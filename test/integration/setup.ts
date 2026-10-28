// The integration tests run against a real Centrifugo, set up as
// testdata/centrifugo.json says - history and presence for channels without a
// namespace, a "map" and a "poll" namespace, HMAC and Ed25519 client tokens,
// the unidirectional HTTP stream, the connect and refresh proxies:
//
//     docker compose -f testdata/centrifugo-pro.compose.yml up -d --wait   # Centrifugo PRO
//     npm run test:integration
//
// JSCENT_TEST_ADDR and JSCENT_TEST_API_KEY default to http://localhost:8100/api
// and "api_key". The PRO tests skip against Centrifugo OSS, unless
// JSCENT_TEST_PRO is set: then a server which is not PRO fails them.

import { createServer, type RequestListener, type Server } from 'node:http';
import { Client } from '../../src/index.ts';

export const ADDR = process.env.JSCENT_TEST_ADDR ?? 'http://localhost:8100/api';
export const API_KEY = process.env.JSCENT_TEST_API_KEY ?? 'api_key';

export async function client(): Promise<Client> {
  const c = new Client({ apiEndpoint: ADDR, apiKey: API_KEY });
  try {
    await c.info();
  } catch (e) {
    throw new Error(`Centrifugo not reachable at ${ADDR}: ${(e as Error).message}`);
  }
  return c;
}

/** The client when the server is Centrifugo PRO; undefined to skip otherwise. */
export async function pro(): Promise<Client | undefined> {
  const c = await client();
  try {
    await c.connections({ user: 'nobody' });
  } catch (e) {
    if (process.env.JSCENT_TEST_PRO) {
      throw new Error(`JSCENT_TEST_PRO is set, but the server is not Centrifugo PRO: ${(e as Error).message}`);
    }
    return undefined;
  }
  return c;
}

let n = 0;
export function unique(prefix = ''): string {
  return `${prefix}jscent-${Date.now().toString(36)}-${(n++).toString(36)}`;
}

/** Serves a handler on all interfaces at port, where Centrifugo reaches it as host.docker.internal. */
export async function serve(port: number, listener: RequestListener): Promise<Server> {
  const server = createServer(listener);
  await new Promise<void>((resolve) => server.listen(port, '0.0.0.0', resolve));
  return server;
}

export function stop(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

/** A client connection over Centrifugo's unidirectional HTTP stream: one JSON message per line. */
export class Stream {
  readonly #ac = new AbortController();
  readonly #lines: AsyncGenerator<string>;

  constructor(body: Record<string, unknown>) {
    const ac = this.#ac;
    const url = `${ADDR.replace(/\/api$/, '')}/connection/uni_http_stream`;
    this.#lines = (async function* () {
      const res = await fetch(url, { method: 'POST', body: JSON.stringify(body), signal: ac.signal });
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body!) {
        buf += decoder.decode(chunk, { stream: true });
        let i = buf.indexOf('\n');
        while (i >= 0) {
          yield buf.slice(0, i);
          buf = buf.slice(i + 1);
          i = buf.indexOf('\n');
        }
      }
    })();
  }

  /** The next message, undefined once the connection is closed; pings skipped. */
  async next(): Promise<Record<string, any> | undefined> {
    for (;;) {
      const { value, done } = await this.#lines.next().catch(() => ({ value: undefined, done: true }));
      if (done || value === undefined) {
        return undefined;
      }
      const line = value.trim();
      if (line && line !== '{}') {
        return JSON.parse(line);
      }
    }
  }

  close(): void {
    this.#ac.abort();
  }
}
