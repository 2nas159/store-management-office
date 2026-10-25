// Agents Office — the Telegram Bot API client (STORE, spec 0005: docs/specs/0005-telegram-team.md).
// The office connects OUT to Telegram (getUpdates long polling), so nothing on this machine is exposed. One client per bot:
// the CEO, the secretary and the six department leads each have their own token from @BotFather.
//
//   office.config.local.json (gitignored; never office.config.json):
//   "telegram": { "bots": { "secretary": "<token>", "ceo": "<token>", "emails": "<token>", … }, "confirmAbove": 100 }
//
//   node telegram.mjs        tests every token and prints each bot's name — starts nothing, sends nothing
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROLES = ['secretary', 'ceo', 'emails', 'sales', 'marketing', 'ops', 'fin', 'delivery'];
export const MAX_TEXT = 3500; // past this a result goes as a .md document (Telegram's own limit is 4,096)
const TOKEN = /^\d{5,}:[A-Za-z0-9_-]{20,}$/;

/** office config → { on, bots: { role: token }, confirmAbove, morning, weekly, roles, problems } — never logs a token */
export function settings(cfg) {
  const t = cfg.telegram || {}, problems = [], bots = {};
  for (const [role, token] of Object.entries(t.bots || {})) {
    if (!ROLES.includes(role)) { problems.push(`telegram.bots: "${role}" is not a role (${ROLES.join(', ')})`); continue; }
    if (typeof token !== 'string' || !TOKEN.test(token.trim())) { problems.push(`telegram.bots.${role} does not look like a bot token from @BotFather`); continue; }
    bots[role] = token.trim();
  }
  const confirmAbove = t.confirmAbove === undefined ? 100 : Number(t.confirmAbove);
  if (!(confirmAbove >= 0)) problems.push('telegram.confirmAbove must be a number of 0 or more');
  const morning = /^\d{2}:\d{2}$/.test(t.morning || '') ? t.morning : '08:00';
  const weekly = { days: Array.isArray(t.weekly?.days) ? t.weekly.days.filter(d => d >= 0 && d <= 6) : [1], at: /^\d{2}:\d{2}$/.test(t.weekly?.at || '') ? t.weekly.at : '08:30' };
  return { on: Object.keys(bots).length > 0, bots, confirmAbove: confirmAbove >= 0 ? confirmAbove : 100, morning, weekly, roles: t.roles || {}, problems };
}

class TelegramError extends Error { constructor(message, code, retryAfter) { super(message); this.code = code; this.retryAfter = retryAfter || 0; } }

