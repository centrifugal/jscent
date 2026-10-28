import { Client, type ClientOptions } from '../../src/index.ts';

export interface Sent {
  method: string;
  path: string;
  headers: Headers;
  body: string;
  json: unknown;
}

type Reply = Response | Record<string, unknown> | Error | Promise<Response | Record<string, unknown> | Error>;

/**
 * A fake Centrifugo behind fetch: reply answers each request - with a Response,
 * a result object for {"result": ...}, or an Error to throw - and every request
 * is recorded.
 */
export class FakeCentrifugo {
  readonly sent: Sent[] = [];
  reply: (method: string, json: any, init: RequestInit) => Reply;

  constructor(reply?: (method: string, json: any, init: RequestInit) => Reply) {
    this.reply = reply ?? (() => ({}));
  }

  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
    const body = String(init?.body ?? '');
    const sent: Sent = {
      method,
      path: url.pathname,
      headers: new Headers(init?.headers),
      body,
      json: JSON.parse(body || 'null'),
    };
    this.sent.push(sent);
    init?.signal?.throwIfAborted();
    const out = await this.reply(method, sent.json, init ?? {});
    if (out instanceof Error) {
      throw out;
    }
    if (out instanceof Response) {
      return out;
    }
    return json(200, { result: out });
  }) as typeof fetch;

  client(options: Partial<ClientOptions> = {}): Client {
    return new Client({ apiEndpoint: 'http://centrifugo.test/api', apiKey: 'key', fetch: this.fetch, ...options });
  }

  get last(): Sent {
    const last = this.sent.at(-1);
    if (last === undefined) {
      throw new Error('no request');
    }
    return last;
  }
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** A promise's rejection, failing when it resolves. */
export async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a rejection');
}
