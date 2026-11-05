import { describe, expect, it } from 'vitest';
import { InvalidConfigError, InvalidRequestError, RawJSON, rawJSON } from '../../src/index.ts';
import { FakeCentrifugo, json, rejection } from './fake.ts';

async function sent(data: unknown): Promise<string> {
  const fake = new FakeCentrifugo();
  await fake.client().publish({ channel: 'c', data });
  const body = fake.last.body;
  expect(body.startsWith('{"channel":"c","data":')).toBe(true);
  return body.slice('{"channel":"c","data":'.length, -1);
}

describe('payloads, spec section 3.4', () => {
  it.each([
    ['object', { text: 'hi', n: 1 }, '{"text":"hi","n":1}'],
    ['array', [1, 'a', null, true], '[1,"a",null,true]'],
    ['empty object', {}, '{}'],
    ['empty array', [], '[]'],
    ['a string is a JSON string', '{"text":"hi"}', '"{\\"text\\":\\"hi\\"}"'],
    ['null', null, 'null'],
    ['false', false, 'false'],
    ['integer past 2^53 as bigint', 9007199254740993n, '9007199254740993'],
    ['bigint past 2^64', { id: 18446744073709551617n }, '{"id":18446744073709551617}'],
    ['a Date as toJSON writes it', new Date(0), '"1970-01-01T00:00:00.000Z"'],
    ['undefined properties dropped, as JSON.stringify does', { a: 1, b: undefined }, '{"a":1}'],
  ])('%s', async (_, value, expected) => {
    expect(await sent(value)).toBe(expected);
  });

  it('sends raw JSON as it is, number text kept', async () => {
    const text = '{"n": 1.50, "big": 18446744073709551617, "e": 1e400}';
    expect(await sent(rawJSON(text))).toBe(text);
    expect(await sent({ a: [1, 2] })).toBe(await sent(rawJSON('{"a":[1,2]}')));
  });

  it('sends raw JSON inside a value', async () => {
    expect(await sent({ doc: rawJSON('{"n": 1.50}'), list: [1, rawJSON('{"big":18446744073709551617}')] })).toBe(
      '{"doc":{"n": 1.50},"list":[1,{"big":18446744073709551617}]}',
    );
    // Outside jscent's encoding, it is its value.
    expect(JSON.stringify({ a: rawJSON('{"n":1}') })).toBe('{"a":{"n":1}}');
  });

  it.each([
    ['NaN', Number.NaN],
    ['infinity', { x: Number.NEGATIVE_INFINITY }],
    ['bytes', { bin: new Uint8Array([1]) }],
    ['an ArrayBuffer', new ArrayBuffer(1)],
    ['a Map', new Map()],
    ['a Set', { s: new Set() }],
    ['a function', { f: () => 1 }],
    ['a symbol', { s: Symbol('x') }],
    [
      'a cycle',
      (() => {
        const o: Record<string, unknown> = {};
        o.self = o;
        return o;
      })(),
    ],
  ])('refuses %s before sending', async (_, value) => {
    const fake = new FakeCentrifugo();
    const err = await rejection(fake.client().publish({ channel: 'c', data: value }));
    expect(err).toBeInstanceOf(InvalidRequestError);
    expect(err.message).toMatch(/^invalid publish request: data/);
    expect(fake.sent).toEqual([]);
  });

  it('hints at b64data for bytes', async () => {
    expect((await rejection(sent(new Uint8Array(1)))).message).toContain('b64data');
  });

  it('refuses invalid raw JSON', () => {
    for (const bad of ['', '{', 'NaN', '{"a":1}x']) {
      expect(() => rawJSON(bad)).toThrow(InvalidRequestError);
    }
    expect(() => new RawJSON(1 as never)).toThrow(InvalidRequestError);
  });

  it.each([
    ['empty object', '{}'],
    ['numeric keys', '{"0":"a","1":"b"}'],
    ['zero fraction, as JavaScript numbers write it', '1'],
    ['nested', '{"a":[{},[],{"0":1}],"b":null,"c":"x"}'],
    ['__proto__ key', '{"__proto__":{"x":1}}'],
  ])('a payload from a reply goes back as the same JSON value: %s', async (_, text) => {
    const fake = new FakeCentrifugo((method) =>
      json(200, method === 'history' ? `{"result":{"publications":[{"data":${text},"offset":1}]}}` : '{"result":{}}'),
    );
    const c = fake.client();
    const pub = (await c.history({ channel: 'c' })).publications[0]!;
    await c.publish({ channel: 'c', data: pub.data });
    expect(fake.last.body).toBe(`{"channel":"c","data":${text}}`);
  });

  it('keeps integers past 2^53 with bigIntegers, and only then', async () => {
    // 1e+300: how JavaScript writes the number, the same JSON value as 1e300.
    const text = '{"id":9007199254740993,"small":1,"f":1.5,"e":1e+300}';
    const fake = new FakeCentrifugo((method) =>
      json(200, method === 'history' ? `{"result":{"publications":[{"data":${text},"offset":1}]}}` : '{"result":{}}'),
    );
    const exact = fake.client({ bigIntegers: true });
    const data = (await exact.history({ channel: 'c' })).publications[0]!.data as Record<string, unknown>;
    expect(data.id).toBe(9007199254740993n);
    expect(data.small).toBe(1);
    expect(data.e).toBe(1e300);
    await exact.publish({ channel: 'c', data });
    expect(fake.last.body).toBe(`{"channel":"c","data":${text}}`);
    // Off by default: rounded, as JSON.parse does.
    const plain = (await fake.client().history({ channel: 'c' })).publications[0]!.data as Record<string, unknown>;
    expect(plain.id).toBe(9007199254740992);
  });

  it('refuses bigIntegers where JSON.parse has no source text', async () => {
    const original = JSON.parse;
    JSON.parse = ((text: string, reviver?: (k: string, v: unknown) => unknown) =>
      original(text, reviver ? (k, v) => reviver(k, v) : undefined)) as typeof JSON.parse;
    try {
      expect(() => new FakeCentrifugo().client({ bigIntegers: true })).toThrow(InvalidConfigError);
    } finally {
      JSON.parse = original;
    }
  });

  it('keeps numeric map keys as object keys', async () => {
    const fake = new FakeCentrifugo();
    await fake.client().publish({ channel: 'c', data: 1, tags: { 0: 'a', 1: 'b' } });
    expect(fake.last.body).toContain('"tags":{"0":"a","1":"b"}');
  });
});
