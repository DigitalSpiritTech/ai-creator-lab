/**
 * Settings: which keys are configured (never their values), workspace settings, the spend policy in
 * force (monthly budget, this period's extension and spend, the read-only operator ceiling), and the
 * data directory. PUT edits the monthly budget, its reset day, auto-approve, and default recipes;
 * the operator ceiling is GENERATION_ALLOWANCE_USD and cannot be changed here.
 * @packageDocumentation
 */
import { UpdateWorkspaceSettingsSchema } from "@/lib/domain/workspace";
import { readJson } from "@/server/http";
import { settingsView } from "@/app/api/_lib/settings";
import { route, withStore } from "@/app/api/_lib/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return route(() => withStore((store) => Response.json(settingsView(store))));
}

export async function PUT(request: Request): Promise<Response> {
  return route(async () => {
    const patch = UpdateWorkspaceSettingsSchema.parse(await readJson(request));
    return withStore((store) => {
      store.workspace.update(patch, Date.now());
      return Response.json(settingsView(store));
    });
  });
}
