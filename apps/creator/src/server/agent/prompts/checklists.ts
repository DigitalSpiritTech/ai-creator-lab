/**
 * What the user should look for when candidates arrive, per step. The creative director quotes
 * these; the UI can render the same lists on candidate cards.
 * @packageDocumentation
 */

export const CHECKLISTS = {
  face: [
    "Matches the bible: age, face shape, hair, eyes, distinguishing details",
    "Head turned off-center (one cheek narrower, the near ear showing), not dead-on",
    "Eyes sharp with a catchlight; skin looks real, not plastic",
    "No extra accessories, text, or busy background",
  ],
  body: [
    "Same face and hair as the locked face",
    "Whole body in frame, head to toe, relaxed standing pose",
    "Plain fitted athleticwear and a plain light background",
    "Hands and feet look natural",
  ],
  sheet: [
    "The portrait is the largest panel (a quarter to a third of the sheet) and not dead-on frontal",
    "Irises show their color and both eyes have a catchlight",
    "The face in the full-body panels matches the portrait (one identity, not two)",
    "Clean, even background that the outfit stands out against; no colored rim light, no plastic or game-render skin, face not mirror-symmetric",
    "The same chosen outfit in every panel",
    "No text, labels, logos, or watermarks",
  ],
  still: [
    "Same person as the reference sheet: face, hair, and outfit",
    "The product is recognizable: shape, color, and label",
    "The setting and action match the beat",
    "Hands and fingers look right; no text in the image",
  ],
  clip: [
    "Lips roughly follow the spoken line on talking beats",
    "No ghosting, doubled limbs, or melting objects mid-clip",
    "Face and clothing stay the same as the still",
    "B-roll has ambient sound only, no stray speech",
  ],
  voice: [
    "Sounds like the same person as the talking clips (or the uploaded recording)",
    "Every word of the line is there, in order, with no extra words or repeats",
    "Fits the beat: it ends before the clip does, at a natural pace",
    "No hiss, clicks, or robotic buzz; a quiet room, not an echo",
  ],
} as const satisfies Record<string, readonly string[]>;

export type ChecklistKind = keyof typeof CHECKLISTS;

export function checklistText(kind: ChecklistKind): string {
  return CHECKLISTS[kind].map((item) => `- ${item}`).join("\n");
}
