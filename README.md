# AI Creator Lab

AI Creator Lab is an open-source studio for creators who make short vertical content around a single product. It runs on your own computer or server and generates on your own Comfy account (Comfy Cloud, Comfy API, or Comfy Router), so there is no middleman and no per-seat platform fee. A built-in assistant walks you from "here is what I'm selling" to a locked AI creator character, a script, the shots, and a finished 1080 x 1920 ad. Everything you approve is kept in a Library you can reuse in the next piece of content.

**New here? [docs/QUICKSTART.md](docs/QUICKSTART.md) goes from a fresh computer to a finished Quick Ad in a few steps.** Demo: see [docs/DEMO.md](docs/DEMO.md) (the video link goes there once it is recorded). Gallery: the Gallery page in the app, from [`examples/`](examples/README.md).

It is early software. One user, one machine, two content types (Ad and Social post). The first full ad was produced on real credits on October 26, 2026; see `docs/VERIFICATION.md` for exactly what has and has not been tested on a real account, and `docs/TESTING.md` for the start-to-finish manual test (open weights and premium models, from a brief and from your own photos).

## What you need

Two accounts and two pieces of software. Everything else, ffmpeg included, comes down with `npm ci`.

### Accounts

- A Comfy account and API key from https://platform.comfy.org. Two ways to use it:
  - A Comfy Cloud plan with API access (the free tier does not include it). This unlocks the open-weights workflows that ship with the app: Z-Image for text to image, Qwen Image Edit for compositions, LTX 2.5 for video, and Chatterbox and Qwen3-TTS for voice-overs.
  - Or credits only, no plan, using hosted models through Comfy Router. Router models draw from the same credit balance. The starter catalog includes Nano Banana 2.1 and Nano Banana Pro for stills and Kling 3.0 Omni for clips, and Settings lists every other Router model: switch one on and it joins the recipe pickers (FLUX by BFL, Kling, Seedance, MiniMax, Wan, LTX, Gemini and OpenAI image families have adapters today). Settings picks the default per step, and you can ask the assistant for a specific model on any proposal.
- An Anthropic API key for the assistant, from https://console.anthropic.com. Usage is small compared with generation. (Settings can also run the assistant through Comfy Router on your Comfy credits, with no Anthropic key.)

### Software

| Dependency | Version | Why | Install |
| --- | --- | --- | --- |
| Node.js and npm | Node 22.13 or newer (24 is fine) | Runs the app; the database uses Node's built-in `node:sqlite` | https://nodejs.org, or `brew install node`, or `winget install OpenJS.NodeJS.LTS` |
| ffmpeg and ffprobe | bundled (6.0 or newer, with `drawtext`) | Checks every generated clip, lifts voice samples, levels and mixes audio, and assembles the export; `drawtext` burns in the captions | Nothing to install: `npm ci` downloads static builds for macOS (Apple silicon and Intel), Linux (x64 and ARM), and Windows x64 through `ffmpeg-static` and `@derhuerst/ffprobe-static`. To use your own, set `FFMPEG_PATH` and `FFPROBE_PATH` (below). |
| git | any | Cloning and updating | https://git-scm.com, or `brew install git` |

The image library (`sharp`), the ffmpeg and ffprobe binaries, and everything else in `package.json` install with `npm ci` as prebuilt packages on macOS, Linux and Windows, Intel and ARM; no compiler is needed. The caption font (DejaVu Sans Bold) is bundled in `assets/fonts/`.

To check before you start, `node --version` should print v22.13.0 or higher. After `npm ci`, `node_modules/ffmpeg-static/ffmpeg -hide_banner -filters | grep drawtext` prints one line naming `drawtext`, the filter that burns in captions.

Which ffmpeg runs, first match wins: `FFMPEG_PATH` and `FFPROBE_PATH` in `.env.local`, then the bundled pair (each checked against the SHA-256 recorded for its release before it first runs; see SECURITY.md), then Homebrew's `ffmpeg-full` (if the bundled download was skipped, for example with `npm ci --ignore-scripts`), then whatever is on PATH. Settings shows the ffmpeg and ffprobe the app is using and whether captions are available, so you can confirm from the browser.

## Install

```
git clone <the address of this repository>
cd ai-creator-lab
npm ci
npx ai-creator-lab
```

