// Agents Office — the team on Telegram (STORE, spec 0005: docs/specs/0005-telegram-team.md).
// Eight bots, one owner. The SECRETARY collects every approval (the action list with APPROVE / REJECT, a second tap above
// confirmAbove), sends the morning brief, keeps reminders, the calendar and the inbox, and runs office admin by sentence
// (rules, routines, triggers — always read back, saved on "yes"). The CEO plans goals across departments (its tasks are always
// drafts behind the read-only gate) and sends the weekly brief. Each DEPARTMENT LEAD is its own contact: chat as on the page,
// /task to give work, results come back to its chat.
// Every action goes through the office's own paths (ctx, from serve.mjs): the same approve, the same routing, the same gates.
// Only the paired owner gets an answer; nothing another bot says is ever an instruction.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROLES, client, poll } from './telegram.mjs';
import { tokensText, add as addTokens } from './src/tokens.js';
import * as GS from './goalsteps.mjs'; // STORE spec 0007: a goal's steps in order

const DEPTS6 = ['emails', 'sales', 'marketing', 'ops', 'fin', 'delivery'];
const YES = /^\s*(yes|y|yep|yes please|confirm|do it|go ahead|ok|okay)\s*[.!]?\s*$/i, NO = /^\s*(no|nope|cancel|drop it|stop)\b/i;
const CODE_FOR = 10 * 60 * 1000;
const day = ms => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const hm = ms => new Date(ms).toTimeString().slice(0, 5);
const readJSON = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };
const parseJSON = t => { const s = String(t).replace(/```json|```/g, ''); return JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)); };

/**
 * ctx (from serve.mjs): { cfg, tg, dataDir, AGENTS, DEPTS, leadOf, tasks(), task(id), addTask({ dept, text, title, needsOk, goal, goalPiece, goalContext, by }),
 *   approve(id), reject(id, note), leadChat(agent, text, history), run({ system, user, gated, model }) → { text, runDenied },
 *   ask(system, user, opts), notes(text), toolsText(), makeRoutine({ dept, text, when }), parseWhen, describeWhen,
 *   approvals, triggers, actions, store() → { line, counts }, log }
 */
