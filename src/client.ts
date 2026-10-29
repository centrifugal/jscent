import { Batch, batchReplies, commandError } from './batch.ts';
import { apiError, BroadcastResult, type ChannelResult } from './broadcast.ts';
import {
  BroadcastFailedChannelsError,
  CentError,
  ClosedError,
  DecodeError,
  HTTPError,
  InvalidConfigError,
  InvalidRequestError,
  NetworkError,
  retryable,
  TimeoutError,
} from './errors.ts';
import { type BroadcastRequest, ClientMethods, METHODS } from './generated/api.ts';
import { checkKeys } from './options.ts';
import { checkBigIntegers, decodeJSON } from './payload.ts';
import { type CallOptions, checkCallOptions } from './request.ts';
import { type BroadcastAttempt, exponentialBackoff, wait } from './retry.ts';
import { encodeRequest } from './validate.ts';
import { decode, kindOf } from './wire.ts';

/** The User-Agent jscent sends, unless headers give another. */
export const USER_AGENT = 'jscent/1';

const DEFAULT_REQUEST_TIMEOUT = 10_000;
const DEFAULT_MAX_BATCH_SIZE = 1000;
const DEFAULT_MAX_ATTEMPTS = 2;
// The body of an unexpected status is read up to ERROR_BODY bytes for a
// Centrifugo error in it, ERROR_KEPT of it kept for the HTTPError, and the
// rest drained up to DRAIN, so that the connection is reused.
const ERROR_BODY = 4 << 10;
const ERROR_KEPT = 512;
const DRAIN = 64 << 10;
// Statuses Centrifugo's transport error mode maps errors to.
const TRANSPORT_MODE_STATUSES = new Set([400, 404, 409, 416, 429, 500]);

/** One HTTP request to Centrifugo's API, for onRequest. */
export interface RequestInfo {
  /** The API method: "publish", say, or "batch" for a batch. */
  readonly method: string;
  /** How many commands the request carried: 1, or a batch's size. */
  readonly commands: number;
  /**
   * How many of them Centrifugo answered with an error. A broadcast which
   * failed in some channels is not counted: its command was answered.
   */
  readonly failed: number;
  /** True for a batch made of concurrent calls by automatic batching. */
  readonly autoBatch: boolean;
  /** Milliseconds from before getting the endpoint and credentials to the reply read. */
  readonly duration: number;
  /** The HTTP status of the reply, 0 without one. */
  readonly status: number;
  /**
   * The request's own error: the network, a timeout, an HTTP status, a reply
   * which is not Centrifugo's, a request refused before sending - or, in the
   * transport error mode, the error of its one command. Undefined when
   * Centrifugo's reply was read.
   */
  readonly error: Error | undefined;
}

/**
 * Automatic batching: concurrent calls sent together, as one batch request,
 * once enough of them are in flight.
 *
 * Nothing waits for a batch to fill. While fewer than maxInFlight requests
 * are in flight, every call is sent at once, alone, exactly as without it.
 * Only a call made when maxInFlight requests are already in flight waits -
 * for one of them to finish, not for a timer. Then all the calls waiting at
 * that moment go out together, at most maxBatchSize of them. The busier the
 * client, the larger the batches, and the fewer requests Centrifugo handles
 * for the same work.
 *
 * Every call gets its own command's reply. Calls sharing a batch share its
 * request, though: when it fails as a whole - the network, the credentials, a
 * body too large for a proxy in front of Centrifugo (nginx refuses bodies
 * over 1 MB by default) - every call in it fails with that error.
 */
export interface AutoBatch {
  /**
   * How many requests may be in flight before calls start to wait and be
   * batched: about half the calls the process makes at once. Above that, it
   * never batches; just below, it batches calls one at a time, and only limits
   * them.
   */
  maxInFlight: number;
  /** The most calls one batch carries: 1000 by default. */
  maxBatchSize?: number;
}

/**
 * The fetch a Client sends with: the runtime's, or one of your own - undici's,
 * an instrumented one, a fake in tests. Only this much of fetch is used, so
 * any of them fits without a cast.
 */
export type Fetch = (url: string, init: FetchInit) => Promise<FetchResponse>;

/** What a Client passes its fetch: a POST of JSON text. */
export interface FetchInit {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  redirect: 'manual';
  signal: AbortSignal;
}

