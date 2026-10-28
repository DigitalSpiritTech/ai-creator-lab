/**
 * The tools the assistant is offered: the A4 roster with descriptions written for the model (what
 * the tool does, when to call it, one short example). Names and input schemas come unchanged from
 * the registry; internal tools such as `submit_proposal` are never offered.
 * @packageDocumentation
 */
import type { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/messages";
import { TOOLS, toolsToJsonSchema } from "@/server/tools";

const PROPOSAL_NOTE = "Returns a proposal (recipe, prompt, references, count, estimated cost); nothing is generated until the user approves it on the card.";

/** Model-facing descriptions, keyed by tool name. Every roster tool has one. */
export const AGENT_TOOL_DESCRIPTIONS: Record<string, string> = {
  get_project_state: [
    "Read the whole project: brief, linked character with this project's wardrobe and sheet, product card, scripts, the ad's shots, active assets, and running jobs.",
    "The system prompt already carries a summary; call this when you need exact ids or details it leaves out.",
    'Example: the user says "use the second one" and you need the candidate asset ids.',
  ].join(" "),
  save_brief: [
    "Save the project brief: productSummary (what is sold), audience (who buys it), platforms (where it runs), tone. Replaces the previous brief.",
    "Use the user's own words. Call as soon as you have all four, offering defaults for any the user skipped.",
    'Example: "Ridgeline bottle for commuters on TikTok, warm" gives all four fields.',
  ].join(" "),
  save_character_bible: [
    "Create a Library character from a bible, or revise one (pass characterId and its revision). visualCore is one dense sentence under 60 words that starts every image prompt.",
    "With projectId the character is linked to this project; with wardrobe, that outfit is recorded for the project's reference sheet.",
    "To reuse a Library character in this project, pass its characterId, projectId, and its bible copied exactly; never change identity fields unless the user asked.",
    'Example: after the user confirms the bible draft, save it with projectId and the wardrobe they picked.',
  ].join(" "),
  propose_candidates: [
    `Propose a generation from your own prompt. ${PROPOSAL_NOTE}`,
    "Use it for the face lock (text_to_image, count 4, target character_reference face, the face prompt from the stage guidance) and the body reference (image_edit, the locked face as the only referenceAssetIds entry, target character_reference body).",
    'Example: the bible is saved and the face is not locked, so propose four face candidates.',
  ].join(" "),
  select_reference: [
    "Lock a character's face or body reference to the candidate the user picked, bump the bible version, and archive the other candidates for that slot. The face must be locked before the body. Slot voice sets the uploaded recording voice-overs are cloned from (archiveSiblings false).",
    'Example: the user says "the second face, that\'s her", so pass slot face and that asset id.',
  ].join(" "),
  generate_face_candidates: [
    `Propose the face lock for a linked character from its bible with the standard face prompt (count 4 by default). ${PROPOSAL_NOTE}`,
    "Prefer it over propose_candidates for the face lock; the prompt and target are built for you.",
    "Example: the bible is saved and no face is locked, so call it with the projectId and characterId.",
  ].join(" "),
  generate_body_reference: [
    `Propose full-body candidates for a linked character from its locked face with the standard athleticwear prompt (count 2 by default). ${PROPOSAL_NOTE}`,
    "Prefer it over propose_candidates for the body reference; the prompt, reference, and target are built for you.",
    "Example: the face is locked and no body is, so call it with the projectId and characterId.",
  ].join(" "),
  generate_reference_sheet: [
    `Propose this project's character reference sheet from the locked face and body in the project's wardrobe (pass wardrobe to record it first). ${PROPOSAL_NOTE}`,
    'Example: face and body are locked and the user chose "olive utility jacket over a white tee".',
  ].join(" "),
  generate_product_images: [
    `Propose product photo candidates for a linked product from its appearance line, never its name (count 2 by default; an optional setting says where it stands). ${PROPOSAL_NOTE}`,
    "The user approves one on the product card in the workspace, which adds it to the card's images.",
    'Example: the card has "dark green steel bottle, black cap" as appearance and no photo, so call it with the projectId and productId.',
  ].join(" "),
  save_product: [
    "Create or update (pass productId) the Library product card: name, appearance, link, allowedClaims, imageAssetIds. With projectId it is linked to this project. Only claims saved here may appear in a script.",
    "Always fill appearance (shape, color, material, cap or lid, size cues, no brand text) from what the user said, or ask them one question for it first: stills and clips describe the product by appearance only, never by name.",
    "Save claims in the user's words; never add one they did not give.",
    'Example: "keeps drinks cold 24 hours, fits a cup holder, dishwasher safe" becomes three allowedClaims, and "dark green steel bottle, black cap" becomes the appearance.',
  ].join(" "),
  save_script: [
    "Save a 15 to 30 second script as ordered beats (talking, broll, textcard), or a new version (pass scriptId and baseVersion). Every beat carries the creator's line in spokenLine: said on camera on a talking beat, read as a voice-over on b-roll and text cards. A line holds at most 3 words per second of the beat (2.5 is a natural pace); on-screen text is at most two lines of six words.",
    "Editing a beat's visual withdraws that beat's approved still and clip; editing a talking beat's line or any beat's length withdraws its clip; editing any line withdraws that beat's voice-over.",
    'Example: the user approves the beat outline, so save it; when they change beat 3\'s line, save a new version.',
  ].join(" "),
  plan_shots: [
    "Create the Ad for a script (one shot per beat), or with contentId bring an existing Ad up to the script's newest version, keeping approvals for unchanged beats.",
    "Example: right after the first script is saved, or after a script revision.",
  ].join(" "),
  compose_still: [
    `Propose start-frame candidates for one beat; the tool writes the prompt from the sheet (or face and body), the product photo, and the beat. ${PROPOSAL_NOTE}`,
    "Example: the Ad exists and beat 1 has no approved still.",
  ].join(" "),
  refine_still: [
    `Propose a text-guided edit of one image that is close but not right; the result lands with the original. ${PROPOSAL_NOTE}`,
    'Example: "the bottle label is blurry" on a still the user otherwise likes.',
  ].join(" "),
  generate_clip: [
    `Propose a clip for one beat from its approved still, at the beat's length; talking beats carry the spoken line for synchronized audio, b-roll is ambient sound only (its voice-over is a separate step). ${PROPOSAL_NOTE}`,
    "Example: beat 2's still was just approved.",
  ].join(" "),
  extract_voice_sample: [
    "Set the character's voice sample, which every voice-over is cloned from: the audio of the first approved talking clip (or of clipAssetId). generate_voice_over does this on its own when no sample is set, so call it only when the user wants a different clip's voice. An uploaded recording is set with select_reference, slot voice.",
    'Example: "use the voice from beat 3\'s clip instead".',
  ].join(" "),
  generate_voice_over: [
    `Propose the voice-over for one b-roll or text card beat: its line read in the creator's cloned voice. One take by default. The approved take is mixed over the clip's ambient sound at export. ${PROPOSAL_NOTE}`,
    "Call it once per beat that has a line and is not a talking beat, after a talking clip is approved (its voice is the sample) or the user uploaded a recording.",
    "Example: beat 1's talking clip is approved and beat 2 is b-roll with a line.",
  ].join(" "),
  approve: [
    "Approve one candidate: a beat's still, a beat's clip (needs an approved still), a beat's voice-over take, or this project's reference sheet. The other candidates are archived. Only when the user chose that candidate.",
    'Example: "approve the first sheet" gives kind sheet, the asset id, projectId, and characterId.',
  ].join(" "),
  archive_asset: [
    "Move an asset to the Archive (restorable) with a short reason, or restore it with restore true. Approved references cannot be archived.",
    'Example: the user rejects all four face candidates, so archive each with reason "rejected: too formal".',
  ].join(" "),
  delete_asset_everywhere: [
    "Permanently delete a file and break every reference to it. Only after the user typed an explicit confirmation in this conversation; never as a cleanup step. Prefer archive_asset.",
    'Example: the user says "yes, delete it everywhere" after you listed what breaks.',
  ].join(" "),
  assemble_ad: [
    "Join the approved clips in order into the final 1080 x 1920 MP4 with the on-screen text burned in (captions false to skip, mute true to drop audio) and approved voice-overs mixed over their clips, and save it as an export. Every beat needs an approved clip first; a beat with a line and no approved voice-over exports with ambient sound only.",
    "Example: all clips are approved and the user asks for the final ad.",
  ].join(" "),
  list_assets: ["List assets, newest first, filtered by project, kind, state, or recipe.", 'Example: the user asks "what did I archive?"'].join(" "),
  list_recipes: [
    "List recipes for a capability with verified, open-weights, cost hint, and whether they can run now.",
    'Example: the user asks for a cheaper or open-weights way to make the stills.',
  ].join(" "),
  link_library_item: [
    "Attach an existing Library character, product, or set to this project without changing it (the bible version stays the same). Use it to reuse a character from an earlier project; its face and body then work as references here.",
    'Example: the user says "use Avery again for this launch", so link Avery\'s itemId to this project.',
  ].join(" "),
  unlink_library_item: [
    "Detach a Library item from this project; the item stays in the Library. Refused while an approved still or clip was made from its images.",
    'Example: the user picked the wrong product for this project and nothing is approved with it yet.',
  ].join(" "),
  archive_library_item: [
    "Archive a Library character, product, or set so it is hidden from new selections, or restore it with restore true. Its assets and links are kept.",
    'Example: the user retires an old product and wants it out of the list.',
  ].join(" "),
  create_set: [
    "Create a Library set (a location) with a name, notes, and reference image asset ids; with projectId it is linked here. Beats whose setting names the set get its image as a location reference in stills.",
    'Example: the user uploads a photo of their kitchen and calls it "bright kitchen counter".',
  ].join(" "),
  set_cut_order: [
    "Set the order the approved clips play in the export: pass every shot id of the ad exactly once. assemble_ad uses this order.",
    'Example: the user wants the product reveal before the problem beat.',
  ].join(" "),
  reset_shots: [
    "Regenerate from here: withdraw the approved still and clip of beat fromBeatIndex and every later beat (candidates stay); then compose new stills for the first one.",
    'Example: the user says "redo everything from beat 3", so reset from beat 3 and propose its stills.',
  ].join(" "),
};

/** The `tools` array for the assistant: the roster, with model-facing descriptions. */
export function agentTools(): AnthropicTool[] {
  return toolsToJsonSchema(TOOLS).map((tool) => ({ ...tool, description: AGENT_TOOL_DESCRIPTIONS[tool.name] ?? tool.description }));
}

/** Names the assistant may call; anything else is refused without running. */
export function agentToolNames(): Set<string> {
  return new Set(TOOLS.map((tool) => tool.name));
}
