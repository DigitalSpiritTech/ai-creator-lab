import { z } from "zod";

/** Typed, safe failure every service and tool throws across the HTTP boundary. */
export const ServiceFailureSchema = z.object({
  code: z.enum(["not_found", "conflict", "storage", "provider", "invalid", "budget"]),
  message: z.string(),
});
export type ServiceFailure = z.infer<typeof ServiceFailureSchema>;

/** Maps an unknown exception to a known failure, or a generic storage failure. */
export function toFailure(error: unknown): ServiceFailure {
  const known = ServiceFailureSchema.safeParse(error);
  return known.success ? known.data : { code: "storage", message: "Something went wrong while saving your work." };
}
