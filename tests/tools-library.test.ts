/**
 * Library linking across projects, set and wardrobe prompt wiring, unlink guards, and archiving.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, describe, test } from "node:test";
import sharp from "sharp";
import type { CharacterItem, ProjectLink, SetItem } from "@/lib/domain/library";
import type { GenerationProposal } from "@/lib/domain/job";
import { importImage } from "@/server/media/images";
import { type ToolContext, callTool, createGenerationContext } from "@/server/tools";
import { averyBible, clock, generateAssets, ridgelineBeats, ridgelineProduct, seedProject, tempStore } from "./support/domain-fixtures";

const workflowsDir = fileURLToPath(new URL("../workflows", import.meta.url));
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function setup() {
  const context = tempStore();
  cleanups.push(context.cleanup);
  const now = clock();
  const tools: ToolContext = { store: context.store, now, newId: randomUUID, generation: createGenerationContext(context.store, { workflowsDir }) };
  return { ...context, now, tools, project: seedProject(context.store, now) };
}

async function ok<T>(tools: ToolContext, name: string, input: unknown): Promise<T> {
  const result = await callTool(tools, name, input);
  if (!result.ok) assert.fail(`${name} failed: ${result.failure.code} ${result.failure.message}`);
  return result.output as T;
}

async function failure(tools: ToolContext, name: string, input: unknown): Promise<{ code: string; message: string }> {
  const result = await callTool(tools, name, input);
  assert.equal(result.ok, false, `${name} should fail`);
  return result.ok ? { code: "", message: "" } : result.failure;
}

async function photo(context: ReturnType<typeof setup>, color: string) {
  const bytes = await sharp({ create: { width: 48, height: 64, channels: 3, background: color } }).png().toBuffer();
  return importImage(context.store, { projectId: null, name: `${color}.png`, bytes }, { now: context.now(), newId: randomUUID });
}

/** A character whose face and body were locked in an earlier project. */
async function earlierCharacter(context: ReturnType<typeof setup>) {
  const { store, now, tools } = context;
  const earlier = seedProject(store, now, "Earlier project");
  const { character } = await ok<{ character: CharacterItem }>(tools, "save_character_bible", { projectId: earlier.id, bible: averyBible() });
  const refs: Record<"face" | "body", string> = { face: "", body: "" };
  for (const slot of ["face", "body"] as const) {
    const generated = await generateAssets(store, now, { projectId: earlier.id, target: { kind: "character_reference", characterId: character.id, slot } });
    await ok(tools, "select_reference", { characterId: character.id, slot, assetId: generated.assetIds[0] });
    refs[slot] = generated.assetIds[0];
  }
  return { earlier, characterId: character.id, ...refs };
}

