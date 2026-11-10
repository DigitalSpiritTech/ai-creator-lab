/**
 * The auth provider contract, and the one implementation that ships: a single app password.
 *
 * A provider decides whether a request needs a signed-in session, recognizes one, and opens and
 * closes sessions. The request proxy and every route's local-request guard ask the same provider,
 * so a page, an API route, and a media download are held to one rule. `authenticate` is
 * synchronous on purpose: the guard runs inside every route before any work starts.
 * @packageDocumentation
 */
import { randomBytes } from "node:crypto";
import { type AuthFile, MAX_FAILED_ATTEMPTS, readAuthFile, updateAuthFile } from "@/server/auth/auth-file";
import { isNetworkExposed } from "@/server/auth/network";
import { type FailureStore, createFailureLimiter } from "@/server/auth/rate-limit";
import {
  digest,
  digestsEqual,
  hashPassword,
  newSessionToken,
  newSetupCode,
  normalizeSetupCode,
  verifyPassword,
} from "@/server/auth/password";
import { hostedMode } from "@/server/demo";

type Env = Record<string, string | undefined>;

export const SESSION_COOKIE = "creator_lab_session";
export const SESSION_DAYS = 30;
const MAX_SESSIONS = 50;

export interface Session {
  /** SHA-256 of the token: identifies the session without being usable as one. */
  id: string;
  createdAt: string;
  expiresAt: string;
}

export type SignInFailure =
  | { ok: false; reason: "invalid"; message: string }
  | { ok: false; reason: "rate_limited"; message: string; retryAfterSeconds: number }
  | { ok: false; reason: "not_configured" | "already_configured"; message: string };

/** A successful sign-in carries the token for the cookie; it is never stored or logged. */
export type SignInResult = { ok: true; session: Session; token: string } | SignInFailure;

export interface AuthProvider {
  readonly id: string;
  /** Whether this request must carry a signed-in session (public paths are the caller's concern). */
  required(request: Request): boolean;
  /** Whether the provider has what it needs to check a sign-in (for the password provider, a password). */
  configured(): boolean;
  /** The session the request carries, or null. Cheap and synchronous. */
  authenticate(request: Request): Session | null;
  /** First run: proves the person can read the server log, sets the password, and opens a session. */
  setUp(input: { setupCode: string; password: string }): Promise<SignInResult>;
  signIn(input: { password: string }): Promise<SignInResult>;
  /** Ends the request's session, if it has one. */
  signOut(request: Request): void;
  /**
   * Makes sure a setup code exists that this server process printed. Returns the new code when one
   * was issued (the caller prints it to the server log), or null when none is needed or this
   * process already printed one.
   */
  issueSetupCode(): string | null;
}

/** Reads one cookie from a request's Cookie header. */
export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) {
      const value = part.slice(index + 1).trim();
      return value || undefined;
    }
  }
  return undefined;
}

const holder = globalThis as typeof globalThis & { __creatorLabBootId?: string };

/** Identifies this server process, shared by every bundle loaded in it (one global object). */
function processIssuer(): string {
  holder.__creatorLabBootId ??= `${process.pid}-${randomBytes(6).toString("hex")}`;
  return holder.__creatorLabBootId;
}

export interface SinglePasswordOptions {
  dataDir: () => string;
  env?: () => Env;
  now?: () => number;
  /** Failure limit settings; failures are kept in the auth file unless `failureStore` says otherwise. */
  limits?: { maxFailures?: number; windowMs?: number; delayMs?: number };
  failureStore?: FailureStore;
  sleep?: (ms: number) => Promise<void>;
  /** The password check; replaceable so tests can count how many guesses reach it. */
  verify?: typeof verifyPassword;
}

/**
 * The single-password provider. Required when the server is reachable from other machines and is
 * not one of the hosted modes (the read-only demo is public by design; the judging copy has its
 * own password). Sessions are random tokens whose SHA-256 digests live in `auth.json`, so the
 * proxy and the routes, which Next.js may load as separate bundles, agree on them through the file.
 */
