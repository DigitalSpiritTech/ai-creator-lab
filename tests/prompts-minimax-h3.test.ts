import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  GUIDE_FRAMES,
  H3_PROMPT_LIMIT,
  type H3ChainSpecInput,
  type H3ShotSpecInput,
  framesForSeconds,
  frameIndexAt,
  h3Timestamp,
  lastFrameIndex,
  renderH3Chain,
  renderH3Prompt,
  renderH3SingleShot,
} from "@/server/tools/prompts-minimax-h3";
import { RIDGELINE_APPEARANCE, averyBible } from "./support/domain-fixtures";

const PRODUCT = { name: "Ridgeline 32 oz insulated bottle", appearance: RIDGELINE_APPEARANCE };

function avery() {
  return {
    id: "avery",
    name: "Avery",
    description: averyBible().visualCore,
    wardrobe: "an olive utility jacket over a white tee",
    voice: "a warm, unhurried voice with natural pauses, like a friend recommending something",
  };
}

/** Three shots, eight seconds: talking, b-roll with a voice-over, talking; sheet, first frame, keyframe. */
function multiFrameScene(): H3ShotSpecInput {
  return {
    durationSeconds: 8,
    subjects: [avery()],
    pictures: [
      { index: 1, role: "identity", subject: "avery", sheet: true },
      { index: 2, role: "first_frame", shot: 1, subject: "avery", shows: "Avery at the kitchen counter holding the Ridgeline bottle at chest height, mid-sentence" },
      { index: 3, role: "keyframe", shot: 3, atSeconds: 6.5, subject: "avery", shows: "Avery smiling at the camera with the open bottle beside her on the counter" },
    ],
    shots: [
      {
        startSeconds: 0,
        endSeconds: 3,
        framing: "medium close-up",
        setting: "a bright kitchen counter by a window",
        lighting: "soft morning light from the window",
        subjects: ["avery"],
        action: "Avery lifts the bottle slightly toward the camera and talks to it with an easy smile and small natural head movement",
        camera: { move: "static" },
        product: "held in Avery's right hand at chest height",
      },
      {
        startSeconds: 3,
        endSeconds: 5.5,
        framing: "close-up",
        setting: "the same kitchen counter",
        lighting: "the same soft window light",
        action: "Two hands unscrew the cap of the Ridgeline bottle while condensation beads on the steel",
        camera: { move: "push_in", amplitude: "small", speed: "slow", detail: "toward the bottle" },
        product: "standing on the counter between the hands",
        sound: "The cap turns with a soft metallic click",
      },
      {
        startSeconds: 5.5,
        endSeconds: 8,
        framing: "medium close-up",
        setting: "the bright kitchen counter by the window",
        lighting: "soft morning light",
        subjects: ["avery"],
        action: "Avery sets the open bottle down beside her and looks back at the camera",
        camera: { move: "static" },
        product: "open on the counter beside Avery",
      },
    ],
    dialogue: [
      { speaker: "avery", shot: 1, text: "Honestly, this fits my cup holder." },
      { speaker: "avery", shot: 2, text: "Twenty-four hours later, still cold.", offscreen: true },
      { speaker: "avery", shot: 3, text: "And it's dishwasher safe", tone: "matter-of-factly" },
    ],
    product: PRODUCT,
    soundscape: "Quiet kitchen room tone with a soft refrigerator hum and faint birdsong outside the window. The bottle taps lightly on the counter.",
  };
}

/** The hook beat as one five-second image-to-video shot with dialogue. */
function singleShotHook(): H3ShotSpecInput {
  return {
    durationSeconds: 5,
    subjects: [avery()],
    pictures: [{ index: 1, role: "first_frame", shot: 1, subject: "avery", shows: "Avery in the driver's seat of a parked car holding the bottle, morning light" }],
    shots: [
      {
        startSeconds: 0,
        endSeconds: 5,
        setting: "a parked car interior",
        lighting: "soft morning light through the windshield",
        subjects: ["avery"],
        action: "Avery raises the Ridgeline bottle a little toward the camera and talks to it with an easy smile and small natural head movement",
        camera: { move: "static" },
        product: "held in Avery's right hand above the cup holder",
      },
    ],
    dialogue: [{ speaker: "avery", shot: 1, text: "I stopped buying bottled water the day this fit my cup holder." }],
    product: PRODUCT,
    soundscape: "Quiet car interior with faint traffic outside and the soft creak of the seat.",
  };
}

