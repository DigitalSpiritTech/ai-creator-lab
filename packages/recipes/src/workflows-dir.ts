/**
 * Where the starter workflow files live. Paths resolve against the working directory, which is the
 * repository root for every script (`npm run dev`, `npm test`, the Docker image), so a bundled
 * server and plain Node agree without reading this module's own location.
 * @packageDocumentation
 */
import { resolve } from "node:path";

/** The workflows folder relative to the repository root. */
export const WORKFLOWS_DIR_RELATIVE = "packages/recipes/workflows";

/** The absolute workflows folder for a repository root (the working directory by default). */
export function defaultWorkflowsDir(root: string = process.cwd()): string {
  return resolve(/* turbopackIgnore: true */ root, WORKFLOWS_DIR_RELATIVE);
}