describe("Library linking", () => {
  test("link_library_item attaches without changing the item, and cross-project references work only once linked", async () => {
    const context = setup();
    const { store, tools, project } = context;
    const { characterId, face, body } = await earlierCharacter(context);
    const before = store.library.getRequired(characterId) as CharacterItem;

    const unlinked = await failure(tools, "propose_candidates", { projectId: project.id, capability: "image_edit", prompt: "Same person", referenceAssetIds: [face], count: 1 });
    assert.equal(unlinked.code, "invalid");
    assert.match(unlinked.message, /Link the item first/);

    const link = await ok<ProjectLink>(tools, "link_library_item", { projectId: project.id, itemId: characterId });
    assert.equal(link.kind, "character");
    assert.deepEqual(await ok<ProjectLink>(tools, "link_library_item", { projectId: project.id, itemId: characterId }), link);
    const after = store.library.getRequired(characterId) as CharacterItem;
    assert.equal(after.bible.version, before.bible.version);
    assert.equal(after.revision, before.revision);

    await ok(tools, "propose_candidates", { projectId: project.id, capability: "image_edit", prompt: "Same person", referenceAssetIds: [face], count: 1 });
    const noWardrobe = await failure(tools, "generate_reference_sheet", { projectId: project.id, characterId });
    assert.match(noWardrobe.message, /wardrobe/);
    const sheet = await ok<GenerationProposal>(tools, "generate_reference_sheet", { projectId: project.id, characterId, wardrobe: "Olive utility jacket over a white tee" });
    assert.deepEqual(sheet.references.map((reference) => reference.assetId), [face, body]);
    const refine = await ok<GenerationProposal>(tools, "refine_still", { assetId: face, projectId: project.id, instruction: "Softer light" });
    assert.equal(refine.projectId, project.id);
    assert.deepEqual(refine.target, { kind: "loose" });
  });

  test("archived items are hidden from new links and restorable", async () => {
    const context = setup();
    const { tools, project } = context;
    const { set } = await ok<{ set: SetItem }>(tools, "create_set", { set: { name: "A gym bench" } });
    const archived = await ok<SetItem>(tools, "archive_library_item", { itemId: set.id });
    assert.equal(archived.archived, true);
    assert.match((await failure(tools, "link_library_item", { projectId: project.id, itemId: set.id })).message, /archived/);
    const restored = await ok<SetItem>(tools, "archive_library_item", { itemId: set.id, restore: true });
    assert.equal(restored.archived, false);
    await ok(tools, "link_library_item", { projectId: project.id, itemId: set.id });
  });

  test("unlink is refused while an approved still was made from the item's images, then allowed", async () => {
    const context = setup();
    const { store, tools, project } = context;
    const kitchen = await photo(context, "#ddd");
    const { set } = await ok<{ set: SetItem }>(tools, "create_set", { projectId: project.id, set: { name: "Bright kitchen counter", notes: "By a window", imageAssetIds: [kitchen.id] } });
    const script = await ok<{ script: { id: string } }>(tools, "save_script", { projectId: project.id, title: "Counter", beats: [ridgelineBeats()[3]] });
    const content = await ok<{ id: string }>(tools, "plan_shots", { projectId: project.id, scriptId: script.script.id });
    const proposal = await ok<GenerationProposal>(tools, "compose_still", { contentId: content.id, beatIndex: 1, count: 1 });
    assert.deepEqual(proposal.references.map((reference) => reference.assetId), [kitchen.id]);
    const submitted = await ok<{ results: { assetIds: string[] }[] }>(tools, "submit_proposal", { proposal, wait: true });
    const still = submitted.results[0].assetIds[0];
    await ok(tools, "approve", { kind: "still", contentId: content.id, beatIndex: 1, assetId: still });

    const refused = await failure(tools, "unlink_library_item", { projectId: project.id, itemId: set.id });
    assert.equal(refused.code, "invalid");
    assert.match(refused.message, /Beat 1's approved still in "Counter" was made from Bright kitchen counter's images/);

    await ok(tools, "delete_asset_everywhere", { assetId: still, confirm: true });
    assert.deepEqual(await ok(tools, "unlink_library_item", { projectId: project.id, itemId: set.id }), { projectId: project.id, itemId: set.id, unlinked: true });
    assert.equal(store.library.getLink(project.id, set.id), undefined);
    assert.equal(store.library.getRequired(set.id).archived, false);
  });
});

