/**
 * The Quick Ad (v0.2 F11): the pure plan and state transitions, the price on Comfy Router from the
 * catalog's ceilings, and the whole path on the mock executor: a two-line brief, three approvals
 * (frame, clip, export), and an exported MP4 with the caption burned in.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { ContentPieceSchema, planShots } from "@creator-lab/core/domain/content";
import {
  QUICK_AD,
  defaultOnScreenText,
  defaultSpokenLine,
  quickAdBeat,
  quickAdPlan,
  quickAdProgress,
  quickBrief,
} from "@creator-lab/core/domain/quick-ad";
import { createScript, maxWords } from "@creator-lab/core/domain/script";
import { wordCount } from "@creator-lab/core/domain/common";
import type { RouterRecipe } from "@creator-lab/core/catalog";
import { ceilingFor } from "@creator-lab/executors/router";
import { probeVideo } from "@creator-lab/executors/media";
import { DEFAULT_RECIPE_IDS, ROUTER_RECIPES } from "@creator-lab/recipes/defaults";
import { loadSnapshot, nextStage } from "@/server/agent/state";
import { importImage } from "@/server/media/images";
import { resolveMediaPath } from "@/server/media/paths";
import { type ToolContext, callTool, createGenerationContext } from "@/server/tools";
import { averyBible, clock, ridgelineProduct, seedProject, tempStore } from "./support/domain-fixtures";

const workflowsDir = fileURLToPath(new URL("../packages/recipes/workflows", import.meta.url));
const TWO_LINES = {
  productSummary: "Ridgeline 32 oz insulated bottle, keeps drinks cold 24 hours",
  audience: "Commuters who leave a drink in the car, on TikTok",
};

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function setup() {
  const context = tempStore();
  cleanups.push(context.cleanup);
  const now = clock();
  const calls: string[] = [];
  const tools: ToolContext = { store: context.store, now, newId: randomUUID, generation: createGenerationContext(context.store, { workflowsDir }) };
  const ok = async <T>(name: string, input: unknown): Promise<T> => {
    calls.push(name);
    const result = await callTool(tools, name, input);
    if (!result.ok) assert.fail(`${name} failed: ${result.failure.code} ${result.failure.message}`);
    return result.output as T;
  };
  return { ...context, now, tools, ok, calls, project: seedProject(context.store, now) };
}

describe("Quick Ad plan (pure)", () => {
  test("two lines become a full brief with the Quick Ad's platforms and tone", () => {
    assert.deepEqual(quickBrief({ brief: TWO_LINES }), { ...TWO_LINES, platforms: [...QUICK_AD.platforms], tone: QUICK_AD.tone });
    assert.deepEqual(quickBrief({ brief: TWO_LINES, platforms: ["Instagram Reels"], tone: "Dry" }).platforms, ["Instagram Reels"]);
    assert.throws(() => quickBrief({ brief: { productSummary: " ", audience: "x" } }));
  });

  test("the default line fits the four-second beat, and the default caption is the first clause in six words", () => {
    assert.equal(defaultSpokenLine("Keeps coffee hot all day"), "Keeps coffee hot all day.");
    assert.equal(defaultSpokenLine(TWO_LINES.productSummary), "Ridgeline 32 oz insulated bottle, keeps drinks cold 24 hours.");
    const long = "The Ridgeline thirty-two ounce insulated steel bottle keeps every single drink properly cold for twenty-four hours";
    const shortened = defaultSpokenLine(long);
    assert.ok(wordCount(shortened) <= QUICK_AD.durationSeconds * 2.5, shortened);
    assert.doesNotMatch(shortened, /\b(for|the|and)\.$/, "never ends on a dangling word");
    assert.equal(defaultOnScreenText(TWO_LINES.productSummary), "Ridgeline 32 oz insulated bottle");
    assert.ok(wordCount(defaultOnScreenText(long)) <= 6);
  });

  test("one talking hook beat; the visual names the creator and product in words only when the Library has none", () => {
    const words = quickAdBeat({ brief: TWO_LINES }, { character: false, product: false });
    assert.equal(words.type, "talking");
    assert.equal(words.durationSeconds, QUICK_AD.durationSeconds);
    assert.ok(wordCount(words.spokenLine ?? "") <= maxWords(QUICK_AD.durationSeconds));
    assert.match(words.visual, /^A friendly creator .* holds the product \(Ridgeline 32 oz insulated bottle/);
    const cast = quickAdBeat({ brief: TWO_LINES, spokenLine: "Still cold at five.", onScreenText: "", setting: "a car interior" }, { character: true, product: true });
    assert.equal(cast.visual, "The creator holds the product up beside their face and talks straight to the camera.");
    assert.deepEqual([cast.spokenLine, cast.onScreenText, cast.setting], ["Still cold at five.", "", "a car interior"]);
    assert.throws(() => quickAdBeat({ brief: TWO_LINES, spokenLine: "one two three four five six seven eight nine ten eleven twelve thirteen" }, { character: false, product: false }), /needs about/);
  });

  test("the frame composes from references when there are any, else comes from text; one candidate each", () => {
    assert.deepEqual(quickAdPlan({ creator: true, productPhoto: true }).frame, { capability: "image_edit", count: 1 });
    assert.deepEqual(quickAdPlan({ creator: false, productPhoto: true }).frame, { capability: "image_edit", count: 1 });
    assert.deepEqual(quickAdPlan({ creator: false, productPhoto: false }).frame, { capability: "text_to_image", count: 1 });
    assert.deepEqual(quickAdPlan({ creator: true, productPhoto: false }).clip, { capability: "image_to_video", count: 1, durationSeconds: 4 });
  });

  test("progress moves frame, clip, export, done; the three approvals are counted in order", () => {
    const now = 1_760_000_000_000;
    const ids = Array.from({ length: 8 }, () => randomUUID());
    let next = 0;
    const script = createScript(randomUUID(), randomUUID(), "Quick", [quickAdBeat({ brief: TWO_LINES }, { character: false, product: false })], now);
    const content = planShots(randomUUID(), script, "Quick", now, () => ids[next++], "quick");
    assert.equal(content.mode, "quick");
    assert.deepEqual(quickAdProgress(content, 0), { next: "frame", approved: [], candidates: [] });
    const [still, clip] = [randomUUID(), randomUUID()];
    const withFrame = { shots: [{ ...content.shots[0], still: { state: "open" as const, candidateIds: [still], selectedId: null } }] };
    assert.deepEqual(quickAdProgress(withFrame, 0), { next: "frame", approved: [], candidates: [still] });
    const framed = { shots: [{ ...withFrame.shots[0], still: { state: "approved" as const, candidateIds: [still], assetId: still, approvedAt: now } }] };
    assert.deepEqual(quickAdProgress(framed, 0), { next: "clip", approved: ["frame"], candidates: [] });
    const clipped = { shots: [{ ...framed.shots[0], clip: { state: "approved" as const, candidateIds: [clip], assetId: clip, approvedAt: now } }] };
    assert.deepEqual(quickAdProgress(clipped, 0), { next: "export", approved: ["frame", "clip"], candidates: [] });
    assert.deepEqual(quickAdProgress(clipped, 1), { next: "done", approved: ["frame", "clip", "export"], candidates: [] });
    assert.equal(QUICK_AD.approvals.length, 3);
  });

  test("an Ad saved before modes existed reads as the full flow", () => {
    const now = 1_760_000_000_000;
    const script = createScript(randomUUID(), randomUUID(), "Old", [quickAdBeat({ brief: TWO_LINES }, { character: false, product: false })], now);
    const { mode, ...saved } = planShots(randomUUID(), script, "Old", now, randomUUID);
    assert.equal(mode, "full");
    assert.equal(ContentPieceSchema.parse(saved).mode, "full");
  });
});

describe("Quick Ad price on Comfy Router", () => {
  const router = (id: string): RouterRecipe => {
    const recipe = ROUTER_RECIPES.find((entry) => entry.id === id);
    assert.ok(recipe, `${id} is in the catalog`);
    return recipe;
  };
  // The hosted recipe a credits-only user (no Cloud plan) runs for each step.
  const composed = router(DEFAULT_RECIPE_IDS.image_edit!.hosted!);
  const fromText = router("router-nano-banana-pro-t2i");
  const clip = router(DEFAULT_RECIPE_IDS.image_to_video!.hosted!);

  test("stays under one dollar from the catalog's ceilings, whether the frame is composed or made from text", () => {
    const plan = quickAdPlan({ creator: true, productPhoto: true });
    const clipUsd = ceilingFor(clip, { prompt: "p", images: [], durationSeconds: plan.clip.durationSeconds });
    assert.ok(clipUsd !== null);
    assert.equal(clipUsd, 0.64, "Kling 3.0 Omni's 0.80 ceiling for 5 s, scaled to the 4 s clip");
    const composedUsd = plan.frame.count * ceilingFor(composed, { prompt: "p", images: [] })! + plan.clip.count * clipUsd;
    const textUsd = quickAdPlan({ creator: false, productPhoto: false }).frame.count * ceilingFor(fromText, { prompt: "p", images: [] })! + clipUsd;
    assert.equal(Math.round(composedUsd * 100) / 100, 0.79, "Nano Banana 2.1 edit (0.15) plus the clip (0.64)");
    assert.equal(Math.round(textUsd * 100) / 100, 0.89, "Nano Banana Pro from text (0.25) plus the clip (0.64)");
    assert.ok(composedUsd < QUICK_AD.routerBudgetUsd && textUsd < QUICK_AD.routerBudgetUsd);
    // A five-second clip from text would not fit: the reason the Quick Ad's clip is four seconds.
    assert.ok(ceilingFor(fromText, { prompt: "p", images: [] })! + ceilingFor(clip, { prompt: "p", images: [], durationSeconds: 5 })! > QUICK_AD.routerBudgetUsd);
  });
});

describe("Quick Ad on the mock executor", () => {
  test("a two-line brief, three approvals, and an exported 1080 x 1920 MP4 with the caption burned in", async () => {
    const { store, ok, calls, project } = setup();
    const started = await ok<{ content: { id: string; mode: string; shots: unknown[] }; plan: { frame: { capability: string } }; project: { brief: unknown } }>("start_quick_ad", {
      projectId: project.id,
      brief: TWO_LINES,
    });
    assert.equal(started.content.mode, "quick");
    assert.equal(started.content.shots.length, 1);
    assert.deepEqual(started.project.brief, quickBrief({ brief: TWO_LINES }));
    assert.equal(started.plan.frame.capability, "text_to_image", "nothing in the Library, so the frame comes from the two lines");
    assert.equal(store.documents.list("brief", project.id).length, 1, "the brief is a versioned document");
    const contentId = started.content.id;
    assert.equal(nextStage(loadSnapshot(store, project.id)!).title, "Quick Ad frame (0 of 3 approvals given)");

    // The frame: one candidate, through the gate (submit_proposal), then approval 1.
    const frame = await ok<{ count: number; capability: string; estimate: { kind: string } }>("compose_still", { contentId, beatIndex: 1 });
    assert.equal(frame.count, 1, "a Quick Ad proposes one frame");
    assert.equal(frame.capability, "text_to_image");
    const frames = await ok<{ results: { outcome: string; assetIds: string[] }[] }>("submit_proposal", { proposal: frame, wait: true });
    assert.equal(frames.results.length, 1);
    await ok("approve", { kind: "still", contentId, beatIndex: 1, assetId: frames.results[0].assetIds[0] });
    assert.match(nextStage(loadSnapshot(store, project.id)!).guidance, /generate_clip with contentId/);

    // The talking clip: four seconds with the line, through the gate, then approval 2.
    const clip = await ok<{ count: number; durationSeconds: number; prompt: string }>("generate_clip", { contentId, beatIndex: 1 });
    assert.deepEqual([clip.count, clip.durationSeconds], [1, QUICK_AD.durationSeconds]);
    const clips = await ok<{ results: { assetIds: string[] }[] }>("submit_proposal", { proposal: clip, wait: true });
    await ok("approve", { kind: "clip", contentId, beatIndex: 1, assetId: clips.results[0].assetIds[0] });
    assert.equal(nextStage(loadSnapshot(store, project.id)!).title, "Quick Ad export (2 of 3 approvals given)");

    // The export: approval 3.
    const assembled = await ok<{ export: { status: string; filterSummary?: string; sources: { onScreenText: string }[] }; asset: { id: string; width: number; height: number; video: { durationSeconds: number } } }>("assemble_ad", {
      contentId,
      captions: true,
    });
    assert.equal(assembled.export.status, "completed");
    assert.deepEqual([assembled.asset.width, assembled.asset.height], [1080, 1920]);
    assert.ok(Math.abs(assembled.asset.video.durationSeconds - QUICK_AD.durationSeconds) < 0.1);
    assert.equal(assembled.export.sources[0].onScreenText, "Ridgeline 32 oz insulated bottle");
    assert.match(assembled.export.filterSummary ?? "", /drawtext captions/);
    const probed = await probeVideo(resolveMediaPath(store.dataDir, store.assets.getRequired(assembled.asset.id).relativePath));
    assert.deepEqual([probed.codec, probed.width, probed.height], ["h264", 1080, 1920]);

    const approvals = calls.filter((name) => name === "approve" || name === "assemble_ad");
    assert.equal(approvals.length, 3, "three approvals: the frame, the clip, the export");
    assert.equal(calls.filter((name) => name === "submit_proposal").length, 2, "each generation passed the spend gate once");
    assert.equal(nextStage(loadSnapshot(store, project.id)!).id, "next");
  });

  test("with a linked character and product photo, the frame is a composition from the sheet or face and the photo", async () => {
    const { store, ok, project, now } = setup();
    const saved = await ok<{ character: { id: string } }>("save_character_bible", { projectId: project.id, wardrobe: "Olive utility jacket over a white tee", bible: averyBible() });
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#2a4d6e" } }).png().toBuffer();
    const face = await importImage(store, { projectId: project.id, name: "face.png", bytes: png }, { now: now(), newId: randomUUID });
    await ok("select_reference", { characterId: saved.character.id, slot: "face", assetId: face.id });
    const photo = await importImage(store, { projectId: null, name: "ridgeline.png", bytes: png }, { now: now(), newId: randomUUID });
    await ok("save_product", { projectId: project.id, product: ridgelineProduct([photo.id]) });

    const started = await ok<{ content: { id: string }; plan: { frame: { capability: string } }; script: { beats: { visual: string }[] } }>("start_quick_ad", { projectId: project.id, brief: TWO_LINES, spokenLine: "It was still cold at five." });
    assert.equal(started.plan.frame.capability, "image_edit");
    assert.equal(started.script.beats[0].visual, "The creator holds the product up beside their face and talks straight to the camera.");
    const frame = await ok<{ count: number; capability: string; references: { assetId: string }[]; prompt: string }>("compose_still", { contentId: started.content.id, beatIndex: 1 });
    assert.equal(frame.capability, "image_edit");
    assert.equal(frame.count, 1);
    assert.deepEqual(frame.references.map((reference) => reference.assetId), [face.id, photo.id]);
    assert.doesNotMatch(frame.prompt, /Ridgeline/, "the product is described by its appearance, never its name");
  });

  test("a full Ad still proposes four stills by default", async () => {
    const { ok, project } = setup();
    const script = await ok<{ script: { id: string } }>("save_script", { projectId: project.id, title: "Full", beats: [quickAdBeat({ brief: TWO_LINES }, { character: false, product: false })] });
    const content = await ok<{ id: string; mode: string }>("plan_shots", { projectId: project.id, scriptId: script.script.id });
    assert.equal(content.mode, "full");
    const proposal = await ok<{ count: number }>("compose_still", { contentId: content.id, beatIndex: 1 });
    assert.equal(proposal.count, 4);
  });
});
