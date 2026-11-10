/**
 * Acceptance smoke: the whole UGC Creator flow with the mock executor, on a temporary data
 * directory, then a Social Post (a plugin content type: brief, copy, a 4:5 still through the gate,
 * approval, and export), then a restart and a relocated restore. No provider is called: every proposal names a
 * mock recipe, the operator ceiling (GENERATION_ALLOWANCE_USD) is zero, and the Comfy and Anthropic
 * keys are placeholders. A monthly budget is saved and an extension is refused at the zero ceiling.
 *
 * Layers (`ACCEPTANCE_LAYER`):
 * - `http` (default when `src/app/api` exists): builds the app (skip with ACCEPTANCE_SKIP_BUILD=1),
 *   runs `next start` on a free loopback port, and drives the flow over the API routes; then starts
 *   `HOST=0.0.0.0 npm start` on a fresh data folder and checks the app password (`authCheck`).
 * - `tools`: drives the same flow through `callTool` against the store, without a server.
 * - `both`: tools first, then http.
 *
 * Usage: npm run test:acceptance
 * @packageDocumentation
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import type { Asset } from "@creator-lab/core/domain/asset";
import type { ExportRecord } from "@creator-lab/core/domain/content";
import type { GenerationProposal, Job } from "@creator-lab/core/domain/job";
import type { BeatInput } from "@creator-lab/core/domain/script";
import type { SpendPolicy } from "@creator-lab/core/domain/spend";
import { renderMockWav } from "@creator-lab/executors/mock";
import { addBudgetExtension, currentSpendPolicy } from "@creator-lab/executors/spend";
import { defaultWorkflowsDir } from "@creator-lab/recipes/workflows-dir";
import { importAudio } from "@/server/media/audio";
import { readAssetBytes } from "@/server/media/files";
import { importImage } from "@/server/media/images";
import { type Store, openStore } from "@/server/store";
import { type ToolContext, callTool, createGenerationContext, createToolContext } from "@/server/tools";
import { startProject } from "@/server/tools/project";
import { SOCIAL_POST_APP, SOCIAL_POST_TOOLS } from "@creator-lab/content-social-post";

// Scripts run from the repository root; the Next.js app is apps/creator.
const ROOT = resolve(process.cwd());
const APP = join(ROOT, "apps", "creator");
// The smoke runs on the mock recipes, which real installs hide.
process.env.MOCK_RECIPES = "1";
const PLACEHOLDER_KEY = "acceptance-smoke-placeholder";

interface Client {
  readonly label: string;
  /** Creates a project in an App (UGC Creator when absent). */
  createProject(name: string, appId?: string): Promise<{ id: string }>;
  tool<T>(name: string, input: Record<string, unknown>, projectId?: string): Promise<T>;
  /** Submits an approved proposal and waits for every candidate; returns the new asset ids. */
  submit(projectId: string, proposal: GenerationProposal): Promise<string[]>;
  upload(name: string, bytes: Uint8Array): Promise<Asset>;
  /** Uploads a voice recording (WAV bytes) as an audio asset in a project. */
  uploadVoice(projectId: string, name: string, bytes: Uint8Array): Promise<Asset>;
  download(assetId: string): Promise<Buffer>;
  /** Saves the monthly budget and reset day; returns the spend policy in force. */
  setBudget(monthlyBudgetUsd: number, budgetResetDay: number): Promise<SpendPolicy>;
  /** Tries "add to this month"; returns whether it was refused (it must be, at a zero operator ceiling). */
  tryExtend(periodKey: string, amountUsd: number): Promise<"added" | "refused">;
  spend(): Promise<SpendPolicy>;
  /** Stops and starts again on the same data directory, or on a copy of it in a new location. */
  restart(relocate: boolean): Promise<void>;
  close(): Promise<void>;
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Acceptance check failed: ${message}`);
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function step(client: Client, message: string): void {
  console.log(`[${client.label}] ${message}`);
}

const BIBLE = {
  name: "Avery Lane",
  ageRange: "early 30s",
  look: {
    face: "Warm oval face with light freckles across the nose",
    hair: "Dark shoulder-length hair, usually tied back",
    skin: "Light olive with natural texture",
    eyes: "Hazel",
    distinguishingDetails: "Small silver hoop earrings",
  },
  build: "Average height, athletic and relaxed",
  wardrobeDefaults: ["Oatmeal knit sweater and jeans", "Olive utility jacket over a white tee"],
  voice: {
    style: "Speaks like a friend recommending something, never hype",
    pace: "Unhurried with natural pauses",
    phrasesUsed: ["Honestly", "I checked"],
    phrasesAvoided: ["You won't believe"],
  },
  vibe: ["warm", "direct", "grounded"],
  backstory: "Commutes forty minutes each way and tries things before she talks about them.",
  boundaries: ["No claims about health outcomes", "No competitor names"],
  visualCore:
    "Avery Lane, a woman in her early 30s with a warm oval face, light freckles, hazel eyes, dark shoulder-length hair tied back, and small silver hoop earrings.",
};

const BEATS: BeatInput[] = [
  {
    type: "talking",
    purpose: "hook",
    spokenLine: "This fits my cup holder.",
    onScreenText: "Fits the cup holder.",
    visual: "Avery in the driver's seat holding the Ridgeline bottle, morning light.",
    setting: "a car interior",
    productVisible: true,
    durationSeconds: 2,
  },
  {
    type: "broll",
    purpose: "problem",
    spokenLine: "Warm by noon, every day.",
    onScreenText: "Warm by noon.",
    visual: "Hands pulling a warm plastic bottle from a hot car console.",
    setting: "a car interior",
    durationSeconds: 2,
  },
  {
    type: "talking",
    purpose: "proof",
    spokenLine: "Still cold a day later.",
    onScreenText: "Cold 24 hours: I checked.",
    visual: "Avery at a kitchen counter, bottle open, condensation.",
    setting: "a bright kitchen counter by a window",
    productVisible: true,
    durationSeconds: 2,
  },
  {
    type: "broll",
    purpose: "cta",
    spokenLine: "Link below.",
    onScreenText: "",
    visual: "The bottle going into a dishwasher rack.",
    setting: "a bright kitchen counter by a window",
    productVisible: true,
    durationSeconds: 2,
  },
];

/** The beats whose line is a voice-over (b-roll with a line), 1-based. */
const VOICE_BEATS = BEATS.map((beat, index) => (beat.type !== "talking" && beat.spokenLine ? index + 1 : 0)).filter(Boolean);

type ProjectState = {
  project: { id: string; brief: unknown };
  characters: { item: { id: string; bible: { references: { faceAssetId: string | null } } } }[];
  products: unknown[];
  contents: { id: string }[];
};

type Assembled = { export: ExportRecord; asset: Asset | null };

/** The flow every layer runs. Returns what the restart checks compare against. */
async function runFlow(client: Client) {
  const project = await client.createProject("Bottle launch, October");
  const projectId = project.id;
  step(client, "project created");

  await client.tool("save_brief", {
    projectId,
    revision: 0,
    brief: { productSummary: "Ridgeline 32 oz insulated bottle", audience: "Commuters", platforms: ["TikTok", "Reels"], tone: "Warm, direct" },
  }, projectId);
  const saved = await client.tool<{ character: { id: string } }>("save_character_bible", {
    projectId,
    wardrobe: "Olive utility jacket over a white tee",
    bible: BIBLE,
  }, projectId);
  const characterId = saved.character.id;
  step(client, "brief and bible saved");

  const faceProposal = await client.tool<GenerationProposal>("propose_candidates", {
    projectId,
    capability: "text_to_image",
    recipeId: "mock-text-to-image",
    prompt: "Avery Lane, 3/4 view headshot, soft window light, plain grey background.",
    count: 4,
    target: { kind: "character_reference", characterId, slot: "face" },
  }, projectId);
  check(faceProposal.estimate.kind === "free", "the mock face proposal is free");
  const faces = await client.submit(projectId, faceProposal);
  check(faces.length === 4, `four face candidates (got ${faces.length})`);
  const face = await client.tool<{ character: { bible: { references: { faceAssetId: string } } }; archivedAssetIds: string[] }>(
    "select_reference",
    { characterId, slot: "face", assetId: faces[1] },
    projectId,
  );
  check(face.character.bible.references.faceAssetId === faces[1], "the chosen face is locked");
  check(face.archivedAssetIds.length === 3, "the other three faces went to the Archive");
  step(client, "face locked from four candidates");

  // The one-click workspace path: body from the locked face, then the sheet from both.
  const bodyProposal = await client.tool<GenerationProposal>("generate_body_reference", { projectId, characterId, recipeId: "mock-image-edit" }, projectId);
  check(bodyProposal.references.length === 1 && bodyProposal.count === 2, "the body proposal uses the locked face as its one reference, two candidates");
  const bodies = await client.submit(projectId, bodyProposal);
  await client.tool("select_reference", { characterId, slot: "body", assetId: bodies[0] }, projectId);
  const sheetProposal = await client.tool<GenerationProposal>("generate_reference_sheet", { projectId, characterId, recipeId: "mock-image-edit", count: 1 }, projectId);
  const sheets = await client.submit(projectId, sheetProposal);
  await client.tool("approve", { kind: "sheet", assetId: sheets[0], projectId, characterId }, projectId);
  step(client, "body and reference sheet from the workspace buttons");

  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#2a4d6e" } }).png().toBuffer();
  const photo = await client.upload("ridgeline.png", png);
  const savedProduct = await client.tool<{ product: { id: string; revision: number } }>("save_product", {
    projectId,
    product: {
      name: "Ridgeline 32 oz insulated bottle",
      appearance: "a matte dark green steel bottle with a black screw cap",
      link: "https://example.com/ridgeline",
      allowedClaims: ["Keeps drinks cold 24 hours", "Fits a car cup holder", "Dishwasher safe"],
      imageAssetIds: [photo.id],
    },
  }, projectId);
  const productProposal = await client.tool<GenerationProposal>("generate_product_images", { projectId, productId: savedProduct.product.id, recipeId: "mock-text-to-image", count: 1 }, projectId);
  check(!productProposal.prompt.includes("Ridgeline"), "the product prompt never carries the product's name");
  const productImages = await client.submit(projectId, productProposal);
  const afterProduct = await client.tool<{ assets: { id: string }[] }>("get_project_state", { projectId }, projectId);
  check(afterProduct.assets.some((asset) => asset.id === productImages[0]), "the product photo candidate is in the project");
  step(client, "product saved with a generated photo candidate");

  const script = await client.tool<{ script: { id: string } }>("save_script", { projectId, title: "Cup holder", beats: BEATS }, projectId);
  const content = await client.tool<{ id: string; shots: unknown[] }>("plan_shots", { projectId, scriptId: script.script.id }, projectId);
  check(content.shots.length === BEATS.length, "one shot per beat");
  step(client, "script and shots planned");

  for (let beatIndex = 1; beatIndex <= BEATS.length; beatIndex++) {
    const stillProposal = await client.tool<GenerationProposal>("compose_still", { contentId: content.id, beatIndex, recipeId: "mock-image-edit", count: 2 }, projectId);
    const stills = await client.submit(projectId, stillProposal);
    check(stills.length === 2, `two stills for beat ${beatIndex}`);
    await client.tool("approve", { kind: "still", contentId: content.id, beatIndex, assetId: stills[0] }, projectId);
    if (beatIndex === 1) {
      // Model override (F3): the candidate set aside at approval is proposed again from its own shot
      // spec, and the project gets a preference for stills; nothing is re-briefed.
      const again = await client.tool<GenerationProposal>("regenerate_with", { assetId: stills[1], recipeId: "mock-image-edit" }, projectId);
      check(again.spec?.kind === "still" && JSON.stringify(again.spec) === JSON.stringify(stillProposal.spec), "regenerate_with carries the same shot spec");
      check(again.target.kind === "shot" && again.target.beatIndex === 1, "regenerate_with lands on the same beat");
      await client.tool("set_recipe_preference", { projectId, capability: "image_edit", recipeId: "mock-image-edit" }, projectId);
      const preferred = await client.tool<{ preferences: { recipes: Record<string, string> } }>("get_project_state", { projectId }, projectId);
      check(preferred.preferences.recipes.image_edit === "mock-image-edit", "the project's recipe preference is saved");
    }
    const clipProposal = await client.tool<GenerationProposal>("generate_clip", { contentId: content.id, beatIndex, recipeId: "mock-image-to-video" }, projectId);
    const clips = await client.submit(projectId, clipProposal);
    check(clips.length === 1, `one clip for beat ${beatIndex}`);
    await client.tool("approve", { kind: "clip", contentId: content.id, beatIndex, assetId: clips[0] }, projectId);
  }
  step(client, "stills and clips approved for every beat");

  // Voice-overs: a recording of the creator becomes the voice sample; each b-roll line is read in it.
  const recording = await client.uploadVoice(projectId, "creator-voice.wav", renderMockWav("Hello, this is the creator's voice sample for the ad.").bytes);
  check(recording.kind === "audio" && recording.audio !== undefined, "the recording is an audio asset with playback metadata");
  const voiced = await client.tool<{ character: { bible: { references: { voiceAssetId: string | null } } } }>(
    "select_reference",
    { characterId, slot: "voice", assetId: recording.id, archiveSiblings: false },
    projectId,
  );
  check(voiced.character.bible.references.voiceAssetId === recording.id, "the recording is the character's voice sample");
  for (const beatIndex of VOICE_BEATS) {
    const voiceProposal = await client.tool<GenerationProposal>("generate_voice_over", { projectId, contentId: content.id, beatIndex, recipeId: "mock-text-to-speech" }, projectId);
    check(voiceProposal.prompt === BEATS[beatIndex - 1].spokenLine, `the voice-over reads beat ${beatIndex}'s line`);
    check(voiceProposal.references.some((reference) => reference.assetId === recording.id), `the voice-over clones the voice sample for beat ${beatIndex}`);
    const takes = await client.submit(projectId, voiceProposal);
    check(takes.length === 1, `one voice-over take for beat ${beatIndex}`);
    await client.tool("approve", { kind: "voice", contentId: content.id, beatIndex, assetId: takes[0] }, projectId);
  }
  const voicedContent = await client.tool<{ contents: { id: string; shots: { voice: { state: string } }[] }[] }>("get_project_state", { projectId }, projectId);
  const shots = voicedContent.contents.find((entry) => entry.id === content.id)!.shots;
  check(VOICE_BEATS.every((beatIndex) => shots[beatIndex - 1].voice.state === "approved"), "every voice-over beat has an approved take");
  step(client, `voice-overs approved for beats ${VOICE_BEATS.join(" and ")}`);

  const exportId = randomUUID();
  const assembled = await client.tool<Assembled>("assemble_ad", { contentId: content.id, exportId, captions: true }, projectId);
  check(assembled.export.status === "completed", `the export completed (${assembled.export.status === "failed" ? assembled.export.error : assembled.export.status})`);
  const asset = assembled.asset;
  check(asset && asset.kind === "export" && asset.width === 1080 && asset.height === 1920, "a 1080 x 1920 export asset");
  check(Math.abs(asset.video!.durationSeconds - BEATS.length * 2) < 0.1, "the export lasts as long as its beats");
  const downloaded = await client.download(asset.id);
  check(hash(downloaded) === asset.sha256, "the downloaded MP4 matches its recorded hash");
  step(client, `exported and downloaded ${downloaded.length} bytes`);

  return { projectId, characterId, faceId: faces[1], contentId: content.id, exportId, assembled };
}

