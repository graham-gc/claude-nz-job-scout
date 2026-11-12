import { hash } from './store.mjs';
import { key } from './evidence.mjs';
import { closureBoundToAdvertisement } from './evidence.mjs';
import { foreignScope, isForeignPlace, nzPlace, remoteScope, REMOTE_ONLY } from './places.mjs';

export const nzDate = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
const dayNumber = date => Date.parse(`${date}T00:00:00Z`) / 86400000;
const fields = new Set(['location', 'workArrangement', 'hoursPerWeek', 'engagement', 'contractType', 'duration', 'durationWeeks', 'durationMonths', 'startAt', 'endAt', 'workRights']);
export function criteria(input) {
  if (!input || !Array.isArray(input.roleFamilies) || !input.roleFamilies.length || input.roleFamilies.some(x => typeof x !== 'string' || !x.trim())) throw new Error('roleFamilies must contain the requested role families');
  const disclosures = [];
  const location = input.location ?? { country: 'New Zealand', onsiteCities: [], remoteOutside: true };
  if (!input.location) disclosures.push('未提供 location：地区按国家层级（New Zealand）判定，未默认任何城市；城市级匹配需显式提供 onsiteCities。');
  const result = { roleFamilies: input.roleFamilies, postingDays: input.postingDays ?? 7,
    location: { country: location.country ?? 'New Zealand', onsiteCities: location.onsiteCities ?? [], remoteOutside: location.remoteOutside !== false },
    all: input.all ?? [], any: input.any ?? [], preferences: input.preferences ?? [], exclusions: input.exclusions ?? [],
    includeTalentPools: input.includeTalentPools === true, disclosures };
  if (!Number.isInteger(result.postingDays) || result.postingDays < 1 || result.postingDays > 365) throw new Error('postingDays must be 1–365');
  if (result.location.country !== 'New Zealand') throw new Error('location needs country New Zealand');
  if (!Array.isArray(result.location.onsiteCities) || result.location.onsiteCities.some(c => typeof c !== 'string' || !c.trim())) throw new Error('location.onsiteCities must be a list of city names (may be empty)');
  if (typeof result.location.remoteOutside !== 'boolean') throw new Error('location needs country New Zealand, onsiteCities and remoteOutside');
  if (!Array.isArray(result.all) || !Array.isArray(result.any) || result.any.some(g => !Array.isArray(g) || !g.length)) throw new Error('all is a list of conditions; any is a list of nonempty alternative condition lists');
  for (const c of [...result.all, ...result.any.flat()]) {
    if (!c || !fields.has(c.field) || !['eq', 'in', 'lte', 'gte', 'contains'].includes(c.op) || c.value == null) throw new Error('Invalid condition: see references/input.md for fields and operators');
    if (c.op === 'in' && (!Array.isArray(c.value) || !c.value.length)) throw new Error('in requires a nonempty array');
    if (['lte', 'gte'].includes(c.op) && typeof c.value !== 'number' && !/^\d{4}-\d{2}-\d{2}$/.test(c.value)) throw new Error('lte/gte require a number or ISO date');
    if (['duration', 'durationWeeks', 'durationMonths'].includes(c.field) && c.valueUnit && !['weeks', 'months'].includes(c.valueUnit)) throw new Error('valueUnit must be weeks or months');
  }
  if (!result.location.onsiteCities.length) disclosures.push('location.onsiteCities 为空：不会把任何城市判为冲突。');
  return result;
}
export const contextHash = (criteria, resumeHash) => hash({ criteria, resumeHash });
const verdict = (name, status, detail) => ({ name, status, detail });

