import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { hash, put } from './store.mjs';
import { isPublicAddress, isValidAddress } from './addr.mjs';
import { isAllowed } from './robots.mjs';

const AGENT = 'NZJobScout/1.0';
export function publicUrl(value) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) throw new Error('Only public HTTPS URLs without credentials are allowed');
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(u.hostname) || !u.hostname.includes('.')) throw new Error('Private host refused');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isValidAddress(host) && !publicAddress(host)) throw new Error('Private IP refused');
  return u;
}
export function publicAddress(address) {
  return isPublicAddress(address);
}

export function requestPublic(url, timeoutMs = 8000) {
  const target = publicUrl(url);
  return new Promise((resolve, reject) => {
    const req = httpsRequest(target, {
      method: 'GET', headers: { 'User-Agent': AGENT, Accept: 'application/json,text/html,text/plain;q=0.8', 'Accept-Encoding': 'identity' },
      lookup(host, options, done) {
        lookup(host, { all: true }, (error, addresses) => {
          if (error) return done(error);
          if (!addresses.length || addresses.some(x => !publicAddress(x.address))) return done(new Error('Non-public DNS address refused'));
          done(null, options.all ? addresses : addresses[0].address, addresses[0].family);
        });
      },
    }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 6_000_000) req.destroy(new Error('Response exceeds 6 MB limit')); else chunks.push(chunk); });
      response.on('end', () => { clearTimeout(timer); resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }); });
      response.on('error', reject);
    });
    const timer = setTimeout(() => req.destroy(new Error('Request timeout')), Math.max(1, timeoutMs));
    req.on('error', e => { clearTimeout(timer); reject(e); });
    req.end();
  });
}

// A robots.txt fetch belongs to the source it protects: it is counted inside
// that source's group (boards, linkedin or search) and additionally against a
// robots ceiling of its own.
// The group follows the source family, not one hard-coded id: discovery entry
// points are per role family and per location, and every one of them must be
// charged to the family it belongs to.
export const groupOf = (source, kind) => {
  const id = String(source ?? '').toLowerCase();
  if (id === 'web-search' || id.startsWith('web-search')) return 'search';
  if (id === 'linkedin' || id.startsWith('linkedin')) return 'linkedin';
  return 'boards';
};

export function charge(state, stage, source, kind = 'http') {
  if (!['discovery', 'detail', 'application'].includes(stage)) throw new Error('Invalid budget stage');
  // The request window measures network time only, so model thinking cannot consume it.
  if ((state.networkSpentMs ?? 0) >= (state.networkBudgetMs ?? 15 * 60000)) throw new Error('Network time budget reached');
  if (state.deadline != null && Date.now() >= state.deadline) throw new Error('Run deadline reached');
  if (state.wallDeadline && Date.now() >= state.wallDeadline) throw new Error('Run wall-clock limit reached');
  state.budget.sourceUsed ??= {};
  if (!state.budget.groupLimits) state.budget.groupLimits = {};
  if (!state.budget.groups) state.budget.groups = {};
  // The ledger is kept per stage: a group's counter describes the discovery mix
  // only, so the report cannot print detail reads as discovery spend.
  state.budget.stageGroups ??= { discovery: { boards: 0, linkedin: 0, search: 0 }, detail: { boards: 0, linkedin: 0, search: 0 }, application: { boards: 0, linkedin: 0, search: 0 } };
  state.budget.stageRobots ??= { discovery: { boards: 0, linkedin: 0, search: 0 }, detail: { boards: 0, linkedin: 0, search: 0 }, application: { boards: 0, linkedin: 0, search: 0 } };
  if (state.budget.used[stage] >= state.budget.limits[stage]) throw new Error(`${stage} budget exhausted`);
  const group = groupOf(source, kind);
  const groupLimit = state.budget.groupLimits[group];
  // Group ceilings describe the discovery mix; later stages have their own limits.
  if (stage === 'discovery' && groupLimit != null && state.budget.groups[group] >= groupLimit) throw new Error(`${group} discovery budget exhausted`);
  // robots.txt reads are counted inside the source group and against a ceiling
  // of their own, so a run cannot spend its whole discovery budget on them.
  const robotsRead = kind === 'robots';
  if (robotsRead && (state.budget.robotsUsed ?? 0) >= (state.budget.robotsLimit ?? 6)) throw new Error('robots discovery budget exhausted');
  const perSource = state.budget.sourceLimits ?? {};
  const used = state.budget.sourceUsed[source] ?? { requests: 0, items: 0, details: 0, stages: {} };
  // Per-source ceilings are counted per stage. Discovery spend on one board
  // must not eat the application allowance of the same source: each stage
  // has its own ceiling and its own counter.
  const stageUsed = used.stages?.[stage] ?? { requests: 0 };
  const requestLimit = stage === 'discovery' ? perSource.discoveryRequests : stage === 'application' ? perSource.applicationRequests : perSource.detailRequests;
  if (requestLimit != null && stageUsed.requests >= requestLimit) throw new Error(`Per-source ${stage} request limit reached for ${source}`);
  if (stage === 'discovery') state.budget.groups[group] = (state.budget.groups[group] ?? 0) + 1;
  state.budget.stageGroups[stage][group] = (state.budget.stageGroups[stage][group] ?? 0) + 1;
  if (robotsRead) {
    state.budget.robotsUsed = (state.budget.robotsUsed ?? 0) + 1;
    state.budget.stageRobots[stage][group] = (state.budget.stageRobots[stage][group] ?? 0) + 1;
  }
  state.budget.used[stage]++;
  state.budget.sourceUsed[source] = { ...used, requests: used.requests + 1,
    stages: { ...(used.stages ?? {}), [stage]: { requests: stageUsed.requests + 1 } } };
  const item = { id: state.attempts.length + 1, stage, source, kind, at: new Date().toISOString(), outcome: 'started' };
  state.attempts.push(item);
  return item;
}

