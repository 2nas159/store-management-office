// Agents Office — auto approve rules (STORE, spec 0002: docs/specs/0002-auto-approve-rules.md).
// A rule lets small, safe actions go out without waiting for the owner's tick. A draft is approved by rule
// only when its action list (spec 0001) is readable, not empty, and EVERY action fits a rule with room left
// under that rule's daily cap; otherwise it waits as before, and `autoWhy` says why. Nothing a model
// writes can create a rule: they come from the owner's file, the panel, or a chat sentence the owner confirmed.
//
//   <brain>/Agents Office/approvals.json   the owner's rules  { "paused": false, "rules": [ … ] }
//   data/approvals.json                    the ledger (run state): what each rule approved, per day
//
//   { "id": "small-refunds", "title": "Small refunds", "kinds": ["refund"], "max": 30, "currency": "USD", "dailyMax": 200,
//     "depts": ["delivery"], "routines": [], "tools": [], "to": [], "maxPercent": null, "dailyCount": null, "paused": false }
//
// Every rule has a daily cap: refund and payment need max + currency + dailyMax; any other kind needs dailyCount;
// a discount needs maxPercent or max. An action that moves money never fits a rule without max.
import fs from 'node:fs';
import path from 'node:path';
import { KINDS, readOf, num } from './src/actions.js';
import { DEPT_KEYS } from './src/data.js';

export const file = brainPath => path.join(brainPath, 'Agents Office', 'approvals.json');
export const ledgerFile = dataDir => path.join(dataDir, 'approvals.json');
const MONEY = ['refund', 'payment'];
const KEEP_DAYS = 8;
const slug = t => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const readJSON = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };
const given = v => v !== undefined && v !== null && v !== '';
const list = v => (Array.isArray(v) ? v : given(v) ? [v] : []).map(x => String(x).trim()).filter(Boolean);
const m2 = n => Number(n).toFixed(2);
export const dayKey = ms => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }; // the machine's local day, the routines' clock

/* ---------- the rules file ---------- */
/** One rule → { rule, problems }. A rule with a problem is not used. */
export function validate(r, existing = []) {
  const problems = [], out = {};
  out.title = String(r?.title || '').trim().slice(0, 80);
  out.id = String(r?.id || slug(out.title) || '').trim();
  const name = out.id || out.title || 'a rule';
  const bad = why => problems.push(`${name}: ${why}`);
  if (!r || typeof r !== 'object' || Array.isArray(r)) return { rule: null, problems: ['a rule is not an object'] };
  if (!out.id) bad('no id or title');
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
/** { paused, rules, problems, path, exists } — bad rules are left out, each named. */
export function load(brainPath) {
  const p = file(brainPath), doc = readJSON(p, null), problems = [], rules = [];
  if (doc !== null && (typeof doc !== 'object' || Array.isArray(doc) || !Array.isArray(doc.rules))) problems.push(`${p}: expected {"paused": false, "rules": [...]}`);
  for (const r of Array.isArray(doc?.rules) ? doc.rules : []) { const v = validate(r, rules); if (v.problems.length) problems.push(...v.problems); else rules.push(v.rule); }
  return { paused: doc?.paused === true, rules, problems, path: p, exists: fs.existsSync(p) };
}
// a validated rule as it is written to the file (empty fields left out)
export const clean = r => Object.fromEntries(Object.entries({ id: r.id, title: r.title, kinds: r.kinds, max: r.max, currency: r.currency, dailyMax: r.dailyMax, maxPercent: r.maxPercent, dailyCount: r.dailyCount, depts: r.depts, routines: r.routines, tools: r.tools, to: r.to, paused: r.paused || undefined })
  .filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && !v.length)));
// change the file as written: fn(doc) edits { paused, rules } in place. A rule load() skipped as broken stays in the file untouched
export function edit(brainPath, fn) {
  const p = file(brainPath); const raw = readJSON(p, null);
  const doc = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw, rules: Array.isArray(raw.rules) ? raw.rules : [] } : { paused: false, rules: [] };
  fn(doc);
  fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(doc, null, 2) + '\n');
  return p;
}

/* ---------- the ledger: what each rule approved, per local day ---------- */
export const loadLedger = dataDir => { const l = readJSON(ledgerFile(dataDir), null); return { entries: Array.isArray(l?.entries) ? l.entries : [] }; };
export function saveLedger(dataDir, ledger, now = Date.now()) {
  ledger.entries = ledger.entries.filter(e => now - e.at < KEEP_DAYS * 864e5);
  fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(ledgerFile(dataDir), JSON.stringify(ledger, null, 1));
}
export function use(ledger, ruleId, now = Date.now()) {
  const day = dayKey(now); let amount = 0, count = 0;
  for (const e of ledger.entries) if (e.rule === ruleId && dayKey(e.at) === day) { count++; amount += Number(e.amount) || 0; }
  return { amount, count };
}
export function record(ledger, take, taskId, now = Date.now()) {
  for (const t of take) ledger.entries.push({ rule: t.rule, task: taskId, action: t.action, amount: t.amount ?? null, currency: t.currency ?? null, at: now });
}

