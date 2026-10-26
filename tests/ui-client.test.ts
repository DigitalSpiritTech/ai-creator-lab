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
import { shotStatus, slotStatus } from "@/components/project/shots-tab";
import { sheetChecklist } from "@/components/project/sheet-checklist";
import { assetQuery } from "@/components/assets/asset-browser";
import type { ChatItem } from "@/components/project/project-context";
import { applyAgentEvent, historyToItems, parseAgentEvent } from "@/lib/client/chat";
import { ASSET_KINDS, assetKindInfo, describeEstimate, describeTarget, shouldPoll, summarizeSubmit } from "@/lib/client/format";
import { AssetMedia } from "@/components/media/asset-media";
import { AssetKindSchema } from "@/lib/domain/asset";
import { createSseParser, encodeSse } from "@/lib/client/sse";
import type { GenerationProposal } from "@/lib/client/types";

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
    assert.equal(describeEstimate({ kind: "free", usd: 0, credits: 0, note: "" }, 4), "Free (mock run)");
    assert.equal(describeEstimate({ kind: "unquoted", usd: 0.5, credits: null, note: "" }, 2), "Up to $1.00 reserved (no live price)");
    assert.equal(describeEstimate({ kind: "rejected", usd: null, credits: null, note: "x" }, 1), "Cannot run");
    assert.equal(describeTarget({ kind: "shot", contentId: randomUUID(), beatIndex: 2, slot: "clip" }), "Beat 2 clip");
  });

  test("submit summaries and polling decisions", () => {
    const base = { requestId: randomUUID(), job: null, assetIds: [], reserveUsd: null };
    assert.deepEqual(summarizeSubmit([{ ...base, outcome: "started", message: null }, { ...base, outcome: "started", message: null }]), { tone: "ok", text: "2 candidates submitted." });
    assert.equal(summarizeSubmit([{ ...base, outcome: "blocked", message: "Allowance is zero." }]).tone, "error");
    assert.equal(summarizeSubmit([{ ...base, outcome: "needs_confirmation", message: "Confirm" }]).tone, "warn");
    assert.equal(shouldPoll([]), false);
    assert.equal(shouldPoll([{ status: "running" }]), true);
    assert.equal(shouldPoll([{ status: "completed" }, { status: "failed" }]), false);
    assert.equal(assetQuery({ state: "archived", projectId: "", kind: "video", recipeId: "" }), "/api/assets?state=archived&kind=video");
  });

  test("shot and sheet helpers", () => {
    const id = randomUUID();
    assert.equal(slotStatus({ state: "empty" }, "still"), "No still yet");
    assert.equal(slotStatus({ state: "open", candidateIds: [id], selectedId: null }, "still"), "1 still candidate");
    const shot = { id, beatIndex: 1, still: { state: "approved" as const, candidateIds: [id], assetId: id, approvedAt: 1 }, clip: { state: "empty" as const }, brokenAssetIds: [] };
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

  test("auto-approve shows the submission instead of the buttons; a rejected estimate cannot run", () => {
    const auto = renderToStaticMarkup(createElement(ProposalCard, { proposal: proposal(), autoApprove: true }));
    assert.match(auto, /Auto-approved under your allowance/);
    assert.doesNotMatch(auto, /Approve and generate/);
    const rejected = renderToStaticMarkup(createElement(ProposalCard, { proposal: proposal({ estimate: { kind: "rejected", usd: null, credits: null, note: "No key" } }), autoApprove: true }));
    assert.match(rejected, /disabled/);
    assert.doesNotMatch(rejected, /Auto-approved/);
  });

  test("tool card names the tool", () => {
    const html = renderToStaticMarkup(createElement(ToolCard, { activity: { id: "t", name: "save_brief", input: {}, status: "ok" } }));
    assert.match(html, /Save brief/);
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
