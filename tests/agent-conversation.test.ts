import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, test } from "node:test";
import {
  type ContentBlock,
  type ConversationMessage,
  ConversationMessageSchema,
  toApiMessages,
  windowMessages,
} from "@/lib/domain/conversation";
import { createProject } from "@/lib/domain/project";
import { DATABASE_FILE, SCHEMA_VERSION, openStore } from "@/server/store";
import { MIGRATIONS } from "@/server/store/migrations";
import { conversationsOf } from "@/server/store/conversations";
import { clock, seedProject, tempDir, tempStore } from "./support/domain-fixtures";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function message(projectId: string, role: "user" | "assistant", content: ContentBlock[], createdAt = 1): ConversationMessage {
  return { id: randomUUID(), projectId, role, content, createdAt };
}

const text = (value: string): ContentBlock => ({ type: "text", text: value });
const toolUse = (id: string): ContentBlock => ({ type: "tool_use", id, name: "get_project_state", input: { projectId: "p" } });
const toolResult = (id: string): ContentBlock => ({ type: "tool_result", tool_use_id: id, content: "{}" });

/** A user turn with one tool round trip: user text, assistant tool call, tool result, assistant text. */
function turn(projectId: string, label: string): ConversationMessage[] {
  const id = `toolu_${label}`;
  return [
    message(projectId, "user", [text(`question ${label}`)]),
    message(projectId, "assistant", [text("Checking."), toolUse(id)]),
    message(projectId, "user", [toolResult(id)]),
    message(projectId, "assistant", [text(`answer ${label}`)]),
  ];
}

describe("conversation contract", () => {
  test("tool calls belong to assistant messages and tool results to user messages", () => {
    const projectId = randomUUID();
    assert.ok(ConversationMessageSchema.safeParse(message(projectId, "assistant", [toolUse("a")])).success);
    assert.ok(ConversationMessageSchema.safeParse(message(projectId, "user", [toolResult("a")])).success);
    assert.equal(ConversationMessageSchema.safeParse(message(projectId, "user", [toolUse("a")])).success, false);
    assert.equal(ConversationMessageSchema.safeParse(message(projectId, "assistant", [toolResult("a")])).success, false);
    assert.equal(ConversationMessageSchema.safeParse(message(projectId, "user", [])).success, false);
  });

  test("the window keeps whole turns, so every tool call keeps its result", () => {
    const projectId = randomUUID();
    const history = [...turn(projectId, "1"), ...turn(projectId, "2"), ...turn(projectId, "3")];
    const all = windowMessages(history, 5);
    assert.equal(all.omittedTurns, 0);
    assert.equal(all.messages.length, 12);
    const last = windowMessages(history, 2);
    assert.equal(last.omittedTurns, 1);
    assert.equal(last.messages.length, 8);
    assert.deepEqual(last.messages[0].content, [text("question 2")]);
    assert.equal(windowMessages([], 3).messages.length, 0);
  });

  test("API messages merge same-role neighbours and drop leading assistants and unanswered tool calls", () => {
    const projectId = randomUUID();
    const api = toApiMessages([
      message(projectId, "assistant", [text("orphan greeting")]),
      message(projectId, "user", [text("hi")]),
      message(projectId, "assistant", [text("Let me look."), toolUse("answered")]),
      message(projectId, "user", [toolResult("answered")]),
      message(projectId, "user", [text("and also")]),
      message(projectId, "assistant", [text("Saving."), toolUse("dangling")]),
      message(projectId, "user", [text("hello again")]),
    ]);
    assert.deepEqual(
      api.map((entry) => entry.role),
      ["user", "assistant", "user", "assistant", "user"],
    );
    assert.deepEqual(api[2].content, [toolResult("answered"), text("and also")]);
    assert.deepEqual(api[3].content, [text("Saving.")]);
  });
});

describe("conversation store", () => {
  test("appends atomically, lists in order, and limits to the newest messages", () => {
    const { store, cleanup } = tempStore();
    cleanups.push(cleanup);
    const now = clock();
    const project = seedProject(store, now);
    const other = seedProject(store, now, "Second project");
    const conversations = conversationsOf(store);
    const messages = turn(project.id, "1").map((entry) => ({ ...entry, createdAt: now() }));
    conversations.append(...messages);
    conversations.append(message(other.id, "user", [text("elsewhere")]));
    assert.deepEqual(conversations.listByProject(project.id), messages);
    assert.deepEqual(conversations.listByProject(project.id, { limit: 2 }), messages.slice(2));
    assert.equal(conversations.countByProject(project.id), 4);
    assert.deepEqual(conversations.get(messages[1].id), messages[1]);
    assert.equal(conversations.get(randomUUID()), undefined);

    const duplicate = message(project.id, "user", [text("again")]);
    assert.throws(() => conversations.append(duplicate, { ...duplicate }));
    assert.equal(conversations.countByProject(project.id), 4, "a failed append writes nothing");
    assert.throws(() => conversations.append(message(randomUUID(), "user", [text("no project")])));
  });

  test("migration 2 upgrades a version 1 database and keeps its data", () => {
    const dir = tempDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const raw = new DatabaseSync(join(dir, DATABASE_FILE));
    raw.exec(MIGRATIONS[0]);
    raw.exec("PRAGMA user_version = 1");
    const project = createProject({ name: "Bottle launch, October" }, randomUUID(), 1_760_000_000_000);
    raw.prepare("INSERT INTO projects(id, data) VALUES (?, ?)").run(project.id, JSON.stringify(project));
    raw.close();

    const store = openStore(dir);
    try {
      assert.equal(SCHEMA_VERSION, 2);
      assert.equal(Object.values(store.database.prepare("PRAGMA user_version").get()!)[0], 2);
      assert.equal(store.projects.getRequired(project.id).name, project.name);
      const saved = conversationsOf(store).append(message(project.id, "user", [text("hello")]));
      assert.equal(conversationsOf(store).listByProject(project.id)[0].id, saved[0].id);
    } finally {
      store.close();
    }
  });
});
