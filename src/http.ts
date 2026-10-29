// The HTTP handlers' framework-free core, and its Fetch and Node.js adapters.

/** A request to a handler, as the application's function receives it. */
export interface HttpRequest {
  /** The HTTP method, upper case. */
  readonly method: string;
  /**
   * The headers: those Centrifugo passes on from the client's connection to a
   * proxy, the client SDK's to an endpoint. `get` is case-insensitive.
   */
  readonly headers: Headers;
  /** The query parameters. */
  readonly query: URLSearchParams;
  /** The path, as the server saw it. */
  readonly path: string;
  /**
   * The server's own form of the request - the Fetch Request, Node's
   * IncomingMessage, or what was given to handle - for what the core does not
   * carry, such as the client's address or a user your framework
   * authenticated.
   */
  readonly raw: unknown;
}

/** A handler's answer. */
export interface HttpResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** What handle takes: a request in plain terms. */
export interface HandleInput {
  method: string;
  /** Headers as a Headers, an object - Express's req.headers - or pairs. */
  headers?: HeadersInit | Record<string, string | string[] | undefined>;
  body?: string | Uint8Array;
  /** The URL or path with its query: "/centrifugo/connect?x=1". */
  url?: string;
  raw?: unknown;
}

/** Called with every request answered 400 or 500, and the error. It must not throw. */
export type OnError = (request: HttpRequest, error: unknown) => void;

/** The parts of Node's IncomingMessage the Node adapter reads. Express's req is one. */
export interface NodeRequest extends AsyncIterable<unknown> {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  /** Set by a body parser which ran before: express.raw(), express.text() or express.json(). */
  body?: unknown;
}

/** The parts of Node's ServerResponse the Node adapter writes. Express's res is one. */
export interface NodeResponse {
  writeHead(status: number, headers: Record<string, string>): unknown;
  end(body: string): unknown;
}

const REASONS: Record<number, string> = {
  400: 'Bad Request',
  403: 'Forbidden',
  405: 'Method Not Allowed',
  500: 'Internal Server Error',
};

/** @internal */
export function text(status: number, message: string, extra: Record<string, string> = {}): HttpResponse {
  return { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...extra }, body: message };
}

/** @internal */
export function statusText(status: number): HttpResponse {
  return text(status, REASONS[status] ?? String(status));
}

/** @internal */
export function allow(methods: string): HttpResponse {
  return text(405, `only ${methods} allowed`, { Allow: methods });
}

