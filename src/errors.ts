import type { BatchResult, FailedCommand } from './batch.ts';
import type { BroadcastResult, ChannelResult } from './broadcast.ts';

/** How many failures a partial error names in its message; all stay in the error. */
const MAX_NAMED = 3;

/** The base of every error jscent throws. */
export class CentError extends Error {
  /**
   * Set on the error broadcastWithRetry rejects with when no attempt got a
   * reply - a timeout, say - to the key its attempts carried, made for the
   * call when the request had none: Centrifugo may have published, and a
   * retry with this key does not publish twice. Undefined on other errors.
   */
  declare idempotencyKey: string | undefined;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * An error of Centrifugo itself: it understood the request and refused it, or
 * failed to carry it out.
 *
 * Centrifugo identifies an error by its `code`; `serverMessage` is for people
 * and may change. Errors with a known code are thrown as the subclass for it -
 * `instanceof UnknownChannelError` - and any other code as ApiError itself:
 * Centrifugo adds codes from time to time, so match the ones you handle and
 * treat the rest by their class.
 */
export class ApiError extends CentError {
  /** The code subclasses stand for. */
  static readonly code: number = 0;

  /** Centrifugo's error code. */
  readonly code: number;

  /** Centrifugo's message, for people. */
  readonly serverMessage: string;

  /**
   * Set by Centrifugo when the same request may succeed if retried later - a
   * broker being unavailable, a rate limit - not because of the request. It
   * does not mean nothing was done: a publication may have happened, so retry
   * it with the same idempotencyKey. Centrifugo versions before the field
   * existed never set it; `retryable` takes that into account.
   */
  readonly temporary: boolean;

  constructor(code: number, serverMessage = '', temporary = false, proMethod = '') {
    let message = `${serverMessage || 'server error'} (code ${code})`;
    if (proMethod) {
      message += ` (${proMethod} is a Centrifugo PRO method: is the server Centrifugo OSS?)`;
    }
    super(message);
    this.code = code;
    this.serverMessage = serverMessage;
    this.temporary = temporary;
  }

  /** The error for code: the subclass of a known code, ApiError otherwise. */
  static fromCode(code: number, serverMessage = '', temporary = false, proMethod = ''): ApiError {
    const cls = BY_CODE.get(code) ?? ApiError;
    return new cls(code, serverMessage, temporary, proMethod);
  }
}

/** Code 100: an internal error of Centrifugo, temporary. */
export class InternalError extends ApiError {
  static override readonly code = 100;
}

/** Code 102: the channel is not in a namespace Centrifugo is configured with. */
export class UnknownChannelError extends ApiError {
  static override readonly code = 102;
}

/**
 * Code 104: what the request refers to was not found.
 *
 * A method only Centrifugo PRO has, sent in a batch to Centrifugo OSS, fails
 * with it too, instead of the 404 it gets when sent alone.
 */
export class NotFoundError extends ApiError {
  static override readonly code = 104;
}

/** Code 107: Centrifugo refused the request as invalid. */
export class BadRequestError extends ApiError {
  static override readonly code = 107;
}

/** Code 108: the feature is not available - history or presence off in the channel's namespace, say. */
export class NotAvailableError extends ApiError {
  static override readonly code = 108;
}

/** Code 111: a rate limit was reached, temporary. */
export class TooManyRequestsError extends ApiError {
  static override readonly code = 111;
}

/** Code 112: the stream position asked for is not in the history any more. */
export class UnrecoverablePositionError extends ApiError {
  static override readonly code = 112;
}

/** Code 113: the request conflicts with the current state - a map publish whose version check failed, say. */
export class ConflictError extends ApiError {
  static override readonly code = 113;
}

const BY_CODE = new Map<number, typeof ApiError>(
  [
    InternalError,
    UnknownChannelError,
    NotFoundError,
    BadRequestError,
    NotAvailableError,
    TooManyRequestsError,
    UnrecoverablePositionError,
    ConflictError,
  ].map((c) => [c.code, c]),
);

/**
 * A reply with an HTTP status other than 200: the request did not reach the API
 * method. A 401 is an UnauthorizedError.
 */
export class HTTPError extends CentError {
  /** The reply's HTTP status. */
  readonly status: number;

  /** The start of the reply's body, for diagnostics. */
  readonly body: string;

  /** The reply's headers: a request ID a proxy set, a Retry-After. */
  readonly headers: Headers;

