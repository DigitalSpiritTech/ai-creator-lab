---
name: comfy-cloud-api
description: Run ComfyUI workflows on Comfy Cloud, a Comfy API deployment, or a self-hosted ComfyUI proxy through @comfyorg/sdk (Comfy API v2). Use when building or debugging the WorkflowExecutor, the Cloud spike, starter workflows, or anything that submits a workflow and retrieves outputs.
---

# Comfy Cloud and API v2

## Facts to rely on (verified October 26, 2026 from docs.comfy.org)

- One client, three targets. The SDK reads `COMFY_BASE_URL` at construction: blank means Comfy Cloud (`https://cloud.comfy.org`), a deployment is `https://<deployment>.run.comfy.app`, the self-hosted proxy is `http://127.0.0.1:8189` (no key by default). Cloud and deployments need an API key from platform.comfy.org.
- Auth is `Authorization: Bearer <key>` on v2. The older v1 Cloud API uses `X-API-Key` and is deprecated; use it only for Cloud-specific reads v2 lacks (account info `GET /api/user`, queue, model browsing).
- API access requires a paid Comfy Cloud subscription. Standard runs one workflow at a time with a 30-minute cap. `402` means not enough credits; `429` on v1 means inactive subscription.
- Workflows are API format (`Export (API)` in the ComfyUI menu), not the UI save format. Model file names in the graph must exist in Comfy Cloud's model library. Build starter workflows from Cloud's own templates, never from local graphs with quantized file names.
- Partner nodes inside a Cloud workflow work with the same key (v1 passes it as `extra_data.api_key_comfy_org`; the SDK handles this).
- Outputs: `job.getOutputs(nodeId)` returns handles; `toFile(path)` saves. Signed download URLs last about six hours, so copy bytes into managed storage immediately and never persist the URL.
- Polling is the source of truth. `job.events()` streams `progress`, `outputReady`, `statusChange` and reconnects, but `wait()`, `run()`, and `result()` decide terminal state.
- Idempotency: `submit(wf, { idempotencyKey })`. Reusing a key throws `IdempotencyKeyReuse`; recover with `client.jobs.get(savedJobId)`. Save the job id the moment submit returns, before anything else.
- Job metadata labels and `listJobs` work only on deployments, not Cloud.
- The lowercase `comfy` export is the Router namespace; the `Comfy` class is the Cloud client and has no `.models`.
- Job status strings seen on Cloud: `queued`, `running`, `succeeded`, `failed`. Treat `succeeded` and `completed` both as success. `job.metrics` carries `execution_ms` and `queue_ms`.
- Validation runs before billing: a graph with a missing required input fails in seconds at no cost. Cloud's `ImageScaleToTotalPixels` requires `resolution_steps`.
- Credit balance: `GET https://cloud.comfy.org/api/billing/balance` with `X-API-Key`; `effective_balance_cents` times 2.11 is the credit count the UI shows. It lags a finished job by up to a minute, so settle per-run cost later rather than from an immediate read.
- Observed costs on October 26: Z-Image 1024x1024 about 2 to 3 credits; Qwen Image Edit 2511 two references at 768x1344 with the Lightning LoRA about 7; LTX 2.5 576x1024, 121 frames about 10. Queue plus execution was under 50 seconds for each when the node was warm.

## Procedure: WorkflowExecutor

1. Install: `npm i @comfyorg/sdk`. Read `node_modules/@comfyorg/sdk/dist/*.d.ts` for exact signatures before writing code; this skill summarizes, the types decide.
2. Load the recipe's workflow file and its slot sidecar (see recipe-catalog). Apply slots: text slots set string inputs; image slots call `client.assets.fromFile(localPath)` and `wf.setInput(nodeId, inputName, asset)`; numeric slots set width, height, length, fps, seed.
3. Persist intent (job record `preparing`) with the exact workflow JSON and input hashes, then `submit` with the job's idempotency key, then persist the returned job id (`submitting` to `queued`).
4. Poll on a backoff; store status transitions; surface queue position when available.
5. On terminal success, copy every output of the designated save node into managed storage through a temp file and rename, verify (PNG decodes at the expected size; MP4 passes ffprobe with the expected frame count, fps, codec, audio), then commit the asset and `completed` together.
6. On ambiguous submit failure (timeout after the request left the process), mark `uncertain` and resolve by `jobs.get` before any resubmission. Never resubmit a paid job automatically.
7. Record real runs in `docs/VERIFICATION.md`, with the credit balance before and after. Read the balance from the v1 Cloud API (`GET https://cloud.comfy.org/api/user` with `X-API-Key`, or the billing endpoints the previous project's `router-billing.ts` used) and compute the delta; Cloud jobs do not always report credits per job. Keep a running total against the cap in the same file.

## Procedure: the spike (`scripts/spike/`)

Write small `tsx` scripts, one per check, that take paths and a prompt from the command line, run against the real target, save outputs under `.data/spike/`, print timings and any credits information, and exit non-zero on verification failure. Checks: LTX 2.5 image-to-video (vertical input), a multi-reference image edit (two references plus a product image), a text-to-image. Use the invented example persona. Fill the spike rows in `docs/VERIFICATION.md`.

## Where to read more

docs.comfy.org: `/api-reference/v2/overview`, `/development/api-development/sdks`, `/development/deploy/cloud`, `/development/cloud/overview` (v1), `/api-reference/v2/assets/...` and `/api-reference/v2/jobs/...` pages for raw HTTP when the SDK is not enough. Comfy's MCP (`https://cloud.comfy.org/mcp`) has `search_templates`, `get_template`, `get_template_schema`, and `get_prompting_guide`; use it from Claude Code to fetch Cloud-blessed template graphs for the starter workflows.
