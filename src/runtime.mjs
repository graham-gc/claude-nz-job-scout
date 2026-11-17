// The identity of the runtime that a run is bound to.
//
// A run reads pages, parses facts, judges hard conditions and writes the
// report. If two different implementations handle the same request, one run's
// evidence is read by another run's parser, and the conclusion no longer
// follows from the evidence. A path in a document does not prevent that: the
// path can be a project copy, a cache copy or an explicit mixture.
//
// So the runtime identifies itself by the content of the code that decides:
// the reader, the parser, the classifier and the report writer. The identity
// is pinned when a run starts, carried by the request, and checked before a
// run is resumed.
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// The files that decide an outcome. Documentation and criteria files are not
// part of it: a release that only rewrites the manual stays compatible.
const DECIDING_FILES = [
  'bin/nz-job-scout.mjs',
  'src/addr.mjs', 'src/criteria.mjs', 'src/dates.mjs', 'src/engine.mjs',
  'src/evidence.mjs', 'src/html.mjs', 'src/net.mjs', 'src/places.mjs',
  'src/report.mjs', 'src/robots.mjs', 'src/runtime.mjs', 'src/site.mjs',
  'src/sources.mjs', 'src/store.mjs'
];

export async function implementationIdentity(root = packageRoot) {
  const hash = createHash('sha256');
  const present = [];
  for (const file of DECIDING_FILES) {
    let content;
    try { content = await readFile(join(root, file)); } catch { continue; }
    hash.update(file).update('\0').update(content).update('\0');
    present.push(file);
  }
  // A file that was added to the source directory and is not listed above is
  // still part of the runtime, so the listing is checked against the disk.
  let extra = [];
  try {
    const files = (await readdir(join(root, 'src'))).filter(f => f.endsWith('.mjs')).sort();
    extra = files.filter(f => !present.includes(`src/${f}`));
  } catch { /* no source directory: the identity is what was found */ }
  if (extra.length) {
    hash.update(extra.join('\0'));
    for (const file of extra) {
      try { hash.update(await readFile(join(root, 'src', file))); } catch { /* unreadable: its name still counts */ }
    }
  }
  let version = null;
  try { version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version ?? null; } catch { /* no manifest */ }
  return { version, hash: hash.digest('hex').slice(0, 16), files: present.length + extra.length, root };
}

// Two identities are compatible when the deciding code is the same code.
export function sameImplementation(a, b) {
  if (!a?.hash || !b?.hash) return false;
  return a.hash === b.hash;
}

export function describeImplementation(identity) {
  if (!identity?.hash) return 'an unidentified runtime';
  return identity.version ? `runtime ${identity.version} (${identity.hash})` : `runtime ${identity.hash}`;
}

// The message an operator sees when a run is resumed by a runtime that is not
// the one that created it.
export function incompatibilityMessage(stored, running, { allowChange = false } = {}) {
  const head = `This run was created by ${describeImplementation(stored)} and this command runs ${describeImplementation(running)}.`;
  if (allowChange) {
    return `${head} The change was accepted explicitly and is disclosed in the report: evidence collected under the earlier runtime was not re-read.`;
  }
  return `${head} Resuming it would mix two parsers, so it is refused. Use the matching runtime to finish this run, or start a new request with start --new-request (a new request has its own budget). If you are certain the change is acceptable, repeat the command with --allow-implementation-change; the change is then recorded in the run and disclosed in the report.`;
}

// A run that was created before the runtime was pinned does not name the
// implementation that read its pages. An unknown runtime is not a compatible
// one: the pages of that run were read by code this command cannot identify.
export function unpinnedRunMessage(running) {
  return `This run was created before the runtime was pinned, so the implementation that read its pages is unknown. Resuming it with ${describeImplementation(running)} would mix an unknown runtime with this one, so it is refused. Finish the run with the runtime that created it, or close it with end --run RUN_ID and start a new request with start --new-request (a new request has its own budget). If you are certain the change is acceptable, repeat the command with --allow-implementation-change; the change is then recorded in the run and disclosed in the report.`;
}

// The same, for the earlier runs of a request that are continued.
export function unpinnedRequestMessage(running) {
  return `The earlier runs of this request were created before the runtime was pinned, so the implementation that read their pages is unknown. Continuing the request with ${describeImplementation(running)} would mix an unknown runtime with this one, so it is refused. Close the abandoned run with end --run RUN_ID, or start a new request with start --new-request (a new request has its own budget). If you are certain the change is acceptable, repeat the command with --allow-implementation-change; the change is then recorded in the run and disclosed in the report.`;
}
