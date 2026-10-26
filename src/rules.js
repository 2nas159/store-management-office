// Agents Office — auto approve rules, the pure part (STORE, spec 0002; moved here 26 Oct 2026 for spec 0006).
// Shared by the server (approvals.mjs re-exports it) and the page (the Automations screen checks a rule as it is typed,
// with the same sentences the server and `npm run check` print). No DOM, no Node.
import { KINDS, num } from './actions.js';
import { DEPT_KEYS } from './data.js';

export const MONEY = ['refund', 'payment'];
const slug = t => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const given = v => v !== undefined && v !== null && v !== '';
const list = v => (Array.isArray(v) ? v : given(v) ? [v] : []).map(x => String(x).trim()).filter(Boolean);
const m2 = n => Number(n).toFixed(2);

/** One rule → { rule, problems }. A rule with a problem is not used. */
export function validate(r, existing = []) {
  const problems = [], out = {};
  out.title = String(r?.title || '').trim().slice(0, 80);
  out.id = String(r?.id || slug(out.title) || '').trim();
  const name = out.id || out.title || 'a rule';
  const bad = why => problems.push(`${name}: ${why}`);
  if (!r || typeof r !== 'object' || Array.isArray(r)) return { rule: null, problems: ['a rule is not an object'] };
  if (!out.id) bad('no id or title');
  if (out.id === 'pause' || out.id === 'resume') bad('"pause" and "resume" are kept for the switch of all rules; pick another id');
  if (!out.title) out.title = out.id;
  if (existing.some(x => x.id === out.id)) bad('two rules share this id');
  out.kinds = list(r.kinds); if (!out.kinds.length) bad('no kinds (which actions it covers)');
  for (const k of out.kinds) if (!KINDS.includes(k)) bad(`"${k}" is not a kind (${KINDS.join(', ')})`);
  out.tools = list(r.tools); for (const t of out.tools) if (!/^mcp__.+?__.+$/.test(t)) bad(`tool "${t}" is not of the shape mcp__<server>__<tool>`);
  out.to = list(r.to);
  out.depts = list(r.depts); for (const d of out.depts) if (!DEPT_KEYS.includes(d)) bad(`"${d}" is not a department (${DEPT_KEYS.join(', ')})`);
  out.routines = list(r.routines);
  for (const k of ['max', 'maxPercent', 'dailyMax', 'dailyCount']) {
    out[k] = null; if (!given(r[k])) continue;
    const n = num(r[k]); if (!(n > 0)) { bad(`${k} must be a number above 0`); continue; } out[k] = n;
  }
  if (out.maxPercent !== null && out.maxPercent > 100) bad('maxPercent must be at most 100');
  if (out.dailyCount !== null && !Number.isInteger(out.dailyCount)) bad('dailyCount must be a whole number');
  out.currency = given(r.currency) ? String(r.currency).trim().toUpperCase() : null;
  if (out.currency !== null && !/^[A-Z]{3}$/.test(out.currency)) bad(`currency must be a three letter code (got "${r.currency}")`);
  if (out.kinds.some(k => MONEY.includes(k)) && (out.max === null || out.currency === null || out.dailyMax === null)) bad('a refund or payment rule needs max, currency and dailyMax (a daily money cap)');
  if (out.kinds.includes('discount') && out.maxPercent === null && out.max === null) bad('a discount rule needs maxPercent or max');
  if (out.max !== null && (out.currency === null || out.dailyMax === null)) bad('a rule with max needs currency and dailyMax');
  if (out.kinds.some(k => !MONEY.includes(k)) && out.dailyCount === null) bad(`a rule for ${out.kinds.filter(k => !MONEY.includes(k)).join(', ')} needs dailyCount (at most how many a day)`);
  out.paused = r.paused === true;
  return { rule: out, problems };
}
// a validated rule as it is written to the file (empty fields left out)
export const clean = r => Object.fromEntries(Object.entries({ id: r.id, title: r.title, kinds: r.kinds, max: r.max, currency: r.currency, dailyMax: r.dailyMax, maxPercent: r.maxPercent, dailyCount: r.dailyCount, depts: r.depts, routines: r.routines, tools: r.tools, to: r.to, paused: r.paused || undefined })
  .filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && !v.length)));

export function describeRule(r) {
  const bits = [r.kinds.map(k => k.replace(/_/g, ' ')).join(', ')];
  if (r.max !== null) bits.push(`up to ${m2(r.max)} ${r.currency} each`);
  if (r.maxPercent !== null) bits.push(`up to ${r.maxPercent}%`);
  if (r.dailyMax !== null) bits.push(`at most ${m2(r.dailyMax)} ${r.currency} a day`);
  if (r.dailyCount !== null) bits.push(`at most ${r.dailyCount} a day`);
  if (r.depts.length) bits.push(r.depts.join(', ') + ' only');
  if (r.routines.length) bits.push('from ' + r.routines.join(', '));
  if (r.tools.length) bits.push('through ' + r.tools.join(', '));
  if (r.to.length) bits.push('to ' + r.to.join(', '));
  return bits.join(' · ');
}

/** STORE (26 Oct 2026, spec 0006): what an edit lets through that the rule did not before, in words. [] = it is not wider. */
export function widens(was, now) {
  const out = [], up = (k, words, unit = '') => { if (now[k] !== null && (was[k] === null || now[k] > was[k] + 1e-9)) out.push(`${words} ${was[k] === null ? 'had no limit of its own' : was[k] + unit} → ${now[k]}${unit}`); };
  const added = now.kinds.filter(k => !was.kinds.includes(k)); if (added.length) out.push(`it now covers ${added.map(k => k.replace(/_/g, ' ')).join(', ')}`);
  up('max', 'the most per action', now.currency ? ' ' + now.currency : ''); up('dailyMax', 'the daily money cap', now.currency ? ' ' + now.currency : ''); up('maxPercent', 'the most percent', '%'); up('dailyCount', 'the daily count');
  if (was.currency && now.currency && was.currency !== now.currency) out.push(`the currency is now ${now.currency}, not ${was.currency}`);
  for (const [k, words] of [['depts', 'departments'], ['routines', 'routines and triggers'], ['tools', 'tools'], ['to', 'recipients']]) {
    if (was[k].length && (!now[k].length || now[k].some(x => !was[k].includes(x)))) out.push(now[k].length ? `more ${words}: ${now[k].filter(x => !was[k].includes(x)).join(', ')}` : `no longer limited to these ${words}: ${was[k].join(', ')}`);
  }
  if (was.paused && !now.paused) out.push('it is switched back on');
  return out;
}