describe("prompt wiring", () => {
  test("compose_still references the matching set and generate_clip repeats the wardrobe", async () => {
    const context = setup();
    const { store, now, tools, project } = context;
    const { characterId } = await earlierCharacter(context);
    await ok(tools, "save_character_bible", { characterId, projectId: project.id, wardrobe: "Olive utility jacket over a white tee", bible: averyBible() });
    const sheets = await generateAssets(store, now, { projectId: project.id, target: { kind: "reference_sheet", characterId } });
    await ok(tools, "approve", { kind: "sheet", assetId: sheets.assetIds[0], projectId: project.id, characterId });
    const bottle = await photo(context, "#357");
    await ok(tools, "save_product", { projectId: project.id, product: ridgelineProduct([bottle.id]) });
    const kitchen = await photo(context, "#eee");
    await ok(tools, "create_set", { projectId: project.id, set: { name: "Bright kitchen counter by a window", imageAssetIds: [kitchen.id] } });
    await ok(tools, "create_set", { projectId: project.id, set: { name: "A car interior" } });

    const script = await ok<{ script: { id: string } }>(tools, "save_script", { projectId: project.id, title: "Proof", beats: [ridgelineBeats()[2]] });
    const content = await ok<{ id: string }>(tools, "plan_shots", { projectId: project.id, scriptId: script.script.id });
    const still = await ok<GenerationProposal>(tools, "compose_still", { contentId: content.id, beatIndex: 1, count: 1 });
    assert.deepEqual(still.references.map((reference) => reference.assetId), [sheets.assetIds[0], bottle.id, kitchen.id]);
    assert.equal(
      still.prompt,
      "Avery Lane, a woman in her early 30s with a warm oval face, light freckles, hazel eyes, dark shoulder-length hair tied back, and small silver hoop earrings. " +
        "The person shown in the character reference sheet, reference image 1, wearing olive utility jacket over a white tee. " +
        "Mid-sentence, talking to a phone camera held at arm's length, relaxed natural expression, mouth slightly open as if speaking. " +
        "Avery at a kitchen counter, bottle open, condensation. " +
        "Setting: the location in reference image 3, bright kitchen counter by a window. " +
        "The product in reference image 2 is a matte dark green 32 oz insulated steel bottle with a black screw cap, clearly visible, true to its shape, color, and materials, no text, lettering, or logo on the product. " +
        "Only the objects described; no additional phones or props, and no bottles beyond those described. " +
        "Vertical 9:16 phone photo, natural light, candid UGC look. No text, captions, logos, or watermarks in the image. " +
        "Preserve the person's identity, face, hair, build, and wardrobe exactly as in the sheet.",
    );

    const submitted = await ok<{ results: { assetIds: string[] }[] }>(tools, "submit_proposal", { proposal: still, wait: true });
    await ok(tools, "approve", { kind: "still", contentId: content.id, beatIndex: 1, assetId: submitted.results[0].assetIds[0] });
    const clip = await ok<GenerationProposal>(tools, "generate_clip", { contentId: content.id, beatIndex: 1 });
    assert.equal(
      clip.prompt,
      "Avery at a kitchen counter, bottle open, condensation, speaking to the camera with an easy smile, small natural head movement, static phone camera. " +
        "Wearing Olive utility jacket over a white tee. " +
        "The product is a matte dark green 32 oz insulated steel bottle with a black screw cap, no text, lettering, or logo on the product. " +
        "Quiet ambient sound of a bright kitchen counter by a window. " +
        'The person says, "Twenty-four hours later it was still cold. I checked." ' +
        "No text on screen. The person's face and clothing stay consistent.",
    );
  });
});

describe("product appearance", () => {
  test("a product saved before appearance existed still reads, with an empty appearance and the name fallback", async () => {
    const context = setup();
    const { store, tools, project } = context;
    const { product } = await ok<{ product: { id: string; appearance: string } }>(tools, "save_product", { projectId: project.id, product: ridgelineProduct() });
    assert.equal(product.appearance, "a matte dark green 32 oz insulated steel bottle with a black screw cap");
    store.database.prepare("UPDATE library_items SET data = json_remove(data, '$.appearance') WHERE id = ?").run(product.id);
    const legacy = store.library.getRequired(product.id);
    assert.equal(legacy.kind === "product" && legacy.appearance, "");
    const script = await ok<{ script: { id: string } }>(tools, "save_script", { projectId: project.id, title: "Dishwasher", beats: [ridgelineBeats()[3]] });
    const content = await ok<{ id: string }>(tools, "plan_shots", { projectId: project.id, scriptId: script.script.id });
    const still = await ok<GenerationProposal>(tools, "compose_still", { contentId: content.id, beatIndex: 1, count: 1 });
    assert.match(still.prompt, /The product is a 32 oz insulated bottle, clearly visible/);
    assert.doesNotMatch(still.prompt, /Ridgeline/);
  });
});