interface PostExport {
  copyText: string;
  stills: { aspectRatio: string; assetId: string; sha256: string }[];
  missing: string[];
}

/** A Social Post, the plugin content type: brief, copy, a 4:5 still proposed and approved through the gate, and the export. */
async function runSocialPost(client: Client) {
  const project = await client.createProject("Cup holder post", SOCIAL_POST_APP.id);
  const projectId = project.id;
  const brief = { productSummary: "Ridgeline 32 oz insulated bottle", audience: "Commuters who drive to work", platforms: ["Instagram"], tone: "Warm and direct" };
  await client.tool("save_brief", { projectId, brief }, projectId);
  const copy = {
    caption: "It fits my cup holder and it was still cold at five.",
    hashtags: ["#commute", "hydration"],
    callToAction: "Link in bio.",
    visual: "A matte dark green steel bottle in a car cup holder, morning light through the windshield.",
  };
  const saved = await client.tool<{ post: { id: string; slots: Record<string, { state: string }> }; created: boolean }>(SOCIAL_POST_TOOLS.saveCopy, { projectId, copy }, projectId);
  check(saved.created && Object.keys(saved.post.slots).join(",") === "1:1,4:5,9:16,16:9", "the post starts with one still slot per aspect ratio");
  const contentId = saved.post.id;
  step(client, "social post: brief and copy saved");

  const proposal = await client.tool<GenerationProposal>(SOCIAL_POST_TOOLS.proposeStill, { contentId, aspectRatio: "4:5", recipeId: "mock-text-to-image", count: 2 }, projectId);
  check(proposal.target.kind === "piece" && proposal.target.slot === "4:5" && proposal.aspectRatio === "4:5", "the still proposal aims at the post's 4:5 slot");
  const stills = await client.submit(projectId, proposal);
  check(stills.length === 2, "two 4:5 candidates were made with the mock executor");
  const approved = await client.tool<{ piece: { slots: Record<string, { state: string }> }; archivedAssetIds: string[] }>("approve", { kind: "slot", contentId, slot: "4:5", assetId: stills[0] }, projectId);
  check(approved.piece.slots["4:5"].state === "approved" && approved.archivedAssetIds.join() === stills[1], "one 4:5 still approved, the other archived");
  step(client, "social post: a 4:5 still proposed, generated, and approved");

  const exported = await client.tool<PostExport>(SOCIAL_POST_TOOLS.export, { contentId }, projectId);
  check(exported.stills.length === 1 && exported.stills[0].aspectRatio === "4:5" && exported.stills[0].assetId === stills[0], "the export lists the approved 4:5 still");
  check(exported.missing.join(",") === "1:1,9:16,16:9", "the export names the ratios still missing");
  check(exported.copyText.endsWith("Link in bio.\n\n#commute #hydration"), "the export carries the copy as text");
  const bytes = await client.download(exported.stills[0].assetId);
  check(hash(bytes) === exported.stills[0].sha256, "the exported still downloads intact");
  step(client, "social post: exported the 4:5 still and the copy");
  return { projectId, contentId, exported };
}

