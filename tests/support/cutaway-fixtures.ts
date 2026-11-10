/**
 * Take-then-cutaways fixtures: a four-beat script for the invented Ridgeline bottle (two seconds a
 * beat, so an 8 s take) and the handwritten Whisper word timestamps for it.
 * @packageDocumentation
 */
import { readFileSync } from "node:fs";
import type { BeatInput } from "@creator-lab/core/domain/script";

export const CUTAWAY_BEATS: BeatInput[] = [
  {
    type: "talking",
    purpose: "hook",
    spokenLine: "This fits my cup holder.",
    onScreenText: "Fits the cup holder.",
    visual: "Avery in the driver's seat holding the Ridgeline bottle, morning light.",
    setting: "a car interior",
    productVisible: true,
    durationSeconds: 2,
  },
  {
    type: "broll",
    purpose: "problem",
    spokenLine: "Warm by noon, every day.",
    onScreenText: "Warm by noon.",
    visual: "Hands pulling a warm plastic bottle from a hot car console.",
    setting: "a car interior",
    durationSeconds: 2,
  },
  {
    type: "talking",
    purpose: "proof",
    spokenLine: "Still cold a day later.",
    onScreenText: "Cold 24 hours: I checked.",
    visual: "Avery at a kitchen counter, bottle open, condensation.",
    setting: "a bright kitchen counter by a window",
    productVisible: true,
    durationSeconds: 2,
  },
  {
    type: "broll",
    purpose: "cta",
    spokenLine: "Link below.",
    onScreenText: "",
    visual: "The bottle going into a dishwasher rack.",
    setting: "a bright kitchen counter by a window",
    productVisible: true,
    durationSeconds: 2,
  },
];

/** The take's length: the beats added up. */
export const TAKE_SECONDS = 8;

/** The fixture as Whisper returns it (segments with word timestamps). */
export function takeTranscriptFixture(): unknown {
  return JSON.parse(readFileSync(new URL("../fixtures/transcripts/ridgeline-take.json", import.meta.url), "utf8"));
}