// Duration keeps its own unit. Weeks are never converted into months, or months into weeks.
export function durationValue(record, field) {
  const d = record.fields.duration?.value;
  if (!d || typeof d !== 'object') return { amount: null, unit: null };
  if (field === 'durationWeeks') return d.unit === 'weeks' ? { amount: d.amount, unit: 'weeks' } : { amount: null, unit: d.unit };
  if (field === 'durationMonths') return d.unit === 'months' ? { amount: d.amount, unit: 'months' } : { amount: null, unit: d.unit };
  return { amount: d.amount, unit: d.unit };
}
export function condition(record, c) {
  const name = c.label ?? c.field;
  if (['duration', 'durationWeeks', 'durationMonths'].includes(c.field)) {
    const { amount, unit } = durationValue(record, c.field);
    if (amount == null) return verdict(name, 'unknown', `duration not stated in the requested unit (${unit ?? 'none stated'}); no conversion is applied`);
    const wanted = c.valueUnit ?? (c.field === 'durationMonths' ? 'months' : 'weeks');
    if (unit !== wanted) return verdict(name, 'unknown', `${amount} ${unit} stated; the condition is expressed in ${wanted}; no conversion is applied`);
    const pass = c.op === 'lte' ? amount <= c.value : c.op === 'gte' ? amount >= c.value : c.op === 'eq' ? amount === c.value : String(amount).includes(String(c.value));
    return verdict(name, pass ? 'satisfied' : 'conflict', `${amount} ${unit} ${c.op} ${JSON.stringify(c.value)}`);
  }
  const v = record.fields[c.field]?.value;
  if (v == null) return verdict(name, 'unknown', `${c.field} not stated/read`);
  const pass = c.op === 'eq' ? key(v) === key(c.value) : c.op === 'in' ? c.value.some(x => key(x) === key(v))
    : c.op === 'contains' ? key(v).includes(key(c.value)) : c.op === 'lte' ? v <= c.value : v >= c.value;
  return verdict(name, pass ? 'satisfied' : 'conflict', `${v} ${c.op} ${JSON.stringify(c.value)}`);
}