async function confirmPostAfterRestart(client: Client, post: Awaited<ReturnType<typeof runSocialPost>>, how: string): Promise<void> {
  const again = await client.tool<PostExport>(SOCIAL_POST_TOOLS.export, { contentId: post.contentId }, post.projectId);
  check(JSON.stringify(again) === JSON.stringify(post.exported), `${how}: the social post exports the same still and copy`);
}

async function confirmAfterRestart(client: Client, flow: Awaited<ReturnType<typeof runFlow>>, how: string): Promise<void> {
  const state = await client.tool<ProjectState>("get_project_state", { projectId: flow.projectId }, flow.projectId);
  check(state.project.brief, `${how}: the brief is still there`);
  check(state.characters[0]?.item.bible.references.faceAssetId === flow.faceId, `${how}: the face lock is still there`);
  check(state.products.length === 1, `${how}: the product is still there`);
  check(state.contents.some((content) => content.id === flow.contentId), `${how}: the content piece is still there`);
  const again = await client.tool<Assembled>("assemble_ad", { contentId: flow.contentId, exportId: flow.exportId }, flow.projectId);
  check(JSON.stringify(again) === JSON.stringify(flow.assembled), `${how}: the same export comes back unchanged`);
  const bytes = await client.download(flow.assembled.asset!.id);
  check(hash(bytes) === flow.assembled.asset!.sha256, `${how}: the MP4 still downloads intact`);
  step(client, `${how}: everything is still there`);
}

