import { describe, expect, it } from 'vitest';
import * as api from '../../src/generated/api.ts';
import {
  ApiError,
  BadRequestError,
  BatchFailedCommandsError,
  BatchNotSentError,
  BatchResult,
  BatchSentError,
  type BroadcastAttempt,
  BroadcastFailedChannelsError,
  BroadcastResult,
  ClosedError,
  command,
  DecodeError,
  exponentialBackoff,
  HTTPError,
  InternalError,
  InvalidConfigError,
  InvalidRequestError,
  NetworkError,
  NotFoundError,
  Pending,
  type RequestInfo,
  rawJSON,
  retryable,
  TimeoutError,
  TooManyRequestsError,
  UnauthorizedError,
  UnknownChannelError,
} from '../../src/index.ts';
import { FakeCentrifugo, json, rejection } from './fake.ts';

describe('configuration', () => {
  const bad: [string, Record<string, unknown>, string][] = [
    ['no endpoint', {}, 'apiEndpoint is required'],
    ['both endpoints', { apiEndpoint: 'http://a/api', getApiEndpoint: () => 'x' }, 'not both'],
    ['relative', { apiEndpoint: 'localhost:8000/api' }, 'absolute'],
    ['ftp', { apiEndpoint: 'ftp://a/api' }, 'absolute'],
    ['query', { apiEndpoint: 'http://a/api?x=1' }, 'query'],
    ['fragment', { apiEndpoint: 'http://a/api#x' }, 'fragment'],
    ['credentials', { apiEndpoint: 'http://u:p@a/api' }, 'credentials'],
    ['method', { apiEndpoint: 'http://a/api/publish' }, 'ends with the method "publish"'],
    ['key and token', { apiEndpoint: 'http://a/api', apiKey: 'k', getBearerToken: () => 't' }, 'not both'],
    ['key with newline', { apiEndpoint: 'http://a/api', apiKey: 'k\n' }, 'printable ASCII'],
    ['X-API-Key header', { apiEndpoint: 'http://a/api', headers: { 'x-api-key': 'k' } }, 'apiKey'],
    ['Authorization header', { apiEndpoint: 'http://a/api', headers: { Authorization: 'x' } }, 'getBearerToken'],
    ['Content-Type header', { apiEndpoint: 'http://a/api', headers: { 'Content-Type': 'x' } }, 'Content-Type'],
    ['bad header name', { apiEndpoint: 'http://a/api', headers: { 'a b': 'x' } }, 'valid HTTP header name'],
    ['bad header value', { apiEndpoint: 'http://a/api', headers: { 'X-A': 'a\r\nb' } }, 'printable ASCII'],
    ['empty host', { apiEndpoint: 'http://a/api', headers: { Host: '' } }, 'Host'],
    ['zero timeout', { apiEndpoint: 'http://a/api', requestTimeout: 0 }, 'requestTimeout'],
    ['NaN timeout', { apiEndpoint: 'http://a/api', requestTimeout: Number.NaN }, 'requestTimeout'],
    ['fetch not a function', { apiEndpoint: 'http://a/api', fetch: 'x' }, 'fetch'],
    ['maxInFlight 0', { apiEndpoint: 'http://a/api', autoBatch: { maxInFlight: 0 } }, 'maxInFlight'],
    ['maxBatchSize 1', { apiEndpoint: 'http://a/api', autoBatch: { maxInFlight: 1, maxBatchSize: 1 } }, 'maxBatchSize'],
  ];
  it.each(bad)('refuses %s', async (_, options, message) => {
    const { Client } = await import('../../src/index.ts');
    expect(() => new Client(options as never)).toThrow(InvalidConfigError);
    expect(() => new Client(options as never)).toThrow(message);
  });

  it('requires the fields the proto marks required', () => {
    // Type-checked, never run: tsc fails when channel is optional.
    const typeCheck = (c: ReturnType<FakeCentrifugo['client']>) => {
      // @ts-expect-error channel is required
      void c.history({});
      void c.history({ channel: 'news' });
      // "Required unless ..." stays optional: data or b64data.
      void c.publish({ channel: 'news', b64data: 'aGk=' });
    };
    expect(typeCheck).toBeTypeOf('function');
  });

  it('refuses unknown options', async () => {
    const fake = new FakeCentrifugo();
    expect(() => fake.client({ timeout: 1000 } as never)).toThrow(
      new InvalidConfigError('unknown client option timeout: did you mean requestTimeout?'),
    );
    expect(() => fake.client({ api_key: 'k' } as never)).toThrow('did you mean apiKey?');
    expect(() => fake.client({ autoBatch: { maxInflight: 2 } } as never)).toThrow('did you mean maxInFlight?');
    const c = fake.client();
    expect(await rejection(c.info({}, { timeOut: 5 } as never))).toEqual(
      new InvalidRequestError('unknown call option timeOut: did you mean timeout?'),
    );
    expect(() => c.newBatch({ paralel: true } as never)).toThrow('unknown batch option paralel');
    expect(
      await rejection(c.broadcastWithRetry({ channels: ['a'], data: 1 }, { maxAttempt: 3 } as never)),
    ).toBeInstanceOf(InvalidRequestError);
    expect(await rejection(c.newBatch().send({ timeout_ms: 5 } as never))).toBeInstanceOf(InvalidRequestError);
    expect(fake.sent).toEqual([]);
  });

  it('round-trips a JSON null payload', async () => {
    const fake = new FakeCentrifugo((method) =>
      method === 'history' ? { publications: [{ data: null, offset: 1 }, { offset: 2 }] } : {},
    );
    const c = fake.client();
    const { publications } = await c.history({ channel: 'news', limit: 2 });
    expect(publications[0]?.data).toBeNull();
    expect(publications[1]?.data).toBeUndefined();
    await c.publish({ channel: 'archive', data: publications[0]?.data });
    expect(fake.last.body).toBe('{"channel":"archive","data":null}');
    expect(await rejection(c.publish({ channel: 'archive', data: publications[1]?.data }))).toBeInstanceOf(
      InvalidRequestError,
    );
  });

  it('normalizes the endpoint', async () => {
    const fake = new FakeCentrifugo();
    await fake.client({ apiEndpoint: 'HTTP://Host:8000/prefix/api/' }).info();
    expect(fake.last.path).toBe('/prefix/api/info');
  });

  it('sends the headers', async () => {
    const fake = new FakeCentrifugo();
    await fake.client({ apiKey: 'secret', headers: { 'X-Tenant': 'a' } }).info();
    const h = fake.last.headers;
    expect(h.get('content-type')).toBe('application/json');
    expect(h.get('user-agent')).toBe('jscent/1');
    expect(h.get('x-api-key')).toBe('secret');
    expect(h.get('x-tenant')).toBe('a');
    await fake.client({ headers: { 'User-Agent': 'mine/1' } }).info();
    expect(fake.last.headers.get('user-agent')).toBe('mine/1');
    await fake.client({ apiKey: '' }).info();
    expect(fake.last.headers.has('x-api-key')).toBe(false);
  });

  it('gets a bearer token per request, refusing an empty one before sending', async () => {
    const fake = new FakeCentrifugo();
    let n = 0;
    const c = fake.client({ apiKey: '', getBearerToken: async () => `t${++n}` });
    await c.info();
    await c.info();
    expect(fake.last.headers.get('authorization')).toBe('Bearer t2');
    const sent = fake.sent.length;
    const err = await rejection(fake.client({ apiKey: '', getBearerToken: () => '' }).info());
    expect(err).toBeInstanceOf(InvalidConfigError);
    expect(fake.sent.length).toBe(sent);
  });

  it('validates the endpoint of getApiEndpoint per request', async () => {
    const fake = new FakeCentrifugo();
    let addr = 'http://a/one/api';
    const c = fake.client({ apiEndpoint: undefined, getApiEndpoint: () => addr });
    await c.info();
    expect(fake.last.path).toBe('/one/api/info');
    addr = 'http://a/api/info';
    expect(await rejection(c.info())).toBeInstanceOf(InvalidConfigError);
  });
});

