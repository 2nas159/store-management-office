// Agents Office — outbound action lists and the call gate (STORE, spec 0001: docs/specs/0001-outbound-action-list-drafts.md).
// A draft that waits for the owner's OK ends with a fenced ```actions block: a strict JSON list of what
// it will send, pay or change, each with the exact connector tool. The server parses and validates it
// (no second model call: a broken block locks APPROVE until REJECT redrafts it). Approving runs one
// Claude process whose allowed tools are exactly the listed ones, behind a PreToolUse hook (gate.mjs)
// that lets each tool through as many times as actions name it and blocks everything else. Each
// action's outcome comes from the real tool calls in the run's stream.
//
//   draftLine(role)            the draft instructions: 'single' and 'lead' write the block, 'piece' does not
//   parse(text)                → { list, body } | { why, body }   body = the draft without the fence
//   validate(list, opts)       → { actions } | { why }             opts: { servers, currency, sdk }
//   approve(task, opts)        the gated approve run → { actions, gateDenied, gateFailed, text, error, ran }
//   outcomes(actions, calls, decisions)   done · failed · unknown · not_done, matched by arguments then order
//   noteSection / noteLine     the brain note's ## Actions section and front matter line
//   closeOut(task)             an approve the office was stopped in the middle of → done, outcomes unknown
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KINDS, STATUS_TEXT, summary, cardLines, outcomeLine, readOf, OLD_WHY, money, found, num } from './src/actions.js';
export { KINDS, STATUS_TEXT, summary, cardLines, outcomeLine, readOf, OLD_WHY, money, found };

const GATE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'gate.mjs');
export const BROWSER = 'claude-in-chrome';
export const MAX = 10;
const NEED_AMOUNT = ['refund', 'payment'];
const STOPPED = 'the office stopped while sending, check before resending';

/* ---------- the draft ---------- */
const DRAFT = '\nPrepare everything, but send, post, pay or change NOTHING outside this machine: the owner reads this first and approves it.' +
  ' The office blocks every write tool while you draft: if a call is blocked, do not try it again or another way.'; // STORE spec 0003
const EXAMPLE = '```actions\n[\n {"kind":"reply","tool":"mcp__claude_ai_Gmail__send_message","to":"jane@example.com","summary":"Reply to Jane: order #1042 ships Friday","content":"Hi Jane, your order #1042 ships on Friday. Thank you for waiting."},\n {"kind":"refund","tool":"mcp__shopify__refund_create","to":"#1042","amount":12.5,"currency":"USD","summary":"Refund the shipping on order #1042"}\n]\n```';
export function draftLine(role = 'single') {
  if (role === 'piece') return DRAFT + ' Say in one line what your piece would send, if anything. Do not write an actions block: the lead writes the one list for the whole team.';
  return DRAFT + ' Say in one line what will go out when approved (or that nothing needs to).' +
    `\n\nThen end your reply with an ACTIONS BLOCK, the last thing in it${role === 'lead' ? ', covering everything the team\'s deliverable sends' : ''}: a fenced block that opens with \`\`\`actions and holds a strict JSON list (double quotes, no comments, no trailing commas), one object per outbound action, at most ${MAX}. When nothing goes out, the block holds [].\n` +
    `Fields of each action:\n- kind: one of ${KINDS.join(', ')}\n- tool: the exact name of the tool from your own tool list that does the sending, mcp__<server>__<tool> (the tool that sends, not one that saves a draft); use ToolSearch to find one you have not seen yet. The browser cannot carry an approved action.\n` +
    '- to: who or what it goes to (an email address, a customer, an order number, a channel)\n- summary: one line, at most 140 characters, of what the owner is approving\n- amount: the money it moves, a number above 0; refund and payment need it\n- currency: the three letter code that goes with amount (USD, EUR, GBP)\n- percent: a percent discount, above 0 and at most 100; a discount needs amount or percent\n- content: the exact text that goes out, at most 4,000 characters (leave it out when there is none)\n' +
    'After the OK, a separate step makes exactly one call per action with exactly that tool, and it cannot look anything up: resolve every id, address and amount now and write it into the action.\n' +
    `Example:\n${EXAMPLE}`;
}
const bare = list => (list || []).map(({ outcome, id, ...a }) => a);
export function reworkLine(prev) {
  return Array.isArray(prev) && prev.length ? `\nThe actions list of your previous version was:\n${JSON.stringify(bare(prev))}\nWrite the list again for the new version, same rules, as the last thing in your reply.` : '';
}

