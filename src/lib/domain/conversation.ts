/**
 * Assistant conversations: one ordered list of messages per project. Content is stored as the
 * Anthropic Messages content array (text, tool_use, tool_result), so a stored transcript replays
 * to the model exactly, tool calls and their results included.
 * @packageDocumentation
 */
import { z } from "zod";
import { IdSchema, TimestampSchema } from "@/lib/domain/common";

export const TextBlockSchema = z.object({ type: z.literal("text"), text: z.string().min(1).max(100_000) }).strict();

export const ToolUseBlockSchema = z
  .object({
    type: z.literal("tool_use"),
    id: z.string().min(1).max(200),
    name: z.string().min(1).max(64),
    input: z.unknown(),
  })
  .strict();

export const ToolResultBlockSchema = z
  .object({
    type: z.literal("tool_result"),
    tool_use_id: z.string().min(1).max(200),
    content: z.string().max(100_000),
    is_error: z.boolean().optional(),
  })
  .strict();

export const ContentBlockSchema = z.discriminatedUnion("type", [TextBlockSchema, ToolUseBlockSchema, ToolResultBlockSchema]);
export type ContentBlock = z.infer<typeof ContentBlockSchema>;
export type ToolUseBlock = z.infer<typeof ToolUseBlockSchema>;
export type ToolResultBlock = z.infer<typeof ToolResultBlockSchema>;

export const MessageRoleSchema = z.enum(["user", "assistant"]);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

export const ConversationMessageSchema = z
  .object({
    id: IdSchema,
    projectId: IdSchema,
    role: MessageRoleSchema,
    content: z.array(ContentBlockSchema).min(1).max(64),
    createdAt: TimestampSchema,
  })
  .strict()
  .refine(
    (message) =>
      message.content.every((block) =>
        block.type === "tool_use" ? message.role === "assistant" : block.type === "tool_result" ? message.role === "user" : true,
      ),
    "Tool calls belong to assistant messages and tool results to user messages.",
  );
export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;

/** The `messages` entry shape of the Anthropic Messages API, as plain data. */
export interface ApiMessage {
  role: MessageRole;
  content: ContentBlock[];
}

/** A turn starts at a user message the person typed (it has text), not at a tool-result message. */
export function startsTurn(message: Pick<ConversationMessage, "role" | "content">): boolean {
  return message.role === "user" && message.content.some((block) => block.type === "text");
}

/**
 * The last `maxTurns` turns of a transcript. Cutting only at turn starts keeps every tool_use with
 * its tool_result. `omittedTurns` counts the turns left out, for the state summary to mention.
 */
export function windowMessages<T extends Pick<ConversationMessage, "role" | "content">>(
  messages: readonly T[],
  maxTurns: number,
): { messages: T[]; omittedTurns: number } {
  const starts = messages.flatMap((message, index) => (startsTurn(message) ? [index] : []));
  if (starts.length <= maxTurns) return { messages: messages.slice(starts[0] ?? messages.length), omittedTurns: 0 };
  const from = starts[starts.length - maxTurns];
  return { messages: messages.slice(from), omittedTurns: starts.length - maxTurns };
}

/**
 * Converts stored messages to the API's `messages` array: drops leading assistant messages,
 * merges consecutive messages from the same role (tool results stay ahead of the text that follows
 * them), and drops tool calls that never got a result, so an interrupted turn cannot break the next.
 */
export function toApiMessages(messages: readonly Pick<ConversationMessage, "role" | "content">[]): ApiMessage[] {
  const answered = new Set(
    messages.flatMap((message) => message.content.flatMap((block) => (block.type === "tool_result" ? [block.tool_use_id] : []))),
  );
  const result: ApiMessage[] = [];
  for (const message of messages) {
    const content = message.content.filter((block) => block.type !== "tool_use" || answered.has(block.id));
    if (content.length === 0) continue;
    if (result.length === 0 && message.role !== "user") continue;
    const last = result.at(-1);
    if (last && last.role === message.role) last.content = [...last.content, ...content];
    else result.push({ role: message.role, content: [...content] });
  }
  const used = new Set(result.flatMap((message) => message.content.flatMap((block) => (block.type === "tool_use" ? [block.id] : []))));
  return result
    .map((message) => ({
      ...message,
      content: message.content.filter((block) => block.type !== "tool_result" || used.has(block.tool_use_id)),
    }))
    .filter((message) => message.content.length > 0);
}
