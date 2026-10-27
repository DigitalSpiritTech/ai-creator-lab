/**
 * Browser helpers for the local API: JSON requests with readable errors, tool calls, the spending
 * gate, and asset URLs.
 * @packageDocumentation
 */
import type { Asset, GenerationProposal, SubmitResult } from "@/lib/client/types";

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function parse<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) throw new ApiError(response.status, body?.error ?? "The studio could not complete this request.");
  return body as T;
}

export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  return parse<T>(await fetch(path, { cache: "no-store", signal }));
}

export async function sendJson<T>(path: string, body: unknown, method: "POST" | "PUT" = "POST"): Promise<T> {
  return parse<T>(
    await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  );
}

/** Calls one roster tool, scoped to a project when `projectId` is given. */
export function callTool<T = unknown>(name: string, input: Record<string, unknown>, projectId?: string): Promise<T> {
  const path = projectId ? `/api/projects/${projectId}/tools/${name}` : `/api/tools/${name}`;
  return sendJson<T>(path, input);
}

/** The spending gate: submit a proposal the user approved. */
export function submitProposal(proposal: GenerationProposal, confirmUnquoted = false): Promise<{ results: SubmitResult[] }> {
  return sendJson(`/api/projects/${proposal.projectId}/proposals/submit`, { proposal, confirmUnquoted });
}

export const UPLOAD_TYPES = "image/png,image/jpeg,image/webp";

/** Uploads one image as an asset; `as: "sheet"` stores it as a reference sheet (needs a project). */
export async function uploadImage(file: File, projectId?: string | null, options: { as?: "sheet" } = {}): Promise<{ asset: Asset }> {
  const form = new FormData();
  form.set("image", file);
  if (projectId) form.set("projectId", projectId);
  return parse(await fetch(`/api/uploads${options.as ? `?as=${options.as}` : ""}`, { method: "POST", body: form }));
}

export function assetUrl(id: string, options: { poster?: boolean; download?: boolean } = {}): string {
  const query = [options.poster ? "poster" : "", options.download ? "download" : ""].filter(Boolean).join("&");
  return `/api/assets/${id}${query ? `?${query}` : ""}`;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}