Those are the clone, the move into the folder, the dependency install, and the start. `npx ai-creator-lab` checks your Node version, reads `.env.local` like `npm start` does, prepares the data folder (and says which one and why), builds the app the first time (and again after `git pull` brings new code), and serves it on http://127.0.0.1:3000 (the next free port if 3000 is taken). Open that address in your browser. Options: `--open`, `--port 4000`, `--data <folder>`, `--rebuild`, `--no-build`. `npm run build` then `npm start` does the same by hand, and is the way to use `HOST` (next section). By default the app only listens on your own machine (127.0.0.1), only answers requests addressed to localhost or 127.0.0.1, and asks for no password. To use it from another computer, see the next section.

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

## Settings: keys, backends, and the monthly budget

Open Settings in the left rail.

- Paste your Comfy API key and your Anthropic API key and press Save keys. The app checks them and shows which are set. Keys are stored in a file called `secrets.json` inside the data folder, with permissions 0600 (readable only by your user). They are read on the server only and are never sent to the browser, shown again, or written to logs. If you set `COMFY_API_KEY` or `ANTHROPIC_API_KEY` as environment variables instead, those win over the saved ones.
- Paid generation is off until you turn it on. Two numbers have to be above zero:
  1. The operator ceiling, `GENERATION_ALLOWANCE_USD` in a file named `.env.local` in the project folder: the most any calendar month (UTC) can spend. Copy `.env.example` to `.env.local`, set the variable to the dollar amount you are willing to spend in a month, and restart the app. Settings shows it read-only; nothing in the app can raise it.
  2. Your monthly budget in Settings (USD), with the day of the month it resets (1 to 28, at midnight UTC). Settings shows this period's dates, the budget in force, what has been spent, what is reserved by jobs in flight, and what remains, in dollars with Comfy credits beside them (210 credits per dollar).
- Spend counts in the period its cost was recorded, so a new period starts at zero. Settings warns at 50 and 80 percent of the month's budget and says when it is used up.
- With either number at zero, nothing paid runs. Proposals still show you the quote, so you can walk the flow up to the gate before spending anything.

### Backends: where recipes run

Settings, Backends lists the servers recipes run on. Comfy Cloud and Comfy Router are always there. You can add a self-hosted ComfyUI (usually through the Comfy API proxy, for example `http://127.0.0.1:8189`, or a ComfyUI on your network) or a Comfy API deployment (`https://<name>.run.comfy.app`). If you set `COMFY_BASE_URL` in `.env.local`, that server is listed too and stays the default, so an existing setup keeps running where it did.

- Adding a backend checks it right away. The app reads the server's node list (`object_info`) and compares it with every workflow: which node classes each one uses and which model files its loaders name. Checking is free and never submits anything. Press Check to do it again after you install nodes or models.
- The table under the list shows each recipe on each backend: Verified (a real run finished there; for Comfy Cloud, also the date in the catalog), Compatible (the check found everything), Unavailable with the missing node and model names, or Not checked.
- Workflows run on the default backend. Make default picks it. When the default lacks what a recipe needs, the proposal says so ("Runs on Comfy Cloud because Studio PC cannot run it (missing nodes ...)") and runs it on Comfy Cloud. If Cloud cannot run it either (no key, or Cloud lacks it too), the proposal is refused with the reason. A proposal never moves to another backend without a new proposal saying so.
- Keys are not stored per backend. Comfy Cloud, Router and deployments on Comfy's own hosts use your Comfy API key. A self-hosted ComfyUI never receives it. Runs on your own ComfyUI cost no Comfy credits, so once a check has cleared a recipe there its proposals show as free (before the first check, the recipe's usual price is reserved). A workflow that uses a partner (API) node, such as a hosted model inside the graph, is unavailable on any backend but Comfy Cloud, because it would bill the Comfy account signed in to that server, outside your budget.
- A backend with generations still running cannot be removed until they finish. On a hosted copy (judging or read-only), only Comfy Cloud and Router are offered.

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
11. Clips. Each approved frame becomes an LTX clip at the beat's length with synchronized audio; talking beats carry the spoken line, b-roll has ambient sound only. Approve one per beat. A clip longer than the model makes in one run is a chained recording (see Long recordings, below).
12. Voice-overs. Each b-roll line is read in the creator's own voice: the app lifts a voice sample from the first approved talking clip (or you upload a recording on the character's Voice slot) and clones it with Chatterbox Turbo or Qwen3-TTS on Comfy Cloud, a few credits a line. Approve one recording per beat. For one voice across the whole ad, a talking beat can take the same path: a voice recording of its line, then a clip lip-synced to it with Wan 2.2 S2V (4.8 s per run; longer lines are chained).
13. Assemble. On the Export tab, put the clips in order and press Export 1080 x 1920. You get an MP4 with the on-screen text burned in as captions and the voice-overs mixed over their beats. Download it. It is also saved as an asset with its full source record.
14. Next piece. Start another ad in the same project, or a new project with the same character and a fresh sheet if the wardrobe changes.

