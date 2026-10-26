/**
 * API keys and the assistant model: read from the environment first, then from
 * `<dataDir>/secrets.json` (written by Settings with mode 0600). Values never leave the server;
 * `secretsStatus` is the only shape API routes return, and it carries presence, not values.
 *
 * This module does not import `server-only` because the tools layer (tested under plain Node)
 * resolves the Comfy key through it; `node:fs` already keeps it out of client bundles.
 * @packageDocumentation
 */
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const SECRETS_FILE = "secrets.json";

const SecretValueSchema = z.string().trim().min(1).max(500);

export const SecretsFileSchema = z
  .object({
    comfyApiKey: SecretValueSchema.optional(),
    anthropicApiKey: SecretValueSchema.optional(),
    llmModel: z.string().trim().min(1).max(120).optional(),
  })
  .strip();
export type SecretsFile = z.infer<typeof SecretsFileSchema>;

/** A Settings edit: a string sets the value, an empty string or null clears it, absent keeps it. */
export const SecretsPatchSchema = z
  .object({
    comfyApiKey: z.string().trim().max(500).nullable().optional(),
    anthropicApiKey: z.string().trim().max(500).nullable().optional(),
    llmModel: z.string().trim().max(120).nullable().optional(),
  })
  .strict();
export type SecretsPatch = z.infer<typeof SecretsPatchSchema>;

export interface Secrets {
  comfyApiKey?: string;
  anthropicApiKey?: string;
  llmModel?: string;
}

const ENV_NAMES = {
  comfyApiKey: "COMFY_API_KEY",
  anthropicApiKey: "ANTHROPIC_API_KEY",
  llmModel: "LLM_MODEL",
} as const satisfies Record<keyof Secrets, string>;

export type SecretSource = "environment" | "settings" | null;

export interface SecretsStatus {
  comfyApiKey: { present: boolean; source: SecretSource };
  anthropicApiKey: { present: boolean; source: SecretSource };
  /** The model id is not a secret, so its value is returned. */
  llmModel: { value: string | null; source: SecretSource };
}

function readFile(dataDir: string): SecretsFile {
  const path = join(dataDir, SECRETS_FILE);
  if (!existsSync(path)) return {};
  try {
    const parsed = SecretsFileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function fromEnv(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function resolveAll(dataDir: string, env: Record<string, string | undefined>): { values: Secrets; sources: Record<keyof Secrets, SecretSource> } {
  const file = readFile(dataDir);
  const values: Secrets = {};
  const sources = { comfyApiKey: null, anthropicApiKey: null, llmModel: null } as Record<keyof Secrets, SecretSource>;
  for (const key of Object.keys(ENV_NAMES) as (keyof Secrets)[]) {
    const environment = fromEnv(env, ENV_NAMES[key]);
    if (environment) {
      values[key] = environment;
      sources[key] = "environment";
    } else if (file[key]) {
      values[key] = file[key];
      sources[key] = "settings";
    }
  }
  return { values, sources };
}

/** Full key values for server code only (executors, the assistant). Never return these from a route. */
export function readSecrets(dataDir: string, env: Record<string, string | undefined> = process.env): Secrets {
  return resolveAll(dataDir, env).values;
}

/** Which keys are configured and where they come from, without any key value. */
export function secretsStatus(dataDir: string, env: Record<string, string | undefined> = process.env): SecretsStatus {
  const { values, sources } = resolveAll(dataDir, env);
  return {
    comfyApiKey: { present: !!values.comfyApiKey, source: sources.comfyApiKey },
    anthropicApiKey: { present: !!values.anthropicApiKey, source: sources.anthropicApiKey },
    llmModel: { value: values.llmModel ?? null, source: sources.llmModel },
  };
}

/** Applies a Settings edit to `secrets.json`, written atomically with mode 0600. */
export function writeSecrets(dataDir: string, patch: SecretsPatch): void {
  const next: SecretsFile = { ...readFile(dataDir) };
  for (const key of Object.keys(ENV_NAMES) as (keyof Secrets)[]) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null || value === "") delete next[key];
    else next[key] = value;
  }
  const path = join(dataDir, SECRETS_FILE);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(SecretsFileSchema.parse(next), null, 2), { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}
