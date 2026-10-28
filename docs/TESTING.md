# Testing the app by hand, start to finish

This is the manual test script: four complete runs that together cover every path the app offers. Each run ends with a finished 1080 x 1920 ad. Budget about 90 minutes and roughly 1,100 Comfy credits (about 5 USD) for all four; the open-weights runs are cheap and the premium runs are where the credits go. Numbers below are what the real runs on October 26 and 27 cost, so expect them to drift.

The four runs:

1. Open weights, from nothing: Z-Image, Qwen Image Edit and LTX 2.5 on Comfy Cloud, everything generated from a brief.
2. Premium, from nothing: Nano Banana Pro for stills and Kling 3.0 Omni for clips on Comfy Router, everything generated from a brief.
3. Open weights, from your own photos: a real person, a real product and a real place as the starting points.
4. Premium, from your own photos.

Run them in that order. Runs 1 and 3 prove the pipeline; runs 2 and 4 only change which model each step uses.

## Before the first run

Run the app natively on the machine whose browser you will use. Node 22.13 or newer, ffmpeg and ffprobe on PATH (`brew install ffmpeg` on macOS), a Comfy API key with a Cloud plan for the open-weights workflows (Router models need only credits), and an Anthropic key for the assistant.

```
npm ci
npm run build
npm start
```

Open http://localhost:3000. `npm run dev` works too and reloads on edits, but the production build is what the demo and the fresh-install check use.

Then, in this order:

1. `.env.local`: set `GENERATION_ALLOWANCE_USD` to the most you are willing to spend across every project (25 is enough for all four runs with room to redo steps). The app never raises this itself. Restart after changing it.
2. Settings, keys: the Comfy and Anthropic keys from `.env.local` show as set. If you keep keys only in Settings instead, paste them and click Save keys; they go to a 0600 file inside the data folder.
3. Settings, Comfy connection: run the check. It should name the account and show the credit balance. If it reports no API access, the Cloud plan is missing and only Router recipes will run.
4. Settings, Generation allowance: set your allowance (this is the second cap; the lower of the two is what is in force). Spent and Reserved should both read zero on a fresh data folder.
5. Settings, Default recipe per capability: leave every field on the starter default for run 1. The starter defaults are the open-weights set: Z-Image Turbo for text to image, Qwen Image Edit 2511 for compositions, LTX 2.5 for image to video and for first and last frame.
6. Leave Auto-approve off. You want to see every proposal card and its estimate.

