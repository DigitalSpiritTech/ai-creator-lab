/**
 * The project as the creative director sees it each turn: a compact snapshot read from the store,
 * the next step in the 13-step UGC Creator flow, and guidance for that step (including the exact
 * face and body prompts, so the model never writes its own identity prompt).
 * @packageDocumentation
 */
import type { ContentPiece } from "@creator-lab/core/domain/content";
import type { GenerationTarget } from "@creator-lab/core/domain/job";
import type { CharacterItem, CharacterLink, ProductItem, SetItem } from "@creator-lab/core/domain/library";
import type { ProjectPreferences } from "@creator-lab/core/domain/preferences";
import type { Project } from "@creator-lab/core/domain/project";
import { QUICK_AD, quickAdProgress } from "@creator-lab/core/domain/quick-ad";
import type { Script } from "@creator-lab/core/domain/script";
import { UGC_AD_STEPS, type UgcAdStepId } from "@creator-lab/content-ugc-ad";
import type { Store } from "@/server/store";
import { checklistText } from "@/server/agent/prompts/checklists";
import { BACKDROP_NAMES, BODY_REFERENCE, FACE_LOCK, backdropFor } from "@creator-lab/recipes/prompts";

export interface ProjectSnapshot {
  project: Project;
  character?: { item: CharacterItem; link: CharacterLink };
  product?: ProductItem;
  sets: SetItem[];
  /** The newest script, at its newest version. */
  script?: Script;
  /** The newest Ad. */
  content?: ContentPiece;
  /** Finished exports of the newest Ad. */
  completedExports: number;
  /** Which locked references are uploaded photos rather than generated images. */
  uploads: { face: boolean; body: boolean; sheet: boolean };
  /** Active candidates still waiting for a decision. */
  candidates: { face: string[]; body: string[]; sheet: string[] };
  /** Unfinished jobs and where their outputs land. */
  runningJobs: { id: string; target: GenerationTarget }[];
  /** Library items not linked to this project (archived ones left out). */
  libraryCharacters: CharacterItem[];
  libraryProducts: ProductItem[];
  /** This project's recipe preferences by capability. */
  preferences: ProjectPreferences;
}

/** Reads the snapshot. Returns undefined when the project does not exist. */
export function loadSnapshot(store: Store, projectId: string): ProjectSnapshot | undefined {
  const project = store.projects.get(projectId);
  if (!project) return undefined;
  let character: ProjectSnapshot["character"];
  let product: ProductItem | undefined;
  const sets: SetItem[] = [];
  const linked = new Set<string>();
  for (const link of store.library.listLinks(projectId)) {
    const item = store.library.get(link.itemId);
    if (!item || item.archived) continue;
    linked.add(item.id);
    if (!character && item.kind === "character" && link.kind === "character") character = { item, link };
    if (!product && item.kind === "product") product = item;
    if (item.kind === "set") sets.push(item);
  }
  const scripts = store.scripts.listByProject(projectId);
  const script = scripts.sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const contents = store.content.listByProject(projectId);
  const content = contents.sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const jobs = store.jobs.listByProject(projectId);
  const targetOf = new Map(jobs.map((job) => [job.id, job.request.target]));
  const candidates: ProjectSnapshot["candidates"] = { face: [], body: [], sheet: [] };
  if (character) {
    const { references } = character.item.bible;
    for (const asset of store.assets.list({ projectId, state: "active", limit: 500 })) {
      if (asset.provenance.source !== "generated") continue;
      const target = targetOf.get(asset.provenance.jobId);
      if (!target || !("characterId" in target) || target.characterId !== character.item.id) continue;
      if (target.kind === "character_reference" && target.slot === "face" && !references.faceAssetId) candidates.face.push(asset.id);
      if (target.kind === "character_reference" && target.slot === "body" && references.faceAssetId && !references.bodyAssetId) {
        candidates.body.push(asset.id);
      }
      if (target.kind === "reference_sheet" && !character.link.sheetAssetId) candidates.sheet.push(asset.id);
    }
  }
  const library = store.library.list({ includeArchived: false }).filter((item) => !linked.has(item.id));
  const uploaded = (assetId: string | null | undefined) => !!assetId && store.assets.get(assetId)?.provenance.source === "upload";
  return {
    project,
    character,
    product,
    sets,
    script,
    content,
    uploads: {
      face: uploaded(character?.item.bible.references.faceAssetId),
      body: uploaded(character?.item.bible.references.bodyAssetId),
      sheet: uploaded(character?.link.sheetAssetId),
    },
    completedExports: content ? store.content.listExports(content.id).filter((record) => record.status === "completed").length : 0,
    candidates,
    runningJobs: jobs.filter((job) => job.status !== "completed" && job.status !== "failed").map((job) => ({ id: job.id, target: job.request.target })),
    libraryCharacters: library.filter((item): item is CharacterItem => item.kind === "character"),
    libraryProducts: library.filter((item): item is ProductItem => item.kind === "product"),
    preferences: store.preferences.get(projectId),
  };
}

