import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const compiled = resolve(packageRoot, 'dist/src/runtime/scout.mjs');
const bundled = resolve(packageRoot, 'runtime/scout.mjs');
const compiledProvider = resolve(packageRoot, 'dist/src/providers/provider.js');
const bundledProvider = resolve(packageRoot, 'runtime/provider.mjs');

await mkdir(dirname(bundled), { recursive: true });
await copyFile(compiled, bundled);
await copyFile(compiledProvider, bundledProvider);
console.log(`Synced generated runtime: ${bundled}`);
console.log(`Synced generated ATS provider runtime: ${bundledProvider}`);
