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
   * when unset.
   */
  timeout?: number;
  /**
   * Aborts the call; it then throws the signal's reason, as fetch does. It
   * only ends a call sooner: a signal which aborts later than the call's
   * timeout, or never, does not extend it.
   */
  signal?: AbortSignal;
}