/** The UGC Ad plugin's steps (`@creator-lab/content-ugc-ad`); a test checks the numbers and titles match. */
export type StageId = UgcAdStepId;

export interface Stage {
  id: StageId;
  /** The step number in the UGC Creator flow of docs/PRODUCT.md. */
  step: number;
  title: string;
  guidance: string;
}

const STEPS = new Map<StageId, (typeof UGC_AD_STEPS)[number]>(UGC_AD_STEPS.map((step) => [step.id, step]));

/** A stage's id, flow step number, and title, as the UGC Ad plugin declares them. */
export function stepOf(id: StageId): Pick<Stage, "id" | "step" | "title"> {
  const step = STEPS.get(id);
  if (!step) throw new Error(`The UGC Ad plugin has no step ${id}.`);
  return { id, step: step.number, title: step.title };
}

function running(snapshot: ProjectSnapshot, matches: (target: GenerationTarget) => boolean): number {
  return snapshot.runningJobs.filter((job) => matches(job.target)).length;
}

function waiting(what: string, ids: string[], checklist: Parameters<typeof checklistText>[0], then: string): string {
  return [
    `${ids.length} ${what} candidate${ids.length === 1 ? " is" : "s are"} waiting for the user in the workspace: ${ids.join(", ")}.`,
    `Tell the user what to look for, briefly:\n${checklistText(checklist)}`,
    then,
  ].join("\n");
}

function bibleFields(item: CharacterItem): Record<string, unknown> {
  const { references, version, ...fields } = item.bible;
  void references;
  void version;
  return fields;
}

/** The first unfinished step of the flow, with what to do there. */
const UPLOAD_FACE =
  "If this character is a real person the user has photos of, do not generate a face: ask them to upload a clear face photo to the face slot on the Assets tab (the chat is text only) and continue once it is locked.";

/**
 * The Quick Ad's next step (an Ad in quick mode): the frame, the clip, then the export, each an
 * approval the person gives. Character, sheet, product, and voice-over steps are skipped.
 */
