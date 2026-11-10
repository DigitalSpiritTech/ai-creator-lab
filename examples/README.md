# Gallery examples

Each folder here is one gallery example: an ad made with the studio, recorded so anyone can see what it took. The app's Gallery page and the static site (`npm run gallery:build`, published by the manual `Gallery (GitHub Pages)` workflow) both read this folder. The schema is `GalleryExampleSchema` in `packages/core/src/domain/gallery.ts`; `npm test` checks every example against it (`tests/gallery.test.ts`).

Every person and product in an example is invented. Use the example persona from `docs/PRODUCT.md` (Avery Lane, the Ridgeline 32 oz bottle, its sets) or another invented one; never a real or private creator.

## Layout

```
examples/<id>/
  example.json    the record below; "id" must equal the folder name
  <outputs>       the files "outputs" names: .png, .jpg, .webp, or .mp4, side by side with example.json
```

## example.json

| Field | What it holds |
| --- | --- |
| `schemaVersion` | `1` |
| `id`, `title`, `summary` | The folder name, a title, and two or three sentences on what the ad shows |
| `status` | `draft` (planned, not yet generated: no outputs, `cost` null) or `published` (made on a real account) |
| `appId`, `mode` | The App (`ugc-creator`) and, for an Ad, `full` or `quick` (a Quick Ad) |
| `brief` | The project brief: product summary, audience, platforms, tone |
| `recipes` | The recipe for each step, in the order they ran (`step`, `capability`, `recipeId`, optional `backend` and `note`). A draft lists the planned ones |
| `library` | The Library items it starts from, as their fields: `characters` (key, bible, optional wardrobe), `products` (key, product card without images), `sets` (key, name and notes) |
| `cost` | Settled from the Comfy credit balance read before and after the run, never from estimates: `balanceBeforeCredits`, `balanceAfterCredits`, `credits` (before minus after), `usd` (at 210 credits per USD), `measuredOn`, and the matching `docs/VERIFICATION.md` row. `null` for a draft |
| `outputs` | The files made: `kind` (export, still, clip, sheet, face, body, product), `file`, `caption`, `sha256`, `width`, `height`, and `durationSeconds` for video. A published example includes its export |
| `flaws` | What is wrong with the outputs, in plain words. A published example lists at least one line, even if it is "none seen at full size" |
| `madeBy` | Optional: who made it and with what |

"Start from this example" in the app puts the example's characters, products, and sets into your Library (reusing items with the same kind and name), then creates a project with `POST /api/projects` and the inbound context: the brief as version 1 and those items linked. A Quick Ad example opens on the Quick Ad tab. Nothing is generated until you approve it.

## Publishing an example after a real run

Only the maintainer runs paid generations (see `AGENTS.md`, Safety rules).

1. Start a project from the draft (or a new one), run it, and export.
2. Read the credit balance before the first generation and after the export, and log the run in `docs/VERIFICATION.md`.
3. Copy the outputs into the folder (JPEG at 1024 px on the long side for stills; the export as made), and fill in `outputs` with each file's SHA-256 and size.
4. Set `cost` from the two balance readings, write the `flaws` you see at full size, set `status` to `published`, and run `npm test` and `npm run gallery:build`.

## The v0.1 run in docs/examples

`docs/examples/` holds the outputs of the first complete run (October 28, 2026), which the README shows. It stays there unchanged as the v0.1 record. It is not a gallery example: its cost was not settled from a balance reading around that run alone, and its flaws were not written down. The six gallery examples are the maintainer's runs to come (`docs/TASKS.md`).
