import { hash } from './store.mjs';
import { key } from './evidence.mjs';

export const nzDate = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
const dayNumber = date => Date.parse(`${date}T00:00:00Z`) / 86400000;
const fields = new Set(['location', 'workArrangement', 'hoursPerWeek', 'engagement', 'contractType', 'durationWeeks', 'startAt', 'endAt', 'workRights']);
export function criteria(input) {
  if (!input || !Array.isArray(input.roleFamilies) || !input.roleFamilies.length || input.roleFamilies.some(x => typeof x !== 'string' || !x.trim())) throw new Error('roleFamilies must contain the requested role families');
  const result = { roleFamilies: input.roleFamilies, postingDays: input.postingDays ?? 7,
    location: input.location ?? { country: 'New Zealand', onsiteCities: ['Auckland'], remoteOutside: true },
    all: input.all ?? [], any: input.any ?? [], preferences: input.preferences ?? [], exclusions: input.exclusions ?? [], includeTalentPools: input.includeTalentPools === true };
  if (!Number.isInteger(result.postingDays) || result.postingDays < 1 || result.postingDays > 365) throw new Error('postingDays must be 1–365');
  if (result.location.country !== 'New Zealand' || !Array.isArray(result.location.onsiteCities) || !result.location.onsiteCities.length || typeof result.location.remoteOutside !== 'boolean') throw new Error('location needs country New Zealand, onsiteCities and remoteOutside');
  if (!Array.isArray(result.all) || !Array.isArray(result.any) || result.any.some(g => !Array.isArray(g) || !g.length)) throw new Error('all is a list of conditions; any is a list of nonempty alternative condition lists');
  for (const c of [...result.all, ...result.any.flat()]) {
    if (!c || !fields.has(c.field) || !['eq', 'in', 'lte', 'gte', 'contains'].includes(c.op) || c.value == null) throw new Error('Invalid condition: see references/input.md for fields and operators');
    if (c.op === 'in' && (!Array.isArray(c.value) || !c.value.length)) throw new Error('in requires a nonempty array');
    if (['lte', 'gte'].includes(c.op) && typeof c.value !== 'number' && !/^\d{4}-\d{2}-\d{2}$/.test(c.value)) throw new Error('lte/gte require a number or ISO date');
  }
  return result;
}
export const contextHash = (criteria, resumeHash) => hash({ criteria, resumeHash });
const verdict = (name, status, detail) => ({ name, status, detail });
export function condition(record, c) {
  const v = record.fields[c.field]?.value;
  if (v == null) return verdict(c.label ?? c.field, 'unknown', `${c.field} not stated/read`);
  const pass = c.op === 'eq' ? key(v) === key(c.value) : c.op === 'in' ? c.value.some(x => key(x) === key(v))
    : c.op === 'contains' ? key(v).includes(key(c.value)) : c.op === 'lte' ? v <= c.value : v >= c.value;
  return verdict(c.label ?? c.field, pass ? 'satisfied' : 'conflict', `${v} ${c.op} ${JSON.stringify(c.value)}`);
}
export function hardChecks(record, config, now) {
  const f = record.fields, checks = [], location = f.location?.value ?? '';
  const inCity = config.location.onsiteCities.some(c => new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(location));
  const foreign = /united states|united kingdom|australia|california|canada|singapore|\bUSA\b/i.test(location);
  const inNZ = !foreign && /new zealand|\bNZ\b|auckland|wellington|christchurch|hamilton|tauranga|dunedin/i.test(location);
  checks.push(verdict('Location', !location ? 'unknown' : inCity && inNZ ? 'satisfied'
    : inNZ && config.location.remoteOutside && f.workArrangement?.value === 'remote' ? 'satisfied'
      : inNZ && config.location.remoteOutside && !f.workArrangement?.value ? 'unknown' : 'conflict', location || 'Job location not stated/read'));
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
  if (record.closure) return { category: 'closed', checks, reason: `${record.closure.scope} explicitly closed` };
  if (record.identityConflict) return { category: 'unresolved', checks, reason: 'Conflicting identities share a URL; no automatic recommendation' };
  if (checks.some(x => x.status === 'conflict')) return { category: 'excluded', checks, reason: 'Known hard-condition conflict' };
  if (!judgment) return { category: 'unassessed', checks, reason: 'No responsibility assessment' };
  if (judgment.fit === 'weak') return { category: 'excluded', checks, reason: 'Responsibilities do not match' };
  if (record.opportunityKind?.value === 'talent-pool') return { category: config.includeTalentPools ? 'pool' : 'excluded', checks, reason: 'Expression of interest/talent pool, not a confirmed vacancy' };
  if (record.readState !== 'read' || record.authority !== 'registered-official' || !record.fields.employer?.value || !record.fields.title?.value) return { category: 'unresolved', checks, reason: 'Primary vacancy not fully read or employer association/identity unconfirmed' };
  if (checks.some(x => x.status === 'unknown' && !x.advisory) || record.application.status !== 'verified') return { category: 'check', checks, reason: 'Missing hard-condition evidence or unverified application route' };
  return { category: 'ready', checks, reason: 'All required checks and application route verified' };
}
