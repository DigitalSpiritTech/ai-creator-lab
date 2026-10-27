import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { afterEach, describe, test } from "node:test";
import { type ModelEvent, type RouterMessagesPort, anthropicModel, assistantModel, buildRequest, messageEvents, routerModel, scriptedModel } from "@/server/agent";
import { readSecrets, secretsStatus, writeSecrets } from "@/server/secrets";
import { conversationsOf } from "@/server/store/conversations";
import { type Harness, agentHarness, runTurn } from "./support/agent-harness";
import { tempDir } from "./support/domain-fixtures";

const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/router/anthropic-messages.json", import.meta.url), "utf8")) as Record<string, Record<string, unknown>>;

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function setup(): Harness {
  const harness = agentHarness();
  cleanups.push(harness.cleanup);
  return harness;
}

interface Call {
  model: string;
  body: Record<string, unknown>;
  options?: { idempotencyKey?: string; signal?: AbortSignal };
}

/** A fake `comfy.models.run` that answers with the given documents in order and records each call. */
function fakeRouter(replies: unknown[]): RouterMessagesPort & { calls: Call[] } {
  const queue = [...replies];
  const calls: Call[] = [];
  return {
    calls,
    async run(model, body, options) {
      calls.push({ model, body, options });
      const next = queue.shift();
      if (next instanceof Error) throw next;
      if (next === "binary") return { kind: "binary" };
      return { kind: "json", data: next };
    },
  };
}

function withProject(reply: Record<string, unknown>, projectId: string): Record<string, unknown> {
  return JSON.parse(JSON.stringify(reply).replaceAll("00000000-0000-4000-8000-000000000000", projectId));
}

