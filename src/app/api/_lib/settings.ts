/**
 * The Settings view shared by the settings and budget routes: which keys are configured (never
 * their values), workspace settings, the spend policy in force, and the data directory.
 * @packageDocumentation
 */
import "server-only";
import { CREDITS_PER_USD } from "@/lib/domain/spend";
import { currentSpendPolicy } from "@/server/executors/spend";
import { secretsStatus } from "@/server/secrets";
import type { Store } from "@/server/store";

export function settingsView(store: Store) {
  return {
    workspace: store.workspace.get(),
    keys: secretsStatus(store.dataDir),
    /** This period's budget, extension, spend, and the operator ceiling (GENERATION_ALLOWANCE_USD, read-only). */
    spend: currentSpendPolicy({ store }),
    creditsPerUsd: CREDITS_PER_USD,
    dataDirectory: store.dataDir,
  };
}