function quickStage(snapshot: ProjectSnapshot, content: ContentPiece): Stage {
  const { script, project } = snapshot;
  if (script && content.scriptId === script.id && content.scriptVersion !== script.version) {
    return { ...stepOf("shots"), guidance: `The Quick Ad's script is at version ${script.version} but the Ad uses ${content.scriptVersion}: call plan_shots with projectId ${project.id}, scriptId ${script.id}, and contentId ${content.id}.` };
  }
  const progress = quickAdProgress(content, snapshot.completedExports);
  const given = `${progress.approved.length} of ${QUICK_AD.approvals.length} approvals given`;
  if (progress.next === "frame") {
    const shot = content.shots.find((entry) => entry.still.state !== "approved")!;
    const title = `Quick Ad frame (${given})`;
    if (shot.still.state === "open") {
      return {
        ...stepOf("stills"),
        title,
        guidance: waiting(`beat ${shot.beatIndex} frame`, shot.still.candidateIds, "still", `When the user approves it (the Quick Ad tab's Approve, or a yes here), call approve with kind still, contentId ${content.id}, beatIndex ${shot.beatIndex}. Not right: compose_still again (count 1), or refine_still.`),
      };
    }
    if (running(snapshot, (target) => target.kind === "shot" && target.slot === "still" && target.contentId === content.id)) {
      return { ...stepOf("stills"), title, guidance: "The frame is generating. Say it will appear in the Quick Ad tab." };
    }
    return { ...stepOf("stills"), title, guidance: `Propose the frame: compose_still with contentId ${content.id}, beatIndex ${shot.beatIndex}, and count ${QUICK_AD.frameCount}. Say what it composes from (the linked character and product, or the brief in words) and its cost.` };
  }
  if (progress.next === "clip") {
    const shot = content.shots.find((entry) => entry.clip.state !== "approved")!;
    const title = `Quick Ad talking clip (${given})`;
    if (shot.clip.state === "open") {
      return {
        ...stepOf("clips"),
        title,
        guidance: waiting(`beat ${shot.beatIndex} clip`, shot.clip.candidateIds, "clip", `When the user approves it, call approve with kind clip, contentId ${content.id}, beatIndex ${shot.beatIndex}.`),
      };
    }
    if (running(snapshot, (target) => target.kind === "shot" && target.slot === "clip" && target.contentId === content.id)) {
      return { ...stepOf("clips"), title, guidance: "The talking clip is generating. Say it will appear in the Quick Ad tab." };
    }
    return { ...stepOf("clips"), title, guidance: `Propose the talking clip from the approved frame: generate_clip with contentId ${content.id} and beatIndex ${shot.beatIndex} (one ${QUICK_AD.durationSeconds} s clip with the line spoken).` };
  }
  if (progress.next === "export") {
    return { ...stepOf("assemble"), title: `Quick Ad export (${given})`, guidance: `The frame and the clip are approved. The last approval is the export: when the user says go (or clicks Export in the Quick Ad tab), call assemble_ad with contentId ${content.id} (captions on).` };
  }
  return { ...stepOf("next"), guidance: "The Quick Ad is exported. Offer another Quick Ad (start_quick_ad), or the full flow with a locked character for a longer ad." };
}