/** The spend policy: a monthly budget and reset day save, and a zero operator ceiling refuses any extension. */
async function checkBudget(client: Client): Promise<void> {
  const policy = await client.setBudget(5, 15);
  check(policy.limitUsd === 5 && policy.period.resetDay === 15, "the monthly budget and reset day are saved");
  check(policy.ceilingUsd === 0 && policy.effectiveLimitUsd === 0, "a zero operator ceiling keeps the effective limit at zero");
  check((await client.tryExtend(policy.period.key, 1)) === "refused", "a zero operator ceiling refuses an extension");
  check((await client.spend()).extensionUsd === 0, "nothing was added to this month");
  step(client, "monthly budget saved; the zero operator ceiling refused an extension");
}

async function confirmBudget(client: Client, how: string): Promise<void> {
  const policy = await client.spend();
  check(policy.limitUsd === 5 && policy.period.resetDay === 15, `${how}: the monthly budget is still there`);
}

async function runLayer(client: Client): Promise<void> {
  try {
    const flow = await runFlow(client);
    const post = await runSocialPost(client);
    await checkBudget(client);
    await client.restart(false);
    await confirmAfterRestart(client, flow, "after restart");
    await confirmPostAfterRestart(client, post, "after restart");
    await confirmBudget(client, "after restart");
    await client.restart(true);
    await confirmAfterRestart(client, flow, "after relocating the data directory");
    await confirmPostAfterRestart(client, post, "after relocating the data directory");
    await confirmBudget(client, "after relocating the data directory");
  } finally {
    await client.close();
  }
}

