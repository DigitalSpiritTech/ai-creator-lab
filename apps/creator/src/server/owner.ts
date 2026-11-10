/**
 * The owner a request acts for (F8 owner context). A local install has one owner, the core default
 * (`local`), and the app password (when set) only decides whether a request gets in at all. Teams
 * will resolve the owner from the signed-in session here; everything below already receives it
 * through the tool context and stamps it on the records it creates.
 * @packageDocumentation
 */
import { DEFAULT_OWNER_ID } from "@creator-lab/core/domain/owner";

/** The owner for this request: always the default owner until workspaces have more than one. */
export function requestOwner(request?: Request): string {
  void request;
  return DEFAULT_OWNER_ID;
}
