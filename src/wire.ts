import { DecodeError, InvalidRequestError } from './errors.ts';
import { encodePayload } from './payload.ts';

// Encoding requests and decoding replies, from the field descriptors the
// generated code declares for each message.

/** @internal */
export const STRING = 0;
/** @internal */
export const BOOL = 1;
/** @internal */
export const INT = 2;
/** @internal */
export const FLOAT = 3;
/** @internal */
export const PAYLOAD = 4;
/** @internal */
export const MESSAGE = 5;
/** @internal BoolValue: absent, or {"value": bool}. */
export const BOOL_VALUE = 6;
/** @internal Int32Value: absent, or {"value": int}. */
export const INT32_VALUE = 7;

/** @internal */
export const SINGLE = 0;
/** @internal */
export const LIST = 1;
/** @internal */
export const MAP = 2;

/**
 * A field of a message, for the generated code: its wire name, kind, whether
 * it is a list or a map, and its message fields when the kind is MESSAGE.
 */
export type FieldSpec = readonly [wire: string, kind: number, shape?: number, of?: () => Fields];

/** The fields of a message, for the generated code. */
export type Fields = readonly FieldSpec[];

/** The JavaScript name of a wire name: skip_history -> skipHistory. */
function camel(wire: string): string {
  return wire.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

interface Compiled {
  js: string;
  wire: string;
  kind: number;
  shape: number;
  of: (() => Fields) | undefined;
}

const compiled = new WeakMap<Fields, Compiled[]>();

function compile(fields: Fields): Compiled[] {
  let out = compiled.get(fields);
  if (out === undefined) {
    out = fields.map(([wire, kind, shape, of]) => ({ js: camel(wire), wire, kind, shape: shape ?? SINGLE, of }));
    compiled.set(fields, out);
  }
  return out;
}

/**
 * A message as JSON: fields at their zero value - '', false, 0, an empty list
 * or map, a message with nothing set, undefined - left out, payloads encoded
 * apart and spliced in. `path` names the message in error messages.
 *
 * @internal
 */
export function encode(fields: Fields, obj: unknown, path: string): string {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new InvalidRequestError(`${path || 'the request'} must be an object, not ${kindOf(obj)}`);
  }
  const parts: string[] = [];
  const record = obj as Record<string, unknown>;
  const known = compile(fields);
  for (const key of Object.keys(record)) {
    if (record[key] !== undefined && !known.some((f) => f.js === key)) {
      // A field misspelled - or in snake_case, as Centrifugo's own JSON and
      // docs name it - would otherwise be dropped without a word.
      const like = known.find((f) => f.js === camel(key) || f.js.toLowerCase() === key.toLowerCase());
      throw new InvalidRequestError(
        `${path ? `${path}.` : ''}${key} is not a field${like ? `: did you mean ${like.js}?` : ''}`,
      );
    }
  }
  for (const f of known) {
    const v = record[f.js];
    if (v === undefined) {
      continue;
    }
    const where = path ? `${path}.${f.js}` : f.js;
    let json: string | undefined;
    if (f.shape === LIST) {
      if (!Array.isArray(v)) {
        throw new InvalidRequestError(`${where} must be an array, not ${kindOf(v)}`);
      }
      if (v.length > 0) {
        json = `[${v.map((item, i) => encodeValue(f, item, `${where}[${i}]`, true)).join(',')}]`;
      }
    } else if (f.shape === MAP) {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        throw new InvalidRequestError(`${where} must be an object, not ${kindOf(v)}`);
      }
      const entries = Object.entries(v);
      if (entries.length > 0) {
        json = `{${entries.map(([k, item]) => `${JSON.stringify(k)}:${encodeValue(f, item, `${where}[${JSON.stringify(k)}]`, true)}`).join(',')}}`;
      }
    } else {
      json = encodeValue(f, v, where, false);
    }
    if (json !== undefined) {
      parts.push(`${JSON.stringify(f.wire)}:${json}`);
    }
  }
  return `{${parts.join(',')}}`;
}

/** The JSON of one value of a field; undefined for a zero value, unless in a list or map. */
function encodeValue(f: Compiled, v: unknown, where: string, keep: boolean): string | undefined {
  switch (f.kind) {
    case STRING:
      if (typeof v !== 'string') {
        throw new InvalidRequestError(`${where} must be a string, not ${kindOf(v)}`);
      }
      if (!v.isWellFormed()) {
        throw new InvalidRequestError(`${where} is not a well-formed string: it has a lone surrogate`);
      }
      return v === '' && !keep ? undefined : JSON.stringify(v);
    case BOOL:
      if (typeof v !== 'boolean') {
        throw new InvalidRequestError(`${where} must be a boolean, not ${kindOf(v)}`);
      }
      return v || keep ? String(v) : undefined;
    case INT:
      if (typeof v === 'bigint') {
        return v === 0n && !keep ? undefined : v.toString();
      }
      if (typeof v !== 'number' || !Number.isInteger(v)) {
        throw new InvalidRequestError(`${where} must be an integer, not ${kindOf(v)}`);
      }
      return v === 0 && !keep ? undefined : String(v);
    case FLOAT:
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new InvalidRequestError(`${where} must be a finite number, not ${kindOf(v)}`);
      }
      return v === 0 && !keep ? undefined : JSON.stringify(v);
    case PAYLOAD:
      return encodePayload(v, where);
    case BOOL_VALUE:
      if (typeof v !== 'boolean') {
        throw new InvalidRequestError(`${where} must be a boolean, not ${kindOf(v)}`);
      }
      return `{"value":${v}}`;
    case INT32_VALUE:
      if (typeof v !== 'number' || !Number.isInteger(v)) {
        throw new InvalidRequestError(`${where} must be an integer, not ${kindOf(v)}`);
      }
      return `{"value":${v}}`;
    default: {
      const json = encode(f.of!(), v, where);
      return json === '{}' && !keep ? undefined : json;
    }
  }
}

