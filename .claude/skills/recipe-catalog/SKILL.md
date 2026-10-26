---
name: recipe-catalog
description: Define capabilities, recipes, slot sidecars, and starter workflows so any Comfy-hosted model or workflow can fulfill a step. Use when adding a model, writing a workflow sidecar, tagging Router models, or wiring a step to a recipe.
---

# Recipe catalog

## Capabilities (MVP)

`text_to_image`, `image_edit` (one to N reference images, records max), `image_to_video`, `first_last_to_video`, `text_to_video`. Later: `references_to_video`, `video_reference_to_video`, `audio_reference_to_video`, `text_to_speech`, `upscale_image`, `upscale_video`, `text_generation` (Comfy Cloud runs Qwen3-VL through the core Load CLIP and Generate Text nodes; output is text, inputs are prompt, system prompt, and optional image, video, or audio; use for review gates, not conversation).

A step in the creative flow asks for a capability and a set of semantic inputs. The catalog returns recipes that satisfy it. The user or the default setting picks one.

## Recipe schema (Zod in `src/lib/catalog/`)

Common: `id`, `title`, `capability`, `kind` (`router` | `workflow` | `mock`), `openWeights` boolean, `verified` (date or null), `costHint` text, `limits` (aspect ratios, sizes, max references, duration), `defaults`.

Router recipe adds `provider`, `model`, `fieldMap` (semantic field to schema path), and caches the fetched input schema.

Workflow recipe adds `file` (path under `workflows/`), `target` hint, and the slot map from the sidecar.

## Slot sidecar format (`workflows/<name>.slots.json`)

```json
{
  "workflow": "ltx-2.5-i2v-cloud.api.json",
  "capability": "image_to_video",
  "outputNode": "95",
  "slots": {
    "prompt": { "node": "6", "input": "text" },
    "image": { "node": "78", "input": "image", "kind": "image" },
    "width": { "node": "70", "input": "width" },
    "height": { "node": "70", "input": "height" },
    "length": { "node": "70", "input": "length" },
    "seed": { "node": "3", "input": "noise_seed" }
  },
  "limits": { "aspectRatios": ["9:16", "16:9", "1:1"], "sizes": [[576, 1024], [720, 1280]] }
}
```

Node ids and input names must match the API-format file. `workflow-discovery.ts` from the previous project detects LoadImage, text, and size inputs; port it to propose a sidecar for a user-uploaded workflow, then let the user confirm.

## Starter workflows (build from Comfy Cloud templates, verify in the spike)

`ltx-2.5-i2v-cloud`, `ltx-2.5-flf2v-cloud` (stretch), one multi-reference image edit (Qwen Image Edit on Cloud is the first candidate), one text-to-image (Z-Image Turbo or Qwen Image on Cloud). Each ships with a sidecar and a line in `workflows/README.md` stating what it needs and when it was verified.

## Starter Router recipes

`vertexai/gemini-nano-banana-2` (or the current Nano Banana id) for `image_edit` with multiple references, `bfl/flux-2-pro` for `text_to_image`, Seedance, Kling, and Wan 3 for `image_to_video` alternatives. Pull the live model list for everything else and tag by capability; show unverified ones with a label.

## Defaults

Set per capability in settings. Competition defaults are decided by the spike and recorded in `docs/VERIFICATION.md`: video default is LTX 2.5 on Cloud unless it cannot run there, in which case the Lightricks LTX partner node inside a Cloud workflow.
