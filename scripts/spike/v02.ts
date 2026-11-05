/**
 * The v0.2 spike: Krea 2 as the character-start recipe and the MiniMax H3 checks (dialogue against
 * LTX, the multi-frame graph, a two-segment chain, H3 Max on Router), through the real tool path
 * (proposal, gate, executor, store) on a fresh spike data directory.
 *
 * Usage:
 *   DRY_RUN=1 npm run spike:v02            offline: resolve, validate and price every step, then exit
 *   npm run spike:v02                       live, every step (needs .env.local, see below)
 *   STEPS=krea,h3-dialogue npm run spike:v02
 *
 * Live runs need COMFY_API_KEY and GENERATION_ALLOWANCE_USD above zero in .env.local, both set by the
 * maintainer; this script never writes either. SPIKE_CAP_CREDITS (default 420, about 2 USD) caps the
 * whole spike across invocations (ledger in .data/spike/v02/ledger.json). The Cloud balance is read
 * before and after every paid run (it lags about a minute, so each read waits BALANCE_SETTLE_MS,
 * default 65 s); a run whose ceiling would cross the cap is not started; notes print at 50 and 80
 * percent. A paid submit is never retried: the allowance admits exactly one job per planned run, so
 * the app's automatic black-output retry is refused. Inputs: STILL, KEYFRAMES, KEYFRAME_NOTES,
 * KEYFRAME_SECONDS, MULTIFRAME_SECONDS, SHEET (files under .data/spike/ unless absolute), and
 * SPIKE_SEED (default 42), the one seed every video run uses so the A/B steps (h3-traits against
 * h3-dialogue, ltx-variants against ltx-dialogue) differ only in prompt or setting.
 * SPIKE_STORE=app writes into the app's data directory (STUDIO_DATA_DIR, default .data) instead of a
 * fresh one, reusing a "v0.2 spike" project, so the outputs show in the UI; the app's own allowance
 * (the lower of Settings and GENERATION_ALLOWANCE_USD, against its whole ledger) then applies too.
 * Results go to .data/spike/v02/<run>/ with ready-to-paste VERIFICATION rows and a decisions checklist.
 */
