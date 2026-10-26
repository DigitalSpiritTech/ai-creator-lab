/**
 * Loads `workflows/*.slots.json` sidecars into workflow recipes, checking each against its graph.
 * @packageDocumentation
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { sidecarProblems, SlotSidecarSchema, WorkflowGraphSchema, WorkflowRecipeSchema, type WorkflowRecipe } from "@/lib/catalog";

/** Curated facts the sidecar format does not carry: title, verification date, cost, defaults. */
export interface WorkflowMeta {
  title: string;
  verified: string | null;
  costHint: string;
  ceilingUsd?: number;
  fitImages?: boolean;
  defaults?: WorkflowRecipe["defaults"];
  notes?: string;
}

export interface LoadedWorkflows {
  recipes: WorkflowRecipe[];
  /** Sidecars that could not be loaded, with the reason, so the UI can show them. */
  problems: { file: string; problem: string }[];
}

function titleFrom(id: string): string {
  return id.replaceAll("-", " ").replace(/^\w/, (letter) => letter.toUpperCase());
}

/** Reads every sidecar in `directory`; unknown workflows load as unverified with no cost ceiling. */
export async function loadWorkflowRecipes(directory: string, meta: Record<string, WorkflowMeta> = {}): Promise<LoadedWorkflows> {
  const recipes: WorkflowRecipe[] = [];
  const problems: { file: string; problem: string }[] = [];
  const files = (await readdir(directory)).filter((file) => file.endsWith(".slots.json")).sort();
  for (const file of files) {
    const id = file.slice(0, -".slots.json".length).toLowerCase();
    try {
      const sidecar = SlotSidecarSchema.parse(JSON.parse(await readFile(join(directory, file), "utf8")));
      const graph = WorkflowGraphSchema.parse(JSON.parse(await readFile(join(directory, sidecar.workflow), "utf8")));
      const mismatch = sidecarProblems(sidecar, graph);
      if (mismatch.length) throw new Error(mismatch.join(" "));
      const info = meta[id];
      recipes.push(
        WorkflowRecipeSchema.parse({
          id,
          kind: "workflow",
          title: info?.title ?? titleFrom(id),
          capability: sidecar.capability,
          openWeights: sidecar.openWeights,
          verified: info?.verified ?? null,
          costHint: info?.costHint ?? "Cost unknown until it runs; Cloud bills by GPU time.",
          ceilingUsd: info?.ceilingUsd,
          limits: {
            sizes: sidecar.limits.sizes,
            maxReferences: sidecar.maxReferences,
            fps: sidecar.limits.fps,
          },
          defaults: info?.defaults ?? {},
          notes: info?.notes ?? sidecar.notes?.slice(0, 600),
          file: sidecar.workflow,
          target: "cloud",
          sidecar,
          fitImages: info?.fitImages ?? false,
        }),
      );
    } catch (cause) {
      problems.push({ file, problem: cause instanceof Error ? cause.message.slice(0, 300) : "Unreadable sidecar." });
    }
  }
  return { recipes, problems };
}
