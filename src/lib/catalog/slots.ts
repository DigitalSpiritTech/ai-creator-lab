/**
 * Slot sidecars: the map from semantic inputs (prompt, images, size, length, seed) to node inputs
 * of an API-format ComfyUI workflow, plus pure helpers to validate and apply them.
 * @packageDocumentation
 */
import { z } from "zod";
import { CapabilitySchema } from "@/lib/catalog/capabilities";

export const SlotBindingSchema = z
  .object({
    node: z.string().min(1).max(64),
    input: z.string().min(1).max(128),
    kind: z.enum(["text", "number", "image"]).optional(),
  })
  .strict();
export type SlotBinding = z.infer<typeof SlotBindingSchema>;

export const SlotSchema = z.union([SlotBindingSchema, z.array(SlotBindingSchema).min(1).max(8)]);
export type Slot = z.infer<typeof SlotSchema>;

export const SlotLimitsSchema = z
  .object({
    sizes: z.array(z.tuple([z.number().int().positive(), z.number().int().positive()])).optional(),
    multipleOf: z.number().int().positive().optional(),
    aspectRatios: z.array(z.string()).optional(),
    length: z.object({ default: z.number().int().positive(), rule: z.string().optional() }).optional(),
    fps: z.number().positive().optional(),
    megapixelsPerReference: z.number().positive().optional(),
  })
  .passthrough();
export type SlotLimits = z.infer<typeof SlotLimitsSchema>;

export const SlotSidecarSchema = z.object({
  workflow: z.string().regex(/^[\w.-]+\.api\.json$/),
  capability: CapabilitySchema,
  openWeights: z.boolean().default(true),
  maxReferences: z.number().int().positive().optional(),
  outputNode: z.string().min(1),
  slots: z.record(z.string().regex(/^[A-Za-z][\w]*$/), SlotSchema),
  limits: SlotLimitsSchema.default({}),
  notes: z.string().optional(),
});
export type SlotSidecar = z.infer<typeof SlotSidecarSchema>;

/** API-format graph: node id to `{ class_type, inputs }`. */
export const WorkflowGraphSchema = z.record(
  z.string(),
  z.object({ class_type: z.string(), inputs: z.record(z.string(), z.unknown()) }).passthrough(),
);
export type WorkflowGraph = z.infer<typeof WorkflowGraphSchema>;

export type SlotValue = string | number | boolean | object;

/** The minimal surface `applySlots` writes to; the SDK `Workflow` satisfies it. */
export interface SlotTarget {
  setInput(nodeId: string, field: string, value: unknown): void;
}

/** Every binding of a slot, whether the sidecar wrote one or a list. */
export function slotBindings(slot: Slot): SlotBinding[] {
  return Array.isArray(slot) ? slot : [slot];
}

/** Names of the image slots in declaration order, for example `["image1", "image2"]`. */
export function imageSlotNames(sidecar: SlotSidecar): string[] {
  return Object.entries(sidecar.slots)
    .filter(([, slot]) => slotBindings(slot).some((binding) => binding.kind === "image"))
    .map(([name]) => name);
}

/**
 * Checks that every slot names a node and input that exist in the graph and that the output node exists.
 * Returns human-readable problems; an empty list means the sidecar matches.
 */
export function sidecarProblems(sidecar: SlotSidecar, graph: WorkflowGraph): string[] {
  const problems: string[] = [];
  if (!graph[sidecar.outputNode]) problems.push(`Output node ${sidecar.outputNode} is missing.`);
  for (const [name, slot] of Object.entries(sidecar.slots)) {
    for (const binding of slotBindings(slot)) {
      const node = graph[binding.node];
      if (!node) {
        problems.push(`Slot ${name}: node ${binding.node} is missing.`);
      } else if (!(binding.input in node.inputs)) {
        problems.push(`Slot ${name}: node ${binding.node} has no input ${binding.input}.`);
      } else if (binding.kind === "image" && node.class_type !== "LoadImage") {
        problems.push(`Slot ${name}: image slots must bind a LoadImage node, not ${node.class_type}.`);
      }
    }
  }
  return problems;
}

/** Reads the value a slot currently holds in the graph (its first binding), for defaults such as width. */
export function slotDefault(sidecar: SlotSidecar, graph: WorkflowGraph, name: string): unknown {
  const slot = sidecar.slots[name];
  if (!slot) return undefined;
  const [first] = slotBindings(slot);
  return graph[first.node]?.inputs[first.input];
}

/**
 * Writes slot values into a workflow. Unknown slot names are rejected so a typo never silently drops an input.
 * Image values are expected to be already resolved to asset handles by the caller.
 */
export function applySlots(target: SlotTarget, sidecar: SlotSidecar, values: Record<string, SlotValue | undefined>): void {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) continue;
    const slot = sidecar.slots[name];
    if (!slot) throw new Error(`The workflow has no slot named ${name}.`);
    for (const binding of slotBindings(slot)) {
      if (binding.kind !== "image" && typeof value === "object") throw new Error(`Slot ${name} takes a plain value.`);
      target.setInput(binding.node, binding.input, value);
    }
  }
}

/** Snaps a frame count to LTX's 8n+1 rule. */
export function snapLength(frames: number, rule?: string): number {
  if (rule !== "8n+1") return Math.max(1, Math.round(frames));
  return Math.max(1, Math.round((frames - 1) / 8) * 8 + 1);
}
