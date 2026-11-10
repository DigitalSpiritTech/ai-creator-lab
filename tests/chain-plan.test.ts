/**
 * Length as a capability (v0.2 F4), the pure half: which strategy each starter recipe resolves for a
 * take (native, one whole-take workflow, chained segments, or refused), how a chain is planned
 * (fewest segments, the crossfade taken from spare length), and the segment prompts (the line
 * shared out word for word, continuity written in, H3 through its own chain renderer).
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import {
  type Recipe,
  LENGTH_LABELS,
  MIN_OVERLAP_SECONDS,
  backendAllowsCustomGraphs,
  hardMaxSeconds,
  nativeMaxSeconds,
  planChain,
  resolveLengthStrategy,
  seamTimes,
} from "@creator-lab/core/catalog";
import { BeatSchema } from "@creator-lab/core/domain/script";
import type { ClipSpec } from "@creator-lab/core/domain/shot-spec";
import { CONTINUES_FROM, SETS_UP, renderChain, splitLine } from "@creator-lab/recipes/chain";
import { defaultRecipes } from "@creator-lab/recipes/defaults";

const workflowsDir = fileURLToPath(new URL("../packages/recipes/workflows", import.meta.url));

function describeStrategy(recipe: Recipe, seconds: number): string {
  const strategy = resolveLengthStrategy(recipe, seconds);
  if (strategy.kind === "native") return `native ${LENGTH_LABELS[strategy.mechanism]}`;
  if (strategy.kind === "chained") return `chained ${strategy.drive} x${strategy.plan.segments.length}`;
  return strategy.kind;
}

describe("chain planning", () => {
  test("20 s on a 5 s model is four segments; with no spare length the crossfade is two frames and the take 0.25 s short", () => {
    const plan = planChain(20, 5);
    assert.equal(plan.segments.length, 4);
    assert.equal(plan.overlapSeconds, Math.round(MIN_OVERLAP_SECONDS * 1000) / 1000);
    assert.deepEqual(plan.segments.map((segment) => segment.durationSeconds), [5, 5, 5, 5]);
    assert.equal(plan.totalSeconds, 19.75);
    assert.deepEqual(plan.segments.map((segment) => segment.startSeconds), [0, 4.917, 9.834, 14.751]);
    assert.deepEqual(seamTimes(plan), [4.959, 9.875, 14.792]);
  });

  test("spare length becomes the crossfade, up to 0.25 s, and the take comes out at the length asked", () => {
    const h3 = planChain(20, 124 / 24);
    assert.equal(h3.segments.length, 4);
    assert.ok(h3.overlapSeconds > 0.2 && h3.overlapSeconds < 0.25, String(h3.overlapSeconds));
    assert.ok(Math.abs(h3.totalSeconds - 20) < 0.01);
    const roomy = planChain(18, 5);
    assert.equal(roomy.overlapSeconds, 0.25);
    assert.equal(roomy.totalSeconds, 18);
    assert.equal(planChain(10, 121 / 24).segments.length, 2);
  });

  test("another segment is added only when the take would fall more than half a second short, and thirteen is the most", () => {
    assert.equal(planChain(20.4, 5).segments.length, 5);
    assert.equal(planChain(19.9, 5).segments.length, 4);
    assert.equal(planChain(60, 5).segments.length, 13);
    assert.throws(() => planChain(60, 4.5), /more than 13 segments/);
  });
});

describe("strategy per recipe", async () => {
  const recipes = await defaultRecipes(workflowsDir, { mocks: true });
  const byId = (id: string) => recipes.find((recipe) => recipe.id === id)!;

  test("the starter video recipes: native up to their one-run length, then chained, ending frames refused past their limit", () => {
    const table = Object.fromEntries(
      [
        "ltx-2.5-i2v",
        "ltx-2.5-flf2v",
        "minimax-h3-i2v",
        "minimax-h3-flf2v",
        "minimax-h3-multiframe",
        "wan-2.2-i2v",
        "wan-2.2-flf2v",
        "wan-2.2-s2v",
        "router-kling-3-omni-i2v",
        "router-kling-3-omni-flf2v",
        "router-wan-3-i2v",
        "mock-image-to-video",
        "mock-speech-to-video",
      ].map((id) => [id, [nativeMaxSeconds(byId(id)), ...[5, 10, 20].map((seconds) => describeStrategy(byId(id), seconds))]]),
    );
    assert.deepEqual(table, {
      "ltx-2.5-i2v": [5.042, "native one run", "chained first_frame x2", "chained first_frame x4"],
      "ltx-2.5-flf2v": [5.042, "native one run", "native one run", "unsupported"],
      "minimax-h3-i2v": [5.167, "native one run", "chained first_frame x2", "chained first_frame x4"],
      "minimax-h3-flf2v": [5.167, "native H3 last frame", "native H3 last frame", "unsupported"],
      "minimax-h3-multiframe": [8, "native H3 multi-frame", "native H3 multi-frame", "unsupported"],
      "wan-2.2-i2v": [5.063, "native one run", "chained first_frame x2", "chained first_frame x4"],
      "wan-2.2-flf2v": [5.063, "native one run", "native one run", "unsupported"],
      "wan-2.2-s2v": [4.813, "native one run", "chained audio x3", "chained audio x5"],
      "router-kling-3-omni-i2v": [15, "native Kling first/last", "native Kling first/last", "chained first_frame x2"],
      "router-kling-3-omni-flf2v": [15, "native Kling first/last", "native Kling first/last", "unsupported"],
      "router-wan-3-i2v": [5, "native one run", "chained first_frame x2", "chained first_frame x4"],
      "mock-image-to-video": [5, "native one run", "chained first_frame x2", "chained first_frame x4"],
      "mock-speech-to-video": [5, "native one run", "chained audio x2", "chained audio x4"],
    });
    assert.equal(hardMaxSeconds(byId("ltx-2.5-flf2v")), 15, "an ending-frame recipe keeps one run up to a beat's 15 s, as before");
    assert.equal(hardMaxSeconds(byId("wan-2.2-s2v")), 4.813, "a declared frame limit is the hard limit");
    const refused = resolveLengthStrategy(byId("ltx-2.5-flf2v"), 20);
    assert.ok(refused.kind === "unsupported" && /An ending frame pins the end of one run/.test(refused.reason));
  });

  test("half a second over a workflow's length is still one run (it snaps); Router durations are exact", () => {
    assert.equal(resolveLengthStrategy(byId("ltx-2.5-i2v"), 5.5).kind, "native");
    assert.equal(resolveLengthStrategy(byId("ltx-2.5-i2v"), 5.6).kind, "chained");
    assert.equal(resolveLengthStrategy(byId("router-kling-3-omni-i2v"), 15.2).kind, "chained");
  });

  test("a whole-take community workflow runs as one job where the backend runs custom graphs, and is refused on a deployment", () => {
    const base = byId("wan-2.2-s2v");
    const whole = { ...base, id: "community-long-s2v", title: "A community long-take workflow", length: { longer: "workflow" as const } } as Recipe;
    assert.equal(resolveLengthStrategy(whole, 30, { customGraphs: true }).kind, "workflow");
    const deployed = resolveLengthStrategy(whole, 30, { customGraphs: false });
    assert.ok(deployed.kind === "unsupported" && /deployed with/.test(deployed.reason));
    assert.ok(backendAllowsCustomGraphs("cloud") && backendAllowsCustomGraphs("comfyui") && backendAllowsCustomGraphs(undefined));
    assert.ok(!backendAllowsCustomGraphs("deployment") && !backendAllowsCustomGraphs("router"));
    assert.equal(resolveLengthStrategy(base, 61).kind, "unsupported");
  });
});

function clipSpec(overrides: Partial<ClipSpec> & { line?: string; type?: "talking" | "broll" } = {}): ClipSpec {
  const beat = BeatSchema.parse({
    index: 1,
    type: overrides.type ?? "talking",
    purpose: "hook",
    spokenLine: overrides.line ?? "I stopped buying bottled water the day this fit my cup holder. It stays cold all day, and I never think about it.",
    onScreenText: "",
    visual: "Avery in the driver's seat holding the bottle, morning light.",
    setting: "a car interior",
    productVisible: true,
    durationSeconds: 15,
  });
  return {
    kind: "clip",
    beat,
    mode: overrides.mode ?? "start",
    durationSeconds: 15,
    character: { name: "Avery Lane", visualCore: "Avery Lane, a woman in her early 30s.", wardrobe: "an olive utility jacket over a white tee" },
    product: { name: "Ridgeline 32 oz insulated bottle", appearance: "a matte dark green steel bottle with a black screw cap" },
  };
}

describe("segment prompts", async () => {
  const recipes = await defaultRecipes(workflowsDir, { mocks: true });
  const ltx = recipes.find((recipe) => recipe.id === "ltx-2.5-i2v")!;
  const h3 = recipes.find((recipe) => recipe.id === "minimax-h3-i2v")!;

  test("the line is shared out by time, cut at punctuation, word for word", () => {
    const plan = planChain(15, 5);
    const parts = splitLine("I stopped buying bottled water the day this fit my cup holder. It stays cold all day, and I never think about it.", plan);
    assert.equal(parts.length, 3);
    assert.equal(parts.join(" "), "I stopped buying bottled water the day this fit my cup holder. It stays cold all day, and I never think about it.");
    assert.ok(parts.every((part) => part.length > 0));
    assert.ok(parts.slice(0, -1).some((part) => /[.,]$/.test(part)), `a cut lands on punctuation: ${JSON.stringify(parts)}`);
  });

  test("LTX: each segment is the house clip prompt for its share of the line, carrying on from the start image and setting up the next", () => {
    const plan = planChain(15, 5);
    const rendered = renderChain(clipSpec(), plan, ltx);
    assert.ok(rendered.ok);
    const [first, second, third] = rendered.segments;
    assert.ok(first.prompt.startsWith("Use the provided start image as the first frame."));
    assert.ok(first.prompt.endsWith(SETS_UP.talking));
    assert.ok(second.prompt.startsWith(CONTINUES_FROM));
    assert.ok(!third.prompt.includes(SETS_UP.talking), "the last segment sets nothing up");
    for (const segment of rendered.segments) {
      assert.ok(segment.prompt.includes(`"${segment.line.replace(/[,]$/, ".")}`) || segment.prompt.includes(segment.line), `segment ${segment.index} speaks its own words`);
      assert.ok(!segment.prompt.includes("Ridgeline"), "the product is never named");
      assert.equal(segment.spec.durationSeconds, 5);
    }
  });

  test("MiniMax H3: segments go through the H3 chain renderer (continues from <Picture 1>, sets up the next moment)", () => {
    const rendered = renderChain(clipSpec(), planChain(15, 124 / 24), h3);
    assert.ok(rendered.ok, rendered.ok ? "" : rendered.error);
    assert.match(rendered.segments[0].prompt, /begins from <Picture 1>/);
    assert.match(rendered.segments[0].prompt, /setting up the next moment/);
    assert.match(rendered.segments[1].prompt, /continues from <Picture 1>, the last frame of the previous segment/);
    assert.doesNotMatch(rendered.segments[2].prompt, /setting up the next moment/);
    assert.ok(rendered.segments.every((segment) => segment.prompt.includes("<d>")), "every segment speaks its words in H3's dialogue tag");
    const speech = renderChain(clipSpec({ mode: "speech" }), planChain(15, 5), h3);
    assert.ok(!speech.ok && /does not lip-sync/.test(speech.error));
  });

  test("a line too short or too dense for the take is refused with the reason", () => {
    const sparse = renderChain(clipSpec({ line: "Cold all day." }), planChain(20, 5), ltx);
    assert.ok(!sparse.ok && /too few for a 19.75 s take in 4 segments/.test(sparse.error));
    const broll = renderChain(clipSpec({ type: "broll" }), planChain(10, 5), ltx);
    assert.ok(broll.ok && broll.segments.every((segment) => segment.line === "") && broll.segments[0].prompt.endsWith(SETS_UP.broll));
  });
});
