import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const compiled = resolve(packageRoot, 'dist/src/runtime/scout.mjs');
const bundled = resolve(packageRoot, 'runtime/scout.mjs');

await mkdir(dirname(bundled), { recursive: true });
await copyFile(compiled, bundled);
console.log(`Synced generated runtime: ${bundled}`);
