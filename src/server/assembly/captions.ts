/**
 * Burned-in captions: wraps a beat's on-screen text to at most two lines, sizes it so it never
 * leaves the safe area of a 1080 x 1920 frame, and builds escaped `drawtext` filters for it.
 * Widths come from the bundled DejaVu Sans Bold advance table, so layout is pure and exact
 * enough to guarantee no clipping (kerning only ever narrows a line).
 * @packageDocumentation
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { EXPORT_HEIGHT, EXPORT_WIDTH } from "@/lib/domain/content";

/** Bundled caption font, relative to the app root. License: `assets/fonts/DejaVu-LICENSE.txt`. */
export const CAPTION_FONT_RELATIVE = "assets/fonts/DejaVuSans-Bold.ttf";

export const CAPTION_FONT_SIZE = 64;
const MIN_FONT_SIZE = 16;
/** Horizontal margin on each side; 960 px of a 1080 px frame carry text. */
const SIDE_MARGIN = 60;
export const CAPTION_SAFE_WIDTH = EXPORT_WIDTH - 2 * SIDE_MARGIN;
/** The last line's baseline sits here, above the platform UI at the bottom of the screen. */
export const CAPTION_BASELINE_RATIO = 0.78;
const LINE_HEIGHT_RATIO = 1.25;
const SHADOW_OFFSET = 4;

const UNITS_PER_EM = 2048;
/** Advance widths of DejaVu Sans Bold for code points 32 to 126, in font units. */
const ASCII_ADVANCE = [
  713, 934, 1067, 1716, 1425, 2052, 1786, 627, 936, 936, 1071, 1716, 778, 850, 778, 748, 1425, 1425, 1425, 1425, 1425,
  1425, 1425, 1425, 1425, 1425, 819, 819, 1716, 1716, 1716, 1188, 2048, 1585, 1561, 1503, 1700, 1399, 1399, 1681, 1714,
  762, 762, 1587, 1305, 2038, 1714, 1741, 1501, 1741, 1577, 1475, 1397, 1663, 1585, 2259, 1579, 1483, 1485, 936, 748, 936,
  1716, 1024, 1024, 1382, 1466, 1214, 1466, 1389, 891, 1466, 1458, 702, 702, 1362, 702, 2134, 1458, 1407, 1466, 1466,
  1010, 1219, 979, 1458, 1335, 1892, 1321, 1335, 1192, 1458, 748, 1458, 1716,
];
/** Anything outside printable ASCII is measured as the widest Latin glyph, so it errs narrow. */
const FALLBACK_ADVANCE = 2259;

/** Rendered width of one line in pixels at `fontSize`, never less than the real width. */
export function lineWidth(line: string, fontSize: number): number {
  let units = 0;
  for (const character of line) {
    const code = character.codePointAt(0)!;
    units += code >= 32 && code <= 126 ? ASCII_ADVANCE[code - 32] : FALLBACK_ADVANCE;
  }
  return (units / UNITS_PER_EM) * fontSize;
}

function tidy(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

/**
 * Splits caption text into at most two lines. Explicit line breaks win; a single line that is
 * too wide at full size is split at the word boundary that best balances the two halves.
 */
export function wrapCaption(text: string): string[] {
  const explicit = text.split(/\r?\n/).map(tidy).filter(Boolean);
  if (explicit.length === 0) return [];
  if (explicit.length > 1) return [explicit[0], tidy(explicit.slice(1).join(" "))];
  const line = explicit[0];
  const words = line.split(" ");
  if (words.length < 2 || lineWidth(line, CAPTION_FONT_SIZE) <= CAPTION_SAFE_WIDTH) return [line];
  let best: string[] = [line];
  let bestWidth = Infinity;
  for (let split = 1; split < words.length; split++) {
    const lines = [words.slice(0, split).join(" "), words.slice(split).join(" ")];
    const widest = Math.max(...lines.map((entry) => lineWidth(entry, CAPTION_FONT_SIZE)));
    if (widest < bestWidth) {
      best = lines;
      bestWidth = widest;
    }
  }
  return best;
}

export interface CaptionLayout {
  lines: string[];
  fontSize: number;
  /** Baseline y of each line, top to bottom. */
  baselines: number[];
}

/** Wraps and sizes a caption: 64 px unless the widest line needs less to fit the safe width. */
export function layoutCaption(text: string): CaptionLayout | null {
  const lines = wrapCaption(text);
  if (lines.length === 0) return null;
  const widest = Math.max(...lines.map((line) => lineWidth(line, CAPTION_FONT_SIZE)));
  const fitted = widest <= CAPTION_SAFE_WIDTH ? CAPTION_FONT_SIZE : Math.floor((CAPTION_FONT_SIZE * CAPTION_SAFE_WIDTH) / widest);
  const fontSize = Math.max(MIN_FONT_SIZE, fitted);
  const lineHeight = Math.round(fontSize * LINE_HEIGHT_RATIO);
  const last = Math.round(EXPORT_HEIGHT * CAPTION_BASELINE_RATIO);
  const baselines = lines.map((_, index) => last - (lines.length - 1 - index) * lineHeight);
  return { lines, fontSize, baselines };
}

/**
 * Escapes a value for a `drawtext` option inside an ffmpeg filter graph. Two parsers unescape
 * it in turn: the filter's option parser (`\`, `'`, `:`), then the graph parser
 * (`\`, `'`, `[`, `]`, `,`, `;`). Percent signs are literal because captions use
 * `expansion=none`.
 */
export function escapeDrawtext(value: string): string {
  const option = value.replace(/[\\':]/g, (character) => `\\${character}`);
  return option.replace(/[\\'[\],;]/g, (character) => `\\${character}`);
}

/** One `drawtext` filter per caption line, joined for a filter chain; empty when there is no text. */
export function captionFilters(text: string, fontPath: string): string {
  const layout = layoutCaption(text);
  if (!layout) return "";
  const font = escapeDrawtext(fontPath);
  return layout.lines
    .map((line, index) =>
      [
        `drawtext=fontfile=${font}`,
        `text=${escapeDrawtext(line)}`,
        "expansion=none",
        `fontsize=${layout.fontSize}`,
        "fontcolor=white",
        "shadowcolor=black@0.75",
        `shadowx=${SHADOW_OFFSET}`,
        `shadowy=${SHADOW_OFFSET}`,
        "x=(w-text_w)/2",
        `y=${layout.baselines[index]}-ascent`,
      ].join(":"),
    )
    .join(",");
}

/** The caption font: `CAPTION_FONT_PATH` when set, else the bundled file; undefined when neither exists. */
export function captionFontPath(): string | undefined {
  const configured = process.env.CAPTION_FONT_PATH?.trim();
  const path = configured || join(/* turbopackIgnore: true */ process.cwd(), CAPTION_FONT_RELATIVE);
  return existsSync(path) ? path : undefined;
}
