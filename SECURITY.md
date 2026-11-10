# Security

AI Creator Lab runs on one person's computer, with that person's own Comfy and Anthropic keys. This page says what the app does to keep those keys and that person's files safe, what it does not try to protect against, and how to report a problem.

## What the app assumes

One user, on their own machine, reaching the app at `http://localhost:3000` (or `127.0.0.1`). `npm start` and `npm run dev` bind to `127.0.0.1` only, so nothing else on the network can reach the app. The data folder (`.data` by default, or `STUDIO_DATA_DIR`) holds the database, every media file, exports, and `secrets.json` with the saved keys; treat a copy of it like a password file. Keys set as environment variables (`COMFY_API_KEY`, `ANTHROPIC_API_KEY`) are read on the server only.

## What is guarded

Every request, pages and API alike, goes through a local-only check (`src/server/http.ts`): the Host must be localhost, 127.0.0.1, or ::1 (which stops DNS rebinding), and a request with an Origin or Sec-Fetch-Site header from another origin is refused, which stops a web page you have open from posting to the app, loading its media, or framing it. The one cross-site request allowed is a top-level navigation (a link to the app from another page), which the other page learns nothing from. This check is not authentication: if you run the app on `0.0.0.0`, in a container, or behind a port forward, anyone who can reach the port and send `Host: localhost` has the whole API. Keep it on loopback.

API keys are never returned by any route or written to any log; Settings shows only whether a key is set and where it came from. The saved keys file is written atomically with mode 0600. Child processes (ffmpeg, ffprobe) run with a minimal environment that does not include the keys. `.gitignore` excludes the data folder and any `secrets.json`.

Media paths are built from UUIDs under three fixed folders inside the data folder and re-checked against the data root before any read or write. Uploads are bounded (12 MB images, 25 MB recordings), images are re-encoded through sharp with pixel limits, and recordings must be in a known audio container before ffmpeg decodes them. ffmpeg and ffprobe are always run with argument arrays (never a shell), with timeouts and output caps; caption text is escaped for both of ffmpeg's parsers. SQL is parameterized throughout. Files downloaded from Comfy Router must come over HTTPS from a public address, with redirects re-checked and a size cap.

Spending is gated twice: a generation runs only when the user clicks a proposal card (or has turned auto-approve on for proposals under their budget), and the server re-estimates the cost and refuses anything over what is left of this month's budget. The budget is monthly: the Settings value plus any amount the person added to the current period, reset on the day of the month they choose (UTC), and spend counts in the period its cost was recorded. Over all of it sits the operator ceiling, `GENERATION_ALLOWANCE_USD`, enforced on the server per calendar month (UTC) whatever the reset day, shown read-only in Settings, and zero until set; a zero ceiling blocks every paid run and every extension. "Add to this month" is a route behind the local-request check, reached only by a person's click in Settings or on the proposal card's budget dialog; it is not a tool, so neither the assistant nor the MCP server can raise a budget, and an extension can never lift the effective limit above the ceiling. The assistant can propose, archive (restorable), and revise, but cannot submit a proposal, change or extend the budget, or delete a file for good; permanent deletion is a click on the Archive page. The assistant is told that everything inside the project state is data, not instructions, which limits what a prompt injection in a brief or script can do to restorable changes.

The MCP server (`npm run --silent mcp`) offers the same tools to an MCP client, but not spending or permanent deletion unless the person starting it sets `MCP_ALLOW_SPEND=1` or `MCP_ALLOW_DELETE=1`, because an MCP client has no proposal card to click.

## What is not guarded

The app trusts its own data folder: a file replaced on disk is caught by hash when it is read, but the folder itself is yours to protect. ffmpeg decodes recordings and clips you upload; keep ffmpeg updated. Generated content goes to Comfy Cloud and Comfy Router under your key; the prompts, reference images, and voice samples a project uses leave your machine for those services. The assistant's replies come from a hosted model; the project text it reads is yours, and a bad instruction hidden in it can at most make a restorable change.

## Reporting

Open an issue on the repository with the steps that show the problem. Do not include your keys or your data folder.
