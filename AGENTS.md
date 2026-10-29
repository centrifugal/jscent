# Working on jscent

jscent is the JavaScript and TypeScript SDK for Centrifugo's HTTP server API,
written to the
[Centrifugo server SDK specification](https://github.com/centrifugal/gocent/blob/master/spec.md),
whose reference implementation is gocent. Applications call it on their hot
paths, on Node.js, Deno, Bun and edge runtimes, so it has to be correct under
concurrency, hard to misuse, and use web standards only. Read this before
changing code.

## Layout

| Path | What |
|---|---|
| `proto/api.proto`, `proto/proxy.proto` | Copies of Centrifugo's protos, from a released tag (`CENTRIFUGO_REF=v6.10.2 npm run sync-proto`) |
| `gen/` | `proto.ts` parses the protos, `generate.ts` writes `src/generated/`, `api_docs.ts` writes `API.md` from `dist/`'s declarations |
| `src/generated/` | Generated - never edited: request and result types, field descriptors, the methods of the client, a batch and `command` |
| `API.md` | The API reference - never edited |
| `src/client.ts` | `Client`: configuration, the fetch transport, broadcast, `broadcastWithRetry`, automatic batching |
| `src/wire.ts`, `src/payload.ts` | Encoding requests and decoding replies from the descriptors; payloads, `rawJSON`, `bigIntegers` |
| `src/errors.ts` | The errors and `retryable` |
| `src/batch.ts`, `src/broadcast.ts`, `src/retry.ts`, `src/command.ts` | Batches, broadcast results, backoff, commands |
| `src/http.ts` | The HTTP handlers' framework-free core and its Fetch and Node.js adapters |
| `src/endpoints.ts`, `src/proxy/`, `src/token.ts`, `src/sharedpoll.ts` | Endpoints for client SDKs, proxy handlers, tokens, shared poll signatures - each a package entry point |
| `test/unit/`, `test/integration/` | Unit tests against a fake Centrifugo (a fake `fetch`) and a local HTTP server; integration tests against a real Centrifugo |
| `testdata/` | The Centrifugo config and the Centrifugo PRO compose file the integration tests use |

## Invariants

These are not preferences. A change that breaks one is wrong even if every test
passes; if you find yourself about to break one, stop and say so instead.

1. **The generated files are never edited.** Change `proto/` or `gen/`, then
   `npm run generate`; `npm run check` fails when they, or `API.md`, are
   stale.
2. **Web standards only at run time.** `src/` uses `fetch`, Web Crypto,
   `AbortSignal`, `TextEncoder` and the like - no `node:` modules, no
   dependencies - so the same build runs on Node.js, Deno, Bun and Workers.
   The Node.js adapter takes node:http's objects structurally, without
   importing them.
3. **A call rejects unless it did everything asked.** A broadcast or batch in
   which some parts failed rejects with `BroadcastFailedChannelsError` or
   `BatchFailedCommandsError`, whose `result` holds every part's outcome. A
   partial error is never an `ApiError` of its parts - also with one channel.
4. **Errors follow Centrifugo's model.** A Centrifugo error is an `ApiError`,
   the subclass of its code when known; the transport error mode gives the
   same error as a 200 reply.
5. **One deadline per call.** Its `timeout` - or `requestTimeout` - becomes an
   `AbortSignal.timeout` combined with the caller's `signal`, bounding the
   fetch and the body read: any timeout is a `TimeoutError`, a caller's abort
   rejects with the signal's reason.
6. **A payload is carried exactly.** Plain values are encoded with
   `JSON.stringify`, refusing what it would silently change (NaN, bytes, Maps,
   functions); `bigint` through `JSON.rawJSON`; `rawJSON` spliced in as its
   text. Replies decode with `JSON.parse`, with `bigIntegers` the spec's
   reviver.
7. **A caller's fetch is never changed**: credentials and headers go on each
   request.
8. **Automatic batching never delays a call below `maxInFlight`**, never gives
   a caller a reply which is not its own, never sends a call whose caller gave
   up while it queued, and `close` waits for batches whose callers left.
9. **A handler answers with exactly one of result, error and disconnect,** as
   its proxy type can carry them; anything else is a 500 reported to
   `onError`.
10. **The published types are what users compile against.** `stripInternal`
    drops what is `@internal`: never mark something a public type refers to
    as internal (`npm run build`, then a consumer's `tsc`, catches it).

## Running things

```
npm install                 # the dev tools
npm run check               # generated code, Biome, tsc, unit tests, build, API.md: what CI runs
npm run test:integration    # against Centrifugo on :8100
```

The integration tests need a Centrifugo set up as `testdata/` says:

```
docker compose -f testdata/centrifugo-pro.compose.yml up -d --wait
JSCENT_TEST_PRO=1 npm run test:integration
```

They serve the proxy handlers on port 3100 and an API JWKS on 3101 of the host,
which Centrifugo reaches as `host.docker.internal`.

## Updating to a new Centrifugo API

1. `CENTRIFUGO_REF=vX.Y.Z npm run sync-proto` - always a released tag.
2. Read the diff of `proto/`: a removed field is a breaking change.
3. `npm run check`, then the integration tests against the new release.
4. Bump the Centrifugo image in `.github/workflows/ci.yml` and
   `testdata/centrifugo-pro.compose.yml`, and the versions table in the README
   when a feature needs the new release.

## Releasing

Push a tag, `v1.0.0` say: `release.yml` sets the package version from it,
checks and builds, publishes to npm with provenance - through npm's trusted
publishing, no token - and creates the GitHub release. A tag with a
pre-release part, `v1.0.0-beta.1`, publishes under npm's `next` tag.
`package.json` keeps `0.0.0-development`: the tag is the version.

## Things that look wrong but are deliberate

- **Plain objects, a method per API method**, as the spec says for JavaScript
  (3.3): `client.publish({ ... })`, `batch.publish({ ... })`,
  `command.publish({ ... })`. The method a request goes to is the function
  called, so no request carries it; the types name the fields.
- **Unknown fields are refused**, in every message encoded - requests, claims,
  proxy results: a typo or a snake_case name would otherwise be dropped
  without a word.
- **Milliseconds**, not seconds: JavaScript's timeouts are milliseconds.
- **Every request's fields are optional in its type.** Centrifugo checks what
  is required; the client checks only what the spec lists (a publication's
  channel and data).
- **Integer fields of results are numbers even with `bigIntegers`**: the
  option is for payloads; offsets and counts stay below 2^53.
- **No `Symbol.asyncDispose`**: it would put a lib requirement into the
  published types.
- **`rpc` is not offered**: it calls server API extensions, which Centrifugo
  does not provide.
- **An oversized handler body is a 400**, as in gocent, not a 413.
