// Place knowledge is shared by two modules: the evidence reader decides what a
// location string names, and the criteria decide what that name means for the
// request. Neither one guesses on its own, and neither one carries its own
// copy of the lists.
// Cities and regions. A posting that names one of them has stated where the
// job is, at a level a city request can be checked against.
export const NZ_LOCALITIES = ['auckland', 'wellington', 'christchurch', 'hamilton', 'tauranga', 'dunedin', 'napier', 'queenstown', 'rotorua',
  'palmerston north', 'new plymouth', 'whangarei', 'invercargill', 'hastings', 'whanganui', 'taupo', 'te puke', 'tokoroa', 'gore',
  'cambridge', 'motueka', 'feilding', 'levin', 'greymouth', 'wanaka', 'pukekohe', 'waiuku', 'orewa', 'masterton', 'lower hutt',
  'upper hutt', 'petone', 'porirua', 'takapuna', 'paraparaumu', 'palmerston', 'kapiti', 'hawkes bay', 'bay of plenty', 'waikato',
  'taranaki', 'wairarapa', 'nelson', 'marlborough', 'otago', 'southland', 'west coast', 'canterbury', 'northland', 'gisborne'];

// The country itself. A posting that names only the country has said where the
// employer hires, but not in which city: "Aotearoa" does not prove "not
// Auckland", so it can never be read as a location conflict.
export const NZ_COUNTRY_NAMES = ['new zealand', 'nz', 'aotearoa'];

export const NZ_PLACES = [...NZ_LOCALITIES, ...NZ_COUNTRY_NAMES];

// The localities that belong to a city. A posting that names one of them has
// stated that city, even when the city name is not written out: "Takapuna,
// New Zealand" is an Auckland posting. The Auckland list covers Auckland's
// own suburbs and localities and the northern local-board areas of the
// Auckland region.
//
// A locality that is not listed is not placed at all. The request then stays
// unknown rather than becoming a conflict: a suburb is never proof that the
// role is outside the requested city.
export const CITY_LOCALITIES = {
  auckland: ['takapuna', 'devonport', 'devonport-takapuna', 'stanley bay', 'north shore', 'northshore', 'orewa', 'red beach', 'silverdale',
    'whangaparaoa', 'albany', 'glenfield', 'browns bay', 'birkenhead', 'northcote', 'glenorchy', 'new lynn', 'te atatu', 'titirangi',
    'henderson', 'henderson-massey', 'massey', 'glen eden', 'sunnyvale', 'avondale', 'blockhouse bay', 'kuriwhenua', 'mt eden', 'mount eden',
    'mt roskill', 'mount roskill', 'mt albert', 'mount albert', 'onehunga', 'newmarket', 'ponsonby', 'parnell', 'herne bay', 'kohimarama',
    'grey lynn', 'kingsland', 'sandringham', 'royal oak', 'greenlane', 'ellerslie', 'otahuhu', 'mangere', 'mangere-otahuhu', 'papatoetoe',
    'botany', 'howick', 'east tamaki', 'pakuranga', 'bucklands beach', 'beachlands', 'highland park', 'whitakere', 'westhaven', 'glen innes',
    'st johns', 'panmure', 'waiheke', 'waiheke island', 'rangitoto', 'motutapu', 'pukekohe', 'waiuku', 'waitakere', 'waitemata',
    'albert-eden', 'orakei', 'papakura', 'maungakiekie-tamaki', 'whau', 'manukau', 'rodney', 'kaipara'],
  wellington: ['johnsonville', 'tawa', 'karori', 'khandallah', 'churton park', 'island bay', 'newtown', 'te aro', 'miramar', 'kilbirnie',
    'seatoun', 'makara', 'wrights hill'],
  christchurch: ['riccarton', 'hornby', 'bishopdale', 'new brighton', 'addington', 'cashmere', 'redwood', 'bexley', 'moorhouse', 'halswell']
};

// Countries, states and regions that are outside New Zealand. A posting that
// names one of them is a location conflict, not an unknown: the posting said
// where the job is.
export const FOREIGN_PLACES = ['united states', 'united kingdom', 'england', 'scotland', 'wales', 'ireland', 'australia', 'canada', 'tasmania',
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
// A city or region named in the text, as opposed to the country as a whole.
export const nzLocality = text => placeHit(text, NZ_LOCALITIES);
export const nzCountry = text => placeHit(text, NZ_COUNTRY_NAMES);
export const foreignPlace = text => placeHit(text, FOREIGN_PLACES);

// The city a place name belongs to. A locality of the requested city counts
// as that city: "Takapuna" is Auckland, so an Auckland request is satisfied
// by it. A name that belongs to no known city is not placed at all.
const placeKey = value => tidy(value).toLowerCase();
export const mentionsCity = (text, city) => {
  const name = placeKey(city);
  if (!name) return false;
  const t = tidy(text);
  if (!t) return false;
  if (new RegExp(`(^|[^A-Za-z0-9])${escapeRe(name)}([^A-Za-z0-9]|$)`, 'i').test(t)) return true;
  for (const locality of CITY_LOCALITIES[name] ?? []) {
    if (new RegExp(`(^|[^A-Za-z0-9])${escapeRe(locality)}([^A-Za-z0-9]|$)`, 'i').test(t)) return true;
  }
  return false;
};

// A posting may name more than one place it hires from. The reader joins the
// alternatives it found into one location string, so the string is split
// back into the distinct work locations it names.
export const workLocations = text => {
  const parts = String(text ?? '').split(/\s*\|\s*/).map(part => tidy(part)).filter(Boolean);
  return parts.length ? parts : [''];
};

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
