// Place knowledge is shared by two modules: the evidence reader decides what a
// location string names, and the criteria decide what that name means for the
// request. Neither one guesses on its own, and neither one carries its own
// copy of the lists.
export const NZ_PLACES = ['auckland', 'wellington', 'christchurch', 'hamilton', 'tauranga', 'dunedin', 'napier', 'queenstown', 'rotorua',
  'palmerston north', 'new plymouth', 'whangarei', 'invercargill', 'hastings', 'whanganui', 'taupo', 'te puke', 'tokoroa', 'gore',
  'cambridge', 'motueka', 'feilding', 'levin', 'greymouth', 'wanaka', 'pukekohe', 'waiuku', 'orewa', 'masterton', 'lower hutt',
  'upper hutt', 'petone', 'porirua', 'takapuna', 'paraparaumu', 'palmerston', 'kapiti', 'hawkes bay', 'bay of plenty', 'waikato',
  'taranaki', 'wairarapa', 'nelson', 'marlborough', 'otago', 'southland', 'west coast', 'canterbury', 'northland', 'gisborne',
  'new zealand', 'nz', 'aotearoa'];

// Countries, states and regions that are outside New Zealand. A posting that
// names one of them is a location conflict, not an unknown: the posting said
// where the job is.
export const FOREIGN_PLACES = ['united states', 'united kingdom', 'england', 'scotland', 'wales', 'ireland', 'australia', 'canada',
  'singapore', 'germany', 'india', 'china', 'japan', 'france', 'netherlands', 'philippines', 'south africa', 'brazil', 'mexico',
  'italy', 'spain', 'poland', 'sweden', 'norway', 'denmark', 'switzerland', 'austria', 'belgium', 'argentina', 'indonesia',
  'vietnam', 'thailand', 'malaysia', 'uae', 'united arab emirates', 'israel', 'turkey', 'greece', 'portugal', 'finland',
  'new york', 'california', 'texas', 'colorado', 'florida', 'washington', 'massachusetts', 'illinois', 'ontario', 'quebec',
  'british columbia', 'nsw', 'victoria', 'queensland', 'rhode island', 'mississippi', 'latin america', 'north america',
  'south america', 'new jersey', 'new hampshire', 'new mexico', 'north carolina', 'south carolina', 'west virginia',
  'virginia', 'maryland', 'tennessee', 'kentucky', 'alabama', 'louisiana', 'oklahoma', 'kansas', 'missouri', 'nebraska',
  'minnesota', 'wisconsin', 'michigan', 'ohio', 'pennsylvania', 'connecticut', 'massachusetts', 'arizona', 'nevada', 'utah',
  'colorado', 'montana', 'wyoming', 'idaho', 'oregon', 'hawaii', 'alaska', 'wales', 'northern ireland'];

// Two-letter state codes are only read when the posting writes them as a place
// ("Woonsocket, RI"). A bare word is never treated as a state.
export const US_STATE_CODES = new Set(['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA',
  'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK',
  'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC']);

// A remote posting that names its own scope names where it hires. The scope
// list is deliberately explicit: an unknown scope stays unknown.
export const REMOTE_SCOPES = ['us', 'usa', 'u.s.', 'united states', 'north america', 'south america', 'latin america', 'emea',
  'apac', 'asia pacific', 'europe', 'uk', 'united kingdom', 'canada', 'india', 'australia', 'japan', 'singapore', 'philippines',
  'indonesia', 'vietnam', 'thailand', 'malaysia', 'brazil', 'mexico', 'argentina', 'germany', 'france', 'netherlands', 'poland',
  'south africa', 'china', 'hong kong', 'taiwan', 'south korea', 'israel', 'turkey', 'uae', 'egypt', 'nigeria', 'kenya', 'ireland'];

// "Remote" on its own says nothing about where the employer hires.
export const REMOTE_ONLY = /^\s*(?:remote|fully remote|work from home|wfh|anywhere|100% remote)\s*$/i;

const escapeRe = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tidy = value => String(value ?? '').replace(/\s+/g, ' ').trim();

// The earliest place the text names, with its position in the text.
const placeHit = (text, list) => {
  const t = tidy(text);
  if (!t) return null;
  let best = null;
  for (const name of list) {
    const m = t.match(new RegExp(`(^|[^A-Za-z0-9])${escapeRe(name)}([^A-Za-z0-9]|$)`, 'i'));
    if (!m) continue;
    const index = m.index + m[1].length;
    if (!best || index < best.index) best = { index, name };
  }
  return best;
};
export const nzPlace = text => placeHit(text, NZ_PLACES);
export const foreignPlace = text => placeHit(text, FOREIGN_PLACES);

export const usStateCode = text => {
  const m = tidy(text).match(/,\s*([A-Z]{2})\b/);
  return m && US_STATE_CODES.has(m[1]) ? m[1] : null;
};

// The scope of a remote posting, when the posting writes one: "Remote (US)",
// "Remote, Latin America", "Remote - New Zealand".
export const remoteScope = text => {
  const t = tidy(text);
  if (!/\bremote\b/i.test(t)) return null;
  const m = t.match(/\bremote\b\s*(?:\(([^)]{1,40})\)|\[([^\]]{1,40})\]|,\s*([^,;]{1,40})|[-–—]\s*([^;]{1,40}))/i);
  if (!m) return null;
  return tidy(m[1] ?? m[2] ?? m[3] ?? m[4] ?? '') || null;
};
export const foreignScope = scope => {
  const s = tidy(scope).toLowerCase();
  if (!s) return null;
  for (const word of REMOTE_SCOPES) if (new RegExp(`(^|[^a-z])${escapeRe(word)}([^a-z]|$)`, 'i').test(s)) return word;
  return null;
};

export const isForeignPlace = text => Boolean(foreignPlace(text) || usStateCode(text));
export const isNzPlace = text => Boolean(nzPlace(text));

// The place phrase a candidate string names, trimmed to the phrase itself:
// "Senior QA Automation Engineer at Private Identity. Woonsocket, Rhode Island"
// becomes "Woonsocket, Rhode Island".
export function placeFragment(text) {
  const t = tidy(text);
  if (!t) return null;
  // A named foreign region wins over a New Zealand mention: the posting is
  // outside the requested country, and that is the stricter reading.
  const foreign = foreignPlace(t), hit = foreign ?? nzPlace(t);
  if (hit) {
    const start = hit.index, end = hit.index + hit.name.length;
    const right = t.slice(end).match(/^\s*,\s*([A-Z][A-Za-z.'-]{2,}(?:\s+[A-Z][A-Za-z.'-]{2,}){0,2})/);
    const after = right ? end + right[0].length : end;
    // A city that belongs to a foreign region is named before the region:
    // "Woonsocket, Rhode Island" says more than "Rhode Island" alone. A New
    // Zealand place keeps its own region and takes no street-level prefix.
    let prefix = '';
    if (foreign) {
      const before = t.slice(0, start);
      const left = before.match(/([A-Z][A-Za-z.'-]{2,})\s*,?\s*$/);
      const streetNumber = /\d+\s+[A-Za-z]/.test(before.slice(-24));
      if (left && !streetNumber) prefix = `${left[1]}, `;
    }
    return tidy(prefix + t.slice(start, after));
  }
  const code = usStateCode(t);
  if (code) {
    const index = t.search(new RegExp(`,\\s*${code}\\b`));
    const left = t.slice(0, index).match(/([A-Z][A-Za-z.'-]{2,}(?:\s+[A-Za-z.'-]{2,}){0,2})\s*$/);
    return tidy(left ? `${left[1]}, ${code}` : code);
  }
  return null;
}
