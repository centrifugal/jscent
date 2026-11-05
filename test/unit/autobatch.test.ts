import { describe, expect, it } from 'vitest';
import { type RequestInfo, TimeoutError, UnknownChannelError } from '../../src/index.ts';
import { FakeCentrifugo, json, rejection } from './fake.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fake Centrifugo answering after a random delay: each command's reply names its channel and data. */
function slow(maxDelay: number) {
  return new FakeCentrifugo(async (method, body) => {
    await sleep(Math.random() * maxDelay);
    if (method === 'batch') {
      return json(200, {
        replies: (body.commands as Record<string, { channel: string; data: number }>[]).map((cmd) => {
          const pub = cmd.publish!;
          return pub.channel === 'unknown:x'
            ? { error: { code: 102, message: 'unknown channel' } }
            : { publish: { offset: pub.data, epoch: pub.channel } };
        }),
      });
    }
    if (body.channel === 'unknown:x') {
      return json(200, { error: { code: 102, message: 'unknown channel' } });
    }
    return { offset: body.data, epoch: body.channel };
  });
}

describe('automatic batching, spec section 8', () => {
  it('gives every call exactly its own reply under random concurrency', async () => {
    for (let round = 0; round < 5; round++) {
      const fake = slow(5);
      const infos: RequestInfo[] = [];
      const c = fake.client({
        autoBatch: { maxInFlight: 1 + (round % 3), maxBatchSize: 7 },
        onRequest: (i) => infos.push(i),
      });
      const calls = Array.from({ length: 200 }, async (_, i) => {
        await sleep(Math.random() * 10);
        const ch = i % 17 === 0 ? 'unknown:x' : `ch-${i}`;
        try {
          const res = await c.publish({ channel: ch, data: i });
          expect([res.offset, res.epoch]).toEqual([i, ch]);
        } catch (e) {
          expect(ch).toBe('unknown:x');
          expect(e).toBeInstanceOf(UnknownChannelError);
        }
      });
      await Promise.all(calls);
      await c.close();
      const batches = infos.filter((i) => i.autoBatch);
      expect(batches.length).toBeGreaterThan(0);
      expect(Math.max(...batches.map((b) => b.commands))).toBeLessThanOrEqual(7);
      expect(infos.reduce((n, i) => n + i.commands, 0)).toBe(200);
      // An automatic batch goes to /batch, parallel, even with one command.
      for (const s of fake.sent.filter((x) => x.method === 'batch')) {
        expect(s.body.endsWith(',"parallel":true}')).toBe(true);
      }
    }
  });

  it('never has more requests in flight than maxInFlight', async () => {
    let inFlight = 0;
    let max = 0;
    const fake = new FakeCentrifugo(async (method, body) => {
      inFlight++;
      max = Math.max(max, inFlight);
      await sleep(5);
      inFlight--;
      return method === 'batch' ? json(200, { replies: (body.commands as unknown[]).map(() => ({ info: {} })) }) : {};
    });
    const c = fake.client({ autoBatch: { maxInFlight: 3 } });
    await Promise.all(Array.from({ length: 100 }, () => c.info()));
    expect(max).toBeLessThanOrEqual(3);
  });

  it('sends a call alone, at once, below maxInFlight', async () => {
    const fake = new FakeCentrifugo();
    const c = fake.client({ autoBatch: { maxInFlight: 8 } });
    await c.info();
    expect(fake.last.method).toBe('info');
  });

  it('lets a queued call whose deadline ends leave without being sent', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fake = new FakeCentrifugo(async (method, body) => {
      await gate;
      return method === 'batch' ? json(200, { replies: (body.commands as unknown[]).map(() => ({ info: {} })) }) : {};
    });
    const c = fake.client({ autoBatch: { maxInFlight: 1 } });
    const first = c.info();
    // Queued behind a call which stays: not at the head of the queue.
    const waiting = c.info();
    const late = c.info({}, { timeout: 20 });
    const err = await rejection(late);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err.message).toContain('before it was sent');
    release();
    await first;
    await waiting;
    await c.close();
    expect(fake.sent.map((s) => s.method)).toEqual(['info', 'batch']);
    expect((fake.last.json as { commands: unknown[] }).commands.length).toBe(1);
  });

  it('fails every call of a batch failing as a whole', async () => {
    let n = 0;
    const fake = new FakeCentrifugo(async () => {
      n++;
      await sleep(5);
      return n === 1 ? {} : json(500, 'down');
    });
    const c = fake.client({ autoBatch: { maxInFlight: 1 } });
    const results = await Promise.allSettled([c.info(), c.info(), c.info()]);
    expect(results[0]!.status).toBe('fulfilled');
    expect(results.slice(1).map((r) => r.status)).toEqual(['rejected', 'rejected']);
  });
});
