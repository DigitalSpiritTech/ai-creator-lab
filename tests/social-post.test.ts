/**
 * Social Post (F13), the first content type added purely as a plugin: it exists only in its
 * package and the app's composition files, appears in the shell with no shell change, brings its
 * own tools, panels, and assistant, and runs brief, copy, a 4:5 still through the gate with the mock
 * executor, approval, and export.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SOCIAL_POST_APP,
  SOCIAL_POST_CONTENT_TYPE,
  SOCIAL_POST_PANELS,
  SOCIAL_POST_TOOLS,
  socialPostPlugin,
} from "@creator-lab/content-social-post";
import { copyText, normalizeCopy } from "@creator-lab/content-social-post/copy";
import { SOCIAL_POST_PANEL_COMPONENTS } from "@creator-lab/content-social-post/panels";
import { socialPostServerPlugin, socialPostStage, stillPrompt } from "@creator-lab/content-social-post/server";
import type { GenerationProposal } from "@creator-lab/core/domain/job";
import type { PluginPiece } from "@creator-lab/core/domain/piece";
import { createProject } from "@creator-lab/core/domain/project";
import type { PanelHost } from "@creator-lab/core/registry";
import { proposalAutoApproves } from "@/components/project/chat-panel";
import { WorkspacePanels } from "@/components/project/workspace-panels";
import { appPlugins } from "@/plugins/panels";
import { appChoices } from "@/plugins/registry";
import { serverDefinitions, serverPlugins } from "@/plugins/server";
import { AGENT_TOOLS, PLUGIN_TOOLS, TOOLS, type ToolContext, agentToolsFor, callTool, createGenerationContext } from "@/server/tools";
import { startProject } from "@/server/tools/project";
import { scriptedModel, say } from "@/server/agent";
import { ridgelineProduct, clock, tempStore } from "./support/domain-fixtures";
import { runTurn } from "./support/agent-harness";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const workflowsDir = fileURLToPath(new URL("../packages/recipes/workflows", import.meta.url));
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function setup() {
  const context = tempStore();
  cleanups.push(context.cleanup);
  const now = clock();
  const tools: ToolContext = { store: context.store, now, newId: randomUUID, generation: createGenerationContext(context.store, { workflowsDir }) };
  return { ...context, now, tools };
}

async function run<T>(tools: ToolContext, name: string, input: Record<string, unknown>): Promise<T> {
  const result = await callTool(tools, name, input);
  if (!result.ok) throw new Error(`${name}: ${result.failure.code}: ${result.failure.message}`);
  return result.output as T;
}

const BRIEF = { productSummary: "Ridgeline 32 oz insulated bottle", audience: "Commuters who drive to work", platforms: ["Instagram"], tone: "Warm and direct" };
const COPY = {
  caption: "It fits my cup holder and it was still cold at five.",
  hashtags: ["#commute", "hydration", "#Commute"],
  callToAction: "Link in bio.",
  visual: "The bottle in a car cup holder, morning light through the windshield.",
};

describe("Social Post exists only as a plugin", () => {
  test("its id appears nowhere outside its package, the app's composition files, package manifests, docs, and tests", () => {
    const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
    const allowed = (file: string) =>
      file.startsWith("packages/content-social-post/") ||
      file.startsWith("tests/") ||
      file.startsWith("docs/") ||
      file.endsWith(".md") ||
      file.endsWith("package.json") ||
      file === "package-lock.json" ||
      [
        "apps/creator/src/plugins/installed.ts",
        "apps/creator/src/plugins/panels.tsx",
        "apps/creator/src/plugins/server.ts",
        "apps/creator/next.config.ts",
        // The acceptance smoke is a test: it drives a Social Post project over HTTP.
        "apps/creator/scripts/acceptance-smoke.ts",
      ].includes(file);
    const pattern = /social[-_]post|socialPost|SOCIAL_POST|Social Post/;
    const offenders = files.filter((file) => /\.(ts|tsx|mjs|cjs|js|json|css|sql)$/.test(file) && !allowed(file)).filter((file) => pattern.test(readFileSync(`${ROOT}/${file}`, "utf8")));
    assert.deepEqual(offenders, [], "the core shell, store, tools, and agent never name Social Post");
    // And the composition files do name it, so the check above is looking at the right repository.
    assert.match(readFileSync(`${ROOT}/apps/creator/src/plugins/installed.ts`, "utf8"), /socialPostPlugin/);
  });

  test("it appears in the shell: an App on the Projects page and its three panels, each drawn by the plugin", () => {
    assert.ok(appChoices().some((app) => app.id === SOCIAL_POST_APP.id && app.label === "Social Post"));
    const type = appPlugins.contentTypeForApp(SOCIAL_POST_APP.id);
    assert.equal(type?.id, SOCIAL_POST_CONTENT_TYPE);
    const panels = appPlugins.resolvePanels(SOCIAL_POST_CONTENT_TYPE);
    assert.deepEqual(panels.map(({ panel }) => panel.title), ["Post", "Stills", "Export"]);
    assert.deepEqual(panels.map(({ component }) => component), [SOCIAL_POST_PANEL_COMPONENTS[SOCIAL_POST_PANELS.post], SOCIAL_POST_PANEL_COMPONENTS[SOCIAL_POST_PANELS.stills], SOCIAL_POST_PANEL_COMPONENTS[SOCIAL_POST_PANELS.export]]);
    const host: PanelHost = { projectId: randomUUID(), contentTypeId: SOCIAL_POST_CONTENT_TYPE, openPanel: () => undefined, refresh: async () => undefined, notify: () => undefined, callTool: () => new Promise(() => undefined), assetUrl: (id) => `/api/assets/${id}` };
    const html = renderToStaticMarkup(createElement(WorkspacePanels, { contentTypeId: SOCIAL_POST_CONTENT_TYPE, active: null, onSelect: () => undefined, host }));
    assert.match(html, /aria-selected="true"[^>]*>Post<\/button>.*>Stills<\/button>.*>Export<\/button>/);
  });

  test("a proposal a plugin panel raises always waits for a click, even with auto-approve on", () => {
    assert.equal(proposalAutoApproves(true, "panel"), false);
    assert.equal(proposalAutoApproves(true, "history"), false);
    assert.equal(proposalAutoApproves(true, "assistant"), true);
    assert.equal(proposalAutoApproves(false, "workspace"), false);
  });

  test("the server registers the same manifest with its tools, copy schema, and assistant", () => {
    assert.equal(serverDefinitions().find((definition) => definition.id === socialPostPlugin.id), socialPostServerPlugin);
    assert.deepEqual(serverPlugins.contentType(SOCIAL_POST_CONTENT_TYPE), appPlugins.contentType(SOCIAL_POST_CONTENT_TYPE));
    assert.deepEqual(serverPlugins.tools(SOCIAL_POST_CONTENT_TYPE).map((tool) => tool.name), Object.values(SOCIAL_POST_TOOLS));
    assert.ok(serverPlugins.pieceType(socialPostPlugin.contentTypes[0].pieceType));
    assert.ok(serverPlugins.assistant(SOCIAL_POST_CONTENT_TYPE)?.systemPrompt.includes("no video"));
    assert.equal(TOOLS.length, 37, "the core roster: the 33 tools, start_quick_ad (F11), and generate_take, transcribe_take, save_edl (F5)");
    assert.deepEqual(PLUGIN_TOOLS.map((tool) => tool.name), Object.values(SOCIAL_POST_TOOLS));
  });

  test("the assistant is offered the Ad's full roster in an Ad project, and the post's tools (no Ad tools) in a post project", () => {
    assert.deepEqual(agentToolsFor("ad").map((tool) => tool.name), AGENT_TOOLS.map((tool) => tool.name));
    const post = agentToolsFor(SOCIAL_POST_CONTENT_TYPE).map((tool) => tool.name);
    for (const name of ["get_project_state", "save_brief", "link_library_item", "propose_candidates", "approve", "archive_asset", "list_document_versions", "restore_document_version", ...Object.values(SOCIAL_POST_TOOLS)]) {
      assert.ok(post.includes(name), `${name} is offered`);
    }
    for (const name of ["save_script", "plan_shots", "compose_still", "generate_clip", "assemble_ad", "delete_asset_everywhere", "submit_proposal"]) {
      assert.ok(!post.includes(name), `${name} is not offered`);
    }
  });
});

describe("Social Post copy and stage", () => {
  test("copy is normalized and exported as one block of text", () => {
    const copy = normalizeCopy(COPY);
    assert.deepEqual(copy.hashtags, ["commute", "hydration"]);
    assert.equal(copyText(copy), "It fits my cup holder and it was still cold at five.\n\nLink in bio.\n\n#commute #hydration");
    assert.throws(() => normalizeCopy({ ...COPY, hashtags: ["two words"] }));
  });

  test("the still prompt names the references by position, frames the ratio, and keeps text out of the image", () => {
    const prompt = stillPrompt("The bottle on a gym bench", "4:5", { product: { image: 1, appearance: "a matte dark green steel bottle" } });
    assert.equal(
      prompt,
      "The bottle on a gym bench. The product is a matte dark green steel bottle, exactly as shown in image 1. Portrait 4:5 feed composition, the subject filling the upper two thirds. Natural light, photographic, no text, captions, watermarks, or logos in the image.",
    );
    assert.doesNotMatch(prompt, /Ridgeline/, "the prompt never uses the product's name");
  });

  test("the stage moves from brief to copy to stills to export", () => {
    const now = clock();
    const project = createProject({ name: "Cup holder post", appId: SOCIAL_POST_APP.id }, randomUUID(), now());
    const view = (overrides: Partial<Parameters<typeof socialPostStage>[0]> = {}) => ({ project, pieces: [], linked: [], ...overrides });
    assert.equal(socialPostStage(view()).stepId, "brief");
    const briefed = { ...project, brief: BRIEF };
    assert.equal(socialPostStage(view({ project: briefed })).stepId, "copy");
    const piece = { id: randomUUID(), projectId: project.id, ownerId: "local", type: "social-post", title: "Cup holder", body: normalizeCopy(COPY), brokenAssetIds: [], revision: 0, createdAt: 1, updatedAt: 1, slots: { "1:1": { state: "empty" as const }, "4:5": { state: "empty" as const }, "9:16": { state: "empty" as const }, "16:9": { state: "empty" as const } } } satisfies PluginPiece;
    const stills = socialPostStage(view({ project: briefed, pieces: [piece] }));
    assert.equal(stills.stepId, "stills");
    assert.match(stills.guidance, /aspectRatio 4:5/);
    const assetId = randomUUID();
    const done = socialPostStage(view({ project: briefed, pieces: [{ ...piece, slots: { ...piece.slots, "4:5": { state: "approved", candidateIds: [assetId], assetId, approvedAt: 2 } } }] }));
    assert.equal(done.stepId, "export");
    assert.match(done.state.join("\n"), /4:5 approved/);
  });
});

describe("Social Post flow with the mock executor", () => {
  test("brief, a linked product, copy, a 4:5 still through the gate, approval, and export", async () => {
    const { store, tools } = setup();
    const { project } = startProject(tools, { name: "Cup holder post", appId: SOCIAL_POST_APP.id });
    await run(tools, "save_brief", { projectId: project.id, brief: BRIEF });
    const saved = await run<{ product: { id: string } }>(tools, "save_product", { product: ridgelineProduct(), projectId: project.id });

    const first = await run<{ post: PluginPiece; created: boolean }>(tools, SOCIAL_POST_TOOLS.saveCopy, { projectId: project.id, copy: COPY });
    assert.equal(first.created, true);
    assert.deepEqual(Object.keys(first.post.slots), ["1:1", "4:5", "9:16", "16:9"]);
    const revised = await run<{ post: PluginPiece; created: boolean; copyText: string }>(tools, SOCIAL_POST_TOOLS.saveCopy, { projectId: project.id, copy: { ...COPY, callToAction: "Tap the link." }, revision: first.post.revision });
    assert.equal(revised.created, false);
    assert.equal(revised.post.id, first.post.id, "saving again revises the same post");
    const history = await run<{ versions: unknown[]; current: number }>(tools, "list_document_versions", { kind: "piece", subjectId: first.post.id });
    assert.equal(history.versions.length, 2);
    assert.equal(history.current, 2);

    const proposal = await run<GenerationProposal>(tools, SOCIAL_POST_TOOLS.proposeStill, { contentId: first.post.id, aspectRatio: "4:5", recipeId: "mock-text-to-image", count: 2 });
    assert.deepEqual(proposal.target, { kind: "piece", contentId: first.post.id, slot: "4:5" });
    assert.equal(proposal.aspectRatio, "4:5");
    assert.equal(proposal.capability, "text_to_image", "no product photo yet, so text to image");
    assert.match(proposal.prompt, /matte dark green/);
    assert.equal(store.jobs.listByProject(project.id).length, 0, "a proposal runs nothing");

    const submitted = await run<{ results: { outcome: string; assetIds: string[] }[] }>(tools, "submit_proposal", { proposal, wait: true });
    assert.deepEqual(submitted.results.map((result) => result.outcome), ["completed", "completed"]);
    const candidates = submitted.results.flatMap((result) => result.assetIds);
    const slot = store.pieces.getRequired(first.post.id).slots["4:5"];
    assert.deepEqual(slot.state === "open" && slot.candidateIds, candidates);

    const approved = await run<{ piece: PluginPiece; archivedAssetIds: string[] }>(tools, "approve", { kind: "slot", contentId: first.post.id, slot: "4:5", assetId: candidates[0] });
    assert.deepEqual(approved.archivedAssetIds, [candidates[1]]);

    const exported = await run<{ copyText: string; stills: { aspectRatio: string; assetId: string }[]; missing: string[] }>(tools, SOCIAL_POST_TOOLS.export, { contentId: first.post.id });
    assert.deepEqual(exported.stills.map((still) => [still.aspectRatio, still.assetId]), [["4:5", candidates[0]]]);
    assert.deepEqual(exported.missing, ["1:1", "9:16", "16:9"]);
    assert.match(exported.copyText, /Tap the link\.\n\n#commute #hydration$/);

    // With a product photo on the card, the next still uses it as image 1.
    const photo = store.assets.getRequired(candidates[0]);
    await run(tools, "save_product", { productId: saved.product.id, product: ridgelineProduct([photo.id]) });
    const square = await run<GenerationProposal>(tools, SOCIAL_POST_TOOLS.proposeStill, { contentId: first.post.id, aspectRatio: "1:1", recipeId: "mock-image-edit", count: 1 });
    assert.equal(square.capability, "image_edit");
    assert.deepEqual(square.references, [{ role: "image1", assetId: photo.id }]);
    assert.match(square.prompt, /exactly as shown in image 1\. Square composition/);
  });

  test("posts live only in Social Post projects; a still needs a visual line; an export needs an approved still", async () => {
    const { tools } = setup();
    const ad = startProject(tools, { name: "Cup holder ad" }).project;
    const refused = await callTool(tools, SOCIAL_POST_TOOLS.saveCopy, { projectId: ad.id, copy: COPY });
    assert.ok(!refused.ok && /another App/.test(refused.failure.message));
    const { project } = startProject(tools, { name: "Post", appId: SOCIAL_POST_APP.id });
    const { post } = await run<{ post: PluginPiece }>(tools, SOCIAL_POST_TOOLS.saveCopy, { projectId: project.id, copy: { caption: "Cold at five." } });
    const noVisual = await callTool(tools, SOCIAL_POST_TOOLS.proposeStill, { contentId: post.id, aspectRatio: "4:5" });
    assert.ok(!noVisual.ok && /visual line/.test(noVisual.failure.message));
    const noStill = await callTool(tools, SOCIAL_POST_TOOLS.export, { contentId: post.id });
    assert.ok(!noStill.ok && /Approve a still/.test(noStill.failure.message));
    const badRatio = await callTool(tools, SOCIAL_POST_TOOLS.proposeStill, { contentId: post.id, aspectRatio: "3:2", prompt: "A bottle" });
    assert.equal(badRatio.ok, false);
  });

  test("the assistant in a post project gets the plugin's prompt, its state, and its tools", async () => {
    const { store, now, tools } = setup();
    const project = store.projects.create(createProject({ name: "Cup holder post", appId: SOCIAL_POST_APP.id }, randomUUID(), now()));
    const model = scriptedModel([say("What does the post promote?")]);
    const result = await runTurn({ tools, project }, "Let's make a post about the bottle.", model);
    assert.equal(result.error, undefined);
    const [call] = model.calls;
    assert.match(JSON.stringify(call.system), /Social Post assistant/);
    const offered = call.tools.map((tool) => tool.name);
    assert.ok(offered.includes(SOCIAL_POST_TOOLS.saveCopy));
    assert.ok(!offered.includes("assemble_ad"));
    const lastUser = JSON.stringify(call.messages.at(-1));
    assert.match(lastUser, /Next step: 1\. Brief/);
    assert.match(lastUser, /Social post: none yet/);
  });
});
