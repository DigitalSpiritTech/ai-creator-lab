/**
 * Live check: one real face candidate through the tools, run orchestration, executors, and store.
 * Usage: npx tsx scripts/live-check.ts   (spends about 2 credits; needs .env.local)
 */
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { withStore } from "@/server/runtime";
import { callTool, createGenerationContext, createToolContext } from "@/server/tools";

for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const prompt =
  "Portrait of a woman in her early thirties, head turned about thirty degrees to her left so the far cheek narrows and the near ear shows, eyes toward the camera, warm direct expression with a hint of a smile, light freckles, dark shoulder-length hair tied back, small silver hoop earrings, plain fitted gray tee, soft natural window light, plain light gray background, photographic, 85mm look, sharp focus on the eyes, visible catchlights in both eyes, natural skin texture, no text.";

async function main() {
  await withStore(async (store) => {
  const now = Date.now();
  const project = store.projects.create({ id: randomUUID(), appId: "ugc-creator", name: "Live check", brief: null, revision: 0, createdAt: now, updatedAt: now });
  store.workspace.update({ allowanceUsd: 5 }, now);
  const context = createToolContext(store, createGenerationContext(store));
  const proposed = await callTool(context, "propose_candidates", { projectId: project.id, capability: "text_to_image", prompt, count: 1, aspectRatio: "4:5", target: { kind: "loose" } });
  if (!proposed.ok) throw new Error(`propose failed: ${proposed.failure.message}`);
  const proposal = proposed.output as { recipeTitle: string; estimate: unknown };
  console.log("proposal:", proposal.recipeTitle, JSON.stringify(proposal.estimate));
  const t0 = Date.now();
  const submitted = await callTool(context, "submit_proposal", { proposal: proposed.output, wait: true });
  if (!submitted.ok) throw new Error(`submit failed: ${submitted.failure.message}`);
  const { results } = submitted.output as { results: { outcome: string; message: string | null; assetIds: string[]; job: { id: string; status: string; creditsUsed: number | null } | null }[] };
  for (const r of results) {
    console.log("result:", r.outcome, r.message ?? "", "job", r.job?.id, r.job?.status, "credits", r.job?.creditsUsed, `${Math.round((Date.now() - t0) / 1000)}s`);
    for (const id of r.assetIds) {
      const asset = store.assets.get(id)!;
      const path = resolve(store.dataDir, asset.relativePath);
      console.log("asset:", asset.kind, asset.width + "x" + asset.height, asset.relativePath, statSync(path).size, "bytes", "sha", asset.sha256.slice(0, 12));
    }
  }
  const state = await callTool(context, "get_project_state", { projectId: project.id });
  console.log("project state ok:", state.ok, "assets in project:", store.assets.list({ projectId: project.id }).length);
});
}

main().catch((error) => {
  console.error("FAILED:", error instanceof Error ? error.message : error);
  process.exit(1);
});
