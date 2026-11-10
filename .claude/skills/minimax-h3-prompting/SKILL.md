---
name: minimax-h3-prompting
description: Write MiniMax H3 video-with-sound prompts from a structured shot spec: image-to-video from a first frame, first and last frame, full-reference multi-shot scenes with <Picture N> keyframes, and last-frame chains for talking content over five seconds. Use when rendering H3 clip prompts, building H3 workflows or the multi-frame reference graph, running the H3 spike, or debugging H3 speech, identity, or seam problems.
---

# MiniMax H3 prompting

Prompts are rendered per model from a shot spec, never copied from an LTX prompt. The renderer is `src/server/tools/prompts-minimax-h3.ts`; tests with full snapshots are in `tests/prompts-minimax-h3.test.ts`.

| Renderer | Workflow | Mode |
| --- | --- | --- |
| `renderH3SingleShot` | `minimax-h3-i2v` (one image), `minimax-h3-flf2v` (two) | Base image to video; first and last frame when `<Picture 2>` is a last frame |
| `renderH3Prompt` | multi-frame reference (R2V weights plus Add Guide anchors) | Full reference: subjects, picture roles, timestamped cuts |
| `renderH3Chain` | `minimax-h3-i2v`, once per segment | Each segment starts from the previous segment's last frame |
| `renderH3Clip` (in `render.ts`) | `minimax-h3-i2v`, `minimax-h3-flf2v`, Router `minimax/minimax-h3*` | A beat's clip spec mapped by `h3ClipSpec` to a single-shot spec; what generate_clip proposes for an H3 recipe |

Each returns `{ ok: true, prompt, frames, anchors }` or `{ ok: false, errors }`; nothing throws on bad input.

Scope: MiniMax H3 (open weights on Comfy, and the v2 `/v2/video_generation` API that Comfy Router forwards unchanged). Not Hailuo 02 or 2.3 (v1): their bracketed camera commands (`[Push in]`, `[Static shot]`) and `prompt_optimizer` belong to that grammar, and how H3 reads brackets is unverified, so never send them to H3. H3 has no negative prompt, seed, or prompt-optimizer field in the API schema. On H3-Max, set `prompt_expansion_mode: disabled` so a rewrite cannot add appearance description; inspect any H3-Context-IR output for trait lists before using it.

## Anchor, do not describe

When `<Picture 1>` is the first frame, it carries the person, wardrobe, product, set, and light. The base renderers point at it (`Avery shown in <Picture 1> keeps the face, hair, clothing, and position exactly as in <Picture 1>.`, `The setting and light stay exactly as in <Picture 1>.`, `The product shown in <Picture 1> keeps its shape and proportions, held in ...`) and never restate the bible's visual core, the wardrobe, or the product's look. Restating traits gives H3 a second instruction to render them: on 2026-11-04 the spike's freckles came out exaggerated with the face description in the prompt. The `h3-traits` spike step tests this on the same still and seed. Keep the face large in frame (H3 distorts faces in wide shots), keep motion subtle, and leave out intensity words (ultra-detailed, 8k, vibrant).

## Prompt shape

- Base modes: one fixed alignment line, a blank line, then three fields: `integrated_multimodal_description` (all visuals, actions, camera, dialogue, and in-scene sound, shot by shot), `overall_soundscape` (ambience and physical sounds, one to four sentences), `non_diegetic_music` (score only, or `N/A`). The alignment line differs for image to video and first and last frame; copy it exactly from the renderer, including the em dash in the first-and-last form, which states the effective duration to two decimals.
- Full reference: six sections in order: `subject_definitions`, `summary` (starts with a bracketed task type such as `[keyframe completion + reference generation]`), `retention_analysis` (one line per label with `fully_preserved` and similar markers), `detailed_description` (a style sentence, then the shots), and the two sound sections. The guide aims for 350 to 500 words of shot description, so these prompts run long (`H3_PROMPT_LIMIT` is 6000 characters, not the 2000 used for image recipes).
- Shots: `[Shot 1]` carries no time. Every later shot opens with one timestamp in `MM:SS.mmm` and a cut verb: `[Shot 2] At 00:03.000, the camera cuts to a close-up.` Never a range. A new shot means new subject, place, viewpoint, state, or time; a small reframe is camera motion inside the shot.
- Camera: motion type, then amplitude and speed only when they are not medium and normal, as a sentence: `The camera pushes in with small amplitude at slow speed toward the bottle.`
- Write in English. The dialogue language goes in a tag inside each line.

## Dialogue

- Lines go in `<d>[English] words.</d>`, never in double quotes. Speaker IDs `(S1)`, `(S2)` follow the order of first speech and stay fixed across shots; people who never speak get none.
- Who speaks, the ID, and the delivery sit outside the tag; only the words go inside. Describe the voice (timbre, pace) once, at the speaker's first line, from the bible.
- In full-reference mode a speaking subject is `<Subject 1> (S1)`.
- End each line with `.`, `?`, or `!` before `</d>`. Ellipses make speech mushy; the renderer refuses them.
- A voice-over uses the phrase `says in an off-screen voiceover`; if the speaker is in frame, say right after that their lips stay closed.
- In the base modes, a subject in frame with no line at all gets `<name>'s lips remain closed throughout.` (b-roll), so H3 does not mouth stray words.
- After an on-camera line the renderer says the speaker finishes and goes quiet with lips closed, to stop the mouth moving into silence.
- Tie lines to what is happening in the shot, not to timecodes. Lines that cross a cut (`<scenetrans>`) or get cut off by the end (`<cutoff>`) exist in the guide but are not rendered; keep each line inside one shot.
- Pace: at most 2.5 words per second of the shot (`WORDS_PER_SECOND`). That is stricter than save_script's 3 words per second ceiling, so a 13 to 15 word line on a 5 s beat passes the script but is refused here: shorten it or lengthen the shot.

