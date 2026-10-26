# AI Creator Lab: build plan

Status: Phase 0 (planning). Written October 26, 2026. Read this before changing scope.

## Why this exists

Primary goal: an open-source studio that creators can run on their own Comfy account as an alternative to closed creator platforms, built and shared in public. Secondary goal: enter the Comfy "Open Source Higgsfield" competition (submissions close October 30, 2026, 9 a.m. Pacific; the maintainer's own submission target is October 29). The competition shapes the MVP cut, not the product.

Audience: non-technical creators, many of them building UGC-style content for a single affiliate or owned product. They will pay for a Comfy Cloud plan and credits. They will not install model files, write workflows, or read API docs.

Positioning in one line: an open-source UGC creator studio that runs on your own Comfy account.

## Product principles

1. The user brings their own Comfy account. The app never proxies or resells generation. Keys stay on the user's machine or server.
2. No "only" model. Every step declares a capability; any recipe that satisfies that capability can run it. Recipes are either hosted models (Comfy Router and partner models, with their published input schemas) or workflows (API-format JSON with a slot map) run through Comfy API v2 against Comfy Cloud, a Comfy API deployment, or a self-hosted ComfyUI proxy.
3. Chat-first. A built-in agent walks the user from "what are you selling" to a finished ad. The agent proposes, the user approves, the app submits. The same domain tools are exposed to the in-app agent and (later) to any MCP client such as Claude Code.
4. Everything approved is reusable. Characters, products, and sets live in the Library above projects. Projects scope the working context.
5. Honest provenance. Every asset keeps its recipe, inputs, prompt, and cost. Mock runs are labeled. Nothing claims a capability that has not been verified.
6. Durable and recoverable. Submit once, resume after restart, never double-spend credits.

## Scope: MVP for October 29

The MVP is one App, UGC Creator, with one content type, Ad.

Must have:

- Settings: Comfy API key, Anthropic API key, data directory, generation allowance (USD, zero disables paid runs). Keys never reach the browser.
- Workspace shell: Projects, Assets, Library, Archive. Light and dark theme.
- Project created from the UGC Creator app with a chat panel, tool-result cards, and the project's asset grid.
- Capability and recipe catalog with two executors (Router executor, Workflow executor) and a mock executor for credit-free trials.
- Starter recipes verified on real Comfy accounts: at least one text-to-image, one multi-reference image edit, and LTX 2.5 image-to-video on Comfy Cloud. Router image and video models listed from the live catalog, filtered by capability.
- Creative flow through the agent: brief, character bible, face lock (3/4 view), body reference (3/4 full body, athleticwear), per-project character reference sheet (portrait plus full-body front and back in the project's wardrobe, generated from the approved face and body), product card, script with talking and b-roll beats, one start frame per beat composed from the sheet, one LTX clip per beat, assembly to a 1080 x 1920 MP4 with captions from the script.
- Approvals per candidate; rejected candidates archived; archive and delete-everywhere with a clear warning.
- README for creators with setup, pricing expectations, and the maintainer section.
- Two-minute demo video and the social post draft.

Should have if green by the morning of October 29:

- MCP server exposing the domain tools (stdio), so Claude Code and Claude Desktop can drive the same flow.
- Optional Set (location) library item used as a reference in stills.
- First-and-last-frame LTX clips for beats that need an ending pose.

Later (do not build before the 29th):

- Post content type (organic persona content), Microdrama app, episodes.
- OpenAI and local Ollama agent backends (Ollama code exists in the previous project and can be ported).
- Reference video and reference audio inputs for models that accept them (Seedance and similar).
- Remotion-based assembly with motion text and transitions; Cloud-side video combine.
- Vision review gate on Comfy Cloud (does this frame match the bible, is the product legible). Verified available: Comfy Cloud runs Qwen3-VL (`Comfy-Org/Qwen3-VL`, `qwen3vl_4b_fp8_scaled`) through the core Load CLIP plus Generate Text nodes with image, video, and audio inputs, so a review recipe is an open-weights Cloud workflow with no extra key. Not needed for the MVP.
- Text-to-speech recipes and voice consistency.
- Router charge reconciliation UI, Cloud Nodes, local ComfyUI in the UI (local stays reachable through the v2 proxy as an advanced setting).
- Multi-user workspaces.

## Architecture

Next.js 16 App Router, React 19, TypeScript, Tailwind 4, shadcn/ui, Node 22+ with built-in SQLite, Zod 4 at every boundary, @comfyorg/sdk for Cloud, API deployments, and the local proxy, direct HTTP for Router, Anthropic SDK for the agent, ffmpeg on the host for assembly. Single-user, loopback by default, deployable to the user's own server.

Layers, bottom to top:

1. Storage: SQLite with versioned migrations; media on disk under the data directory with relative paths and SHA-256 hashes; atomic output commits; idempotent job requests. Ported from the previous project.
2. Execution: `RouterExecutor` (api.comfy.org `/v2/models/{provider}/{model}`), `WorkflowExecutor` (@comfyorg/sdk against `COMFY_BASE_URL`), `MockExecutor`. All three implement one interface: estimate, submit, poll, retrieve, with durable job records and uncertain-state recovery.
3. Catalog: capabilities, recipes, slot maps, live Router model list with schemas, starter workflow files under `workflows/`.
4. Domain: workspace settings, projects, Library items (character, product, set), assets with provenance, scripts, content pieces (ad), shots (beats with candidate stills and clips, approvals), cuts and exports.
5. Tools: one typed tool set over the domain (Zod in, Zod out). Used by the in-app agent via Anthropic tool use and, later, by the MCP server.
6. Agent: the UGC Creator "creative director" system prompt plus stage guidance; proposes actions; never spends without the UI gate or the user's auto-approve setting under the allowance.
7. UI: workspace shell, chat panel with tool cards (candidate grids with Select, Approve, Archive), asset grid, settings.

Partner-node workflows already in the maintainer's Cloud workspace (for example a Krea 3 image edit) are candidate `image_edit` recipes once a sidecar exists.

The live Router catalog (262 models on October 26) also carries `ltx/ltx-2-5-fast` and `ltx/ltx-2-5-pro`, `krea/krea-3`, `qwen/qwen-image-3.0`, and the Anthropic and OpenAI text models, including `anthropic/claude-opus-5-5`, which answers with the native Anthropic Messages shape. So a credits-only user can run the whole flow, assistant included, with one Comfy key and no plan; the Cloud plan is what adds open-weights workflows.

Comfy product map: Router for hosted partner models (credits only, no plan, 24-hour retention so bytes are copied locally immediately); Comfy Cloud for open-weights workflows (Standard plan or above for API access, one concurrent workflow on Standard); Comfy API deployments and the self-hosted proxy through the same v2 client; partner nodes inside Cloud workflows where a closed model is wanted in a graph (Krea 3, Lightricks LTX API as the fallback if open LTX does not run on Cloud).

## Carry-over from the previous project

Source path: `../open-higgs`, the previous project folder beside this one (read-only reference). Port code, not docs. Reformat ported code to this repo's conventions. Remove references to removed features. Never copy its documentation prose, screenshots, or private names.

Port and keep: `src/server/store.ts` (restructure tables for the new domain), `http.ts`, `runtime.ts`, `references.ts`, `reference-upload.ts`, `job-input.ts`, `asset-response.ts`, `video-media.ts`, `scene-export.ts` (becomes assembly), `router-provider.ts`, `router-service.ts`, `router-media.ts`, `router-download.ts`, `router-billing.ts`, `router-approval.ts`, `router-errors.ts`, `model-library.ts` (Router catalog fetch), `workflow-discovery.ts` (slot detection), `mock-provider.ts`, `src/lib/router-budget.ts`, `src/lib/contracts.ts` (split by domain), `src/components/ui/*`, `src/proxy.ts`, and the tests for those modules.

Port as reference only, then replace: `comfy-provider.ts` and `comfy-service.ts` (legacy local ComfyUI protocol; replaced by the SDK-based WorkflowExecutor), `ltx-workflow.ts`, `minimax-workflow.ts`, `image-edit-workflow.ts` (graph builders; replaced by workflow files plus slot maps), `scene-service.ts` and `scenes.ts` (approval and revision logic is reusable for shots).

Do not port: `scene-workflow.tsx`, `cinematic.ts`, `model-library.tsx`, the Router panel UI, every file under `docs/`.

## Day plan (America/Chicago)

October 26: Phase 0 (this plan, product doc, task board, agents, skills). The maintainer confirms a Comfy Cloud account with API access and a credit balance, and an Anthropic key.

October 26, evening (done): the spike ran ahead of schedule. Z-Image text-to-image, Qwen Image Edit 2511 two-reference composition, and LTX 2.5 image-to-video with dialogue all succeeded on Comfy Cloud with open weights; Nano Banana 2.1 composition and a Claude Opus 5.5 call succeeded on Router. Total 36 credits. Defaults are recorded in docs/VERIFICATION.md. Three starter workflows with sidecars are in `workflows/`.

October 27, rest of day: repo scaffold and ported storage layer; executors with offline tests; catalog with starter recipes; settings page; workspace shell; chat panel skeleton with the first tools (brief, bible).

October 28: face lock, body reference, product, script, shots, stills, clips, assembly, approvals, archive. End-to-end run on real credits by evening. Fresh-install check.

October 29: polish, README with the maintainer section, workflows folder docs, demo recording, social post draft, fresh-install verification, MCP server if everything else is green. Package and submit.

October 30, morning: buffer for submission form issues only.

## Risks and the answer to each

- Cloud workflows reference model files by name and the previous project's graphs were built for one specific local machine. Answer: starter workflows are checked against Cloud's model library (done October 26; the names matched).
- Standard plan allows one concurrent workflow. Answer: the job runner is serial per target; the UI shows queue position.
- Partner moderation can reject creator content. Answer: errors are surfaced per candidate with the provider's reason; the user can switch recipes.
- Credits spent by autonomous agents. Answer: allowance defaults to zero; agents never change it; every real run is logged with the credit balance before and after; the whole build, spike included, is capped at the allowance (about 1,050 credits for $5), with notices at 50 and 80 percent and a hard stop at 100.
- Private material leaking into a public repo. Answer: privacy grep in verify-release; invented example persona only.
- Three build days. Answer: cut in this order if behind: MCP server, Set library item, first/last clips, captions, reference sheet (stills then use face and body directly), body reference. Never cut the end-to-end path.

## Decisions log

- 2026-10-26: Fresh repository in `ai-creator-lab`, no history from the previous project.
- 2026-10-26: Keep Next.js (the maintainer's choice for portfolio and work visibility).
- 2026-10-26: Relax TSDoc and formatting rules for contributors.
- 2026-10-26: First App is UGC Creator; first content type is Ad.
- 2026-10-26: "Library" replaces the Elements concept; "Archive" replaces Trash.
- 2026-10-26: Chat-first UI on Claude is primary; MCP front door is a stretch for the 29th.
- 2026-10-26: Not targeting the Open Weights Only category; LTX is the video default anyway. Body reference uses athleticwear so everything stays SFW.
- 2026-10-26: Local ffmpeg assembly for the MVP; Remotion later.
