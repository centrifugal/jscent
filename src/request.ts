import { InvalidRequestError } from './errors.ts';
import { checkKeys } from './options.ts';

/** The keys of CallOptions. */
const CALL_OPTIONS = ['timeout', 'signal'] as const;

/**
 * Refuses an unknown key of a call's options: a misspelled timeout would
 * otherwise leave the call bounded by requestTimeout.
 *
 * @internal
 */
export function checkCallOptions(options: object | undefined, extra: readonly string[] = []): void {
  if (options !== undefined && options !== null) {
    checkKeys(options, [...CALL_OPTIONS, ...extra], 'call option', (m) => new InvalidRequestError(m));
  }
}

/** The options of one call. */
export interface CallOptions {
  /**
   * Milliseconds bounding the call - connecting, sending, the reply's headers
   * and body - replacing requestTimeout, longer or shorter: requestTimeout
   * when unset. Zero or less is refused with InvalidRequestError: a call
   * cannot be left unbounded, nor given no time.
   */
  timeout?: number;
  /**
   * Aborts the call; it then throws the signal's reason, as fetch does. It
   * only ends a call sooner: a signal which aborts later than the call's
   * timeout, or never, does not extend it.
   */
  signal?: AbortSignal;
}

/** The options of a paging iterator: historyAll, deviceListAll and the rest. */
export interface PageOptions {
  /**
   * Milliseconds bounding each page's request, replacing requestTimeout for
   * it: requestTimeout when unset. Zero or less is refused with
   * InvalidRequestError. Nothing bounds the whole iteration but the loop - and
   * the signal.
   */
  pageTimeout?: number;
  /** Ends the iteration: the page in flight, and every later one, throw the signal's reason. */
  signal?: AbortSignal;
}

/**
 * The CallOptions of each page of an iterator with options, or
 * InvalidRequestError for an unknown key - `timeout`, which an iteration does
 * not take, names pageTimeout - or a pageTimeout not above zero.
 *
 * @internal
 */
export function pageCallOptions(method: string, options: PageOptions | undefined): CallOptions | undefined {
  if (options === undefined || options === null) {
    return undefined;
  }
  checkKeys(options, ['pageTimeout', 'signal'], `${method} option`, (m) => new InvalidRequestError(m), {
    timeout: 'pageTimeout',
  });
  const { pageTimeout, signal } = options;
  if (
    pageTimeout !== undefined &&
    (typeof pageTimeout !== 'number' || !Number.isFinite(pageTimeout) || pageTimeout <= 0)
  ) {
    throw new InvalidRequestError(
      `${method}: pageTimeout must be a positive number of milliseconds; leave it unset for requestTimeout`,
    );
  }
  return { timeout: pageTimeout, signal };
}