/** Ten seconds of talking as two chained five-second segments at the kitchen counter. */
function twoSegmentChain(): H3ChainSpecInput {
  const shot = {
    startSeconds: 0,
    endSeconds: 5,
    setting: "a bright kitchen counter by a window",
    lighting: "soft morning light from the window",
    subjects: ["avery"],
    camera: { move: "static" as const },
  };
  return {
    segments: [
      {
        durationSeconds: 5,
        subjects: [avery()],
        pictures: [{ index: 1, role: "first_frame", shot: 1, subject: "avery", shows: "Avery at the kitchen counter holding the closed bottle" }],
        shots: [{ ...shot, action: "Avery taps the closed bottle and talks to the camera with an easy smile", product: "held in Avery's left hand on the counter" }],
        dialogue: [{ speaker: "avery", shot: 1, text: "Twenty-four hours later it was still cold. I checked." }],
        product: PRODUCT,
        soundscape: "Quiet kitchen room tone with a soft refrigerator hum.",
      },
      {
        durationSeconds: 5,
        subjects: [avery()],
        pictures: [{ index: 1, role: "first_frame", shot: 1, subject: "avery", shows: "Avery at the kitchen counter holding the closed bottle in her left hand" }],
        shots: [{ ...shot, action: "Avery unscrews the cap, takes a short sip, and smiles at the camera", product: "in Avery's hands, cap off" }],
        dialogue: [{ speaker: "avery", shot: 1, text: "And it goes straight in the dishwasher." }],
        product: PRODUCT,
        soundscape: "Quiet kitchen room tone with a soft refrigerator hum and the light twist of the cap.",
      },
    ],
  };
}

function rendered(result: ReturnType<typeof renderH3Prompt>): string {
  if (!result.ok) assert.fail(result.errors.join("\n"));
  return result.prompt;
}

function errors(result: { ok: boolean; errors?: string[] }): string {
  assert.equal(result.ok, false, "expected a rejection");
  return (result.errors ?? []).join("\n");
}

const EXPECTED_MULTI_FRAME =
  "subject_definitions:\n<Subject 1> is the person in <Picture 1>, <Picture 2>, and <Picture 3>. Avery Lane, a woman in her early 30s with a warm oval face, light freckles, hazel eyes, dark shoulder-length hair tied back, and small silver hoop earrings. <Subject 1> wears an olive utility jacket over a white tee throughout.\n<Picture 1> is a character reference sheet of <Subject 1> with a large portrait panel, a full-body front view, and a full-body back view.\n<Picture 2> is the first frame of [Shot 1], showing <Subject 1> at the kitchen counter holding the bottle at chest height, mid-sentence.\n<Picture 3> is the keyframe of [Shot 3] at 00:06.500, showing <Subject 1> smiling at the camera with the open bottle beside her on the counter.\n\nsummary:\n[keyframe completion + reference generation] The target video runs 8 seconds in 3 shots with <Subject 1>: [Shot 1] medium close-up, a bright kitchen counter by a window; [Shot 2] close-up, the same kitchen counter; [Shot 3] medium close-up, the bright kitchen counter by the window. <Picture 1> defines <Subject 1>, <Picture 2> is the first frame of [Shot 1], and <Picture 3> is the keyframe of [Shot 3] at 00:06.500.\n\nretention_analysis:\n<Subject 1> (appears in [Shot 1], [Shot 3]): fully_preserved - the face, hair, skin, and distinguishing details are retained, with an olive utility jacket over a white tee in every shot.\n<Picture 1> (identity reference sheet): fully_preserved - <Subject 1> keeps the face from the portrait panel and the build from the full-body views.\n<Picture 2> ([Shot 1] first frame): fully_preserved - its composition, pose, and setting are matched at 00:00.000.\n<Picture 3> ([Shot 3] keyframe at 00:06.500): fully_preserved - its composition, pose, and setting are matched at 00:06.500.\n\ndetailed_description:\nThe target video uses a live-action, candid vertical phone-video UGC style.\n[Shot 1] A medium close-up. The setting is a bright kitchen counter by a window, soft morning light from the window. The shot begins from <Picture 2>, showing <Subject 1> at the kitchen counter holding the bottle at chest height, mid-sentence. <Subject 1> is in frame, wearing an olive utility jacket over a white tee, with the face and hair from the portrait panel of <Picture 1>. <Subject 1> lifts the bottle slightly toward the camera and talks to it with an easy smile and small natural head movement. The product, a matte dark green 32 oz insulated steel bottle with a black screw cap, its surface plain and unmarked, is held in <Subject 1>'s right hand at chest height. The camera holds a static shot. <Subject 1> (S1), speaking in a warm, unhurried voice with natural pauses, like a friend recommending something, says: <d>[English] Honestly, this fits my cup holder.</d> <Subject 1> finishes the line and goes quiet with lips closed.\n[Shot 2] At 00:03.000, the camera cuts to a close-up. The setting is the same kitchen counter, the same soft window light. Two hands unscrew the cap of the bottle while condensation beads on the steel. The product, a matte dark green 32 oz insulated steel bottle with a black screw cap, its surface plain and unmarked, is standing on the counter between the hands. The camera pushes in with small amplitude at slow speed toward the bottle. <Subject 1> (S1) says in an off-screen voiceover: <d>[English] Twenty-four hours later, still cold.</d> The cap turns with a soft metallic click.\n[Shot 3] At 00:05.500, the camera cuts to a medium close-up. The setting is the bright kitchen counter by the window, soft morning light. <Subject 1> is in frame in the same olive utility jacket over a white tee. <Subject 1> sets the open bottle down beside her and looks back at the camera. The product, a matte dark green 32 oz insulated steel bottle with a black screw cap, its surface plain and unmarked, is open on the counter beside <Subject 1>. The camera holds a static shot. At 00:06.500, the shot's keyframe corresponds to <Picture 3>, showing <Subject 1> smiling at the camera with the open bottle beside her on the counter. <Subject 1> (S1) says matter-of-factly: <d>[English] And it's dishwasher safe.</d> <Subject 1> finishes the line and goes quiet with lips closed.\n\noverall_soundscape:\nQuiet kitchen room tone with a soft refrigerator hum and faint birdsong outside the window. The bottle taps lightly on the counter.\n\nnon_diegetic_music:\nN/A";
