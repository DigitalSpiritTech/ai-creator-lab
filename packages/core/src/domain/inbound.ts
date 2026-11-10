/**
 * Inbound context (F8): what something outside a project hands in to start one. The gallery's
 * "start from example" (item 10) sends a brief and the Library items the example uses; an import or
 * an API caller can send the same. The app creates the project, saves the brief as its first
 * document version, and links the Library items, all in one transaction.
 * @packageDocumentation
 */
import { z } from "zod";
import { IdSchema } from "./common";
import { fail } from "./failure";
import type { LibraryItem, LibraryKind } from "./library";
import { BriefSchema, CreateProjectSchema, ProjectOriginSchema } from "./project";

/** A Library item named by kind and id, so a wrong kind is caught before anything is linked. */
export const LibraryRefSchema = z
  .object({
    kind: z.enum(["character", "product", "set"]),
    id: IdSchema,
  })
  .strict();
export type LibraryRef = z.infer<typeof LibraryRefSchema>;

export const InboundContextSchema = z
  .object({
    brief: BriefSchema.optional(),
    libraryRefs: z.array(LibraryRefSchema).max(12).default([]),
    source: ProjectOriginSchema,
  })
  .strict()
  .refine((inbound) => new Set(inbound.libraryRefs.map((ref) => ref.id)).size === inbound.libraryRefs.length, "Name each Library item once.");
export type InboundContext = z.infer<typeof InboundContextSchema>;
export type InboundContextInput = z.input<typeof InboundContextSchema>;

/** A project to create, seeded from an inbound context. */
export const SeedProjectSchema = CreateProjectSchema.extend({ inbound: InboundContextSchema }).strict();
export type SeedProject = z.input<typeof SeedProjectSchema>;

/**
 * The Library items an inbound context names, in order: each must exist, be of the kind named,
 * belong to `ownerId`, and not be archived. `lookup` reads a Library item by id.
 */
export function resolveLibraryRefs(
  refs: readonly LibraryRef[],
  ownerId: string,
  lookup: (id: string) => LibraryItem | undefined,
): LibraryItem[] {
  return refs.map((ref) => {
    const item = lookup(ref.id);
    if (!item || item.ownerId !== ownerId) fail("not_found", `The Library ${ref.kind} ${ref.id} could not be found.`);
    if (item.kind !== ref.kind) fail("invalid", `Library item ${ref.id} is a ${item.kind}, not a ${ref.kind satisfies LibraryKind}.`);
    if (item.archived) fail("invalid", `Library ${ref.kind} ${ref.id} is archived. Restore it before starting a project from it.`);
    return item;
  });
}
