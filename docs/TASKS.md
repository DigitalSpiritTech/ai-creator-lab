# Task board

Ordered by workstream. Each task names its owner agent, what it depends on, and the acceptance check that makes it done. Mark tasks with [x] when done and add the commit hash. Add new tasks here rather than leaving TODOs in code.

Cut order if behind schedule: E7 MCP server, A8 Set library item, B7 first/last clips, A6 captions, C8 reference sheet (stills then take face and body directly), C6 body reference. Never cut the end-to-end path: brief, bible, face lock, product, script, stills, clips, assembly.

## A. Foundation (domain-engineer)

- [x] A1 Scaffold (commit 2, scaffold): Next.js 16 app, Tailwind 4, shadcn/ui primitives ported, ESLint, tsx tests, scripts for dev, build, typecheck, lint, test. Acceptance: `npm run typecheck && npm run lint && npm test && npm run build` pass on a clean clone with Node 22.
- [x] A2 Storage port: SQLite store with migrations, managed media directory, atomic commits, idempotent request IDs, uncertain-job recovery, asset streaming routes. Acceptance: ported tests pass; a project and a mock job survive restart; relocating the data directory and restarting works. Done in `cad037c`.
- [x] A3 Domain schema: workspace settings, projects, library items (character, product, set) with project links (a project-character link carries the wardrobe choice and the approved reference sheet asset), assets with provenance and archive flag, scripts (versioned), content pieces (ad), shots with candidates and approvals, cuts and exports. Zod contracts in `src/lib/domain/`. Acceptance: migration from empty database; unit tests for every state transition (select, approve, archive, delete-everywhere breaks references cleanly). Done in `cad037c`.
- [x] A4 Tools layer: `src/server/tools/` with one typed tool per domain action (see CLAUDE.md roster). Each tool: Zod input, Zod output, pure where possible, side effects through the store and executors. Acceptance: tool registry builds JSON schemas from Zod; a test calls every tool against a temp database. Done after `cad037c` (executors reconciled onto the domain job and `run.ts`); the registry now has 22 roster tools plus the internal `submit_proposal`.
- [x] A5 Assembly: ffmpeg join of approved clips in script order to 1080 x 1920 at 24 fps, scale and pad, audio re-encode with silence fill, mute option, poster extraction, ffprobe verification, source record. Acceptance: synthetic clips of mixed sizes and frame rates join correctly; output metadata asserted; export survives restart. Done in `516b21a`: `src/server/assembly/`, the `assemble_ad` tool renders and saves the export record and an `export` asset, idempotent by export id; `tests/assembly-render.test.ts`.
- [x] A6 Captions: burn on-screen text per beat with drawtext inside the safe area, font bundled or detected. Acceptance: visual check on a synthetic export; text never clipped at 1080 x 1920. Done in `516b21a`: DejaVu Sans Bold bundled in `assets/fonts/` with its license (override with `CAPTION_FONT_PATH`); layout sized from the font's advance widths; frames checked by eye and by pixel difference in `tests/assembly-render.test.ts`.
- [x] A7 Archive and delete: archive and restore; delete-everywhere removes files, marks references broken, and refuses when an export depends on the asset unless confirmed. Acceptance: tests cover each path. Done in `516b21a`: `tests/assembly-archive-delete.test.ts` against real files and rendered exports.
- [x] A8 Set library item (stretch): location references usable as an extra reference in stills. Done after `516b21a`: `create_set`, `link_library_item`, and still prompts reference the set whose name the beat setting names.
- [x] A9 HTTP acceptance smoke: isolated temp workspace, mock executor, full flow through HTTP routes, restart, relocated restore. Acceptance: `npm run test:acceptance` passes. Done in `516b21a`: `scripts/acceptance-smoke.ts` builds, runs `next start` on a temp data directory with placeholder keys and a zero allowance, drives the flow over the API routes, restarts, and relocates; `ACCEPTANCE_LAYER=tools` runs the same flow through `callTool`.