/* ---------- matching ---------- */
const glob = (pat, s) => new RegExp('^' + pat.split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i').test(String(s));
// does this one action fit this rule (limits, not caps)? → { ok } | { why }
export function fits(a, r, task) {
  if (!r.kinds.includes(a.kind)) return { why: 'kind' };
  if (r.depts.length && !r.depts.includes(task.dept)) return { why: 'scope' };
  if (r.routines.length && !r.routines.includes(task.routine)) return { why: 'scope' };
  if (r.tools.length && !r.tools.includes(a.tool)) return { why: `${r.title} does not allow ${a.tool}` };
  if (r.to.length && !r.to.some(p => glob(p, a.to))) return { why: `${r.title} does not cover ${a.to}` };
  if (a.amount != null) {
    if (r.max === null) return { why: `${r.title} has no money limit` };
    if (r.currency !== a.currency) return { why: `${r.title} is in ${r.currency}, not ${a.currency}` };
    if (a.amount > r.max + 1e-9) return { why: `${m2(a.amount)} ${a.currency} is over the ${m2(r.max)} ${r.currency} limit of ${r.title}` };
  } else if (a.percent != null) {
    if (r.maxPercent === null) return { why: `${r.title} has no percent limit` };
    if (a.percent > r.maxPercent + 1e-9) return { why: `${a.percent}% is over the ${r.maxPercent}% limit of ${r.title}` };
  }
  return { ok: true };
}
/** A draft that just landed → { ok, take: [{ action, rule, title, amount, currency }] } | { why } (why '' = there are no rules, say nothing) */
export function decide(task, { rules = [], paused = false, ledger = { entries: [] }, sdk = false, now = Date.now() } = {}) {
  if (!rules.length) return { why: '' };
  if (paused) return { why: 'auto approvals are paused' };
  if (sdk) return { why: 'the API key backend has no connectors, so nothing is sent by rule' };
  if (!readOf(task).ok) return { why: 'the actions could not be read' };
  if (!task.actions.length) return { why: 'nothing goes out, so it waits for you to read it' };
  const live = rules.filter(r => !r.paused), pending = {}, take = [];
  for (const a of task.actions) {
    const fit = live.map(r => ({ r, f: fits(a, r, task) }));
    const ok = fit.filter(x => x.f.ok);
    if (!ok.length) {
      const near = fit.find(x => x.f.why !== 'kind' && x.f.why !== 'scope');
      return { why: `${a.id}: ${near ? near.f.why : `no rule covers ${String(a.kind).replace(/_/g, ' ')}${live.length < rules.length ? ' (a paused rule might)' : ''}`}` };
    }
    let chosen = null, full = null;
    for (const { r } of ok) {
      const u = use(ledger, r.id, now), p = pending[r.id] || { amount: 0, count: 0 };
      const amountOver = r.dailyMax !== null && a.amount != null && u.amount + p.amount + a.amount > r.dailyMax + 1e-9;
      const countOver = r.dailyCount !== null && u.count + p.count + 1 > r.dailyCount;
      if (amountOver || countOver) { full = full || { r, u, p, amountOver }; continue; }
      chosen = r; pending[r.id] = { amount: p.amount + (a.amount || 0), count: p.count + 1 }; break;
    }
    if (!chosen) {
      const { r, u, p, amountOver } = full;
      return { why: `${a.id}: ${r.title} is at ${amountOver ? `${m2(u.amount + p.amount)} of ${m2(r.dailyMax)} ${r.currency}` : `${u.count + p.count} of ${r.dailyCount}`} today` };
    }
    take.push({ action: a.id, rule: chosen.id, title: chosen.title, amount: a.amount ?? null, currency: a.currency ?? null });
  }
  return { ok: true, take };
}
/** After a draft lands: decide, and on a yes write the ledger FIRST, then mark the task. → { auto: bool, why } */
export function afterDraft(task, { brainPath, dataDir, sdk = false, now = Date.now() }) {
  delete task.autoApproved; delete task.autoWhy;
  const doc = load(brainPath), ledger = loadLedger(dataDir);
  const d = decide(task, { rules: doc.rules, paused: doc.paused, ledger, sdk, now });
  if (!d.ok) { if (d.why) task.autoWhy = d.why; return { auto: false, why: d.why }; }
  record(ledger, d.take, task.id, now); saveLedger(dataDir, ledger, now);
  const titles = new Map(d.take.map(t => [t.rule, t.title]));
  task.autoApproved = { rules: [...titles].map(([id, title]) => ({ id, title })), at: now };
  task.actions = task.actions.map(a => ({ ...a, rule: d.take.find(t => t.action === a.id).rule }));
  return { auto: true, why: '' };
}

/* ---------- words: the panel, the chat, the note ---------- */
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
export function useText(r, ledger, now = Date.now()) {
  const u = use(ledger, r.id, now), out = [];
  if (r.dailyMax !== null) out.push(`${m2(u.amount)} of ${m2(r.dailyMax)} ${r.currency} today`);
  if (r.dailyCount !== null) out.push(`${u.count} of ${r.dailyCount} today`);
  return out.join(' · ');
}
export const withUse = (doc, ledger, now = Date.now()) => doc.rules.map(r => ({ ...r, desc: describeRule(r), use: useText(r, ledger, now), today: use(ledger, r.id, now) }));
export function listText(doc, ledger, now = Date.now()) {
  if (!doc.rules.length) return 'No auto approve rules yet. Say one — "auto approve refunds under 30 USD, at most 200 a day" — and I will read it back before it goes on.';
  return `Auto approve rules${doc.paused ? ' (ALL PAUSED — say "resume auto approvals")' : ''}:\n` + doc.rules.map(r => `• ${r.title} — ${describeRule(r)} · ${useText(r, ledger, now)}${r.paused ? ' · PAUSED' : ''}`).join('\n') +
    '\n\nSay "pause …", "resume …" or "delete …" with a few words from the name and "rule", or "pause auto approvals" for all of them.';
}
export function matchRule(rules, words) {
  const w = String(words).toLowerCase().split(/[^a-z0-9]+/).filter(x => x.length > 2 && !['the', 'rule', 'auto', 'approve', 'one', 'and', 'please'].includes(x));
  let best = null, bestN = 0;
  for (const r of rules) { const hay = (r.id + ' ' + r.title + ' ' + r.kinds.join(' ')).toLowerCase(); const n = w.filter(x => hay.includes(x)).length; if (n > bestN) { bestN = n; best = r; } }
  return bestN ? best : null;
}
export const noteLines = task => (task.autoApproved?.rules || []).map(r => `approved by: rule ${r.id} (${r.title})`).join('\n');

/* ---------- a sentence in a lead's chat → a proposed rule (the owner says yes before it is saved) ---------- */
export const proposes = text => /^\s*(please\s+)?auto[\s-]*approve\b/i.test(text) && !/^\s*auto[\s-]*approve\s+rules?\s*\??\s*$/i.test(text);
export async function parseSentence(ask, sentence, { dept, currency = 'USD', existing = [] }) {
  const system = 'Turn the owner\'s sentence into one auto approve rule for their store office. Return ONLY a JSON object, no prose, no code fences. Use only what the sentence says; leave a field out when it does not say it.';
  const user = `Sentence: "${sentence}"\nDefault currency when an amount has none: ${currency}\n` +
    `Fields: title (short name), kinds (list from: ${KINDS.join(', ')}), max (most money per action), currency (three letters), dailyMax (money per day), dailyCount (actions per day), maxPercent (for percent discounts), to (recipient patterns, * as wildcard), routines (routine ids), tools (exact mcp__ tool names).\n` +
    'Example: "auto approve refunds under 30 dollars, at most 200 a day" → {"title":"Small refunds","kinds":["refund"],"max":30,"currency":"USD","dailyMax":200}';
  let j; try { const t = await ask(system, user, { maxTokens: 600, timeout: 120000, model: 'sonnet' }); const s = t.replace(/```json|```/g, ''); j = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)); }
  catch { return { error: 'I could not turn that into a rule. Try: "auto approve refunds under 30 USD, at most 200 a day".' }; }
  if (!j.title) j.title = (list(j.kinds)[0] || 'rule').replace(/_/g, ' ') + ' rule';
  let id = slug(j.title) || 'rule', n = 2; while (existing.some(r => r.id === id)) id = `${slug(j.title)}-${n++}`;
  const v = validate({ ...j, id, depts: dept ? [dept] : j.depts, paused: false }, existing);
  if (v.problems.length) return { error: `That rule is not complete yet: ${v.problems.map(p => p.replace(/^[^:]+: /, '')).join('; ')}. Say it again with that in it.` };
  return { rule: v.rule };
}
export const confirmText = r => `Here is the rule I would turn on:\n• ${r.title} — ${describeRule(r)}\n\nAnything that fits it goes out without waiting for you, every action of a draft has to fit, and the daily cap stops it. Say "yes" to turn it on; anything else drops it.`;
