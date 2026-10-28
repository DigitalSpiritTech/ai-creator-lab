/**
 * Runs one starter workflow through the real tool path (proposal, gate, executor, store) and reports
 * the output. Usage: RECIPE=<id> [PROMPT=...] [REFS=face.png,product.png] [VOICE=voice-sample.flac] [SLOTS='{"refText":"..."}'] [SECONDS=5] npm run verify-workflow
 * References come from .data/spike; a project "Workflow checks" is created on first use.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { importAudio } from "@/server/media/audio";
import { importImage } from "@/server/media/images";
import { withStore } from "@/server/runtime";
import { callTool, createGenerationContext, createToolContext } from "@/server/tools";
import { startRecoveryOnce } from "@/server/tools/recovery";

for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const CREDITS_PER_CENT = 2.11;
async function balance(): Promise<number> {
  const res = await fetch("https://cloud.comfy.org/api/billing/balance", { headers: { "X-API-Key": process.env.COMFY_API_KEY ?? "" } });
  return Number(((await res.json()) as { effective_balance_cents?: number }).effective_balance_cents ?? 0) * CREDITS_PER_CENT;
}
const t0 = Date.now();
const log = (...parts: unknown[]) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s]`, ...parts);

async function main() {
  const recipeId = process.env.RECIPE;
  if (process.env.RESUME) {
    // Finish jobs a cut-off run left in flight (startup recovery), then list what they made.
    await withStore(async (store) => {
      const outcomes = await startRecoveryOnce(store, (line) => log(line));
      for (const outcome of outcomes) {
        log("recovered:", outcome.kind, outcome.job?.id, outcome.job?.status, "credits", outcome.job && "creditsUsed" in outcome.job ? outcome.job.creditsUsed : "");
        if (outcome.kind === "completed") {
          for (const asset of outcome.assets) {
            console.log("asset:", asset.kind, asset.relativePath, statSync(resolve(store.dataDir, asset.relativePath)).size, "bytes", asset.video ? JSON.stringify(asset.video) : asset.audio ? JSON.stringify(asset.audio) : "");
            console.log("ASSET_PATH=" + resolve(store.dataDir, asset.relativePath));
          }
        }
      }
    });
    log(`credits now: ${(await balance()).toFixed(0)}`);
    return;
  }
  if (!recipeId) throw new Error("RECIPE is required");
  const before = await balance();
  await withStore(async (store) => {
    const context = createToolContext(store, createGenerationContext(store));
    const tool = async <T,>(name: string, input: unknown): Promise<T> => {
      const result = await callTool(context, name, input);
      if (!result.ok) throw new Error(`${name}: ${result.failure.code} ${result.failure.message}`);
      return result.output as T;
    };
    store.workspace.update({ allowanceUsd: 5 }, Date.now());
    let project = store.projects.list().find((p) => p.name === "Workflow checks");
    if (!project) {
      const now = Date.now();
      project = store.projects.create({ id: randomUUID(), appId: "ugc-creator", name: "Workflow checks", brief: null, revision: 0, createdAt: now, updatedAt: now });
    }
    const recipes = await context.generation!.recipes();
    const recipe = recipes.find((r) => r.id === recipeId);
    if (!recipe) throw new Error(`no recipe ${recipeId}; have ${recipes.map((r) => r.id).join(", ")}`);
    const refs = (process.env.REFS ?? "").split(",").filter(Boolean);
    const referenceAssetIds: string[] = [];
    for (const name of refs) {
      const path = resolve(process.cwd(), ".data/spike", name);
      if (!existsSync(path)) throw new Error(`missing ${path}`);
      const existing = store.assets.list({ projectId: project.id, state: "any" }).find((a) => a.provenance.source === "upload" && a.provenance.name === name);
      if (existing) { referenceAssetIds.push(existing.id); continue; }
      const asset = await importImage(store, { projectId: project.id, name, bytes: readFileSync(path) }, { now: Date.now(), newId: randomUUID });
      referenceAssetIds.push(asset.id);
    }
    if (process.env.VOICE) {
      const name = process.env.VOICE;
      const path = resolve(process.cwd(), ".data/spike", name);
      if (!existsSync(path)) throw new Error(`missing ${path}`);
      const existing = store.assets.list({ projectId: project.id, state: "any" }).find((a) => a.provenance.source === "upload" && a.provenance.name === name);
      const asset = existing ?? (await importAudio(store, { projectId: project.id, name, bytes: readFileSync(path) }, { now: Date.now(), newId: randomUUID }));
      log("voice sample:", asset.id, asset.mime, JSON.stringify(asset.audio));
      referenceAssetIds.push(asset.id);
    }
    const slots = process.env.SLOTS ? (JSON.parse(process.env.SLOTS) as Record<string, string | number | boolean>) : undefined;
    const seconds = process.env.SECONDS ? Number(process.env.SECONDS) : undefined;
    const prompt = process.env.PROMPT ?? "Three-quarter portrait of a woman in her early thirties with dark hair tied back, warm direct expression, plain fitted navy tee, soft window light, plain light gray background, photographic, no text.";
    const proposal = await tool<{ recipeTitle: string; estimate: unknown }>("propose_candidates", {
      projectId: project.id,
      capability: recipe.capability,
      recipeId,
      prompt,
      referenceAssetIds,
      count: 1,
      aspectRatio: process.env.ASPECT ?? "9:16",
      ...(seconds ? { durationSeconds: seconds } : {}),
      ...(slots ? { slots } : {}),
      target: { kind: "loose" },
    });
    log("proposal:", proposal.recipeTitle, JSON.stringify(proposal.estimate));
    const { results } = await tool<{ results: { outcome: string; message: string | null; assetIds: string[]; job: { id: string; status: string; creditsUsed: number | null; providerRef?: string | null } | null }[] }>("submit_proposal", { proposal, wait: true, confirmUnquoted: true });
    for (const r of results) {
      log("result:", r.outcome, r.message ?? "", "job", r.job?.id, r.job?.status, "credits", r.job?.creditsUsed, "ref", r.job?.providerRef ?? "");
      for (const id of r.assetIds) {
        const asset = store.assets.get(id)!;
        console.log("asset:", asset.kind, `${asset.width}x${asset.height}`, asset.relativePath, statSync(resolve(store.dataDir, asset.relativePath)).size, "bytes", asset.video ? JSON.stringify(asset.video) : asset.audio ? JSON.stringify(asset.audio) : "");
        console.log("ASSET_PATH=" + resolve(store.dataDir, asset.relativePath));
      }
    }
  });
  await new Promise((r) => setTimeout(r, 25_000));
  const after = await balance();
  log(`credits: ${before.toFixed(0)} -> ${after.toFixed(0)} (${(before - after).toFixed(0)} spent)`);
}
main().catch((error) => { console.error("FAILED:", error instanceof Error ? error.message : error); process.exit(1); });
