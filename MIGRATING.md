# Migrating from jscent 0.2 to jscent 1

jscent 1 is a rewrite, to the
[Centrifugo server SDK specification](https://github.com/centrifugal/gocent/blob/master/spec.md).
jscent 0.2 was written for Centrifugo 1, whose API requests were signed with
the secret; Centrifugo v6 refuses them, so code using jscent 0.2 does not work
with it at all, and moves over call by call, as the table below shows.

What changes:

- **Promises, not callbacks.** Every method resolves to its result or rejects
  with an error; there is no callback argument.
- **Every API method of Centrifugo v6** - the PRO ones included - takes its
  request's fields and resolves to a typed result:
  `client.publish({ channel: 'news', data })`.
- **Errors are errors.** Centrifugo's errors reject with `ApiError`, with a
  subclass per known code; HTTP statuses, network failures and timeouts reject
  with their own errors, all `CentError`. **Broadcasts and batches reject when
  any part failed**, with every part's outcome in the error: see below.
- **Credentials:** an API key, sent as `X-API-Key`, or a bearer token for
  Centrifugo PRO - not a secret signing each request.
- **Tokens** are made with `connection()` and `subscription()` of
  `jscent/token`, with every claim Centrifugo reads, HMAC, RSA, ECDSA or
  Ed25519 keys, and a required expiry: `NEVER` for a token accepted forever.
- **Runtimes:** Node.js 22 or newer, Deno, Bun and edge runtimes, with no
  dependencies. jscent is an ES module, which CommonJS code loads with
  `require('jscent')` on Node.js 22.12 or newer.
- **New:** proxy handlers, the endpoints client SDKs call, JWKS, Centrifugo
  PRO's API tokens, shared poll signatures, commands for async consumers,
  `broadcastWithRetry`, automatic batching, and your own `fetch`.

## The client

jscent 0.2 took the server's URL and appended `/api` itself. jscent 1 takes
the API's URL, `/api` included, checks it when the client is created, and
refuses a URL ending in a method name:

```js
// jscent 0.2
const Client = require('jscent');
const client = new Client({ url: 'http://localhost:8000', secret: 'SECRET', timeout: 5000 });
client.publish('news', { text: 'hi' }, (err, res) => { /* ... */ });

// jscent 1
import { Client } from 'jscent';
const client = new Client({ apiEndpoint: 'http://localhost:8000/api', apiKey: process.env.CENTRIFUGO_API_KEY, requestTimeout: 5000 });
const res = await client.publish({ channel: 'news', data: { text: 'hi' } });
```

An option jscent 1 does not know is refused, with a hint: `url`, `secret`
and `timeout` fail with `InvalidConfigError` naming `apiEndpoint`, `apiKey`
and `requestTimeout`. `strictSSL` is gone, refused with a hint to `fetch`:
TLS belongs to your own `fetch` (with an undici `Agent`, say).

## Timeouts

`requestTimeout`, in milliseconds as 0.2's `timeout` was, bounds every call:
10 seconds by default, where 0.2 had none. A call can pass its own:

```ts
await client.publish({ channel, data }, { timeout: 2_000 }); // replaces requestTimeout for this call
await client.publish({ channel, data }, { signal: req.signal }); // only ends the call sooner
```

A `signal` never makes a call wait longer than its timeout: a call made with
the signal of a request handler which lives for minutes still gives up after
`requestTimeout`. A timeout rejects with `TimeoutError`, an abort with the
signal's reason. A timeout of zero is refused: leave it unset for the
default.

## Requests checked before sending

A request jscent can tell is wrong rejects with `InvalidRequestError` and is
not sent: a field it does not know (`skip_history` instead of
`skipHistory`), a field Centrifugo requires left unset or empty
(`client.history({ channel: '' })`), a publication without data, a payload
JSON cannot hold (NaN, a `Map`, bytes). Where 0.2 sent these and Centrifugo
answered with an error, jscent 1 fails at the call.

A nested message with nothing set is not sent, as an empty field is not.
`deviceUpdate`'s updates are the exception: an empty `userUpdate` detaches the
devices from their user, an empty `timezoneUpdate` clears the timezone.

## History reads what you ask for

Centrifugo v6's `history` returns publications only with a `limit`; without
one it gives the stream's position alone. Pass a `limit`, or read every
publication a page at a time:

```ts
const { publications } = await client.history({ channel: 'news', limit: 100 });
for await (const item of client.historyAll({ channel: 'news', limit: 100 })) {
  handle(item.data);
}
```

## Broadcasts and batches reject when a part failed

A broadcast or batch in which any channel or command failed rejects - with
`BroadcastFailedChannelsError` or `BatchFailedCommandsError` - even when the
others succeeded. Decide, for each one, which you want:

- **A failure is an error** - an unknown channel is a bug, a broker failure
  needs attention: let it reject, and your error reporting sees it.
- **Best effort** - publish where it can, log the rest: catch the error. It
  holds every part's outcome, and the parts which succeeded were published.

```ts
try {
  await client.broadcast({ channels, data });
} catch (e) {
  if (!(e instanceof BroadcastFailedChannelsError)) throw e;
  for (const ch of e.result.failed) {
    logger.warn(`broadcast to ${ch.channel} failed: ${ch.error?.message}`);
  }
}
```

Catch these two errors only. A broadcast or batch which failed as a whole -
the network, the credentials, Centrifugo down - rejects with its own error, as
any call does, and no part of it was published. To retry the channels which
failed for a temporary reason, use `broadcastWithRetry`.

## Reference

| jscent 0.2 | jscent 1 |
|---|---|
| `const Client = require('jscent')` | `import { Client } from 'jscent'` |
| `new Client({ url, secret, timeout, strictSSL })` | `new Client({ apiEndpoint: 'http://localhost:8000/api', apiKey, requestTimeout })` - the endpoint is the API's URL, `/api` included. TLS options belong to your `fetch` |
| `client.publish(channel, data, (err, res) => ...)` | `await client.publish({ channel, data })` |
| `client.publishClient(channel, data, clientId, cb)` | gone with Centrifugo 1: publish as above |
| `client.unsubscribe(user, channel, cb)` | `await client.unsubscribe({ user, channel })` |
| `client.disconnect(user, cb)` | `await client.disconnect({ user })` |
| `client.presence(channel, cb)` | `await client.presence({ channel })` |
| `client.history(channel, cb)` | `await client.history({ channel, limit: 100 })`, or `client.historyAll(...)` for every publication |
| `client.channels(cb)` | `await client.channels({})` |
| `client.stats(cb)` | `await client.info()` |
| `client.add(...)`, `client.send(cb)` | `const batch = client.newBatch(); const p = batch.publish({ channel, data }); await batch.send(); p.result()` |
| `new Token(secret).clientToken(user, timestamp, info)` | `await token.connection(token.Key.hmac(secret), { user, expiresAt, info })` |
| `new Token(secret).channelSign(client, channel, info)` | `await token.subscription(token.Key.hmac(secret), { channel, user, expiresAt, info })` - Centrifugo v6 has subscription tokens instead |
| `RequestError` (`statusCode`, `body`, `error`) | `HTTPError` (`status`, `body`, `headers`) and `UnauthorizedError`, `NetworkError` (fetch's error as `cause`), `TimeoutError`, `DecodeError`; `ApiError` for Centrifugo's own errors, with a subclass per known code; all are `CentError` |
| `Client.Token`, `Client.RequestError` | `import * as token from 'jscent/token'`; the errors from `jscent` |

For tests, give the client a fake `fetch` instead of mocking it: see
[Testing your code](README.md#testing-your-code).
