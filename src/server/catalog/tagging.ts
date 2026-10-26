/**
 * Capability tagging for Router models from their published schemas, with a curated override table
 * for models the heuristics get wrong.
 * @packageDocumentation
 */
import { requestBodySchema, type Capability } from "@/lib/catalog";

export interface ModelTags {
  capabilities: Capability[];
  maxReferences?: number;
  inputs: string[];
  outputs: string[];
  imageFields: string[];
  /** True when the tags come from the override table rather than the heuristics. */
  curated: boolean;
  note?: string;
}

export interface CapabilityOverride {
  capabilities: Capability[];
  maxReferences?: number;
  note: string;
}

/** Models whose schema alone would be tagged wrongly, checked against their schemas on 2026-10-26. */
export const CAPABILITY_OVERRIDES: Record<string, CapabilityOverride> = {
  "vertexai/gemini-nano-banana-2.1": {
    capabilities: ["text_to_image", "image_edit"],
    maxReferences: 14,
    note: "Accepts video and answers with text too, but the useful output is a still.",
  },
  "ltx/ltx-2-5-fast": { capabilities: ["text_to_video"], note: "The Router schema takes a prompt only; there is no image input." },
  "ltx/ltx-2-5-pro": { capabilities: ["text_to_video"], note: "The Router schema takes a prompt only; there is no image input." },
  "wan/wan3.0-video": {
    capabilities: ["text_to_video", "image_to_video", "first_last_to_video", "references_to_video"],
    maxReferences: 10,
    note: "Frames and references travel in `input.media` with a `type` per item.",
  },
};

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Image-related field paths and enum values in the request body, following local `$ref`s. */
export function imageFields(document: unknown): { fields: string[]; maxReferences?: number } {
  const fields = new Set<string>();
  const seenRefs = new Set<string>();
  let maxReferences: number | undefined;
  const pattern = /image|reference|first_frame|last_frame|start_frame|end_frame|tail/i;
  function resolve(ref: string): unknown {
    let node: unknown = document;
    for (const segment of ref.slice(2).split("/")) node = isObject(node) ? node[segment] : undefined;
    return node;
  }
  function visit(node: unknown, path: string, depth: number): void {
    if (depth > 24 || fields.size > 100) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, path, depth + 1);
      return;
    }
    if (!isObject(node)) return;
    if (typeof node.$ref === "string" && node.$ref.startsWith("#/") && !seenRefs.has(node.$ref)) {
      seenRefs.add(node.$ref);
      visit(resolve(node.$ref), path, depth + 1);
    }
    for (const value of stringList(node.enum)) if (pattern.test(value)) fields.add(`${path}=${value}`);
    for (const [key, child] of Object.entries(node)) {
      if (key === "properties" && isObject(child)) {
        for (const [name, definition] of Object.entries(child)) {
          const next = path ? `${path}.${name}` : name;
          if (pattern.test(name)) {
            fields.add(next);
            if (isObject(definition) && typeof definition.maxItems === "number") maxReferences = Math.max(maxReferences ?? 0, definition.maxItems);
          }
          visit(definition, next, depth + 1);
        }
      } else if (!["description", "example", "examples", "default", "enum"].includes(key)) {
        visit(child, path, depth + 1);
      }
    }
  }
  visit(requestBodySchema(document), "", 0);
  return { fields: [...fields], maxReferences };
}

/** Tags one model. Overrides win; otherwise output and input modalities plus image field names decide. */
export function tagModel(id: string, document: unknown): ModelTags {
  const meta = isObject(document) ? document : {};
  const inputs = stringList(meta["x-comfy-router-input-modalities"]);
  const outputs = stringList(meta["x-comfy-router-output-modalities"]);
  const found = imageFields(document);
  const override = CAPABILITY_OVERRIDES[id];
  if (override) {
    return { capabilities: override.capabilities, maxReferences: override.maxReferences, inputs, outputs, imageFields: found.fields, curated: true, note: override.note };
  }
  const text = found.fields.join(" ").toLowerCase();
  const takesImages = inputs.includes("image") || found.fields.length > 0;
  const capabilities = new Set<Capability>();
  if (outputs.includes("video")) {
    if (inputs.includes("text")) capabilities.add("text_to_video");
    if (takesImages) capabilities.add("image_to_video");
    if (/(last_frame|end_frame|end_image|tail)/.test(text)) capabilities.add("first_last_to_video");
    if (/reference/.test(text)) capabilities.add("references_to_video");
  } else if (outputs.includes("image")) {
    if (inputs.includes("text")) capabilities.add("text_to_image");
    if (takesImages) capabilities.add("image_edit");
  } else if (outputs.includes("text") && inputs.includes("text")) {
    capabilities.add("text_generation");
  }
  return { capabilities: [...capabilities], maxReferences: found.maxReferences, inputs, outputs, imageFields: found.fields, curated: false };
}
