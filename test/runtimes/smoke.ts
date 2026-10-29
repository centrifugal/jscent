// Runs the built package on one runtime - Node.js, Deno or Bun - against a
// fake Centrifugo: requests, payloads, tokens through Web Crypto, and a
// handler's Fetch adapter. CI runs it on each:
//
//     node test/runtimes/smoke.ts && deno run test/runtimes/smoke.ts && bun test/runtimes/smoke.ts

import { BroadcastFailedChannelsError, Client, command, rawJSON } from '../../dist/index.js';
import { ConnectHandler } from '../../dist/proxy/index.js';
import { sign } from '../../dist/sharedpoll.js';
import * as token from '../../dist/token.js';

function check(ok: boolean, what: string): void {
  if (!ok) {
    throw new Error(`smoke: ${what}`);
  }
}

const sent: string[] = [];
const client = new Client({
  apiEndpoint: 'http://centrifugo.test/api',
  apiKey: 'k',
  bigIntegers: true,
  fetch: async (url, init) => {
    sent.push(String(init?.body));
    if (String(url).endsWith('/broadcast')) {
      return Response.json({
        result: { responses: [{ result: { offset: 1 } }, { error: { code: 102, message: 'unknown channel' } }] },
      });
    }
    return new Response('{"result":{"offset":9007199254740993,"epoch":"e"}}', {
      headers: { 'Content-Type': 'application/json' },
    });
  },
});

const res = await client.publish({
  channel: 'c',
  data: { big: 18446744073709551617n, raw: rawJSON('{"n": 1.50}'), empty: {} },
});
check(
  sent[0] === '{"channel":"c","data":{"big":18446744073709551617,"raw":{"n": 1.50},"empty":{}}}',
  `payload sent as ${sent[0]}`,
);
check(res.offset === 9007199254740992 && res.epoch === 'e', 'result decoded');
try {
  await client.broadcast({ channels: ['a', 'b'], data: 1 });
  check(false, 'partial broadcast resolved');
} catch (e) {
  check(e instanceof BroadcastFailedChannelsError && e.failed[0]?.channel === 'b', 'partial broadcast error');
}

const at = (s: number) => new Date(s * 1000);
check(
  (await token.connection(token.Key.hmac('client_secret'), {
    user: '42',
    expiresAt: at(1700003600),
    issuedAt: at(1700000000),
  })) ===
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI0MiIsImV4cCI6MTcwMDAwMzYwMCwiaWF0IjoxNzAwMDAwMDAwfQ.HKZwmcYmHVbRESuYd4swVgAH7gg41giR57F_K5FEmEY',
  'HS256 vector',
);
check(
  /^\d+:0:[0-9a-f]{64}$/.test(
    await sign('shared_poll_secret', { user: '', channel: 'poll:prices', keys: [], expiresAt: token.NEVER }),
  ),
  'shared poll signature',
);
const ed = (await token.Key.ed25519(new Uint8Array(32).fill(1))).withKeyId('e');
check(token.jwks(ed).includes('"x":"iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w"'), 'Ed25519 JWKS');
for (const curve of ['P-256', 'P-384', 'P-521']) {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: curve }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const key = await token.Key.fromJwk(await crypto.subtle.exportKey('jwk', pair.privateKey));
  check((await token.connection(key, { expiresAt: token.NEVER })).split('.').length === 3, `ECDSA ${curve}`);
}

check(
  command.publish({ channel: 'c', data: 1 }).toString() === '{"method":"publish","payload":{"channel":"c","data":1}}',
  'command',
);
const batchClient = new Client({
  apiEndpoint: 'http://centrifugo.test/api',
  fetch: async () => Response.json({ replies: [{ publish: { offset: 3 } }] }),
});
const batch = batchClient.newBatch();
const pub = batch.publish({ channel: 'c', data: 1 });
await batch.send();
check(pub.result().offset === 3, 'batch');

const connect = new ConnectHandler((req, http) => ({ user: http.headers.get('x-user') ?? '', data: req.data }));
const out = await connect.fetch(
  new Request('http://app/', { method: 'POST', headers: { 'X-User': '7' }, body: '{"data":{"a":{}}}' }),
);
check((await out.text()) === '{"result":{"user":"7","data":{"a":{}}}}', 'proxy handler');

console.log('smoke ok');
