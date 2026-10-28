/**
 * Real-credit check of the voice-over path: a project with an approved talking clip (imported from a
 * file) and a b-roll clip, then generate_voice_over through the tool path (the voice sample is
 * lifted from the talking clip), approval, and an export with the voice-over mixed in.
 * Usage: TALKING=path.mp4 BROLL=path.mp4 STILL=path.png [TALKING_STILL=path.png] [RECIPE=id] [LINE="..."] [LIPSYNC=1] npm run e2e-voice
 * With LIPSYNC=1 the talking beat also gets a voice take and a lip-synced clip (speech_to_video) before the export.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { AssetSchema } from "@/lib/domain/asset";
import { addCandidates, approveCandidate } from "@/lib/domain/content";
import { probeVideo } from "@/server/executors/media";
import { importImage } from "@/server/media/images";
import { writeAtomic } from "@/server/media/files";
import { resolveMediaPath, sha256 } from "@/server/media/paths";
import { withStore } from "@/server/runtime";
import { callTool, createGenerationContext, createToolContext } from "@/server/tools";
import type { Store } from "@/server/store";
import { averyBible } from "../tests/support/domain-fixtures";

for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
type Ctx = Parameters<typeof callTool>[0];
const t0 = Date.now();
const log = (...parts: unknown[]) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s]`, ...parts);
function fail(message: string): never {
  throw new Error(message);
}
async function tool<T>(context: Ctx, name: string, input: unknown): Promise<T> {
  const result = await callTool(context, name, input);
  if (!result.ok) throw new Error(`${name}: ${result.failure.code} ${result.failure.message}`);
  return result.output as T;
}

/** Imports an MP4 file as a video asset (an "upload" of a finished clip), with its poster. */
async function importVideo(store: Store, projectId: string, path: string): Promise<string> {
  const bytes = readFileSync(path);
  const existing = store.assets.list({ projectId, kind: "video", state: "active" }).find((a) => a.provenance.source === "upload" && a.provenance.originalSha256 === sha256(bytes));
  if (existing) return existing.id;
  const id = randomUUID();
  const relativePath = `media/${id}.mp4`;
  await writeAtomic(resolveMediaPath(store.dataDir, relativePath), bytes);
  const info = await probeVideo(resolveMediaPath(store.dataDir, relativePath));
  const asset = AssetSchema.parse({
    id, projectId, kind: "video", mime: "video/mp4", relativePath, width: info.width, height: info.height, sha256: sha256(bytes),
    provenance: { source: "upload", name: basename(path), originalSha256: sha256(bytes) },
    state: { state: "active" },
    video: { durationSeconds: info.durationSeconds, frameRate: info.fps, frameCount: info.frames, hasAudio: info.hasAudio },
    revision: 0, createdAt: Date.now(),
  });
  store.assets.insert(asset);
  return id;
}

