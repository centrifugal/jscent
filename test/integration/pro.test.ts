// Centrifugo PRO methods, API tokens and async consumers, against the
// Centrifugo PRO of testdata/centrifugo-pro.compose.yml: user status, user
// blocking and token revocation in Redis, devices in PostgreSQL, push
// notifications through webpush in dry run.
//
// The tests use Centrifugo PRO in sandbox mode, without a license key.
// Centrifugo PRO is commercial software, under the Centrifugal Labs License
// Agreement (https://centrifugal.dev/license), not under jscent's MIT license.

import { connect as tcp } from 'node:net';
import { describe, expect, it } from 'vitest';
import { JWKS } from '../../src/endpoints.ts';
import {
  Client,
  command,
  NotAvailableError,
  OP_ADD,
  PLATFORM_WEB,
  PROVIDER_WEBPUSH,
  STATUS_DELIVERED,
  UnauthorizedError,
} from '../../src/index.ts';
import * as token from '../../src/token.ts';
import { ADDR, pro, serve, stop, unique } from './setup.ts';

/** A browser PushSubscription, as webpush devices are registered with. */
async function webpushToken(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const e = (b: Uint8Array) =>
    btoa(String.fromCharCode(...b))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');
  return JSON.stringify({
    endpoint: `https://fcm.googleapis.com/fcm/send/${e(pub.slice(0, 8))}`,
    keys: { p256dh: e(pub), auth: e(new Uint8Array(16)) },
  });
}

