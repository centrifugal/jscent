// Writes src/generated/ from proto/api.proto and proto/proxy.proto: the
// request and result types of every Centrifugo server API method, the client's
// API methods, and the requests and results of the proxy protocol.
//
//     node gen/generate.ts            # write
//     node gen/generate.ts --check    # fail when src/generated/ is stale
//
// The output is committed, formatted with Biome.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Field, type Message, parse, type Schema } from './proto.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// rpc calls server API extensions, which neither Centrifugo OSS nor PRO
// provides.
const OMITTED_COMMANDS = new Set(['rpc']);
// Messages written by hand (BroadcastResult: a result per channel; Error: an
// error class), only used on the wire (the batch envelope), or wrappers which
// become optional scalars.
const HANDWRITTEN = new Set(['Error', 'BroadcastResult']);
const WIRE_ONLY = new Set(['Command', 'Reply', 'BatchRequest', 'BatchResponse']);
const WRAPPERS: Record<string, string> = { BoolValue: 'boolean', Int32Value: 'number' };
const TS_TYPES: Record<string, [string, string]> = {
  string: ['string', 'STRING'],
  bool: ['boolean', 'BOOL'],
  int32: ['number', 'INT'],
  int64: ['number', 'INT'],
  uint32: ['number', 'INT'],
  uint64: ['number', 'INT'],
  double: ['number', 'FLOAT'],
  float: ['number', 'FLOAT'],
  bytes: ['unknown', 'PAYLOAD'],
};

interface Command {
  method: string;
  request: Message;
  result: string;
  proOnly: boolean;
}

