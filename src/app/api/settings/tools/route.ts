/**
 * Settings video tools check: the ffmpeg and ffprobe in use, their versions, and whether
 * captions can be burned in. Paths and versions only.
 * @packageDocumentation
 */
import { checkVideoToolsReport } from "@/server/media/tools";
import { route } from "@/app/api/_lib/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return route(async () => Response.json(await checkVideoToolsReport()));
}
