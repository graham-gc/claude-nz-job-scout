import { readFile } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { load } from 'cheerio';
import { hash, put, rootAt, runId, runPath, locked } from './store.mjs';
import { Reader, charge, publicUrl } from './net.mjs';
import { criteria, contextHash } from './criteria.mjs';
import { newRecord, canonical, key, sameIdentity, formProof } from './evidence.mjs';
import { SOURCES, parseListing, resolveLead, readDetail, recognised } from './sources.mjs';

export async function start(project, input, resumePath) {
  const root = await rootAt(project), config = criteria(input), path = resolve(resumePath);
  let resume;
  if (extname(path).toLowerCase() === '.pdf') resume = (await promisify(execFile)('pdftotext', ['-layout', path, '-'], { timeout: 10000, maxBuffer: 2_000_000 })).stdout;
  else if (['.txt', '.md'].includes(extname(path).toLowerCase())) resume = await readFile(path, 'utf8');
  else throw new Error('Resume input supports PDF (pdftotext required), TXT or Markdown');
  if (resume.trim().length < 100) throw new Error('Resume text missing/too short; supply a readable resume, not invented profile data');
  const id = runId(), now = new Date().toISOString(), folder = runPath(root, id);
  const state = { schema: 1, id, startedAt: now, deadline: Date.now() + 15 * 60000, config,
    resumeHash: hash(resume), context: contextHash(config, hash(resume)), resumePath: path,
    budget: { limits: { discovery: 20, detail: 20, application: 10 }, used: { discovery: 0, detail: 0, application: 0 }, groupLimits: { boards: 12, linkedin: 3, search: 5 }, groups: { boards: 0, linkedin: 0, search: 0 } },
    attempts: [], sources: SOURCES.map(s => ({ id: s.id, url: s.url, name: s.name, status: 'not-started', reviewed: 0 })),
    records: [], cache: {}, robots: {}, blockedSources: {}, tickets: [], associations: [], warnings: [] };
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
export function merge(state, records) {
  for (const record of records) {
    const old = state.records.find(x => sameIdentity(x, record));
    if (!old) {
      const collision = state.records.find(x => x.aliases.some(u => record.aliases.includes(u)));
      if (collision) { collision.identityConflict = true; record.identityConflict = true; record.recordId = hash(state.id + record.canonicalUrl + JSON.stringify(record.ids)).slice(0, 24); }
      state.records.push(record);
    }
    else if ((old.authority !== 'registered-official' && record.authority === 'registered-official') || (old.readState !== 'read' && record.readState === 'read' && record.authority === old.authority)) {
      record.recordId = old.recordId;
      if (old.association) record.association = old.association;
      record.aliases = [...new Set([...record.aliases, ...old.aliases])];
      state.records[state.records.indexOf(old)] = record;
    } else {
      old.aliases = [...new Set([...old.aliases, ...record.aliases])];
      for (const [name, f] of Object.entries(record.fields)) if (!old.fields[name]?.value && f.value != null) old.fields[name] = f;
    }
  }
}
export async function discover(state, reader, sources = SOURCES) {
  for (const source of sources) {
    const status = state.sources.find(x => x.id === source.id);
    if (!status || status.status !== 'not-started') continue;
    try {
      const response = await reader.get(source.url, 'discovery', source.id);
      if (response.status !== 200) throw new Error(`HTTP ${response.status}; inventory not established`);
      const result = parseListing(source, response, state.id);
      merge(state, [...result.records, ...result.leads.map(l => newRecord(l, state.id))]);
      Object.assign(status, { status: 'completed', reviewed: result.returned, advertisedTotal: result.total,
        inventoryComplete: result.total !== null && result.returned >= result.total, snapshot: response.snapshot });
      if (result.total > result.returned) status.note = 'Only returned page checked; remaining inventory not fetched';
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
      readState: r.readState, authority: r.authority, url: r.canonicalUrl })),
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
  const records = error ? [] : urls.map(url => { publicUrl(url); return newRecord(resolveLead(url), state.id); });
  Object.assign(t, { status: error ? 'error' : 'completed', ...(error ? { error: String(error).slice(0, 500) } : { urls }) });
  Object.assign(state.attempts.find(a => a.id === t.id), { outcome: 'model-reported', reportedStatus: t.status });
  merge(state, records);
  return { accepted: records.length, note: 'URLs only; no webpage facts accepted from model' };
}
export async function details(state, reader, ids) {
  const out = [];
  for (const id of ids) {
    const r = state.records.find(r => r.recordId === id);
    if (!r) throw new Error(`Unknown record ID ${id}`);
    if (!r.detailAttempted) {
      r.detailAttempted = true;
      if (!(r.readState === 'read' && ['first-published', 'advertised-date'].includes(r.fields.postedAt?.semantics))) await readDetail(r, reader);
      else r.detailNote = 'Reused complete current-run ATS inventory evidence; no duplicate detail request';
    }
    out.push(r);
  }
  // Merge only after identities are confirmed, preserving all canonical aliases.
  const all = state.records; state.records = []; merge(state, all);
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
  r.association = { officialUrl: response.url, observedAt: response.observedAt, snapshot: response.snapshot, linkedUrls: found };
  state.associations.push(r.association);
  return r.association;
}
export async function inventory(state, reader, recordId, officialUrl) {
  const r = state.records.find(x => x.recordId === recordId);
  if (!r) throw new Error('Unknown record ID');
  if (!r.association) await associate(state, reader, recordId, officialUrl);
  const shape = recognised(r.canonicalUrl), { account, provider } = shape;
  const url = provider === 'greenhouse' ? `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(account)}/jobs?content=true`
    : provider === 'lever' ? `https://api.lever.co/v0/postings/${encodeURIComponent(account)}?mode=json`
      : provider === 'smartrecruiters' ? `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(account)}/postings?limit=100` : null;
  if (!url) throw new Error('Employer association saved, but this inventory format is not implemented; report a blind spot');
  const id = `${provider}:${account.toLowerCase()}`;
  const prior = state.sources.find(x => x.id === id || (x.url === url && x.status !== 'not-started'));
  if (prior) return prior;
  const source = { id, name: r.fields.employer?.value ?? `Unconfirmed employer (${account})`, employer: r.fields.employer?.value ?? null, provider, account, url, association: r.association };
  state.sources.push({ id, name: source.name, url, status: 'not-started', reviewed: 0 });
  await discover(state, reader, [source]);
  return state.sources.find(s => s.id === id);
}
export async function verifyApplication(record, reader) {
  if (record.application.status === 'verified') return;
  if (record.authority !== 'registered-official') { record.application.reason = 'Employer association unconfirmed'; return; }
  const urls = [...new Set([record.canonicalUrl, record.applicationUrl, ...(record.applyLinks ?? []).map(x => x.url)].filter(Boolean))];
  for (const url of urls.slice(0, 3)) {
    try {
      const response = await reader.get(url, 'application', record.sourceKey);
      const proof = formProof(record, response);
      if (proof) { record.application = { status: 'verified', ...proof }; return; }
      record.application.reason = `No bound, job-specific form observed at ${response.url} (HTTP ${response.status})`;
      // Email instructions must be on the same, fully read primary vacancy, not a contact page.
      if (record.emailRoute && record.readState === 'read' && canonical(response.url) === record.canonicalUrl && response.status === 200) {
        record.application = { status: 'verified', kind: 'email', ...record.emailRoute }; return;
      }
    } catch (e) { record.application.reason = e.message; }
  }
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
  return exclusions.find(e => {
    const ids = { requisition: e.requisitionId ?? e.ids?.requisition ?? null, advertisement: e.ids?.advertisement ?? null, platformJob: e.ids?.platformJob ?? null };
    const old = { fields: { employer: { value: e.employer } }, ids, aliases: e.url ? [canonical(e.url)] : e.aliases ?? [], provider: e.provider ?? 'external', account: e.account ?? '' };
    return sameIdentity(record, old);
  });
}
export async function inRun(project, id, action, request) {
  const root = await rootAt(project);
  return locked(root, id, (state, folder) => {
    if (state.reported) throw new Error('This run already produced its immutable report; start a new incremental run');
    return action(state, new Reader(root, folder, state, request), root, folder);
  });
}
