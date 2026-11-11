import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns';
import ipaddr from 'ipaddr.js';
import robotsParser from 'robots-parser';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { hash, put } from './store.mjs';

const AGENT = 'NZJobScout/1.0';
export function publicUrl(value) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) throw new Error('Only public HTTPS URLs without credentials are allowed');
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(u.hostname) || !u.hostname.includes('.')) throw new Error('Private host refused');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (ipaddr.isValid(host) && !publicAddress(host)) throw new Error('Private IP refused');
  return u;
}
export function publicAddress(address) {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
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

export function charge(state, stage, source, kind = 'http') {
  if (!['discovery', 'detail', 'application'].includes(stage)) throw new Error('Invalid budget stage');
  if (Date.now() >= state.deadline) throw new Error('Run deadline reached');
  if (state.budget.used[stage] >= state.budget.limits[stage]) throw new Error(`${stage} budget exhausted`);
  if (stage === 'discovery') {
    const group = source === 'web-search' ? 'search' : source === 'linkedin' ? 'linkedin' : 'boards';
    if (state.budget.groups[group] >= state.budget.groupLimits[group]) throw new Error(`${group} discovery budget exhausted`);
    state.budget.groups[group]++;
  }
  state.budget.used[stage]++;
  const item = { id: state.attempts.length + 1, stage, source, kind, at: new Date().toISOString(), outcome: 'started' };
  state.attempts.push(item);
  return item;
}

export class Reader {
  constructor(root, folder, state, request = requestPublic) { Object.assign(this, { root, folder, state, request }); }
  async once(url, stage, source) {
    const item = charge(this.state, stage, source);
    item.url = url;
    try {
      const response = await this.request(url, Math.min(8000, this.state.deadline - Date.now()));
      const relative = `responses/${hash(url)}.json`;
      await put(this.root, join(this.folder, relative), { ...response, url, observedAt: item.at, snapshot: relative }, { replace: true });
      item.outcome = 'received'; item.status = response.status;
      return { ...response, url, observedAt: item.at, snapshot: relative };
    } catch (error) { item.outcome = 'error'; item.reason = error.message; throw error; }
  }
  async get(value, stage, source, depth = 0) {
    const u = publicUrl(value); u.hash = '';
    const url = u.toString();
    if (this.state.blockedSources[source] || this.state.blockedSources[u.origin]) throw new Error('Source was restricted earlier in this run; no retry');
    if (/\/(?:login|signup|sign-in|authwall|checkpoint|captcha)(?:\/|\?|$)/i.test(u.pathname)) throw new Error('Login/challenge route is not a public vacancy');
    if (this.state.cache[url]) return JSON.parse(await readFile(join(this.folder, this.state.cache[url]), 'utf8'));
    if (!Object.hasOwn(this.state.robots, u.origin)) {
      const response = await this.once(`${u.origin}/robots.txt`, stage, source);
      if (![200, 404, 410].includes(response.status)) {
        this.state.blockedSources[source] = `robots status ${response.status}`;
        this.state.blockedSources[u.origin] = `robots status ${response.status}`;
        throw new Error(`Robots availability unconfirmed (${response.status})`);
      }
      this.state.robots[u.origin] = response.status === 200 ? response.body : '';
    }
    if (robotsParser(`${u.origin}/robots.txt`, this.state.robots[u.origin]).isAllowed(url, AGENT) === false) {
      this.state.blockedSources[source] = 'robots restriction'; throw new Error('Robots restriction; no retry');
    }
    const response = await this.once(url, stage, source);
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
}
