/**
 * Multipart upload parsing for images (field `image`, 12 MB) and voice recordings (field `audio`,
 * 25 MB). The body is read with a hard size limit before the form is parsed.
 * @packageDocumentation
 */
import { IdSchema } from "@/lib/domain/common";
import { MAX_AUDIO_BYTES } from "@/server/media/audio";
import { MAX_IMAGE_BYTES } from "@/server/media/images";

export interface Upload {
  projectId: string | null;
  name: string;
  bytes: Uint8Array;
}

interface UploadSpec {
  field: "image" | "audio";
  maxBytes: number;
  what: string;
  limitLabel: string;
}

const IMAGE: UploadSpec = { field: "image", maxBytes: MAX_IMAGE_BYTES, what: "an image", limitLabel: "12 MB" };
const AUDIO: UploadSpec = { field: "audio", maxBytes: MAX_AUDIO_BYTES, what: "a recording", limitLabel: "25 MB" };

async function readUpload(request: Request, spec: UploadSpec): Promise<Upload> {
  const contentType = request.headers.get("content-type");
  if (!contentType?.startsWith("multipart/form-data;")) {
    throw Response.json({ error: `Upload ${spec.what} with multipart form data.` }, { status: 415 });
  }
  const limit = spec.maxBytes + 64 * 1024;
  const tooLarge = () => Response.json({ error: `Choose ${spec.what} up to ${spec.limitLabel}.` }, { status: 413 });
  if (Number(request.headers.get("content-length")) > limit) throw tooLarge();
  if (!request.body) throw Response.json({ error: `Choose ${spec.what} to upload.` }, { status: 400 });
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw tooLarge();
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
    throw Response.json({ error: `The ${spec.field} upload could not be read.` }, { status: 400 });
  }
  const file = form.get(spec.field);
  if (!(file instanceof File) || form.getAll(spec.field).length !== 1 || file.size === 0 || file.size > spec.maxBytes) {
    throw Response.json({ error: `Choose one ${spec.field} up to ${spec.limitLabel}.` }, { status: 400 });
  }
  const rawProject = form.get("projectId");
  const project = rawProject === null || rawProject === "" ? null : IdSchema.safeParse(rawProject);
  if (project !== null && !project.success) throw Response.json({ error: "Choose a valid project." }, { status: 400 });
  const name =
    file.name
      .split(/[/\\]/)
      .at(-1)
      ?.replace(/[\x00-\x1f]/g, "")
      .slice(0, 255) || `Uploaded ${spec.field}`;
  return { projectId: project?.data ?? null, name, bytes: new Uint8Array(await file.arrayBuffer()) };
}

export function readImageUpload(request: Request): Promise<Upload> {
  return readUpload(request, IMAGE);
}

export function readAudioUpload(request: Request): Promise<Upload> {
  return readUpload(request, AUDIO);
}
