/**
 * Prompt templates for every generation step, following the character-bible, ugc-script, and
 * ltx-prompting skills. Pure functions of the bible, product, set, beat, and wardrobe; each result
 * stays under {@link PROMPT_LIMIT} characters for the Z-Image, Qwen Image Edit, Nano Banana, and
 * LTX recipes.
 *
 * Image and video prompts describe the product by appearance only. Its name stays in the brief and
 * script: a model that reads a brand name prints it on the product.
 * @packageDocumentation
 */
import type { CharacterBible } from "@/lib/domain/library";
import type { Beat } from "@/lib/domain/script";

/** The longest prompt any template may produce. */
export const PROMPT_LIMIT = 2000;

export const NO_TEXT = "No text, captions, logos, or watermarks in the image.";

/** How a face lock is proposed: four text-to-image candidates, square. */
export const FACE_LOCK = { capability: "text_to_image", aspectRatio: "1:1", count: 4 } as const;

/** How a body reference is proposed: an edit of the locked face, vertical. */
export const BODY_REFERENCE = { capability: "image_edit", aspectRatio: "9:16", count: 2 } as const;

/** Ends a fragment with exactly one period. */
function sentence(value: string): string {
  const trimmed = value.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Drops a trailing period so the fragment can continue with a clause. */
function clause(value: string): string {
  return value.trim().replace(/[.!]+$/, "");
}

/** A fragment placed mid-sentence: no trailing period, lowercase first letter. */
function inline(value: string): string {
  const text = clause(value);
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** Ends every product sentence, so image and video models do not print a name or logo on it. */
export const NO_PRODUCT_TEXT = "no text, lettering, or logo on the product";

/** A product as prompts see it: the card's name (never printed) and, when known, how it looks. */
export interface ProductLook {
  name: string;
  /** What it looks like in plain words, for example "a matte dark green steel bottle with a black cap". */
  appearance?: string;
}

const NOT_BRAND = new Set(["a", "an", "the", "and", "of", "by", "for"]);

/** The leading capitalized words of a product name: "Ridgeline" in "Ridgeline 32 oz insulated bottle". */
function brandWords(name: string): string[] {
  const brand: string[] = [];
  for (const word of name.trim().split(/\s+/)) {
    if (!/^[A-Z]/.test(word)) break;
    brand.push(word);
  }
  return brand;
}

/** The generic part of a product name, without the brand: "32 oz insulated bottle". */
function genericNoun(name: string): string {
  const words = name.trim().split(/\s+/);
  return words.slice(brandWords(name).length).join(" ");
}

function withArticle(noun: string): string {
  if (/^(a|an|the)\s/i.test(noun) || noun.startsWith("<")) return noun;
  return `${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun}`;
}

/** The product by appearance only: the card's appearance, else its name without the brand, else "the product". */
export function productAppearance(product: ProductLook): string {
  if (product.appearance?.trim()) return withArticle(inline(product.appearance));
  const noun = genericNoun(product.name);
  return noun ? withArticle(noun) : "the product";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Removes the product's name from free text such as a beat visual: the full name becomes its
 * generic noun ("the Ridgeline 32 oz insulated bottle" reads "the 32 oz insulated bottle"), and brand
 * words are dropped ("the Ridgeline bottle" reads "the bottle"). A name with no generic part is only
 * removed as a whole phrase, so ordinary words are never stripped.
 */
export function withoutProductName(text: string, product: Pick<ProductLook, "name">): string {
  const name = product.name.trim();
  const noun = genericNoun(name) || "product";
  let result = text.replace(new RegExp(`\\b${escapeRegExp(name)}(?:'s)?\\b`, "gi"), noun);
  const brand = brandWords(name);
  if (genericNoun(name)) {
    const phrases = [brand.join(" "), ...brand].filter((phrase) => phrase.length >= 3 && !NOT_BRAND.has(phrase.toLowerCase()));
    for (const phrase of phrases) result = result.replace(new RegExp(`\\b${escapeRegExp(phrase)}(?:'s)?\\b\\s*`, "gi"), "");
  }
  return result.replace(/\s{2,}/g, " ").replace(/\s+([,.;:])/g, "$1").trim();
}

const STRAY_OBJECTS = [
  { word: "bottles", named: /\b(bottles?|tumblers?|flasks?|cans?|cups?|mugs?)\b/i },
  { word: "phones", named: /\b(smart)?phones?\b/i },
  { word: "props", named: /\bprops?\b/i },
] as const;

/**
 * Keeps image models from adding objects. A category the visual names is not forbidden, only capped
 * at what the visual describes, so the line never contradicts the beat.
 */
export function onlyDescribedObjects(visual: string): string {
  const named = STRAY_OBJECTS.filter((entry) => entry.named.test(visual)).map((entry) => entry.word);
  const others = STRAY_OBJECTS.map((entry) => entry.word).filter((word) => !named.includes(word));
  const list = (words: string[]) => (words.length < 3 ? words.join(" or ") : `${words.slice(0, -1).join(", ")}, or ${words.at(-1)}`);
  const parts = [others.length ? `no additional ${list(others)}` : "", named.length ? `no ${list(named)} beyond those described` : ""].filter(Boolean);
  return `Only the objects described; ${parts.join(", and ")}.`;
}

/**
 * A text-to-image product photo from the user's description of how it looks (never its name), for
 * a product card that has no photo yet.
 */
export function productPhotoPrompt(product: ProductLook, setting = "a light wooden kitchen counter by a window"): string {
  return [
    `Product photograph of ${productAppearance(product)}, standing upright on ${inline(setting)}, soft morning light, plain uncluttered background, true to its shape, color, and materials, ${NO_PRODUCT_TEXT}.`,
    "Only the product; no additional bottles, phones, or props.",
    NO_TEXT,
  ].join(" ");
}

/** Background tones for identity references; never white or black. */
export type Backdrop = "gray" | "light";

export const BACKDROPS: Record<Backdrop, string> = {
  gray: "a deep neutral gray (#3a3a3c) seamless background",
  light: "a light warm neutral seamless background (light greige, roughly #d8d2c8)",
};

/** Short names for telling the user which background a proposal uses. */
export const BACKDROP_NAMES: Record<Backdrop, string> = { gray: "deep neutral gray", light: "light warm neutral" };

/** Athleticwear colors that contrast with each background. */
export const ATHLETICWEAR: Record<Backdrop, string> = { gray: "navy", light: "charcoal" };

export const CONTRAST = "The outfit must contrast clearly with the background so the silhouette reads.";

/** Added whenever the person's face reference is an uploaded photo of a real person. */
export const PHOTO_MATCH = "Match the real person's features exactly as photographed.";

/** Whether the identity comes from a real person's uploaded photo rather than a generated face. */
export interface IdentitySource {
  photographed?: boolean;
}

const DARK_GARMENT = /\b(gr[ae]y|charcoal|black|dark)\b/i;

/**
 * The background for a garment: gray, charcoal, black, or dark clothing goes on the light warm
 * background (a gray tee on gray loses the silhouette); everything else on deep neutral gray.
 */
export function backdropFor(garment: string): Backdrop {
  return DARK_GARMENT.test(garment) ? "light" : "gray";
}

/** Which background a reference prompt asked for, for proposal copy; undefined for other prompts. */
export function backdropOf(prompt: string): Backdrop | undefined {
  if (prompt.includes("#d8d2c8")) return "light";
  if (prompt.includes("#3a3a3c")) return "gray";
  return undefined;
}

/** The top the face lock shows at the shoulders; navy reads against the deep gray background. */
export const FACE_GARMENT = "a plain fitted navy crew-neck top";

/**
 * The face lock prompt. Z-Image ignores "three-quarter view" on its own, so the turn is spelled
 * out as a thirty-degree head turn with what it does to the cheek and ear. The background follows
 * the garment at the shoulders.
 */
export function facePrompt(bible: Pick<CharacterBible, "visualCore">, garment: string = FACE_GARMENT): string {
  return [
    sentence(bible.visualCore),
    `Portrait, head and shoulders, wearing ${inline(garment)}, head turned about thirty degrees to the left so the far cheek narrows and the near ear shows, eyes toward the camera, neutral expression with a hint of a smile, soft natural window light, ${BACKDROPS[backdropFor(garment)]}, no accessories beyond those described, photographic, 85mm look.`,
    CONTRAST,
    NO_TEXT,
  ].join(" ");
}

/**
 * The body reference prompt, an edit of the locked face (the only reference image). Navy
 * athleticwear on deep gray by default, or charcoal on the light background.
 */
export function bodyPrompt(bible: Pick<CharacterBible, "build">, backdrop: Backdrop = "gray", source: IdentitySource = {}): string {
  return [
    "Same person as the reference image, identical face and hair.",
    source.photographed ? PHOTO_MATCH : "",
    `Build: ${sentence(bible.build)}`,
    `Three-quarter view full-body standing pose, body turned about thirty degrees from the camera, relaxed, arms at sides, fitted ${ATHLETICWEAR[backdrop]} athleticwear (plain fitted tee and leggings or shorts), simple trainers, head to toe inside the frame, ${BACKDROPS[backdrop]}, even soft light, photographic.`,
    CONTRAST,
    NO_TEXT,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * The reference sheet prompt from the character-bible skill, with the background chosen from the
 * wardrobe so the outfit contrasts with it.
 */
export function referenceSheetPrompt(bible: Pick<CharacterBible, "visualCore">, wardrobe: string, source: IdentitySource = {}): string {
  return [
    `Character reference sheet of one consistent person, on ${BACKDROPS[backdropFor(wardrobe)].replace("seamless background", "seamless studio background")}, clean editorial layout in three vertical columns read left to right, identical identity, lighting, and color grading in every panel.`,
    "Column 1, largest, about a third of the width: chest-up portrait turned slightly off frontal, sharp focus on the eyes, iris color clearly visible, soft catchlights in both eyes, natural skin texture with subtle imperfections, no mirror symmetry.",
    "Column 2: full-body front view, relaxed standing pose, arms slightly away from the body, head to toe inside the frame with even margins.",
    "Column 3: full-body back view, same pose mirrored, showing hair fall, posture, and garment fit.",
    `The person is the person in reference image 1 (face, hair, skin, eyes) with the build of reference image 2. ${sentence(bible.visualCore)} Wardrobe in every panel: ${clause(wardrobe)}. ${CONTRAST}${source.photographed ? ` ${PHOTO_MATCH}` : ""}`,
    "Soft even studio light, large diffused key with gentle fill, neutral white balance, true-to-life skin, 85mm look, tack-sharp detail. No text, no labels, no logos, no colored rim light, no 3D render look.",
  ].join("\n");
}

export interface StillPromptParts {
  beat: Beat;
  bible?: Pick<CharacterBible, "visualCore">;
  wardrobe?: string | null;
  /**
   * How the character is referenced: one sheet, or a face plus an optional body image.
   * `photographed` marks a real person whose face reference is an uploaded photo.
   */
  character?: ({ mode: "sheet"; image: number } | { mode: "face"; face: number; body?: number }) & IdentitySource;
  product?: ProductLook & { image?: number };
  /** A Library set, referenced by image number when it has one; `photo` marks a real place's photo. */
  set?: { name: string; image?: number; photo?: boolean };
}

const STILL_FRAMING: Record<Beat["type"], string> = {
  talking: "Mid-sentence, talking to a phone camera held at arm's length, relaxed natural expression, mouth slightly open as if speaking.",
  broll: "Close detail shot.",
  textcard: "Simple uncluttered composition with calm empty space in the upper third for a caption added later.",
};

/**
 * A start-frame prompt for one beat. Reference images are numbered as the tool attaches them: the
 * approved sheet as image 1 (or the face, then the body), then the product, then the set.
 */
export function stillPrompt(parts: StillPromptParts): string {
  const { beat, bible, character, product, set } = parts;
  const wearing = parts.wardrobe ? `, wearing ${inline(parts.wardrobe)}` : "";
  const lines: string[] = [];
  if (bible && character) {
    lines.push(sentence(bible.visualCore));
    if (character.mode === "sheet") {
      lines.push(`The person shown in the character reference sheet, reference image ${character.image}${wearing}.`);
    } else {
      const body = character.body ? ` with the build of reference image ${character.body}` : "";
      lines.push(`The person in reference image ${character.face}${body}${wearing}.`);
    }
  }
  const visual = product ? withoutProductName(beat.visual, product) : beat.visual;
  lines.push(STILL_FRAMING[beat.type], sentence(visual));
  if (set?.image && set.photo) lines.push(`Setting: the place in reference image ${set.image} (${inline(set.name)}), matching its layout, furniture, and lighting.`);
  else if (set?.image) lines.push(`Setting: the location in reference image ${set.image}, ${inline(set.name)}.`);
  else if (set) lines.push(`Setting: ${clause(set.name)}.`);
  else if (beat.setting) lines.push(`Setting: ${clause(beat.setting)}.`);
  if (product && beat.productVisible) {
    const subject = product.image ? `The product in reference image ${product.image}` : "The product";
    lines.push(`${subject} is ${productAppearance(product)}, clearly visible, true to its shape, color, and materials, ${NO_PRODUCT_TEXT}.`);
  } else if (product?.image) {
    lines.push(`The product in reference image ${product.image} stays out of this shot.`);
  }
  lines.push(onlyDescribedObjects(visual));
  if (!character && beat.type !== "talking") lines.push("No faces in frame.");
  lines.push("Vertical 9:16 phone photo, natural light, candid UGC look. The photo itself, full frame, not a screenshot: no camera app interface, buttons, icons, or phone frame.", NO_TEXT);
  if (bible && character) {
    lines.push(
      character.mode === "sheet"
        ? "Preserve the person's identity, face, hair, build, and wardrobe exactly as in the sheet."
        : `Preserve the person's identity, face, and hair exactly as in reference image ${character.face}.`,
    );
    if (character.photographed) lines.push(PHOTO_MATCH);
  }
  return lines.join(" ");
}

export interface ClipPromptParts {
  /** Repeating the still's wardrobe words keeps LTX from drifting the clothing. */
  wardrobe?: string | null;
  /** The project's product: its name is removed from the visual, and visible products are described by look. */
  product?: ProductLook;
}

/**
 * An LTX image-to-video prompt for one beat: subject and one action, camera, sound, the spoken line
 * in quotes for talking beats, and the closing constraints. B-roll and text cards get ambient sound
 * only, so LTX does not invent speech.
 */
export function clipPrompt(beat: Beat, parts: ClipPromptParts = {}): string {
  const ambient = beat.setting ? clause(beat.setting) : "the room";
  const { product } = parts;
  const visual = product ? withoutProductName(beat.visual, product) : beat.visual;
  const productLine = product && beat.productVisible ? `The product is ${productAppearance(product)}, ${NO_PRODUCT_TEXT}.` : "";
  if (beat.type === "talking") {
    const line = /[.!?]$/.test(beat.spokenLine.trim()) ? beat.spokenLine.trim() : `${beat.spokenLine.trim()}.`;
    return [
      `${clause(visual)}, speaking to the camera with an easy smile, small natural head movement, static phone camera.`,
      parts.wardrobe ? `Wearing ${clause(parts.wardrobe)}.` : "",
      productLine,
      `Quiet ambient sound of ${ambient}.`,
      `The person says, "${line}"`,
      "No text on screen. The person's face and clothing stay consistent.",
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (beat.type === "broll") {
    return [
      `${clause(visual)}, one simple motion, slow push-in.`,
      productLine,
      `Ambient sound of ${ambient}, no speech, ambient sound only.`,
      "No faces in frame. No text on screen.",
    ]
      .filter(Boolean)
      .join(" ");
  }
  return [
    `${clause(visual)}, almost still with very subtle natural motion, static camera.`,
    productLine,
    `Soft ambient sound of ${ambient}, no speech, ambient sound only.`,
    "No text on screen.",
  ]
    .filter(Boolean)
    .join(" ");
}

/** A refinement edit that changes one thing and keeps the rest; sheets also keep their layout. */
export function refinePrompt(instruction: string, kind: "still" | "sheet" = "still"): string {
  const keep =
    kind === "sheet"
      ? "Keep the three-panel layout, the same person in every panel, the wardrobe, and the clean seamless background otherwise identical."
      : "Keep the person, product, composition, lighting, and background otherwise identical.";
  return `${clause(instruction)}. Change only that. ${keep} ${NO_TEXT}`;
}
