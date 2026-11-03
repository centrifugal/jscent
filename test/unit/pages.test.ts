import { describe, expect, it } from 'vitest';
import { ApiError, InternalError, InvalidRequestError } from '../../src/index.ts';
import { FakeCentrifugo, json } from './fake.ts';

/**
 * A fake Centrifugo answering the paged methods over a stream of n items,
 * failing the request numbered failAt (from 1).
 */
function paged(n: number, failAt = 0): FakeCentrifugo {
  const fake: FakeCentrifugo = new FakeCentrifugo((method, req) => {
    if (fake.sent.length === failAt) {
      return json(200, { error: { code: 100, message: 'internal server error' } });
    }
    const limit = req.limit as number;
    if (method === 'history') {
      const from = (req.since?.offset as number | undefined) ?? 0;
      const publications = [];
      for (let i = from + 1; i <= n && publications.length < limit; i++) {
        publications.push({ offset: i, data: i });
      }
      return { publications, epoch: 'e', offset: n };
    }
    const from = Number(req.cursor ?? '0');
    const items = [];
    for (let i = from; i < n && items.length < limit; i++) {
      items.push(method === 'map_read_state' ? { key: `k${i}` } : { id: `d${i}`, topic: `t${i}` });
    }
    const next = from + limit < n ? String(from + limit) : '';
    if (method === 'map_read_state') {
      return { entries: items, offset: 9, epoch: 'e', cursor: next };
    }
    return { items, next_cursor: next };
  });
  return fake;
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) {
    out.push(x);
  }
  return out;
}

const cursorMethods = [
  ['deviceListAll', 'device_list', (x: any) => x.id, 'd'],
  ['deviceTopicListAll', 'device_topic_list', (x: any) => x.id, 'd'],
  ['userTopicListAll', 'user_topic_list', (x: any) => x.id, 'd'],
  ['mapReadStateAll', 'map_read_state', (x: any) => x.key, 'k'],
] as const;

