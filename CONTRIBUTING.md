# Contributing

Thanks for helping with AI Creator Lab. Read `AGENTS.md` for the working agreements (stack, code conventions, safety rules, definition of done) before you change anything. This page covers where code lives, branches, pull requests, and releases.

## Where code lives

The repository is an npm workspace (`npm ci` at the root installs everything). Run every script from the root: it stays the working directory, so `.env.local`, the `.data` folder, the caption font in `assets/`, and the workflows resolve there.

| Package                                         | What lives there                                                                                                                                                                                             | May import             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| `packages/core` (`@creator-lab/core`)           | Domain contracts (`src/domain/`), the pure catalog types (`src/catalog/`), the spend policy (`src/domain/spend.ts`), and the plugin registry (`src/registry/`). No I/O, no React.                              | nothing else           |
| `packages/recipes` (`@creator-lab/recipes`)     | The starter recipe catalog (`defaults.ts`), the workflow files and slot sidecars (`workflows/`) and their loader, Router adapters, and the per-model prompt renderers (`prompts*.ts`, `render.ts`).            | core                   |
| `packages/executors` (`@creator-lab/executors`) | The Router, workflow, and mock executors, the allowance and spend settlement, the Router catalog and Comfy clients, the backend probe, ffmpeg and ffprobe paths, and `childEnv()`. Server only.               | core, recipes          |
| `packages/ui` (`@creator-lab/ui`)               | The shared shadcn/ui primitives and generic client components (theme provider and toggle).                                                                                                                  | core                   |
| `packages/content-ugc-ad`                       | The UGC Ad content type as a plugin: the Ad, its 13 steps with their tools, and its five workspace panels (by id).                                                                                            | core, ui               |
| `packages/content-social-post`                  | The Social Post content type as a plugin: stills in four aspect ratios plus the copy, its steps, three tools, its assistant, and its three panels (with their components).                                     | core, ui               |
| `apps/creator` (`@creator-lab/app-creator`)     | The Next.js app: routes and pages, app components, the store, the tools layer, generation orchestration (`src/server/generation/run.ts`), the assistant, assembly, media, auth, the MCP server, the installed plugin list (`src/plugins/`), and `scripts/`. | everything above       |

Packages ship TypeScript source with no build step: each `package.json` `exports` points at `.ts` files, Next.js compiles them (`transpilePackages`), and `tsx` runs them in tests and scripts. Import another package by name (`@creator-lab/core/domain/job`, `@creator-lab/executors`); `@/` paths are for the app only. ESLint refuses an import that breaks the direction in the table, and anything a client component imports must stay free of keys, `node:` modules, and the executors.

`tests/` at the root holds the offline tests for every package; `npm test` runs them all.

### Adding a content type

A content type (an Ad, a Social Post) is a plugin package. The shell (the Projects page, the project header, and the workspace tabs), the store, the tools layer, and the assistant read content types, panels, tools, and piece schemas from the registry, so none of them needs a change. `packages/content-social-post` is the worked example: it was added without touching any of them.