// A posting that names a place outside the requested country has stated its
// location, so it is a conflict rather than an unknown. A posting that names
// only "Remote" has not stated where it hires, so it stays unknown. A remote
// posting that names its own scope ("Remote (US)", "Remote, Latin America")
// has stated where it hires too.
export function locationVerdict(record, config) {
  const location = (record.fields.location?.value ?? '').trim();
  const arrangement = record.fields.workArrangement?.value;
  if (!location) return verdict('Location', 'unknown', 'Job location not stated/read');
  if (isForeignPlace(location)) return verdict('Location', 'conflict', `Location outside New Zealand: ${location}`);
  if (REMOTE_ONLY.test(location)) return verdict('Location', 'unknown', `Remote only; the posting does not state whether the employer hires in ${config.location.country}`);
  const scope = remoteScope(location);
  if (scope) {
    if (nzPlace(scope)) return verdict('Location', 'satisfied', `${location}; remote work covers ${scope}`);
    const outside = foreignScope(scope);
    if (outside) return verdict('Location', 'conflict', `Remote work is limited to ${scope}; it does not cover ${config.location.country}`);
    return verdict('Location', 'unknown', `Remote scope "${scope}" is not a recognised hiring region; treated as unknown, not as a match`);
  }
  if (!nzPlace(location)) return verdict('Location', 'unknown', `Region not parsed from "${location}"; treated as unknown, not as a match`);
  const cities = config.location.onsiteCities ?? [];
  if (!cities.length) return verdict('Location', 'satisfied', `In ${config.location.country} and no specific city was requested: ${location}`);
  const inCity = cities.some(c => new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').trim()}\\b`, 'i').test(location));
  if (inCity) return verdict('Location', 'satisfied', location);
  if (arrangement === 'remote' && config.location.remoteOutside) return verdict('Location', 'satisfied', `${location}; role is stated as remote and remote work is allowed`);
  return verdict('Location', 'conflict', `In ${config.location.country} but not in the requested cities (${cities.join(', ')}): ${location}`);
}

export function hardChecks(record, config, now) {
  const f = record.fields, checks = [];
  checks.push(locationVerdict(record, config));
  const posted = f.postedAt;
  if (!posted?.value || !['first-published', 'advertised-date'].includes(posted.semantics)) checks.push(verdict('Recent publication', 'unknown', posted?.value ? `${posted.semantics}: ${posted.value}; not first-publication evidence` : 'First-publication date not stated/read'));
  else {
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(posted.value), time = Date.parse(posted.value);
    const age = dateOnly ? dayNumber(nzDate(now)) - dayNumber(posted.value) : (Date.parse(now) - time) / 86400000;
    checks.push(verdict('Recent publication', !Number.isFinite(age) || age < 0 ? 'unknown' : age <= config.postingDays ? 'satisfied' : 'conflict', `${posted.value} (${posted.semantics})`));
  }
  const closing = f.closesAt;
  if (closing?.value) {
    const ms = Date.parse(closing.value), beforePosted = f.postedAt?.value && ms < Date.parse(f.postedAt.value);
    if (beforePosted || !Number.isFinite(ms) || ms - Date.parse(now) > 366 * 86400000) checks.push({ ...verdict('Closing date', 'unknown', `Unconfirmed deadline retained: ${closing.value}; not used for urgency or open status`), advisory: true });
    else {
      const expired = /^\d{4}-\d{2}-\d{2}$/.test(closing.value) ? closing.value < nzDate(now) : ms < Date.parse(now);
      if (expired) checks.push(verdict('Closing date', 'conflict', `Deadline has passed: ${closing.value}`));
    }
  }
  checks.push(...config.all.map(c => condition(record, c)));
  if (config.any.length) {
    const alternatives = config.any.map(group => group.map(c => condition(record, c)));
    checks.push(verdict('Work/availability alternatives', alternatives.some(g => g.every(c => c.status === 'satisfied')) ? 'satisfied'
      : alternatives.every(g => g.some(c => c.status === 'conflict')) ? 'conflict' : 'unknown', alternatives));
  }
  return checks;
}

export function classify(record, config, judgment, now) {
  const checks = hardChecks(record, config, now);
  // A closure closes the vacancy only when the employer said so, on the
  // employer's own posting. A mirror that says "this job has expired" proves
  // that mirror advertisement expired and says nothing about the employer's
  // role, so it stays out of the recommendation area without being called closed.
  if (record.closure) {
    const bound = record.closure.scope === 'employer-posting' || closureBoundToAdvertisement(record, record.closure.source?.url);
    if (bound) return { category: 'closed', checks, reason: `${record.closure.scope} explicitly closed` };
    return { category: 'mirror-expired', checks, reason: '只有镜像／聚合广告的过期说明：这证明该镜像广告已失效，不证明雇主岗位已关闭，雇主岗位状态仍未知' };
  }
  // An identity anomaly is neither a recommendation nor a high-value lead.
  if (record.anomalies?.length || record.identityConflict) return { category: 'identity-anomaly', checks, reason: 'Identity could not be resolved across sources; not recommended' };
  if (record.opportunityKind?.value === 'talent-pool') {
    // Allowing talent pools is not allowing every talent pool. A pool is
    // still bound by the hard conditions and by the duty match: a pool in
    // another country, or one whose responsibilities were never assessed,
    // is not a lead and never enters the recommendation area.
    if (!config.includeTalentPools) return { category: 'excluded', checks, reason: 'Expression of interest/talent pool, not a confirmed vacancy' };
    if (checks.some(x => x.status === 'conflict')) return { category: 'excluded', checks, reason: 'Talent pool conflicts with a hard condition' };
    if (!judgment) return { category: 'excluded', checks, reason: 'Talent pool without a responsibility assessment' };
    if (judgment.fit === 'weak') return { category: 'excluded', checks, reason: 'Talent pool responsibilities do not match' };
    return { category: 'pool', checks, reason: 'Expression of interest/talent pool, not a confirmed vacancy' };
  }
  if (checks.some(x => x.status === 'conflict')) return { category: 'excluded', checks, reason: 'Known hard-condition conflict' };
  if (!judgment) return { category: 'unassessed', checks, reason: 'No responsibility assessment' };
  if (judgment.fit === 'weak') return { category: 'excluded', checks, reason: 'Responsibilities do not match' };
  if (record.readState !== 'read' || record.authority !== 'registered-official' || !record.fields.employer?.value || !record.fields.title?.value) return { category: 'unresolved', checks, reason: 'Primary vacancy not fully read or employer association/identity unconfirmed' };
  if (checks.some(x => x.status === 'unknown' && !x.advisory) || record.application.status !== 'verified') return { category: 'check', checks, reason: 'Missing hard-condition evidence or unverified application route' };
  return { category: 'ready', checks, reason: 'All required checks and application route verified' };
}
