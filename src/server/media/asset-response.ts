/**
 * Streams managed media with byte ranges for video playback and seeking.
 * @packageDocumentation
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { type Asset, extensionFor } from "@/lib/domain/asset";
import { resolveMediaPath } from "@/server/media/paths";

export type ByteRange =
  | { kind: "full"; start: number; end: number }
  | { kind: "partial"; start: number; end: number }
  | { kind: "unsatisfiable" };

/** Interprets a single HTTP byte range without accepting unsafe offsets. */
export function parseByteRange(range: string | null, size: number): ByteRange {
  if (!range) return { kind: "full", start: 0, end: size - 1 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) return { kind: "unsatisfiable" };
  const first = match[1] ? Number(match[1]) : undefined;
  const last = match[2] ? Number(match[2]) : undefined;
  if ((first !== undefined && !Number.isSafeInteger(first)) || (last !== undefined && !Number.isSafeInteger(last))) {
    return { kind: "unsatisfiable" };
  }
  const start = first === undefined ? Math.max(0, size - (last ?? 0)) : first;
  const end = first === undefined || last === undefined ? size - 1 : Math.min(last, size - 1);
  if (start >= size || start > end || size === 0) return { kind: "unsatisfiable" };
  return { kind: "partial", start, end };
}

/**
 * Streams an asset, or its video poster with `?poster`, with stable playback headers.
 * `?download` sets an attachment disposition. Deleted assets are 404.
 */
export async function assetResponse(request: Request, asset: Asset, dataDir: string): Promise<Response> {
  const url = new URL(request.url);
  const poster = url.searchParams.has("poster");
  if (asset.state.state === "deleted" || (poster && !asset.video?.posterPath)) return new Response(null, { status: 404 });
  const path = resolveMediaPath(dataDir, poster ? asset.video!.posterPath! : asset.relativePath);
  const { size } = await stat(path);
  const range = parseByteRange(request.method === "HEAD" ? null : request.headers.get("range"), size);
  const extension = poster ? "png" : extensionFor(asset.mime);
  const headers = new Headers({
    "Content-Type": poster ? "image/png" : asset.mime,
    "Content-Disposition": `${url.searchParams.has("download") ? "attachment" : "inline"}; filename="${asset.kind}-${asset.id}.${extension}"`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
    "Accept-Ranges": "bytes",
  });
  if (asset.mime === "image/svg+xml" && !poster) {
    headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  }
  if (range.kind === "unsatisfiable") {
    headers.set("Content-Range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  const length = Math.max(0, range.end - range.start + 1);
  headers.set("Content-Length", String(length));
  if (range.kind === "partial") headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
  const body =
    request.method === "HEAD" || size === 0
      ? null
      : (Readable.toWeb(
          createReadStream(path, { start: range.start, end: range.end, signal: request.signal }),
        ) as ReadableStream<Uint8Array>);
  return new Response(body, { status: range.kind === "partial" ? 206 : 200, headers });
}
