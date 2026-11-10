/**
 * UGC Ad, the first content type, as a plugin: an Ad made in the UGC Creator App (docs/PRODUCT.md),
 * the 13-step flow from brief to the next piece with the domain tools each step uses, the Quick Ad
 * mode (a two-line brief, one frame, one talking clip, the export: three approvals), and the six
 * workspace panels beside the chat.
 *
 * The declaration is data only. The panels' React components are registered on the client by the
 * app (`apps/creator/src/plugins/panels.tsx`), because they share the app's project context and
 * candidate cards; the step guidance the assistant reads lives with the agent
 * (`apps/creator/src/server/agent/state.ts`) and is checked against these steps by a test.
 * @packageDocumentation
 */
import { type StepInput, definePlugin } from "@creator-lab/core/registry";

export const UGC_AD_PLUGIN_ID = "ugc-ad";
export const UGC_AD_CONTENT_TYPE = "ad";
export const UGC_CREATOR_APP = { id: "ugc-creator", label: "UGC Creator" } as const;

/** Panel ids, in tab order. */
export const UGC_AD_PANELS = {
  documents: "ugc-ad.documents",
  script: "ugc-ad.script",
  shots: "ugc-ad.shots",
  assets: "ugc-ad.assets",
  export: "ugc-ad.export",
  quick: "ugc-ad.quick",
} as const;
export type UgcAdPanelId = (typeof UGC_AD_PANELS)[keyof typeof UGC_AD_PANELS];

type UgcAdStep = Omit<StepInput, "contentType" | "id" | "panel"> & { id: string; panel: UgcAdPanelId };

/**
 * The flow's steps in order. `number` is the step in docs/PRODUCT.md (1 and 2, connecting and
 * creating the project, happen outside a project); stills share step 10 with planning the shots.
 */
export const UGC_AD_STEPS = [
  { id: "brief", number: 3, title: "Brief", tools: ["save_brief"], panel: UGC_AD_PANELS.documents },
  { id: "quick", number: 3, title: "Quick Ad brief", tools: ["start_quick_ad"], panel: UGC_AD_PANELS.quick },
  { id: "character", number: 4, title: "Character", tools: ["save_character_bible", "link_library_item"], panel: UGC_AD_PANELS.documents },
  { id: "face", number: 5, title: "Face lock", tools: ["generate_face_candidates", "select_reference"], panel: UGC_AD_PANELS.assets },
  { id: "body", number: 6, title: "Body reference", tools: ["generate_body_reference", "select_reference"], panel: UGC_AD_PANELS.assets },
  { id: "sheet", number: 7, title: "Reference sheet", tools: ["generate_reference_sheet", "approve"], panel: UGC_AD_PANELS.assets },
  { id: "product", number: 8, title: "Product", tools: ["save_product", "generate_product_images", "approve"], panel: UGC_AD_PANELS.documents },
  { id: "script", number: 9, title: "Script", tools: ["save_script"], panel: UGC_AD_PANELS.script },
  { id: "shots", number: 10, title: "Shots", tools: ["plan_shots", "reset_shots"], panel: UGC_AD_PANELS.shots },
  { id: "stills", number: 10, title: "Shots", tools: ["compose_still", "refine_still", "approve"], panel: UGC_AD_PANELS.shots },
  { id: "clips", number: 11, title: "Clips", tools: ["generate_clip", "approve"], panel: UGC_AD_PANELS.shots },
  { id: "voice", number: 12, title: "Voice-overs", tools: ["extract_voice_sample", "generate_voice_over", "approve"], panel: UGC_AD_PANELS.shots },
  { id: "assemble", number: 13, title: "Assemble", tools: ["set_cut_order", "assemble_ad"], panel: UGC_AD_PANELS.export },
  { id: "next", number: 14, title: "Next piece", tools: [], panel: UGC_AD_PANELS.export },
] as const satisfies readonly UgcAdStep[];

/** The step ids the creative director moves through (`nextStage`). */
export type UgcAdStepId = (typeof UGC_AD_STEPS)[number]["id"];

/**
 * The Quick Ad, a mode of the Ad (v0.2 F11): the same Ad, shots, and export with three approvals
 * (the frame, the clip, the export). Its id is the Ad's `mode` (`quick`).
 */
export const QUICK_AD_MODE = {
  id: "quick",
  label: "Quick Ad",
  description: "Two lines about what you sell and who it's for, one composed frame, one talking clip, and the export. Three approvals.",
  panel: UGC_AD_PANELS.quick,
  steps: ["quick", "stills", "clips", "assemble"],
} as const satisfies { id: string; label: string; description: string; panel: UgcAdPanelId; steps: readonly UgcAdStepId[] };

export const ugcAdPlugin = definePlugin({
  id: UGC_AD_PLUGIN_ID,
  label: "UGC Ad",
  contentTypes: [
    {
      id: UGC_AD_CONTENT_TYPE,
      label: "Ad",
      app: UGC_CREATOR_APP,
      description: "A 15 to 30 second vertical ad (1080 x 1920) built around one AI creator character and one product.",
      pieceType: "ad",
      defaultPanel: UGC_AD_PANELS.documents,
      modes: [{ ...QUICK_AD_MODE, steps: [...QUICK_AD_MODE.steps] }],
    },
  ],
  steps: UGC_AD_STEPS.map((step) => ({ ...step, tools: [...step.tools], contentType: UGC_AD_CONTENT_TYPE })),
  panels: [
    { id: UGC_AD_PANELS.documents, contentType: UGC_AD_CONTENT_TYPE, title: "Documents", order: 10 },
    { id: UGC_AD_PANELS.script, contentType: UGC_AD_CONTENT_TYPE, title: "Script", order: 20 },
    { id: UGC_AD_PANELS.shots, contentType: UGC_AD_CONTENT_TYPE, title: "Shots", order: 30 },
    { id: UGC_AD_PANELS.assets, contentType: UGC_AD_CONTENT_TYPE, title: "Assets", order: 40 },
    { id: UGC_AD_PANELS.export, contentType: UGC_AD_CONTENT_TYPE, title: "Export", order: 50 },
    { id: UGC_AD_PANELS.quick, contentType: UGC_AD_CONTENT_TYPE, title: "Quick Ad", order: 60 },
  ],
});
