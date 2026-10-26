import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages";
import { toApiMessages } from "@/lib/domain/conversation";
import { GenerationProposalSchema } from "@/lib/domain/job";
import { type LlmModel, type ModelEvent, MAX_TOOL_CALLS, anthropicModel, say, scriptedModel, use } from "@/server/agent";
import { STOPPED_MESSAGE } from "@/server/agent/loop";
import { translateStream } from "@/server/agent/model";
import { conversationsOf } from "@/server/store/conversations";
import { type Harness, agentHarness, runTurn, toolResultFor } from "./support/agent-harness";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function setup(): Harness {
  const harness = agentHarness();
  cleanups.push(harness.cleanup);
  return harness;
}

const brief = { productSummary: "Ridgeline 32 oz insulated bottle", audience: "Commuters", platforms: ["TikTok", "Reels"], tone: "Warm, direct" };

describe("agent loop", () => {
  test("streams text, saves the user and assistant messages, and reports usage", async () => {
    const harness = setup();
    const model = scriptedModel([say("Hi. What are you selling, and who buys it? I can start from your product link if you have one.")]);
    const turn = await runTurn(harness, "Hello", model);
    assert.equal(turn.error, undefined);
    assert.ok(turn.events.filter((event) => event.type === "text").length > 1, "text arrives in deltas");
    assert.match(turn.text, /What are you selling/);
    const saved = conversationsOf(harness.store).listByProject(harness.project.id);
    assert.deepEqual(saved.map((message) => message.role), ["user", "assistant"]);
    assert.equal(turn.done?.messageId, saved[1].id);
    assert.ok(turn.done!.usage.inputTokens > 0 && turn.done!.usage.outputTokens > 0);
    assert.equal(model.calls[0].messages.length, 1);
    assert.match(model.calls[0].system[1].text, /Next step: 3\. Brief/);
    assert.equal(model.calls[0].tools.some((tool) => tool.name === "submit_proposal"), false);
  });

  test("runs tool calls, feeds results back, emits proposals, and refreshes the state each call", async () => {
    const harness = setup();
    const { project } = harness;
    const model = scriptedModel([
      [...say("Saving your brief."), use("save_brief", { projectId: project.id, brief }, "toolu_brief")],
      (params) => {
        assert.deepEqual(toolResultFor(params.messages, "toolu_brief")?.isError, false);
        assert.match(params.system[1].text, /Next step: 4\. Character/);
        return [use("propose_candidates", { projectId: project.id, capability: "text_to_image", prompt: "A steel bottle on a kitchen counter.", count: 2 }, "toolu_prop")];
      },
      (params) => {
        assert.match(toolResultFor(params.messages, "toolu_prop")!.content, /waiting for the user's approval.*Nothing has been generated/);
        return say("Two test images are proposed; approve the card to run them.");
      },
    ]);
    const turn = await runTurn(harness, "Ridgeline bottle, commuters, TikTok and Reels, warm", model);
    assert.equal(turn.error, undefined);
    assert.equal(model.remaining(), 0);
    assert.deepEqual(
      turn.events.map((event) => event.type).filter((type) => type !== "text"),
      ["tool_call", "tool_result", "tool_call", "tool_result", "proposal", "done"],
    );
    assert.ok(GenerationProposalSchema.safeParse(turn.proposals[0]).success);
    assert.equal(turn.proposals[0].count, 2);
    assert.equal(harness.store.jobs.listByProject(project.id).length, 0, "a proposal never submits");
    assert.equal(harness.store.projects.getRequired(project.id).brief?.tone, "Warm, direct");
    const saved = conversationsOf(harness.store).listByProject(project.id);
    assert.deepEqual(saved.map((message) => message.role), ["user", "assistant", "user", "assistant", "user", "assistant"]);
    assert.deepEqual(saved[1].content.map((block) => block.type), ["text", "tool_use"]);
    assert.equal(saved[2].content[0].type, "tool_result");
    assert.equal(turn.done?.messageId, saved[5].id);
  });

  test("returns a validation error once so the model can fix its input", async () => {
    const harness = setup();
    const { project } = harness;
    const model = scriptedModel([
      [use("save_brief", { projectId: project.id, brief: { productSummary: "Ridgeline" } }, "toolu_bad")],
      (params) => {
        const result = toolResultFor(params.messages, "toolu_bad")!;
        assert.equal(result.isError, true);
        assert.match(result.content, /Invalid input for save_brief[\s\S]*Fix the input and call save_brief again/);
        return [use("save_brief", { projectId: project.id, brief }, "toolu_good")];
      },
      say("Brief saved."),
    ]);
    const turn = await runTurn(harness, "Save my brief", model);
    assert.deepEqual(turn.toolResults.map((result) => result.ok), [false, true]);
    assert.notEqual(harness.store.projects.getRequired(project.id).brief, null);
  });

  test("after two invalid inputs the tool is refused for the rest of the turn", async () => {
    const harness = setup();
    const { project } = harness;
    const bad = { projectId: project.id, brief: {} };
    const model = scriptedModel([
      [use("save_brief", bad, "toolu_1")],
      (params) => {
        assert.match(toolResultFor(params.messages, "toolu_1")!.content, /Fix the input/);
        return [use("save_brief", bad, "toolu_2")];
      },
      (params) => {
        assert.match(toolResultFor(params.messages, "toolu_2")!.content, /Do not retry/);
        return [use("save_brief", bad, "toolu_3")];
      },
      (params) => {
        assert.match(toolResultFor(params.messages, "toolu_3")!.content, /failed validation twice/);
        return say("I could not save the brief: the audience and platforms are missing. Who buys it?");
      },
    ]);
    const turn = await runTurn(harness, "Save it", model);
    assert.deepEqual(turn.toolResults.map((result) => result.ok), [false, false, false]);
    assert.match(turn.text, /could not save the brief/);
  });

  test(`caps a turn at ${MAX_TOOL_CALLS} tool calls and then asks for text only`, async () => {
    const harness = setup();
    const { project } = harness;
    const nine = Array.from({ length: 9 }, (_, index) => use("get_project_state", { projectId: project.id }, `toolu_state_${index}`));
    const model = scriptedModel([
      nine,
      (params) => {
        assert.equal(params.toolChoice, "none");
        assert.match(toolResultFor(params.messages, "toolu_state_8")!.content, /^budget: The limit of 8 tool calls/);
        assert.match(toolResultFor(params.messages, "toolu_state_0")!.content, /Project "Bottle launch, October"/);
        return say("Here is where things stand.");
      },
    ]);
    const turn = await runTurn(harness, "Status?", model);
    assert.equal(turn.toolResults.filter((result) => result.ok).length, MAX_TOOL_CALLS);
    assert.equal(turn.toolResults.at(-1)!.ok, false);
    assert.equal(turn.done !== undefined, true);
  });

  test("never runs submit_proposal or a tool aimed at another project", async () => {
    const harness = setup();
    const { project } = harness;
    const other = agentHarness();
    cleanups.push(other.cleanup);
    const model = scriptedModel([
      [
        use("submit_proposal", { proposal: {}, wait: true }, "toolu_submit"),
        use("save_brief", { projectId: other.project.id, brief }, "toolu_other"),
      ],
      say("I can't run generations myself; approve the card when you're ready."),
    ]);
    const turn = await runTurn(harness, "Just run it", model);
    assert.deepEqual(turn.toolResults.map((result) => [result.name, result.ok]), [
      ["submit_proposal", false],
      ["save_brief", false],
    ]);
    assert.match(JSON.stringify(turn.toolResults[0].output), /not available to the assistant/);
    assert.match(JSON.stringify(turn.toolResults[1].output), /belongs to project/);
    assert.equal(harness.store.jobs.listByProject(project.id).length, 0);
  });

  test("stopping mid-reply keeps the partial text and leaves a transcript the next turn can send", async () => {
    const harness = setup();
    const controller = new AbortController();
    const long = say("Here is a long answer that keeps going. ".repeat(10));
    const first = await runTurn(harness, "Tell me everything", scriptedModel([long]), {
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "text") controller.abort();
      },
    });
    assert.equal(first.error, STOPPED_MESSAGE);
    assert.equal(first.done, undefined);
    const saved = conversationsOf(harness.store).listByProject(harness.project.id);
    assert.deepEqual(saved.map((message) => message.role), ["user", "assistant"]);

    const next = scriptedModel([say("Picking up from there.")]);
    await runTurn(harness, "Continue", next);
    assert.deepEqual(next.calls[0].messages.map((message) => message.role), ["user", "assistant", "user"]);
  });

  test("stopping between tool calls cancels the rest and keeps every call paired with a result", async () => {
    const harness = setup();
    const { project } = harness;
    const controller = new AbortController();
    const model = scriptedModel([
      [use("get_project_state", { projectId: project.id }, "toolu_a"), use("save_brief", { projectId: project.id, brief }, "toolu_b")],
    ]);
    const turn = await runTurn(harness, "Go", model, {
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "tool_result") controller.abort();
      },
    });
    assert.equal(turn.error, STOPPED_MESSAGE);
    assert.equal(harness.store.projects.getRequired(project.id).brief, null, "the second call never ran");
    const api = toApiMessages(conversationsOf(harness.store).listByProject(project.id));
    assert.deepEqual(api.map((message) => message.role), ["user", "assistant", "user"]);
    assert.equal(api[2].content.length, 2);
    assert.equal(toolResultFor(api, "toolu_b")?.isError, true);
  });

  test("model failures end the turn with a readable error and keep the user's message", async () => {
    const harness = setup();
    const failing: LlmModel = {
      async *stream() {
        throw Object.assign(new Error("401 invalid x-api-key"), { status: 401 });
      },
    };
    const turn = await runTurn(harness, "Hello", failing);
    assert.equal(turn.error, "The Anthropic key was rejected. Check it in Settings.");
    const next = scriptedModel([say("Hello again.")]);
    await runTurn(harness, "Are you there?", next);
    assert.equal(next.calls[0].messages.length, 1, "consecutive user messages merge into one");
    assert.equal(next.calls[0].messages[0].content.length, 2);
  });

  test("an unknown project, an empty message, or a missing key end with an error and save nothing", async () => {
    const harness = setup();
    const missing = await runTurn({ tools: harness.tools, project: { ...harness.project, id: "00000000-0000-4000-8000-000000000000" } }, "Hi", scriptedModel([]));
    assert.equal(missing.error, "This project could not be found.");
    const empty = await runTurn(harness, "   ", scriptedModel([]));
    assert.equal(empty.error, "Type a message first.");
    assert.equal(conversationsOf(harness.store).countByProject(harness.project.id), 0);

    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const keyless = await runTurn(harness, "Hi", anthropicModel());
      assert.equal(keyless.error, "Add an Anthropic API key in Settings to use the assistant.");
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  test("older turns fall out of the window and the system prompt says so", async () => {
    const harness = setup();
    for (let index = 0; index < 13; index += 1) await runTurn(harness, `message ${index}`, scriptedModel([say(`reply ${index}`)]));
    const model = scriptedModel([say("Still here.")]);
    await runTurn(harness, "latest", model);
    const sent = model.calls[0];
    assert.equal(sent.messages.length, 12 * 2 - 1);
    assert.match(sent.system[1].text, /2 older turn\(s\) are not shown/);
  });
});

describe("Anthropic stream translation", () => {
  test("turns raw stream events into text, finished tool calls, and usage", async () => {
    const raw = [
      { type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 1, cache_creation_input_tokens: 20, cache_read_input_tokens: 5 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Saving " } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "now." } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "save_brief", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"projectId":' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"p"}' } },
      { type: "content_block_stop", index: 1 },
      { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_2", name: "list_assets", input: {} } },
      { type: "content_block_stop", index: 2 },
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 42, input_tokens: null } },
      { type: "message_stop" },
    ] as unknown as RawMessageStreamEvent[];
    async function* source() {
      yield* raw;
    }
    const events: ModelEvent[] = [];
    for await (const event of translateStream(source())) events.push(event);
    assert.deepEqual(events, [
      { type: "text", delta: "Saving " },
      { type: "text", delta: "now." },
      { type: "tool_use", id: "toolu_1", name: "save_brief", input: { projectId: "p" } },
      { type: "tool_use", id: "toolu_2", name: "list_assets", input: {} },
      { type: "stop", stopReason: "tool_use", usage: { inputTokens: 125, outputTokens: 42 } },
    ]);
  });
});