// Per-source ceilings: one board must not consume the whole run.
export function countItems(state, source, count) {
  state.budget.sourceUsed ??= {};
  const limit = state.budget.sourceLimits?.items ?? null;
  const used = state.budget.sourceUsed[source] ?? { requests: 0, items: 0, details: 0 };
  if (limit != null && used.items + count > limit) {
    const allowed = Math.max(0, limit - used.items);
    state.budget.sourceUsed[source] = { ...used, items: used.items + allowed };
    return allowed;
  }
  state.budget.sourceUsed[source] = { ...used, items: used.items + count };
  return count;
}
export function countDetail(state, source) {
  state.budget.sourceUsed ??= {};
  const limit = state.budget.sourceLimits?.details ?? null;
  const used = state.budget.sourceUsed[source] ?? { requests: 0, items: 0, details: 0 };
  if (limit != null && used.details >= limit) return false;
  state.budget.sourceUsed[source] = { ...used, details: used.details + 1 };
  return true;
}
export const networkSpent = state => state.networkSpentMs ?? 0;

const TRANSIENT = /timeout|socket hang up|ECONNRESET|ECONNREFUSED|EPIPE|EAI_AGAIN|ETIMEDOUT|network|5\d\d/;

export class Reader {
  constructor(root, folder, state, request = requestPublic) { Object.assign(this, { root, folder, state, request }); }
  async once(url, stage, source, kind = 'http') {
    const item = charge(this.state, stage, source, kind);
    item.url = url;
    const started = Date.now();
    try {
      const response = await this.request(url, Math.min(8000, Math.max(1000, this.state.networkBudgetMs - networkSpent(this.state))));
      const relative = `responses/${hash(url)}.json`;
      await put(this.root, join(this.folder, relative), { ...response, url, observedAt: item.at, snapshot: relative }, { replace: true });
      item.outcome = 'received'; item.status = response.status;
      item.elapsedMs = Date.now() - started;
      this.state.networkSpentMs = (this.state.networkSpentMs ?? 0) + item.elapsedMs;
      return { ...response, url, observedAt: item.at, snapshot: relative };
    } catch (error) {
      item.outcome = 'error'; item.reason = error.message;
      item.elapsedMs = Date.now() - started;
      this.state.networkSpentMs = (this.state.networkSpentMs ?? 0) + item.elapsedMs;
      throw error;
    }
  }
  async get(value, stage, source, depth = 0) {
    const u = publicUrl(value); u.hash = '';
    const url = u.toString();
    if (this.state.blockedSources[source] || this.state.blockedSources[u.origin]) throw new Error('Source was restricted earlier in this run; no retry');
    if (/\/(?:login|signup|sign-in|authwall|checkpoint|captcha)(?:\/|\?|$)/i.test(u.pathname)) throw new Error('Login/challenge route is not a public vacancy');
    if (this.state.cache[url]) return JSON.parse(await readFile(join(this.folder, this.state.cache[url]), 'utf8'));
    if (!Object.hasOwn(this.state.robots, u.origin)) {
      const response = await this.once(`${u.origin}/robots.txt`, stage, source, 'robots');
      if (![200, 404, 410].includes(response.status)) {
        this.state.blockedSources[source] = `robots status ${response.status}`;
        this.state.blockedSources[u.origin] = `robots status ${response.status}`;
        throw new Error(`Robots availability unconfirmed (${response.status})`);
      }
      this.state.robots[u.origin] = response.status === 200 ? response.body : '';
    }
    if (isAllowed(url, AGENT, this.state.robots[u.origin]) === false) {
      this.state.blockedSources[source] = 'robots restriction'; throw new Error('Robots restriction; no retry');
    }
    const response = await this.fetchWithRetry(url, stage, source);
    if ([401, 403, 429].includes(response.status)) {
      this.state.blockedSources[source] = `HTTP ${response.status}`;
      this.state.blockedSources[u.origin] = `HTTP ${response.status}`;
      throw new Error(`Source restricted (${response.status}); no alternate endpoint retry`);
    }
    if (response.status === 200 && /<title>\s*(?:just a moment|access denied)|verify (?:that )?you are human|id=["']cf-chl/i.test(response.body)) {
      this.state.blockedSources[source] = 'challenge page'; this.state.blockedSources[u.origin] = 'challenge page';
      throw new Error('Source restricted by a challenge page; no bypass');
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (depth >= 3 || !response.headers?.location) throw new Error('Redirect limit or missing target');
      const final = await this.get(new URL(response.headers.location, u).href, stage, source, depth + 1);
      this.state.cache[url] = final.snapshot;
      return final;
    }
    this.state.cache[url] = response.snapshot;
    return response;
  }
  // One bounded retry for transient network failures. Restrictions are never retried.
  async fetchWithRetry(url, stage, source, attempt = 0) {
    try {
      return await this.once(url, stage, source);
    } catch (error) {
      const transient = TRANSIENT.test(error.message);
      if (!transient || attempt >= 1) throw error;
      const item = this.state.attempts[this.state.attempts.length - 1];
      if (item) { item.outcome = 'transient-error'; item.retried = true; }
      this.state.warnings = this.state.warnings ?? [];
      this.state.warnings.push(`Transient read failure for ${url} (${error.message}); one retry was charged to the budget.`);
      await new Promise(resolve => setTimeout(resolve, 400));
      return this.fetchWithRetry(url, stage, source, attempt + 1);
    }
  }
}
