---
name: ltx-prompting
description: Write LTX 2.5 image-to-video and first/last-frame prompts with synchronized audio and dialogue, and choose canvases, lengths, and seeds that are known to work. Use when generating clip prompts for beats, building LTX starter workflows, or debugging drift, ghosting, or audio problems.
---

# LTX 2.5 prompting

## Facts

- LTX 2.5 generates video and synchronized audio together. Describe sounds and dialogue in the prompt. Put spoken lines in quotes: `She says, "Twenty-four hours later it was still cold."` Lip sync is approximate; keep lines short.
- Image-to-video uses the input image as the first frame. First/last uses two images with the same aspect ratio; the ending pose is guided, not copied pixel for pixel.
- Verified native vertical canvas on the distilled open-weights graph: 576 x 1024, 121 frames at 24 fps (about 5.04 seconds). Cloud templates may allow 720 x 1280; verify in the spike before offering it. Frame counts follow 8n+1.
- Prompt enhancers add one to two minutes; leave them off by default.
- Final delivery is 1080 x 1920; native output is resized at assembly, not regenerated.

## Prompt structure for a beat

One paragraph, in this order: who and what is in frame (consistent with the still), the single action, camera (static or one slow move), ambient audio, dialogue in quotes if the beat is `talking`, and a closing constraint: `No text on screen. The person's face and clothing stay consistent.`

Talking beat example: `A woman in her early thirties with dark hair tied back sits in a parked car holding a steel water bottle, speaking to the camera with an easy smile, small natural head movement, static phone camera, soft morning light, quiet car interior with faint traffic outside. She says, "I stopped buying bottled water the day this fit my cup holder." No text on screen. Her face and clothing stay consistent.`

B-roll example: `Close-up of two hands lifting a sweating steel bottle from a car cup holder, slow push-in, warm sunlight through the windshield, quiet interior, the sound of the bottle sliding out of the holder. No people's faces. No text on screen.`

## Known problems and fixes

- Mid-clip ghosting or doubled limbs: simplify the motion to one action, keep the camera static, retry with the same seed, then try a different seed.
- Drift from the still: shorten the prompt, repeat the clothing and setting words from the still prompt, avoid new objects.
- Audio contains unintended speech on b-roll: say `no speech, ambient sound only`.
- Text artifacts: always include `No text on screen.`

## Sources

docs.ltx.io usage guides (text-to-video, image-to-video), the LTX 2.5 ComfyUI tutorial on docs.comfy.org, and Comfy MCP `get_prompting_guide` for the model family.
