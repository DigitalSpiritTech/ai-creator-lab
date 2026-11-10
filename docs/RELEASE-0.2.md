# AI Creator Lab 0.2 (draft release notes)

Draft for the maintainer. Not tagged yet: `v0.2.0` is tagged on `main` by the maintainer after the release merge (CONTRIBUTING.md, Releases). Items 11 and 12 are still open and marked pending; update this page when they merge. The v0.1.0 tag (the competition submission, October 30, 2026) stays as it is.

## Highlights

- Quick Ad: two lines, one frame, one talking clip, the export. Three approvals; on Comfy Router it reserves under 1 USD from the catalog's price ceilings (assuming clip prices scale linearly with length, which no real run has measured yet).
- `npx ai-creator-lab`: one command from a clone to a running studio, with ffmpeg bundled (captions work without Homebrew).
- A Gallery of examples with the cost settled from the credit balance, and "Start from this example".
- A monthly budget you can extend for the current month only, under a fixed operator ceiling.
- An app password for running the studio on a network, and an official read-only mode.
- Backends: your own ComfyUI or Comfy API deployment next to Comfy Cloud, checked before anything runs.
- Pick the model for any step; the prompt is rewritten in that model's style.
- A second content type, Social Post, added as a plugin, and the codebase split into packages.

## What changed

### Spend policy (#4, F2)

The allowance became a monthly budget with a reset day (1 to 28, UTC) in Settings. "Add to this month" raises the current period only, by a click in Settings or in the dialog a blocked proposal opens; the assistant and the MCP server cannot extend. `GENERATION_ALLOWANCE_USD` stays the operator ceiling per calendar month, read-only in the app, and zero blocks every paid run. A proposal that would cross the remaining budget is blocked as a whole, with spent, remaining, and cost. Warnings at 50, 80, and 100 percent.

### Access control (#5, F7)

Loopback stays the default, with no password. A non-loopback `HOST` (or a name in `STUDIO_ALLOWED_HOSTS`) turns on the app password for every page and API route: a one-time setup code in the server log, a scrypt hash in the data folder, HttpOnly session cookies, and a throttle on failed attempts that survives restarts. `STUDIO_READ_ONLY=1` is the official read-only flag. The Docker image gains a third mode: your own studio behind the password.

### Backends (#6, F6)

Settings lists Comfy Cloud and Comfy Router plus any self-hosted ComfyUI or Comfy API deployment you add. Adding one probes its `object_info` (a free read) against every workflow's nodes and model files, so each recipe shows as verified, compatible, unavailable with what is missing, or not checked. A workflow runs on the default backend, falls back to Comfy Cloud with the reason on the proposal, or is refused. The Comfy key never goes to a self-hosted ComfyUI.

### Model override (#7, F3)

Every generation writes a shot spec once, and the app renders the prompt in the chosen model's style (the house prompts, Krea, Nano Banana, GPT Image, MiniMax H3). The proposal card's recipe menu lists every model that can run the step with what you have connected; switching rewrites the prompt and the estimate. "Use for the rest of this project" saves a per-project preference. "Regenerate with..." reruns a candidate's own spec, references, and destination with another model.

### Workspace split and plugin registry (#8, F8 phase A)

The repository is an npm workspace: `packages/core` (domain contracts, spend policy, plugin registry), `packages/recipes`, `packages/executors`, `packages/ui`, `packages/content-ugc-ad`, and `apps/creator` (the Next.js app). Packages ship TypeScript source with no build step, and ESLint enforces the dependency direction. The plugin registry drives the workspace tabs, the Projects page's Apps, the prompt renderers, and the assistant's steps. Behavior, routes, schema, and tool names did not change.

### Social Post, owner context, inbound context (#9, F8 phase B, F13)

Social Post is the second App and the first content type added purely as a plugin: stills in 1:1, 4:5, 9:16, and 16:9 plus the caption, hashtags, and call to action, with its own tools, assistant, and panels. Every record carries an owner (one default owner until Teams), projects can have a parent, and a project can be seeded from an inbound context (a brief and Library items), which the Gallery's "Start from this example" uses.

### Install, Quick Ad, Gallery, MCP examples (item 10, F9 to F12)

- Install (F9): ffmpeg and ffprobe now come with `npm ci` (`ffmpeg-static` and `@derhuerst/ffprobe-static`, macOS arm64 and x64, Linux, Windows), with `drawtext` for the captions; `FFMPEG_PATH` and `FFPROBE_PATH` still override them. `npx ai-creator-lab` checks Node 22.13, prepares the data folder, builds on the first run in a clone, and serves on 127.0.0.1. The Docker image uses the same binaries instead of the distro ffmpeg. [docs/QUICKSTART.md](QUICKSTART.md) goes from a fresh computer to a finished Quick Ad.
- Quick Ad (F11): a mode of the Ad. `start_quick_ad` (a new roster tool, 34 in all) turns two lines into the brief, a one-beat four-second talking script, and the Ad; then the frame, the clip, and the export, each approved by a person, and each generation through the spend gate. A Quick Ad tab and a Quick Ad button on Projects. On Comfy Router it reserves under 1 USD from the catalog's ceilings: about 0.79 USD composed from a Library character and product photo, 0.89 USD from text. The clip's share is the Kling ceiling scaled linearly to four seconds; that pricing is assumed until the first real Quick Ad run is logged in docs/VERIFICATION.md.
- Gallery (F10): `examples/` with a schema (brief, recipe choices, Library items, cost from the balance before and after, outputs, flaws), a Gallery page with "Start from this example", and a static site builder (`npm run gallery:build`) with a manual-only GitHub Pages workflow. One example ships as a draft ("not yet generated"); the six real examples follow the maintainer's paid runs.
- MCP (F12): [docs/MCP.md](MCP.md) shows Claude Code driving a Quick Ad, a `.mcp.json` snippet, and what `MCP_ALLOW_SPEND` and `MCP_ALLOW_DELETE` allow.

### Pending

- Item 11, chain step and long takes: segment jobs and the stitch for talking beats longer than one clip. In progress.
- Item 12, take-then-cutaways: transcription recipes, an edit decision list, and cutaway assembly. In progress.

## Upgrading from 0.1

- Run `npm ci` (new dependencies, including the bundled ffmpeg), then start as before. The database migrates on start (schema 8); no data folder changes are needed.
- If you set `FFMPEG_PATH` and `FFPROBE_PATH` only to get captions on macOS, you can remove them.
- A saved allowance becomes the monthly budget (migration 4); check the reset day in Settings.

## Not in this release

Tagging, the merge to `main`, publishing to npm, enabling GitHub Pages, the six paid gallery runs, and the announcement posts are the maintainer's steps.
