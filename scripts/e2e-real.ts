/**
 * Real end-to-end run through the tools layer on real Comfy credits, without the assistant.
 * Face lock, body reference, reference sheet, product, script, stills, clips, and assembly.
 * Usage: npm run e2e-real   (about 80 credits; needs .env.local and the workspace allowance)
 * PROJECT_ID resumes; E2E_MAX_BEATS beats per call; E2E_FACES face candidates (default 2); E2E_NAME names the project;
 * b-roll beats carry voice-over lines and get a take each after the clips.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { withStore } from "@/server/runtime";
import { callTool, createGenerationContext, createToolContext } from "@/server/tools";
import { averyBible, ridgelineBeats } from "../tests/support/domain-fixtures";

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
  const { results } = await tool<{ results: { outcome: string; message: string | null; assetIds: string[]; job: { creditsUsed: number | null } | null }[] }>(
    context, "submit_proposal", { proposal, wait: true, confirmUnquoted: true },
  );
  const ids = results.flatMap((r) => r.assetIds);
  for (const r of results) log(label, r.outcome, r.message ?? "", "credits", r.job?.creditsUsed ?? "n/a");
  if (!ids.length) throw { code: "invalid", message: `${label}: no assets (${results.map((r) => r.outcome + " " + r.message).join("; ")})` };
  return ids;
}

async function balanceCredits(): Promise<number> {
  const r = await fetch("https://cloud.comfy.org/api/billing/balance", { headers: { "X-API-Key": process.env.COMFY_API_KEY ?? "" } });
  const j = (await r.json()) as { effective_balance_cents: number };
  return Math.round(j.effective_balance_cents * 2.11);
}

type State = {
  project: { id: string };
  characters: { item: { id: string; bible: { references: { faceAssetId: string | null; bodyAssetId: string | null } } }; link: { wardrobe: string | null; sheetAssetId: string | null; sheetApprovedAt: number | null } }[];
  products: { id: string }[];
  scripts: { id: string }[];
  contents: { id: string; shots: { beatIndex: number; still: { state: string; candidateIds?: string[] }; clip: { state: string; candidateIds?: string[] }; voice: { state: string } }[] }[];
};

async function main() {
  const before = await balanceCredits();
  log("credits before:", before);
  const maxBeats = Number(process.env.E2E_MAX_BEATS ?? "1");
  await withStore(async (store) => {
    const now = Date.now();
    store.workspace.update({ allowanceUsd: Number(process.env.E2E_ALLOWANCE ?? "5") }, now);
    const context = createToolContext(store, createGenerationContext(store));
    const existing = process.env.PROJECT_ID;
    const project = existing
      ? store.projects.getRequired(existing)
      : store.projects.create({ id: randomUUID(), appId: "ugc-creator", name: process.env.E2E_NAME ?? "Ridgeline e2e v2", brief: null, revision: 0, createdAt: now, updatedAt: now });
    const pid = project.id;
    console.log("PROJECT_ID=" + pid);
    const state = async () => tool<State>(context, "get_project_state", { projectId: pid });
    let s = await state();
    const bible = averyBible();
    const wardrobe = "olive utility jacket over a white tee, dark jeans";

    if (!s.characters.length) {
      await tool(context, "save_brief", { projectId: pid, brief: { productSummary: "Ridgeline 32 oz insulated bottle, affiliate", audience: "Commuters who drink water in the car", platforms: ["TikTok", "Instagram Reels"], tone: "friend recommending something" } });
      await tool(context, "save_character_bible", { projectId: pid, wardrobe, bible });
      s = await state();
    }
    const character = s.characters[0];
    const cid = character.item.id;
    log("character", cid);

    if (!character.item.bible.references.faceAssetId) {
      const faceProposal = await tool(context, "generate_face_candidates", { projectId: pid, characterId: cid, count: Number(process.env.E2E_FACES ?? "2") });
      const faces = await generate(context, faceProposal, "face");
      await tool(context, "select_reference", { characterId: cid, slot: "face", assetId: faces[0] });
      s = await state();
    }
    const faceId = s.characters[0].item.bible.references.faceAssetId!;
    log("face", faceId);

    if (!s.characters[0].item.bible.references.bodyAssetId) {
      const bodyProposal = await tool(context, "generate_body_reference", { projectId: pid, characterId: cid, count: 1 });
      const bodies = await generate(context, bodyProposal, "body");
      await tool(context, "select_reference", { characterId: cid, slot: "body", assetId: bodies[0] });
      s = await state();
    }
    log("body", s.characters[0].item.bible.references.bodyAssetId);

    if (!s.characters[0].link.sheetApprovedAt) {
      const sheetProposal = await tool(context, "generate_reference_sheet", { projectId: pid, characterId: cid, wardrobe, count: 1 });
      const sheets = await generate(context, sheetProposal, "sheet");
      await tool(context, "approve", { kind: "sheet", assetId: sheets[0], projectId: pid, characterId: cid });
      s = await state();
    }
    log("sheet", s.characters[0].link.sheetAssetId);

    if (!s.products.length) {
      const productProposal = await tool(context, "propose_candidates", { projectId: pid, capability: "text_to_image", prompt: "Product photograph of a matte dark green 32 oz insulated steel water bottle with a black screw cap, standing upright on a light wooden kitchen counter by a window, soft morning light, light condensation on the steel, plain uncluttered background, no text, no logo.", count: 1, aspectRatio: "1:1", target: { kind: "loose" } });
      const productImages = await generate(context, productProposal, "product");
      await tool(context, "save_product", { projectId: pid, product: { name: "Ridgeline 32 oz insulated bottle", appearance: "a matte dark green 32 oz insulated steel bottle with a black screw cap", link: "https://example.com/ridgeline", allowedClaims: ["keeps drinks cold 24 hours", "fits a car cup holder", "dishwasher safe"], imageAssetIds: [productImages[0]] } });
      s = await state();
    }
    log("product", s.products[0].id);

    const beats = ridgelineBeats().slice(0, 4).map((beat) =>
      beat.type === "broll" && !beat.spokenLine
        ? { ...beat, spokenLine: beat.purpose === "problem" ? "By noon that water was warm, every single day." : "And it goes straight in the dishwasher.", durationSeconds: 4 }
        : beat,
    );
    if (!s.contents.length) {
      const scriptId = s.scripts[0]?.id ?? (await tool<{ script: { id: string } }>(context, "save_script", { projectId: pid, title: "Cup holder hook", beats })).script.id;
      await tool(context, "plan_shots", { projectId: pid, scriptId, title: "Ridgeline ad" });
      s = await state();
    }
    const content = s.contents[0];
    log("content", content.id, "shots", content.shots.length);

    let done = 0;
    for (const shot of [...content.shots].sort((a, b) => a.beatIndex - b.beatIndex)) {
      if (shot.still.state === "approved" && shot.clip.state === "approved") continue;
      if (done >= maxBeats) { log("stopping after", done, "beat(s) this call; rerun with PROJECT_ID to continue"); return; }
      const beatIndex = shot.beatIndex;
      // A candidate recovered from a cut-off call is approved rather than made again.
      if (shot.still.state === "open" && shot.still.candidateIds?.length) {
        await tool(context, "approve", { kind: "still", assetId: shot.still.candidateIds[0], contentId: content.id, beatIndex });
      } else if (shot.still.state !== "approved") {
        const stillProposal = await tool(context, "compose_still", { contentId: content.id, beatIndex, count: 1 });
        const stills = await generate(context, stillProposal, `still ${beatIndex}`);
        await tool(context, "approve", { kind: "still", assetId: stills[0], contentId: content.id, beatIndex });
      }
      if (shot.clip.state === "open" && shot.clip.candidateIds?.length) {
        await tool(context, "approve", { kind: "clip", assetId: shot.clip.candidateIds[0], contentId: content.id, beatIndex });
      } else if (shot.clip.state !== "approved") {
        const clipProposal = await tool(context, "generate_clip", { contentId: content.id, beatIndex, count: 1 });
        const clips = await generate(context, clipProposal, `clip ${beatIndex}`);
        await tool(context, "approve", { kind: "clip", assetId: clips[0], contentId: content.id, beatIndex });
      }
      log(`beat ${beatIndex} approved`);
      done++;
    }

    for (const shot of content.shots) {
      const beat = beats[shot.beatIndex - 1];
      if (!beat || beat.type === "talking" || !beat.spokenLine || shot.voice.state === "approved") continue;
      const voiceProposal = await tool(context, "generate_voice_over", { projectId: pid, beatIndex: shot.beatIndex, count: 1 });
      const takes = await generate(context, voiceProposal, `voice-over ${shot.beatIndex}`);
      await tool(context, "approve", { kind: "voice", assetId: takes[0], contentId: content.id, beatIndex: shot.beatIndex });
      log(`beat ${shot.beatIndex} voice-over approved`);
    }

    const { export: record, asset } = await tool<{ export: { id: string; durationSeconds?: number }; asset: { relativePath: string; width: number; height: number } }>(context, "assemble_ad", { contentId: content.id, captions: true });
    const path = resolve(store.dataDir, asset.relativePath);
    log("export", record.id, `${asset.width}x${asset.height}`, record.durationSeconds, "s", asset.relativePath, statSync(path).size, "bytes");
    console.log("EXPORT_PATH=" + path);
  });
  const after = await balanceCredits();
  log("credits after:", after, "spent about", before - after);
}

main().catch((error) => {
  console.error("FAILED:", error instanceof Error ? error.message : JSON.stringify(error));
  process.exit(1);
});