/**
 * A message from its JSON, as JSON.parse gives it: every field present - at
 * its zero value when the reply left it out, undefined for a message, a
 * payload or a wrapper - fields the client does not know ignored, a field of
 * another type a DecodeError.
 *
 * @internal
 */
export function decode<T>(fields: Fields, v: unknown, path: string): T {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new DecodeError(`${path}: expected an object, got ${kindOf(v)}`);
  }
  const src = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const f of compile(fields)) {
    const where = `${path}.${f.wire}`;
    const item = Object.hasOwn(src, f.wire) ? src[f.wire] : undefined;
    if (f.shape === LIST) {
      if (item === undefined || item === null) {
        out[f.js] = [];
      } else if (!Array.isArray(item)) {
        throw new DecodeError(`${where}: expected an array, got ${kindOf(item)}`);
      } else {
        out[f.js] = item.map((x, i) => decodeValue(f, x, `${where}[${i}]`));
      }
    } else if (f.shape === MAP) {
      if (item === undefined || item === null) {
        out[f.js] = {};
      } else if (typeof item !== 'object' || Array.isArray(item)) {
        throw new DecodeError(`${where}: expected an object, got ${kindOf(item)}`);
      } else {
        // fromEntries keeps a "__proto__" key an own property.
        out[f.js] = Object.fromEntries(
          Object.entries(item).map(([k, x]) => [k, decodeValue(f, x, `${where}[${JSON.stringify(k)}]`)]),
        );
      }
    } else {
      out[f.js] = item === undefined || item === null ? zero(f) : decodeValue(f, item, where);
    }
  }
  return out as T;
}

function zero(f: Compiled): unknown {
  switch (f.kind) {
    case STRING:
      return '';
    case BOOL:
      return false;
    case INT:
    case FLOAT:
      return 0;
    default:
      return undefined;
  }
}

function decodeValue(f: Compiled, v: unknown, where: string): unknown {
  switch (f.kind) {
    case STRING:
      if (typeof v !== 'string') {
        throw new DecodeError(`${where}: expected a string, got ${kindOf(v)}`);
      }
      return v;
    case BOOL:
      if (typeof v !== 'boolean') {
        throw new DecodeError(`${where}: expected a boolean, got ${kindOf(v)}`);
      }
      return v;
    case INT:
      // With bigIntegers, an integer past 2^53 arrives as a bigint: the
      // server API's own numbers - offsets, counts - stay numbers.
      if (typeof v === 'bigint') {
        return Number(v);
      }
      if (typeof v !== 'number' || !Number.isInteger(v)) {
        throw new DecodeError(`${where}: expected an integer, got ${kindOf(v)}`);
      }
      return v;
    case FLOAT:
      if (typeof v === 'bigint') {
        return Number(v);
      }
      if (typeof v !== 'number') {
        throw new DecodeError(`${where}: expected a number, got ${kindOf(v)}`);
      }
      return v;
    case PAYLOAD:
      return v;
    case BOOL_VALUE:
    case INT32_VALUE: {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        throw new DecodeError(`${where}: expected an object, got ${kindOf(v)}`);
      }
      const inner = (v as Record<string, unknown>).value;
      // The value's zero, which a protobuf encoder leaves out.
      if (inner === undefined || inner === null) {
        return f.kind === BOOL_VALUE ? false : 0;
      }
      const expected = f.kind === BOOL_VALUE ? 'boolean' : 'number';
      if (typeof inner !== expected) {
        throw new DecodeError(`${where}.value: expected a ${expected}, got ${kindOf(inner)}`);
      }
      return inner;
    }
    default:
      return decode(f.of!(), v, where);
  }
}

/** @internal */
export function kindOf(v: unknown): string {
  if (v === null) {
    return 'null';
  }
  if (Array.isArray(v)) {
    return 'an array';
  }
  switch (typeof v) {
    case 'object':
      return 'an object';
    case 'string':
      return 'a string';
    case 'number':
      return Number.isNaN(v) ? 'NaN' : Number.isFinite(v) ? 'a number' : String(v);
    case 'boolean':
      return 'a boolean';
    default:
      return typeof v;
  }
}
