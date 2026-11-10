/** Regenerate one beat's clip, approve the first non-black candidate, and re-export. Usage: PROJECT_ID=... BEAT=1 npm run redo-clip */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { withStore } from "@/server/runtime";
import { callTool, createGenerationContext, createToolContext } from "@/server/tools";

for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
type State = { contents: { id: string }[] };
function meanLuma(path: string): number {
  const run = spawnSync("ffmpeg", ["-nostats", "-i", path, "-vf", "select='not(mod(n\\,30))',signalstats,metadata=print:key=lavfi.signalstats.YAVG", "-f", "null", "-"], { encoding: "utf8" });
  const vals = [...(run.stderr + run.stdout).matchAll(/YAVG=([0-9.]+)/g)].map((m) => Number(m[1]));
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
}
async function main() {
  await withStore(async (store) => {
    const pid = process.env.PROJECT_ID!; const beatIndex = Number(process.env.BEAT ?? "1");
    const context = createToolContext(store, createGenerationContext(store));
    const st = await callTool(context, "get_project_state", { projectId: pid });
    if (!st.ok) throw { code: "invalid", message: st.failure.message };
    const content = (st.output as State).contents[0];
    let candidateIds: string[];
    if (process.env.APPROVE_PATH) {
      candidateIds = store.assets.list({ projectId: pid }).filter((a) => a.relativePath === process.env.APPROVE_PATH).map((a) => a.id);
    } else {
      const proposal = await callTool(context, "generate_clip", { contentId: content.id, beatIndex, count: 2 });
      if (!proposal.ok) throw { code: "invalid", message: proposal.failure.message };
      const submitted = await callTool(context, "submit_proposal", { proposal: proposal.output, wait: true, confirmUnquoted: true });
      if (!submitted.ok) throw { code: "invalid", message: submitted.failure.message };
      const { results } = submitted.output as { results: { outcome: string; message: string | null; assetIds: string[] }[] };
      candidateIds = results.flatMap((r) => r.assetIds);
    }
    let chosen: string | undefined;
    for (const id of candidateIds) {
      const asset = store.assets.get(id)!; const luma = meanLuma(resolve(store.dataDir, asset.relativePath));
      console.log("candidate", asset.relativePath, "mean luma", luma.toFixed(1));
      if (!chosen && luma > 4) chosen = id;
    }
    if (!chosen) throw { code: "invalid", message: "every candidate was black" };
    const approved = await callTool(context, "approve", { kind: "clip", assetId: chosen, contentId: content.id, beatIndex });
    if (!approved.ok) throw { code: "invalid", message: approved.failure.message };
    const exported = await callTool(context, "assemble_ad", { contentId: content.id, captions: true });
    if (!exported.ok) throw { code: "invalid", message: exported.failure.message };
    const { asset } = exported.output as { asset: { relativePath: string } };
    console.log("EXPORT_PATH=" + resolve(store.dataDir, asset.relativePath));
  });
}
main().catch((error) => { console.error("FAILED:", error instanceof Error ? error.message : JSON.stringify(error)); process.exit(1); });
