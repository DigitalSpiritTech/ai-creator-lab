/**
 * Client helpers and cards: SSE parsing across chunk boundaries, folding assistant events and stored
 * history into the transcript, cost and status text, polling decisions, and server-rendered cards.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProposalCard } from "@/components/cards/proposal-card";
import { ToolCard } from "@/components/cards/tool-card";
import { ToolSteps } from "@/components/cards/tool-steps";
import { groupSteps } from "@/components/project/chat-panel";
import { summarizeTool } from "@/lib/client/tool-summary";
import { shotStatus, slotStatus } from "@/components/project/shots-tab";
import { sheetChecklist } from "@/components/project/sheet-checklist";
import { assetQuery } from "@/components/assets/asset-browser";
import type { ChatItem } from "@/components/project/project-context";
import { applyAgentEvent, historyToItems, parseAgentEvent } from "@/lib/client/chat";
import { ASSET_KINDS, assetKindInfo, budgetBlock, describeBudgetBlock, describeEstimate, describeSpendWarning, describeTarget, formatPeriodDate, formatUsdCredits, shouldPoll, suggestedExtensionUsd, summarizeSubmit } from "@/lib/client/format";
import { AssetMedia } from "@/components/media/asset-media";
import { ProductForm } from "@/components/library/product-form";
import { MonthlyBudget, ProviderChoice } from "@/components/settings/settings-form";
import { productFields } from "@/lib/client/library";
import { AssetKindSchema } from "@creator-lab/core/domain/asset";
import { createSseParser, encodeSse } from "@/lib/client/sse";
import type { GenerationProposal, SettingsView, SubmitResult } from "@/lib/client/types";
import { budgetCrossing, budgetPeriod, composeSpendPolicy } from "@creator-lab/core/domain/spend";
import { DEFAULT_WORKSPACE_SETTINGS } from "@creator-lab/core/domain/workspace";

function proposal(overrides: Partial<GenerationProposal> = {}): GenerationProposal {
  return {
    id: randomUUID(),
    projectId: randomUUID(),
    capability: "text_to_image",
    recipeId: "mock-text-to-image",
    recipeTitle: "Z-Image Turbo",
    prompt: "3/4 view headshot of Avery Lane, early 30s, light freckles",
    references: [],
    count: 4,
    target: { kind: "loose" },
    estimate: { kind: "quoted", usd: 0.05, credits: 10.5, note: "" },
    ...overrides,
  };
}

let ids = 0;
const newId = (prefix: string) => `${prefix}-${++ids}`;

describe("sse", () => {
  test("parses frames split across chunks and multi-line data", () => {
    const parser = createSseParser();
    const frame = encodeSse({ type: "text", delta: "Hello" } as { type: string });
    assert.deepEqual(parser.push(frame.slice(0, 7)), []);
    const [message] = parser.push(frame.slice(7) + "event: x\r\ndata: a\r\ndata: b\r\n\r\n: comment\n\n");
    assert.equal(message.event, "text");
    assert.deepEqual(JSON.parse(message.data), { type: "text", delta: "Hello" });
    assert.deepEqual(parser.push(""), []);
    const parser2 = createSseParser();
    assert.deepEqual(parser2.push("event: x\ndata: a\ndata: b\n\n"), [{ event: "x", data: "a\nb" }]);
    assert.deepEqual(parser2.push("data: tail"), []);
    assert.deepEqual(parser2.flush(), [{ event: "message", data: "tail" }]);
  });

  test("parseAgentEvent accepts only known event types", () => {
    assert.deepEqual(parseAgentEvent('{"type":"text","delta":"hi"}'), { type: "text", delta: "hi" });
    assert.equal(parseAgentEvent('{"type":"other"}'), null);
    assert.equal(parseAgentEvent("not json"), null);
  });
});

describe("transcript", () => {
  test("streams text into one bubble, tool cards between, and proposals as cards", () => {
    let items: ChatItem[] = [{ kind: "user", id: "u1", text: "Write the brief" }];
    const start = items.length;
    items = applyAgentEvent(items, { type: "text", delta: "Saving " }, start, newId);
    items = applyAgentEvent(items, { type: "text", delta: "the brief." }, start, newId);
    assert.equal(items.length, 2);
    assert.equal(items[1].kind === "assistant" && items[1].text, "Saving the brief.");
    items = applyAgentEvent(items, { type: "tool_call", id: "t1", name: "save_brief", input: { tone: "warm" } }, start, newId);
    items = applyAgentEvent(items, { type: "tool_result", id: "t1", name: "save_brief", ok: true, output: { ok: 1 } }, start, newId);
    const tool = items[2];
    assert.ok(tool.kind === "tool" && tool.activity.status === "ok" && (tool.activity.input as { tone: string }).tone === "warm");
    items = applyAgentEvent(items, { type: "text", delta: "Done." }, start, newId);
    assert.equal(items.length, 4, "text after a tool card starts a new bubble");
    const made = proposal();
    items = applyAgentEvent(items, { type: "proposal", proposal: made }, start, newId);
    items = applyAgentEvent(items, { type: "error", message: "Stopped." }, start, newId);
    items = applyAgentEvent(items, { type: "done", messageId: "m", usage: { inputTokens: 1, outputTokens: 1 } }, start, newId);
    assert.deepEqual(items.slice(4).map((item) => item.kind), ["proposal", "notice"]);
  });

  test("rebuilds history with tool results and proposals that never auto-approve", () => {
    const made = proposal();
    const items = historyToItems([
      { id: "m1", role: "user", content: [{ type: "text", text: "Four headshots please" }] },
      { id: "m2", role: "assistant", content: [{ type: "text", text: "Here is a proposal." }, { type: "tool_use", id: "t1", name: "propose_candidates", input: {} }] },
      { id: "m3", role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: JSON.stringify(made) }] },
      { id: "m4", role: "assistant", content: [{ type: "tool_use", id: "t2", name: "save_brief", input: {} }] },
    ]);
    assert.deepEqual(items.map((item) => item.kind), ["user", "assistant", "tool", "proposal", "tool"]);
    const card = items[3];
    assert.ok(card.kind === "proposal" && card.source === "history" && card.proposal.id === made.id);
    const dangling = items[4];
    assert.ok(dangling.kind === "tool" && dangling.activity.status === "error");
  });
});

describe("format", () => {
  test("cost lines multiply the per-run estimate by the count", () => {
    assert.equal(describeEstimate({ kind: "quoted", usd: 0.05, credits: 10.5, note: "" }, 4), "About $0.20 (42 credits)");
    assert.equal(describeEstimate({ kind: "quoted", usd: 0.05, credits: 10.5, source: "hint", note: "About 6 credits." }, 4), "Up to $0.20 (42 credits) reserved");
    assert.equal(describeEstimate({ kind: "free", usd: 0, credits: 0, note: "" }, 4), "Free (mock run)");
    assert.equal(describeEstimate({ kind: "unquoted", usd: 0.5, credits: null, note: "" }, 2), "Up to $1.00 reserved (no live price)");
    assert.equal(describeEstimate({ kind: "rejected", usd: null, credits: null, note: "x" }, 1), "Cannot run");
    assert.equal(describeTarget({ kind: "shot", contentId: randomUUID(), beatIndex: 2, slot: "clip" }), "Beat 2 clip");
  });

  test("submit summaries and polling decisions", () => {
    const base = { requestId: randomUUID(), job: null, assetIds: [], reserveUsd: null, budget: null };
    assert.deepEqual(summarizeSubmit([{ ...base, outcome: "started", message: null }, { ...base, outcome: "started", message: null }]), { tone: "ok", text: "2 candidates submitted." });
    assert.equal(summarizeSubmit([{ ...base, outcome: "blocked", message: "Allowance is zero." }]).tone, "error");
    assert.equal(summarizeSubmit([{ ...base, outcome: "needs_confirmation", message: "Confirm" }]).tone, "warn");
    assert.equal(shouldPoll([]), false);
    assert.equal(shouldPoll([{ status: "running" }]), true);
    assert.equal(shouldPoll([{ status: "completed" }, { status: "failed" }]), false);
    assert.equal(assetQuery({ state: "archived", projectId: "", kind: "video", recipeId: "" }), "/api/assets?state=archived&kind=video");
  });

  test("budget helpers: credits beside USD, the 50/80/100 notices, and the suggested extension", () => {
    assert.equal(formatUsdCredits(4.8), "$4.80 (1,008 credits)");
    assert.equal(formatUsdCredits(0.5), "$0.50 (105 credits)");
    assert.equal(formatPeriodDate(Date.UTC(2026, 11, 15)), "December 15");
    assert.equal(describeSpendWarning(0, null), null);
    assert.equal(describeSpendWarning(50, null)?.tone, "warn");
    assert.match(describeSpendWarning(80, null)!.text, /80 percent/);
    assert.match(describeSpendWarning(100, Date.UTC(2026, 11, 1))!.text, /resets on December 1/);
    assert.equal(suggestedExtensionUsd({ neededUsd: 0.3, maxExtensionUsd: 5 }), 1);
    assert.equal(suggestedExtensionUsd({ neededUsd: 1.004, maxExtensionUsd: 5 }), 2);
    assert.equal(suggestedExtensionUsd({ neededUsd: 0.3, maxExtensionUsd: 0.5 }), 0.5);
  });

  test("a budget block counts the candidates that already ran, so the card never says nothing ran when some did", () => {
    const now = Date.UTC(2026, 10, 20);
    const totals = { spentUsd: 4.8, reservedUsd: 0 };
    const spend = composeSpendPolicy({ period: budgetPeriod(now, 1), ceilingPeriod: budgetPeriod(now, 1), limitUsd: 5, ceilingUsd: 10, extensionUsd: 0, totals, ceilingTotals: totals });
    const crossing = budgetCrossing(spend, 0.5)!;
    const job = { id: randomUUID() } as unknown as SubmitResult["job"];
    const base = { requestId: randomUUID(), assetIds: [], message: null, reserveUsd: null, budget: null };
    const blocked = { ...base, outcome: "blocked" as const, job: null, budget: crossing };
    assert.deepEqual(budgetBlock([blocked]), { crossing, ran: 0 });
    assert.deepEqual(budgetBlock([{ ...base, outcome: "existing", job }, { ...base, outcome: "started", job }, blocked]), { crossing, ran: 2 });
    assert.equal(budgetBlock([{ ...base, outcome: "blocked", job: null, message: "Paid generation is off." }]), null, "a block without a crossing is not the extend dialog");
    assert.equal(describeBudgetBlock(0), "Approving this would go over this month's budget. Nothing was generated.");
    assert.match(describeBudgetBlock(1), /^1 candidate has already run/);
    assert.match(describeBudgetBlock(2), /^2 candidates have already run/);
  });

  test("shot and sheet helpers", () => {
    const id = randomUUID();
    assert.equal(slotStatus({ state: "empty" }, "still"), "No still yet");
    assert.equal(slotStatus({ state: "open", candidateIds: [id], selectedId: null }, "still"), "1 still candidate");
    const shot = { id, beatIndex: 1, still: { state: "approved" as const, candidateIds: [id], assetId: id, approvedAt: 1 }, clip: { state: "empty" as const }, voice: { state: "empty" as const }, brokenAssetIds: [] };
    assert.equal(shotStatus(shot), "Needs a clip");
    assert.ok(sheetChecklist("Olive utility jacket over a white tee").some((line) => line.includes("Olive utility jacket")));
  });
});

describe("cards", () => {
  test("proposal card shows recipe, count, cost, and the gate buttons", () => {
    const html = renderToStaticMarkup(createElement(ProposalCard, { proposal: proposal() }));
    assert.match(html, /Z-Image Turbo/);
    assert.match(html, /About \$0\.20/);
    assert.match(html, />4</);
    assert.match(html, /Approve and generate/);
    assert.match(html, /Cancel/);
  });

  test("proposal card says which model the prompt was written for and lets the person edit it", () => {
    const html = renderToStaticMarkup(createElement(ProposalCard, { proposal: proposal({ promptStyle: "gemini-image" }) }));
    assert.match(html, /Written for Nano Banana \(Gemini image\)/);
    assert.match(html, /<textarea[^>]*aria-label="Prompt"/);
    assert.match(html, /\/ 8,000 characters/);
    assert.doesNotMatch(html, /Use for the rest of this project/, "outside a project page there is no project to save a preference to");
    assert.deepEqual(summarizeTool("set_recipe_preference", { capability: "image_edit" }, { recipeTitle: "Nano Banana Pro on Comfy Router" }, "ok").title, "Set Nano Banana Pro on Comfy Router for image edit in this project");
    assert.equal(summarizeTool("set_recipe_preference", { capability: "image_edit" }, { recipeTitle: null }, "ok").title, "Cleared this project's image edit preference");
    assert.equal(summarizeTool("regenerate_with", {}, { recipeTitle: "GPT Image 2", count: 1, estimate: { kind: "free", usd: 0, credits: 0, note: "" } }, "ok").title, "Proposed the same shot with another model");
  });

  test("auto-approve shows the submission instead of the buttons; a rejected estimate cannot run", () => {
    const auto = renderToStaticMarkup(createElement(ProposalCard, { proposal: proposal(), autoApprove: true }));
    assert.match(auto, /Auto-approved under your budget/);
    assert.doesNotMatch(auto, /Approve and generate/);
    const rejected = renderToStaticMarkup(createElement(ProposalCard, { proposal: proposal({ estimate: { kind: "rejected", usd: null, credits: null, note: "No key" } }), autoApprove: true }));
    assert.match(rejected, /disabled/);
    assert.doesNotMatch(rejected, /Auto-approved/);
  });

  test("tool card says what the call did in plain words and keeps the JSON behind a second toggle", () => {
    const html = renderToStaticMarkup(createElement(ToolCard, { activity: { id: "t", name: "save_brief", input: {}, status: "ok" } }));
    assert.match(html, /Saved the brief/);
    assert.match(html, /Raw input and output/);
    const running = renderToStaticMarkup(createElement(ToolCard, { activity: { id: "t", name: "compose_still", input: { beatIndex: 6 }, status: "running" } }));
    assert.match(running, /Compose still…/);
    const proposal = {
      recipeTitle: "Qwen Image Edit 2511, one reference, on Comfy Cloud",
      count: 4,
      estimate: { kind: "quoted", usd: 0.07, credits: 14.8, source: "hint", note: "About 6 credits at 768x1344." },
    };
    assert.deepEqual(summarizeTool("compose_still", { contentId: "c", beatIndex: 6 }, proposal, "ok"), {
      title: "Proposed a still for beat 6",
      detail: "Qwen Image Edit 2511, one reference, on Comfy Cloud · 4 candidates · up to 59 credits",
    });
    assert.deepEqual(summarizeTool("generate_clip", { contentId: "c", beatIndex: 1, mode: "speech" }, { recipeTitle: "Wan 2.2 S2V", count: 1, estimate: { kind: "free" } }, "ok"), {
      title: "Proposed a lip-synced clip for beat 1",
      detail: "Wan 2.2 S2V · 1 candidate · free",
    });
    assert.deepEqual(summarizeTool("save_script", { beats: [1, 2, 3] }, { script: { version: 2 } }, "ok"), { title: "Saved the script (version 2), 3 beats", detail: "" });
    assert.deepEqual(summarizeTool("approve", { kind: "voice", beatIndex: 2 }, {}, "ok"), { title: "Approved the voice for beat 2", detail: "" });
    assert.deepEqual(summarizeTool("some_new_tool", {}, {}, "ok"), { title: "Some new tool", detail: "" });
    assert.deepEqual(summarizeTool("save_brief", {}, { code: "invalid", message: "Tone is required." }, "error"), { title: "Save brief failed", detail: "Tone is required." });
  });

  test("a turn's tool calls fold into one steps line that names the running step, then counts the steps", () => {
    const items: ChatItem[] = [
      { kind: "user", id: "u", text: "Save the brief" },
      { kind: "tool", id: "t1", activity: { id: "1", name: "get_project_state", input: {}, status: "ok", output: {} } },
      { kind: "tool", id: "t2", activity: { id: "2", name: "save_brief", input: {}, status: "ok", output: {} } },
      { kind: "assistant", id: "a", text: "Saved." },
      { kind: "tool", id: "t3", activity: { id: "3", name: "compose_still", input: { beatIndex: 2 }, status: "running" } },
    ];
    const grouped = groupSteps(items);
    assert.deepEqual(grouped.map((item) => item.kind), ["user", "steps", "assistant", "steps"]);
    const first = grouped[1];
    assert.ok(first.kind === "steps" && first.activities.length === 2);
    const done = renderToStaticMarkup(createElement(ToolSteps, { activities: first.kind === "steps" ? first.activities : [] }));
    assert.match(done, /2 steps/);
    assert.match(done, /Read the project · Saved the brief/);
    assert.match(done, /aria-label="done"/);
    const last = grouped[3];
    const running = renderToStaticMarkup(createElement(ToolSteps, { activities: last.kind === "steps" ? last.activities : [] }));
    assert.match(running, /Compose still…/);
    assert.match(running, /aria-label="running"/);
    const failed = renderToStaticMarkup(createElement(ToolSteps, { activities: [{ id: "4", name: "save_script", input: {}, status: "error", output: { message: "A 20-word line needs about 8 s." } }] }));
    assert.match(failed, /1 step, 1 failed/);
    assert.match(failed, /A 20-word line needs about 8 s\./);
  });
});

describe("asset kinds", () => {
  test("every asset kind has a label, and exports render as playable video with a poster", () => {
    assert.deepEqual(Object.keys(ASSET_KINDS).sort(), [...AssetKindSchema.options].sort());
    assert.equal(ASSET_KINDS.export.playable, true);
    assert.equal(assetKindInfo("export").label, "Export");
    assert.equal(assetKindInfo("unknown-kind").playable, false);
    const id = randomUUID();
    const html = renderToStaticMarkup(
      createElement(AssetMedia, { asset: { id, kind: "export", mime: "video/mp4", video: { durationSeconds: 15, frameRate: 24, frameCount: 360, hasAudio: true, posterPath: `media/${id}.png` } }, controls: true }),
    );
    assert.match(html, /<video/);
    assert.match(html, new RegExp(`poster="/api/assets/${id}\\?poster"`));
  });
});

describe("product appearance and assistant provider", () => {
  test("the product form edits appearance and linking keeps it", () => {
    const html = renderToStaticMarkup(createElement(ProductForm, { onSaved: () => undefined }));
    assert.match(html, /Appearance/);
    assert.match(html, /never by its name/);
    const product = {
      id: randomUUID(), kind: "product" as const, archived: false, brokenAssetIds: [], revision: 2, createdAt: 1, updatedAt: 1,
      name: "Ridgeline 32 oz insulated bottle", appearance: "Matte sage-green steel bottle", link: null, allowedClaims: ["Dishwasher safe"], imageAssetIds: [],
    };
    assert.equal(productFields(product).appearance, "Matte sage-green steel bottle");
  });

  test("the provider choice offers direct Anthropic and Comfy Router", () => {
    const html = renderToStaticMarkup(createElement(ProviderChoice, { value: "router", fromEnvironment: false, disabled: false, onChange: () => undefined }));
    assert.match(html, /Anthropic key \(direct\)/);
    assert.match(html, /Comfy Router \(uses your Comfy credits, no Anthropic key\)/);
    assert.match(html, /checked="" value="router"/);
    const locked = renderToStaticMarkup(createElement(ProviderChoice, { value: "anthropic", fromEnvironment: true, disabled: false, onChange: () => undefined }));
    assert.match(locked, /LLM_PROVIDER in .env.local/);
  });

  test("the monthly budget section shows the period, credits, the 80 percent notice, and the ceiling read-only", () => {
    const now = Date.UTC(2026, 10, 20);
    const totals = { spentUsd: 4, reservedUsd: 0.2 };
    const spend = composeSpendPolicy({ period: budgetPeriod(now, 15), ceilingPeriod: budgetPeriod(now, 1), limitUsd: 5, ceilingUsd: 6, extensionUsd: 0, totals, ceilingTotals: totals });
    const workspace = { ...DEFAULT_WORKSPACE_SETTINGS, monthlyBudgetUsd: 5, budgetResetDay: 15 };
    const view = { workspace, keys: {} as SettingsView["keys"], spend, creditsPerUsd: 210, dataDirectory: "/data" };
    const html = renderToStaticMarkup(createElement(MonthlyBudget, { view, busy: false, onSave: () => undefined, onExtended: () => undefined, onError: () => undefined }));
    assert.match(html, /November 15 to December 15/);
    assert.match(html, /Remaining \$0\.80 \(168 credits\)/);
    assert.match(html, /80 percent of this month/);
    assert.match(html, /Operator ceiling \(GENERATION_ALLOWANCE_USD, read-only\)/);
    assert.match(html, /\$6\.00 a month/);
    assert.match(html, /Up to \$1\.00 under the operator ceiling/);
    assert.doesNotMatch(html, /id="operator/, "the ceiling has no input");
    const off = renderToStaticMarkup(
      createElement(MonthlyBudget, { view: { ...view, spend: { ...spend, ceilingUsd: 0, maxExtensionUsd: 0 } }, busy: false, onSave: () => undefined, onExtended: () => undefined, onError: () => undefined }),
    );
    assert.match(off, /Zero keeps paid generation off/);
    assert.match(off, /id="budget-extra"[^>]*disabled=""|disabled=""[^>]*id="budget-extra"/);
  });
});

describe("real photo references", () => {
  type Call = { url: string; method: string; body: unknown };
  async function withFetch<T>(work: (calls: Call[]) => Promise<T>): Promise<T> {
    const original = globalThis.fetch;
    const calls: Call[] = [];
    let uploads = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      const body = init?.body instanceof FormData ? Object.fromEntries([...init.body.entries()].map(([key, value]) => [key, typeof value === "string" ? value : (value as File).name])) : init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: path, method: init?.method ?? "GET", body });
      if (path.startsWith("/api/uploads")) {
        uploads += 1;
        return Response.json({ asset: { id: `00000000-0000-4000-8000-00000000000${uploads}`, kind: path.includes("as=sheet") ? "sheet" : "image" } }, { status: 201 });
      }
      return Response.json({ ok: true });
    }) as typeof fetch;
    try {
      return await work(calls);
    } finally {
      globalThis.fetch = original;
    }
  }
  const file = (name: string) => new File([new Uint8Array([1, 2, 3])], name, { type: "image/jpeg" });

  test("upload then select_reference for the slot, scoped to the project", async () => {
    const { lockPhotoAsReference } = await import("@/lib/client/references");
    const projectId = randomUUID();
    const characterId = randomUUID();
    await withFetch(async (calls) => {
      const asset = await lockPhotoAsReference(file("founder.jpg"), { characterId, slot: "face", projectId });
      assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), ["POST /api/uploads", `POST /api/projects/${projectId}/tools/select_reference`]);
      assert.deepEqual(calls[0].body, { image: "founder.jpg", projectId });
      assert.deepEqual(calls[1].body, { characterId, slot: "face", assetId: asset.id });
    });
    await withFetch(async (calls) => {
      await lockPhotoAsReference(file("body.jpg"), { characterId, slot: "body" });
      assert.deepEqual(calls.map((call) => call.url), ["/api/uploads", "/api/tools/select_reference"]);
    });
  });

  test("own sheet records a new wardrobe, uploads as a sheet, and approves it; sets upload every photo", async () => {
    const { approveOwnSheet, createSetFromPhotos } = await import("@/lib/client/references");
    const projectId = randomUUID();
    const character = {
      id: randomUUID(), kind: "character" as const, archived: false, brokenAssetIds: [], revision: 3, createdAt: 1, updatedAt: 1,
      bible: { ...(await import("./support/domain-fixtures")).averyBible(), references: { faceAssetId: null, bodyAssetId: null, wardrobeAssetIds: [] }, version: 1 },
    } as unknown as import("@/lib/client/types").CharacterItem;
    await withFetch(async (calls) => {
      await approveOwnSheet(file("sheet.png"), { projectId, character, currentWardrobe: null, wardrobe: "Navy blazer" });
      assert.deepEqual(calls.map((call) => call.url), [`/api/projects/${projectId}/tools/save_character_bible`, "/api/uploads?as=sheet", `/api/projects/${projectId}/tools/approve`]);
      assert.equal((calls[0].body as { wardrobe: string }).wardrobe, "Navy blazer");
      assert.equal((calls[2].body as { kind: string }).kind, "sheet");
    });
    await withFetch(async (calls) => {
      await createSetFromPhotos([file("a.jpg"), file("b.jpg")], { name: " Boardroom ", notes: "" }, projectId);
      assert.deepEqual(calls.map((call) => call.url), ["/api/uploads", "/api/uploads", `/api/projects/${projectId}/tools/create_set`]);
      assert.deepEqual((calls[2].body as { set: { name: string; imageAssetIds: string[] } }).set.name, "Boardroom");
      assert.equal((calls[2].body as { set: { imageAssetIds: string[] } }).set.imageAssetIds.length, 2);
    });
  });

  test("face and body slots need the likeness checkbox and fill non-square photos from the top", async () => {
    const { ReferenceSlot } = await import("@/components/references/reference-slot");
    const html = renderToStaticMarkup(createElement(ReferenceSlot, { slot: "face", assetId: randomUUID(), characterId: randomUUID(), onLocked: () => undefined, onError: () => undefined }));
    assert.match(html, /Use a photo/);
    assert.match(html, /I have permission to use this person(&#x27;|')s likeness\./);
    assert.match(html, /type="file"[^>]*disabled=""/);
    assert.match(html, /object-cover object-top/);
  });
});
