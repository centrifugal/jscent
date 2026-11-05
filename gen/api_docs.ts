// Writes API.md, the API reference, from the type declarations the build
// writes to dist/ - the docs of everything public; what is marked @internal is
// already left out of them.
//
//     npm run build && node gen/api_docs.ts            # write
//     npm run build && node gen/api_docs.ts --check    # fail when API.md is stale

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

interface Decl {
  doc: string;
  /** The declaration's text, its body for a class or interface left out. */
  head: string;
  kind: 'class' | 'interface' | 'type' | 'function' | 'const' | 'other';
  name: string;
  members: Decl[];
}

/**
 * The statements of declaration text, each with the doc comment above it:
 * split at semicolons and closing braces outside brackets, strings and
 * comments.
 */
function statements(text: string): { doc: string; code: string }[] {
  const out: { doc: string; code: string }[] = [];
  let i = 0;
  let doc = '';
  let start = -1;
  let depth = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2) + 2;
      if (start < 0 && text[i + 2] === '*') {
        doc = text.slice(i, end);
      }
      i = end;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      i = text.indexOf('\n', i);
      i = i < 0 ? text.length : i;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      if (start < 0) {
        start = i;
      }
      let j = i + 1;
      while (j < text.length && text[j] !== c) {
        j += text[j] === '\\' ? 2 : 1;
      }
      i = j + 1;
      continue;
    }
    if (start < 0 && !/\s/.test(c)) {
      start = i;
    }
    if (c === '{' || c === '(' || c === '[' || c === '<') {
      depth++;
    } else if (c === '}' || c === ')' || c === ']' || (c === '>' && text[i - 1] !== '=')) {
      depth--;
      if (
        depth === 0 &&
        c === '}' &&
        start >= 0 &&
        !/^\s*[;,|&)]/.test(text.slice(i + 1, i + 3)) &&
        !/=\s*$/.test(text.slice(start, i).split('{')[0] ?? '')
      ) {
        // The end of a class or interface body.
        const code = text.slice(start, i + 1);
        if (/^(export\s+)?(declare\s+)?(abstract\s+)?(class|interface)\b/.test(code)) {
          out.push({ doc, code });
          doc = '';
          start = -1;
        }
      }
    } else if (c === ';' && depth === 0 && start >= 0) {
      out.push({ doc, code: text.slice(start, i + 1) });
      doc = '';
      start = -1;
    }
    i++;
  }
  return out;
}

