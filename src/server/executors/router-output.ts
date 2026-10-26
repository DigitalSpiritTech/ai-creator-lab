/**
 * Reads where a Router model put its generated media, per model family, and recognizes refusals that
 * arrive inside a successful response.
 * @packageDocumentation
 */
import { z } from "zod";
import type { RouterOutputFamily, RouterRecipe } from "@/lib/catalog";
import { ExecutorFailure, jobError } from "@/server/executors/jobs";

export type RouterMedia = { kind: "url"; url: string } | { kind: "inline"; bytes: Uint8Array; mime: string };

/** The family a recipe's output follows: explicit in the field map, otherwise from the provider. */
export function routerFamily(recipe: Pick<RouterRecipe, "model" | "fieldMap">): RouterOutputFamily | undefined {
  if (recipe.fieldMap.output) return recipe.fieldMap.output;
  const provider = recipe.model.split("/")[0];
  const byProvider: Record<string, RouterOutputFamily> = {
    vertexai: "gemini",
    google: "gemini",
    gemini: "gemini",
    bfl: "flux",
    minimax: "minimax",
    wan: "wan",
    kling: "kling",
    byteplus: "seedance",
    ltx: "ltx",
    elevenlabs: "binary",
  };
  return byProvider[provider];
}

function refused(reason: string): ExecutorFailure {
  return new ExecutorFailure(jobError("provider", `The provider declined this request: ${reason.slice(0, 300)}`, false, "content_policy_violation"));
}

function failedUpstream(reason?: string): ExecutorFailure {
  return new ExecutorFailure(jobError("provider", `The provider reported a failed generation${reason ? `: ${reason.slice(0, 300)}` : "."}`, false, "provider_error"));
}

function unreadable(): ExecutorFailure {
  return new ExecutorFailure(jobError("provider", "The provider's response did not contain a recognizable output.", false, "unexpected_response"));
}

const GeminiPartSchema = z
  .object({
    thought: z.boolean().optional(),
    text: z.string().optional(),
    fileData: z.object({ fileUri: z.string(), mimeType: z.string().optional() }).optional(),
    inlineData: z.object({ data: z.string(), mimeType: z.string() }).optional(),
  })
  .passthrough();
