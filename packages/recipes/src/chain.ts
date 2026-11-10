/**
 * Prompts for a chained take: one clip spec split into segment specs (the line shared out by time
 * at the beat's pace), each rendered in the recipe's prompt style, with continuity written in. A
 * segment after the first says it carries on from its start image (the previous segment's handover
 * frame); a segment before the last foreshadows the next one, ending on a steady pose that sets it
 * up, so the seam joins two matching frames.
 *
 * MiniMax H3 uses its own chain renderer (`renderH3Chain`); every other style decorates the style's
 * own clip prompt with two plain sentences. Pure; returns a readable error instead of throwing.
 * @packageDocumentation
 */
import { type ChainPlan, type PromptStyleSource, inferPromptStyle } from "@creator-lab/core/catalog";
import { wordCount } from "@creator-lab/core/domain/common";
import { BeatSchema, maxWords } from "@creator-lab/core/domain/script";
import type { ClipSpec } from "@creator-lab/core/domain/shot-spec";
import type { RendererTable } from "@creator-lab/core/registry";
import { h3ClipSpec, renderPrompt, STARTER_RENDERER_TABLE } from "./render";
import { renderH3Chain } from "./prompts-minimax-h3";
import { START_IMAGE } from "./prompts";

export interface ChainSegmentPrompt {
  index: number;
  /** The words this segment speaks (empty on b-roll and text cards). */
  line: string;
  prompt: string;
  /** The segment's own clip spec, which its job carries for provenance. */
  spec: ClipSpec;
}

export type ChainRender = { ok: true; segments: ChainSegmentPrompt[] } | { ok: false; error: string };

/** The sentence a later segment opens with instead of the plain start-image line. */
export const CONTINUES_FROM =
  "Use the provided start image as the first frame; it is the last moment of the previous shot, so the motion carries on from it without a reset.";
/** The foreshadowing sentence an outgoing segment ends on, by beat type. */
export const SETS_UP = {
  talking: "In the last second the person keeps the same framing and pose and glances back to the lens mid-thought, ready to go on.",
  broll: "The motion keeps its speed into the last frame, ready to carry on.",
  textcard: "The scene stays steady into the last frame, ready to carry on.",
} as const;

/**
 * Shares a line out across the segments by the new time each one adds (the first its whole length,
 * the rest their length minus the crossfade), cutting at punctuation within two words of the even
 * split when there is some.
 */
export function splitLine(line: string, plan: Pick<ChainPlan, "overlapSeconds" | "segments">): string[] {
  const words = line.trim().split(/\s+/).filter(Boolean);
  const fresh = plan.segments.map((segment, position) => segment.durationSeconds - (position === 0 ? 0 : plan.overlapSeconds));
  const total = fresh.reduce((sum, value) => sum + value, 0);
  const parts: string[] = [];
  let from = 0;
  let elapsed = 0;
  for (let position = 0; position < plan.segments.length; position++) {
    elapsed += fresh[position];
    const last = position === plan.segments.length - 1;
    let to = last ? words.length : Math.round((words.length * elapsed) / total);
    if (!last) {
      const breaks = [0, -1, 1, -2, 2].map((shift) => to + shift).filter((index) => index > from && index < words.length && /[.,!?;:]$/.test(words[index - 1]));
      if (breaks.length) to = breaks[0];
      to = Math.max(from, Math.min(to, words.length));
    }
    parts.push(words.slice(from, to).join(" "));
    from = to;
  }
  return parts;
}