/** Runs `work` with the given environment variables set (undefined removes one), then restores them. */
async function withEnv(values: Record<string, string | undefined>, work: () => Promise<void> | void) {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await work();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("assistant through Comfy Router", () => {
  test("a complete reply becomes the same events the streaming adapter emits", () => {
    assert.deepEqual(messageEvents(FIXTURE.tool_use), [
      { type: "text", delta: "Saving your brief now." },
      {
        type: "tool_use",
        id: "toolu_router_fixture_1",
        name: "save_brief",
        input: (FIXTURE.tool_use.content as { input?: unknown }[])[2].input,
      },
      { type: "stop", stopReason: "tool_use", usage: { inputTokens: 16_960, outputTokens: 188, cacheReadInputTokens: 0, cacheCreationInputTokens: 16_548 } },
    ] satisfies ModelEvent[]);
    assert.throws(() => messageEvents({ nope: true }), /could not read/);
  });

  test("posts the identical Messages body, cache breakpoints included, without streaming", async () => {
    const harness = setup();
    const router = fakeRouter([FIXTURE.end_turn]);
    const model = routerModel({ models: router, model: "claude-opus-5-5" });
    const recorder = scriptedModel([[]]);
    await runTurn(harness, "Hello", {
      async *stream(params) {
        for await (const event of recorder.stream(params)) void event;
        yield* model.stream(params);
      },
    });
    assert.equal(router.calls.length, 1);
    const [call] = router.calls;
    assert.equal(call.model, "anthropic/claude-opus-5-5");
    assert.match(call.options!.idempotencyKey!, /^[0-9a-f-]{36}$/);
    const { stream, ...expected } = buildRequest(recorder.calls[0], "claude-opus-5-5");
    assert.equal(stream, true);
    assert.deepEqual(call.body, expected, "the body is the Anthropic request minus streaming");
    assert.equal("stream" in call.body, false);
    const body = JSON.stringify(call.body);
    assert.equal(body.match(/"cache_control":\{"type":"ephemeral"\}/g)?.length, 3);
  });

  test("runs a whole tool-using turn on the Comfy key and reports cache usage", async () => {
    const harness = setup();
    const { project, store } = harness;
    const router = fakeRouter([withProject(FIXTURE.tool_use, project.id), FIXTURE.end_turn]);
    const turn = await runTurn(harness, "Ridgeline bottle, commuters, TikTok and Reels, warm and direct", routerModel({ models: router, model: "anthropic/claude-opus-5-5" }));
    assert.equal(turn.error, undefined);
    assert.equal(router.calls.length, 2);
    assert.ok(router.calls.every((call) => call.model === "anthropic/claude-opus-5-5"));
    assert.notEqual(router.calls[0].options!.idempotencyKey, router.calls[1].options!.idempotencyKey);
    assert.deepEqual(turn.toolResults.map((result) => [result.name, result.ok]), [["save_brief", true]]);
    assert.equal(store.projects.getRequired(project.id).brief?.audience, "commuters");
    assert.match(turn.text, /Saving your brief now\.Brief saved\./);
    assert.deepEqual(turn.done!.usage, { inputTokens: 16_960 + 17_453, outputTokens: 229, cacheReadInputTokens: 16_548, cacheCreationInputTokens: 16_548 });
    const assistants = conversationsOf(store).listByProject(project.id).filter((message) => message.role === "assistant");
    assert.equal(assistants[1].usage?.cacheReadInputTokens, 16_548);
    assert.equal(JSON.stringify(assistants).includes("thinking"), false, "thinking blocks are not stored");
  });

  test("Router failures, files, and a missing Comfy key end the turn with a readable error", async () => {
    const harness = setup();
    const failing = await runTurn(harness, "Hi", routerModel({ models: fakeRouter([new Error("402 insufficient credits")]), model: "claude-opus-5-5" }));
    assert.equal(failing.error, "Comfy Router could not run the assistant. 402 insufficient credits");
    const binary = await runTurn(harness, "Hi", routerModel({ models: fakeRouter(["binary"]), model: "claude-opus-5-5" }));
    assert.equal(binary.error, "Comfy Router returned a file instead of a message.");
    await withEnv({ COMFY_API_KEY: undefined }, async () => {
      const keyless = await runTurn(harness, "Hi", routerModel({ model: "claude-opus-5-5" }));
      assert.equal(keyless.error, "Add a Comfy API key in Settings to use the assistant through Comfy Router.");
    });
  });
});

describe("assistant provider setting", () => {
  test("LLM_PROVIDER or Settings choose the provider; Anthropic is the default and unknown values are ignored", async () => {
    const dir = tempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const env = (provider?: string) => ({ ...(provider ? { LLM_PROVIDER: provider } : {}) });
    assert.deepEqual(secretsStatus(dir, env()).llmProvider, { value: "anthropic", source: null });
    assert.deepEqual(secretsStatus(dir, env("Router")).llmProvider, { value: "router", source: "environment" });
    assert.deepEqual(secretsStatus(dir, env("openai")).llmProvider, { value: "anthropic", source: null });
    writeSecrets(dir, { llmProvider: "router" });
    assert.deepEqual(secretsStatus(dir, env()).llmProvider, { value: "router", source: "settings" });
    assert.equal(readSecrets(dir, env("anthropic")).llmProvider, "anthropic", "the environment wins over Settings");
    writeSecrets(dir, { llmProvider: null });
    assert.equal(readSecrets(dir, env()).llmProvider, undefined);
    assert.equal(JSON.stringify(secretsStatus(dir, env())).includes("sk-"), false);
  });

  test("the chat picks Router or Anthropic from the setting", async () => {
    const harness = setup();
    await withEnv({ COMFY_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }, async () => {
      const router = await runTurn(harness, "Hi", assistantModel({ llmProvider: "router", anthropicApiKey: "present-but-unused" }));
      assert.match(router.error!, /Comfy API key/);
      const anthropic = await runTurn(harness, "Hi", assistantModel({ comfyApiKey: "present-but-unused" }));
      assert.match(anthropic.error!, /Anthropic API key/);
      const explicit = await runTurn(harness, "Hi", anthropicModel());
      assert.equal(explicit.error, anthropic.error);
    });
  });
});