const EXPECTED_SINGLE_SHOT =
  "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n\nintegrated_multimodal_description: [Shot 1] Live-action, candid vertical phone-video UGC style, a medium close-up begins from <Picture 1>, showing Avery in the driver's seat of a parked car holding the bottle, morning light. Avery shown in <Picture 1> keeps the face, hair, clothing, and position exactly as in <Picture 1>. The setting and light stay exactly as in <Picture 1>. Avery raises the bottle a little toward the camera and talks to it with an easy smile and small natural head movement. The product shown in <Picture 1> keeps its shape and proportions, held in Avery's right hand above the cup holder. The camera holds a static shot. Avery (S1), speaking in a warm, unhurried voice with natural pauses, like a friend recommending something, says: <d>[English] I stopped buying bottled water the day this fit my cup holder.</d> Avery finishes the line and goes quiet with lips closed.\n\noverall_soundscape: Quiet car interior with faint traffic outside and the soft creak of the seat.\n\nnon_diegetic_music: N/A";
const EXPECTED_CHAIN: string[] = [
  "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n\nintegrated_multimodal_description: [Shot 1] Live-action, candid vertical phone-video UGC style, a medium close-up begins from <Picture 1>, showing Avery at the kitchen counter holding the closed bottle. Avery shown in <Picture 1> keeps the face, hair, clothing, and position exactly as in <Picture 1>. The setting and light stay exactly as in <Picture 1>. Avery taps the closed bottle and talks to the camera with an easy smile. The product shown in <Picture 1> keeps its shape and proportions, held in Avery's left hand on the counter. The camera holds a static shot. Avery (S1), speaking in a warm, unhurried voice with natural pauses, like a friend recommending something, says: <d>[English] Twenty-four hours later it was still cold. I checked.</d> Avery finishes the line and goes quiet with lips closed. In the last second the motion eases into a steady pose with the same framing, clothing, and light, setting up the next moment: Avery unscrews the cap, takes a short sip, and smiles at the camera.\n\noverall_soundscape: Quiet kitchen room tone with a soft refrigerator hum.\n\nnon_diegetic_music: N/A",
  "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n\nintegrated_multimodal_description: [Shot 1] Live-action, candid vertical phone-video UGC style, a medium close-up continues from <Picture 1>, the last frame of the previous segment, showing Avery at the kitchen counter holding the closed bottle in her left hand. Avery shown in <Picture 1> keeps the face, hair, clothing, and position exactly as in <Picture 1>. The setting and light stay exactly as in <Picture 1>. Avery unscrews the cap, takes a short sip, and smiles at the camera. The product shown in <Picture 1> keeps its shape and proportions, in Avery's hands, cap off. The camera holds a static shot. Avery (S1), speaking in a warm, unhurried voice with natural pauses, like a friend recommending something, says: <d>[English] And it goes straight in the dishwasher.</d> Avery finishes the line and goes quiet with lips closed.\n\noverall_soundscape: Quiet kitchen room tone with a soft refrigerator hum and the light twist of the cap.\n\nnon_diegetic_music: N/A",
];