import { Comfy } from "@comfyorg/sdk";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { WorkflowGraphSchema, type Recipe, type WorkflowGraph } from "@/lib/catalog";
import { adapterFor } from "@/server/catalog/router-adapters";
import { createCatalogPort, RouterCatalog } from "@/server/catalog/router-catalog";
import { tagModel } from "@/server/catalog/tagging";
import { z } from "zod";
import { CREDITS_PER_BALANCE_CENT, CREDITS_PER_USD, readAllowanceUsd, readCreditBalance } from "@/server/executors/allowance";
import { ffmpegPath } from "@/server/executors/media";
import { importImage } from "@/server/media/images";
import { checkVideoTools, probeVideo } from "@/server/media/video";
import { childEnv } from "@/server/process";
import { effectiveAllowanceUsd } from "@/lib/domain/workspace";
import { dataDirectory } from "@/server/runtime";
import { openStore, type Store } from "@/server/store";
import { callTool, createGenerationContext, createToolContext, type ToolContext } from "@/server/tools";
import { averyBible } from "../../tests/support/domain-fixtures";
import { buildSpikePlan, DEFAULT_CAP_CREDITS, DERIVED_IMAGE, formatPlan, KREA_RECIPE, parseSteps, spikeInputsFromEnv, type PlannedRun, type PlannedStep, type SpikePlan } from "./v02-plan";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");
const workflowsDir = resolve(root, "workflows");
const spikeDir = resolve(root, ".data/spike");
const v02Dir = resolve(spikeDir, "v02");
const t0 = Date.now();
const log = (...parts: unknown[]) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s]`, ...parts);

/** A file under .data/spike/ unless the name is absolute. */
function inputPath(name: string): string {
  return isAbsolute(name) ? name : resolve(spikeDir, name);
}

function chicagoTime(ms = Date.now()): string {
  return new Date(ms).toLocaleString("sv-SE", { timeZone: "America/Chicago", hour12: false }).slice(0, 16);
}

/** Loads .env.local into the environment without printing it; never creates it. */
function loadEnvLocal(): boolean {
  const path = resolve(root, ".env.local");
  if (!existsSync(path)) return false;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]]) continue;
    const quoted = match[2].match(/^(["'])(.*)\1$/);
    process.env[match[1]] = quoted ? quoted[2] : match[2];
  }
  return true;
}

function cloudOrigin(): string | undefined {
  const base = process.env.COMFY_BASE_URL?.trim();
  if (!base) return "https://cloud.comfy.org";
  return /^https:\/\/cloud\.comfy\.org\/?$/.test(base) ? "https://cloud.comfy.org" : undefined;
}

/** The Cloud balance in credits, through the app's reader (timeout, schema, no redirects). */
async function balanceCredits(apiKey: string): Promise<number> {
  const { cents } = await readCreditBalance(apiKey);
  return Math.round(cents * CREDITS_PER_BALANCE_CENT * 100) / 100;
}

const LedgerSchema = z.object({ spentCredits: z.number().nonnegative(), runs: z.number().int().nonnegative() });
type Ledger = z.infer<typeof LedgerSchema>;

const ledgerPath = resolve(v02Dir, "ledger.json");

/** The spend carried across invocations. A ledger that does not parse stops the spike rather than resetting to zero. */
function readLedger(): Ledger {
  if (!existsSync(ledgerPath)) return { spentCredits: 0, runs: 0 };
  const parsed = LedgerSchema.safeParse(JSON.parse(readFileSync(ledgerPath, "utf8")));
  if (!parsed.success) throw new Error(`${ledgerPath} is not a valid spike ledger; fix or remove it after checking the balance.`);
  return parsed.data;
}

/**
 * The spend guard: what the spike has spent (from the balance, across invocations) plus the
 * ceilings of runs not yet settled must stay under the cap before a run starts.
 */
class Budget {
  private last = 0;
  private pendingCredits = 0;
  /** Charged in this invocation: each run's balance drop, or its ceiling when the balance has not moved yet. */
  private charged = 0;
  private readonly noticed = new Set<number>();
  readonly ledger: Ledger;

  constructor(
    readonly capCredits: number,
    private readonly read: () => Promise<number>,
    private readonly settleMs: number,
  ) {
    this.ledger = readLedger();
  }

  async open(): Promise<number> {
    this.last = await this.read();
    log(`balance ${this.last.toFixed(0)} credits; spike spent so far ${this.ledger.spentCredits.toFixed(0)} of ${this.capCredits}`);
    return this.last;
  }

  get balance(): number {
    return this.last;
  }

  /**
   * Spent across every spike invocation. A run whose balance drop has not shown yet (the balance
   * lags) is charged at its ceiling, so a lagging read can over-count but never under-count.
   */
  get spent(): number {
    return this.ledger.spentCredits + this.charged;
  }

  allows(ceilingCredits: number): boolean {
    return this.spent + this.pendingCredits + ceilingCredits <= this.capCredits;
  }

  reserve(ceilingCredits: number): void {
    this.pendingCredits += ceilingCredits;
  }

  /** Waits out the balance lag, reads it, charges the run (its drop, or its ceiling if none shows), and returns the new balance. */
  async settle(ceilingCredits: number): Promise<number> {
    await new Promise((done) => setTimeout(done, this.settleMs));
    const before = this.last;
    try {
      this.last = await this.read();
    } catch (cause) {
      this.charged += ceilingCredits;
      this.pendingCredits = 0;
      writeFileSync(ledgerPath, JSON.stringify({ spentCredits: this.spent, runs: this.ledger.runs }, null, 2));
      throw cause;
    }
    const drop = before - this.last;
    if (drop <= 0) log(`the balance has not moved yet; charging this run its ceiling (${ceilingCredits} credits) so the cap stays safe`);
    this.charged += drop > 0 ? drop : ceilingCredits;
    this.pendingCredits = 0;
    const total = this.spent;
    writeFileSync(ledgerPath, JSON.stringify({ spentCredits: total, runs: this.ledger.runs }, null, 2));
    for (const share of [0.5, 0.8]) {
      if (total >= share * this.capCredits && !this.noticed.has(share)) {
        this.noticed.add(share);
        log(`NOTE: the spike has spent ${total.toFixed(0)} credits, ${share * 100} percent of its ${this.capCredits}-credit cap.`);
      }
    }
    return this.last;
  }

  close(): void {
    writeFileSync(ledgerPath, JSON.stringify({ spentCredits: this.spent, runs: this.ledger.runs + 1 }, null, 2));
  }
}

/** The allowance the run path reads once per admission: one token per planned run, zero otherwise. */
class SubmitGate {
  private tokens = 0;

  constructor(private readonly allowanceUsd: number) {}

  admitOne(): void {
    this.tokens = 1;
  }

  close(): void {
    this.tokens = 0;
  }

  readonly allowance = (): number => {
    if (this.tokens <= 0) return 0;
    this.tokens -= 1;
    return this.allowanceUsd;
  };
}

interface RunRecord {
  step: string;
  label: string;
  recipeId: string;
  inputs: string;
  outcome: string;
  message: string | null;
  assetPath: string | null;
  probe: string;
  jobId: string | null;
  providerRef: string | null;
  metrics: Record<string, unknown> | null;
  before: number;
  after: number;
  deltaCredits: number;
  durationMs: number;
  ceilingCredits: number;
  notes: string[];
}

interface StepRecord {
  id: string;
  status: "done" | "skipped" | "stopped" | "failed";
  reason?: string;
  runs: RunRecord[];
  facts: string[];
}

async function ffmpeg(args: string[]): Promise<void> {
  await execute(ffmpegPath(), ["-nostdin", "-v", "error", "-y", ...args], { env: childEnv(), timeout: 120_000, maxBuffer: 1_000_000 });
}

async function probeLine(path: string): Promise<string> {
  try {
    const probe = await probeVideo(path);
    const video = probe.streams.find((stream) => stream.codec_type === "video");
    const audio = probe.streams.find((stream) => stream.codec_type === "audio");
    return `${video?.width}x${video?.height}, ${video?.nb_read_frames ?? "?"} frames, ${Number(probe.format.duration).toFixed(2)} s${audio ? `, ${audio.codec_name} audio` : ", no audio"}`;
  } catch (cause) {
    return `probe failed: ${cause instanceof Error ? cause.message.slice(0, 120) : String(cause)}`;
  }
}

/** Mean absolute difference of two images as a percent of full scale, at the first one's size. */
async function imageDifference(a: string, b: string): Promise<number> {
  const first = sharp(a).removeAlpha();
  const { width, height } = await first.metadata();
  const left = await first.raw().toBuffer();
  const right = await sharp(b).removeAlpha().resize(width, height, { fit: "fill" }).raw().toBuffer();
  let sum = 0;
  for (let index = 0; index < left.length; index++) sum += Math.abs(left[index] - right[index]);
  return Math.round((sum / left.length / 255) * 10_000) / 100;
}

type ObjectInfo = Record<string, { input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> }; api_node?: boolean }>;

/** Cloud's node catalog (a free read), or undefined when the endpoint does not answer. */
async function fetchObjectInfo(apiKey: string, origin: string): Promise<ObjectInfo | undefined> {
  try {
    const response = await fetch(`${origin}/api/object_info`, { headers: { "X-API-Key": apiKey } });
    if (!response.ok) {
      log(`object_info answered HTTP ${response.status}; node and file checks skipped`);
      return undefined;
    }
    return (await response.json()) as ObjectInfo;
  } catch (cause) {
    log(`object_info unavailable (${cause instanceof Error ? cause.message : String(cause)}); node and file checks skipped`);
    return undefined;
  }
}

function comboOptions(spec: unknown): string[] | undefined {
  if (!Array.isArray(spec)) return undefined;
  if (Array.isArray(spec[0])) return spec[0].filter((value): value is string => typeof value === "string");
  const options = (spec[1] as { options?: unknown } | undefined)?.options;
  return Array.isArray(options) ? options.filter((value): value is string => typeof value === "string") : undefined;
}

/** Each node class with its partner (API) flag, plus model files the Cloud library does not list. */
function graphFacts(graph: WorkflowGraph, info: ObjectInfo): { classes: string[]; missing: string[] } {
  const classes = new Set<string>();
  const missing: string[] = [];
  for (const [id, node] of Object.entries(graph)) {
    const entry = info[node.class_type];
    if (!entry) {
      missing.push(`node ${id} class ${node.class_type} is not on Cloud`);
      continue;
    }
    classes.add(`${node.class_type}${entry.api_node ? " (partner/API node)" : ""}`);
    for (const [field, value] of Object.entries(node.inputs)) {
      if (typeof value !== "string" || !/\.(safetensors|gguf|pt|pth|bin|ckpt)$/.test(value)) continue;
      const options = comboOptions(entry.input?.required?.[field] ?? entry.input?.optional?.[field]);
      if (options && !options.includes(value)) missing.push(`node ${id} ${node.class_type}.${field} ${value} is not in the Cloud library`);
    }
  }
  return { classes: [...classes].sort(), missing };
}

interface Session {
  store: Store;
  context: ToolContext;
  projectId: string;
  characterId: string;
  apiKey: string;
  budget: Budget;
  gate: SubmitGate;
  outDir: string;
  recipes: Recipe[];
  comfy: Comfy;
}

async function tool<T>(context: ToolContext, name: string, input: unknown): Promise<T> {
  const result = await callTool(context, name, input);
  if (!result.ok) throw new Error(`${name}: ${result.failure.code} ${result.failure.message}`);
  return result.output as T;
}

const imported = new Map<string, string>();

async function importReference(session: Session, path: string, name: string): Promise<string> {
  const known = imported.get(path);
  if (known) return known;
  const asset = await importImage(session.store, { projectId: session.projectId, name, bytes: readFileSync(path) }, { now: Date.now(), newId: randomUUID });
  imported.set(path, asset.id);
  return asset.id;
}

type SubmitResult = { outcome: string; message: string | null; assetIds: string[]; job: { id: string; status: string; providerRef?: string | null } | null };

class StopSpike extends Error {}

/**
 * One paid run: the cap check, one admission token, the proposal through submit_proposal with wait,
 * then the settled balance. Anything but completed or failed (an uncertain or unfinished job) stops
 * the spike so nothing is sent again before it is resolved.
 */
async function paidRun(session: Session, step: PlannedStep, run: PlannedRun, propose: () => Promise<unknown>, inputs: string): Promise<RunRecord> {
  const { budget, gate } = session;
  if (!budget.allows(run.ceilingCredits)) {
    throw new StopSpike(`${run.label} would cross the cap: ${budget.spent.toFixed(0)} spent, ceiling ${run.ceilingCredits}, cap ${budget.capCredits}`);
  }
  const before = budget.balance;
  const proposal = await propose();
  const started = Date.now();
  budget.reserve(run.ceilingCredits);
  gate.admitOne();
  let result: SubmitResult;
  try {
    ({ results: [result] } = await tool<{ results: SubmitResult[] }>(session.context, "submit_proposal", { proposal, wait: true, confirmUnquoted: true }));
  } catch (cause) {
    // The request may have left the process, so the spend is unknown: settle and stop, never resend.
    gate.close();
    await budget.settle(run.ceilingCredits).catch(() => undefined);
    throw new StopSpike(`${run.label}: submit_proposal failed (${cause instanceof Error ? cause.message : String(cause)}); check the jobs in ${session.store.dataDir} before running again.`);
  } finally {
    gate.close();
  }
  const durationMs = Date.now() - started;
  const after = await budget.settle(run.ceilingCredits);
  const record: RunRecord = {
    step: step.id,
    label: run.label,
    recipeId: run.recipeId,
    inputs,
    outcome: result.outcome,
    message: result.message,
    assetPath: null,
    probe: "",
    jobId: result.job?.id ?? null,
    providerRef: result.job?.providerRef ?? null,
    metrics: null,
    before,
    after,
    deltaCredits: Math.round((before - after) * 100) / 100,
    durationMs,
    ceilingCredits: run.ceilingCredits,
    notes: [],
  };
  log(`${run.label}: ${result.outcome}${result.message ? ` (${result.message})` : ""}, ${record.deltaCredits} credits, ${Math.round(durationMs / 1000)} s`);
  if (record.providerRef) {
    try {
      const job = await session.comfy.jobs.get(record.providerRef);
      record.metrics = (job.metrics as Record<string, unknown> | undefined) ?? null;
    } catch {
      record.notes.push("job metrics unavailable");
    }
  }
  const assetId = result.assetIds[0];
  if (assetId) {
    const asset = session.store.assets.getRequired(assetId);
    record.assetPath = resolve(session.store.dataDir, asset.relativePath);
    record.probe = asset.kind === "video" ? await probeLine(record.assetPath) : `${asset.width}x${asset.height} still`;
  }
  if (result.outcome !== "completed" && result.outcome !== "failed") {
    throw Object.assign(new StopSpike(`${run.label} ended ${result.outcome} (job ${record.jobId}, status ${result.job?.status}); resolve it before running again. Nothing was resubmitted.`), { record });
  }
  return record;
}

function referenceIds(session: Session, run: PlannedRun, derived?: string): Promise<string[]> {
  return Promise.all(run.images.map((name) => (name === DERIVED_IMAGE ? Promise.resolve(derived!) : importReference(session, inputPath(name), name))));
}

function proposeVideo(session: Session, run: PlannedRun, referenceAssetIds: string[]): () => Promise<unknown> {
  return () =>
    tool(session.context, "propose_candidates", {
      projectId: session.projectId,
      capability: run.capability,
      recipeId: run.recipeId,
      prompt: run.prompt,
      referenceAssetIds,
      count: 1,
      aspectRatio: run.aspectRatio,
      ...(run.durationSeconds ? { durationSeconds: run.durationSeconds } : {}),
      ...(run.slots ? { slots: run.slots } : {}),
      ...(run.seed !== undefined ? { seed: run.seed } : {}),
      target: { kind: "loose" },
    });
}

async function copyOut(session: Session, record: RunRecord, name: string): Promise<string | undefined> {
  if (!record.assetPath) return undefined;
  const target = join(session.outDir, name);
  await copyFile(record.assetPath, target);
  return target;
}

async function runKrea(session: Session, step: PlannedStep, record: StepRecord, info: ObjectInfo | undefined): Promise<void> {
  const recipe = session.recipes.find((entry) => entry.id === KREA_RECIPE);
  if (info && recipe?.kind === "workflow") {
    const graph = WorkflowGraphSchema.parse(JSON.parse(readFileSync(join(workflowsDir, recipe.file), "utf8")));
    const facts = graphFacts(graph, info);
    record.facts.push(`Krea graph node classes on Cloud: ${facts.classes.join(", ")}`);
    record.facts.push(facts.classes.some((name) => name.includes("partner")) ? "billing: the graph has a partner/API node class" : "billing: no partner/API node class in the graph, so plan compute is expected");
  }
  for (const [index, run] of step.runs.entries()) {
    const done = await paidRun(
      session,
      step,
      run,
      async () => {
        const proposal = await tool<{ prompt: string; recipeId: string }>(session.context, "generate_face_candidates", { projectId: session.projectId, characterId: session.characterId, recipeId: KREA_RECIPE, count: 1 });
        if (proposal.recipeId !== KREA_RECIPE || proposal.prompt !== run.prompt) throw new Error("generate_face_candidates did not build the Krea face prompt the plan expects.");
        return proposal;
      },
      "the Krea face-lock prompt for the invented persona (Avery Lane), 1:1",
    );
    await copyOut(session, done, `krea-face-${index + 1}.png`);
    const executionMs = Number(done.metrics?.execution_ms ?? NaN);
    if (Number.isFinite(executionMs) && executionMs > 0) done.notes.push(`${(done.deltaCredits / (executionMs / 1000)).toFixed(3)} credits per execution second`);
    record.runs.push(done);
  }
  const measured = record.runs.filter((run) => run.outcome === "completed").map((run) => run.deltaCredits);
  if (measured.length) {
    const worst = Math.max(...measured);
    const ceilingUsd = Math.max(0.01, Math.ceil(((worst * 1.5) / CREDITS_PER_USD) * 100) / 100);
    record.facts.push(`measured credits per face: ${measured.join(", ")}; suggested ceilingUsd ${ceilingUsd} (1.5x the highest, rounded up)`);
  }
}

/** Each run of the step in order; one run is saved as `<step>.mp4`, several as `<step>-<label>.mp4`. */
async function runSingle(session: Session, step: PlannedStep, record: StepRecord): Promise<void> {
  for (const run of step.runs) await runOne(session, step, record, run, step.runs.length === 1 ? `${step.id}.mp4` : `${step.id}-${run.label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.mp4`);
}

async function runOne(session: Session, step: PlannedStep, record: StepRecord, run: PlannedRun, name: string): Promise<void> {
  const ids = await referenceIds(session, run);
  const settings = [run.slots ? Object.entries(run.slots).map(([key, value]) => `${key}=${value}`).join(" ") : "", run.seed !== undefined ? `seed ${run.seed}` : ""].filter(Boolean).join(", ");
  const done = await paidRun(session, step, run, proposeVideo(session, run, ids), `${run.images.join(" + ")}, ${run.frames} frames at ${run.width}x${run.height}${settings ? `, ${settings}` : ""}`);
  const copied = await copyOut(session, done, name);
  record.runs.push(done);
  if (copied && step.id === "h3-multiframe" && run.slots && run.frames) {
    const sheet = join(session.outDir, "h3-multiframe-cuts.png");
    const frames = [0, run.slots.image2Frame, run.slots.image3Frame, run.frames - 1];
    await ffmpeg(["-i", copied, "-vf", `select='${frames.map((frame) => `eq(n\\,${frame})`).join("+")}',scale=240:-2,tile=${frames.length}x1`, "-frames:v", "1", "-fps_mode", "vfr", sheet]);
    record.facts.push(`contact sheet at frames ${frames.join(", ")}: ${sheet}`);
  }
}

async function runChain(session: Session, step: PlannedStep, record: StepRecord): Promise<void> {
  const [first, second] = step.runs;
  const one = await paidRun(session, step, first, proposeVideo(session, first, await referenceIds(session, first)), `${first.images[0]}, ${first.frames} frames`);
  record.runs.push(one);
  const segment1 = await copyOut(session, one, "h3-chain-1.mp4");
  if (one.outcome !== "completed" || !segment1) {
    record.status = "failed";
    record.reason = "segment 1 did not complete, so segment 2 was not started";
    return;
  }
  const lastFrame = join(session.outDir, "h3-chain-1-last.png");
  await ffmpeg(["-sseof", "-0.5", "-i", segment1, "-map", "0:v:0", "-update", "1", "-f", "image2", "-c:v", "png", lastFrame]);
  const lastId = await importReference(session, lastFrame, "h3-chain-1-last.png");
  const two = await paidRun(session, step, second, proposeVideo(session, second, await referenceIds(session, second, lastId)), `segment 1's last frame, ${second.frames} frames`);
  record.runs.push(two);
  const segment2 = await copyOut(session, two, "h3-chain-2.mp4");
  if (two.outcome !== "completed" || !segment2) {
    record.status = "failed";
    record.reason = "segment 2 did not complete";
    return;
  }
  const firstFrame = join(session.outDir, "h3-chain-2-first.png");
  await ffmpeg(["-i", segment2, "-map", "0:v:0", "-frames:v", "1", "-update", "1", "-f", "image2", "-c:v", "png", firstFrame]);
  const seam = await imageDifference(lastFrame, firstFrame);
  record.facts.push(`seam difference between segment 1's last frame and segment 2's first frame: ${seam} percent of full scale`);
  const frames1 = Number((await probeVideo(segment1)).streams.find((stream) => stream.codec_type === "video")?.nb_read_frames ?? 0);
  const duration1 = Number((await probeVideo(segment1)).format.duration);
  const hardCut = join(session.outDir, "h3-chain-hardcut.mp4");
  await ffmpeg([
    "-i", segment1, "-i", segment2,
    "-filter_complex", "[1:v]trim=start_frame=1,setpts=PTS-STARTPTS[v1];[1:a]atrim=start=0.041667,asetpts=PTS-STARTPTS[a1];[0:v][0:a][v1][a1]concat=n=2:v=1:a=1[v][a]",
    "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", hardCut,
  ]);
  const crossfade = join(session.outDir, "h3-chain-crossfade.mp4");
  const offset = Math.max(0, duration1 - 0.25).toFixed(3);
  await ffmpeg([
    "-i", segment1, "-i", segment2,
    "-filter_complex", `[0:v]settb=AVTB,fps=24[a0];[1:v]settb=AVTB,fps=24[b0];[a0][b0]xfade=transition=fade:duration=0.25:offset=${offset}[v];[0:a][1:a]acrossfade=d=0.25[a]`,
    "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", crossfade,
  ]);
  const seamSheet = join(session.outDir, "h3-chain-seam.png");
  await ffmpeg(["-i", hardCut, "-vf", `select='between(n\\,${Math.max(0, frames1 - 4)}\\,${frames1 + 3})',scale=240:-2,tile=8x1`, "-frames:v", "1", "-fps_mode", "vfr", seamSheet]);
  record.facts.push(`stitched: hard cut ${hardCut} (${await probeLine(hardCut)}), 0.25 s crossfade ${crossfade} (${await probeLine(crossfade)}), seam contact sheet ${seamSheet} (four frames each side of the cut)`);
}

