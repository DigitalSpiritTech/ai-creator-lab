/**
 * Access control (F7): the network policy, password hashing, the single-password provider, and
 * the acceptance check end to end through the proxy and the route handlers: started with
 * HOST=0.0.0.0 and no password, the first visit asks for one (setup code from the server log),
 * and the API refuses unauthenticated calls. Loopback stays as it was: no password.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, afterEach, before, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { NextRequest } from "next/server";
import { AUTH_FILE, readAuthFile } from "@/server/auth/auth-file";
import {
  acceptedHosts,
  allowedHostsHint,
  configuredHosts,
  isLoopbackHostname,
  isNetworkExposed,
  normalizeHostname,
  requestProtocol,
} from "@/server/auth/network";
import { authorized } from "@/server/demo";
import { digest, hashPassword, newSetupCode, normalizeSetupCode, verifyPassword } from "@/server/auth/password";
import { SESSION_COOKIE, createSinglePasswordProvider } from "@/server/auth/provider";
import { safeNextPath } from "@/lib/domain/auth";

// Route modules import `server-only`; outside the React server build it would throw on import.
const empty = pathToFileURL(resolve("node_modules/server-only/empty.js")).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: empty, shortCircuit: true, format: "commonjs" };
    return next(specifier, context);
  },
});

const ENV_KEYS = ["HOST", "STUDIO_ALLOWED_HOSTS", "STUDIO_DATA_DIR", "STUDIO_READ_ONLY", "STUDIO_PUBLIC_HOST", "STUDIO_JUDGE_PASSWORD", "STUDIO_JUDGE_OPEN", "MOCK_RECIPES"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const roots: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "creator-lab-auth-"));
  roots.push(dir);
  return dir;
}

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);
}

after(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("network policy", () => {
  test("loopback names are loopback; LAN, wildcard and public names are not", () => {
    for (const host of ["localhost", "127.0.0.1", "127.9.9.9", "[::1]", "::1", "app.localhost", "LOCALHOST"]) assert.ok(isLoopbackHostname(host), host);
    for (const host of ["0.0.0.0", "::", "192.168.1.20", "studio.example.com", "localhost.example.com", ""]) assert.ok(!isLoopbackHostname(host), host);
    assert.equal(normalizeHostname("Studio.LAN:3000"), "studio.lan");
    assert.equal(normalizeHostname("fe80::1"), "[fe80::1]");
  });

  test("HOST, STUDIO_ALLOWED_HOSTS, or a non-loopback bind address in the URL expose the server", () => {
    assert.equal(isNetworkExposed({}), false, "the default is loopback");
    assert.equal(isNetworkExposed({ HOST: "127.0.0.1" }), false);
    assert.equal(isNetworkExposed({ HOST: "localhost" }, "localhost"), false);
    assert.equal(isNetworkExposed({ HOST: "0.0.0.0" }), true);
    assert.equal(isNetworkExposed({ HOST: "192.168.1.20" }), true);
    assert.equal(isNetworkExposed({ STUDIO_ALLOWED_HOSTS: "studio.lan" }), true, "a reverse proxy name");
    assert.equal(isNetworkExposed({ STUDIO_ALLOWED_HOSTS: "localhost, 127.0.0.1" }), false);
    assert.equal(isNetworkExposed({}, "0.0.0.0"), true, "started with --hostname 0.0.0.0 directly");
  });

  test("accepted hosts: loopback, the allow list, a specific HOST, never a wildcard", () => {
    assert.deepEqual(configuredHosts({ STUDIO_ALLOWED_HOSTS: " Studio.LAN , 192.168.1.20:3000,, " }), ["studio.lan", "192.168.1.20"]);
    const hosts = acceptedHosts({ HOST: "0.0.0.0", STUDIO_ALLOWED_HOSTS: "studio.lan" });
    assert.ok(hosts.includes("localhost") && hosts.includes("studio.lan"));
    assert.ok(!hosts.includes("0.0.0.0"));
    assert.ok(acceptedHosts({ HOST: "192.168.1.20" }).includes("192.168.1.20"));
  });

  test("X-Forwarded-Proto counts only behind a named proxy, or on loopback", () => {
    const forwarded = (url: string) => new Request(url, { headers: { "x-forwarded-proto": "https" } });
    assert.equal(requestProtocol(forwarded("http://0.0.0.0:3000/"), { HOST: "0.0.0.0" }), "http:", "exposed directly: anyone could send it");
    assert.equal(requestProtocol(forwarded("https://0.0.0.0:3000/"), { HOST: "0.0.0.0" }), "http:", "Next.js copies the header into the URL scheme; not trusted either");
    assert.equal(requestProtocol(forwarded("http://0.0.0.0:3000/"), { HOST: "0.0.0.0", STUDIO_ALLOWED_HOSTS: "studio.example.com" }), "https:");
    assert.equal(requestProtocol(forwarded("http://demo.example.com/"), { STUDIO_READ_ONLY: "1", STUDIO_PUBLIC_HOST: "demo.example.com" }), "https:");
    assert.equal(requestProtocol(forwarded("http://127.0.0.1:3000/"), {}), "https:", "a local TLS proxy on loopback");
    assert.equal(requestProtocol(new Request("http://0.0.0.0:3000/"), { HOST: "0.0.0.0" }), "http:");
  });

  test("a wildcard bind with no allowed hosts gets a startup hint naming STUDIO_ALLOWED_HOSTS", () => {
    const hint = allowedHostsHint({ HOST: "0.0.0.0" }, ["192.168.1.20"]);
    assert.match(hint ?? "", /STUDIO_ALLOWED_HOSTS=192\.168\.1\.20/);
    assert.equal(allowedHostsHint({ HOST: "0.0.0.0", STUDIO_ALLOWED_HOSTS: "studio.lan" }, []), null);
    assert.equal(allowedHostsHint({ HOST: "192.168.1.20" }, []), null, "a specific HOST is accepted on its own");
    assert.equal(allowedHostsHint({}, []), null);
  });

  test("the judging password check compares digests: right password only, any length", () => {
    const basic = (secret: string) => "Basic " + Buffer.from(`judge:${secret}`).toString("base64");
    assert.equal(authorized(basic("correct-horse-battery"), "correct-horse-battery"), true);
    for (const wrong of ["", "correct-horse-batter", "correct-horse-battery!", "x".repeat(500)]) assert.equal(authorized(basic(wrong), "correct-horse-battery"), false, wrong);
  });

  test("the next path after sign-in stays on this site", () => {
    assert.equal(safeNextPath("/projects/abc?tab=shots"), "/projects/abc?tab=shots");
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "/\t/evil.example", "/\n/evil.example", "/.//evil.example", "/%2e//evil.example", "/a/..//evil.example", "", null, "/login?next=/x", "projects"]) assert.equal(safeNextPath(bad), "/", String(bad));
  });
});

describe("password and setup code", () => {
  test("scrypt hashes verify only the right password, with a fresh salt each time", async () => {
    const first = await hashPassword("correct horse battery");
    const second = await hashPassword("correct horse battery");
    assert.notEqual(first.salt, second.salt);
    assert.notEqual(first.hash, second.hash);
    assert.equal(await verifyPassword("correct horse battery", first), true);
    assert.equal(await verifyPassword("correct horse batterY", first), false);
    assert.ok(!JSON.stringify(first).includes("correct horse"));
  });

  test("setup codes are 100-bit Crockford strings that survive retyping", () => {
    const code = newSetupCode();
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){4}$/);
    assert.notEqual(newSetupCode(), code);
    assert.equal(normalizeSetupCode(code.toLowerCase().replace(/-/g, " ")), normalizeSetupCode(code));
    assert.equal(normalizeSetupCode("o0il-L1"), "001111");
  });
});

describe("single-password provider", () => {
  const exposed = { HOST: "0.0.0.0" };
  const request = (cookie?: string) => new Request("http://0.0.0.0:3000/api/projects", { headers: { host: "localhost:3000", ...(cookie ? { cookie } : {}) } });

  function provider(
    dataDir: string,
    env: Record<string, string> = exposed,
    extra: { now?: () => number; maxFailures?: number; delayMs?: number; sleep?: (ms: number) => Promise<void>; verify?: typeof verifyPassword } = {},
  ) {
    return createSinglePasswordProvider({
      dataDir: () => dataDir,
      env: () => env,
      now: extra.now,
      limits: { delayMs: extra.delayMs ?? 0, maxFailures: extra.maxFailures },
      sleep: extra.sleep,
      verify: extra.verify,
    });
  }

  test("required only when exposed and not a hosted mode", () => {
    const dir = tempDir();
    assert.equal(provider(dir, {}).required(new Request("http://localhost:3000/")), false);
    assert.equal(provider(dir, {}).required(new Request("http://0.0.0.0:3000/")), true, "the bind address in the URL");
    assert.equal(provider(dir).required(request()), true);
    assert.equal(provider(dir, { ...exposed, STUDIO_READ_ONLY: "1" }).required(request()), false, "the read-only demo is public");
    assert.equal(provider(dir, { ...exposed, STUDIO_JUDGE_OPEN: "1" }).required(request()), false, "the judging copy keeps its own rule");
  });

  test("setup needs the code this process printed; then sign-in, sign-out, and expiry", async () => {
    const dir = tempDir();
    let clock = Date.parse("2026-11-09T12:00:00Z");
    const auth = provider(dir, exposed, { now: () => clock });
    assert.equal(auth.configured(), false);
    const code = auth.issueSetupCode();
    assert.ok(code);
    assert.equal(auth.issueSetupCode(), null, "one code per process, so the logged code stays valid");

    const wrong = await auth.setUp({ setupCode: newSetupCode(), password: "a long enough password" });
    assert.equal(wrong.ok, false);
    assert.equal(!wrong.ok && wrong.reason, "invalid");
    const set = await auth.setUp({ setupCode: code!.toLowerCase(), password: "a long enough password" });
    assert.ok(set.ok);
    assert.equal(auth.configured(), true);
    assert.equal(auth.issueSetupCode(), null);
    const again = await auth.setUp({ setupCode: code!, password: "another password here" });
    assert.equal(!again.ok && again.reason, "already_configured", "the code is spent once a password is set");

    assert.ok(auth.authenticate(request(`${SESSION_COOKIE}=${set.token}`)));
    assert.equal(auth.authenticate(request(`${SESSION_COOKIE}=not-a-session`)), null);
    assert.equal(auth.authenticate(request()), null);

    const bad = await auth.signIn({ password: "not the password" });
    assert.equal(!bad.ok && bad.reason, "invalid");
    const good = await auth.signIn({ password: "a long enough password" });
    assert.ok(good.ok);
    auth.signOut(request(`${SESSION_COOKIE}=${good.token}`));
    assert.equal(auth.authenticate(request(`${SESSION_COOKIE}=${good.token}`)), null, "signed out on the server, not only in the browser");
    assert.ok(auth.authenticate(request(`${SESSION_COOKIE}=${set.token}`)), "other sessions stay");

    clock += 31 * 86_400_000;
    assert.equal(auth.authenticate(request(`${SESSION_COOKIE}=${set.token}`)), null, "sessions expire after 30 days");

    const file = readFileSync(join(dir, AUTH_FILE), "utf8");
    for (const secret of ["a long enough password", code!, set.token, good.token]) assert.ok(!file.includes(secret), "nothing stored in plaintext");
    if (process.platform !== "win32") assert.equal(statSync(join(dir, AUTH_FILE)).mode & 0o777, 0o600);
  });

  test("failed attempts are capped for everyone until the window passes", async () => {
    const dir = tempDir();
    let clock = Date.parse("2026-11-09T12:00:00Z");
    const auth = provider(dir, exposed, { now: () => clock, maxFailures: 3 });
    const code = auth.issueSetupCode()!;
    await auth.setUp({ setupCode: code, password: "a long enough password" });
    for (let attempt = 0; attempt < 3; attempt++) assert.equal((await auth.signIn({ password: "wrong guess" })).ok, false);
    const limited = await auth.signIn({ password: "a long enough password" });
    assert.equal(!limited.ok && limited.reason, "rate_limited");
    assert.ok(!limited.ok && limited.reason === "rate_limited" && limited.retryAfterSeconds > 0);
    clock += 10 * 60_000 + 1;
    assert.ok((await auth.signIn({ password: "a long enough password" })).ok);
  });

  test("parallel wrong sign-ins: at most maxFailures reach the password check, one at a time, each held for the delay", async () => {
    const dir = tempDir();
    const setup = provider(dir);
    await setup.setUp({ setupCode: setup.issueSetupCode()!, password: "a long enough password" });
    let checks = 0;
    let running = 0;
    let overlap = 0;
    const delays: number[] = [];
    const auth = provider(dir, exposed, {
      maxFailures: 5,
      delayMs: 1_000,
      sleep: async (ms) => {
        delays.push(ms);
        await new Promise((done) => setImmediate(done));
      },
      verify: async (password, stored) => {
        checks++;
        running++;
        overlap = Math.max(overlap, running);
        try {
          return await verifyPassword(password, stored);
        } finally {
          running--;
        }
      },
    });
    const results = await Promise.all(Array.from({ length: 30 }, (_, index) => auth.signIn({ password: `wrong guess ${index}` })));
    assert.equal(checks, 5, "only the counted attempts are checked");
    assert.equal(overlap, 1, "checked one at a time");
    assert.deepEqual(delays, [1_000, 1_000, 1_000, 1_000, 1_000], "every failure holds its turn");
    assert.equal(results.filter((result) => !result.ok && result.reason === "invalid").length, 5);
    assert.equal(results.filter((result) => !result.ok && result.reason === "rate_limited").length, 25);
    const limited = await auth.signIn({ password: "a long enough password" });
    assert.equal(!limited.ok && limited.reason, "rate_limited", "the right password waits too");
    assert.equal(checks, 5);
  });

  test("parallel wrong setup codes are capped the same way", async () => {
    const dir = tempDir();
    const auth = provider(dir, exposed, { maxFailures: 3 });
    const code = auth.issueSetupCode()!;
    const results = await Promise.all(Array.from({ length: 20 }, () => auth.setUp({ setupCode: newSetupCode(), password: "a long enough password" })));
    assert.equal(results.filter((result) => !result.ok && result.reason === "invalid").length, 3);
    assert.equal(results.filter((result) => !result.ok && result.reason === "rate_limited").length, 17);
    assert.equal((await auth.setUp({ setupCode: code, password: "a long enough password" })).ok, false, "even the right code waits");
  });

  test("failures are kept in the auth file, so a restart does not reset the limit; a success is not counted", async () => {
    const dir = tempDir();
    const clock = () => Date.parse("2026-11-09T12:00:00Z");
    const first = provider(dir, exposed, { now: clock, maxFailures: 3 });
    await first.setUp({ setupCode: first.issueSetupCode()!, password: "a long enough password" });
    assert.equal(readAuthFile(dir).failedAttempts.length, 0, "the successful setup is uncounted");
    assert.ok((await first.signIn({ password: "a long enough password" })).ok);
    assert.equal(readAuthFile(dir).failedAttempts.length, 0, "a successful sign-in is uncounted");
    for (let attempt = 0; attempt < 3; attempt++) await first.signIn({ password: "wrong guess" });
    const restarted = provider(dir, exposed, { now: clock, maxFailures: 3 });
    const limited = await restarted.signIn({ password: "a long enough password" });
    assert.equal(!limited.ok && limited.reason, "rate_limited");
  });

  test("a damaged auth file locks rather than opens, and is never overwritten", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, AUTH_FILE), "{ not json");
    const auth = provider(dir);
    assert.equal(auth.configured(), true);
    assert.equal(auth.issueSetupCode(), null, "no setup code over a damaged file");
    assert.equal((await auth.signIn({ password: "anything at all" })).ok, false);
    assert.equal(readAuthFile(dir).sessions.length, 0);
    assert.equal(readFileSync(join(dir, AUTH_FILE), "utf8"), "{ not json");
  });
});

describe("acceptance: HOST=0.0.0.0, no password set", () => {
  let dataDir: string;
  let proxy: typeof import("@/proxy").proxy;
  let routes: {
    session: typeof import("@/app/api/auth/session/route");
    setup: typeof import("@/app/api/auth/setup/route");
    login: typeof import("@/app/api/auth/login/route");
    logout: typeof import("@/app/api/auth/logout/route");
    projects: typeof import("@/app/api/projects/route");
    runtime: typeof import("@/server/runtime");
    auth: typeof import("@/server/auth");
  };
  const logged: string[] = [];
  const originalLog = console.log;

  // `next start --hostname 0.0.0.0` puts the bind address in the request URL; the browser's Host
  // header says which name it used.
  const BIND = "http://0.0.0.0:3000";
  const browser = (path: string, init: { method?: string; cookie?: string; body?: unknown; origin?: string; host?: string } = {}) =>
    new NextRequest(`${BIND}${path}`, {
      method: init.method ?? "GET",
      headers: {
        host: init.host ?? "localhost:3000",
        "sec-fetch-site": init.origin ? "cross-site" : "same-origin",
        origin: init.origin ?? `http://${init.host ?? "localhost:3000"}`,
        ...(init.cookie ? { cookie: init.cookie } : {}),
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  const passes = (response: Response) => response.headers.get("x-middleware-next") === "1";

  before(async () => {
    dataDir = tempDir();
    setEnv({ HOST: "0.0.0.0", STUDIO_DATA_DIR: dataDir, MOCK_RECIPES: "1" });
    console.log = (...args: unknown[]) => void logged.push(args.join(" "));
    proxy = (await import("@/proxy")).proxy;
    routes = {
      session: await import("@/app/api/auth/session/route"),
      setup: await import("@/app/api/auth/setup/route"),
      login: await import("@/app/api/auth/login/route"),
      logout: await import("@/app/api/auth/logout/route"),
      projects: await import("@/app/api/projects/route"),
      runtime: await import("@/server/runtime"),
      auth: await import("@/server/auth"),
    };
    routes.auth.setAuthProvider(undefined);
  });

  after(() => {
    console.log = originalLog;
    routes?.runtime.closeStore();
  });

  afterEach(() => {
    setEnv({ HOST: "0.0.0.0", STUDIO_DATA_DIR: dataDir, MOCK_RECIPES: "1" });
  });

  let cookie = "";

  test("the API refuses unauthenticated calls with a 401, and pages go to the sign-in page", async () => {
    const api = proxy(browser("/api/projects"));
    assert.equal(api.status, 401);
    assert.deepEqual(await api.json(), { error: "Sign in to use this studio.", signIn: "/login" });
    for (const path of ["/api/assets/00000000-0000-4000-8000-000000000000", "/api/settings", "/api/tools/list_recipes"]) {
      assert.equal(proxy(browser(path)).status, 401, path);
    }
    const page = proxy(browser("/projects?tab=shots"));
    assert.equal(page.status, 307);
    assert.equal(page.headers.get("location"), "http://localhost:3000/login?next=%2Fprojects%3Ftab%3Dshots", "on the name the browser used, not the bind address");
    assert.equal(proxy(browser("/")).headers.get("location"), "http://localhost:3000/login");
    const write = await routes.projects.POST(browser("/api/projects", { method: "POST", body: { name: "Ridgeline bottle" } }));
    assert.equal(write.status, 401, "the route's own guard refuses too, not only the proxy");
  });

  test("the first visit asks for a password: the sign-in page is open and a setup code is in the server log", async () => {
    assert.ok(passes(proxy(browser("/login"))));
    assert.ok(passes(proxy(browser("/api/auth/session"))));
    const status = await (routes.session.GET(browser("/api/auth/session"))).json();
    assert.deepEqual(status, { required: true, authenticated: false, readOnly: false }, "whether a password is set is not public");
    assert.ok(logged.some((line) => /setup code/.test(line)), "the code is printed to the server log");
  });

  test("a wrong setup code is refused; the logged one sets the password and signs in", async () => {
    const code = logged.join("\n").match(/[0-9A-Z]{4}(?:-[0-9A-Z]{4}){4}/)?.[0];
    assert.ok(code, "a setup code was logged");
    const wrong = await routes.setup.POST(browser("/api/auth/setup", { method: "POST", body: { setupCode: "AAAA-AAAA-AAAA-AAAA-AAAA", password: "a long enough password" } }));
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers.get("set-cookie"), null);
    const short = await routes.setup.POST(browser("/api/auth/setup", { method: "POST", body: { setupCode: code, password: "short" } }));
    assert.equal(short.status, 400);

    const response = await routes.setup.POST(browser("/api/auth/setup", { method: "POST", body: { setupCode: code, password: "a long enough password" } }));
    assert.equal(response.status, 200);
    const setCookie = response.headers.get("set-cookie") ?? "";
    assert.match(setCookie, new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43}; Path=/; HttpOnly; SameSite=Strict; Max-Age=\\d+$`));
    assert.ok(!JSON.stringify(await response.json()).includes(setCookie.split(";")[0]!.split("=")[1]!), "the token is in the cookie only");
    cookie = setCookie.split(";")[0]!;
    assert.ok(!logged.join("\n").includes("a long enough password"), "the password is never logged");
  });

  test("with the session cookie every page and API call goes through, and the layout learns it is signed in", async () => {
    const api = proxy(browser("/api/projects", { cookie }));
    assert.ok(passes(api));
    assert.equal(api.headers.get("x-middleware-request-x-creator-lab-session"), "1");
    assert.ok(passes(proxy(browser("/projects", { cookie }))));
    const created = await routes.projects.POST(browser("/api/projects", { method: "POST", cookie, body: { name: "Ridgeline bottle" } }));
    assert.equal(created.status, 201);
    const spoofed = proxy(new NextRequest(`${BIND}/login`, { headers: { host: "localhost:3000", "x-creator-lab-session": "1" } }));
    assert.equal(spoofed.headers.get("x-middleware-request-x-creator-lab-session"), null, "a client cannot claim a session through the header");
  });

  test("origin and host checks stay in force for signed-in requests", () => {
    assert.equal(proxy(browser("/api/projects", { method: "POST", cookie, origin: "https://evil.example", body: {} })).status, 403);
    assert.equal(proxy(browser("/api/projects", { cookie, host: "attacker.example:3000" })).status, 403, "a name not in STUDIO_ALLOWED_HOSTS");
    setEnv({ HOST: "0.0.0.0", STUDIO_DATA_DIR: dataDir, STUDIO_ALLOWED_HOSTS: "studio.lan" });
    assert.ok(passes(proxy(browser("/api/projects", { cookie, host: "studio.lan:3000" }))));
    assert.equal(proxy(browser("/api/projects", { host: "studio.lan:3000" })).status, 401);
  });

  test("sign out ends the session; signing in with the password opens a new one", async () => {
    const out = await routes.logout.POST(browser("/api/auth/logout", { method: "POST", cookie }));
    assert.equal(out.status, 200);
    assert.match(out.headers.get("set-cookie") ?? "", /Max-Age=0/);
    assert.equal(proxy(browser("/api/projects", { cookie })).status, 401);

    const wrong = await routes.login.POST(browser("/api/auth/login", { method: "POST", body: { password: "not the password" } }));
    assert.equal(wrong.status, 401);
    const right = await routes.login.POST(browser("/api/auth/login", { method: "POST", body: { password: "a long enough password" } }));
    assert.equal(right.status, 200);
    const next = (right.headers.get("set-cookie") ?? "").split(";")[0]!;
    assert.ok(passes(proxy(browser("/api/projects", { cookie: next }))));
    const status = await routes.session.GET(browser("/api/auth/session", { cookie: next })).json();
    assert.deepEqual(status, { required: true, authenticated: true, readOnly: false });
  });

  test("the session cookie is Secure behind an https proxy", async () => {
    const request = new NextRequest(`${BIND}/api/auth/login`, {
      method: "POST",
      headers: { host: "studio.example.com", origin: "https://studio.example.com", "x-forwarded-proto": "https", "content-type": "application/json" },
      body: JSON.stringify({ password: "a long enough password" }),
    });
    setEnv({ HOST: "0.0.0.0", STUDIO_DATA_DIR: dataDir, STUDIO_ALLOWED_HOSTS: "studio.example.com" });
    const response = await routes.login.POST(request);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("set-cookie") ?? "", /; Secure$/);
  });

  test("on loopback nothing changes: no password, and the sign-in page sends you to the studio", () => {
    setEnv({ STUDIO_DATA_DIR: dataDir });
    const local = (path: string) => new NextRequest(`http://127.0.0.1:3000${path}`, { headers: { host: "127.0.0.1:3000" } });
    assert.ok(passes(proxy(local("/api/projects"))));
    assert.ok(passes(proxy(local("/projects"))));
    assert.equal(proxy(local("/login")).headers.get("location"), "http://127.0.0.1:3000/");
  });

  test("the read-only flag is public and refuses every write, even on a network bind", async () => {
    setEnv({ HOST: "0.0.0.0", STUDIO_DATA_DIR: dataDir, STUDIO_READ_ONLY: "1" });
    assert.ok(passes(proxy(browser("/api/projects"))));
    assert.equal(proxy(browser("/api/projects", { method: "POST", body: { name: "x" } })).status, 403);
    const write = await routes.projects.POST(browser("/api/projects", { method: "POST", body: { name: "x" } }));
    assert.equal(write.status, 403, "the route refuses the write as well");
  });

  test("the auth file holds hashes only, mode 0600", () => {
    const file = readAuthFile(dataDir);
    assert.ok(file.password && file.password.algorithm === "scrypt");
    assert.equal(file.setup, undefined, "the setup code is spent");
    assert.ok(file.sessions.every((session) => session.id.length === 64));
    assert.equal(digest("x").length, 64);
    if (process.platform !== "win32") assert.equal(statSync(join(dataDir, AUTH_FILE)).mode & 0o777, 0o600);
  });
});
