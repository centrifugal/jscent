# v1.0.0

A rewrite to the [Centrifugo server SDK specification](https://github.com/centrifugal/gocent/blob/v4_dev/spec.md),
for Centrifugo v6. Migrating from jscent 0.2: see [MIGRATING.md](MIGRATING.md).

- No dependencies: `fetch` and Web Crypto only, on Node.js 22 or newer, Deno, Bun and edge runtimes. TypeScript types included; an ES module, which Node.js 22.12+ also loads with `require`.
- Requests and results are generated from Centrifugo's `api.proto`, with its documentation: every API method, including the map and shared poll methods and those of Centrifugo PRO, on the client, a batch and `command` alike - `client.publish({ channel, data })`. A field jscent does not know is refused, not dropped. Promises, not callbacks.
- One deadline per call - its `timeout` or `requestTimeout`, and its `signal` - over the whole request. Redirects are not followed. Your own `fetch` for tracing, pools and tests.
- Errors: `ApiError` with a subclass per known code, `HTTPError`, `UnauthorizedError`, `DecodeError`, `InvalidRequestError`, `InvalidConfigError`, `NetworkError`, `TimeoutError`, `ClosedError`; `retryable()`; hints in messages; Centrifugo's transport error mode.
- **Breaking:** a broadcast or batch in which some parts failed rejects with `BroadcastFailedChannelsError` or `BatchFailedCommandsError`, carrying every part's outcome. `broadcastWithRetry` retries only the channels which may still succeed, under one idempotency key.
- Automatic batching of concurrent calls (`autoBatch`), with no timers.
- Payloads: plain values or `rawJSON`, sent as the same JSON value - `bigint` exactly - with NaN, bytes and other values JSON cannot hold refused before sending; `bigIntegers`, as in centrifuge-js, for integers past 2^53 in replies.
- `jscent/token`: connection, subscription and Centrifugo PRO server API tokens with every claim (HS256, RS256, ES256/384/512, EdDSA), JWKS, `ApiTokens`.
- `jscent/endpoints`: the token, shared poll signature and JWKS endpoints client SDKs call. `jscent/proxy`: a handler for every proxy type. Each is a framework-free core, served by `handler.fetch` (Workers, Bun, Deno, Hono, Next.js) and `handler.node` (node:http, Express).
- `command.publish(...)` and the like for Centrifugo's async consumers; `jscent/sharedpoll` for shared poll signatures.
