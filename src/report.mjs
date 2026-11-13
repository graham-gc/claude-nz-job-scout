import { join } from 'node:path';
import { lstat } from 'node:fs/promises';
import { readJson, put, reports, hash, runStates } from './store.mjs';
import { nzDate, classify, hardChecks } from './criteria.mjs';
import { idKeys } from './evidence.mjs';
import { excluded, validateJudgments, verifyApplication, applicationPlan, requestLedger } from './engine.mjs';

const esc = text => String(text ?? '').replace(/[\[\]<>*_`|]/g, x => `\\${x}`).replace(/\s+/g, ' ').trim();
// Values are shown in words, never as raw JSON.
const fmtValue = value => {
  if (value == null) return 'Not stated';
  if (Array.isArray(value)) return value.map(fmtValue).join(', ');
  if (typeof value === 'object') return Object.entries(value).map(([k, v]) => `${k}=${fmtValue(v)}`).join(', ');
  return String(value);
};
const link = (title, url) => `[${esc(title)}](<${new URL(url).href}>)`;
// The request ledger in words: every request of the project, how many runs it
// holds and what it spent. A request that opens a fresh budget is visible
// here, so a reset cannot pass unnoticed.
function requestLedgerText(ledger) {
  if (!ledger) return '(not recorded)';
  const parts = (ledger.requests ?? []).map(r => `requestId ${esc(r.requestId)} (${r.runs} runs; discovery ${r.spent?.used?.discovery ?? 0} / detail ${r.spent?.used?.detail ?? 0} / application ${r.spent?.used?.application ?? 0}; started ${esc(r.startedAt ?? 'not recorded')})`);
  if (ledger.legacy?.runs) parts.push(`Legacy runs without request IDs (${ledger.legacy.runs} runs; discovery ${ledger.legacy.spent?.used?.discovery ?? 0} / detail ${ledger.legacy.spent?.used?.detail ?? 0} / application ${ledger.legacy.spent?.used?.application ?? 0}) are not charged to any request`);
  return parts.length ? parts.join('; ') : 'No requests have been opened in this project';
}
const value = (r, name) => r.fields[name]?.value ?? 'Not stated / not read';
const material = item => hash({ ids: item.record.ids, fields: Object.fromEntries(Object.entries(item.record.fields).map(([k, v]) => [k, v.value])),
  application: { status: item.record.application?.status, kind: item.record.application?.kind, url: item.record.application?.url, email: item.record.application?.email }, category: item.category, fit: item.judgment?.fit });

export function coverage(state) {
  const http = state.attempts.filter(a => a.kind === 'http'), received = http.filter(a => a.status === 200 && !/robots\.txt$/.test(a.url));
  if (!http.length && !state.tickets.some(t => t.status !== 'pending')) return 'not-started';
  if (!received.length && !state.tickets.some(t => t.status === 'completed')) return 'blocked';
  const inventoryDone = state.sources.every(s => s.status === 'completed' && s.inventoryComplete);
  return inventoryDone && state.tickets.some(t => t.status === 'completed') && state.records.every(r => r.readState === 'read') ? 'complete' : 'partial';
}

// --- readable obstacles ------------------------------------------------------
// Checks may carry nested alternatives; the report shows what failed, in words.
export function readableCheck(check) {
  const name = esc(check.name), status = check.status;
  const render = detail => {
    if (detail == null) return '';
    if (typeof detail === 'string') return esc(detail);
    if (Array.isArray(detail)) {
      if (detail.every(x => x && typeof x === 'object' && 'status' in x)) {
        return detail.map(x => `${esc(x.name)}=${x.status}`).join(', ');
      }
      if (detail.every(Array.isArray)) {
        return detail.map((group, i) => `Alternative ${i + 1}[${group.map(x => `${esc(x.name)}=${x.status}`).join(', ')}]`).join('; ');
      }
      return detail.map(x => esc(fmtValue(x))).join('; ');
    }
    if (detail && typeof detail === 'object') return esc(fmtValue(detail));
    return esc(fmtValue(detail));
  };
  const label = status === 'conflict' ? 'conflict' : status === 'satisfied' ? 'satisfied' : 'unknown';
  return `${name} (${label}): ${render(check.detail)}`;
}
function obstacles(item) {
  return item.checks.filter(c => c.status !== 'satisfied').map(readableCheck);
}
function unreadReason(record) {
  const bits = [];
  if (record.readState !== 'read') bits.push(`Posting read state: ${record.readState}`);
  if (record.detailError) bits.push(`Read issue: ${record.detailError}`);
  if (record.gaps?.length) bits.push(`Missing fields: ${record.gaps.join(', ')}`);
  if (record.authority !== 'registered-official') bits.push('Employer website association not verified');
  if (record.closure) bits.push(`Closure evidence (${record.closure.scope}): ${record.closure.quote ?? ''}`);
  return bits.join('; ');
}
// Every record is left in its own state. "Unassessed" alone says nothing about
// why a record was not assessed, so each record carries the status this run
// actually reached: read or not, from which page, and what is still unknown.
export function leadStatus(record) {
  const r = record ?? {};
  if (r.readState === 'read') {
    if (r.authority === 'registered-official') return 'Employer posting read: website association verified';
    if (r.closure) return 'Mirror read: mirror advertisement expired; employer vacancy status unknown';
    return 'Source page read: employer website association and original posting not verified';
  }
  if (r.readState === 'closed-stated') return 'Page read: the page states that this advertisement is closed';
  if (r.readState === 'partial') return `Partially read: ${r.detailError ?? 'incomplete fields'}`;
  if (r.readState === 'unreadable') return `Read attempted but not verifiable: ${r.detailError ?? 'page could not be verified'}`;
  if (r.readState === 'not-read') return r.detailError ? `Not read: ${r.detailError}` : 'Read not attempted';
  return `State: ${r.readState ?? 'unknown'}`;
}
// A record without a title is still identifiable: its own address is shown.
export function leadLabel(record) {
  const r = record ?? {};
  const title = r.fields.title?.value ?? r.lead?.title;
  if (title) return title;
  try { const u = new URL(r.canonicalUrl); return `${u.hostname}${u.pathname}`; } catch { return String(r.canonicalUrl ?? 'Unknown page'); }
}

// --- preferences -------------------------------------------------------------
// Preferences are executable rules over recorded facts. Their basis is stated.
const PREFERENCE_RULES = [
  { re: /\bremote\b/i, check: r => r.fields.workArrangement?.value === 'remote' || /\bremote\b/i.test(r.fields.location?.value ?? ''), basis: r => `workArrangement=${r.fields.workArrangement?.value ?? 'not read'}; location=${r.fields.location?.value ?? 'not read'}` },
  { re: /\bhybrid\b/i, check: r => r.fields.workArrangement?.value === 'hybrid', basis: r => `workArrangement=${r.fields.workArrangement?.value ?? 'not read'}` },
  { re: /\bon[\s-]?site\b/i, check: r => r.fields.workArrangement?.value === 'on-site', basis: r => `workArrangement=${r.fields.workArrangement?.value ?? 'not read'}` },
  { re: /\bpermanent\b/i, check: r => r.fields.contractType?.value === 'permanent', basis: r => `contractType=${r.fields.contractType?.value ?? 'not read'}` },
  { re: /\bfixed[\s-]?term\b/i, check: r => r.fields.contractType?.value === 'fixed-term', basis: r => `contractType=${r.fields.contractType?.value ?? 'not read'}` },
  { re: /\bfull[\s-]?time\b/i, check: r => r.fields.workload?.value === 'full-time', basis: r => `workload=${r.fields.workload?.value ?? 'not read'}` },
  { re: /\bpart[\s-]?time\b/i, check: r => r.fields.workload?.value === 'part-time', basis: r => `workload=${r.fields.workload?.value ?? 'not read'}` },
  { re: /\bintern(ship)?\b/i, check: r => /intern/i.test(`${r.fields.title?.value ?? ''} ${r.lead.title ?? ''}`), basis: r => `title=${r.fields.title?.value ?? r.lead.title ?? 'not read'}` },
  { re: /\bsalary\b/i, check: r => !!r.fields.salary?.value, basis: r => `salary=${r.fields.salary?.value ?? 'not read'}` },
  { re: /\bnot volunteer\b|paid role/i, check: r => r.fields.engagement?.value && r.fields.engagement.value !== 'volunteer', basis: r => `engagement=${r.fields.engagement?.value ?? 'not read'}` },
  { re: /\bvolunteer\b/i, check: r => r.fields.engagement?.value === 'volunteer', basis: r => `engagement=${r.fields.engagement?.value ?? 'not read'}` }
];
const CITY_RULE = { re: /\b(auckland|wellington|christchurch|hamilton|tauranga|dunedin|napier|queenstown|palmerston north|new plymouth|whangarei|invercargill)\b/i };
export function preferenceVerdicts(record, preferences = []) {
  return preferences.map(text => {
    const rule = PREFERENCE_RULES.find(r => r.re.test(text));
    if (rule) {
      const ok = rule.check(record);
      return { text, status: ok ? 'satisfied' : 'conflict', basis: rule.basis(record) };
    }
    const city = text.match(CITY_RULE.re);
    if (city) {
      const location = record.fields.location?.value ?? '';
      return { text, status: new RegExp(city[0], 'i').test(location) ? 'satisfied' : 'conflict', basis: `location=${location || 'not read'}` };
    }
    return { text, status: 'unknown', basis: 'No executable preference rule; this preference does not affect ranking' };
  });
}
export function preferenceScore(record, preferences = []) {
  const verdicts = preferenceVerdicts(record, preferences);
  return { satisfied: verdicts.filter(v => v.status === 'satisfied').length, verdicts };
}

function jobLines(item, preferences = []) {
  const { record: r, judgment: j, checks } = item;
  const title = value(r, 'title') === 'Not stated / not read' ? r.lead.title || 'Unconfirmed role' : value(r, 'title');
  const employer = r.fields.employer?.value ?? r.lead.employer ?? 'Unconfirmed employer';
  const lines = [`### ${esc(title)} — ${esc(employer)}`, '', `- Location / arrangement: ${esc(value(r, 'location'))} · ${esc(value(r, 'workArrangement'))}`,
    `- Work type: ${esc(value(r, 'engagement'))} · ${esc(value(r, 'contractType'))} · ${esc(value(r, 'workload'))} · ${esc(value(r, 'hoursPerWeek'))} hours/week`,
    `- Duration: ${esc(r.fields.duration?.value ? `${r.fields.duration.value.amount} ${r.fields.duration.value.unit}` : 'Not stated / not read')} (original unit; no conversion)`,
    `- Published: ${esc(value(r, 'postedAt'))}${r.fields.postedAt?.semantics ? ` (${esc(r.fields.postedAt.semantics)})` : ''}; closes: ${esc(value(r, 'closesAt'))}`,
    `- Salary: ${esc(value(r, 'salary'))}; pay status: ${esc(r.fields.payStatus?.value ?? 'unknown')}${r.fields.engagement?.value === 'volunteer' ? ' · **Volunteer**' : ''}`,
    `- Match assessment: ${esc(j?.fit ?? 'unassessed')}. ${(j?.reasons ?? [item.reason]).map(esc).join('; ')}`];
  if (r.relativePublication?.text) lines.push(`- Relative publication wording (verbatim): ${esc(r.relativePublication.text)}; source ${esc(r.relativePublication.source?.url ?? 'not read')}, observed ${esc(r.relativePublication.source?.observedAt ?? 'not read')}; not converted into an exact first-publication date.`);
  if (r.application?.status === 'verified') {
    if (r.application.kind === 'email-in-posting') lines.push(`- Apply by email to **${esc(r.application.email)}**. Instructions in the posting: ${esc(r.application.instruction)}`);
    else if (r.application.kind === 'job-specific-external-ats') lines.push(`- **${link('Apply (external ATS)', r.application.url)}** (job-specific application page read; nothing submitted)`);
    else lines.push(`- **${link('Apply directly', r.application.url)}** (job-specific form read; nothing submitted)`);
  } else lines.push(`- Application route not verified (${esc(r.application?.status ?? 'not-checked')}): ${esc(r.application?.reason ?? 'Not checked')}. The link below is not a verified application route.`);
  lines.push(`- ${link('Vacancy details', r.canonicalUrl)}`);
  const obs = obstacles(item);
  if (obs.length) lines.push(`- Main obstacles: ${obs.join('; ')}`);
  if (r.conflicts?.length) lines.push(`- Merge conflicts: ${r.conflicts.slice(0, 3).map(c => `${esc(c.field)} kept ${esc(fmtValue(c.kept))}; also observed ${esc(fmtValue(c.discarded))}`).join('; ')}`);
  if (r.closure) lines.push(`- Closure evidence (${esc(r.closure.scope)}, observed ${esc(r.closure.observedAt ?? 'not read')}): ${esc(r.closure.quote ?? '')}`);
  if (r.opportunityKind?.value === 'talent-pool') lines.push('- This is a talent pool, not a confirmed vacancy or interview opportunity; it is not counted as an open role.');
  if (preferences.length) {
    const { verdicts } = preferenceScore(r, preferences);
    lines.push(`- Preference evidence: ${verdicts.map(v => `${esc(v.text)} -> ${v.status === 'satisfied' ? 'satisfied' : v.status === 'conflict' ? 'conflict' : 'unknown'} (${esc(v.basis)})`).join('; ')}`);
  }
  const evidence = Object.entries(r.fields).filter(([k, f]) => k !== 'duties' && f.source).map(([name, f]) => `${esc(name)} -> ${link('source', f.source.url)}`);
  lines.push(`- Record: \`${r.recordId}\`; field evidence: ${evidence.join('; ')}`, '');
  return lines;
}
// A recruitment channel is disclosed with its own evidence. It never looks
// like a job: no application route is claimed for it.
function channelLines(item) {
  const { record: r } = item;
  const title = value(r, 'title') === 'Not stated / not read' ? r.lead.title || 'Unconfirmed channel' : value(r, 'title');
  const employer = r.fields.employer?.value ?? r.lead.employer ?? 'Unconfirmed employer';
  const lines = [`- ${esc(title)} — ${esc(employer)}: ${esc(item.reason ?? '')}`];
  const obs = obstacles(item);
  if (obs.length) lines.push(`  - Obstacles: ${obs.join('; ')}`);
  const unread = unreadReason(r);
  if (unread) lines.push(`  - Read limitations: ${esc(unread)}`);
  lines.push(`  - Page: ${link('Channel page', r.canonicalUrl)}`, `  - Record: \`${r.recordId}\``);
  return lines;
}
export function render(report) {
  const { state, items, newItems, overflow = [], withdrawals, pendingHistory } = report;
  const record = id => report.records[id];
  const preferences = state.config.preferences ?? [];
  const lines = ['# New Zealand Job Scout', '', `Generated: ${report.generatedAt} · Pacific/Auckland date ${report.date}`, '',
    `Resume read; role families: ${state.config.roleFamilies.map(esc).join(', ')}; first-publication window: ${state.config.postingDays} days.`,
    `Coverage: **${report.coverage}** (this run's plan only, not the whole market).`, ''];
  // Disclosures are sentences: each one is printed in full.
  for (const text of (state.config.disclosures ?? [])) lines.push(`- Criteria disclosure: ${esc(text)}`);
  if ((state.config.disclosures ?? []).length) lines.push('');
  lines.push('## Recommendations', '');
  for (const [category, name] of [['ready', 'Ready to apply'], ['check', 'Worth confirming'], ['unresolved', 'High-value leads: authoritative posting not fully verified'], ['pool', 'Talent pools: not confirmed vacancies']]) {
    lines.push(`### ${name}`, '');
    const section = newItems.filter(i => i.category === category);
    if (section.length) for (const item of section) lines.push(...jobLines({ ...item, record: record(item.recordId) }, preferences));
    else lines.push(category === 'ready' ? 'No new verified roles with usable application routes were found in accessible sources.' : 'No new items in this run.', '');
  }
  const channels = items.filter(i => i.category === 'channel');
  if (channels.length) {
    lines.push('## Channels to check (employer-facing, not job recommendations)', '',
      'These recruitment events or platform pages address employers, not applicants. They are not confirmed vacancies and no candidate entry point was verified in this run. They are disclosed as channels to check, not recommendations, and are not counted as jobs.', '');
    for (const item of channels) lines.push(...channelLines({ ...item, record: record(item.recordId) }));
    lines.push('');
  }
  if (overflow.length) {
    lines.push('## Other records in this run (ID index; full fields in the JSON sidecar)', '');
    for (const item of overflow) {
      const r = record(item.recordId);
      lines.push(`- \`${item.recordId}\` ${esc(r.fields.title?.value ?? r.lead.title)} — ${esc(r.fields.employer?.value ?? r.lead.employer)}: ${esc(item.reason ?? item.category)}`);
    }
    lines.push('');
  }
  lines.push('## Diagnostics (not recommended; not necessarily unsuitable)', '');
  const diagnostics = items.filter(i => ['excluded', 'closed', 'decided', 'identity-anomaly', 'unassessed', 'mirror-expired'].includes(i.category));
  const shown = diagnostics.slice(0, 15), diagnosticOverflow = diagnostics.slice(15);
  for (const item of shown) {
    const r = record(item.recordId);
    const employer = r.fields.employer?.value ?? r.lead.employer;
    const head = employer ? `${esc(leadLabel(r))} — ${esc(employer)}` : esc(leadLabel(r));
    lines.push(`- ${head}: ${esc(item.reason)}`);
    lines.push(`  - Current-run status: ${esc(leadStatus(r))}`);
    const obs = obstacles(item);
    if (obs.length) lines.push(`  - Obstacles: ${obs.join('; ')}`);
    const unread = unreadReason(r);
    if (unread && ['unassessed', 'identity-anomaly', 'mirror-expired', 'closed'].includes(item.category)) lines.push(`  - Read limitations: ${esc(unread)}`);
    lines.push(`  - Page: ${link('Page', r.canonicalUrl)}`, `  - Record: \`${r.recordId}\``);
  }
  if (diagnosticOverflow.length) {
    lines.push('', `Remaining ${diagnosticOverflow.length} diagnostic records by ID (full fields in the JSON sidecar):`, '');
    for (const item of diagnosticOverflow) {
      const r = record(item.recordId);
      const employer = r.fields.employer?.value ?? r.lead.employer;
      const head = employer ? `${esc(leadLabel(r))} — ${esc(employer)}` : esc(leadLabel(r));
      lines.push(`- \`${r.recordId}\` ${head}: ${esc(item.reason)} | Current-run status: ${esc(leadStatus(r))}`);
    }
  }
  lines.push('', '## Status changes and deduplication', '');
  for (const w of withdrawals) lines.push(`- Withdrawn previous ${w.scope === 'advertisement' ? 'advertisement' : 'role'}: ${esc(w.title)} — ${esc(w.employer)}. ${esc(w.reason)} (historical reports unchanged)`);
  if (pendingHistory.length) lines.push(`- ${pendingHistory.length} historical recommendations were not reverified in this run; this does not mean they are closed.`);
  // Each record reports the state this run actually reached. A single
  // "unread" total hides whether a link was never tried, could not be
  // verified, or was read from a mirror whose original posting is unknown.
  const statusCounts = new Map();
  for (const r of Object.values(report.records)) {
    const s = leadStatus(r);
    statusCounts.set(s, (statusCounts.get(s) ?? 0) + 1);
  }
  lines.push(`- Previously decided exclusions: ${items.filter(i => i.category === 'decided').length}; unchanged items not repeated: ${report.unchanged}.`,
    `- Recruitment channels to check: ${channels.length} (employer-facing pages, not recommendations or jobs).`,
    `- Discovered ${Object.keys(report.records).length} records; assessed ${items.filter(i => i.judgment).length}; unassessed ${items.filter(i => i.category === 'unassessed').length}. Unassessed does not mean unsuitable.`,
    `- Current-run status tally: ${[...statusCounts].map(([s, n]) => `${s}: ${n}`).join('; ')}.`,
    '', '## Sources and budget', '');
  for (const s of state.sources) lines.push(`- ${link(s.name, s.url)}: ${s.status}; actually read ${s.reviewed}${s.advertisedTotal != null ? ` / advertised ${s.advertisedTotal}` : ''}. ${esc(s.reason ?? s.note ?? '')}`);
  const budget = state.budget, groups = budget.groups ?? {}, limits = budget.limits ?? {};
  const stageGroups = budget.stageGroups ?? {};
  const stageRobots = budget.stageRobots ?? {};
  // Each stage prints its own ledger, taken from the same run's counters.
  const stageLine = (stage, label) => {
    const g = stageGroups[stage] ?? { boards: 0, linkedin: 0, search: 0 };
    const r = stageRobots[stage] ?? { boards: 0, linkedin: 0, search: 0 };
    return `${label} ${budget.used[stage] ?? 0}/${limits[stage] ?? 0} (boards ${g.boards ?? 0}, including robots.txt ${r.boards ?? 0}; linkedin ${g.linkedin ?? 0}, including robots.txt ${r.linkedin ?? 0}; search ${g.search ?? 0}, including robots.txt ${r.search ?? 0})`;
  };
  const request = state.request ?? null;
  lines.push(`- WebSearch: ${state.tickets.length ? state.tickets.map(t => `ticket ${t.id}: ${t.status}${t.error ? ` (${esc(t.error)})` : ''}`).join('; ') : 'not-started'}. Search results are reported by the model; upstream internal requests are not observable.`,
    `- Observable calls / reserved tickets (${request ? 'request totals including this run' : 'this run'}): ${stageLine('discovery', 'Discovery')}; ${stageLine('detail', 'Detail')}; ${stageLine('application', 'Application')}. Total robots.txt reads: ${budget.robotsUsed ?? 0}; redirects and robots reads are included above, with no separate robots ceiling.`);
  if (request) {
    const own = request.own?.used ?? request.own ?? {};
    lines.push(`- Current request (requestId ${esc(request.requestId ?? '')}, ${request.kind === 'new' ? 'new request' : 'continuation'}): all runs share one observable-call budget (discovery ${limits.discovery ?? 20} / detail ${limits.detail ?? 20} / application ${limits.application ?? 10}). This is run ${request.runIndex}/${request.maxRuns}; opening another run does not reset the budget. Only one run may be active per request. A report ends the run; use end --run RUN_ID to close an abandoned run before continuing. Use start --new-request only for a new scan explicitly requested by the user; its budget is independent and does not carry over prior spend. This run used: discovery ${own.discovery ?? 0}, detail ${own.detail ?? 0}, application ${own.application ?? 0}.`,
      `- Project request ledger: ${requestLedgerText(report.ledger)}`,
      `- Network time used: ${Math.round((state.networkSpentMs ?? 0) / 1000)} seconds / ${Math.round((state.networkBudgetMs ?? 0) / 1000)} seconds; model thinking time is excluded.`,
      `- ${esc(report.stopReason)}; no authenticated browsing, application submission, resume upload, or email sending occurred in this run.`);
  }
  for (const w of state.warnings) lines.push(`- ${esc(w)}`);
  lines.push('', `<!-- nz-job-scout-v1 run=${state.id} context=${state.context} -->`, '');
  return lines.join('\n');
}
export async function produce(root, state, reader, input, now = new Date().toISOString()) {
  const judgments = validateJudgments(input, state), oldState = await readJson(join(root, '.nz-job-scout-state.json'), {});
  const exclusions = [...(oldState.excludedRoles ?? []), ...state.config.exclusions];
  // Verification order: hard conditions already satisfied first, then a few
  // high-value unknowns. Unverified jobs never become recommendations.
  const plan = applicationPlan(state, judgments, exclusions, now);
  for (const record of plan) await verifyApplication(record, reader);
  const preferences = state.config.preferences ?? [];
  const items = state.records.map(record => {
    const judgment = judgments.find(j => j.recordId === record.recordId), prior = excluded(record, exclusions);
    const base = prior ? { category: 'decided', checks: [], reason: `Previously ${prior.decision ?? 'excluded'}; ${prior.reason ?? ''}` } : classify(record, state.config, judgment, now);
    const { satisfied } = preferenceScore(record, preferences);
    return { recordId: record.recordId, record, judgment, ...base, preferenceScore: satisfied };
  });
  // The sidecar stores each record once; items refer to it by ID.
  const records = Object.fromEntries(items.map(i => [i.recordId, i.record]));
  const items2 = items.map(i => { const { record, ...rest } = i; return { ...rest, identity: idKeys(record), material: material({ ...i }) }; });
  const history = (await reports(root)).filter(r => r.context === state.context && Date.parse(now) - Date.parse(r.generatedAt) <= 30 * 86400000).sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
  const previous = [];
  for (const report of history) for (const item of report.items ?? []) if (!previous.some(p => overlap(p.identity, item.identity))) previous.push(item);
  const withdrawals = [], pendingHistory = [];
  for (const old of previous.filter(i => ['ready', 'check', 'pool', 'unresolved'].includes(i.category))) {
    const match = items2.find(i => overlap(i.identity, old.identity));
    const r = match ? records[match.recordId] : null;
    if (r?.closure) withdrawals.push({ title: r.fields.title?.value ?? r.lead.title, employer: r.fields.employer?.value ?? r.lead.employer, scope: r.closure.scope, reason: r.closure.quote });
    else if (!r || r.readState !== 'read') pendingHistory.push(old.recordId);
  }
  const promoted = items2.filter(i => ['ready', 'check', 'pool', 'unresolved'].includes(i.category));
  // Channels are disclosed on their own, never promoted.
  const channels = items2.filter(i => i.category === 'channel');
  const allNew = promoted.filter(i => !previous.some(p => p.material === i.material))
    .sort((a, b) => (a.judgment?.fit === 'strong' ? 0 : 1) - (b.judgment?.fit === 'strong' ? 0 : 1) || b.preferenceScore - a.preferenceScore);
  const visible = [], counts = {};
  for (const item of allNew) { counts[item.category] = (counts[item.category] ?? 0) + 1; if (item.category === 'ready' || counts[item.category] <= 5) visible.push(item); }
  // Overflowing records stay out of the promoted lists, but they are still indexed
  // so that every record of this run can be traced by ID.
  const overflow = allNew.filter(i => !visible.includes(i))
    .map(i => ({ recordId: i.recordId, category: i.category, fit: i.judgment?.fit ?? null, reason: i.reason }));
  if (overflow.length) state.warnings.push(`${overflow.length} additional records of this run are kept in the JSON sidecar and indexed in this report; they are not promoted to recommendations.`);
  const budgetShort = Object.keys(state.budget.used).filter(k => state.budget.used[k] >= state.budget.limits[k]);
  const stopReason = budgetShort.length ? `Stage budget reached (${budgetShort.map(k => `${k} ${state.budget.used[k]}/${state.budget.limits[k]}`).join(', ')}); later-stage allowances were not consumed` : 'Finished with the available evidence; incomplete sources and unassessed records are disclosed';
  const { records: _drop, ...stateWithoutRecords } = state;
  const ledger = requestLedger(await runStates(root));
  const report = { format: 'nz-job-scout-report-v1', generatedAt: now, date: nzDate(now), context: state.context,
    coverage: coverage(state), state: stateWithoutRecords, records, items: items2, newItems: visible, overflow, withdrawals, pendingHistory,
    unchanged: promoted.filter(i => previous.some(p => p.material === i.material)).length,
    ledger, stopReason };
  const base = `nz-jobs-${report.date}`;
  const occupied = await lstat(join(root, 'output', `${base}.md`)).catch(e => { if (e.code !== 'ENOENT') throw e; });
  const name = occupied ? `${base}-${state.id.slice(0, 8)}` : base;
  const json = join(root, 'output', `${name}.json`), md = join(root, 'output', `${name}.md`);
  // The sidecar stores each record and each assessment once: the promoted list
  // is an index of record IDs, not a second copy of the item.
  await put(root, json, { ...report, newItems: visible.map(i => ({ recordId: i.recordId, category: i.category, fit: i.judgment?.fit ?? null })) });
  await put(root, md, render(report));
  state.reported = { json, md };
  return { report: md, records: json, coverage: report.coverage, ready: visible.filter(i => i.category === 'ready').length, needsChecking: visible.filter(i => ['check', 'unresolved'].includes(i.category)).length, channels: channels.length, withdrawals: withdrawals.length };
}
function overlap(a = [], b = []) {
  const set = new Set(a);
  return b.some(x => set.has(x));
}
