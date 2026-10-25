// V3.1 — the real connector list for the office. Served: GET /api/mcp (the MCP servers this
// machine's Claude Code is connected to) + /api/agents (the roster's tool preferences) become
// the `connectors` object initMcp() draws. Opened as a file: null → the demo list plays.
import { MCP_LOGOS } from './mcplogos.js';
import { DEPT_KEYS } from './data.js';

// brand inks for shared looms (a shared connector is wired to four or more pods)
const INK = { notion: '#151414', gmail: '#EA4335', slack: '#4A154B', zapier: '#FF4F00', claude_ai_Google_Drive: '#1FA463', googledrive: '#1FA463', chrome: '#4285F4' }; // V3.2 (16 Sep): Chrome is wired to every pod
const norm = s => String(s).toLowerCase().replace(/^claude\.ai\s+/, '').replace(/[^a-z0-9]/g, '');
function hue(name) { let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; }
export const inkOf = name => `hsl(${hue(name)} 52% 42%)`;

// a tile for a server we have no logo for: same white rounded square as the baked ones, the
// name's initials in a colour hashed from the name — stable across boots
export function tile(name) {
  const c = document.createElement('canvas'); c.width = c.height = 160;
  const x = c.getContext('2d');
  const r = 34;
  x.beginPath(); x.roundRect(1, 1, 158, 158, r); x.fillStyle = '#fff'; x.fill();
  x.lineWidth = 2; x.strokeStyle = 'rgba(28,26,23,0.10)'; x.stroke();
  const words = String(name).replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/);
  const ini = (words.length > 1 ? words[0][0] + words[1][0] : String(name).slice(0, 2)).toUpperCase();
  x.fillStyle = inkOf(name);
  x.font = `700 ${ini.length > 1 ? 64 : 76}px -apple-system, "Helvetica Neue", Arial, sans-serif`;
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(ini, 80, 86);
  return c.toDataURL('image/png');
}

// STORE (25 Oct 2026): a machine with 60+ servers drew 60+ logos in the bar and ~19 per pod. The office shows the ones that
// matter: at most TOP_MAX connected servers in the bar (the rest behind a "+N more" pill that names them, not-connected ones
// included) and at most DOCK_MAX per department. Ranked by: the department's agents name it in their tools · office.config.json
// wires it to chosen departments (not every pod) · it is one of a store's core tools. One logo per tool (two Gmails → one).
export const TOP_MAX = 10, DOCK_MAX = 5;
const CORE = ['shopify', 'gmail', 'googlecalendar', 'googledrive', 'chrome', 'slack', 'canva', 'notion', 'stripe', 'xero', 'klaviyo', 'quickbooks'];
const family = s => { const n = norm(s.key || '') + ' ' + norm(s.name); return CORE.find(c => n.includes(c)) || norm(s.name).replace(/^plugin[a-z]*?(smallbusiness|marketing|design)?/, ''); };

export function fromSummary(m, agents) {
  const logos = {}, names = {};
  for (const s of m.servers || []) { // a plugin's server wears the logo of the tool it wraps, and its name without "plugin:…:"
    const key = s.key || s.id, name = String(s.name).replace(/^plugin:[^:]+:/, '');
    logos[key] = MCP_LOGOS[key] || MCP_LOGOS[family(s)] || { name, img: tile(name) }; names[key] = name;
  }
  return { live: true, logos, names, off: [], ...choose(m.servers || [], agents), servers: m.servers || [], tools: !!m.tools, web: !!m.web };
}

/** servers (GET /api/mcp) + the roster → which logos the bar and each pod show: { byDept, shared, status, more, agentTools }. No DOM. */
export function choose(servers, agents) {
  const byDept = Object.fromEntries(DEPT_KEYS.map(k => [k, []]));
  const status = {}, shared = {};
  const all = servers.map(s => ({ s, key: s.key || s.id }));
  for (const { s, key } of all) status[key] = s.denied ? 'denied' : (s.allowed ? s.status : 'denied');
  const agentTools = agents ? Object.fromEntries(agents.map(a => [a.id, (a.tools || []).map(t => {
    const n = norm(t); const hit = servers.find(s => s.key === n || norm(s.name) === n || s.id === t || family(s) === n); return hit ? (hit.key || hit.id) : n;
  })])) : null;
  // only a usable server is wired to pods; one per tool family, the one with a real logo first
  const usable = all.filter(x => status[x.key] === 'connected').sort((a, b) => (MCP_LOGOS[b.key] ? 1 : 0) - (MCP_LOGOS[a.key] ? 1 : 0));
  const seen = new Set(), pick = usable.filter(x => { const f = family(x.s); if (seen.has(f)) return false; seen.add(f); return true; });
  const wants = (key, dept) => agents ? agents.filter(a => (!dept || a.department === dept) && (agentTools[a.id] || []).includes(key)).length : 0;
  const core = x => { const i = CORE.indexOf(family(x.s)); return i === 0 ? 1000 : i < 0 ? 0 : 40 - i * 3; }; // the store fork: Shopify, the store itself, is on every pod it is wired to
  const chosen = x => (x.s.depts || []).length && (x.s.depts || []).length < DEPT_KEYS.length ? 50 : 0;
  const rank = (x, dept) => wants(x.key, dept) * 100 + chosen(x) + core(x);
  const top = [...pick].sort((a, b) => rank(b) - rank(a)).slice(0, TOP_MAX);
  for (const d of DEPT_KEYS) byDept[d] = top.filter(x => (x.s.depts || []).includes(d)).sort((a, b) => rank(b, d) - rank(a, d)).slice(0, DOCK_MAX).map(x => x.key);
  for (const { key, s } of top) if (DEPT_KEYS.filter(d => byDept[d].includes(key)).length >= 4) shared[key] = INK[key] || INK[norm(s.name)] || inkOf(s.name);
  const shown = new Set(Object.values(byDept).flat()); // the bar draws what the pods are wired to
  const plain = s => String(s.name).replace(/^plugin:[^:]+:/, '');
  const more = { connected: usable.filter(x => !shown.has(x.key)).map(x => plain(x.s)), off: all.filter(x => status[x.key] !== 'connected').map(x => `${plain(x.s)} (${status[x.key]})`) };
  return { byDept, status, shared, more, agentTools };
}

export async function loadConnectors({ timeout = 25000 } = {}) {
  if (!location.protocol.startsWith('http')) return null;
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeout);
    const [m, a] = await Promise.all([fetch('/api/mcp', { signal: ctl.signal }).then(r => r.ok ? r.json() : null),
                                      fetch('/api/agents', { signal: ctl.signal }).then(r => r.ok ? r.json() : null).catch(() => null)]);
    clearTimeout(t);
    if (!m) return null;
    return fromSummary(m, a && a.agents);
  } catch { return null; }
}
