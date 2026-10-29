# jscent

JavaScript and TypeScript SDK for the
[HTTP server API](https://centrifugal.dev/docs/server/server_api) of
[Centrifugo](https://github.com/centrifugal/centrifugo): every API method,
including those of Centrifugo PRO; connection, subscription and server API
tokens; the proxy handlers and the endpoints client SDKs call. For a real-time
client in browsers and apps, see
[centrifuge-js](https://github.com/centrifugal/centrifuge-js).

```
npm install jscent
```

No dependencies: it uses `fetch` and Web Crypto only, so the same package runs
on Node.js, Deno, Bun and edge runtimes such as Cloudflare Workers.

| | Version |
|---|---|
| Node.js | 22 or newer; Deno 2, Bun 1.2 or newer |
| Centrifugo | v6, any release |
| Map and shared poll methods | Centrifugo v6.8.0 or newer |
| `ApiError.temporary`, `TooManyRequestsError`, refused requests reported as such rather than as internal errors | Centrifugo v6.10.0 or newer |
| Ed25519 tokens verified without JWKS, by `client.token.ed25519_public_key` | Centrifugo v6.10.2 or newer |
| Methods marked "Centrifugo PRO only" | Centrifugo PRO v6 |

jscent 1 replaces jscent 0.2: see [MIGRATING.md](MIGRATING.md). jscent
implements the
[Centrifugo server SDK specification](https://github.com/centrifugal/gocent/blob/master/spec.md),
version 0.2.

## Example

```ts
import { Client } from 'jscent';

const client = new Client({ apiEndpoint: 'http://localhost:8000/api', apiKey: process.env.CENTRIFUGO_API_KEY });

const res = await client.publish({ channel: 'news', data: { text: 'hello' } });
console.log(`published at offset ${res.offset}`);
```

Every API method takes its request's fields - typed from Centrifugo's
`api.proto`, with its documentation - and resolves to its result, rejecting
unless Centrifugo did everything asked. A field jscent does not know - a typo,
or `skip_history` for `skipHistory` - is refused, not dropped. Create the
client once and share it: it is safe for concurrent use.

`JSON.stringify` renders a result with Centrifugo's field names -
`num_clients`, `idempotency_key` - for a response of your own, and an error in
a broadcast's or batch's result as `{ code, message }`.

A batch and commands have the same methods as the client:
`batch.publish({ ... })`, `command.publish({ ... })`. jscent is an ES module;
CommonJS code loads it with `require('jscent')` on Node.js 22.12 or newer.

## Payloads

`data`, `info`, `meta` and the other payloads are JSON values, given as the
JavaScript values they decode to - objects, arrays, strings, numbers, booleans,
`null` - and returned the same way, as `JSON.parse` gives them: a payload from
a reply sent back unchanged is the same JSON value. `null` is JSON null; a
payload left out is `undefined`.

A string is a JSON string: `data: 'hi'` publishes `"hi"`. (Unlike Pusher, whose
event data is a string: Centrifugo's data is any JSON value.) JSON you already
have, or encode with rules of your own, goes in `rawJSON`, sent as it is - also
inside an object:

```ts
await client.publish({ channel: 'news', data: rawJSON(row.payloadJson) });
await client.publish({ channel: 'news', data: { meta, doc: rawJSON(row.docJson) } });
```

A payload which is not JSON - NaN, infinities, bytes, a `Map`, a function -
rejects with `InvalidRequestError` before anything is sent, where
`JSON.stringify` would write `null` or `{}`, or drop it, without a word.
Binary data goes base64-encoded in the `b64` fields, such as `b64data`.

**Integers past 2^53.** JavaScript numbers hold integers exactly only up to
2^53, in browsers running centrifuge-js too: write integers which may pass it -
64-bit IDs, say - as JSON strings, `{"id": "9007199254740993"}`. A `bigint`
in a payload is sent exactly, as a JSON number. For payloads you cannot
change, `bigIntegers: true` decodes integers past 2^53 as `bigint`, as
centrifuge-js's option of the same name does. It is off by default, because a
field's type then follows its value - a `bigint` does not mix with a `number`,
and `JSON.stringify` refuses it: to send such a payload on with a
`JSON.stringify` of your own, pass it
`(k, v) => typeof v === 'bigint' ? JSON.rawJSON(String(v)) : v`.

## Timeouts

Each call takes `{ timeout, signal }`, the timeout in milliseconds; without
one, `requestTimeout` - ten seconds by default - bounds it:

```ts
await client.info(undefined, { timeout: 500 });
await client.publish(request, { signal: AbortSignal.timeout(2_000) });
```

The timeout bounds the whole call - connecting, sending, the reply's headers
and body - and rejects with `TimeoutError`. A call aborted by its `signal`
rejects with the signal's reason, as `fetch` does. `broadcastWithRetry` makes
several requests in one call: its `timeout` bounds them all, waits between
them included, and `attemptTimeout` each one.

## Errors

| Error | Meaning |
|---|---|
| `ApiError` | Centrifugo refused the request or failed to carry it out: `code`, `serverMessage`, `temporary`. Known codes are subclasses: `UnknownChannelError`, `NotFoundError`, `BadRequestError`, `NotAvailableError`, `TooManyRequestsError`, `InternalError`... |
| `BroadcastFailedChannelsError`, `BatchFailedCommandsError` | some parts of a broadcast or batch failed - see below |
| `HTTPError` | the request did not reach the API method: `status`, `body`, `headers`; `UnauthorizedError` for rejected credentials |
| `DecodeError` | the reply was not Centrifugo's - usually `apiEndpoint` points elsewhere |
| `InvalidRequestError` | the client could tell the request is wrong and did not send it |
| `InvalidConfigError` | the client was not created: the message names the option and the fix |
| `NetworkError`, `TimeoutError`, `ClosedError` | as their names say; a network error's `cause` is fetch's |

All are `CentError`. Centrifugo adds error codes over time: an unknown code is
still an `ApiError`, so match the codes you handle and treat the rest by
class.

## Retries

`retryable(e)` reports whether a new attempt, with time left, may succeed: the
error came from a temporary condition - a broker being unavailable, a rate
limit, the network - not from the request.

A temporary error does not mean nothing was done: after a timeout, or even an
internal error, the publication may have happened. So retry a publication only
with an `idempotencyKey`, and back off between a bounded number of attempts:

```ts
const request = {
  channel: 'orders:42',
  data,
  // The same key on every attempt: a publication which happened in an
  // earlier attempt, even one reported as failed, is not published again.
  idempotencyKey: 'order-42-paid',
};
const backoff = exponentialBackoff(200, 5_000);
for (let attempt = 1; ; attempt++) {
  try {
    await client.publish(request);
    break;
  } catch (e) {
    if (!retryable(e) || attempt === 3) throw e;
  }
  await wait(backoff(attempt), signal); // ends early when signal aborts
}
```

Choosing keys:

- One key per publication or broadcast, reused only to retry that same one. A
  broadcast needs one key, not one per channel.
- Centrifugo remembers a key per channel, for five minutes by default. A retry
  within that time is answered with the first result and not published again -
  and so is a _different_ publication into the same channel under the same
  key. A key built from an ID must name the event too: `order-42-paid`, not
  `order-42`.
- The memory, Redis and PostgreSQL brokers keep keys. The NATS broker ignores
  them, so with it a retry publishes again.

Retry a broadcast with `broadcastWithRetry` rather than a loop: see below.

## Broadcast and batch

`broadcast` publishes the same data into many channels in one request; a batch
sends many commands at once. Both reject unless every part succeeded:

```ts
await client.broadcast({ channels: ['user:1', 'user:2'], data: { text: 'hello' }, idempotencyKey: messageId });

const batch = client.newBatch();
const pub = batch.publish({ channel: 'news', data });
const stats = batch.presenceStats({ channel: 'news' });
await batch.send();
pub.result().offset; // each command has its own result, or throws its own error
stats.result().numClients;
```

Parts succeed or fail on their own. When Centrifugo carried the request out
and some parts failed, up to all, it rejects with `BroadcastFailedChannelsError`
or `BatchFailedCommandsError`: its `failed` lists them, and its `result` holds
every part's outcome. Any other error means the request failed as a whole - the
network, the credentials, an invalid request - and no part got a reply; after
a timeout or a network error Centrifugo may still have carried it out.

A partial error is not an error of its parts: it is not an
`UnknownChannelError` when a channel was unknown, nor when the broadcast went
to a single channel - use `publish` for one channel. To go on despite some
failed parts:

```ts
try {
  await client.broadcast(request);
} catch (e) {
  if (!(e instanceof BroadcastFailedChannelsError)) throw e;
  logger.warn('broadcast failed in some channels', e.result.failed);
}
```

Retrying:

- a **broadcast**: `broadcastWithRetry` does it. It sends again only the
  channels which may still succeed, all attempts with one `idempotencyKey` -
  made for the call when the request has none - and returns every channel's
  last outcome, as `broadcast` does:

  ```ts
  const res = await client.broadcastWithRetry(request, { maxAttempts: 5, attemptTimeout: 2_000, timeout: 10_000 });
  ```

  By default it retries once, after about 100 milliseconds. `onAttemptError`
  is called after each failed attempt which will be retried, with a
  `BroadcastAttempt` - the channels to retry and their errors: it returns the
  milliseconds to wait before the next attempt - or `undefined` for the
  default backoff - and may log or count meanwhile; it throws to stop. An
  `HTTPError` in `a.error` carries the response's `headers`: wait at least its
  `retry-after` to honour one.

  `res.idempotencyKey` is the key the attempts used: to retry the broadcast
  later, after it gave up - from a job queue, say - send it with that key.
  Repeating `broadcast` on any error would instead send it to every channel
  again, those which already got it included.
- a **batch**: build a new one, with the same keys, from the commands
  `e.failed` lists with a retryable error. A batch is sent once.

`newBatch()` runs the commands one by one, in order; `{ parallel: true }` runs
them concurrently. Centrifugo PRO sends a batch's publications to its broker
together: each channel's publications still take effect in order, but
publications into different channels may not, unless the namespace sets
`publication_grouping_disabled`.

## Automatic batching

With `autoBatch`, calls made concurrently go out together once `maxInFlight`
requests are in flight, with no delay otherwise, since nothing waits for a
timer.

It is for processes making many calls at once - a server handling many
requests concurrently, a worker fanning publications out - and does nothing
for one making a few at a time. Set `maxInFlight` to about half the calls the
process makes at once: above that, it never batches; just below, it batches
calls one at a time, and only limits them:

```ts
const client = new Client({ apiEndpoint, apiKey, autoBatch: { maxInFlight: 8 } });
```

Every call still gets its own result or error, and keeps its own timeout.
Calls sharing a batch share its request, though: if the request itself fails -
the network, a body too large for a proxy in front of Centrifugo (nginx
refuses bodies over 1 MB by default) - every call in it fails.

## Authentication

`apiKey` is sent in the `X-API-Key` header. `getBearerToken` instead sends a
token as `Authorization: Bearer`, for Centrifugo PRO's JWKS authentication - it
is called for every request, so return a cached token. Leave both unset when
mutual TLS, set up in your `fetch`, or a proxy authenticates instead.

To sign the tokens yourself, `ApiTokens` issues them and reuses each for half
its lifetime:

```ts
import { ApiTokens } from 'jscent/token';

const apiTokens = new ApiTokens({
  key: apiKey, // its own key - never one of the client tokens
  claims: { audience: 'centrifugo-api', scope: ['centrifugo:api'] },
});
const client = new Client({ apiEndpoint: 'https://centrifugo.example.com/api', getBearerToken: apiTokens.token });
```

Centrifugo PRO accepts a token signed with any key of `http_api.jwks.endpoint`,
and checks the audience, issuer and scope only when configured to. So keep API
tokens apart from the connection and subscription tokens your users hold - or
any user can call the server API with their connection token:

- publish the API keys with `new JWKS(...apiKeys)` at an endpoint of their own,
  not the one of `client.token.jwks_public_endpoint`;
- set `http_api.jwks.audience` and `http_api.jwks.scope` to values only API
  tokens carry - `api()` refuses claims with neither.

The API keys rotate as client keys do: see [Key rotation with JWKS](#key-rotation-with-jwks).

Rejected credentials make every call reject with `UnauthorizedError`.

## HTTP transport

jscent sends requests with the runtime's `fetch`, which keeps connections
alive, and never follows redirects. Pass your own `fetch` to change how -
undici's, with a dispatcher sized for many concurrent calls, say:

```ts
import { Agent, fetch } from 'undici';

const dispatcher = new Agent({ connections: 256 });
const client = new Client({ apiEndpoint, apiKey, fetch: (url, init) => fetch(url, { ...init, dispatcher }) });
```

Your `fetch` is called with each request's credentials and headers; jscent
never changes it. Tracing comes from it: on Node.js,
`@opentelemetry/instrumentation-undici` traces the global `fetch`. `onRequest`
is told of every request - method, commands and how many failed, duration,
status, error - for metrics without a dependency of jscent's. It must not
throw.

## Testing your code

Give the client a fake `fetch`, which answers as Centrifugo would - your tests
then see the requests jscent really sends, and decode replies as jscent really
does:

```ts
const sent: { url: string; body: any }[] = [];
const client = new Client({
  apiEndpoint: 'http://centrifugo.test/api',
  fetch: async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Response.json({ result: { offset: 1, epoch: 'e' } });
  },
});

await new OrderNotifier(client).paid(order);

expect(sent[0]!.url).toBe('http://centrifugo.test/api/publish');
expect(sent[0]!.body.idempotency_key).toBe('order-42-paid');
```

Answer as Centrifugo does, at `/api/<method>`:

- a method: `{ result: {...} }`, or an error: `{ error: { code: 102, message: 'unknown channel' } }`;
- a broadcast, one response per channel, in order:
  `{ result: { responses: [{ result: { offset: 1 } }, { error: { code: 102, message: 'unknown channel' } }] } }`;
- a batch, one reply per command, in order:
  `{ replies: [{ publish: { offset: 1 } }, { error: { code: 102, message: 'unknown channel' } }] }`.

A test double of your own returns jscent's results and throws its errors,
partial failures included:

```ts
const ok = { channel: 'news', result: { offset: 1, epoch: '' }, error: undefined, attempts: 1 };
const bad = { channel: 'unknown:x', result: undefined, error: ApiError.fromCode(102, 'unknown channel'), attempts: 1 };
throw new BroadcastFailedChannelsError([bad], 2, new BroadcastResult([ok, bad]));
```

and for a batch, `Pending.resolved(result)` or
`Pending.resolved(undefined, error)` as each command's outcome, with
`new BatchFailedCommandsError(failed, total, new BatchResult(true, failed))`
of `{ index, method, error }` failures.

## Shutdown

`await client.close()` rejects new calls with `ClosedError` and waits for the
ones in progress, automatic batches included, so that what was accepted is
sent before the process exits. With `{ timeout }` it rejects with
`TimeoutError` when calls are still in progress then.

## HTTP handlers

The proxy handlers and the endpoints client SDKs call have a framework-free
core - `await handler.handle({ method, headers, body })` resolving to `{ status,
headers, body }` - and two adapters, bound to the handler: `handler.fetch`
for Fetch API requests, and `handler.node` for node:http and Express. Each
function receives an `HttpRequest`: the method, headers, query and, in `raw`,
the server's own request object.

```ts
// Express
app.post('/centrifugo/connect', connectHandler.node);

// node:http
http.createServer(connectHandler.node).listen(3000);

// Cloudflare Workers, Bun.serve, Deno.serve
export default { fetch: connectHandler.fetch };

// Hono
app.post('/centrifugo/connect', (c) => connectHandler.fetch(c.req.raw));

// Next.js, in app/centrifugo/connect/route.ts
export const POST = connectHandler.fetch;
```

To use your framework's authentication, call the core from a route of your
own, and hand the function what it needs in `raw`:

```ts
app.post('/centrifugo/connect', express.text({ type: '*/*' }), async (req, res) => {
  const out = await connectHandler.handle({ method: req.method, headers: req.headers, body: req.body, raw: req.user });
  res.status(out.status).set(out.headers).send(out.body);
});
```

Behind `express.json()`, the handler takes the body the parser read; mount it
before the parser, or use `express.text()` as above, to keep the body exactly
as Centrifugo sent it.

## Proxy

`jscent/proxy` is the backend side of Centrifugo's HTTP proxy, which calls your
application when a client connects, subscribes, publishes or makes an RPC
call: a handler per proxy type, taking a function.

```ts
import { ProxyError, SubscribeHandler } from 'jscent/proxy';

const subscribeHandler = new SubscribeHandler(
  async (req, http) => {
    if (!(await canRead(req.user, req.channel))) {
      throw new ProxyError(403, 'permission denied');
    }
    return {};
  },
  { onError: logProxyError },
);
```

Return a result to accept the request, throw `ProxyError` to reject it with an
error the client receives, or `Disconnect` to close the client's connection;
any other error fails the request, and goes to `onError` to be logged -
`onError` itself must not throw. Error codes are in [400, 1999], disconnect
codes in [4000, 4999], and a disconnect reason is at most 32 bytes. Keep proxy
endpoints reachable by Centrifugo only: whoever can call them can claim
to be any user.

## Tokens

`jscent/token` issues the JWTs Centrifugo authenticates clients with -
connection and subscription tokens, with Centrifugo's claims, signed with
HMAC, RSA, ECDSA or Ed25519 through Web Crypto - and `jscent/endpoints` serves
the endpoints the `getToken` callbacks of client SDKs call:

```ts
import { ConnectionToken, Unauthorized } from 'jscent/endpoints';
import * as token from 'jscent/token';

const key = token.Key.hmac(secret); // client.token.hmac_secret_key

const connectionToken = new ConnectionToken(
  async (http) => {
    const user = await sessionUser(http);
    if (!user) throw new Unauthorized(); // 403: the client stops asking
    return token.connection(key, { user, expiresAt: new Date(Date.now() + 3_600_000) });
  },
  { onError: logError },
);
```

An expiry is required: a `Date`, or `token.NEVER` for a token accepted
forever. `SubscriptionToken` serves subscription tokens the same way, with the
channel the client asks for. Signing is asynchronous in Web Crypto, so the
token functions return promises. To rotate keys without restarting
Centrifugo, see [Key rotation with JWKS](#key-rotation-with-jwks).

## Key rotation with JWKS

By default Centrifugo verifies tokens with a single key from its
configuration: `client.token.hmac_secret_key`, or an RSA, ECDSA or Ed25519
public key. Changing that key means restarting Centrifugo, and from that
moment it refuses every token signed with the old key. To rotate keys without
that, your application can serve the keys itself, as a JSON Web Key Set (JWKS)
at Centrifugo's `client.token.jwks_public_endpoint`. Each key in the set has an
ID, and Centrifugo verifies a token with the key its `kid` header names:

```ts
import { JWKS } from 'jscent/endpoints';

// An ID for each key, never reused for another key: Centrifugo caches keys by ID.
const key = (await token.Key.fromPem(await readFile('keys/2026-10.pem', 'utf8'))).withKeyId('2026-10');

const jwks = new JWKS(key); // served at the URL of jwks_public_endpoint
const tok = await token.connection(key, { user: '42', expiresAt });
```

```json
{ "client": { "token": { "jwks_public_endpoint": "https://app.example.com/centrifugo/jwks" } } }
```

Only RSA, ECDSA and Ed25519 keys can go in a set: PKCS #8 PEMs
(`BEGIN PRIVATE KEY`), private JWKs, or Ed25519 seeds. An HMAC secret has no
public part to publish. Once `jwks_public_endpoint` is set, Centrifugo
verifies tokens with the set only, and refuses tokens signed with the key it
was configured with before. So moving to a JWKS is a one-time restart.

How Centrifugo reads the set:

- when a token names a key ID Centrifugo doesn't know, it fetches the set
  again, at most once every 5 seconds;
- it keeps the keys it fetched for 5 minutes (an hour before Centrifugo
  v6.10.2), so a key dropped from the set stops working within that time;
- when the endpoint can't be reached, it keeps using the keys it already has;
- a token whose key isn't in the set is refused as expired, and the client
  SDK asks for a new token.

Rotate a key in three steps. Each step is one deploy of your application, and
every instance should finish a step before any instance moves to the next:

1. **Publish the new key alongside the current one,** and keep signing with
   the current one: `new JWKS(current, next)`.
2. **Sign with the new key.** Centrifugo fetches the set the first time it
   sees the new ID.
3. **Drop the old key** once every token it signed has expired: wait longer
   than the longest `expiresAt` you give.

If a key leaks, do all three steps now, without waiting in step 3. Within
5 minutes Centrifugo refuses new connections with the leaked key's tokens.
Clients that connected before stay connected until their tokens expire:
disconnect them with the server API if needed.

Centrifugo PRO's API tokens rotate the same way, from a set of their own at
`http_api.jwks.endpoint` (see [Authentication](#authentication)).
`new ApiTokens({ currentKey })` takes the key to sign with from a function, so
it can switch to the new key at step 2. Each API token is reused for half its
`ttl`, so in step 3 wait at least `ttl` after the switch.

## Shared poll signatures

Clients tracking keys of a [shared poll](https://centrifugal.dev/docs/server/shared_poll)
channel need a signature from the backend. `jscent/sharedpoll`'s `sign` makes
one, and `SharedPollSignature` serves the endpoint a subscription's
`getSignature` callback calls:

```ts
import { SharedPollSignature } from 'jscent/endpoints';
import { sign } from 'jscent/sharedpoll';

const signature = new SharedPollSignature(async (http, channel, keys) => {
  const user = await sessionUser(http);
  const allowed = await readable(user, channel, keys); // the rest are revoked
  return {
    keys: allowed,
    signature: await sign(secret, { user, channel, keys: allowed, expiresAt: new Date(Date.now() + 3_600_000) }),
  };
});
```

Shared poll subscriptions are experimental in Centrifugo, and this part
follows their changes.

## Commands for async consumers

`command.publish({ ... })` - and a function like it for every API method -
checks a request as a client would and encodes it, for
Centrifugo's [async consumers](https://centrifugal.dev/docs/server/consumers):
its `method` and `payload` for an outbox table - `payload` is JSON text, for a
`jsonb` column - or `String(cmd)` for a Kafka message. `JSON.stringify` of a
command, also inside another value, gives the same message, `payload` an
object.

```ts
const cmd = command.publish({ channel: 'news', data: { text: 'hi' } });
await sql`INSERT INTO centrifugo_outbox (method, payload, partition) VALUES (${cmd.method}, ${cmd.payload}, 0)`;
```

A consumer keeps commands in order only within a partition: to keep a
channel's commands in order, derive their partition from the channel the same
way in every writer.

## Streaming AI output

Publish a model's output into a channel of its own, in a namespace with history
and recovery, from one task - each publish awaiting the previous one - in
chunks of what arrived every 50 ms or so, not a publication per token. See
[Centrifugo for AI apps](https://centrifugal.dev/docs/getting-started/ai_apps),
which also covers sizing history for a whole response.

## More

- [API.md](API.md): the API reference, every class, function and field, made
  from the doc comments by `npm run docs`.
- Docs for agents and LLMs: [centrifugal.dev/llms.txt](https://centrifugal.dev/llms.txt),
  an index of the current (v6) documentation.
- Development: see [AGENTS.md](AGENTS.md); `npm run check` runs what CI does
  but the integration tests, `npm run test:integration` those.

MIT license. Centrifugo PRO, which the methods marked "Centrifugo PRO only"
call, is commercial software under its own
[license](https://centrifugal.dev/license).