What a proposal card shows: the recipe, how many candidates, the estimated cost (a live quote reads "About"; "Up to ... reserved" is the recipe's ceiling, used when the provider cannot quote, which is every Cloud workflow and most Router models today; the note under it says what runs usually cost), the references it will send and the exact prompt. Settings' Spent figure counts Cloud runs at their ceiling because Cloud reports no per-job cost, so it runs about 1.5 times the real spend; the Comfy balance is the truth. Approve and generate runs it (an unquoted run asks once more with Reserve and generate); Cancel discards it. Nothing is ever sent without that click unless Auto-approve is on. The assistant's message under a card only describes the card; nothing is running until you click.

Every step the chat proposes also has a button in the workspace that builds the same card: Generate face candidates, Make body reference, Make reference sheet, Generate photos on a product card, Compose stills and Make clip on a beat. The button for the next step is green; the rest are outlined. While a job runs, a placeholder tile with the recipe and status sits in the grid where its result will land.

## Run 1: open weights, from nothing

Expected cost about 65 to 80 credits (voice-overs are about 4 each). Expected wall time about 15 minutes, most of it waiting on Cloud.

1. Projects, New project. Name it. The project opens with the chat on the left and the workspace on the right (Script, Shots, Assets, Export tabs, and a Manual panel).
2. In chat, describe what you sell, who it is for and the tone, in two or three sentences. The assistant saves the brief and may ask one question; answer it or tell it to pick.
3. Character: the assistant drafts a character bible (age range, face, hair, build, voice, vibe, wardrobe) and proposes face candidates (or click Generate face candidates on the character in Assets). Check the card: recipe Z-Image Turbo, four candidates, a few credits. Approve and generate. A placeholder tile per candidate appears under Face candidates and fills in as each finishes. Select one, Lock face. The other three go to the Archive (check the Archive page once; restore one and archive it again to see both directions).
4. Body: click Make body reference (now green) or ask the assistant. The card should name Qwen Image Edit 2511, one reference: the one-reference graph keeps this step on open weights. Lock one. The bible's visual core stays the same person across both.
5. Reference sheet: in Assets, Characters, choose the wardrobe (from the bible, or type a custom one) and click Make reference sheet. One candidate arrives: portrait, front and back views, same person. Open it at full size, go through the Inspection checklist, Approve. Every still in this project will now carry this sheet as reference 1.
6. Product: the assistant asks for the product and creates its card with a name, an appearance line and up to three claims it is allowed to make. For run 1 click Generate photos on the product card (it needs the appearance line) and approve one with Use as product photo; the appearance line is what the prompts use, and it must describe color, material, shape and cap, never the brand name. An image made from the Manual panel can also become the product photo from its Use as control under Other assets.
7. Script: the assistant writes a three-beat script, talking, b-roll, talking, each beat with a line, a visual sentence, a setting and a length in seconds sized to the line (about 2.5 words per second; 1 to 15 s). The b-roll beat's line is a voice-over: the creator keeps talking over the footage, and the Script tab's line column says so. Open the Script tab, edit one line in place, set one beat to 3 s and another to 8 s, and save; the Versions list shows the new version. A line over three words per second is refused with the seconds it needs. Changing a talking beat's line or any length withdraws that beat's clip; changing a b-roll line withdraws only its voice-over.
8. Stills: the assistant proposes one still per beat (Qwen Image Edit with the sheet and the product as references; b-roll beats get no face). Approve one per beat on the Shots tab. To change one, use Refine with an instruction (it proposes a new still from the approved one) or Regenerate from here when an earlier choice should change everything after it.
9. Clips: the assistant proposes one LTX 2.5 clip per beat from its approved still at the beat's length, about 10 credits per 5 s (the reservation scales with length). Talking beats carry the spoken line and LTX generates the speech; b-roll beats get ambient sound. Approve one per beat. If a clip comes back solid black, the app rejects it and retries once with a new seed on its own; if the retry is black too, ask for another take a minute later.
10. Voice-over: once beat 1's talking clip is approved, the b-roll beat on the Shots tab shows "Needs a voice-over" and a highlighted Voice-over button (the assistant proposes the same step with generate_voice_over). The card names Chatterbox Turbo voice clone, the line, and about 4 credits; the first run also lifts the voice sample from the approved talking clip (Assets tab, the character's Voice slot shows it with its words). Approve and generate; the take appears as an audio card under the beat with a player and its length. Play it against the talking clip, then Approve. Another take is one click; "use Qwen3-TTS" in chat picks the other recipe (about 2 credits), and a recording of your own voice uploaded to the Voice slot replaces the lifted sample for every later take. Optional, once a voice sample exists: a talking beat shows a Voice take button too; approve its take and Make clip becomes Lip-sync clip, which makes the clip from the still and the take with Wan 2.2 S2V (about 12 credits, 4.8 s at most) so every beat shares one voice.
11. Export tab: the beats are in script order (move one and move it back), captions on, Export 1080 x 1920. Download the MP4 and check it: 1080 x 1920, 24 fps, about 15 s for three five-second beats, audible speech on the talking beats, the voice-over over the b-roll beat at about the same level as the talking clips with the clip's own sound ducked under it, captions burned in, the same person in every beat, no lettering on the product.

Also check after this run: Library lists the character, the product and the set, each marked as usable in other projects; Settings shows Spent moved by the sum of the cards' reserved amounts; the Comfy balance moved by less (Cloud runs settle at the ceiling in the ledger; the balance lags a run by up to a minute). The assistant's work between its messages folds into one line per turn ("3 steps · Read the project · Saved the brief · Proposed a still for beat 6"); while a step runs the line names it, a failed step turns the line red with the reason inside, and opening the line shows each step with its recipe and cost and, one level deeper, the raw input and output.

## Run 2: premium, from nothing

Expected cost about 500 to 700 credits with one candidate per step, more with several. Expected wall time about 20 minutes; a Kling clip takes about two minutes.

