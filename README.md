# AI Creator Lab

AI Creator Lab is an open-source studio for creators who make short vertical content around a single product. It runs on your own computer or server and generates on your own Comfy account (Comfy Cloud, Comfy API, or Comfy Router), so there is no middleman and no per-seat platform fee. A built-in assistant walks you from "here is what I'm selling" to a locked AI creator character, a script, the shots, and a finished 1080 x 1920 ad. Everything you approve is kept in a Library you can reuse in the next piece of content.

It is early software. One user, one machine, one content type (Ad). The first full ad was produced on real credits on October 26, 2026; see `docs/VERIFICATION.md` for exactly what has and has not been tested on a real account, and `docs/TESTING.md` for the start-to-finish manual test (open weights and premium models, from a brief and from your own photos).

## What you need

Two accounts and three pieces of software. Everything else comes down with `npm ci`.

### Accounts

- A Comfy account and API key from https://platform.comfy.org. Two ways to use it:
  - A Comfy Cloud plan with API access (the free tier does not include it). This unlocks the open-weights workflows that ship with the app: Z-Image for text to image, Qwen Image Edit for compositions, LTX 2.5 for video, and Chatterbox and Qwen3-TTS for voice-overs.
  - Or credits only, no plan, using hosted models through Comfy Router. Router models draw from the same credit balance. The starter catalog includes Nano Banana 2.1 and Nano Banana Pro for stills and Kling 3.0 Omni for clips, and Settings lists every other Router model: switch one on and it joins the recipe pickers (FLUX by BFL, Kling, Seedance, MiniMax, Wan, LTX, Gemini and OpenAI image families have adapters today). Settings picks the default per step, and you can ask the assistant for a specific model on any proposal.
- An Anthropic API key for the assistant, from https://console.anthropic.com. Usage is small compared with generation. (Settings can also run the assistant through Comfy Router on your Comfy credits, with no Anthropic key.)

### Software

| Dependency | Version | Why | Install |
| --- | --- | --- | --- |
| Node.js and npm | Node 22.13 or newer (24 is fine) | Runs the app; the database uses Node's built-in `node:sqlite` | https://nodejs.org, or `brew install node`, or `winget install OpenJS.NodeJS.LTS` |
| ffmpeg and ffprobe | 4.4 or newer, built with `drawtext` (libfreetype) | Checks every generated clip, lifts voice samples, levels and mixes audio, and assembles the export; `drawtext` burns in the captions | macOS: `brew install ffmpeg-full` (the plain `ffmpeg` formula is a lean build without `drawtext`; the app finds `ffmpeg-full` on its own). Debian and Ubuntu: `sudo apt install ffmpeg`. Windows: `winget install Gyan.FFmpeg`, which puts the full build on PATH. |
| git | any | Cloning and updating | https://git-scm.com, or `brew install git` |

The image library (`sharp`) and everything else in `package.json` install with `npm ci` as prebuilt packages on macOS, Linux and Windows, Intel and ARM; no compiler is needed. The caption font (DejaVu Sans Bold) is bundled in `assets/fonts/`.

To check the software before you start:

```
node --version
ffmpeg -version
ffmpeg -hide_banner -filters | grep drawtext
```

The first should print v22.13.0 or higher. The last should print one line naming `drawtext`; if it prints nothing, your ffmpeg lacks captions (see Troubleshooting). On macOS with `ffmpeg-full` installed, test that build instead: `/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg -hide_banner -filters | grep drawtext`.

If ffmpeg is installed somewhere the app cannot see, or you have several, set `FFMPEG_PATH` and `FFPROBE_PATH` in `.env.local` to the pair you want. Settings shows the ffmpeg and ffprobe the app is using and whether captions are available, so you can confirm from the browser.

## Install

```
git clone <the address of this repository>
cd ai-creator-lab
npm ci
npm run build
npm start
```

Those are the clone, the move into the folder, the dependency install, the build, and the start. Then open http://127.0.0.1:3000 in your browser. By default the app only listens on your own machine (127.0.0.1), only answers requests addressed to localhost or 127.0.0.1, and asks for no password. To use it from another computer, see the next section.

### On a network, with a password

To reach the studio from a laptop, a tablet, or a server you rent, start it on every interface and name the address people will type:

```
HOST=0.0.0.0 STUDIO_ALLOWED_HOSTS=studio.lan,192.168.1.20 npm start
```

