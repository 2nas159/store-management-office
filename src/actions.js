// Agents Office — the outbound action list on a draft (STORE, spec 0001). Shared by the page and the
// server (actions.mjs re-exports it), so it stays free of DOM and Node APIs.
// A draft that waits for the owner's OK carries `actions`: what kind, to whom, how much, through which
// connector tool. The card shows one line each, the WAITING row shows the count and the totals.
export const KINDS = ['email', 'reply', 'post', 'refund', 'discount', 'payment', 'order_update', 'product_update', 'inventory', 'message', 'other'];
export const OLD_WHY = 'drafted before action lists, send it back to redraft it'; // AC-12
export const STATUS_TEXT = { done: 'done', failed: 'failed', unknown: 'unknown', not_done: 'not done' };

// can this draft be approved? A task drafted before action lists has no `actions` at all
export function readOf(t) {
  if (!t || !Array.isArray(t.actions) || !t.actionsRead) return { ok: false, why: OLD_WHY };
  return t.actionsRead === 'ok' ? { ok: true, why: '' } : { ok: false, why: t.actionsWhy || 'the actions in this draft could not be read' };
}
export const money = a => a.amount != null ? `${Number(a.amount).toFixed(2)} ${a.currency || ''}`.trim() : a.percent != null ? `${a.percent}%` : '';
const kindText = k => String(k).replace(/_/g, ' ');

// "3 actions · 912.00 USD" — percent discounts count toward the number, not the totals
export function summary(list) {
  if (!Array.isArray(list)) return '';
  if (!list.length) return 'nothing goes out';
  const tot = {};
  for (const a of list) if (a.amount != null) tot[a.currency || ''] = (tot[a.currency || ''] || 0) + Number(a.amount);
  const money = Object.entries(tot).map(([c, v]) => `${v.toFixed(2)} ${c}`.trim());
  return `${list.length} action${list.length > 1 ? 's' : ''}${money.length ? ' · ' + money.join(' · ') : ''}`;
}
// one plain line per action for the approval card: kind, to, amount or percent, summary, tool
export function cardLines(list) {
  return (list || []).map(a => ({ head: `${kindText(a.kind)} · to ${a.to}`, money: money(a), summary: a.summary, tool: a.tool }));
}
// is the action's amount and recipient in a tool call's input? The amount matches within 0.005 or in minor units (12.50 = 1250);
// the recipient case insensitive, as a whole value inside any value. A manual approve only flags a miss; the strict gate of an auto approved run (spec 0002) blocks it
export const num = v => typeof v === 'number' ? v : typeof v === 'string' && /^-?\d*\.?\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
function values(v, out = []) {
  if (Array.isArray(v)) for (const x of v) values(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) values(x, out);
  else if (typeof v === 'string' || typeof v === 'number') out.push(v);
  return out;
}
export function found(a, input) {
  const vals = values(input);
  const amountOk = a.amount == null || vals.some(v => { const n = num(v); return Number.isFinite(n) && (Math.abs(n - a.amount) < 0.005 || n === Math.round(a.amount * 100)); });
  // STORE (review, 24 Oct 2026): the recipient as a whole value — no letter or digit right before or after it, so "#1" never matches "#10"
  const to = new RegExp(`(^|[^a-z0-9])${String(a.to).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`, 'i'), toOk = vals.some(v => to.test(String(v)));
  const flag = [!amountOk && `amount ${Number(a.amount).toFixed(2)} not found in the call`, !toOk && 'recipient not found in the call'].filter(Boolean).join('; ');
  return { ok: amountOk && toOk, flag };
}
// one line per action once it has run: "a1 · refund · to #1001 · 12.50 USD · done"
export function outcomeLine(a) {
  const o = a.outcome || {};
  return [a.id, kindText(a.kind), `to ${a.to}`, money(a), STATUS_TEXT[o.status] || 'not run'].filter(Boolean).join(' · ') +
    (o.error ? ` · ${String(o.error).replace(/\s+/g, ' ').slice(0, 200)}` : '') + (o.flag ? ` · flag: ${o.flag}` : '');
}
