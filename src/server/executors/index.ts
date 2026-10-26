/**
 * Executors and the factory that wires them to the user's Comfy key.
 * @packageDocumentation
 */
import type { Recipe } from "@/lib/catalog";
import { quoteRouter } from "@/server/executors/allowance";
import { MockExecutor } from "@/server/executors/mock";
import { createRouterModels, RouterExecutor } from "@/server/executors/router";
import type { Executor, JobRepository } from "@/server/executors/types";
import { createWorkflowClient, WorkflowExecutor } from "@/server/executors/workflow";

export * from "@/server/executors/types";
export { MockExecutor } from "@/server/executors/mock";
export { RouterExecutor } from "@/server/executors/router";
export { WorkflowExecutor } from "@/server/executors/workflow";
export { MemoryJobRepository } from "@/server/executors/memory-repository";
export { runToCompletion } from "@/server/executors/run";
export { checkAllowance, readAllowanceUsd, readCreditBalance, CREDITS_PER_USD } from "@/server/executors/allowance";

export interface ExecutorSet {
  mock: MockExecutor;
  router?: RouterExecutor;
  workflow?: WorkflowExecutor;
  /** The executor for a recipe, or undefined when its target is not configured. */
  forRecipe(recipe: Pick<Recipe, "kind">): Executor | undefined;
}

export interface ExecutorConfig {
  repository: JobRepository;
  apiKey?: string;
  workflowsDir?: string;
  schemaFor?: (model: string) => Promise<unknown | undefined>;
}

/** Creates the mock executor always, and the Router and Workflow executors when a Comfy key is set. */
export function createExecutors(config: ExecutorConfig): ExecutorSet {
  const mock = new MockExecutor({ repository: config.repository });
  const apiKey = config.apiKey?.trim();
  const router = apiKey
    ? new RouterExecutor({
        repository: config.repository,
        models: createRouterModels(apiKey),
        quote: (model, body) => quoteRouter(apiKey, model, body),
        schemaFor: config.schemaFor,
      })
    : undefined;
  const workflow = apiKey || process.env.COMFY_BASE_URL?.trim()
    ? new WorkflowExecutor({ repository: config.repository, client: createWorkflowClient(apiKey), workflowsDir: config.workflowsDir })
    : undefined;
  return {
    mock,
    router,
    workflow,
    forRecipe(recipe) {
      if (recipe.kind === "mock") return mock;
      return recipe.kind === "router" ? router : workflow;
    },
  };
}