- `HOST` is the address the server listens on (`127.0.0.1` when unset). Anything other than a loopback address turns on the app password.
- `STUDIO_ALLOWED_HOSTS` is a comma-separated list of the host names or addresses in the browser's address bar, besides localhost. A request for any other name is refused, which stops DNS rebinding. Behind a reverse proxy that keeps the app on `127.0.0.1`, list the proxy's public name here; that also turns on the password.
- The first time it starts this way, the server log prints a one-time setup code. Open the app, enter the code and choose a password (12 characters or more). From then on every page and API call needs a signed-in browser; Sign out is at the bottom of the left rail. Sessions last 30 days.
- With `HOST=0.0.0.0` and no `STUDIO_ALLOWED_HOSTS`, only localhost is accepted, so other computers get a 403; the server log says so at start and lists this machine's addresses.
- Behind HTTPS (a TLS proxy that sets `X-Forwarded-Proto: https`, with its public name in `STUDIO_ALLOWED_HOSTS`), the session cookie is marked Secure. The header is ignored when no proxy name is set. Without HTTPS the password crosses the network in the clear, so use a network you trust, or a VPN such as Tailscale.
- Forgot the password? Stop the server, delete `auth.json` from the data folder, and start again: a new setup code is printed.

### Read-only mode

`STUDIO_READ_ONLY=1` turns the studio into a viewer of its data folder: every request that could change something is refused, the chat is off, and a banner says so. It is meant for showing finished work, so it never asks for a password, even on a network: only use it on a data folder you would show to anyone who can reach the port. [docs/DEMO-DEPLOY.md](docs/DEMO-DEPLOY.md) shows how to host one.

## Settings: keys and the monthly budget

Open Settings in the left rail.

- Paste your Comfy API key and your Anthropic API key and press Save keys. The app checks them and shows which are set. Keys are stored in a file called `secrets.json` inside the data folder, with permissions 0600 (readable only by your user). They are read on the server only and are never sent to the browser, shown again, or written to logs. If you set `COMFY_API_KEY` or `ANTHROPIC_API_KEY` as environment variables instead, those win over the saved ones.
- Paid generation is off until you turn it on. Two numbers have to be above zero:
  1. The operator ceiling, `GENERATION_ALLOWANCE_USD` in a file named `.env.local` in the project folder: the most any calendar month (UTC) can spend. Copy `.env.example` to `.env.local`, set the variable to the dollar amount you are willing to spend in a month, and restart the app. Settings shows it read-only; nothing in the app can raise it.
  2. Your monthly budget in Settings (USD), with the day of the month it resets (1 to 28, at midnight UTC). Settings shows this period's dates, the budget in force, what has been spent, what is reserved by jobs in flight, and what remains, in dollars with Comfy credits beside them (210 credits per dollar).
- Spend counts in the period its cost was recorded, so a new period starts at zero. Settings warns at 50 and 80 percent of the month's budget and says when it is used up.
- With either number at zero, nothing paid runs. Proposals still show you the quote, so you can walk the flow up to the gate before spending anything.

## Your first ad in ten minutes

The example below uses an invented creator, Avery Lane, and an invented product, the Ridgeline 32 oz insulated bottle. Replace them with your own. Most of the ten minutes is waiting on generation; the real clicking is short.

