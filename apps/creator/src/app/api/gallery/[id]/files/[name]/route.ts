/**
 * One output file of a gallery example (an image or the exported MP4), with byte ranges. Only files
 * the example's `outputs` list are served.
 * @packageDocumentation
 */
import { ExampleFileSchema, ExampleIdSchema } from "@creator-lab/core/domain/gallery";
import { exampleFileResponse, loadExample } from "@/server/gallery";
import { route } from "@/app/api/_lib/server";

export const dynamic = "force-dynamic";

async function serve(request: Request, params: Promise<{ id: string; name: string }>): Promise<Response> {
  return route(async () => {
    const { id, name } = await params;
    const exampleId = ExampleIdSchema.safeParse(id);
    const file = ExampleFileSchema.safeParse(name);
    if (!exampleId.success || !file.success) return Response.json({ error: "This example has no such file." }, { status: 404 });
    return exampleFileResponse(request, await loadExample(exampleId.data), file.data);
  });
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string; name: string }> }): Promise<Response> {
  return serve(request, params);
}

export async function HEAD(request: Request, { params }: { params: Promise<{ id: string; name: string }> }): Promise<Response> {
  return serve(request, params);
}
