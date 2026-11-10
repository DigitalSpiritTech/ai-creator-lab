# Quickstart: from a fresh computer to a finished Quick Ad

This page takes you from a computer with nothing installed to an exported 1080 x 1920 Quick Ad: two lines about what you sell, one frame, one four-second talking clip, and the export. It works the same on macOS, Linux, and Windows. Everything else (the full flow with a locked character, the monthly budget in detail, running on a server) is in the [README](../README.md).

## 1. Install Node and git

You need Node.js 22.13 or newer and git. Install Node from https://nodejs.org (the LTS), and git from https://git-scm.com. Then check:

```sh
node --version
```

It should print v22.13.0 or higher. You do not need to install ffmpeg: `npm ci` downloads ffmpeg and ffprobe for your platform (with the `drawtext` filter that burns in captions), and the app uses them unless you point `FFMPEG_PATH` and `FFPROBE_PATH` at another pair.

## 2. Get the studio

```sh
git clone <the address of this repository>
cd ai-creator-lab
npm ci
```

## 3. Start it

```sh
npx ai-creator-lab
```

The first start builds the app, which takes a minute or two; later starts are quick (and build again only after `git pull` brings new code). When it prints `AI Creator Lab is running at http://127.0.0.1:3000`, open that address in your browser. It listens on this computer only. Add `--open` to open the browser for you, `--port 4000` for another port, or `--data <folder>` to keep your work somewhere other than `.data` in the clone. Ctrl+C stops it.

### Try it free first (optional)

To walk the whole Quick Ad without an account or any spend, start it with the mock recipes, which make labeled placeholder frames and clips locally:

```sh
MOCK_RECIPES=1 npx ai-creator-lab
```

On Windows PowerShell: `$env:MOCK_RECIPES="1"; npx ai-creator-lab`. With no Comfy key saved, every proposal uses a mock recipe and costs nothing; skip to step 5. Stop and start it without `MOCK_RECIPES` for real generations.

## 4. Connect your Comfy account and set a budget

1. Get an API key from https://platform.comfy.org. Credits alone are enough for a Quick Ad: the hosted models on Comfy Router need no plan.
2. In the app, open Settings, paste the Comfy API key, and press Save keys. An Anthropic key is optional; it turns on the assistant in the chat, which can do the same steps for you.
3. Paid generation is off until two numbers are above zero. In the clone, copy `.env.example` to `.env.local` and set `GENERATION_ALLOWANCE_USD` to the most you are willing to spend in a calendar month, then stop and start the app. In Settings, set your monthly budget (and the day it resets). A Quick Ad on Comfy Router reserves under 1 USD from the catalog's price ceilings: about 0.79 USD when the frame is composed from a Library character and a product photo, about 0.89 USD when it is made from your two lines alone. Leave Auto-approve off for now.

## 5. Make the Quick Ad

1. On Projects, type a name (for example "Ridgeline bottle, quick") and press Quick Ad. The project opens on the Quick Ad tab.
2. Write the two lines. What you're selling: "Ridgeline 32 oz insulated bottle, keeps drinks cold 24 hours". Who it's for: "Commuters who leave a drink in the car, on TikTok". The line the creator says and the on-screen text fill in from the first line; change them if you like (about ten words fit the four seconds; the on-screen text is two lines of six words at most). Press Start the Quick Ad. Nothing is generated yet.
3. Frame. Press Compose the frame. A card appears in the chat with the recipe, the prompt, and the estimated cost. Press Approve and generate; that is the only way anything spends. When the frame arrives in the Quick Ad tab, look at it full size and press Approve (approval 1 of 3). Not right? Compose another frame, or Refine it with a short instruction.
4. Talking clip. Press Make the clip. Approve its card in the chat the same way. When the clip arrives, play it and press Approve (approval 2 of 3).
5. Export. Press Export 1080 x 1920 (approval 3 of 3). The MP4 has the on-screen text burned in. Play it in the tab, or press Download. It is also kept on the Assets page with its full source record.

With an Anthropic key, you can instead type in the chat: "Quick ad: Ridgeline 32 oz bottle keeps drinks cold 24 hours, for commuters on TikTok." The assistant starts the Quick Ad and proposes each step; the cards and the three approvals are still yours to click.

For a frame that shows your own creator and product, link a Library character with a locked face and a product with a photo to the project first (Documents tab, or start from the Gallery's example), then start the Quick Ad.

## 6. Check the file (optional)

The bundled ffprobe can confirm the export from a terminal in the clone (copy the file path from the Download, or find the newest file in `.data/exports/`):

```sh
node_modules/@derhuerst/ffprobe-static/ffprobe -v error -show_entries stream=codec_name,width,height -of compact <the exported .mp4>
```

It should list an h264 video stream at 1080 x 1920.

## If something goes wrong

- `npx ai-creator-lab` says Node is too old: install the current LTS from https://nodejs.org and open a new terminal.
- "Paid generation is off": `GENERATION_ALLOWANCE_USD` in `.env.local` is missing or zero, or the app was not restarted after you set it.
- The export says captions cannot be burned in: Settings, Video tools shows which ffmpeg the app runs. If it is not the bundled one, remove `FFMPEG_PATH` and `FFPROBE_PATH` from `.env.local`; if the bundled one is missing, run `npm ci` again (it downloads the binaries).
- More help: the README's Troubleshooting section.

The demo video is linked from [docs/DEMO.md](DEMO.md) once it is recorded. The gallery of finished examples is the Gallery page in the app.
