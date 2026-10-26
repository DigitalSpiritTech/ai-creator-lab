/**
 * Assistant conversation messages, one ordered transcript per project.
 * @packageDocumentation
 */
import type { DatabaseSync } from "node:sqlite";
import { type ConversationMessage, ConversationMessageSchema } from "@/lib/domain/conversation";
import type { Store } from "@/server/store";
import { decode, decodeAll, encode, transaction } from "@/server/store/connection";

/** Upper bound on how many messages one read returns. */
export const MAX_MESSAGES_READ = 500;

export function conversationRepository(database: DatabaseSync) {
  function get(id: string): ConversationMessage | undefined {
    const row = database.prepare("SELECT data FROM conversation_messages WHERE id = ?").get(id);
    return row ? decode(row, ConversationMessageSchema) : undefined;
  }

  /** Messages in the order they were appended; with `limit`, only the newest ones (still oldest first). */
  function listByProject(projectId: string, options: { limit?: number } = {}): ConversationMessage[] {
    const limit = Math.min(Math.max(1, options.limit ?? MAX_MESSAGES_READ), MAX_MESSAGES_READ);
    const rows = database
      .prepare(
        "SELECT data FROM (SELECT seq, data FROM conversation_messages WHERE project_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC",
      )
      .all(projectId, limit);
    return decodeAll(rows, ConversationMessageSchema);
  }

  function countByProject(projectId: string): number {
    const row = database.prepare("SELECT COUNT(*) AS count FROM conversation_messages WHERE project_id = ?").get(projectId);
    return Number(row?.count ?? 0);
  }

  /** Appends messages atomically, in order. */
  function append(...messages: ConversationMessage[]): ConversationMessage[] {
    return transaction(database, () =>
      messages.map((message) => {
        const { record, json } = encode(ConversationMessageSchema, message);
        database.prepare("INSERT INTO conversation_messages(id, project_id, data) VALUES (?, ?, ?)").run(record.id, record.projectId, json);
        return record;
      }),
    );
  }

  return { get, listByProject, countByProject, append };
}
export type ConversationRepository = ReturnType<typeof conversationRepository>;

/** The conversation repository over an open store's database. */
export function conversationsOf(store: Pick<Store, "database">): ConversationRepository {
  return conversationRepository(store.database);
}
