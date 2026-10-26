// Agents Office — store triggers, the pure part (STORE, spec 0004; moved here 26 Oct 2026 for spec 0006).
// Shared by the server (triggers.mjs re-exports it) and the page (the Automations screen checks a trigger as it is typed).
// No DOM, no Node. agents: [{ id, name, department, lead }].
import { DEPT_KEYS } from './data.js';

export const EVENTS = { order_created: 'a new order', order_cancelled: 'a cancelled order', order_refunded: 'a refund', return_requested: 'a return request', stock_low: 'low stock' };
const slug = t => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

export function validate(t, agents, existing = []) {
  const problems = [], out = {};
  if (!t || typeof t !== 'object' || Array.isArray(t)) return { trigger: null, problems: ['a trigger is not an object'] };
  out.title = String(t.title || '').trim().slice(0, 90);
  out.id = String(t.id || slug(out.title) || '').trim();
  const bad = why => problems.push(`${out.id || out.title || 'a trigger'}: ${why}`);
  if (!out.id) bad('no id or title');
  if (existing.some(x => x.id === out.id)) bad('two triggers share this id');
  out.event = String(t.event || '').trim(); if (!EVENTS[out.event]) bad(`"${t.event}" is not an event (${Object.keys(EVENTS).join(', ')})`);
  out.dept = String(t.dept || '').trim(); if (!DEPT_KEYS.includes(out.dept)) bad(`"${t.dept}" is not a department (${DEPT_KEYS.join(', ')})`);
  const lead = agents.find(a => a.department === out.dept && a.lead), a = t.agent ? agents.find(x => x.id === t.agent) : lead;
  if (!a) bad(`no agent called "${t.agent}"`); else if (a.department !== out.dept) bad(`${a.name} is not in ${out.dept}`);
  out.agent = a ? a.id : t.agent;
  out.text = String(t.text || '').trim(); if (!out.text) bad('no text (what the desk should do with the events)');
  if (!out.title) out.title = out.text.slice(0, 90);
  out.dailyCount = t.dailyCount === undefined ? 10 : Number(t.dailyCount);
  if (!(Number.isInteger(out.dailyCount) && out.dailyCount >= 1 && out.dailyCount <= 100)) bad('dailyCount must be a whole number from 1 to 100');
  out.needsOk = t.needsOk !== false;
  out.paused = t.paused === true;
  out.customerText = t.customerText === true;
  const minTotal = t.filter?.minTotal; out.filter = {};
  if (minTotal !== undefined) { if (!(Number(minTotal) >= 0)) bad('filter.minTotal must be a number of 0 or more'); else out.filter.minTotal = Number(minTotal); }
  if (out.event === 'stock_low') { out.below = Number(t.below); if (!(Number.isInteger(out.below) && out.below >= 0)) bad('a stock_low trigger needs below (a whole number: fire at or below this stock)'); }
  return { trigger: out, problems };
}
// STORE (26 Oct 2026, spec 0006): a validated trigger as it is written to the file (defaults and empty fields left out)
export const clean = t => Object.fromEntries(Object.entries({ id: t.id, event: t.event, dept: t.dept, agent: t.agent, title: t.title, text: t.text, dailyCount: t.dailyCount, needsOk: t.needsOk,
  below: t.event === 'stock_low' ? t.below : undefined, filter: t.filter?.minTotal !== undefined && t.event !== 'stock_low' ? { minTotal: t.filter.minTotal } : undefined, customerText: t.customerText || undefined, paused: t.paused || undefined })
  .filter(([, v]) => v !== undefined));
export const describe = t => `on ${EVENTS[t.event]}${t.event === 'stock_low' ? ` (at or below ${t.below})` : ''}${t.filter.minTotal ? ` over ${t.filter.minTotal}` : ''}`;
