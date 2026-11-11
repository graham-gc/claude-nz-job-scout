import { readFile } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { load } from './html.mjs';
import { hash, put, rootAt, runId, runPath, locked } from './store.mjs';
import { Reader, charge, publicUrl, countItems, countDetail } from './net.mjs';
import { criteria, contextHash, hardChecks } from './criteria.mjs';
import { newRecord, canonical, canonicalLocal, key, sameIdentity, formProof, idKeys, textOf, clean } from './evidence.mjs';
import { SOURCES, sourcesFor, parseListing, resolveLead, readDetail, recognised } from './sources.mjs';

export async function start(project, input, resumePath) {
  const root = await rootAt(project), config = criteria(input), path = resolve(resumePath);
  let resume;
  if (extname(path).toLowerCase() === '.pdf') resume = (await promisify(execFile)('pdftotext', ['-layout', path, '-'], { timeout: 10000, maxBuffer: 2_000_000 })).stdout;
  else if (['.txt', '.md'].includes(extname(path).toLowerCase())) resume = await readFile(path, 'utf8');
  else throw new Error('Resume input supports PDF (pdftotext required), TXT or Markdown');
  if (resume.trim().length < 100) throw new Error('Resume text missing/too short; supply a readable resume, not invented profile data');
  const id = runId(), now = new Date().toISOString(), folder = runPath(root, id);
  const sources = sourcesFor(config);
  const state = {
    schema: 1, id, startedAt: now,
    // The request window is measured in network time, so model thinking cannot consume it.
    // The wall-clock deadline is only a hard safety cap for the whole run.
    deadline: Date.now() + 60 * 60000, networkBudgetMs: 15 * 60000, networkSpentMs: 0, wallDeadline: Date.now() + 60 * 60000,
    config, resumeHash: hash(resume), context: contextHash(config, hash(resume)), resumePath: path,
    budget: {
      limits: { discovery: 20, detail: 20, application: 10 },
      used: { discovery: 0, detail: 0, application: 0 },
      groupLimits: { boards: 12, linkedin: 3, search: 5 },
      groups: { boards: 0, linkedin: 0, search: 0 },
      // Per-stage ledgers: the report prints the numbers of the stage it
      // describes, so a detail read can never be shown as discovery spend.
      stageGroups: { discovery: { boards: 0, linkedin: 0, search: 0 }, detail: { boards: 0, linkedin: 0, search: 0 }, application: { boards: 0, linkedin: 0, search: 0 } },
      // robots.txt reads are counted inside their source group and against
      // this ceiling of their own.
      robotsLimit: 6, robotsUsed: 0,
      stageRobots: { discovery: { boards: 0, linkedin: 0, search: 0 }, detail: { boards: 0, linkedin: 0, search: 0 }, application: { boards: 0, linkedin: 0, search: 0 } },
      sourceLimits: { discoveryRequests: 4, detailRequests: 8, applicationRequests: 4, items: 200, details: 6 },
      sourceUsed: {}
    },
    attempts: [], sources: sources.map(s => ({ id: s.id, url: s.url, name: s.name, status: 'not-started', reviewed: 0 })),
    records: [], cache: {}, robots: {}, blockedSources: {}, tickets: [], associations: [], warnings: []
  };
  await put(root, join(folder, 'resume.txt'), resume);
  await put(root, join(folder, 'run.json'), state);
  return { run: id, root, context: state.context, resumeText: join(folder, 'resume.txt'), limits: state.budget.limits, deadline: new Date(state.deadline).toISOString() };
}
export function relevant(record, config) {
  // Retrieval hint only; never a suitability score or a recommendation decision.
  const title = record.fields.title?.value ?? record.lead.title;
  const words = config.roleFamilies.join(' ').toLowerCase().split(/[^a-z0-9+#]+/).filter(x => x.length > 2 && !['engineer', 'engineering', 'development', 'developer', 'internship', 'graduate', 'senior', 'junior', 'intern'].includes(x));
  return words.some(w => key(title).includes(key(w))) || /software|\bQA\b|SDET|test|backend|back.end|automation|platform|developer|programmer|devops/i.test(title);
}

// ---------------------------------------------------------------------------
// Merging: fields and evidence are preserved, never wholesale replaced.
// ---------------------------------------------------------------------------
const SEMANTIC_WEIGHT = { 'first-published': 4, 'advertised-date': 4, 'deadline': 3, 'deadline-date': 3, 'updated': 1, 'last-published': 1, 'platform-created': 1 };
const READ_RANK = { read: 4, 'closed-stated': 3, partial: 2, 'not-read': 1, unreadable: 0 };
const fieldWeight = f => SEMANTIC_WEIGHT[f?.semantics] ?? 2;

function mergeField(old, incoming, name) {
  const a = old.fields[name], b = incoming.fields[name];
  if (!b || b.value == null) return null;
  if (!a || a.value == null) { old.fields[name] = b; return null; }
  if (JSON.stringify(a.value) === JSON.stringify(b.value)) return null;
  const conflict = { field: name, kept: a.value, discarded: b.value, keptSource: a.source?.url ?? null, discardedSource: b.source?.url ?? null };
  // A stronger piece of evidence (a first-publication date beats an update stamp) wins.
  if (fieldWeight(b) > fieldWeight(a)) { old.fields[name] = b; conflict.kept = b.value; conflict.discarded = a.value; conflict.keptSource = b.source?.url ?? null; conflict.discardedSource = a.source?.url ?? null; }
  return conflict;
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
export function mergeInto(old, incoming) {
  for (const [name, value] of Object.entries(incoming.ids ?? {})) {
    if (value == null || value === '') continue;
    if (old.ids[name] == null) old.ids[name] = value;
    else if (String(old.ids[name]) !== String(value)) {
      old.anomalies.push({ type: 'id-divergence', field: name, kept: old.ids[name], seen: value, source: incoming.apiUrl ?? incoming.canonicalUrl });
    }
  }
  for (const name of Object.keys(incoming.fields ?? {})) {
    const conflict = mergeField(old, incoming, name);
    if (conflict) old.conflicts.push(conflict);
  }
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
      Object.assign(status, { status: 'completed', reviewed: records.length + leads.length, advertisedTotal: result.total,
        inventoryComplete: result.total !== null && result.returned >= result.total, snapshot: response.snapshot });
      if (allowed < result.returned) { status.note = `Per-source item ceiling kept ${allowed} of ${result.returned} returned entries`; state.warnings.push(`${source.name}: only ${allowed} of ${result.returned} returned entries were admitted (per-source ceiling).`); }
      else if (result.total > result.returned) status.note = 'Only returned page checked; remaining inventory not fetched';
      else if (result.total === null) status.note = 'Returned entries checked; full site coverage not established';
    } catch (e) {
      Object.assign(status, { status: /restricted|robots|no retry/i.test(e.message) ? 'restricted' : 'incomplete', reason: e.message });
    }
  }
  return index(state);
}
export function index(state) {
  const candidates = state.records.filter(r => relevant(r, state.config));
  return { run: state.id, discovered: state.records.length, candidates: candidates.length, budget: state.budget,
    sources: state.sources, warnings: state.warnings,
    records: candidates.slice(0, 100).map(r => ({ recordId: r.recordId, title: r.fields.title?.value ?? r.lead.title,
      employer: r.fields.employer?.value ?? r.lead.employer, location: r.fields.location?.value ?? null,
      readState: r.readState, authority: r.authority, gaps: missingFields(r), url: r.canonicalUrl })),
    ...(candidates.length > 100 ? { omitted: candidates.length - 100, note: 'Use index --offset 100 to read the next page' } : {}) };
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
  if (error) state.warnings.push(`WebSearch 路径失败（${String(error).slice(0, 200)}）：该路径能发现的来源本轮为盲区；已知库存继续运行，未用其它结果替代。`);
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
      if (gaps.length) await readDetail(r, reader, { gaps });
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
  const official = publicUrl(officialUrl), response = await reader.get(official.href, 'discovery', 'association');
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
const CLOSED_NOTICE = /no longer accepting applications|applications? (?:are|have) (?:now )?closed|this (?:job|position|vacancy|role) (?:has expired|is no longer available|is now closed|has been closed|has been filled)|(?:job|position|vacancy|role) (?:is|has been) (?:closed|filled|removed)|no longer (?:advertised|available|open)|we (?:are|will) no longer (?:accepting|hiring)/i;
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
  const closed = CLOSED_NOTICE.exec(textOf(response.body));
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
  if (CLOSED_NOTICE.test(textOf(response.body))) return null;
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
      // A page that states the posting is closed offers no route: the entry
      // exists, but the vacancy behind it is gone.
      const closed = CLOSED_NOTICE.exec(textOf(response.body));
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
export function applicationPlan(state, judgments, exclusions, now, budget) {
  const fitOf = r => judgments.find(j => j.recordId === r.recordId)?.fit;
  const scored = state.records.filter(r => r.readState === 'read' && !r.closure && !excluded(r, exclusions)).map(r => {
    const checks = hardChecks(r, state.config, now);
    const conflicts = checks.filter(c => c.status === 'conflict').length;
    const unknowns = checks.filter(c => c.status === 'unknown' && !c.advisory).length;
    const fit = fitOf(r);
    const rank = conflicts ? 3 : unknowns === 0 ? 0 : fit === 'strong' ? 1 : 2;
    return { record: r, rank, fit };
  });
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
    if (Object.keys(j).some(k => !['recordId', 'fit', 'reasons', 'quotes'].includes(k))) throw new Error('Judgments accept only recordId, fit, reasons and quotes; webpage facts are runtime-owned');
    const record = state.records.find(r => r.recordId === j.recordId);
    if (!record || seen.has(j.recordId)) throw new Error('Unknown/duplicate judgment record ID');
    seen.add(j.recordId);
    if (!['strong', 'possible', 'weak'].includes(j.fit) || !Array.isArray(j.reasons) || !j.reasons.length || j.reasons.some(x => typeof x !== 'string' || x.length > 1000)) throw new Error('fit: strong|possible|weak; reasons: nonempty text array');
    if (!Array.isArray(j.quotes) || !j.quotes.length || j.quotes.some(q => typeof q !== 'string' || q.length < 8 || !(record.fields.duties?.value ?? '').includes(q))) throw new Error('quotes must be exact excerpts from this record duties; model cannot fabricate supporting evidence');
  }
  return input.judgments;
}
export function excluded(record, exclusions) {
  for (const e of exclusions ?? []) {
    try {
      const ids = { requisition: e.requisitionId ?? e.ids?.requisition ?? null, advertisement: e.ids?.advertisement ?? null, platformJob: e.ids?.platformJob ?? null };
      const old = { fields: { employer: { value: e.employer } }, ids, aliases: (e.url ? [e.url] : e.aliases ?? []).map(canonicalLocal).filter(Boolean), provider: e.provider ?? 'external', account: e.account ?? '' };
      // A confirmed, different requisition number is a different vacancy and is not excluded.
      if (ids.requisition && record.ids?.requisition && key(ids.requisition) !== key(record.ids.requisition)) continue;
      if (sameIdentity(record, old)) return e;
    } catch { continue; } // A malformed history entry must never abort a scan.
  }
  return undefined;
}
export async function inRun(project, id, action, request) {
  const root = await rootAt(project);
  return locked(root, id, (state, folder) => {
    if (state.reported) throw new Error('This run already produced its immutable report; start a new incremental run');
    return action(state, new Reader(root, folder, state, request), root, folder);
  });
}
export { idKeys, SOURCES };
