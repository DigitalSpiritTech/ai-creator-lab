/**
 * Failed sign-in limiter. The proxy and route handlers see no client address, so the limit is
 * global: after `maxFailures` failures inside `windowMs`, sign-in and setup answer 429 until the
 * oldest failure leaves the window. Sessions already signed in keep working. Each failure is also
 * answered only after `delayMs`, which slows a guessing loop further.
 * @packageDocumentation
 */

export interface FailureLimiter {
  /** Seconds until the next attempt is allowed; 0 when attempts are open. */
  retryAfterSeconds(): number;
  recordFailure(): void;
  reset(): void;
  readonly delayMs: number;
}

export function createFailureLimiter(options: { maxFailures?: number; windowMs?: number; delayMs?: number; now?: () => number } = {}): FailureLimiter {
  const maxFailures = options.maxFailures ?? 10;
  const windowMs = options.windowMs ?? 10 * 60_000;
  const now = options.now ?? Date.now;
  let failures: number[] = [];
  const prune = () => {
    const cutoff = now() - windowMs;
    failures = failures.filter((time) => time > cutoff);
  };
  return {
    delayMs: options.delayMs ?? 1_000,
    retryAfterSeconds() {
      prune();
      if (failures.length < maxFailures) return 0;
      return Math.max(1, Math.ceil((failures[0]! + windowMs - now()) / 1000));
    },
    recordFailure() {
      prune();
      failures.push(now());
    },
    reset() {
      failures = [];
    },
  };
}
