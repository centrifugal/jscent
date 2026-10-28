// Copies api.proto and proxy.proto from a released Centrifugo tag, then
// regenerates the code and API.md:
//
//     CENTRIFUGO_REF=v6.10.2 npm run sync-proto
//
// There is no default ref, so that nothing is synced from an unreleased
// branch by accident.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ref = process.env.CENTRIFUGO_REF ?? '';
if (ref === '') {
  console.error('set CENTRIFUGO_REF to a Centrifugo tag, e.g. CENTRIFUGO_REF=v6.10.2 npm run sync-proto');
  process.exit(1);
}
const base = `https://raw.githubusercontent.com/centrifugal/centrifugo/${ref}/internal`;
const files: [string, string, string][] = [
  ['api.proto', `${base}/apiproto/api.proto`, 'service CentrifugoApi'],
  ['proxy.proto', `${base}/proxyproto/proxy.proto`, 'service CentrifugoProxy'],
];
const got: [string, string][] = [];
for (const [name, url, marker] of files) {
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`no ${name} at Centrifugo ${ref}`);
    process.exit(1);
  }
  const text = await res.text();
  if (!new RegExp(`^${marker}\\b`, 'm').test(text)) {
    console.error(`not Centrifugo's ${name}`);
    process.exit(1);
  }
  got.push([name, text]);
}
for (const [name, text] of got) {
  writeFileSync(join(ROOT, 'proto', name), text);
}
execFileSync('npm', ['run', 'generate'], { cwd: ROOT, stdio: 'inherit' });
execFileSync('npm', ['run', 'docs'], { cwd: ROOT, stdio: 'inherit' });