describe('pages', () => {
  it.each([0, 1, 3, 7])('historyAll reads every publication of %i, once and in order', async (n) => {
    const fake = paged(n);
    const pubs = await collect(fake.client().historyAll({ channel: 'c', limit: 3 }));
    expect(pubs.map((p) => p.offset)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
    // A page shorter than limit ends it: a full last page costs one more request.
    expect(fake.sent.length).toBe(Math.floor(n / 3) + 1);
    for (const [i, s] of fake.sent.entries()) {
      expect(s.path).toBe('/api/history');
      expect((s.json as any).since).toEqual(i === 0 ? undefined : { offset: i * 3, epoch: 'e' });
    }
  });

  it.each(cursorMethods)('%s reads every item, once and in order', async (name, method, key, prefix) => {
    for (const n of [0, 1, 3, 7]) {
      const fake = paged(n);
      const c = fake.client() as any;
      const req = name === 'mapReadStateAll' ? { channel: 'c', limit: 3 } : { limit: 3 };
      const items = await collect(c[name](req) as AsyncIterable<unknown>);
      expect(items.map(key)).toEqual(Array.from({ length: n }, (_, i) => `${prefix}${i}`));
      expect(fake.sent.length).toBe(Math.max(1, Math.ceil(n / 3)));
      for (const [i, s] of fake.sent.entries()) {
        expect(s.path).toBe(`/api/${method}`);
        expect((s.json as any).cursor).toBe(i === 0 ? undefined : String(i * 3));
      }
    }
  });

  it('reads no further page when the loop leaves early', async () => {
    const fake = paged(7);
    for await (const pub of fake.client().historyAll({ channel: 'c', limit: 3 })) {
      if (pub.offset === 3) {
        break;
      }
    }
    expect(fake.sent.length).toBe(1);
    const devices = paged(7);
    for await (const _ of devices.client().deviceListAll({ limit: 3 })) {
      break;
    }
    expect(devices.sent.length).toBe(1);
  });

  it('ends with the error of a page, after the items before it', async () => {
    const fake = paged(7, 2);
    const seen: number[] = [];
    let err: unknown;
    try {
      for await (const pub of fake.client().historyAll({ channel: 'c', limit: 3 })) {
        seen.push(pub.offset);
      }
    } catch (e) {
      err = e;
    }
    expect(seen).toEqual([1, 2, 3]);
    expect(err).toBeInstanceOf(InternalError);
    const devices = paged(7, 2);
    const ids: string[] = [];
    await expect(
      (async () => {
        for await (const d of devices.client().deviceListAll({ limit: 3 })) {
          ids.push(d.id);
        }
      })(),
    ).rejects.toBeInstanceOf(ApiError);
    expect(ids).toEqual(['d0', 'd1', 'd2']);
  });

  it('historyAll refuses a limit below 1 and reverse, sending nothing', async () => {
    const fake = paged(7);
    const c = fake.client();
    for (const req of [{ channel: 'c' }, { channel: 'c', limit: 0 }, { channel: 'c', limit: -1 }]) {
      await expect(collect(c.historyAll(req))).rejects.toThrow('historyAll needs a limit of 1 or more');
    }
    await expect(collect(c.historyAll({ channel: 'c', limit: 3, reverse: true }))).rejects.toBeInstanceOf(
      InvalidRequestError,
    );
    expect(fake.sent).toEqual([]);
  });

  it("mapReadStateAll reads later pages at the first one's revision, or the caller's", async () => {
    const fake = paged(7);
    await collect(fake.client().mapReadStateAll({ channel: 'c', limit: 3 }));
    expect(fake.sent.map((s) => [(s.json as any).revision_offset, (s.json as any).revision_epoch])).toEqual([
      [undefined, undefined],
      [9, 'e'],
      [9, 'e'],
    ]);
    const own = paged(7);
    await collect(own.client().mapReadStateAll({ channel: 'c', limit: 3, revisionOffset: 5, revisionEpoch: 'x' }));
    expect(own.sent.map((s) => [(s.json as any).revision_offset, (s.json as any).revision_epoch])).toEqual([
      [5, 'x'],
      [5, 'x'],
      [5, 'x'],
    ]);
  });

  it("gives each page the call's options: its timeout per page, its signal", async () => {
    const fake = paged(7);
    const c = fake.client();
    const ctl = new AbortController();
    const reason = new Error('stop');
    const seen: number[] = [];
    await expect(
      (async () => {
        for await (const pub of c.historyAll({ channel: 'c', limit: 3 }, { signal: ctl.signal, timeout: 1000 })) {
          seen.push(pub.offset);
          if (pub.offset === 3) {
            ctl.abort(reason);
          }
        }
      })(),
    ).rejects.toBe(reason);
    expect(seen).toEqual([1, 2, 3]);
    expect(fake.sent.length).toBe(1);
  });
});

describe('positions', () => {
  it('are the offset and epoch of publish, history, map_read_state and map_read_stream', async () => {
    const fake = new FakeCentrifugo((m) =>
      m === 'history' ? { publications: [], offset: 4, epoch: 'h' } : { offset: 4, epoch: 'h', entries: [] },
    );
    const c = fake.client();
    const pub = await c.publish({ channel: 'c', data: 1 });
    expect(pub.position).toEqual({ offset: 4, epoch: 'h' });
    expect((await c.history({ channel: 'c' })).position).toEqual({ offset: 4, epoch: 'h' });
    expect((await c.mapReadState({ channel: 'c' })).position).toEqual({ offset: 4, epoch: 'h' });
    expect((await c.mapReadStream({ channel: 'c' })).position).toEqual({ offset: 4, epoch: 'h' });
    // What a publish returned is what the next history call asks from.
    await c.history({ channel: 'c', since: pub.position, limit: 10 });
    expect((fake.last.json as any).since).toEqual({ offset: 4, epoch: 'h' });
    // Not a field: JSON has the result's fields only.
    expect(JSON.parse(JSON.stringify(pub))).toEqual({ offset: 4, epoch: 'h' });
  });
});