describe('every method', () => {
  const methods = Object.keys(api.METHODS).filter((m) => m !== 'batch');
  const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  const requestFor = (method: string) => (method === 'publish' ? { channel: 'ch', data: 1 } : {});
  type Methods = Record<string, (r: object) => unknown>;

  it('is a method of the client - but broadcast, written by hand - of a batch and of command', () => {
    const client = Object.getOwnPropertyNames(api.ClientMethods.prototype).filter((n) => n !== 'constructor');
    const batch = Object.getOwnPropertyNames(api.BatchMethods.prototype).filter((n) => n !== 'constructor');
    expect(client.sort()).toEqual(
      methods
        .filter((m) => m !== 'broadcast')
        .map(camel)
        .sort(),
    );
    expect(batch.sort()).toEqual(methods.map(camel).sort());
    expect(Object.keys(command).sort()).toEqual(methods.map(camel).sort());
  });

  it.each(methods.filter((m) => m !== 'broadcast'))(
    '%s reaches its endpoint, alone, in a batch and as a command',
    async (method) => {
      const fake = new FakeCentrifugo((m, body) =>
        m === 'batch' ? json(200, { replies: (body.commands as unknown[]).map(() => ({ [method]: {} })) }) : {},
      );
      const c = fake.client();
      const req = requestFor(method);
      const res = await (c as unknown as Record<string, (r: object) => Promise<unknown>>)[camel(method)]!(req);
      expect(fake.last.path).toBe(`/api/${method}`);
      expect(typeof res).toBe('object');
      const b = c.newBatch();
      const p = (b as unknown as Record<string, (r: object) => { result(): unknown }>)[camel(method)]!(req);
      await b.send();
      expect(fake.last.path).toBe('/api/batch');
      expect(Object.keys((fake.last.json as { commands: object[] }).commands[0]!)).toEqual([method]);
      expect(typeof p.result()).toBe('object');
      expect(((command as unknown as Methods)[camel(method)]!(req) as { method: string }).method).toBe(method);
    },
  );

  it('fills a result with its zero values', async () => {
    const fake = new FakeCentrifugo(() => ({}));
    expect(await fake.client().history({ channel: 'c' })).toEqual({
      publications: [],
      offset: 0,
      epoch: '',
    });
  });

  it('takes a plain object of the fields', async () => {
    const fake = new FakeCentrifugo((m) => (m === 'broadcast' ? { responses: [{ result: { offset: 1 } }] } : {}));
    const c = fake.client();
    await c.publish({ channel: 'a', data: { x: 1 }, skipHistory: true });
    expect(fake.last.body).toBe('{"channel":"a","data":{"x":1},"skip_history":true}');
    await c.broadcast({ channels: ['a'], data: 1 });
    expect(fake.last.path).toBe('/api/broadcast');
    await c.broadcastWithRetry({ channels: ['a'], data: 1 });
    await c.info({}, { timeout: 500 });
    await c.info();
    expect(fake.last.path).toBe('/api/info');
    expect(await rejection(c.publish({ channel: 'a' }))).toBeInstanceOf(InvalidRequestError);
  });

  it('refuses a field it does not know, suggesting the right one', async () => {
    const fake = new FakeCentrifugo();
    const c = fake.client();
    const snake = await rejection(c.publish({ channel: 'a', data: 1, skip_history: true } as never));
    expect(snake).toBeInstanceOf(InvalidRequestError);
    expect(snake.message).toBe('invalid publish request: skip_history is not a field: did you mean skipHistory?');
    const typo = await rejection(c.publish({ channel: 'a', data: 1, chanel: 'b' } as never));
    // A batch and a command check their requests as a call does.
    const b = c.newBatch();
    b.publish({ channel: 'a', data: 1, skip_history: true } as never);
    expect((await rejection(b.send())).message).toContain('skip_history is not a field: did you mean skipHistory?');
    expect(() => command.publish({ channel: 'a', data: 1, skip_history: true } as never)).toThrow(
      'did you mean skipHistory?',
    );
    expect(typo.message).toBe('invalid publish request: chanel is not a field');
    const nested = await rejection(
      c.subscribe({ channel: 'a', user: 'u', recoverSince: { offset: 1, ephoc: 'e' } as never }),
    );
    expect(nested.message).toContain('recoverSince.ephoc is not a field');
    // undefined is no field at all: an optional left out.
    await c.publish({ channel: 'a', data: 1, tags: undefined });
    expect(fake.sent.length).toBe(1);
  });

  it('refuses something which is not an object of fields', async () => {
    const fake = new FakeCentrifugo();
    const err = await rejection(fake.client().publish('news' as never));
    expect(err).toBeInstanceOf(InvalidRequestError);
    expect(err.message).toBe('invalid publish request: it must be an object of its fields');
    expect(fake.sent).toEqual([]);
  });
});

