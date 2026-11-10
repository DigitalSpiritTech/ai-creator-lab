# Third-party notices

AI Creator Lab is licensed under the MIT License (see `LICENSE`). It includes or adapts the following third-party material.

## shadcn/ui

The components in `packages/ui/src/` are adapted from shadcn/ui (https://ui.shadcn.com), which is licensed under the MIT License. Copyright (c) 2023 shadcn. They build on Radix UI primitives (the `radix-ui` package, MIT), `class-variance-authority` (Apache-2.0), and Tailwind CSS (MIT). The adapted files carry local changes and documentation.

## DejaVu fonts

`assets/fonts/DejaVuSans-Bold.ttf` is DejaVu Sans Bold, used to draw captions on exported videos. DejaVu fonts are derived from Bitstream Vera Fonts (Copyright (c) 2003 Bitstream, Inc.), with changes in the public domain, and include glyphs from the Arev fonts (Copyright (c) 2006 Tavmjong Bah). The full license text is in `assets/fonts/DejaVu-LICENSE.txt` and must travel with the font file in any copy or redistribution.

## npm dependencies

Runtime and build dependencies listed in `package.json` (including Next.js, React, Zod, sharp, Lucide icons, `@anthropic-ai/sdk`, and `@comfyorg/sdk`) are installed from npm and keep their own licenses. They are not copied into this repository. Run `npm ls` and read each package's license file for details.

## FFmpeg (bundled binaries)

`npm ci` downloads static FFmpeg (6.0) and ffprobe builds for your platform through the `ffmpeg-static` and `@derhuerst/ffprobe-static` npm packages (GPL-3.0-or-later). The binaries themselves are GPL builds of FFmpeg (configured with `--enable-gpl`), published as release assets of the ffmpeg-static project (https://github.com/eugeneware/ffmpeg-static/releases, tags `b6.0` for ffmpeg and `b6.1.1` for ffprobe), which collects static builds made by others for each platform. They are separate programs the app runs as child processes; they are not part of this repository's source and keep their own licenses. Each package's folder in `node_modules` carries the GPL license text; the exact build configuration of a binary is what `ffmpeg -version` (or `ffprobe -version`) prints. The Docker image copies the same binaries in with `node_modules`. Set `FFMPEG_PATH` and `FFPROBE_PATH` to use another FFmpeg instead.

## Models and services

No model weights are included. The starter workflows reference Z-Image, Qwen Image Edit, and LTX 2.5 model files by name; you use them through Comfy under the licenses and terms that apply to them and to your Comfy account. Hosted models used through Comfy Router are subject to their providers' terms.
