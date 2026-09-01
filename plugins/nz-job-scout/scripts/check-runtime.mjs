import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const compiled = await readFile(resolve(packageRoot, 'dist/src/runtime/scout.mjs'), 'utf8');
const bundled = await readFile(resolve(packageRoot, 'runtime/scout.mjs'), 'utf8');

if (compiled !== bundled) {
  console.error('Bundled runtime is stale. Run npm run build and commit runtime/scout.mjs.');
  process.exitCode = 1;
} else {
  console.log('Bundled runtime matches the canonical TypeScript source.');
}
