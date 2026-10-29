// The application side of Centrifugo's HTTP proxy: the requests Centrifugo
// sends to the backend when a client connects, subscribes, publishes or calls
// an RPC, the results the backend answers with, and a handler for each proxy
// type which decodes the request, calls a function and encodes its answer.
// See https://centrifugal.dev/docs/server/proxy.

import { CentError } from '../errors.ts';
import {
  type ConnectRequest,
  ConnectRequestFields,
  type ConnectResult,
  ConnectResultFields,
  type MapPublishRequest,
  MapPublishRequestFields,
  type MapPublishResult,
  MapPublishResultFields,
  type MapRemoveRequest,
  MapRemoveRequestFields,
  type MapRemoveResult,
  MapRemoveResultFields,
  type NotifyCacheEmptyRequest,
  NotifyCacheEmptyRequestFields,
  type NotifyCacheEmptyResult,
  NotifyCacheEmptyResultFields,
  type NotifyChannelStateRequest,
  NotifyChannelStateRequestFields,
  type NotifyChannelStateResult,
  NotifyChannelStateResultFields,
  type PublishRequest,
  PublishRequestFields,
  type PublishResult,
  PublishResultFields,
  type RefreshRequest,
  RefreshRequestFields,
  type RefreshResult,
  RefreshResultFields,
  type RPCRequest,
  RPCRequestFields,
  type RPCResult,
  RPCResultFields,
  type SharedPollRefreshRequest,
  SharedPollRefreshRequestFields,
  type SharedPollRefreshResult,
  SharedPollRefreshResultFields,
  type SubRefreshRequest,
  SubRefreshRequestFields,
  type SubRefreshResult,
  SubRefreshResultFields,
  type SubscribeRequest,
  SubscribeRequestFields,
  type SubscribeResult,
  SubscribeResultFields,
} from '../generated/proxy.ts';
import { allow, Handler, type HttpRequest, type HttpResponse, type OnError } from '../http.ts';
import { decodeJSON } from '../payload.ts';
import { decode, encode, type Fields } from '../wire.ts';

export * from '../generated/proxy.ts';

/**
 * The default bound of a request's body, 16 MiB: far above what Centrifugo's
 * own limits on client messages let through, it only stops a request which is
 * not Centrifugo's from taking the memory it likes.
 */
export const DEFAULT_MAX_BODY = 16 << 20;

/**
 * Thrown by a proxy function to reject the client's request with this error: a
 * code in [400, 1999], which Centrifugo leaves to applications. temporary tells
 * the client that retrying may succeed.
 */
export class ProxyError extends Error {
  /** The error code: in [400, 1999]. */
  readonly code: number;
  /** Tells the client that retrying may succeed. */
  readonly temporary: boolean;

  constructor(code: number, message = '', temporary = false, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProxyError';
    this.code = code;
    this.temporary = temporary;
  }
}

/**
 * Thrown by a proxy function to close the client's connection: a code in
 * [4000, 4999] - [4000, 4499] tells the client to reconnect, [4500, 4999] not
 * to. reason is a short description, at most 32 bytes.
 */
export class Disconnect extends Error {
  /** The disconnect code: in [4000, 4999]. */
  readonly code: number;
  /** A short description, at most 32 bytes. */
  readonly reason: string;

  constructor(code: number, reason = '', options?: ErrorOptions) {
    super(`disconnect: ${reason} (code ${code})`, options);
    this.name = 'Disconnect';
    this.code = code;
    this.reason = reason;
  }
}

/** The options of a proxy handler. */
export interface ProxyHandlerOptions {
  /** Told of every 500 and 400, with the error. */
  onError?: OnError;
  /** The largest request body read: 16 MiB by default. */
  maxBody?: number;
}

function find<T>(err: unknown, cls: abstract new (...args: never[]) => T): T | undefined {
  for (let e = err; e instanceof Error; e = e.cause) {
    if (e instanceof cls) {
      return e;
    }
  }
  return undefined;
}

// What a proxy type's response can carry, besides a result.
const RESULT_ONLY = 0;
const ERROR = 1;
const ERROR_DISCONNECT = 2;