  constructor(status: number, body = '', headers: Headers = new Headers(), proMethod = '') {
    let message = `unexpected HTTP status ${status}`;
    if (status >= 300 && status < 400) {
      // Centrifugo's API never redirects: something in front of it does, which
      // jscent does not follow.
      message += ' (a redirect, which jscent does not follow: check apiEndpoint, http or https say)';
    } else if (status === 404 && proMethod) {
      message += ` (${proMethod} is a Centrifugo PRO method: if other methods work, the server is Centrifugo OSS)`;
    } else if (status === 404) {
      // The usual cause: apiEndpoint lacks the API prefix.
      message += ' (is apiEndpoint the API base URL, such as http://localhost:8000/api?)';
    } else if (status === 401) {
      message += ' (check the credentials: apiKey or getBearerToken)';
    }
    if (body) {
      message += `: ${body}`;
    }
    super(message);
    this.status = status;
    this.body = body;
    this.headers = headers;
  }

  /** @internal */
  static fromStatus(status: number, body: string, headers: Headers, proMethod: string): HTTPError {
    return status === 401
      ? new UnauthorizedError(status, body, headers, proMethod)
      : new HTTPError(status, body, headers, proMethod);
  }
}

/** A 401: Centrifugo did not accept the credentials - the API key or the bearer token. */
export class UnauthorizedError extends HTTPError {}

/**
 * The reply is not a Centrifugo API reply. The usual cause is an apiEndpoint
 * which does not point at Centrifugo's API, so that something else - a proxy,
 * a web page - answers instead.
 */
export class DecodeError extends CentError {}

/**
 * A request the client can tell is wrong without sending it: one which cannot
 * be encoded - a payload which is not JSON, in any request - or a publication
 * without a channel or data. It is never sent.
 *
 * Only rules which hold for every Centrifugo are checked; everything else
 * Centrifugo checks itself, and reports as a BadRequestError.
 */
export class InvalidRequestError extends CentError {}

/** A configuration with a mistake: the message names the option and the fix. */
export class InvalidConfigError extends CentError {}

/** A call made after the client was closed. */
export class ClosedError extends CentError {}

/**
 * The request failed on its way: a refused or reset connection, a failed TLS
 * handshake. The cause is the fetch error.
 */
export class NetworkError extends CentError {
  /**
   * The server's TLS certificate was refused - an unknown CA, an expired
   * certificate, another host's: no retry fixes it, so retryable is false.
   * Told from the fetch error's cause unless given.
   */
  readonly certificate: boolean;

  constructor(message: string, options?: ErrorOptions & { certificate?: boolean }) {
    super(message, options);
    this.certificate = options?.certificate ?? certificateError(options?.cause);
  }
}

// Node.js's and Bun's codes for a refused certificate.
const CERTIFICATE_CODE = /^(?:CERT_|ERR_TLS_CERT|UNABLE_TO_(?:GET|VERIFY)|SELF_SIGNED|DEPTH_ZERO)/;

/** Whether err, or an error it was caused by, refused a TLS certificate. */
function certificateError(err: unknown): boolean {
  for (let e = err, depth = 0; e instanceof Error && depth < 8; e = e.cause, depth++) {
    const code = (e as { code?: unknown }).code;
    // Deno names it in the message: "invalid peer certificate: UnknownIssuer".
    if ((typeof code === 'string' && CERTIFICATE_CODE.test(code)) || /certificate/i.test(e.message)) {
      return true;
    }
  }
  return false;
}

/**
 * The request timed out: its `timeout`, or `requestTimeout`. A request which
 * timed out may still have been carried out. A call aborted by its own
 * `signal` throws the signal's reason instead, as fetch does.
 */
export class TimeoutError extends CentError {}

/** A pending command's result read before its batch was sent. */
export class BatchNotSentError extends CentError {}

/** A batch sent again: a batch is sent once. */
export class BatchSentError extends CentError {}

/**
 * A broadcast Centrifugo carried out which failed in one or more of its
 * channels, up to all of them. `result` holds every channel's outcome.
 *
 * It is not an ApiError of its parts: `instanceof UnknownChannelError` is false
 * for a broadcast in which one channel of many was unknown, and for one into a
 * single channel - the broadcast as a whole is not unknown. Look at each
 * channel's error in `failed`.
 */
export class BroadcastFailedChannelsError extends CentError {
  /** The channels which failed, with their errors, in the order of the request. */
  readonly failed: ChannelResult[];

