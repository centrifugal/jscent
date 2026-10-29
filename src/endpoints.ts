// The HTTP endpoints client SDKs call: for connection and subscription tokens -
// what their getToken callbacks fetch - and for shared poll signatures, plus
// the JSON Web Key Set Centrifugo fetches.
//
// An endpoint answers a JSON object, never cached; Unauthorized - also as the
// cause of another error - with 403, on which client SDKs stop asking, and
// disconnect or unsubscribe; any other error with 500, which they retry. A
// malformed request gets 400, a wrong method 405. onError, when set, is told
// of every 500 and 400, with the error; it must not throw.

import { allow, Handler, type HttpRequest, type HttpResponse, json, type OnError, statusText } from './http.ts';
import { jwks, type Key } from './token.ts';

/** Bodies are read up to 1 MiB. */
const MAX_BODY = 1 << 20;

/**
 * Thrown by the function of an endpoint when the user may not have a token or
 * signature: answered with 403, on which client SDKs stop asking. It is the
 * endpoints' own, named after client SDKs' UnauthorizedError - not the API
 * client's UnauthorizedError, which means Centrifugo refused the SDK's
 * credentials.
 */
export class Unauthorized extends Error {
  constructor(message = 'unauthorized', options?: ErrorOptions) {
    super(message, options);
    this.name = 'Unauthorized';
  }
}

function isUnauthorized(err: unknown): boolean {
  for (let e = err; e instanceof Error; e = e.cause) {
    if (e instanceof Unauthorized) {
      return true;
    }
  }
  return false;
}

abstract class Endpoint extends Handler {
  protected answer(req: HttpRequest, body: unknown, error: unknown, failed: boolean): HttpResponse {
    if (failed) {
      return isUnauthorized(error) ? statusText(403) : this.fail(req, 500, error);
    }
    return json(JSON.stringify(body));
  }

  /** The request's JSON object, or the 400 answering it. */
  protected decode(
    req: HttpRequest,
    body: string,
  ): { ok: true; value: Record<string, unknown> } | { ok: false; response: HttpResponse } {
    let d: unknown;
    try {
      d = JSON.parse(body);
    } catch (e) {
      return {
        ok: false,
        response: this.fail(req, 400, new SyntaxError(`malformed request: ${(e as Error).message}`)),
      };
    }
    if (typeof d !== 'object' || d === null || Array.isArray(d)) {
      return { ok: false, response: this.fail(req, 400, new TypeError('malformed request: not a JSON object')) };
    }
    return { ok: true, value: d as Record<string, unknown> };
  }
}

function asToken(out: unknown): string {
  if (typeof out !== 'string' || out === '') {
    throw new TypeError(`the function returned ${out === '' ? 'an empty string' : typeof out}, not a token`);
  }
  return out;
}

/**
 * The endpoint a client's getToken callback calls: issue returns the connection
 * token of the request's user - from connection(), say - or throws
 * Unauthorized. It takes GET and POST, the body ignored.
 *
 * ```ts
 * const endpoint = new ConnectionToken(async (http) => {
 *   const user = await sessionUser(http.headers.get('cookie'));
 *   if (!user) throw new Unauthorized();
 *   return token.connection(key, { user, expiresAt: new Date(Date.now() + 15 * 60_000) });
 * });
 * ```
 */
export class ConnectionToken extends Endpoint {
  readonly #issue: (http: HttpRequest) => string | Promise<string>;

  constructor(issue: (http: HttpRequest) => string | Promise<string>, options: { onError?: OnError } = {}) {
    super(options.onError, MAX_BODY);
    if (typeof issue !== 'function') {
      throw new TypeError('ConnectionToken takes the function issuing tokens');
    }
    this.#issue = issue;
  }

  protected begin(req: HttpRequest): HttpResponse | unknown[] {
    return req.method === 'GET' || req.method === 'POST' ? [] : allow('GET, POST');
  }

  protected call(req: HttpRequest): unknown {
    return this.#issue(req);
  }

  protected end(req: HttpRequest, _args: unknown[], out: unknown, error: unknown, failed: boolean): HttpResponse {
    if (!failed) {
      try {
        return this.answer(req, { token: asToken(out) }, undefined, false);
      } catch (e) {
        return this.answer(req, undefined, e, true);
      }
    }
    return this.answer(req, undefined, error, true);
  }
}

/**
 * The endpoint a subscription's getToken callback calls: issue returns the
 * token of the request's user for the channel - from subscription(), say - or
 * throws Unauthorized when the user may not subscribe. The channel comes from
 * a POST's JSON body, {"channel": ...}, or from a GET's channel query
 * parameter; it is required.
 */
export class SubscriptionToken extends Endpoint {
  readonly #issue: (http: HttpRequest, channel: string) => string | Promise<string>;

  constructor(
    issue: (http: HttpRequest, channel: string) => string | Promise<string>,
    options: { onError?: OnError } = {},
  ) {
    super(options.onError, MAX_BODY);
    if (typeof issue !== 'function') {
      throw new TypeError('SubscriptionToken takes the function issuing tokens');
    }
    this.#issue = issue;
  }

