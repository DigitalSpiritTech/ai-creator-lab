/**
 * `<dataDir>/auth.json`: the app password's scrypt hash, the digest of the pending one-time setup
 * code, and the digests of live sessions. Written atomically with mode 0600 like `secrets.json`.
 * No plaintext password, code, or session token is ever stored. Deleting the file (with the server
 * stopped) resets the password: the next start asks for a new one.
 * @packageDocumentation
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { PasswordHashSchema } from "@/server/auth/password";

export const AUTH_FILE = "auth.json";

const Iso = z.string().min(1);
const Hex = z.string().regex(/^[0-9a-f]{64}$/);

export const StoredSessionSchema = z.object({ id: Hex, createdAt: Iso, expiresAt: Iso }).strict();
export type StoredSession = z.infer<typeof StoredSessionSchema>;

export const AuthFileSchema = z
  .object({
    version: z.literal(1),
    password: PasswordHashSchema.extend({ setAt: Iso }).optional(),
    /** The pending setup code: its digest, and which server process printed it. */
    setup: z.object({ codeDigest: Hex, createdAt: Iso, issuer: z.string().min(1) }).strict().optional(),
    sessions: z.array(StoredSessionSchema).default([]),
  })
  .strict();
export type AuthFile = z.infer<typeof AuthFileSchema>;

export const EMPTY_AUTH_FILE: AuthFile = { version: 1, sessions: [] };

/**
 * Reads the auth file. A missing file is the empty state; a file that exists but does not parse
 * is treated as configured-but-unreadable, so a damaged file never opens the app: `password` is
 * kept as an impossible hash and every sign-in fails until the file is fixed or deleted.
 */
export function readAuthFile(dataDir: string): AuthFile {
  const path = join(dataDir, AUTH_FILE);
  if (!existsSync(path)) return EMPTY_AUTH_FILE;
  try {
    const parsed = AuthFileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (parsed.success) return parsed.data;
  } catch {
    // Fall through to the locked state.
  }
  return { version: 1, sessions: [], password: LOCKED_PASSWORD };
}

/** A hash no password matches, standing in for an unreadable auth file. */
const LOCKED_PASSWORD = { algorithm: "scrypt", N: 2, r: 1, p: 1, keyLength: 16, salt: "AA==", hash: "AA==", setAt: "1970-01-01T00:00:00.000Z" } as const;

export function writeAuthFile(dataDir: string, file: AuthFile): void {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, AUTH_FILE);
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(AuthFileSchema.parse(file), null, 2), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

/** Reads, transforms, and writes the auth file. */
export function updateAuthFile(dataDir: string, change: (file: AuthFile) => AuthFile): AuthFile {
  const next = change(readAuthFile(dataDir));
  writeAuthFile(dataDir, next);
  return next;
}