  /** How many channels the broadcast had. */
  readonly total: number;

  /** Every channel's outcome. */
  readonly result: BroadcastResult;

  constructor(failed: ChannelResult[], total: number, result: BroadcastResult) {
    let message = failuresMessage(
      'broadcast',
      'channels',
      'got the publication',
      total,
      failed.map((f) => [f.channel, f.error]),
    );
    const retry = failed.filter((f) => f.error !== undefined && retryable(f.error));
    if (retry.length > 0) {
      message += ' (retry only retryableChannels(), with the same idempotencyKey)';
    }
    super(message);
    this.failed = failed;
    this.total = total;
    this.result = result;
  }

  /**
   * The channels whose failure is retryable, in the order of the request: the
   * channels a retry should go to, with the same idempotencyKey. Channels which
   * failed for good, such as an unknown channel, are left out.
   */
  retryableChannels(): string[] {
    return this.failed.filter((f) => f.error !== undefined && retryable(f.error)).map((f) => f.channel);
  }
}

/**
 * A batch in which one or more commands failed, up to all of them. Every
 * command got its own reply: each Pending holds its outcome. `result` is the
 * batch's.
 *
 * It is not an ApiError of its parts: look at each command's error in
 * `failed`, or at its Pending.
 */
export class BatchFailedCommandsError extends CentError {
  readonly failed: FailedCommand[];
  readonly total: number;
  readonly result: BatchResult;

  constructor(failed: FailedCommand[], total: number, result: BatchResult) {
    super(
      failuresMessage(
        'batch',
        'commands',
        'succeeded',
        total,
        failed.map((f) => [`#${f.index} ${f.method}`, f.error]),
      ),
    );
    this.failed = failed;
    this.total = total;
    this.result = result;
  }
}

/** "broadcast: 2 of 4 channels failed, 2 got the publication: a: ...; b: ..." */
function failuresMessage(op: string, parts: string, rest: string, total: number, items: [string, unknown][]): string {
  const failed = items.length;
  let s = `${op}: ${failed} of ${total} ${parts} failed`;
  if (failed < total) {
    s += `, ${total - failed} ${rest}`;
  }
  const named: string[] = [];
  for (const [i, [label, err]] of items.entries()) {
    if (i === MAX_NAMED) {
      named.push(`and ${failed - i} more`);
      break;
    }
    named.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return named.length > 0 ? `${s}: ${named.join('; ')}` : s;
}

/**
 * Whether a new attempt, with time left, may succeed after `err`: the error
 * came from a temporary condition, not from the request.
 *
 * Retryable are an ApiError Centrifugo marked temporary, and code 100 from
 * Centrifugo versions which did not mark errors yet; a network failure; a
 * timeout, also one of the caller's own signal; an HTTPError 429 or 5xx; a
 * broadcast or batch partial error with at least one retryable part.
 *
 * Not retryable are the request's own errors - an unknown channel, a bad
 * request, InvalidRequestError - and InvalidConfigError, ClosedError, an
 * aborted call, a DecodeError and rejected credentials.
 *
 * A retryable error does not mean nothing was done: retry a publication only
 * with the same idempotencyKey. Retry a broadcast with broadcastWithRetry, or
 * only its retryableChannels(): repeating the call resends to the channels
 * which already got it.
 */
export function retryable(err: unknown): boolean {
  if (err instanceof BroadcastFailedChannelsError) {
    return err.retryableChannels().length > 0;
  }
  if (err instanceof BatchFailedCommandsError) {
    return err.failed.some((f) => retryable(f.error));
  }
  if (err instanceof ApiError) {
    return err.temporary || err.code === InternalError.code;
  }
  if (err instanceof HTTPError) {
    return err.status === 429 || err.status >= 500;
  }
  if (err instanceof NetworkError) {
    return !err.certificate;
  }
  if (err instanceof TimeoutError) {
    return true;
  }
  // A caller's own AbortSignal.timeout(): a timeout, as any other.
  return err instanceof Error && err.name === 'TimeoutError';
}

/**
 * How an error in a result renders as JSON: `{code, message}` for an
 * ApiError, `{message}` for any other.
 *
 * @internal
 */
export function errorJSON(e: Error): { code?: number; message: string } {
  return e instanceof ApiError ? { code: e.code, message: e.serverMessage } : { message: e.message };
}