/** @internal */
export function json(body: string, cache = 'no-store'): HttpResponse {
  return { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': cache }, body };
}

/**
 * The base of every handler - a token or signature endpoint, the JWKS
 * endpoint, a proxy handler. Its framework-free core, `handle`, turns a
 * request into a response; `fetch` serves it wherever requests are Fetch API
 * Requests - Cloudflare Workers, Deno, Bun, Hono, Next.js route handlers - and
 * `node` in node:http and Express.
 */
export abstract class Handler {
  /** The largest request body read, in bytes. */
  readonly maxBody: number;
  readonly #onError: OnError | undefined;

  constructor(onError: OnError | undefined, maxBody: number) {
    if (!Number.isInteger(maxBody) || maxBody <= 0) {
      throw new TypeError('maxBody must be a positive number of bytes');
    }
    if (onError !== undefined && typeof onError !== 'function') {
      throw new TypeError('onError must be a function');
    }
    this.maxBody = maxBody;
    this.#onError = onError;
  }

  /** @internal The response to the request, or the function's arguments after the request. */
  protected abstract begin(req: HttpRequest, body: string): HttpResponse | unknown[];

  /** @internal Calls the function with the arguments begin made. */
  protected abstract call(req: HttpRequest, args: unknown[]): unknown;

  /** @internal The response to what the function returned or threw. */
  protected abstract end(
    req: HttpRequest,
    args: unknown[],
    out: unknown,
    error: unknown,
    failed: boolean,
  ): HttpResponse;

  /** @internal status, after telling onError of error. */
  protected fail(req: HttpRequest, status: number, error: unknown): HttpResponse {
    this.#onError?.(req, error);
    return statusText(status);
  }

  /**
   * Answers a request: the core every adapter calls. `raw` is passed on to the
   * function as HttpRequest.raw: the server's own request object, or what your
   * framework knows of the request, such as its authenticated user.
   */
  async handle(input: HandleInput): Promise<HttpResponse> {
    const url = new URL(input.url ?? '/', 'http://handler');
    const req: HttpRequest = {
      method: input.method.toUpperCase(),
      headers: toHeaders(input.headers),
      query: url.searchParams,
      path: url.pathname,
      raw: input.raw,
    };
    const raw = input.body ?? '';
    const size = typeof raw === 'string' ? new TextEncoder().encode(raw).byteLength : raw.byteLength;
    if (size > this.maxBody) {
      return this.fail(req, 400, new RangeError(`request body over ${this.maxBody} bytes`));
    }
    const body = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    const begun = this.begin(req, body);
    if (!Array.isArray(begun)) {
      return begun;
    }
    let out: unknown;
    try {
      out = await this.call(req, begun);
    } catch (e) {
      return this.end(req, begun, undefined, e, true);
    }
    return this.end(req, begun, out, undefined, false);
  }

  /**
   * The handler as a Fetch API function, bound to it:
   *
   * ```ts
   * export default { fetch: handler.fetch };              // Cloudflare Workers, Bun.serve, Deno.serve
   * export const POST = handler.fetch;                     // a Next.js route handler
   * app.post('/centrifugo/connect', (c) => handler.fetch(c.req.raw));   // Hono
   * ```
   */
  readonly fetch = async (request: Request): Promise<Response> => {
    const body = await readLimited(request.body, this.maxBody);
    const res = await this.handle({
      method: request.method,
      headers: request.headers,
      body,
      url: request.url,
      raw: request,
    });
    return new Response(res.status === 200 && request.method === 'HEAD' ? null : res.body, {
      status: res.status,
      headers: res.headers,
    });
  };

  /**
   * The handler for node:http and Express, bound to it:
   *
   * ```ts
   * http.createServer(handler.node);
   * app.post('/centrifugo/connect', handler.node);                       // Express
   * ```
   *
   * It reads the body itself. Behind a body parser - express.json() - it
   * takes what the parser read: register express.raw() or express.text() on
   * the route to keep the body exactly as Centrifugo sent it.
   */
  readonly node = async (req: NodeRequest, res: NodeResponse): Promise<void> => {
    let body: string | Uint8Array;
    if (typeof req.body === 'string' || req.body instanceof Uint8Array) {
      body = req.body;
    } else if (req.body !== undefined && req.body !== null && typeof req.body === 'object') {
      body = JSON.stringify(req.body);
    } else {
      body = await readNode(req, this.maxBody);
    }
    const out = await this.handle({ method: req.method ?? 'GET', headers: req.headers, body, url: req.url, raw: req });
    res.writeHead(out.status, out.headers);
    res.end(req.method === 'HEAD' ? '' : out.body);
  };
}

function toHeaders(h: HandleInput['headers']): Headers {
  if (h === undefined) {
    return new Headers();
  }
  if (h instanceof Headers || Array.isArray(h)) {
    return new Headers(h);
  }
  const out = new Headers();
  for (const [k, v] of Object.entries(h)) {
    if (Array.isArray(v)) {
      for (const item of v) {
        out.append(k, item);
      }
    } else if (v !== undefined) {
      out.append(k, v);
    }
  }
  return out;
}

/** A body, read up to one byte past limit: enough to tell it is too large. */
async function readLimited(stream: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array> {
  if (stream === null) {
    return new Uint8Array();
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size <= limit) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return concat(chunks, size);
}

async function readNode(req: NodeRequest, limit: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of req) {
    const c = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : (chunk as Uint8Array);
    chunks.push(c);
    size += c.byteLength;
    if (size > limit) {
      break;
    }
  }
  return concat(chunks, size);
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}