/** Tools layer: `callTool` against a store, closed and reopened for restarts. */
async function toolsClient(): Promise<Client> {
  const root = await mkdtemp(join(tmpdir(), "creator-lab-acceptance-"));
  let dataDir = join(root, "data");
  let store: Store = openStore(dataDir);
  let context: ToolContext = createToolContext(store, createGenerationContext(store, { workflowsDir: defaultWorkflowsDir(ROOT) }));
  const reopen = (dir: string) => {
    store = openStore(dir);
    context = createToolContext(store, createGenerationContext(store, { workflowsDir: defaultWorkflowsDir(ROOT) }));
  };
  const call = async <T>(name: string, input: Record<string, unknown>): Promise<T> => {
    const result = await callTool(context, name, input);
    if (!result.ok) throw new Error(`${name} failed: ${result.failure.code} ${result.failure.message}`);
    return result.output as T;
  };
  return {
    label: "tools",
    createProject: async (name, appId) => startProject(context, { name, ...(appId ? { appId } : {}) }).project,
    tool: (name, input) => call(name, input),
    submit: async (_projectId, proposal) => {
      const { results } = await call<{ results: { outcome: string; assetIds: string[]; message: string | null }[] }>("submit_proposal", { proposal, wait: true });
      for (const result of results) check(result.outcome === "completed", `a mock candidate completed (${result.outcome}: ${result.message})`);
      return results.flatMap((result) => result.assetIds);
    },
    upload: (name, bytes) => importImage(store, { projectId: null, name, bytes }, { now: Date.now(), newId: randomUUID }),
    uploadVoice: (projectId, name, bytes) => importAudio(store, { projectId, name, bytes }, { now: Date.now(), newId: randomUUID }),
    download: async (assetId) => readAssetBytes(store.dataDir, store.assets.getRequired(assetId)),
    // The tools layer pins the operator ceiling at zero, as the HTTP layer's environment does.
    setBudget: async (monthlyBudgetUsd, budgetResetDay) => {
      store.workspace.update({ monthlyBudgetUsd, budgetResetDay }, Date.now());
      return currentSpendPolicy({ store, operatorCeilingUsd: () => 0 });
    },
    tryExtend: async (periodKey, amountUsd) => {
      try {
        addBudgetExtension({ store, operatorCeilingUsd: () => 0 }, { id: randomUUID(), periodKey, amountUsd });
        return "added";
      } catch {
        return "refused";
      }
    },
    spend: async () => currentSpendPolicy({ store, operatorCeilingUsd: () => 0 }),
    restart: async (relocate) => {
      store.close();
      if (relocate) {
        const moved = join(root, `moved-${randomUUID()}`);
        await cp(dataDir, moved, { recursive: true });
        await rm(dataDir, { recursive: true, force: true });
        dataDir = moved;
      }
      reopen(dataDir);
    },
    close: async () => {
      try {
        store.close();
      } catch {
        // Already closed.
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolvePort(address.port) : reject(new Error("No port."))));
    });
  });
}

