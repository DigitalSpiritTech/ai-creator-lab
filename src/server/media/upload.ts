/**
 * Reads a bounded multipart image upload before parsing it.
 * @packageDocumentation
 */
import { IdSchema } from "@/lib/domain/common";
import { MAX_IMAGE_BYTES } from "@/server/media/images";

/**
 * Reads a capped request body, including uploads without Content-Length.
 * @returns The optional project id (absent for Library uploads), a safe file name, and the bytes.
 * @throws A 400, 413, or 415 Response for malformed or oversized uploads.
 */
export async function readImageUpload(
  request: Request,
): Promise<{ projectId: string | null; name: string; bytes: Uint8Array }> {
  const contentType = request.headers.get("content-type");
  if (!contentType?.startsWith("multipart/form-data;")) {
    throw Response.json({ error: "Upload an image with multipart form data." }, { status: 415 });
  }
  const limit = MAX_IMAGE_BYTES + 64 * 1024;
  if (Number(request.headers.get("content-length")) > limit) {
    throw Response.json({ error: "Choose an image up to 12 MB." }, { status: 413 });
  }
  if (!request.body) throw Response.json({ error: "Choose an image to upload." }, { status: 400 });
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw Response.json({ error: "Choose an image up to 12 MB." }, { status: 413 });
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  let form: FormData;
  try {
    form = await new Response(Buffer.concat(chunks), { headers: { "Content-Type": contentType } }).formData();
  } catch {
    throw Response.json({ error: "The image upload could not be read." }, { status: 400 });
  }
  const file = form.get("image");
  if (!(file instanceof File) || form.getAll("image").length !== 1 || file.size === 0 || file.size > MAX_IMAGE_BYTES) {
    throw Response.json({ error: "Choose one image up to 12 MB." }, { status: 400 });
  }
  const rawProject = form.get("projectId");
  const project = rawProject === null || rawProject === "" ? null : IdSchema.safeParse(rawProject);
  if (project !== null && !project.success) throw Response.json({ error: "Choose a valid project." }, { status: 400 });
  const name =
    file.name
      .split(/[/\\]/)
      .at(-1)
      ?.replace(/[\x00-\x1f]/g, "")
      .slice(0, 255) || "Uploaded image";
  return { projectId: project?.data ?? null, name, bytes: new Uint8Array(await file.arrayBuffer()) };
}