/**
 * A proxy handler: it decodes the request Centrifugo sends, calls the function
 * and encodes its answer.
 *
 * The function returns a result to accept the request, or throws:
 *
 * - ProxyError rejects the request with that error, which the client
 *   receives: use codes in [400, 1999]. The connect, subscribe, publish, RPC,
 *   map publish and map remove proxies pass it to the client; the shared poll
 *   refresh and channel state proxies take it as a failure.
 * - Disconnect closes the client's connection with that code: use codes in
 *   [4000, 4999] - [4500, 4999] to tell the client not to reconnect. Only the
 *   proxies which pass a ProxyError to the client honour it.
 * - Any other error, or one a proxy cannot carry, fails the request with HTTP
 *   status 500, and is passed to onError for logging. Centrifugo then answers
 *   the client with its temporary internal error; for refresh and sub refresh
 *   it keeps the connection or subscription for another minute and asks
 *   again.
 *
 * A ProxyError or Disconnect as the cause of another error counts too. The
 * refresh and sub refresh proxies end a connection or subscription through
 * their result's expired, not an error.
 *
 * Payloads - data, info, meta - arrive as JSON.parse gives them, and a result
 * takes them back as they are, or as rawJSON. A proxy with binary_encoding
 * enabled sends them base64-encoded in the b64 fields, with encoding
 * "binary"; a result may answer with either field.
 *
 * Security: Centrifugo trusts what a proxy endpoint answers, and the endpoint
 * trusts what Centrifugo sends - a SubscribeRequest's user is the user
 * Centrifugo authenticated. Anyone else able to reach the endpoint could claim
 * any user. Keep proxy endpoints reachable by Centrifugo only: on an internal
 * network, or behind a check of a secret Centrifugo sends as a static header.
 */
export abstract class ProxyHandler<Req, Res> extends Handler {
  readonly #func: (request: Req, http: HttpRequest) => Res | Promise<Res>;

  constructor(func: (request: Req, http: HttpRequest) => Res | Promise<Res>, options: ProxyHandlerOptions = {}) {
    super(options.onError, options.maxBody ?? DEFAULT_MAX_BODY);
    if (typeof func !== 'function') {
      throw new TypeError(`${new.target.name} takes the function answering the proxy`);
    }
    this.#func = func;
  }

  /** @internal */
  protected abstract readonly proxy: string;
  /** @internal */
  protected abstract readonly requestFields: Fields;
  /** @internal */
  protected abstract readonly resultFields: Fields;
  /** @internal */
  protected abstract readonly answers: number;

  protected begin(req: HttpRequest, body: string): HttpResponse | unknown[] {
    if (req.method !== 'POST') {
      return allow('POST');
    }
    try {
      return [decode(this.requestFields, decodeJSON(body, this.proxy, false), this.proxy)];
    } catch (e) {
      return this.fail(
        req,
        400,
        new TypeError(`proxy: malformed ${this.proxy} request: ${(e as Error).message}`, { cause: e }),
      );
    }
  }

  protected call(req: HttpRequest, args: unknown[]): unknown {
    return this.#func(args[0] as Req, req);
  }

  protected end(req: HttpRequest, _args: unknown[], out: unknown, error: unknown, failed: boolean): HttpResponse {
    let body: string;
    if (!failed) {
      if (typeof out !== 'object' || out === null || Array.isArray(out)) {
        return this.fail(
          req,
          500,
          new TypeError(
            `proxy: the ${this.proxy} function returned ${out === null ? 'null' : typeof out}, not a result object`,
          ),
        );
      }
      try {
        body = `{"result":${encode(this.resultFields, out, 'result')}}`;
      } catch (e) {
        // A payload which is not JSON, say: Centrifugo could not use the response.
        return this.fail(req, 500, e);
      }
    } else {
      const d = find(error, Disconnect);
      const e = find(error, ProxyError);
      if (d !== undefined && this.answers === ERROR_DISCONNECT) {
        body = JSON.stringify({ disconnect: { code: d.code, reason: d.reason } });
      } else if (e !== undefined && this.answers !== RESULT_ONLY) {
        body = JSON.stringify({
          error: { code: e.code, message: e.message, ...(e.temporary ? { temporary: true } : {}) },
        });
      } else if (d !== undefined || e !== undefined) {
        // Centrifugo would ignore it in this proxy's response.
        return this.fail(
          req,
          500,
          new CentError(
            `proxy: the ${this.proxy} proxy cannot answer with ${(error as Error).name}: failing the request`,
            { cause: error },
          ),
        );
      } else {
        return this.fail(req, 500, error);
      }
    }
    return { status: 200, headers: { 'Content-Type': 'application/json' }, body };
  }
}

/**
 * The connect proxy: the function authenticates a connecting client and returns
 * its user and initial state. ProxyError rejects the connection; Disconnect
 * closes it with that code.
 *
 * ```ts
 * const connect = new ConnectHandler(async (req, http) => {
 *   const user = await sessionUser(http.headers.get('cookie'));   // passed on with http_headers
 *   if (!user) throw new Disconnect(4501, 'unauthorized');
 *   return { user };
 * });
 * ```
 */
export class ConnectHandler extends ProxyHandler<ConnectRequest, ConnectResult> {
  protected readonly proxy = 'connect';
  protected readonly requestFields = ConnectRequestFields;
  protected readonly resultFields = ConnectResultFields;
  protected readonly answers = ERROR_DISCONNECT;
}

/**
 * The refresh proxy: the function decides whether a connection about to expire
 * lives on, and until when. To end it, return a result with expired set. Any
 * error fails the request, and Centrifugo keeps the connection for another
 * minute before asking again.
 */
