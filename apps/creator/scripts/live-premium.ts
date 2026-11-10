/**
 * Live check for the hosted premium recipes (Nano Banana Pro, Kling 3.0 Omni) through the tools layer.
 * Usage: STEP=still|clip|face [PROJECT_ID=...] [RECIPE=...] npm run live-premium
 *   still: compose_still for beat 1 of PROJECT_ID (default recipe router-nano-banana-pro-edit)
 *   clip:  generate_clip for beat 2 of PROJECT_ID (default recipe router-kling-3-omni-i2v)
 *   face:  propose_candidates text_to_image in a new "Premium check" project (default router-nano-banana-pro-t2i)
 * The proposal is cached under .data/spike so a cut-off call can be rerun; resubmitting it is idempotent.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { withStore } from "@/server/runtime";
import { callTool, createGenerationContext, createToolContext } from "@/server/tools";

for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const CREDITS_PER_CENT = 2.11;
async function balanceCents(): Promise<number> {
  const res = await fetch("https://cloud.comfy.org/api/billing/balance", { headers: { "X-API-Key": process.env.COMFY_API_KEY ?? "" } });
  const data = (await res.json()) as { effective_balance_cents?: number };
  return Number(data.effective_balance_cents ?? 0);
}
const t0 = Date.now();
const log = (...parts: unknown[]) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s]`, ...parts);

async function main() {
  const step = process.env.STEP ?? "still";
  const cacheDir = resolve(process.cwd(), ".data/spike");
  mkdirSync(cacheDir, { recursive: true });
  const cachePath = resolve(cacheDir, `premium-${step}.json`);
  const before = await balanceCents();
  log(`balance before: ${(before * CREDITS_PER_CENT).toFixed(0)} credits`);
  await withStore(async (store) => {
    const context = createToolContext(store, createGenerationContext(store));
    const tool = async <T,>(name: string, input: unknown): Promise<T> => {
      const result = await callTool(context, name, input);
      if (!result.ok) throw new Error(`${name}: ${result.failure.code} ${result.failure.message}`);
      return result.output as T;
    };
    let proposal: unknown;
    if (existsSync(cachePath)) {
      proposal = JSON.parse(readFileSync(cachePath, "utf8"));
      log("resuming cached proposal");
    } else if (step === "face") {
      const now = Date.now();
      const project = store.projects.create({ id: randomUUID(), appId: "ugc-creator", name: "Premium check", brief: null, revision: 0, createdAt: now, updatedAt: now });
      console.log("PROJECT_ID=" + project.id);
      const prompt =
        "Portrait of a man in his late thirties, head turned about thirty degrees to his right so the far cheek narrows and the near ear shows, eyes toward the camera, calm confident expression, short dark hair with a little gray at the temples, trimmed beard, plain navy crew-neck tee, soft natural window light, plain warm off-white background, photographic, 85mm look, sharp focus on the eyes, visible catchlights, natural skin texture, no text.";
      proposal = await tool("propose_candidates", { projectId: project.id, capability: "text_to_image", prompt, count: 1, aspectRatio: "4:5", recipeId: process.env.RECIPE ?? "router-nano-banana-pro-t2i", target: { kind: "loose" } });
    } else {
      const projectId = process.env.PROJECT_ID;
      if (!projectId) throw new Error("PROJECT_ID is required for still and clip.");
      const state = await tool<{ contents: { id: string }[] }>("get_project_state", { projectId });
      const content = state.contents[0];
      if (!content) throw new Error("The project has no content.");
      proposal =
        step === "clip"
          ? await tool("generate_clip", { contentId: content.id, beatIndex: 2, count: 1, recipeId: process.env.RECIPE ?? "router-kling-3-omni-i2v" })
          : await tool("compose_still", { contentId: content.id, beatIndex: 1, count: 1, recipeId: process.env.RECIPE ?? "router-nano-banana-pro-edit" });
    }
    const p = proposal as { recipeTitle: string; estimate: unknown; prompt?: string };
    log("proposal:", p.recipeTitle, JSON.stringify(p.estimate));
    writeFileSync(cachePath, JSON.stringify(proposal));
    const { results } = await tool<{ results: { outcome: string; message: string | null; assetIds: string[]; job: { id: string; status: string; creditsUsed: number | null } | null }[] }>(
      "submit_proposal",
      { proposal, wait: true, confirmUnquoted: true },
    );
    for (const r of results) {
      log("result:", r.outcome, r.message ?? "", "job", r.job?.id, r.job?.status, "credits", r.job?.creditsUsed);
      for (const id of r.assetIds) {
        const asset = store.assets.get(id)!;
        const path = resolve(store.dataDir, asset.relativePath);
        console.log("asset:", asset.kind, asset.width + "x" + asset.height, asset.relativePath, statSync(path).size, "bytes");
      }
      if (r.outcome === "completed") writeFileSync(cachePath + ".done", "1");
    }
  });
  await new Promise((r) => setTimeout(r, 20_000));
  const after = await balanceCents();
  log(`balance after: ${(after * CREDITS_PER_CENT).toFixed(0)} credits; delta ${((before - after) * CREDITS_PER_CENT).toFixed(0)} credits (${(before - after).toFixed(2)}c)`);
}
main().catch((error) => {
  console.error("FAILED:", error instanceof Error ? error.message : error);
  process.exit(1);
});
