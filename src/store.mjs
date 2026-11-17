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
// A lock is written with its payload already inside it, so a lock file that
// cannot name its owner is a leftover of a command that was interrupted
// before it could record itself. Such a lock cannot be attributed to a
// process, so its age decides: it is left alone for a short grace period and
// recovered after that. The grace period is short because the window in
// which a lock exists without its payload is the moment between creating the
// file and writing it, which is why the payload is linked into place instead.
export const INCOMPLETE_LOCK_GRACE_MS = 10_000;
async function alive(pid) {
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}
// What a lock file says about its owner: a PID and whether that process is
// still running, and how long the lock has been there.
export async function lockStatus(lock) {
  const data = await readJson(lock, null).catch(() => null);
  const pid = Number(data?.pid);
  const usable = Number.isInteger(pid) && pid > 0;
  const ageMs = await lstat(lock).then(s => Math.max(0, Date.now() - s.mtimeMs)).catch(() => null);
  return { lock, pid: usable ? pid : null, live: usable ? await alive(pid) : null, ageMs, complete: usable };
}
// Whether a lock may be removed, and why. The lock of a live process is never
// removed. A lock whose owner has exited is removed. A lock without a usable
// PID is removed only once it has been incomplete for longer than the grace
// period, or when the caller asks for it explicitly.
export async function lockRemovable(lock, { graceMs = INCOMPLETE_LOCK_GRACE_MS, force = false } = {}) {
  const status = await lockStatus(lock);
  if (status.pid != null) {
    if (status.live) return { remove: false, status, reason: `the lock belongs to the live process ${status.pid}` };
    return { remove: true, status, reason: `the process ${status.pid} that owned the lock has exited` };
  }
  if (status.ageMs == null) return { remove: false, status, reason: 'the lock file cannot be read' };
  if (!force && status.ageMs < graceMs) return { remove: false, status, reason: `the lock carries no PID and is only ${Math.round(status.ageMs / 1000)}s old` };
  return { remove: true, status, reason: force
    ? 'the lock carries no PID and was removed on explicit request'
    : `the lock carries no PID and is older than the ${Math.round(graceMs / 1000)}s grace period` };
}
// A lock is removed only when it is a real file: a symbolic link at the lock
// path is never followed and never removed.
async function removeLock(lock) {
  const info = await lstat(lock).catch(e => { if (e.code !== 'ENOENT') throw e; });
  if (!info || info.isSymbolicLink()) return false;
  await unlink(lock).catch(() => {});
  return true;
}
// The lock is released by path, but only while it still carries our own PID:
// a lock that was taken over in the meantime belongs to somebody else.
async function releaseLock(lock) {
  const data = await readJson(lock, null).catch(() => null);
  if (Number(data?.pid) !== process.pid) return;
  await removeLock(lock);
}
// The lock is created with its payload already inside it. A lock file that
// cannot name its owner can never be told apart from a live one, so the
// payload is written to a temporary file and linked into place. The link
// fails when the lock is already taken, so the exclusion stays atomic.
async function createLock(lock) {
  const temp = `${lock}.${randomUUID()}.tmp`;
  const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + '\n');
    await handle.sync();
  } finally { await handle.close(); }
  try { await link(temp, lock); }
  finally { await unlink(temp).catch(() => {}); }
}
export async function locked(root, id, action) {
  const folder = runPath(root, id), file = join(folder, 'run.json'), lock = join(folder, 'command.lock');
  await guard(root, lock);
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await createLock(lock); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const verdict = await lockRemovable(lock);
      if (attempt === 0 && verdict.remove) { await removeLock(lock); continue; }
      throw new Error(verdict.status.pid == null
        ? `The run lock carries no usable PID (${verdict.reason}); it may be a leftover of an interrupted command. Retry in a few seconds, or inspect it with "nz-job-scout recover-lock --project ${root} --run ${id}".`
        : 'Run is locked by another command; do not run commands concurrently');
    }
  }
  try {
    await guard(root, file);
    const state = await readJson(file);
    if (state.id !== id || state.schema !== 1) throw new Error('Invalid run state');
    try { return await action(state, folder); }
    finally { await put(root, file, state, { replace: true }); }
  } finally { await releaseLock(lock); }
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
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await createLock(lock); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const verdict = await lockRemovable(lock);
      if (attempt === 0 && verdict.remove) { await removeLock(lock); continue; }
      throw new Error(verdict.status.pid == null
        ? `The start lock carries no usable PID (${verdict.reason}); it may be a leftover of an interrupted start. Retry in a few seconds, or inspect it with "nz-job-scout recover-lock --project ${root}".`
        : 'A run is being started by another command; do not run start concurrently');
    }
  }
  try { return await action(); }
  finally { await releaseLock(lock); }
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
