import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const compiled = await readFile(resolve(packageRoot, 'dist/src/runtime/scout.mjs'), 'utf8');
const bundled = await readFile(resolve(packageRoot, 'runtime/scout.mjs'), 'utf8');
const compiledProvider = await readFile(resolve(packageRoot, 'dist/src/providers/provider.js'), 'utf8');
const bundledProvider = await readFile(resolve(packageRoot, 'runtime/provider.mjs'), 'utf8');

const compiledIdentity = await readFile(resolve(packageRoot, 'dist/src/runtime/identity.mjs'), 'utf8');
const bundledIdentity = await readFile(resolve(packageRoot, 'runtime/identity.mjs'), 'utf8');
if (compiled !== bundled || compiledProvider !== bundledProvider || compiledIdentity !== bundledIdentity) {
  console.error('Bundled runtime is stale. Run npm run build and include the generated runtime files.');
  process.exitCode = 1;
} else {
  console.log('Bundled runtime matches the canonical TypeScript source.');
}