Any step can also be done by hand without the chat: pick a recipe, write a prompt, generate, approve.

The brief, the character bible, the product card, and the script are documents: edit them in the Documents and Script tabs, and the assistant works from what you saved. Every save keeps the previous version. Open a document's Versions list to see who changed it and when, and press Restore to bring an earlier version back as the newest one. A restored bible keeps the locked face and body, and the next stills use it.

Every generation step shows a proposal first: the recipe, the prompt, the references, how many candidates, and the estimated cost. Nothing is submitted until you press Approve and generate (or turn on auto-approve, below).

### Long recordings

Length is a capability of the model. LTX 2.5, MiniMax H3, and Wan 2.2 make about five seconds in one run, Kling 3.0 Omni up to 15, Wan 2.2 S2V up to 4.8. Ask for a longer talking clip (a beat's length, a voice recording longer than the beat, or "make this clip 20 seconds" in the chat) and the proposal card says how it will be made:

- In one run when the model reaches that length (Kling, the H3 multi-frame graph, a first-and-last-frame clip within its limit). LTX's own extend mode is not wired in yet, so a long LTX clip is always chained.
- As a chained recording otherwise: segments of about five seconds (on Router models, lengths the model accepts, such as two 10 s Kling runs for 20 s), each started from the last moment of the one before, the line shared out across them, stitched with a short crossfade at every seam. When the beat has an approved voice recording, that one recording is the whole clip's sound, so the voice never cuts; if it is shorter than the clip, the card says how many seconds at the end have no voice. A lip-synced clip (Wan 2.2 S2V) follows its own slice of that recording in every segment. Each seam is checked for black frames, a frozen or jumping picture, and a gap or click in the audio.

The card prices the whole recording, and the whole recording must fit your remaining budget before segment 1 starts; the rest stays reserved while it runs, so nothing else can leave it half paid. If a segment still cannot start (for example the operator ceiling was lowered), the chained recording pauses with a note and keeps what it made; submitting the same card again finishes it. A chained recording never keeps money it cannot use: a file it needs that is deleted, or five local failures in a row, end it and release what it held, and deleting a file a running one needs is refused until it finishes or is canceled. Each segment is its own durable job, so a restart picks the recording up where it stopped. The finished clip lands on the beat as one candidate; the segments go to the Archive. The project state the assistant reads lists each chained recording (segment X of N, why it paused, what the seam check found), and the seam check's finding leads the clip's prompt record on the Assets page. The proposal card does not have a Cancel button or a segment counter yet (the server side, `submit_proposal` with `cancel`, is in place). Chained recordings on H3, LTX, and Kling are tested offline; their first real runs are still to be logged in docs/VERIFICATION.md.

### Choosing the model for a step

Each step decides what the shot should show once (the beat, your character, the product, the place), and each model gets that written in its own prompt style: Nano Banana reads a descriptive paragraph, GPT Image reads labeled sections, MiniMax H3 reads its structured video format, and the open-weights models read the prompts the starter workflows were verified with. So switching models never means re-briefing.

- On a proposal card, the Recipe menu lists every model that can do this step with what you have connected (Router models you switched on in Settings included). Pick another one and the prompt is rewritten for it and the cost estimated again. The prompt is editable too, up to 8,000 characters; your edit is what runs.
- "Just this run" is the default. "Use for the rest of this project" makes that model the project's choice for this kind of step from then on. You can also say it in the chat: "use Nano Banana for product shots from now on".
- On a candidate you do not like, "Regenerate with…" proposes the same shot with another model, with the same references and the same place in the ad.

Which model a step uses, first match wins: the one you pick for this run, this project's choice, the default in Settings, then the app's starter default. A project's choice never changes other projects.

### One continuous recording with b-roll cut in

The export above joins one clip per beat. The other way to build the same ad, on the Export tab's Build menu, is "Recording with cutaways": the creator says the whole script in one continuous talking recording, and the b-roll is cut over the lines it belongs to, the way an editor would cut a real UGC video. The delivery never restarts between beats.

1. Make the talking recording. One clip from the first talking beat's approved still in which the creator says every line in order, as long as the beats added up (60 s at most). Approve one. Longer than the model makes in one run, it is a chained recording like any long clip (see Long recordings above), priced as a whole on the card.
2. Transcribe the recording. A speech to text run finds each word and when it is said, then each beat's line is placed on the recording. A transcription that heard no words is refused instead of guessed.
3. Draft the edit decision list. Each b-roll beat gets a window from its first word to the next line, and each beat's on-screen text becomes a caption over the same stretch. A beat none of whose words was heard is placed by estimate, and the list says so. The list is a document in the Documents tab ("Edit list"), with times in seconds on the recording: move a window, change where a caption starts, add or remove one, and save. Every save keeps the previous version.
4. Export. The recording's sound is kept exactly as it is, the picture in each window is that beat's approved clip, and the captions are burned in at their times. Edit the list and export again as often as you like: nothing is regenerated and nothing is spent.

If you change a beat's on-screen text in the script later, its caption follows (unless you rewrote that caption yourself). If you change a spoken line, or add or remove a beat, the recording no longer says the script: make or approve a recording again and draft the list again before exporting.

Transcription runs through the same proposal card and monthly budget as every generation. Two recipes are planned for it, Whisper on Comfy Router and open-weights Whisper on Comfy Cloud, and neither is verified yet: Router's catalog had no Whisper model when the app was built, and no Cloud node for transcribing with word timestamps has been confirmed. Until one is, `list_recipes` shows both with what they are waiting for, and transcription runs on the mock recipe only (`MOCK_RECIPES=1`), which the tests and the acceptance smoke use.
## A Quick Ad

For an ad in a few minutes, press Quick Ad on Projects (or ask the assistant for one). Write two lines: what you're selling, and who it's for. The studio saves the brief and a one-beat talking script, then asks for three approvals: one frame, one four-second talking clip, and the export, each on the Quick Ad tab. Every generation still shows its card in the chat and waits for Approve and generate. With a Library character (locked face) and a product with a photo linked to the project, the frame is composed from them; otherwise it is made from your two lines. On Comfy Router the whole Quick Ad reserves under 1 USD from the catalog's price ceilings (about 0.79 USD composed, 0.89 USD from text). [docs/QUICKSTART.md](docs/QUICKSTART.md) walks through it from a fresh install.

## A social post

Not every piece needs video. On Projects, create a project from Social Post instead of UGC Creator. A social post is a set of stills plus its copy, in up to four aspect ratios: 1:1 (square), 4:5 (feed portrait), 9:16 (story or reel cover), and 16:9 (wide).

1. Brief. Same four questions as an ad: what you promote, who it is for, where it runs, the tone.
2. Library. Reuse your Library: link Avery Lane and the Ridgeline bottle (ask the assistant, or link them from the Library). Linked characters and products are the stills' references, so the bottle and the face stay the same as in your ads.
3. Copy. On the Post tab (or in the chat) write the caption with the hook first, three to eight hashtags, a call to action, and a visual line that describes the picture, for example "The bottle in a car cup holder, morning light through the windshield." Every save is a version; the Copy history lists them and Restore brings one back.
4. Stills. On the Stills tab, press Propose stills on a ratio (start with 4:5). The proposal card appears in the chat with the recipe, the prompt, and the estimated cost, and nothing runs until you approve it there, under the same monthly budget as everything else. Approve one candidate per ratio; the others go to the Archive.
5. Export. The Export tab lists the approved still for each ratio with a Download button, and the copy as one block of text to paste (Copy text, or Download as text). Ratios without an approved still are named so you can go back for them.

Social Post is the first content type added as a plugin (`packages/content-social-post`): the app shell did not change to make room for it. See CONTRIBUTING.md, Adding a content type.

## Example outputs and the Gallery

`docs/examples/` holds one complete run with the open-weights starter recipes: the face and body references, the reference sheet, the product photo, two start frames, and the finished 18 second ad with voice-overs and captions. The creator and the product are invented.

The Gallery page in the app lists the examples in [`examples/`](examples/README.md), each with its brief, the recipe for every step, the Library items it uses, what it cost (settled from the credit balance before and after, never an estimate), its outputs, and its flaws. "Start from this example" creates a project with the example's brief and Library items. Examples marked "Not yet generated" are drafts waiting for a real run. `npm run gallery:build` renders the same examples as a static site in `site/`.

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

Twenty-three open-weights workflows ship in `packages/recipes/workflows/` (Z-Image, Qwen-Image 2512, FLUX.2 dev, Krea 2 Turbo and MiniMax H3 for stills; Qwen Image Edit 2511 and FLUX.2 dev with one to three references and the Krea 2 style reference for edits; LTX 2.5, Wan 2.2 and MiniMax H3 for text, image and first-and-last-frame video; Chatterbox Turbo and Qwen3-TTS for voice-overs cloned from a voice sample; Wan 2.2 S2V for clips lip-synced to a voice recording), each with a small sidecar file that tells the app which node inputs to fill (prompt, images, a voice sample, size, length, seed). To see what they need on Comfy Cloud, how to open one in ComfyUI, and how to add your own, read [workflows/README.md](workflows/README.md).

## Troubleshooting

- `npm start` binds to 127.0.0.1 on purpose. To open it to a network, use `HOST` and the app password (see "On a network, with a password"); do not forward the port some other way. [SECURITY.md](SECURITY.md) says what is and is not protected.
- "This host name is not one this studio answers to." Add the name or address in your browser's address bar to `STUDIO_ALLOWED_HOSTS` and restart.
- "Too many failed attempts." Attempts are checked one at a time, and ten wrong passwords or setup codes in ten minutes pause sign-in for everyone until the oldest is ten minutes old. Restarting does not clear it (the times are kept in `auth.json`); browsers already signed in keep working.

- "Paid generation is off." `GENERATION_ALLOWANCE_USD` in `.env.local` must be above zero. Restart after editing `.env.local`.
- "More than the ... left in this month's budget." Add to this month in the dialog or in Settings, raise the monthly budget, or wait for the reset day.
- Cloud workflows fail with an authorization or plan error. API access to Comfy Cloud is not part of the free tier. Use a paid plan, or use Router models, which need only credits.
- Jobs wait in a queue. On the entry plan Comfy Cloud runs one workflow at a time. The app also submits one job at a time per target and shows queue position, so a batch of candidates arrives one after another.
- The export says the FFmpeg build has no `drawtext` filter. The bundled ffmpeg has it, so this means another one is in use: Settings, Video tools names it. Remove `FFMPEG_PATH` and `FFPROBE_PATH` from `.env.local` to go back to the bundled pair, or point them at a build with libfreetype (on macOS, Homebrew's `ffmpeg-full`; the plain `ffmpeg` formula lacks it). Or export with captions switched off.
- ffmpeg or ffprobe not found. Run `npm ci` again: it downloads the bundled binaries (an install with `--ignore-scripts` skips them). Or set `FFMPEG_PATH` and `FFPROBE_PATH` in `.env.local` to the full paths of your own.
- Captions use the wrong font or the font is missing. The app bundles DejaVu Sans Bold (`assets/fonts/DejaVuSans-Bold.ttf`). To use another TTF or OTF file, set `CAPTION_FONT_PATH` in `.env.local`.
- The face does not look like a three-quarter view. The open Z-Image model ignores loose wording; the face-lock prompt states the head turn explicitly. Reject and regenerate, or edit the prompt on the proposal card.
- The product name is printed on the bottle or a second bottle appears. Add "no text or logo on the product" and "one bottle only" to the prompt and regenerate. These came up in the first full run.
- A Router result vanished. Router keeps outputs for 24 hours; the app copies them to your data folder as soon as they finish, so check the Assets page first.
- A provider rejected a prompt (moderation). The reason is shown on that candidate. Edit the prompt on the card, or use "Regenerate with…" to try another model.

## For developers

Stack: Next.js 16 App Router, React 19, TypeScript, Tailwind 4 with shadcn/ui, Zod 4 at every boundary, SQLite through Node's built-in `node:sqlite`, `@comfyorg/sdk` for Cloud and API deployments, direct HTTP for Router, the Anthropic SDK for the assistant, ffmpeg for assembly.

Scripts (all in `package.json`):

- `npx ai-creator-lab` (the `bin` in the root `package.json`, `apps/creator/scripts/launch.mjs`) builds when needed and serves the production build on 127.0.0.1; see Install.
- `npm run dev` starts the dev server on 127.0.0.1 (or on `HOST`, with the app password; `npm start` the same). Both go through `apps/creator/scripts/serve.mjs`, which runs Next.js on the app folder from the repository root and passes `HOST` to it as `--hostname`.
- `npm run build`, `npm start` build and serve.
- `npm run lint`, `npm run typecheck`, `npm test` are the checks. `npm run test:acceptance` runs the whole flow against the mock executor with no credits, a 10 s chained recording included. `MOCK_VIDEO=mp4` (with `MOCK_RECIPES=1`) makes the mock's clips real MP4s made with ffmpeg instead of storyboards, which chained recordings need.
- `npm run --silent mcp` starts the MCP server on stdio (see below).
- `npm run gallery:build` renders `examples/` into a static site in `site/` (GitHub Pages, through the manual `Gallery (GitHub Pages)` workflow).
- `npm run spike`, `npm run live-check`, `npm run e2e-real`, `npm run e2e-photos`, `npm run live-premium` call real providers and spend credits. They need the key, a nonzero `GENERATION_ALLOWANCE_USD`, and room in the monthly budget.
- `npm run spike:v02` runs the v0.2 spike (Krea 2 character start and the MiniMax H3 checks) under a 420-credit cap; `DRY_RUN=1 npm run spike:v02` prints the plan and its ceilings without a key or any network call. See `docs/TASKS.md` B24 and B25 for its inputs.

Where things live:

The repository is an npm workspace. Run every script from the repository root (it stays the working directory, so `.env.local`, the `.data` folder, and the workflows resolve there).

- `apps/creator/` the Next.js app: pages (Projects, Gallery, Assets, Library, Archive, Settings) in `src/app/`, the HTTP routes under `src/app/api/`, the UI in `src/components/`, and in `src/server/` storage (`store`), the typed tool set (`tools`), the assistant (`agent`), ffmpeg assembly (`assembly`: the component join in `graph.ts` and `render.ts`, take then cutaways in `cutaway.ts`, `cutaway-render.ts`, and `edl.ts`), media, auth, and the MCP server. `src/plugins/` lists the installed plugins. `scripts/` holds the acceptance smoke, the MCP entry, and the real-provider checks.
- `packages/core/` domain contracts and Zod schemas, the pure catalog types, the spend policy, and the plugin registry.
- `packages/recipes/` the starter recipe catalog, `workflows/` (starter workflows and sidecars), Router adapters, and the per-model prompt renderers.
- `packages/executors/` the Router, workflow, and mock executors, the allowance and spend settlement, the Router and Comfy clients, the backend probe, and the chained-recording stitch and seam check (`stitch.ts`).
- `packages/ui/` the shared shadcn/ui primitives.
- `packages/content-ugc-ad/` the UGC Ad content type (its steps and workspace panels) as a plugin.
- `packages/content-social-post/` the Social Post content type as a plugin: its steps, its tools (`social_post_save_copy`, `social_post_propose_still`, `social_post_export`), its assistant, and its three workspace panels.
- `assets/fonts/` the caption font.
- `examples/` the gallery examples, each an `example.json` checked by the schema in `packages/core/src/domain/gallery.ts`.
- `tests/` offline tests with fixtures for every package.
- `docs/` the product description (`PRODUCT.md`), the plan (`PLAN.md`), the task board (`TASKS.md`), the log of every real run (`VERIFICATION.md`), the demo script (`DEMO.md`), and post drafts (`POSTS.md`).

### MCP server (Claude Code, Claude Desktop, other MCP clients)

`npm run --silent mcp` (or `node --import tsx apps/creator/scripts/mcp.ts`) starts an MCP server on stdio over the same tools the in-app assistant uses. It opens the data folder in `STUDIO_DATA_DIR` (default `.data` in the repo). Keys come from `.env.local`, which the server loads when present, or from the secrets file that Settings writes in the data folder. Run it from the repo folder. Use `--silent` with `npm run`, because npm's own banner on stdout would break the protocol.

Every tool is offered under its own name. Generating is split the same way as in the app: tools such as `propose_candidates` and `compose_still` return a proposal, and only `approve_and_generate` spends credits. That tool, and `delete_asset_everywhere`, are offered only when you start the server with `MCP_ALLOW_SPEND=1` or `MCP_ALLOW_DELETE=1`, because an MCP client has no proposal card to click; with spending allowed it is still held to the same monthly budget, capped by `GENERATION_ALLOWANCE_USD` (zero blocks every paid run), and it cannot add to a month; only a click in the app does that. Two resources let a client look at the work: `project://{id}/state` (the whole project as JSON) and `asset://{id}` (a candidate's file).

Claude Code, from the repo folder:

```sh
claude mcp add ai-creator-lab -- node --import tsx apps/creator/scripts/mcp.ts
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

[docs/MCP.md](docs/MCP.md) has a project `.mcp.json`, the two flags in detail, and a sample Quick Ad session from Claude Code.

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
