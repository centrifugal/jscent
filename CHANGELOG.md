# v1.0.0

jscent 1 is a rewrite to the [Centrifugo server SDK specification](https://github.com/centrifugal/gocent/blob/master/spec.md), version 0.3, which gives Centrifugo's server SDKs the same calls, errors and behaviour, spelled the JavaScript way. It runs on Node.js 22 or newer, Deno 2, Bun 1.2 and edge runtimes such as Cloudflare Workers, with no dependencies - `fetch` and Web Crypto only - and ships its TypeScript types. It works with Centrifugo v6 and Centrifugo PRO v6; the map and shared poll methods need v6.8.0 or newer. jscent 0.2 was written for Centrifugo 1 and does not work with v6: to move over, see the [migration guide](https://github.com/centrifugal/jscent/blob/master/MIGRATING.md).

### Client and calls

- `new Client({ apiEndpoint, apiKey })`, or `getApiEndpoint` for an address discovered per request and `getBearerToken` for Centrifugo PRO's API tokens; `headers`; your own `fetch` for pools, proxies, tracing and tests. Options are checked when the client is created, and an unknown one is refused with a hint (`timeout`: did you mean `requestTimeout`?).
- A method for every API method of Centrifugo v6 - Centrifugo PRO's, the map and the shared poll methods included - on the client, on a batch and as a command: `await client.publish({ channel, data })`. Requests and results are generated from Centrifugo's `api.proto`, with its documentation; methods only Centrifugo PRO has are marked so. Promises, not callbacks.
- A request is a plain object of camelCase fields. A field jscent does not know - a typo, or a snake_case name - is refused with `InvalidRequestError`, not dropped.
- Fields Centrifugo requires are required properties, and are checked for a value before sending: `''`, `0`, an empty list or an empty object would go out as the field left out, so such a call - from plain JavaScript too - rejects with `InvalidRequestError` naming the path (`limitStrategy.rateLimit.policies[0].rate is required`) instead of failing in Centrifugo with code 107. A field whose empty value means something is not checked: `invalidateUserTokens({ user: '' })` invalidates the tokens of anonymous users.
- A nested message with nothing set is left out, as an empty field is: an empty `limitStrategy`, which Centrifugo refuses, is not sent. `deviceUpdate`'s `userUpdate`, `timezoneUpdate`, `localeUpdate` and `metaUpdate` are sent whenever they are set, even empty: an empty one detaches the devices from their user, or clears the setting.
- `JSON.stringify` renders a result with Centrifugo's field names (`num_clients`), and errors in it as `{code, message}`.
- `close()` refuses new calls with `ClosedError` and waits for those in progress, automatic batches included.
- Redirects are not followed. A 404 hints at the endpoint's path, or at Centrifugo OSS for a PRO method.

### Timeouts

- `requestTimeout` - 10 seconds by default - bounds every call. A call's `{ timeout }` replaces it for that call, longer or shorter. A call's `{ signal }` only ends it sooner, never later: a call made with a long-lived request handler's signal still gives up on a stuck Centrifugo after `requestTimeout`. A timeout rejects with `TimeoutError`; an abort with the signal's reason, as `fetch` does.
- A timeout of zero is refused, as a negative one is: `requestTimeout` with `InvalidConfigError`; a call's `timeout`, `attemptTimeout` and `pageTimeout` with `InvalidRequestError`. Leave one unset for its default: a call cannot be left unbounded.

### Errors

- `ApiError` for Centrifugo's own errors - `code`, `serverMessage`, `temporary` - with a subclass per known code: `UnknownChannelError`, `BadRequestError`, `NotFoundError`, `NotAvailableError`, `TooManyRequestsError`, `UnrecoverablePositionError`, `InternalError` and the rest. An unknown code is still an `ApiError`.
- `HTTPError` (`status`, `body`, `headers`), with `UnauthorizedError` for refused credentials; `DecodeError` for a reply which is not Centrifugo's; `NetworkError`, `TimeoutError`, `ClosedError`; `InvalidRequestError` for a request refused before sending; `InvalidConfigError` for a client refused as configured. All are `CentError`. Centrifugo's transport error mode gives the same errors as a 200 reply.
- `InvalidConfigError` on a call, too: an endpoint from `getApiEndpoint` which fails `apiEndpoint`'s rules, or an empty or non-printable token from `getBearerToken`, fails the call before sending.
- `FunctionError`: an error `getApiEndpoint` or `getBearerToken` itself throws fails the call as a `FunctionError` naming the function in its message and `function`, with the error as its `cause`.
- `retryable(err)` tells whether a new attempt may succeed: Centrifugo's temporary errors, network failures, timeouts, 429 and 5xx; a `FunctionError` by its cause. A TLS certificate error is not retryable.

### Retries and idempotency

- `exponentialBackoff(base, limit)` and `wait(ms, signal)` for retry loops of your own. The README explains idempotency keys: one per publication or broadcast, reused only to retry that same one. The memory, Redis and PostgreSQL brokers keep keys; the NATS broker ignores them.

### Broadcast and batch

- **A broadcast or batch in which some parts failed rejects**, with `BroadcastFailedChannelsError` or `BatchFailedCommandsError`, whose `result` holds every part's outcome - `failed` lists those which failed, with their errors - also with one channel. One which failed as a whole rejects with its own error, as any call does.
- `broadcastWithRetry` retries only the channels which may still succeed, under one idempotency key, made for the call when the request has none. Its `timeout` bounds the whole call, waits included; `attemptTimeout` is each attempt's own timeout, replacing `requestTimeout` for it, the call's `timeout` and `signal` still ending it sooner; `maxAttempts` and `onAttemptError` decide the retries. An attempt which failed as a whole lists every channel in its result's `failed`, each with that error.
- `client.newBatch({ parallel })`: a method per API method, each returning a `Pending` holding its own outcome once `send()` settled. A command the client can tell is invalid fails the whole batch before sending, naming its index.

### Automatic batching

- `autoBatch: { maxInFlight, maxBatchSize }` sends concurrent calls together once `maxInFlight` requests are in flight, with no timers: below it, every call goes out at once, alone. Each call gets exactly its own reply and keeps its own deadline, and one whose caller gave up while it queued is not sent.

### Pages and positions

- `historyAll`, `deviceListAll`, `deviceTopicListAll`, `userTopicListAll` and `mapReadStateAll`: every item of a paged method as an async iterator, a page read when the loop reaches it and none after the loop leaves. They take `{ pageTimeout, signal }`: `pageTimeout` bounds each page's request, replacing `requestTimeout` for it, and `signal` ends the iteration. An iteration takes no `timeout`: it lasts as long as the loop. `historyAll` needs a `limit` of 1 or more, and refuses `reverse`.
- `historyAll` yields each publication as a `HistoryItem`, with its `position`. `mapReadStateAll` yields each entry as a `MapStateItem`, with `state`, the position of the map's state, and reads every page after the first at the first one's revision: a state reset between pages fails with `UnrecoverablePositionError` instead of mixing two states.
- `position` on every result holding an offset and an epoch - `publish`'s, `history`'s, `mapPublish`'s, `mapRemove`'s, `mapReadState`'s and `mapReadStream`'s: the `since` of the history call reading what came after.

### Constants

- A constant per value of every string field with a fixed set of values, under the names the spec pins for every SDK: `PROVIDER_FCM`, `PLATFORM_IOS`, `OP_ADD`, `STATUS_DELIVERED`, `KEY_MODE_IF_NEW`, `CMP_EQ`, `FILTER_NODE_OP_AND` and the rest; in `jscent/proxy`, `PROTOCOL_JSON`, `ENCODING_BINARY`, `ALLOW_SUB`, `CAPABILITY_MATCH_WILDCARD`, `CHANNEL_EVENT_TYPE_OCCUPIED`, `FILTER_NODE_OP_AND` and the rest. The fields stay strings, so a value a later Centrifugo adds can be sent before jscent names it.

### Payloads

- `data`, `info`, `meta` and the other payloads are JavaScript values, or `rawJSON(text)` for JSON you already have, sent as the same JSON value; a `bigint` is sent exactly. NaN, infinities, bytes, `Map`s and functions are refused before sending, where `JSON.stringify` would change them without a word. A payload from a reply sent back unchanged is the same JSON value, and JSON `null` stays `null`.
- `bigIntegers: true`, as in centrifuge-js, decodes integers past 2^53 in replies as `bigint`.

### Tokens and JWKS

- `jscent/token`: `connection()` and `subscription()` tokens with every claim Centrifugo reads - `profile`, Centrifugo PRO's compression profile, included - signed with HMAC, RSA, ECDSA or Ed25519 keys (`Key.hmac`, `Key.fromPem`, `Key.fromJwk`, `Key.ed25519`). The expiry is required: a `Date`, or `NEVER` for a token accepted forever. Unknown claims are refused, with a hint.
- `jwks(...keys)` and the `JWKS` endpoint publish the public keys, for key rotation without restarts.

### API tokens (Centrifugo PRO)

- `api()` signs a server API token. `ApiTokenSource` issues them and reuses each for half its lifetime - its `token` is the client's `getBearerToken` - with `currentKey` for keys which rotate.

### Endpoints for client SDKs

- `jscent/endpoints`: `ConnectionToken`, `SubscriptionToken` and `SharedPollSignature`, the endpoints the `getToken` callbacks of client SDKs call, and `JWKS`. A function throws `ForbiddenError` to answer 403, on which client SDKs stop asking and report their `UnauthorizedError`.

### Shared poll

- `jscent/sharedpoll`: `sign()` makes the signatures of shared poll subscriptions, the expiry required: a `Date`, or `NEVER`.

### Proxy handlers

- `jscent/proxy`: a handler for every HTTP proxy type - connect, refresh, subscribe, publish, RPC, sub refresh, map publish, map remove, shared poll refresh, and Centrifugo PRO's cache empty and channel state. Its function returns the result, or throws `ProxyError` or `Disconnect`; anything else is a 500 reported to `onError`.
- Every handler and endpoint is a framework-free core, served by `handler.fetch` (Workers, Bun, Deno, Hono, Next.js) and `handler.node` (node:http, Express).

### Commands for async consumers

- `command.publish({ ... })`, and a function like it for every API method, for Centrifugo's [async consumers](https://centrifugal.dev/docs/server/consumers): checked as a call is, its `method` and `payload` for an outbox table, `String(cmd)` for a Kafka message. `JSON.stringify` gives the payload as an object.

### Observability

- `onRequest` is told of every request - method, commands and how many failed, duration, status, error - for metrics without a dependency.

### Testing your code

- Give the client a fake `fetch`: the README shows Centrifugo's reply shapes. `Pending.resolved` and the public constructors of `BroadcastResult` - which takes plain `{ offset, epoch }` channel results - `BatchResult` and the partial-failure errors make test doubles.
