---
name: video-assembly
description: Join approved clips into a 1080 x 1920 ad with ffmpeg, burn in on-screen text, handle mixed audio, extract posters, and verify output with ffprobe. Use when building or debugging the assembly step or the export routes.
---

# Video assembly

## Port first

`/Users/teddarling/Documents/open-higgs/src/server/scene-export.ts` (join, scale and pad, audio re-encode with silence fill, mute, source record, immutable export request and result) and `video-media.ts` (full decode verification, poster extraction). Reformat and rename to `src/server/assembly/`. Keep the tests that use synthetic clips of mixed sizes and frame rates.

## Pipeline

1. Inputs: ordered approved clip assets, per-beat on-screen text, mute flag, captions flag.
2. Normalize each clip: `scale` to fit inside 1080 x 1920 preserving aspect, `pad` to exactly 1080 x 1920, `fps=24`, `setsar=1`, audio `aresample=48000` with `anullsrc` fill when a clip has no audio.
3. Captions: `drawtext` per clip with the beat's text, bundled font file (DejaVu Sans Bold or similar under `assets/fonts/`, license noted), size about 64 px, white with a 4 px dark shadow or a semi-transparent box, centered horizontally, baseline around 78 percent of height so it sits above platform UI, wrapped to at most two lines of six words. Escape text for drawtext (colons, quotes, percent signs).
4. Concatenate with the `concat` filter (not the demuxer) so mixed sources join cleanly. Straight cuts only in the MVP.
5. Encode H.264 `yuv420p`, CRF 18 to 20, `-movflags +faststart`, AAC 160k, or `-an` when muted.
6. Write through a temp file and rename. Verify with ffprobe: 1080 x 1920, 24 fps, expected duration within 0.1 seconds, audio present unless muted. Extract a poster at the first frame.
7. Save the export record: ordered asset ids and hashes, script version, captions on or off, mute, output hash, ffmpeg command summary.

## Later

Remotion or similar for animated captions and transitions; per-beat transitions; music bed with ducking; Cloud-side combine when the app runs without ffmpeg.
