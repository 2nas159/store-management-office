// Agents Office — configuration (Beta).
// office.config.json is the shipped default; office.config.local.json (gitignored) overrides it;
// environment variables override both: AO_NAME, AO_BRAIN, PORT, AO_MODEL.
// V3.1 keys: mcp { allow, deny, departments } · tools { web } · timeout (seconds per agent run) — see mcp.mjs.
// STORE (24 Oct 2026) key: currency (ISO code for an action with an amount and no currency, default USD; spec 0001) — problems lands in c.problems.
// V3.2 (16 Sep) keys: tools { browser } (Claude in Chrome for the agents, default on) · teams { enabled, max } (Agent Teams, default on, up to 4 desks) — see teams.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

export function loadConfig() {
  const base = readJSON(path.join(ROOT, 'office.config.json'));
  const local = readJSON(path.join(ROOT, 'office.config.local.json'));
  const c = { name: 'Agents Office', brain: './brain', port: 4520, model: 'sonnet', ...base, ...local }; // V3.6: model = sonnet · opus · fable
  c.mcp = { allow: [], deny: [], departments: {}, ...(base.mcp || {}), ...(local.mcp || {}) };
  c.tools = { web: true, browser: true, ...(base.tools || {}), ...(local.tools || {}) }; // V3.2 (16 Sep): browser = Claude in Chrome
  c.teams = { enabled: true, max: 4, ...(base.teams || {}), ...(local.teams || {}) }; // V3.2 (16 Sep): Agent Teams
  if (process.env.AO_NAME) c.name = process.env.AO_NAME;
  if (process.env.AO_BRAIN) c.brain = process.env.AO_BRAIN;
  if (process.env.PORT) c.port = +process.env.PORT;
  if (process.env.AO_MODEL) c.model = process.env.AO_MODEL;
  c.port = +c.port || 4520;
  c.problems = [];
  { const cur = String(c.currency ?? 'USD').trim().toUpperCase(); if (/^[A-Z]{3}$/.test(cur)) c.currency = cur; else { c.problems.push(`currency must be a three letter code like USD (got "${c.currency}"), using USD`); c.currency = 'USD'; } } // STORE spec 0001
  { // STORE spec 0003: the owner's read/write lists for the read-only gate of drafts and routines (full tool names, * wildcard); local wins per list
    const g = { read: [], write: [], ...(base.gate || {}), ...(local.gate || {}) }; c.gate = { read: [], write: [] };
    for (const k of ['read', 'write']) { if (!Array.isArray(g[k])) { c.problems.push(`gate.${k} must be a list of tool names`); continue; } for (const p of g[k]) { if (typeof p === 'string' && /^mcp__\S+$/.test(p.trim())) c.gate[k].push(p.trim()); else c.problems.push(`gate.${k}: "${p}" is not a tool name like mcp__<server>__<tool> (* is a wildcard)`); } }
  }
  { // STORE spec 0004: the store's access lives in the local file only; a secret in the shared (git) file is refused, never used
    c.shopify = { ...(base.shopify || {}), ...(local.shopify || {}) };
    for (const k of ['clientId', 'clientSecret', 'token']) if (base.shopify?.[k]) { c.problems.push(`shopify.${k} is in office.config.json, which git shares: move it to office.config.local.json (gitignored)`); if (local.shopify?.[k] === undefined) delete c.shopify[k]; }
    if (!base.shopify && !local.shopify) delete c.shopify;
  }
  { // STORE spec 0005: bot tokens live in the local file only; a token in the shared (git) file is refused, never used
    c.telegram = { ...(base.telegram || {}), ...(local.telegram || {}) };
    if (base.telegram?.bots && Object.keys(base.telegram.bots).length) { c.problems.push('telegram.bots (bot tokens) are in office.config.json, which git shares: move them to office.config.local.json (gitignored)'); c.telegram.bots = local.telegram?.bots || {}; }
    if (!base.telegram && !local.telegram) delete c.telegram;
  }
  c.brainPath = path.resolve(ROOT, c.brain);
  return c;
}
