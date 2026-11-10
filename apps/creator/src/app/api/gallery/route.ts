/**
 * The gallery: every example in `examples/` with its status (drafts are "not yet generated"), and
 * any example folder that failed its schema check.
 * @packageDocumentation
 */
import { exampleStatusLabel } from "@creator-lab/core/domain/gallery";
import { assertLocalRequest } from "@/server/http";
import { loadGallery } from "@/server/gallery";
import { route } from "@/app/api/_lib/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return route(async () => {
    assertLocalRequest(request);
    const { examples, problems } = await loadGallery();
    return Response.json({ examples: examples.map((example) => ({ ...example, statusLabel: exampleStatusLabel(example) })), problems });
  });
}