describe('Centrifugo PRO', () => {
  it('user status', async (ctx) => {
    const c = await pro();
    if (!c) return ctx.skip();
    const user = unique();
    await c.updateUserStatus({ users: [user], state: 'away' });
    const st = (await c.getUserStatus({ users: [user] })).statuses[0]!;
    expect([st.user, st.state]).toEqual([user, 'away']);
    expect(st.active).toBeGreaterThan(0);
    await c.deleteUserStatus({ users: [user] });
    expect((await c.getUserStatus({ users: [user] })).statuses[0]!.active).toBe(0);
  });

  it('user and token control', async (ctx) => {
    const c = await pro();
    if (!c) return ctx.skip();
    const user = unique();
    const expireAt = Math.floor(Date.now() / 1000) + 60;
    await c.blockUser({ user, expireAt });
    await c.unblockUser({ user });
    await c.revokeToken({ uid: `${user}-jti`, expireAt });
    await c.invalidateUserTokens({ user, issuedBefore: Math.floor(Date.now() / 1000), expireAt });
  });

  it('devices and push', async (ctx) => {
    const c = await pro();
    if (!c) return ctx.skip();
    const user = unique();
    const reg = await c.deviceRegister({
      provider: PROVIDER_WEBPUSH,
      platform: PLATFORM_WEB,
      token: await webpushToken(),
      user,
      meta: { app: 'jscent' },
      topics: ['news'],
    });
    expect(reg.id).not.toBe('');
    const byUser = { users: [user] };
    const list = await c.deviceList({
      filter: byUser,
      includeMeta: true,
      includeTopics: true,
      includeTotalCount: true,
    });
    expect(list.totalCount).toBe(1);
    expect(list.items[0]!.id).toBe(reg.id);
    expect(list.items[0]!.meta).toEqual({ app: 'jscent' });
    expect(list.items[0]!.topics).toContain('news');
    await c.deviceTopicUpdate({ deviceId: reg.id, op: OP_ADD, topics: ['sport'] });
    expect((await c.deviceTopicList({ filter: { deviceIds: [reg.id] }, includeTotalCount: true })).totalCount).toBe(2);
    await c.deviceUpdate({
      ids: [reg.id],
      metaUpdate: { meta: { app: 'updated' } },
      timezoneUpdate: { timezone: 'Europe/Berlin' },
    });
    const updated = (await c.deviceList({ filter: byUser, includeMeta: true })).items[0]!;
    expect(updated.meta).toEqual({ app: 'updated' });
    expect(updated.timezone).toBe('Europe/Berlin');
    // An empty update is sent, and clears it.
    await c.deviceUpdate({ ids: [reg.id], timezoneUpdate: { timezone: '' } });
    expect((await c.deviceList({ filter: byUser })).items[0]!.timezone).toBe('');
    await c.userTopicUpdate({ user, op: OP_ADD, topics: ['alerts'] });
    expect((await c.userTopicList({ filter: { users: [user] } })).items.map((i) => i.topic)).toEqual(['alerts']);
    const push = await c.sendPushNotification({
      recipient: { filter: byUser },
      notification: { webpush: { payload: { title: 'hi' } } },
      sendAt: Math.floor(Date.now() / 1000) + 3600,
    });
    expect(push.uid).not.toBe('');
    await c.cancelPush({ uid: push.uid });
    // Push status needs push analytics in ClickHouse; without it, the method is not available.
    await c.updatePushStatus({ analyticsUid: push.uid, status: STATUS_DELIVERED, deviceId: reg.id }).catch((e) => {
      expect(e).toBeInstanceOf(NotAvailableError);
    });
    await c.deviceRemove({ ids: [reg.id] });
    expect((await c.deviceList({ filter: byUser })).items).toEqual([]);
  });

  // Every part the checks before sending look into: each request sets
  // exactly what Centrifugo requires, so a check stricter than its own fails
  // here.
  it('push with rate and time limits, a device detached by an empty update, devices page by page', async (ctx) => {
    const c = await pro();
    if (!c) return ctx.skip();
    const user = unique();
    const ids: string[] = [];
    try {
      for (let i = 0; i < 3; i++) {
        const reg = await c.deviceRegister({
          provider: PROVIDER_WEBPUSH,
          platform: PLATFORM_WEB,
          token: await webpushToken(),
          user,
        });
        ids.push(reg.id);
      }
      const byUser = { users: [user] };
      const seen: string[] = [];
      for await (const d of c.deviceListAll({ filter: byUser, limit: 2 })) {
        seen.push(d.id);
      }
      expect(seen.sort()).toEqual([...ids].sort());

      const strategies = {
        'rate limit': { rateLimit: { key: 'device.id', policies: [{ rate: 1, intervalMs: 60000 }] } },
        'time limit': { timeLimit: { sendAfterTime: '09:00:00', sendBeforeTime: '21:00:00', noTzSendNow: true } },
      };
      for (const [name, limitStrategy] of Object.entries(strategies)) {
        const now = Math.floor(Date.now() / 1000);
        const push = await c.sendPushNotification({
          recipient: { filter: byUser },
          // A limit strategy needs expireAt: a push the limits hold back is
          // not tried forever.
          notification: { webpush: { payload: { title: 'hi' } }, expireAt: now + 7200 },
          limitStrategy,
          sendAt: now + 3600,
        });
        expect(push.uid, name).not.toBe('');
        await c.cancelPush({ uid: push.uid });
      }

      // An empty user update detaches the device.
      await c.deviceUpdate({ ids: ids.slice(0, 1), userUpdate: { user: '' } });
      expect((await c.deviceList({ filter: { ids: ids.slice(0, 1) } })).items.map((d) => d.user)).toEqual(['']);
    } finally {
      await c.deviceRemove({ ids });
    }
  });

  it('PRO methods in a batch', async (ctx) => {
    const c = await pro();
    if (!c) return ctx.skip();
    const user = unique();
    const b = c.newBatch();
    b.updateUserStatus({ users: [user], state: 'busy' });
    const status = b.getUserStatus({ users: [user] });
    const reg = b.deviceRegister({ provider: 'webpush', platform: 'web', token: await webpushToken(), user });
    const conns = b.connections({ user });
    await b.send();
    expect(status.result().statuses[0]!.state).toBe('busy');
    expect(reg.result().id).not.toBe('');
    expect(conns.result().connections).toEqual({});
    await c.deviceRemove({ ids: [reg.result().id] });
  });

  it('API tokens: accepted, and refused without audience or scope, as connection tokens, from unpublished keys', async (ctx) => {
    if (!(await pro())) return ctx.skip();
    // The same key on every run, from a fixed seed: Centrifugo caches keys by
    // ID, so a new key under a known ID would be refused.
    const key = (await token.Key.ed25519(new Uint8Array(32).fill(1))).withKeyId('gocent-api-test');
    const jwks = new JWKS(key);
    const server = await serve(Number(process.env.JSCENT_TEST_API_JWKS_PORT ?? 3101), (req, res) =>
      req.url === '/api_jwks' ? jwks.node(req, res) : res.writeHead(404).end(),
    );
    try {
      const publish = (getBearerToken: () => string | Promise<string>) =>
        new Client({ apiEndpoint: ADDR, getBearerToken }).publish({ channel: unique(), data: {} });
      const tokens = new token.ApiTokenSource({
        key,
        claims: { audience: 'centrifugo-api', scope: ['centrifugo:api'] },
      });
      await publish(tokens.token);
      const expiresAt = new Date(Date.now() + 60_000);
      const refused = [
        await token.api(key, { audience: 'centrifugo-api', expiresAt }),
        await token.api(key, { scope: ['centrifugo:api'], expiresAt }),
        await token.connection(key, { user: '42', expiresAt }),
        await token.api((await token.Key.ed25519(new Uint8Array(32).fill(2))).withKeyId('gocent-unpublished'), {
          audience: 'centrifugo-api',
          expiresAt,
        }),
      ];
      for (const tok of refused) {
        await expect(publish(() => tok)).rejects.toBeInstanceOf(UnauthorizedError);
      }
    } finally {
      await stop(server);
    }
  });

  it('commands consumed from a Redis stream: apart and whole', async (ctx) => {
    const c = await pro();
    if (!c) return ctx.skip();
    const ch = unique();
    const apart = command.publish({ channel: ch, data: { n: 1 } });
    await xadd('jscent_commands', ['method', apart.method, 'payload', apart.payload]);
    await xadd('jscent_commands', ['payload', command.publish({ channel: ch, data: { n: 2 } }).toString()]);
    const deadline = Date.now() + 15_000;
    for (;;) {
      const pubs = (await c.history({ channel: ch, limit: 10 })).publications;
      if (pubs.length === 2) {
        expect(pubs.map((p) => p.data)).toEqual([{ n: 1 }, { n: 2 }]);
        return;
      }
      expect(Date.now(), `${pubs.length} of 2 commands consumed after 15s`).toBeLessThan(deadline);
      await new Promise((r) => setTimeout(r, 100));
    }
  }, 30_000);
});

function xadd(stream: string, fields: string[]): Promise<void> {
  const [host, port] = (process.env.JSCENT_TEST_REDIS ?? 'localhost:46379').split(':');
  const args = ['XADD', stream, '*', ...fields];
  const cmd = `*${args.length}\r\n${args.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join('')}`;
  return new Promise((resolve, reject) => {
    const s = tcp(Number(port), host!, () => s.write(cmd));
    s.once('data', (d) => {
      s.end();
      String(d).startsWith('$') ? resolve() : reject(new Error(String(d)));
    });
    s.once('error', reject);
  });
}
