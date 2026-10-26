---
name: comfy-router
description: Call hosted models (Nano Banana, Seedance, Kling, Wan, FLUX, MiniMax H3 and others) through Comfy Router with quotes, idempotency, credits tracking, and 24-hour retention handling. Use when building the RouterExecutor, the live model catalog, or any Router request body.
---

# Comfy Router

## Facts (verified from docs and from the previous project's working code)

- Origin `https://api.comfy.org`, path `/v2/models/{provider}/{model}`. Header `X-API-Key: comfyui-...`. Optional `Idempotency-Key`. Credits used come back in `x-comfy-credits-used`; error category in `x-comfy-error-type`; `409` with `concurrency_limit_exceeded` and `429` with `retry-after` are retryable; `5xx` retryable; everything else is not.
- Credits only; no subscription needed. Per-model prices are in the catalog. Inputs are deleted 24 hours after upload and outputs 24 hours after generation: download and verify into managed storage immediately after completion, and treat a missing output as recoverable only within that window.
- Each model has a published input schema and native output. Do not hand-write a Zod body per model. Build the body from the schema plus a semantic field map (prompt, image inputs, aspect or size, duration, seed) and validate against the fetched schema.
- Providers moderate content; a rejection is a per-candidate error with the provider's reason, never a crash.
- The TypeScript SDK exposes `comfy.models.run(model, nativeBody, { idempotencyKey })` (verified October 26 with `vertexai/gemini-nano-banana-2.1` and `anthropic/claude-opus-5-5`); the catalog is `GET https://api.comfy.org/v2/models?limit=100` with cursor paging (262 models) and per-model schemas at `/v2/models/{id}/openapi.json`.
- The catalog includes text models (`anthropic/claude-opus-5-5`, `anthropic/claude-sonnet-5-5`, `openai/gpt-5.5`, Gemini) that accept their native request bodies, plus `ltx/ltx-2-5-fast`, `ltx/ltx-2-5-pro`, `krea/krea-3`, `qwen/qwen-image-3.0`, Seedance, Kling, Wan 3. Nano Banana 2.1 two-reference composition at 1K cost about 13 credits and returned in 15 seconds.

## Port these from `../open-higgs/src/server/`

`router-provider.ts` (fixed origin, estimate, queue, status, result; safe failure mapping), `router-service.ts` (budgeted intent, bounded idempotency recovery), `router-media.ts` (PNG and MP4 decode and retention), `router-download.ts` (downloads across changing CDN hosts), `router-billing.ts` and `router-approval.ts` (quotes, unquoted approval, reservations, charges), `model-library.ts` (model list and schema fetch, cache). Reformat to this repo's conventions and replace the per-model body union with the schema-driven builder.

## Capability tagging from a model schema

Image output and no image inputs: `text_to_image`. Image output with one or more image or reference inputs: `image_edit` (record the max count). Video output with `first_frame` style input: `image_to_video`; with both first and last: `first_last_to_video`; with a reference array: `references_to_video`; with no image input: `text_to_video`. Keep a curated override file for models the heuristics get wrong, and label every untested recipe as unverified in the UI.

## Procedure for one Router job

1. Resolve recipe and build the body from the semantic map; validate.
2. Quote when the model offers an estimate; reserve against the allowance; if no quote, require explicit per-shot confirmation and reserve the recipe's documented ceiling.
3. Persist intent, submit with the job's idempotency key, persist the request id immediately.
4. Poll with the returned pacing; copy and verify outputs locally; replace the reservation with the credits header charge; log in `docs/VERIFICATION.md` for real runs.