## References and anchors

- `<Picture N>` is the Nth `ref_images` slot. A full-reference subject is defined from the pictures that show it. A plain identity photo is cited inside the subject's definition. A character reference sheet gets its own picture line naming its panels, and shots point at the portrait panel.
- Frame anchors: a first frame sits at its shot's start, a keyframe at `atSeconds` inside its shot, a last frame at the end. The Add Guide `frame_idx` is `frameIndexAt(seconds)` = `round(seconds * 24)`. The index plus the guide length (one frame for a still) must stay inside the video. Negative indices count from the end.
- An image wired only to Add Guide pins the frame, but the text encoder never sees it. To name it as `<Picture N>`, wire it into a `ref_images` slot too. `anchors` in the render result lists what to wire where.
- The renderer refuses any `<Picture N>` with no matching picture, and refuses every other tag in free text (it adds `<Subject N>` itself).

## Lengths

24 fps. Lengths snap to 17n+5 frames. `framesForSeconds` picks the smallest such length that covers the plan: 5 s gives 124 frames (5.17 s, the template default), and 5.2 s gives 141. `lastFrameIndex` is the frame a chain extracts for the next segment.

## Gotchas

1. No negative prompt. The sampler runs at cfg 1 with no negative branch, so `No text on screen` or `no logo` puts text and logos into the scene. Say what should be there instead: the product's surface is `plain and unmarked`. Drop the LTX closing constraints entirely.
2. Double quotes mean visible text. H3 renders quoted words as signs or captions, so the LTX form `She says, "..."` is wrong here. The renderer rejects quotes in every free-text field.
3. Guide-only images are invisible to the prompt (see above). This is the most common way a multi-frame prompt points at nothing.
4. Image fitting. The native I2V node stretches `first_frame` to the canvas without keeping its aspect ratio, and center-crops `last_frame`. Our workflows fit images first (`fitImages`), but stills should still be composed at the canvas aspect (736 x 1312) so nothing important is cropped.
5. Weights and steps. Reference mode uses the `ref2va` model, not the `fl2va` one used by i2v and flf2v. The 4-step reference turbo LoRA weakens identity and audio adherence; use 20 to 25 steps when identity must hold.
6. Voices. A reference audio clip carries timbre, not words. With two speakers H3 can give a line to the wrong person; use one audio reference per speaker when it matters.
7. Fill both sound fields every time (`N/A` for music) so H3 does not invent speech or score.
8. Product and identity. The product is never named. In full-reference mode it is described by the card's appearance line, people by the bible's visual core and the project wardrobe (the wardrobe words repeat in every shot), and the subject's short name in actions becomes its `<Subject N>` label. In the base modes the first frame carries all of that (see Anchor, do not describe); only a subject `<Picture 1>` does not show gets a description.

## Known and still to measure

Known: i2v, flf2v, and t2v with sound ran on Comfy Cloud on 2026-10-27 at 736 x 1312, 124 frames, about 21 to 23 credits each (see `workflows/README.md`). The prompt structure above comes from MiniMax's guides. The renderers are tested offline only.

To measure in the spike (log each run in `docs/VERIFICATION.md`):

- Speech clarity against LTX 2.5 on the same line and still: intelligibility, lip sync, and whether the lips-closed sentence stops trailing mouth movement.
- Identity across cuts in one native multi-shot generation, with the reference sheet against a first-frame-only setup.
- Seam quality in a last-frame chain: visible jumps in pose, light, or color; the voice changing between segments (each segment makes its own audio); clicks at the join; whether the set-up sentence in the last second helps; and whether dropping the duplicated first frame of each later segment hides the join.
- H3 Max on Comfy Router (the Router lists `h3-max` and `h3-max-turbo` schemas): durations, price per second, whether it accepts this structured prompt and reference images, and quality against Cloud H3.
- Limits: the longest native duration that holds identity and speech, the shortest usable shot, and how long a prompt the text encoder reads before ignoring the rest.

## Open decision

For talking content longer than 5 s, there are two ways to make it:

- Native H3 multi-shot: one generation with timestamped cuts and keyframes, and one continuous audio track, so the voice stays the same. The costs: one bad shot means regenerating the whole clip, identity may drift across cuts, and approval happens per clip rather than per beat.
- Chained 5 s segments: fits the existing per-beat approve flow, each segment is cheap to redo, and the first frame of each segment is exact. The costs: a seam at every join, and the voice and light may drift between segments.

Decide after the spike on these measurements: seam visibility, voice consistency, identity across cuts, credits per usable second, and redo cost. Record the decision in the PRD and `docs/TASKS.md`.

## Sources

MiniMax H3 prompt writing guides on Hugging Face (`docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md` for T2VA, I2VA, FL2VA, and L2VA; `docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md` for full reference). On docs.comfy.org: the MiniMax H3 prompt guide, the native workflows page (T2V, I2V, R2V, Add Guide), and the multi-frame reference workflow page. Read November 3, 2026.
