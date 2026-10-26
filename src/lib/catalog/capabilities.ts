/**
 * Capabilities: what a creative step needs, independent of which model fulfills it.
 * @packageDocumentation
 */
import { z } from "zod";
import type { Capability } from "@/lib/domain/capability";

export { CapabilitySchema, type Capability } from "@/lib/domain/capability";

/** Capabilities the MVP flow uses; every one needs at least one verified recipe. */
export const MVP_CAPABILITIES: readonly Capability[] = ["text_to_image", "image_edit", "image_to_video"];

export type OutputMedia = "image" | "video" | "text";

/** The kind of file a capability produces. */
export function capabilityMedia(capability: Capability): OutputMedia {
  if (capability === "text_to_image" || capability === "image_edit") return "image";
  if (capability === "text_generation") return "text";
  return "video";
}

export const AspectRatioSchema = z.enum(["9:16", "16:9", "1:1", "4:5", "3:4", "4:3", "2:3", "3:2", "21:9"]);
export type AspectRatio = z.infer<typeof AspectRatioSchema>;

/** Width divided by height for a ratio such as "9:16". */
export function ratioValue(ratio: AspectRatio): number {
  const [width, height] = ratio.split(":").map(Number);
  return width / height;
}
