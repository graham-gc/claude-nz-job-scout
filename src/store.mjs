import { constants } from 'node:fs';
import { open, mkdir, readFile, realpath, lstat, rename, link, unlink, readdir } from 'node:fs/promises';
import { resolve, relative, dirname, join, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const hash = (value) => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const runId = () => randomUUID();
// A request id names one user request. Continuation runs of that request carry
// the same id and share its budget; a new user request carries a new id.
export const newRequestId = () => randomUUID();
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
// A lock is only stale when the process that owns it is gone. A live lock is
// never removed, so two concurrent commands still cannot share a run.
export async function staleLock(lock) {
  let info;
  try { info = await readJson(lock); } catch { return false; }
  const pid = Number(info?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return false;
  try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; }
}
export async function locked(root, id, action) {
  const folder = runPath(root, id), file = join(folder, 'run.json'), lock = join(folder, 'command.lock');
  await guard(root, lock);
  let handle;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      handle = await open(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (attempt === 0 && await staleLock(lock)) { await unlink(lock).catch(() => {}); continue; }
      throw new Error('Run is locked by another command; do not run commands concurrently');
    }
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + '\n');
    await handle.sync();
  } catch { /* the lock itself is the mutual exclusion; its payload is advisory */ }
  try {
    await guard(root, file);
    const state = await readJson(file);
    if (state.id !== id || state.schema !== 1) throw new Error('Invalid run state');
    try { return await action(state, folder); }
    finally { await put(root, file, state, { replace: true }); }
  } finally { await handle.close(); await unlink(lock); }
}
// Starting a run is serialized per project. The request id may still be
// undecided when a start begins — two commands that both see "no request yet"
// would each mint one — so the lock is taken on the project, not on an id that
// does not exist yet. Under it the check and the creation happen together, so
// no second run of the same request can slip in between them.
export async function startLock(root, action) {
  const folder = join(root, '.nz-job-scout', 'requests');
  await guard(root, folder);
  await mkdir(folder, { recursive: true });
  const lock = join(folder, 'start.lock');
  await guard(root, lock);
  let handle;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      handle = await open(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (attempt === 0 && await staleLock(lock)) { await unlink(lock).catch(() => {}); continue; }
      throw new Error('A run is being started by another command; do not run start concurrently');
    }
  }
  try { await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + '\n'); await handle.sync(); }
  catch { /* the lock itself is the mutual exclusion; its payload is advisory */ }
  finally { await handle.close(); }
  try { return await action(); }
  finally { await unlink(lock).catch(() => {}); }
}
// Every run this project has opened, newest last. The request ledger is read
// from these files, so the ceiling of a request survives a restart.
export async function runStates(root) {
  const folder = join(root, '.nz-job-scout', 'runs');
  const entries = await readdir(folder, { withFileTypes: true }).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
  const states = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const state = await readJson(join(folder, entry.name, 'run.json'), null).catch(() => null);
    if (state) states.push(state);
  }
  return states.sort((a, b) => String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? '')));
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