1. Settings, Default recipe per capability: text to image, Nano Banana Pro from text; image edit, Nano Banana Pro; image to video, Kling 3.0 Omni image to video; first and last frame, Kling 3.0 Omni first and last frame. Save. (The open-weights pickers now also offer Qwen-Image 2512, FLUX.2 dev, Krea 2 Turbo and MiniMax H3 for stills, FLUX.2 dev edits, and Wan 2.2 and MiniMax H3 for video; run 1 can be repeated with any of them.)
2. New project, then the same flow as run 1. Every proposal card should now name a Router recipe and show an estimate of the ceiling, since Router does not quote these models yet: 0.25 USD per Nano Banana Pro still, 0.80 USD per 5 s Kling clip (1.60 for 10 s). Measured so far: 36 credits per Nano Banana Pro still at 1K, 148 credits per 5 s Kling clip in pro mode with sound. Kling takes whole seconds from 3 to 15; set a beat to 3 s and one to 8 s in the Script tab to see the reservation change.
3. Keep candidate counts low on this run (tell the assistant "one candidate" or set Count on the Manual panel), because every candidate is a paid call. Router runs only a few hosted requests per account at once; the app sends two at a time and holds the rest ("Waiting for a Router slot" on the tile), and when Router still says it is busy the job waits and resends the same key for up to 15 minutes. `ROUTER_CONCURRENCY` in `.env.local` changes the two.
4. Two things to look at: Nano Banana Pro takes up to 14 references, so a still that needs the sheet, the product and a set all fit; and Kling's 9:16 output is 1088 x 1904 with its own sound; the export fills the 1080 x 1920 canvas and crops the sliver at the edges (a source that is a different shape altogether is letterboxed instead). Kling clips can be 10 s; ask for one on a b-roll beat.
5. More hosted models: Settings, Comfy Router models, lists everything Router offers. Switch on, say, `bfl/flux-2-pro` or `byteplus/seedance-1-5-pro-251215` and it appears in the pickers and as a Settings default for the capabilities its adapter covers; models marked without an adapter cannot be switched on yet.
6. Instead of changing the Settings defaults, you can name the model in chat on any step ("use Kling for this clip", "do this still with Nano Banana Pro") and the assistant picks that recipe for that proposal only. The Manual panel also has a Recipe field per capability.

Not yet verified live: Nano Banana Pro from text (the edit path is verified, the from-text path uses the same request minus references) and Kling first and last frame. Their first real runs settle them; if either fails, the message on the card says why.

## Run 3: open weights, from your own photos

Expected cost about 50 to 65 credits. You need three photos: a headshot or three-quarter portrait of the person, a product photo on a plain background, and a photo of the place.

1. Settings, Default recipe per capability: back to the starter defaults (clear each field). Save.
2. New project. In chat say that you have photos of the person, the product and the place and want the ad to use them. The assistant steers to uploads rather than generating.
3. Person: the assistant still writes a character bible (it needs the name, wardrobe and voice). Then Assets, Characters, Face slot, Use a photo: upload the portrait and tick the likeness permission line. Body slot: upload a full-body photo if you have one, or let the assistant propose a body from the face. Make reference sheet as in run 1 (its prompt now says to match the photographed person), or Use my own sheet if you already have a three-view sheet. Approve it.
4. Product: Assets, Products, Add product (or Library, New product): name, appearance line, link, and the product photo under Photos. The photo becomes the product reference in every still; the appearance line still matters for the clip prompts.
5. Place: Assets, Sets, New set from photos: a name ("the boardroom"), notes, and the photo. Tell the assistant which beats happen there; its prompts then say the place in the reference photo, matching its layout, furniture and lighting.
6. Script, stills, clips, export as in run 1. A still that needs three references (sheet, product, set) uses the three-reference Qwen graph; the card names it. Only a step with more references than any Qwen graph takes (four or more) goes to a hosted model.
7. Check the export for the things only this run can prove: the person is recognizably the one in the photo, the product is the one in the photo (shape, color, cap), the place is the one in the photo, and the wardrobe is what the bible says rather than what the portrait shows.

## Run 4: premium, from your own photos

Set the premium defaults from run 2 and repeat run 3. Expected cost about 450 to 650 credits with one candidate per step. Every still goes to Nano Banana Pro with all three references, and every clip to Kling, so this is the run to compare side by side with run 3: same photos, same script if you paste it, different models.

## While you test, note anything like this

- A proposal card with no estimate and no ceiling: that recipe cannot be reserved and the card says so. Report the recipe.
- Reserved in Settings staying above zero after everything finished: a job is still in flight or stuck. The Assets tab and the project state show it; restarting the server runs recovery on startup.
- Settings Spent above the Comfy balance change: Router models that report no cost (Kling today) settle at their ceiling in the ledger, so the ledger runs high on them; the Comfy balance is the truth.
- A still showing camera app chrome, a second bottle, lettering on the product, or a different person: these are prompt-rule failures. Archive it, Refine with a one-line instruction, and note what the prompt said (it is on the card).
- Anything in the UI that needs a page reload to update: the workspace polls every two seconds while jobs run and should never need one.

## Resetting

Everything lives in the data folder (`STUDIO_DATA_DIR`, default `.data`): the database, media, exports and the keys file. To start over, stop the server and move that folder aside; the next start creates a fresh one. To keep the projects and clear only the credits ledger, raise the allowance instead; the ledger is per workspace and never resets on its own.