describe('errors', () => {
  it.each([
    [100, InternalError],
    [102, UnknownChannelError],
    [104, NotFoundError],
    [107, BadRequestError],
    [111, TooManyRequestsError],
    [9999, ApiError],
  ] as const)('code %d is a %s', async (code, cls) => {
    const fake = new FakeCentrifugo(() => json(200, { error: { code, message: 'm', temporary: true } }));
    const err = (await rejection(fake.client().info())) as ApiError;
    expect(err.constructor).toBe(cls);
    expect(err.code).toBe(code);
    expect(err.serverMessage).toBe('m');
    expect(err.temporary).toBe(true);
    expect(err.message).toBe(`m (code ${code})`);
  });

  it.each([400, 404, 409, 416, 429, 500])(
    'the transport error mode, status %d, is the same ApiError',
    async (status) => {
      const fake = new FakeCentrifugo(() => json(status, { code: 102, message: 'unknown channel' }));
      expect(await rejection(fake.client().info())).toBeInstanceOf(UnknownChannelError);
    },
  );

  it.each([
    [429, '{"code":429}'],
    [500, '{"code":500,"message":"x"}'],
    [502, '{"code":102}'],
    [400, 'bad'],
  ])("a gateway's %d %s stays an HTTPError", async (status, body) => {
    const fake = new FakeCentrifugo(() => json(status, body));
    const err = await rejection(fake.client().info());
    expect(err).toBeInstanceOf(HTTPError);
    expect(err).not.toBeInstanceOf(ApiError);
  });

  it('gives hints', async () => {
    let status = 401;
    const fake = new FakeCentrifugo(() => new Response('nope', { status, headers: { 'X-Request-Id': 'r1' } }));
    const c = fake.client();
    const unauthorized = (await rejection(c.info())) as HTTPError;
    expect(unauthorized).toBeInstanceOf(UnauthorizedError);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.body).toBe('nope');
    expect(unauthorized.headers.get('x-request-id')).toBe('r1');
    expect(unauthorized.message).toContain('check the credentials');
    expect(retryable(unauthorized)).toBe(false);
    status = 404;
    expect((await rejection(c.info())).message).toContain('is apiEndpoint the API base URL');
    const pro = await rejection(c.connections({}));
    expect(pro.message).toContain('connections is a Centrifugo PRO method');
    expect(pro).not.toBeInstanceOf(NotFoundError);
    status = 302;
    expect((await rejection(c.info())).message).toContain('a redirect, which jscent does not follow');
    status = 503;
    expect(retryable(await rejection(c.info()))).toBe(true);
  });

  it('hints at OSS for a PRO method in a batch', async () => {
    const fake = new FakeCentrifugo(() =>
      json(200, {
        replies: [{ error: { code: 104, message: 'not found' } }, { error: { code: 104, message: 'not found' } }],
      }),
    );
    const b = fake.client().newBatch();
    const conns = b.connections({});
    const hist = b.history({ channel: 'x' });
    await rejection(b.send());
    expect(() => conns.result()).toThrow('connections is a Centrifugo PRO method: is the server Centrifugo OSS?');
    expect(() => conns.result()).toThrow(NotFoundError);
    let histErr: Error | undefined;
    try {
      hist.result();
    } catch (e) {
      histErr = e as Error;
    }
    expect(histErr?.message).not.toContain('PRO');
  });

  it.each([
    ['html', '<html>hi</html>'],
    ['array', '[1]'],
    ['result not object', '{"result":1}'],
    ['field of another type', '{"result":{"nodes":"x"}}'],
    ['error not object', '{"error":1}'],
  ])("a reply which is not Centrifugo's (%s) is a DecodeError", async (_, body) => {
    const fake = new FakeCentrifugo(() => json(200, body));
    expect(await rejection(fake.client().info())).toBeInstanceOf(DecodeError);
  });

  it('wraps network errors', async () => {
    const fake = new FakeCentrifugo(() => new TypeError('fetch failed'));
    const err = await rejection(fake.client().info());
    expect(err).toBeInstanceOf(NetworkError);
    expect(err.cause).toBeInstanceOf(TypeError);
    expect(retryable(err)).toBe(true);
  });

  it('does not retry a refused TLS certificate', async () => {
    const nodeErr = Object.assign(new Error('unable to verify the first certificate'), {
      code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    });
    for (const cause of [nodeErr, new Error('invalid peer certificate: UnknownIssuer')]) {
      const fake = new FakeCentrifugo(() => new TypeError('fetch failed', { cause }));
      const err = await rejection(fake.client().info());
      expect(err).toBeInstanceOf(NetworkError);
      expect((err as NetworkError).certificate).toBe(true);
      expect(retryable(err)).toBe(false);
    }
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const fake = new FakeCentrifugo(() => new TypeError('fetch failed', { cause: refused }));
    expect(retryable(await rejection(fake.client().info()))).toBe(true);
  });

  it('times out, and an aborted call throws the signal reason', async () => {
    const never = (_m: string, _j: unknown, init: RequestInit) =>
      new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
    const fake = new FakeCentrifugo(never);
    const err = await rejection(fake.client().info(undefined, { timeout: 30 }));
    expect(err).toBeInstanceOf(TimeoutError);
    expect(retryable(err)).toBe(true);
    const ac = new AbortController();
    const call = fake.client().info(undefined, { signal: ac.signal });
    ac.abort(new Error('stop'));
    expect((await rejection(call)).message).toBe('stop');
    // No time left: not sent.
    const before = fake.sent.length;
    expect(await rejection(fake.client().info(undefined, { timeout: 0 }))).toBeInstanceOf(TimeoutError);
    expect(fake.sent.length).toBe(before);
    expect(await rejection(fake.client().info(undefined, { timeout: -1 }))).toBeInstanceOf(InvalidRequestError);
  });

  it('refuses invalid requests before sending', async () => {
    const fake = new FakeCentrifugo();
    const c = fake.client();
    const cases: [Promise<unknown>, string][] = [
      // Plain JS callers, without the types' required properties.
      [c.publish({ data: 1 } as never), 'invalid publish request: channel is required'],
      [c.publish({ channel: 'a' }), 'invalid publish request: data or b64data is required'],
      [c.broadcast({ data: 1 } as never), 'invalid broadcast request: channels is required'],
      [c.broadcast({ channels: ['a'] }), 'data or b64data is required'],
      [c.broadcast({ channels: ['a', ''], data: 1 }), 'channels[1] is empty'],
      [c.publish({ channel: 'a', data: Number.POSITIVE_INFINITY }), 'invalid publish request: data is Infinity'],
      [c.publish({ channel: '\ud800', data: 1 }), 'channel is not a well-formed string'],
      [c.publish({ channel: 1 as never, data: 1 }), 'channel must be a string'],
      [c.publish({ channel: 'a', data: 1, tags: { k: 1 as never } }), 'tags["k"] must be a string'],
    ];
    for (const [call, message] of cases) {
      const err = await rejection(call);
      expect(err).toBeInstanceOf(InvalidRequestError);
      expect(err.message).toContain(message);
      expect(retryable(err)).toBe(false);
    }
    expect(fake.sent).toEqual([]);
    // Only those rules: a publication with b64data alone is Centrifugo's to judge.
    await c.publish({ channel: 'a', b64data: 'AA==' });
    expect(fake.sent.length).toBe(1);
  });
});

