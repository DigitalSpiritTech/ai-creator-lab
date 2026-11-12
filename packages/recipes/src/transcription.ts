/**
 * Transcription (`speech_to_text`): a take's words with start and end times, which a
 * take-then-cutaways Ad aligns its beats to. Two recipes are planned, Whisper on Comfy Router and
 * open-weights Whisper on Comfy Cloud. Neither can run yet, and neither is guessed at: the
 * repository has no cached Router schema for a Whisper model and records no Cloud node that
 * transcribes with word timestamps. Until one is written and verified, transcription runs on the
 * mock (`mock-speech-to-text`, `MOCK_RECIPES=1`), which tests and the acceptance smoke use.
 * @packageDocumentation
 */
import { type PlannedRecipe, PlannedRecipeSchema } from "@creator-lab/core/catalog";

export const ROUTER_WHISPER_ID = "router-whisper-transcribe";
export const CLOUD_WHISPER_ID = "whisper-transcribe-cloud";

export const PLANNED_TRANSCRIPTION_RECIPES: readonly PlannedRecipe[] = [
  PlannedRecipeSchema.parse({
    id: ROUTER_WHISPER_ID,
    title: "Whisper on Comfy Router",
    capability: "speech_to_text",
    kind: "router",
    openWeights: false,
    verified: null,
    costHint: "Not measured. Hosted Whisper is priced per minute of audio; a 30 s recording should cost well under a credit.",
    ceilingUsd: 0.05,
    candidate: "openai/whisper-1 (word timestamps need verbose_json with word granularity)",
    pending:
      "No Whisper model is in the Router catalog the repository recorded on 2026-10-26, and no Router schema for one is cached, so no request body is written. To finish: find the model in the live catalog (Settings, Router models), save its input schema under tests/fixtures/router/, give the Router field map an audio input (the executor sends images only today) and a parser for word timestamps, then one maintainer run logged in docs/VERIFICATION.md.",
  }),
  PlannedRecipeSchema.parse({
    id: CLOUD_WHISPER_ID,
    title: "Whisper (open weights) on Comfy Cloud",
    capability: "speech_to_text",
    kind: "workflow",
    openWeights: true,
    verified: null,
    costHint: "Not measured. Expected a few credits for a 30 s recording on Whisper large-v3.",
    ceilingUsd: 0.05,
    candidate: "a Whisper large-v3 transcription node with word timestamps, to be chosen from Cloud's object_info",
    pending:
      "The node choice is pending verification: the repository records no Comfy Cloud node that transcribes with word timestamps. To finish: confirm a node in Cloud's object_info (the backend probe lists missing node classes), write the API-format workflow and its slot sidecar (the recording on a LoadAudio audio slot, the script as the vocabulary prompt), let the workflow executor retrieve a text output, then one maintainer run logged in docs/VERIFICATION.md.",
  }),
];

/** A planned recipe by id, for a refusal that says what is pending. */
export function plannedRecipe(id: string): PlannedRecipe | undefined {
  return PLANNED_TRANSCRIPTION_RECIPES.find((recipe) => recipe.id === id);
}