export class RefreshHandler extends ProxyHandler<RefreshRequest, RefreshResult> {
  protected readonly proxy = 'refresh';
  protected readonly requestFields = RefreshRequestFields;
  protected readonly resultFields = RefreshResultFields;
  protected readonly answers = RESULT_ONLY;
}

/**
 * The subscribe proxy: the function decides whether a client may subscribe to a
 * channel. ProxyError rejects the subscription; Disconnect closes the
 * connection.
 */
export class SubscribeHandler extends ProxyHandler<SubscribeRequest, SubscribeResult> {
  protected readonly proxy = 'subscribe';
  protected readonly requestFields = SubscribeRequestFields;
  protected readonly resultFields = SubscribeResultFields;
  protected readonly answers = ERROR_DISCONNECT;
}

/**
 * The publish proxy: the function decides whether a client may publish into a
 * channel, and may change the publication. ProxyError rejects it; Disconnect
 * closes the connection.
 */
export class PublishHandler extends ProxyHandler<PublishRequest, PublishResult> {
  protected readonly proxy = 'publish';
  protected readonly requestFields = PublishRequestFields;
  protected readonly resultFields = PublishResultFields;
  protected readonly answers = ERROR_DISCONNECT;
}

/**
 * The RPC proxy: the function answers a client's RPC call. ProxyError fails the
 * call; Disconnect closes the connection.
 */
export class RPCHandler extends ProxyHandler<RPCRequest, RPCResult> {
  protected readonly proxy = 'rpc';
  protected readonly requestFields = RPCRequestFields;
  protected readonly resultFields = RPCResultFields;
  protected readonly answers = ERROR_DISCONNECT;
}

/**
 * The sub refresh proxy: the function decides whether a subscription about to
 * expire lives on, and until when. To end it, return a result with expired
 * set. Any error fails the request, and Centrifugo keeps the subscription for
 * another minute before asking again.
 */
export class SubRefreshHandler extends ProxyHandler<SubRefreshRequest, SubRefreshResult> {
  protected readonly proxy = 'sub refresh';
  protected readonly requestFields = SubRefreshRequestFields;
  protected readonly resultFields = SubRefreshResultFields;
  protected readonly answers = RESULT_ONLY;
}

/**
 * The map publish proxy: the function decides whether a client may publish a
 * key into a map channel, and may change the publication.
 */
export class MapPublishHandler extends ProxyHandler<MapPublishRequest, MapPublishResult> {
  protected readonly proxy = 'map publish';
  protected readonly requestFields = MapPublishRequestFields;
  protected readonly resultFields = MapPublishResultFields;
  protected readonly answers = ERROR_DISCONNECT;
}

/**
 * The map remove proxy: the function decides whether a client may remove a key
 * from a map channel.
 */
export class MapRemoveHandler extends ProxyHandler<MapRemoveRequest, MapRemoveResult> {
  protected readonly proxy = 'map remove';
  protected readonly requestFields = MapRemoveRequestFields;
  protected readonly resultFields = MapRemoveResultFields;
  protected readonly answers = ERROR_DISCONNECT;
}

/**
 * The shared poll refresh proxy: the function returns the current data of the
 * items tracked in a shared poll channel. ProxyError, or any other error,
 * fails the refresh: Centrifugo tries again at the next interval.
 */
export class SharedPollRefreshHandler extends ProxyHandler<SharedPollRefreshRequest, SharedPollRefreshResult> {
  protected readonly proxy = 'shared poll refresh';
  protected readonly requestFields = SharedPollRefreshRequestFields;
  protected readonly resultFields = SharedPollRefreshResultFields;
  protected readonly answers = ERROR;
}

/**
 * The cache empty proxy of Centrifugo PRO: the function learns that a client
 * subscribed to a channel in cache recovery mode with nothing to recover, and
 * may publish the current state - then it returns a result with populated set,
 * for Centrifugo to recover once more. Any error fails the request, and the
 * client which subscribed is disconnected to reconnect.
 */
export class NotifyCacheEmptyHandler extends ProxyHandler<NotifyCacheEmptyRequest, NotifyCacheEmptyResult> {
  protected readonly proxy = 'cache empty';
  protected readonly requestFields = NotifyCacheEmptyRequestFields;
  protected readonly resultFields = NotifyCacheEmptyResultFields;
  protected readonly answers = RESULT_ONLY;
}

/**
 * The channel state proxy of Centrifugo PRO, in preview: the function receives
 * channels becoming occupied or vacated. ProxyError, or any other error, fails
 * the request.
 */
export class NotifyChannelStateHandler extends ProxyHandler<NotifyChannelStateRequest, NotifyChannelStateResult> {
  protected readonly proxy = 'channel state';
  protected readonly requestFields = NotifyChannelStateRequestFields;
  protected readonly resultFields = NotifyChannelStateResultFields;
  protected readonly answers = ERROR;
}
