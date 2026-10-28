import { describe, expect, it } from 'vitest';
import {
  ApiError,
  BatchFailedCommandsError,
  BroadcastFailedChannelsError,
  type HTTPError,
  NotFoundError,
  rawJSON,
  retryable,
  UnknownChannelError,
} from '../../src/index.ts';
import * as token from '../../src/token.ts';
import { client, Stream, unique } from './setup.ts';

describe('the API client against Centrifugo', () => {
  it('publishes and reads history, payloads exactly', async () => {
    const c = await client();
    const ch = unique();
    const raw = '{"n":1.5,"big":9007199254740993,"empty":{},"keys":{"0":"a"}}';
    const res = await c.publish({ channel: ch, data: rawJSON(raw), tags: { k: 'v' } });
    expect(res.offset).toBe(1);
    expect(res.epoch).not.toBe('');
    const pubs = (await c.history({ channel: ch, limit: 10 })).publications;
    expect(pubs.length).toBe(1);
    expect(pubs[0]!.tags).toEqual({ k: 'v' });
    // Sent back unchanged, the payload is the same JSON value; with
    // bigIntegers, the integer past 2^53 too.
    const exact = new (await import('../../src/index.ts')).Client({
      apiEndpoint: (await import('./setup.ts')).ADDR,
      apiKey: 'api_key',
      bigIntegers: true,
    });
    const data = (await exact.history({ channel: ch, limit: 10 })).publications[0]!.data;
    await exact.publish({ channel: ch, data });
    const again = (await exact.history({ channel: ch, limit: 10, reverse: true })).publications[0]!.data;
    expect(again).toEqual(data);
    expect((again as { big: unknown }).big).toBe(9007199254740993n);
    await c.historyRemove({ channel: ch });
    expect((await c.history({ channel: ch, limit: 10 })).publications).toEqual([]);
  });

  it('publishes once per idempotency key', async () => {
    const c = await client();
    const ch = unique();
    const first = await c.publish({ channel: ch, data: 1, idempotencyKey: 'k1' });
    const second = await c.publish({ channel: ch, data: 2, idempotencyKey: 'k1' });
    expect(second.offset).toBe(first.offset);
    expect((await c.history({ channel: ch, limit: 10 })).publications.length).toBe(1);
  });

  it('broadcasts', async () => {
    const c = await client();
    const [a, b] = [unique('a-'), unique('b-')];
    const res = await c.broadcast({ channels: [a, b], data: { x: 1 } });
    expect(res.channels.map((ch) => ch.result?.offset)).toEqual([1, 1]);
    try {
      await c.broadcast({ channels: [a, 'unknown:x'], data: { x: 2 } });
      expect.unreachable();
    } catch (e) {
      const err = e as BroadcastFailedChannelsError;
      expect(err).toBeInstanceOf(BroadcastFailedChannelsError);
      expect(err.failed.map((f) => f.channel)).toEqual(['unknown:x']);
      expect(err.failed[0]!.error).toBeInstanceOf(UnknownChannelError);
      expect(err.result.channels[0]!.result).toBeDefined();
      expect(retryable(err)).toBe(false);
    }
  });

  it('broadcasts with retry, under one key', async () => {
    const c = await client();
    const a = unique();
    const res = await c.broadcastWithRetry({ channels: [a], data: 1 });
    expect(res.idempotencyKey).toMatch(/^jscent-/);
    // Retried later with the key, nothing is published again.
    await c.broadcast({ channels: [a], data: 1, idempotencyKey: res.idempotencyKey });
    expect((await c.history({ channel: a, limit: 10 })).publications.length).toBe(1);
  });

  it('sends batches', async () => {
    const c = await client();
    const ch = unique();
    const b = c.newBatch();
    const pub = b.publish({ channel: ch, data: 1 });
    const hist = b.history({ channel: ch, limit: 1 });
    const bad = b.publish({ channel: 'unknown:x', data: 1 });
    const e = (await b.send().catch((x) => x)) as BatchFailedCommandsError;
    expect(e).toBeInstanceOf(BatchFailedCommandsError);
    expect(e.failed.map((f) => f.index)).toEqual([2]);
    expect(pub.result().offset).toBe(1);
    expect(hist.result().publications.length).toBe(1);
    expect(() => bad.result()).toThrow(UnknownChannelError);
  });

  it('does not retry a refused request', async () => {
    const e = await (await client()).history({ channel: 'unknown:x' }).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(retryable(e)).toBe(false);
  });

  it('hints at OSS for a PRO method, alone and in a batch', async () => {
    const c = await client();
    const e = await c.connections({ user: 'nobody' }).catch((x) => x);
    if (!(e instanceof Error)) {
      return; // Centrifugo PRO
    }
    expect((e as HTTPError).status).toBe(404);
    expect(e.message).toContain('Centrifugo PRO method');
    const b = c.newBatch();
    const conns = b.connections({ user: 'nobody' });
    await b.send().catch(() => {});
    expect(() => conns.result()).toThrow(NotFoundError);
    expect(() => conns.result()).toThrow('Centrifugo PRO method');
  });

  it('reads info', async () => {
    const info = await (await client()).info();
    expect(info.nodes.length).toBeGreaterThan(0);
    expect(info.nodes[0]!.version).not.toBe('');
  });

  it('uses maps', async () => {
    const c = await client();
    const ch = `map:${unique()}`;
    await c.mapPublish({ channel: ch, key: 'k1', data: { v: 1 } });
    await c.mapPublish({ channel: ch, key: 'k2', data: { v: 2 } });
    const state = await c.mapReadState({ channel: ch, limit: 10 });
    expect(state.entries.map((e) => e.key).sort()).toEqual(['k1', 'k2']);
    await c.mapRemove({ channel: ch, key: 'k1' });
    expect((await c.mapStats({ channel: ch })).numKeys).toBe(1);
    await c.mapClear({ channel: ch });
  });

  it('publishes into a shared poll', async () => {
    await (await client()).sharedPollPublish({ channel: `poll:${unique()}`, key: 'k', version: 1, data: { v: 1 } });
  });

  it('batches concurrent calls automatically, in order per caller', async () => {
    const { Client } = await import('../../src/index.ts');
    const { ADDR, API_KEY } = await import('./setup.ts');
    let batched = 0;
    const c = new Client({
      apiEndpoint: ADDR,
      apiKey: API_KEY,
      autoBatch: { maxInFlight: 2 },
      onRequest: (i) => {
        if (i.autoBatch) batched++;
      },
    });
    const ch = unique();
    await Promise.all(
      Array.from({ length: 16 }, async (_, w) => {
        for (let n = 0; n < 20; n++) {
          await c.publish({ channel: `${ch}-${w}`, data: { n } });
        }
      }),
    );
    await c.close();
    expect(batched).toBeGreaterThan(0);
    const plain = await client();
    for (let w = 0; w < 16; w++) {
      const pubs = (await plain.history({ channel: `${ch}-${w}`, limit: 100 })).publications;
      // One after another: in order.
      expect(pubs.map((p) => (p.data as { n: number }).n)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    }
  });

  it('connects a real client with HMAC and Ed25519 tokens', async () => {
    const c = await client();
    const exp = new Date(Date.now() + 3_600_000);
    const keys = {
      hmac: token.Key.hmac('client_secret'),
      ed25519: await token.Key.ed25519(new Uint8Array(32).fill(2)),
    };
    for (const [name, key] of Object.entries(keys)) {
      const user = unique(`${name}-`);
      const ch = `${user}-news`;
      const tok = await token.connection(key, { user, expiresAt: exp, info: { name: 'Alice' }, channels: [ch] });
      const s = new Stream({ token: tok });
      try {
        const msg = await s.next();
        expect(msg?.connect, JSON.stringify(msg)).toBeDefined();
        expect(JSON.stringify(msg)).toContain(ch);
        const pres = Object.values((await c.presence({ channel: ch })).presence);
        expect(pres.map((i) => [i.user, i.connInfo])).toEqual([[user, { name: 'Alice' }]]);
        expect((await c.presenceStats({ channel: ch })).numUsers).toBe(1);
        await c.publish({ channel: ch, data: { text: 'hello' } });
        expect(JSON.stringify(await s.next())).toContain('hello');
        const other = `${ch}-2`;
        await c.subscribe({ user, channel: other });
        expect(JSON.stringify(await s.next())).toContain(other);
        await c.unsubscribe({ user, channel: other });
        await c.refresh({ user, expireAt: Math.floor(exp.getTime() / 1000) });
        await c.disconnect({ user });
        while ((await s.next()) !== undefined) {}
      } finally {
        s.close();
      }
    }
    // A token signed with another key is refused.
    const bad = await token.connection(await token.Key.ed25519(crypto.getRandomValues(new Uint8Array(32))), {
      user: 'u',
      expiresAt: exp,
    });
    const s = new Stream({ token: bad });
    const msg = await s.next();
    s.close();
    expect(msg === undefined || msg.disconnect !== undefined).toBe(true);
  });
});