/** What a Client reads of fetch's response: any fetch's Response has it. */
export interface FetchResponse {
  readonly status: number;
  readonly type?: string;
  readonly headers: Headers;
  readonly body: {
    getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> };
  } | null;
  text(): Promise<string>;
}

/** The keys of ClientOptions. */
const CLIENT_OPTIONS = [
  'apiEndpoint',
  'getApiEndpoint',
  'apiKey',
  'getBearerToken',
  'fetch',
  'requestTimeout',
  'headers',
  'onRequest',
  'autoBatch',
  'bigIntegers',
] as const;

/** The options of a Client. */
export interface ClientOptions {
  /**
   * The base URL of the API, "http://localhost:8000/api". Each method is sent
   * to it plus its name, "/publish".
   */
  apiEndpoint?: string;
  /** Instead of apiEndpoint, returns it for each request, for addresses discovered rather than fixed. */
  getApiEndpoint?: () => string | Promise<string>;
  /**
   * Sent as X-API-Key. Leave it and getBearerToken unset when requests are
   * authenticated another way - mutual TLS, a proxy - or not at all.
   */
  apiKey?: string;
  /**
   * Returns the token sent as "Authorization: Bearer" with each request, for
   * Centrifugo PRO's JWKS authentication of the API - an ApiTokens's token,
   * say. Not together with apiKey.
   */
  getBearerToken?: () => string | Promise<string>;
  /**
   * The fetch sending the requests: the runtime's own by default. Pass your
   * own - with an undici dispatcher, say, or instrumented for tracing. It is
   * called with each request's credentials and headers, never changed.
   */
  fetch?: Fetch;
  /** Milliseconds bounding a call without a timeout of its own: 10 seconds by default. */
  requestTimeout?: number;
  /**
   * Extra headers for every request, for a proxy in front of Centrifugo. Not
   * X-API-Key, Authorization or Content-Type. A User-Agent replaces jscent's.
   */
  headers?: Record<string, string>;
  /**
   * Called after every HTTP request, for metrics; the call waits for it. It
   * must not throw: what it throws rejects the call in place of its outcome.
   */
  onRequest?: (info: RequestInfo) => void;
  /** Sends calls made concurrently in batches: see AutoBatch. */
  autoBatch?: AutoBatch;
  /**
   * Decodes integers past 2^53 in payloads as bigint, as centrifuge-js does:
   * false by default, when they are rounded to the nearest number. See the
   * README before turning it on: a field's type then follows its value.
   */
  bigIntegers?: boolean;
}

/** The options of broadcastWithRetry. */
export interface BroadcastRetryOptions extends CallOptions {
  /** How many attempts at most: 2 by default, one retry. */
  maxAttempts?: number;
  /** Milliseconds bounding each attempt: requestTimeout by default. */
  attemptTimeout?: number;
  /**
   * Called after an attempt which failed in a way a retry may fix, except the
   * last. It returns the milliseconds to wait before the next attempt, or
   * undefined for the default wait - exponentialBackoff(100, 5000) of the
   * attempt - and may log or count meanwhile. To stop, it throws: its error
   * propagates as it is. The wait never outlasts the call's timeout.
   */
  onAttemptError?: (attempt: BroadcastAttempt) => number | undefined | Promise<number | undefined>;
}

/**
 * Calls Centrifugo's HTTP server API. Create it once and share it: it is
 * safe for concurrent use.
 *
 * ```ts
 * const client = new Client({ apiEndpoint: 'http://localhost:8000/api', apiKey: process.env.CENTRIFUGO_API_KEY });
 * await client.publish({ channel: 'news', data: { text: 'hello' } });
 * ```
 *
 * Every API method takes its request and resolves to its result, rejecting
 * unless Centrifugo did everything asked. Each takes `{ timeout, signal }`;
 * without a timeout, requestTimeout bounds the call.
 */
export class Client extends ClientMethods {
  readonly #endpoint: string;
  readonly #endpointFunc: (() => string | Promise<string>) | undefined;
  readonly #tokenFunc: (() => string | Promise<string>) | undefined;
  readonly #fetch: Fetch;
  readonly #requestTimeout: number;
  readonly #headers: Record<string, string>;
  readonly #onRequest: ((info: RequestInfo) => void) | undefined;
  readonly #bigIntegers: boolean;
  readonly #batcher: AutoBatcher | undefined;
  #closed = false;
  #active = 0;
  #idle: (() => void)[] = [];

