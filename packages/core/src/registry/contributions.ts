/**
 * What a content plugin contributes on the server, beside its data manifest: domain tools, the
 * schema of its piece body, and the assistant's prompt and step logic for its content type.
 *
 * A plugin package depends on core only, so it never touches the store. Its tools run against a
 * `PluginToolPort` the app implements over the store and the tools layer: read the project and its
 * pieces, save a piece (the body is checked with the plugin's schema and versioned in the document
 * history), and call the roster tools (`propose_candidates`, `get_project_state`, ...) exactly as
 * the assistant would. A spending step therefore returns the same proposal the gate submits.
 * @packageDocumentation
 */
import type { z } from "zod";
import type { Asset } from "../domain/asset";
import type { DocumentAuthor } from "../domain/document";
import type { PieceBody, PluginPiece, PluginPieceInput } from "../domain/piece";
import type { Project } from "../domain/project";

/** The project and tools layer as a plugin tool sees them. Expected failures throw `ServiceError`. */
export interface PluginToolPort {
  /** The owner the request acts for; pieces are created for it. */
  readonly ownerId: string;
  /** Who is calling: the assistant (chat, MCP) or a person in the app. */
  readonly author: DocumentAuthor;
  now(): number;
  newId(): string;
  /** Runs synchronous port work atomically. */
  transaction<T>(work: () => T): T;
  /** A project of this owner; `not_found` otherwise. */
  project(projectId: string): Project;
  /** The project's pieces of one of this plugin's types, newest first. */
  pieces(projectId: string, type: string): PluginPiece[];
  /** A piece of one of this plugin's types; `not_found` otherwise. */
  piece(contentId: string): PluginPiece;
  /** Inserts a new piece; its body is checked and saved as version 1 of its document. */
  createPiece(piece: PluginPieceInput): PluginPiece;
  /** Saves the piece's next revision; a changed body is checked and saved as a new document version. */
  savePiece(next: PluginPiece): PluginPiece;
  asset(assetId: string): Asset | undefined;
  /** Runs a roster tool in the same context and returns its output; a failure throws. */
  callTool<T = unknown>(name: string, input: Record<string, unknown>): Promise<T>;
}

/**
 * A domain tool a plugin adds. Its name starts with the plugin id in snake case (`social_post_`)
 * so it never collides with the core roster; input and output are Zod, like every roster tool.
 */
export interface PluginToolDefinition {
  name: string;
  /** The content type whose projects use it; the assistant is offered it there. */
  contentType: string;
  /** What the tool does, for the tools registry, MCP, and the assistant. */
  description: string;
  input: z.ZodObject;
  output: z.ZodType;
  /** Returns a proposal instead of running anything when it would spend; never submits. */
  run(port: PluginToolPort, input: unknown): Promise<unknown>;
}

/** Types a plugin tool's `run` against its own schemas. */
export function definePluginTool<I extends z.ZodObject, O extends z.ZodType>(definition: {
  name: string;
  contentType: string;
  description: string;
  input: I;
  output: O;
  run: (port: PluginToolPort, input: z.output<I>) => z.input<O> | Promise<z.input<O>>;
}): PluginToolDefinition {
  return { ...definition, run: async (port, input) => definition.run(port, input as z.output<I>) };
}

/** The body schema of a piece type, so the app can check a body it did not write (a restore). */
export interface PieceTypeDefinition {
  /** A content type's `pieceType`, registered by the same plugin. */
  pieceType: string;
  body: z.ZodType<PieceBody>;
}

/** What the assistant's step logic reads: the project, its pieces of this content type, and its Library links. */
export interface AssistantView {
  project: Project;
  pieces: PluginPiece[];
  linked: { kind: "character" | "product" | "set"; id: string; name: string }[];
}

/** The next step and what the assistant should do there, plus lines describing the pieces. */
export interface AssistantStage {
  /** One of the content type's step ids. */
  stepId: string;
  guidance: string;
  /** Lines for the project state block. */
  state: string[];
}

/**
 * The assistant for a content type: its system prompt (stable, so it caches) and a pure function
 * from the project to the next step. A content type without one gets the app's built-in assistant.
 */
export interface ContentAssistantDefinition {
  contentType: string;
  systemPrompt: string;
  stage(view: AssistantView): AssistantStage;
}
