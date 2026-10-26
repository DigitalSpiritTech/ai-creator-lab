# AI Creator Lab: product description

Working name. Rename freely; nothing in the code should depend on it.

## One paragraph

AI Creator Lab is an open-source studio for creators who make short vertical content around a single product. It runs on your own computer or server and generates on your own Comfy account (Comfy Cloud, Comfy API, or Comfy Router), so there is no middleman and no per-seat platform fee. A built-in assistant walks you from "here is what I'm selling" to a locked AI creator character, a script, the shots, and a finished 1080 x 1920 ad. Everything you approve is kept in a Library you can reuse in the next piece of content.

## Vocabulary

- Workspace: everything on this install. Single user for now.
- App: a guided way of working. The first App is UGC Creator. A Microdrama App comes later.
- Project: one effort created from an App, for example "Bottle launch, October". A project holds its own assets, scripts, and content pieces, and links to Library items.
- Library: named, approved things you reuse across projects. Three types for now: Character (bible plus face and body references), Product (name, link, claims, images), Set (a location with reference images). Library replaces what other tools call elements or canon.
- Assets: every generated or uploaded file, with where it came from. Filter by type, project, recipe, or approval.
- Archive: assets you rejected or retired. Restorable. "Delete everywhere" is a separate, confirmed action that removes the file and breaks every reference to it.
- Content piece: the thing you are making inside a project. The first type is Ad. Post comes later.
- Reference sheet: a single landscape image, made per project from a Library character's face and body references, showing a dominant portrait plus full-body front and back views in that project's wardrobe on a neutral grey background. Once approved it is the one character reference every still in the project uses, and the reference that video models with a reference mode will read later.
- Script: the plan for a content piece, saved and versioned as an asset. Beats are talking, b-roll, or text card.
- Shot: one beat's production: candidate stills, an approved still, candidate clips, an approved clip.
- Recipe: a concrete way to fulfill a capability, either a hosted model or a workflow with a slot map.
- Capability: what a step needs: text to image, image edit with references, image to video, first and last frame to video, and more later.

## Navigation

Left rail: Projects, Assets, Library, Archive, Settings. Inside a project: Chat (left), Workspace (right) with tabs for Script, Shots, Assets, and Export.

Settings: Comfy API key, Anthropic API key, generation allowance in USD, default recipe per capability, data directory, theme.

## The UGC Creator flow as the user experiences it

1. Connect. Paste a Comfy API key and an Anthropic key. The app checks both and shows the Comfy plan and credit balance. Set an allowance.
2. New project from UGC Creator. Name it. The chat opens.
3. Brief. The assistant asks what you are selling, who buys it, where it will run, and the tone. It saves a brief card you can edit.
4. Character. The assistant builds a character bible with you: name, age range, look, wardrobe defaults, voice, backstory, boundaries. If you already have a Character in the Library, you pick it and skip ahead.
5. Face lock. The assistant proposes four 3/4-view headshots. You pick one and name the character. The rest go to Archive. This image becomes the identity reference for everything after.
6. Body reference. From the locked face, the assistant proposes 3/4 full-body references in neutral athleticwear. You approve one. Wardrobe changes later start from this.
7. Reference sheet. For this project, the assistant picks a wardrobe from the bible (or you name one) and generates a character reference sheet from the approved face and body: a large portrait, full-body front, and full-body back, same identity in every panel, neutral grey background. You inspect it at full size against a short checklist and approve it. It becomes the single character reference for every still in this project.
8. Product. Upload product photos, paste the link, list the claims you are allowed to make. Saved as a Product in the Library.
9. Script. The assistant writes a 15 to 30 second script with a hook, problem, reveal, proof, and CTA. Beats alternate talking and b-roll. Each beat has a spoken line, on-screen text, a visual, and a length. You edit in place; the script is versioned.
10. Shots. For each beat the assistant composes a start frame from the reference sheet, the product, and the setting. You approve one per beat. Refine with a text instruction when a frame is close but not right.
11. Clips. Each approved frame becomes a five-second LTX clip with synchronized audio; talking beats carry the spoken line. You approve one clip per beat.
12. Assemble. The app joins approved clips in script order into a 1080 x 1920 MP4 with the on-screen text burned in. Download it. The ad is saved as an asset with its full source record.
13. Next piece. Start another ad in the same project, or a new project with the same character and a fresh sheet if the wardrobe changes.

Any step can be done manually without the chat: pick a recipe, write a prompt, generate, approve.

## Example persona and product for docs, tests, and the demo

Use these invented details everywhere an example is needed. Do not use any real or private creator.

- Character: Avery Lane, early 30s, warm and direct, light freckles, dark shoulder-length hair usually tied back, small silver hoop earrings, speaks like a friend recommending something, never hype. Boundaries: no claims about health outcomes, no competitor names.
- Product: the Ridgeline 32 oz insulated bottle (invented), affiliate link placeholder, claims allowed: keeps drinks cold 24 hours, fits a car cup holder, dishwasher safe.
- Set: a bright kitchen counter by a window; a car interior; a gym bench.

## What the user pays

Comfy Cloud Standard plan for API access (about $20 a month, roughly 4,200 credits a month, one workflow at a time) plus optional credit top-ups. Router models use the same credits and need no plan. Anthropic usage for the assistant is small compared with generation. The README states these numbers as "at the time of writing" and links to Comfy's pricing page.

## Maintainer section (README, bottom)

Heading: "Need help running this?" Body: AI Creator Lab is maintained by Ted Darling at Digital Spirit Technology. If you would rather have it installed on your own server and connected to your Comfy account for you, you can hire Ted to do that. One link to the contact page `https://digitalspirittech.com/ai-creator-lab` (confirmed; the page is built separately). Three sentences, nothing more; the project speaks for itself and this section is the only place the maintainer is mentioned.

## Demo outline (two minutes)

0:00 the problem and the promise in one sentence; 0:10 settings with keys and allowance; 0:20 brief and bible in chat; 0:40 face lock with four candidates, pick and name; 0:50 the reference sheet; 0:58 product card; 1:05 script with beats; 1:20 approved frames; 1:35 LTX clips playing with audio; 1:50 assembled ad playing; 1:58 repo link.