  /** @throws InvalidConfigError naming the option and the fix */
  constructor(options: ClientOptions) {
    super();
    const o = options ?? {};
    checkKeys(o, CLIENT_OPTIONS, 'client option', (m) => new InvalidConfigError(m), {
      url: 'apiEndpoint',
      timeout: 'requestTimeout',
      secret: 'apiKey',
      strictSSL: 'fetch',
    });
    if (o.apiEndpoint === undefined && o.getApiEndpoint === undefined) {
      throw new InvalidConfigError('apiEndpoint is required, for example http://localhost:8000/api');
    }
    if (o.apiEndpoint !== undefined && o.getApiEndpoint !== undefined) {
      throw new InvalidConfigError('set apiEndpoint or getApiEndpoint, not both');
    }
    this.#endpoint = o.apiEndpoint !== undefined ? checkEndpoint(o.apiEndpoint, 'apiEndpoint') : '';
    this.#endpointFunc = callable(o.getApiEndpoint, 'getApiEndpoint');

    const apiKey = o.apiKey ?? '';
    if (typeof apiKey !== 'string') {
      throw new InvalidConfigError(`apiKey must be a string, not ${kindOf(apiKey)}`);
    }
    if (apiKey && o.getBearerToken !== undefined) {
      throw new InvalidConfigError(
        'set apiKey or getBearerToken, not both: a request with a bearer token is judged by the token alone',
      );
    }
    if (!validHeaderValue(apiKey)) {
      throw new InvalidConfigError('apiKey must be printable ASCII: no line breaks, control or non-ASCII characters');
    }
    this.#tokenFunc = callable(o.getBearerToken, 'getBearerToken');

    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(o.headers ?? {})) {
      const lower = name.toLowerCase();
      if (lower === 'x-api-key') {
        throw new InvalidConfigError('headers may not set X-API-Key; use apiKey');
      }
      if (lower === 'authorization') {
        throw new InvalidConfigError('headers may not set Authorization; use getBearerToken');
      }
      if (lower === 'content-type') {
        throw new InvalidConfigError('headers may not set Content-Type');
      }
      if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
        throw new InvalidConfigError(`headers: "${name}" is not a valid HTTP header name`);
      }
      if (typeof value !== 'string' || !validHeaderValue(value)) {
        throw new InvalidConfigError(
          `headers: ${name} must be a string of printable ASCII: no line breaks, control or non-ASCII characters`,
        );
      }
      if (lower === 'host' && value === '') {
        throw new InvalidConfigError('headers: Host must not be empty');
      }
      headers[name] = value;
    }
    headers['Content-Type'] = 'application/json';
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'user-agent')) {
      headers['User-Agent'] = USER_AGENT;
    }
    if (apiKey) {
      headers['X-API-Key'] = apiKey;
    }
    this.#headers = headers;

    const timeout = o.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT;
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
      throw new InvalidConfigError('requestTimeout must be a positive number of milliseconds');
    }
    this.#requestTimeout = timeout;
    this.#onRequest = callable(o.onRequest, 'onRequest');
    const f = o.fetch ?? globalThis.fetch;
    if (typeof f !== 'function') {
      throw new InvalidConfigError('fetch must be a function; this runtime has no global fetch: pass one');
    }
    this.#fetch = f;
    this.#bigIntegers = o.bigIntegers === true;
    if (this.#bigIntegers) {
      checkBigIntegers();
    }
    if (o.autoBatch !== undefined) {
      checkKeys(o.autoBatch, ['maxInFlight', 'maxBatchSize'], 'autoBatch option', (m) => new InvalidConfigError(m));
      const { maxInFlight, maxBatchSize = DEFAULT_MAX_BATCH_SIZE } = o.autoBatch;
      if (!Number.isInteger(maxInFlight) || maxInFlight < 1) {
        throw new InvalidConfigError('autoBatch.maxInFlight must be 1 or more; leave autoBatch unset to disable it');
      }
      if (!Number.isInteger(maxBatchSize) || maxBatchSize < 2) {
        throw new InvalidConfigError('autoBatch.maxBatchSize must be 2 or more: a batch of 1 never batches');
      }
      this.#batcher = new AutoBatcher(this, maxInFlight, maxBatchSize);
    }
  }

  // Broadcast.

  /**
   * Publishes the same data into many channels in one request.
   *
   * Channels succeed or fail on their own. It resolves when every channel got
   * the publication. When Centrifugo carried the broadcast out and one or more
   * channels failed - up to all of them - it rejects with
   * BroadcastFailedChannelsError, whose `result` holds every channel's
   * outcome. Any other error means it failed as a whole: no channel got a
   * reply. After a timeout or a network error Centrifugo may still have
   * published it.
   *
   * To go on despite some failed channels:
   *
   * ```ts
   * try {
   *   await client.broadcast(request);
   * } catch (e) {
   *   if (!(e instanceof BroadcastFailedChannelsError)) throw e;
   *   logger.warn('broadcast failed in some channels', e.result.failed);
   * }
   * ```
   *
   * Retry it with broadcastWithRetry, which sends again only the channels
   * which may still succeed, with one idempotencyKey.
   */
  async broadcast(request: BroadcastRequest, options?: CallOptions): Promise<BroadcastResult> {
    const channels = [...(request?.channels ?? [])];
    const result = await this.#result('broadcast', request, options);
    return BroadcastResult.fromWire(result, 'broadcast result', channels, request.idempotencyKey ?? '').check();
  }

  /**
   * Broadcasts as broadcast does, and retries the channels which failed for a
   * temporary reason - see retryable - up to maxAttempts (2 by default: one
   * retry).
   *
   * - Only the channels which may still succeed are sent again; when only
   *   channels which failed for good are left, it stops.
   * - Every attempt carries the same idempotencyKey - made for the call when
   *   the request has none - so that a channel which got the publication in an
   *   earlier attempt does not get it again. The memory, Redis and PostgreSQL
   *   brokers keep keys; the NATS broker ignores them, and a retry may publish
   *   again.
   * - The result holds every channel's last outcome, and the key: retrying
   *   later with it publishes only into the channels which did not get it.
   *
   * `timeout`, when set, bounds the whole call, waits included;
   * `attemptTimeout` - requestTimeout by default - bounds each attempt.
   * `onAttemptError` decides the wait between attempts, and may stop them. It
   * rejects as broadcast does.
   */
  async broadcastWithRetry(request: BroadcastRequest, options: BroadcastRetryOptions = {}): Promise<BroadcastResult> {
    checkCallOptions(options, ['maxAttempts', 'attemptTimeout', 'onAttemptError']);
    const { maxAttempts = DEFAULT_MAX_ATTEMPTS, attemptTimeout, onAttemptError, timeout, signal } = options;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new InvalidRequestError('invalid broadcast request: maxAttempts must be 1 or more');
    }
    if (attemptTimeout !== undefined && (!Number.isFinite(attemptTimeout) || attemptTimeout <= 0)) {
      throw new InvalidRequestError('invalid broadcast request: attemptTimeout must be positive');
    }
    encodeRequest('broadcast', request);
    // Without a timeout the call has no bound of its own: each attempt has
    // attemptTimeout, or requestTimeout as a call alone would, so that an
    // attempt which hangs leaves time to retry.
    const deadline = timeout !== undefined ? this.#deadline(timeout) : Number.POSITIVE_INFINITY;
    const perAttempt = attemptTimeout ?? this.#requestTimeout;
    const channels = [...(request.channels ?? [])];
    const key = request.idempotencyKey || `jscent-${randomKey()}`;
    const final: ChannelResult[] = channels.map((channel) => ({
      channel,
      result: undefined,
      error: undefined,
      attempts: 0,
    }));
    // Positions in channels of what the next attempt sends: positions, not
    // names, so that a channel listed twice keeps both entries.
    let pending = channels.map((_, i) => i);
    let replied = false;
    let attempts = 0;
    let last: Error | undefined;
    const backoff = exponentialBackoff(100, 5_000);
    const result = () => new BroadcastResult([...final], key, attempts, replied);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const left = deadline - performance.now();
      if (left <= 0) {
        last ??= new TimeoutError('broadcast: timed out');
        break;
      }
      const attemptReq: BroadcastRequest = {
        ...request,
        channels: pending.map((p) => channels[p]!),
        idempotencyKey: key,
      };
      let res: BroadcastResult;
      let err: Error | undefined;
      try {
        res = await this.broadcast(attemptReq, { timeout: Math.min(left, perAttempt), signal });
      } catch (e) {
        if (e instanceof BroadcastFailedChannelsError) {
          res = e.result;
          err = e;
        } else if (e instanceof CentError && !(e instanceof InvalidRequestError)) {
          res = BroadcastResult.failedAsWhole(attemptReq.channels ?? [], e, 1, key);
          err = e;
        } else {
          throw e;
        }
      }
      attempts++;
      for (const [i, pos] of pending.entries()) {
        final[pos] = { ...res.channels[i]!, attempts: final[pos]!.attempts + 1 };
      }
      if (err === undefined || err instanceof BroadcastFailedChannelsError) {
        replied = true;
      }
      last = err;
      // An ended deadline leaves no time for another attempt.
      if (err === undefined || !retryable(err) || attempt === maxAttempts || performance.now() >= deadline) {
        break;
      }
      pending = pending.filter((pos) => final[pos]!.error !== undefined && retryable(final[pos]!.error));
      const waitFor =
        (onAttemptError !== undefined
          ? await onAttemptError({
              attempt,
              error: err,
              retry: pending.map((p) => final[p]!),
              result: result(),
              idempotencyKey: key,
            })
          : undefined) ?? backoff(attempt);
      await wait(Math.min(waitFor, deadline - performance.now()), signal);
      this.checkOpen();
    }
    if (!replied) {
      if (last instanceof CentError) {
        last.idempotencyKey = key;
      }
      throw last ?? new Error('jscent: broadcastWithRetry: no reply and no error');
    }
    return result().check();
  }

  // Batches.

  /**
   * An empty Batch sent by this client. Without `parallel` the commands run
   * one by one, in the order added - but Centrifugo PRO sends a sequential
   * batch's publications to its broker together: each channel's take effect in
   * order, publications into different channels may not, unless the
   * namespace sets publication_grouping_disabled. With `parallel`, Centrifugo
   * runs them concurrently, with no order.
   */
  newBatch(options: { parallel?: boolean } = {}): Batch {
    checkKeys(options, ['parallel'], 'batch option', (m) => new InvalidRequestError(m));
    return new Batch(this, options.parallel === true);
  }

  // Shutdown.

  /**
   * Stops the client: calls made from now on reject with ClosedError, and
   * close waits for the calls in progress to end - automatic batches
   * included. A broadcast being retried stops at its next attempt. With
   * `timeout`, in milliseconds, it rejects with TimeoutError when calls are
   * still in progress then; they go on, and close may be called again.
   *
   * Call it when the application shuts down, so that what was accepted is
   * sent before the process exits.
   */
  async close(options: { timeout?: number } = {}): Promise<void> {
    this.#closed = true;
    if (this.#active === 0) {
      return;
    }
    const idle = new Promise<void>((resolve) => this.#idle.push(resolve));
    if (options.timeout === undefined) {
      return idle;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<void>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError('close: calls still in progress')), options.timeout);
    });
    try {
      await Promise.race([idle, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  // Sending.

  /** @internal */
  protected override async invoke<T>(method: string, request: object, options: CallOptions | undefined): Promise<T> {
    const result = await this.#result(method, request, options);
    return decode<T>(METHODS[method]?.result ?? [], result, `${method} result`);
  }

  async #result(method: string, request: object, options: CallOptions | undefined): Promise<unknown> {
    checkCallOptions(options);
    const json = encodeRequest(method, request);
    const deadline = this.#deadline(options?.timeout);
    this.#enter();
    try {
      const alone = async (): Promise<[Record<string, unknown>, Error | undefined]> =>
        this.#call(method, json, 1, deadline, options?.signal, false, (d) => {
          const out = envelope(d, method);
          return [out, out[1] === undefined ? 0 : 1];
        });
      let result: Record<string, unknown>;
      let err: Error | undefined;
      if (this.#batcher === undefined) {
        [result, err] = await alone();
      } else {
        const out = await this.#batcher.call(
          `{${JSON.stringify(method)}:${json}}`,
          method,
          deadline,
          options?.signal,
          alone,
        );
        if (out.alone) {
          [result, err] = out.value;
        } else {
          err = commandError(out.reply, out.index, method);
          result = (out.reply[method] ?? {}) as Record<string, unknown>;
          if (typeof result !== 'object' || result === null || Array.isArray(result)) {
            throw new DecodeError(`replies[${out.index}].${method}: expected an object, got ${kindOf(result)}`);
          }
        }
      }
      if (err !== undefined) {
        throw err;
      }
      return result;
    } finally {
      this.#leave();
    }
  }

  /** @internal */
  async sendBatch(
    body: string,
    n: number,
    options: CallOptions | undefined,
    auto: boolean,
    deadline?: number,
  ): Promise<Record<string, unknown>[]> {
    if (!auto) {
      this.#enter();
    }
    try {
      return await this.#call(
        'batch',
        body,
        n,
        deadline ?? this.#deadline(options?.timeout),
        options?.signal,
        auto,
        (d) => {
          const replies = batchReplies(d, n);
          return [replies, replies.filter((r) => r.error !== undefined && r.error !== null).length];
        },
      );
    } finally {
      if (!auto) {
        this.#leave();
      }
    }
  }

  /** @internal */
  get requestTimeout(): number {
    return this.#requestTimeout;
  }

  /** @internal Throws ClosedError after close. */
  checkOpen(): void {
    if (this.#closed) {
      throw new ClosedError('client closed');
    }
  }

  /** @internal Counts in a call, closed or not: an automatic batch which outlives its callers. */
  enterWork(): void {
    this.#active++;
  }

  /** @internal */
  leaveWork(): void {
    this.#leave();
  }

  #enter(): void {
    this.checkOpen();
    this.#active++;
  }

  #leave(): void {
    this.#active--;
    if (this.#active === 0) {
      const idle = this.#idle;
      this.#idle = [];
      for (const resolve of idle) {
        resolve();
      }
    }
  }

  #deadline(timeout: number | undefined): number {
    if (timeout === undefined) {
      return performance.now() + this.#requestTimeout;
    }
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout < 0) {
      throw new InvalidRequestError('timeout must be a non-negative number of milliseconds');
    }
    return performance.now() + timeout;
  }

  async #call<T>(
    method: string,
    body: string,
    commands: number,
    deadline: number,
    signal: AbortSignal | undefined,
    auto: boolean,
    parse: (decoded: unknown) => [T, number],
  ): Promise<T> {
    const start = performance.now();
    let status = 0;
    try {
      const raw = await this.#roundtrip(method, body, deadline, signal, (s) => {
        status = s;
      });
      const [out, failed] = parse(decodeJSON(raw, method, this.#bigIntegers));
      this.#report({
        method,
        commands,
        failed,
        autoBatch: auto,
        duration: performance.now() - start,
        status,
        error: undefined,
      });
      return out;
    } catch (e) {
      this.#report({
        method,
        commands,
        failed: 0,
        autoBatch: auto,
        duration: performance.now() - start,
        status,
        error: e as Error,
      });
      throw e;
    }
  }

  async #roundtrip(
    method: string,
    body: string,
    deadline: number,
    signal: AbortSignal | undefined,
    setStatus: (s: number) => void,
  ): Promise<string> {
    let base = this.#endpoint;
    if (this.#endpointFunc !== undefined) {
      base = checkEndpoint(await this.#endpointFunc(), 'getApiEndpoint');
    }
    const headers = { ...this.#headers };
    if (this.#tokenFunc !== undefined) {
      const token = await this.#tokenFunc();
      if (typeof token !== 'string' || token === '' || !validHeaderValue(token)) {
        throw new InvalidConfigError(
          'getBearerToken returned an empty token, not a string, or one which is not printable ASCII',
        );
      }
      headers.Authorization = `Bearer ${token}`;
    }
    const left = deadline - performance.now();
    if (left <= 0) {
      throw new TimeoutError(`${method}: timed out`);
    }
    signal?.throwIfAborted();
    const timeoutSignal = AbortSignal.timeout(Math.max(1, Math.ceil(left)));
    const combined = signal !== undefined ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const fail = (e: unknown): never => {
      if (signal?.aborted) {
        throw signal.reason;
      }
      if (timeoutSignal.aborted) {
        throw new TimeoutError(`${method}: timed out`, { cause: e });
      }
      if (e instanceof CentError) {
        throw e;
      }
      throw new NetworkError(`${method}: ${(e as Error)?.message ?? String(e)}`, { cause: e });
    };
    let resp: FetchResponse;
    try {
      resp = await this.#fetch(`${base}/${method}`, {
        method: 'POST',
        headers,
        body,
        redirect: 'manual',
        signal: combined,
      });
    } catch (e) {
      return fail(e);
    }
    const status = resp.type === 'opaqueredirect' ? 302 : resp.status;
    setStatus(status);
    try {
      if (status !== 200) {
        const errorBody = await readBounded(resp, ERROR_BODY, DRAIN);
        throw httpError(method, status, errorBody, resp.headers);
      }
      return await resp.text();
    } catch (e) {
      return fail(e);
    }
  }

  #report(info: RequestInfo): void {
    this.#onRequest?.(info);
  }
}