/** HTTP layer: `next start` on loopback, restarted (and relocated) between checks. */
async function httpClient(): Promise<Client> {
  const root = await mkdtemp(join(tmpdir(), "creator-lab-acceptance-http-"));
  let dataDir = join(root, "data");
  let server: ChildProcess | undefined;
  let base = "";
  let output = "";

  const start = async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    output = "";
    server = spawn(join(ROOT, "node_modules", ".bin", "next"), ["start", APP, "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: "production",
        // The flow runs on loopback, where no password is asked; `authCheck` covers the network bind.
        HOST: "127.0.0.1",
        STUDIO_ALLOWED_HOSTS: "",
        STUDIO_DATA_DIR: dataDir,
        COMFY_API_KEY: PLACEHOLDER_KEY,
        ANTHROPIC_API_KEY: PLACEHOLDER_KEY,
        GENERATION_ALLOWANCE_USD: "0",
        MOCK_RECIPES: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout?.on("data", (chunk) => (output += chunk));
    server.stderr?.on("data", (chunk) => (output += chunk));
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`The server exited early:\n${output}`);
      try {
        const response = await fetch(`${base}/api/projects`);
        if (response.ok) return;
      } catch {
        // Not listening yet.
      }
      await new Promise((wait) => setTimeout(wait, 250));
    }
    throw new Error(`The server did not start:\n${output}`);
  };

  const stop = async () => {
    if (!server || server.exitCode !== null) return;
    const exited = new Promise((done) => server!.once("exit", done));
    server.kill("SIGTERM");
    await Promise.race([exited, new Promise((done) => setTimeout(done, 10_000))]);
    if (server.exitCode === null) server.kill("SIGKILL");
  };

  const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(`${base}${path}`, init);
    const text = await response.text();
    if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} returned ${response.status}: ${text.slice(0, 500)}`);
    return JSON.parse(text) as T;
  };
  const post = <T>(path: string, body: unknown) =>
    json<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  await start();
  return {
    label: "http",
    createProject: async (name, appId) => (await post<{ project: { id: string } }>("/api/projects", { name, ...(appId ? { appId } : {}) })).project,
    tool: (name, input, projectId) => post(projectId ? `/api/projects/${projectId}/tools/${name}` : `/api/tools/${name}`, input),
    submit: async (projectId, proposal) => {
      const { results } = await post<{ results: { outcome: string; job: Job | null; message: string | null }[] }>(
        `/api/projects/${projectId}/proposals/submit`,
        { proposal },
      );
      const jobIds = results.map((result) => {
        check(result.job && (result.outcome === "started" || result.outcome === "existing" || result.outcome === "completed"), `a mock candidate started (${result.outcome}: ${result.message})`);
        return result.job.id;
      });
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const { unfinished, recent } = await json<{ unfinished: Job[]; recent: Job[] }>(`/api/projects/${projectId}/jobs`);
        const done = recent.filter((job) => jobIds.includes(job.id));
        const failed = done.find((job) => job.status === "failed");
        check(!failed, `mock job failed: ${failed && failed.status === "failed" ? failed.error.message : ""}`);
        if (done.length === jobIds.length && !unfinished.some((job) => jobIds.includes(job.id))) {
          return jobIds.flatMap((id) => {
            const job = done.find((entry) => entry.id === id)!;
            return job.status === "completed" ? job.outputs : [];
          });
        }
        await new Promise((wait) => setTimeout(wait, 200));
      }
      throw new Error("Mock jobs did not finish in time.");
    },
    upload: async (name, bytes) => {
      const form = new FormData();
      form.set("image", new Blob([new Uint8Array(bytes)], { type: "image/png" }), name);
      return (await json<{ asset: Asset }>("/api/uploads", { method: "POST", body: form })).asset;
    },
    uploadVoice: async (projectId, name, bytes) => {
      const form = new FormData();
      form.set("audio", new Blob([new Uint8Array(bytes)], { type: "audio/wav" }), name);
      form.set("projectId", projectId);
      return (await json<{ asset: Asset }>("/api/uploads?as=voice", { method: "POST", body: form })).asset;
    },
    download: async (assetId) => {
      const response = await fetch(`${base}/api/assets/${assetId}?download`);
      check(response.ok, `download returned ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    },
    setBudget: async (monthlyBudgetUsd, budgetResetDay) =>
      (
        await json<{ spend: SpendPolicy }>("/api/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ monthlyBudgetUsd, budgetResetDay }),
        })
      ).spend,
    tryExtend: async (periodKey, amountUsd) => {
      const response = await fetch(`${base}/api/settings/budget`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: randomUUID(), periodKey, amountUsd }),
      });
      await response.body?.cancel();
      if (response.ok) return "added";
      check(response.status === 400, `an extension at a zero ceiling is a 400, not ${response.status}`);
      return "refused";
    },
    spend: async () => (await json<{ spend: SpendPolicy }>("/api/settings")).spend,
    restart: async (relocate) => {
      await stop();
      if (relocate) {
        const moved = join(root, `moved-${randomUUID()}`);
        await cp(dataDir, moved, { recursive: true });
        await rm(dataDir, { recursive: true, force: true });
        dataDir = moved;
      }
      await start();
    },
    close: async () => {
      await stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * Access control on a real server: `HOST=0.0.0.0 npm start` with no password set. The API refuses
 * unauthenticated calls, pages go to the sign-in page, the setup code from the server log sets the
 * password, the session cookie opens the API, and sign-out closes it again.
 */
async function authCheck(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "creator-lab-acceptance-auth-"));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let output = "";
  const server = spawn(process.execPath, [join(APP, "scripts", "serve.mjs"), "start", "--port", String(port)], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: "production", HOST: "0.0.0.0", STUDIO_ALLOWED_HOSTS: "", STUDIO_DATA_DIR: join(root, "data"), GENERATION_ALLOWANCE_USD: "0", COMFY_API_KEY: PLACEHOLDER_KEY, ANTHROPIC_API_KEY: PLACEHOLDER_KEY },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (chunk) => (output += chunk));
  server.stderr?.on("data", (chunk) => (output += chunk));
  try {
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (server.exitCode !== null) throw new Error(`The server exited early:\n${output}`);
      check(Date.now() < deadline, `the network server did not start:\n${output}`);
      const ready = await fetch(`${base}/api/auth/session`).catch(() => null);
      if (ready?.ok) {
        const status = (await ready.json()) as { required: boolean; authenticated: boolean; configured?: boolean };
        check(status.required && !status.authenticated, `HOST=0.0.0.0 asks for a password (${JSON.stringify(status)})`);
        check(!("configured" in status), "the public status does not say whether a password is set");
        break;
      }
      await new Promise((wait) => setTimeout(wait, 250));
    }
    const refused = await fetch(`${base}/api/projects`);
    check(refused.status === 401, `an unauthenticated API call is refused (got ${refused.status})`);
    check(((await refused.json()) as { signIn?: string }).signIn === "/login", "the 401 names the sign-in page");
    const page = await fetch(`${base}/projects`, { redirect: "manual" });
    check(page.status === 307 && new URL(page.headers.get("location") ?? "", base).href === `${base}/login?next=%2Fprojects`, `a page goes to the sign-in page (got ${page.status} ${page.headers.get("location")})`);
    const login = await fetch(`${base}/login`);
    check(login.ok && (await login.text()).includes("Choose a password"), "the first visit asks for a password");
    const code = output.match(/setup code to choose one: ([0-9A-Z]{4}(?:-[0-9A-Z]{4}){4})/)?.[1];
    check(code, `the setup code is in the server log:\n${output}`);
    const password = `acceptance-${randomUUID()}`;
    const setup = await fetch(`${base}/api/auth/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ setupCode: code, password }) });
    check(setup.ok, `the setup code sets the password (got ${setup.status})`);
    const cookie = setup.headers.get("set-cookie")?.split(";")[0];
    check(cookie && /HttpOnly/.test(setup.headers.get("set-cookie") ?? ""), "setup signs the browser in with an HttpOnly cookie");
    const listed = await fetch(`${base}/api/projects`, { headers: { cookie } });
    check(listed.ok, `the session opens the API (got ${listed.status})`);
    const created = await fetch(`${base}/api/projects`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Ridgeline bottle, network" }) });
    check(created.status === 201, `a signed-in write works (got ${created.status})`);
    const signedOut = await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { cookie } });
    check(signedOut.ok, "sign-out answers");
    check((await fetch(`${base}/api/projects`, { headers: { cookie } })).status === 401, "the signed-out session no longer opens the API");
    check(!output.includes(password), "the password never reaches the server log");
    check(output.includes("Set STUDIO_ALLOWED_HOSTS"), "with HOST=0.0.0.0 and no allowed hosts, the log says how to let other computers in");
    console.log("[auth] HOST=0.0.0.0: first visit asks for a password, the API refuses unauthenticated calls, sessions open and close");
  } finally {
    const exited = new Promise((done) => server.once("exit", done));
    server.kill("SIGTERM");
    await Promise.race([exited, new Promise((done) => setTimeout(done, 10_000))]);
    if (server.exitCode === null) server.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
}

function build(): void {
  if (process.env.ACCEPTANCE_SKIP_BUILD === "1" && existsSync(join(APP, ".next", "BUILD_ID"))) return;
  console.log("[http] building the app (set ACCEPTANCE_SKIP_BUILD=1 to reuse the last build)");
  const result = spawnSync(join(ROOT, "node_modules", ".bin", "next"), ["build", APP, "--webpack"], { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) throw new Error("The production build failed, so the HTTP smoke cannot run. Fix the build, or run ACCEPTANCE_LAYER=tools.");
}

async function main(): Promise<void> {
  const routes = existsSync(join(APP, "src", "app", "api"));
  const layer = process.env.ACCEPTANCE_LAYER ?? (routes ? "http" : "tools");
  if (!["http", "tools", "both"].includes(layer)) throw new Error(`Unknown ACCEPTANCE_LAYER ${layer}.`);
  if (layer === "tools" || layer === "both") await runLayer(await toolsClient());
  if (layer === "http" || layer === "both") {
    build();
    await runLayer(await httpClient());
    await authCheck();
  }
  console.log(`Acceptance smoke passed (${layer}).`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