describe('broadcast', () => {
  const reply = (responses: unknown[]) => new FakeCentrifugo(() => ({ responses }));

  it('succeeds in every channel', async () => {
    const fake = reply([{ result: { offset: 1 } }, { result: { offset: 2 } }]);
    const res = await fake.client().broadcast({ channels: ['a', 'b'], data: 1, idempotencyKey: 'k' });
    expect(res.replied).toBe(true);
    expect(res.failed).toEqual([]);
    expect(res.channels.map((c) => c.channel)).toEqual(['a', 'b']);
    expect(res.channels[1]!.result?.offset).toBe(2);
    expect(res.idempotencyKey).toBe('k');
    expect(res.attempts).toBe(1);
  });

  it('throws on a partial failure, with every channel', async () => {
    const fake = reply([
      { result: { offset: 1 } },
      { error: { code: 102, message: 'unknown channel' } },
      { error: { code: 100, message: 'internal' } },
    ]);
    const e = (await rejection(
      fake.client().broadcast({ channels: ['a', 'b', 'c'], data: 1 }),
    )) as BroadcastFailedChannelsError;
    expect(e).toBeInstanceOf(BroadcastFailedChannelsError);
    expect(e).not.toBeInstanceOf(ApiError);
    expect(e.result.replied).toBe(true);
    expect(e.failed.map((c) => c.channel)).toEqual(['b', 'c']);
    expect(e.total).toBe(3);
    expect(e.failed[0]!.error).toBeInstanceOf(UnknownChannelError);
    expect(e.retryableChannels()).toEqual(['c']);
    expect(retryable(e)).toBe(true);
    expect(e.message).toBe(
      'broadcast: 2 of 3 channels failed, 1 got the publication: b: unknown channel (code 102); c: internal (code 100) (retry only retryableChannels(), with the same idempotencyKey)',
    );
  });

  it('into one unknown channel is not an UnknownChannelError', async () => {
    const fake = reply([{ error: { code: 102, message: 'unknown channel' } }]);
    const e = await rejection(fake.client().broadcast({ channels: ['a'], data: 1 }));
    expect(e).toBeInstanceOf(BroadcastFailedChannelsError);
    expect(e).not.toBeInstanceOf(UnknownChannelError);
    expect(e.message).toBe('broadcast: 1 of 1 channels failed: a: unknown channel (code 102)');
  });

  it('refuses a reply with another count of channels', async () => {
    const fake = reply([{ result: { offset: 1 } }]);
    expect(await rejection(fake.client().broadcast({ channels: ['a', 'b'], data: 1 }))).toBeInstanceOf(DecodeError);
  });
});