  protected begin(req: HttpRequest, body: string): HttpResponse | unknown[] {
    let channel: unknown;
    if (req.method === 'GET') {
      channel = req.query.get('channel') ?? '';
    } else if (req.method === 'POST') {
      const d = this.decode(req, body);
      if (!d.ok) {
        return d.response;
      }
      channel = d.value.channel ?? '';
      if (typeof channel !== 'string') {
        return this.fail(req, 400, new TypeError('malformed request: channel is not a string'));
      }
    } else {
      return allow('GET, POST');
    }
    if (channel === '') {
      return this.fail(req, 400, new TypeError('subscription token request without a channel'));
    }
    return [channel];
  }

  protected call(req: HttpRequest, args: unknown[]): unknown {
    return this.#issue(req, args[0] as string);
  }

  protected end(req: HttpRequest, _args: unknown[], out: unknown, error: unknown, failed: boolean): HttpResponse {
    if (!failed) {
      try {
        return this.answer(req, { token: asToken(out) }, undefined, false);
      } catch (e) {
        return this.answer(req, undefined, e, true);
      }
    }
    return this.answer(req, undefined, error, true);
  }
}

/** What a SharedPollSignature function returns: the keys signed, in order, and the signature. */
export interface SignedKeys {
  keys: readonly string[];
  signature: string;
}

/**
 * The endpoint a shared poll subscription's getSignature callback calls: a POST
 * of {"channel": ..., "keys": [...]}, answered {"signature": ..., "keys":
 * [...]}.
 *
 * sign decides which of the keys the user may track in the channel, signs them
 * - with sharedpoll's sign, say - and returns them, in the order signed, with
 * the signature. The keys it leaves out are revoked: the client stops tracking
 * them. To end the subscription instead, it throws Unauthorized. It may return
 * only keys it was asked for: a signature covering another would be refused,
 * and such a key fails the request with 500.
 */
export class SharedPollSignature extends Endpoint {
  readonly #sign: (http: HttpRequest, channel: string, keys: string[]) => SignedKeys | Promise<SignedKeys>;

  constructor(
    sign: (http: HttpRequest, channel: string, keys: string[]) => SignedKeys | Promise<SignedKeys>,
    options: { onError?: OnError } = {},
  ) {
    super(options.onError, MAX_BODY);
    if (typeof sign !== 'function') {
      throw new TypeError('SharedPollSignature takes the function signing keys');
    }
    this.#sign = sign;
  }

  protected begin(req: HttpRequest, body: string): HttpResponse | unknown[] {
    if (req.method !== 'POST') {
      return allow('POST');
    }
    const d = this.decode(req, body);
    if (!d.ok) {
      return d.response;
    }
    const channel = d.value.channel ?? '';
    const keys = d.value.keys ?? [];
    if (typeof channel !== 'string' || !Array.isArray(keys) || !keys.every((k) => typeof k === 'string')) {
      return this.fail(req, 400, new TypeError('malformed request: channel and keys must be strings'));
    }
    if (channel === '') {
      return this.fail(req, 400, new TypeError('signature request without a channel'));
    }
    return [channel, keys];
  }

  protected call(req: HttpRequest, args: unknown[]): unknown {
    return this.#sign(req, args[0] as string, args[1] as string[]);
  }

  protected end(req: HttpRequest, args: unknown[], out: unknown, error: unknown, failed: boolean): HttpResponse {
    if (failed) {
      return this.answer(req, undefined, error, true);
    }
    try {
      const o = out as Partial<SignedKeys> | undefined;
      if (typeof o?.signature !== 'string' || !Array.isArray(o.keys) || !o.keys.every((k) => typeof k === 'string')) {
        throw new TypeError('the function must return { keys, signature }');
      }
      const asked = new Set(args[1] as string[]);
      for (const k of o.keys) {
        if (!asked.has(k)) {
          throw new RangeError(`signed key "${k}" the client did not ask for`);
        }
      }
      // The SDK reads the keys as an array, empty included.
      return this.answer(req, { signature: o.signature, keys: [...o.keys] }, undefined, false);
    } catch (e) {
      return this.answer(req, undefined, e, true);
    }
  }
}

/**
 * Serves the JSON Web Key Set of keys - see jwks - at the URL configured as
 * Centrifugo's client.token.jwks_public_endpoint, or Centrifugo PRO's
 * http_api.jwks.endpoint for API keys. It answers GET and HEAD, cacheable for
 * five minutes. A set jwks refuses fails here, when the endpoint is built.
 */
export class JWKS extends Handler {
  readonly #body: string;

  constructor(...keys: Key[]) {
    super(undefined, MAX_BODY);
    this.#body = jwks(...keys);
  }

  protected begin(req: HttpRequest): HttpResponse {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return allow('GET, HEAD');
    }
    return json(req.method === 'GET' ? this.#body : '', 'public, max-age=300');
  }

  protected call(): unknown {
    throw new Error('begin always answers');
  }

  protected end(): HttpResponse {
    throw new Error('begin always answers');
  }
}