describe("H3 frame helpers", () => {
  test("lengths follow 17n+5 at 24 fps and cover the requested seconds", () => {
    assert.equal(framesForSeconds(5), 124);
    assert.equal(framesForSeconds(124 / 24), 124, "the template default, about 5.17 s");
    assert.equal(framesForSeconds(5.2), 141, "5.2 s needs 125 frames, so the next 17n+5 length");
    assert.equal(framesForSeconds(8), 192);
    assert.equal(framesForSeconds(1), 39);
    assert.equal(framesForSeconds(0.1), 5);
    for (const seconds of [0.5, 2, 3.3, 5, 7.25, 10, 15]) {
      const frames = framesForSeconds(seconds);
      assert.equal((frames - 5) % 17, 0, `${seconds} s`);
      assert.ok(frames >= Math.round(seconds * 24), `${seconds} s covers the plan`);
      assert.ok(frames - 17 < Math.round(seconds * 24), `${seconds} s is the smallest that fits`);
    }
    assert.equal(lastFrameIndex(5), 123);
  });

  test("guide frames are round(seconds * 24) and cut times use MM:SS.mmm", () => {
    assert.equal(frameIndexAt(1.5), 36);
    assert.equal(frameIndexAt(6.5), 156);
    assert.equal(frameIndexAt(0.02), 0);
    assert.equal(GUIDE_FRAMES, 1);
    assert.equal(h3Timestamp(0), "00:00.000");
    assert.equal(h3Timestamp(3.5), "00:03.500");
    assert.equal(h3Timestamp(65.25), "01:05.250");
  });
});