/** One bot. Every call goes through call(); a 429 waits Telegram's retry_after and tries again (twice). */
export function client(token, { fetchImpl = fetch } = {}) {
  const base = `https://api.telegram.org/bot${token}/`;
  let chain = Promise.resolve(), last = 0;
  async function call(method, body, form) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let r;
      try { r = await fetchImpl(base + method, form ? { method: 'POST', body: form } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); }
      catch (e) { throw new TelegramError(`Telegram did not answer (${e.code || e.message})`, 0); }
      let j = {}; try { j = await r.json(); } catch {}
      if (j.ok) return j.result;
      const after = j.parameters?.retry_after;
      if (r.status === 429 && after && attempt < 2) { await new Promise(res => setTimeout(res, Math.min(after, 30) * 1000)); continue; }
      throw new TelegramError(r.status === 401 || r.status === 404 ? 'Telegram does not accept this bot token (revoked or mistyped)' : `Telegram: ${j.description || r.status}`, r.status, after);
    }
  }
  // sends go one at a time per bot, at least 1 s apart (Telegram allows about one message a second per chat)
  const queued = fn => { const p = chain.then(async () => { const wait = 1000 - (Date.now() - last); if (wait > 0) await new Promise(res => setTimeout(res, wait)); last = Date.now(); return fn(); }); chain = p.catch(() => {}); return p; };
  const keyboard = buttons => buttons?.length ? { reply_markup: { inline_keyboard: buttons.map(row => row.map(b => ({ text: b.text, callback_data: String(b.data).slice(0, 64) }))) } } : {};
  return {
    me: () => call('getMe'),
    updates: (offset, timeout = 25) => call('getUpdates', { offset, timeout, allowed_updates: ['message', 'callback_query'] }),
    /** text → one message (split at 3,500 on line breaks) or, past 3 parts, a .md document */
    async send(chat, text, { buttons, name = 'message.md' } = {}) {
      const s = String(text || '').trim() || '…';
      if (s.length > MAX_TEXT * 3) return this.document(chat, name, s, { caption: s.split('\n')[0].slice(0, 200), buttons });
      const parts = []; let rest = s;
      while (rest.length > MAX_TEXT) { let cut = rest.lastIndexOf('\n', MAX_TEXT); if (cut < MAX_TEXT / 2) cut = MAX_TEXT; parts.push(rest.slice(0, cut)); rest = rest.slice(cut).replace(/^\n/, ''); }
      parts.push(rest);
      let msg = null; for (let i = 0; i < parts.length; i++) msg = await queued(() => call('sendMessage', { chat_id: chat, text: parts[i], disable_web_page_preview: true, ...(i === parts.length - 1 ? keyboard(buttons) : {}) }));
      return msg;
    },
    document(chat, name, content, { caption = '', buttons } = {}) {
      const form = new FormData(); form.append('chat_id', String(chat)); if (caption) form.append('caption', caption.slice(0, 1000));
      if (buttons?.length) form.append('reply_markup', JSON.stringify(keyboard(buttons).reply_markup));
      form.append('document', new Blob([String(content)], { type: 'text/markdown' }), name);
      return queued(() => call('sendDocument', null, form));
    },
    edit: (chat, id, text, { buttons } = {}) => queued(() => call('editMessageText', { chat_id: chat, message_id: id, text: String(text).slice(0, 4000), disable_web_page_preview: true, ...(buttons ? keyboard(buttons) : { reply_markup: { inline_keyboard: [] } }) })),
    answer: (id, text) => call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text: String(text).slice(0, 190) } : {}) }),
  };
}

/** Poll one bot forever: onUpdate(update) for each; the offset is kept by the caller (getOffset / setOffset). Errors back off 5 s → 60 s. */
export function poll(bot, { getOffset, setOffset, onUpdate, onProblem, stopped = () => false }) {
  let wait = 5000;
  (async function loop() {
    while (!stopped()) {
      try {
        const ups = await bot.updates(getOffset(), 25);
        for (const u of ups) { setOffset(u.update_id + 1); try { await onUpdate(u); } catch (e) { onProblem?.(`a message could not be handled: ${e.message}`, false); } }
        wait = 5000; onProblem?.(null);
      } catch (e) { onProblem?.(e.message, true); await new Promise(r => setTimeout(r, wait)); wait = Math.min(wait * 2, 60000); }
    }
  })();
}

// node telegram.mjs — every token's bot, read only
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { loadConfig } = await import('./config.mjs'); const cfg = loadConfig(), s = settings(cfg);
  for (const p of [...s.problems, ...cfg.problems.filter(p => /^telegram\./.test(p))]) console.log('⚠ ' + p);
  if (!s.on) { console.log('No bots yet: add "telegram": { "bots": { "secretary": "<token>", … } } to office.config.local.json.'); process.exit(1); }
  let bad = 0;
  for (const role of ROLES) { if (!s.bots[role]) { console.log(`  ${role.padEnd(10)} —  not set`); continue; } try { const me = await client(s.bots[role]).me(); console.log(`  ${role.padEnd(10)} ✓  @${me.username} (${me.first_name})`); } catch (e) { bad++; console.log(`  ${role.padEnd(10)} ✗  ${e.message}`); } }
  console.log(`\n${Object.keys(s.bots).length} of ${ROLES.length} bots set${bad ? ` · ${bad} not working` : ''}. Start the office (npm start) and send the pairing code it shows to any of them.`);
}