const GeminiSchema = z
  .object({
    candidates: z
      .array(
        z
          .object({
            content: z.object({ parts: z.array(GeminiPartSchema).default([]) }).partial().optional(),
            finishReason: z.string().optional(),
            finishMessage: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
    promptFeedback: z.object({ blockReason: z.string().optional(), blockReasonMessage: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();
const SAFETY_FINISH = new Set(["SAFETY", "IMAGE_SAFETY", "PROHIBITED_CONTENT", "IMAGE_PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION", "IMAGE_RECITATION"]);

function gemini(data: unknown): RouterMedia {
  const parsed = GeminiSchema.safeParse(data);
  if (!parsed.success) throw unreadable();
  const { candidates = [], promptFeedback } = parsed.data;
  for (const candidate of candidates) {
    for (const part of candidate.content?.parts ?? []) {
      if (part.thought) continue;
      if (part.fileData && /^image\//.test(part.fileData.mimeType ?? "image/png")) return { kind: "url", url: part.fileData.fileUri };
      if (part.inlineData && /^image\//.test(part.inlineData.mimeType)) {
        return { kind: "inline", bytes: Buffer.from(part.inlineData.data, "base64"), mime: part.inlineData.mimeType };
      }
    }
  }
  if (promptFeedback?.blockReason) refusedThrow(promptFeedback.blockReasonMessage ?? promptFeedback.blockReason);
  const blocked = candidates.find((candidate) => candidate.finishReason && SAFETY_FINISH.has(candidate.finishReason));
  if (blocked) refusedThrow(blocked.finishMessage ?? blocked.finishReason ?? "content policy");
  throw unreadable();
}

function refusedThrow(reason: string): never {
  throw refused(reason);
}

function pick<T>(schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw unreadable();
  return parsed.data;
}

function flux(data: unknown): RouterMedia {
  const parsed = pick(z.object({ status: z.string().optional(), result: z.object({ sample: z.string() }).partial().nullish() }).passthrough(), data);
  if (parsed.result?.sample) return { kind: "url", url: parsed.result.sample };
  if (!parsed.status) throw unreadable();
  if (/moderat/i.test(parsed.status)) refusedThrow(parsed.status);
  throw failedUpstream(parsed.status);
}

function minimax(data: unknown): RouterMedia {
  const parsed = pick(z.object({ task: z.object({ status: z.string(), content: z.object({ url: z.string() }).partial().nullish() }).passthrough() }), data);
  if (parsed.task.status === "succeeded" && parsed.task.content?.url) return { kind: "url", url: parsed.task.content.url };
  throw failedUpstream(parsed.task.status);
}

function wan(data: unknown): RouterMedia {
  const parsed = pick(
    z.object({ output: z.object({ task_status: z.string(), video_url: z.string().optional(), code: z.string().optional(), message: z.string().optional() }).passthrough() }).passthrough(),
    data,
  );
  const { output } = parsed;
  if (output.task_status === "SUCCEEDED" && output.video_url) return { kind: "url", url: output.video_url };
  if (output.code && /inappropriate|sensitive|moderation|policy/i.test(`${output.code} ${output.message ?? ""}`)) refusedThrow(output.message ?? output.code);
  throw failedUpstream(output.message ?? output.task_status);
}

function kling(data: unknown): RouterMedia {
  const parsed = pick(
    z
      .object({
        code: z.number(),
        message: z.string().optional(),
        data: z
          .object({
            task_status: z.string(),
            task_status_msg: z.string().optional(),
            task_result: z.object({ videos: z.array(z.object({ url: z.string() })).optional(), images: z.array(z.object({ url: z.string() })).optional() }).optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
    data,
  );
  const url = parsed.data?.task_result?.videos?.[0]?.url ?? parsed.data?.task_result?.images?.[0]?.url;
  if (parsed.code === 0 && parsed.data?.task_status === "succeed" && url) return { kind: "url", url };
  throw failedUpstream(parsed.data?.task_status_msg ?? parsed.message);
}

function seedance(data: unknown): RouterMedia {
  const parsed = pick(z.object({ status: z.string().optional(), content: z.object({ video_url: z.string() }).partial().nullish(), error: z.object({ message: z.string() }).partial().nullish() }).passthrough(), data);
  if (parsed.content?.video_url) return { kind: "url", url: parsed.content.video_url };
  if (!parsed.status && !parsed.error) throw unreadable();
  throw failedUpstream(parsed.error?.message ?? parsed.status);
}

function ltx(data: unknown): RouterMedia {
  const parsed = pick(
    z.object({ status: z.string().optional(), result: z.object({ video_url: z.string() }).partial().nullish(), error: z.object({ type: z.string(), message: z.string() }).partial().nullish() }).passthrough(),
    data,
  );
  if (parsed.status === "completed" && parsed.result?.video_url) return { kind: "url", url: parsed.result.video_url };
  if (parsed.error?.type && /policy|moderation|safety/i.test(parsed.error.type)) refusedThrow(parsed.error.message ?? parsed.error.type);
  if (!parsed.status && !parsed.error) throw unreadable();
  throw failedUpstream(parsed.error?.message ?? parsed.status);
}

const PARSERS: Record<Exclude<RouterOutputFamily, "binary">, (data: unknown) => RouterMedia> = { gemini, flux, minimax, wan, kling, seedance, ltx };

/** Finds the generated media in a Router result, or throws a typed failure (refusal or upstream failure). */
export function extractRouterMedia(
  family: RouterOutputFamily | undefined,
  result: { kind: "json"; data: unknown } | { kind: "binary"; data: Uint8Array; contentType: string },
): RouterMedia {
  if (result.kind === "binary") return { kind: "inline", bytes: result.data, mime: result.contentType };
  if (!family || family === "binary") throw unreadable();
  return PARSERS[family](result.data);
}
