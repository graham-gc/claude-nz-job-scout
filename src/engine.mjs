import { readFile, lstat, unlink } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { load } from './html.mjs';
import { hash, put, rootAt, runId, runPath, locked, startLock, runStates, newRequestId, validRun, lockRemovable } from './store.mjs';
import { Reader, charge, publicUrl, countItems, countDetail } from './net.mjs';
import { criteria, contextHash, checksWithJudgment, classify, DISQUALIFIER_KINDS, hardChecks, isChannel } from './criteria.mjs';
import { newRecord, canonical, canonicalLocal, key, sameIdentity, formProof, idKeys, textOf, clean, fieldIsEmployerPosting, SEMANTICS_WEIGHT, publicationOrderKey, CLOSED_NOTICE, applyPageClaims, quoteCorpus } from './evidence.mjs';
import { SOURCES, sourcesFor, parseListing, inventoryComplete, resolveLead, readDetail, recognised, discoveryDisclosure } from './sources.mjs';
import { siteKey } from './site.mjs';
import { implementationIdentity, sameImplementation, incompatibilityMessage, unpinnedRunMessage, unpinnedRequestMessage, describeImplementation } from './runtime.mjs';

// The ceiling belongs to the request, not to a run. Opening a new run does not
// reset anything: the remaining budget of the request travels with it, and a
// request that has already spent its ceiling cannot buy more by restarting.
// The request is named by an id the caller carries, so "the same resume and
// the same criteria" is never mistaken for "the same user request": the
// continuation runs of one request share its budget, and a request the user
// starts afresh carries its own id and its own budget.
export const MAX_RUNS_PER_REQUEST = 3;

const STAGES = ['discovery', 'detail', 'application'];
const STAGE_LABEL = { discovery: 'discovery', detail: 'detail', application: 'application' };
const GROUPS = ['boards', 'linkedin', 'search'];

export function zeroCounters() {
  const groups = () => ({ boards: 0, linkedin: 0, search: 0 });
  return { used: { discovery: 0, detail: 0, application: 0 }, groups: groups(),
    stageGroups: { discovery: groups(), detail: groups(), application: groups() },
    robotsUsed: 0, stageRobots: { discovery: groups(), detail: groups(), application: groups() }, sourceUsed: {} };
}
export function budgetDelta(current, baseline) {
  const delta = { used: {}, groups: {}, stageGroups: {}, robotsUsed: 0, stageRobots: {}, sourceUsed: {} };
  // The group counters describe the whole request, not one stage: they are
  // read once, outside the stage loop.
  for (const group of GROUPS) delta.groups[group] = Math.max(0, (current?.groups?.[group] ?? 0) - (baseline?.groups?.[group] ?? 0));
  for (const stage of STAGES) {
    delta.used[stage] = Math.max(0, (current?.used?.[stage] ?? 0) - (baseline?.used?.[stage] ?? 0));
    delta.stageGroups[stage] = {}; delta.stageRobots[stage] = {};
    for (const group of GROUPS) {
      delta.stageGroups[stage][group] = Math.max(0, (current?.stageGroups?.[stage]?.[group] ?? 0) - (baseline?.stageGroups?.[stage]?.[group] ?? 0));
      delta.stageRobots[stage][group] = Math.max(0, (current?.stageRobots?.[stage]?.[group] ?? 0) - (baseline?.stageRobots?.[stage]?.[group] ?? 0));
    }
  }
  delta.robotsUsed = Math.max(0, (current?.robotsUsed ?? 0) - (baseline?.robotsUsed ?? 0));
  for (const [source, used] of Object.entries(current?.sourceUsed ?? {})) {
    const base = baseline?.sourceUsed?.[source] ?? { requests: 0, items: 0, details: 0, stages: {} };
    const entry = { requests: Math.max(0, (used.requests ?? 0) - (base.requests ?? 0)),
      items: Math.max(0, (used.items ?? 0) - (base.items ?? 0)),
      details: Math.max(0, (used.details ?? 0) - (base.details ?? 0)), stages: {} };
    for (const [stage, s] of Object.entries(used.stages ?? {})) {
      entry.stages[stage] = { requests: Math.max(0, (s.requests ?? 0) - (base.stages?.[stage]?.requests ?? 0)) };
    }
    delta.sourceUsed[source] = entry;
  }
  return delta;
}
// What a run spent on its own, apart from what the request had already spent
// before it started. The delta is derived from the run's own counters rather
// than from a stored copy of them, so a command that failed after billed work
// still reports the spend it made, and a continuation inherits that spend.
export function ownSpend(state) {
  return budgetDelta(state?.budget ?? {}, state?.request?.baselineBudget ?? zeroCounters());
}
export function addBudget(target, delta) {
  // The group counters are totals, not per-stage sums: adding them inside the
  // stage loop would count the same discovery once for every stage.
  for (const group of GROUPS) target.groups[group] = (target.groups[group] ?? 0) + (delta.groups?.[group] ?? 0);
  for (const stage of STAGES) {
    target.used[stage] = (target.used[stage] ?? 0) + (delta.used?.[stage] ?? 0);
    for (const group of GROUPS) {
      target.stageGroups[stage][group] = (target.stageGroups[stage][group] ?? 0) + (delta.stageGroups?.[stage]?.[group] ?? 0);
      target.stageRobots[stage][group] = (target.stageRobots[stage][group] ?? 0) + (delta.stageRobots?.[stage]?.[group] ?? 0);
    }
  }
  target.robotsUsed = (target.robotsUsed ?? 0) + (delta.robotsUsed ?? 0);
  for (const [source, entry] of Object.entries(delta.sourceUsed ?? {})) {
    const used = target.sourceUsed[source] ?? { requests: 0, items: 0, details: 0, stages: {} };
    const stages = { ...(used.stages ?? {}) };
    for (const [stage, s] of Object.entries(entry.stages ?? {})) {
      stages[stage] = { requests: (stages[stage]?.requests ?? 0) + (s.requests ?? 0) };
    }
    target.sourceUsed[source] = { ...used, requests: used.requests + entry.requests, items: used.items + entry.items, details: used.details + entry.details, stages };
  }
  return target;
}

// A run is finished when it produced its report, when it was closed by hand,
// or when its own wall-clock cap has passed. A finished run takes no more
// calls, so it cannot spend behind the back of the next run of the request.
export function runFinished(state, now = Date.now()) {
  if (state?.reported) return true;
  if (state?.request?.finishedAt) return true;
  const deadline = state?.wallDeadline ?? state?.deadline;
  return typeof deadline === 'number' && now >= deadline;
}
// Closing a run by hand: an abandoned run that will never report is ended, so
// the request can continue.
export function endRun(state, now = new Date().toISOString()) {
  state.request = state.request ?? {};
  state.request.finishedAt = now;
  return { run: state.id, ended: true, finishedAt: now };
}

