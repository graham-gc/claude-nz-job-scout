import { constants } from 'node:fs';
import { open, mkdir, readFile, realpath, lstat, rename, link, unlink, readdir } from 'node:fs/promises';
import { resolve, relative, dirname, join, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const hash = (value) => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const runId = () => randomUUID();
export function validRun(id) { if (!/^[a-f0-9-]{36}$/.test(id ?? '')) throw new Error('Invalid run ID; use the ID returned by start'); return id; }
export async function rootAt(path = process.cwd()) { return realpath(resolve(path)); }

export async function guard(root, path) {
  const target = resolve(path), rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) throw new Error('Write outside project refused');
  let current = root;
  for (const segment of rel.split(sep)) {
    current = join(current, segment);
    const info = await lstat(current).catch(e => { if (e.code !== 'ENOENT') throw e; });
    if (info?.isSymbolicLink()) throw new Error(`Symbolic-link write refused: ${current}`);
    if (info && current !== target && !info.isDirectory()) throw new Error('A write parent is not a directory');
  }
  return target;
}

export async function put(root, path, value, { replace = false } = {}) {
  const target = await guard(root, path);
  await mkdir(dirname(target), { recursive: true });
  await guard(root, target);
  const existing = await lstat(target).catch(e => { if (e.code !== 'ENOENT') throw e; });
  if (existing && (!replace || !existing.isFile())) throw new Error(`Refusing to overwrite ${target}`);
  const temp = `${target}.${randomUUID()}.tmp`;
  const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
    await handle.sync();
  } finally { await handle.close(); }
  try {
    await guard(root, target);
    if (replace) await rename(temp, target);
    else { await link(temp, target); await unlink(temp); } // Atomic no-clobber, even across simultaneous starts/reports.
  }
  catch (e) { await unlink(temp).catch(() => {}); throw e; }
}

export async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT' && fallback !== undefined) return fallback; throw e; }
}
export function runPath(root, id) { return join(root, '.nz-job-scout', 'runs', validRun(id)); }
export async function locked(root, id, action) {
  const folder = runPath(root, id), file = join(folder, 'run.json'), lock = join(folder, 'command.lock');
  await guard(root, lock);
  const handle = await open(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    .catch(e => { if (e.code === 'EEXIST') throw new Error('Run is locked by another command; do not run commands concurrently'); throw e; });
  try {
    await guard(root, file);
    const state = await readJson(file);
    if (state.id !== id || state.schema !== 1) throw new Error('Invalid run state');
    try { return await action(state, folder); }
    finally { await put(root, file, state, { replace: true }); }
  } finally { await handle.close(); await unlink(lock); }
}
export async function reports(root) {
  const folder = join(root, 'output');
  await guard(root, join(folder, 'history-probe'));
  const entries = await readdir(folder, { withFileTypes: true }).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
  const result = [];
  for (const entry of entries) {
    if (entry.isFile() && /^nz-jobs-\d{4}-\d{2}-\d{2}(?:-[a-f0-9]{8})?\.json$/.test(entry.name)) {
      const data = await readJson(join(folder, entry.name));
      if (data.format === 'nz-job-scout-report-v1') result.push(data);
    }
  }
  return result;
}
