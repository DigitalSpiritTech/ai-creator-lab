/**
 * Password hashing and the one-time setup code. scrypt from `node:crypto` with a random 16-byte
 * salt; verification compares with `timingSafeEqual`. Nothing here logs or returns a password.
 * @packageDocumentation
 */
import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/** scrypt cost: N = 2^15, r = 8, p = 1 needs 32 MiB; about 50 to 100 ms per check. */
const SCRYPT = { N: 32_768, r: 8, p: 1, keyLength: 64 } as const;
const MAX_MEMORY = 128 * SCRYPT.N * SCRYPT.r * 2;

export const PasswordHashSchema = z
  .object({
    algorithm: z.literal("scrypt"),
    N: z.number().int().positive(),
    r: z.number().int().positive(),
    p: z.number().int().positive(),
    keyLength: z.number().int().positive(),
    salt: z.string().min(1),
    hash: z.string().min(1),
  })
  .strict();
export type PasswordHash = z.infer<typeof PasswordHashSchema>;

function derive(password: string, salt: Buffer, params: { N: number; r: number; p: number; keyLength: number }): Promise<Buffer> {
  return new Promise((resolveKey, reject) => {
    scrypt(password.normalize("NFKC"), salt, params.keyLength, { N: params.N, r: params.r, p: params.p, maxmem: Math.max(MAX_MEMORY, 128 * params.N * params.r * 2) }, (error, key) =>
      error ? reject(error) : resolveKey(key),
    );
  });
}

export async function hashPassword(password: string): Promise<PasswordHash> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, SCRYPT);
  return { algorithm: "scrypt", ...SCRYPT, salt: salt.toString("base64"), hash: key.toString("base64") };
}

export async function verifyPassword(password: string, stored: PasswordHash): Promise<boolean> {
  const expected = Buffer.from(stored.hash, "base64");
  const key = await derive(password, Buffer.from(stored.salt, "base64"), stored);
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** SHA-256 hex of a high-entropy random value (a session token or setup code); safe to store. */
export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Constant-time comparison of two hex digests of equal length. */
export function digestsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

/** Crockford base32: no I, L, O, U, so the code survives being read off a terminal and typed. */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A one-time setup code: 20 symbols (100 bits) in five groups of four. */
export function newSetupCode(): string {
  const symbols = Array.from({ length: 20 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]);
  return [0, 4, 8, 12, 16].map((start) => symbols.slice(start, start + 4).join("")).join("-");
}

/** The comparable form of a typed setup code: upper case, no spaces or dashes, O read as 0 and I or L as 1. */
export function normalizeSetupCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
}

/** A new session token: 32 random bytes, base64url. */
export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}