## B. Providers and catalog (provider-engineer)

- [x] B0 Spike (done October 26 evening): `scripts/spike/run.ts` ran all checks on real accounts: Z-Image text-to-image, Qwen Image Edit 2511 two-reference composition, LTX 2.5 image-to-video with dialogue on Comfy Cloud; Nano Banana 2.1 composition and a Claude Opus 5.5 call on Router. Rows and defaults are in docs/VERIFICATION.md. 36 credits total. The live checks (`scripts/live-check.ts`) are done as well.
- [x] B1 Executor interface: `estimate`, `submit`, `poll`, `retrieve`, `cancel?` with durable job records and the uncertain state. Acceptance: contract tests against the mock executor. Done in `cad037c`.
- [x] B2 Router executor: port and reformat `router-provider.ts`, `router-service.ts`, `router-media.ts`, `router-download.ts`, `router-billing.ts`; generic request body built from the model's schema plus a semantic field map; idempotency; credits header capture; 24-hour retention handled by immediate local copy. Acceptance: ported offline tests pass with fixtures; one real run recorded. Done in `cad037c`.
- [x] B3 Workflow executor: @comfyorg/sdk client targeting `COMFY_BASE_URL`; load API-format workflow; apply slot map (prompt, images, size, length, seed); lazy asset upload; submit with idempotency key; poll authoritative; stream for progress; copy outputs locally before signed URLs expire. Acceptance: offline tests with a recorded job fixture; one real run recorded. Done in `cad037c`.
- [x] B4 Catalog: capability enum; recipe schema; slot sidecar schema; starter workflows under `workflows/` with sidecars; live Router model list with schemas cached in SQLite; capability tagging from schemas with curated overrides; open-weights flag; cost hints. Acceptance: catalog lists at least one verified recipe per MVP capability; unverified recipes are labeled. Done in `cad037c`.
- [x] B5 Allowance and ledger: `GENERATION_ALLOWANCE_USD`, Router quotes and reservations, Cloud credits-used capture where available, ledger shown in settings. Acceptance: zero allowance blocks every paid submit path in tests. Done in `516b21a`: the allowance gate in `run.ts` plus the ledger in Settings. Local pre-submit failures settle at zero and uncertain jobs release their reservation after 23 hours.
- [x] B6 Mock executor: deterministic labeled SVG stills and static storyboard "clips" so the whole flow runs without an account. Acceptance: acceptance smoke uses it end to end. Done in `cad037c`.
- [ ] B7 First/last-frame LTX recipe (stretch): workflow and sidecar verified on Cloud.
- [ ] B8 Serial job runner per target respecting one concurrent Cloud workflow; queue position surfaced. Acceptance: two submissions on Standard do not collide; test with a fake clock.

## C. Agent (creative-prompts)

- [x] C1 Creative director system prompt for UGC Creator: role, stage guidance, rules (never claims generation happened, never invents identity details, only product claims from the product card, SFW), tool usage policy. Stored in `src/server/agent/prompts/`. Done in `516b21a`.
- [x] C2 Tool descriptions and argument schemas written for the model (short, example-rich), generated from the A4 registry plus prose. Done in `516b21a`.
- [x] C3 Structured schemas: brief, character bible (with the visual core string), product card, script with beats, shot plan. Acceptance: schema fixtures parse; invalid LLM output is rejected with a retry prompt. Done in `516b21a`.
- [x] C4 Prompt templates: face lock, body reference, still composition per beat type, LTX clip per beat type, refinement edit. Acceptance: snapshot tests; prompts stay under each recipe's limits. Done in `516b21a`.
- [ ] C9 Assistant via Router (after C5): an LLM provider that posts the same Anthropic Messages body to `anthropic/claude-opus-5-5` on Router with the Comfy key, so a user without an Anthropic key still gets the assistant. Acceptance: the scripted eval passes against a recorded Router fixture; settings let the user choose direct Anthropic or Router.
- [x] C5 Agent loop: Anthropic SDK tool use with the registry, streaming to the UI, proposal cards for anything that spends, auto-approve under allowance as a user setting. Acceptance: offline test with a scripted model transcript drives brief to script without network. Done in `516b21a`.
- [x] C6 Body reference step (cut candidate): prompt and tool wiring. Done: the body reference ran in the real end-to-end run, `28ebe66`.
- [x] C8 Reference sheet step: wardrobe selection from the bible or the user, sheet prompt template from the character-bible skill, generation through an `image_edit` recipe with the face and body references as inputs, inspection checklist rendered on the card, approval stored on the project-character link; still prompts switch to the sheet as reference image 1 once one is approved. Acceptance: snapshot test of the prompt; a scripted conversation reaches an approved sheet; stills without a sheet fall back to face plus body. Done: the reference sheet ran in the real end-to-end run, `28ebe66`.
- [x] C7 Offline evals: five scripted conversations (two references exist, one missing, none, user changes mind, user rejects all candidates) pass with the scripted model. Done in `516b21a`.