1. Create `packages/content-<name>/` with a `package.json` named `@creator-lab/content-<name>` that depends on `@creator-lab/core` (and `@creator-lab/ui` if it ships panels), and `exports` for `.` (the definition), `./server` (its server half, if it has tools or an assistant), and `./panels` (if it ships its own panels).
2. In `src/index.ts`, export `definePlugin({ id, label, contentTypes, steps, panels, recipes })` from `@creator-lab/core/registry`. A content type names its App (`app: { id, label }`, which the Projects page offers and project creation checks) and its `pieceType`. Panel ids are `<plugin id>.<name>`; every step and panel names a registered content type; the content type's `defaultPanel` is one of its own panels. Keep this entry data only, because it reaches the browser.
3. Your content piece is a `PluginPiece` (`@creator-lab/core/domain/piece`): core owns the envelope (project, owner, title, revision) and its named slots (candidates and one approval each, like a shot's still); you own `body`, a JSON object you validate with the schema you register. Generations aimed at `{ kind: "piece", contentId, slot }` land in that slot, `approve` with kind `slot` approves one, and the body is a document (kind `piece`) with the artifact panel's version history and restore.
4. In `src/server.ts`, export the same definition with its server contributions: `tools` (each made with `definePluginTool`: Zod input and output, a name starting with your plugin id in snake case, such as `social_post_save_copy`), `pieces` (`{ pieceType, body }`), and optionally `assistants` (a system prompt and a pure `stage(view)` that picks the next step). A tool runs against a `PluginToolPort`: it reads the project and its pieces, saves pieces (the body is checked and versioned), and calls roster tools such as `propose_candidates` or `get_project_state`. A spending step returns the proposal that call gives back; the port refuses `submit_proposal` and `delete_asset_everywhere`, so only the gate in the chat panel spends. Keep the 33 core tool names; reuse them where they fit.
5. In `src/panels.tsx` (`"use client"`), export `Record<panelId, ComponentType<PanelProps>>`. A panel gets a `host` (`projectId`, `openPanel`, `refresh`, `notify`, `assetUrl`, and `callTool` for the roster and your own tools; a proposal a tool returns is shown in the chat panel for the gate) and imports nothing from the app. Build it from `@creator-lab/ui`.
6. Add the definition to `INSTALLED_PLUGINS` in `apps/creator/src/plugins/installed.ts`, its server half to `SERVER_PARTS` in `apps/creator/src/plugins/server.ts` (prompt renderers keyed by `promptStyle` can go there too, so they stay out of the browser), the panels to `apps/creator/src/plugins/panels.tsx`, and the package to `transpilePackages` in `apps/creator/next.config.ts` and to the app's `dependencies`. Those five places are the only ones that may name your plugin; `tests/social-post.test.ts` checks that for Social Post.
7. Add tests like `tests/plugin-shell.test.ts` and `tests/social-post.test.ts`, then run `npm install` and the checks below.

### Adding a Router family

A Router family is a group of Comfy Router models that share a request and response shape (FLUX from BFL, Seedance, Kling omni video). Supporting one is one adapter in `packages/recipes/src/router-adapters.ts` plus a test, with no change to the executors, the tools, or the UI: a model the user switches on in Settings gets one recipe per capability from its adapter, and every step picks it up from there.

1. Read the model's input schema from the live catalog (Settings, Router models, or `GET /api/router/models`) and save it as a fixture next to the others in `tests/fixtures/router/` (`schema-<provider>__<model>.json`). Reading the catalog is free; do not run the model.
2. Write a builder beside the existing ones. `bflImage` (FLUX) is the simplest worked example with references, and `seedanceVideo` the one for video with first and last frames. A builder returns one `recipe(model, capability, suffix, { ceilingUsd, limits, defaults, fieldMap })` per capability. The `fieldMap` says where each semantic input goes in the provider's body: `template` for fixed fields, `prompt`, `images` (path, `append` or `indexed`, the encoding, the item shape, `min` and `max`, and `roles` such as `first_frame`), `aspectRatio` and `duration` (a path, or a `values` table when the provider wants sizes or strings), `seed`, and `output`, the response parser.
3. Pick `output` from the existing parsers (`RouterOutputFamilySchema` in `packages/core/src/catalog/recipes.ts`: `gemini`, `flux`, `kling`, `seedance`, `minimax`, `wan`, `ltx`, `openai`, `binary`). Only a response shape none of them reads needs a new parser in `packages/executors/src/router-output.ts`, with an offline fixture test.
4. Match the family in `adapterFor` by provider and model name, with its `family` label and capabilities. Keep the match narrow: models with their own request shapes (virtual try-on, fill, expand) stay unsupported until they get their own adapter.
5. Test it offline in `tests/catalog-router-adapters.test.ts`: `adapterFor` finds the family, `adapterRecipes` gives stable recipe ids, and `buildRouterBody` builds the body your schema fixture describes for each capability. New recipes carry `verified: null` and a cost hint that says the price is not measured yet.
6. A verified example comes last and only from the maintainer: one real run through `RECIPE=<recipe id> npm run verify-workflow`, logged as a row in `docs/VERIFICATION.md` with the credits before and after. The FLUX and Seedance rows of 2026-10-27 are what such a row looks like ("the adapter body and the output parser both held"). Contributors never run it: it spends credits, and only the maintainer sets `GENERATION_ALLOWANCE_USD`.

## Branches

The repository follows git-flow.

| Branch      | What lives there                                                                 | Who writes to it                                                                      |
| ----------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `main`      | Released code only. From `v0.1.0` on, `main` moves only by tagged releases.      | Release merges from `develop` (or a `release/*` branch). Never commit to it directly. |
| `develop`   | The integration branch. Always builds and passes the tests.                      | Merges from `feature/*` and `fix/*` pull requests.                                    |
| `feature/*` | One piece of work, branched from `develop`.                                      | You.                                                                                  |
| `fix/*`     | A bug fix for `develop`, branched from `develop`.                                | You.                                                                                  |
| `release/*` | Optional. Final polish for a version (`release/0.2.0`), branched from `develop`. | The maintainer.                                                                       |
| `hotfix/*`  | A fix for a released version, branched from `main`.                              | The maintainer.                                                                       |

Name a branch after the task it does, short and lowercase: `feature/artifact-panel`, `fix/caption-clipping`. When the work comes from a numbered roadmap item, put the number first: `feature/03-artifact-panel`.

If you use the git-flow extension, `git flow init -d` picks these names (`main` for production, `develop` for the next release, `feature/`, `release/`, `hotfix/` prefixes, `v` as the version tag prefix). Plain git works just as well:

```sh
git fetch origin develop
git switch -c feature/my-change origin/develop
```

## Pull requests

1. Branch from the latest `develop`.
2. Keep one change per branch. Rebase on `develop` if it moves while you work (your own branch only; never rewrite `develop` or `main`).
3. Run the definition-of-done checks before you push:

   ```sh
   npm run typecheck
   npm run lint
   npm test
   npm run build
   ```

   Run `npm run test:acceptance` too when you change routes, tools, storage, or assembly.

4. Open the pull request against `develop`, not `main`. Say what changed and why, list the tests you added, and note anything left unfinished.
5. A change that spends real Comfy credits needs a row in `docs/VERIFICATION.md`. Never commit `.env.local`, the data folder, keys, or media from real runs.

Merges into `develop` use a merge commit or squash, whichever keeps the history readable; the branch is deleted after merge.

## Releases

Releases are tagged on `main` only, with semantic versions and a `v` prefix (`v0.1.0`, `v0.2.0`). Tags are annotated and never moved or deleted once pushed; a mistake gets a new patch version.

1. Bring `develop` to a releasable state: all checks green, `README.md` and `docs/` current.
2. Optionally cut `release/X.Y.Z` from `develop` for last fixes, and set `"version"` in `package.json` to `X.Y.Z`.
3. Merge into `main` with a merge commit (no squash, so `main` and `develop` share history).
4. Tag the merge commit on `main`:

   ```sh
   git tag -a vX.Y.Z -m "AI Creator Lab X.Y.Z"
   git push origin vX.Y.Z
   ```

5. Merge `main` back into `develop` if the release branch carried fixes.
6. Write the release notes on GitHub from the tag.

A hotfix branches from `main` (`hotfix/X.Y.Z+1`), merges into both `main` and `develop`, and is tagged the same way.

## Versions

| Tag      | What it is                                                                                                                       |
| -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `v0.1.0` | The Comfy "Open Source Higgsfield" competition submission (October 30, 2026). The submitted link points here, so it stays fixed. |
