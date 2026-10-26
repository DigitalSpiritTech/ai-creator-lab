/**
 * Downloads Router result media from changing public CDN hosts. Every DNS answer and redirect target is
 * checked against public address ranges and the socket is pinned to the checked address, so a result URL
 * cannot reach local or private services. No credentials are ever sent.
 * @packageDocumentation
 */
import { lookup } from "node:dns/promises";
import { get, type RequestOptions } from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";
import { z } from "zod";
import { ExecutorFailure, jobError } from "@/server/executors/jobs";

const AddressSchema = z.object({ address: z.string(), family: z.union([z.literal(4), z.literal(6)]) });
export type MediaAddress = z.infer<typeof AddressSchema>;

/** DNS and credential-free HTTPS boundaries, injectable for offline tests. */
export interface MediaPorts {
  lookup(host: string): Promise<readonly MediaAddress[]>;
  /** One HTTPS GET pinned to `address`, without redirects or credentials. */
  get(url: URL, address: MediaAddress, signal: AbortSignal): Promise<Response>;
}

export const MEDIA_LIMIT_BYTES = 200 * 1024 * 1024;

const deniedV4 = new BlockList();
const deniedV4Ranges = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const;
for (const [address, prefix] of deniedV4Ranges) deniedV4.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const deniedV6 = new BlockList();
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) deniedV6.addSubnet(address, prefix, "ipv6");

type MediaReason = "destination" | "size" | "download";

const MEDIA_MESSAGES: Record<MediaReason, string> = {
  destination: "The output download was blocked because its address is not a public HTTPS destination. Retrieval will retry without generating again.",
  size: `The output exceeds the ${MEDIA_LIMIT_BYTES / 1024 / 1024} MB download limit. The request is kept; nothing new is generated.`,
  download: "The output download could not finish. Retrieval will retry without generating again.",
};

function mediaFailure(reason: MediaReason): ExecutorFailure {
  return new ExecutorFailure(jobError("provider", MEDIA_MESSAGES[reason], true));
}

/** Whether a literal IP is public unicast (not local, private, reserved, mapped, or documentation). */
export function publicMediaAddress(value: string): boolean {
  const family = isIP(value);
  if (family === 4) return !deniedV4.check(value, "ipv4");
  return family === 6 && globalV6.check(value, "ipv6") && !deniedV6.check(value, "ipv6");
}

/** Accepts only HTTPS URLs with a public-looking DNS name, no port, credentials, or fragment. */
export function mediaUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw mediaFailure("destination");
  }
  const badHost =
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname) ||
    /\.(?:local|localhost|internal|lan|home|test|invalid)$/.test(url.hostname) ||
    url.hostname === "metadata.amazonaws.com";
  if (/[\s\\]/.test(value) || url.protocol !== "https:" || url.port || url.username || url.password || url.hash || badHost) {
    throw mediaFailure("destination");
  }
  return url;
}

async function resolveAddress(host: string, ports: MediaPorts, signal: AbortSignal): Promise<MediaAddress> {
  let onAbort = () => {};
  try {
    const expired = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(mediaFailure("download"));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    const addresses = z.array(AddressSchema).min(1).max(256).parse(await Promise.race([ports.lookup(host), expired]));
    for (const address of addresses) {
      if (isIP(address.address) !== address.family || !publicMediaAddress(address.address)) throw mediaFailure("destination");
    }
    return addresses.find((address) => address.family === 4) ?? addresses[0];
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** Node request options that pin the socket to one checked address while keeping TLS hostname checks. */
export function mediaRequestOptions(url: URL, address: MediaAddress, signal: AbortSignal): RequestOptions {
  return {
    protocol: "https:",
    hostname: url.hostname,
    servername: url.hostname,
    port: 443,
    path: url.pathname + url.search,
    method: "GET",
    agent: false,
    rejectUnauthorized: true,
    family: address.family,
    signal,
    lookup(_host, options, callback) {
      callback(null, options.all ? [address] : address.address, address.family);
    },
  };
}

function pinnedGet(url: URL, address: MediaAddress, signal: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = get(mediaRequestOptions(url, address, signal), (response) => {
      const headers = new Headers();
      for (let index = 0; index < response.rawHeaders.length; index += 2) headers.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
      const status = response.statusCode ?? 502;
      if ([204, 205, 304].includes(status)) {
        response.destroy();
        resolve(new Response(null, { status, headers }));
      } else {
        resolve(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array<ArrayBuffer>>, { status, headers }));
      }
    });
    request.on("error", reject);
  });
}

export const productionMediaPorts: MediaPorts = {
  async lookup(host) {
    return z.array(AddressSchema).parse(await lookup(host, { all: true, verbatim: true }));
  },
  get: pinnedGet,
};

/**
 * Downloads at most MEDIA_LIMIT_BYTES within two minutes, rechecking and pinning every redirect.
 * Failures are sanitized and never contain the signed URL.
 */
export async function downloadMedia(value: string, ports: MediaPorts = productionMediaPorts): Promise<Uint8Array> {
  const signal = AbortSignal.timeout(120_000);
  try {
    let url = mediaUrl(value);
    for (let hop = 0; hop < 4; hop++) {
      const address = await resolveAddress(url.hostname, ports, signal);
      signal.throwIfAborted();
      const response = await ports.get(url, address, signal);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location) throw mediaFailure("destination");
        url = mediaUrl(new URL(location, url).href);
        continue;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw mediaFailure("download");
      }
      if (Number(response.headers.get("content-length")) > MEDIA_LIMIT_BYTES) {
        await response.body.cancel();
        throw mediaFailure("size");
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          size += chunk.length;
          if (size > MEDIA_LIMIT_BYTES) throw mediaFailure("size");
          chunks.push(chunk);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      return Buffer.concat(chunks);
    }
    throw mediaFailure("download");
  } catch (error) {
    if (error instanceof ExecutorFailure && Object.values(MEDIA_MESSAGES).includes(error.failure.message)) throw error;
    throw mediaFailure("download");
  }
}
