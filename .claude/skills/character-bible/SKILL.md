---
name: character-bible
description: Build a reusable AI creator character: the bible schema, elicitation questions, 3/4-view face lock, 3/4 full-body reference in athleticwear, the per-project reference sheet, naming, and archiving of rejected candidates. Use when implementing the character tools, the creative director's character stage, the reference sheet step, or the prompt templates for identity references.
---

# Character bible and references

## Bible schema (`src/lib/domain/character.ts`)

`name`, `ageRange`, `look` (face, hair, skin, eyes, distinguishing details), `build`, `wardrobeDefaults` (two or three outfits), `voice` (how they talk, pace, phrases they use and avoid), `vibe` (three adjectives), `backstory` (two sentences), `boundaries` (what the character never does or says), `visualCore` (one dense sentence, under 60 words, used verbatim at the start of every image prompt), `references` (`faceAssetId`, `bodyAssetId`, optional wardrobe asset ids), `version`.

The `visualCore` is the contract between the bible and the image models. Change it only through a bible revision.

## Elicitation (at most eight questions, defaults offered for each)

Who buys the product and who would they trust? Age range. Look in a sentence. Hair. Style of dress. How they talk. One thing that makes them memorable. Anything they must never do.

## Face lock procedure

1. Prompt template (Z-Image ignores the phrase "three-quarter view" on its own; state the turn explicitly): `{visualCore}. Portrait, head and shoulders, head turned about thirty degrees to her left so the far cheek narrows and the near ear shows, eyes toward the camera, neutral expression with a hint of a smile, soft natural window light, plain light gray background, no accessories beyond the bible, photographic, 85mm look.` Aspect 4:5 or 1:1. Four candidates with different seeds.
2. The user picks one and names the character. `select_reference` stores it as `faceAssetId`, archives the other candidates, and bumps the bible version.
3. A face lock is a human decision. The app does not claim identity verification. A later vision gate can score candidates against the bible.

## Body reference procedure

1. Uses an `image_edit` recipe with the face reference as input. Prompt: `Same person as the reference image, identical face and hair. Three-quarter view full-body standing pose, relaxed, arms at sides, fitted neutral athleticwear (plain fitted tee and leggings or shorts), bare feet or simple trainers, plain light gray background, even soft light, photographic.` Aspect 9:16.
2. Approve one; store as `bodyAssetId`; archive siblings.
3. Wardrobe variants later start from the body reference with an edit prompt that names the outfit.

## Reference sheet procedure (per project)

Why: one sheet carries the face, the build, and this project's wardrobe in a single image, so every still is composed from one character reference instead of two, and video models that read a reference image get the same evidence. The bible stays in the Library; the sheet belongs to the project because wardrobe changes per project.

1. Wardrobe: the assistant proposes one outfit from `wardrobeDefaults` that suits the brief, or the user names one. Record it on the project-character link.
2. Generate through an `image_edit` recipe with two inputs: the approved face (reference image 1) and the approved body (reference image 2). Landscape 3:2 or 16:9, highest resolution the recipe allows. Prompt template:

```
Character reference sheet of one consistent person, on a deep neutral grey (#3a3a3c) seamless studio background, clean editorial layout in three vertical columns read left to right, identical identity, lighting, and color grading in every panel.
Column 1, largest, about a third of the width: chest-up portrait turned slightly off frontal, sharp focus on the eyes, iris color clearly visible, soft catchlights in both eyes, natural skin texture with subtle imperfections, no mirror symmetry.
Column 2: full-body front view, relaxed standing pose, arms slightly away from the body, head to toe inside the frame with even margins.
Column 3: full-body back view, same pose mirrored, showing hair fall, posture, and garment fit.
The person is the person in reference image 1 (face, hair, skin, eyes) with the build of reference image 2. {visualCore}. Wardrobe in every panel: {wardrobe}.
Soft even studio light, large diffused key with gentle fill, neutral white balance, true-to-life skin, 85mm look, tack-sharp detail. No text, no labels, no logos, no colored rim light, no 3D render look.
```

3. Candidates: two to four with different seeds. The user inspects at full size; the card shows the checklist below.
4. Approve one; store `sheetAssetId` on the project-character link; archive the rest. From then on every still prompt in this project uses the sheet as reference image 1.
5. Fix small flaws with `refine_still` on the chosen candidate (prompt-guided edit of the one image) rather than regenerating the whole sheet repeatedly; stacked regenerations drift and the background picks up grime. Re-inspect after every edit.

Inspection checklist (reject on any):
- Portrait is not the dominant panel (should be roughly a quarter to a third of the sheet) or is dead-on frontal.
- Irises read black or there is no catchlight.
- The face in the full-body panels does not match the portrait (two identities).
- Mottled or dirty background, baked-in colored rim light, plastic or game-render skin, or a perfectly mirror-symmetric face.
- Wardrobe differs between panels or from the chosen outfit.
- Any text, logo, or watermark.

Later: crop the heads out of the full-body panels automatically before using the sheet with a reference-mode video model, so the model takes face detail from the portrait panel only; and a vision review recipe that scores the checklist.

## Identity preservation wording for stills

When the project has an approved reference sheet, every still prompt starts with the `visualCore`, references "the person shown in the character reference sheet, reference image 1", names the wardrobe, and ends with `Preserve the person's identity, face, hair, build, and wardrobe exactly as in the sheet.` The product is "the product in reference image 2". Settings are described or referenced as image 3.

Without a sheet (cut or not yet approved), fall back to the face image as reference image 1 and the body image as reference image 2, with the product as image 3.

## Naming and archiving

Rejected candidates go to Archive automatically with the reason "not selected". Archived assets stay restorable. "Delete everywhere" is a separate confirmed action that lists what breaks.
