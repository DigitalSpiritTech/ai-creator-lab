/**
 * Owner context (F8): every record that matters says who owns it, and every server request carries
 * the owner it acts for. The core has one default owner, `local` (this install's single user); no
 * check uses it yet. Teams (later) resolve the owner from the session and enforce it, so records
 * written today already carry the field they will filter on.
 *
 * Records with their own owner: projects, Library items, assets, jobs, document versions, and
 * plugin content pieces. Records inside a project (scripts, Ad content pieces, exports, links,
 * conversations, preferences) are owned through their project and carry no copy that could drift.
 * @packageDocumentation
 */
import { z } from "zod";
import { fail } from "./failure";

/** The single owner of a local install. */
export const DEFAULT_OWNER_ID = "local";

/** An owner id: lowercase letters, digits, hyphens, and underscores, starting with a letter or digit. */
export const OwnerIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "Use a valid owner id.");
export type OwnerId = z.infer<typeof OwnerIdSchema>;

/** The `ownerId` field for record schemas; rows saved before owners existed read as the default owner. */
export const ownerField = { ownerId: OwnerIdSchema.default(DEFAULT_OWNER_ID) };

/** Refuses a record that belongs to another owner, in words that do not reveal it exists. */
export function assertSameOwner(record: { ownerId: string }, ownerId: string, what: string): void {
  if (record.ownerId !== ownerId) fail("not_found", `This ${what} could not be found.`);
}
