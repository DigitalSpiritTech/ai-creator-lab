/**
 * Spike runner: proves each capability on real Comfy accounts and logs cost.
 *
 * Usage: npx tsx scripts/spike/run.ts <t2i-face|t2i-product|edit|ltx|router-edit|router-llm|balance>
 * Reads .env.local, enforces the allowance cap, appends rows to docs/VERIFICATION.md.
 */
import { Comfy, comfy, type Job } from "@comfyorg/sdk";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const out = resolve(root, ".data/spike");
mkdirSync(out, { recursive: true });

// Load .env.local without printing it.
for (const line of readFileSync(resolve(root, ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const apiKey = process.env.COMFY_API_KEY ?? "";
if (!apiKey) throw new Error("COMFY_API_KEY missing");
const CREDITS_PER_CENT = 2.11; // observed: 2604.77 cents == 5,496 credits
const capCents = Math.round(Number(process.env.GENERATION_ALLOWANCE_USD ?? "0") * 100);

async function balanceCents(): Promise<number> {
  const r = await fetch("https://cloud.comfy.org/api/billing/balance", { headers: { "X-API-Key": apiKey } });
  if (!r.ok) throw new Error(`balance http ${r.status}`);
  const j = (await r.json()) as { effective_balance_cents: number };
  return j.effective_balance_cents;
}
const ledgerPath = resolve(out, "ledger.json");
function ledger(): { spentCents: number } {
  return existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")) : { spentCents: 0 };
}
function assertUnderCap() {
  const { spentCents } = ledger();
  if (capCents <= 0) throw new Error("GENERATION_ALLOWANCE_USD is zero; paid runs disabled");
  if (spentCents >= capCents) throw new Error(`cap reached: spent ${spentCents.toFixed(1)}c of ${capCents}c`);
  console.log(`allowance: ${spentCents.toFixed(1)}c spent of ${capCents}c`);
}
function logRow(target: string, recipe: string, inputs: string, result: string, before: number, after: number, ms: number, notes: string) {
  const delta = before - after;
  const l = ledger(); l.spentCents += Math.max(0, delta); writeFileSync(ledgerPath, JSON.stringify(l));
  const credits = (c: number) => (c * CREDITS_PER_CENT).toFixed(0);
  const date = new Date().toLocaleString("en-US", { timeZone: "America/Chicago", hour12: false });
  const row = `| ${date} | spike | ${target} | ${recipe} | ${inputs} | ${result} | ${credits(before)} / ${credits(after)} / ${credits(delta)} (${delta.toFixed(2)}c) | ${(ms / 1000).toFixed(0)}s | ${notes} |\n`;
  const vPath = resolve(root, "docs/VERIFICATION.md");
  let v = readFileSync(vPath, "utf8");
  v = v.replace(/Running total spent: .*\n/, `Running total spent: ${credits(l.spentCents)} credits (${(l.spentCents / 100).toFixed(2)} USD) of the ${credits(capCents)}-credit cap.\n`);
  const marker = "| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n";
  v = v.replace(marker, marker + row);
  writeFileSync(vPath, v);
  console.log(`spent this run: ${credits(delta)} credits (${delta.toFixed(2)}c); running total ${credits(l.spentCents)} credits`);
  const pct = l.spentCents / capCents;
  if (pct >= 0.8) console.log("NOTICE: 80 percent of the cap reached");
  else if (pct >= 0.5) console.log("NOTICE: 50 percent of the cap reached");
}
function probe(file: string): string {
  try {
    const j = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file]).toString());
    const v = j.streams.find((s: { codec_type: string }) => s.codec_type === "video");
    const a = j.streams.find((s: { codec_type: string }) => s.codec_type === "audio");
    return `${v?.width}x${v?.height} ${v?.codec_name}${v?.nb_frames ? ` ${v.nb_frames}f` : ""}${j.format?.duration ? ` ${Number(j.format.duration).toFixed(2)}s` : ""}${a ? ` audio:${a.codec_name}` : ""}`;
  } catch (e) { return `probe failed: ${(e as Error).message.slice(0, 80)}`; }
}
async function runCloud(workflowFile: string, outputNode: string, bind: (wf: { setInput(n: string, f: string, v: unknown): void }, client: Comfy) => void, saveAs: string) {
  const client = new Comfy({ apiKey, clientInfo: "ai-creator-lab-spike" });
  const wf = await client.workflows.fromFile(resolve(root, "workflows", workflowFile));
  bind(wf, client);
  const t0 = Date.now();
  const job = await client.submit(wf, { idempotencyKey: randomUUID() });
  console.log("job", job.id, job.status);
  let last = "";
  const terminal = (st: string) => ["completed", "succeeded", "failed", "cancelled", "canceled", "error", "expired"].includes(st);
  while (!terminal(job.status)) {
    await new Promise(r => setTimeout(r, 5000));
    await job.refresh();
    const p = job.progress ? ` ${JSON.stringify(job.progress).slice(0, 80)}` : "";
    const line = `${job.status}${job.queuePosition != null ? ` queue:${job.queuePosition}` : ""}${p}`;
    if (line !== last) { console.log(`  ${Math.round((Date.now() - t0) / 1000)}s ${line}`); last = line; }
    if (Date.now() - t0 > 20 * 60_000) throw new Error("timeout");
  }
  if (!["completed", "succeeded"].includes(job.status)) throw new Error(`job ${job.status}: ${JSON.stringify(job.error).slice(0, 300)}`);
  const outputs = job.getOutputs(outputNode);
  if (!outputs.length) throw new Error(`no outputs on node ${outputNode}; have ${job.outputs.map(o => o.nodeId + ":" + o.name).join(",")}`);
  const path = resolve(out, saveAs);
  await outputs[0].toFile(path);
  return { ms: Date.now() - t0, path, jobId: job.id, metrics: job.metrics };
}