export function createTeam(ctx, { clientFor = t => client(t), now = () => Date.now(), polling = true } = {}) {
  // data/telegram.json: the pairing, offsets and cards (delete it to unpair) · goals.json and reminders.json beside it survive that
  const file = path.join(ctx.dataDir, 'telegram.json'), goalsFile = path.join(ctx.dataDir, 'goals.json'), remindersFile = path.join(ctx.dataDir, 'reminders.json');
  const S = ctx.tg, old = readJSON(file, {});
  const st = { owner: null, group: null, offsets: {}, cards: {}, lastMorning: null, lastWeekly: null, ...old, goals: readJSON(goalsFile, null)?.goals || old.goals || {}, reminders: readJSON(remindersFile, null)?.reminders || old.reminders || [] };
  for (const g of Object.values(st.goals)) GS.upgrade(g); // STORE spec 0007 (AC-14): a goal saved before steps had keys gets p1 … and no `after`
  const save = () => { fs.mkdirSync(ctx.dataDir, { recursive: true }); const { goals, reminders, ...rest } = st;
    fs.writeFileSync(file, JSON.stringify(rest, null, 1)); fs.writeFileSync(goalsFile, JSON.stringify({ goals }, null, 1)); fs.writeFileSync(remindersFile, JSON.stringify({ reminders }, null, 1)); };
  const bots = {}, problems = {}, history = {}, pending = {}, usernames = {}; // pending[role] = { kind, … } — a read-back waiting for "yes", or a reject note
  for (const [role, token] of Object.entries(S.bots)) bots[role] = clientFor(token);
  let code = null, codeUntil = 0, wrong = 0;
  const newCode = () => { code = String(crypto.randomInt(100000, 1000000)); codeUntil = now() + CODE_FOR; wrong = 0; ctx.log(`📱 Telegram: send  /start ${code}  to any of your bots within 10 minutes to pair it with your account`); };
  if (!st.owner) newCode();
  // STORE (25 Oct 2026): every message says what it cost in tokens. measure(fn) → { value, usage } counts the Claude runs inside fn
  const measure = ctx.measure || (async fn => ({ value: await fn(), usage: null }));
  const foot = (u, label) => u ? '\n\n' + tokensText(u, { label }) : '';
  const lead = dept => ctx.leadOf(dept);
  const nameOf = role => role === 'secretary' ? (S.roles.secretary?.name || 'Secretary') : role === 'ceo' ? (S.roles.ceo?.name || 'CEO') : lead(role)?.name || role;
  // who speaks: the role's own bot, else the secretary, else any bot
  const voice = role => bots[role] ? role : bots.secretary ? 'secretary' : Object.keys(bots)[0];
  async function say(role, text, opts = {}) {
    if (!st.owner) return null; const r = voice(role); if (!r) return null;
    const prefix = r !== role ? `[${nameOf(role)}] ` : '';
    try { return await bots[r].send(st.owner.id, prefix + text, opts); } catch (e) { problems[r] = e.message; ctx.log(`📱 ${r}: ${e.message}`); return null; }
  }
  const boardroom = async (role, text) => { if (!st.group) return; const r = bots[role] ? role : voice(role); try { await bots[r].send(st.group, text); } catch (e) { problems[r] = e.message; } };
  const remember = (role, who, text) => { const h = history[role] || (history[role] = []); h.push({ who, text: String(text).slice(0, 1500) }); if (h.length > 8) h.shift(); };

  /* ---------- the approval card (the secretary) ---------- */
  function totals(actions) { const t = {}; for (const a of actions || []) if (a.amount != null) t[a.currency || ''] = (t[a.currency || ''] || 0) + Number(a.amount); return t; }
  function cardText(t) {
    const rd = ctx.actions.readOf(t), who = ctx.AGENTS.find(a => a.id === t.agent);
    const lines = !rd.ok ? [`Actions unreadable: ${rd.why}. APPROVE is locked; REJECT to redraft.`] : !t.actions.length ? ['Nothing goes out.'] :
      ctx.actions.cardLines(t.actions).map(l => `• ${l.head}${l.money ? ' · ' + l.money : ''} — ${l.summary}`);
    return [`⏸ ${t.title}`, `from ${who?.name || t.agent} · ${ctx.DEPTS[t.dept]?.name || t.dept}${t.trigger ? ' · store trigger ' + t.when : t.routine ? ' · routine ' + t.when : t.goal ? ' · CEO goal' : ''}`, '', ...lines,
      ...(t.autoWhy ? ['', `Not sent by rule: ${t.autoWhy}.`] : []), ...(t.runDenied?.length ? [`Blocked while drafting: ${[...new Set(t.runDenied.map(d => String(d.tool).replace(/^mcp__.+?__/, '')))].join(', ')}.`] : []), ...(t.usage ? ['', tokensText(t.usage, { label: 'the draft' })] : [])].join('\n');
  }
  const cardButtons = t => [[...(ctx.actions.readOf(t).ok ? [{ text: 'APPROVE', data: 'a:' + t.id }] : []), { text: 'REJECT', data: 'r:' + t.id }, { text: 'DETAILS', data: 'd:' + t.id }]];
  async function sendCard(t) { const m = await say('secretary', cardText(t), { buttons: cardButtons(t) }); if (m) { st.cards[t.id] = { chat: m.chat.id, msg: m.message_id, by: voice('secretary') }; save(); } }
  async function editCard(id, text, buttons) { const c = st.cards[id]; if (!c || !bots[c.by]) return; try { await bots[c.by].edit(c.chat, c.msg, text, { buttons }); } catch {} }
  /** the owner decided (here or on the page): the card loses its buttons. A sent-back draft is reworked into a NEW draft, so its card
   *  is closed and forgotten — the rework gets a fresh card; an old card can never approve a draft the owner has not seen. */
  async function decided(id, kind, note = '') {
    const c = st.cards[id], t = ctx.task(id); if (!c || c.closed) return;
    if (kind === 'reject') { await editCard(id, `↩ ${t?.title || id}\nSent back${note ? ': "' + note.slice(0, 300) + '"' : ''}. A new card comes when the rework is ready.`); delete st.cards[id]; }
    else { await editCard(id, (t ? cardText(t) : id) + '\n\n✓ Approved — sending now.'); c.closed = true; }
    save();
  }

  async function onButton(role, q) {
    const [kind, id, extra] = String(q.data || '').split(':');
    if (!st.owner || q.from?.id !== st.owner.id) return bots[role].answer(q.id);
    const t = id ? ctx.task(id) : null;
    if (['a', 'c', 'r'].includes(kind) && (!t || t.state !== 'waiting')) { await bots[role].answer(q.id, 'Already handled.'); if (t) await editCard(id, cardText(t) + `\n\n${t.state === 'done' ? (t.approved ? '✓ Approved' : '✓ Done') : '… ' + t.state}`); return; }
    const card = st.cards[id], pressed = q.message?.message_id;
    if (['a', 'c', 'r', 'x'].includes(kind) && (!card || (pressed && pressed !== card.msg))) return bots[role].answer(q.id, 'That card is old: the draft changed. Use the newest card, or say "waiting".');
    if (kind === 'a') { // APPROVE: above confirmAbove a second tap shows the money first
      const big = Object.entries(totals(t.actions)).filter(([, v]) => v > S.confirmAbove);
      if (big.length) { await bots[role].answer(q.id); return editCard(id, cardText(t) + `\n\nSend ${big.map(([c, v]) => `${v.toFixed(2)} ${c}`.trim()).join(' + ')}?`, [[{ text: `CONFIRM ${big.map(([c, v]) => `${v.toFixed(2)} ${c}`.trim()).join(' + ')}`, data: 'c:' + id }, { text: 'CANCEL', data: 'x:' + id }]]); }
      return doApprove(role, q, t);
    }
    if (kind === 'c') return doApprove(role, q, t);
    if (kind === 'x') { await bots[role].answer(q.id, 'Not sent.'); return t?.state === 'waiting' ? editCard(id, cardText(t), cardButtons(t)) : null; }
    if (kind === 'r') { pending[role] = { kind: 'note', id }; await bots[role].answer(q.id); return say(role, `What should change in "${t.title}"? Reply here and ${ctx.AGENTS.find(a => a.id === t.agent)?.name || 'the desk'} reworks it.`); }
    if (kind === 'd') { await bots[role].answer(q.id); return t ? bots[voice(role)].send(st.owner.id, `${t.title}\n\n${t.draft || t.result || t.text}${foot(t.usage, 'this task so far')}`, { name: `${t.id}.md` }) : null; }
    if (kind === 'g') return goalButton(role, q, id, extra);
    if (kind === 'i') return inboxButton(role, q, id);
    return bots[role].answer(q.id);
  }
  async function doApprove(role, q, t) {
    const r = await ctx.approve(t.id);
    await bots[role].answer(q.id, r.ok ? 'Approved.' : r.error);
    if (r.ok) await decided(t.id, 'approve'); else await editCard(t.id, cardText(t) + `\n\n${r.error}`);
  }

  /* ---------- what the office tells the team (serve calls notify when a task reaches WAITING or DONE) ---------- */
  async function notify(t) {
    if (!t) return;
    if (t.goal) { try { await goalProgress(t.goal); } catch (e) { ctx.log(`🎯 ${t.goal}: ${e.message}`); } } // STORE spec 0007 (AC-13): the chain moves first, paired or not, before any message
    if (!st.owner) return;
    if (t.state === 'waiting' && !st.cards[t.id]) { if (bots.secretary) await sendCard(t); else await say(t.dept, cardText(t)); }
    if (t.state !== 'done') return;
    if (st.cards[t.id]) {
      const out = Array.isArray(t.actions) && t.approved ? t.actions.map(a => '• ' + ctx.actions.outcomeLine(a)).join('\n') : '';
      await editCard(t.id, `${t.approved ? '✓' : '•'} ${t.title}${t.autoApproved ? ' — sent by rule ' + t.autoApproved.rules.map(r => r.title).join(', ') : t.approved ? ' — approved' : ''}${out ? '\n\n' + out : ''}${t.gateFailed ? '\n\nThe gate did not run for every call: check what went out.' : ''}${foot(t.usage, 'task total')}`);
      delete st.cards[t.id]; save();
    }
    if (!t.piece) {
      const head = `${t.error ? '⚠ Could not complete' : '✓'} ${t.title}${t.trigger ? ` (store event: ${t.when})` : t.routine ? ` (routine: ${t.when})` : ''}`;
      await say(t.dept, `${head}\n\n${t.result || ''}${foot(t.usage, 'task total')}`, { name: `${(t.title || 'result').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}.md` });
      await boardroom(t.dept, `${nameOf(t.dept)}: ${head}`);
    }
  }

  /* ---------- the secretary ---------- */
  const persona = (role, extra = '') => {
    const r = S.roles[role] || {}, biz = ctx.cfg.name;
    const who = role === 'secretary' ? `You are ${nameOf(role)}, the owner's personal secretary at ${biz}: their day, calendar, reminders, inbox and the office's admin.`
      : `You are ${nameOf(role)}, the CEO of ${biz}. Six department leads report to you (Emails, Sales, Marketing, Operations, Accounting, Delivery). You think about the whole business: priorities, numbers, what is stuck, what to do next.`;
    return `${who}${r.brief ? '\nSTANDING INSTRUCTIONS FROM THE OWNER\n' + r.brief : ''}\nYou are writing to the owner on Telegram: short, plain, no preamble, at most 150 words unless asked. ${extra}\n\n${ctx.toolsText()}`;
  };
  const READ_ONLY = 'This turn may only read: tools that send, book, post, pay or change anything are blocked. If the owner asks for such an action, do not try it; say exactly what you would do (to whom, what, when) and end with the line "Shall I go ahead?".';
  async function freeChat(role, text, extra = '') { // history holds the turns before this one (handle remembers after the reply)
    const notes = ctx.notes(text), convo = (history[role] || []).map(m => `${m.who === 'owner' ? 'Owner' : nameOf(role)}: ${m.text}`).join('\n');
    const { text: reply } = await ctx.run({ system: persona(role, READ_ONLY + (extra ? ' ' + extra : '')) + `\n\nCOMPANY NOTES\n${notes}`, user: `${convo ? convo + '\n' : ''}Owner: ${text}\n${nameOf(role)}:`, gated: true, model: S.roles[role]?.model });
    if (/Shall I go ahead\?\s*$/i.test(reply)) pending[role] = { kind: 'act', proposal: reply, role };
    return reply;
  }
  async function confirmed(role, p) { // the owner said yes to a read-back
    if (p.kind === 'rule') { let id = p.rule.id; ctx.approvals.edit(ctx.brainPath, doc => { let n = 2; while (doc.rules.some(r => r?.id === id)) id = `${p.rule.id}-${n++}`; doc.rules.push(ctx.approvals.clean({ ...p.rule, id })); }); ctx.log(`⚡ rule ${id} on (from Telegram)`); return `On. "${p.rule.title}" now sends what fits it without waiting for you.`; }
    if (p.kind === 'trigger') { ctx.triggers.edit(ctx.brainPath, doc => { doc.triggers.push(p.raw); }); ctx.log(`🛍 trigger ${p.raw.id} on (from Telegram)`); return `On. "${p.trigger.title}" starts with the next check of the store.`; }
    if (p.kind === 'routine') { const r = await ctx.makeRoutine({ dept: p.dept, text: p.text, when: p.when }); return r.error ? `Could not set it: ${r.error}` : `Done. ${r.routine.desc}, ${nameOf(p.dept)}'s team has it. Next run ${new Date(r.routine.nextAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}.`; }
    if (p.kind === 'act') { const who = p.role || role; const { text: out } = await ctx.run({ system: persona(who, 'The owner has said yes to the action below. Do exactly that, nothing more, then say in one line what you did.'), user: `The action the owner approved:\n${p.proposal}`, gated: false, model: S.roles[who]?.model }); return out; }
    return 'Done.';
  }
  async function secretary(text) {
    const p = pending.secretary;
    if (p && YES.test(text)) { delete pending.secretary; return confirmed('secretary', p); }
    if (p && NO.test(text)) { delete pending.secretary; return 'Dropped. Nothing was changed.'; }
    delete pending.secretary;
    const at = /^\s*@(\w+)\s+([\s\S]+)$/.exec(text); if (at) return forward(at[1], at[2]);
    if (/^\/?(brief|morning brief)\s*$/i.test(text)) return morningBrief(true);
    if (/^\/?(waiting|approvals)\s*\??$/i.test(text)) { const w = ctx.tasks().filter(t => t.state === 'waiting'); for (const t of w) { delete st.cards[t.id]; await sendCard(t); } return w.length ? `${w.length} waiting for your OK — the cards are above.` : 'Nothing is waiting for your OK.'; }
    if (/^\/?inbox\s*$/i.test(text)) return inbox();
    if (/^\/?(rules|auto approve rules)\s*\??$/i.test(text)) return ctx.approvals.listText(ctx.approvals.load(ctx.brainPath), ctx.approvals.loadLedger(ctx.dataDir));
    if (/^\/?triggers\s*\??$/i.test(text)) return ctx.triggers.listText(ctx.triggers.load(ctx.brainPath, ctx.AGENTS), ctx.triggerState());
    const pr = /^\s*(pause|resume|delete)\s+(?:the\s+)?(.+?)\s+(rule|trigger)\s*[.!]?\s*$/i.exec(text); if (pr) return pauseThing(pr[1].toLowerCase(), pr[2], pr[3].toLowerCase());
    const sw = /^\s*(pause|resume)\s+(?:all\s+)?auto[\s-]*approv/i.exec(text); if (sw) { ctx.approvals.edit(ctx.brainPath, d => { d.paused = /pause/i.test(sw[1]); }); return /pause/i.test(sw[1]) ? 'Paused. Every draft waits for you again.' : 'Resumed. Drafts that fit a rule go out on their own again.'; }
    if (/^\s*remind me\b/i.test(text)) return reminder(text);
    if (ctx.approvals.proposes(text)) { const r = await ctx.approvals.parseSentence(ctx.ask, text, { dept: null, currency: ctx.cfg.currency, existing: ctx.approvals.load(ctx.brainPath).rules }); if (r.error) return r.error; pending.secretary = { kind: 'rule', rule: r.rule }; return ctx.approvals.confirmText(r.rule); }
    if (/\b(trigger|when (a|an|the)\b.*\b(order|return|refund|cancel|stock))/i.test(text) && /\b(order|return|refund|cancel\w*|stock)\b/i.test(text)) return triggerFromChat(text);
    const w = ctx.parseWhen(text); if (w && !w.needsDay && !w.needsTime && w.text) return routineFromChat(w);
    return freeChat('secretary', text);
  }
  async function forward(who, text) {
    const k = DEPTS6.find(d => d === who.toLowerCase() || ctx.DEPTS[d].name.toLowerCase().startsWith(who.toLowerCase())) || (who.toLowerCase() === 'ceo' ? 'ceo' : null);
    if (!k) return `Who is @${who}? The leads are ${DEPTS6.map(d => '@' + d).join(', ')}, and @ceo.`;
    const reply = k === 'ceo' ? await ceo(text) : await leadBot(k, text);
    if (pending[k]) { pending.secretary = pending[k]; delete pending[k]; } // the owner's "yes" comes back here, not to the relayed bot
    return reply == null ? null : `${nameOf(k)}: ${reply}`;
  }
  function pauseThing(verb, words, kind) {
    if (kind === 'rule') { const d = ctx.approvals.load(ctx.brainPath), r = ctx.approvals.matchRule(d.rules, words); if (!r) return 'Which one? ' + ctx.approvals.listText(d, ctx.approvals.loadLedger(ctx.dataDir)); ctx.approvals.edit(ctx.brainPath, doc => { if (verb === 'delete') doc.rules = doc.rules.filter(x => x?.id !== r.id); else { const x = doc.rules.find(y => y?.id === r.id); if (x) x.paused = verb === 'pause'; } }); return `${verb === 'delete' ? 'Deleted' : verb === 'pause' ? 'Paused' : 'Resumed'} "${r.title}".`; }
    const d = ctx.triggers.load(ctx.brainPath, ctx.AGENTS), t = ctx.triggers.matchTrigger(d.triggers, words); if (!t) return 'Which one? ' + ctx.triggers.listText(d, ctx.triggerState());
    ctx.triggers.edit(ctx.brainPath, doc => { if (verb === 'delete') doc.triggers = doc.triggers.filter(x => x?.id !== t.id); else { const x = doc.triggers.find(y => y?.id === t.id); if (x) x.paused = verb === 'pause'; } });
    return `${verb === 'delete' ? 'Deleted' : verb === 'pause' ? 'Paused' : 'Resumed'} "${t.title}".`;
  }
  async function triggerFromChat(text) { // spec 0005: triggers from chat, read back, saved on yes (the same validation as the file)
    let j; try { j = parseJSON(await ctx.ask('Turn the owner\'s sentence into one store trigger. Return ONLY a JSON object.', `Sentence: "${text}"\nFields: event (one of ${Object.keys(ctx.triggers.EVENTS).join(', ')}), dept (one of ${DEPTS6.join(', ')}: the department that should act), title (short), text (what the desk should do with the events, as the owner would say it), dailyCount (1-100, default 10), below (stock_low only: fire at or below this stock), filter ({"minTotal": n} for orders at or above n), needsOk (default true).`, { maxTokens: 500, timeout: 120000, model: 'sonnet' })); }
    catch { return 'I could not turn that into a trigger. Try: "when a return is requested, Delivery drafts the reply and the refund".'; }
    const existing = ctx.triggers.load(ctx.brainPath, ctx.AGENTS).triggers; let id = String(j.title || j.event || 'trigger').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'trigger', n = 2; while (existing.some(t => t.id === id)) id = `${id}-${n++}`;
    const raw = { ...j, id }; const v = ctx.triggers.validate(raw, ctx.AGENTS, existing);
    if (v.problems.length) return `That trigger is not complete yet: ${v.problems.map(p => p.replace(/^[^:]+: /, '')).join('; ')}.`;
    pending.secretary = { kind: 'trigger', trigger: v.trigger, raw };
    const t = v.trigger; return `Here is the trigger I would add:\n• ${t.title} — ${ctx.triggers.describe(t)} → ${nameOf(t.dept)}'s ${ctx.AGENTS.find(a => a.id === t.agent)?.name || t.agent} · at most ${t.dailyCount} a day · ${t.needsOk ? 'waits for your OK' : 'read-only report'}\n"${t.text}"\n\nSay "yes" to turn it on; anything else drops it.`;
  }
  async function routineFromChat(w) {
    let dept = null; const at = /^\s*@?(\w+)[,:]?\s/.exec(w.text); if (at && DEPTS6.includes(at[1].toLowerCase())) dept = at[1].toLowerCase();
    if (!dept) { try { dept = parseJSON(await ctx.ask('Pick the one department that should do this recurring task. Return ONLY {"dept":"…"}.', `Departments: ${DEPTS6.map(d => `${d} (${ctx.DEPTS[d].name})`).join(', ')}\nTask: "${w.text}"`, { maxTokens: 50, timeout: 60000, model: 'sonnet' })).dept; } catch {} }
    if (!DEPTS6.includes(dept)) return 'Which department should do it? Say it again starting with @sales, @ops, @delivery …';
    pending.secretary = { kind: 'routine', dept, text: w.text, when: w.when };
    return `Here is the routine I would set:\n• ${ctx.describeWhen(w.when)} — ${nameOf(dept)}'s team: ${w.text}${w.guessed ? `\n("${w.guessWord}" taken as ${w.when.at})` : ''}\n\nSay "yes" to put it on the timetable.`;
  }
  async function reminder(text) {
    let j, spent = null; try { ({ value: j, usage: spent } = await measure(async () => parseJSON(await ctx.ask('Turn the owner\'s reminder into a time and a text. Return ONLY {"at":"<ISO 8601 with offset>","text":"<what to remind>"}.', `Now: ${new Date(now()).toString()}\nReminder: "${text}"`, { maxTokens: 120, timeout: 60000, model: 'sonnet' })))); } catch {}
    const at = Date.parse(j?.at || ''); if (!(at > now())) return 'When? Say it with a time that is still ahead: "remind me Friday at 10 to call the supplier".';
    st.reminders.push({ id: crypto.randomUUID().slice(0, 8), at, text: String(j.text || text).slice(0, 300), sent: false, ...(spent ? { usage: spent } : {}) }); save(); // usage: the ping says what setting it cost
    return `I'll remind you ${new Date(at).toLocaleString([], { weekday: 'long', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}: ${j.text}`;
  }
  async function morningBrief(asked = false) {
    const all = ctx.tasks(), since = now() - 18 * 3600e3, waiting = all.filter(t => t.state === 'waiting'), overnight = all.filter(t => t.state === 'done' && t.doneAt > since && !t.piece);
    const store = ctx.store(), lines = [`Good ${new Date(now()).getHours() < 12 ? 'morning' : 'day'}. ${new Date(now()).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}`, ''];
    lines.push(waiting.length ? `WAITING FOR YOU (${waiting.length})` : 'Nothing is waiting for your OK.'); for (const t of waiting.slice(0, 8)) lines.push(`• ${t.title} — ${ctx.AGENTS.find(a => a.id === t.agent)?.name || t.agent}${Array.isArray(t.actions) ? ' · ' + ctx.actions.summary(t.actions) : ''}`);
    const stuck = stuckLines(); if (stuck.length) lines.push('', ...stuck); // STORE spec 0007 (AC-12): a goal held by a failed step or a doubtful send
    if (overnight.length) { lines.push('', `DONE SINCE YESTERDAY (${overnight.length})`); for (const t of overnight.slice(0, 8)) lines.push(`• ${t.title}${t.autoApproved ? ' · sent by rule' : t.approved ? ' · sent after your OK' : t.trigger ? ' · store event' : t.routine ? ' · routine' : ''}${t.error ? ' · failed' : ''}`); }
    if (store?.line) lines.push('', `STORE: ${store.line}`);
    let today = ''; try { today = (await ctx.run({ system: persona('secretary', READ_ONLY), user: 'For the owner\'s morning brief: list today\'s calendar events (time — title), then at most five emails that need the owner today (from — subject — why). Plain lines, no preamble. Say "nothing" for an empty part.', gated: true })).text; } catch (e) { today = `(calendar and inbox not read: ${e.message})`; }
    if (today) lines.push('', 'TODAY', today);
    lines.push('', [waiting.length ? 'Say "waiting" to get the approval cards again.' : '', 'Say "inbox" to hand any of those emails to a department.'].filter(Boolean).join(' '));
    if (!asked) st.lastMorning = day(now()), save();
    return lines.join('\n');
  }
  async function inbox() {
    let items = [];
    try { const { text } = await ctx.run({ system: persona('secretary', READ_ONLY), user: `Read the owner's Gmail inbox (read only) and return ONLY a JSON object {"items":[{"from":"…","subject":"…","why":"one line: why it needs the owner","dept":"one of ${DEPTS6.join(', ')}","task":"what that department should do, one sentence"}]} with at most 6 items that need action today.`, gated: true }); items = (parseJSON(text).items || []).filter(x => DEPTS6.includes(x.dept)).slice(0, 6); }
    catch (e) { return `I could not read the inbox: ${e.message}`; }
    if (!items.length) return 'Nothing in the inbox needs you today.';
    st.inbox = items.map((x, i) => ({ ...x, n: i + 1, at: now() })); save();
    for (const x of st.inbox) await say('secretary', `${x.n}. ${x.from} — ${x.subject}\n${x.why}\n→ ${nameOf(x.dept)}: ${x.task}`, { buttons: [[{ text: `HAND TO ${nameOf(x.dept)}`.slice(0, 40), data: `i:${x.n}` }]] });
    return `${items.length} email${items.length > 1 ? 's' : ''} need you — above, each with a button to hand it to the right lead. A handed email becomes a draft that waits for your OK.`;
  }
  async function inboxButton(role, q, n) {
    const x = (st.inbox || []).find(y => String(y.n) === String(n)); if (!x) return bots[role].answer(q.id, 'That list is old — say "inbox" again.');
    // email content is untrusted: a handed email always becomes a DRAFT (read-only while drafting, waits for the OK)
    const t = await ctx.addTask({ dept: x.dept, text: `${x.task}\n(From the owner's inbox: ${x.from} — ${x.subject})`, needsOk: true, by: 'telegram' });
    x.handed = t.id; save(); await bots[role].answer(q.id, `Handed to ${nameOf(x.dept)}.`);
  }

  /* ---------- the leads ---------- */
  async function leadBot(dept, text) {
    const a = lead(dept);
    const task = /^\s*\/task(?:@\w+)?\s+([\s\S]+)$/i.exec(text);
    if (task) { const t = await ctx.addTask({ dept, text: task[1].trim(), by: 'telegram' }); return `Added — ${ctx.AGENTS.find(x => x.id === t.agent)?.name || t.agent} has it: ${t.title}.${t.needsOk ? ' It will wait for your OK before anything goes out.' : ''} The result comes back here.`; }
    const reply = await ctx.leadChat(a, text, history[dept] || []);
    return reply;
  }

  /* ---------- the CEO ---------- */
  async function ceo(text) {
    const p = pending.ceo;
    if (p && YES.test(text) && p.kind === 'act') { delete pending.ceo; return confirmed('ceo', p); }
    delete pending.ceo;
    const at = /^\s*@(\w+)\s+([\s\S]+)$/.exec(text); if (at) return forward(at[1], at[2]);
    const g = /^\s*\/?goal\b[:\s]*([\s\S]+)$/i.exec(text); if (g) return planGoal(g[1].trim());
    if (/^\/?(brief|weekly brief)\s*$/i.test(text)) return weeklyBrief(true);
    if (/^\/?goals\s*\??$/i.test(text)) { const gs = Object.values(st.goals).filter(x => x.state !== 'dropped').slice(-8); return gs.length ? gs.map(x => `• ${x.text} — ${x.state}${x.pieces ? ` (${x.pieces.filter(p => p.done).length}/${x.pieces.length} steps done)` : ''}`).join('\n') : 'No goals yet. Say "goal: …".'; }
    // plain text the CEO decides is a goal (AC-6) comes back as one "GOAL: …" line and is planned like "goal: …"
    const reply = await freeChat('ceo', text, 'If the owner\'s message sets a goal for the business that needs work from the departments (not a question, not a single small errand), answer with exactly one line and nothing else: "GOAL: <the goal, in the owner\'s words>".');
    const gl = /^\s*GOAL:\s*(.+?)\s*$/i.exec(reply || ''); if (gl && !/\n/.test(reply.trim())) { delete pending.ceo; return planGoal(gl[1]); }
    return reply;
  }
  async function planGoal(text, change = null, id = null) {
    let plan, planned = null;
    try { ({ value: plan, usage: planned } = await measure(async () => parseJSON(await ctx.ask(persona('ceo', 'Plan the owner\'s goal across the departments. Return ONLY a JSON object.'), `Goal: "${text}"${change ? `\nThe owner wants this changed: "${change}"` : ''}\nDepartments and their leads: ${DEPTS6.map(d => `${d} (${ctx.DEPTS[d].name}, lead ${lead(d)?.name})`).join('; ')}\n\nReturn {"pieces":[{"dept":"<key>","title":"<under 80 chars>","text":"<what that department should do, as one clear task>","after":[<numbers of earlier pieces in this list whose approved result this piece needs first>]}],"why":"<one sentence>"} with 1 to 6 pieces in the order the work happens, at most two per department, only departments that are really needed. "after" counts from 1; leave it [] for a piece that can start at once. A piece starts only when every piece in its "after" is approved and sent, and it gets their results.\n\nCOMPANY NOTES\n${ctx.notes(text)}`, { maxTokens: 1500, timeout: 150000, model: S.roles.ceo?.model || 'sonnet' })))); }
    catch { return 'I could not plan that. Say the goal again, more concretely.'; }
    const pieces = GS.planPieces(plan.pieces, DEPTS6); // STORE spec 0007 (AC-1, AC-2): at most two per department, `after` checked
    if (!pieces.length) return 'That goal does not need any department I can see. Say more about what should happen.';
    id = id || crypto.randomUUID().slice(0, 8);
    st.goals[id] = { id, text, pieces, why: String(plan.why || ''), state: 'planned', at: now(), told: {}, usage: addTokens(st.goals[id]?.usage, planned) }; save(); // usage: the planning, CHANGE re-plans included
    const g = st.goals[id];
    await say('ceo', `GOAL: ${text}\n${plan.why ? plan.why + '\n' : ''}\n${pieces.map((x, i) => `${i + 1}. ${nameOf(x.dept)} — ${x.title}${afterText(g, x)}`).join('\n')}\n\nEvery step is a draft that waits for your OK; a rule never sends one. A step with "after" starts when those steps are approved and sent, and builds on their results. To change the plan, press CHANGE and tell me what.${foot(planned, 'planning')}`, { buttons: [[{ text: 'START', data: `g:${id}:s` }, { text: 'CHANGE', data: `g:${id}:c` }, { text: 'DROP', data: `g:${id}:d` }]] });
    return null;
  }

  /* ---------- a goal, step by step (STORE spec 0007): state read from the tasks every pass, never stored ---------- */
  const mine = new Set(); // `${goal}:${key}` whose task this process is creating; any other `starting` was cut short by a restart
  let lastGoals = 0;
  const stepNo = (g, key) => g.pieces.findIndex(p => p.key === key) + 1;
  const pieceOf = (g, key) => g.pieces.find(p => p.key === key);
  const afterText = (g, p) => p.after.length ? ` (after ${p.after.map(k => stepNo(g, k)).join(', ')})` : '';
  async function goalButton(role, q, id, what) { // each button checks its own state; the stored change is saved before any await (AC-15)
    const g = st.goals[id], [w, key] = String(what || '').split('-'), no = () => bots[role].answer(q.id, 'That is no longer open.');
    if (!g) return no();
    if (['s', 'c', 'd'].includes(w)) {
      if (g.state !== 'planned') return no();
      if (w === 'd') { g.state = 'dropped'; save(); await bots[role].answer(q.id, 'Dropped.'); return; }
      if (w === 'c') { pending[role] = { kind: 'change', goal: g }; await bots[role].answer(q.id); return say('ceo', 'What should change in the plan?'); }
      g.state = 'running'; save(); await bots[role].answer(q.id, 'Started.');
      await boardroom('ceo', `New goal: ${g.text} — ${g.pieces.map(p => nameOf(p.dept)).join(', ')}`);
      return goalProgress(id); // starts the pieces with an empty `after` (AC-3), always drafts
    }
    if (w === 'x') { // STOP (AC-11): nothing new starts; drafts already waiting stay for the owner
      if (g.state !== 'running') return no();
      g.state = 'stopped'; save(); await bots[role].answer(q.id, 'Stopped.');
      const never = g.pieces.filter(p => !p.task && !p.tries.length).length; ctx.log(`🎯 ${id} stopped, ${never} step${never === 1 ? '' : 's'} never started`);
      return report(g, true);
    }
    const p = pieceOf(g, key); if (!p) return no();
    const s = GS.pieceState(p, p.task ? ctx.task(p.task) : undefined).state;
    if (w === 'r') { // RETRY (AC-8): only where nothing was ever sent
      if (g.state !== 'running' || s !== 'failed') return no();
      delete g.told[p.task || 'start:' + p.key]; if (p.task) p.tries.push(p.task); p.task = null; p.startError = null; save();
      await bots[role].answer(q.id, 'Trying that step again.');
      return goalProgress(id);
    }
    if (w === 'k') { // CONTINUE (AC-9): the owner counts this exact task as finished
      if (g.state !== 'running' || s !== 'doubtful') return no();
      p.continued = p.task; save(); await bots[role].answer(q.id, 'Counted as done. Moving on.');
      return goalProgress(id);
    }
    if (w === 'w') return bots[role].answer(q.id, s === 'doubtful' ? 'Kept waiting.' : 'That is no longer open.');
    return no();
  }
  async function startPiece(g, p) { // a draft with the piece's own text; earlier steps only as fenced data in goalContext (AC-5)
    const earlier = p.after.map(k => { const e = pieceOf(g, k); return { n: stepNo(g, k), piece: e, task: e.task ? ctx.task(e.task) : undefined }; });
    const goalContext = GS.stepText(p, earlier, { deptName: d => ctx.DEPTS[d]?.name || d, outcomeLine: ctx.actions.outcomeLine, fence: ctx.triggers.fence });
    const last = p.tries.length ? ctx.task(p.tries.at(-1)) : null;
    const text = p.text + (last?.lastFeedback ? `\n\nThe owner's last note on this step: ${last.lastFeedback}` : '');
    return ctx.addTask({ dept: p.dept, text, title: p.title, needsOk: true, goal: g.id, goalPiece: p.key, ...(goalContext ? { goalContext } : {}), by: 'ceo' });
  }
  async function goalProgress(id) { // the chain moves first; messages only after (AC-13)
    const g = st.goals[id]; if (!g || g.state !== 'running') return;
    const go = GS.advance(g, ctx.task).start;
    for (const k of go) { pieceOf(g, k).starting = now(); mine.add(`${id}:${k}`); } // marked and saved before the first await: a second pass cannot start them again
    if (go.length) save();
    const started = [];
    for (const k of go) {
      const p = pieceOf(g, k);
      try { p.task = (await startPiece(g, p)).id; started.push(p); ctx.log(`🎯 ${id} step ${k} → ${p.dept}${p.after.length ? ` (after ${p.after.join(', ')})` : ''}`); }
      catch (e) { p.startError = String(e?.message || e).slice(0, 200); }
      finally { p.starting = null; mine.delete(`${id}:${k}`); save(); }
    }
    if (g.state !== 'running') return; // STOP was pressed while a step was being created; its draft stays
    const a = GS.advance(g, ctx.task);
    for (const p of g.pieces) p.done = a.states[p.key].state === 'finished';
    const tell = st.owner ? [...a.failed, ...a.doubtful].map(k => pieceOf(g, k)).filter(p => !g.told[p.task || 'start:' + p.key]) : [];
    for (const p of tell) g.told[p.task || 'start:' + p.key] = a.states[p.key].state; // once per task
    if (a.finished) g.state = 'ready';
    save();
    if (started.length) {
      const wait = g.pieces.filter(p => a.states[p.key].state === 'waiting').length, from = p => p.after.length ? ` (from step${p.after.length > 1 ? 's' : ''} ${p.after.map(k => stepNo(g, k)).join(', ')})` : '';
      await say('ceo', `${started.map(p => `Step ${stepNo(g, p.key)} of ${g.pieces.length} started: ${nameOf(p.dept)} — ${p.title}${from(p)}`).join('\n')}\n\nEach step is a draft that waits for your OK with the secretary.${wait ? ` ${wait} more start${wait === 1 ? 's' : ''} when the steps before ${wait === 1 ? 'it are' : 'them are'} approved and sent.` : ''}`, { buttons: [[{ text: 'STOP', data: `g:${id}:x` }]] });
    }
    for (const p of tell) await tellStep(g, p, a.states[p.key]);
    if (a.finished) await report(g);
  }
  async function tellStep(g, p, s) {
    const n = stepNo(g, p.key), dept = ctx.DEPTS[p.dept]?.name || p.dept;
    if (s.state === 'failed') { ctx.log(`🎯 ${g.id} step ${p.key} failed: ${s.why}`); return say('ceo', `Step ${n} (${dept}) could not finish: ${s.why}`, { buttons: [[{ text: 'RETRY', data: `g:${g.id}:r-${p.key}` }]] }); }
    ctx.log(`🎯 ${g.id} step ${p.key} doubtful send, waiting for you`);
    const out = (ctx.task(p.task)?.actions || []).map(a => '• ' + ctx.actions.outcomeLine(a));
    return say('ceo', `Step ${n} (${dept}) may not have gone out as approved: ${s.why}.\n\nWhat went out:\n${out.join('\n') || '• nothing on record'}\n\nCONTINUE counts this step as done and starts the steps after it. WAIT keeps them waiting. Nothing is sent again either way.`, { buttons: [[{ text: 'CONTINUE', data: `g:${g.id}:k-${p.key}` }, { text: 'WAIT', data: `g:${g.id}:w-${p.key}` }]] });
  }
  async function report(g, stopped = false) { // GOAL IN once every piece is finished, or the report so far on STOP
    const label = (p, t) => { if (!t) return p.task ? 'the task is gone' : 'never started'; const s = GS.pieceState(p, t);
      return s.state === 'finished' ? 'done' : s.state === 'running' ? (t.state === 'waiting' ? 'draft waiting for the owner' : 'still working') : s.state === 'doubtful' ? `sent, not all confirmed: ${s.why}` : `failed: ${s.why}`; };
    const ts = g.pieces.map(p => p.task ? ctx.task(p.task) : undefined);
    const body = g.pieces.map((p, i) => `--- ${nameOf(p.dept)}: ${ts[i]?.title || p.title} (${label(p, ts[i])})${ts[i] ? '\n' + String(ts[i].draft || ts[i].result || '').slice(0, 1500) : ''}`).join('\n\n');
    let summary = '', wrote = null; try { ({ value: summary, usage: wrote } = await measure(() => ctx.ask(persona('ceo', `Report on the goal from the pieces below${stopped ? ' (the owner stopped it; some steps never started)' : ''}: what was done, what waits for the owner's OK, what is still open, and the one next step. Plain text.`), `Goal: ${g.text}\n\n${body}`, { maxTokens: 900, timeout: 150000, model: S.roles.ceo?.model || 'sonnet' }))); } catch (e) { summary = 'The pieces are in (I could not write the summary: ' + e.message + ').'; }
    const waits = ts.filter(t => t?.state === 'waiting').length, never = g.pieces.filter(p => !p.task && !p.tries.length);
    const every = g.pieces.flatMap(p => [...p.tries, p.task]).filter(Boolean).map(id => ctx.task(id)).filter(Boolean); // the current task and every RETRY
    g.usage = every.reduce((u, t) => addTokens(u, t.usage), addTokens(g.usage, wrote)); save(); // the goal's whole cost: planning, every piece so far, this report
    await say('ceo', `${stopped ? 'GOAL STOPPED' : 'GOAL IN'}: ${g.text}\n\n${summary}${never.length ? `\n\nNever started: ${never.map(p => `step ${stepNo(g, p.key)} (${nameOf(p.dept)} — ${p.title})`).join(', ')}.` : ''}${waits ? `\n\n${waits} draft${waits > 1 ? 's' : ''} wait${waits > 1 ? '' : 's'} for your OK with the secretary.` : ''}${foot(g.usage, 'goal total')}`);
    await boardroom('ceo', `${stopped ? 'Goal stopped' : 'Goal in'}: ${g.text}`);
  }
  async function goalsTick() { // once a minute, paired or not: heals a missed notify and a task creation a restart cut short (AC-13)
    for (const g of Object.values(st.goals).filter(x => x.state === 'running')) {
      for (const p of g.pieces) if (!p.task && p.starting && !mine.has(`${g.id}:${p.key}`)) {
        const t = ctx.tasks().filter(x => x.goal === g.id && x.goalPiece === p.key && !p.tries.includes(x.id)).at(-1);
        p.task = t ? t.id : null; p.starting = null; save(); ctx.log(`🎯 ${g.id} step ${p.key} ${t ? 'adopted ' + t.id : 'starts again'} after a restart`);
      }
      try { await goalProgress(g.id); } catch (e) { ctx.log(`🎯 ${g.id}: ${e.message}`); }
    }
  }
  const stuckLines = () => Object.values(st.goals).filter(g => g.state === 'running').flatMap(g => { const a = GS.advance(g, ctx.task); return [...a.failed, ...a.doubtful].map(k => `Goal "${g.text}" waits on step ${stepNo(g, k)}: ${a.states[k].why}`); }); // AC-12
  async function weeklyBrief(asked = false) {
    const week = ctx.tasks().filter(t => t.state === 'done' && t.doneAt > now() - 7 * 864e5 && !t.piece), per = {};
    for (const t of week) per[t.dept] = (per[t.dept] || 0) + 1;
    const facts = `Tasks done in the last 7 days: ${week.length} (${Object.entries(per).map(([d, n]) => `${ctx.DEPTS[d]?.name || d} ${n}`).join(', ') || 'none'}).\nWaiting for the owner: ${ctx.tasks().filter(t => t.state === 'waiting').length}.\nGoals: ${Object.values(st.goals).filter(g => g.state === 'running' || g.state === 'ready').map(g => `${g.text} (${g.state})`).join('; ') || 'none open'}.\nStore: ${ctx.store()?.line || 'not connected'}.\nRecent titles: ${week.slice(-15).map(t => t.title).join('; ')}`;
    let text = ''; try { text = (await ctx.run({ system: persona('ceo', READ_ONLY + ' Write the weekly brief: what moved, the numbers you can read, what is stuck, and three suggestions for this week.'), user: facts + `\n\nCOMPANY NOTES\n${ctx.notes('weekly business review')}`, gated: true, model: S.roles.ceo?.model })).text; } catch (e) { text = `I could not write the brief: ${e.message}`; }
    if (!asked) st.lastWeekly = day(now()), save();
    return `WEEKLY BRIEF\n\n${text}`;
  }

  /* ---------- messages in ---------- */
  async function handle(role, u) {
    if (u.callback_query) return onButton(role, u.callback_query);
    const m = u.message; if (!m?.text || !m.from) return;
    let text = m.text.trim(); const chat = m.chat;
    if (!st.owner) {
      const c = /^\/start\s+(\d{6})\s*$/.exec(text);
      if (c && chat.type === 'private' && code && c[1] === code && now() < codeUntil) { st.owner = { id: m.from.id, name: m.from.first_name || '' }; code = null; save(); ctx.log(`📱 Telegram paired with ${st.owner.name || 'the owner'} (${m.from.id})`); return bots[role].send(chat.id, `Paired. Hello ${st.owner.name || ''} — I'm ${nameOf(role)}. ${role === 'secretary' ? 'Approvals, your day and the office\'s admin come through me. Say "brief" any time.' : role === 'ceo' ? 'Give me a goal: "goal: …".' : 'Talk to me about the department, or give me work with /task …'}`); }
      if (c && now() >= codeUntil) newCode();
      else if (c && ++wrong >= 5) { ctx.log('📱 Telegram: 5 wrong pairing codes — that code is void'); newCode(); } // a code cannot be guessed by trying
      ctx.log(`📱 ${role}: a message from someone who is not paired was ignored`); return;
    }
    if (m.from.id !== st.owner.id) { ctx.log(`📱 ${role}: a message from someone else (${m.from.id}) was ignored`); return; }
    if (chat.type !== 'private') {
      if (!usernames[role]) { try { usernames[role] = (await bots[role].me()).username; } catch {} }
      const me = usernames[role], mine = me ? new RegExp(`@${me}\\b`, 'i') : null;
      if (/^\/boardroom(@\w+)?$/.test(text)) { // every bot in the group sees a bare /boardroom: all take it, one answers
        if (/@/.test(text) && mine && !mine.test(text)) return;
        st.group = chat.id; save(); if (!/@/.test(text) && role !== voice('secretary')) return;
        return bots[role].send(chat.id, 'This group is the boardroom now: the leads post short updates here. Mention any of us to talk.');
      }
      if (chat.id !== st.group) return;
      // in the boardroom a bot answers only when it is mentioned or replied to, and its own @name is not part of the message
      const toMe = mine ? mine.test(text) || m.reply_to_message?.from?.username === me : true;
      if (!toMe) return;
      if (mine) text = text.replace(new RegExp(`\\s*@${me}\\b`, 'ig'), ' ').trim(); if (!text) return;
    }
    if (/^\/unpair(@\w+)?$/.test(text)) { st.owner = null; st.group = null; save(); newCode(); return bots[role].send(chat.id, 'Unpaired. The office shows a new code to pair again.'); }
    const { value: reply, usage } = await measure(async () => { // every Claude run this message causes, counted under the answer
      try {
        const p = pending[role];
        if (p?.kind === 'note') { delete pending[role]; const r = await ctx.reject(p.id, text); if (r.ok) await decided(p.id, 'reject', text); return r.ok ? 'On it — the desk is reworking it with your note. It comes back here for your OK.' : r.error; } // REJECT's next message, whichever bot showed the card
        if (p?.kind === 'change') { delete pending[role]; return await planGoal(p.goal.text, text, p.goal.id); } // CHANGE's next message (the CEO's, or the secretary's when there is no CEO bot)
        return role === 'secretary' ? await secretary(text) : role === 'ceo' ? await ceo(text) : await leadBot(role, text);
      } catch (e) { return `Something went wrong: ${e.message}`; }
    });
    remember(role, 'owner', text);
    if (reply) { remember(role, role, reply); await bots[role].send(chat.id, reply + foot(usage), { name: `${role}.md` }); }
  }

  /* ---------- the clock (serve's 20 s tick) ---------- */
  async function tick(t = now()) {
    if (t - lastGoals >= 60000) { lastGoals = t; await goalsTick(); } // STORE spec 0007 (AC-13): before the pairing check
    if (!st.owner) { if (t >= codeUntil) newCode(); return; }
    for (const r of st.reminders.filter(r => !r.sent && r.at <= t)) { r.sent = true; save(); await say('secretary', `⏰ ${r.text}${t - r.at > 90000 ? ` (late — was due ${new Date(r.at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })})` : ''}${foot(r.usage, 'setting this reminder')}`); }
    st.reminders = st.reminders.filter(r => !r.sent || t - r.at < 7 * 864e5);
    if (st.lastMorning !== day(t) && hm(t) >= S.morning) { st.lastMorning = day(t); save(); const b = await measure(() => morningBrief()); await say('secretary', b.value + foot(b.usage)); }
    if (S.weekly.days.includes(new Date(t).getDay()) && st.lastWeekly !== day(t) && hm(t) >= S.weekly.at) { st.lastWeekly = day(t); save(); const b = await measure(() => weeklyBrief()); await say('ceo', b.value + foot(b.usage)); }
  }

  function start() {
    for (const [role, bot] of Object.entries(bots)) {
      if (!polling) continue;
      bot.me().then(me => { usernames[role] = me.username; }, () => {}); // its @name, to know when the boardroom means it
      poll(bot, { getOffset: () => st.offsets[role], setOffset: o => { st.offsets[role] = o; save(); }, onUpdate: u => handle(role, u), onProblem: (msg, fatal) => { if (msg && problems[role] !== msg) ctx.log(`📱 ${role}: ${msg}`); problems[role] = fatal ? msg : null; } });
    }
  }
  const status = () => ({ on: true, paired: !!st.owner, owner: st.owner?.name || null, code: st.owner ? null : (now() < codeUntil ? code : null), group: !!st.group, bots: ROLES.map(r => ({ role: r, name: nameOf(r), set: !!bots[r], problem: problems[r] || null })), reminders: st.reminders.filter(r => !r.sent).length, goals: Object.values(st.goals).filter(g => g.state === 'running').length });
  return { start, handle, notify, decided, tick, status, state: st, _code: () => code };
}