describe('broadcastWithRetry', () => {
  it('retries only the channels which may still succeed, under one key', async () => {
    let calls = 0;
    const fake = new FakeCentrifugo((_, body) => {
      calls++;
      return {
        responses: (body.channels as string[]).map((ch) =>
          ch === 'a'
            ? { result: { offset: 1 } }
            : ch === 'b'
              ? { error: { code: 102, message: 'unknown channel' } }
              : calls === 1
                ? { error: { code: 111, message: 'limit', temporary: true } }
                : { result: { offset: 5 } },
        ),
      };
    });
    const attempts: BroadcastAttempt[] = [];
    const e = (await rejection(
      fake.client().broadcastWithRetry(
        { channels: ['a', 'b', 'c'], data: 1 },
        {
          onAttemptError: (a) => {
            attempts.push(a);
            return 0;
          },
        },
      ),
    )) as BroadcastFailedChannelsError;
    expect(e.failed.map((c) => c.channel)).toEqual(['b']);
    expect(e.result.channels[2]!.result?.offset).toBe(5);
    expect(e.result.channels.map((c) => c.attempts)).toEqual([1, 1, 2]);
    expect(e.result.attempts).toBe(2);
    expect(e.result.idempotencyKey).toMatch(/^jscent-/);
    expect(attempts.map((a) => a.retry.map((c) => c.channel))).toEqual([['c']]);
    const keys = fake.sent.map((s) => (s.json as { idempotency_key: string }).idempotency_key);
    expect(keys[0]).toBe(keys[1]);
    expect((fake.sent[1]!.json as { channels: string[] }).channels).toEqual(['c']);
  });

  it('stops when the callback throws, on a failure no retry fixes, and after maxAttempts', async () => {
    const down = new FakeCentrifugo(() => json(503, 'down'));
    const stop = await rejection(
      down.client().broadcastWithRetry(
        { channels: ['a'], data: 1 },
        {
          maxAttempts: 5,
          onAttemptError: () => {
            throw new RangeError('stop');
          },
        },
      ),
    );
    expect(stop).toBeInstanceOf(RangeError);
    expect(down.sent.length).toBe(1);
    const denied = new FakeCentrifugo(() => json(401, ''));
    expect(
      await rejection(denied.client().broadcastWithRetry({ channels: ['a'], data: 1 }, { maxAttempts: 5 })),
    ).toBeInstanceOf(UnauthorizedError);
    expect(denied.sent.length).toBe(1);
    const flaky = new FakeCentrifugo(() => json(503, ''));
    const failed = await rejection(
      flaky.client().broadcastWithRetry(
        { channels: ['a'], data: 1 },
        {
          maxAttempts: 3,
          onAttemptError: () => 0,
        },
      ),
    );
    expect(failed).toBeInstanceOf(HTTPError);
    // The key the attempts carried, for a retry which does not publish twice.
    const keys = new Set(flaky.sent.map((r) => (r.json as { idempotency_key: string }).idempotency_key));
    expect([...keys]).toEqual([(failed as HTTPError).idempotencyKey]);
    expect(flaky.sent.length).toBe(3);
  });

  it('refuses bad options before any attempt', async () => {
    const fake = new FakeCentrifugo();
    for (const opts of [{ maxAttempts: 0 }, { maxAttempts: -1 }, { attemptTimeout: -1 }, { attemptTimeout: 0 }]) {
      expect(await rejection(fake.client().broadcastWithRetry({ channels: ['a'], data: 1 }, opts))).toBeInstanceOf(
        InvalidRequestError,
      );
    }
    expect(fake.sent).toEqual([]);
  });

  it('bounds the waits by its timeout', async () => {
    const fake = new FakeCentrifugo(() => json(503, ''));
    const start = performance.now();
    await rejection(
      fake.client().broadcastWithRetry(
        { channels: ['a'], data: 1 },
        {
          maxAttempts: 10,
          onAttemptError: () => 60_000,
          timeout: 200,
        },
      ),
    );
    expect(performance.now() - start).toBeLessThan(2_000);
  });
});