1. Connect. Save your two keys in Settings and set a monthly budget (above).
2. New project. On Projects, create one from UGC Creator and name it, for example "Ridgeline launch". The chat opens on the left.
3. Brief. The assistant asks what you are selling, who buys it, where it will run, and the tone. It saves the brief to the Documents tab beside the chat, where you can edit it.
4. Character. Build the bible together: name, age range, look, wardrobe, voice, boundaries. Avery Lane is early 30s, warm and direct, light freckles, dark shoulder-length hair tied back, small silver hoop earrings, never hype, no health claims, no competitor names. If you already have a Character in the Library, pick it and skip ahead.
5. Face lock. The assistant proposes four 3/4-view headshots. Pick one and name the character. The rest go to the Archive.
6. Body reference. From the locked face, the assistant proposes 3/4 full-body references in neutral athleticwear. Approve one.
7. Reference sheet. For this project the assistant generates one landscape sheet from the approved face and body: a large portrait plus full-body front and back in the project's wardrobe, on a neutral grey background. Check it at full size against the checklist, then approve. Every still in the project uses it.
8. Product. Upload product photos, paste your link, and list the claims you may make. For the Ridgeline bottle: keeps drinks cold 24 hours, fits a car cup holder, dishwasher safe. It is saved to the Library as a Product.
9. Script. The assistant writes a 15 to 30 second script with a hook, problem, reveal, proof, and call to action. Beats alternate talking and b-roll; each has a line, on-screen text, a visual, and a length sized to the line (about 2.5 words per second). Talking beats say their line on camera; b-roll beats carry theirs as a voice-over, so the creator keeps talking over the footage. Edit in place; the script is versioned.
10. Shots. For each beat the assistant composes a start frame from the sheet, the product, and the setting (a bright kitchen counter by a window, a car interior, a gym bench). Approve one per beat, or give a text instruction to refine one that is close.
11. Clips. Each approved frame becomes an LTX clip at the beat's length with synchronized audio; talking beats carry the spoken line, b-roll has ambient sound only. Approve one per beat.
12. Voice-overs. Each b-roll line is read in the creator's own voice: the app lifts a voice sample from the first approved talking clip (or you upload a recording on the character's Voice slot) and clones it with Chatterbox Turbo or Qwen3-TTS on Comfy Cloud, a few credits a line. Approve a take per beat. For one voice across the whole ad, a talking beat can take the same path: a voice take of its line, then a clip lip-synced to it with Wan 2.2 S2V (up to 4.8 s).
13. Assemble. On the Export tab, put the clips in order and press Export 1080 x 1920. You get an MP4 with the on-screen text burned in as captions and the voice-overs mixed over their beats. Download it. It is also saved as an asset with its full source record.
14. Next piece. Start another ad in the same project, or a new project with the same character and a fresh sheet if the wardrobe changes.

Any step can also be done by hand without the chat: pick a recipe, write a prompt, generate, approve.

The brief, the character bible, the product card, and the script are documents: edit them in the Documents and Script tabs, and the assistant works from what you saved. Every save keeps the previous version. Open a document's Versions list to see who changed it and when, and press Restore to bring an earlier version back as the newest one. A restored bible keeps the locked face and body, and the next stills use it.

Every generation step shows a proposal first: the recipe, the prompt, the references, how many candidates, and the estimated cost. Nothing is submitted until you press Approve and generate (or turn on auto-approve, below).

## Example outputs

`docs/examples/` holds one complete run with the open-weights starter recipes: the face and body references, the reference sheet, the product photo, two start frames, and the finished 18 second ad with voice-overs and captions. The creator and the product are invented.

## What it costs

Numbers as of October 2026, observed on a real Comfy Cloud account on October 26, 2026. Check https://comfy.org/pricing/ for current plans and prices; they change.

| Step | Observed cost |
| --- | --- |
| Text-to-image still (Z-Image) | about 2 to 3 credits each |
| Composition from references (Qwen Image Edit on Cloud, or a hosted model on Router) | about 7 to 14 credits each |
| LTX 2.5 image-to-video clip, five seconds with audio | about 10 credits each |
| A complete three-beat ad, character through finished MP4 | around 60 credits |

The app converts at 210 credits per US dollar, which is the rate observed on Router and matches the entry plan's monthly rate, so a full three-beat ad is a few tenths of a dollar of generation. Expect more once you generate several candidates per step and redo a few. The entry Comfy Cloud plan with API access was about $20 a month with roughly 4,200 credits and one workflow at a time when this was written. Router models need no plan, only credits. The assistant's Anthropic usage is billed separately by Anthropic.

## The monthly budget and auto-approve

