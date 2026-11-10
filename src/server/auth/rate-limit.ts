/**
 * Failed sign-in limiter. The proxy and route handlers see no client address, so the limit is
 * global: at most `maxFailures` failed attempts inside `windowMs`, after which sign-in and setup
 * answer 429 until the oldest failure leaves the window. Sessions already signed in keep working.
 *
 * Each attempt is counted as a failure when it starts, before the password is checked, and only
 * uncounted if it succeeds; so a burst of parallel guesses gets no more checks than the limit
 * allows. Attempts are also checked one at a time, and a failure holds that turn for `delayMs`,
 * which makes the delay a real throttle. Failure times live in a `FailureStore` (the auth file in
 * production), so a restart does not clear them.
 * @packageDocumentation
 */

/** Where failure times are kept; read and written synchronously so counting never interleaves. */
export interface FailureStore {
  load(): number[];
  save(failures: number[]): void;
}

export function memoryFailureStore(): FailureStore {
  let failures: number[] = [];
  return {
    load: () => failures,
    save: (next) => {
      failures = next;
    },
  };
}

export type AttemptOutcome<T> = { blocked: true; retryAfterSeconds: number } | { blocked: false; value: T };

export interface FailureLimiter {
  /** Seconds until the next attempt is allowed; 0 when attempts are open. */
  retryAfterSeconds(): number;
  /**
   * Runs one attempt if the limit allows it: counted up front, run alone (one at a time), held
   * for the delay when it fails, and uncounted when `succeeded(value)` says it worked.
   */
  attempt<T>(run: () => Promise<T>, succeeded: (value: T) => boolean): Promise<AttemptOutcome<T>>;
}

export function createFailureLimiter(
  options: { maxFailures?: number; windowMs?: number; delayMs?: number; now?: () => number; store?: FailureStore; sleep?: (ms: number) => Promise<void> } = {},
): FailureLimiter {
  const maxFailures = options.maxFailures ?? 10;
  const windowMs = options.windowMs ?? 10 * 60_000;
  const delayMs = options.delayMs ?? 1_000;
  const now = options.now ?? Date.now;
  const store = options.store ?? memoryFailureStore();
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  let queue: Promise<unknown> = Promise.resolve();

  const recent = () => {
    const cutoff = now() - windowMs;
    return store.load().filter((time) => time > cutoff);
  };
  const retryAfterSeconds = () => {
    const failures = recent();
    if (failures.length < maxFailures) return 0;
    return Math.max(1, Math.ceil((Math.min(...failures) + windowMs - now()) / 1000));
  };

  return {
    retryAfterSeconds,
    async attempt(run, succeeded) {
      // Check and count in one synchronous step, so parallel attempts see each other.
      const wait = retryAfterSeconds();
      if (wait > 0) return { blocked: true, retryAfterSeconds: wait };
      const stamp = now();
      store.save([...recent(), stamp]);
      const turn = queue.then(async () => {
        const value = await run().catch((error: unknown) => {
          if (delayMs > 0) return sleep(delayMs).then(() => Promise.reject(error));
          throw error;
        });
        if (succeeded(value)) {
          const failures = store.load();
          const index = failures.indexOf(stamp);
          if (index >= 0) store.save([...failures.slice(0, index), ...failures.slice(index + 1)]);
        } else if (delayMs > 0) {
          await sleep(delayMs);
        }
        return value;
      });
      queue = turn.catch(() => undefined);
      return { blocked: false, value: await turn };
    },
  };
}
