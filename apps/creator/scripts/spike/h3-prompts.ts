/**
 * Literal MiniMax H3 prompts for the v0.2 spike, written to MiniMax's official prompt guides
 * (base modes for image to video, full-reference mode for the multi-frame graph): the subject is
 * defined first, every `<Picture N>` is mapped to a shot, later shots open at an explicit
 * `At MM:SS.mmm` cut time, and spoken lines carry a speaker id with the words in
 * `<d>[English] ...</d>` (the guide's form for dialogue; plain quotes are for on-screen text).
 *
 * These are spike fixtures for the invented persona in docs/PRODUCT.md (Avery Lane and the
 * Ridgeline bottle, described by appearance only). The app's renderer for H3 prompts is written
 * separately and replaces these after the spike.
 * @packageDocumentation
 */

/** The spoken line both dialogue steps use (the proof beat of the Ridgeline script, 9 words). */
export const DIALOGUE_LINE = "Twenty-four hours later it was still cold. I checked.";

/** The two halves of the chained talking beat (about 10 s in two 5 s segments). */
export const CHAIN_LINES = ["I filled this before my commute yesterday morning.", DIALOGUE_LINE] as const;

/**
 * The person, by reference only. <Picture 1> carries her identity; a face description on top of it
 * (freckles, hair) made H3 exaggerate those features and could contradict the still (2026-11-04 run).
 */
export const PERSON = "the woman";

/**
 * The trait description the 2026-11-04 run used, kept only for the h3-traits A/B: the same still
 * and seed with and without it shows whether restating traits is what exaggerates them.
 */
export const PERSON_WITH_TRAITS =
  "a woman in her early 30s with a warm oval face, light freckles, hazel eyes, dark shoulder-length hair tied back, and small silver hoop earrings";

/** The product by appearance only; its name never reaches a video prompt. */
export const BOTTLE = "a matte dark green insulated steel bottle with a black screw cap";

/** The voice as the base guide asks for it: identity, pitch, timbre, pace. */
const VOICE = "the warm, unhurried woman with a clear mid-range voice (S1)";

/** The I2VA opening line, verbatim from the base-mode guide. */
export const I2VA_ALIGNMENT = "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.";

