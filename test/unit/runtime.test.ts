import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('uses web standards only: no node: imports in src/', () => {
  const root = join(import.meta.dirname, '../../src');
  const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'));
  expect(files.length).toBeGreaterThan(10);
  for (const f of files) {
    expect(readFileSync(join(root, f), 'utf8'), f).not.toMatch(/from ['"]node:|require\(['"]node:/);
  }
});
