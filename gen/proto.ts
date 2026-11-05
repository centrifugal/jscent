// A parser for the part of proto3 Centrifugo's api.proto and proxy.proto use.
//
// Top-level messages with scalar, message, repeated and map fields, and one
// service whose methods may stream. Anything else - a oneof, an enum, a nested
// message - fails the generation, rather than being dropped from the SDK
// without a word.

export const SCALARS = new Set(['string', 'bool', 'int32', 'int64', 'uint32', 'uint64', 'double', 'float', 'bytes']);

export interface Field {
  name: string;
  /** A scalar or message type; the value type for maps. */
  type: string;
  repeated: boolean;
  mapKey: string;
  doc: string[];
}

export interface Message {
  name: string;
  doc: string[];
  fields: Field[];
}

export interface Method {
  name: string;
  request: string;
  response: string;
  streaming: boolean;
}

export interface Schema {
  messages: Message[];
  byName: Map<string, Message>;
  methods: Method[];
}

const MESSAGE_OPEN = /^message\s+(\w+)\s*\{\s*(\})?$/;
const FIELD = /^(repeated\s+)?(\w+)\s+(\w+)\s*=\s*\d+\s*;$/;
const MAP_FIELD = /^map\s*<\s*(\w+)\s*,\s*(\w+)\s*>\s+(\w+)\s*=\s*\d+\s*;$/;
const RESERVED = /^reserved\s+[\d\s,to]+;$/;
const SERVICE_OPEN = /^service\s+\w+\s*\{$/;
const RPC = /^rpc\s+(\w+)\s*\(\s*(stream\s+)?(\w+)\s*\)\s*returns\s*\(\s*(stream\s+)?(\w+)\s*\)\s*(?:\{\s*\}|;)$/;
const TOP_LEVEL_SKIP = /^(syntax|package|option)\b.*;$/;

export function parse(text: string, name: string): Schema {
  const s: Schema = { messages: [], byName: new Map(), methods: [] };
  let comment: string[] = [];
  let current: Message | null = null;
  let inService = false;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const fail = (msg: string) => new Error(`${name}:${i + 1}: ${msg}`);
    let line = (lines[i] ?? '').trim();
    if (line === '') {
      // A blank line ends a comment block: only a comment directly above a
      // declaration documents it.
      comment = [];
      continue;
    }
    if (line.startsWith('//')) {
      comment.push(line.slice(2).trim());
      continue;
    }
    const pos = line.indexOf('//');
    if (pos >= 0) {
      // A trailing comment documents its line when nothing above does.
      if (comment.length === 0) {
        comment = [line.slice(pos + 2).trim()];
      }
      line = line.slice(0, pos).trim();
    }

    let m: RegExpMatchArray | null = null;
    const matches = (re: RegExp): boolean => {
      m = line.match(re);
      return m !== null;
    };
    if (current === null && !inService) {
      if (TOP_LEVEL_SKIP.test(line)) {
        // Nothing to generate.
      } else if (matches(MESSAGE_OPEN) && m) {
        const msgName = m[1]!;
        if (s.byName.has(msgName)) {
          throw fail(`message ${msgName} declared twice`);
        }
        const msg: Message = { name: msgName, doc: comment, fields: [] };
        s.messages.push(msg);
        s.byName.set(msgName, msg);
        if (!m[2]) {
          current = msg;
        }
      } else if (SERVICE_OPEN.test(line)) {
        inService = true;
      } else {
        throw fail(`unsupported top-level declaration: ${line}`);
      }
    } else if (inService) {
      if (line === '}') {
        inService = false;
      } else if (matches(RPC) && m) {
        s.methods.push({ name: m[1]!, request: m[3]!, response: m[5]!, streaming: Boolean(m[2] || m[4]) });
      } else {
        throw fail(`unsupported service declaration: ${line}`);
      }
    } else if (current !== null) {
      if (line === '}') {
        current = null;
      } else if (RESERVED.test(line)) {
        // Nothing to generate.
      } else if (matches(MAP_FIELD) && m) {
        current.fields.push({ name: m[3]!, type: m[2]!, repeated: false, mapKey: m[1]!, doc: comment });
      } else if (matches(FIELD) && m) {
        current.fields.push({ name: m[3]!, type: m[2]!, repeated: Boolean(m[1]), mapKey: '', doc: comment });
      } else {
        throw fail(`unsupported declaration in message ${current.name}: ${line}`);
      }
    }
    comment = [];
  }
  if (current !== null || inService) {
    throw new Error(`${name}: unexpected end of file`);
  }
  check(s, name);
  return s;
}

/** Every type a field or method refers to is declared. */
function check(s: Schema, name: string): void {
  for (const m of s.messages) {
    for (const f of m.fields) {
      if (!SCALARS.has(f.type) && !s.byName.has(f.type)) {
        throw new Error(`${name}: ${m.name}.${f.name} has unknown type ${f.type}`);
      }
      if (f.mapKey && f.mapKey !== 'string') {
        throw new Error(`${name}: ${m.name}.${f.name}: only string map keys are supported`);
      }
    }
  }
  for (const rpc of s.methods) {
    if (!s.byName.has(rpc.request) || !s.byName.has(rpc.response)) {
      throw new Error(`${name}: rpc ${rpc.name} refers to an undeclared message`);
    }
  }
}
