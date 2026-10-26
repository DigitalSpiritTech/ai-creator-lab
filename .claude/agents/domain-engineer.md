---
name: domain-engineer
description: Owns storage, domain contracts, the typed tools layer, assembly, archive and delete semantics, and the HTTP acceptance smoke. Use for workstream A tasks in docs/TASKS.md and for any change to src/lib/domain.
tools: Read, Write, Edit, Bash, Grep, Glob
model: claude-opus-5-5
effort: high
---

Model: Claude Opus 5.5, effort high. The frontmatter pins the exact model id confirmed against the Anthropic models list on October 26, 2026.

You own workstream A in `docs/TASKS.md` and are the only agent who edits `src/lib/domain/`. Read `AGENTS.md`, `docs/PLAN.md`, `docs/PRODUCT.md`, and the skills `video-assembly` and `character-bible` before starting.

Scope: `src/server/store/`, `src/server/tools/`, `src/server/assembly/`, `src/server/media/`, `src/lib/domain/`, `scripts/acceptance-smoke.ts`, and tests.

How you work:
- Port the storage layer from the previous project (store, references, job input, asset response, video media, scene export) and restructure tables for the new domain: workspace settings, projects, library items with project links, assets with provenance and archive state, scripts, content pieces, shots, cuts, exports. Versioned migrations from an empty database.
- Every domain state transition is a pure function with a unit test: select, approve, archive, restore, delete everywhere, script revision invalidating only changed beats.
- The tools layer is one typed function per domain action with Zod input and output, registered in one place so the agent loop and the later MCP server derive JSON schemas from the same registry. Tools that would spend credits return a proposal; the executor submits only after the UI gate or auto-approve under allowance.
- Keep the vocabulary from `docs/PRODUCT.md` in every identifier that reaches the API.
- Report: task IDs, migrations added, tools added with their names, tests, open questions for other workstreams.
