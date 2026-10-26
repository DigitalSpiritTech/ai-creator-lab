# CLAUDE.md

Start by reading `AGENTS.md`, then `docs/PLAN.md`, `docs/PRODUCT.md`, and `docs/TASKS.md`. Those four files are the contract for this repository.

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

Environment lives in `.env.local` (never committed). Variables: `COMFY_API_KEY`, `COMFY_BASE_URL` (blank for Comfy Cloud, a deployment URL, or `http://127.0.0.1:8189` for the local proxy), `ANTHROPIC_API_KEY`, `LLM_MODEL`, `GENERATION_ALLOWANCE_USD` (set by Ted only), `STUDIO_DATA_DIR`, `FFMPEG_PATH`, `FFPROBE_PATH`.

## How to run a build session

1. Read `docs/TASKS.md` and pick the next unblocked tasks per workstream.
2. Spawn one agent per workstream in parallel, each in its own worktree. Give each agent the task IDs, the acceptance checks, and the skills it needs. Agents own files in their workstream only; shared contracts in `src/lib/domain/` are changed by domain-engineer, and other agents request changes through a note in the task.
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

## Skills (`.claude/skills/`)

- comfy-cloud-api: running workflows on Comfy Cloud, API deployments, and the local proxy with `@comfyorg/sdk`.
- comfy-router: calling hosted models through Comfy Router, schemas, quotes, retention.
- recipe-catalog: capabilities, recipes, slot sidecars, starter workflows.
- ugc-script: script structure and beat types for UGC ads.
- character-bible: bible schema, face lock, body reference, naming and archiving.
- ltx-prompting: LTX 2.5 image-to-video and first/last prompts with audio.
- video-assembly: ffmpeg join, captions, verification.
- verify-release: checks before every commit and before release.

## Tool roster (domain tools, `src/server/tools/`)

`get_project_state`, `save_brief`, `save_character_bible`, `propose_candidates` (capability, recipe, prompt, references, count; returns a proposal the UI gates), `select_reference` (asset to a library slot, archives siblings), `generate_reference_sheet` (per project, from the approved face and body), `save_product`, `save_script`, `plan_shots`, `compose_still`, `refine_still`, `generate_clip`, `approve`, `archive_asset`, `delete_asset_everywhere`, `assemble_ad`, `list_assets`, `list_recipes`. Keep the names stable; the MCP server (stretch) exposes the same registry.
