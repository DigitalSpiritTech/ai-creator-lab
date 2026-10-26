/**
 * Test fixtures built on the invented example persona and product from docs/PRODUCT.md.
 * @packageDocumentation
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssetKind, AssetMime } from "@/lib/domain/asset";
import type { CharacterBibleFields } from "@/lib/domain/library";
import { createJob, advanceJob, type GenerationTarget, type Job, type JobInput } from "@/lib/domain/job";
import { MOCK_RECIPES } from "@/server/catalog/defaults";
import { createProject, type Project } from "@/lib/domain/project";
import type { BeatInput } from "@/lib/domain/script";
import { commitJobOutputs } from "@/server/media/commit";
import { type Store, openStore } from "@/server/store";

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "creator-lab-"));
}

/** Opens a store in a fresh temporary directory; `cleanup` closes it and removes the directory. */
export function tempStore(): { store: Store; dir: string; cleanup: () => void } {
  const dir = tempDir();
  const store = openStore(dir);
  return {
    store,
    dir,
    cleanup: () => {
      try {
        store.close();
      } catch {
        // Already closed by the test.
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function clock(start = 1_760_000_000_000): () => number {
  let time = start;
  return () => {
    time += 1000;
    return time;
  };
}

export function averyBible(): CharacterBibleFields {
  return {
    name: "Avery Lane",
    ageRange: "early 30s",
    look: {
      face: "Warm oval face with light freckles across the nose",
      hair: "Dark shoulder-length hair, usually tied back",
      skin: "Light olive with natural texture",
      eyes: "Hazel",
      distinguishingDetails: "Small silver hoop earrings",
    },
    build: "Average height, athletic and relaxed",
    wardrobeDefaults: ["Oatmeal knit sweater and jeans", "Olive utility jacket over a white tee"],
    voice: {
      style: "Speaks like a friend recommending something, never hype",
      pace: "Unhurried with natural pauses",
      phrasesUsed: ["Honestly", "I checked"],
      phrasesAvoided: ["You won't believe"],
    },
    vibe: ["warm", "direct", "grounded"],
    backstory: "Commutes forty minutes each way and lives out of her car on busy days. Tries things before she talks about them.",
    boundaries: ["No claims about health outcomes", "No competitor names"],
    visualCore:
      "Avery Lane, a woman in her early 30s with a warm oval face, light freckles, hazel eyes, dark shoulder-length hair tied back, and small silver hoop earrings.",
  };
}

export function ridgelineBeats(): BeatInput[] {
  return [
    {
      type: "talking",
      purpose: "hook",
      spokenLine: "I stopped buying bottled water the day this fit my cup holder.",
      onScreenText: "Fits the cup holder.",
      visual: "Avery in the driver's seat holding the Ridgeline bottle, morning light.",
      setting: "a car interior",
      productVisible: true,
    },
    {
      type: "broll",
      purpose: "problem",
      onScreenText: "Warm by noon.",
      visual: "Hands pulling a warm plastic bottle from a hot car console.",
      setting: "a car interior",
    },
    {
      type: "talking",
      purpose: "proof",
      spokenLine: "Twenty-four hours later it was still cold. I checked.",
      onScreenText: "Cold 24 hours.",
      visual: "Avery at a kitchen counter, bottle open, condensation.",
      setting: "a bright kitchen counter by a window",
      productVisible: true,
    },
    {
      type: "broll",
      purpose: "proof",
      onScreenText: "Dishwasher safe.",
      visual: "The bottle going into a dishwasher rack.",
      setting: "a bright kitchen counter by a window",
      productVisible: true,
    },
  ];
}

export function seedProject(store: Store, now: () => number, name = "Bottle launch, October"): Project {
  return store.projects.create(createProject({ name }, randomUUID(), now()));
}

const MIME_FOR: Record<AssetKind, AssetMime> = {
  image: "image/png",
  sheet: "image/png",
  storyboard: "image/svg+xml",
  video: "video/mp4",
};

/**
 * Runs a fake job through the real state machine and atomic commit, producing `count` outputs.
 * Bytes are placeholders; nothing here decodes them.
 */
export async function generateAssets(
  store: Store,
  now: () => number,
  options: {
    projectId: string;
    target?: GenerationTarget;
    kind?: AssetKind;
    count?: number;
    inputs?: JobInput[];
  },
): Promise<{ job: Job; assetIds: string[] }> {
  const kind = options.kind ?? "image";
  const count = options.count ?? 1;
  const capability = kind === "video" || kind === "storyboard" ? "image_to_video" : options.inputs?.length ? "image_edit" : "text_to_image";
  const created = createJob(
    {
      id: randomUUID(),
      requestId: randomUUID(),
      projectId: options.projectId,
      request: {
        recipe: MOCK_RECIPES.find((recipe) => recipe.capability === capability)!,
        input: { prompt: "Avery Lane portrait", images: [] },
        inputs: options.inputs ?? [],
        target: options.target ?? { kind: "loose" },
      },
    },
    now(),
  );
  let job = store.jobs.add(created).job;
  for (const status of ["submitting", "running", "retrieving"] as const) {
    const next = advanceJob(job, { status, providerRef: "mock-ref" }, now());
    if (!store.jobs.transition(job, next)) throw new Error("transition lost");
    job = next;
  }
  const outputs = Array.from({ length: count }, (_, index) => ({
    bytes: new TextEncoder().encode(`${kind}-${job.id}-${index}`),
    mime: MIME_FOR[kind],
    kind,
    width: 1080,
    height: 1920,
    video:
      kind === "video"
        ? {
            durationSeconds: 5,
            frameRate: 24,
            frameCount: 121,
            hasAudio: true,
            posterPng: new TextEncoder().encode(`poster-${index}`),
          }
        : undefined,
  }));
  const result = await commitJobOutputs(store, job, outputs, { now: now(), newId: randomUUID });
  return { job: result.job, assetIds: result.assets.map((asset) => asset.id) };
}
