import { join } from 'node:path';
import { lstat } from 'node:fs/promises';
import { readJson, put, reports, hash, runStates } from './store.mjs';
import { nzDate, classify, hardChecks } from './criteria.mjs';
import { idKeys } from './evidence.mjs';
import { excluded, validateJudgments, verifyApplication, applicationPlan, requestLedger } from './engine.mjs';

const esc = text => String(text ?? '').replace(/[\[\]<>*_`|]/g, x => `\\${x}`).replace(/\s+/g, ' ').trim();
// Values are shown in words, never as raw JSON.
const fmtValue = value => {
  if (value == null) return '未披露';
  if (Array.isArray(value)) return value.map(fmtValue).join('、');
  if (typeof value === 'object') return Object.entries(value).map(([k, v]) => `${k}=${fmtValue(v)}`).join('，');
  return String(value);
};
const link = (title, url) => `[${esc(title)}](<${new URL(url).href}>)`;
// The request ledger in words: every request of the project, how many runs it
// holds and what it spent. A request that opens a fresh budget is visible
// here, so a reset cannot pass unnoticed.
function requestLedgerText(ledger) {
  if (!ledger) return '（未记录）';
  const parts = (ledger.requests ?? []).map(r => `requestId ${esc(r.requestId)}（${r.runs} 轮，发现 ${r.spent?.used?.discovery ?? 0}／详情 ${r.spent?.used?.detail ?? 0}／申请 ${r.spent?.used?.application ?? 0}，起始 ${esc(r.startedAt ?? '未记录')}）`);
  if (ledger.legacy?.runs) parts.push(`早期无请求标识的运行（${ledger.legacy.runs} 轮，发现 ${ledger.legacy.spent?.used?.discovery ?? 0}／详情 ${ledger.legacy.spent?.used?.detail ?? 0}／申请 ${ledger.legacy.spent?.used?.application ?? 0}）不结转给任何请求`);
  return parts.length ? parts.join('；') : '本项目尚未开启过请求';
}
const value = (r, name) => r.fields[name]?.value ?? '未披露／未读到';
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
        return detail.map((group, i) => `方案${i + 1}[${group.map(x => `${esc(x.name)}=${x.status}`).join(', ')}]`).join('；');
      }
      return detail.map(x => esc(fmtValue(x))).join('；');
    }
    if (detail && typeof detail === 'object') return esc(fmtValue(detail));
    return esc(fmtValue(detail));
  };
  const label = status === 'conflict' ? '冲突' : status === 'satisfied' ? '满足' : '未知';
  return `${name}（${label}）：${render(check.detail)}`;
}
function obstacles(item) {
  return item.checks.filter(c => c.status !== 'satisfied').map(readableCheck);
}
function unreadReason(record) {
  const bits = [];
  if (record.readState !== 'read') bits.push(`原帖读取状态：${record.readState}`);
  if (record.detailError) bits.push(`读取问题：${record.detailError}`);
  if (record.gaps?.length) bits.push(`仍缺字段：${record.gaps.join('、')}`);
  if (record.authority !== 'registered-official') bits.push('雇主官网关联未核验');
  if (record.closure) bits.push(`关闭证据（${record.closure.scope}）：${record.closure.quote ?? ''}`);
  return bits.join('；');
}

// --- preferences -------------------------------------------------------------
// Preferences are executable rules over recorded facts. Their basis is stated.
const PREFERENCE_RULES = [
  { re: /\bremote\b|远程/i, check: r => r.fields.workArrangement?.value === 'remote' || /\bremote\b/i.test(r.fields.location?.value ?? ''), basis: r => `workArrangement=${r.fields.workArrangement?.value ?? '未读到'}；location=${r.fields.location?.value ?? '未读到'}` },
  { re: /\bhybrid\b|混合/i, check: r => r.fields.workArrangement?.value === 'hybrid', basis: r => `workArrangement=${r.fields.workArrangement?.value ?? '未读到'}` },
  { re: /\bon[\s-]?site\b|现场|坐班/i, check: r => r.fields.workArrangement?.value === 'on-site', basis: r => `workArrangement=${r.fields.workArrangement?.value ?? '未读到'}` },
  { re: /\bpermanent\b|长期|永久/i, check: r => r.fields.contractType?.value === 'permanent', basis: r => `contractType=${r.fields.contractType?.value ?? '未读到'}` },
  { re: /\bfixed[\s-]?term\b|固定期限/i, check: r => r.fields.contractType?.value === 'fixed-term', basis: r => `contractType=${r.fields.contractType?.value ?? '未读到'}` },
  { re: /\bfull[\s-]?time\b|全职/i, check: r => r.fields.workload?.value === 'full-time', basis: r => `workload=${r.fields.workload?.value ?? '未读到'}` },
  { re: /\bpart[\s-]?time\b|兼职/i, check: r => r.fields.workload?.value === 'part-time', basis: r => `workload=${r.fields.workload?.value ?? '未读到'}` },
  { re: /\bintern(ship)?\b|实习/i, check: r => /intern/i.test(`${r.fields.title?.value ?? ''} ${r.lead.title ?? ''}`), basis: r => `title=${r.fields.title?.value ?? r.lead.title ?? '未读到'}` },
  { re: /\bsalary\b|薪酬|薪资/i, check: r => !!r.fields.salary?.value, basis: r => `salary=${r.fields.salary?.value ?? '未读到'}` },
  { re: /\bnot volunteer\b|非志愿|paid role/i, check: r => r.fields.engagement?.value && r.fields.engagement.value !== 'volunteer', basis: r => `engagement=${r.fields.engagement?.value ?? '未读到'}` },
  { re: /\bvolunteer\b|志愿/i, check: r => r.fields.engagement?.value === 'volunteer', basis: r => `engagement=${r.fields.engagement?.value ?? '未读到'}` }
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
      return { text, status: new RegExp(city[0], 'i').test(location) ? 'satisfied' : 'conflict', basis: `location=${location || '未读到'}` };
    }
    return { text, status: 'unknown', basis: '没有可执行的判定规则；本条偏好不参与排序' };
  });
}
export function preferenceScore(record, preferences = []) {
  const verdicts = preferenceVerdicts(record, preferences);
  return { satisfied: verdicts.filter(v => v.status === 'satisfied').length, verdicts };
}

function jobLines(item, preferences = []) {
  const { record: r, judgment: j, checks } = item;
  const title = value(r, 'title') === '未披露／未读到' ? r.lead.title || '未确认职位' : value(r, 'title');
  const employer = r.fields.employer?.value ?? r.lead.employer ?? '未确认雇主';
  const lines = [`### ${esc(title)} — ${esc(employer)}`, '', `- 地点／方式：${esc(value(r, 'location'))} · ${esc(value(r, 'workArrangement'))}`,
    `- 工作性质：${esc(value(r, 'engagement'))} · ${esc(value(r, 'contractType'))} · ${esc(value(r, 'workload'))} · ${esc(value(r, 'hoursPerWeek'))} 小时／周`,
    `- 期限：${esc(r.fields.duration?.value ? `${r.fields.duration.value.amount} ${r.fields.duration.value.unit}` : '未披露／未读到')}（保留原始单位，不做换算）`,
    `- 发布：${esc(value(r, 'postedAt'))}${r.fields.postedAt?.semantics ? `（${esc(r.fields.postedAt.semantics)}）` : ''}；截止：${esc(value(r, 'closesAt'))}`,
    `- 薪酬：${esc(value(r, 'salary'))}；薪酬状态：${esc(r.fields.payStatus?.value ?? 'unknown')}${r.fields.engagement?.value === 'volunteer' ? ' · **Volunteer**' : ''}`,
    `- 匹配判断：${esc(j?.fit ?? '未评估')}。${(j?.reasons ?? [item.reason]).map(esc).join('；')}`];
  if (r.relativePublication?.text) lines.push(`- 相对发布时间（原文保留）：${esc(r.relativePublication.text)}；来源 ${esc(r.relativePublication.source?.url ?? '未读到')}，观察于 ${esc(r.relativePublication.source?.observedAt ?? '未读到')}；未折算为具体首发日期。`);
  if (r.application?.status === 'verified') {
    if (r.application.kind === 'email-in-posting') lines.push(`- 申请方式：发邮件至 **${esc(r.application.email)}**。原帖投递说明：${esc(r.application.instruction)}`);
    else if (r.application.kind === 'job-specific-external-ats') lines.push(`- **${link('申请入口（外部 ATS）', r.application.url)}**（已读到本岗位专属申请页，未提交）`);
    else lines.push(`- **${link('直接申请', r.application.url)}**（已读到本岗位专属表单，未提交）`);
  } else lines.push(`- 申请方式未核验（${esc(r.application?.status ?? 'not-checked')}）：${esc(r.application?.reason ?? '未检查')}。下方链接不是已验证申请入口。`);
  lines.push(`- ${link('职位详情', r.canonicalUrl)}`);
  const obs = obstacles(item);
  if (obs.length) lines.push(`- 主要障碍：${obs.join('；')}`);
  if (r.conflicts?.length) lines.push(`- 合并冲突：${r.conflicts.slice(0, 3).map(c => `${esc(c.field)} 保留 ${esc(fmtValue(c.kept))}，另见 ${esc(fmtValue(c.discarded))}`).join('；')}`);
  if (r.closure) lines.push(`- 关闭证据（${esc(r.closure.scope)}，观察于 ${esc(r.closure.observedAt ?? '未读到')}）：${esc(r.closure.quote ?? '')}`);
  if (r.opportunityKind?.value === 'talent-pool') lines.push('- 这是人才池，不保证有空缺或面试，不作为现有职位统计。');
  if (preferences.length) {
    const { verdicts } = preferenceScore(r, preferences);
    lines.push(`- 偏好依据：${verdicts.map(v => `${esc(v.text)}→${v.status === 'satisfied' ? '满足' : v.status === 'conflict' ? '不满足' : '未知'}（${esc(v.basis)}）`).join('；')}`);
  }
  const evidence = Object.entries(r.fields).filter(([k, f]) => k !== 'duties' && f.source).map(([name, f]) => `${esc(name)} → ${link('来源', f.source.url)}`);
  lines.push(`- 记录：\`${r.recordId}\`；字段证据：${evidence.join('；')}`, '');
  return lines;
}
// A recruitment channel is disclosed with its own evidence. It never looks
// like a job: no application route is claimed for it.
function channelLines(item) {
  const { record: r } = item;
  const title = value(r, 'title') === '未披露／未读到' ? r.lead.title || '未确认渠道' : value(r, 'title');
  const employer = r.fields.employer?.value ?? r.lead.employer ?? '未确认雇主';
  const lines = [`- ${esc(title)} — ${esc(employer)}：${esc(item.reason ?? '')}`];
  const obs = obstacles(item);
  if (obs.length) lines.push(`  - 障碍：${obs.join('；')}`);
  const unread = unreadReason(r);
  if (unread) lines.push(`  - 未读原因：${esc(unread)}`);
  lines.push(`  - 页面：${link('渠道页面', r.canonicalUrl)}`, `  - 记录：\`${r.recordId}\``);
  return lines;
}
export function render(report) {
  const { state, items, newItems, overflow = [], withdrawals, pendingHistory } = report;
  const record = id => report.records[id];
  const preferences = state.config.preferences ?? [];
  const lines = ['# New Zealand Job Scout', '', `生成：${report.generatedAt} · Pacific/Auckland 日期 ${report.date}`, '',
    `简历已读取；职位族：${state.config.roleFamilies.map(esc).join('、')}；首发窗口：${state.config.postingDays} 天。`,
    `覆盖度：**${report.coverage}**（仅指本轮计划，不代表整个市场）。`, ''];
  // Disclosures are sentences: each one is printed in full.
  for (const text of (state.config.disclosures ?? [])) lines.push(`- 条件披露：${esc(text)}`);
  if ((state.config.disclosures ?? []).length) lines.push('');
  lines.push('## 建议（已核验）', '');
  for (const [category, name] of [['ready', '可以投'], ['check', '值得确认'], ['unresolved', '高价值线索：尚未读到可信完整原帖'], ['pool', '人才池：不是确定空缺']]) {
    lines.push(`### ${name}`, '');
    const section = newItems.filter(i => i.category === category);
    if (section.length) for (const item of section) lines.push(...jobLines({ ...item, record: record(item.recordId) }, preferences));
    else lines.push(category === 'ready' ? '在可访问的来源中没有新增的、核验通过且有可用申请方式的岗位。' : '本轮无新增。', '');
  }
  const channels = items.filter(i => i.category === 'channel');
  if (channels.length) {
    lines.push('## 渠道待核查（面向雇主的招聘渠道，不是岗位推荐）', '',
      '以下条目是面向雇主方的招聘活动或平台页面。页面本身不是可投的空缺，候选人侧的报名入口本轮未核验；它们只作为可跟进的渠道披露，不进入推荐，也不计入岗位统计。', '');
    for (const item of channels) lines.push(...channelLines({ ...item, record: record(item.recordId) }));
    lines.push('');
  }
  if (overflow.length) {
    lines.push('## 本轮其余记录（按 ID 索引，完整字段见同目录 JSON 侧车）', '');
    for (const item of overflow) {
      const r = record(item.recordId);
      lines.push(`- \`${item.recordId}\` ${esc(r.fields.title?.value ?? r.lead.title)} — ${esc(r.fields.employer?.value ?? r.lead.employer)}：${esc(item.reason ?? item.category)}`);
    }
    lines.push('');
  }
  lines.push('## 诊断（未推荐，不代表不合适）', '');
  const diagnostics = items.filter(i => ['excluded', 'closed', 'decided', 'identity-anomaly', 'unassessed', 'mirror-expired'].includes(i.category));
  const shown = diagnostics.slice(0, 15), diagnosticOverflow = diagnostics.slice(15);
  for (const item of shown) {
    const r = record(item.recordId);
    lines.push(`- ${esc(r.fields.title?.value ?? r.lead.title)} — ${esc(r.fields.employer?.value ?? r.lead.employer)}：${esc(item.reason)}`);
    const obs = obstacles(item);
    if (obs.length) lines.push(`  - 障碍：${obs.join('；')}`);
    const unread = unreadReason(r);
    if (unread && ['unassessed', 'identity-anomaly'].includes(item.category)) lines.push(`  - 未读原因：${esc(unread)}`);
    lines.push(`  - 记录：\`${r.recordId}\``);
  }
  if (diagnosticOverflow.length) {
    lines.push('', `其余 ${diagnosticOverflow.length} 条诊断记录按 ID 索引（完整字段见同目录 JSON 侧车）：`, '');
    for (const item of diagnosticOverflow) {
      const r = record(item.recordId);
      lines.push(`- \`${r.recordId}\` ${esc(r.fields.title?.value ?? r.lead.title)} — ${esc(r.fields.employer?.value ?? r.lead.employer)}：${esc(item.reason)}`);
    }
  }
  lines.push('', '## 状态变化与去重', '');
  for (const w of withdrawals) lines.push(`- 撤回此前${w.scope === 'advertisement' ? '广告' : '岗位'}：${esc(w.title)} — ${esc(w.employer)}。${esc(w.reason)}（不改写历史报告）`);
  if (pendingHistory.length) lines.push(`- ${pendingHistory.length} 个历史推荐本轮未重新核实：不等于已关闭。`);
  lines.push(`- 已决定排除：${items.filter(i => i.category === 'decided').length}；无实质变化而不重复展示：${report.unchanged}。`,
    `- 招聘渠道待核查：${channels.length} 条（面向雇主的渠道页面，不是岗位推荐，不计入岗位统计）。`,
    `- 发现 ${Object.keys(report.records).length} 条记录；已评估 ${items.filter(i => i.judgment).length} 条；未评估 ${items.filter(i => i.category === 'unassessed').length} 条。未评估不等于不合适。`,
    '', '## 来源与预算', '');
  for (const s of state.sources) lines.push(`- ${link(s.name, s.url)}：${s.status}；实际读到 ${s.reviewed} 条${s.advertisedTotal != null ? `／列表标称 ${s.advertisedTotal}` : ''}。${esc(s.reason ?? s.note ?? '')}`);
  const budget = state.budget, groups = budget.groups ?? {}, limits = budget.limits ?? {};
  const stageGroups = budget.stageGroups ?? {};
  const stageRobots = budget.stageRobots ?? {};
  // Each stage prints its own ledger, taken from the same run's counters.
  const stageLine = (stage, label) => {
    const g = stageGroups[stage] ?? { boards: 0, linkedin: 0, search: 0 };
    const r = stageRobots[stage] ?? { boards: 0, linkedin: 0, search: 0 };
    return `${label} ${budget.used[stage] ?? 0}/${limits[stage] ?? 0}（boards ${g.boards ?? 0}，其中 robots.txt ${r.boards ?? 0} 次；linkedin ${g.linkedin ?? 0}，其中 robots.txt ${r.linkedin ?? 0} 次；search ${g.search ?? 0}，其中 robots.txt ${r.search ?? 0} 次）`;
  };
  const request = state.request ?? null;
  lines.push(`- WebSearch：${state.tickets.length ? state.tickets.map(t => `ticket ${t.id}: ${t.status}${t.error ? ` (${esc(t.error)})` : ''}`).join('；') : 'not-started'}。搜索工具的结果由模型报回；不可观察上游内部请求。`,
    `- 可观察调用／预留票据（${request ? '本次请求累计账目，含本轮' : '本次运行账目'}）：${stageLine('discovery', '发现')}；${stageLine('detail', '详情')}；${stageLine('application', '申请')}。robots.txt 读取合计 ${budget.robotsUsed ?? 0} 次；跳转和 robots 请求均已计入上列数字，没有单独的 robots 上限。`);
  if (request) {
    const own = request.own?.used ?? request.own ?? {};
    lines.push(`- 本次请求（requestId ${esc(request.requestId ?? '')}，${request.kind === 'new' ? '本次开启的新请求' : '本次请求的续跑'}）：同一请求内的所有轮次共用同一份可观察调用预算（发现 ${limits.discovery ?? 20}／详情 ${limits.detail ?? 20}／申请 ${limits.application ?? 10}），本轮为该请求的第 ${request.runIndex}/${request.maxRuns} 轮，重开 run 不会把预算重置。同一请求同时只有一个活跃运行：产出报告即结束该运行，未完成的运行用 end --run RUN_ID 关闭，之后才能续跑。用户明确发起的新一次扫描用 start --new-request 开启新请求：新请求的预算独立，不结转上一次请求的用量。本轮自身用掉：发现 ${own.discovery ?? 0}、详情 ${own.detail ?? 0}、申请 ${own.application ?? 0}。`,
      `- 本项目请求账目：${requestLedgerText(report.ledger)}`,
      `- 网络时间用量：${Math.round((state.networkSpentMs ?? 0) / 1000)} 秒／${Math.round((state.networkBudgetMs ?? 0) / 1000)} 秒；模型思考时间不计入。`,
      `- ${esc(report.stopReason)}；本轮未进行登录态读取、自动投递、简历上传或邮件发送。`);
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
  const stopReason = budgetShort.length ? `阶段预算已到（${budgetShort.map(k => `${k} ${state.budget.used[k]}/${state.budget.limits[k]}`).join('，')}），未挤占后段预算` : '按当前已取得证据结束；未完成来源和未评估条目已披露';
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
