---
name: ugc-script
description: Write and structure UGC ad scripts for a single product with talking, b-roll, and text-card beats sized for five-second clips. Use when writing the script tool schema, the creative director prompts, script examples, or when the assistant drafts or revises a script.
---

# UGC ad scripts

## Shape

Total length 15 to 30 seconds, so three to six beats of about five seconds each (one clip per beat). Vertical 1080 x 1920. The character speaks to camera as a friend recommending something; never a presenter voice, never hype.

Beat order for the default template: hook, problem or context, product reveal, proof or demo, CTA. Short ads merge problem and reveal. Alternate talking and b-roll where it helps: a 20-second ad is typically talking, b-roll, talking, b-roll with the CTA spoken over the final b-roll or a text card.

## Beat types

- `talking`: the character on camera, one spoken line of at most 15 words, natural pause room. The still shows the character mid-sentence with the product visible or nearby. The clip prompt carries the spoken line for LTX audio.
- `broll`: no face required. Hands using the product, product close-up, product in the setting, a result shot. Spoken line optional (voice over is not available in the MVP, so b-roll audio is ambient).
- `textcard`: on-screen text over a simple still or the last frame of the previous clip. Used for the CTA or a single claim.

## Fields per beat (schema in `src/lib/domain/script.ts`)

`index`, `type`, `purpose` (hook, problem, reveal, proof, cta), `spokenLine`, `onScreenText` (at most two lines of six words), `visual` (one sentence a still model can render), `setting` (library set id or short description), `productVisible` boolean, `durationSeconds` (default 5), `notes`.

## Rules

- Product claims come only from the product card's allowed claims. If a claim is missing, the assistant asks rather than invents.
- Hooks are specific: a number, a contrast, a question the buyer already has. No "you won't believe".
- On-screen text never repeats the spoken line word for word; it supports it.
- Keep text out of the generated image itself; captions are burned in at assembly.
- Scripts are versioned; editing a beat invalidates that beat's approvals only if its visual changed.

## Example (invented persona and product)

Beat 1, talking, hook: "I stopped buying bottled water the day this fit my cup holder." On-screen: "Fits the cup holder." Visual: Avery in the driver's seat holding the Ridgeline bottle, morning light.
Beat 2, broll, problem: hands pulling a warm plastic bottle from a hot car console. On-screen: "Warm by noon."
Beat 3, talking, proof: "Twenty-four hours later it was still cold. I checked." On-screen: "Cold 24 hours." Visual: Avery at a kitchen counter, bottle open, condensation.
Beat 4, broll, demo: bottle going into a dishwasher rack. On-screen: "Dishwasher safe."
Beat 5, textcard, cta: "Link in bio." Spoken over beat 4's last frame.
