/**
 * Roster tools that need the executors and catalog. Registered now so the registry and its JSON
 * schemas are complete; each returns an "invalid" failure until it is built (docs/TASKS.md A4, C4, C8, A5, B4).
 * @packageDocumentation
 */
import { z } from "zod";
import { CapabilitySchema } from "@/lib/domain/capability";
import { IdSchema, RecipeIdSchema, text } from "@/lib/domain/common";
import { ExportRecordSchema } from "@/lib/domain/content";
import { GenerationProposalSchema, GenerationTargetSchema } from "@/lib/domain/job";
import { stubTool } from "@/server/tools/registry";

const count = z.number().int().min(1).max(4).default(4);

export const proposeCandidates = stubTool({
  name: "propose_candidates",
  description:
    "Propose a generation (capability, optional recipe, prompt, reference images, count) and return a proposal the user approves before anything is spent. Used for face lock, body reference, and manual generations.",
  input: z
    .object({
      projectId: IdSchema,
      capability: CapabilitySchema,
      recipeId: RecipeIdSchema.optional(),
      prompt: text(8000),
      referenceAssetIds: z.array(IdSchema).max(8).default([]),
      count,
      target: GenerationTargetSchema.default({ kind: "loose" }),
    })
    .strict(),
  output: GenerationProposalSchema,
});

export const generateReferenceSheet = stubTool({
  name: "generate_reference_sheet",
  description:
    "Propose this project's character reference sheet from the approved face and body references in the project's wardrobe.",
  input: z
    .object({
      projectId: IdSchema,
      characterId: IdSchema,
      wardrobe: text(300).optional(),
      recipeId: RecipeIdSchema.optional(),
      count: z.number().int().min(1).max(4).default(2),
    })
    .strict(),
  output: GenerationProposalSchema,
});

export const composeStill = stubTool({
  name: "compose_still",
  description: "Propose start-frame candidates for one beat, composed from the reference sheet, the product, and the setting.",
  input: z
    .object({
      contentId: IdSchema,
      beatIndex: z.number().int().positive(),
      recipeId: RecipeIdSchema.optional(),
      count,
    })
    .strict(),
  output: GenerationProposalSchema,
});

export const refineStill = stubTool({
  name: "refine_still",
  description: "Propose a text-guided edit of one candidate image when it is close but not right.",
  input: z
    .object({
      assetId: IdSchema,
      instruction: text(1000),
      recipeId: RecipeIdSchema.optional(),
    })
    .strict(),
  output: GenerationProposalSchema,
});

export const generateClip = stubTool({
  name: "generate_clip",
  description: "Propose a clip for one beat from its approved still; talking beats carry the spoken line.",
  input: z
    .object({
      contentId: IdSchema,
      beatIndex: z.number().int().positive(),
      recipeId: RecipeIdSchema.optional(),
      count: z.number().int().min(1).max(4).default(1),
    })
    .strict(),
  output: GenerationProposalSchema,
});

export const assembleAd = stubTool({
  name: "assemble_ad",
  description: "Join the approved clips in cut order into a 1080 x 1920 MP4 with on-screen text burned in.",
  input: z
    .object({
      contentId: IdSchema,
      mute: z.boolean().optional(),
      captions: z.boolean().optional(),
    })
    .strict(),
  output: ExportRecordSchema,
});

export const listRecipes = stubTool({
  name: "list_recipes",
  description: "List recipes that can run a capability, with verification status and cost hints.",
  input: z.object({ capability: CapabilitySchema.optional() }).strict(),
  output: z.object({
    recipes: z.array(
      z.object({
        id: RecipeIdSchema,
        title: z.string(),
        capability: CapabilitySchema,
        kind: z.enum(["router", "workflow", "mock"]),
        verified: z.boolean(),
        costHint: z.string(),
      }),
    ),
  }),
});
