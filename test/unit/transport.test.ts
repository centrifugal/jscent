import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, DecodeError, type HTTPError, NetworkError, retryable, TimeoutError } from '../../src/index.ts';
import { rejection } from './fake.ts';

let server: Server;
let base = '';
let connections = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    const kind = (req.url ?? '').split('/')[1];
    switch (kind) {
      case 'ok':
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"result":{"offset":1,"epoch":"e"}}');
        break;
      case 'slowheaders':
        setTimeout(() => res.writeHead(200).end('{"result":{}}'), 2000);
        break;
      case 'trickle': {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"result":{"x":"');
        let i = 0;
        const t = setInterval(() => {
          if (++i > 30 || res.destroyed) {
            clearInterval(t);
            res.end('"}}');
          } else {
            res.write('a');
          }
        }, 100);
        break;
      }
      case 'redirect':
        res.writeHead(302, { Location: 'https://elsewhere.test/api/publish' }).end();
        break;
      case 'bigerror':
        res.writeHead(502, { 'Content-Type': 'text/html' }).end(`<html>${'x'.repeat(200_000)}</html>`);
        break;
      case 'html':
        res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>not centrifugo</html>');
        break;
      default:
        res.writeHead(404).end();
    }
  });
  server.on('connection', () => connections++);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const client = (kind: string, requestTimeout = 10_000) =>
  new Client({ apiEndpoint: `${base}/${kind}/api`, requestTimeout });

describe('the fetch transport, against a real server', () => {
  it('sends and keeps the connection alive', async () => {
    const c = client('ok');
    const before = connections;
    for (let i = 0; i < 20; i++) {
      expect((await c.info()).nodes).toEqual([]);
    }
    // Node's fetch keeps a small pool, alternating between two connections
    // even for calls made one after another: reused, not one per call.
    expect(connections - before).toBeLessThanOrEqual(2);
  });

  it('times out on slow headers', async () => {
    const start = performance.now();
    const err = await rejection(client('slowheaders', 300).info());
    expect(err).toBeInstanceOf(TimeoutError);
    expect(retryable(err)).toBe(true);
    expect(performance.now() - start).toBeLessThan(1500);
  });

  it('times out on a body trickling in: the deadline bounds the whole request', async () => {
    const start = performance.now();
    expect(await rejection(client('trickle').info(undefined, { timeout: 500 }))).toBeInstanceOf(TimeoutError);
    expect(performance.now() - start).toBeLessThan(1500);
  });

  it('does not follow redirects', async () => {
    const err = (await rejection(client('redirect').info())) as HTTPError;
    expect(err.status).toBe(302);
    expect(err.headers.get('location')).toBe('https://elsewhere.test/api/publish');
  });

  it('keeps the start of an error body', async () => {
    const err = (await rejection(client('bigerror').info())) as HTTPError;
    expect(err.status).toBe(502);
    expect(err.body.length).toBe(512);
  });

  it("refuses a reply which is not Centrifugo's", async () => {
    expect(await rejection(client('html').info())).toBeInstanceOf(DecodeError);
  });

  it('reports a refused connection as a retryable NetworkError', async () => {
    const s = createServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const { port } = s.address() as AddressInfo;
    await new Promise((r) => s.close(r));
    const err = await rejection(new Client({ apiEndpoint: `http://127.0.0.1:${port}/api` }).info());
    expect(err).toBeInstanceOf(NetworkError);
    expect(retryable(err)).toBe(true);
  });
});