async function runRouter(session: Session, record: StepRecord): Promise<void> {
  const catalog = new RouterCatalog({ port: createCatalogPort(session.apiKey), dataDir: session.outDir });
  const models = await catalog.models({ refresh: true });
  const minimax = models.filter((model) => model.provider === "minimax" || /minimax|hailuo/i.test(model.id));
  record.facts.push(`Router lists ${models.length} models; MiniMax: ${minimax.map((model) => model.id).join(", ") || "none"}`);
  const candidates: string[] = [];
  for (const model of minimax) {
    let summary: string;
    try {
      const tags = tagModel(model.id, await catalog.schema(model.id, { refresh: true }));
      const takesReference = tags.capabilities.includes("references_to_video") || tags.imageFields.some((field) => /reference/i.test(field));
      const adapter = adapterFor(model.id);
      const buildable = !!adapter?.info.capabilities.includes("references_to_video");
      summary = `${model.id}: capabilities ${tags.capabilities.join(", ") || "none"}; image fields ${tags.imageFields.join(", ") || "none"}; max references ${tags.maxReferences ?? "unstated"}; takes an image reference: ${takesReference ? "yes" : "no"}; adapter builds a reference body: ${buildable ? "yes" : "no"}`;
      if (/max/i.test(model.id) || takesReference) candidates.push(model.id);
      if (buildable && takesReference) summary += "; an adapter exists, so review its ceiling and add a references_to_video run to the plan before spending";
    } catch (cause) {
      summary = `${model.id}: schema read failed (${cause instanceof Error ? cause.message.slice(0, 120) : String(cause)})`;
    }
    record.facts.push(summary);
  }
  const max = minimax.find((model) => /h3.*max|max.*h3/i.test(model.id));
  record.facts.push(max ? `H3 Max is listed as ${max.id}` : "H3 Max: not available on Router (no MiniMax model id names it)");
  record.status = "done";
  record.reason = candidates.length
    ? `not submitted: no adapter in src/server/catalog/router-adapters.ts builds a references_to_video body for ${candidates.join(", ")}`
    : "not available: no MiniMax reference-to-video model on Router; nothing submitted";
}