/* ---------- parse + validate ---------- */
// the LAST ```actions fence; only the fence itself leaves the draft
export function parse(text) {
  const s = String(text || ''); const re = /```actions[ \t]*\r?\n([\s\S]*?)```/g;
  let m, last = null; while ((m = re.exec(s))) last = m;
  if (!last) return { why: 'the draft has no actions block', body: s.trim() };
  const body = (s.slice(0, last.index).replace(/\s+$/, '') + '\n\n' + s.slice(last.index + last[0].length).replace(/^\s+/, '')).trim();
  let list; try { list = JSON.parse(last[1]); } catch (e) { return { why: 'the actions block is not valid JSON', body }; }
  if (!Array.isArray(list)) return { why: 'the actions block is not a JSON list', body };
  return { list, body };
}
const given = v => v !== undefined && v !== null && v !== '';
const TOOL = /^mcp__(.+?)__(.+)$/;
// servers: [{ id, tools }] as mcp.usable() gives them · sdk: the API key backend, which has no connectors (the connected check is skipped)
export function validate(list, { servers = [], currency = 'USD', sdk = false } = {}) {
  if (!Array.isArray(list)) return { why: 'the actions block is not a JSON list' };
  if (list.length > MAX) return { why: `the list has ${list.length} actions, at most ${MAX}` };
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const n = i + 1, raw = list[i], bad = why => ({ why: `action ${n}: ${why}` });
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('is not an object');
    const a = {}; for (const [k, v] of Object.entries(raw)) a[k] = typeof v === 'string' ? v.trim() : v;
    if (!KINDS.includes(a.kind)) return bad(`${given(a.kind) ? `"${a.kind}" is not a kind` : 'has no kind'} (${KINDS.join(', ')})`);
    const to = typeof a.to === 'number' ? String(a.to) : a.to;
    if (typeof to !== 'string' || !to) return bad(`${a.kind} has no recipient (to)`);
    if (typeof a.summary !== 'string' || !a.summary) return bad(`${a.kind} has no summary`);
    if (a.summary.length > 140) return bad(`the summary is ${a.summary.length} characters, at most 140`);
    const tm = typeof a.tool === 'string' && TOOL.exec(a.tool);
    if (!tm) return bad(`${a.kind} has no tool of the shape mcp__<server>__<tool>`);
    if (tm[1] === BROWSER) return bad('the browser cannot carry an approved action yet');
    if (!sdk) {
      const s = servers.find(x => x.id === tm[1]);
      if (!s) return bad(`the connector ${tm[1]} is not connected or not allowed`);
      if (s.tools?.length && !s.tools.includes(tm[2])) return bad(`${tm[1]} has no tool named ${tm[2]}`);
    }
    let amount = null, percent = null, cur = null;
    if (given(a.amount)) { amount = num(a.amount); if (!(amount > 0)) return bad('amount must be a number above 0'); }
    if (given(a.percent)) { percent = num(a.percent); if (!(percent > 0 && percent <= 100)) return bad('percent must be above 0 and at most 100'); }
    if (NEED_AMOUNT.includes(a.kind) && amount === null) return bad(`${a.kind} has no amount`);
    if (a.kind === 'discount' && amount === null && percent === null) return bad('discount has no amount or percent');
    if (amount !== null) {
      cur = given(a.currency) ? String(a.currency).toUpperCase() : String(currency || 'USD').toUpperCase();
      if (!/^[A-Z]{3}$/.test(cur)) return bad(`currency must be a three letter code (got "${a.currency}")`);
    }
    if (given(a.content) && typeof a.content !== 'string') return bad('content must be text');
    if (given(a.content) && a.content.length > 4000) return bad(`the content is ${a.content.length} characters, at most 4,000`);
    out.push({ id: 'a' + n, kind: a.kind, tool: a.tool, to, amount, percent, currency: cur, summary: a.summary, ...(given(a.content) ? { content: a.content } : {}) });
  }
  return { actions: out };
}
// the draft run's text → what is stored on the waiting task
export function fromDraft(text, opts) {
  const p = parse(text); const v = p.why ? p : validate(p.list, opts);
  return v.why ? { body: p.body, actions: [], actionsRead: 'unreadable', actionsWhy: v.why } : { body: p.body, actions: v.actions, actionsRead: 'ok' };
}