const prompts = {
  face: "Three-quarter view portrait of a woman in her early thirties, warm direct expression with a hint of a smile, light freckles, dark shoulder-length hair tied back, small silver hoop earrings, plain fitted gray tee, soft natural window light, plain light gray background, photographic, 85mm look, sharp focus on the eyes, visible catchlights in both eyes, natural skin texture, no text.",
  product: "Product photograph of a matte dark green 32 oz insulated steel water bottle with a black screw cap, standing upright on a light wooden kitchen counter by a window, soft morning light, light condensation on the steel, plain uncluttered background, no text, no logo.",
  compose: "Place the woman from image 1 at a bright kitchen counter by a window, holding the water bottle from image 2 in her right hand near her chest, looking at the camera mid-sentence with an easy smile. Vertical 9:16 phone framing from the waist up. Preserve the woman's identity, face, hair, freckles, and earrings exactly. Preserve the bottle's dark green color, black cap, and shape exactly. Natural morning light, photographic. No text.",
  clip: "A woman in her early thirties with dark hair tied back stands at a bright kitchen counter holding a dark green steel water bottle, speaking to the camera with an easy smile, small natural head movement, static phone camera, soft morning light, quiet kitchen ambience. She says, \"Twenty-four hours later it was still cold. I checked.\" No text on screen. Her face and clothing stay consistent.",
};

