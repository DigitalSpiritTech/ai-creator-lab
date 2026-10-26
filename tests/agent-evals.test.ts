/**
 * Offline evals (C7): five scripted conversations run end to end through the real loop, the real
 * tools, a temp store, and the mock executor. The scripted model reads what a real model would
 * (the system prompt's state and guidance, and tool results) to pick its next call; each eval
 * then asserts the project state the conversation produced.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, describe, test } from "node:test";
import sharp from "sharp";
import type { CharacterItem, CharacterLink, ProductItem } from "@/lib/domain/library";
import type { BeatInput } from "@/lib/domain/script";
import { loadSnapshot, nextStage, say, scriptedModel, use } from "@/server/agent";
import { importImage } from "@/server/media/images";
import { conversationsOf } from "@/server/store/conversations";
import { callTool } from "@/server/tools";
import { CHECKLISTS } from "@/server/agent/prompts/checklists";
import { type Harness, type TurnResult, agentHarness, approveProposal, guidedPrompt, resultJson, runTurn, stateValue, waitingIds } from "./support/agent-harness";
import { averyBible, generateAssets, ridgelineBeats, seedProject } from "./support/domain-fixtures";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function setup(): Harness {
  const harness = agentHarness();
  cleanups.push(harness.cleanup);
  return harness;
}

const BRIEF = { productSummary: "the Ridgeline 32 oz insulated bottle", audience: "commuters", platforms: ["TikTok", "Reels"], tone: "warm and direct, never hype" };

async function seed(harness: Harness, name: string, input: unknown) {
  const result = await callTool(harness.tools, name, input);
  if (!result.ok) throw new Error(`${name}: ${result.failure.message}`);
  return result.output as Record<string, unknown>;
}

/** A still uploaded straight to the Library (no project), as reference images are. */
async function libraryImage(harness: Harness, name: string): Promise<string> {
  const bytes = await sharp({ create: { width: 48, height: 64, channels: 3, background: "#8a6f5a" } }).jpeg().toBuffer();
  return (await importImage(harness.store, { projectId: null, name, bytes }, { now: harness.now(), newId: randomUUID })).id;
}

function character(harness: Harness, id: string): CharacterItem {
  return harness.store.library.getRequired(id) as CharacterItem;
}

function clean(turn: TurnResult): TurnResult {
  assert.equal(turn.error, undefined, turn.error ?? "");
  assert.ok(turn.done, "the turn finished");
  return turn;
}

/** Records scripted token usage per stage as a test diagnostic. */
function usage(t: { diagnostic: (message: string) => void }, stage: string, turn: TurnResult) {
  t.diagnostic(`${stage}: ${turn.done!.usage.inputTokens} input, ${turn.done!.usage.outputTokens} output tokens (scripted estimate)`);
}

