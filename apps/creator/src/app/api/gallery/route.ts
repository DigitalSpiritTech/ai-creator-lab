/**
 * The gallery: every example in `examples/` with its status (drafts are "not yet generated"), and
 * any example folder that failed its schema check.
 * @packageDocumentation
 */
import { exampleStatusLabel } from "@creator-lab/core/domain/gallery";
import { loadGallery } from "@/server/gallery";
import { route } from "@/app/api/_lib/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return route(async () => {
    const { examples, problems } = await loadGallery();
    return Response.json({ examples: examples.map((example) => ({ ...example, statusLabel: exampleStatusLabel(example) })), problems });
  });
}
