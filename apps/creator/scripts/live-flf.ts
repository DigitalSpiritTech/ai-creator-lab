/** Live check of the first/last-frame LTX recipe on an existing project. Usage: PROJECT_ID=... npm run live-flf (about 10 credits). */
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { withStore } from "@/server/runtime";
import { callTool, createGenerationContext, createToolContext } from "@/server/tools";

for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
type State = { contents: { id: string; shots: { beatIndex: number; still: { state: string; assetId?: string } }[] }[] };

async function main() {
  const t0 = Date.now();
  await withStore(async (store) => {
    const pid = process.env.PROJECT_ID!;
    const context = createToolContext(store, createGenerationContext(store));
    const stateResult = await callTool(context, "get_project_state", { projectId: pid });
    if (!stateResult.ok) throw { code: "invalid", message: stateResult.failure.message };
    const content = (stateResult.output as State).contents[0];
    const approved = content.shots.filter((s) => s.still.state === "approved").sort((a, b) => a.beatIndex - b.beatIndex);
    const first = approved[0]; const last = approved[approved.length - 1];
    console.log("start beat", first.beatIndex, "end beat", last.beatIndex);
    const proposal = await callTool(context, "generate_clip", { contentId: content.id, beatIndex: first.beatIndex, mode: "first_last", lastAssetId: last.still.assetId, count: 1 });
    if (!proposal.ok) throw { code: "invalid", message: proposal.failure.message };
    const p = proposal.output as { recipeTitle: string; estimate: unknown; references: unknown[] };
    console.log("proposal:", p.recipeTitle, JSON.stringify(p.estimate), "references", p.references.length);
    const submitted = await callTool(context, "submit_proposal", { proposal: proposal.output, wait: true, confirmUnquoted: true });
    if (!submitted.ok) throw { code: "invalid", message: submitted.failure.message };
    const { results } = submitted.output as { results: { outcome: string; message: string | null; assetIds: string[] }[] };
    for (const r of results) console.log("result:", r.outcome, r.message ?? "", `${Math.round((Date.now() - t0) / 1000)}s`);
    for (const id of results.flatMap((r) => r.assetIds)) {
      const asset = store.assets.get(id)!; const path = resolve(store.dataDir, asset.relativePath);
      const probe = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height,nb_frames", "-of", "csv=p=0", path]).toString().trim().replace(/\n/g, " | ");
      console.log("asset:", asset.relativePath, statSync(path).size, "bytes", probe);
      console.log("CLIP_PATH=" + path);
    }
  });
}
main().catch((error) => { console.error("FAILED:", error instanceof Error ? error.message : JSON.stringify(error)); process.exit(1); });
