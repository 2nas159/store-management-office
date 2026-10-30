// Agents Office — the local server (Beta).
// Serves the office and makes it real on your own Claude login:
//   · the command bar routes a typed task through Claude to the right agent in the department
//   · the agent produces the deliverable, which is saved as a note in your brain folder
//   · the Brain is your vault's real wiki-link graph, rebuilt live as notes are written
//   · chat with any agent is a real conversation in that agent's persona, grounded in your notes
// Everything stays on this machine: data/tasks.json and <brain>/Agents Office/*.md.
//
//   npm start                 → http://localhost:4520
//   PORT=4600 npm start       → another port
//
// Claude backend: the Claude Code CLI (`claude -p`, your existing login) — or the official SDK
// if ANTHROPIC_API_KEY is set. AO_MODEL=<model> overrides the model.
//
// V3.1: the connectors are real — the MCP servers your Claude Code is connected to are what the
// top bar shows and what the agents can call (mcp.mjs); the roster is yours (office.agents.json,
// roster.mjs). Tool calls only happen on the CLI backend: the SDK path has no MCP servers.
// V3.2: how the work is done is yours too — each agent's `brief` (roster.mjs) and the skills
// bound to it (skills.mjs: skills/ + <brain>/Agents Office/skills/) go into every task and chat.
// V3.3: the agents learn — every "revise: …" is recorded and standing rules come back into the
// prompt (learn.mjs); a department lead interviews the owner in chat and writes the briefs and a
// skill for its team (onboard.mjs). Roster, skills and lessons are re-read before every task.
// V3.5: routines — the office keeps its own clock (routines.mjs + src/when.js). A routine in
// <brain>/Agents Office/routines.json fires at its minute whether or not the page is open; the
// server creates the task, runs it here, and a result that needs the owner's OK waits in
// WAITING ON APPROVAL until /approve (the agent then does the outbound step) or /reject (with a
// note, which the agent learns from). STORE (24 Oct 2026): every department (ROUTINE_DEPTS in src/data.js).
// STORE (24 Oct 2026, spec 0001): the draft ends with a list of its outbound actions, and /approve runs exactly those tools,
// once per action, behind a PreToolUse call gate; each action's outcome comes from the real calls (actions.mjs, gate.mjs).
// V3.2 (16 Sep): AGENT TEAMS + CLAUDE IN CHROME. A team task (TEAM in the bar, "as a team" in the sentence,
// `team: true` on a routine) goes to the department lead, who plans the pieces; the office runs one
// Claude process per teammate at the same time (teams.mjs, pool of `teams.max`), keeps the shared
// piece list and the notes they leave each other on the task (`task.team`, polled by the page), and
// the lead writes the finished deliverable from the pieces. Every `claude -p` gets --chrome when
// `tools.browser` is on: the agents can drive the owner's own Chrome (mcp.mjs).
// V3.2.1: the CALENDAR (P). A task can be scheduled for a date (`at` on POST /api/tasks → state
// 'scheduled', `dueAt`; the clock below fires it, marked LATE if the office was off) and a routine
// can start from a date (`when.start`, src/when.js). Cancel = DELETE /api/tasks/:id.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig, ROOT } from './config.mjs';
import { layoutGraph, readVault, readOfficeNotes } from './graph-build.mjs';
import { DEPTS, DEPT_KEYS } from './src/data.js';
import * as mcp from './mcp.mjs';
import { loadRoster } from './roster.mjs';
import { loadSkills } from './skills.mjs';
import * as learn from './learn.mjs';
import * as onboard from './onboard.mjs';
import * as routines from './routines.mjs';
import * as usage from './usage.mjs';
import * as teams from './teams.mjs';
import * as actions from './actions.mjs'; // STORE (24 Oct 2026): outbound action lists on drafts + the approve call gate (spec 0001)
import * as approvals from './approvals.mjs'; // STORE (24 Oct 2026): auto approve rules (spec 0002)
import * as shopify from './shopify.mjs'; // STORE (25 Oct 2026): the office's own read-only view of the store (spec 0004)
import * as triggers from './triggers.mjs'; // STORE (25 Oct 2026): store events start trigger tasks (spec 0004)
import * as telegram from './telegram.mjs'; // STORE (25 Oct 2026): the team on Telegram (spec 0005)
import { createTeam } from './team.mjs';
import { lane } from './lanes.mjs'; // STORE (30 Oct 2026): the work lane and the send lane
import * as meter from './meter.mjs'; // STORE (25 Oct 2026): tokens per task, per chat turn and per Telegram message
import { fromRun, add as addTokens, tokensText } from './src/tokens.js';
import { normModel, modelFor, modelArgs, modelId, modelName, MODEL_KEYS, DEFAULT_MODEL, normEffort, effortFor, effortName, EFFORT_KEYS } from './src/models.js';
import { parseWhen, describe, valid as validWhen, untilText } from './src/when.js';

const cfg = loadConfig();
const HTML = path.join(ROOT, 'dist', 'command-centre-v2.html'); // built by build.mjs; shipped so npm start works without a build
const DATA = path.join(ROOT, 'data');
const FILE = path.join(DATA, 'tasks.json');
const GATES = path.join(DATA, 'gates'); // STORE spec 0001: one folder per approve run in flight (budget, slots, decisions)
const BRAIN = cfg.brainPath;
const NOTES_DIR = path.join(BRAIN, 'Agents Office');
const CLI_CWD = path.join(os.tmpdir(), 'agents-office-cli'); // an empty cwd: no CLAUDE.md, no repo context
const version = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return '?'; } })();
const RUN_TIMEOUT = Math.max(60, +cfg.timeout || 300) * 1000; // agents with tools take longer than a plain draft
{ const m = normModel(cfg.model); if (cfg.model && !m) console.warn(`config: model must be sonnet, opus or fable (got "${cfg.model}") — using ${DEFAULT_MODEL}`); cfg.model = m || DEFAULT_MODEL; } // V3.6: three models, by name
{ const e = normEffort(cfg.effort); if (cfg.effort && !e) console.warn(`config: effort must be low, medium, high, xhigh or max (got "${cfg.effort}") — using the model's own`); cfg.effort = e || ''; } // V3.6.1: the office's effort, empty = the model's own
for (const w of cfg.problems || []) console.warn('config:', w);
mcp.configure(cfg);
mcp.remember(path.join(DATA, 'connectors.json')); // STORE (24 Oct 2026): the claude.ai connectors a run reported survive a restart (claude mcp list does not show them)
const TEAMS = teams.settings(cfg); // V3.2 (16 Sep): { enabled, max }
const roster = loadRoster(BRAIN);
const AGENTS = roster.agents; // id · department · lead · name · role · does · tools · brief
for (const w of roster.problems) console.warn('agents:', w);
let skills = loadSkills(BRAIN, AGENTS); // reloaded before every task and chat, so a new skill needs no restart
for (const w of skills.problems) console.warn('skills:', w);
// the roster's editable fields are re-read too (a brief written by the lead's interview, or by hand, lands without a restart)
function reloadRoster() {
  const r = loadRoster(BRAIN);
  for (const a of r.agents) { const cur = AGENTS.find(x => x.id === a.id); if (cur) Object.assign(cur, { name: a.name, role: a.role, does: a.does, tools: a.tools, brief: a.brief }); }
  if (r.problems.join() !== roster.problems.join()) for (const w of r.problems) console.warn('agents:', w);
  Object.assign(roster, { problems: r.problems, customised: r.customised, briefed: r.briefed, files: r.files });
}
const refreshSkills = () => { reloadRoster(); const s = loadSkills(BRAIN, AGENTS); if (s.problems.join() !== skills.problems.join()) for (const w of s.problems) console.warn('skills:', w); skills = s; return s; };
const leadOf = dept => AGENTS.find(a => a.department === dept && a.lead) || AGENTS.find(a => a.department === dept);
const setupMap = () => Object.fromEntries(DEPT_KEYS.map(k => [k, onboard.isSetUp(AGENTS, skills, k)]));

let backend = 'claude-cli', sdk = null;
if (process.env.ANTHROPIC_API_KEY) {
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    sdk = new Anthropic(); backend = 'anthropic-sdk';
  } catch (e) { console.warn('SDK not installed (npm install @anthropic-ai/sdk) — using the Claude CLI:', e.message.split('\n')[0]); }
}

/* ---------- storage ---------- */
const load = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; } };
const save = list => { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(list, null, 2)); };
const nid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
/* ---------- the usage gauge (V3.6, A3): Claude's own numbers, the office's count underneath ---------- */
const USTATE = usage.loadState(DATA);
let usageCache = { at: 0, value: null, stale: true };
async function getUsage(force) {
  if (!force && !usageCache.stale && usageCache.value && Date.now() - usageCache.at < 60000) return usageCache.value;
  const u = await usage.fetchUsage();
  const v = u.ok ? { ...u, office: usage.fallback(USTATE).window } : { ...usage.fallback(USTATE), reason: u.reason };
  usageCache = { at: Date.now(), value: v, stale: false };
  return v;
}
function bumpUsage(u, mu) { if (u || mu) meter.charge(fromRun(u, mu)); if (!u) return; Object.assign(USTATE, usage.record(USTATE, u)); usage.saveState(DATA, USTATE); usageCache.stale = true; }
const slug = t => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