const step = process.argv[2];
if (step === "fetch") {
  const [, , , jobId, node, saveAs] = process.argv;
  const client = new Comfy({ apiKey });
  const job = await client.jobs.get(jobId);
  console.log("job", job.id, job.status, "outputs:", job.outputs.map(o => o.nodeId + ":" + o.name).join(","));
  const path = resolve(out, saveAs);
  await job.getOutputs(node)[0].toFile(path);
  console.log("saved", path, probe(path), "metrics:", JSON.stringify(job.metrics));
  process.exit(0);
}
if (step === "balance") { const b = await balanceCents(); console.log(`balance ${b.toFixed(2)}c = ${(b * CREDITS_PER_CENT).toFixed(0)} credits`); process.exit(0); }
assertUnderCap();
const before = await balanceCents();
console.log(`balance before: ${(before * CREDITS_PER_CENT).toFixed(0)} credits`);
try {
  if (step === "t2i-face" || step === "t2i-product") {
    const which = step === "t2i-face" ? "face" : "product";
    const r = await runCloud("z-image-turbo-t2i.api.json", "9", wf => { wf.setInput("4", "text", prompts[which]); wf.setInput("6", "width", 1024); wf.setInput("6", "height", 1024); wf.setInput("8", "seed", which === "face" ? 7 : 11); }, `${which}.png`);
    const after = await balanceCents();
    logRow("cloud", "z-image-turbo-t2i", `prompt:${which}`, `${r.path.replace(root + "/", "")} ${probe(r.path)}`, before, after, r.ms, `job ${r.jobId}`);
  } else if (step === "edit") {
    const r = await runCloud("qwen-image-edit-2511-2ref.api.json", "9", (wf, client) => {
      wf.setInput("20", "image", client.assets.fromFile(resolve(out, "face.png")));
      wf.setInput("21", "image", client.assets.fromFile(resolve(out, "product.png")));
      wf.setInput("4", "prompt", prompts.compose); wf.setInput("8", "seed", 3);
    }, "composite.png");
    const after = await balanceCents();
    logRow("cloud", "qwen-image-edit-2511-2ref", "face.png + product.png", `${r.path.replace(root + "/", "")} ${probe(r.path)}`, before, after, r.ms, `job ${r.jobId}`);
  } else if (step === "ltx") {
    const r = await runCloud("ltx-2.5-i2v.api.json", "9", (wf, client) => {
      wf.setInput("22", "image", client.assets.fromFile(resolve(out, "composite-576x1024.png")));
      wf.setInput("5", "text", prompts.clip); wf.setInput("12", "noise_seed", 5);
    }, "clip.mp4");
    const after = await balanceCents();
    logRow("cloud", "ltx-2.5-i2v", "composite.png", `${r.path.replace(root + "/", "")} ${probe(r.path)}`, before, after, r.ms, `job ${r.jobId}`);
  } else if (step === "router-edit") {
    comfy.config({ credentials: apiKey });
    const b64 = (f: string) => readFileSync(resolve(out, f)).toString("base64");
    const t0 = Date.now();
    const res = await comfy.models.run("vertexai/gemini-nano-banana-2.1", {
      contents: [{ role: "user", parts: [{ text: prompts.compose }, { inlineData: { mimeType: "image/png", data: b64("face.png") } }, { inlineData: { mimeType: "image/png", data: b64("product.png") } }] }],
      generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "9:16", imageSize: "1K", imageOutputOptions: { mimeType: "image/png" } } },
      uploadImagesToStorage: true,
    }, { idempotencyKey: randomUUID() });
    const ms = Date.now() - t0;
    if (res.kind !== "json") throw new Error("expected json");
    const data = res.data as { candidates: { content: { parts: { thought?: boolean; fileData?: { fileUri: string }; inlineData?: { data: string } }[] } }[] };
    const part = data.candidates[0].content.parts.find(p => !p.thought && (p.fileData || p.inlineData));
    if (!part) throw new Error("no image part: " + JSON.stringify(data).slice(0, 300));
    const bytes = part.fileData ? new Uint8Array(await (await fetch(part.fileData.fileUri)).arrayBuffer()) : Buffer.from(part.inlineData!.data, "base64");
    const path = resolve(out, "router-composite.png"); writeFileSync(path, bytes);
    const after = await balanceCents();
    logRow("router", "vertexai/gemini-nano-banana-2.1", "face.png + product.png", `${path.replace(root + "/", "")} ${probe(path)}`, before, after, ms, `request ${res.requestId}`);
  } else if (step === "router-llm") {
    comfy.config({ credentials: apiKey });
    const t0 = Date.now();
    const res = await comfy.models.run("anthropic/claude-opus-5-5", { model: "claude-opus-5-5", max_tokens: 120, messages: [{ role: "user", content: "In one sentence, what makes a good UGC hook for an insulated water bottle? Reply with JSON {\"hook\": string}." }] }, { idempotencyKey: randomUUID() });
    const ms = Date.now() - t0;
    console.log("router llm reply:", JSON.stringify(res.data).slice(0, 400));
    const after = await balanceCents();
    logRow("router", "anthropic/claude-opus-5-5", "120 token prompt", "json reply received", before, after, ms, `request ${res.requestId}`);
  } else {
    throw new Error("unknown step");
  }
} catch (e) {
  const after = await balanceCents().catch(() => before);
  console.error("FAILED:", (e as Error).message);
  logRow(step.startsWith("router") ? "router" : "cloud", step, "", `FAILED: ${(e as Error).message.slice(0, 200).replace(/\|/g, "/")}`, before, after, 0, "");
  process.exit(1);
}
