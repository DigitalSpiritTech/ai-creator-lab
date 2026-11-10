/**
 * Executors and the factory that wires them to the user's Comfy key.
 * @packageDocumentation
 */
import { type Backend, COMFY_CLOUD_URL, backendUsable, isComfyHost, isWorkflowBackend, normalizeBackendUrl, runsFreeOn, type Recipe } from "@creator-lab/core/catalog";
import type { JobStorePort } from "@creator-lab/core/domain/job";
import { quoteRouter } from "./allowance";
import { MockExecutor, type MockVideo } from "./mock";
import { createRouterModels, RouterExecutor } from "./router";
import type { Executor } from "./types";
import { createBackendClient, WorkflowExecutor, type WorkflowClient, type WorkflowTarget } from "./workflow";

export * from "./types";
export { MockExecutor } from "./mock";
export { RouterExecutor } from "./router";
export { WorkflowExecutor } from "./workflow";
export { checkAllowance, readAllowanceUsd, readCreditBalance, CREDITS_PER_USD } from "./allowance";

export interface ExecutorSet {
  mock: MockExecutor;
  router?: RouterExecutor;
  workflow?: WorkflowExecutor;
  /**
   * The executor for a recipe, or undefined when its target is not configured. A workflow recipe
   * bound to a backend (`backendId`) needs that backend to be usable.
   */
  forRecipe(recipe: Pick<Recipe, "kind"> & { backendId?: string }): Executor | undefined;
}

export interface ExecutorConfig {
  jobs: JobStorePort;
  /** The data directory; relative reference paths in requests resolve against it. */
  mediaRoot: string;
  apiKey?: string;
  workflowsDir?: string;
  schemaFor?: (model: string) => Promise<unknown | undefined>;
  /** The backend list (read on every use, so Settings changes apply at once). */
  backends?: () => readonly Backend[];
  /** Builds the SDK client for a backend; tests pass fakes. `baseUrl` null means Comfy Cloud. */
  clientFor?: (baseUrl: string | null, apiKey: string | undefined, backend: Backend) => WorkflowClient;
  /** What mock video jobs write; defaults to `mp4` when MOCK_VIDEO=mp4, else storyboards. */
  mockVideo?: MockVideo;
}

/** The mock's video mode from the environment: `MOCK_VIDEO=mp4` makes real clips (chained recordings need them). */
export function mockVideoFromEnv(env: Record<string, string | undefined> = process.env): MockVideo {
  return env.MOCK_VIDEO?.trim() === "mp4" ? "mp4" : "storyboard";
}

/**
 * Resolves a backend id to a workflow target, caching one client per backend address. The Comfy key
 * goes to Comfy Cloud and to deployments on Comfy's own hosts only.
 */
function workflowTargets(config: ExecutorConfig, apiKey: string | undefined): ((backendId: string) => WorkflowTarget | undefined) | undefined {
  const { backends } = config;
  if (!backends) return undefined;
  const build = config.clientFor ?? ((baseUrl: string | null, key: string | undefined) => createBackendClient(baseUrl, key));
  const clients = new Map<string, WorkflowClient>();
  return (backendId) => {
    const backend = backends().find((entry) => entry.id === backendId);
    if (!backend || !isWorkflowBackend(backend) || !backendUsable(backend, !!apiKey).ok) return undefined;
    const key = backend.kind === "cloud" || (backend.kind === "deployment" && isComfyHost(backend.baseUrl)) ? apiKey : undefined;
    const cacheKey = `${backend.kind}\n${backend.baseUrl}\n${key ? "keyed" : "open"}`;
    let client = clients.get(cacheKey);
    if (!client) {
      client = build(backend.kind === "cloud" ? null : backend.baseUrl, key, backend);
      clients.set(cacheKey, client);
    }
    return { client, label: backend.label, freeFor: (recipeId) => runsFreeOn(recipeId, backend) };
  };
}

/**
 * The client for jobs saved before backends existed (no `backendId`): COMFY_BASE_URL, or Comfy Cloud
 * when it is blank. The key goes only to Comfy Cloud or a Comfy-hosted address, the same rule the
 * backend clients follow, so a self-hosted proxy named there never receives it.
 */
export function legacyClient(
  apiKey: string | undefined,
  env: Record<string, string | undefined> = process.env,
  build: (baseUrl: string | null, apiKey: string | undefined) => WorkflowClient = createBackendClient,
): WorkflowClient | undefined {
  const raw = env.COMFY_BASE_URL?.trim();
  if (!raw) return apiKey ? build(null, apiKey) : undefined;
  const parsed = normalizeBackendUrl(raw);
  const url = parsed.ok ? parsed.url : raw;
  if (url === COMFY_CLOUD_URL) return apiKey ? build(null, apiKey) : undefined;
  return build(url, isComfyHost(url) ? apiKey : undefined);
}

/** Creates the mock executor always, and the Router and Workflow executors when a Comfy key is set. */
export function createExecutors(config: ExecutorConfig): ExecutorSet {
  const mock = new MockExecutor({ jobs: config.jobs, video: config.mockVideo ?? mockVideoFromEnv() });
  const apiKey = config.apiKey?.trim();
  const router = apiKey
    ? new RouterExecutor({
        jobs: config.jobs,
        mediaRoot: config.mediaRoot,
        models: createRouterModels(apiKey),
        quote: (model, body) => quoteRouter(apiKey, model, body),
        schemaFor: config.schemaFor,
      })
    : undefined;
  const defaultClient = legacyClient(apiKey);
  const targets = workflowTargets(config, apiKey);
  const workflow =
    defaultClient || targets
      ? new WorkflowExecutor({
          jobs: config.jobs,
          mediaRoot: config.mediaRoot,
          client: defaultClient,
          targets,
          workflowsDir: config.workflowsDir,
        })
      : undefined;
  return {
    mock,
    router,
    workflow,
    forRecipe(recipe) {
      if (recipe.kind === "mock") return mock;
      if (recipe.kind === "router") return router;
      return workflow?.canRun(recipe) ? workflow : undefined;
    },
  };
}
