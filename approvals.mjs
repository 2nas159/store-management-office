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
import { KINDS, readOf } from './src/actions.js';
import { validate, clean, describeRule, widens } from './src/rules.js'; // STORE (26 Oct 2026, spec 0006): the pure part is shared with the page
export { validate, clean, describeRule, widens };

export const file = brainPath => path.join(brainPath, 'Agents Office', 'approvals.json');
export const ledgerFile = dataDir => path.join(dataDir, 'approvals.json');
const KEEP_DAYS = 8;
const slug = t => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const readJSON = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };
const list = v => (Array.isArray(v) ? v : v !== undefined && v !== null && v !== '' ? [v] : []).map(x => String(x).trim()).filter(Boolean);
const m2 = n => Number(n).toFixed(2);
export const dayKey = ms => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }; // the machine's local day, the routines' clock

/* ---------- the rules file ---------- */
/** { paused, rules, problems, path, exists } — bad rules are left out, each named. */
export function load(brainPath) {
  const p = file(brainPath), doc = readJSON(p, null), problems = [], rules = [];
  if (doc !== null && (typeof doc !== 'object' || Array.isArray(doc) || !Array.isArray(doc.rules))) problems.push(`${p}: expected {"paused": false, "rules": [...]}`);
  for (const r of Array.isArray(doc?.rules) ? doc.rules : []) { const v = validate(r, rules); if (v.problems.length) problems.push(...v.problems); else rules.push(v.rule); }
  return { paused: doc?.paused === true, rules, problems, path: p, exists: fs.existsSync(p) };
}
// change the file as written: fn(doc) edits { paused, rules } in place. A rule load() skipped as broken stays in the file untouched
export function edit(brainPath, fn) {
  const p = file(brainPath); const raw = readJSON(p, null);
  const doc = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw, rules: Array.isArray(raw.rules) ? raw.rules : [] } : { paused: false, rules: [] };
  fn(doc);
  fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(doc, null, 2) + '\n');
  return p;
}
/** STORE (26 Oct 2026, spec 0006): the Automations screen — a new rule (id null) or one rule replaced as given; its id never changes.
 *  dry: check and describe only, nothing written (the screen reads the rule back before it turns on). → { rule, desc, widens } | { problems } | { missing } */
export function upsert(brainPath, id, input, { dry = false } = {}) {
  const doc = load(brainPath), was = id ? doc.rules.find(r => r.id === id) : null;
  if (id && !was) return { missing: true, problems: ['no such rule'] };
  const taken = (readJSON(file(brainPath), null)?.rules || []).map(r => String(r?.id ?? '')), base = slug(input?.title || '') || 'rule';
  let rid = id; if (!rid) { rid = base; for (let n = 2; taken.includes(rid) || rid === 'pause' || rid === 'resume'; n++) rid = `${base}-${n}`; }
  const v = validate({ ...input, id: rid, paused: typeof input?.paused === 'boolean' ? input.paused : !!was?.paused }, doc.rules.filter(r => r.id !== rid));
  if (v.problems.length) return { problems: v.problems };
  if (!dry) edit(brainPath, d => { const i = d.rules.findIndex(r => r?.id === rid), c = clean(v.rule); if (i >= 0) d.rules[i] = c; else d.rules.push(c); });
  return { rule: v.rule, desc: describeRule(v.rule), widens: was ? widens(was, v.rule) : [] };
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
  if (r.routines.length && !r.routines.includes(task.routine) && !(task.trigger && r.routines.includes(task.trigger))) return { why: 'scope' }; // spec 0004: a trigger id scopes a rule too
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
  if (task.runDenied?.length) return { why: `the draft tried to write while drafting (${[...new Set(task.runDenied.map(d => String(d.tool).replace(/^mcp__.+?__/, '')))].join(', ')}), so you look at it yourself` }; // STORE spec 0003
  if (task.runGateFailed) return { why: 'the gate did not run for every call while drafting, so you look at it yourself' };
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
// reworked: the draft is a rework after the owner's REJECT — the owner was looking at this one, so it always waits (24 Oct, owner's call)
export function afterDraft(task, { brainPath, dataDir, sdk = false, now = Date.now(), reworked = false }) {
  delete task.autoApproved; delete task.autoWhy;
  const doc = load(brainPath), ledger = loadLedger(dataDir);
  const d = reworked && doc.rules.length ? { why: 'you sent this one back, so its rework waits for you' } : decide(task, { rules: doc.rules, paused: doc.paused, ledger, sdk, now });
  if (!d.ok) { if (d.why) task.autoWhy = d.why; return { auto: false, why: d.why }; }
  record(ledger, d.take, task.id, now); saveLedger(dataDir, ledger, now);
  const titles = new Map(d.take.map(t => [t.rule, t.title]));
  task.autoApproved = { rules: [...titles].map(([id, title]) => ({ id, title })), at: now };
  task.actions = task.actions.map(a => ({ ...a, rule: d.take.find(t => t.action === a.id).rule }));
  return { auto: true, why: '' };
}

/* ---------- words: the panel, the chat, the note ---------- */
export function useText(r, ledger, now = Date.now()) {
  const u = use(ledger, r.id, now), out = [];
  if (r.dailyMax !== null) out.push(`${m2(u.amount)} of ${m2(r.dailyMax)} ${r.currency} today`);
  if (r.dailyCount !== null) out.push(`${u.count} of ${r.dailyCount} today`);
  return out.join(' · ');
}
export const withUse = (doc, ledger, now = Date.now()) => doc.rules.map(r => ({ ...r, desc: describeRule(r), use: useText(r, ledger, now), today: use(ledger, r.id, now) }));
export function listText(doc, ledger, now = Date.now()) {
  if (!doc.rules.length) return 'No auto approve rules yet. Say one — "auto approve refunds under 30 USD, at most 200 a day" — and I will read it back before it goes on. Or press A for the Automations screen.';
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