## D. UI (ui-builder)

- [x] D1 Shell: left rail (Projects, Assets, Library, Archive, Settings), theme toggle, responsive to a laptop width. Acceptance: renders with an empty database. Done in `516b21a`.
- [x] D2 Settings: keys (masked, server-only), allowance, default recipe per capability, data directory, connection checks showing plan and credits. Acceptance: keys never appear in any client bundle or API response (test). Done in `516b21a` except the connection check that shows the Comfy plan and credits, which is still open.
- [x] D3 Project page: chat panel with streamed messages and tool cards; workspace tabs Script, Shots, Assets, Export. Done in `516b21a`.
- [x] D4 Candidate grid card: thumbnails, Select, Approve, Archive, Refine; shows recipe and cost; proposal cards with Generate and Cancel. Done in `516b21a`.
- [x] D5 Script editor: beats table, editable fields, version history, "regenerate from here". Done in `516b21a` except "regenerate from here", which is still open.
- [x] D6 Shots board: one row per beat with approved still, approved clip, status, and actions. Done in `516b21a`.
- [x] D7 Export tab: order, mute toggle, captions toggle, export button, player, download, source record. Done in `516b21a` except reordering clips, which is still open.
- [x] D8 Library pages: Characters (bible, face, body, wardrobe), Products, Sets; link to project; archive. Project view shows the character's reference sheet for this project with its inspection checklist and approve action. Done in `516b21a`.
- [x] D9 Assets and Archive pages with filters; delete-everywhere confirmation listing affected items. Done in `516b21a`.
- [x] D10 Manual mode: pick capability, recipe, prompt, references, generate, without chat. Done in `516b21a`.

## E. Docs, demo, release (docs-writer, qa-reviewer)

- [x] E1 README for creators: what it is, what you need (Comfy plan, keys, ffmpeg), install, first ad in ten minutes, pricing expectations, workflows folder, troubleshooting, maintainer section, license, credits to Comfy and LTX. No private names. Done in `d81447a`.
- [x] E2 `workflows/README.md`: each starter workflow, what it needs on Cloud, how to open it in ComfyUI, how to customize and re-import, slot sidecar format. Done in `d81447a`.
- [ ] E3 Demo (recording still open): two-minute recording following docs/PRODUCT.md outline, real outputs, SFW.
- [x] E4 Social post draft with the required hashtag and the demo link; build-in-public thread draft. Done in `d81447a`.
- [ ] E5 Fresh-install verification on a clean directory with Node 22, recorded in docs/VERIFICATION.md.
- [x] E6 Privacy and secret scan (verify-release skill) passes. Passing at `28ebe66`.
- [ ] E7 MCP server (stretch): stdio server exposing the A4 registry; Claude Code config example in README.
- [ ] E8 Submission packet: repo public, license, demo link, social post link, form answers drafted for the maintainer to submit.
