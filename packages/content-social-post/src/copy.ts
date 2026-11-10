/**
 * A Social Post's copy, the body of its content piece: the caption, hashtags, a call to action, and
 * the visual line its stills are generated from. Pure data and functions, shared by the tools, the
 * assistant, and the panels.
 * @packageDocumentation
 */
import { z } from "zod";

/** The aspect ratios a post's stills come in, one slot each, in display order. */
export const SOCIAL_POST_RATIOS = ["1:1", "4:5", "9:16", "16:9"] as const;
export const SocialPostRatioSchema = z.enum(SOCIAL_POST_RATIOS);
export type SocialPostRatio = z.infer<typeof SocialPostRatioSchema>;

/** Where each ratio is used, for labels. */
export const RATIO_LABELS: Record<SocialPostRatio, string> = {
  "1:1": "Square (1:1)",
  "4:5": "Feed portrait (4:5)",
  "9:16": "Story or reel cover (9:16)",
  "16:9": "Wide (16:9)",
};

/** A hashtag as typed: with or without the leading #, no spaces. */
const HashtagInputSchema = z.string().trim().regex(/^#?[^\s#]{1,60}$/, "A hashtag is one word, with or without #.");

/** The copy as saved: hashtags without their #. */
export const SocialPostCopySchema = z
  .object({
    caption: z.string().trim().min(1).max(2200),
    hashtags: z.array(z.string().regex(/^[^\s#]{1,60}$/)).max(30).default([]),
    callToAction: z.string().trim().max(200).default(""),
    /** One or two sentences describing the picture; the stills' prompts start from it. */
    visual: z.string().trim().max(600).default(""),
  })
  .strict();
export type SocialPostCopy = z.infer<typeof SocialPostCopySchema>;

/** The copy as a tool or a form sends it: hashtags may carry their #. */
export const SocialPostCopyInputSchema = SocialPostCopySchema.extend({
  hashtags: z.array(HashtagInputSchema).max(30).default([]),
}).strict();
export type SocialPostCopyInput = z.input<typeof SocialPostCopyInputSchema>;

/** Normalizes typed copy for saving: hashtags lose their #, repeats are dropped (case-insensitive). */
export function normalizeCopy(input: SocialPostCopyInput): SocialPostCopy {
  const parsed = SocialPostCopyInputSchema.parse(input);
  const seen = new Set<string>();
  const hashtags = parsed.hashtags
    .map((tag) => tag.replace(/^#/, ""))
    .filter((tag) => {
      const key = tag.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return SocialPostCopySchema.parse({ ...parsed, hashtags });
}

/** The copy as one block of text to paste into a post: caption, call to action, hashtags. */
export function copyText(copy: SocialPostCopy): string {
  return [copy.caption, copy.callToAction, copy.hashtags.map((tag) => `#${tag}`).join(" ")].filter((part) => part.trim().length > 0).join("\n\n");
}

/** A short title from the caption, for a post saved without one. */
export function titleFrom(copy: SocialPostCopy): string {
  const first = copy.caption.split("\n")[0].trim();
  return first.length > 60 ? `${first.slice(0, 59)}…` : first;
}
