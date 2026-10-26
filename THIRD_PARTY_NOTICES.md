# Third-party notices

AI Creator Lab is licensed under the MIT License (see `LICENSE`). It includes or adapts the following third-party material.

## shadcn/ui

The components in `src/components/ui/` are adapted from shadcn/ui (https://ui.shadcn.com), which is licensed under the MIT License. Copyright (c) 2023 shadcn. They build on Radix UI primitives (the `radix-ui` package, MIT), `class-variance-authority` (Apache-2.0), and Tailwind CSS (MIT). The adapted files carry local changes and documentation.

## DejaVu fonts

`assets/fonts/DejaVuSans-Bold.ttf` is DejaVu Sans Bold, used to draw captions on exported videos. DejaVu fonts are derived from Bitstream Vera Fonts (Copyright (c) 2003 Bitstream, Inc.), with changes in the public domain, and include glyphs from the Arev fonts (Copyright (c) 2006 Tavmjong Bah). The full license text is in `assets/fonts/DejaVu-LICENSE.txt` and must travel with the font file in any copy or redistribution.

## npm dependencies

Runtime and build dependencies listed in `package.json` (including Next.js, React, Zod, sharp, Lucide icons, `@anthropic-ai/sdk`, and `@comfyorg/sdk`) are installed from npm and keep their own licenses. They are not copied into this repository. Run `npm ls` and read each package's license file for details.

## Models and services

No model weights are included. The starter workflows reference Z-Image, Qwen Image Edit, and LTX 2.5 model files by name; you use them through Comfy under the licenses and terms that apply to them and to your Comfy account. Hosted models used through Comfy Router are subject to their providers' terms.
