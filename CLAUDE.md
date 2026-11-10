# CLAUDE.md

Start by reading `AGENTS.md`, then `docs/PLAN.md`, `docs/PRODUCT.md`, and `docs/TASKS.md`. Those four files are the contract for this repository. this repository is public.

## Commands

```sh
npm ci
npm run dev            # http://127.0.0.1:3000
npm run typecheck
npm run lint
npm test
npm run test:acceptance
npm run build
```

Environment lives in `.env.local` (never committed). Variables: `COMFY_API_KEY`, `COMFY_BASE_URL` (blank for Comfy Cloud, a deployment URL, or `http://127.0.0.1:8189` for the local proxy), `ANTHROPIC_API_KEY`, `LLM_MODEL`, `GENERATION_ALLOWANCE_USD` (set by the maintainer only; the operator ceiling per calendar month, UTC), `STUDIO_DATA_DIR`, `FFMPEG_PATH`, `FFPROBE_PATH`.

## How to run a build session

1. Read `docs/TASKS.md` and pick the next unblocked tasks per workstream.
2. Branch from `develop` as `feature/<task>` (see `CONTRIBUTING.md`; releases are tagged on `main` only). Spawn one agent per workstream in parallel, each in its own worktree. Give each agent the task IDs, the acceptance checks, and the skills it needs. Agents own files in their workstream only; shared contracts in `packages/core/src/domain/` (and the plugin registry in `packages/core/src/registry/`) are changed by domain-engineer, and other agents request changes through a note in the task.
3. Every agent runs the definition-of-done commands before reporting. Reports list files changed, tests added, and anything not finished, with the task ID.
4. Hand the combined diff to qa-reviewer before merging. qa-reviewer runs the verify-release skill and reports findings ranked by severity. Fix blockers before committing.
5. Update `docs/TASKS.md` with [x] and the commit hash. Log any real provider run in `docs/VERIFICATION.md`.

## Agents (`.claude/agents/`)

Model and effort are pinned in each agent's frontmatter (ids confirmed against the Anthropic models list on October 26, 2026: claude-opus-5-5, claude-sonnet-5-5, claude-fable-5-1); pass them through unchanged when spawning. The in-app assistant uses `LLM_MODEL`, currently claude-opus-5-5.

- provider-engineer (Opus 5.5, high): executors, catalog, starter workflows, the spike.
- domain-engineer (Opus 5.5, high): storage, domain contracts, tools layer, assembly.
- ui-builder (Opus 5.5, medium): shell, settings, chat, cards, library, assets.
- creative-prompts (Opus 5.5, high): system prompts, structured schemas, prompt templates, agent loop, evals.
- qa-reviewer (Fable, high): independent verification, privacy and secret scans, release checks.
- docs-writer (Sonnet 5.5, medium): README, workflows docs, demo script, social post.

## Layout

npm workspaces. `packages/core` (domain contracts, pure catalog types, spend policy, plugin registry), `packages/recipes` (starter catalog, `workflows/`, Router adapters, prompt renderers), `packages/executors` (executors, allowance and spend settlement, Router and Comfy clients, backend probe), `packages/ui` (shadcn primitives), `packages/content-ugc-ad` (the UGC Ad content type as a plugin), `packages/content-social-post` (the Social Post content type as a plugin, with its own tools, assistant, and panels), and `apps/creator` (the Next.js app: routes, pages, store, tools, agent, assembly, MCP server, scripts). Every script runs from the repository root, which stays the working directory. A new content type is a plugin package listed in `apps/creator/src/plugins/installed.ts` (its server half in `server.ts`, its panels in `panels.tsx`); see CONTRIBUTING.md, which also covers adding a Router family. Records carry an `ownerId` (the default owner `local`; the request context carries it), projects an optional `parentProjectId`, and `startProject` seeds a project from an inbound context (brief and Library refs; the gallery's "start from example"). A content type can declare modes (the Ad's Quick Ad: its own steps and panel; the Ad's `mode` records it). `examples/` holds the gallery examples (schema in `packages/core/src/domain/gallery.ts`, the app's Gallery page, `npm run gallery:build` for the static site). `npx ai-creator-lab` is the root `bin` (`apps/creator/scripts/launch.mjs`): Node check, data folder, build on first run in a clone, serve on 127.0.0.1. ffmpeg and ffprobe are bundled (`ffmpeg-static`, `@derhuerst/ffprobe-static`) unless `FFMPEG_PATH` and `FFPROBE_PATH` are set.

## Skills (`.claude/skills/`)