export function createSinglePasswordProvider(options: SinglePasswordOptions): AuthProvider {
  const env = options.env ?? (() => process.env);
  const now = options.now ?? Date.now;
  const verify = options.verify ?? verifyPassword;
  const read = () => readAuthFile(options.dataDir());
  const update = (change: (file: AuthFile) => AuthFile) => updateAuthFile(options.dataDir(), change);
  const fileFailures: FailureStore = {
    load: () => read().failedAttempts,
    save: (failures) => void update((file) => ({ ...file, failedAttempts: failures.slice(-MAX_FAILED_ATTEMPTS) })),
  };
  const limiter = createFailureLimiter({ ...options.limits, now, sleep: options.sleep, store: options.failureStore ?? fileFailures });

  const live = (file: AuthFile) => {
    const time = now();
    return file.sessions.filter((session) => Date.parse(session.expiresAt) > time);
  };

  const openSession = (file: AuthFile): { file: AuthFile; session: Session; token: string } => {
    const token = newSessionToken();
    const created = now();
    const session: Session = {
      id: digest(token),
      createdAt: new Date(created).toISOString(),
      expiresAt: new Date(created + SESSION_DAYS * 86_400_000).toISOString(),
    };
    return { file: { ...file, sessions: [...live(file), session].slice(-MAX_SESSIONS) }, session, token };
  };

  /** Runs one counted attempt; only a wrong password or setup code stays counted as a failure. */
  const limitedAttempt = async (run: () => Promise<SignInResult>): Promise<SignInResult> => {
    const outcome = await limiter.attempt(run, (result) => result.ok || result.reason !== "invalid");
    if (!outcome.blocked) return outcome.value;
    const retryAfterSeconds = outcome.retryAfterSeconds;
    return { ok: false, reason: "rate_limited", message: `Too many failed attempts. Try again in ${retryAfterSeconds} seconds.`, retryAfterSeconds };
  };

  const authenticate = (request: Request): Session | null => {
    const token = readCookie(request, SESSION_COOKIE);
    if (!token || token.length > 128) return null;
    const id = digest(token);
    return live(read()).find((session) => digestsEqual(session.id, id)) ?? null;
  };

  return {
    id: "single-password",

    required(request) {
      const environment = env();
      if (hostedMode(environment)) return false;
      let urlHostname: string | undefined;
      try { urlHostname = new URL(request.url).hostname; } catch { urlHostname = undefined; }
      return isNetworkExposed(environment, urlHostname);
    },

    configured() {
      return read().password !== undefined;
    },

    authenticate,

    setUp(input) {
      return limitedAttempt(async () => {
        const file = read();
        if (file.password) return { ok: false, reason: "already_configured", message: "A password is already set. Sign in instead." };
        const pending = file.setup;
        if (!pending || !digestsEqual(pending.codeDigest, digest(normalizeSetupCode(input.setupCode)))) {
          return { ok: false, reason: "invalid", message: "That setup code does not match the one in the server log." };
        }
        const password = await hashPassword(input.password);
        let opened: { session: Session; token: string } | undefined;
        const written = update((current) => {
          // Re-checked against the file as written now, so two racing setups cannot both win.
          if (current.password || !current.setup || current.setup.codeDigest !== pending.codeDigest) return current;
          const result = openSession({ ...current, setup: undefined, sessions: [], password: { ...password, setAt: new Date(now()).toISOString() } });
          opened = result;
          return result.file;
        });
        if (!opened || !written.password) return { ok: false, reason: "already_configured", message: "A password is already set. Sign in instead." };
        return { ok: true, session: opened.session, token: opened.token };
      });
    },

    signIn(input) {
      return limitedAttempt(async () => {
        const file = read();
        if (!file.password) return { ok: false, reason: "not_configured", message: "No password is set yet. Use the setup code from the server log." };
        if (!(await verify(input.password, file.password))) return { ok: false, reason: "invalid", message: "That password is not right." };
        let opened: { session: Session; token: string } | undefined;
        update((current) => {
          const result = openSession(current);
          opened = result;
          return result.file;
        });
        return { ok: true, session: opened!.session, token: opened!.token };
      });
    },

    signOut(request) {
      const session = authenticate(request);
      if (!session) return;
      update((file) => ({ ...file, sessions: live(file).filter((entry) => entry.id !== session.id) }));
    },

    issueSetupCode() {
      const file = read();
      if (file.password) return null;
      const issuer = processIssuer();
      if (file.setup?.issuer === issuer) return null;
      const code = newSetupCode();
      update((current) => ({ ...current, setup: { codeDigest: digest(normalizeSetupCode(code)), createdAt: new Date(now()).toISOString(), issuer } }));
      return code;
    },
  };
}