/** A function option, or InvalidConfigError. */
function callable<F>(f: F | undefined, name: string): F | undefined {
  if (f !== undefined && typeof f !== 'function') {
    throw new InvalidConfigError(`${name} must be a function`);
  }
  return f;
}

/** Printable ASCII and tab: what HTTP header values carry without an encoding. */
function validHeaderValue(v: string): boolean {
  return /^[\x20-\x7e\t]*$/.test(v);
}

/** The endpoint without a trailing slash, or InvalidConfigError naming what is wrong. */
function checkEndpoint(addr: unknown, option: string): string {
  if (typeof addr !== 'string') {
    throw new InvalidConfigError(`${option} must be a string, not ${kindOf(addr)}`);
  }
  let u: URL;
  try {
    u = new URL(addr);
  } catch {
    throw new InvalidConfigError(`${option}: "${addr}" must be an absolute http:// or https:// URL`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new InvalidConfigError(`${option}: "${addr}" must be an absolute http:// or https:// URL`);
  }
  if (u.hostname === '') {
    throw new InvalidConfigError(`${option}: "${addr}" has no host`);
  }
  if (
    u.search !== '' ||
    u.hash !== '' ||
    addr.includes('?') ||
    addr.includes('#') ||
    u.username !== '' ||
    u.password !== ''
  ) {
    throw new InvalidConfigError(`${option}: "${addr}" must not have a query, fragment or credentials; use apiKey`);
  }
  const path = u.pathname.replace(/\/+$/, '');
  const last = path.slice(path.lastIndexOf('/') + 1);
  if (last in METHODS) {
    throw new InvalidConfigError(
      `${option}: "${addr}" ends with the method "${last}"; it is the API base URL, such as http://localhost:8000/api`,
    );
  }
  return `${u.protocol}//${u.host}${path}`;
}

/** A method's reply: its result, or its error. */
function envelope(d: unknown, method: string): [Record<string, unknown>, Error | undefined] {
  if (typeof d !== 'object' || d === null || Array.isArray(d)) {
    throw new DecodeError(`${method}: the reply is not a JSON object`);
  }
  const body = d as { error?: unknown; result?: unknown };
  if (body.error !== undefined && body.error !== null) {
    return [{}, apiError(body.error, 'error', '')];
  }
  if (body.result === undefined || body.result === null) {
    return [{}, undefined];
  }
  if (typeof body.result !== 'object' || Array.isArray(body.result)) {
    throw new DecodeError(`${method}: result: expected an object, got ${kindOf(body.result)}`);
  }
  return [body.result as Record<string, unknown>, undefined];
}

/**
 * The error of a reply with status other than 200: a Centrifugo error in the
 * transport error mode, an HTTPError otherwise.
 */
function httpError(method: string, status: number, body: string, headers: Headers): Error {
  if (TRANSPORT_MODE_STATUSES.has(status)) {
    let d: unknown;
    try {
      d = JSON.parse(body);
    } catch {
      d = undefined;
    }
    // A body whose code is an HTTP error status - {"code": 429} from a rate
    // limiting gateway - is a gateway's, not Centrifugo's.
    const code = (d as { code?: unknown } | undefined)?.code;
    if (typeof d === 'object' && d !== null && Number.isInteger(code)) {
      const c = code as number;
      if (c >= 100 && (c < 400 || c >= 600)) {
        try {
          return apiError(d, 'error', '');
        } catch {
          // Not Centrifugo's after all.
        }
      }
    }
  }
  return HTTPError.fromStatus(status, body.slice(0, ERROR_KEPT).trim(), headers, METHODS[method]?.pro ? method : '');
}

/** A body's start, keep bytes of it, the rest read up to drain bytes so the connection is reused. */
async function readBounded(resp: FetchResponse, keep: number, drain: number): Promise<string> {
  if (resp.body === null) {
    return '';
  }
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let read = 0;
  try {
    while (read < drain) {
      const { done, value } = await reader.read();
      if (done || value === undefined) {
        break;
      }
      read += value.byteLength;
      if (kept < keep) {
        const part = value.subarray(0, keep - kept);
        chunks.push(part);
        kept += part.byteLength;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const all = new Uint8Array(kept);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

function randomKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

// Automatic batching.

interface Queued {
  command: string;
  deadline: number;
  taken: boolean;
  gone: boolean;
  index: number;
  reply: Record<string, unknown>;
  error: Error | undefined;
  done: boolean;
  wake: () => void;
}

type CallOutcome<T> = { alone: true; value: T } | { alone: false; index: number; reply: Record<string, unknown> };

/** AutoBatch for a Client: calls queue once maxInFlight requests are in flight. */
class AutoBatcher {
  readonly #client: Client;
  readonly #maxInFlight: number;
  readonly #maxBatch: number;
  #inFlight = 0;
  #queue: Queued[] = [];

  constructor(client: Client, maxInFlight: number, maxBatch: number) {
    this.#client = client;
    this.#maxInFlight = maxInFlight;
    this.#maxBatch = maxBatch;
  }

  async call<T>(
    command: string,
    method: string,
    deadline: number,
    signal: AbortSignal | undefined,
    alone: () => Promise<T>,
  ): Promise<CallOutcome<T>> {
    this.#dropGone();
    if (this.#inFlight < this.#maxInFlight && this.#queue.length === 0) {
      this.#inFlight++;
      try {
        return { alone: true, value: await alone() };
      } finally {
        this.#release();
      }
    }
    // The command was encoded before it queued: the batch never reads the
    // caller's request.
    const q: Queued = {
      command,
      deadline,
      taken: false,
      gone: false,
      index: 0,
      reply: {},
      error: undefined,
      done: false,
      wake: () => {},
    };
    const done = new Promise<void>((resolve) => {
      q.wake = resolve;
    });
    this.#queue.push(q);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const stop = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, deadline - performance.now()));
      if (signal !== undefined) {
        onAbort = resolve;
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    try {
      await Promise.race([done, stop]);
    } finally {
      clearTimeout(timer);
      if (onAbort !== undefined) {
        signal?.removeEventListener('abort', onAbort);
      }
    }
    // A reply which came as the deadline ended is the call's outcome.
    if (!q.done) {
      if (!q.taken) {
        q.gone = true;
      }
      if (signal?.aborted) {
        throw signal.reason;
      }
      throw new TimeoutError(q.taken ? `${method}: timed out` : `${method}: timed out before it was sent`);
    }
    if (q.error !== undefined) {
      throw q.error;
    }
    return { alone: false, index: q.index, reply: q.reply };
  }

  #dropGone(): void {
    while (this.#queue.length > 0 && this.#queue[0]!.gone) {
      this.#queue.shift();
    }
  }

  /** Hands the slot of a finished request to the calls waiting, if any, and frees it otherwise. */
  #release(): void {
    this.#dropGone();
    if (this.#queue.length === 0) {
      this.#inFlight--;
      return;
    }
    const items: Queued[] = [];
    while (this.#queue.length > 0 && items.length < this.#maxBatch) {
      const q = this.#queue.shift()!;
      if (q.gone) {
        continue;
      }
      q.taken = true;
      q.index = items.length;
      items.push(q);
    }
    // Counted as work: close waits for it, whose callers may be gone.
    this.#client.enterWork();
    void this.#flush(items);
  }

  async #flush(items: Queued[]): Promise<void> {
    try {
      if (items.length === 0) {
        return;
      }
      // Parallel: the calls were made concurrently, so nothing orders them.
      const body = `{"commands":[${items.map((q) => q.command).join(',')}],"parallel":true}`;
      // Until the latest deadline of its calls, and never less than
      // requestTimeout from now: no caller's deadline cuts it short for the
      // others.
      const deadline = Math.max(performance.now() + this.#client.requestTimeout, ...items.map((q) => q.deadline));
      try {
        const replies = await this.#client.sendBatch(body, items.length, undefined, true, deadline);
        for (const [i, q] of items.entries()) {
          q.reply = replies[i]!;
          q.done = true;
          q.wake();
        }
      } catch (e) {
        for (const q of items) {
          q.error = e as Error;
          q.done = true;
          q.wake();
        }
      }
    } finally {
      this.#release();
      this.#client.leaveWork();
    }
  }
}
