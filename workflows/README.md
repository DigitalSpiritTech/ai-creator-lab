# Starter workflows

These are API-format ComfyUI workflows, each with a small sidecar file that tells AI Creator Lab which node inputs to fill. All three use open weights and were run on Comfy Cloud on October 26, 2026. The dates and costs come from `docs/VERIFICATION.md`.

| Workflow | Capability | Needs on Cloud | Verified |
| --- | --- | --- | --- |
| `z-image-turbo-t2i.api.json` | text_to_image | z_image_turbo_bf16, qwen_3_4b, ae.safetensors (all in the Cloud library) | 2026-10-26, 1024x1024, about 2 to 3 credits |
| `qwen-image-edit-2511-2ref.api.json` | image_edit (2 references) | qwen_image_edit_2511_bf16, qwen_2.5_vl_7b_fp8_scaled, qwen_image_vae, Qwen-Image-Edit-2511-Lightning-4steps LoRA | 2026-10-26, 768x1344, about 7 credits |
| `qwen-image-edit-2511-1ref.api.json` | image_edit (1 reference: body from a face, refine) | same as the two-reference graph | 2026-10-27, 768x1344, about 6 credits |
| `qwen-image-edit-2511-3ref.api.json` | image_edit (3 references: sheet, product, set) | same as the two-reference graph | 2026-10-27, 768x1344, about 6 credits |
| `ltx-2.5-i2v.api.json` | image_to_video | ltx-2.5-22b-distilled-transformer-comfy-int8-convrot, gemma4-12b-with-proj-ltx-2.5-bf16, ltx-2.5 video and audio VAEs | 2026-10-26, 576x1024, 121 frames, 24 fps, audio, about 10 credits |

Running these needs a Comfy Cloud plan with API access. Without one, use the hosted Router models, which need only credits.

## Open a workflow in ComfyUI or Comfy Cloud

1. Open ComfyUI on your machine, or open Comfy Cloud in your browser.
2. Choose File, then Open, and pick the `.api.json` file from this folder. You can also drag the file onto the canvas.
3. The graph appears with its nodes and settings. On Comfy Cloud the model files above are already in the library. On a local ComfyUI you must have the same model files installed under the same names.

If a node shows a missing model, the name in the file does not match a model in your library. Pick the model you have in that node's dropdown, run it once to check it works, and export again (below).

## Change a workflow and export it again

1. Edit the graph in ComfyUI: swap a model, change steps, add a LoRA, change the sampler.
2. Run it once in ComfyUI to confirm it produces what you expect.
3. Export it in API format: File, then Export (API). The normal Save and Export formats are not the same thing and will not work here. The API format is a flat list of nodes keyed by id.
4. Save the exported file in this folder, replacing the old `.api.json` or under a new name.
5. Keep the node ids that the sidecar points at, or update the sidecar to match (next section). If you added or removed nodes, ComfyUI may have renumbered them.

## The sidecar format

For every workflow `name.api.json` there is a `name.slots.json` next to it. The sidecar says what the workflow does and where the app should put each value. Here is the real sidecar for the text-to-image workflow, `z-image-turbo-t2i.slots.json`:

```json
{
  "workflow": "z-image-turbo-t2i.api.json",
  "capability": "text_to_image",
  "openWeights": true,
  "outputNode": "9",
  "slots": {
    "prompt": { "node": "4", "input": "text" },
    "width": { "node": "6", "input": "width" },
    "height": { "node": "6", "input": "height" },
    "seed": { "node": "8", "input": "seed" }
  },
  "limits": {
    "sizes": [[1024, 1024], [1024, 576], [576, 1024], [896, 1152], [1152, 896], [896, 1120], [1120, 896]],
    "multipleOf": 32
  },
  "notes": "Z-Image Turbo, 8 steps, CFG 1. Model files verified present on Comfy Cloud 2026-10-26."
}
```

What each field means:

- `workflow`: the API-format file this sidecar belongs to.
- `capability`: what the workflow can do for a step. The starter set uses `text_to_image`, `image_edit`, and `image_to_video`.
- `openWeights`: true when the models are open weights.
- `outputNode`: the id of the node whose output is the finished image or video.
- `slots`: the values the app fills in. Each slot names a node id and an input name on that node. Common slots are `prompt`, `width`, `height`, `seed`, and for edits and video the input images (`image`, `image1`, `image2`). Image slots carry `"kind": "image"`. A slot can also be a list when one value must be written to several nodes; the video workflow does this for `length`, which sets the frame count in two places. Video also has `imageStrength`.
- `limits`: the sizes the workflow is known to handle, and rules such as `multipleOf`. The edit workflow also records `maxReferences` and the video workflow a frame count rule (8n+1) and the frame rate.
- `notes`: free text shown with the recipe.

### The rule: node ids must match

Every `node` and `input` in the sidecar must exist in the `.api.json` file, and `outputNode` must be a real node id. When the app loads the catalog it checks each sidecar against its graph, and a sidecar that does not match is skipped with a problem message instead of being offered as a recipe. After any re-export, open the `.api.json`, find the node ids for your prompt, size, seed, input images, and output, and make the sidecar agree.

## Add your own workflow

1. Build or adapt a workflow in ComfyUI and run it once.
2. Export it with Export (API) and save it here as `my-workflow.api.json`.
3. Copy one of the existing `.slots.json` files to `my-workflow.slots.json`, set `workflow` and `capability`, and fill `slots` with the node ids from your file. Set `outputNode`.
4. Restart the app. Workflows that are not part of the starter set load as unverified, and they show that label until you have run them yourself.
5. In Settings, choose it as the default recipe for its capability, or pick it by hand on a proposal.

Test a new workflow with a single candidate first. Cloud bills by GPU time, so an unfamiliar workflow can cost more than you expect.

## Verification

All three starter workflows ran successfully on Comfy Cloud on 2026-10-26 with the model files listed above, and then ran again inside the full three-beat ad on the same day. Nothing in this folder has been verified on a local ComfyUI or a Comfy API deployment yet.
