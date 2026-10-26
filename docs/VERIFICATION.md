# Verification log

Every real provider run (anything that spends credits or tokens on a real account) gets a row here, written by the agent or person who ran it. Mock and offline test results do not belong here; those are in CI output.

Budget: the whole build, spike included, is capped at the allowance in `.env.local` ($5, about 1,050 credits at 210 credits per USD). Notices at 50 percent (525 credits) and 80 percent (840 credits); hard stop at 1,050 until Ted raises it. Starting balance on the Base plan, October 26: 5,496 credits.

Running total spent: 153 credits (0.73 USD) of the 1055-credit cap, settled from the balance endpoint (start 5,496 credits, now 5,343).

Columns: date (America/Chicago), who, target (cloud, deployment, proxy, router), recipe, inputs (asset hashes or short description), result (asset path or failure), credits (balance before, after, delta), duration, notes.

| Date | Who | Target | Recipe | Inputs | Result | Credits (before / after / delta) | Duration | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-10-26 17:32 | e2e-real | cloud | full flow through the tools layer: Z-Image face (2), Qwen Edit body, Qwen Edit reference sheet, Z-Image product, Qwen Edit still and LTX clip for 3 beats, ffmpeg assembly with captions | Avery Lane bible, Ridgeline bottle, 3-beat script (talking, broll, talking) | .data/exports/0f13de87-...mp4, 1080x1920, 24 fps, 15.1 s, AAC; reference sheet 1344x768 three-column; identity consistent across beats | about 60 per full pass (two partial reruns cost about 55 more) | about 6 min of generation over four calls | project 17429621-3f49-45d7-ad5d-db7d6f9afea1; first complete ad produced by the application code |
| 2026-10-26 16:35 | live-check | cloud | z-image-turbo-t2i through propose_candidates, submit_proposal, run.ts, store commit | face-lock prompt with explicit head turn, 896x1120 (4:5) | .data/media/8c4e589d-...-0.png, three-quarter view as asked; asset row committed with sha | about 2 to 3 (settle later) | 22s | job 8c4e589d-80fa-462d-8a8a-b09034f19704; first real run through the application code path |
| 10/26/2026, 15:39:41 | spike | router | anthropic/claude-opus-5-5 | 120 token prompt | json reply received | 5461 / 5461 / 0 (0.00c) | 3s | request 1c0aa9c7-9fa1-4d7c-bc02-30fd88fc5cb6 |
| 10/26/2026, 15:39:19 | spike | router | vertexai/gemini-nano-banana-2.1 | face.png + product.png | .data/spike/router-composite.png 768x1376 png | 5474 / 5474 / 0 (0.00c) | 15s | request d52907a3-4341-4c26-9bc6-c77bd36eac54 |
| 10/26/2026, 15:38:32 | spike | cloud | ltx-2.5-i2v | composite.png | .data/spike/clip.mp4 576x1024 h264 121f 5.04s audio:aac | 5484 / 5484 / 0 (0.00c) | 47s | job 371d686a-ee2f-4926-81cf-441830a4de13 |
| 10/26/2026, 15:37:13 | spike | cloud | qwen-image-edit-2511-2ref | face.png + product.png | .data/spike/composite.png 768x1344 png | 5491 / 5484 / 7 (3.54c) | 49s | job ad14b0ab-3b86-4b6d-a162-fe48a1c25f4f |
| 10/26/2026, 15:36:07 | spike | cloud | edit |  | FAILED: job failed: {"class_type":"ImageScaleToTotalPixels","code":"node_execution_error","message":"Prompt outputs failed validation. node 30 (ImageScaleToTotalPixels): resolution_steps required_input_missing | 5491 / 5491 / 0 (0.00c) | 0s |  |
| 10/26/2026, 15:35:17 | spike | cloud | z-image-turbo-t2i | prompt:product | .data/spike/product.png 1024x1024 png | 5494 / 5494 / 0 (0.00c) | 18s | job e145a3af-431b-4e1f-b6b6-78f9029c9f0d |
| 2026-10-26 15:34 | spike | cloud | z-image-turbo-t2i | prompt:face (1024x1024, seed 7) | .data/spike/face.png 1024x1024 png | 5496 / 5494 / 2 (0.94c) | 17s (queue 8.4s, exec 7.7s) | job f33eefc3-d88b-4a35-9f1a-3c9a0229c1b5; output recovered by job id after a client-side status bug |


## Spike results (October 26, evening)

All four capability checks passed on real accounts in about 40 minutes, for 36 credits total (about 0.17 USD). Balance endpoint: `GET https://cloud.comfy.org/api/billing/balance` with `X-API-Key`; `effective_balance_cents` times 2.11 equals the credit count shown in the Cloud UI. The balance lags a run by up to a minute, so per-run deltas read immediately can show zero; settle from the balance later.

| Check | Recipe | Result | Credits | Time |
| --- | --- | --- | --- | --- |
| Text to image | `z-image-turbo-t2i` on Cloud (open weights) | 1024x1024 face and product stills, photographic, prompt followed except "three-quarter view" (came out near frontal) | about 2 to 3 each | 17 s (queue 8 s, exec 8 s) |
| Two-reference composition | `qwen-image-edit-2511-2ref` on Cloud (open weights, Lightning 4 steps) | 768x1344 still: identity, freckles, earrings, tee, bottle color and cap all preserved; kitchen setting rendered | about 7 | 48 s cold |
| Image to video with dialogue | `ltx-2.5-i2v` on Cloud (open weights) | 576x1024, 121 frames, 24 fps, 5.04 s, H.264 plus AAC stereo; visible speech, static camera, identity held; audio peaks at -1.8 dB | about 10 | 46 s |
| Two-reference composition, hosted | `vertexai/gemini-nano-banana-2.1` on Router | 768x1376 still, natural pose and light, identity close | about 13 | 15 s |
| Assistant on Comfy credits | `anthropic/claude-opus-5-5` on Router | native Anthropic Messages response (thinking block included) with only the Comfy key | under 1 | 5 s |

Defaults decided for the MVP: `text_to_image` Z-Image Turbo on Cloud; `image_edit` Qwen Image Edit 2511 on Cloud with Nano Banana 2.1 on Router as the hosted alternative; `image_to_video` LTX 2.5 on Cloud with `ltx/ltx-2-5-fast` on Router as the hosted alternative (untested). Assistant backend: Anthropic key direct, with Router (`anthropic/claude-opus-5-5`) as the no-extra-key option to add.

Fixes found: Cloud's `ImageScaleToTotalPixels` requires `resolution_steps` (validation rejected the job before charging); job status reads `succeeded`, not `completed`; the LTX graph needs an exactly 576x1024 input, so the app crops and scales before upload (ffmpeg crop plus Lanczos in the spike, sharp in the app). Z-Image ignores "three-quarter view" wording; the face-lock template must state the head turn explicitly.

Private outputs are under `.data/spike/` (ignored): `face.png`, `product.png`, `composite.png`, `composite-576x1024.png`, `clip.mp4`, `clip-contact.png`, `router-composite.png`.

## First complete ad (October 26, evening)

`scripts/e2e-real.ts` drove the real tools on real credits without the assistant: brief, bible, two face candidates and a lock, body reference, project reference sheet, product still, three-beat script, one still and one LTX clip per beat with approvals, and `assemble_ad` with captions. Output: 1080x1920, 24 fps, 15.1 s, H.264 with AAC, 5.6 MB. Identity held across the two talking beats; captions sit inside the safe area. Creative notes for the prompt templates: the still model printed the product name on the bottle (product prompts need "no text or logo on the product" when the product card carries a name), and one still added a second, unrelated bottle. Operational note: a background process on the Mac dies when the shell call that started it ends, so the script resumes from saved project state (`PROJECT_ID`, `E2E_MAX_BEATS`) and the UI's two-second job polling is the normal driver.

Spend today: 153 credits, about $0.73, including the spike and two partial reruns.