describe('batch', () => {
  it('holds every command outcome', async () => {
    const fake = new FakeCentrifugo(() =>
      json(200, {
        replies: [
          { publish: { offset: 3 } },
          { error: { code: 102, message: 'unknown channel' } },
          { broadcast: { responses: [{ result: { offset: 1 } }, { error: { code: 102, message: 'u' } }] } },
        ],
      }),
    );
    const b = fake.client().newBatch({ parallel: true });
    const pub = b.publish({ channel: 'a', data: 1 });
    const hist = b.history({ channel: 'x' });
    const bc = b.broadcast({ channels: ['a', 'b'], data: 1 });
    expect(b.size).toBe(3);
    expect(() => pub.result()).toThrow(BatchNotSentError);
    const e = (await rejection(b.send())) as BatchFailedCommandsError;
    expect(e).toBeInstanceOf(BatchFailedCommandsError);
    expect(e.result.replied).toBe(true);
    expect(e.failed.map((f) => f.index)).toEqual([1, 2]);
    expect(e.failed.map((f) => f.method)).toEqual(['history', 'broadcast']);
    expect(e.message).toMatch(
      /^batch: 2 of 3 commands failed, 1 succeeded: #1 history: unknown channel \(code 102\); #2 broadcast: broadcast: 1 of 2/,
    );
    let bcErr: unknown;
    try {
      bc.result();
    } catch (err) {
      bcErr = err;
    }
    // The very error the pending throws.
    expect(bcErr).toBe(e.failed[1]!.error);
    expect(fake.last.body.endsWith('],"parallel":true}')).toBe(true);
    expect(pub.result().offset).toBe(3);
    expect(() => hist.result()).toThrow(UnknownChannelError);
  });

  it('is sent once', async () => {
    const fake = new FakeCentrifugo(() => json(200, { replies: [{ info: {} }] }));
    const b = fake.client().newBatch();
    b.info({});
    await b.send();
    expect(await rejection(b.send())).toBeInstanceOf(BatchSentError);
    expect(() => b.info({})).toThrow('already sent');
  });

  it('fails every pending when it fails as a whole', async () => {
    const fake = new FakeCentrifugo(() => json(500, 'down'));
    const b = fake.client().newBatch();
    const p = b.info({});
    const e = await rejection(b.send());
    expect(e).toBeInstanceOf(HTTPError);
    expect(() => p.result()).toThrow(e);
  });

  it('refuses a reply with another count of commands', async () => {
    const fake = new FakeCentrifugo(() => json(200, { replies: [] }));
    const b = fake.client().newBatch();
    b.info({});
    expect(await rejection(b.send())).toBeInstanceOf(DecodeError);
  });

  it('fails as a whole before sending for an invalid command, naming it', async () => {
    const fake = new FakeCentrifugo();
    const b = fake.client().newBatch();
    b.info({});
    b.publish({ channel: 'a' });
    const e = await rejection(b.send());
    expect(e).toBeInstanceOf(InvalidRequestError);
    expect(e.message).toMatch(/^batch command #1: invalid publish request/);
    expect(fake.sent).toEqual([]);
  });

  it('sends nothing when empty, but refuses a closed client', async () => {
    const fake = new FakeCentrifugo();
    const c = fake.client();
    expect((await c.newBatch().send()).replied).toBe(true);
    expect(fake.sent).toEqual([]);
    await c.close();
    expect(await rejection(c.newBatch().send())).toBeInstanceOf(ClosedError);
  });
});

describe('the rest', () => {
  it('closes', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fake = new FakeCentrifugo(async () => {
      await gate;
      return {};
    });
    const c = fake.client();
    const inFlight = c.info();
    let closed = false;
    const closing = c.close().then(() => {
      closed = true;
    });
    expect(await rejection(c.info())).toBeInstanceOf(ClosedError);
    expect(closed).toBe(false);
    expect(await rejection(c.close({ timeout: 10 }))).toBeInstanceOf(TimeoutError);
    release();
    await inFlight;
    await closing;
    expect(closed).toBe(true);
    expect(retryable(new ClosedError('x'))).toBe(false);
  });

  it('reports every request', async () => {
    const infos: RequestInfo[] = [];
    let reply: Response = json(200, { result: {} });
    const fake = new FakeCentrifugo(() => reply);
    const c = fake.client({ onRequest: (i) => infos.push(i) });
    await c.info();
    reply = json(200, { replies: [{ error: { code: 102 } }, { info: {} }] });
    const b = c.newBatch();
    b.info({});
    b.info({});
    await rejection(b.send());
    reply = json(400, '{"code":102,"message":"unknown channel"}');
    await rejection(c.info());
    await rejection(c.publish({ channel: 'a', data: Number.NaN }));
    expect(infos.map((i) => i.method)).toEqual(['info', 'batch', 'info']);
    expect(infos.map((i) => i.commands)).toEqual([1, 2, 1]);
    expect(infos.map((i) => i.failed)).toEqual([0, 1, 0]);
    expect(infos.map((i) => i.status)).toEqual([200, 200, 400]);
    expect(infos[1]!.error).toBeUndefined();
    expect(infos[2]!.error).toBeInstanceOf(UnknownChannelError);
    expect(infos[0]!.duration).toBeGreaterThanOrEqual(0);
  });

  it('judges retryable errors', () => {
    expect(retryable(undefined)).toBe(false);
    expect(retryable(ApiError.fromCode(100))).toBe(true);
    expect(retryable(ApiError.fromCode(108, '', true))).toBe(true);
    expect(retryable(ApiError.fromCode(102))).toBe(false);
    expect(retryable(new HTTPError(429))).toBe(true);
    expect(retryable(new HTTPError(500))).toBe(true);
    expect(retryable(new HTTPError(404))).toBe(false);
    expect(retryable(new DecodeError('x'))).toBe(false);
    expect(retryable(new Error('x'))).toBe(false);
    expect(retryable(new DOMException('t', 'TimeoutError'))).toBe(true);
    expect(retryable(new DOMException('a', 'AbortError'))).toBe(false);
  });

  it('backs off exponentially, clamped', () => {
    const d = exponentialBackoff(100, 1000);
    for (const [attempt, max] of [
      [1, 100],
      [2, 200],
      [3, 400],
      [4, 800],
      [5, 1000],
      [100, 1000],
      [0, 100],
      [-5, 100],
      [Number.MAX_SAFE_INTEGER, 1000],
    ] as const) {
      for (let i = 0; i < 20; i++) {
        const v = d(attempt);
        expect(v).toBeGreaterThanOrEqual(max / 2);
        expect(v).toBeLessThanOrEqual(max);
      }
    }
    expect(exponentialBackoff(-1, -5)(3)).toBe(0);
    const start = performance.now();
    expect(exponentialBackoff(0, 1000)(Number.MAX_SAFE_INTEGER)).toBe(0);
    expect(performance.now() - start).toBeLessThan(100);
  });

  it('makes commands', () => {
    const cmd = command.publish({ channel: 'news', data: { text: 'hi' } });
    expect(cmd.method).toBe('publish');
    expect(cmd.payload).toBe('{"channel":"news","data":{"text":"hi"}}');
    expect(cmd.toString()).toBe('{"method":"publish","payload":{"channel":"news","data":{"text":"hi"}}}');
    // JSON.stringify gives the payload as an object, also of a nested command.
    expect(JSON.stringify(cmd)).toBe('{"method":"publish","payload":{"channel":"news","data":{"text":"hi"}}}');
    expect(JSON.stringify({ id: 1, cmd })).toBe(
      '{"id":1,"cmd":{"method":"publish","payload":{"channel":"news","data":{"text":"hi"}}}}',
    );
    // Inside a payload jscent encodes, exactly as its text.
    const big = command.publish({ channel: 'news', data: rawJSON('{"n":12345678901234567890}') });
    expect(command.publish({ channel: 'outbox', data: { cmd: big } }).payload).toBe(
      '{"channel":"outbox","data":{"cmd":{"method":"publish","payload":{"channel":"news","data":{"n":12345678901234567890}}}}}',
    );
    expect(() => command.publish({ channel: 'news' })).toThrow(InvalidRequestError);
  });
});