function verificationRow(run: RunRecord): string {
  const result = run.assetPath ? `${run.assetPath.replace(`${root}/`, "")}, ${run.probe}` : `${run.outcome}${run.message ? `: ${run.message.replaceAll("|", "/")}` : ""}`;
  const metrics = run.metrics ? ` (queue ${Math.round(Number(run.metrics.queue_ms ?? 0) / 1000)} s, exec ${Math.round(Number(run.metrics.execution_ms ?? 0) / 1000)} s)` : "";
  const notes = [`job ${run.providerRef ?? run.jobId ?? "none"}`, `ceiling ${run.ceilingCredits}`, ...run.notes].join("; ");
  return `| ${chicagoTime()} | spike v02 (${run.step}) | cloud | ${run.recipeId} | ${run.inputs} | ${result} | ${run.deltaCredits} (${run.before.toFixed(0)} to ${run.after.toFixed(0)}) | ${Math.round(run.durationMs / 1000)} s${metrics} | ${notes.replaceAll("|", "/")} |`;
}

function decisions(steps: StepRecord[]): string {
  const facts = (id: string) => steps.find((step) => step.id === id)?.facts ?? [];
  const runs = (id: string) => steps.find((step) => step.id === id)?.runs ?? [];
  const brief = (id: string) => runs(id).map((run) => `${run.label} ${run.outcome}, ${run.deltaCredits} credits, ${Math.round(run.durationMs / 1000)} s${run.assetPath ? `, ${run.assetPath}` : ""}`).join("; ") || "not run";
  return [
    "# v0.2 spike decisions (tick one option per line after watching the outputs)",
    "",
    `- [ ] Talking beats over 5 s: native H3 multi-shot / chaining. Multi-frame: ${brief("h3-multiframe")}. ${facts("h3-multiframe").join(" ")} Chain: ${brief("h3-chain")}. ${facts("h3-chain").join(" ")}`,
    `- [ ] Microdrama on H3: yes / no. H3 dialogue: ${brief("h3-dialogue")}. LTX baseline: ${brief("ltx-dialogue")}. Compare speech clarity, lip sync and identity by ear and eye.`,
    `- [ ] Restated traits exaggerate on H3: yes / no (same still and seed). Reference-only: ${brief("h3-dialogue")}. With traits: ${brief("h3-traits")}. If yes, first-frame prompts stay reference-only everywhere.`,
    `- [ ] LTX start-image prompt and settings: keep the new prompt yes / no; strength 0.85 / 0.7; CRF 0 / 18 (change workflows/ltx-2.5-i2v.api.json node 24 strength and node 23 img_compression). New prompt at 0.85 and CRF 0: ${brief("ltx-dialogue")}. Variants: ${brief("ltx-variants")}.`,
    `- [ ] Krea 2 as the default character start: yes / no. ${brief("krea")}. ${facts("krea").join(" ")} If yes: in src/server/catalog/defaults.ts add character_start: "${KREA_RECIPE}" to DEFAULT_PURPOSE_RECIPE_IDS, and tags: ["character_start"] plus the suggested ceilingUsd to Krea's WORKFLOW_META entry.`,
    `- [ ] Krea billing: plan compute / partner model. ${facts("krea").filter((fact) => /billing|classes|per execution/.test(fact)).join(" ")} Credits per execution second: ${runs("krea").flatMap((run) => run.notes).join(", ") || "n/a"}.`,
    `- [ ] H3 Max reference to video on Router: ${steps.find((step) => step.id === "h3-max-router")?.reason ?? "not run"}. ${facts("h3-max-router").join(" ")}`,
    "",
  ].join("\n");
}