async function main() {
  const talkingPath = resolve(process.env.TALKING ?? ".data/spike/voice-clip.mp4");
  const brollPath = resolve(process.env.BROLL ?? ".data/media/8341a867-8179-46e4-a4cb-d8e40216d485-0.mp4");
  const stillPath = resolve(process.env.STILL ?? ".data/spike/still2.png");
  const talkingStillPath = resolve(process.env.TALKING_STILL ?? ".data/spike/boardroom-still.png");
  const line = process.env.LINE ?? "And it stays that cold through the whole afternoon.";
  await withStore(async (store) => {
    const now = Date.now();
    store.workspace.update({ allowanceUsd: 5 }, now);
    const context = createToolContext(store, createGenerationContext(store));
    if (process.env.PROJECT_ID) {
      // Resume: the project from an earlier run, with its b-roll voice-over already approved.
      const pid = process.env.PROJECT_ID;
      const content = store.content.listByProject(pid)[0] ?? fail("no Ad in that project");
      await lipSyncAndExport(context, store, pid, content.id);
      return;
    }
    const project = store.projects.create({ id: randomUUID(), appId: "ugc-creator", name: "Voice-over e2e", brief: null, revision: 0, createdAt: now, updatedAt: now });
    const pid = project.id;
    console.log("PROJECT_ID=" + pid);
    await tool(context, "save_brief", { projectId: pid, brief: { productSummary: "Ridgeline 32 oz insulated bottle", audience: "Office teams", platforms: ["Instagram Reels"], tone: "founder talking plainly" } });
    const saved = await tool<{ character: { id: string } }>(context, "save_character_bible", { projectId: pid, wardrobe: "navy blazer over a white tee", bible: { ...averyBible(), name: "Jordan Hale" } });
    const cid = saved.character.id;
    const script = await tool<{ script: { id: string } }>(context, "save_script", {
      projectId: pid,
      title: "Boardroom bottle",
      beats: [
        { type: "talking", purpose: "hook", spokenLine: "We built this bottle because our own meetings ran on warm water.", onScreenText: "Built for long meetings", visual: "Jordan at the head of the boardroom table holding the bottle", setting: "the boardroom", productVisible: true, durationSeconds: 5 },
        { type: "broll", purpose: "proof", spokenLine: line, onScreenText: "Cold all afternoon", visual: "Close-up of the bottle on the boardroom table, condensation on the steel", setting: "the boardroom", productVisible: true, durationSeconds: 5 },
      ],
    });
    const content = await tool<{ id: string }>(context, "plan_shots", { projectId: pid, scriptId: script.script.id });
    const still = await importImage(store, { projectId: pid, name: basename(stillPath), bytes: new Uint8Array(readFileSync(stillPath)) }, { now: Date.now(), newId: randomUUID });
    const talkingStill = await importImage(store, { projectId: pid, name: basename(talkingStillPath), bytes: new Uint8Array(readFileSync(talkingStillPath)) }, { now: Date.now(), newId: randomUUID });
    const talking = await importVideo(store, pid, talkingPath);
    const broll = await importVideo(store, pid, brollPath);
    const current = () => store.content.getRequired(content.id);
    for (const [beat, clip, frame] of [[1, talking, talkingStill], [2, broll, still]] as const) {
      store.content.update(addCandidates(current(), beat, "still", [frame.id], Date.now()));
      store.content.update(approveCandidate(current(), beat, "still", frame.id, Date.now()).content);
      store.content.update(addCandidates(current(), beat, "clip", [clip], Date.now()));
      store.content.update(approveCandidate(current(), beat, "clip", clip, Date.now()).content);
    }
    log("project ready: talking clip", talking, "b-roll clip", broll);

    const proposal = await tool<{ recipeTitle: string; prompt: string; references: { role: string; assetId: string }[]; slots?: Record<string, unknown>; estimate: unknown }>(context, "generate_voice_over", {
      projectId: pid,
      beatIndex: 2,
      ...(process.env.RECIPE ? { recipeId: process.env.RECIPE } : {}),
    });
    const sample = store.assets.getRequired(proposal.references[0].assetId);
    log("voice sample:", sample.id, sample.provenance.source, JSON.stringify(sample.audio));
    const character = store.library.getRequired(cid);
    log("character voice reference:", character.kind === "character" ? character.bible.references.voiceAssetId : null);
    log("proposal:", proposal.recipeTitle, JSON.stringify(proposal.estimate), "slots", JSON.stringify(proposal.slots ?? {}));
    const { results } = await tool<{ results: { outcome: string; message: string | null; assetIds: string[] }[] }>(context, "submit_proposal", { proposal, wait: true, confirmUnquoted: true });
    for (const r of results) log("take:", r.outcome, r.message ?? "", r.assetIds.join(","));
    const takeId = results[0]?.assetIds[0];
    if (!takeId) throw new Error("no take");
    const take = store.assets.getRequired(takeId);
    log("take asset:", take.relativePath, JSON.stringify(take.audio));
    await tool(context, "approve", { kind: "voice", contentId: content.id, beatIndex: 2, assetId: takeId });
    await lipSyncAndExport(context, store, pid, content.id);
  });
}

async function lipSyncAndExport(context: Ctx, store: Store, pid: string, contentId: string): Promise<void> {
  {
    const content = { id: contentId };
    if (process.env.LIPSYNC) {
      const talkingTake = await tool<{ recipeTitle: string; estimate: unknown }>(context, "generate_voice_over", { projectId: pid, beatIndex: 1, ...(process.env.RECIPE ? { recipeId: process.env.RECIPE } : {}) });
      log("talking take proposal:", talkingTake.recipeTitle, JSON.stringify(talkingTake.estimate));
      const taken = await tool<{ results: { outcome: string; message: string | null; assetIds: string[] }[] }>(context, "submit_proposal", { proposal: talkingTake, wait: true, confirmUnquoted: true });
      const talkingTakeId = taken.results[0]?.assetIds[0] ?? fail(`talking take ${taken.results[0]?.outcome}: ${taken.results[0]?.message}`);
      log("talking take:", talkingTakeId, JSON.stringify(store.assets.getRequired(talkingTakeId).audio));
      await tool(context, "approve", { kind: "voice", contentId: content.id, beatIndex: 1, assetId: talkingTakeId });
      const lip = await tool<{ recipeTitle: string; prompt: string; durationSeconds: number; estimate: unknown }>(context, "generate_clip", { contentId: content.id, beatIndex: 1, mode: "speech" });
      log("lip-sync proposal:", lip.recipeTitle, lip.durationSeconds, "s", JSON.stringify(lip.estimate));
      log("prompt:", lip.prompt);
      const synced = await tool<{ results: { outcome: string; message: string | null; assetIds: string[] }[] }>(context, "submit_proposal", { proposal: lip, wait: true, confirmUnquoted: true });
      const clipId = synced.results[0]?.assetIds[0] ?? fail(`lip-sync ${synced.results[0]?.outcome}: ${synced.results[0]?.message}`);
      log("lip-synced clip:", clipId, JSON.stringify(store.assets.getRequired(clipId).video));
      await tool(context, "approve", { kind: "clip", contentId: content.id, beatIndex: 1, assetId: clipId });
    }
    const assembled = await tool<{ export: { status: string; filterSummary?: string; error?: string }; asset: { id: string; relativePath: string; video: { durationSeconds: number; hasAudio: boolean } } | null }>(context, "assemble_ad", { contentId: content.id, captions: true });
    log("export:", assembled.export.status, assembled.export.filterSummary ?? assembled.export.error ?? "");
    if (assembled.asset) {
      const path = resolveMediaPath(store.dataDir, assembled.asset.relativePath);
      console.log("EXPORT_PATH=" + path, statSync(path).size, "bytes", JSON.stringify(assembled.asset.video));
    }
  }
}
main().catch((error) => { console.error("FAILED:", error instanceof Error ? error.message : error); process.exit(1); });