/* ---------- ask Claude ---------- */
// askX → { text, tools }: tools = the MCP/web tools the agent actually called (for the office to
// light up). On the CLI the agent gets --allowedTools = every connected server the config allows
// (+ web); file tools, Bash and sub-agents stay off — the office is not a coding session.
// the model the agent's turn ran on: a --chrome run (V3.2 (16 Sep)) also reports a small Haiku helper call in modelUsage, so the first key is not the answer —
// prefer the key of the family we asked for, else the biggest non-Haiku talker
function ranOn(mu, want) {
  const keys = Object.keys(mu || {}); if (!keys.length) return null;
  const fam = normModel(want) || cfg.model;
  return keys.find(k => k.includes(fam)) || keys.filter(k => !/haiku/.test(k)).sort((a, b) => (mu[b].outputTokens || 0) - (mu[a].outputTokens || 0))[0] || keys[0];
}
// STORE (spec 0001): `only` = these exact tool names and nothing else (no web, no Chrome) · `settings` = a --settings file (the
// approve run's call gate) · `calls` comes back: every tool_use with its result ({ id, name, input, ok, error }, ok null = no result),
// also on the error of a timeout or a failed exit, so an approve that stops halfway still shows what went out
async function askX(system, user, { maxTokens = 4000, tools = true, timeout = RUN_TIMEOUT, model = cfg.model, effort = null, only = null, settings = null } = {}) { // model: sonnet · opus · fable · effort: low…max or null = the model's own (src/models.js)
  if (sdk) {
    const res = await sdk.messages.create({ model: modelId(model), max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] });
    if (res.stop_reason === 'refusal') throw new Error('Claude declined this request');
    bumpUsage(res.usage);
    return { text: res.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim(), tools: [], calls: [], usage: res.usage, modelId: res.model };
  }
  fs.mkdirSync(CLI_CWD, { recursive: true });
  const allowed = only ? only : tools ? mcp.allowedTools() : [];
  // STORE (26 Oct 2026): the prompts go by file and stdin, not argv — a team lead's synth (skills + notes + every piece) passed
  // Windows' 32,767-character command line and failed with spawn ENAMETOOLONG. The file sits outside CLI_CWD, so the run's cwd stays empty.
  const promptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-office-prompt-')), systemFile = path.join(promptDir, 'system.txt');
  fs.writeFileSync(systemFile, system);
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--system-prompt-file', systemFile,
    '--disallowedTools', 'Bash,Edit,Write,Read,Glob,Grep,Agent,NotebookEdit,Task' + (allowed.includes('WebFetch') && !only ? '' : ',WebFetch,WebSearch')];
  if (allowed.length) args.push('--allowedTools', allowed.join(','));
  args.push(...(tools && !only ? mcp.cliArgs() : ['--no-chrome'])); // V3.2 (16 Sep): the owner's Chrome, when tools.browser is on
  if (settings) args.push('--settings', settings);
  args.push(...modelArgs(model, effort));
  const env = { ...process.env }; delete env.CLAUDECODE; // the CLI refuses to nest inside another Claude Code session
  return new Promise((resolve, reject) => {
    const cleanup = () => fs.rmSync(promptDir, { recursive: true, force: true });
    let p; try { p = spawn('claude', args, { cwd: CLI_CWD, env, stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { cleanup(); return reject(e); }
    p.stdin.on('error', () => {}); p.stdin.end(user); // the request: `claude -p` with no prompt argument reads it from stdin
    let out = '', err = '', text = '', used = [], gotResult = false, usageOut = null, modelUsageOut = null, modelUsed = null; const calls = [];
    const fail = e => { cleanup(); e.calls = calls; reject(e); };
    const timer = setTimeout(() => { p.kill('SIGKILL'); fail(new Error(`Claude took longer than ${timeout / 1000} s`)); }, timeout);
    const feed = line => {
      if (!line.trim()) return;
      let j; try { j = JSON.parse(line); } catch { return; }
      if (j.type === 'system' && j.subtype === 'init') mcp.fromInit(j);
      if (j.type === 'assistant' && j.message?.content) for (const b of j.message.content) if (b.type === 'tool_use' && b.name) { if (!used.includes(b.name)) used.push(b.name); calls.push({ id: b.id, name: b.name, input: b.input, ok: null, error: null }); }
      if (j.type === 'user' && Array.isArray(j.message?.content)) for (const b of j.message.content) if (b.type === 'tool_result') {
        const c = calls.find(x => x.id === b.tool_use_id); if (!c) continue;
        c.ok = !b.is_error; if (b.is_error) c.error = (typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map(x => x.text || '').join(' ') : '').trim().slice(0, 500) || 'the tool returned an error';
      }
      if (j.type === 'result') { gotResult = true; text = String(j.result || '').trim(); if (j.is_error && !text) text = ''; usageOut = j.usage || null; modelUsageOut = j.modelUsage || null; modelUsed = ranOn(j.modelUsage, model); }
    };
    p.stdout.on('data', d => { out += d; let i; while ((i = out.indexOf('\n')) >= 0) { feed(out.slice(0, i)); out = out.slice(i + 1); } });
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => { clearTimeout(timer); fail(new Error(e.code === 'ENOENT' ? 'Claude Code is not installed (claude not found on PATH)' : e.message)); });
    p.on('close', code => {
      clearTimeout(timer); feed(out); cleanup();
      if (code !== 0 && !gotResult) return fail(new Error(`claude exited ${code}${err ? ': ' + err.trim().slice(0, 300) : ''}`));
      if (!gotResult) { try { text = String(JSON.parse(out).result || '').trim(); } catch { text = out.trim(); } }
      bumpUsage(usageOut, modelUsageOut); // STORE: modelUsage is the whole run (Chrome's helper too)
      resolve({ text, tools: used, calls, usage: usageOut, modelId: modelUsed });
    });
  });
}
const ask = async (system, user, opts) => (await askX(system, user, { tools: false, ...opts })).text;
// STORE (spec 0003): a draft or a read-only routine runs with the call gate in read mode — reads pass, every write is blocked.
// → askX's answer + runDenied (what was blocked) + runGateFailed (an MCP call with no gate decision). Other modes run as before.
async function askFor(mode, dir, system, user, opts) {
  if (!(mode === 'draft' || mode === 'routine') || sdk) return { ...(await askX(system, user, opts)), runDenied: [], runGateFailed: false };
  const settings = actions.prepareReadGate(dir, cfg.gate);
  let out = null, err = null; try { out = await askX(system, user, { ...opts, settings }); } catch (e) { err = e; }
  const r = actions.readRun(dir, out?.calls || err?.calls || []); fs.rmSync(dir, { recursive: true, force: true });
  for (const d of r.runDenied) console.warn(`  ⛔ ${path.basename(dir)} blocked while ${mode === 'draft' ? 'drafting' : 'running'}: ${d.tool}`);
  if (r.runGateFailed) console.warn(`  ⚠ ${path.basename(dir)} an MCP call ran with no gate decision`);
  if (err) throw err;
  return { ...out, ...r };
}
function parseJSON(text) {
  const s = text.replace(/```json|```/g, ''); const a = s.indexOf('{'), b = s.lastIndexOf('}');
  return JSON.parse(s.slice(a, b + 1));
}

/* ---------- the brain: graph + context ---------- */
let graph = { notes: 0, nodes: [], links: [], floor: [] };
async function rebuildGraph() {
  try { graph = await layoutGraph(BRAIN); } catch (e) { console.warn('brain graph failed:', e.message); }
  return graph;
}
function vaultIndex() { // name → text (vault notes + live office notes)
  const { notes } = readVault(BRAIN); const m = new Map();
  for (const [name, n] of notes) m.set(name, n.text);
  for (const n of readOfficeNotes(BRAIN)) m.set(n.name, n.text);
  return m;
}
function businessContext(index) {
  const bits = [];
  for (const k of ['CLAUDE', 'index', 'business-model', 'voice']) if (index.has(k)) bits.push(`--- ${k}.md ---\n${index.get(k).slice(0, 1200)}`);
  return bits.join('\n\n');
}
// the notes an agent would read for this task: name/word overlap, department MOC first
function relevantNotes(index, dept, text, n = 4) {
  const words = new Set(String(text).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3));
  const mocName = { emails: 'MOC-Emails', sales: 'MOC-Sales', marketing: 'MOC-Marketing', ops: 'MOC-Operations', fin: 'MOC-Finance', delivery: 'MOC-Delivery' }[dept];
  const scored = [];
  for (const [name, txt] of index) {
    if (['CLAUDE', 'index', 'log'].includes(name)) continue;
    const hay = (name + ' ' + txt.slice(0, 1500)).toLowerCase();
    let s = 0; for (const w of words) if (hay.includes(w)) s += name.toLowerCase().includes(w) ? 3 : 1;
    if (name === mocName) s += 2;
    if (s) scored.push([s, name]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  const picks = scored.slice(0, n).map(x => x[1]);
  if (mocName && index.has(mocName) && !picks.includes(mocName)) picks.push(mocName);
  return picks;
}
function contextText(index, names) {
  return names.map(n => `--- ${n}.md ---\n${(index.get(n) || '').slice(0, 1800)}`).join('\n\n');
}

/* ---------- the roster, as Claude sees it ---------- */
const persona = a => `${a.name}${a.lead ? ' (lead)' : ''} · ${a.role} · ${a.does}`;
function rosterText(dept) { return AGENTS.filter(a => a.department === dept).map(a => { const sk = skills.names(a); return `- ${a.id} · ${persona(a)}${sk.length ? ' · skills: ' + sk.join(', ') : ''}`; }).join('\n'); }
// what an agent is told about itself: the job, the owner's standing instructions, the skills it follows
function agentBrief(a) {
  const lessons = learn.promptText(BRAIN, a);
  return (a.brief ? `\nSTANDING INSTRUCTIONS FROM THE OWNER\n${a.brief}\n` : '') + (skills.promptText(a) ? `\n${skills.promptText(a)}\n` : '') + (lessons ? `\n${lessons}\n` : '');
}
const toolKeys = names => [...new Set(names.map(n => /^mcp__/.test(n) ? mcp.keyOf(n) : n === 'WebSearch' || n === 'WebFetch' ? 'web' : null).filter(Boolean))];
async function route(dept, text) {
  const d = DEPTS[dept]; refreshSkills();
  const system = `You are the router for ${cfg.name}, a business whose departments are run by AI agents. ` +
    'Pick the single best agent for the owner\'s request — an agent whose skills match the request is the right one — and return ONLY a JSON object — no prose, no code fences.';
  const user = `Department: ${d.name}\nAgents (id · name · role · what they do):\n${rosterText(dept)}\n\nOwner's request: "${text}"\n\n` +
    'Return: {"agent":"<id from the list>","title":"<clean imperative task title, max 70 characters>","plan":["<step>","<step>","<step>"],"eta_minutes":<integer>,"why":"<one short sentence>","needs_ok":<true if doing this involves sending, posting, paying, deleting or changing anything outside this machine; false if it only reads and reports>}';
  const j = parseJSON(await ask(system, user, { maxTokens: 800, timeout: 150000, model: 'sonnet' })); // routing is a one-line JSON job: always Sonnet
  const valid = AGENTS.find(a => a.id === j.agent && a.department === dept);
  const agent = valid ? valid.id : (AGENTS.find(a => a.department === dept && a.lead) || AGENTS.find(a => a.department === dept)).id;
  return { agent, title: String(j.title || text).slice(0, 90), plan: Array.isArray(j.plan) ? j.plan.slice(0, 4).map(String) : [],
    eta: Number.isFinite(j.eta_minutes) ? j.eta_minutes : 30, why: String(j.why || ''), needsOk: typeof j.needs_ok === 'boolean' ? j.needs_ok : routines.guessNeedsOk(text) };
}
// the system prompt every agent run starts from: who it is, its brief, skills and lessons, its tools, the company, the notes for this task
function agentSystem(a, index, read, { extra = '', words = 260 } = {}) {
  const d = DEPTS[a.department];
  return `You are ${a.name}, ${a.role || 'an agent'}, in the ${d.name} department of ${cfg.name}. ${a.does}\n${agentBrief(a)}` + (extra ? `\n${extra}\n` : '') +
    'Write the finished deliverable itself, not a description of what you would do. Plain text: a short heading, then short sections or bullets. ' +
    `At most ${words} words unless a skill or the owner\'s instructions set a different shape — those win. No preamble, no sign-off. Ground it in the company notes below; where a fact is missing, make a reasonable assumption and mark it (assumed). ` +
    'If you used a tool, say so in one line at the end ("Used: Gmail — searched the client thread").\n\n' +
    `${mcp.promptText(a.tools)}\n\nCOMPANY NOTES\n${businessContext(index)}\n\nNOTES YOU READ FOR THIS TASK\n${contextText(index, read)}`;
}
// STORE (spec 0001): a draft ends with its actions block (role 'single' or 'lead'; a team 'piece' writes none); the approve step is actions.approve, not a mode line
const modeLineFor = (mode, task, role = 'single') => mode === 'draft' ? actions.draftLine(role) : mode === 'routine' ? actions.READ_LINE : ''; // STORE spec 0003: a read-only routine is told it may only read
const pickFor = (task, a) => { // model + effort: four places, one precedence (task > routine > agent > office)
  const pick = modelFor({ task: task.model, routine: task.routineModel, agent: a.model, office: cfg.model });
  const eff = effortFor({ task: task.effort, routine: task.routineEffort, agent: a.effort, office: cfg.effort, model: pick.model });
  return { pick, eff };
};
// persist a task mid-run (a team's pieces move while the run is still going; the page polls /api/tasks)
function persist(task) { const l = load(); const i = l.findIndex(t => t.id === task.id); if (i >= 0) { l[i] = task; save(l); } }
async function run(task, feedback, mode) { // mode: undefined (a task from the bar) · 'routine' (read-only routine) · 'draft' (routine that waits for the OK) · 'approve' (the owner ticked it)
  if (task.team && TEAMS.enabled) { // V3.2 (16 Sep): a team task — the lead plans, the desks work at once, the lead writes the final
    if (feedback && task.team.pieces?.length) return runTeamLead(task, feedback, mode); // "revise: …" reworks the final from the same pieces
    return runTeam(task, mode);
  }
  const a = AGENTS.find(x => x.id === task.agent);
  refreshSkills();
  const index = vaultIndex();
  const read = relevantNotes(index, a.department, task.title + ' ' + task.text);
  const system = agentSystem(a, index, read);
  const routineLine = task.trigger ? `\nThis task was started by events in the store (${task.when}); the owner is not at the keyboard. Work from the events listed in the request, one by one. It is now ${new Date().toLocaleString([], { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}.` // STORE spec 0004
    : task.routine ? `\nThis is a routine (${task.when}): it runs on the office's own clock and the owner is not at the keyboard. It is now ${new Date().toLocaleString([], { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}${task.late ? `; this run is late, it was due ${new Date(task.due).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}. Do the work for now.`
    : task.dueAt ? `\nThis task was scheduled in advance for ${new Date(task.dueAt).toLocaleString([], { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })} and is running now; the owner is not at the keyboard${task.late ? ' and this run is late' : ''}. Do the work for now.` : '';
  const modeLine = modeLineFor(mode, task);
  const user = `Task: ${task.title}\nOwner's request: ${task.text}` + (task.goalContext ? `\n\n${task.goalContext}\n` : '') + (task.plan?.length ? `\nAgreed plan: ${task.plan.join(' → ')}` : '') + routineLine + modeLine + // STORE spec 0007: earlier goal steps, fenced data, on the draft and every rework
    (feedback ? `\n\nThe owner reviewed your previous version and asked for changes: "${feedback}"\nPrevious version:\n${task.result}` + (mode === 'draft' ? actions.reworkLine(task.actions) : '') : '');
  const { pick, eff } = pickFor(task, a);
  const { text, tools, modelId: ran, runDenied, runGateFailed } = await askFor(mode, path.join(GATES, `${task.id}-run`), system, user, { model: pick.model, effort: eff.effort });
  if (!text) throw new Error('Claude returned nothing');
  return { result: text, read, tools: toolKeys(tools), used: mcp.namesOf(tools), skills: skills.names(a), modelUsed: pick.model, modelFrom: pick.from, modelId: ran, effortUsed: eff.effort || '', effortFrom: eff.from, runDenied, runGateFailed };
}

/* ---------- V3.2 (16 Sep) Agent Teams: the lead plans, the desks work at once, the lead writes the final ---------- */
const nameOf = id => id === 'lead' ? 'the lead' : (AGENTS.find(a => a.id === id)?.name || id);
const routineLineFor = task => task.routine ? `\nThis is a routine (${task.when}): it runs on the office's own clock and the owner is not at the keyboard. It is now ${new Date().toLocaleString([], { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}. Do the work for now.`
  : task.dueAt ? `\nThis task was scheduled in advance for ${new Date(task.dueAt).toLocaleString([], { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })} and is running now; the owner is not at the keyboard. Do the work for now.` : '';
async function runTeam(task, mode) {
  const lead = AGENTS.find(x => x.id === task.agent), dept = lead.department;
  refreshSkills();
  const index = vaultIndex();
  const seats = AGENTS.filter(a => a.department === dept).map(a => ({ id: a.id, lead: a.lead, name: a.name, role: a.role, does: a.does, skills: skills.names(a) }));
  const max = Math.min(TEAMS.max, teams.askedSize(task.text) || TEAMS.max);
  // 1. the plan — the lead splits the request across the desks (Sonnet, no tools: a JSON job)
  const pp = teams.planPrompt({ business: cfg.name, deptName: DEPTS[dept].name, lead, seats, text: task.text, title: task.title, max, notes: contextText(index, relevantNotes(index, dept, task.title + ' ' + task.text, 3)).slice(0, 4000) });
  let plan;
  try { plan = teams.parsePlan(await ask(pp.system, pp.user, { maxTokens: 1400, timeout: 150000, model: 'sonnet' }), { seats, lead, max, fallback: task }); }
  catch (e) { plan = { pieces: [{ agent: lead.id, title: task.title, text: task.text }], why: '', solo: true, error: e.message }; }
  task.team = { ...(task.team || {}), lead: lead.id, max, pieces: plan.pieces.map(p => ({ ...p, state: 'next' })), messages: [], why: plan.why, solo: plan.solo, plannedAt: Date.now() };
  persist(task);
  console.log(`  ⚑ ${task.id} team of ${plan.pieces.length}: ${plan.pieces.map(p => p.agent).join(' + ')}${plan.why ? ' — ' + plan.why : ''}`);
  // 2. the pieces — one Claude process per desk, at the same time (at most `max` in flight)
  const ids = task.team.pieces.map(p => p.agent);
  await teams.pool(task.team.pieces, max, async piece => {
    const a = AGENTS.find(x => x.id === piece.agent);
    piece.state = 'doing'; piece.startedAt = Date.now(); persist(task);
    try {
      const read = relevantNotes(index, dept, piece.title + ' ' + piece.text, 3);
      const system = agentSystem(a, index, read, { extra: teams.teamSection({ me: a, lead, pieces: task.team.pieces, nameOf }), words: 220 });
      const user = `Task (the whole request, for context): ${task.title}\nOwner's request: ${task.text}\n\nYOUR PIECE: ${piece.title}\n${piece.text}` + routineLineFor(task) + modeLineFor(mode, task, 'piece');
      const { pick, eff } = pickFor(task, a);
      const { text, tools, modelId: ran, runDenied, runGateFailed } = await askFor(mode, path.join(GATES, `${task.id}-${a.id}-run`), system, user, { model: pick.model, effort: eff.effort });
      const { body, messages } = teams.parseMessages(text, ids);
      Object.assign(piece, { result: body || '(empty)', tools: toolKeys(tools), used: mcp.namesOf(tools), read, modelId: ran, error: !text, ...(runDenied.length ? { runDenied } : {}), ...(runGateFailed ? { runGateFailed } : {}) });
      for (const m of messages) task.team.messages.push({ from: a.id, to: m.to === lead.id ? 'lead' : m.to, text: m.text, at: Date.now() });
    } catch (e) { Object.assign(piece, { result: 'Could not complete this piece: ' + e.message, error: true }); }
    piece.state = 'done'; piece.doneAt = Date.now(); persist(task);
    console.log(`    ${piece.error ? '✗' : '✓'} ${a.name}: ${piece.title} (${(piece.result || '').length} chars${piece.tools?.length ? ', tools: ' + piece.tools.join(' ') : ''})`);
  });
  // 3. the final — the lead writes the deliverable from the pieces and the notes
  return runTeamLead(task, null, mode);
}
async function runTeamLead(task, feedback, mode) {
  const lead = AGENTS.find(x => x.id === task.agent), tm = task.team;
  refreshSkills();
  const index = vaultIndex();
  const read = relevantNotes(index, lead.department, task.title + ' ' + task.text);
  const system = agentSystem(lead, index, read, { extra: `TEAM\nYou lead this team. The pieces below were done by your teammates (one of them may be yours). You write the finished deliverable from them.`, words: 450 });
  const user = teams.synthPrompt({ task, pieces: tm.pieces || [], messages: tm.messages || [], nameOf, feedback }) + routineLineFor(task) + modeLineFor(mode, task, 'lead') + (feedback && mode === 'draft' ? actions.reworkLine(task.actions) : '');
  const { pick, eff } = pickFor(task, lead);
  const { text, tools, modelId: ran, runDenied: leadDenied, runGateFailed: leadFailed } = await askFor(mode, path.join(GATES, `${task.id}-run`), system, user, { model: pick.model, effort: eff.effort, maxTokens: 6000 });
  if (!text) throw new Error('Claude returned nothing');
  const runDenied = [...(tm.pieces || []).flatMap(p => p.runDenied || []), ...leadDenied], runGateFailed = leadFailed || (tm.pieces || []).some(p => p.runGateFailed); // STORE spec 0003: the whole team's blocks
  const allTools = [...new Set([...(tm.pieces || []).flatMap(p => p.tools || []), ...toolKeys(tools)])];
  const allUsed = [...new Set([...(tm.pieces || []).flatMap(p => p.used || []), ...mcp.namesOf(tools)])];
  const allRead = [...new Set([...read, ...(tm.pieces || []).flatMap(p => p.read || [])])];
  return { result: text, read: allRead, tools: allTools, used: allUsed, skills: skills.names(lead), modelUsed: pick.model, modelFrom: pick.from, modelId: ran, effortUsed: eff.effort || '', effortFrom: eff.from, team: tm, runDenied, runGateFailed };
}
function writeNote(task) { // the deliverable becomes a note in the brain, linked to what was read
  fs.mkdirSync(NOTES_DIR, { recursive: true });
  const a = AGENTS.find(x => x.id === task.agent);
  const name = `${new Date(task.doneAt).toISOString().slice(0, 10)} ${slug(task.title)}`;
  const body = `---\nagent: ${a.name}\ndepartment: ${DEPTS[a.department].name}\ntask: ${task.id}\ndone: ${new Date(task.doneAt).toISOString()}${task.used?.length ? '\ntools: ' + task.used.join(', ') : ''}${task.skills?.length ? '\nskills: ' + task.skills.join(', ') : ''}${task.routine ? '\nroutine: ' + task.when + (task.late ? ' (late)' : '') : ''}${task.trigger ? '\ntrigger: ' + task.trigger + ' · ' + task.when + ' · ' + (task.events || []).length + ' event' + ((task.events || []).length === 1 ? '' : 's') : ''}${task.modelUsed ? '\nmodel: ' + modelName(task.modelUsed) + (task.modelFrom && task.modelFrom !== 'office' ? ' (' + task.modelFrom + ')' : '') : ''}${task.effortUsed ? '\neffort: ' + task.effortUsed + (task.effortFrom && task.effortFrom !== 'model' ? ' (' + task.effortFrom + ')' : '') : ''}${task.approved ? '\napproved: ' + new Date(task.approvedAt).toISOString() : ''}${task.approved && task.autoApproved ? '\n' + approvals.noteLines(task) : ''}${task.approved && Array.isArray(task.actions) ? '\n' + actions.noteLine(task.actions) : ''}${task.team?.pieces?.length ? '\nteam: ' + task.team.pieces.map(p => nameOf(p.agent)).join(', ') : ''}\n---\n` +
    `# ${task.title}\n\n${task.result}\n\n${task.approved && Array.isArray(task.actions) ? actions.noteSection(task.actions, task) + '\n' : ''}${actions.runNote(task) ? actions.runNote(task) + '\n' : ''}---\nRead: ${(task.read || []).map(n => `[[${n}]]`).join(' · ') || '—'}\n` + teams.noteExtra(task.team, nameOf); // STORE spec 0001: what went out, per action
  fs.writeFileSync(path.join(NOTES_DIR, name + '.md'), body);
  return name;
}
async function chat(agentId, text, history) {
  const a = AGENTS.find(x => x.id === agentId); if (!a) throw new Error('unknown agent');
  const d = DEPTS[a.department]; refreshSkills();
  const index = vaultIndex();
  const read = relevantNotes(index, a.department, text, 3);
  const mine = load().filter(t => t.agent === agentId).slice(-6).map(t => `- [${t.state}] ${t.title}`).join('\n');
  const system = `You are ${a.name}, ${a.role || 'an agent'}, in the ${d.name} department of ${cfg.name}. ${a.does}\n${agentBrief(a)}` +
    'You are talking to the owner. Answer as this agent, in first person, briefly (under 120 words unless asked for detail), plainly, no hype. ' +
    'Use the company notes; say when something is not in them. If the owner asks you to look something up, use your tools. Nothing outbound is sent without the owner\'s explicit say-so.\n\n' +
    `${mcp.promptText(a.tools)}\n\nCOMPANY NOTES\n${businessContext(index)}\n\nRELEVANT NOTES\n${contextText(index, read)}\n\nYOUR RECENT TASKS\n${mine || '—'}`;
  const convo = (history || []).slice(-8).map(m => `${m.who === 'user' ? 'Owner' : a.name}: ${m.text}`).join('\n');
  const { text: reply, tools } = await askX(system, (convo ? convo + '\n' : '') + `Owner: ${text}\n${a.name}:`, { maxTokens: 1200, model: modelFor({ agent: a.model, office: cfg.model }).model, effort: effortFor({ agent: a.effort, office: cfg.effort, model: modelFor({ agent: a.model, office: cfg.model }).model }).effort });
  return { reply, read, tools: toolKeys(tools), used: mcp.namesOf(tools) };
}

/* ---------- routines: the office's own clock (V3.5) ---------- */
const RSTATE = routines.loadState(DATA);
let rlist = { routines: [], problems: [], path: routines.file(BRAIN) };
function loadRoutines() { // re-read from disk every time: a routine written by Claude Code, or by hand, lands without a restart
  const r = routines.load(BRAIN, AGENTS);
  if (r.problems.join() !== rlist.problems.join()) for (const w of r.problems) console.warn('routines:', w);
  rlist = r;
  const { list, changed } = routines.withState(r.routines, RSTATE);
  if (changed) routines.saveState(DATA, RSTATE);
  return list;
}
const routinesOut = () => { const list = loadRoutines(); return { routines: list, depts: routines.ALLOWED, path: rlist.path, problems: rlist.problems }; };
// STORE (spec 0002): the auto approve rules as the panel and the chat see them — the owner's file, today's use from the ledger
const approvalsOut = () => { const d = approvals.load(BRAIN); return { paused: d.paused, rules: approvals.withUse(d, approvals.loadLedger(DATA)), problems: d.problems, path: d.path, currency: cfg.currency }; }; // currency: the Automations screen's default for a new money rule (spec 0006)
const pendingRule = new Map(); // lead id → { rule, at }: a rule said in chat waits for the owner's "yes" before it is saved
async function approvalsChat(a, t) { // a department lead: "auto approve …" (read back, saved on yes) · "rules" · "pause|resume|delete … rule" · "pause|resume auto approvals"
  if (leadOf(a.department).id !== a.id) return approvals.proposes(t) || /\brules?\b/i.test(t) && /^\s*(pause|resume|delete|remove)\b/i.test(t) || /^\s*(pause|stop|resume|start)\s+(?:all\s+)?(?:the\s+)?auto[\s-]*approv/i.test(t)
    ? { reply: `Auto approve rules are set with the department lead — open ${leadOf(a.department).name}'s chat.` } : null; // so "pause the refunds rule" never pauses a routine by mistake
  const p = pendingRule.get(a.id);
  if (p) {
    pendingRule.delete(a.id);
    if (/^\s*(yes|y|yep|yes please|confirm|do it|turn it on)\s*[.!]?\s*$/i.test(t) && Date.now() - p.at < 30 * 60000) {
      let id = p.rule.id; approvals.edit(BRAIN, doc => { let n = 2; while (doc.rules.some(r => r?.id === id)) id = `${p.rule.id}-${n++}`; doc.rules.push(approvals.clean({ ...p.rule, id })); });
      console.log(`⚡ rule ${id} on (from ${a.name}'s chat): ${approvals.describeRule(p.rule)}`);
      return { reply: `On. "${p.rule.title}" now sends what fits it without waiting for you. Say "rules" to see them, "pause ${p.rule.title.toLowerCase()} rule" to stop it.` };
    }
    if (/^\s*(no|nope|cancel|drop it|stop)\b/i.test(t)) return { reply: 'Dropped. Nothing was turned on.' };
  }
  if (/^\s*((auto[\s-]*approv\w*|approval)\s+)?rules\s*\??\s*$/i.test(t)) return { reply: approvals.listText(approvals.load(BRAIN), approvals.loadLedger(DATA)) };
  const sw = /^\s*(pause|stop|resume|start)\s+(?:all\s+)?(?:the\s+)?auto[\s-]*approv(?:als?|ing|e)\s*[.!]?\s*$/i.exec(t);
  if (sw) { const off = /pause|stop/i.test(sw[1]); approvals.edit(BRAIN, doc => { doc.paused = off; }); console.log(`⚡ auto approvals ${off ? 'paused' : 'resumed'} (from ${a.name}'s chat)`); return { reply: off ? 'Paused. Every draft waits for you again until you say "resume auto approvals".' : 'Resumed. Drafts that fit a rule go out on their own again.' }; }
  const cmd = /^\s*(pause|resume|delete|remove)\s+(?:the\s+)?(.+?)\s+(?:auto[\s-]*approve\s+)?rule\s*[.!]?\s*$/i.exec(t);
  if (cmd) {
    const d = approvals.load(BRAIN), r = approvals.matchRule(d.rules, cmd[2]); if (!r) return { reply: 'Which one? ' + approvals.listText(d, approvals.loadLedger(DATA)) };
    const verb = cmd[1].toLowerCase();
    approvals.edit(BRAIN, doc => { if (/delete|remove/.test(verb)) doc.rules = doc.rules.filter(x => x?.id !== r.id); else { const x = doc.rules.find(y => y?.id === r.id); if (x) x.paused = verb === 'pause'; } });
    console.log(`⚡ rule ${r.id} ${verb}d (from ${a.name}'s chat)`);
    return { reply: /delete|remove/.test(verb) ? `Deleted "${r.title}".` : verb === 'pause' ? `Paused "${r.title}". Drafts it would have sent wait for you.` : `"${r.title}" is back on.` };
  }
  if (!approvals.proposes(t)) return null;
  const out = await approvals.parseSentence(ask, t, { dept: a.department, currency: cfg.currency, existing: approvals.load(BRAIN).rules });
  if (out.error) return { reply: out.error };
  pendingRule.set(a.id, { rule: out.rule, at: Date.now() });
  return { reply: approvals.confirmText(out.rule) };
}
const agentName = id => AGENTS.find(a => a.id === id)?.name || id;
// routine-driven runs go one at a time, so a burst of catch-ups after a long sleep does not spawn five Claude processes at once
const enqueue = lane();
const enqueueSend = lane(); // STORE (30 Oct 2026): an approved send gets its own lane, so it never waits behind a long draft; sends stay one at a time
function fire(r, { due = Date.now(), late = false, by = 'routine' } = {}) { // the routine becomes a task and runs here, page or no page
  const task = { id: nid(), dept: r.dept, agent: r.agent, title: r.title, text: r.text, plan: r.plan || [], eta: 15, why: '', state: 'next', addedAt: Date.now(), by, routine: r.id, when: r.desc || describe(r.when), needsOk: r.needsOk, due, late, routineModel: r.model || undefined, routineEffort: r.effort || undefined, team: r.team && TEAMS.enabled ? { lead: r.agent, asked: 'routine' } : undefined };
  const list = load(); list.push(task); save(list);
  routines.advance(RSTATE, r, Date.now(), task.id, late); routines.saveState(DATA, RSTATE);
  console.log(`⏱ ${task.id} → ${task.agent}: ${task.title}${late ? ' (LATE · was due ' + new Date(due).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ')' : ''}`);
  enqueue(() => runServerTask(task.id));
  return task;
}
// STORE (spec 0001): the approved actions only, one gated Claude run (actions.approve + gate.mjs); outcomes from the real calls
async function approveRun(task, strict = false) { // strict (spec 0002): an auto approved run — the gate also checks each call's amount and recipient
  const a = AGENTS.find(x => x.id === task.agent); const { pick, eff } = pickFor(task, a);
  const r = await actions.approve(task, { agent: a, deptName: DEPTS[a.department].name, business: cfg.name, servers: mcp.usable(), sdk: !!sdk, dir: path.join(GATES, task.id), ask: askX, model: pick.model, effort: eff.effort, strict });
  const report = r.text || (r.error ? 'The run stopped: ' + r.error + '. The outcomes below come from the calls that were seen.' : '');
  Object.assign(task, { actions: r.actions, gateDenied: r.gateDenied.length ? r.gateDenied : undefined, gateFailed: r.gateFailed || undefined, result: (task.draft || task.result) + '\n\n---\nAFTER YOUR OK\n' + report,
    approved: true, approvedAt: Date.now(), error: !!r.error, tools: [...new Set([...(task.tools || []), ...toolKeys(r.tools)])], used: [...new Set([...(task.used || []), ...mcp.namesOf(r.tools)])], modelUsed: pick.model, modelFrom: pick.from, effortUsed: eff.effort || '', effortFrom: eff.from });
  for (const d of r.gateDenied) console.warn(`  ⛔ ${task.id} gate blocked ${d.tool}`);
  if (r.gateFailed) console.warn(`  ⚠ ${task.id} an MCP call ran with no gate decision on record — check what went out`);
  console.log(`  ↳ ${task.id} actions: ${r.actions.map(x => x.id + ' ' + actions.STATUS_TEXT[x.outcome.status]).join(' · ')}`);
}
// the owner's APPROVE or REJECT on a waiting draft — the page and Telegram take this one path (STORE spec 0005). → { status, body }
async function ownerDecides(id, kind, note = '') {
  const task = load().find(t => t.id === id);
  if (!task) return { status: 404, body: { error: 'no such task' } };
  if (task.state !== 'waiting') return { status: 400, body: { error: 'this task is not waiting for your OK' } };
  if (kind === 'approve') { // STORE spec 0001: an unreadable list locks APPROVE; an empty one is done with no Claude run (AC-4, AC-7, AC-12)
    const rd = actions.readOf(task);
    if (!rd.ok) return { status: 400, body: { error: `the actions in this draft could not be read: ${rd.why}. Send it back with REJECT.` } };
    if (!task.actions.length) {
      const list = load(); const t = list.find(x => x.id === task.id);
      Object.assign(t, { result: (t.draft || t.result) + '\n\n---\nAFTER YOUR OK\nNothing went out, this draft had no outbound actions.', approved: true, approvedAt: Date.now(), error: false }); delete t.ask;
      finishApproved(t); save(list); await rebuildGraph();
      console.log(`✅ ${t.id} approved — nothing goes out, done (note: ${t.note})`);
      team?.notify(t);
      return { status: 200, body: { ok: true, id: t.id, state: 'done' } };
    }
    const list = load(); const t = list.find(x => x.id === task.id); Object.assign(t, { state: 'doing', startedAt: Date.now(), approving: true }); delete t.ask; save(list); // off WAITING now: a second APPROVE while this one is queued is refused, never a second send
  } else if (note) { const list = load(); const t = list.find(x => x.id === task.id); t.lastFeedback = note; save(list); } // STORE spec 0007 (AC-7): a goal step's RETRY carries the owner's last note
  console.log(`${kind === 'approve' ? '✅' : '↩'} ${task.id} ${kind === 'approve' ? 'approved — ' + agentName(task.agent) + ' is sending' : 'sent back: ' + note.slice(0, 80)}`);
  team?.decided(task.id, kind, note).catch(() => {}); // the Telegram card loses its buttons; a sent-back draft gets a new card when reworked
  (kind === 'approve' ? enqueueSend : enqueue)(() => runServerTask(task.id, kind === 'approve' ? { approve: true } : { feedback: note || 'Not this. Rework it.' }))
    .then(t => { if (kind === 'reject' && note && t && !t.error) { const a = AGENTS.find(x => x.id === t.agent); return learn.classify(ask, a, t, note).then(v => { const r = learn.record(BRAIN, a, t, note, v); console.log(`  ↳ ${a.name} ${r.standing ? 'learned a rule' : 'noted a one-off'}: ${r.line.slice(0, 100)}`); }); } })
    .catch(e => console.warn('approval:', e.message));
  return { status: 200, body: { ok: true, id: task.id, state: 'doing' } };
}
function finishApproved(task) { delete task.approving; task.state = 'done'; task.doneAt = Date.now(); task.note = writeNote(task); }
async function runServerTask(id, { feedback, approve, strict = false } = {}) {
  let list = load(); const task = list.find(t => t.id === id); if (!task) return null;
  task.state = 'doing'; task.startedAt = Date.now(); delete task.ask; if (approve) { task.approving = true; task.sendStartedAt ||= Date.now(); } save(list); // approving: a restart mid-send is closed out at startup (AC-15) · sendStartedAt (spec 0007): a send began, never cleared, so a goal never offers RETRY on it
  const { usage: spent } = await meter.measure(async () => { try { // STORE: this run's tokens (draft, approve or rework) add to the task's total
    if (approve) { await approveRun(task, strict); finishApproved(task); await rebuildGraph(); }
    else {
      const out = await run(task, feedback, task.needsOk ? 'draft' : task.asked ? undefined : 'routine'); // STORE spec 0005: a task the owner gave a bot runs like a bar task
      task.result = out.result;
      Object.assign(task, { read: out.read, tools: [...new Set([...(task.tools || []), ...out.tools])], used: [...new Set([...(task.used || []), ...out.used])], skills: out.skills, error: false, modelUsed: out.modelUsed, modelFrom: out.modelFrom, modelId: out.modelId, effortUsed: out.effortUsed, effortFrom: out.effortFrom, ...(out.team ? { team: out.team } : {}) });
      if (task.needsOk) { // STORE spec 0001: the draft's actions block → actions + actionsRead; only the fence leaves the draft
        for (const k of ['actions', 'actionsRead', 'actionsWhy', 'gateDenied', 'gateFailed']) delete task[k];
        Object.assign(task, { runDenied: out.runDenied?.length ? out.runDenied : undefined, runGateFailed: out.runGateFailed || undefined }); // STORE spec 0003: before the rules look at it
        const d = actions.fromDraft(out.result, { servers: mcp.usable(), currency: cfg.currency, sdk: !!sdk });
        Object.assign(task, { result: d.body, draft: d.body, actions: d.actions, actionsRead: d.actionsRead, ...(d.actionsWhy ? { actionsWhy: d.actionsWhy } : {}) });
        task.state = 'waiting'; task.waitingAt = Date.now(); task.ask = routines.askLine(task);
        console.log(`  ↳ ${task.id} actions ${d.actionsRead === 'ok' ? actions.summary(d.actions) : 'unreadable: ' + d.actionsWhy}`);
        const au = approvals.afterDraft(task, { brainPath: BRAIN, dataDir: DATA, sdk: !!sdk, reworked: !!feedback }); // STORE spec 0002: every action fits a rule with room left → sent by rule (ledger written first); a rework after REJECT waits for you
        if (au.auto) { Object.assign(task, { state: 'doing', startedAt: Date.now(), approving: true }); delete task.ask; console.log(`  ⚡ ${task.id} approved by rule: ${task.autoApproved.rules.map(r => r.title).join(', ')}`); }
        else if (au.why) console.log(`  ↳ ${task.id} waits for you: ${au.why}`);
      }
      else { Object.assign(task, { runDenied: out.runDenied?.length ? out.runDenied : undefined, runGateFailed: out.runGateFailed || undefined }); task.state = 'done'; task.doneAt = Date.now(); task.note = writeNote(task); await rebuildGraph(); } // STORE spec 0003: a read-only routine's blocks
    }
  } catch (e) {
    delete task.approving; Object.assign(task, { state: 'done', doneAt: Date.now(), result: 'Could not complete this task: ' + e.message, error: true });
  } });
  task.usage = addTokens(task.usage, spent);
  list = load(); const i = list.findIndex(t => t.id === task.id); if (i >= 0) list[i] = task; save(list);
  console.log(`${task.error ? '✗' : task.state === 'waiting' ? '⏸' : task.state === 'doing' ? '⚡' : '✓'} ${task.id} ${task.error ? 'failed' : task.state === 'waiting' ? 'waiting for your OK' : task.state === 'doing' ? 'sending by rule' : 'done'} (${task.result.length} chars, ${tokensText(task.usage).slice(3)}${task.tools?.length ? ', tools: ' + task.tools.join(' ') : ''}${task.note ? ', note: ' + task.note : ''})`);
  if (!approve && task.state === 'doing' && task.autoApproved) enqueueSend(() => runServerTask(task.id, { approve: true, strict: true })); // STORE spec 0002: the same gated run as APPROVE, strict
  team?.notify(task).catch(e => console.warn('telegram:', e.message)); // STORE spec 0005: a draft waiting → the secretary's card; done → the lead's chat
  return task;
}
/* ---------- STORE (spec 0004): Shopify event triggers — the office reads the store, events start trigger tasks ---------- */
const SHOP = shopify.settings(cfg); for (const w of SHOP.problems) console.warn('shopify:', w);
const TSTATE = triggers.loadState(DATA);
let checking = false;
const loadTriggers = () => triggers.load(BRAIN, AGENTS);
function fireTrigger(t, events) { // one task for the whole batch, run like a routine draft
  const task = { id: nid(), ...triggers.taskFields(t, events), plan: [], eta: 15, why: '', state: 'next', addedAt: Date.now() };
  const list = load(); list.push(task); save(list);
  console.log(`🛍 ${task.id} → ${task.agent}: ${task.title} (${events.length} event${events.length === 1 ? '' : 's'}, ${task.when})`);
  enqueue(() => runServerTask(task.id));
  return task;
}
async function checkStore({ runNow = null, force = false } = {}) {
  if (!SHOP.on || checking || process.env.AO_NO_STORE === '1') return { skipped: true }; // AO_NO_STORE: RUN NOW too
  const doc = loadTriggers(); if (!doc.triggers.length) return { skipped: true };
  if (!force && Date.now() < TSTATE.backoffUntil) return { skipped: true };
  checking = true; let fired = [];
  try { // the check itself, its backoff and the cursor live in triggers.check (STORE, 30 Oct 2026)
    const r = await triggers.check({ shop: SHOP, doc, state: TSTATE, S: shopify, runNow, force });
    fired = (r.fires || []).map(f => fireTrigger(f.trigger, f.events));
  } catch (e) { console.warn('🛍 could not start a trigger task:', e.message); } finally { triggers.saveState(DATA, TSTATE); checking = false; }
  return { fired };
}
const triggersOut = () => { const d = loadTriggers(); return { triggers: d.triggers.map(t => ({ ...t, desc: triggers.describe(t), today: TSTATE.day === triggers.dayKey(Date.now()) ? (TSTATE.counts[t.id] || 0) : 0, held: (TSTATE.held[t.id] || []).length })), problems: [...SHOP.problems, ...d.problems], path: d.path,
  shopify: { on: SHOP.on, shop: SHOP.shop, poll: SHOP.poll, lastCheck: TSTATE.lastCheck, lastOk: TSTATE.lastOk, problem: TSTATE.problem, connectedAt: TSTATE.cursor ? true : false }, stale: TSTATE.stale.slice(-5) }; };
function triggersChat(a, t) { // a lead: "triggers" · "pause|resume … trigger"
  if (leadOf(a.department).id !== a.id) return null;
  if (/^\s*((store|shopify)\s+)?triggers\s*\??\s*$/i.test(t)) return { reply: triggers.listText(loadTriggers(), TSTATE) };
  const cmd = /^\s*(pause|resume)\s+(?:the\s+)?(.+?)\s+trigger\s*[.!]?\s*$/i.exec(t); if (!cmd) return null;
  const d = loadTriggers(), x = triggers.matchTrigger(d.triggers, cmd[2]); if (!x) return { reply: 'Which one? ' + triggers.listText(d, TSTATE) };
  triggers.edit(BRAIN, doc => { const y = doc.triggers.find(z => z?.id === x.id); if (y) y.paused = /pause/i.test(cmd[1]); });
  return { reply: /pause/i.test(cmd[1]) ? `Paused "${x.title}". Store events it would have started pass by until you resume it.` : `"${x.title}" is back on.` };
}
function tickRoutines() {
  let list; try { list = loadRoutines(); } catch (e) { console.warn('routines:', e.message); return; }
  for (const { routine, due, late } of routines.due(list, RSTATE)) fire(routine, { due, late });
  team?.tick().catch(e => console.warn('telegram:', e.message)); // STORE spec 0005: reminders, the morning and weekly briefs, the pairing code
  tickScheduled();
}
function tickScheduled() { // V3.2.1: a task scheduled for a date fires on its minute — late (once) if the office was off
  const now = Date.now(); let list = load(); let changed = false;
  for (const t of list) {
    if (t.state !== 'scheduled' || !(t.dueAt <= now)) continue;
    t.state = 'next'; t.due = t.dueAt; t.late = now - t.dueAt > routines.LATE_AFTER; t.addedAt = now; changed = true;
    console.log(`⏱ ${t.id} scheduled task fires → ${t.agent}: ${t.title}${t.late ? ' (LATE · was due ' + new Date(t.dueAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) + ')' : ''}`);
    enqueue(() => runServerTask(t.id));
  }
  if (changed) save(list);
}
const uniqueId = (base, list) => { let id = base || 'routine', n = 2; while (list.some(r => r.id === id)) id = `${base}-${n++}`; return id; };
function editRoutine(id, patch) { const r = rlist.routines.find(x => x.id === id); if (!r) return null; Object.assign(r, patch); routines.save(BRAIN, rlist.routines); return loadRoutines().find(x => x.id === id); }
// STORE (26 Oct 2026, spec 0006): an edit from the Automations screen is checked as a whole before it is saved — a bad one is refused with its problems, never half applied
function updateRoutine(id, patch) {
  const i = rlist.routines.findIndex(x => x.id === id); if (i < 0) return { problems: ['no such routine'] };
  const v = routines.validate({ ...rlist.routines[i], ...patch, id }, AGENTS, rlist.routines.filter(x => x.id !== id));
  if (v.problems.length) return { problems: v.problems };
  rlist.routines[i] = v.routine; routines.save(BRAIN, rlist.routines);
  console.log(`⏱ routine ${id} edited`); return { routine: loadRoutines().find(x => x.id === id) };
}
function removeRoutine(id) { const n = rlist.routines.length; rlist.routines = rlist.routines.filter(x => x.id !== id); if (rlist.routines.length !== n) routines.save(BRAIN, rlist.routines); loadRoutines(); return rlist.routines.length !== n; }
// a sentence (or the REPEAT picker) → a routine in the brain file. Claude names the agent, the title and whether it needs the OK.
async function makeRoutine({ dept, text, when, agent, needsOk, model, effort, title, team }) {
  let taskText = String(text || '').trim(), w = when, parsed = null;
  if (!w) {
    parsed = parseWhen(taskText);
    if (!parsed) return { error: 'No schedule in that sentence. Say when: "every weekday at 8am, …", "Mondays 9am, …", "every hour 9-5, …".', noSchedule: true };
    if (parsed.needsDay) return { error: 'Which day? Say "every Monday …" or "Mon and Thu …".', needsDay: true };
    if (parsed.needsTime) return { error: 'What time? Say "… at 8am" or "… at 17:30".', needsTime: true };
    w = parsed.when; taskText = parsed.text;
  }
  if (!validWhen(w)) return { error: 'That schedule is not complete.' };
  if (!taskText) return { error: 'What should happen? The sentence has a time but no task.' };
  loadRoutines();
  const named = String(title || '').trim().slice(0, 90), desk = agent && AGENTS.find(x => x.id === agent && x.department === dept);
  const r = desk && named ? { agent, title: named, plan: [], why: '', needsOk: routines.guessNeedsOk(taskText) } : await route(dept, taskText); // STORE spec 0006: the screen named the desk and the title, so no Claude run
  const a = desk ? agent : r.agent; if (named) r.title = named;
  const v = routines.validate({ id: uniqueId(slug(r.title).slice(0, 40), rlist.routines), dept, agent: a, title: r.title, text: taskText, when: w, needsOk: typeof needsOk === 'boolean' ? needsOk : r.needsOk, plan: r.plan, model: normModel(model) || undefined, effort: normEffort(effort) || undefined, team: team === true || undefined }, AGENTS, rlist.routines);
  if (v.problems.length) return { error: v.problems.join('; ') };
  rlist.routines.push(v.routine); routines.save(BRAIN, rlist.routines);
  const out = loadRoutines().find(x => x.id === v.routine.id);
  console.log(`⏱ routine ${out.id} → ${out.agent}: ${out.title} (${out.desc} · next ${untilText(out.nextAt)}${out.needsOk ? ' · waits for the OK' : ''})`);
  return { ok: true, routine: out, why: r.why, guessed: parsed?.guessed ? parsed.guessWord : null };
}
// B2: a routine said to an agent in chat. The lead routes it inside the department; a specialist takes it on.
async function routinesChat(a, text) {
  const t = String(text).trim(), dept = a.department, allowed = routines.ALLOWED.includes(dept);
  if (/^\s*(routines?|schedule|timetable|what(?:'s| is) (?:scheduled|on the (?:schedule|timetable)))\s*\??\s*$/i.test(t)) return { reply: allowed ? routines.listText(loadRoutines(), dept, AGENTS) : routines.refusal(dept) };
  const cmd = /^\s*(pause|stop|resume|start|unpause|delete|remove|run)\b\s*(?:the\s+)?(.*?)\s*[.!]?$/i.exec(t);
  if (cmd && allowed && !parseWhen(t)) {
    const list = loadRoutines(); const words = cmd[2].replace(/\s+(routine|one)$/i, ''); const r = routines.matchRoutine(list, dept, words);
    if (!r) return { reply: (list.some(x => x.dept === dept) ? 'Which one? ' : '') + routines.listText(list, dept, AGENTS) };
    const verb = cmd[1].toLowerCase();
    if (verb === 'run') { const task = fire(r, { by: 'you' }); return { reply: `Running "${r.title}" now — ${r.agent === a.id ? 'I have it' : agentName(r.agent) + ' has it'}. It lands in the panel${r.needsOk ? ' and waits for your OK before anything is sent' : ''}.`, task }; }
    if (/pause|stop/.test(verb)) { editRoutine(r.id, { paused: true }); return { reply: `Paused "${r.title}". It stays on the timetable; say "resume ${r.title.toLowerCase()}" to start it again.` }; }
    if (/resume|start|unpause/.test(verb)) { const n = editRoutine(r.id, { paused: false }); return { reply: `"${r.title}" is back on — next ${untilText(n.nextAt)}.` }; }
    if (/delete|remove/.test(verb)) { removeRoutine(r.id); return { reply: `Deleted "${r.title}". It is off the timetable.` }; }
  }
  const p = parseWhen(t);
  if (!p) return null;
  if (!allowed) return { reply: routines.refusal(dept) };
  if (p.needsDay) return { reply: 'Which day? Say it again with the day: "every Monday at 9am, …".' };
  if (p.needsTime) return { reply: `What time? Say it again with the time, e.g. "every weekday at 8am, ${p.text ? p.text.slice(0, 60) : '…'}".` };
  if (!p.text) return { reply: 'I have the time but not the task. Say it again with what should happen.' };
  const made = await makeRoutine({ dept, text: p.text, when: p.when, agent: a.lead ? undefined : a.id });
  if (made.error) return { reply: made.error };
  const r = made.routine, who = r.agent === a.id ? 'I have it' : `${agentName(r.agent)} has it`;
  return { reply: `Done. ${r.desc.charAt(0).toUpperCase() + r.desc.slice(1)}, ${who}.${made.guessed ? ` I took "${made.guessed}" as ${r.when.at}; say a time to change it.` : ''} ${r.needsOk ? 'Anything to send waits for your OK first.' : 'It only reads, so it will not wait for you.'} Next run ${untilText(r.nextAt)}. Say "routines" to see the list, "pause ${r.title.toLowerCase()}" to stop it.`, routine: r };
}

// an agent's chat turn — the page and the Telegram lead bots take this one path (STORE spec 0005)
async function chatReply(a, text, history) {
  if (!onboard.active(DATA, a.department)) { // V3.5: "every weekday at 8am, …" · "routines" · "pause …" · "run … now" — unless the lead is mid-interview
    const tc = triggersChat(a, text); // STORE spec 0004: "triggers", "pause … trigger"
    if (tc) return { reply: tc.reply, read: [], tools: [], interview: false, triggers: true };
    const ac = await approvalsChat(a, text); // STORE spec 0002: auto approve rules, before routines ("pause … rule" is a rule)
    if (ac) return { reply: ac.reply, read: [], tools: [], interview: false, approvals: true };
    const rc = await routinesChat(a, text);
    if (rc) return { reply: rc.reply, read: [], tools: [], interview: false, routine: rc.routine || null, routines: true };
  }
  if (leadOf(a.department).id === a.id) { // the department lead can run the set-up interview
    refreshSkills();
    const o = await onboard.handle(text, { dept: a.department, deptName: DEPTS[a.department].name, lead: a, agents: AGENTS.filter(x => x.department === a.department),
      connected: mcp.summary().servers?.filter(x => x.status === 'connected').map(x => x.name || x.key) || [], brainPath: BRAIN, dataDir: DATA, ask, business: cfg.name, afterWrite: refreshSkills });
    if (o) { if (o.wrote) console.log(`★ ${a.name} set up ${DEPTS[a.department].name}: ${o.wrote.briefs.length} briefs${o.wrote.skill ? ', skill ' + o.wrote.skill.name : ''}`); return { reply: o.reply, read: [], tools: [], interview: !o.wrote, setup: setupMap() }; }
  }
  const r = await chat(a.id, text, history);
  return { ...r, interview: false };
}

/* ---------- STORE (spec 0005): the team on Telegram — eight bots, one owner, the office's own paths ---------- */
const TG = telegram.settings(cfg); for (const w of TG.problems) console.warn('telegram:', w);
let team = null;
async function teamTask({ dept, text, title, needsOk, goal, goalPiece, goalContext, by = 'telegram' }) { // a task the owner gave a bot (or the CEO planned), run on the server · goalPiece, goalContext: spec 0007
  const { value: r, usage: routed } = await meter.measure(() => route(dept, text)); // STORE: routing is part of the task's tokens
  const task = { id: nid(), dept, agent: r.agent, title: title || r.title, text, plan: r.plan, eta: r.eta, why: r.why, state: 'next', addedAt: Date.now(), by, asked: true, needsOk: typeof needsOk === 'boolean' ? needsOk : r.needsOk, ...(goal ? { goal } : {}), ...(goalPiece ? { goalPiece } : {}), ...(goalContext ? { goalContext } : {}), ...(routed.runs ? { usage: routed } : {}) };
  const list = load(); list.push(task); save(list);
  console.log(`📱 ${task.id} → ${task.agent}: ${task.title} (${by}${task.needsOk ? ', a draft' : ''})`);
  enqueue(() => runServerTask(task.id));
  return task;
}
function teamContext() {
  return { cfg, tg: TG, dataDir: DATA, brainPath: BRAIN, AGENTS, DEPTS, leadOf, actions, approvals, triggers, ask, measure: meter.measure,
    tasks: () => load(), task: id => load().find(t => t.id === id), addTask: teamTask,
    approve: async id => { const r = await ownerDecides(id, 'approve'); return r.status === 200 ? { ok: true, state: r.body.state } : { ok: false, error: r.body.error }; },
    reject: async (id, note) => { const r = await ownerDecides(id, 'reject', note); return r.status === 200 ? { ok: true } : { ok: false, error: r.body.error }; },
    leadChat: async (a, text, history) => (await chatReply(a, text, (history || []).map(h => ({ who: h.who === 'owner' ? 'user' : 'agent', text: h.text })))).reply,
    run: async ({ system, user, gated, model }) => { const md = normModel(model) || cfg.model; const o = gated ? await askFor('routine', path.join(GATES, `tg-${nid()}-run`), system, user, { model: md, maxTokens: 2000 }) : await askX(system, user, { model: md, maxTokens: 2000 }); return { text: o.text, runDenied: o.runDenied || [] }; },
    notes: text => { const index = vaultIndex(); return (businessContext(index) + '\n\n' + contextText(index, relevantNotes(index, null, text, 3))).slice(0, 5000); },
    toolsText: () => mcp.promptText([]), makeRoutine, parseWhen, describeWhen: describe, triggerState: () => TSTATE,
    store: () => SHOP.on ? { line: `${SHOP.shop}${TSTATE.problem ? ' · ' + TSTATE.problem : TSTATE.lastOk ? ' · checked ' + new Date(TSTATE.lastOk).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''} · trigger tasks today: ${Object.values(TSTATE.counts || {}).reduce((s, n) => s + n, 0)}` } : null,
    log: s => console.log(s) };
}

/* ---------- http ---------- */
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const body = req => new Promise((resolve, reject) => { let s = ''; req.on('data', d => { s += d; }); req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } }); });

{ // STORE spec 0001 (AC-15): an approve the office stopped in the middle of is closed out, never re-run; leftover gate folders go
  const l = load(); const stopped = l.filter(t => t.state === 'doing' && t.approving);
  for (const t of stopped) { actions.closeOut(t); try { t.note = writeNote(t); } catch (e) { console.warn('note:', e.message); } console.warn(`⚠ ${t.id} the office stopped while sending "${t.title}" — marked done, outcomes unknown, check before resending`); }
  if (stopped.length) save(l);
  fs.rmSync(GATES, { recursive: true, force: true });
}
await rebuildGraph();
const discovering = mcp.discover().then(l => { console.log(`  connectors: ${l.filter(s => s.status === 'connected').length} connected of ${l.length} (claude mcp list)`); return l; });
const agentsOut = () => { const setup = setupMap(); return AGENTS.map(a => ({ id: a.id, name: a.name, role: a.role, does: a.does, tools: a.tools, brief: a.brief || '', model: a.model || '', effort: a.effort || '', skills: skills.names(a), lessons: learn.count(BRAIN, a.id), department: a.department, lead: a.lead,
  interviewer: leadOf(a.department).id === a.id, setUp: setup[a.department] })); };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/command-centre-v2.html' || url.pathname === '/dark')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      const page = fs.readFileSync(HTML, 'utf8');
      return res.end(url.pathname === '/dark' ? page.replace('<body>', '<body class="dark">') : page); // /dark: the same file, opened in dark mode
    }
    if (url.pathname === '/api/health') return json(res, 200, { ok: true, version, backend, model: cfg.model, modelName: modelName(cfg.model), models: MODEL_KEYS, effort: cfg.effort || '', efforts: EFFORT_KEYS, name: cfg.name, brain: BRAIN, notes: graph.notes, depts: DEPT_KEYS,
      agents: agentsOut(), setup: setupMap(), routines: (l => ({ count: l.length, paused: l.filter(r => r.paused).length, depts: routines.ALLOWED }))(loadRoutines()), roster: { customised: roster.customised, briefed: roster.briefed, files: roster.files, problems: roster.problems }, skills: (({ count, shipped, brain, problems }) => ({ count, shipped, brain, problems }))(skills.summary()), tools: backend === 'claude-cli', mcp: mcp.summary(), teams: TEAMS, browser: mcp.summary().browser });
    if (url.pathname === '/api/agents') return json(res, 200, { agents: agentsOut(), problems: roster.problems, files: roster.files });
    if (url.pathname === '/api/skills') return json(res, 200, refreshSkills().summary()); // reloads from disk: edit a skill, hit this, see it
    if (url.pathname === '/api/lessons') return json(res, 200, { dir: learn.dir(BRAIN), agents: AGENTS.map(a => ({ id: a.id, name: a.name, ...learn.read(BRAIN, a.id) })).filter(x => x.rules.length || x.oneOffs.length) });
    if (url.pathname === '/api/mcp') { if (url.searchParams.get('refresh') === '1') await mcp.discover(); else await discovering; return json(res, 200, { ...mcp.summary(), tools: backend === 'claude-cli' }); }
    if (url.pathname === '/api/brain') return json(res, 200, graph);
    if (url.pathname === '/api/usage') return json(res, 200, await getUsage(url.searchParams.get('refresh') === '1')); // V3.6: the plan's gauge (never a 500: unavailable is an answer)
    if (url.pathname === '/api/tasks' && req.method === 'GET') return json(res, 200, load());
    if (url.pathname === '/api/routines' && req.method === 'GET') return json(res, 200, routinesOut());
    if (url.pathname === '/api/routines' && req.method === 'POST') {
      const b = await body(req);
      if (!DEPTS[b.dept] || b.dept === 'brain') return json(res, 400, { error: 'unknown department' });
      if (!routines.ALLOWED.includes(b.dept)) return json(res, 400, { error: routines.refusal(b.dept), refused: true });
      const r = await makeRoutine({ dept: b.dept, text: b.text, when: b.when, agent: b.agent, needsOk: b.needsOk, model: b.model, effort: b.effort, title: b.title, team: b.team });
      return json(res, r.error ? 400 : 200, r);
    }
    const rm = url.pathname.match(/^\/api\/routines\/([^/]+)(?:\/(run|pause|resume))?$/);
    if (rm) {
      const r = loadRoutines().find(x => x.id === rm[1]);
      if (!r) return json(res, 404, { error: 'no such routine' });
      if (req.method === 'DELETE') { removeRoutine(r.id); return json(res, 200, { ok: true, routines: loadRoutines() }); }
      if (req.method !== 'POST') return json(res, 405, { error: 'POST or DELETE' });
      if (rm[2] === 'run') return json(res, 200, { ok: true, task: fire(r, { by: 'you' }), routines: loadRoutines() });
      if (rm[2] === 'pause' || rm[2] === 'resume') { editRoutine(r.id, { paused: rm[2] === 'pause' }); return json(res, 200, { ok: true, routines: loadRoutines() }); }
      const b = await body(req); const patch = {};
      if (typeof b.needsOk === 'boolean') patch.needsOk = b.needsOk; if (typeof b.paused === 'boolean') patch.paused = b.paused;
      if (typeof b.text === 'string' && b.text.trim()) patch.text = b.text.trim(); if (typeof b.title === 'string' && b.title.trim()) patch.title = b.title.trim().slice(0, 90);
      if (b.when) patch.when = b.when; // STORE spec 0006: a bad schedule is refused by name, not dropped without a word
      if (b.model !== undefined) patch.model = normModel(b.model) || '';
      if (b.effort !== undefined) patch.effort = normEffort(b.effort) || '';
      if (typeof b.dept === 'string') patch.dept = b.dept; if (typeof b.agent === 'string') patch.agent = b.agent; if (typeof b.team === 'boolean') patch.team = b.team; // STORE spec 0006: move it to another desk, or make it a team routine
      const u = updateRoutine(r.id, patch); if (u.problems) return json(res, 400, { error: u.problems.map(p => p.replace(/^[^:]+: /, '')).join('; '), problems: u.problems });
      return json(res, 200, { ok: true, routine: u.routine, routines: loadRoutines() });
    }
    if (url.pathname === '/api/telegram' && req.method === 'GET') return json(res, 200, team ? { ...team.status(), problems: TG.problems } : { on: false, configured: TG.on, problems: TG.problems }); // STORE spec 0005
    if (url.pathname === '/api/triggers' && req.method === 'GET') return json(res, 200, triggersOut()); // STORE spec 0004
    // STORE (26 Oct 2026, spec 0006): the Automations screen writes triggers — POST /api/triggers makes one, POST /api/triggers/:id replaces it; { dry: true } only checks
    // JSON only: a text/plain POST needs no CORS preflight, so without this any web page open in the owner's browser could write a trigger or a rule here
    const notJSON = () => { if (/^application\/json\b/i.test(req.headers['content-type'] || '')) return false; json(res, 415, { error: 'send JSON (content-type: application/json)' }); return true; };
    const saveTrigger = async (id) => { if (notJSON()) return; const b = await body(req), u = triggers.upsert(BRAIN, AGENTS, id, b, { dry: b.dry === true });
      if (u.missing) return json(res, 404, { error: 'no such trigger' });
      if (u.problems) return json(res, 400, { error: u.problems.map(p => p.replace(/^[^:]+: /, '')).join('; '), problems: u.problems });
      if (b.dry !== true) console.log(`🛍 trigger ${u.trigger.id} ${id ? 'edited' : 'added'}: ${u.trigger.title} (${u.desc} → ${u.trigger.agent})`);
      return json(res, 200, { ok: true, dry: b.dry === true, trigger: u.trigger, desc: u.desc, ...triggersOut() }); };
    if (url.pathname === '/api/triggers' && req.method === 'POST') return saveTrigger(null);
    const tm = url.pathname.match(/^\/api\/triggers\/([^/]+)(?:\/(pause|resume|run))?$/);
    if (tm) {
      const tid = (() => { try { return decodeURIComponent(tm[1]); } catch { return tm[1]; } })(), x = loadTriggers().triggers.find(y => y.id === tid);
      if (!x) return json(res, 404, { error: 'no such trigger' });
      if (req.method === 'POST' && !tm[2]) return saveTrigger(x.id);
      if (req.method === 'DELETE' && !tm[2]) triggers.edit(BRAIN, doc => { doc.triggers = doc.triggers.filter(y => y?.id !== x.id); });
      else if (req.method === 'POST' && (tm[2] === 'pause' || tm[2] === 'resume')) triggers.edit(BRAIN, doc => { const y = doc.triggers.find(z => z?.id === x.id); if (y) y.paused = tm[2] === 'pause'; });
      else if (req.method === 'POST' && tm[2] === 'run') { const r = await checkStore({ runNow: x.id, force: true }); return json(res, 200, { ok: true, fired: (r.fired || []).map(t => t.id), ...triggersOut() }); } // RUN NOW: check now, start what is held past the cap
      else return json(res, 405, { error: 'POST …/pause|resume|run or DELETE' });
      console.log(`🛍 trigger ${x.id} ${req.method === 'DELETE' ? 'deleted' : tm[2] + 'd'}`);
      return json(res, 200, { ok: true, ...triggersOut() });
    }
    if (url.pathname === '/api/approvals' && req.method === 'GET') return json(res, 200, approvalsOut()); // STORE spec 0002
    // STORE (26 Oct 2026, spec 0006): the Automations screen writes rules — POST /api/approvals makes one, POST /api/approvals/:id replaces it.
    // The screen sends { dry: true } first and reads the rule back (and what an edit widens) before the owner turns it on, as the lead's chat does.
    const saveRule = async (id) => { if (notJSON()) return; const b = await body(req), u = approvals.upsert(BRAIN, id, b, { dry: b.dry === true });
      if (u.missing) return json(res, 404, { error: 'no such rule' });
      if (u.problems) return json(res, 400, { error: u.problems.map(p => p.replace(/^[^:]+: /, '')).join('; '), problems: u.problems });
      if (b.dry !== true) console.log(`⚡ rule ${u.rule.id} ${id ? 'edited' : 'on'} (from the Automations screen): ${u.desc}${u.widens.length ? ' · wider: ' + u.widens.join('; ') : ''}`);
      return json(res, 200, { ok: true, dry: b.dry === true, rule: u.rule, desc: u.desc, widens: u.widens, ...approvalsOut() }); };
    if (url.pathname === '/api/approvals' && req.method === 'POST') return saveRule(null);
    const am = url.pathname.match(/^\/api\/approvals\/([^/]+)(?:\/(pause|resume))?$/);
    if (am) {
      if ((am[1] === 'pause' || am[1] === 'resume') && !am[2]) { // the one switch for every rule
        if (req.method !== 'POST') return json(res, 405, { error: 'POST' });
        approvals.edit(BRAIN, doc => { doc.paused = am[1] === 'pause'; }); console.log(`⚡ auto approvals ${am[1]}d`); return json(res, 200, { ok: true, ...approvalsOut() });
      }
      const rid = (() => { try { return decodeURIComponent(am[1]); } catch { return am[1]; } })(); // an id written by hand may hold a space
      const r = approvals.load(BRAIN).rules.find(x => x.id === rid); if (!r) return json(res, 404, { error: 'no such rule' });
      if (req.method === 'POST' && !am[2]) return saveRule(r.id);
      if (req.method === 'DELETE' && !am[2]) approvals.edit(BRAIN, doc => { doc.rules = doc.rules.filter(x => x?.id !== r.id); });
      else if (req.method === 'POST' && am[2]) approvals.edit(BRAIN, doc => { const x = doc.rules.find(y => y?.id === r.id); if (x) x.paused = am[2] === 'pause'; });
      else return json(res, 405, { error: 'POST …/pause|resume or DELETE' });
      console.log(`⚡ rule ${r.id} ${req.method === 'DELETE' ? 'deleted' : am[2] + 'd'}`);
      return json(res, 200, { ok: true, ...approvalsOut() });
    }
    if (url.pathname === '/api/tasks' && req.method === 'POST') {
      const { dept, text, model, effort, team, at } = await body(req);
      if (!DEPTS[dept] || dept === 'brain') return json(res, 400, { error: 'unknown department' });
      if (!text || !String(text).trim()) return json(res, 400, { error: 'empty task' });
      const dueAt = at ? (typeof at === 'number' ? at : Date.parse(at)) : null; // V3.2.1: a task for a date
      if (at && !(dueAt > 0)) return json(res, 400, { error: 'at must be a time (ms or ISO)' });
      if (dueAt && dueAt < Date.now() - 60000) return json(res, 400, { error: 'that time has passed — pick one that is still ahead' });
      const { value: r, usage: routed } = await meter.measure(() => route(dept, String(text).trim())); // STORE: routing is part of the task's tokens
      const asTeam = TEAMS.enabled && (team === true || teams.intent(text)); // V3.2 (16 Sep): TEAM in the bar, or "as a team" in the sentence → the lead owns it and splits it
      const task = { id: nid(), dept, agent: asTeam ? leadOf(dept).id : r.agent, title: r.title, text: String(text).trim(), plan: r.plan, eta: r.eta, why: asTeam ? `team — ${leadOf(dept).name} splits it across the desks` : r.why, state: 'next', addedAt: Date.now(), by: 'you', model: normModel(model) || undefined, effort: normEffort(effort) || undefined, // model/effort: set on this task (beats routine, agent, office)
        team: asTeam ? { lead: leadOf(dept).id, asked: team === true ? 'you' : 'text' } : undefined, ...(routed.runs ? { usage: routed } : {}) };
      if (dueAt) { task.state = 'scheduled'; task.dueAt = dueAt; task.needsOk = r.needsOk; } // waits for its minute; needsOk decides whether it then waits for the OK
      const list = load(); list.push(task); save(list);
      console.log(`+ ${task.id} → ${task.agent}: ${task.title}${asTeam ? ' (team)' : ''}${dueAt ? ' · scheduled ' + untilText(dueAt) : ''}`);
      return json(res, 200, task);
    }
    const m = url.pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(run|revise|approve|reject))?$/);
    if (m && req.method === 'POST' && (m[2] === 'approve' || m[2] === 'reject')) { // D1: the owner's tick on a routine's draft (STORE spec 0005: the same path as Telegram's buttons)
      const { feedback } = m[2] === 'reject' ? await body(req) : {};
      const r = await ownerDecides(m[1], m[2], String(feedback || '').trim());
      return json(res, r.status, r.body);
    }
    if (m && req.method === 'POST' && (m[2] === 'run' || m[2] === 'revise')) {
      const list = load(); const task = list.find(t => t.id === m[1]);
      if (!task) return json(res, 404, { error: 'no such task' });
      const { feedback } = m[2] === 'revise' ? await body(req) : {};
      task.state = 'doing'; task.startedAt = Date.now(); save(list);
      const { usage: spent } = await meter.measure(async () => { try {
        const { result, read, tools, used, skills: sk, modelUsed, modelFrom, modelId: ran, effortUsed, effortFrom, team } = await run(task, feedback);
        Object.assign(task, { state: 'done', doneAt: Date.now(), result, read, tools, used, skills: sk, error: false, modelUsed, modelFrom, modelId: ran, effortUsed, effortFrom, ...(team ? { team } : {}) });
        task.note = writeNote(task);
        await rebuildGraph();
      } catch (e) {
        Object.assign(task, { state: 'done', doneAt: Date.now(), result: 'Could not complete this task: ' + e.message, error: true });
      } });
      task.usage = addTokens(task.usage, spent); // STORE: tokens per task
      const l2 = load(); const i = l2.findIndex(t => t.id === task.id); if (i >= 0) l2[i] = task; save(l2);
      console.log(`${task.error ? '✗' : '✓'} ${task.id} ${task.error ? 'failed' : 'done'} (${task.result.length} chars${task.tools?.length ? ', tools: ' + task.tools.join(' ') : ''}${task.note ? ', note: ' + task.note : ''})`);
      json(res, 200, task); team?.notify(task).catch(() => {}); // STORE spec 0005
      if (feedback && !task.error) { // learn from the correction, after the reply is out the door
        const a = AGENTS.find(x => x.id === task.agent);
        learn.classify(ask, a, task, feedback).then(v => { const r = learn.record(BRAIN, a, task, feedback, v); console.log(`  ↳ ${a.name} ${r.standing ? 'learned a rule' : 'noted a one-off'}: ${r.line.slice(0, 100)}`); })
          .catch(e => console.warn('learn:', e.message));
      }
      return;
    }
    if (m && req.method === 'DELETE') { save(load().filter(t => t.id !== m[1])); return json(res, 200, { ok: true }); }
    if (url.pathname === '/api/chat' && req.method === 'POST') {
      const { agent, text, history } = await body(req);
      if (!text || !String(text).trim()) return json(res, 400, { error: 'empty message' });
      const a = AGENTS.find(x => x.id === agent); if (!a) return json(res, 400, { error: 'unknown agent' });
      const { value, usage: spent } = await meter.measure(() => chatReply(a, String(text).trim(), history)); // STORE: tokens per chat turn
      return json(res, 200, { ...value, usage: spent });
    }
    json(res, 404, { error: 'not found' });
  } catch (e) { console.error(e); json(res, 500, { error: e.message }); }
});
server.listen(cfg.port, () => {
  console.log(`Agents Office ${version} → http://localhost:${cfg.port}`);
  console.log(`  business: ${cfg.name}   brain: ${BRAIN} (${graph.notes} notes, ${graph.links.length} links)   claude: ${backend} · ${modelName(cfg.model)}${cfg.effort ? ' · effort ' + cfg.effort : ''} by default (routing on Sonnet)`);
  getUsage(true).then(u => console.log(u.source === 'claude' ? `  usage: session ${u.session?.percent ?? '—'}% · week ${u.week?.percent ?? '—'}% (your Claude plan, as Claude Code shows it)` : `  usage: Claude's gauge unavailable (${u.reason}) — showing the office's own count`)).catch(() => {});
  console.log(`  tasks: ${FILE}   notes the agents write: ${NOTES_DIR}`);
  const rl = loadRoutines(); const nx = rl.filter(r => !r.paused && r.nextAt).sort((a, b) => a.nextAt - b.nextAt)[0];
  console.log(`  routines: ${rl.length} loaded${rl.some(r => r.paused) ? ' (' + rl.filter(r => r.paused).length + ' paused)' : ''}${nx ? ' · next ' + untilText(nx.nextAt) + ' ' + nx.title.toUpperCase() + ' (' + nx.agent + ')' : ''} · ${rlist.path}`);
  setInterval(tickRoutines, 20000); tickRoutines(); // the clock: every 20 s; the first tick catches up anything missed while the office was off (once, marked LATE)
  if (TG.on && process.env.AO_NO_TELEGRAM === '1') console.log('  telegram: off (AO_NO_TELEGRAM=1)'); // npm run check: the bots stay quiet
  else if (TG.on) { team = createTeam(teamContext()); team.start(); const st = team.status(); console.log(`  telegram: ${st.bots.filter(b => b.set).map(b => b.role).join(', ')} · ${st.paired ? 'paired with ' + (st.owner || 'the owner') : 'not paired yet: send the code above to any bot'}`); } // STORE spec 0005
  if (SHOP.on && process.env.AO_NO_STORE === '1') console.log('  store: polling off (AO_NO_STORE=1)'); // npm run check starts the office this way: a check never reads the store or starts trigger tasks
  else if (SHOP.on) { setInterval(() => checkStore(), SHOP.poll * 60000); setTimeout(() => checkStore(), 5000); console.log(`  store: ${SHOP.shop} · checked every ${SHOP.poll} min for ${loadTriggers().triggers.length} trigger(s) (read-only)`); } // STORE spec 0004
  console.log(`  agents: 35 (${roster.customised} customised${roster.briefed ? ', ' + roster.briefed + ' briefed' : ''}${roster.files.length ? ' via ' + roster.files.join(' + ') : ''})   tools: ${backend === 'claude-cli' ? 'connected MCP servers' + (cfg.tools?.web === false ? '' : ' + web') + (mcp.browserOn() ? ' + the owner\'s Chrome (' + (mcp.browserState().installed ? 'extension paired' + (mcp.browserState().device ? ': ' + mcp.browserState().device : '') : 'extension NOT paired — run `claude --chrome` once') + ')' : '') : 'none on the API backend'}`);
  console.log(`  teams: ${TEAMS.enabled ? 'on — TEAM in the bar or "as a team" in the sentence; the lead splits it across up to ' + TEAMS.max + ' desks' : 'off (teams.enabled in office.config.json)'}`);
  const sk = skills.summary(); const setup = setupMap(); const notYet = DEPT_KEYS.filter(k => !setup[k]);
  console.log(`  skills: ${sk.count} (${sk.shipped} shipped in skills/, ${sk.brain} in ${path.join(NOTES_DIR, 'skills')})${sk.problems.length ? '   ⚠ ' + sk.problems.length + ' problem' + (sk.problems.length > 1 ? 's' : '') + ' — see npm run check' : ''}`);
  console.log(`  set up: ${notYet.length === DEPT_KEYS.length ? 'no department yet — open a lead\'s chat and say "set up"' : notYet.length ? DEPT_KEYS.length - notYet.length + ' of 6 departments (not yet: ' + notYet.map(k => DEPTS[k].name).join(', ') + ')' : 'all six departments'}   lessons: ${learn.dir(BRAIN)}`);
});
