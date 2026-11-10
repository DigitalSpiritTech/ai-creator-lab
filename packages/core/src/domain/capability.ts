import { z } from "zod";

/** What a generation step needs. Recipes declare one capability; steps ask for one. */
export const CapabilitySchema = z.enum([
  "text_to_image",
  "image_edit",
  "image_to_video",
  "first_last_to_video",
  "text_to_video",
  "references_to_video",
  /** A still plus a speech recording: the clip's mouth and gestures follow the audio. */
  "speech_to_video",
  "text_to_speech",
  "text_generation",
]);
export type Capability = z.infer<typeof CapabilitySchema>;
