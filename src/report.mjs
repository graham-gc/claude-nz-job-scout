import { join } from 'node:path';
import { lstat } from 'node:fs/promises';
import { readJson, put, reports, hash } from './store.mjs';
import { nzDate, classify, hardChecks } from './criteria.mjs';
import { sameIdentity } from './evidence.mjs';
import { excluded, validateJudgments, verifyApplication } from './engine.mjs';

const esc = text => String(text ?? '').replace(/[\[\]<>*_`|]/g, x => `\\${x}`).replace(/\s+/g, ' ').trim();
const link = (title, url) => `[${esc(title)}](<${new URL(url).href}>)`;
const value = (r, name) => r.fields[name]?.value ?? '未披露／未读到';
const material = item => hash({ ids: item.record.ids, fields: Object.fromEntries(Object.entries(item.record.fields).map(([k, v]) => [k, v.value])),
  application: { status: item.record.application.status, kind: item.record.application.kind, url: item.record.application.url, email: item.record.application.email }, category: item.category, fit: item.judgment?.fit });

export function coverage(state) {
  const http = state.attempts.filter(a => a.kind === 'http'), received = http.filter(a => a.status === 200 && !/robots\.txt$/.test(a.url));
  if (!http.length && !state.tickets.some(t => t.status !== 'pending')) return 'not-started';
  if (!received.length && !state.tickets.some(t => t.status === 'completed')) return 'blocked';
  const inventoryDone = state.sources.every(s => s.status === 'completed' && s.inventoryComplete);
  return inventoryDone && state.tickets.some(t => t.status === 'completed') && state.records.every(r => r.readState === 'read') ? 'complete' : 'partial';
}
function jobLines(item) {
  const { record: r, judgment: j, checks } = item;
  const title = value(r, 'title') === '未披露／未读到' ? r.lead.title || '未确认职位' : value(r, 'title');
  const employer = r.fields.employer?.value ?? r.lead.employer ?? '未确认雇主';
  const lines = [`### ${esc(title)} — ${esc(employer)}`, '', `- 地点／方式：${esc(value(r, 'location'))} · ${esc(value(r, 'workArrangement'))}`,
    `- 工作性质：${esc(value(r, 'engagement'))} · ${esc(value(r, 'contractType'))} · ${esc(value(r, 'workload'))} · ${esc(value(r, 'hoursPerWeek'))} 小时／周`,
    `- 发布：${esc(value(r, 'postedAt'))}${r.fields.postedAt?.semantics ? `（${esc(r.fields.postedAt.semantics)}）` : ''}；截止：${esc(value(r, 'closesAt'))}`,
    `- 薪酬：${esc(value(r, 'salary'))}；薪酬状态：${esc(r.fields.payStatus?.value ?? 'unknown')}${r.fields.engagement?.value === 'volunteer' ? ' · **Volunteer**' : ''}`,
    `- 匹配判断：${esc(j?.fit ?? '未评估')}。${(j?.reasons ?? [item.reason]).map(esc).join('；')}`];
  if (r.application.status === 'verified') {
    if (r.application.kind === 'email') lines.push(`- 申请方式：发邮件至 **${esc(r.application.email)}**。原帖要求：${esc(r.application.instruction)}`);
    else lines.push(`- **${link('直接申请', r.application.url)}**（已读到本岗位专属表单，未提交）`);
  } else lines.push(`- 申请路径未核验：${esc(r.application.reason)}。下方详情链接不是已验证申请入口。`);
  lines.push(`- ${link('职位详情', r.canonicalUrl)}`);
  const unknown = checks.filter(c => c.status !== 'satisfied');
  if (unknown.length) lines.push(`- 主要障碍：${unknown.map(c => `${esc(c.name)}：${esc(typeof c.detail === 'string' ? c.detail : JSON.stringify(c.detail))}`).join('；')}`);
  if (r.detailError) lines.push(`- 页面读取：${esc(r.detailError)}`);
  if (r.opportunityKind?.value === 'talent-pool') lines.push('- 这是人才池，不保证有空缺或面试，不作为现有职位统计。');
  const evidence = Object.entries(r.fields).filter(([k, f]) => k !== 'duties' && f.source).map(([name, f]) => `${esc(name)} → ${link('来源', f.source.url)}`);
  lines.push(`- 记录：\`${r.recordId}\`；字段证据：${evidence.join('；')}`, '');
  return lines;
}
export function render(report) {
  const { state, items, newItems, withdrawals, pendingHistory } = report;
  const lines = ['# New Zealand Job Scout', '', `生成：${report.generatedAt} · Pacific/Auckland 日期 ${report.date}`, '',
    `简历已读取；职位族：${state.config.roleFamilies.map(esc).join('、')}；首发窗口：${state.config.postingDays} 天。`,
    `覆盖度：**${report.coverage}**（仅指本轮计划，不代表整个市场）。`, ''];
  for (const [category, name] of [['ready', '可以投'], ['check', '值得确认'], ['unresolved', '高价值线索：尚未读到可信完整原帖'], ['pool', '人才池：不是确定空缺']]) {
    lines.push(`## ${name}`, '');
    const section = newItems.filter(i => i.category === category);
    if (section.length) for (const item of section) lines.push(...jobLines(item));
    else lines.push(category === 'ready' ? '在可访问的来源中没有新增的、核验通过且有可用申请方式的岗位。' : '本轮无新增。', '');
  }
  lines.push('## 状态变化与去重', '');
  for (const w of withdrawals) lines.push(`- 撤回此前${w.scope === 'advertisement' ? '广告' : '岗位'}：${esc(w.title)} — ${esc(w.employer)}。${esc(w.reason)}（不改写历史报告）`);
  if (pendingHistory.length) lines.push(`- ${pendingHistory.length} 个历史推荐本轮未重新核实：不等于已关闭。`);
  lines.push(`- 已决定排除：${items.filter(i => i.category === 'decided').length}；无实质变化而不重复展示：${report.unchanged}。`, '', '## 已排除与未评估', '');
  for (const item of items.filter(i => ['excluded', 'closed', 'decided'].includes(i.category))) lines.push(`- ${esc(item.record.fields.title?.value ?? item.record.lead.title)} — ${esc(item.record.fields.employer?.value ?? item.record.lead.employer)}：${esc(item.reason)}${item.checks.some(c => c.status === 'conflict') ? '；' + item.checks.filter(c => c.status === 'conflict').map(c => `${esc(c.name)} ${esc(JSON.stringify(c.detail))}`).join('；') : ''}`);
  lines.push(`- 发现 ${state.records.length} 条记录；已评估 ${items.filter(i => i.judgment).length} 条；未评估 ${items.filter(i => i.category === 'unassessed').length} 条。未评估不等于不合适。`, '', '## 来源与预算', '');
  for (const s of state.sources) lines.push(`- ${link(s.name, s.url)}：${s.status}；实际读到 ${s.reviewed} 条${s.advertisedTotal != null ? `／列表标称 ${s.advertisedTotal}` : ''}。${esc(s.reason ?? s.note ?? '')}`);
  lines.push(`- WebSearch：${state.tickets.length ? state.tickets.map(t => `ticket ${t.id}: ${t.status}${t.error ? ` (${esc(t.error)})` : ''}`).join('；') : 'not-started'}。搜索工具的结果由模型报回；不可观察上游内部请求。`,
    `- 可观察调用／预留票据：发现 ${state.budget.used.discovery}/20；详情 ${state.budget.used.detail}/20；申请 ${state.budget.used.application}/10。跳转和 robots 请求均计入。`,
    `- ${esc(report.stopReason)}；本轮未进行登录态读取、自动投递、简历上传或邮件发送。`);
  for (const w of state.warnings) lines.push(`- ${esc(w)}`);
  lines.push('', `<!-- nz-job-scout-v1 run=${state.id} context=${state.context} -->`, '');
  return lines.join('\n');
}
export async function produce(root, state, reader, input, now = new Date().toISOString()) {
  const judgments = validateJudgments(input, state), oldState = await readJson(join(root, '.nz-job-scout-state.json'), {});
  const exclusions = [...(oldState.excludedRoles ?? []), ...state.config.exclusions];
  const sorted = [...state.records].sort((a, b) => {
    const rank = r => ({ strong: 0, possible: 1, weak: 2 }[judgments.find(j => j.recordId === r.recordId)?.fit] ?? 3);
    return rank(a) - rank(b);
  });
  for (const r of sorted) {
    const j = judgments.find(j => j.recordId === r.recordId);
    if (j && j.fit !== 'weak' && r.readState === 'read' && !r.closure && !excluded(r, exclusions) && !hardChecks(r, state.config, now).some(c => c.status === 'conflict')) await verifyApplication(r, reader);
  }
  const items = state.records.map(record => {
    const judgment = judgments.find(j => j.recordId === record.recordId), prior = excluded(record, exclusions);
    return { record, judgment, ...(prior ? { category: 'decided', checks: [], reason: `Previously ${prior.decision ?? 'excluded'}; ${prior.reason ?? ''}` } : classify(record, state.config, judgment, now)) };
  });
  const history = (await reports(root)).filter(r => r.context === state.context && Date.parse(now) - Date.parse(r.generatedAt) <= 30 * 86400000).sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
  const previous = [];
  for (const report of history) for (const item of report.items ?? []) if (!previous.some(p => sameIdentity(p.record, item.record))) previous.push(item);
  const withdrawals = [], pendingHistory = [];
  for (const old of previous.filter(i => ['ready', 'check', 'pool', 'unresolved'].includes(i.category))) {
    const current = items.find(i => sameIdentity(i.record, old.record));
    if (current?.record.closure) withdrawals.push({ title: old.record.fields.title?.value ?? old.record.lead.title, employer: old.record.fields.employer?.value ?? old.record.lead.employer, scope: current.record.closure.scope, reason: current.record.closure.quote });
    else if (!current || current.record.readState !== 'read') pendingHistory.push(old.record.recordId);
  }
  const newItems = items.filter(i => ['ready', 'check', 'pool', 'unresolved'].includes(i.category)).filter(i => !previous.some(p => sameIdentity(i.record, p.record) && material(p) === material(i)))
    .sort((a, b) => (a.judgment?.fit === 'strong' ? 0 : 1) - (b.judgment?.fit === 'strong' ? 0 : 1));
  const visible = [], counts = {};
  for (const item of newItems) { counts[item.category] = (counts[item.category] ?? 0) + 1; if (item.category === 'ready' || counts[item.category] <= 5) visible.push(item); }
  if (visible.length < newItems.length) state.warnings.push(`${newItems.length - visible.length} additional uncertain leads are retained in the private JSON report, not promoted to recommendations.`);
  const report = { format: 'nz-job-scout-report-v1', generatedAt: now, date: nzDate(now), context: state.context,
    coverage: coverage(state), state, items, newItems: visible, withdrawals, pendingHistory,
    unchanged: items.filter(i => ['ready', 'check', 'pool', 'unresolved'].includes(i.category)).length - newItems.length,
    stopReason: Date.now() >= state.deadline ? '总截止时间已到，按现有证据出报告' : Object.keys(state.budget.used).some(k => state.budget.used[k] >= state.budget.limits[k]) ? '阶段预算已到，未挤占后段预算' : '按当前已取得证据结束；未完成来源和未评估条目已披露' };
  const base = `nz-jobs-${report.date}`;
  const occupied = await lstat(join(root, 'output', `${base}.md`)).catch(e => { if (e.code !== 'ENOENT') throw e; });
  const name = occupied ? `${base}-${state.id.slice(0, 8)}` : base;
  const json = join(root, 'output', `${name}.json`), md = join(root, 'output', `${name}.md`);
  await put(root, json, report);
  await put(root, md, render(report));
  state.reported = { json, md };
  return { report: md, records: json, coverage: report.coverage, ready: visible.filter(i => i.category === 'ready').length, needsChecking: visible.filter(i => ['check', 'unresolved'].includes(i.category)).length, withdrawals: withdrawals.length };
}