describe("agent evals", () => {
  test("brief, then a new bible, then the face and body references are proposed, generated, and selected", async (t) => {
    const harness = setup();
    const { project, tools, store } = harness;

    const brief = clean(
      await runTurn(
        harness,
        "I'm selling the Ridgeline 32 oz insulated bottle to commuters. TikTok and Reels. Warm and direct, never hype.",
        scriptedModel([
          [use("save_brief", { projectId: project.id, brief: BRIEF }, "toolu_brief")],
          say("Brief saved. Next is your creator: I'd suggest a woman in her early 30s who commutes herself, unless you have someone in mind."),
        ]),
      ),
    );
    usage(t, "brief", brief);
    assert.deepEqual(store.projects.getRequired(project.id).brief, BRIEF);

    const bible = clean(
      await runTurn(
        harness,
        "Yes. Call her Avery Lane: early 30s, light freckles, dark hair tied back, small silver hoops, talks like a friend.",
        scriptedModel([
          [use("save_character_bible", { projectId: project.id, bible: averyBible() }, "toolu_bible")],
          (params) => {
            assert.match(params.system[1].text, /Next step: 5\. Face lock/);
            const characterId = stateValue(params.system, "characterId");
            return [
              use("propose_candidates", {
                projectId: project.id,
                capability: "text_to_image",
                count: 4,
                aspectRatio: "1:1",
                target: { kind: "character_reference", characterId, slot: "face" },
                prompt: guidedPrompt(params.system),
              }),
            ];
          },
          say(`Four face candidates are proposed; approve the card to run them. When they arrive, look for: ${CHECKLISTS.face[1]}.`),
        ]),
      ),
    );
    usage(t, "character and face proposal", bible);
    const characterId = (bible.toolResults[0].output as { character: { id: string } }).character.id;
    assert.equal(bible.proposals.length, 1);
    const faceProposal = bible.proposals[0];
    assert.equal(faceProposal.count, 4);
    assert.deepEqual(faceProposal.target, { kind: "character_reference", characterId, slot: "face" });
    assert.match(faceProposal.prompt, /^Avery Lane, a woman in her early 30s.*head turned about thirty degrees/);
    assert.equal(store.jobs.listByProject(project.id).length, 0, "nothing runs before the user approves");

    const faces = await approveProposal(tools, faceProposal);
    assert.equal(faces.length, 4);

    const pickFace = clean(
      await runTurn(
        harness,
        "The second one is her.",
        scriptedModel([
          (params) => {
            assert.deepEqual(waitingIds(params.system).sort(), [...faces].sort());
            return [use("select_reference", { characterId, slot: "face", assetId: faces[1] })];
          },
          (params) => {
            assert.match(params.system[1].text, /Next step: 6\. Body reference/);
            return [
              use("propose_candidates", {
                projectId: project.id,
                capability: "image_edit",
                count: 2,
                aspectRatio: "9:16",
                referenceAssetIds: [faces[1]],
                target: { kind: "character_reference", characterId, slot: "body" },
                prompt: guidedPrompt(params.system),
              }),
            ];
          },
          say("Face locked. Two full-body references in athleticwear are proposed from it."),
        ]),
      ),
    );
    usage(t, "face lock and body proposal", pickFace);
    assert.equal(pickFace.proposals[0].references[0].assetId, faces[1]);
    assert.match(pickFace.proposals[0].prompt, /athleticwear/);
    const bodies = await approveProposal(tools, pickFace.proposals[0]);

    const pickBody = clean(
      await runTurn(
        harness,
        "First body.",
        scriptedModel([
          (params) => {
            assert.deepEqual(waitingIds(params.system).sort(), [...bodies].sort());
            return [use("select_reference", { characterId, slot: "body", assetId: bodies[0] })];
          },
          say("Body locked. For this ad I'd dress her in the olive utility jacket over a white tee, unless you prefer the knit sweater."),
        ]),
      ),
    );
    usage(t, "body lock", pickBody);

    const avery = character(harness, characterId);
    assert.equal(avery.bible.references.faceAssetId, faces[1]);
    assert.equal(avery.bible.references.bodyAssetId, bodies[0]);
    assert.equal(avery.bible.version, 3);
    assert.equal(nextStage(loadSnapshot(store, project.id)!).id, "sheet");
    assert.equal(conversationsOf(store).listByProject(project.id).filter((message) => message.role === "user" && message.content[0].type === "text").length, 4);
  });

  test("a character already in the Library is reused without changing her identity, and her sheet is approved", async (t) => {
    const harness = setup();
    const { project, tools, store, now } = harness;
    const earlier = seedProject(store, now, "Earlier project");
    const created = (await seed(harness, "save_character_bible", { projectId: earlier.id, bible: averyBible() })) as { character: CharacterItem };
    const characterId = created.character.id;
    const face = await libraryImage(harness, "avery-face.jpg");
    await seed(harness, "select_reference", { characterId, slot: "face", assetId: face });
    const body = await libraryImage(harness, "avery-body.jpg");
    await seed(harness, "select_reference", { characterId, slot: "body", assetId: body });
    await seed(harness, "save_brief", { projectId: project.id, brief: BRIEF });
    const before = character(harness, characterId);

    const reuse = clean(
      await runTurn(
        harness,
        "Use Avery again for this one. Olive jacket.",
        scriptedModel([
          (params) => {
            const text = params.system[1].text;
            assert.match(text, /Next step: 4\. Character/);
            assert.match(text, new RegExp(`The Library already has Avery Lane \\(characterId ${characterId}, face locked, body locked\\)`));
            const bibleJson = JSON.parse(text.match(/Bible of Avery Lane: (.+)/)![1]);
            return [
              use("save_character_bible", {
                characterId,
                projectId: project.id,
                wardrobe: "Olive utility jacket over a white tee",
                bible: bibleJson,
              }),
            ];
          },
          (params) => {
            assert.match(params.system[1].text, /Next step: 7\. Reference sheet/);
            return [use("generate_reference_sheet", { projectId: project.id, characterId })];
          },
          say(`Avery is linked with the olive jacket, and two reference sheets are proposed. Inspect them at full size; reject any where ${CHECKLISTS.sheet[2].toLowerCase()}.`),
        ]),
      ),
    );
    usage(t, "library reuse and sheet proposal", reuse);
    const after = character(harness, characterId);
    const identity = (item: CharacterItem) => {
      const { references, version, ...fields } = item.bible;
      void version;
      return { fields, references };
    };
    assert.deepEqual(identity(after), identity(before), "identity and references are unchanged");
    const sheetProposal = reuse.proposals[0];
    assert.deepEqual(sheetProposal.target, { kind: "reference_sheet", characterId });
    assert.deepEqual(sheetProposal.references.map((reference) => reference.assetId), [face, body]);
    assert.match(sheetProposal.prompt, /Wardrobe in every panel: Olive utility jacket over a white tee\./);
    const sheets = await approveProposal(tools, sheetProposal);

    const approve = clean(
      await runTurn(
        harness,
        "The first sheet passes the checklist.",
        scriptedModel([
          (params) => {
            assert.deepEqual(waitingIds(params.system).sort(), [...sheets].sort());
            return [use("approve", { kind: "sheet", assetId: sheets[0], projectId: project.id, characterId })];
          },
          say("Sheet approved. Every still in this project will use it. Next: the product card."),
        ]),
      ),
    );
    usage(t, "sheet approval", approve);
    const link = store.library.getLink(project.id, characterId) as CharacterLink;
    assert.equal(link.sheetAssetId, sheets[0]);
    assert.equal(link.wardrobe, "Olive utility jacket over a white tee");
    assert.equal((store.library.getLink(earlier.id, characterId) as CharacterLink).sheetAssetId, null, "the other project keeps its own sheet state");
    assert.equal(nextStage(loadSnapshot(store, project.id)!).id, "product");
  });

  test("the user changes the product mid-way and the card, script, and Ad follow without the old claim", async (t) => {
    const harness = setup();
    const { project, store } = harness;
    await seed(harness, "save_brief", { projectId: project.id, brief: BRIEF });

    const first = clean(
      await runTurn(
        harness,
        "Product: Ridgeline 32 oz insulated bottle, https://example.com/ridgeline. Claims: keeps drinks cold 24 hours, fits a car cup holder, dishwasher safe. Write the script.",
        scriptedModel([
          [
            use(
              "save_product",
              {
                projectId: project.id,
                product: {
                  name: "Ridgeline 32 oz insulated bottle",
                  link: "https://example.com/ridgeline",
                  allowedClaims: ["Keeps drinks cold 24 hours", "Fits a car cup holder", "Dishwasher safe"],
                },
              },
              "toolu_product",
            ),
            use("save_script", { projectId: project.id, title: "Cup holder", beats: ridgelineBeats() }, "toolu_script"),
          ],
          (params) => {
            const { script } = resultJson<{ script: { id: string } }>(params.messages, "toolu_script");
            return [use("plan_shots", { projectId: project.id, scriptId: script.id })];
          },
          say("Product saved and a four-beat script is up in the Script tab."),
        ]),
      ),
    );
    usage(t, "product and script", first);

    const tumblerBeats: BeatInput[] = ridgelineBeats().map((beat) => ({ ...beat, visual: beat.visual.replace("Ridgeline bottle", "Ridgeline tumbler") }));
    tumblerBeats[2] = { ...tumblerBeats[2], spokenLine: "Twelve hours later my coffee was still hot. I checked.", onScreenText: "Hot 12 hours.", visual: "Avery at a kitchen counter, tumbler open, steam rising." };
    tumblerBeats[3] = { ...tumblerBeats[3], onScreenText: "Fits the cup holder.", visual: "The tumbler sliding into a car cup holder.", setting: "a car interior" };

    const change = clean(
      await runTurn(
        harness,
        "Actually, switch it to the Ridgeline 20 oz tumbler. Claims: keeps coffee hot 12 hours, fits a car cup holder. Drop the dishwasher line.",
        scriptedModel([
          (params) => {
            const text = params.system[1].text;
            const productId = stateValue(params.system, "productId");
            const revision = Number(text.match(/productId [0-9a-f-]{36}, revision (\d+)/)![1]);
            const scriptId = stateValue(params.system, "scriptId");
            return [
              use("save_product", {
                productId,
                revision,
                projectId: project.id,
                product: { name: "Ridgeline 20 oz tumbler", link: "https://example.com/ridgeline", allowedClaims: ["Keeps coffee hot 12 hours", "Fits a car cup holder"] },
              }),
              use("save_script", { projectId: project.id, scriptId, baseVersion: 1, title: "Cup holder, tumbler", beats: tumblerBeats }, "toolu_v2"),
            ];
          },
          (params) => {
            const { script, updatedContentIds } = resultJson<{ script: { id: string; version: number }; updatedContentIds: string[] }>(params.messages, "toolu_v2");
            assert.equal(script.version, 2);
            assert.equal(updatedContentIds.length, 1);
            return [use("plan_shots", { projectId: project.id, scriptId: script.id, contentId: updatedContentIds[0] })];
          },
          say("Switched to the 20 oz tumbler. The script is on version 2 with only the two claims on the card."),
        ]),
      ),
    );
    usage(t, "product change", change);

    const snapshot = loadSnapshot(store, project.id)!;
    const products = store.library.listLinks(project.id).filter((link) => link.kind === "product");
    assert.equal(products.length, 1, "still one product on the project");
    const product = snapshot.product as ProductItem;
    assert.equal(product.name, "Ridgeline 20 oz tumbler");
    assert.deepEqual(product.allowedClaims, ["Keeps coffee hot 12 hours", "Fits a car cup holder"]);
    assert.equal(snapshot.script!.version, 2);
    const words = JSON.stringify(snapshot.script!.beats);
    assert.doesNotMatch(words, /dishwasher/i);
    assert.doesNotMatch(words, /Ridgeline bottle/);
    assert.equal(snapshot.content!.scriptVersion, 2);
    assert.equal(snapshot.content!.shots.length, 4);
    assert.equal(store.scripts.listByProject(project.id).length, 1);
  });

  test("the user rejects all four face candidates; they are archived, the bible is revised, and four more are proposed", async (t) => {
    const harness = setup();
    const { project, tools, store } = harness;
    await seed(harness, "save_brief", { projectId: project.id, brief: BRIEF });
    const saved = (await seed(harness, "save_character_bible", { projectId: project.id, bible: averyBible() })) as { character: CharacterItem };
    const characterId = saved.character.id;

    const propose = clean(
      await runTurn(
        harness,
        "Show me some faces.",
        scriptedModel([
          (params) => [
            use("propose_candidates", {
              projectId: project.id,
              capability: "text_to_image",
              count: 4,
              target: { kind: "character_reference", characterId, slot: "face" },
              prompt: guidedPrompt(params.system),
            }),
          ],
          say("Four candidates proposed."),
        ]),
      ),
    );
    usage(t, "first face proposal", propose);
    const firstFaces = await approveProposal(tools, propose.proposals[0]);

    const warmer = {
      ...averyBible(),
      look: { ...averyBible().look, face: "Warm oval face with an easy smile and a generous spray of light freckles across the nose and cheeks" },
      visualCore:
        "Avery Lane, a woman in her early 30s with a warm oval face, an easy smile, a generous spray of light freckles, hazel eyes, dark shoulder-length hair tied back, and small silver hoop earrings.",
    };
    const reject = clean(
      await runTurn(
        harness,
        "None of these. She should look warmer and have more freckles. Try four more.",
        scriptedModel([
          (params) => {
            const waiting = waitingIds(params.system);
            assert.equal(waiting.length, 4);
            const revision = Number(params.system[1].text.match(/characterId [0-9a-f-]{36}, revision (\d+)/)![1]);
            return [
              ...waiting.map((assetId) => use("archive_asset", { assetId, reason: "rejected: not warm enough" })),
              use("save_character_bible", { characterId, revision, bible: warmer }),
            ];
          },
          (params) => {
            assert.deepEqual(waitingIds(params.system), [], "rejected candidates are no longer waiting");
            const prompt = guidedPrompt(params.system);
            assert.match(prompt, /generous spray of light freckles/);
            return [
              use("propose_candidates", {
                projectId: project.id,
                capability: "text_to_image",
                count: 4,
                target: { kind: "character_reference", characterId, slot: "face" },
                prompt,
              }),
            ];
          },
          say("I archived those four, updated Avery's bible to a warmer look with more freckles, and proposed four new faces."),
        ]),
      ),
    );
    usage(t, "reject and re-propose", reject);
    assert.equal(reject.toolCalls.length, 6);
    assert.ok(reject.toolResults.every((result) => result.ok));
    for (const id of firstFaces) {
      const state = store.assets.getRequired(id).state;
      assert.equal(state.state, "archived");
      assert.equal(state.state === "archived" && state.reason, "rejected: not warm enough");
    }
    const avery = character(harness, characterId);
    assert.equal(avery.bible.references.faceAssetId, null);
    assert.equal(avery.bible.version, 2);
    assert.match(reject.proposals[0].prompt, /^Avery Lane, a woman in her early 30s with a warm oval face, an easy smile, a generous spray/);
    const secondFaces = await approveProposal(tools, reject.proposals[0]);
    assert.deepEqual(loadSnapshot(store, project.id)!.candidates.face.sort(), [...secondFaces].sort());
    assert.equal(nextStage(loadSnapshot(store, project.id)!).id, "face");
  });

  test("a script asked for before any character exists is drafted, and the agent steers to what comes next", async (t) => {
    const harness = setup();
    const { project, store } = harness;
    const genericBeats: BeatInput[] = ridgelineBeats().slice(0, 3).map((beat) => ({ ...beat, visual: beat.visual.replace("Avery", "The creator") }));

    const draft = clean(
      await runTurn(
        harness,
        "Just write me a script for my Ridgeline 32 oz bottle ad. Claims: keeps drinks cold 24 hours, fits a car cup holder.",
        scriptedModel([
          (params) => {
            assert.match(params.system[1].text, /Character: none linked to this project yet/);
            assert.match(params.system[0].text, /Never refuse because a step is out of order/);
            return [
              use("save_product", {
                projectId: project.id,
                product: { name: "Ridgeline 32 oz insulated bottle", allowedClaims: ["Keeps drinks cold 24 hours", "Fits a car cup holder"] },
              }),
              use("save_script", { projectId: project.id, title: "Cup holder", beats: genericBeats }),
            ];
          },
          say(
            "Here's a three-beat draft, saved as version 1: a cup-holder hook, a warm-bottle problem, and the 24-hour proof. Before we can shoot it we need your creator and a brief. Who's buying this? I'd assume commuters on TikTok unless you say otherwise.",
          ),
        ]),
      ),
    );
    usage(t, "script before character", draft);
    assert.ok(draft.toolResults.every((result) => result.ok));
    assert.doesNotMatch(draft.text, /\b(can't|cannot|unable)\b/i);
    const snapshot = loadSnapshot(store, project.id)!;
    assert.equal(snapshot.character, undefined);
    assert.equal(snapshot.script?.version, 1);
    assert.equal(snapshot.script?.beats.length, 3);
    assert.doesNotMatch(JSON.stringify(snapshot.script?.beats), /Avery/);
    assert.equal(nextStage(snapshot).id, "brief");
    assert.equal(store.jobs.listByProject(project.id).length, 0);
  });

  test(
    "a Library character whose face and body were generated in another project can make a sheet here",
    async () => {
      const harness = setup();
      const { project, store, now } = harness;
      const earlier = seedProject(store, now, "Earlier project");
      const created = (await seed(harness, "save_character_bible", { projectId: earlier.id, bible: averyBible() })) as { character: CharacterItem };
      const characterId = created.character.id;
      for (const slot of ["face", "body"] as const) {
        const generated = await generateAssets(store, now, { projectId: earlier.id, target: { kind: "character_reference", characterId, slot } });
        await seed(harness, "select_reference", { characterId, slot, assetId: generated.assetIds[0] });
      }
      await seed(harness, "save_character_bible", { characterId, projectId: project.id, wardrobe: "Olive utility jacket over a white tee", bible: averyBible() });
      const result = await callTool(harness.tools, "generate_reference_sheet", { projectId: project.id, characterId });
      assert.ok(result.ok, result.ok ? "" : result.failure.message);
    },
  );

  test(
    "locking one face from a four-candidate proposal archives the other three",
    async () => {
      const harness = setup();
      const { project, tools, store } = harness;
      const saved = (await seed(harness, "save_character_bible", { projectId: project.id, bible: averyBible() })) as { character: CharacterItem };
      const characterId = saved.character.id;
      const proposal = await callTool(tools, "propose_candidates", {
        projectId: project.id,
        capability: "text_to_image",
        prompt: "Avery Lane portrait, head turned about thirty degrees.",
        target: { kind: "character_reference", characterId, slot: "face" },
      });
      assert.ok(proposal.ok);
      const faces = await approveProposal(tools, proposal.output as never);
      const selected = await callTool(tools, "select_reference", { characterId, slot: "face", assetId: faces[0] });
      assert.ok(selected.ok);
      assert.deepEqual(
        faces.slice(1).map((id) => store.assets.getRequired(id).state.state),
        ["archived", "archived", "archived"],
      );
    },
  );
});
