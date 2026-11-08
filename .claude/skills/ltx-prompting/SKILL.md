---
name: ltx-prompting
description: Write LTX 2.5 image-to-video and first/last-frame prompts with synchronized audio and dialogue, and choose canvases, lengths, and seeds that are known to work. Use when generating clip prompts for beats, building LTX starter workflows, or debugging drift, ghosting, frozen clips, or audio problems.
---

# LTX 2.5 prompting

Scope: LTX 2.5 distilled open weights on Comfy (`ltx-2.5-i2v`, `ltx-2.5-flf2v`) and the hosted `ltx-2-5-fast` / `pro`. Not for LTX 2 / 2.3 (deprecated; most community "frozen I2V" fixes are from that era), and never for H3 (see minimax-h3-prompting).

## Facts

- LTX 2.5 generates video and synchronized audio together. Describe sounds and dialogue in the prompt. Put spoken lines in double quotes after a speaker phrase and a delivery cue: `She looks into the lens and says in a warm, casual voice, "..."`. Lip sync is approximate; keep lines short.
- Image-to-video uses the input image as the first frame. First/last uses two images with the same aspect ratio; the ending pose is guided, not copied pixel for pixel. Verified October 26 on Comfy Cloud: both endpoints are honored, and when the two frames are different scenes the model bridges them with a dissolve in the last second, so compose the ending frame for the same shot (same setting, same wardrobe, a plausible few seconds later).
- Verified native vertical canvas on the distilled graph: 576 x 1024, 121 frames at 24 fps (about 5.04 seconds). Our graph is single-stage, so 576 x 1024 is the output; the official two-stage template doubles the base size, and its stage-2 upscaler refines from the prompt alone and drifts identity (Lightricks' own warning). Keep identity-critical clips single-stage. Frame counts follow 8n+1; set the length explicitly rather than relying on the duration predictor.
- The distilled graph samples at CFG 1, so a negative prompt does nothing, and neither do `No text on screen` or other "no X" lines in the positive prompt. Steer positively.
- Prompt enhancer (Gemma 4 E2B rewrite): off for every UGC beat. A rewrite of a short motion prompt tends to add appearance description, which is the failure below.
- Final delivery is 1080 x 1920; native output is resized at assembly, not regenerated.

## Prompt structure: prompt the change, not the picture

The start image already carries the person, wardrobe, product, set, and light. Re-describing them makes the model render the traits twice. `clipPrompt` in `src/server/tools/prompts.ts` writes one flowing present-tense paragraph, 4 to 8 sentences and at most 110 words:

1. `Use the provided start image as the first frame.`
2. One action, referring to the person only as `the person in the start image` (then a pronoun). For talking beats, give the delivery cue and then the quoted line, at most 2.5 words per second (12 words for 5 s). Write pauses in ("a small nod follows the last word") so the clip has no dead air.
3. If the product is visible, a hold clause by reference: `The product keeps the shape and proportions it has in the start image, its front toward the camera.`
4. The camera, stated once, relative to the subject, plus `no cuts, natural real-time speed`.
5. Ambience, then `no music` (and `no dialogue` on b-roll and text cards).

Talking example: `Use the provided start image as the first frame. The person in the start image looks into the phone camera, smiles easily, and says in a relaxed, natural voice, "I stopped buying bottled water the day this fit my cup holder." A small nod follows the last word. The product keeps the shape and proportions it has in the start image, its front toward the camera. Handheld phone framing with a subtle natural sway, no cuts, natural real-time speed. Quiet ambient sound of a car interior, no music.`

B-roll example: `Use the provided start image as the first frame. Hands pulling a warm plastic bottle from a hot car console. One simple motion, no cuts, natural real-time speed. The camera pushes in slowly and stops on a steady close-up. Ambient sound of a car interior, no dialogue, no music.`

## Do not include when a start image is supplied

- Bible traits (age, hair, skin, freckles, eyes, makeup, build), wardrobe, product colors or label text.
- Lighting, time of day, or set dressing the still already shows, unless it changes.
- Quality and intensity words: 8k, ultra-detailed, hyper-realistic, vibrant, cinematic slow motion, dramatic.
- "No X" lines naming an unwanted trait; they add the word at CFG 1.
- Other models' syntax: H3 field labels or `<d>` tags, bracket camera commands, `@Image1` tags, Seedance timecode blocks.
- More than one primary action, cuts, or a second speaker.

## Start-image settings (being measured)

The graph runs `LTXVImgToVideoInplace` strength 0.85 and `LTXVPreprocess` img_compression 0. Lightricks' defaults are 0.7 and CRF 18 (LTX 2.5 trains at CRF 18). The v0.2 spike's `ltx-variants` step tests each one alone on the same still and seed as `ltx-dialogue`; both are slots (`imageStrength`, `imgCompression`). Change the workflow defaults only after that run.

## Known problems and fixes

| Symptom | Prompt fix | Setting fix |
| --- | --- | --- |
| Static or frozen clip | One concrete verb per sentence; give empty areas motion; `natural real-time speed` | Lower strength or raise img_compression, one at a time |
| Slow motion or dead air | Write the pauses; fill 5 s with the line plus one gesture | Explicit length (121 frames) |
| Face drift or exaggerated features | Remove appearance words; anchor to the start image | Single stage; fill the frame with the face |
| Mouth artifacts | One speaker, at most 12 words for 5 s, delivery cue before the quote | |
| Hand or product warping | One simple product action; the hold clause | Avoid fast motion |
| Garbled label text | Keep the label facing camera and static; never ask for new text | Composite the real label in post |
| Ghosting or doubled limbs | Simplify to one action, steady camera | Same seed, then a different seed |

## Sources

docs.ltx.io Image-to-Video and Prompting guides; ltx.io "LTX-2.5 Prompt Guide" (August 10, 2026); the LTX 2.5 ComfyUI tutorial on docs.comfy.org; the Lightricks IC-LoRA model card (stage-2 identity drift, CFG 1 with no negative prompt); Lightricks/LTX-2.5 HF discussion #30 (I2V identity). Research summary reviewed November 4, 2026. The trait-amplification cause is an inference to test, not a documented fact.
