import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { ConnectionToken, JWKS, SharedPollSignature, SubscriptionToken, Unauthorized } from '../../src/endpoints.ts';
import type { HttpRequest } from '../../src/http.ts';
import { rawJSON } from '../../src/index.ts';
import {
  ConnectHandler,
  type ConnectRequest,
  Disconnect,
  NotifyChannelStateHandler,
  ProxyError,
  PublishHandler,
  RefreshHandler,
} from '../../src/proxy/index.ts';
import * as token from '../../src/token.ts';

function collect() {
  const errors: unknown[] = [];
  return { errors, onError: (_: HttpRequest, e: unknown) => errors.push(e) };
}

describe('endpoints for client SDKs, spec section 12', () => {
  it('serves connection tokens', async () => {
    const { errors, onError } = collect();
    const h = new ConnectionToken((http) => `tok-${http.headers.get('X-User')}`, { onError });
    for (const method of ['GET', 'post']) {
      const res = await h.handle({ method, headers: { 'x-user': '42' }, body: 'ignored' });
      expect(res.status).toBe(200);
      expect(res.body).toBe('{"token":"tok-42"}');
      expect(res.headers['Content-Type']).toBe('application/json');
      expect(res.headers['Cache-Control']).toBe('no-store');
    }
    const put = await h.handle({ method: 'PUT' });
    expect([put.status, put.headers.Allow]).toEqual([405, 'GET, POST']);
    expect(errors).toEqual([]);
  });

  it('answers Unauthorized, also as a cause, with 403', async () => {
    const { errors, onError } = collect();
    for (const e of [new Unauthorized(), new Error('wrapped', { cause: new Unauthorized() })]) {
      const h = new ConnectionToken(() => Promise.reject(e), { onError });
      expect((await h.handle({ method: 'GET' })).status).toBe(403);
    }
    expect(errors).toEqual([]);
  });

  it('answers any other error, and a wrong return, with 500 told to onError', async () => {
    const { errors, onError } = collect();
    expect(
      (
        await new ConnectionToken(
          () => {
            throw new Error('db down');
          },
          { onError },
        ).handle({ method: 'GET' })
      ).status,
    ).toBe(500);
    expect((await new ConnectionToken(() => '', { onError }).handle({ method: 'GET' })).status).toBe(500);
    expect(errors.length).toBe(2);
    expect((errors[0] as Error).message).toBe('db down');
  });

  it('serves subscription tokens', async () => {
    const { errors, onError } = collect();
    const h = new SubscriptionToken((_, ch) => `tok-${ch}`, { onError });
    expect((await h.handle({ method: 'POST', body: '{"channel":"news"}' })).body).toBe('{"token":"tok-news"}');
    expect((await h.handle({ method: 'GET', url: '/token?channel=news' })).body).toBe('{"token":"tok-news"}');
    for (const body of ['', '{', '[]', '{"channel":1}', '{"channel":""}', '{"status":200,"headers":{}}']) {
      expect((await h.handle({ method: 'POST', body })).status).toBe(400);
    }
    expect((await h.handle({ method: 'GET' })).status).toBe(400);
    expect(errors.length).toBe(7);
    expect((await h.handle({ method: 'POST', body: ' '.repeat((1 << 20) + 1) })).status).toBe(400);
  });

  it('serves shared poll signatures', async () => {
    const { errors, onError } = collect();
    const h = new SharedPollSignature(
      (_, ch, keys) => ({ keys: keys.filter((k) => k !== 'secret'), signature: `sig-${ch}` }),
      { onError },
    );
    expect((await h.handle({ method: 'POST', body: '{"channel":"c","keys":["a","secret"]}' })).body).toBe(
      '{"signature":"sig-c","keys":["a"]}',
    );
    // Keys always an array, empty included.
    expect((await h.handle({ method: 'POST', body: '{"channel":"c"}' })).body).toBe('{"signature":"sig-c","keys":[]}');
    expect((await h.handle({ method: 'GET' })).status).toBe(405);
    expect((await h.handle({ method: 'POST', body: '{"channel":"c","keys":[1]}' })).status).toBe(400);
    const extra = new SharedPollSignature(() => ({ keys: ['other'], signature: 'sig' }), { onError });
    expect((await extra.handle({ method: 'POST', body: '{"channel":"c","keys":["a"]}' })).status).toBe(500);
    expect(String(errors.at(-1))).toContain('did not ask for');
  });

  it('serves the JWKS', async () => {
    const h = new JWKS((await token.Key.ed25519(new Uint8Array(32).fill(1))).withKeyId('k'));
    const res = await h.handle({ method: 'GET' });
    expect(res.status).toBe(200);
    expect(res.headers['Cache-Control']).toBe('public, max-age=300');
    expect(res.body).toMatch(/^\{"keys":\[\{"kty":"OKP","kid":"k"/);
    expect((await h.handle({ method: 'HEAD' })).body).toBe('');
    expect((await h.handle({ method: 'POST' })).status).toBe(405);
    // A set jwks refuses fails when the endpoint is built.
    expect(() => new JWKS(token.Key.hmac('s').withKeyId('h'))).toThrow();
  });
});

describe('proxy handlers, spec section 14', () => {
  it('answers with exactly one of result, error and disconnect', async () => {
    const { errors, onError } = collect();
    let seen: ConnectRequest | undefined;
    const h = new ConnectHandler(
      (req, http) => {
        seen = req;
        const answer = (req.data as { answer: string }).answer;
        switch (answer) {
          case 'ok':
            return { user: http.headers.get('x-user') ?? '', data: req.data, info: rawJSON('{"n":1.50}') };
          case 'error':
            throw new ProxyError(1000, 'nope', true);
          case 'disconnect':
            throw new Disconnect(4501, 'unauthorized');
          case 'wrapped':
            throw new Error('x', { cause: new Disconnect(4500, 'bye') });
          default:
            throw new Error('bug');
        }
      },
      { onError },
    );
    const res = await h.handle({
      method: 'POST',
      headers: { 'X-User': '42' },
      body: '{"client":"c1","transport":"websocket","data":{"answer":"ok","empty":{}}}',
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe('{"result":{"user":"42","info":{"n":1.50},"data":{"answer":"ok","empty":{}}}}');
    expect(seen?.client).toBe('c1');
    const answer = async (a: string) => (await h.handle({ method: 'POST', body: `{"data":{"answer":"${a}"}}` })).body;
    expect(await answer('error')).toBe('{"error":{"code":1000,"message":"nope","temporary":true}}');
    expect(await answer('disconnect')).toBe('{"disconnect":{"code":4501,"reason":"unauthorized"}}');
    expect(await answer('wrapped')).toBe('{"disconnect":{"code":4500,"reason":"bye"}}');
    expect((await h.handle({ method: 'POST', body: '{"data":{"answer":"bug"}}' })).status).toBe(500);
    expect(errors.map((e) => (e as Error).message)).toEqual(['bug']);
    expect((await h.handle({ method: 'GET' })).status).toBe(405);
    expect((await h.handle({ method: 'POST', body: '{"client":1}' })).status).toBe(400);
    expect((await h.handle({ method: 'POST', body: 'not json' })).status).toBe(400);
  });

  it('fails what a proxy cannot carry with 500', async () => {
    const { errors, onError } = collect();
    expect(
      (
        await new RefreshHandler(
          () => {
            throw new ProxyError(1000, 'x');
          },
          { onError },
        ).handle({ method: 'POST', body: '{}' })
      ).status,
    ).toBe(500);
    expect(
      (
        await new NotifyChannelStateHandler(
          () => {
            throw new Disconnect(4000, 'x');
          },
          { onError },
        ).handle({ method: 'POST', body: '{}' })
      ).status,
    ).toBe(500);
    expect(
      (
        await new NotifyChannelStateHandler(() => {
          throw new ProxyError(1000, 'x');
        }).handle({ method: 'POST', body: '{}' })
      ).body,
    ).toBe('{"error":{"code":1000,"message":"x"}}');
    expect(
      (await new PublishHandler(() => ({ data: Number.NaN }), { onError }).handle({ method: 'POST', body: '{}' }))
        .status,
    ).toBe(500);
    expect(
      (await new PublishHandler(() => null as never, { onError }).handle({ method: 'POST', body: '{}' })).status,
    ).toBe(500);
    expect(errors.length).toBe(4);
    expect((await new RefreshHandler(() => ({ expired: true })).handle({ method: 'POST', body: '{}' })).body).toBe(
      '{"result":{"expired":true}}',
    );
    expect((await new NotifyChannelStateHandler(() => ({})).handle({ method: 'POST', body: '{}' })).body).toBe(
      '{"result":{}}',
    );
  });

  it('carries binary mode', async () => {
    const h = new PublishHandler((req) => ({ b64data: req.b64data }));
    expect((await h.handle({ method: 'POST', body: '{"encoding":"binary","b64data":"AAE="}' })).body).toBe(
      '{"result":{"b64data":"AAE="}}',
    );
  });

  it('bounds the body', async () => {
    const h = new RefreshHandler(() => ({}), { maxBody: 10 });
    expect((await h.handle({ method: 'POST', body: '{"user":"0123456789"}' })).status).toBe(400);
    expect((await h.handle({ method: 'POST', body: '{}' })).status).toBe(200);
    expect(() => new RefreshHandler(() => ({}), { maxBody: 0 })).toThrow();
  });
});

describe('adapters', () => {
  const connect = new ConnectHandler((req, http) => ({
    user: http.headers.get('x-user') ?? '',
    data: { raw: (http.raw as object).constructor.name, got: req.data },
  }));

  it('serve Fetch API requests', async () => {
    const res = await connect.fetch(
      new Request('http://app/centrifugo/connect', { method: 'POST', headers: { 'X-User': '7' }, body: '{"data":1}' }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.text()).toBe('{"result":{"user":"7","data":{"raw":"Request","got":1}}}');
    const big = await new RefreshHandler(() => ({}), { maxBody: 10 }).fetch(
      new Request('http://app/', { method: 'POST', body: 'x'.repeat(100) }),
    );
    expect(big.status).toBe(400);
  });

  it('serve node:http', async () => {
    const server = createServer(connect.node);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/centrifugo/connect`, {
        method: 'POST',
        headers: { 'X-User': '42' },
        body: '{"data":{"x":1}}',
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('{"result":{"user":"42","data":{"raw":"IncomingMessage","got":{"x":1}}}}');
      const get = await fetch(`http://127.0.0.1:${port}/x`);
      expect(get.status).toBe(405);
    } finally {
      server.close();
    }
  });

  it('take a body an Express parser already read', async () => {
    let status = 0;
    let body = '';
    const res = {
      writeHead: (s: number) => {
        status = s;
      },
      end: (b: string) => {
        body = b;
      },
    };
    const req = Object.assign((async function* () {})(), {
      method: 'POST',
      url: '/',
      headers: { 'x-user': '1' },
      body: { data: { y: 2 } },
    });
    await connect.node(req, res);
    expect(status).toBe(200);
    expect(body).toContain('"got":{"y":2}');
  });
});