export async function start(project, input, resumePath, options = {}) {
  const root = await rootAt(project), config = criteria(input), path = resolve(resumePath);
  // The runtime that reads the pages of this run identifies itself, and the
  // request keeps that identity for its whole life: a continuation run of the
  // same request has to read pages under the same implementation, or the
  // request's evidence and its conclusion come from two different parsers.
  const implementation = await implementationIdentity();
  let resume;
  if (extname(path).toLowerCase() === '.pdf') resume = (await promisify(execFile)('pdftotext', ['-layout', path, '-'], { timeout: 10000, maxBuffer: 2_000_000 })).stdout;
  else if (['.txt', '.md'].includes(extname(path).toLowerCase())) resume = await readFile(path, 'utf8');
  else throw new Error('Resume input supports PDF (pdftotext required), TXT or Markdown');
  if (resume.trim().length < 100) throw new Error('Resume text missing/too short; supply a readable resume, not invented profile data');
  const sources = sourcesFor(config);
  const context = contextHash(config, hash(resume));
  // The coverage the discovery cap could not cover is disclosed in the run's
  // criteria. It is added after the context is hashed: the context names the
  // criteria the user asked for, and it must stay the same across the runs of
  // one request.
  const coverage = discoveryDisclosure(config);
  if (coverage) config.disclosures.push(coverage);
  const declared = typeof input.requestId === 'string' ? input.requestId.trim() : '';
  // A request is named, not inferred. The caller carries the id: the
  // continuation runs of one user request share it and share its budget, and a
  // request the user starts afresh carries a new id and its own budget. The
  // same resume with the same criteria is not what makes two requests one.
  // A request may only have one live run, and two commands may not start a
  // run of the same request at the same moment. Both are decided under the
  // start lock, against the states as they are on disk at that moment, so a
  // second run can neither slip in between the check and the creation nor
  // live beside the first one.
  return startLock(root, async () => {
    const prior = await runStates(root);
    const known = [...new Set(prior.map(s => s.request?.requestId).filter(Boolean))];
    const current = known.length ? known[known.length - 1] : null;
    let requestId, requestKind;
    if (options.newRequest) { requestId = newRequestId(); requestKind = 'new'; }
    else if (declared && known.includes(declared)) { requestId = declared; requestKind = 'continued'; }
    else if (declared) { requestId = declared; requestKind = 'new'; }
    else if (current) { requestId = current; requestKind = 'continued'; }
    else { requestId = newRequestId(); requestKind = 'new'; }
    const id = runId(), now = new Date().toISOString(), folder = runPath(root, id);
    const requestRuns = prior.filter(s => s.request?.requestId === requestId);
    const live = requestRuns.filter(s => !runFinished(s));
    if (live.length) {
      throw new Error(`Request ${requestId} already has ${live.length} active run(s): ${live.map(r => r.id).join(', ')}. Only one run per request may be active. Finish it by producing a report, or close an abandoned run with end --run RUN_ID before continuing. Use start --new-request only for a new scan explicitly requested by the user.`);
    }
    // Everything this request has already spent, and every run it has already
    // opened, is counted before a new run is allowed to exist.
    const spent = zeroCounters();
    for (const s of requestRuns) addBudget(spent, ownSpend(s));
    // Runs from before requests were named belong to no request: their spend is
    // shown in the ledger, but it is not carried into any request.
    const legacyRuns = prior.filter(s => !s.request?.requestId);
    const legacy = zeroCounters();
    for (const s of legacyRuns) addBudget(legacy, ownSpend(s));
    const limits = { discovery: 20, detail: 20, application: 10 };
    const usedUp = STAGES.filter(stage => (spent.used[stage] ?? 0) >= limits[stage]);
    if (requestRuns.length >= MAX_RUNS_PER_REQUEST || usedUp.length) {
      const reason = requestRuns.length >= MAX_RUNS_PER_REQUEST
        ? `Request ${requestId} has opened ${requestRuns.length} runs; maximum ${MAX_RUNS_PER_REQUEST} runs`
        : `Request ${requestId}: ${usedUp.map(stage => STAGE_LABEL[stage] ?? stage).join(', ')} budget exhausted (${usedUp.map(stage => `${spent.used[stage]}/${limits[stage]}`).join(', ')})`;
      throw new Error(`${reason}. Continuation runs share the same budget; opening another run does not reset it. Use start --new-request only for a new scan explicitly requested by the user; its budget is independent of previous requests.`);
    }
    // The request carries the identity of the runtime that opened it. A
    // continuation run under a different implementation is refused unless the
    // change is accepted explicitly; either way the change is recorded. A run
    // that predates the pinning has an unknown runtime, which is not the same
    // as a compatible one.
    const pinned = requestRuns.find(s => s.request?.implementation)?.request?.implementation ?? null;
    const unpinned = requestRuns.some(s => !s.request?.implementation);
    const implementationChanges = [...(requestRuns.find(s => s.request?.implementationChanges)?.request?.implementationChanges ?? [])];
    if (unpinned || (pinned && !sameImplementation(pinned, implementation))) {
      const refused = unpinned && !pinned
        ? unpinnedRequestMessage(implementation)
        : incompatibilityMessage(pinned, implementation);
      if (!options.allowImplementationChange) throw new Error(refused);
      implementationChanges.push({ from: pinned ?? { version: null, hash: null, unknown: true }, to: implementation, at: new Date().toISOString() });
    }
    const state = {
      schema: 1, id, startedAt: now,
      // The runtime that this run's evidence was read under.
      implementation,
      // The request window is measured in network time, so model thinking cannot consume it.
      // The wall-clock deadline is only a hard safety cap for the whole run.
      deadline: Date.now() + 60 * 60000, networkBudgetMs: 15 * 60000, networkSpentMs: 0, wallDeadline: Date.now() + 60 * 60000,
      config, resumeHash: hash(resume), context, resumePath: path,
      // The request ledger: what this request has spent so far, what this run
      // starts from, and which run of the request this is.
      request: { requestId, kind: requestKind, context, maxRuns: MAX_RUNS_PER_REQUEST,
        runIndex: requestRuns.length + 1,
        startedAt: requestRuns.length ? requestRuns[0].startedAt : now,
        implementation: pinned ?? implementation,
        implementationChanges,
        baselineBudget: JSON.parse(JSON.stringify(spent)), own: zeroCounters(), finishedAt: null },
      budget: {
        limits,
        used: { discovery: 0, detail: 0, application: 0 },
        groupLimits: { boards: 12, linkedin: 3, search: 5 },
        groups: { boards: 0, linkedin: 0, search: 0 },
        // Per-stage ledgers: the report prints the numbers of the stage it
        // describes, so a detail read can never be shown as discovery spend.
        stageGroups: { discovery: { boards: 0, linkedin: 0, search: 0 }, detail: { boards: 0, linkedin: 0, search: 0 }, application: { boards: 0, linkedin: 0, search: 0 } },
        // robots.txt reads are counted inside their source group and inside the
        // stage and per-source budgets; they have no ceiling of their own.
        robotsUsed: 0,
        stageRobots: { discovery: { boards: 0, linkedin: 0, search: 0 }, detail: { boards: 0, linkedin: 0, search: 0 }, application: { boards: 0, linkedin: 0, search: 0 } },
        sourceLimits: { discoveryRequests: 4, detailRequests: 8, applicationRequests: 4, items: 200, details: 6 },
        sourceUsed: {}
      },
      attempts: [], sources: sources.map(s => ({ id: s.id, url: s.url, name: s.name, status: 'not-started', reviewed: 0 })),
      records: [], cache: {}, robots: {}, blockedSources: {}, tickets: [], associations: [], warnings: []
    };
    // The budget of this run starts from what the request has already spent.
    addBudget(state.budget, spent);
    state.request.baselineBudget = JSON.parse(JSON.stringify(spent));
    await put(root, join(folder, 'resume.txt'), resume);
    await put(root, join(folder, 'run.json'), state);
    return { run: id, root, context: state.context, requestId, resumeText: join(folder, 'resume.txt'), limits: state.budget.limits,
      request: { requestId, kind: requestKind, runIndex: state.request.runIndex, maxRuns: state.request.maxRuns,
        startedAt: state.request.startedAt,
        spentBeforeThisRun: { discovery: spent.used.discovery, detail: spent.used.detail, application: spent.used.application },
        legacyRuns: legacyRuns.length,
        legacySpend: { discovery: legacy.used.discovery, detail: legacy.used.detail, application: legacy.used.application } },
      deadline: new Date(state.deadline).toISOString() };
  });
}