/* ---------- the approve run ---------- */
export function approveSystem(agent, list, draft, { business = 'the business', deptName = '' } = {}) {
  return `You are ${agent.name}, ${agent.role || 'an agent'}${deptName ? `, in the ${deptName} department` : ''} of ${business}. The owner has APPROVED the outbound actions in the request. Carry out exactly those actions and nothing else:\n` +
    '- one tool call per action, with the tool it names, using its to, amount, currency, percent and content as written\n- no other tools, no lookups, no second try when a call fails or is blocked\n- if an action cannot be done as written, leave it and say why\n' +
    'Then report in one short section, one line per action id: what went out and to whom, or what went wrong. Plain text, no preamble.\n\n' +
    `THE APPROVED DRAFT (context only; the actions are what you do)\n${String(draft || '').slice(0, 6000)}`;
}
export const approveUser = list => `Approved actions, in this order:\n${JSON.stringify(list.map(({ outcome, ...a }) => a), null, 1)}`;
const fwd = p => p.split(path.sep).join('/'); // the hook command runs in a shell; forward slashes read the same in Git Bash and cmd
// STORE spec 0002: one slot per action (named by its id). strict (an auto approved run): a call takes a slot only when the
// action's amount and recipient are found in its input; otherwise it is blocked
export function prepareGate(dir, list, { strict = false } = {}) {
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const actions = list.map((a, i) => ({ id: a.id || 'a' + (i + 1), tool: a.tool, to: a.to ?? null, amount: a.amount ?? null, strict: !!strict }));
  fs.writeFileSync(path.join(dir, 'budget.json'), JSON.stringify({ actions }));
  return hookSettings(dir);
}
function hookSettings(dir) {
  const command = `"${fwd(process.execPath)}" "${fwd(GATE)}" "${fwd(dir)}"`;
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 30 }] }] } }));
  return file;
}
/* ---------- STORE spec 0003: drafts and read-only routines run with the gate in read mode ---------- */
export const READ_LINE = '\nThis run may only read: the office blocks every tool that sends, posts, pays or changes something, before it runs. If a call is blocked, do not try it again or another way; say in your reply what you would have done.';
export function prepareReadGate(dir, gate = {}) {
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'budget.json'), JSON.stringify({ mode: 'read', gate: { read: gate.read || [], write: gate.write || [] } }));
  return hookSettings(dir);
}
// after a read-mode run: what the gate blocked, and whether an MCP call ran with no decision (the hook did not run)
export function readRun(dir, calls = []) {
  const { decisions } = readGate(dir), seen = new Set(decisions.map(d => d.id).filter(Boolean));
  return { runDenied: decisions.filter(d => d.allow === false).map(d => ({ tool: d.tool, why: d.why || '', at: d.at })), runGateFailed: calls.some(c => /^mcp__/.test(c.name || '') && !seen.has(c.id)) };
}
export function runNote(task) {
  if (!task.runDenied?.length && !task.runGateFailed) return '';
  return `## Blocked while ${task.draft ? 'drafting' : 'running'}\n${(task.runDenied || []).map(d => `- ${d.tool}: ${d.why}`).join('\n')}${task.runGateFailed ? '\n- The gate did not run for every call: check what this run did.' : ''}\n`;
}
export function readGate(dir) {
  let txt = ''; try { txt = fs.readFileSync(path.join(dir, 'decisions.jsonl'), 'utf8'); } catch {}
  return { decisions: txt.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) };
}
// calls: [{ id, name, input, ok, error }] from askX (ok null = no result came back) · decisions: the gate's lines
// (STORE spec 0002: a line may name the action the gate gave the call, and a blocked line its reason)
export function outcomes(list, calls = [], decisions = [], at = Date.now()) {
  const dec = new Map(decisions.filter(d => d.id).map(d => [d.id, d]));
  const acts = list.map(a => ({ ...a, ...(a.outcome ? { outcome: { ...a.outcome } } : {}) }));
  let gateFailed = false;
  for (const c of calls) {
    if (!/^mcp__/.test(c.name || '')) continue;
    const d = dec.get(c.id);
    if (!d) gateFailed = true; // the hook never ran for this call: it went through ungated, so it still counts
    else if (!d.allow) continue;
    const open = acts.filter(a => !a.outcome && a.tool === c.name); if (!open.length) continue;
    const a = open.find(x => x.id === d?.action) || open.find(x => found(x, c.input).ok) || open[0], f = found(a, c.input);
    a.outcome = { status: c.ok === true ? 'done' : c.ok === false ? 'failed' : 'unknown', at, ...(c.ok === false && c.error ? { error: String(c.error).slice(0, 500) } : {}), ...(f.flag ? { flag: f.flag } : {}) };
  }
  const why = decisions.filter(d => d.allow === false && d.why);
  for (const a of acts) if (!a.outcome) { const w = why.find(d => d.tool === a.tool); if (w) why.splice(why.indexOf(w), 1); a.outcome = { status: 'not_done', at, ...(w ? { error: w.why } : {}) }; }
  return { actions: acts, gateDenied: decisions.filter(d => d.allow === false).map(d => ({ tool: d.tool, at: d.at, ...(d.why ? { why: d.why } : {}) })), gateFailed };
}
// opts: { agent, deptName, business, servers, sdk, dir, ask (askX), model, effort, strict (spec 0002: an auto approved run) }
export async function approve(task, { agent, deptName, business, servers = [], sdk = false, dir, ask, model, effort, strict = false }) {
  const at = Date.now();
  const list = (task.actions || []).map(({ outcome, ...a }) => a);
  for (const a of list) {
    if (sdk) a.outcome = { status: 'not_done', at, error: 'the API key backend has no connectors' };
    else if (!servers.some(s => s.id === TOOL.exec(a.tool)?.[1])) a.outcome = { status: 'not_done', at, error: 'connector not connected' };
  }
  const runnable = list.filter(a => !a.outcome);
  if (!runnable.length) return { actions: list, gateDenied: [], gateFailed: false, ran: false, text: 'Nothing was sent: ' + [...new Set(list.map(a => a.outcome.error))].join('; ') + '.', error: null, tools: [] };
  const settings = prepareGate(dir, runnable, { strict });
  let out = null, err = null;
  try { out = await ask(approveSystem(agent, runnable, task.draft, { business, deptName }), approveUser(runnable), { model, effort, only: [...new Set(runnable.map(a => a.tool))], settings }); }
  catch (e) { err = e; }
  const { decisions } = readGate(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  const calls = out?.calls || err?.calls || [];
  return { ...outcomes(list, calls, decisions), ran: true, text: out?.text || '', error: err ? err.message : null, tools: out?.tools || [...new Set(calls.map(c => c.name))] };
}
// AC-15: the office stopped in the middle of an approve; what went out is not known
export function closeOut(task, at = Date.now()) {
  task.actions = (task.actions || []).map(a => a.outcome ? a : { ...a, outcome: { status: 'unknown', at, error: STOPPED } });
  Object.assign(task, { state: 'done', doneAt: at, approved: true, approvedAt: task.approvedAt || at, error: false,
    result: (task.draft || task.result || '') + '\n\n---\nAFTER YOUR OK\nThe office stopped while sending. Check what went out before you send anything again.' });
  delete task.approving;
  return task;
}

/* ---------- the brain note ---------- */
export function noteLine(list) {
  const n = s => list.filter(a => a.outcome?.status === s).length;
  return `actions: ${list.length} · done ${n('done')} · failed ${n('failed')} · not done ${n('not_done')} · unknown ${n('unknown')}`;
}
export function noteSection(list, { gateDenied = [], gateFailed = false } = {}) {
  const lines = list.length ? list.map(a => '- ' + outcomeLine(a)) : ['- Nothing went out, this draft had no outbound actions.'];
  if (gateDenied.length) lines.push(`- Blocked by the gate: ${gateDenied.map(d => d.tool).join(', ')}`);
  if (gateFailed) lines.push('- The gate did not run for every call: check what went out.');
  return `## Actions\n${lines.join('\n')}\n`;
}
