import { DecodeError, InvalidConfigError, InvalidRequestError } from './errors.ts';

// JSON.rawJSON and the reviver's source text are in every runtime jscent
// supports, but not yet in TypeScript's libraries.
type ReviverContext = { source?: string };
type Reviver = (key: string, value: unknown, context?: ReviverContext) => unknown;
const jsonParse = (text: string, reviver?: Reviver): unknown =>
  (JSON.parse as (text: string, reviver?: Reviver) => unknown)(text, reviver);
const rawJSONOf = (JSON as unknown as { rawJSON?: (text: string) => unknown }).rawJSON;

/**
 * JSON text, sent as it is: a payload already encoded - from a database, a
 * queue, a cache - or encoded with rules of your own. It is checked to be
 * valid JSON when created, and sent unchanged, number text kept - also inside
 * another value:
 *
 *     new PublishRequest({ channel: 'news', data: rawJSON(row.payload) });
 *     new PublishRequest({ channel: 'news', data: { meta, doc: rawJSON(row.doc) } });
 *
 * A string, by contrast, is always a JSON string: `data: 'hi'` publishes "hi".
 */
export class RawJSON {
  /** The JSON text. */
  readonly text: string;

  constructor(text: string) {
    if (typeof text !== 'string') {
      throw new InvalidRequestError(`rawJSON takes a string, not ${typeof text}`);
    }
    try {
      JSON.parse(text);
    } catch (e) {
      throw new InvalidRequestError(`raw JSON is not valid JSON: ${(e as Error).message}`, { cause: e });
    }
    this.text = text;
  }

  /** Its value, for a JSON.stringify of your own: integers past 2^53 lose their digits there. */
  toJSON(): unknown {
    return JSON.parse(this.text);
  }

  toString(): string {
    return this.text;
  }
}

/** JSON text, sent as it is: see RawJSON. */
export function rawJSON(text: string): RawJSON {
  return new RawJSON(text);
}

let placeholderNonce = 0;

/**
 * A payload as JSON text: RawJSON as it is; anything else as JSON.stringify
 * writes it, with bigint written as a JSON number, and NaN, infinities, bytes,
 * functions, symbols, Maps and Sets refused - JSON.stringify would write them
 * as null or {}, or drop them, without a word.
 *
 * @internal
 */
export function encodePayload(value: unknown, path: string): string {
  if (value instanceof RawJSON) {
    return value.text;
  }
  // RawJSON inside a value: JSON.rawJSON takes primitives only, so each is
  // written as a placeholder string, then replaced by its text.
  const nonce = `\u0000jscent${(placeholderNonce++).toString(36)}${Math.random().toString(36).slice(2)}:`;
  const raws: string[] = [];
  let text: string | undefined;
  try {
    text = JSON.stringify(value, function (this: Record<string, unknown>, key: string, v: unknown) {
      const original = this[key];
      if (original instanceof RawJSON) {
        raws.push(original.text);
        return `${nonce}${raws.length - 1}`;
      }
      return replace(v, key === '' ? path : `${path}.${key}`);
    });
  } catch (e) {
    if (e instanceof InvalidRequestError) {
      throw e;
    }
    throw new InvalidRequestError(`${path} cannot be encoded: ${(e as Error).message}`, { cause: e });
  }
  if (text === undefined) {
    throw new InvalidRequestError(`${path} is ${typeof value}, which is not a JSON value`);
  }
  for (const [i, raw] of raws.entries()) {
    text = text.replace(JSON.stringify(`${nonce}${i}`), () => raw);
  }
  return text;
}

function replace(v: unknown, path: string): unknown {
  switch (typeof v) {
    case 'number':
      if (!Number.isFinite(v)) {
        throw new InvalidRequestError(`${path} is ${v}, which is not a JSON number`);
      }
      return v;
    case 'bigint':
      if (rawJSONOf === undefined) {
        throw new InvalidRequestError(
          `${path} is a bigint, which needs JSON.rawJSON: Node.js 21+, Deno 1.33+, Bun 1.1.43+, Chrome 114+`,
        );
      }
      return rawJSONOf(v.toString());
    case 'function':
    case 'symbol':
      throw new InvalidRequestError(`${path} is a ${typeof v}, which is not a JSON value`);
    case 'object':
      if (v instanceof Uint8Array || v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
        throw new InvalidRequestError(
          `${path} is binary, which is not JSON: send binary base64-encoded in a b64 field, such as b64data`,
        );
      }
      if (v instanceof Map || v instanceof Set) {
        throw new InvalidRequestError(
          `${path} is a ${v.constructor.name}, which JSON cannot hold: use an object or array`,
        );
      }
      return v;
    default:
      return v;
  }
}

/**
 * Whether JSON.parse gives a reviver the source text of each value, which
 * bigIntegers needs.
 *
 * @internal
 */
export function sourceTextSupported(): boolean {
  let supported = false;
  try {
    jsonParse('1', (_key, value, context) => {
      supported = context?.source === '1';
      return value;
    });
  } catch {
    // An engine without the context argument.
  }
  return supported;
}

/** @internal Fails with InvalidConfigError when bigIntegers cannot work here. */
export function checkBigIntegers(): void {
  if (!sourceTextSupported()) {
    throw new InvalidConfigError(
      'bigIntegers needs JSON.parse source text: Node.js 21+, Deno 1.33+, Bun 1.1.43+, Chrome 114+, Firefox 135+, Safari 18.4+',
    );
  }
}

const integerLiteral = /^-?\d+$/;
// An integer past 2^53 has 16 digits or more: most replies have no such run,
// and skip the reviver.
const longDigits = /\d{16}/;

function reviveBigInteger(_key: string, value: unknown, context?: ReviverContext): unknown {
  return typeof value === 'number' &&
    !Number.isSafeInteger(value) &&
    context?.source !== undefined &&
    integerLiteral.test(context.source)
    ? BigInt(context.source)
    : value;
}

/**
 * A reply's JSON, with integers a number cannot hold exactly as bigint when
 * bigIntegers is set.
 *
 * @internal
 */
export function decodeJSON(text: string, what: string, bigIntegers: boolean): unknown {
  try {
    if (!bigIntegers || !longDigits.test(text)) {
      return JSON.parse(text);
    }
    return jsonParse(text, reviveBigInteger);
  } catch (e) {
    throw new DecodeError(`${what}: the reply is not JSON: ${(e as Error).message}`, { cause: e });
  }
}
