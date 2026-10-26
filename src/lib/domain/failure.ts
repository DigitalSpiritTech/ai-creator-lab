import { z } from "zod";

export const FailureCodeSchema = z.enum(["not_found", "conflict", "storage", "provider", "invalid", "budget"]);
export type FailureCode = z.infer<typeof FailureCodeSchema>;

/** Typed, safe failure every service and tool throws across the HTTP boundary. */
export const ServiceFailureSchema = z.object({
  code: FailureCodeSchema,
  message: z.string(),
});
export type ServiceFailure = z.infer<typeof ServiceFailureSchema>;

/** An Error that carries a safe, user-facing failure and still parses as a ServiceFailure. */
export class ServiceError extends Error {
  readonly code: FailureCode;

  constructor(code: FailureCode, message: string) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
  }
}

/** Throws a typed failure; use for expected, user-facing errors. */
export function fail(code: FailureCode, message: string): never {
  throw new ServiceError(code, message);
}

/** Maps an unknown exception to a known failure, or a generic storage failure. */
export function toFailure(error: unknown): ServiceFailure {
  const known = ServiceFailureSchema.safeParse(error);
  return known.success
    ? { code: known.data.code, message: known.data.message }
    : { code: "storage", message: "Something went wrong while saving your work." };
}
