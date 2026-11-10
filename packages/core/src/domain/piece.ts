/**
 * Plugin content pieces: the content piece of a content type a plugin registers (anything other
 * than the Ad, whose shots and cut live in `content.ts`). Core owns the envelope (project, owner,
 * type, title, revision) and the piece's named slots, each the same candidate and approval state a
 * shot's still has; the plugin owns `body` and checks it with the schema it registers for its piece
 * type, so core never learns what a Social Post is.
 *
 * Slots are where generations land: a job aimed at `{ kind: "piece", contentId, slot }` adds its
 * outputs to that slot's candidates, `approve` (kind `slot`) approves one and archives the rest,
 * and the asset graph treats an approved slot like an approved shot.
 * @packageDocumentation
 */
import { z } from "zod";
import { IdSchema, RevisionSchema, TimestampSchema, nextRevision, text } from "./common";
import { type Slot, SlotSchema } from "./content";
import { fail } from "./failure";
import { ownerField } from "./owner";

/** A slot key: `4:5`, `cover`, `square_1`. Lowercase, digits, and `:`, `_`, `-`. */
export const SlotKeySchema = z.string().regex(/^[a-z0-9][a-z0-9:_-]{0,39}$/, "Use a slot key such as 4:5 or cover.");

/** A piece type as the registry knows it (a content type's `pieceType`). */
export const PieceTypeSchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);

/** The plugin-owned part of a piece: a JSON object its plugin validates. */
export const PieceBodySchema = z.record(z.string(), z.unknown());
export type PieceBody = z.infer<typeof PieceBodySchema>;

export const MAX_PIECE_SLOTS = 16;

export const PluginPieceSchema = z
  .object({
    id: IdSchema,
    projectId: IdSchema,
    ...ownerField,
    type: PieceTypeSchema,
    title: text(120),
    slots: z
      .record(SlotKeySchema, SlotSchema)
      .refine((slots) => Object.keys(slots).length <= MAX_PIECE_SLOTS, `A piece has at most ${MAX_PIECE_SLOTS} slots.`),
    body: PieceBodySchema,
    brokenAssetIds: z.array(IdSchema).default([]),
    revision: RevisionSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type PluginPiece = z.infer<typeof PluginPieceSchema>;
export type PluginPieceInput = z.input<typeof PluginPieceSchema>;

export interface NewPiece {
  id: string;
  projectId: string;
  ownerId?: string;
  type: string;
  title: string;
  /** The slot keys, in display order; every slot starts empty. */
  slots: readonly string[];
  body: PieceBody;
}

/** A new piece with every slot empty. */
export function createPiece(input: NewPiece, now: number): PluginPiece {
  if (new Set(input.slots).size !== input.slots.length) fail("invalid", "Name each slot once.");
  return PluginPieceSchema.parse({
    id: input.id,
    projectId: input.projectId,
    ownerId: input.ownerId,
    type: input.type,
    title: input.title,
    slots: Object.fromEntries(input.slots.map((key) => [key, { state: "empty" }])),
    body: input.body,
    brokenAssetIds: [],
    revision: 0,
    createdAt: now,
    updatedAt: now,
  });
}

/** Replaces the title or body. Writing what is already there returns the piece unchanged. */
export function revisePiece(piece: PluginPiece, patch: { title?: string; body?: PieceBody }, now: number): PluginPiece {
  const title = patch.title ?? piece.title;
  const body = patch.body ?? piece.body;
  if (title === piece.title && JSON.stringify(body) === JSON.stringify(piece.body)) return piece;
  return PluginPieceSchema.parse({ ...nextRevision(piece, now), title, body });
}

function slotOf(piece: PluginPiece, key: string): Slot {
  return piece.slots[key] ?? fail("not_found", `This ${piece.type} has no ${key} slot.`);
}

function withSlot(piece: PluginPiece, key: string, slot: Slot, now: number): PluginPiece {
  return PluginPieceSchema.parse({ ...nextRevision(piece, now), slots: { ...piece.slots, [key]: slot } });
}

/** Adds generated candidates to a slot. An existing approval stays. */
export function addPieceCandidates(piece: PluginPiece, key: string, assetIds: readonly string[], now: number): PluginPiece {
  const current = slotOf(piece, key);
  const before = current.state === "empty" ? [] : current.candidateIds;
  const added = assetIds.filter((id) => !before.includes(id));
  if (added.length === 0) return piece;
  const candidateIds = [...before, ...added];
  const next: Slot =
    current.state === "approved"
      ? { ...current, candidateIds }
      : { state: "open", candidateIds, selectedId: current.state === "open" ? current.selectedId : null };
  return withSlot(piece, key, next, now);
}

/** Marks one candidate as the current pick without approving it. */
export function selectPieceCandidate(piece: PluginPiece, key: string, assetId: string, now: number): PluginPiece {
  const current = slotOf(piece, key);
  if (current.state === "empty" || !current.candidateIds.includes(assetId)) fail("invalid", `Choose one of the ${key} candidates.`);
  if (current.state === "approved") fail("conflict", `The ${key} slot already has an approved choice. Approve a different candidate to replace it.`);
  if (current.selectedId === assetId) return piece;
  return withSlot(piece, key, { ...current, selectedId: assetId }, now);
}

/**
 * Approves one candidate for a slot and returns the other candidates so the caller can archive
 * them. Approving the candidate already approved changes nothing.
 */
export function approvePieceCandidate(
  piece: PluginPiece,
  key: string,
  assetId: string,
  now: number,
): { piece: PluginPiece; siblingIds: string[] } {
  const current = slotOf(piece, key);
  if (current.state === "empty" || !current.candidateIds.includes(assetId)) fail("invalid", `Choose one of the ${key} candidates.`);
  const siblingIds = current.candidateIds.filter((id) => id !== assetId);
  if (current.state === "approved" && current.assetId === assetId) return { piece, siblingIds };
  const approved: Slot = { state: "approved", candidateIds: current.candidateIds, assetId, approvedAt: now };
  return {
    piece: PluginPieceSchema.parse({
      ...nextRevision(piece, now),
      slots: { ...piece.slots, [key]: approved },
      brokenAssetIds: piece.brokenAssetIds.filter((id) => id !== assetId),
    }),
    siblingIds,
  };
}

/** Withdraws a slot's approval; its candidates stay so one can be approved again. */
export function withdrawPieceApproval(piece: PluginPiece, key: string, now: number): PluginPiece {
  const current = slotOf(piece, key);
  if (current.state !== "approved") return piece;
  return withSlot(piece, key, { state: "open", candidateIds: current.candidateIds, selectedId: null }, now);
}

/** The approved asset per slot, in slot order; slots without an approval are left out. */
export function approvedSlots(piece: PluginPiece): { slot: string; assetId: string }[] {
  return Object.entries(piece.slots).flatMap(([slot, state]) => (state.state === "approved" ? [{ slot, assetId: state.assetId }] : []));
}
