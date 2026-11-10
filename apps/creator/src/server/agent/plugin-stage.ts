/**
 * The assistant for a content type whose plugin brings its own assistant: its
 * system prompt, and a project state block built from the generic project (brief, Library links,
 * running jobs) plus the plugin's own lines and next step. The Ad keeps the creative director.
 * @packageDocumentation
 */
import { isTerminal } from "@creator-lab/core/domain/job";
import { libraryItemName } from "@creator-lab/core/domain/library";
import type { ContentAssistantDefinition, PluginRegistry, ResolvedContentType } from "@creator-lab/core/registry";
import { serverPlugins } from "@/plugins/server";
import type { Store } from "@/server/store";

/** A project's content type and, when its plugin registered one, that content type's assistant. */
export interface ProjectAssistant {
  contentType: ResolvedContentType;
  assistant: ContentAssistantDefinition;
}

/** The plugin assistant for a project, or undefined when the built-in creative director applies. */
export function projectAssistant(
  store: Store,
  projectId: string,
  registry: Pick<PluginRegistry, "contentTypeForApp" | "assistant"> = serverPlugins,
): ProjectAssistant | undefined {
  const project = store.projects.get(projectId);
  const contentType = project ? registry.contentTypeForApp(project.appId) : undefined;
  const assistant = contentType ? registry.assistant(contentType.id) : undefined;
  return contentType && assistant ? { contentType, assistant } : undefined;
}

/** The project state and the next step, as the plugin's assistant sees them. */
export function pluginState(store: Store, projectId: string, { contentType, assistant }: ProjectAssistant): { lines: string[]; heading: string; guidance: string } {
  const project = store.projects.getRequired(projectId);
  const pieces = store.pieces.listByProject(projectId, contentType.pieceType);
  const linked = store.library.listLinks(projectId).flatMap((link) => {
    const item = store.library.get(link.itemId);
    return item && !item.archived ? [{ kind: item.kind, id: item.id, name: libraryItemName(item) }] : [];
  });
  const stage = assistant.stage({ project, pieces, linked });
  const step = contentType.steps.find((candidate) => candidate.id === stage.stepId);
  const brief = project.brief;
  const running = store.jobs.listByProject(projectId).filter((job) => !isTerminal(job));
  const lines = [
    `Project "${project.name}" (projectId ${project.id}), a ${contentType.label} in ${contentType.app.label}.`,
    brief
      ? `Brief: ${brief.productSummary}. Audience: ${brief.audience}. Platforms: ${brief.platforms.join(", ")}. Tone: ${brief.tone}.`
      : "Brief: none yet.",
    linked.length ? `Linked Library items: ${linked.map((item) => `${item.kind} ${item.name} (${item.id})`).join("; ")}.` : "Linked Library items: none.",
    ...(running.length ? [`Generations running: ${running.length} (${running.map((job) => JSON.stringify(job.request.target)).join(", ")}).`] : []),
    ...stage.state,
  ];
  return { lines, heading: step ? `${step.number}. ${step.title}` : stage.stepId, guidance: stage.guidance };
}
