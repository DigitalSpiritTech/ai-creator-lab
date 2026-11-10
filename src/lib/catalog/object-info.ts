/**
 * What a workflow graph needs from a ComfyUI backend (node classes and model files) and how that
 * compares with the backend's `object_info`. Pure: the probe that fetches `object_info` lives in
 * `src/server/catalog/backend-probe.ts`.
 * @packageDocumentation
 */
import { z } from "zod";
import type { WorkflowGraph } from "@/lib/catalog/slots";

/**
 * The slice of a ComfyUI `object_info` entry the comparison reads. Each node class lists its inputs;
 * a loader's file input (`unet_name`, `ckpt_name`, `lora_name`, ...) is a combo whose options are the
 * model files that backend has.
 */
export const ObjectInfoEntrySchema = z
  .object({
    input: z
      .object({
        required: z.record(z.string(), z.unknown()).optional(),
        optional: z.record(z.string(), z.unknown()).optional(),
      })
      .passthrough()
      .optional(),
    /** Partner (API) nodes are flagged; they bill the Comfy account the key belongs to. */
    api_node: z.boolean().optional(),
  })
  .passthrough();
export const ObjectInfoSchema = z.record(z.string(), ObjectInfoEntrySchema);
export type ObjectInfo = z.infer<typeof ObjectInfoSchema>;

/** File names a graph passes to a loader input; anything with a model file extension counts. */
export const MODEL_FILE_PATTERN = /\.(safetensors|sft|gguf|pt|pth|bin|ckpt|onnx)$/i;

export interface ModelRequirement {
  node: string;
  classType: string;
  input: string;
  file: string;
}

export interface GraphRequirements {
  /** Every node class the graph uses, sorted. */
  nodes: string[];
  /** Every model file the graph names, with the node input that loads it. */
  models: ModelRequirement[];
}

/** The node classes and model files a workflow graph needs, in a stable order. */
export function graphRequirements(graph: WorkflowGraph): GraphRequirements {
  const nodes = new Set<string>();
  const models: ModelRequirement[] = [];
  for (const [node, entry] of Object.entries(graph)) {
    nodes.add(entry.class_type);
    for (const [input, value] of Object.entries(entry.inputs)) {
      if (typeof value === "string" && MODEL_FILE_PATTERN.test(value)) models.push({ node, classType: entry.class_type, input, file: value });
    }
  }
  models.sort((a, b) => a.file.localeCompare(b.file) || a.node.localeCompare(b.node, undefined, { numeric: true }));
  return { nodes: [...nodes].sort(), models };
}

/**
 * A combo input's options: the legacy `[["a", "b"], {...}]` shape and the newer
 * `["COMBO", { options: ["a", "b"] }]` shape both appear in `object_info`.
 */
export function comboOptions(spec: unknown): string[] | undefined {
  if (!Array.isArray(spec)) return undefined;
  if (Array.isArray(spec[0])) return spec[0].filter((value): value is string => typeof value === "string");
  const options = (spec[1] as { options?: unknown } | undefined)?.options;
  return Array.isArray(options) ? options.filter((value): value is string => typeof value === "string") : undefined;
}

export interface MissingRequirements {
  /** Node classes the backend does not have, sorted. */
  nodes: string[];
  /** Model files a loader on the backend does not list, sorted and unique. */
  models: string[];
  /** Partner (API) node classes the graph uses on this backend, sorted. */
  partnerNodes: string[];
}

/**
 * Compares a graph's needs with a backend's `object_info`. A missing node class is reported by name;
 * a model file is missing when the loader exists and its combo options do not include the file. A
 * loader input that is not a combo (some custom loaders take free text) cannot be checked and is not
 * reported. Models of a node class that is itself missing are not listed separately.
 */
export function compareRequirements(requirements: GraphRequirements, info: ObjectInfo): MissingRequirements {
  const nodes = requirements.nodes.filter((name) => !info[name]);
  const partnerNodes = requirements.nodes.filter((name) => info[name]?.api_node === true);
  const models = new Set<string>();
  for (const model of requirements.models) {
    const entry = info[model.classType];
    if (!entry) continue;
    const options = comboOptions(entry.input?.required?.[model.input] ?? entry.input?.optional?.[model.input]);
    if (options && !options.includes(model.file)) models.add(model.file);
  }
  return { nodes, models: [...models].sort(), partnerNodes };
}