The budget is a hard stop. Before a paid job runs, the app reserves its quoted cost (or the recipe's ceiling when the model gives no quote) against what is left of this month's budget. A recipe without a quote asks for your explicit confirmation. Free and mock runs always pass.

When approving a proposal would go over what is left, nothing runs and a dialog shows what you have spent this month, what remains, and what this action costs. You can type an amount under "Add to this month" and generate: the extra raises the current period only, and next period starts from your monthly budget again. You can also add to this month in Settings. Neither can go past the operator ceiling; when the ceiling is what stands in the way, the dialog says so. Only a click in the app extends a month: the assistant and the MCP server cannot.

Auto-approve is a checkbox in Settings. When it is on, proposals under the budget are submitted without the Approve and generate click, and the card says so. The server still enforces the budget either way, and a proposal that would go over it still waits for you. Leave it off until you trust the prompts for your product. Submitting the same proposal twice never runs it twice.

## Your data folder

Everything lives in one folder: `.data` inside the project folder by default, or wherever `STUDIO_DATA_DIR` points. It holds the database (`studio.sqlite`), your media, your exports, `secrets.json` with your saved keys, and, once you have set an app password, `auth.json` with its hash and the signed-in sessions. To back up, stop the app and copy the whole folder. To move to another machine, copy the folder and set `STUDIO_DATA_DIR` there. Treat the copy like a password file, because it contains your keys unless you used environment variables. The folder is ignored by git.

## Starter workflows and adding your own

Twenty-three open-weights workflows ship in `workflows/` (Z-Image, Qwen-Image 2512, FLUX.2 dev, Krea 2 Turbo and MiniMax H3 for stills; Qwen Image Edit 2511 and FLUX.2 dev with one to three references and the Krea 2 style reference for edits; LTX 2.5, Wan 2.2 and MiniMax H3 for text, image and first-and-last-frame video; Chatterbox Turbo and Qwen3-TTS for voice-overs cloned from a voice sample; Wan 2.2 S2V for clips lip-synced to a take), each with a small sidecar file that tells the app which node inputs to fill (prompt, images, a voice sample, size, length, seed). To see what they need on Comfy Cloud, how to open one in ComfyUI, and how to add your own, read [workflows/README.md](workflows/README.md).

## Troubleshooting

- `npm start` binds to 127.0.0.1 on purpose. To open it to a network, use `HOST` and the app password (see "On a network, with a password"); do not forward the port some other way. [SECURITY.md](SECURITY.md) says what is and is not protected.
- "This host name is not one this studio answers to." Add the name or address in your browser's address bar to `STUDIO_ALLOWED_HOSTS` and restart.
- "Too many failed attempts." Attempts are checked one at a time, and ten wrong passwords or setup codes in ten minutes pause sign-in for everyone until the oldest is ten minutes old. Restarting does not clear it (the times are kept in `auth.json`); browsers already signed in keep working.

- "Paid generation is off." `GENERATION_ALLOWANCE_USD` in `.env.local` must be above zero. Restart after editing `.env.local`.
- "More than the ... left in this month's budget." Add to this month in the dialog or in Settings, raise the monthly budget, or wait for the reset day.
- Cloud workflows fail with an authorization or plan error. API access to Comfy Cloud is not part of the free tier. Use a paid plan, or use Router models, which need only credits.
- Jobs wait in a queue. On the entry plan Comfy Cloud runs one workflow at a time. The app also submits one job at a time per target and shows queue position, so a batch of candidates arrives one after another.
- The export says the FFmpeg build has no `drawtext` filter. Captions need an ffmpeg built with libfreetype. On macOS run `brew install ffmpeg-full` (Homebrew's plain `ffmpeg` is lean and lacks it); the app looks for `ffmpeg-full` on its own, no restart needed. Elsewhere, check the build with `ffmpeg -filters | grep drawtext`, install a fuller one, and if several are installed set `FFMPEG_PATH` and `FFPROBE_PATH` in `.env.local` to the right pair. Or export with captions switched off.
- ffmpeg or ffprobe not found. Install them, or set `FFMPEG_PATH` and `FFPROBE_PATH` in `.env.local` to the full paths.
- Captions use the wrong font or the font is missing. The app bundles DejaVu Sans Bold (`assets/fonts/DejaVuSans-Bold.ttf`). To use another TTF or OTF file, set `CAPTION_FONT_PATH` in `.env.local`.
- The face does not look like a three-quarter view. The open Z-Image model ignores loose wording; the face-lock prompt states the head turn explicitly. Reject and regenerate, or edit the prompt on the proposal card.
- The product name is printed on the bottle or a second bottle appears. Add "no text or logo on the product" and "one bottle only" to the prompt and regenerate. These came up in the first full run.
- A Router result vanished. Router keeps outputs for 24 hours; the app copies them to your data folder as soon as they finish, so check the Assets page first.
- A provider rejected a prompt (moderation). The reason is shown on that candidate. Change the prompt or switch recipes in Settings.

## For developers

Stack: Next.js 16 App Router, React 19, TypeScript, Tailwind 4 with shadcn/ui, Zod 4 at every boundary, SQLite through Node's built-in `node:sqlite`, `@comfyorg/sdk` for Cloud and API deployments, direct HTTP for Router, the Anthropic SDK for the assistant, ffmpeg for assembly.

Scripts (all in `package.json`):

- `npm run dev` starts the dev server on 127.0.0.1 (or on `HOST`, with the app password; `npm start` the same). Both go through `scripts/serve.mjs`, which passes `HOST` to Next.js as `--hostname`.
- `npm run build`, `npm start` build and serve.
- `npm run lint`, `npm run typecheck`, `npm test` are the checks. `npm run test:acceptance` runs the whole flow against the mock executor with no credits.
- `npm run --silent mcp` starts the MCP server on stdio (see below).
- `npm run spike`, `npm run live-check`, `npm run e2e-real`, `npm run e2e-photos`, `npm run live-premium` call real providers and spend credits. They need the key, a nonzero `GENERATION_ALLOWANCE_USD`, and room in the monthly budget.
- `npm run spike:v02` runs the v0.2 spike (Krea 2 character start and the MiniMax H3 checks) under a 420-credit cap; `DRY_RUN=1 npm run spike:v02` prints the plan and its ceilings without a key or any network call. See `docs/TASKS.md` B24 and B25 for its inputs.

Where things live:

- `src/app/` pages (Projects, Assets, Library, Archive, Settings) and the HTTP routes under `src/app/api/`.
- `src/components/` the UI.
- `src/server/` storage (`store`), executors (Router, Workflow, mock), the recipe catalog, the typed tool set (`tools`), the assistant (`agent`), and ffmpeg assembly (`assembly`).
- `src/lib/` shared schemas and domain types.
- `workflows/` starter workflows and sidecars. `assets/fonts/` the caption font.
- `tests/` offline tests with fixtures. `scripts/` the acceptance smoke and the real-provider checks.
- `docs/` the product description (`PRODUCT.md`), the plan (`PLAN.md`), the task board (`TASKS.md`), the log of every real run (`VERIFICATION.md`), the demo script (`DEMO.md`), and post drafts (`POSTS.md`).

### MCP server (Claude Code, Claude Desktop, other MCP clients)

`npm run --silent mcp` (or `node --import tsx scripts/mcp.ts`) starts an MCP server on stdio over the same tools the in-app assistant uses. It opens the data folder in `STUDIO_DATA_DIR` (default `.data` in the repo). Keys come from `.env.local`, which the server loads when present, or from the secrets file that Settings writes in the data folder. Run it from the repo folder. Use `--silent` with `npm run`, because npm's own banner on stdout would break the protocol.

Every tool is offered under its own name. Generating is split the same way as in the app: tools such as `propose_candidates` and `compose_still` return a proposal, and only `approve_and_generate` spends credits. That tool, and `delete_asset_everywhere`, are offered only when you start the server with `MCP_ALLOW_SPEND=1` or `MCP_ALLOW_DELETE=1`, because an MCP client has no proposal card to click; with spending allowed it is still held to the same monthly budget, capped by `GENERATION_ALLOWANCE_USD` (zero blocks every paid run), and it cannot add to a month; only a click in the app does that. Two resources let a client look at the work: `project://{id}/state` (the whole project as JSON) and `asset://{id}` (a candidate's file).

Claude Code, from the repo folder:

```sh
claude mcp add ai-creator-lab -- node --import tsx scripts/mcp.ts
```

Claude Desktop, in `claude_desktop_config.json`. Desktop does not start in the repo folder, so `npm --prefix` runs the script from there:

```json
{
  "mcpServers": {
    "ai-creator-lab": {
      "command": "npm",
      "args": ["--prefix", "/path/to/ai-creator-lab", "run", "--silent", "mcp"],
      "env": { "STUDIO_DATA_DIR": "/path/to/ai-creator-lab/.data" }
    }
  }
}
```

Read `AGENTS.md` for the working agreements before changing scope.

Branches, pull requests, and releases are described in [CONTRIBUTING.md](CONTRIBUTING.md): work happens on `feature/*` branches from `develop`, and releases are tagged on `main`.

## Credits

- ComfyUI and Comfy Cloud, Comfy Router, and the Comfy API and SDK, from Comfy Org.
- LTX 2.5 from Lightricks, for image-to-video with audio.
- Qwen Image Edit from the Qwen team at Alibaba, and Z-Image from Tongyi-MAI (Alibaba).
- DejaVu Sans Bold, the bundled caption font. Its license is in `assets/fonts/DejaVu-LICENSE.txt`.
- shadcn/ui components. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Model weights are not included in this repository. You use them through Comfy under their own licenses.

## License

MIT. See [LICENSE](LICENSE).

## Need help running this?

AI Creator Lab is maintained by Ted Darling at Digital Spirit Technology. If you would rather have it installed on your own server and connected to your Comfy account for you, you can hire Ted to do that. Get in touch at https://digitalspirittech.com/ai-creator-lab.
