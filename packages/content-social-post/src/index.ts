/**
 * Social Post (PRD F13) as a plugin: stills plus copy, in several aspect ratios, no video, made in
 * the Social Post App. It reuses the Library (linked characters and products are the stills'
 * references), the brief and the document history (the copy is a versioned document, with the
 * artifact panel's list and restore), and the generic generation path (its stills are proposals
 * the chat gate submits, approved with `approve` kind `slot`).
 *
 * This entry is data only, because it reaches the browser. The tools and the assistant are in
 * `./server`, the panels in `./panels`, and the copy contract in `./copy`.
 * @packageDocumentation
 */
import { type StepInput, definePlugin } from "@creator-lab/core/registry";

export const SOCIAL_POST_PLUGIN_ID = "social-post";
export const SOCIAL_POST_CONTENT_TYPE = "social-post";
/** The content piece `type` stored for a post. */
export const SOCIAL_POST_PIECE_TYPE = "social-post";
export const SOCIAL_POST_APP = { id: "social-post", label: "Social Post" } as const;

/** Panel ids, in tab order. */
export const SOCIAL_POST_PANELS = {
  post: "social-post.post",
  stills: "social-post.stills",
  export: "social-post.export",
} as const;

/** The plugin's own tools (the rest of each step is the core roster). */
export const SOCIAL_POST_TOOLS = {
  saveCopy: "social_post_save_copy",
  proposeStill: "social_post_propose_still",
  export: "social_post_export",
} as const;

type SocialPostStep = Omit<StepInput, "contentType"> & { panel: (typeof SOCIAL_POST_PANELS)[keyof typeof SOCIAL_POST_PANELS] };

/** The flow: brief, Library, copy, stills per aspect ratio, export. */
export const SOCIAL_POST_STEPS = [
  { id: "brief", number: 1, title: "Brief", tools: ["save_brief"], panel: SOCIAL_POST_PANELS.post },
  { id: "library", number: 2, title: "Library", tools: ["link_library_item", "save_product", "save_character_bible"], panel: SOCIAL_POST_PANELS.post },
  { id: "copy", number: 3, title: "Copy", tools: [SOCIAL_POST_TOOLS.saveCopy, "list_document_versions", "restore_document_version"], panel: SOCIAL_POST_PANELS.post },
  { id: "stills", number: 4, title: "Stills", tools: [SOCIAL_POST_TOOLS.proposeStill, "refine_still", "approve"], panel: SOCIAL_POST_PANELS.stills },
  { id: "export", number: 5, title: "Export", tools: [SOCIAL_POST_TOOLS.export], panel: SOCIAL_POST_PANELS.export },
] as const satisfies readonly SocialPostStep[];
export type SocialPostStepId = (typeof SOCIAL_POST_STEPS)[number]["id"];

export const socialPostPlugin = definePlugin({
  id: SOCIAL_POST_PLUGIN_ID,
  label: "Social Post",
  contentTypes: [
    {
      id: SOCIAL_POST_CONTENT_TYPE,
      label: "Social post",
      app: SOCIAL_POST_APP,
      description: "A feed post: stills in 1:1, 4:5, 9:16, and 16:9 plus the caption, hashtags, and call to action. No video.",
      pieceType: SOCIAL_POST_PIECE_TYPE,
      defaultPanel: SOCIAL_POST_PANELS.post,
    },
  ],
  steps: SOCIAL_POST_STEPS.map((step) => ({ ...step, tools: [...step.tools], contentType: SOCIAL_POST_CONTENT_TYPE })),
  panels: [
    { id: SOCIAL_POST_PANELS.post, contentType: SOCIAL_POST_CONTENT_TYPE, title: "Post", order: 10 },
    { id: SOCIAL_POST_PANELS.stills, contentType: SOCIAL_POST_CONTENT_TYPE, title: "Stills", order: 20 },
    { id: SOCIAL_POST_PANELS.export, contentType: SOCIAL_POST_CONTENT_TYPE, title: "Export", order: 30 },
  ],
});
