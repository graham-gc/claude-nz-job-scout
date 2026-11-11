// A minimal robots.txt parser.
//
// Only what this runtime needs: the group that matches the agent, Allow and
// Disallow rules with '*' and '$' wildcards, and longest-match precedence.

function matchPattern(pattern, path) {
  // '*' matches any sequence, '$' at the end anchors the end of the path.
  let re = '';
  for (const ch of pattern) {
    if (ch === '*') re += '.*';
    else if (ch === '$') re += '$';
    else re += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  try { return new RegExp('^' + re).test(path); } catch { return false; }
}

export function parseRobots(text) {
  const groups = [];
  let current = null;
  let expectingAgent = false;
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const sep = line.indexOf(':');
    if (sep < 0) continue;
    const field = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();
    if (field === 'user-agent') {
      if (!current || !expectingAgent) { current = { agents: [], rules: [] }; groups.push(current); expectingAgent = true; }
      current.agents.push(value.toLowerCase());
      continue;
    }
    if (field === 'allow' || field === 'disallow') {
      if (!current) { current = { agents: [], rules: [] }; groups.push(current); }
      expectingAgent = false;
      if (field === 'disallow' && value === '') continue; // an empty Disallow allows everything
      current.rules.push({ allow: field === 'allow', pattern: value });
    }
  }
  return groups;
}

export function isAllowed(url, agent, body) {
  let path;
  try { const u = new URL(url); path = `${u.pathname}${u.search}`; } catch { return false; }
  const groups = parseRobots(body);
  const wanted = String(agent ?? '').toLowerCase();
  const exact = groups.filter(g => g.agents.some(a => a !== '*' && wanted.includes(a)));
  const chosen = exact.length ? exact : groups.filter(g => g.agents.includes('*'));
  if (!chosen.length) return true;
  let best = null;
  for (const group of chosen) {
    for (const rule of group.rules) {
      if (!matchPattern(rule.pattern, path)) continue;
      const length = rule.pattern.replace(/[*$]/g, '').length;
      if (!best || length > best.length || (length === best.length && rule.allow && !best.allow)) best = { ...rule, length };
    }
  }
  if (!best) return true;
  return best.allow;
}