export function nextStage(snapshot: ProjectSnapshot): Stage {
  const { project, character, product, script, content, candidates } = snapshot;
  if (content?.mode === "quick") return quickStage(snapshot, content);
  if (!project.brief) {
    return {
      ...stepOf("brief"),
      guidance:
        "Find out what they are selling, who buys it, where the ad will run, and the tone. Take what they already said, ask for the rest one question at a time with a default, then call save_brief. If they want a Quick Ad (two lines, one frame, one talking clip), call start_quick_ad with projectId and the two lines instead.",
    };
  }
  if (!character) {
    const library = snapshot.libraryCharacters.slice(0, 3);
    const reuse = library.length
      ? [
          `The Library already has ${library.map((item) => `${item.bible.name} (characterId ${item.id}, face ${item.bible.references.faceAssetId ? "locked" : "not locked"}, body ${item.bible.references.bodyAssetId ? "locked" : "not locked"})`).join("; ")}.`,
          "Offer to reuse one (default: the first) or build someone new. To reuse, call save_character_bible with characterId, this projectId, and the bible below copied exactly. Change nothing about identity unless the user asks.",
          ...library.map((item) => `Bible of ${item.bible.name}: ${JSON.stringify(bibleFields(item))}`),
        ].join("\n")
      : "";
    return {
      ...stepOf("character"),
      guidance: [
        reuse,
        "To build a new character, ask at most eight short questions with defaults (who would the buyer trust, age range, look, hair, style of dress, how they talk, one memorable detail, anything they must never do). Show the draft bible as a short list, then save_character_bible with projectId. The visualCore is one sentence under 60 words; boundaries always include no health-outcome claims and no competitor names unless the user says otherwise.",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
  const { item, link } = character;
  const { faceAssetId, bodyAssetId } = item.bible.references;
  if (!faceAssetId) {
    if (candidates.face.length) {
      return { ...stepOf("face"), guidance: waiting("face", candidates.face, "face", 'When the user picks one, call select_reference with slot "face" and confirm the name.') };
    }
    if (running(snapshot, (target) => target.kind === "character_reference" && target.slot === "face")) {
      return { ...stepOf("face"), guidance: "Face candidates are generating. Say they will appear in the workspace and what to look for." };
    }
    return {
      ...stepOf("face"),
      guidance: `${UPLOAD_FACE} Otherwise propose the face lock: generate_face_candidates with projectId ${project.id} and characterId ${item.id} (${FACE_LOCK.count} ${FACE_LOCK.aspectRatio} candidates; the tool writes the face prompt from the bible in the chosen model's style).`,
    };
  }
  if (!bodyAssetId) {
    if (candidates.body.length) {
      return { ...stepOf("body"), guidance: waiting("body", candidates.body, "body", 'When the user picks one, call select_reference with slot "body".') };
    }
    if (running(snapshot, (target) => target.kind === "character_reference" && target.slot === "body")) {
      return { ...stepOf("body"), guidance: "Body candidates are generating. Say they will appear in the workspace and what to look for." };
    }
    const fromPhoto = snapshot.uploads.face;
    return {
      ...stepOf("body"),
      guidance: `${fromPhoto ? "The face is an uploaded photo of a real person. Suggest uploading a full-body photo to the body slot on the Assets tab; or, if they prefer," : "Propose the body reference:"} generate_body_reference with projectId ${project.id} and characterId ${item.id} (${BODY_REFERENCE.count} ${BODY_REFERENCE.aspectRatio} candidates from the locked face ${faceAssetId}; the tool writes the athleticwear prompt).`,
    };
  }
  if (!link.sheetAssetId) {
    const photoNote = snapshot.uploads.face
      ? "\nThe face is a real person's uploaded photo: say the sheet can still be generated from the photos and recommend it, so every shot matches; or they can upload their own sheet on the Assets tab."
      : "";
    if (!link.wardrobe) {
      return {
        ...stepOf("sheet"),
        guidance: `Pick this project's outfit. Suggest the one from the bible's wardrobe defaults that suits the brief and has a clear tone difference from gray (${item.bible.wardrobeDefaults.map((outfit) => `"${outfit}" (${BACKDROP_NAMES[backdropFor(outfit)]} background)`).join(", ")}) as the default, or the user names one. Then call generate_reference_sheet with projectId, characterId ${item.id}, and that wardrobe, and say which background the sheet uses.${photoNote}`,
      };
    }
    if (candidates.sheet.length) {
      return {
        ...stepOf("sheet"),
        guidance: waiting("reference sheet", candidates.sheet, "sheet", "Ask them to inspect at full size. When they choose, call approve with kind sheet. Small flaws: refine_still on that sheet instead of regenerating."),
      };
    }
    if (running(snapshot, (target) => target.kind === "reference_sheet")) {
      return { ...stepOf("sheet"), guidance: "Reference sheets are generating. Say they will appear in the workspace and what to look for." };
    }
    return {
      ...stepOf("sheet"),
      guidance: `Propose the reference sheet in "${link.wardrobe}": generate_reference_sheet with projectId ${project.id} and characterId ${item.id}.${photoNote}`,
    };
  }
  if (!product) {
    const library = snapshot.libraryProducts.slice(0, 3);
    return {
      ...stepOf("product"),
      guidance: [
        library.length ? `The Library has ${library.map((entry) => `${entry.name} (productId ${entry.id})`).join("; ")}; offer to reuse it with save_product (productId, projectId, its fields unchanged).` : "",
        "Ask for the product name, the link, and the exact claims they are allowed to make, then save_product with projectId. Product photos are uploaded in the workspace.",
        `No photo? Ask what it looks like (color, material, shape, cap or lid), save it as the card's appearance with save_product, then call generate_product_images with projectId and productId (count 2). The user approves one on the product card in the workspace, which adds it to the card's images.`,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
  if (!script) {
    return {
      ...stepOf("script"),
      guidance: "Draft the script (see Writing scripts), show it as a short beat list, and save it with save_script once the user agrees or asks you to go ahead.",
    };
  }
  if (!content || content.scriptId !== script.id) {
    return { ...stepOf("shots"), guidance: `Create the Ad from the script: plan_shots with projectId ${project.id} and scriptId ${script.id}.` };
  }
  if (content.scriptVersion !== script.version) {
    return { ...stepOf("shots"), guidance: `The script is at version ${script.version} but the Ad uses ${content.scriptVersion}: call plan_shots with contentId ${content.id} to bring it up to date.` };
  }
  const stillBeat = content.shots.find((shot) => shot.still.state !== "approved");
  if (stillBeat) {
    const slot = stillBeat.still;
    if (slot.state === "open") {
      return {
        ...stepOf("stills"),
        guidance: waiting(`beat ${stillBeat.beatIndex} still`, slot.candidateIds, "still", `When the user chooses, call approve with kind still, contentId ${content.id}, beatIndex ${stillBeat.beatIndex}. Close but not right: refine_still.`),
      };
    }
    return { ...stepOf("stills"), guidance: `Propose the start frame for beat ${stillBeat.beatIndex}: compose_still with contentId ${content.id} and beatIndex ${stillBeat.beatIndex}.` };
  }
  const clipBeat = content.shots.find((shot) => shot.clip.state !== "approved");
  if (clipBeat) {
    const slot = clipBeat.clip;
    if (slot.state === "open") {
      return {
        ...stepOf("clips"),
        guidance: waiting(`beat ${clipBeat.beatIndex} clip`, slot.candidateIds, "clip", `When the user chooses, call approve with kind clip, contentId ${content.id}, beatIndex ${clipBeat.beatIndex}.`),
      };
    }
    return { ...stepOf("clips"), guidance: `Propose the clip for beat ${clipBeat.beatIndex}: generate_clip with contentId ${content.id} and beatIndex ${clipBeat.beatIndex}.` };
  }
  const voiceBeat = content.shots.find((shot) => {
    const beat = script.beats[shot.beatIndex - 1];
    return beat && beat.type !== "talking" && beat.spokenLine.trim().length > 0 && shot.voice.state !== "approved";
  });
  if (voiceBeat) {
    const slot = voiceBeat.voice;
    if (slot.state === "open") {
      return {
        ...stepOf("voice"),
        guidance: waiting(`beat ${voiceBeat.beatIndex} voice-over`, slot.candidateIds, "voice", `When the user chooses, call approve with kind voice, contentId ${content.id}, beatIndex ${voiceBeat.beatIndex}. Say the take plays on the Shots tab.`),
      };
    }
    if (running(snapshot, (target) => target.kind === "shot" && target.slot === "voice" && target.beatIndex === voiceBeat.beatIndex)) {
      return { ...stepOf("voice"), guidance: `Beat ${voiceBeat.beatIndex}'s voice-over is generating. Say it will appear on the Shots tab.` };
    }
    const sample = item.bible.references.voiceAssetId ? "the character's voice sample" : "the first approved talking clip's voice";
    return {
      ...stepOf("voice"),
      guidance: `Beat ${voiceBeat.beatIndex} is ${script.beats[voiceBeat.beatIndex - 1]?.type === "broll" ? "b-roll" : "a text card"} with a line and no approved voice-over. Propose it: generate_voice_over with projectId ${project.id} and beatIndex ${voiceBeat.beatIndex} (cloned from ${sample}). If the user would rather skip voice-overs, go on to assembling; those beats keep ambient sound only.`,
    };
  }
  if (snapshot.completedExports === 0) {
    return { ...stepOf("assemble"), guidance: `Every beat has an approved clip${content.shots.some((shot) => shot.voice.state === "approved") ? " and the voice-overs are approved" : ""}. Offer to assemble: assemble_ad with contentId ${content.id} (captions on by default).` };
  }
  return { ...stepOf("next"), guidance: "Offer another ad in this project, or a new project with the same character." };
}

function short(value: string, max = 120): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The snapshot as compact text for the system prompt, ids included so tools can be called. */
export function renderSnapshot(snapshot: ProjectSnapshot): string {
  const { project, character, product, script, content } = snapshot;
  const lines = [`Project "${project.name}" (projectId ${project.id}).`];
  lines.push(
    project.brief
      ? `Brief: selling ${short(project.brief.productSummary)}; audience ${short(project.brief.audience)}; platforms ${project.brief.platforms.join(", ")}; tone ${short(project.brief.tone)}.`
      : "Brief: not saved yet.",
  );
  if (character) {
    const { item, link } = character;
    const { faceAssetId, bodyAssetId } = item.bible.references;
    const locked = (id: string, photo: boolean) => `locked ${photo ? "from an uploaded photo" : "(generated)"} (${id})`;
    const { uploads } = snapshot;
    lines.push(
      `Character: ${item.bible.name} (characterId ${item.id}, revision ${item.revision}, bible v${item.bible.version}). Face ${faceAssetId ? locked(faceAssetId, uploads.face) : "not locked"}. Body ${bodyAssetId ? locked(bodyAssetId, uploads.body) : "not locked"}. Wardrobe for this project: ${link.wardrobe ?? "not chosen"}. Reference sheet: ${link.sheetAssetId ? `approved${uploads.sheet ? ", uploaded by the user" : ""} (${link.sheetAssetId})` : "not approved"}.`,
      `visualCore: ${item.bible.visualCore}`,
      `Voice: ${short(item.bible.voice.style)}. Boundaries: ${item.bible.boundaries.join("; ") || "none listed"}.`,
    );
  } else {
    lines.push("Character: none linked to this project yet.");
  }
  if (product) {
    lines.push(
      `Product: ${product.name} (productId ${product.id}, revision ${product.revision}). Allowed claims: ${product.allowedClaims.length ? product.allowedClaims.map((claim) => `"${claim}"`).join(", ") : "none saved"}. Photos: ${product.imageAssetIds.length}. Link: ${product.link ?? "none"}.`,
    );
  } else {
    lines.push("Product: none linked to this project yet.");
  }
  if (snapshot.sets.length) {
    lines.push(`Sets: ${snapshot.sets.map((set) => `${set.name} (setId ${set.id}, ${set.imageAssetIds.length} photo${set.imageAssetIds.length === 1 ? "" : "s"})`).join("; ")}. A beat whose setting names a set uses its photo.`);
  }
  if (script) {
    lines.push(`Script: "${script.title}" (scriptId ${script.id}, version ${script.version}), ${script.beats.length} beats:`);
    for (const beat of script.beats) {
      const spoken = beat.spokenLine ? ` ${beat.type === "talking" ? "says" : "voice-over"} "${beat.spokenLine}"` : " (silent)";
      const onScreen = beat.onScreenText ? ` | on screen "${beat.onScreenText}"` : "";
      lines.push(`  ${beat.index}. ${beat.type}/${beat.purpose}${spoken}${onScreen} | ${short(beat.visual, 100)}`);
    }
  } else {
    lines.push("Script: none yet.");
  }
  if (content) {
    const shots = content.shots.map((shot) => {
      const describe = (slot: typeof shot.still) => (slot.state === "approved" ? "approved" : slot.state === "open" ? `${slot.candidateIds.length} candidates` : "empty");
      const beat = script?.beats[shot.beatIndex - 1];
      const voice = beat && beat.type !== "talking" && beat.spokenLine ? `, voice-over ${describe(shot.voice)}` : "";
      return `beat ${shot.beatIndex} still ${describe(shot.still)}, clip ${describe(shot.clip)}${voice}`;
    });
    lines.push(`${content.mode === "quick" ? "Quick Ad" : "Ad"}: "${content.title}" (contentId ${content.id}, script v${content.scriptVersion}): ${shots.join("; ")}.`);
  }
  const preferred = Object.entries(snapshot.preferences.recipes);
  if (preferred.length) {
    lines.push(`Recipe preferences for this project: ${preferred.map(([capability, recipeId]) => `${capability} uses ${recipeId}`).join("; ")}. Proposals of those capabilities use them unless a recipeId is passed.`);
  }
  if (snapshot.runningJobs.length) lines.push(`Generating now: ${snapshot.runningJobs.length} job(s).`);
  return lines.join("\n");
}
