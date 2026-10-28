import type { BroadcastResult, ChannelResult } from './broadcast.ts';

/**
 * The wait, in milliseconds, before retrying after a failed attempt, attempt 1
 * being the first failure: `base` after it, twice as long after each next
 * one, up to `limit`. Each wait is a random time between half of it and all of
 * it, so that clients which failed together do not all retry at the same
 * moment. A negative base counts as zero, a limit below base as base, and an
 * attempt below 1 as 1.
 *
 * In a retry loop of your own - a publication retried with the same
 * idempotencyKey:
 *
 * ```ts
 * const backoff = exponentialBackoff(100, 2_000);
 * for (let attempt = 1; ; attempt++) {
 *   try {
 *     return await client.publish(request);
 *   } catch (e) {
 *     if (!retryable(e) || attempt === 3) throw e;
 *   }
 *   await wait(backoff(attempt), signal);
 * }
 * ```
 *
 * Retry a broadcast with broadcastWithRetry instead: repeating it resends to
 * the channels which already got it.
 */
export function exponentialBackoff(base: number, limit: number): (attempt: number) => number {
  base = Math.max(base, 0);
  limit = Math.max(limit, base);
  return (attempt) => {
    let d = base;
    // A zero base never grows: nothing to double.
    for (let i = 1; i < Math.max(attempt, 1) && d < limit && d > 0; i++) {
      d *= 2;
    }
    d = Math.min(d, limit);
    return d / 2 + Math.random() * (d / 2);
  };
}

/**
 * Waits `ms` milliseconds, or until `signal` aborts - then it throws the
 * signal's reason: the wait between retries, which a deadline or a
 * cancellation ends.
 */
export function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(
      () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      },
      Math.max(0, ms),
    );
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** A failed attempt of broadcastWithRetry, given to its onAttemptError. */
export interface BroadcastAttempt {
  /** The attempt which failed, from 1. */
  readonly attempt: number;
  /**
   * Its error: BroadcastFailedChannelsError when Centrifugo replied and some
   * channels failed, otherwise the error of the request as a whole.
   */
  readonly error: Error;
  /**
   * The channels the next attempt sends, with the errors this attempt failed
   * them with. A broadcast to many channels which all failed lists every one:
   * log a count or a few.
   */
  readonly retry: ChannelResult[];
  /** Every channel's outcome so far, as the call would return it if it stopped now. */
  readonly result: BroadcastResult;
  /** The key every attempt is sent with. */
  readonly idempotencyKey: string;
}
