/**
 * One readable line per assistant tool call for the chat panel: what the tool did, in the
 * user's terms, from its input and output. Falls back to the tool name when a shape is unknown.
 * @packageDocumentation
 */

type Dict = Record<string, unknown>;

function dict(value: unknown): Dict {
  return typeof value === "object" && value !== null ? (value as Dict) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function beat(input: Dict): string {
  const index = num(input.beatIndex);
  return index ? `beat ${index}` : "";
}

function join(parts: (string | undefined | false)[]): string {
  return parts.filter((part): part is string => !!part).join(" · ");
}

/** A proposal's one-line summary: recipe, candidates, estimate. */
function proposal(output: Dict): string {
  const estimate = dict(output.estimate);
  const credits = num(estimate.credits);
  const usd = num(estimate.usd);
  const count = num(output.count);
  const about = estimate.source === "hint" || estimate.kind === "unquoted" ? "up to" : "about";
  const cost = estimate.kind === "free" ? "free" : credits !== undefined ? `${about} ${Math.round(credits * (count ?? 1))} credits` : usd !== undefined ? `up to $${(usd * (count ?? 1)).toFixed(2)}` : undefined;
  return join([str(output.recipeTitle), count ? `${count} candidate${count === 1 ? "" : "s"}` : undefined, cost]);
}

export interface ToolSummary {
  /** The verb phrase for the summary line, for example "Composed a still for beat 6". */
  title: string;
  /** What came back, for example the recipe and cost of a proposal. */
  detail: string;
}

const TITLES: Record<string, (input: Dict, output: Dict) => string> = {
  get_project_state: () => "Read the project",
  save_brief: () => "Saved the brief",
  save_character_bible: (input, output) => `Saved the character${str(dict(output.character).id) && str(dict(dict(output.character).bible).name) ? ` ${str(dict(dict(output.character).bible).name)}` : ""}`,
  propose_candidates: (input) => `Proposed ${str(input.capability)?.replaceAll("_", " ") ?? "a generation"}`,
  select_reference: (input) => `Locked the ${str(input.slot) ?? "reference"}`,
  generate_face_candidates: () => "Proposed face candidates",
  generate_body_reference: () => "Proposed the body reference",
  generate_reference_sheet: () => "Proposed the reference sheet",
  save_product: (input, output) => `Saved the product${str(dict(output.product).name) ? ` ${str(dict(output.product).name)}` : ""}`,
  generate_product_images: () => "Proposed product photos",
  save_script: (input, output) => {
    const version = num(dict(output.script).version);
    const beats = Array.isArray(input.beats) ? input.beats.length : undefined;
    return `Saved the script${version ? ` (version ${version})` : ""}${beats ? `, ${beats} beats` : ""}`;
  },
  plan_shots: (input, output) => `Planned ${Array.isArray(output.shots) ? `${output.shots.length} shots` : "the shots"}`,
  compose_still: (input) => join([`Proposed a still`, beat(input)]).replace(" · ", " for "),
  refine_still: () => "Proposed a refined still",
  generate_clip: (input) => join([input.mode === "speech" ? "Proposed a lip-synced clip" : input.mode === "first_last" ? "Proposed a first-and-last clip" : "Proposed a clip", beat(input)]).replace(" · ", " for "),
  extract_voice_sample: () => "Took the voice sample from the clip",
  generate_voice_over: (input) => join(["Proposed a voice take", beat(input)]).replace(" · ", " for "),
  approve: (input) => join([`Approved the ${str(input.kind) ?? "candidate"}`, beat(input)]).replace(" · ", " for "),
  archive_asset: () => "Archived an asset",
  delete_asset_everywhere: () => "Deleted an asset everywhere",
  assemble_ad: (input, output) => `Assembled the ad${dict(output.export).status === "completed" ? "" : ` (${str(dict(output.export).status) ?? "rendering"})`}`,
  list_assets: (input, output) => `Listed ${Array.isArray(output.assets) ? `${output.assets.length} assets` : "assets"}`,
  list_recipes: (input, output) => `Listed ${Array.isArray(output.recipes) ? `${output.recipes.length} recipes` : "recipes"}`,
  link_library_item: () => "Linked a Library item",
  unlink_library_item: () => "Unlinked a Library item",
  archive_library_item: () => "Archived a Library item",
  create_set: (input) => `Created the set${str(input.name) ? ` ${str(input.name)}` : ""}`,
  set_cut_order: () => "Set the clip order",
  reset_shots: (input) => join(["Reset the shots", beat(input)]).replace(" · ", " from "),
};

/** Tools whose output is a proposal: the detail line names the recipe and the estimate. */
const PROPOSALS = new Set([
  "propose_candidates",
  "generate_face_candidates",
  "generate_body_reference",
  "generate_reference_sheet",
  "generate_product_images",
  "compose_still",
  "refine_still",
  "generate_clip",
  "generate_voice_over",
]);

export function toolLabel(name: string): string {
  return name.replaceAll("_", " ").replace(/^./, (first) => first.toUpperCase());
}

export function summarizeTool(name: string, input: unknown, output: unknown, status: "running" | "ok" | "error"): ToolSummary {
  const inputDict = dict(input);
  const outputDict = dict(output);
  const title = (TITLES[name] ?? (() => toolLabel(name)))(inputDict, outputDict);
  if (status === "running") return { title: `${toolLabel(name)}…`, detail: "" };
  if (status === "error") {
    const message = str(outputDict.message);
    return { title: `${toolLabel(name)} failed`, detail: message ?? "" };
  }
  if (PROPOSALS.has(name)) return { title, detail: proposal(outputDict) };
  return { title, detail: "" };
}
