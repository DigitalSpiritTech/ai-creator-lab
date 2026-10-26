/**
 * The project as the creative director sees it each turn: a compact snapshot read from the store,
 * the next step in the 13-step UGC Creator flow, and guidance for that step (including the exact
 * face and body prompts, so the model never writes its own identity prompt).
 * @packageDocumentation
 */
import type { ContentPiece } from "@/lib/domain/content";
import type { GenerationTarget } from "@/lib/domain/job";
import type { CharacterItem, CharacterLink, ProductItem, SetItem } from "@/lib/domain/library";
import type { Project } from "@/lib/domain/project";
import type { Script } from "@/lib/domain/script";
import type { Store } from "@/server/store";
import { checklistText } from "@/server/agent/prompts/checklists";
import { BODY_REFERENCE, FACE_LOCK, bodyPrompt, facePrompt, productPhotoPrompt } from "@/server/tools/prompts";

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
  /** Active candidates still waiting for a decision. */
  candidates: { face: string[]; body: string[]; sheet: string[] };
  /** Unfinished jobs and where their outputs land. */
  runningJobs: { id: string; target: GenerationTarget }[];
  /** Library items not linked to this project (archived ones left out). */
  libraryCharacters: CharacterItem[];
  libraryProducts: ProductItem[];
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
  return {
    project,
    character,
    product,
    sets,
    script,
    content,
    completedExports: content ? store.content.listExports(content.id).filter((record) => record.status === "completed").length : 0,
    candidates,
    runningJobs: jobs.filter((job) => job.status !== "completed" && job.status !== "failed").map((job) => ({ id: job.id, target: job.request.target })),
    libraryCharacters: library.filter((item): item is CharacterItem => item.kind === "character"),
    libraryProducts: library.filter((item): item is ProductItem => item.kind === "product"),
  };
}

export type StageId = "brief" | "character" | "face" | "body" | "sheet" | "product" | "script" | "shots" | "stills" | "clips" | "assemble" | "next";