describe('results as JSON', () => {
  it('render with wire names', async () => {
    const fake = new FakeCentrifugo((method) =>
      method === 'presence_stats'
        ? { num_clients: 2, num_users: 1 }
        : method === 'history'
          ? { publications: [{ data: { a: 1 }, offset: 3, tags: { t: 'x' } }], epoch: 'e', offset: 3 }
          : {},
    );
    const c = fake.client();
    expect(JSON.stringify(await c.presenceStats({ channel: 'news' }))).toBe('{"num_clients":2,"num_users":1}');
    expect(JSON.stringify(await c.history({ channel: 'news' }))).toBe(
      '{"publications":[{"data":{"a":1},"offset":3,"tags":{"t":"x"}}],"epoch":"e","offset":3}',
    );
  });

  it('render broadcast and batch results, and doubles of them', () => {
    const ok = { channel: 'news', result: { offset: 1, epoch: 'e' }, error: undefined, attempts: 1 };
    const bad = {
      channel: 'unknown:x',
      result: undefined,
      error: ApiError.fromCode(102, 'unknown channel'),
      attempts: 1,
    };
    const down = { channel: 'chat', result: undefined, error: new NetworkError('publish: refused'), attempts: 2 };
    const res = new BroadcastResult([ok, bad, down], 'k', 2, true);
    expect(JSON.stringify(res)).toBe(
      '{"channels":[{"channel":"news","result":{"offset":1,"epoch":"e"},"attempts":1},' +
        '{"channel":"unknown:x","error":{"code":102,"message":"unknown channel"},"attempts":1},' +
        '{"channel":"chat","error":{"message":"publish: refused"},"attempts":2}],' +
        '"idempotency_key":"k","attempts":2,"replied":true}',
    );
    expect(res.failed).toEqual([bad, down]);
    const e = new BroadcastFailedChannelsError([bad], 2, new BroadcastResult([ok, bad]));
    expect(e.result.failed).toEqual([bad]);
    const failed = [{ index: 1, method: 'publish', error: ApiError.fromCode(102, 'unknown channel') }];
    expect(JSON.stringify(new BatchResult(true, failed))).toBe(
      '{"replied":true,"failed":[{"index":1,"method":"publish","error":{"code":102,"message":"unknown channel"}}]}',
    );
    expect(new BatchFailedCommandsError(failed, 2, new BatchResult(true, failed)).failed).toEqual(failed);
    expect(Pending.resolved({ offset: 1 }).result()).toEqual({ offset: 1 });
    expect(() => Pending.resolved(undefined, ApiError.fromCode(102, 'unknown channel')).result()).toThrow(
      UnknownChannelError,
    );
  });
});
