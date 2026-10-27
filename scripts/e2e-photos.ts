/**
 * Real-credit check of the uploaded-photo path: a person's photo as the face, a product photo, and a
 * place photo as a Set, then body, sheet, script, stills, clips, and export.
 * Usage: FACE=path PRODUCT=path PLACE=path npm run e2e-photos   (PROJECT_ID resumes; E2E_MAX_BEATS per call)
 */
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { importImage } from "@/server/media/images";
import { withStore } from "@/server/runtime";
import { callTool, createGenerationContext, createToolContext } from "@/server/tools";
import { averyBible } from "../tests/support/domain-fixtures";

for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
type Ctx = Parameters<typeof callTool>[0];
const t0 = Date.now();
const log = (...parts: unknown[]) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s]`, ...parts);
async function tool<T>(context: Ctx, name: string, input: unknown): Promise<T> {
  const result = await callTool(context, name, input);
  if (!result.ok) throw { code: "invalid", message: `${name}: ${result.failure.code} ${result.failure.message}` };
  return result.output as T;
}
async function generate(context: Ctx, proposal: unknown, label: string): Promise<string[]> {
  const { results } = await tool<{ results: { outcome: string; message: string | null; assetIds: string[] }[] }>(context, "submit_proposal", { proposal, wait: true, confirmUnquoted: true });
  for (const r of results) log(label, r.outcome, r.message ?? "");
  const ids = results.flatMap((r) => r.assetIds);
  if (!ids.length) throw { code: "invalid", message: `${label}: no assets` };
  return ids;
}
type State = {
  characters: { item: { id: string; bible: { references: { faceAssetId: string | null; bodyAssetId: string | null } } }; link: { sheetApprovedAt: number | null; sheetAssetId: string | null } }[];
  products: { id: string }[]; sets: { id: string }[]; scripts: { id: string }[];
  contents: { id: string; shots: { beatIndex: number; still: { state: string }; clip: { state: string } }[] }[];
};
async function main() {
  const maxBeats = Number(process.env.E2E_MAX_BEATS ?? "1");
  await withStore(async (store) => {
    const now = Date.now();
    store.workspace.update({ allowanceUsd: 5 }, now);
    const context = createToolContext(store, createGenerationContext(store));
    const project = process.env.PROJECT_ID
      ? store.projects.getRequired(process.env.PROJECT_ID)
      : store.projects.create({ id: randomUUID(), appId: "ugc-creator", name: "Founder photos e2e", brief: null, revision: 0, createdAt: now, updatedAt: now });
    const pid = project.id; console.log("PROJECT_ID=" + pid);
    const upload = async (path: string) => importImage(store, { projectId: pid, name: basename(path), bytes: new Uint8Array(readFileSync(path)) }, { now: Date.now(), newId: randomUUID });
    const state = async () => tool<State>(context, "get_project_state", { projectId: pid });
    let s = await state();
    if (!s.characters.length) {
      await tool(context, "save_brief", { projectId: pid, brief: { productSummary: "Ridgeline 32 oz insulated bottle, owned brand", audience: "Office teams who want to stop buying bottled water", platforms: ["LinkedIn", "Instagram Reels"], tone: "founder talking plainly to customers" } });
      await tool(context, "save_character_bible", { projectId: pid, wardrobe: "navy blazer over a white tee, dark jeans", bible: { ...averyBible(), name: "Jordan Hale", backstory: "Founder of the brand. Talks about the product like she still uses it every day." } });
      s = await state();
    }
    const cid = s.characters[0].item.id;
    if (!s.characters[0].item.bible.references.faceAssetId) {
      const face = await upload(process.env.FACE!);
      await tool(context, "select_reference", { characterId: cid, slot: "face", assetId: face.id });
      log("face locked from upload", face.id, face.provenance.source);
      s = await state();
    }
    if (!s.characters[0].item.bible.references.bodyAssetId) {
      const faceId = s.characters[0].item.bible.references.faceAssetId!;
      const bodyProposal = await tool<{ prompt: string }>(context, "propose_candidates", { projectId: pid, capability: "image_edit", prompt: "Same person as the reference image, identical face and hair. Build: average height, slim-athletic. Three-quarter view full-body standing pose, relaxed, arms at sides, fitted navy athleticwear, plain deep neutral gray seamless background, even soft light, photographic. The outfit must contrast clearly with the background so the silhouette reads. Match the real person's features exactly as photographed.", referenceAssetIds: [faceId], count: 1, aspectRatio: "9:16", target: { kind: "character_reference", characterId: cid, slot: "body" } });
      const bodies = await generate(context, bodyProposal, "body");
      await tool(context, "select_reference", { characterId: cid, slot: "body", assetId: bodies[0] });
      s = await state();
    }
    if (!s.characters[0].link.sheetApprovedAt) {
      const sheetProposal = await tool<{ prompt: string }>(context, "generate_reference_sheet", { projectId: pid, characterId: cid, wardrobe: "navy blazer over a white tee, dark jeans", count: 1 });
      log("sheet prompt mentions photo:", /photographed/.test(sheetProposal.prompt));
      const sheets = await generate(context, sheetProposal, "sheet");
      await tool(context, "approve", { kind: "sheet", assetId: sheets[0], projectId: pid, characterId: cid });
      s = await state();
    }
    if (!s.products.length) {
      const productPhoto = await upload(process.env.PRODUCT!);
      await tool(context, "save_product", { projectId: pid, product: { name: "Ridgeline 32 oz insulated bottle", appearance: "a matte dark green 32 oz insulated steel bottle with a black screw cap", link: "https://example.com/ridgeline", allowedClaims: ["keeps drinks cold 24 hours", "fits a car cup holder", "dishwasher safe"], imageAssetIds: [productPhoto.id] } });
      log("product saved from uploaded photo");
      s = await state();
    }
    if (!s.sets.length) {
      const placePhoto = await upload(process.env.PLACE!);
      await tool(context, "create_set", { projectId: pid, set: { name: "the boardroom", notes: "The brand's boardroom: long wooden table, glass wall, city daylight.", imageAssetIds: [placePhoto.id] } });
      log("set created from uploaded photo");
      s = await state();
    }
    if (!s.contents.length) {
      const scriptId = s.scripts[0]?.id ?? (await tool<{ script: { id: string } }>(context, "save_script", { projectId: pid, title: "Founder in the boardroom", beats: [
        { type: "talking", purpose: "hook", spokenLine: "We built this bottle because our own meetings ran on warm water.", onScreenText: "Built by people who drink it.", visual: "The founder at the head of the boardroom table holding the bottle, city light behind her.", setting: "the boardroom", productVisible: true },
        { type: "broll", purpose: "proof", onScreenText: "Cold 24 hours.", visual: "Close-up of the bottle on the boardroom table, condensation on the steel, glass wall behind.", setting: "the boardroom", productVisible: true },
      ] })).script.id;
      await tool(context, "plan_shots", { projectId: pid, scriptId, title: "Founder ad" });
      s = await state();
    }
    const content = s.contents[0];
    let done = 0;
    for (const shot of [...content.shots].sort((a, b) => a.beatIndex - b.beatIndex)) {
      if (shot.still.state === "approved" && shot.clip.state === "approved") continue;
      if (done >= maxBeats) { log("stopping after", done, "beat(s); rerun with PROJECT_ID"); return; }
      const beatIndex = shot.beatIndex;
      if (shot.still.state !== "approved") {
        const stillProposal = await tool<{ prompt: string; references: unknown[] }>(context, "compose_still", { contentId: content.id, beatIndex, count: 1 });
        log(`still ${beatIndex} references`, stillProposal.references.length, "photo wording:", /photographed/.test(stillProposal.prompt), "place wording:", /matching its layout/.test(stillProposal.prompt));
        const stills = await generate(context, stillProposal, `still ${beatIndex}`);
        await tool(context, "approve", { kind: "still", assetId: stills[0], contentId: content.id, beatIndex });
      }
      if (shot.clip.state !== "approved") {
        const clipProposal = await tool(context, "generate_clip", { contentId: content.id, beatIndex, count: 1 });
        const clips = await generate(context, clipProposal, `clip ${beatIndex}`);
        await tool(context, "approve", { kind: "clip", assetId: clips[0], contentId: content.id, beatIndex });
      }
      log(`beat ${beatIndex} approved`); done++;
    }
    const { asset } = await tool<{ asset: { relativePath: string } }>(context, "assemble_ad", { contentId: content.id, captions: true });
    const path = resolve(store.dataDir, asset.relativePath);
    log("export", asset.relativePath, statSync(path).size, "bytes"); console.log("EXPORT_PATH=" + path);
  });
}
main().catch((error) => { console.error("FAILED:", error instanceof Error ? error.message : JSON.stringify(error)); process.exit(1); });
