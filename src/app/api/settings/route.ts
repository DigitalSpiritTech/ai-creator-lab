/**
 * Settings: which keys are configured (never their values), workspace settings, the allowance in
 * force with spend and reservations, and the data directory. PUT edits allowance, auto-approve, and
 * default recipes.
 * @packageDocumentation
 */
import { UpdateWorkspaceSettingsSchema, effectiveAllowanceUsd } from "@/lib/domain/workspace";
import { readAllowanceUsd } from "@/server/executors/allowance";
import { allowanceState } from "@/server/executors/run";
import { readJson } from "@/server/http";
import { secretsStatus } from "@/server/secrets";
import type { Store } from "@/server/store";
import { generationFor, route, withStore } from "@/app/api/_lib/server";

export const dynamic = "force-dynamic";

function settingsView(store: Store) {
  const workspace = store.workspace.get();
  const operatorUsd = readAllowanceUsd();
  const state = allowanceState({ store, executors: generationFor(store).executors });
  return {
    workspace,
    keys: secretsStatus(store.dataDir),
    allowance: {
      operatorUsd,
      effectiveUsd: effectiveAllowanceUsd(workspace, operatorUsd),
      spentUsd: state.spentUsd,
      reservedUsd: state.reservedUsd,
    },
    dataDirectory: store.dataDir,
  };
}

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