function camel(snake: string): string {
  return snake.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function commands(s: Schema): Command[] {
  const cmd = s.byName.get('Command');
  const reply = s.byName.get('Reply');
  if (!cmd || !reply) {
    throw new Error('api.proto: Command and Reply messages are required');
  }
  const results = new Map(reply.fields.map((f) => [f.name, f.type]));
  const out: Command[] = [];
  for (const f of cmd.fields) {
    if (OMITTED_COMMANDS.has(f.name)) {
      continue;
    }
    const req = s.byName.get(f.type);
    const result = results.get(f.name);
    if (!req || !result) {
      throw new Error(`api.proto: Command.${f.name} has no request message or no Reply.${f.name}`);
    }
    const want = `${f.name
      .split('_')
      .map((p) => p[0]!.toUpperCase() + p.slice(1))
      .join('')}Request`;
    if (f.type.toLowerCase() !== want.toLowerCase()) {
      throw new Error(`api.proto: Command.${f.name} is ${f.type}, expected ${want}`);
    }
    out.push({ method: f.name, request: req, result, proOnly: f.doc.join(' ').includes('Centrifugo PRO only') });
  }
  return out;
}

/** The messages reachable from roots through their fields. */
function closure(s: Schema, roots: string[]): Set<string> {
  const seen = new Set<string>();
  const visit = (name: string) => {
    const m = s.byName.get(name);
    if (!m || seen.has(name) || name in WRAPPERS) {
      return;
    }
    seen.add(name);
    for (const f of m.fields) {
      visit(f.type);
    }
  };
  roots.forEach(visit);
  return seen;
}

// Docs.

/** A comment line made safe inside a JSDoc block. */
function safe(l: string): string {
  return l.replaceAll('*/', '*∕');
}

/**
 * Field mentions as the JavaScript names: `data` and version_epoch become
 * `data` and `versionEpoch`; SubscribeRequest.all_users becomes
 * SubscribeRequest.allUsers. A bare name is taken for a field only when it
 * cannot be an English word - it has an underscore or a digit - so that
 * "binary data" stays prose.
 */
function fieldRefs(s: Schema, m: Message, lines: string[]): string[] {
  lines = lines.map((l) =>
    l.replace(/\b([A-Z]\w*)\.([a-z][a-z0-9_]*)\b/g, (whole, type: string, field: string) =>
      s.byName.get(type)?.fields.some((g) => g.name === field) ? `${type}.${camel(field)}` : whole,
    ),
  );
  const names = new Set<string>();
  for (const other of s.messages) {
    for (const g of other.fields) {
      if (/[_0-9]/.test(g.name)) {
        names.add(g.name);
      }
    }
  }
  for (const g of m.fields) {
    names.add(g.name);
  }
  for (const name of names) {
    const tick = new RegExp(`\`${name}\``, 'g');
    lines = lines.map((l) => l.replace(tick, `\`${camel(name)}\``));
    if (/[_0-9]/.test(name)) {
      const bare = new RegExp(`(?<![\\w.\`/:-])${name}(?![\\w/\`-])`, 'g');
      lines = lines.map((l) => l.replace(bare, `\`${camel(name)}\``));
    }
  }
  return lines;
}

/**
 * A field's proto comment, without the field's name it starts with as Go's
 * comments do: "skip_history skips adding..." becomes "Skips adding...", "data
 * is the payload" becomes "The payload", "version, when > 0, is the version"
 * becomes "When > 0, the version".
 */
function fieldDoc(s: Schema, m: Message, f: Field): string[] {
  const lines = [...f.doc];
  if (lines.length > 0) {
    const first = lines[0]!;
    const name = f.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const isAre = first.match(new RegExp(`^\`?${name}\`?\\s+(?:is|are)\\s+(.*)$`));
    const clause = first.match(new RegExp(`^\`?${name}\`?,\\s*(.+?),\\s+(?:(?:is|are)\\s+)?(.*)$`));
    const verb = first.match(new RegExp(`^\`?${name}\`?\\s+([a-z].*)$`));
    if (isAre) {
      lines[0] = upper(isAre[1]!);
    } else if (clause) {
      // "version, when > 0, is the version..." -> "When > 0, the version..."
      lines[0] = `${upper(clause[1]!)}, ${clause[2]}`;
    } else if (verb) {
      lines[0] = upper(verb[1]!);
    }
  }
  return fieldRefs(s, m, lines);
}

function upper(t: string): string {
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function jsdoc(lines: string[], indent: string): string {
  if (lines.length === 0) {
    return '';
  }
  if (lines.length === 1) {
    return `${indent}/** ${safe(lines[0]!)} */\n`;
  }
  return `${indent}/**\n${lines.map((l) => `${indent} *${l ? ` ${safe(l)}` : ''}`).join('\n')}\n${indent} */\n`;
}

function methodDoc(s: Schema, c: Command): string[] {
  const doc = [...c.request.doc];
  const prefix = `${c.request.name} `;
  if (doc[0]?.startsWith(prefix)) {
    doc[0] = upper(doc[0].slice(prefix.length));
  }
  if (doc.length === 0) {
    doc.push(`Calls the ${c.method} method of the Centrifugo server API.`);
  }
  if (c.proOnly && !doc.join(' ').includes('Centrifugo PRO only')) {
    doc.push('Centrifugo PRO only.');
  }
  return fieldRefs(s, c.request, doc);
}

// Code.

interface Shapes {
  /** Messages sent: their input type has optional fields. */
  input: Set<string>;
  /** Messages received: their output type has every field. */
  output: Set<string>;
}

/** The name of a message's input type: itself, unless it is also received. */
function inputName(sh: Shapes, name: string): string {
  return sh.output.has(name) ? `${name}Init` : name;
}

function fieldType(sh: Shapes, f: Field, input: boolean): string {
  let t: string;
  if (f.type in WRAPPERS) {
    t = WRAPPERS[f.type]!;
  } else if (TS_TYPES[f.type]) {
    t = TS_TYPES[f.type]![0];
  } else {
    t = input ? inputName(sh, f.type) : f.type;
  }
  if (f.mapKey) {
    return `Record<string, ${t}>`;
  }
  if (f.repeated) {
    return input ? `readonly ${t}[]` : `${t}[]`;
  }
  if (!input && (f.type in WRAPPERS || !TS_TYPES[f.type])) {
    return `${t} | undefined`;
  }
  return t;
}

function descriptor(m: Message): string {
  const specs = m.fields.map((f) => {
    let kind: string;
    let of = '';
    if (f.type === 'BoolValue') {
      kind = 'BOOL_VALUE';
    } else if (f.type === 'Int32Value') {
      kind = 'INT32_VALUE';
    } else if (TS_TYPES[f.type]) {
      kind = TS_TYPES[f.type]![1];
    } else {
      kind = 'MESSAGE';
      of = `, () => ${f.type}Fields`;
    }
    const shape = f.mapKey ? 'MAP' : f.repeated ? 'LIST' : of ? 'SINGLE' : '';
    return `['${f.name}', ${kind}${shape ? `, ${shape}` : ''}${of}]`;
  });
  return `/** @internal */\nexport const ${m.name}Fields: Fields = [${specs.join(', ')}];\n`;
}

function emitInterface(s: Schema, sh: Shapes, m: Message, name: string, input: boolean, doc: string[]): string {
  let out = jsdoc(doc, '');
  if (m.fields.length === 0) {
    return `${out}export type ${name} = Record<string, never>;\n`;
  }
  out += `export interface ${name} {\n`;
  for (const f of m.fields) {
    out += jsdoc(fieldDoc(s, m, f), '  ');
    out += `  ${input ? '' : 'readonly '}${camel(f.name)}${input ? '?' : ''}: ${fieldType(sh, f, input)};\n`;
  }
  return `${out}}\n`;
}

function emitMessage(s: Schema, sh: Shapes, m: Message, protocol: string, command?: Command): string {
  const doc = fieldRefs(
    s,
    m,
    m.doc.length > 0 ? m.doc : [`${m.name} is the ${m.name} message of the Centrifugo ${protocol}.`],
  );
  let out = '';
  if (command) {
    // A request: the fields of a call, as a plain object.
    out += emitInterface(s, sh, m, m.name, true, doc);
  } else {
    if (sh.output.has(m.name)) {
      out += emitInterface(s, sh, m, m.name, false, doc);
    }
    if (sh.input.has(m.name)) {
      out += out ? '\n' : '';
      out += emitInterface(
        s,
        sh,
        m,
        inputName(sh, m.name),
        true,
        sh.output.has(m.name) ? [`${m.name}, as sent.`] : doc,
      );
    }
  }
  return `${out}\n${descriptor(m)}`;
}

const HEADER = (proto: string) => `// Code generated by gen/generate.ts from proto/${proto}. DO NOT EDIT.\n\n`;

function generateApi(s: Schema): string {
  const cmds = commands(s);
  const skip = new Set([...HANDWRITTEN, ...WIRE_ONLY, ...Object.keys(WRAPPERS)]);
  for (const rpc of s.methods) {
    skip.add(rpc.response);
  }
  for (const c of ['Command', 'Reply']) {
    for (const f of s.byName.get(c)!.fields) {
      if (OMITTED_COMMANDS.has(f.name)) {
        skip.add(f.type);
      }
    }
  }
  const byRequest = new Map(cmds.map((c) => [c.request.name, c]));
  const sh: Shapes = {
    input: closure(
      s,
      cmds.map((c) => c.request.name),
    ),
    output: closure(
      s,
      cmds.map((c) => c.result).filter((r) => r !== 'BroadcastResult'),
    ),
  };
  // BroadcastResult is hand-written, but its PublishResult is received.
  sh.output.add('PublishResult');
  for (const c of cmds) {
    sh.input.delete(c.request.name);
  }

  let out = HEADER('api.proto');
  out += `import type { Pending } from '../batch.ts';\n`;
  out += `import type { BroadcastResult } from '../broadcast.ts';\n`;
  out += `import { type Command, newCommand } from '../command.ts';\n`;
  out += `import type { CallOptions } from '../request.ts';\n`;
  out += `import {\n  BOOL,\n  BOOL_VALUE,\n  FLOAT,\n  type Fields,\n  INT,\n  INT32_VALUE,\n  LIST,\n  MAP,\n  MESSAGE,\n  PAYLOAD,\n  SINGLE,\n  STRING,\n} from '../wire.ts';\n\n`;
  out += `// Every kind is listed for the descriptors below; some may go unused.\nvoid [BOOL, BOOL_VALUE, FLOAT, INT, INT32_VALUE, LIST, MAP, MESSAGE, PAYLOAD, SINGLE, STRING];\n\n`;
  for (const m of s.messages) {
    if (!skip.has(m.name)) {
      out += `${emitMessage(s, sh, m, 'server API', byRequest.get(m.name))}\n`;
    }
  }

  out += `/** Every API method: whether only Centrifugo PRO has it, its request's and its result's fields. @internal */\n`;
  out += `export const METHODS: Record<string, { readonly pro: boolean; readonly request: Fields; readonly result: Fields | undefined }> = {\n`;
  out += `  batch: { pro: false, request: [], result: undefined },\n`;
  for (const c of cmds) {
    const result = c.method === 'broadcast' ? 'undefined' : `${c.result}Fields`;
    out += `  ${c.method}: { pro: ${c.proOnly}, request: ${c.request.name}Fields, result: ${result} },\n`;
  }
  out += `};\n\n`;

  // The same methods three times: on the client, on a batch, for commands.
  const kinds: [string, string, (c: Command) => string, string][] = [
    [
      'ClientMethods',
      "/**\n * The server API methods of Client, one per method of api.proto: each takes its\n * request's fields and the call's options.\n */",
      (c) => `Promise<${c.result}>`,
      '  /** @internal */\n  protected abstract invoke<T>(method: string, request: object, options: CallOptions | undefined): Promise<T>;\n',
    ],
    [
      'BatchMethods',
      '/**\n * The commands of a Batch, one per method of api.proto: each adds its command,\n * and returns the Pending its outcome arrives in once the batch is sent.\n */',
      (c) => `Pending<${c.method === 'broadcast' ? 'BroadcastResult' : c.result}>`,
      '  /** @internal */\n  protected abstract add<T>(method: string, request: object): Pending<T>;\n',
    ],
  ];
  for (const [cls, doc, ret, abstract] of kinds) {
    out += `${doc}\nexport abstract class ${cls} {\n${abstract}`;
    for (const c of cmds) {
      if (cls === 'ClientMethods' && c.method === 'broadcast') {
        continue; // written by hand: its result is a result per channel
      }
      const req = c.request.name;
      const arg = `request: ${req}${c.request.fields.length === 0 ? ' = {}' : ''}`;
      const opts = cls === 'ClientMethods' ? ', options?: CallOptions' : '';
      const call =
        cls === 'ClientMethods' ? `this.invoke('${c.method}', request, options)` : `this.add('${c.method}', request)`;
      const mdoc =
        cls === 'ClientMethods' ? methodDoc(s, c) : [`Adds a ${c.method} command: see Client.${camel(c.method)}.`];
      out += `\n${jsdoc(mdoc, '  ')}`;
      out += `  ${camel(c.method)}(${arg}${opts}): ${ret(c)} {\n    return ${call};\n  }\n`;
    }
    out += `}\n\n`;
  }
  out += `/**\n * Commands for Centrifugo's async consumers, one per method of api.proto: each\n * checks its request as a call does, and encodes it. See Command.\n *\n * \`\`\`ts\n * const cmd = command.publish({ channel: 'news', data: { text: 'hi' } });\n * \`\`\`\n */\n`;
  out += `export const command = {\n`;
  for (const c of cmds) {
    const req = c.request.name;
    const arg = `request: ${req}${c.request.fields.length === 0 ? ' = {}' : ''}`;
    out += `${jsdoc([`The ${c.method} command.`], '  ')}`;
    out += `  ${camel(c.method)}: (${arg}): Command => newCommand('${c.method}', request),\n`;
  }
  return `${out}};\n`;
}

function generateProxy(s: Schema): string {
  const requests: string[] = [];
  const results: string[] = [];
  const skip = new Set(['Error', 'Disconnect', ...Object.keys(WRAPPERS)]);
  for (const rpc of s.methods) {
    if (rpc.streaming) {
      continue;
    }
    requests.push(rpc.request);
    skip.add(rpc.response);
    const result = s.byName.get(rpc.response)!.fields.find((f) => f.name === 'result');
    if (result) {
      results.push(result.type);
    }
  }
  const sh: Shapes = { input: closure(s, results), output: closure(s, requests) };
  let out = HEADER('proxy.proto');
  out += `import {\n  BOOL,\n  BOOL_VALUE,\n  FLOAT,\n  type Fields,\n  INT,\n  INT32_VALUE,\n  LIST,\n  MAP,\n  MESSAGE,\n  PAYLOAD,\n  SINGLE,\n  STRING,\n} from '../wire.ts';\n\n`;
  out += `// Every kind is listed for the descriptors below; some may go unused.\nvoid [BOOL, BOOL_VALUE, FLOAT, INT, INT32_VALUE, LIST, MAP, MESSAGE, PAYLOAD, SINGLE, STRING];\n\n`;
  for (const m of s.messages) {
    if (!skip.has(m.name) && (sh.input.has(m.name) || sh.output.has(m.name))) {
      out += `${emitMessage(s, sh, m, 'proxy protocol')}\n`;
    }
  }
  return out;
}

function generate(): Map<string, string> {
  const api = parse(readFileSync(join(ROOT, 'proto/api.proto'), 'utf8'), 'api.proto');
  const proxy = parse(readFileSync(join(ROOT, 'proto/proxy.proto'), 'utf8'), 'proxy.proto');
  return new Map([
    ['api.ts', generateApi(api)],
    ['proxy.ts', generateProxy(proxy)],
  ]);
}

/** The files as Biome formats them, so that the committed code passes the lint. */
function format(files: Map<string, string>): Map<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'jscent-gen-'));
  try {
    const gen = join(dir, 'src', 'generated');
    mkdirSync(gen, { recursive: true });
    for (const [name, code] of files) {
      writeFileSync(join(gen, name), code);
    }
    execFileSync(
      join(ROOT, 'node_modules/.bin/biome'),
      [
        'check',
        '--write',
        '--linter-enabled=false',
        `--config-path=${ROOT}`,
        ...[...files.keys()].map((n) => join(gen, n)),
      ],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    );
    return new Map([...files.keys()].map((n) => [n, readFileSync(join(gen, n), 'utf8')]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const files = format(generate());
const target = join(ROOT, 'src/generated');
if (process.argv.includes('--check')) {
  const stale = [...files].filter(([name, code]) => {
    try {
      return readFileSync(join(target, name), 'utf8') !== code;
    } catch {
      return true;
    }
  });
  if (stale.length > 0) {
    console.error(
      `stale generated code: ${stale.map(([n]) => `src/generated/${n}`).join(', ')}: run \`npm run generate\``,
    );
    process.exit(1);
  }
} else {
  mkdirSync(target, { recursive: true });
  for (const [name, code] of files) {
    writeFileSync(join(target, name), code);
  }
}