function missingInputs(plan: SpikePlan): string[] {
  const names = new Set(plan.steps.flatMap((step) => step.runs.flatMap((run) => run.images)).filter((name) => name !== DERIVED_IMAGE));
  return [...names].filter((name) => !existsSync(inputPath(name)));
}

async function main(): Promise<void> {
  const dryRun = process.env.DRY_RUN === "1";
  const steps = parseSteps(process.env.STEPS);
  const inputs = spikeInputsFromEnv();
  const capCredits = Number(process.env.SPIKE_CAP_CREDITS ?? DEFAULT_CAP_CREDITS);
  if (!Number.isFinite(capCredits) || capCredits <= 0) throw new Error("SPIKE_CAP_CREDITS must be a positive number of credits.");
  const plan = await buildSpikePlan({ steps, inputs, workflowsDir, capCredits });
  console.log(formatPlan(plan));
  const missing = missingInputs(plan);
  if (dryRun) {
    if (missing.length) console.log(`\ninputs to place under .data/spike/ before a live run: ${missing.join(", ")}`);
    console.log("\nDRY_RUN=1: nothing was sent and no key was read.");
    process.exit(plan.problems.length ? 1 : 0);
  }

  if (!loadEnvLocal()) throw new Error("No .env.local. The maintainer sets COMFY_API_KEY and GENERATION_ALLOWANCE_USD there; this script never creates it.");
  const allowanceUsd = readAllowanceUsd();
  if (allowanceUsd <= 0) throw new Error("GENERATION_ALLOWANCE_USD is not above zero in .env.local, so paid runs are off. Only the maintainer sets it.");
  const apiKey = process.env.COMFY_API_KEY ?? "";
  if (!apiKey) throw new Error("COMFY_API_KEY is missing from .env.local.");
  const origin = cloudOrigin();
  if (!origin) throw new Error("The v0.2 spike measures cost from the Comfy Cloud balance; leave COMFY_BASE_URL blank for it.");
  if (plan.problems.length) throw new Error("The plan has problems (above); fix them before spending.");
  if (missing.length) throw new Error(`Missing inputs under .data/spike/: ${missing.join(", ")}`);
  if (steps.some((step) => step !== "krea" && step !== "h3-max-router")) await checkVideoTools();
  const cap = Math.min(capCredits, allowanceUsd * CREDITS_PER_USD);
  log(`cap ${cap} credits (SPIKE_CAP_CREDITS ${capCredits}, allowance ${allowanceUsd} USD)`);

  mkdirSync(v02Dir, { recursive: true });
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = resolve(v02Dir, runId);
  mkdirSync(outDir, { recursive: true });
  const appStore = process.env.SPIKE_STORE === "app";
  const store = openStore(appStore ? dataDirectory() : join(outDir, "studio"));
  if (appStore) log(`writing into the app's data directory ${store.dataDir}`);
  const budget = new Budget(cap, () => balanceCredits(apiKey), Number(process.env.BALANCE_SETTLE_MS ?? 65_000));
  // In the app's store its allowance gates too, against the app's whole ledger; the spike cap still holds through Budget.
  const gate = new SubmitGate(appStore ? effectiveAllowanceUsd(store.workspace.get(), allowanceUsd) : cap / CREDITS_PER_USD);
  const context = createToolContext(store, { ...createGenerationContext(store, { workflowsDir }), allowanceUsd: gate.allowance });
  const now = Date.now();
  const project =
    (appStore ? store.projects.list().find((p) => p.name === "v0.2 spike") : undefined) ??
    store.projects.create({ id: randomUUID(), appId: "ugc-creator", name: "v0.2 spike", brief: null, revision: 0, createdAt: now, updatedAt: now });
  const existingCharacter = appStore ? store.library.list({ kind: "character" }).find((item) => item.kind === "character" && item.bible.name === averyBible().name) : undefined;
  const { character } = await tool<{ character: { id: string } }>(context, "save_character_bible", { projectId: project.id, bible: averyBible(), ...(existingCharacter ? { characterId: existingCharacter.id } : {}) });
  const session: Session = {
    store,
    context,
    projectId: project.id,
    characterId: character.id,
    apiKey,
    budget,
    gate,
    outDir,
    recipes: await context.generation!.recipes(),
    comfy: new Comfy({ apiKey, clientInfo: "ai-creator-lab-spike-v02" }),
  };
  const info = await fetchObjectInfo(apiKey, origin);
  await budget.open();
  const records: StepRecord[] = [];
  let stopped: string | undefined;
  try {
    for (const step of plan.steps) {
      const record: StepRecord = { id: step.id, status: "done", runs: [], facts: [] };
      records.push(record);
      if (stopped) {
        record.status = "skipped";
        record.reason = `not started: ${stopped}`;
        continue;
      }
      if (step.ceilingCredits > 0 && !budget.allows(step.ceilingCredits)) {
        stopped = `${step.id} (ceiling ${step.ceilingCredits} credits) would cross the cap with ${budget.spent.toFixed(0)} already spent`;
        record.status = "stopped";
        record.reason = stopped;
        log(`STOP: ${stopped}`);
        continue;
      }
      if (info && step.runs.length) {
        const recipe = session.recipes.find((entry) => entry.id === step.runs[0].recipeId);
        if (recipe?.kind === "workflow") {
          const facts = graphFacts(WorkflowGraphSchema.parse(JSON.parse(readFileSync(join(workflowsDir, recipe.file), "utf8"))), info);
          if (facts.missing.length) {
            record.status = "skipped";
            record.reason = `object_info: ${facts.missing.join("; ")}`;
            log(`skip ${step.id}: ${record.reason}`);
            continue;
          }
        }
      }
      log(`step ${step.id}: ${step.title}`);
      try {
        if (step.id === "krea") await runKrea(session, step, record, info);
        else if (step.id === "h3-chain") await runChain(session, step, record);
        else if (step.id === "h3-max-router") await runRouter(session, record);
        else await runSingle(session, step, record);
        if (record.runs.some((run) => run.outcome === "failed")) record.status = "failed";
      } catch (cause) {
        if (cause instanceof StopSpike) {
          const partial = (cause as StopSpike & { record?: RunRecord }).record;
          if (partial) record.runs.push(partial);
          stopped = cause.message;
          record.status = "stopped";
          record.reason = cause.message;
          log(`STOP: ${cause.message}`);
        } else {
          record.status = "failed";
          record.reason = cause instanceof Error ? cause.message : String(cause);
          log(`step ${step.id} failed: ${record.reason}`);
        }
      }
    }
  } finally {
    budget.close();
    store.close();
  }

  const rows = records.flatMap((record) => record.runs.map(verificationRow));
  writeFileSync(join(outDir, "results.json"), JSON.stringify({ plan, records, spentCredits: budget.spent, cap }, null, 2));
  writeFileSync(join(outDir, "verification-rows.md"), `${rows.join("\n")}\n`);
  writeFileSync(join(outDir, "decisions.md"), decisions(records));
  console.log("\nSteps:");
  for (const record of records) console.log(`- ${record.id}: ${record.status}${record.reason ? ` (${record.reason})` : ""}${record.facts.length ? `\n    ${record.facts.join("\n    ")}` : ""}`);
  console.log(`\nRows for docs/VERIFICATION.md (paste under the table header; re-read the balance a few minutes later to settle the total):\n${rows.join("\n")}`);
  console.log(`\n${decisions(records)}`);
  console.log(`spike spent ${budget.spent.toFixed(0)} of ${cap} credits; outputs in ${outDir}`);
  if (stopped) process.exit(2);
}

main().catch((error) => {
  console.error("FAILED:", error instanceof Error ? error.message : error);
  process.exit(1);
});
