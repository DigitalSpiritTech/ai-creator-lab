# Starter workflows

API-format ComfyUI workflows with slot sidecars, built from Comfy Cloud templates and verified on Comfy Cloud. See `.claude/skills/recipe-catalog/SKILL.md` for the sidecar format. The list is filled in as each workflow is verified; verification dates come from `docs/VERIFICATION.md`.

| Workflow | Capability | Needs on Cloud | Verified |
| --- | --- | --- | --- |
| `z-image-turbo-t2i.api.json` | text_to_image | z_image_turbo_bf16, qwen_3_4b, ae.safetensors (all in the Cloud library) | 2026-10-26, 1024x1024, about 2 to 3 credits |
| `qwen-image-edit-2511-2ref.api.json` | image_edit (2 references) | qwen_image_edit_2511_bf16, qwen_2.5_vl_7b_fp8_scaled, qwen_image_vae, Qwen-Image-Edit-2511-Lightning-4steps LoRA | 2026-10-26, 768x1344, about 7 credits |
| `ltx-2.5-i2v.api.json` | image_to_video | ltx-2.5-22b-distilled-transformer-comfy-int8-convrot, gemma4-12b-with-proj-ltx-2.5-bf16, ltx-2.5 video and audio VAEs | 2026-10-26, 576x1024, 121 frames, 24 fps, audio, about 10 credits |

Each `*.slots.json` sidecar names the node inputs the app binds (prompt, images, size, length, seed) and the output node. Open the `.api.json` in ComfyUI through File, Open; to edit a workflow, change it in ComfyUI, export it again with Export (API), keep the node ids the sidecar points at or update the sidecar.
