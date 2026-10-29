import { describe, expect, it } from 'vitest';
import { InvalidRequestError } from '../../src/index.ts';
import { sign as sharedPollSign, signAt } from '../../src/sharedpoll.ts';
import * as token from '../../src/token.ts';

const at = (unix: number) => new Date(unix * 1000);
const b64decode = (s: string) =>
  Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));
const part = (tok: string, i: number) => JSON.parse(new TextDecoder().decode(b64decode(tok.split('.')[i]!)));

describe('tokens, spec section 11 and the vectors of 15.1', () => {
  it('matches the vectors', async () => {
    const key = token.Key.hmac('client_secret');
    expect(await token.connection(key, { user: '42', expiresAt: at(1700003600), issuedAt: at(1700000000) })).toBe(
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI0MiIsImV4cCI6MTcwMDAwMzYwMCwiaWF0IjoxNzAwMDAwMDAwfQ.HKZwmcYmHVbRESuYd4swVgAH7gg41giR57F_K5FEmEY',
    );
    expect(
      await token.subscription(key, {
        channel: 'news',
        user: '42',
        expiresAt: at(1700003600),
        issuedAt: at(1700000000),
      }),
    ).toBe(
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI0MiIsImV4cCI6MTcwMDAwMzYwMCwiaWF0IjoxNzAwMDAwMDAwLCJjaGFubmVsIjoibmV3cyJ9.v_Quw-azNV1qFjm9ZQnkp6QBtK6LmtFxY74YcUHlJcA',
    );
    expect(
      await signAt(
        'shared_poll_secret',
        { user: '42', channel: 'poll:prices', keys: ['AAPL', 'GOOG'], expiresAt: at(1700003600) },
        1700000000,
      ),
    ).toBe('1700000000:1700003600:c61dbf52085a6973537e71644fa30a3bbfc29a52d7ce9f1b7618531596ce587d');
    expect(
      await signAt(
        'shared_poll_secret',
        { user: '', channel: 'poll:prices', keys: [], expiresAt: token.NEVER },
        1700000000,
      ),
    ).toBe('1700000000:0:92dd64af5612afde06cad03bb63435d951e037cb55a087af05c2a1399abade0e');
  });

  it('writes the expiries', async () => {
    const key = token.Key.hmac('s');
    const never = part(await token.connection(key, { expiresAt: token.NEVER }), 1);
    expect(never.exp).toBeUndefined();
    expect(never.expire_at).toBeUndefined();
    expect(never.sub).toBe('');
    const c = part(await token.connection(key, { expiresAt: at(2000000000), connectionExpiresAt: token.NEVER }), 1);
    expect([c.exp, c.expire_at]).toEqual([2000000000, 0]);
    const s = part(
      await token.subscription(key, { channel: 'c', expiresAt: at(2000000000), subscriptionExpiresAt: at(2000000100) }),
      1,
    );
    expect(s.expire_at).toBe(2000000100);
    expect(Math.abs(s.iat - Date.now() / 1000)).toBeLessThan(5);
    await expect(token.connection(key, {} as never)).rejects.toThrow('expiresAt is required');
  });

  it('writes every claim, in order', async () => {
    const key = token.Key.hmac('s');
    const c = part(
      await token.connection(key, {
        expiresAt: at(2000000000),
        user: 'u',
        id: 'j',
        audience: 'a',
        issuer: 'i',
        info: { name: 'Alice' },
        subs: { ch: { data: {}, override: { presence: true } } },
        meta: { plan: 'pro' },
        caps: [{ channels: ['news'], allow: ['sub'] }],
        labels: { region: 'eu' },
      }),
      1,
    );
    expect(Object.keys(c)).toEqual([
      'sub',
      'exp',
      'iat',
      'jti',
      'aud',
      'iss',
      'info',
      'subs',
      'meta',
      'caps',
      'labels',
    ]);
    expect(c.subs).toEqual({ ch: { data: {}, override: { presence: { value: true } } } });
    const s = part(
      await token.subscription(key, {
        channel: 'c',
        expiresAt: at(2000000000),
        data: [1],
        allow: ['pub'],
        b64info: 'AA==',
      }),
      1,
    );
    expect(Object.keys(s)).toEqual(['sub', 'exp', 'iat', 'channel', 'b64info', 'data', 'allow']);
  });

  it('refuses what it must', async () => {
    const key = token.Key.hmac('s');
    await expect(token.connection(key, { expiresAt: token.NEVER, channels: ['a'], subs: { b: {} } })).rejects.toThrow(
      'not both',
    );
    await expect(token.subscription(key, { channel: '', expiresAt: token.NEVER })).rejects.toThrow('needs a channel');
    expect(() => token.Key.hmac('')).toThrow();
    await expect(token.Key.ed25519(new Uint8Array(3))).rejects.toThrow('32 bytes');
    expect(() => key.withKeyId('')).toThrow();
    // A payload which is not JSON fails at signing.
    await expect(token.connection(key, { expiresAt: token.NEVER, info: Number.NaN })).rejects.toThrow(
      InvalidRequestError,
    );
  });

  it.each([
    [
      'RS256',
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      { name: 'RSASSA-PKCS1-v1_5' },
    ],
    ['ES256', { name: 'ECDSA', namedCurve: 'P-256' }, { name: 'ECDSA', hash: 'SHA-256' }],
    ['ES384', { name: 'ECDSA', namedCurve: 'P-384' }, { name: 'ECDSA', hash: 'SHA-384' }],
    ['ES512', { name: 'ECDSA', namedCurve: 'P-521' }, { name: 'ECDSA', hash: 'SHA-512' }],
    ['EdDSA', { name: 'Ed25519' }, { name: 'Ed25519' }],
  ])('signs %s from a PEM and a JWK, verifiably', async (alg, gen, verifyAlg) => {
    const pair = (await crypto.subtle.generateKey(gen as never, true, ['sign', 'verify'])) as CryptoKeyPair;
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8))}\n-----END PRIVATE KEY-----\n`;
    for (const key of [
      await token.Key.fromPem(pem),
      await token.Key.fromJwk(await crypto.subtle.exportKey('jwk', pair.privateKey)),
    ]) {
      const k = key.withKeyId(`k-${alg}`);
      expect(k.alg).toBe(alg);
      const tok = await token.connection(k, { user: '1', expiresAt: token.NEVER });
      expect(part(tok, 0)).toEqual({ alg, typ: 'JWT', kid: `k-${alg}` });
      const [h, p, s] = tok.split('.');
      expect(
        await crypto.subtle.verify(
          verifyAlg as never,
          pair.publicKey,
          b64decode(s!),
          new TextEncoder().encode(`${h}.${p}`),
        ),
      ).toBe(true);
      // The JWKS publishes the public key, and only it.
      const set = JSON.parse(token.jwks(k)).keys[0];
      expect(set.d).toBeUndefined();
      expect(set.use).toBe('sig');
      expect(set.alg).toBe(alg);
    }
  });

  it('refuses other curves and old PEM formats', async () => {
    await expect(
      token.Key.fromPem('-----BEGIN EC PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----'),
    ).rejects.toThrow('pkcs8');
    await expect(token.Key.fromJwk({ kty: 'EC', crv: 'secp256k1', x: 'a', y: 'b', d: 'c' })).rejects.toThrow(
      'want P-256, P-384 or P-521',
    );
    await expect(token.Key.fromJwk({ kty: 'EC', crv: 'P-256', x: 'a', y: 'b' })).rejects.toThrow('no private part');
  });

  it('makes JWKS by its rules', async () => {
    const seed = new Uint8Array(32).fill(1);
    const ed = (await token.Key.ed25519(seed)).withKeyId('e');
    expect(token.jwks(ed)).toBe(
      '{"keys":[{"kty":"OKP","kid":"e","use":"sig","alg":"EdDSA","crv":"Ed25519","x":"iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w"}]}',
    );
    const other = (await token.Key.ed25519(new Uint8Array(32).fill(2))).withKeyId('e');
    for (const keys of [[], [token.Key.hmac('s').withKeyId('h')], [await token.Key.ed25519(seed)], [ed, other]]) {
      expect(() => token.jwks(...keys)).toThrow();
    }
  });

  it('issues API tokens, reused for half their TTL', async () => {
    const key = (await token.Key.ed25519(new Uint8Array(32).fill(3))).withKeyId('api');
    const claims = { audience: 'centrifugo-api', scope: ['centrifugo:api', 'b'] };
    const tokens = new token.ApiTokens({ claims, key });
    const t = await tokens.token();
    expect(await tokens.token()).toBe(t);
    const c = part(t, 1);
    expect(c.scope).toBe('centrifugo:api b');
    expect(c.aud).toBe('centrifugo-api');
    expect(c.exp - c.iat).toBe(300);
    const short = new token.ApiTokens({ claims, currentKey: () => key, ttl: 2000 });
    const first = await short.token();
    await new Promise((r) => setTimeout(r, 1100));
    expect(await short.token()).not.toBe(first);

    const exp = new Date(Date.now() + 60_000);
    await expect(token.api(token.Key.hmac('s').withKeyId('h'), { audience: 'a', expiresAt: exp })).rejects.toThrow(
      'RSA, ECDSA or Ed25519',
    );
    await expect(
      token.api(await token.Key.ed25519(new Uint8Array(32).fill(3)), { audience: 'a', expiresAt: exp }),
    ).rejects.toThrow('key ID');
    await expect(token.api(key, { expiresAt: exp })).rejects.toThrow('audience or scope');
    await expect(token.api(key, { audience: 'a' })).rejects.toThrow('expiresAt');
    await expect(token.api(key, { scope: [''], expiresAt: exp })).rejects.toThrow('scope');
    await expect(token.api(key, { scope: ['a b'], expiresAt: exp })).rejects.toThrow('scope');
    expect(() => new token.ApiTokens({ claims: { audience: 'a', expiresAt: exp }, key })).toThrow();
    expect(() => new token.ApiTokens({ claims })).toThrow();
    expect(() => new token.ApiTokens({ claims, key, currentKey: () => key })).toThrow();
    expect(() => new token.ApiTokens({ claims, key, ttl: -1 })).toThrow();
  });

  it('signs shared poll keys', async () => {
    const never: token.Expiry = token.NEVER;
    expect(await sharedPollSign('s', { user: 'u', channel: 'c', keys: ['a'], expiresAt: never })).toMatch(
      /^\d+:0:[0-9a-f]{64}$/,
    );
    expect(await signAt('s', { user: 'alice', channel: 'news:tech', keys: [], expiresAt: never }, 1)).not.toBe(
      await signAt('s', { user: 'alice:news', channel: 'tech', keys: [], expiresAt: never }, 1),
    );
    await expect(sharedPollSign('', { user: 'u', channel: 'c', keys: [], expiresAt: never })).rejects.toThrow();
    // The expiry is chosen explicitly: never is spelled, a number or unset refused.
    for (const expiresAt of [undefined, 3600, 1700000000]) {
      await expect(sharedPollSign('s', { user: 'u', channel: 'c', keys: [], expiresAt } as never)).rejects.toThrow(
        'token.NEVER',
      );
    }
    await expect(
      sharedPollSign('s', { user: 'u', channel: 'c', keys: [], expiresAt: never, expires_at: 1 } as never),
    ).rejects.toThrow('unknown sign option expires_at: did you mean expiresAt?');
  });

  it('refuses unknown claims', async () => {
    const key = token.Key.hmac('secret');
    const exp = new Date(Date.now() + 60_000);
    await expect(token.connection(key, { user: '42', expiresAt: exp, expire_at: 1 } as never)).rejects.toThrow(
      'unknown connection claim expire_at: did you mean connectionExpiresAt?',
    );
    await expect(token.connection(key, { sub: '42', expiresAt: exp } as never)).rejects.toThrow('did you mean user?');
    await expect(token.subscription(key, { channel: 'c', expiresAt: exp, expireAt: exp } as never)).rejects.toThrow(
      'did you mean subscriptionExpiresAt?',
    );
    await expect(token.subscription(key, { channel: 'c', expiresAt: exp, b64Data: 'x' } as never)).rejects.toThrow(
      'did you mean b64data?',
    );
    // An unset key is no key.
    await token.connection(key, { user: '42', expiresAt: exp, info: undefined });
  });
});