describe("H3 prompt renderers", () => {
  test("full-reference multi-frame scene matches its snapshot", () => {
    const result = renderH3Prompt(multiFrameScene());
    assert.equal(rendered(result), EXPECTED_MULTI_FRAME);
    assert.ok(result.ok);
    assert.equal(result.frames, 192);
    assert.deepEqual(result.anchors, [
      { picture: 2, role: "first_frame", frameIdx: 0 },
      { picture: 3, role: "keyframe", frameIdx: 156 },
    ]);
  });

  test("single-shot image to video with dialogue matches its snapshot", () => {
    const result = renderH3SingleShot(singleShotHook());
    assert.equal(rendered(result), EXPECTED_SINGLE_SHOT);
    assert.ok(result.ok);
    assert.equal(result.frames, 124);
  });

  test("a two-segment chain continues from the last frame and sets up the next action", () => {
    const result = renderH3Chain(twoSegmentChain());
    if (!result.ok) assert.fail(result.errors.join("\n"));
    assert.deepEqual(
      result.segments.map((segment) => segment.prompt),
      EXPECTED_CHAIN,
    );
    assert.deepEqual(
      result.segments.map((segment) => segment.frames),
      [124, 124],
    );
  });

  test("a last frame as Picture 2 renders the first-and-last form with the effective duration", () => {
    const spec = singleShotHook();
    spec.pictures = [...spec.pictures!, { index: 2, role: "last_frame", shot: 1, subject: "avery", shows: "Avery holding the bottle up beside her face, smiling" }];
    const prompt = rendered(renderH3SingleShot(spec));
    assert.ok(
      prompt.startsWith(
        "How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the 5.17-second mark of the target video.\n\nintegrated_multimodal_description: [Shot 1] ",
      ),
    );
    assert.match(prompt, /settles into the pose, framing, and composition established by Picture 2 at the end of the shot/);
  });

  test("prompts follow the content rules: dialogue in <d> tags, product by look only, no negatives, no on-screen text", () => {
    const prompts = [rendered(renderH3Prompt(multiFrameScene())), rendered(renderH3SingleShot(singleShotHook()))];
    const chain = renderH3Chain(twoSegmentChain());
    assert.ok(chain.ok);
    prompts.push(...chain.segments.map((segment) => segment.prompt));
    for (const prompt of prompts) {
      assert.doesNotMatch(prompt, /Ridgeline/);
      assert.doesNotMatch(prompt, /"/, "double quotes would render as on-screen text");
      assert.doesNotMatch(prompt, /\b(no|not|never|without|avoid)\b/i, "H3 has no negative branch; prompts state what appears");
      assert.match(prompt, /<d>\[English\] [^<]+[.?!]<\/d>/);
      assert.ok(prompt.length < H3_PROMPT_LIMIT, `${prompt.length} characters`);
    }
    const [multi, ...base] = prompts;
    assert.match(multi, /a matte dark green 32 oz insulated steel bottle with a black screw cap, its surface plain and unmarked/, "full reference defines the product by its look");
    for (const prompt of base) {
      // A first frame carries identity, wardrobe, product, set, and light; base modes point at it instead.
      assert.ok(!prompt.includes(averyBible().visualCore), "no restated visual core");
      assert.doesNotMatch(prompt, /freckles|hazel|olive utility jacket|matte dark green|The setting is/);
      assert.match(prompt, /Avery shown in <Picture 1> keeps the face, hair, clothing, and position exactly as in <Picture 1>\./);
      assert.match(prompt, /The setting and light stay exactly as in <Picture 1>\./);
      assert.match(prompt, /The product shown in <Picture 1> keeps its shape and proportions, [^.]+\./);
    }
    assert.match(multi, /<Subject 1> \(S1\), speaking in a warm, unhurried voice[^:]*, says: <d>\[English\] Honestly, this fits my cup holder\.<\/d>/);
    assert.match(multi, /<Subject 1> \(S1\) says in an off-screen voiceover: <d>\[English\] Twenty-four hours later, still cold\.<\/d>/);
    assert.match(multi, /<Subject 1> \(S1\) says matter-of-factly: <d>\[English\] And it's dishwasher safe\.<\/d>/, "a missing final period is added");
    assert.equal(multi.match(/speaking in a warm/g)?.length, 1, "the voice is described once, at the first line");
    assert.match(multi, /\[Shot 2\] At 00:03\.000, the camera cuts to a close-up\./);
    assert.match(multi, /\[Shot 3\] At 00:05\.500, the camera cuts to a medium close-up\./);
    assert.doesNotMatch(multi, /\bAvery\b(?! Lane)/, "actions refer to the subject by label in full-reference mode");
  });
});

describe("H3 spec validation", () => {
  test("shots must be ordered, contiguous, and end at the duration", () => {
    const spec = multiFrameScene();
    spec.shots[1] = { ...spec.shots[1], startSeconds: 3.5 };
    assert.match(errors(renderH3Prompt(spec)), /shots\.1\.startSeconds: Shot 2 starts where shot 1 ends \(3 s\)/);

    const late = multiFrameScene();
    late.shots[2] = { ...late.shots[2], endSeconds: 9 };
    const message = errors(renderH3Prompt(late));
    assert.match(message, /Shot 3 ends at 9 s, past the 8 s duration/);
    assert.match(message, /The last shot ends at the duration \(8 s\)/);
  });

  test("keyframes stay inside their shot and leave room for the guide frame", () => {
    const outside = multiFrameScene();
    outside.pictures![2] = { ...outside.pictures![2], atSeconds: 4 };
    assert.match(errors(renderH3Prompt(outside)), /Keyframe <Picture 3> at 4 s is outside shot 3 \(5\.5 to 8 s\)/);

    const edge = multiFrameScene();
    const seconds = 192 / 24;
    edge.durationSeconds = seconds;
    edge.shots[2] = { ...edge.shots[2], endSeconds: seconds };
    edge.pictures![2] = { ...edge.pictures![2], atSeconds: 7.99 };
    assert.match(errors(renderH3Prompt(edge)), /<Picture 3> at frame 192 plus its 1-frame guide runs past the 192-frame video/);

    const missing = multiFrameScene();
    missing.pictures![2] = { index: 3, role: "keyframe", shot: 3, subject: "avery", shows: "Avery smiling" };
    assert.match(errors(renderH3Prompt(missing)), /Keyframe <Picture 3> needs atSeconds/);
  });

  test("<Picture N> references must exist and other tags or quotes are refused", () => {
    const spec = multiFrameScene();
    spec.shots[1] = { ...spec.shots[1], action: "The hands from <Picture 4> unscrew the cap" };
    assert.match(errors(renderH3Prompt(spec)), /<Picture 4> does not exist; this spec has 3 picture\(s\)/);

    const tagged = multiFrameScene();
    tagged.shots[0] = { ...tagged.shots[0], action: "<Subject 2> waves" };
    assert.match(errors(renderH3Prompt(tagged)), /Only <Picture N> tags may appear in text/);

    const quoted = multiFrameScene();
    quoted.shots[0] = { ...quoted.shots[0], action: 'Avery says "hi" to the camera' };
    assert.match(errors(renderH3Prompt(quoted)), /double-quoted words as on-screen text/);

    const order = multiFrameScene();
    order.pictures = [order.pictures![1], order.pictures![0], order.pictures![2]];
    assert.match(errors(renderH3Prompt(order)), /ref_images slot order/);
  });

  test("dialogue fits 2.5 words per second, has a known speaker in frame, and avoids ellipses", () => {
    const long = multiFrameScene();
    long.dialogue![0] = { speaker: "avery", shot: 1, text: "Honestly, I stopped buying bottled water the day this fit my cup holder." };
    assert.match(errors(renderH3Prompt(long)), /Shot 1 holds 13 spoken words, about 5\.2 s at 2\.5 words per second; the shot is 3 s/);

    const stranger = multiFrameScene();
    stranger.dialogue![0] = { speaker: "jordan", shot: 1, text: "Hi there." };
    assert.match(errors(renderH3Prompt(stranger)), /Unknown speaker "jordan"/);

    const offFrame = multiFrameScene();
    offFrame.dialogue![1] = { speaker: "avery", shot: 2, text: "Still cold." };
    assert.match(errors(renderH3Prompt(offFrame)), /avery is not in shot 2; add them to the shot or mark the line offscreen/);

    const trailing = singleShotHook();
    trailing.dialogue![0] = { speaker: "avery", shot: 1, text: "So I tried it..." };
    assert.match(errors(renderH3SingleShot(trailing)), /Ellipses blur H3 speech/);
  });

  test("every mode keeps people to their references", () => {
    const unanchored = multiFrameScene();
    unanchored.pictures = unanchored.pictures!.map((picture) => (picture.role === "identity" ? picture : { ...picture, subject: undefined }));
    unanchored.pictures = unanchored.pictures.filter((picture) => picture.role !== "identity").map((picture, i) => ({ ...picture, index: i + 1 }));
    assert.match(errors(renderH3Prompt(unanchored)), /Subject "avery" needs a picture that shows them/);

    const withIdentity = singleShotHook();
    withIdentity.pictures = [...withIdentity.pictures!, { index: 2, role: "identity", subject: "avery" }];
    assert.match(errors(renderH3SingleShot(withIdentity)), /base modes take only a first frame and an optional last frame/);

    const twoShots = multiFrameScene();
    twoShots.pictures = [{ index: 1, role: "first_frame", shot: 1, subject: "avery", shows: "Avery at the counter" }];
    assert.match(errors(renderH3SingleShot(twoShots)), /Image to video renders one shot/);

    const drift = twoSegmentChain();
    drift.segments[1] = { ...drift.segments[1], subjects: [{ ...avery(), wardrobe: "a gray hoodie" }] };
    assert.match(errors(renderH3Chain(drift)), /segments\.1\.subjects\.0: Subject "avery" keeps the same description, wardrobe, and voice in every segment/);

    const noProduct = singleShotHook();
    delete noProduct.product;
    assert.match(errors(renderH3SingleShot(noProduct)), /A product placement needs the product card/);
  });

  test("renderers report invalid input instead of throwing", () => {
    assert.doesNotThrow(() => renderH3Prompt({} as H3ShotSpecInput));
    assert.equal(renderH3Prompt({} as H3ShotSpecInput).ok, false);
    assert.equal(renderH3SingleShot({ ...singleShotHook(), durationSeconds: 30 }).ok, false);
    assert.equal(renderH3Chain({ segments: [] }).ok, false);
  });
});