- comfy-cloud-api: running workflows on Comfy Cloud, API deployments, and the local proxy with `@comfyorg/sdk`.
- comfy-router: calling hosted models through Comfy Router, schemas, quotes, retention.
- recipe-catalog: capabilities, recipes, slot sidecars, starter workflows.
- ugc-script: script structure and beat types for UGC ads.
- character-bible: bible schema, face lock, body reference, naming and archiving.
- ltx-prompting: LTX 2.5 image-to-video and first/last prompts with audio.
- video-assembly: ffmpeg join, captions, verification.
- verify-release: checks before every commit and before release.

## Tool roster (domain tools, `apps/creator/src/server/tools/`)

`get_project_state`, `save_brief`, `save_character_bible`, `propose_candidates` (capability, recipe, prompt, references, count; returns a proposal the UI gates), `select_reference` (asset to a library slot, archives siblings), `generate_face_candidates` and `generate_body_reference` (the standard face and body proposals as one call, for the workspace buttons and the assistant), `generate_reference_sheet` (per project, from the approved face and body), `save_product`, `generate_product_images` (product photo candidates from the appearance line, target `product_image`), `save_script`, `plan_shots`, `compose_still`, `refine_still`, `generate_clip`, `extract_voice_sample` (the character's voice sample from an approved talking clip's audio), `generate_voice_over` (a b-roll or text card line read in the cloned voice, target slot `voice`), `approve`, `archive_asset`, `delete_asset_everywhere`, `assemble_ad`, `list_assets`, `list_recipes`, `link_library_item` (attach a Library character, product, or set to a project without changing it), `unlink_library_item` (refused while an approved still or clip was made from its images), `archive_library_item` (hide from new selections, restorable), `create_set` (name, notes, image asset ids), `set_cut_order` (the export's clip order, every shot id once), `reset_shots` (regenerate from a beat: withdraws that beat's and later approvals), `list_document_versions` and `restore_document_version` (the artifact panel's history for the brief, bible, product card, and script; a restore saves the old version as the newest), `set_recipe_preference` (a project's recipe for one capability, or null to clear; per-run choice, then project preference, then Settings default, then the purpose and starter defaults), `regenerate_with` (a candidate's own shot spec, references, and destination proposed with another recipe; the prompt is re-rendered in that model's style), `start_quick_ad` (the Quick Ad, F11: two lines become the brief, a one-beat four-second talking script, and an Ad in quick mode; then the frame, the clip, and the export are the three approvals), and for an Ad assembled as a recording with cutaways (F5) `generate_take` (the full talking recording: every line in one continuous clip from the first talking beat's approved still, target `take`; a proposal, chained by item 11's length strategy when it is longer than one run), `transcribe_take` (the approved recording's words with times, capability `speech_to_text`; a proposal, and the two Whisper recipes are planned, not runnable yet), and `save_edl` (the edit decision list: drafted from the transcript, or edited windows and captions in seconds on the recording; a versioned document, nothing generated). 37 tools, plus the internal `submit_proposal` that only the UI gate calls and the proposal card's `rerender_proposal` and `recipe_options` (each behind its own route). `approve` also takes kind `slot` for a plugin content piece's named slot and kind `take` for an Ad's talking recording, the document tools take kind `piece` for its body and kind `edl` for an Ad's edit decision list, and `assemble_ad` takes an optional `strategy` (`component`, the default for a new export, or `take_cutaways`: the recording's sound untouched, b-roll in the EDL's windows, captions at its times). User-facing text says "recording" for a take; identifiers keep `take`.

Plugin tools come after the 37 and are named `<plugin id>_<action>`: Social Post adds `social_post_save_copy` (the post's caption, hashtags, call to action, and visual line; a versioned document), `social_post_propose_still` (a proposal for one aspect ratio, 1:1, 4:5, 9:16, or 16:9, through `propose_candidates`), and `social_post_export` (the approved stills per ratio and the copy as text). A plugin tool runs against a port scoped to its plugin's Apps, pieces, and owner: it can call the tools the assistant is offered for its content types, on records in that scope only, and never `submit_proposal` or `delete_asset_everywhere`.

In an Ad project the assistant is offered `AGENT_TOOLS`, which is everything but `delete_asset_everywhere` (a person's click on the Archive page); in a project of another content type it is offered `agentToolsFor(contentType)`: the workspace tools, the roster tools its steps name, and its plugin's tools, with that plugin's system prompt when it brings one. The MCP server offers every roster and plugin tool, and spending and deletion only with `MCP_ALLOW_SPEND=1` / `MCP_ALLOW_DELETE=1`. Keep the names stable. SECURITY.md records the threat model; child processes get `childEnv()` (no keys, `packages/executors/src/process.ts`), and every route goes through `assertLocalRequest` (`apps/creator/src/server/http.ts`).