// The request ledger of a project: every request that was opened, how many
// runs it holds and what it spent. Runs from before requests were named are
// listed apart, because their spend belongs to no request.
export function requestLedger(states) {
  const requests = new Map();
  let legacy = { runs: 0, spent: zeroCounters() };
  for (const s of states ?? []) {
    const id = s.request?.requestId;
    if (!id) {
      legacy.runs++;
      addBudget(legacy.spent, budgetDelta(s.budget ?? {}, zeroCounters()));
      continue;
    }
    const entry = requests.get(id) ?? { requestId: id, runs: 0, spent: zeroCounters(), startedAt: s.startedAt ?? null };
    entry.runs++;
    entry.startedAt = entry.startedAt && entry.startedAt <= s.startedAt ? entry.startedAt : (s.startedAt ?? entry.startedAt);
    addBudget(entry.spent, ownSpend(s));
    requests.set(id, entry);
  }
  return { requests: [...requests.values()], legacy };
}
// Compact, read-only inspection instead of shell loops over private run files.
// Reuse requestLedger so inherited budgets are not counted a second time.
export async function listRuns(project, { offset = 0, limit = 20, now = Date.now() } = {}) {
  if (!Number.isInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer from 1 to 100');
  const root = await rootAt(project), states = await runStates(root);
  const page = [...states].reverse().slice(offset, offset + limit);
  const ids = new Set(page.map(s => s.request?.requestId).filter(Boolean));
  const ledger = requestLedger(states);
  const totals = value => Object.fromEntries(STAGES.map(stage => [stage, value?.[stage] ?? 0]));
  const groups = value => Object.fromEntries(GROUPS.map(group => [group, value?.[group] ?? 0]));
  return {
    project: root, total: states.length, offset, limit,
    nextOffset: offset + page.length < states.length ? offset + page.length : null,
    runs: page.map(s => ({
      run: s.id, requestId: s.request?.requestId ?? null,
      kind: s.request?.kind ?? 'legacy', runIndex: s.request?.runIndex ?? null,
      startedAt: s.startedAt ?? null, reported: Boolean(s.reported),
      finished: runFinished(s, now),
      status: s.reported ? 'reported' : s.request?.finishedAt ? 'ended' : runFinished(s, now) ? 'expired' : 'active',
      used: totals(s.budget?.used), groups: groups(s.budget?.groups),
      ownUsed: totals(ownSpend(s).used)
    })),
    requests: ledger.requests.filter(r => ids.has(r.requestId)).map(r => ({
      requestId: r.requestId, runs: r.runs, startedAt: r.startedAt,
      used: totals(r.spent.used), groups: groups(r.spent.groups)
    })),
    legacy: { runs: ledger.legacy.runs, used: totals(ledger.legacy.spent.used) },
    note: 'Read-only snapshot of readable saved runs, newest first. used/groups are cumulative request snapshots; ownUsed is per-run spend. Request totals include all runs of each displayed request. No locks, evidence, reports or budgets are changed.'
  };
}

const GENERIC_ROLE_WORDS = new Set(['engineer', 'engineering', 'development', 'developer', 'internship', 'graduate', 'senior', 'junior', 'intern']);
const TITLE_HINTS = /software|\bQA\b|SDET|test|backend|back.end|automation|platform|developer|programmer|devops/i;
const dutyKey = value => key(value).replace(/\btest(?:s|ing)\b/g, 'test');

function dutyQueries(roleFamilies) {
  // Use an exact role phrase or multiple specific terms from the same family.
  return roleFamilies.flatMap(family => family.split('/')).map(family => {
    const phrase = dutyKey(family);
    const words = phrase.split(' ').filter(word =>
      (word.length > 2 || word === 'qa') && !GENERIC_ROLE_WORDS.has(word) && !/^(and|for|the|with)$/.test(word));
    return { phrase, words: [...new Set(words)] };
  }).filter(query => query.words.length > 0);
}

function dutiesMatch(record, queries) {
  if (!record.fields.duties?.value || !queries.length) return false;
  const text = dutyKey(record.fields.duties.value);
  const words = new Set(text.split(' '));
  return queries.some(query => ` ${text} `.includes(` ${query.phrase} `)
    || (query.words.length >= 2 && query.words.every(word => words.has(word))));
}

// ---------------------------------------------------------------------------
// Merging: fields and evidence are preserved, never wholesale replaced.
// ---------------------------------------------------------------------------
// A validity window (a JSON-LD validThrough) is weaker evidence than a
// deadline the page actually calls a deadline.
const READ_RANK = { read: 4, 'closed-stated': 3, partial: 2, 'not-read': 1, unreadable: 0 };
const fieldWeight = f => SEMANTICS_WEIGHT[f?.semantics] ?? 2;

// Every reading a field carries, with the evidence that carried it.
function fieldClaims(field) {
  const list = [];
  if (field?.value != null) list.push({ value: field.value, semantics: field.semantics, source: field.source, quote: field.quote, origin: field.origin });
  for (const alt of field?.ambiguity ?? []) if (alt?.value != null) list.push({ value: alt.value, semantics: alt.semantics, source: alt.source, quote: alt.quote, origin: alt.origin });
  return list;
}
// The standing of a reading: what kind of evidence it is, and whether it
// speaks for the employer's own posting or only for the page it was read on.
const claimRank = c => [fieldWeight(c), fieldIsEmployerPosting(c) ? 1 : 0];
// Two publication claims of the same kind are ordered by the day they name,
// not by how their text sorts: the earlier one is the first appearance, and
// which one governs must not depend on the order the pages were read in.
const PUBLICATION_SEMANTICS = new Set(['first-published', 'advertised-date']);
const publicationOrder = (a, b) => {
  if (!PUBLICATION_SEMANTICS.has(a.semantics) || !PUBLICATION_SEMANTICS.has(b.semantics)) return 0;
  const ka = publicationOrderKey(a.value), kb = publicationOrderKey(b.value);
  if (!ka || !kb) return 0;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
};
// A stronger reading wins. Equal readings are ordered by their content, not
// by the order the pages were read in, so a merge reads the same either way.
const claimOrder = (a, b) => (claimRank(b)[0] - claimRank(a)[0]) || (claimRank(b)[1] - claimRank(a)[1])
  || publicationOrder(a, b)
  || String(a.value).localeCompare(String(b.value)) || String(a.source?.url ?? '').localeCompare(String(b.source?.url ?? ''));

function mergeField(old, incoming, name) {
  const a = old.fields[name], b = incoming.fields[name];
  if (!b || b.value == null) return null;
  if (!a || a.value == null) { old.fields[name] = b; return null; }
  const seen = new Set();
  const claims = [];
  for (const c of [...fieldClaims(a), ...fieldClaims(b)]) {
    const k = `${JSON.stringify(c.value)}|${c.semantics ?? ''}|${c.source?.url ?? ''}`;
    if (seen.has(k)) continue;
    seen.add(k);
    claims.push(c);
  }
  if (claims.length === 1) return null;
  const sorted = [...claims].sort(claimOrder);
  const governing = sorted[0];
  const rest = sorted.slice(1);
  const values = [...new Set(sorted.map(c => JSON.stringify(c.value)))];
  // The readings that disagree are kept beside the one that governs: nothing
  // is dropped, and the check can see that the sources disagree.
  old.fields[name] = { value: governing.value, source: governing.source, quote: governing.quote,
    ...(governing.semantics ? { semantics: governing.semantics } : {}),
    ...(governing.origin ? { origin: governing.origin } : {}),
    ...(rest.length ? { ambiguity: rest } : {}) };
  if (values.length === 1) return null;
  const other = rest.find(c => JSON.stringify(c.value) !== JSON.stringify(governing.value)) ?? rest[0];
  return { field: name, kept: governing.value, discarded: other.value,
    keptSource: governing.source?.url ?? null, discardedSource: other.source?.url ?? null,
    readings: sorted.map(c => c.value) };
}
function mergeClosure(old, incoming) {
  const list = old.closures ?? (old.closures = []);
  const push = c => { if (c && !list.some(x => x.scope === c.scope && x.observedAt === c.observedAt && x.quote === c.quote)) list.push(c); };
  if (old.closure) push(old.closure);
  push(incoming.closure);
  list.sort((x, y) => String(x.observedAt ?? '').localeCompare(String(y.observedAt ?? '')));
  // A later authoritative read of the same advertisement supersedes an older closure,
  // but the closure evidence itself is kept, with the read that superseded it.
  if (old.closure && incoming.readState === 'read' && incoming.authority === 'registered-official'
      && incoming.observedHtml?.observedAt && old.closure.observedAt
      && incoming.observedHtml.observedAt > old.closure.observedAt) {
    const superseded = list.find(c => c === old.closure);
    if (superseded) superseded.supersededBy = { observedAt: incoming.observedHtml.observedAt, url: incoming.observedHtml.url };
  }
  // Only closure evidence that no later authoritative read has superseded
  // decides whether the vacancy is closed.
  const live = list.filter(c => !c.supersededBy);
  old.closure = live.length ? live[live.length - 1] : null;
  old.closures = list;
}
// The posting's body is a document, not a claim about one fact: the primary
// page and an inventory's summary are two texts of one posting. Both are
// kept — the primary document governs, whichever order they arrive in — and
// they are not reported as a contradiction about one field.
function mergeBodies(old, incoming) {
  const oldFact = old.fields?.duties, newFact = incoming.fields?.duties;
  const all = [];
  const add = (value, kind, source, quote) => {
    if (value == null || value === '') return;
    if (all.some(b => b.value === value)) return;
    all.push({ value, kind: kind ?? 'other', source, quote });
  };
  for (const body of [...(old.bodies ?? []), ...(incoming.bodies ?? [])]) add(body.value, body.kind, body.source, body.quote);
  add(oldFact?.value, oldFact?.bodyKind, oldFact?.source, oldFact?.quote);
  add(newFact?.value, newFact?.bodyKind, newFact?.source, newFact?.quote);
  if (!all.length) return;
  const rank = body => (body.kind === 'page' ? 2 : body.kind === 'inventory' ? 1 : 0);
  const governing = [...all].sort((a, b) => (rank(b) - rank(a)) || (b.value.length - a.value.length)
    || String(a.source?.url ?? '').localeCompare(String(b.source?.url ?? '')))[0];
  const chosen = governing.value === oldFact?.value ? oldFact : governing.value === newFact?.value ? newFact
    : { value: governing.value, source: governing.source, quote: governing.quote ?? governing.value };
  old.fields.duties = { ...chosen, bodyKind: governing.kind };
  old.bodies = all.filter(b => b.value !== governing.value).map(b => ({ value: b.value, kind: b.kind, source: b.source }));
}

export function mergeInto(old, incoming) {
  for (const [name, value] of Object.entries(incoming.ids ?? {})) {
    if (value == null || value === '') continue;
    if (old.ids[name] == null) old.ids[name] = value;
    else if (String(old.ids[name]) !== String(value)) {
      old.anomalies.push({ type: 'id-divergence', field: name, kept: old.ids[name], seen: value, source: incoming.apiUrl ?? incoming.canonicalUrl });
    }
  }
  for (const name of Object.keys(incoming.fields ?? {})) {
    if (name === 'duties') continue;
    const conflict = mergeField(old, incoming, name);
    if (conflict) old.conflicts.push(conflict);
  }
  mergeBodies(old, incoming);
  mergeClosure(old, incoming);
  if ((READ_RANK[incoming.readState] ?? 0) > (READ_RANK[old.readState] ?? 0)) old.readState = incoming.readState;
  if (incoming.authority === 'registered-official' && old.authority !== 'registered-official') old.authority = 'registered-official';
  if (incoming.application?.status === 'verified' && old.application?.status !== 'verified') old.application = incoming.application;
  if (incoming.emailRoute && !old.emailRoute) old.emailRoute = incoming.emailRoute;
  if (incoming.applyLinks?.length && (!old.applyLinks?.length || old.applyLinks.length < incoming.applyLinks.length)) old.applyLinks = incoming.applyLinks;
  if (incoming.applicationUrl && !old.applicationUrl) old.applicationUrl = incoming.applicationUrl;
  if (incoming.detailUrl && !old.detailUrl) old.detailUrl = incoming.detailUrl;
  if (incoming.detailError && !old.detailError) old.detailError = incoming.detailError;
  if (incoming.observedHtml && (!old.observedHtml || incoming.observedHtml.observedAt > old.observedHtml.observedAt)) old.observedHtml = incoming.observedHtml;
  if (incoming.opportunityKind?.value && !old.opportunityKind) old.opportunityKind = incoming.opportunityKind;
  // A relative publication wording is kept as it was written, with its source.
  if (incoming.relativePublication && !old.relativePublication) old.relativePublication = incoming.relativePublication;
  if (incoming.association && (!old.association || incoming.association.basis === 'verified-this-run')) old.association = incoming.association;
  old.aliases = [...new Set([...(old.aliases ?? []), ...(incoming.aliases ?? [])])];
  if (!old.lead?.employer && incoming.lead?.employer) old.lead.employer = incoming.lead.employer;
  if (!old.lead?.title && incoming.lead?.title) old.lead.title = incoming.lead.title;
  return old;
}
export function merge(state, records) {
  for (const record of records) {
    const old = state.records.find(x => sameIdentity(x, record));
    if (!old) {
      const collision = state.records.find(x => (x.aliases ?? []).some(u => record.aliases.includes(u)));
      if (collision) {
        collision.identityConflict = true; record.identityConflict = true;
        collision.anomalies.push({ type: 'identity-conflict', with: record.recordId, url: record.canonicalUrl });
        record.anomalies.push({ type: 'identity-conflict', with: collision.recordId, url: collision.canonicalUrl });
        // Two different vacancies behind one URL need their own identity.
        record.recordId = hash(state.id + record.canonicalUrl + JSON.stringify(record.ids)).slice(0, 24);
      }
      state.records.push(record);
    } else {
      mergeInto(old, record);
      if (old.identityConflict) record.identityConflict = true;
    }
  }
}
export async function discover(state, reader, sources = null) {
  const registry = sources ?? sourcesFor(state.config);
  for (const source of registry) {
    const status = state.sources.find(x => x.id === source.id);
    if (!status || status.status !== 'not-started') continue;
    try {
      const response = await reader.get(source.url, 'discovery', source.id);
      if (response.status !== 200) throw new Error(`HTTP ${response.status}; inventory not established`);
      const result = parseListing(source, response, state.id);
      const allowed = countItems(state, source.id, result.returned);
      const records = result.records.slice(0, allowed), leads = result.leads.slice(0, Math.max(0, allowed - records.length));
      merge(state, [...records, ...leads.map(l => newRecord(l, state.id))]);
      const usable = result.records.length + result.leads.length;
      const reviewed = records.length + leads.length;
      const advertisedTotal = Number.isSafeInteger(result.total) && result.total >= 0 ? result.total : null;
      Object.assign(status, { status: 'completed', reviewed, returned: result.returned, advertisedTotal, snapshot: response.snapshot });
      if (reviewed < result.returned) {
        const reasons = [];
        if (allowed < usable) reasons.push('per-source item ceiling');
        if (usable < result.returned) reasons.push('entries without posting URLs');
        status.note = `Only ${reviewed} of ${result.returned} returned entries were admitted (${reasons.join(' and ')})`;
        state.warnings.push(`${source.name}: ${status.note}.`);
      } else if (advertisedTotal > result.returned) status.note = 'Only returned page checked; remaining inventory not fetched';
      else if (advertisedTotal === null) status.note = 'Returned entries checked; full site coverage not established';
      status.inventoryComplete = inventoryComplete(status);
    } catch (e) {
      Object.assign(status, { status: /restricted|robots|no retry/i.test(e.message) ? 'restricted' : 'incomplete', reason: e.message });
    }
  }
  return index(state);
}
function indexEntry(record, title, matchedBy) {
  return { recordId: record.recordId, title, employer: record.fields.employer?.value ?? record.lead.employer,
    location: record.fields.location?.value ?? null, readState: record.readState, authority: record.authority,
    gaps: missingFields(record), url: record.canonicalUrl, matchedBy };
}
export function index(state, offset = 0) {
  const { roleFamilies } = state.config;
  const titleWords = roleFamilies.join(' ').toLowerCase().split(/[^a-z0-9+#]+/)
    .filter(word => word.length > 2 && !GENERIC_ROLE_WORDS.has(word)).map(key);
  const queries = dutyQueries(roleFamilies);
  const titleMatches = [], dutyMatches = [], untitled = [];
  for (const record of state.records) {
    const title = clean(record.fields.title?.value) || clean(record.lead.title);
    const titleKey = key(title);
    if (title && (TITLE_HINTS.test(title) || titleWords.some(word => titleKey.includes(word)))) {
      titleMatches.push({ record, title, matchedBy: 'title' });
    } else if (dutiesMatch(record, queries)) {
      dutyMatches.push({ record, title, matchedBy: 'duties' });
    } else if (!title && !record.detailAttempted && !record.closure && !record.identityConflict && !record.anomalies?.length) {
      untitled.push(record);
    }
  }
  const candidates = [...titleMatches, ...dutyMatches];
  const records = candidates.slice(offset, offset + 100).map(({ record, title, matchedBy }) => indexEntry(record, title, matchedBy));
  const omitted = candidates.length - offset - records.length;
  return { run: state.id, discovered: state.records.length, candidates: candidates.length, budget: state.budget,
    sources: state.sources, warnings: state.warnings, records,
    untitledLeads: { total: untitled.length, records: untitled.slice(0, 3).map(record => indexEntry(record, '', 'untitled')) },
    ...(omitted > 0 ? { omitted, note: `Use index --offset ${offset + 100} to read the next page` } : {}) };
}
export function ticket(state) {
  if (state.tickets.some(t => t.status === 'pending')) throw new Error('Complete the pending search ticket before requesting another');
  if (state.tickets.some(t => t.status === 'error')) throw new Error('Search path previously failed; continue with existing inventories');
  const attempt = charge(state, 'discovery', 'web-search', 'model-search-ticket');
  const t = { id: attempt.id, status: 'pending', at: attempt.at }; state.tickets.push(t);
  return { ticket: t.id, instruction: 'Make at most ONE WebSearch call, then submit URLs or an error. Search output is model-reported discovery, not vacancy evidence; hidden upstream requests are not observable.' };
}
export function searchResult(state, id, urls = [], error) {
  const t = state.tickets.find(t => t.id === Number(id));
  if (!t || t.status !== 'pending') throw new Error('Unknown/already completed search ticket');
  if (!Array.isArray(urls) || urls.length > 30) throw new Error('At most 30 discovery URLs per search');
  // One bad URL must not invalidate the rest of the batch.
  const records = [], rejected = [];
  if (!error) {
    for (const url of urls) {
      try {
        const safe = publicUrl(url);
        records.push(newRecord(resolveLead(safe.href), state.id));
      } catch (e) { rejected.push({ url: String(url).slice(0, 300), reason: e.message }); }
    }
  }
  Object.assign(t, { status: error ? 'error' : 'completed', ...(error ? { error: String(error).slice(0, 500) } : { urls: records.map(r => r.canonicalUrl) }), ...(rejected.length ? { rejected } : {}) });
  if (error) state.warnings.push(`WebSearch path failed (${String(error).slice(0, 200)}): sources discoverable through this path are a blind spot. Known inventories continue; no substitute search results were used.`);
  Object.assign(state.attempts.find(a => a.id === t.id), { outcome: 'model-reported', reportedStatus: t.status });
  merge(state, records);
  for (const bad of rejected) state.warnings.push(`Rejected discovery URL ${bad.url}: ${bad.reason}`);
  return { accepted: records.length, rejected: rejected.length, note: 'URLs only; no webpage facts accepted from model' };
}

// The fields a complete vacancy reading is expected to carry. A record that is
// missing any of them is completed from the HTML job page before it can be judged.
export const GAP_FIELDS = ['location', 'engagement', 'contractType', 'workload', 'hoursPerWeek', 'duration', 'closesAt'];
export function missingFields(record) {
  const gaps = [];
  for (const name of GAP_FIELDS) if (record.fields[name]?.value == null) gaps.push(name);
  const posted = record.fields.postedAt;
  if (!posted?.value || !['first-published', 'advertised-date'].includes(posted.semantics)) gaps.push('postedAt:first-publication');
  return gaps;
}
// A transient failure is not a final answer. The record stays open for one
// more attempt instead of being marked as read-and-failed for the whole run.
const TRANSIENT_ERROR = /timeout|socket hang up|ECONNRESET|ECONNREFUSED|EPIPE|EAI_AGAIN|ETIMEDOUT|network|HTTP 5\d\d|\b5\d\d\b/i;
export async function details(state, reader, ids) {
  const out = [];
  for (const id of ids) {
    const r = state.records.find(r => r.recordId === id);
    if (!r) throw new Error(`Unknown record ID ${id}`);
    if (!r.detailAttempted) {
      const gaps = missingFields(r);
      const attempts = (r.detailAttempts ?? 0) + 1;
      r.detailAttempts = attempts;
      // The employer's own page is the primary document. An inventory that
      // filled every field is not a reason to leave that page unread: the
      // page can state a closing value, a publication date or a fact the
      // inventory does not carry, and a page that was read is never ignored.
      const page = canonicalLocal(r.detailUrl ?? r.canonicalUrl);
      const pageRead = r.primaryRead && canonicalLocal(r.primaryRead.url) === page;
      if (gaps.length || !pageRead) await readDetail(r, reader, { gaps });
      else r.detailNote = 'Reused complete current-run evidence; no duplicate detail request';
      r.gaps = missingFields(r);
      const transient = TRANSIENT_ERROR.test(r.detailError ?? '');
      if (!transient || attempts >= 2) r.detailAttempted = true;
      else {
        r.detailAttempted = false;
        state.warnings.push(`${r.fields.title?.value ?? r.lead.title ?? r.canonicalUrl}: transient read failure (${r.detailError}); the record stays open for one more attempt.`);
      }
    }
    out.push(r);
  }
  return out;
}
export async function associate(state, reader, recordId, officialUrl) {
  const r = state.records.find(x => x.recordId === recordId);
  if (!r) throw new Error('Unknown record ID');
  // Each employer's careers page is its own source. A shared 'association'
  // key would let one employer's refusal block every other employer's
  // verification and would spend a single allowance for unrelated sites.
  const official = publicUrl(officialUrl);
  const site = siteKey(official.href);
  const response = await reader.get(official.href, 'discovery', site);
  if (response.status !== 200) throw new Error('Official careers association could not be read');
  const shape = recognised(r.canonicalUrl), $ = load(response.body), found = [];
  $('a[href]').each((_, el) => {
    try {
      const link = new URL($(el).attr('href'), response.url), s = recognised(link.href);
      if (canonical(link.href) === r.canonicalUrl || (shape.account && s.provider === shape.provider && s.account.toLowerCase() === shape.account.toLowerCase())) found.push(link.href);
    } catch {}
  });
  if (!found.length) throw new Error('No actual official-page link to this vacancy or ATS tenant; employer-name guesses are not accepted');
  r.authority = 'registered-official';
  r.association = { basis: 'verified-this-run', officialUrl: response.url, observedAt: response.observedAt, snapshot: response.snapshot, linkedUrls: found,
    seed: r.association?.basis === 'curated-seed' ? r.association : null };
  state.associations.push(r.association);
  return r.association;
}
export async function inventory(state, reader, recordId, officialUrl) {
  const r = state.records.find(x => x.recordId === recordId);
  if (!r) throw new Error('Unknown record ID');
  // A curated seed is not a verification for this run. Verify once, then reuse.
  if (!r.association || r.association.basis !== 'verified-this-run') await associate(state, reader, recordId, officialUrl);
  const shape = recognised(r.canonicalUrl), { account, provider } = shape;
  const url = provider === 'greenhouse' ? `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(account)}/jobs?content=true`
    : provider === 'lever' ? `https://api.lever.co/v0/postings/${encodeURIComponent(account)}?mode=json`
      : provider === 'smartrecruiters' ? `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(account)}/postings?limit=100` : null;
  const id = `${provider}:${account.toLowerCase()}`;
  if (!url) {
    // An unsupported inventory is a visible blind spot, not a silent omission.
    if (!state.sources.some(s => s.id === id)) state.sources.push({ id, name: r.fields.employer?.value ?? `Unconfirmed employer (${account})`, url: r.canonicalUrl, status: 'unsupported', reviewed: 0, reason: `No inventory adapter for provider "${provider}"; the vacancy was read from its own page only` });
    state.warnings.push(`${r.fields.employer?.value ?? account}: no inventory adapter for ${provider}; full employer coverage is not established.`);
    return state.sources.find(s => s.id === id);
  }
  const prior = state.sources.find(x => x.id === id && x.status !== 'not-started');
  if (prior) return prior;
  const source = { id, name: r.fields.employer?.value ?? `Unconfirmed employer (${account})`, employer: r.fields.employer?.value ?? null, provider, account, url, association: r.association };
  state.sources.push({ id, name: source.name, url, status: 'not-started', reviewed: 0 });
  await discover(state, reader, [source]);
  return state.sources.find(s => s.id === id);
}

// --- application verification -------------------------------------------------
export const APPLICATION_STATUSES = ['not-checked', 'none-found', 'entry-observed', 'verified'];
export const APPLICATION_KINDS = ['job-specific-form', 'job-specific-external-ats', 'email-in-posting', 'none', 'unverified'];
// A closed posting is not an application route. The same wording that keeps
// a page out of formProof also keeps it out of the external-ATS proof.
const ROUTE_CLOSED = new RegExp(`${CLOSED_NOTICE.source}|no longer (?:advertised|available|open)|we (?:are|will) no longer (?:accepting|hiring)|(?:job|position|vacancy|role) (?:is|has been) (?:closed|filled|removed)`, 'i');
// An external ATS page only proves a route when it offers a job-specific
// action: a form that submits for this advertisement, or a link that carries
// the advertisement id into an application route.
function applicationAction($, response, advertisement) {
  const id = String(advertisement);
  let here;
  try { here = new URL(response.url); } catch { return null; }
  const submitLabel = f => f.find('button[type="submit"],input[type="submit"],button').toArray()
    .some(e => /apply|submit (?:your )?application|send application/i.test($(e).text() || $(e).attr('value') || ''));
  for (const form of $('form').toArray()) {
    const f = $(form);
    const hidden = f.find('input[name="job_id"],input[name="jobId"],input[name="gh_jid"],input[name="requisitionId"],input[name="jobId[]"]').first().attr('value');
    if (hidden && hidden !== id) continue;
    let action;
    try { action = new URL(f.attr('action') || response.url, response.url); } catch { continue; }
    const declared = action.pathname.match(/\/(?:jobs?|requisitions?|positions?|vacancies|advertisements?)\/(\d+)(?:\/|$)/)?.[1];
    if (declared && declared !== id) continue;
    // The action must point at this advertisement: by id, or at the very page
    // that carries the id in its own address.
    const bound = hidden === id || declared === id || action.pathname.includes(id)
      || (action.origin === here.origin && action.pathname === here.pathname);
    if (!bound) continue;
    if (!submitLabel(f)) continue;
    return { action: 'job-specific-form', quote: clean(f.text()).slice(-400) };
  }
  for (const a of $('a[href]').toArray()) {
    const el = $(a), label = clean(el.text());
    if (!/^(?:apply(?: (?:now|for this (?:job|role|position))?)?|submit application|start application|apply for this job)$/i.test(label)) continue;
    let href;
    try { href = new URL(el.attr('href'), response.url); } catch { continue; }
    const bound = href.pathname.includes(id) || (href.origin === here.origin && href.pathname === here.pathname);
    if (!bound) continue;
    return { action: 'job-specific-external-ats', quote: label, href: href.toString() };
  }
  return null;
}
// A third-party ATS is a source of its own: its robots read, its job page and
// its apply target are its traffic, not the employer's. Charging them to the
// employer's board would make one employer's allowance pay for another
// system's reads, and it would cap a legitimate route before the apply target
// has even been read.
const atsSourceKey = (provider, account) => `${provider}:${account || 'public'}`;
// The key a request is charged to: the record's own board, or the ATS account
// that actually serves the URL when that is a different system.
function chargeSourceFor(record, url) {
  const shape = recognised(url);
  if (!shape.provider || shape.provider === 'html') return record.sourceKey;
  if (shape.provider === record.provider && (shape.account ?? '').toLowerCase() === (record.account ?? '').toLowerCase()) return record.sourceKey;
  return atsSourceKey(shape.provider, shape.account);
}
// The target of an apply link must still be about this advertisement: the id
// in its own address, the id it declares, or a form that submits for it.
function boundToAdvertisement($, response, advertisement) {
  const id = String(advertisement);
  let path = '';
  try { path = new URL(response.url).pathname; } catch { return false; }
  if (path.includes(id)) return true;
  const shape = recognised(response.url);
  if (shape.advertisement && String(shape.advertisement) === id) return true;
  for (const form of $('form').toArray()) {
    const f = $(form);
    const hidden = f.find('input[name="job_id"],input[name="jobId"],input[name="gh_jid"],input[name="requisitionId"]').first().attr('value');
    if (hidden === id) return true;
    const action = f.attr('action');
    if (!action) continue;
    try { if (new URL(action, response.url).pathname.includes(id)) return true; } catch { continue; }
  }
  return false;
}
// The application action on an apply target has to be bound to the
// advertisement by id, not merely by living on the same page: a generic
// careers form or another job's form does not count.
function boundApplicationAction($, response, advertisement) {
  const id = String(advertisement);
  for (const form of $('form').toArray()) {
    const f = $(form);
    const hidden = f.find('input[name="job_id"],input[name="jobId"],input[name="gh_jid"],input[name="requisitionId"]').first().attr('value');
    if (hidden && hidden !== id) continue;
    let action;
    try { action = new URL(f.attr('action') || response.url, response.url); } catch { continue; }
    const declared = action.pathname.match(/\/(?:jobs?|requisitions?|positions?|vacancies|advertisements?)\/(\d+)(?:\/|$)/)?.[1];
    if (declared && declared !== id) continue;
    if (!(hidden === id || declared === id || action.pathname.includes(id))) continue;
    const submit = f.find('button[type="submit"],input[type="submit"],button').toArray()
      .some(e => /apply|submit (?:your )?application|send application/i.test($(e).text() || $(e).attr('value') || ''));
    if (!submit) continue;
    const hasEmail = f.find('input[type="email"],input[name*="email"],input[id*="email"]').length;
    const personal = f.find('input[name*="name"],input[id*="name"],input[type="file"]').length;
    if (!hasEmail || !personal) continue;
    return { action: 'job-specific-form', quote: clean(f.text()).slice(-400) };
  }
  return null;
}
// An apply link is an entry, not a route. The target is read before the route
// counts: it may be dead, behind a login wall, a generic careers page, or
// another job's page.
async function followApplicationEntry(record, reader, entry) {
  let response;
  try {
    response = await reader.get(entry.link, 'application', chargeSourceFor(record, entry.link));
  } catch (e) {
    return { status: 'entry-observed', kind: 'none', reason: `Application entry ${entry.link} could not be read: ${e.message}`, url: entry.link, entryUrl: entry.link, observedAt: entry.observedAt, snapshot: entry.snapshot };
  }
  if (response.status !== 200) {
    return { status: 'none-found', kind: 'none', reason: `Application entry ${entry.link} returned HTTP ${response.status}`, url: entry.link, entryUrl: entry.link, observedAt: response.observedAt, snapshot: response.snapshot };
  }
  const closed = ROUTE_CLOSED.exec(textOf(response.body));
  if (closed) return { status: 'none-found', kind: 'none', reason: `Application target states it is closed: "${closed[0]}"`, url: entry.link, entryUrl: entry.link, observedAt: response.observedAt, snapshot: response.snapshot };
  const $ = load(response.body);
  if (!boundToAdvertisement($, response, entry.advertisement)) {
    return { status: 'entry-observed', kind: 'none', reason: `Application target ${entry.link} is not bound to advertisement ${entry.advertisement}`, url: entry.link, entryUrl: entry.link, observedAt: response.observedAt, snapshot: response.snapshot };
  }
  const action = boundApplicationAction($, response, entry.advertisement);
  if (!action) {
    const onward = applicationAction($, response, entry.advertisement);
    const reason = onward?.action === 'job-specific-external-ats'
      ? `Application target ${entry.link} only links onward; the final page was not read`
      : `Application target ${entry.link} offers no application action bound to advertisement ${entry.advertisement}`;
    return { status: 'entry-observed', kind: 'none', reason, url: entry.link, entryUrl: entry.link, observedAt: response.observedAt, snapshot: response.snapshot };
  }
  const shape = recognised(response.url);
  const external = shape.provider !== record.provider || (shape.account ?? '').toLowerCase() !== (record.account ?? '').toLowerCase();
  return { status: 'verified', kind: external ? 'job-specific-external-ats' : 'job-specific-form', url: response.url,
    observedAt: response.observedAt, snapshot: response.snapshot, provider: shape.provider, account: shape.account,
    advertisement: entry.advertisement, quote: action.quote };
}
function externalAtsProof(record, response) {
  if (response.status !== 200) return null;
  const shape = recognised(response.url);
  if (!shape.advertisement) return null;
  if (shape.provider === record.provider && (shape.account ?? '').toLowerCase() === (record.account ?? '').toLowerCase()) return null;
  const $ = load(response.body), title = key(record.fields.title?.value);
  if (title && !$('h1,h2,title').toArray().some(e => key($(e).text()).includes(title))) return null;
  // A page that says the posting is closed is not an open application route.
  if (ROUTE_CLOSED.test(textOf(response.body))) return null;
  // HTTP 200 plus a matching title is not proof: the page must offer an
  // action bound to this advertisement.
  const action = applicationAction($, response, shape.advertisement);
  if (!action) return null;
  // A form on this page is the route itself. An apply link is only an entry:
  // its target still has to be read before it can count as a route.
  if (action.action === 'job-specific-form') {
    return { kind: 'job-specific-form', url: response.url, observedAt: response.observedAt, snapshot: response.snapshot,
      provider: shape.provider, account: shape.account, advertisement: shape.advertisement, quote: action.quote };
  }
  return { kind: 'entry', link: action.href, url: response.url, observedAt: response.observedAt, snapshot: response.snapshot,
    provider: shape.provider, account: shape.account, advertisement: shape.advertisement, quote: action.quote };
}
export async function verifyApplication(record, reader) {
  if (record.application?.status === 'verified') return;
  record.application = { status: 'not-checked', kind: 'unverified', reason: 'Not checked' };
  if (record.authority !== 'registered-official') { record.application.reason = 'Employer association unconfirmed'; return; }
  const urls = [...new Set([record.canonicalUrl, record.applicationUrl, ...(record.applyLinks ?? []).map(x => x.url)].filter(Boolean))];
  let sawEntry = false;
  // The most specific reason an observed entry failed to become a route; a
  // later, vaguer page must not erase it.
  let entryOutcome = null;
  for (const url of urls.slice(0, 3)) {
    try {
      const response = await reader.get(url, 'application', chargeSourceFor(record, url));
      // The employer's own page is evaluated as it is read. A contrary fact
      // on the page that was just read — a validity window that has passed,
      // a field the inventory filled differently — is not ignored, even when
      // the inventory had already supplied every field.
      if (response.status === 200 && canonicalLocal(response.url) === canonicalLocal(record.detailUrl ?? record.canonicalUrl)) {
        applyPageClaims(record, response);
      }
      // A page that states the posting is closed offers no route: the entry
      // exists, but the vacancy behind it is gone.
      const closed = ROUTE_CLOSED.exec(textOf(response.body));
      if (closed) { record.application = { status: 'none-found', kind: 'none', reason: `Posting states it is closed: "${closed[0]}"` }; continue; }
      const proof = formProof(record, response);
      if (proof) { record.application = { status: 'verified', kind: 'job-specific-form', ...proof }; return; }
      const external = externalAtsProof(record, response);
      if (external) {
        if (external.kind === 'job-specific-form') {
          record.application = { status: 'verified', kind: 'job-specific-form', url: external.url, observedAt: external.observedAt,
            snapshot: external.snapshot, provider: external.provider, account: external.account, advertisement: external.advertisement, quote: external.quote };
          return;
        }
        // An apply link is an entry, not a route: the target is read first.
        record.application = { status: 'entry-observed', kind: 'none', reason: `Application entry observed at ${external.link}; the target has not been verified`,
          url: external.url, entryUrl: external.link, observedAt: external.observedAt, snapshot: external.snapshot };
        record.application = await followApplicationEntry(record, reader, external);
        if (record.application.status === 'verified') return;
        entryOutcome = record.application;
        continue;
      }
      if (response.status === 200 && (record.applyLinks?.some(x => canonicalLocal(x.url) === canonicalLocal(response.url)) || canonicalLocal(record.canonicalUrl) === canonicalLocal(response.url))) sawEntry = true;
      // Email delivery must be on the same, fully read primary vacancy, not a contact page.
      if (record.emailRoute && record.readState === 'read' && canonicalLocal(response.url) === canonicalLocal(record.canonicalUrl) && response.status === 200) {
        record.application = { status: 'verified', kind: 'email-in-posting', email: record.emailRoute.email, instruction: record.emailRoute.instruction, url: response.url, observedAt: response.observedAt, snapshot: response.snapshot };
        return;
      }
      record.application = { status: sawEntry ? 'entry-observed' : 'none-found', kind: 'none', reason: `No bound, job-specific form observed at ${response.url} (HTTP ${response.status})` };
    } catch (e) { record.application = { status: 'not-checked', kind: 'unverified', reason: e.message }; }
  }
  if (entryOutcome && record.application.status !== 'verified') record.application = entryOutcome;
  if (record.application.status === 'not-checked') record.application = { status: 'not-checked', kind: 'unverified', reason: 'No readable application route was reached' };
}
// Verification order: jobs whose hard conditions already pass first, then a
// small number of high-value unknowns. Unverified jobs are never promoted.
// A record whose state is already known to be terminal never enters the plan:
// an identity anomaly, an excluded opportunity kind or any other state the
// report does not promote spends no application budget at all.
const PROMOTABLE_CATEGORIES = new Set(['ready', 'check', 'pool', 'unresolved']);
export function applicationPlan(state, judgments, exclusions, now, budget) {
  const fitOf = r => judgments.find(j => j.recordId === r.recordId)?.fit;
  // An employer channel is not a vacancy: verifying an application route for it
// would spend the application budget on a page that offers no vacancy.
  const scored = state.records.filter(r => r.readState === 'read' && !r.closure && !isChannel(r) && !excluded(r, exclusions)).map(r => {
    const judgment = judgments.find(j => j.recordId === r.recordId);
    // A disqualifier the runtime verified is a hard condition: the role does
    // not get an application budget.
    const { checks } = checksWithJudgment(r, state.config, judgment, now);
    const conflicts = checks.filter(c => c.status === 'conflict').length;
    const unknowns = checks.filter(c => c.status === 'unknown' && !c.advisory).length;
    const fit = fitOf(r);
    const rank = conflicts ? 3 : unknowns === 0 ? 0 : fit === 'strong' ? 1 : 2;
    // The same decision the report will make about this record, so the plan
    // never buys a verification for a record that cannot be promoted: an
    // identity anomaly, an excluded opportunity kind and every other
    // terminal state are decided before the budget is spent.
    const category = classify(r, state.config, judgment, now).category;
    return { record: r, rank, fit, category };
  }).filter(s => PROMOTABLE_CATEGORIES.has(s.category));
  const ready = scored.filter(s => s.rank === 0 && s.fit && s.fit !== 'weak');
  const strong = scored.filter(s => s.rank === 1);
  const others = scored.filter(s => s.rank === 2 && s.fit && s.fit !== 'weak');
  const plan = [...ready, ...strong.slice(0, 3), ...others.slice(0, 2)].map(s => s.record);
  const room = Math.max(0, (budget ?? state.budget.limits.application) - state.budget.used.application);
  return plan.slice(0, room);
}
export function validateJudgments(input, state) {
  if (!Array.isArray(input?.judgments)) throw new Error('Expected judgments array');
  const seen = new Set();
  for (const j of input.judgments) {
    if (Object.keys(j).some(k => !['recordId', 'fit', 'reasons', 'quotes', 'disqualifiers'].includes(k))) throw new Error('Judgments accept only recordId, fit, reasons, quotes and disqualifiers; webpage facts are runtime-owned');
    const record = state.records.find(r => r.recordId === j.recordId);
    if (!record || seen.has(j.recordId)) throw new Error('Unknown/duplicate judgment record ID');
    seen.add(j.recordId);
    if (!['strong', 'possible', 'weak'].includes(j.fit) || !Array.isArray(j.reasons) || !j.reasons.length || j.reasons.some(x => typeof x !== 'string' || x.length > 1000)) throw new Error('fit: strong|possible|weak; reasons: nonempty text array');
    if (j.reasons.some(x => /\p{Script=Han}/u.test(x))) throw new Error(`Judgment reasons for ${j.recordId} must be written in English; preserve source-language text only in quotes`);
    // A quotation is checked against every text the posting was read from:
    // a declaration that only the employer's own page carries is still the
    // posting's own text.
    const corpus = quoteCorpus(record);
    if (!Array.isArray(j.quotes) || !j.quotes.length || j.quotes.some(q => typeof q !== 'string' || q.length < 8 || !corpus.includes(q))) throw new Error('quotes must be exact excerpts from this record duties; model cannot fabricate supporting evidence');
    // A disqualifier is a pointer, not a fact: the quotation must be the
    // posting's own text, and the runtime verifies what it states.
    if (j.disqualifiers != null) {
      if (!Array.isArray(j.disqualifiers)) throw new Error(`disqualifiers for ${j.recordId} must be an array`);
      for (const d of j.disqualifiers) {
        if (!d || typeof d !== 'object' || !DISQUALIFIER_KINDS.includes(d.kind)) throw new Error(`disqualifier kind must be one of ${DISQUALIFIER_KINDS.join(', ')}`);
        if (typeof d.quote !== 'string' || d.quote.length < 8 || !corpus.includes(d.quote)) throw new Error('disqualifier quote must be an exact excerpt from this record duties');
      }
    }
  }
  return input.judgments;
}
export function excluded(record, exclusions) {
  for (const e of exclusions ?? []) {
    try {
      const ids = { requisition: e.requisitionId ?? e.ids?.requisition ?? null, advertisement: e.ids?.advertisement ?? null, platformJob: e.ids?.platformJob ?? null };
      const old = { fields: { employer: { value: e.employer } }, ids,
        // A saved decision names the posting it was made on and the addresses
        // that posting is known by. Both are the same posting, so both are
        // matched: a record that moved to a new address is still the one the
        // user already decided about.
        aliases: [...(e.url ? [e.url] : []), ...(e.aliases ?? [])].map(canonicalLocal).filter(Boolean),
        provider: e.provider ?? 'external', account: e.account ?? '' };
      // A confirmed, different requisition number is a different vacancy and is not excluded.
      if (ids.requisition && record.ids?.requisition && key(ids.requisition) !== key(record.ids.requisition)) continue;
      if (sameIdentity(record, old)) return e;
    } catch { continue; } // A malformed history entry must never abort a scan.
  }
  return undefined;
}
export async function inRun(project, id, action, request, options = {}) {
  const root = await rootAt(project);
  return locked(root, id, async (state, folder) => {
    if (state.reported) throw new Error('This run already produced its immutable report; start a new incremental run');
    // A finished run takes no further calls: it cannot spend behind the back
    // of the next run of the same request.
    if (state.request?.finishedAt) throw new Error('This run has been ended; start a new run of the request');
    // A run belongs to the runtime that created it. Reading a run's records
    // or closing it stays possible, because neither changes its evidence, but
    // a command that reads pages, judges or reports under a different
    // implementation would mix two parsers in one conclusion.
    const running = await implementationIdentity();
    const stored = state.implementation ?? state.request?.implementation ?? null;
    let mismatch = null;
    if (!stored || !sameImplementation(stored, running)) {
      mismatch = { stored, running };
      if (!options.readOnly && !options.closing) {
        const refused = stored ? incompatibilityMessage(stored, running) : unpinnedRunMessage(running);
        if (!options.allowImplementationChange) throw new Error(refused);
        state.implementationChanges = [...(state.implementationChanges ?? []), { from: stored ?? { version: null, hash: null, unknown: true }, to: running, at: new Date().toISOString() }];
      }
    }
    try {
      const result = await action(state, new Reader(root, folder, state, request), root, folder);
      if (mismatch && options.annotate && result && typeof result === 'object' && !Array.isArray(result)) {
        return { ...result, implementationMismatch: {
          createdBy: describeImplementation(mismatch.stored), running: describeImplementation(mismatch.running),
          note: 'This run was read under a different runtime. Its evidence was not re-read and its earlier report was not rewritten.' } };
      }
      return result;
    } finally {
      // What this run spent on its own, apart from what the request had
      // already spent before it started. It is recorded even when the command
      // failed: the calls were billed, and the next run of the same request
      // must inherit them. The run state is saved by the lock afterwards, so
      // the saved run carries the same number.
      if (state.request?.baselineBudget) state.request.own = ownSpend(state);
    }
  });
}
export { idKeys, SOURCES };

// Inspecting and recovering the locks of a project. A lock is only removed
// when it cannot belong to a running command: the lock of a live process is
// never touched, and a lock without a usable PID is only removed after its
// grace period, or when the caller asks for it explicitly. Nothing else in
// the project is read or removed: the recovery is about locks only.
export async function recoverLock(project, { force = false, run = null } = {}) {
  const root = await rootAt(project);
  const targets = [{ kind: 'start', lock: join(root, '.nz-job-scout', 'requests', 'start.lock') }];
  if (run) targets.push({ kind: 'command', lock: join(runPath(root, validRun(run)), 'command.lock') });
  const results = [];
  for (const target of targets) {
    const info = await lstat(target.lock).catch(e => { if (e.code !== 'ENOENT') throw e; });
    if (!info) { results.push({ ...target, present: false, removed: false, reason: 'no lock file is present' }); continue; }
    if (info.isSymbolicLink()) { results.push({ ...target, present: true, removed: false, reason: 'the lock path is a symbolic link; it was not followed and not removed' }); continue; }
    const verdict = await lockRemovable(target.lock, { force });
    if (verdict.remove) {
      await unlink(target.lock).catch(() => {});
      results.push({ ...target, present: true, removed: true, pid: verdict.status.pid, ageMs: verdict.status.ageMs, reason: verdict.reason });
    } else results.push({ ...target, present: true, removed: false, pid: verdict.status.pid, ageMs: verdict.status.ageMs, reason: verdict.reason });
  }
  return { project: root, force, recovered: results.some(r => r.removed), results,
    note: 'Locks only. A lock of a live process is never removed; a lock without a usable PID is removed after its grace period, or on explicit request with --force.' };
}