function parse(text: string, inBody = false): Decl[] {
  const out: Decl[] = [];
  for (const { doc, code } of statements(text)) {
    if (
      /^(import|export\s*\{|export\s*\*|export\s+type\s*\{|#private|\/\/)/.test(code) ||
      /@internal/.test(doc) ||
      /^(readonly\s+)?__/.test(code)
    ) {
      continue;
    }
    if (inBody) {
      if (/^(private|protected)\b/.test(code)) {
        continue;
      }
      const name = code.match(/^(?:(?:static|readonly|abstract|get|set|declare)\s+)*([\w$]+|constructor)/)?.[1] ?? '';
      out.push({
        doc,
        head: code.replace(/\s+/g, ' ').replace(/;$/, ''),
        kind: /\(/.test(code.split(':')[0] ?? '') ? 'function' : 'other',
        name,
        members: [],
      });
      continue;
    }
    if (!code.startsWith('export')) {
      continue;
    }
    const m = code.match(/^export\s+(?:declare\s+)?(?:abstract\s+)?(class|interface|type|function|const)\s+([\w$]+)/);
    if (!m) {
      continue;
    }
    const kind = m[1] as Decl['kind'];
    const decl: Decl = { doc, head: code, kind, name: m[2]!, members: [] };
    if (kind === 'class' || kind === 'interface') {
      const open = code.indexOf('{');
      decl.head = code.slice(0, open).trim();
      decl.members = parse(code.slice(open + 1, code.lastIndexOf('}')), true);
    }
    out.push(decl);
  }
  return out;
}

/** A doc comment as Markdown: tags dropped, its ``` fences kept. */
function md(doc: string): string {
  const lines = doc
    .replace(/^\/\*\*\s?/, '')
    .replace(/\s*\*\/$/, '')
    .split('\n')
    .map((l) => l.replace(/^\s*\* ?/, ''));
  const out: string[] = [];
  for (const l of lines) {
    if (/^@(internal|throws|template|param|returns)\b/.test(l.trim())) {
      break;
    }
    out.push(l);
  }
  return out.join('\n').trim();
}

/** The @param tags of a doc: name and description. */
function params(doc: string): [string, string][] {
  const body = doc
    .replace(/^\/\*\*\s?/, '')
    .replace(/\s*\*\/$/, '')
    .split('\n')
    .map((l) => l.replace(/^\s*\* ?/, ''))
    .join('\n');
  return [...body.matchAll(/@param\s+(?:\{[^}]*\}\s+)?([\w.$]+)\s+([\s\S]*?)(?=\n@|$)/g)].map((m) => [
    m[1]!,
    m[2]!.replace(/\s+/g, ' ').trim(),
  ]);
}

function render(d: Decl, level: string): string {
  const parts = [`${level} ${d.kind === 'interface' ? 'interface ' : d.kind === 'type' ? 'type ' : ''}\`${d.name}\``];
  if (d.kind === 'function' || d.kind === 'const' || d.kind === 'type') {
    parts.push(`\`\`\`ts\n${d.head.replace(/^export\s+(declare\s+)?/, '')}\n\`\`\``);
  } else if (d.kind === 'class') {
    const ctor = d.members.find((m) => m.name === 'constructor');
    if (ctor) {
      parts.push(`\`\`\`ts\nnew ${d.name}${ctor.head.replace(/^constructor/, '')}\n\`\`\``);
    }
  }
  const text = md(d.doc);
  if (text) {
    parts.push(text);
  }
  const ctor = d.members.find((m) => m.name === 'constructor');
  const ps = ctor ? params(ctor.doc) : [];
  if (ps.length > 0) {
    parts.push(ps.map(([n, t]) => `- \`${n}\` - ${t}`).join('\n'));
  }
  const fields = d.members.filter((m) => m.kind !== 'function' && m.name !== 'constructor');
  if (fields.length > 0) {
    parts.push(
      fields.map((f) => `- \`${f.head}\`${md(f.doc) ? ` - ${md(f.doc).replace(/\s+/g, ' ')}` : ''}`).join('\n'),
    );
  }
  for (const m of d.members.filter((x) => x.kind === 'function' && x.name !== 'constructor')) {
    parts.push(`#${level} \`${m.head}\`${md(m.doc) ? `\n\n${md(m.doc)}` : ''}`);
  }
  return parts.join('\n\n');
}

function load(file: string): Decl[] {
  return parse(readFileSync(join(ROOT, 'dist', file), 'utf8'));
}

function section(title: string, intro: string, decls: Decl[]): string {
  return [`## ${title}`, intro, ...decls.map((d) => render(d, '###'))].filter(Boolean).join('\n\n');
}

function folded(title: string, decls: Decl[]): string {
  const body = decls.map((d) => render(d, '####')).join('\n\n');
  return `## ${title}\n\n<details>\n<summary>${decls.length} types</summary>\n\n${body}\n\n</details>`;
}

function generate(): string {
  const order = [
    'Client',
    'ClientOptions',
    'AutoBatch',
    'BroadcastRetryOptions',
    'RequestInfo',
    'Batch',
    'Pending',
    'BatchResult',
    'FailedCommand',
    'BroadcastResult',
    'ChannelResult',
    'RawJSON',
    'rawJSON',
    'Request',
    'CallOptions',
    'retryable',
    'exponentialBackoff',
    'wait',
    'BroadcastAttempt',
    'newCommand',
    'Command',
  ];
  const main = [
    'client.d.ts',
    'batch.d.ts',
    'broadcast.d.ts',
    'payload.d.ts',
    'request.d.ts',
    'retry.d.ts',
    'command.d.ts',
  ]
    .flatMap(load)
    .concat(load('errors.d.ts').filter((d) => d.name === 'retryable'));
  main.sort((a, b) => {
    const ia = order.indexOf(a.name);
    const ib = order.indexOf(b.name);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.name.localeCompare(b.name);
  });
  const errors = load('errors.d.ts').filter((d) => d.name !== 'retryable');
  const tree = errors
    .map((e) => {
      const parent = e.head.match(/extends\s+([\w$]+)/)?.[1];
      let depth = 0;
      for (
        let p = parent;
        p && p !== 'Error';
        p = errors.find((x) => x.name === p)?.head.match(/extends\s+([\w$]+)/)?.[1]
      ) {
        depth++;
      }
      return `${'  '.repeat(depth)}- \`${e.name}\``;
    })
    .join('\n');
  const api = load('generated/api.d.ts');
  const generated = api.filter((d) => !['ClientMethods', 'BatchMethods', 'command'].includes(d.name));
  // The generated methods are the client's and a batch's own.
  for (const [base, cls] of [
    ['ClientMethods', 'Client'],
    ['BatchMethods', 'Batch'],
  ]) {
    const methods = api.find((d) => d.name === base);
    const target = main.find((d) => d.name === cls);
    if (methods && target) {
      target.members = [...target.members, ...methods.members].sort((a, b) =>
        a.name === 'constructor' ? -1 : b.name === 'constructor' ? 1 : a.name.localeCompare(b.name),
      );
    }
  }
  const command = api.find((d) => d.name === 'command');
  if (command) {
    // The const's type lists every method: show the doc and an example of one.
    command.head =
      'export declare const command: { publish(request: PublishRequest): Command; /* ...one per API method */ }';
    main.splice(
      main.findIndex((d) => d.name === 'Command'),
      0,
      command,
    );
  }
  const out = [
    '# jscent API reference',
    '<!-- Generated by gen/api_docs.ts from the type declarations: `npm run docs`. Do not edit. -->',
    "The public API of jscent, from its doc comments. The [README](README.md) shows how to use it; the request and result types come from Centrifugo's protos, with their documentation.",
    section('jscent', 'The client, batches, results and helpers.', main),
    section('jscent: errors', `Every error is a \`CentError\`.\n\n${tree}`, errors),
    section(
      'jscent: HTTP handlers',
      'The framework-free core of every handler, with its Fetch and Node.js adapters.',
      load('http.d.ts'),
    ),
    section('jscent/token', '', load('token.d.ts')),
    section('jscent/endpoints', '', load('endpoints.d.ts')),
    section('jscent/sharedpoll', '', load('sharedpoll.d.ts')),
    section('jscent/proxy', '', load('proxy/index.d.ts')),
    folded(
      'jscent: request and result types',
      generated.sort((a, b) => a.name.localeCompare(b.name)),
    ),
    folded(
      'jscent/proxy: request and result types',
      load('generated/proxy.d.ts').sort((a, b) => a.name.localeCompare(b.name)),
    ),
  ];
  return `${out
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}

const path = join(ROOT, 'API.md');
const text = generate();
if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    // Missing: stale.
  }
  if (current !== text) {
    console.error('API.md is stale: run `npm run build && npm run docs`');
    process.exit(1);
  }
} else {
  writeFileSync(path, text);
}
