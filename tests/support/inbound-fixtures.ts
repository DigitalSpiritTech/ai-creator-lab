/**
 * A gallery example as item 10's "start from example" will hand it in: the invented Ridgeline
 * launch from docs/PRODUCT.md, with the brief and the Library items the example uses.
 * @packageDocumentation
 */
import type { SeedProject } from "@creator-lab/core/domain/inbound";

export const RIDGELINE_EXAMPLE_REF = "ridgeline-bottle-launch";

/** The example as the gallery sends it, naming the Library character and product it starts from. */
export function ridgelineExample(ids: { characterId: string; productId: string }): SeedProject {
  return {
    name: "Ridgeline launch (from example)",
    appId: "ugc-creator",
    inbound: {
      brief: {
        productSummary: "Ridgeline 32 oz insulated bottle that keeps drinks cold for 24 hours",
        audience: "Commuters who drive to work and want a cold drink at lunch",
        platforms: ["TikTok", "Instagram Reels"],
        tone: "Warm and direct, like a friend recommending something",
      },
      libraryRefs: [
        { kind: "character", id: ids.characterId },
        { kind: "product", id: ids.productId },
      ],
      source: { kind: "gallery", ref: RIDGELINE_EXAMPLE_REF },
    },
  };
}