function segmentSpecs(spec: ClipSpec, plan: ChainPlan): { specs: ClipSpec[]; lines: string[] } | { error: string } {
  const talking = spec.beat.type === "talking";
  // B-roll and text cards speak nothing on camera (their line is a voice-over mixed in at export),
  // but each segment's beat still carries its share so it fits the segment's length.
  const shares = splitLine(spec.beat.spokenLine, plan);
  const lines = talking ? shares : plan.segments.map(() => "");
  if (talking && lines.some((line) => !line)) {
    return { error: `The line has ${wordCount(spec.beat.spokenLine)} words, too few for a ${plan.totalSeconds} s take in ${plan.segments.length} segments. Lengthen the line or shorten the take.` };
  }
  const specs: ClipSpec[] = [];
  for (const [position, segment] of plan.segments.entries()) {
    const seconds = Math.min(15, segment.durationSeconds);
    const words = wordCount(shares[position]);
    if (talking && words > maxWords(seconds)) {
      return { error: `Segment ${segment.index} would carry ${words} words in ${seconds} s. Lengthen the take or shorten the line.` };
    }
    const beat = BeatSchema.safeParse({ ...spec.beat, spokenLine: shares[position], durationSeconds: seconds });
    if (!beat.success) return { error: `Segment ${segment.index}: ${beat.error.issues[0]?.message ?? "the beat does not fit"}` };
    specs.push({ ...spec, beat: beat.data, durationSeconds: seconds });
  }
  return { specs, lines };
}

/** Continuity for the plain-English styles: a carry-on opening after the first segment, a set-up before the last. */
export function withContinuity(prompt: string, position: number, count: number, beatType: ClipSpec["beat"]["type"]): string {
  let text = prompt;
  if (position > 0) text = text.startsWith(START_IMAGE) ? `${CONTINUES_FROM}${text.slice(START_IMAGE.length)}` : `${CONTINUES_FROM} ${text}`;
  if (position < count - 1) text = `${text} ${SETS_UP[beatType]}`;
  return text;
}

/**
 * Renders every segment of a chained take for a recipe. `table` is the plugin registry's renderer
 * table; without one, the starter renderers.
 */
export function renderChain(spec: ClipSpec, plan: ChainPlan, recipe: PromptStyleSource, table: RendererTable = STARTER_RENDERER_TABLE): ChainRender {
  const split = segmentSpecs(spec, plan);
  if ("error" in split) return { ok: false, error: split.error };
  const { specs, lines } = split;
  if (inferPromptStyle(recipe) === "minimax-h3") {
    if (spec.mode === "speech") return { ok: false, error: "MiniMax H3 does not lip-sync to a recording; use a speech to video recipe." };
    const prompts: string[] = [];
    for (let position = 0; position < specs.length; position++) {
      // A window around each segment gives it the right opening (continues) and ending (sets up the next).
      const start = Math.max(0, position - 1);
      const window = specs.slice(start, Math.min(specs.length, position + 2));
      const rendered = renderH3Chain({ segments: window.map((segment) => h3ClipSpec(segment)) });
      if (!rendered.ok) return { ok: false, error: `MiniMax H3 cannot render segment ${position + 1}: ${rendered.errors[0].replace(/^[\w.]+: /, "")}` };
      prompts.push(rendered.segments[position - start].prompt);
    }
    return { ok: true, segments: specs.map((segment, position) => ({ index: position + 1, line: lines[position], prompt: prompts[position], spec: segment })) };
  }
  const segments: ChainSegmentPrompt[] = [];
  for (const [position, segment] of specs.entries()) {
    const rendered = renderPrompt(segment, recipe, table);
    if (!rendered.ok) return { ok: false, error: `Segment ${position + 1}: ${rendered.error}` };
    segments.push({ index: position + 1, line: lines[position], prompt: withContinuity(rendered.prompt, position, specs.length, segment.beat.type), spec: segment });
  }
  return { ok: true, segments };
}

/** The proposal card's view of a chain: every segment's prompt under a heading with its span. */
export function chainPromptSummary(plan: ChainPlan, segments: readonly Pick<ChainSegmentPrompt, "prompt">[], limit = 10_000): string {
  const blocks = plan.segments.map((segment, position) => {
    const end = segment.startSeconds + segment.durationSeconds;
    return `[Segment ${segment.index} of ${plan.segments.length}, ${segment.startSeconds.toFixed(2)} to ${end.toFixed(2)} s]\n${segments[position]?.prompt ?? ""}`;
  });
  const text = blocks.join("\n\n");
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}
