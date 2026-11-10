/**
 * Saving plugin content pieces: every body is checked with the schema its plugin registered for the
 * piece type, and every saved body is a version in the document history (kind `piece`), so the
 * artifact panel's history and restore work for a plugin's piece body exactly as for a brief.
 * @packageDocumentation
 */
import { z } from "zod";
import { fail } from "@creator-lab/core/domain/failure";
import { type PieceBody, type PluginPiece, type PluginPieceInput, PluginPieceSchema } from "@creator-lab/core/domain/piece";
import type { PluginRegistry } from "@creator-lab/core/registry";
import { serverPlugins } from "@/plugins/server";
import { recordDocument } from "@/server/tools/documents";
import type { ToolContext } from "@/server/tools/registry";

/** Checks a piece body with its plugin's schema; an unknown piece type or a bad body is refused. */
export function checkPieceBody(type: string, body: unknown, registry: Pick<PluginRegistry, "pieceType"> = serverPlugins): PieceBody {
  const definition = registry.pieceType(type) ?? fail("invalid", `No installed plugin keeps ${type} content pieces.`);
  const parsed = definition.body.safeParse(body);
  if (!parsed.success) fail("invalid", z.prettifyError(parsed.error));
  return parsed.data;
}

/** Inserts a new piece and records its body as version 1. */
export function insertPiece(context: ToolContext, input: PluginPieceInput): PluginPiece {
  return context.store.transaction(() => {
    const piece = PluginPieceSchema.parse(input);
    const created = context.store.pieces.create({ ...piece, body: checkPieceBody(piece.type, piece.body) });
    recordDocument(context, "piece", created.id, created.body);
    return created;
  });
}

/** Saves a piece's next revision; a changed body is checked and recorded as a new version. */
export function savePiece(context: ToolContext, next: PluginPiece, restoredFrom: number | null = null): PluginPiece {
  return context.store.transaction(() => {
    const saved = context.store.pieces.update({ ...next, body: checkPieceBody(next.type, next.body) });
    recordDocument(context, "piece", saved.id, saved.body, restoredFrom);
    return saved;
  });
}