export interface Stage {
  id: StageId;
  /** The step number in the UGC Creator flow of docs/PRODUCT.md. */
  step: number;
  title: string;
  guidance: string;
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
export function nextStage(snapshot: ProjectSnapshot): Stage {
  const { project, character, product, script, content, candidates } = snapshot;
  if (!project.brief) {
    return {
      id: "brief",
      step: 3,
      title: "Brief",
      guidance:
        "Find out what they are selling, who buys it, where the ad will run, and the tone. Take what they already said, ask for the rest one question at a time with a default, then call save_brief.",
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
      id: "character",
      step: 4,
      title: "Character",
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
      return { id: "face", step: 5, title: "Face lock", guidance: waiting("face", candidates.face, "face", 'When the user picks one, call select_reference with slot "face" and confirm the name.') };
    }
    if (running(snapshot, (target) => target.kind === "character_reference" && target.slot === "face")) {
      return { id: "face", step: 5, title: "Face lock", guidance: "Face candidates are generating. Say they will appear in the workspace and what to look for." };
    }
    return {
      id: "face",
      step: 5,
      title: "Face lock",
      guidance: `Propose the face lock: propose_candidates with projectId ${project.id}, capability "${FACE_LOCK.capability}", count ${FACE_LOCK.count}, aspectRatio "${FACE_LOCK.aspectRatio}", target {"kind":"character_reference","characterId":"${item.id}","slot":"face"}, and exactly this prompt:\n${facePrompt(item.bible)}`,
    };
  }
  if (!bodyAssetId) {
    if (candidates.body.length) {
      return { id: "body", step: 6, title: "Body reference", guidance: waiting("body", candidates.body, "body", 'When the user picks one, call select_reference with slot "body".') };
    }
    if (running(snapshot, (target) => target.kind === "character_reference" && target.slot === "body")) {
      return { id: "body", step: 6, title: "Body reference", guidance: "Body candidates are generating. Say they will appear in the workspace and what to look for." };
    }
    return {
      id: "body",
      step: 6,
      title: "Body reference",
      guidance: `Propose the body reference: propose_candidates with projectId ${project.id}, capability "${BODY_REFERENCE.capability}", count ${BODY_REFERENCE.count}, aspectRatio "${BODY_REFERENCE.aspectRatio}", referenceAssetIds ["${faceAssetId}"], target {"kind":"character_reference","characterId":"${item.id}","slot":"body"}, and exactly this prompt:\n${bodyPrompt(item.bible)}`,
    };
  }
  if (!link.sheetAssetId) {
    if (!link.wardrobe) {
      return {
        id: "sheet",
        step: 7,
        title: "Reference sheet",
        guidance: `Pick this project's outfit. Suggest the one from the bible's wardrobe defaults that suits the brief (${item.bible.wardrobeDefaults.map((outfit) => `"${outfit}"`).join(", ")}) as the default, or the user names one. Then call generate_reference_sheet with projectId, characterId ${item.id}, and that wardrobe.`,
      };
    }
    if (candidates.sheet.length) {
      return {
        id: "sheet",
        step: 7,
        title: "Reference sheet",
        guidance: waiting("reference sheet", candidates.sheet, "sheet", "Ask them to inspect at full size. When they choose, call approve with kind sheet. Small flaws: refine_still on that sheet instead of regenerating."),
      };
    }
    if (running(snapshot, (target) => target.kind === "reference_sheet")) {
      return { id: "sheet", step: 7, title: "Reference sheet", guidance: "Reference sheets are generating. Say they will appear in the workspace and what to look for." };
    }
    return {
      id: "sheet",
      step: 7,
      title: "Reference sheet",
      guidance: `Propose the reference sheet in "${link.wardrobe}": generate_reference_sheet with projectId ${project.id} and characterId ${item.id}.`,
    };
  }
  if (!product) {
    const library = snapshot.libraryProducts.slice(0, 3);
    return {
      id: "product",
      step: 8,
      title: "Product",
      guidance: [
        library.length ? `The Library has ${library.map((entry) => `${entry.name} (productId ${entry.id})`).join("; ")}; offer to reuse it with save_product (productId, projectId, its fields unchanged).` : "",
        "Ask for the product name, the link, and the exact claims they are allowed to make, then save_product with projectId. Product photos are uploaded in the workspace.",
        `No photo? Ask what it looks like (color, material, shape, cap or lid), then propose one: propose_candidates with capability "text_to_image", count 2, aspectRatio "1:1", and this prompt with <appearance> replaced by their description, never the product's name:\n${productPhotoPrompt({ name: "", appearance: "<appearance>" })}\nOnce they pick one, add it to the card's imageAssetIds with save_product.`,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }
  if (!script) {
    return {
      id: "script",
      step: 9,
      title: "Script",
      guidance: "Draft the script (see Writing scripts), show it as a short beat list, and save it with save_script once the user agrees or asks you to go ahead.",
    };
  }
  if (!content || content.scriptId !== script.id) {
    return { id: "shots", step: 10, title: "Shots", guidance: `Create the Ad from the script: plan_shots with projectId ${project.id} and scriptId ${script.id}.` };
  }
  if (content.scriptVersion !== script.version) {
    return { id: "shots", step: 10, title: "Shots", guidance: `The script is at version ${script.version} but the Ad uses ${content.scriptVersion}: call plan_shots with contentId ${content.id} to bring it up to date.` };
  }
  const stillBeat = content.shots.find((shot) => shot.still.state !== "approved");
  if (stillBeat) {
    const slot = stillBeat.still;
    if (slot.state === "open") {
      return {
        id: "stills",
        step: 10,
        title: "Shots",
        guidance: waiting(`beat ${stillBeat.beatIndex} still`, slot.candidateIds, "still", `When the user chooses, call approve with kind still, contentId ${content.id}, beatIndex ${stillBeat.beatIndex}. Close but not right: refine_still.`),
      };
    }
    return { id: "stills", step: 10, title: "Shots", guidance: `Propose the start frame for beat ${stillBeat.beatIndex}: compose_still with contentId ${content.id} and beatIndex ${stillBeat.beatIndex}.` };
  }
  const clipBeat = content.shots.find((shot) => shot.clip.state !== "approved");
  if (clipBeat) {
    const slot = clipBeat.clip;
    if (slot.state === "open") {
      return {
        id: "clips",
        step: 11,
        title: "Clips",
        guidance: waiting(`beat ${clipBeat.beatIndex} clip`, slot.candidateIds, "clip", `When the user chooses, call approve with kind clip, contentId ${content.id}, beatIndex ${clipBeat.beatIndex}.`),
      };
    }
    return { id: "clips", step: 11, title: "Clips", guidance: `Propose the clip for beat ${clipBeat.beatIndex}: generate_clip with contentId ${content.id} and beatIndex ${clipBeat.beatIndex}.` };
  }
  if (snapshot.completedExports === 0) {
    return { id: "assemble", step: 12, title: "Assemble", guidance: `Every beat has an approved clip. Offer to assemble: assemble_ad with contentId ${content.id} (captions on by default).` };
  }
  return { id: "next", step: 13, title: "Next piece", guidance: "Offer another ad in this project, or a new project with the same character." };
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
    lines.push(
      `Character: ${item.bible.name} (characterId ${item.id}, revision ${item.revision}, bible v${item.bible.version}). Face ${faceAssetId ? `locked (${faceAssetId})` : "not locked"}. Body ${bodyAssetId ? `locked (${bodyAssetId})` : "not locked"}. Wardrobe for this project: ${link.wardrobe ?? "not chosen"}. Reference sheet: ${link.sheetAssetId ? `approved (${link.sheetAssetId})` : "not approved"}.`,
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
  if (snapshot.sets.length) lines.push(`Sets: ${snapshot.sets.map((set) => `${set.name} (${set.id})`).join("; ")}.`);
  if (script) {
    lines.push(`Script: "${script.title}" (scriptId ${script.id}, version ${script.version}), ${script.beats.length} beats:`);
    for (const beat of script.beats) {
      const spoken = beat.spokenLine ? ` says "${beat.spokenLine}"` : "";
      const onScreen = beat.onScreenText ? ` | on screen "${beat.onScreenText}"` : "";
      lines.push(`  ${beat.index}. ${beat.type}/${beat.purpose}${spoken}${onScreen} | ${short(beat.visual, 100)}`);
    }
  } else {
    lines.push("Script: none yet.");
  }
  if (content) {
    const shots = content.shots.map((shot) => {
      const describe = (slot: typeof shot.still) => (slot.state === "approved" ? "approved" : slot.state === "open" ? `${slot.candidateIds.length} candidates` : "empty");
      return `beat ${shot.beatIndex} still ${describe(shot.still)}, clip ${describe(shot.clip)}`;
    });
    lines.push(`Ad: "${content.title}" (contentId ${content.id}, script v${content.scriptVersion}): ${shots.join("; ")}.`);
  }
  if (snapshot.runningJobs.length) lines.push(`Generating now: ${snapshot.runningJobs.length} job(s).`);
  return lines.join("\n");
}