/** `At 00:02.000` for 2 seconds: the guide's single-timestamp cut format. */
export function cutTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${rest.toFixed(3).padStart(6, "0")}`;
}

function i2va(description: string, soundscape: string): string {
  return [I2VA_ALIGNMENT, "", `integrated_multimodal_description: ${description}`, "", `overall_soundscape: ${soundscape}`, "", "non_diegetic_music: N/A"].join("\n");
}

/** Step 1: H3 image to video from the approved still, one shot, the line spoken to camera; `person` is the A/B's only variable. */
export function h3DialoguePrompt(line: string = DIALOGUE_LINE, person: string = PERSON): string {
  return i2va(
    [
      `[Shot 1] Live-action, candid vertical phone video, ${person} shown in <Picture 1> stands at a bright kitchen counter by a window holding ${BOTTLE}, preserving her face, hair, earrings, clothing, and the kitchen layout from <Picture 1>.`,
      "The camera holds a static shot at chest height.",
      `She looks into the lens with an easy smile, and ${VOICE} says: <d>[English] ${line}</d>`,
      "She taps the side of the bottle once with a fingertip, nods slightly, and closes her lips into a relaxed smile.",
    ].join(" "),
    "Quiet kitchen room tone with soft daylight ambience, and one light tap of a fingertip on steel.",
  );
}

/**
 * Step 3, the chained talking beat: segment 1 from the approved still, segment 2 from segment 1's
 * last frame, so the second prompt continues the same moment rather than restarting it.
 */
export function h3ChainPrompts(lines: readonly [string, string] = CHAIN_LINES): [string, string] {
  const first = i2va(
    [
      `[Shot 1] Live-action, candid vertical phone video, ${PERSON} shown in <Picture 1> stands at a bright kitchen counter by a window holding ${BOTTLE}, preserving her face, hair, earrings, clothing, and the kitchen layout from <Picture 1>.`,
      "The camera holds a static shot at chest height.",
      `She lifts the bottle slightly toward the lens and ${VOICE} says: <d>[English] ${lines[0]}</d>`,
      "She keeps her eyes on the camera and holds the bottle steady near her chest at the end.",
    ].join(" "),
    "Quiet kitchen room tone with soft daylight ambience.",
  );
  const second = i2va(
    [
      `[Shot 1] Live-action, candid vertical phone video, continuing the same moment: ${PERSON} shown in <Picture 1> still stands at the bright kitchen counter holding ${BOTTLE}, with the same pose, framing, and light as <Picture 1>.`,
      "The camera holds a static shot at chest height.",
      `${VOICE.charAt(0).toUpperCase()}${VOICE.slice(1)} goes on in the same voice and says: <d>[English] ${lines[1]}</d>`,
      "She taps the side of the bottle once with a fingertip, nods slightly, and closes her lips into a relaxed smile.",
    ].join(" "),
    "Quiet kitchen room tone with soft daylight ambience, and one light tap of a fingertip on steel.",
  );
  return [first, second];
}

/** What the two keyframe stills show, so the prompt can map them; override for other stills. */
export const DEFAULT_KEYFRAME_NOTES: readonly [string, string] = [
  `a medium shot of <Subject 1> standing at the head of a boardroom table, holding ${BOTTLE} near her chest`,
  `a closer shot of <Subject 1> in the same boardroom, ${BOTTLE} in her hand, looking at the camera`,
];

/**
 * Step 2, the multi-frame graph: <Picture 1> is the identity and the first frame, <Picture 2> and
 * <Picture 3> are the keyframes pinned at `seconds` (the Add Guide frames), cut to at those times.
 */
export function h3MultiframePrompt(seconds: readonly [number, number], notes: readonly [string, string] = DEFAULT_KEYFRAME_NOTES, line: string = DIALOGUE_LINE): string {
  const [second, third] = seconds;
  return [
    "subject_definitions:",
    "<Subject 1> is the woman in <Picture 1>.",
    `<Picture 1> is the first frame of [Shot 1], showing <Subject 1> at a bright kitchen counter by a window holding ${BOTTLE}.`,
    `<Picture 2> is the keyframe of [Shot 2], showing ${notes[0]}.`,
    `<Picture 3> is the keyframe of [Shot 3], showing ${notes[1]}.`,
    "",
    "summary:",
    `[keyframe completion + reference generation] A three-shot vertical UGC video of <Subject 1>. It begins with <Picture 1> as she speaks to the camera in the kitchen, cuts to match <Picture 2>, then cuts to match <Picture 3>.`,
    "",
    "retention_analysis:",
    "<Subject 1> (appears in [Shot 1], [Shot 2], [Shot 3]): fully_preserved - her face, hair, earrings, and clothing are the same as in <Picture 1> in every shot.",
    "<Picture 1> ([Shot 1] first frame): fully_preserved - the video starts exactly from its framing, pose, and kitchen.",
    "<Picture 2> ([Shot 2] keyframe): fully_preserved - the shot matches its composition, setting, and light.",
    "<Picture 3> ([Shot 3] keyframe): fully_preserved - the shot matches its composition, setting, and light.",
    "",
    "detailed_description:",
    "The target video is a candid live-action vertical phone video with natural light and true-to-life color.",
    `[Shot 1] The shot begins from <Picture 1>. <Subject 1> stands at the bright kitchen counter by the window holding ${BOTTLE} near her chest. The camera holds a static shot at chest height. She looks into the lens with an easy smile and <Subject 1> (S1), in a warm, unhurried, clear mid-range voice, says: <d>[English] ${line}</d> She closes her lips into a relaxed smile.`,
    `[Shot 2] At ${cutTime(second)}, the shot cuts to the keyframe that corresponds to <Picture 2>, ${notes[0]}. The camera pushes in with small amplitude at slow speed while she shifts her weight and keeps the bottle steady. Her identity, hair, earrings, and clothing stay exactly as in [Shot 1].`,
    `[Shot 3] At ${cutTime(third)}, the shot cuts to the keyframe that corresponds to <Picture 3>, ${notes[1]}. The camera holds a static shot as she gives a small nod toward the bottle. Her identity, hair, earrings, and clothing stay exactly as in [Shot 1].`,
    "",
    "overall_soundscape:",
    "Quiet kitchen room tone in the first shot, then the soft hush of a quiet office with a faint air-conditioning hum after the cuts.",
    "",
    "non_diegetic_music:",
    "N/A",
  ].join("\n");
}
