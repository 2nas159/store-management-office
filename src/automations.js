// Agents Office (store fork) — AUTOMATIONS (A). STORE (26 Oct 2026, spec 0006: docs/specs/0006-automations-screen.md).
// One screen for everything the office does without being asked: ROUTINES (on its own clock), STORE TRIGGERS (an event in
// Shopify starts the work) and AUTO APPROVE RULES (small, safe actions go out without waiting). A list on the left, the
// editor on the right: make one, change it, pause it, run it now, delete it. Entries the files hold but the office skipped
// as broken are named at the top in plain words. Each form is checked as it is typed with the same sentences the server
// and `npm run check` print (src/rules.js, src/triggerdefs.js); the server checks again before it writes. A rule is read
// back before it turns on, and an edit that widens one says how, as the lead's chat does.
// Live: the routines, triggers and rules files in the brain, through /api. Demo: session only, like the rest of the page.
//
//   initAutomations(ctx) → { open(tab, id), close, toggle, isOpen, refresh }
//   ctx: routines (the live array) · triggers() · rules() · setRoutines · setTriggers · setApprovals · addRoutine (demo) · touched() (demo)
//        rtAct · trigAct · ruleAct · refresh() · agentOf · AGENTS · DEPTS · DEPT_KEYS · RT_DEPTS · MODEL_KEYS · modelName · EFFORT_KEYS · effortName
//        esc · isLive() · officeModel() · business() · currentDept()
import { describe, nextRun, untilText, valid } from './when.js';
import { KINDS } from './actions.js';
import { validate as validateRule, describeRule, widens, MONEY } from './rules.js';
import { EVENTS, validate as validateTrigger, describe as describeTrigger } from './triggerdefs.js';

const API = '/api';
const TABS = [['routines', 'ROUTINES'], ['triggers', 'STORE TRIGGERS'], ['rules', 'AUTO APPROVE']];
const NEW = { routines: 'NEW ROUTINE', triggers: 'NEW TRIGGER', rules: 'NEW RULE' };
const DOW = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];
const CADS = [['daily', 'Every day'], ['weekdays', 'Every weekday'], ['weekly', 'On these days'], ['hourly', 'Every few hours']];
const ORDER_EVENTS = ['order_created', 'order_cancelled', 'order_refunded', 'return_requested'];
const strip = p => String(p).replace(/^[^:]+: /, ''); // "small-refunds: needs dailyMax" → "needs dailyMax": the form already says which one
const lines = s => String(s || '').split(/[\n,]+/).map(x => x.trim()).filter(Boolean);
const numOrNull = v => String(v ?? '').trim() === '' ? null : Number(v);
const m2 = n => Number(n || 0).toFixed(2);

export function initAutomations(ctx) {
  const { routines, agentOf, AGENTS, DEPTS, DEPT_KEYS, RT_DEPTS, MODEL_KEYS, modelName, EFFORT_KEYS, effortName, esc, isLive } = ctx;
  const ov = document.getElementById('autoOv'); if (!ov) return null;
  const $ = s => ov.querySelector(s);
  const E = { tabs: $('#auTabs'), co: $('#auCo'), list: $('#auList'), ed: $('#auEd'), chips: $('#auChips'), search: $('#auSearch'), status: $('#auStatus'), add: $('#auNew') };
  let openNow = false, tab = 'routines', q = '', deptOn = new Set(DEPT_KEYS), sel = null, confirm = null, timer = null, busy = false, seq = 1;
  const meta = { routines: { problems: [], path: '' }, triggers: { problems: [], path: '' }, rules: { problems: [], path: '', currency: 'USD' } };
  const deskShape = () => AGENTS.map(a => ({ id: a.id, name: a.name, department: a.dept, lead: !!a.lead })); // the shape the shared checks read
  const leadOf = k => AGENTS.find(a => a.dept === k && a.lead) || AGENTS.find(a => a.dept === k);
  const nameOf = id => agentOf(id)?.name || id;
  const items = t => t === 'routines' ? routines : t === 'triggers' ? ctx.triggers().triggers : ctx.rules().rules;
  const find = (t, id) => items(t).find(x => x.id === id);

  /* ---------- keeping up: the lists come from tasks.js (polled); the problems, paths and currency from here ---------- */
  async function refresh() {
    if (!isLive()) return;
    try {
      const [r, t, a] = await Promise.all(['/routines', '/triggers', '/approvals'].map(p => fetch(API + p).then(x => x.json()).catch(() => null)));
      if (r && Array.isArray(r.routines)) { ctx.setRoutines(r.routines); meta.routines = { problems: r.problems || [], path: r.path || '' }; }
      if (t && Array.isArray(t.triggers)) { ctx.setTriggers(t); meta.triggers = { problems: t.problems || [], path: t.path || '' }; }
      if (a && Array.isArray(a.rules)) { ctx.setApprovals(a); meta.rules = { problems: a.problems || [], path: a.path || '', currency: a.currency || 'USD' }; }
    } catch {}
    if (openNow) renderList();
  }

  /* ---------- the list ---------- */
  const shown = x => deptOn.has(x.dept || (x.depts?.length === 1 ? x.depts[0] : '')) || (tab === 'rules' && !(x.depts?.length === 1));
  const matches = x => !q || [x.title, x.text, x.desc, x.id, nameOf(x.agent)].join(' ').toLowerCase().includes(q);
  function rowHTML(x) {
    const on = sel && sel.tab === tab && sel.id === x.id, chip = DEPTS[x.dept || x.depts?.[0]]?.chip || 'var(--ink)';
    let m = '', st = '', btn = '';
    if (tab === 'routines') {
      m = `${esc(x.desc || describe(x.when))} · ${esc(nameOf(x.agent))}${x.team ? ' · ⚑ team' : ''} · ${esc(modelName(x.model || ctx.officeModel()))}${x.needsOk ? ' · waits for your OK' : ' · read-only'}`;
      st = x.paused ? '<span class="au-paused">PAUSED</span>' : `next ${esc(untilText(x.nextAt))}`;
      btn = `<button data-q="run">RUN NOW</button><button data-q="${x.paused ? 'resume' : 'pause'}">${x.paused ? 'RESUME' : 'PAUSE'}</button>`;
    } else if (tab === 'triggers') {
      m = `${esc(x.desc || describeTrigger(x))} · ${esc(nameOf(x.agent))} · ${x.today || 0} of ${x.dailyCount} today${x.held ? ` · <span class="au-amber">${x.held} held</span>` : ''}${x.needsOk ? ' · waits for your OK' : ' · read-only'}${x.customerText ? ' · reads customer words' : ''}`;
      st = x.paused ? '<span class="au-paused">PAUSED</span>' : 'ON';
      btn = `${isLive() ? '<button data-q="run">RUN NOW</button>' : ''}<button data-q="${x.paused ? 'resume' : 'pause'}">${x.paused ? 'RESUME' : 'PAUSE'}</button>`;
    } else {
      m = `${esc(x.desc || describeRule(x))}${x.use ? ' · ' + esc(x.use) : ''}`;
      st = x.paused || ctx.rules().paused ? '<span class="au-paused">PAUSED</span>' : 'ON';
      btn = `<button data-q="${x.paused ? 'resume' : 'pause'}">${x.paused ? 'RESUME' : 'PAUSE'}</button>`;
    }
    return `<div class="au-row${on ? ' on' : ''}${x.paused ? ' paused' : ''}" data-id="${esc(x.id)}" style="--chip:${chip}">
      <div class="au-row-b"><div class="au-row-t">${tab === 'routines' ? '⏱ ' : tab === 'triggers' ? '🛍 ' : '⚡ '}${esc(x.title)}</div><div class="au-row-m">${m}</div></div>
      <div class="au-row-s"><span class="au-st">${st}</span><span class="au-q">${btn}</span></div></div>`;
  }
  function problemsHTML() {
    const p = meta[tab].problems; if (!p.length) return '';
    return `<div class="au-probs"><b>${p.length} not running.</b> ${p.length === 1 ? 'This entry is' : 'These entries are'} in <code>${esc(meta[tab].path)}</code> but the office skipped ${p.length === 1 ? 'it' : 'them'}. Fix the file, or delete the entry there.<ul>${p.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
  }
  const EMPTY = {
    routines: 'No routines yet. A routine is a task the office runs on its own clock: “every weekday at 8, triage the inbox”.',
    triggers: 'No store triggers yet. A trigger starts a task when something happens in your Shopify store: a return request, a new order, low stock.',
    rules: 'No auto approve rules yet. A rule lets small, safe actions go out without waiting for your tick: “refunds up to 30 USD, at most 200 a day”.',
  };
  function renderList() {
    E.tabs.querySelectorAll('button').forEach(b => { b.classList.toggle('on', b.dataset.t === tab); b.querySelector('b').textContent = items(b.dataset.t).length; });
    E.add.textContent = '+ ' + NEW[tab];
    const list = items(tab).filter(shown).filter(matches);
    E.list.innerHTML = problemsHTML() + (list.map(rowHTML).join('') || `<div class="au-empty">${items(tab).length ? 'Nothing matches the search or the departments picked.' : esc(EMPTY[tab])}</div>`);
    E.list.querySelectorAll('.au-row').forEach(n => n.addEventListener('click', () => select(tab, n.dataset.id)));
    E.list.querySelectorAll('[data-q]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); quick(b.closest('.au-row').dataset.id, b.dataset.q); }));
    renderStatus(); renderChips();
  }
  function renderChips() {
    E.chips.innerHTML = DEPT_KEYS.map(k => `<button class="cv-chip${deptOn.has(k) ? ' on' : ''}" data-dept="${k}"><i style="background:${DEPTS[k].chip}"></i>${DEPTS[k].short}</button>`).join('');
  }
  function renderStatus() {
    if (tab === 'triggers') {
      const s = ctx.triggers().shopify;
      E.status.innerHTML = !s?.on ? `<span class="au-amber">Store not connected</span> · triggers start once <code>shopify</code> is in office.config.local.json` : s.problem ? `<span class="au-amber">${esc(s.problem)}</span>` : `🛍 ${esc(s.shop)} · checked every ${s.poll} min · read-only`;
    } else if (tab === 'rules') {
      const p = ctx.rules().paused;
      E.status.innerHTML = `${p ? '<span class="au-amber">Every rule is paused</span>' : 'A draft goes out on its own only when every action fits a rule with room left today'} <button class="cv-btn" data-all="${p ? 'resume' : 'pause'}">${p ? 'RESUME ALL' : 'PAUSE ALL'}</button>`;
      E.status.querySelector('[data-all]').addEventListener('click', async () => { await ctx.ruleAct('*', p ? 'resume' : 'pause'); renderList(); });
    } else E.status.textContent = 'Times are this machine’s clock';
  }
  async function quick(id, act) {
    if (tab === 'routines') await ctx.rtAct(id, act); else if (tab === 'triggers') await ctx.trigAct(id, act); else await ctx.ruleAct(id, act);
    if (act === 'delete' && sel?.id === id) sel = null;
    await refresh(); renderList(); if (sel && !sel.isNew && sel.id === id) renderEditor(true);
  }

  /* ---------- the editor ---------- */
  function select(t, id) { tab = t; sel = { tab: t, id, isNew: false }; confirm = null; renderList(); renderEditor(); }
  function startNew() { sel = { tab, id: null, isNew: true }; confirm = null; renderList(); renderEditor(); }
  const opt = (v, label, cur) => `<option value="${esc(v)}"${String(v) === String(cur ?? '') ? ' selected' : ''}>${esc(label)}</option>`;
  const deskOpts = (k, cur, allowAuto, autoLabel) => (allowAuto ? opt('', autoLabel, cur) : '') + AGENTS.filter(a => a.dept === k).map(a => opt(a.id, `${a.name}${a.lead ? ' (lead)' : ''}`, cur)).join('');
  const field = (label, inner, vis = '', note = '') => { const tag = inner.includes('au-chips') ? 'div' : 'label'; return `<${tag} class="au-f"${vis ? ` data-vis="${vis}"` : ''}><span class="au-l">${label}</span>${inner}${note ? `<span class="au-n">${note}</span>` : ''}</${tag}>`; }; // a chip group is not a label: a click on its name would press the first chip
  const tick = (f, on, label, vis = '') => `<label class="au-c"${vis ? ` data-vis="${vis}"` : ''}><input type="checkbox" data-f="${f}"${on ? ' checked' : ''}> <span>${label}</span></label>`;
  const chips = (f, all, on, label = x => x) => `<div class="au-chips" data-f="${f}">${all.map(v => `<button type="button" class="cv-chip${on.includes(v) ? ' on' : ''}" data-v="${esc(v)}">${esc(label(v))}</button>`).join('')}</div>`;

  function routineForm(r) {
    const k = r ? r.dept : (RT_DEPTS.includes(ctx.currentDept()) ? ctx.currentDept() : RT_DEPTS[0]), w = r?.when || { kind: 'weekdays', at: '08:00' };
    const cad = w.kind === 'weekly' && w.days?.length === 7 ? 'daily' : w.kind;
    return field('What should happen', `<textarea class="cv-text" data-f="text" rows="3" placeholder="Triage the overnight inbox: what needs me today, what can wait">${esc(r?.text || '')}</textarea>`) +
      field('Name on the board', `<input class="au-in" data-f="title" maxlength="90" value="${esc(r?.title || '')}" placeholder="${r ? '' : 'Left empty, Claude names it'}">`) +
      `<div class="au-two">${field('Department', `<select class="au-in" data-f="dept">${RT_DEPTS.map(d => opt(d, DEPTS[d].name, k)).join('')}</select>`)}
        ${field('Desk', `<select class="au-in" data-f="agent">${deskOpts(k, r?.agent || '', !r, 'Claude picks the desk')}</select>`)}</div>` +
      `<div class="au-sec">SCHEDULE</div>` +
      `<div class="au-two">${field('How often', `<select class="au-in" data-f="cad">${CADS.map(([v, l]) => opt(v, l, cad)).join('')}${cad === 'minutes' ? opt('minutes', `Every ${w.every} min (filming)`, cad) : ''}</select>`)}
        ${field('At', `<input type="time" class="au-in" data-f="at" value="${esc(w.at || '08:00')}">`, 'timed')}</div>` +
      field('On', chips('days', DOW.map(d => String(d[0])), (w.days || [1]).map(String), v => DOW.find(d => String(d[0]) === v)[1]), 'weekly') +
      `<div class="au-three" data-vis="hourly">${field('Every', `<select class="au-in" data-f="every">${[1, 2, 3, 4, 6].map(n => opt(n, n === 1 ? 'hour' : n + ' hours', w.kind === 'hourly' ? w.every : 1)).join('')}</select>`)}
        ${field('From', `<input type="time" class="au-in" data-f="from" value="${esc(w.from || '09:00')}">`)}${field('To', `<input type="time" class="au-in" data-f="to" value="${esc(w.to || '17:00')}">`)}</div>` +
      tick('weekdaysOnly', w.kind !== 'hourly' || w.weekdaysOnly, 'Weekdays only', 'hourly') +
      field('Starts on', `<input type="date" class="au-in" data-f="start" value="${esc(w.start || '')}">`, '', 'Optional. Left empty, it starts now.') +
      `<div class="au-sec">HOW IT RUNS</div>` +
      tick('needsOk', r ? r.needsOk : true, 'Waits for my OK before anything is sent, paid or changed') +
      tick('team', !!r?.team, 'As a team: the department lead splits it across the desks') +
      `<div class="au-two">${field('Model', `<select class="au-in" data-f="model">${opt('', `Office default (${modelName(ctx.officeModel())})`, r?.model)}${MODEL_KEYS.map(m => opt(m, modelName(m), r?.model)).join('')}</select>`)}
        ${field('Effort', `<select class="au-in" data-f="effort">${opt('', 'Auto', r?.effort)}${EFFORT_KEYS.map(e => opt(e, effortName(e), r?.effort)).join('')}</select>`)}</div>`;
  }
  function triggerForm(t) {
    const k = t ? t.dept : (DEPT_KEYS.includes(ctx.currentDept()) ? ctx.currentDept() : 'delivery');
    return field('When this happens in the store', `<select class="au-in" data-f="event">${Object.entries(EVENTS).map(([v, l]) => opt(v, l.charAt(0).toUpperCase() + l.slice(1), t?.event || 'return_requested')).join('')}</select>`) +
      `<div class="au-two">${field('Stock at or below', `<input type="number" min="0" step="1" class="au-in" data-f="below" value="${esc(t?.below ?? 5)}">`, 'stock', 'Fires once per product until it is restocked.')}
        ${field('Orders of at least', `<input type="number" min="0" step="0.01" class="au-in" data-f="minTotal" value="${esc(t?.filter?.minTotal ?? '')}" placeholder="any total">`, 'orders')}</div>` +
      field('What the desk should do', `<textarea class="cv-text" data-f="text" rows="3" placeholder="Draft the reply and the refund for each return below.">${esc(t?.text || '')}</textarea>`, '', 'The events are listed under it for the desk, as structured fields from Shopify.') +
      field('Name on the board', `<input class="au-in" data-f="title" maxlength="90" value="${esc(t?.title || '')}" placeholder="Left empty, the first words of the task">`) +
      `<div class="au-two">${field('Department', `<select class="au-in" data-f="dept">${DEPT_KEYS.map(d => opt(d, DEPTS[d].name, k)).join('')}</select>`)}
        ${field('Desk', `<select class="au-in" data-f="agent">${deskOpts(k, t?.agent === leadOf(k)?.id ? '' : t?.agent || '', true, 'The department lead')}</select>`)}</div>` +
      field('At most this many tasks a day', `<input type="number" min="1" max="100" step="1" class="au-in" data-f="dailyCount" value="${esc(t?.dailyCount ?? 10)}">`, '', 'One check starts at most one task, listing every new event. Past the cap, events wait for tomorrow or RUN NOW.') +
      tick('needsOk', t ? t.needsOk : true, 'Waits for my OK before anything is sent, paid or changed') +
      tick('customerText', !!t?.customerText, 'Let the customer’s own words in (order notes, typed return reasons)') +
      `<div class="au-warn" data-vis="custText">Customer words are where a planted instruction would come from. They reach the desk fenced as data, never as instructions; leave this off unless the desk truly needs them.</div>`;
  }
  function ruleForm(r) {
    const scopes = [...routines.map(x => x.id), ...ctx.triggers().triggers.map(x => x.id)], on = r?.routines || [];
    return field('Name', `<input class="au-in" data-f="title" maxlength="80" value="${esc(r?.title || '')}" placeholder="Small refunds">`) +
      field('Which actions it covers', chips('kinds', KINDS, r?.kinds || [], k => k.replace(/_/g, ' '))) +
      `<div class="au-sec">LIMITS <span>every rule has a daily cap</span></div>` +
      `<div class="au-three" data-vis="money">${field('Most per action', `<input type="number" min="0" step="0.01" class="au-in" data-f="max" value="${esc(r?.max ?? '')}">`)}
        ${field('Currency', `<input class="au-in" data-f="currency" maxlength="3" value="${esc(r?.currency || meta.rules.currency)}">`)}
        ${field('Most per day', `<input type="number" min="0" step="0.01" class="au-in" data-f="dailyMax" value="${esc(r?.dailyMax ?? '')}">`)}</div>` +
      `<div class="au-two">${field('Most percent off', `<input type="number" min="0" max="100" step="1" class="au-in" data-f="maxPercent" value="${esc(r?.maxPercent ?? '')}">`, 'discount')}
        ${field('At most this many a day', `<input type="number" min="1" step="1" class="au-in" data-f="dailyCount" value="${esc(r?.dailyCount ?? '')}">`, 'count')}</div>` +
      `<div class="au-sec">ONLY WHEN <span>optional, and the safer for it</span></div>` +
      field('Departments', chips('depts', DEPT_KEYS, r?.depts || [], d => DEPTS[d].short)) +
      (scopes.length || on.length ? field('From these routines and triggers', chips('routines', [...new Set([...scopes, ...on])], on, v => { const t = (find('routines', v) || find('triggers', v))?.title || v; return t.length > 30 ? t.slice(0, 29) + '…' : t; })) : '') +
      field('Through these tools', `<textarea class="cv-text" data-f="tools" rows="2" placeholder="mcp__claude_ai_Gmail__send_message">${esc((r?.tools || []).join('\n'))}</textarea>`, '', 'Exact tool names, one per line. A rule cannot read what a message says, so name the tool and the routine.') +
      field('To these recipients', `<textarea class="cv-text" data-f="to" rows="2" placeholder="*@mystore.com">${esc((r?.to || []).join('\n'))}</textarea>`, '', 'One per line, * as a wildcard.');
  }
  function renderEditor(keepDraft) {
    if (!sel) {
      E.ed.innerHTML = `<div class="au-intro"><div class="au-intro-t">${tab === 'routines' ? 'Routines' : tab === 'triggers' ? 'Store triggers' : 'Auto approve rules'}</div><p>${esc(EMPTY[tab].replace(/^No [^.]+\. /, ''))}</p>
        <p>${tab === 'rules' ? 'Every action of a draft has to fit a rule with room left today, or the draft waits for you as before. A draft you sent back always waits.' : 'A run that would send, pay or change anything waits in WAITING ON APPROVAL for your tick, unless you switch that off or a rule covers it.'}</p>
        <button class="cv-go" data-new>+ ${NEW[tab]}</button><p class="au-keys">Click one on the left to change it · <b>N</b> new · <b>Esc</b> close</p></div>`;
      E.ed.querySelector('[data-new]').addEventListener('click', startNew); return;
    }
    const x = sel.isNew ? null : find(sel.tab, sel.id);
    if (!sel.isNew && !x) { sel = null; renderEditor(); return; }
    if (keepDraft && E.ed.querySelector('form')) { renderFoot(x); return; }
    const form = sel.tab === 'routines' ? routineForm(x) : sel.tab === 'triggers' ? triggerForm(x) : ruleForm(x);
    E.ed.innerHTML = `<div class="au-ed-h"><span>${sel.isNew ? NEW[sel.tab] : sel.tab === 'routines' ? 'ROUTINE' : sel.tab === 'triggers' ? 'STORE TRIGGER' : 'AUTO APPROVE RULE'}</span>${x ? `<code>${esc(x.id)}</code>` : ''}<span class="sp"></span><button class="cv-x" data-close title="close the editor">✕</button></div>
      <form class="au-form" autocomplete="off">${form}</form><div class="au-say"></div><div class="au-probs-f"></div><div class="au-foot"></div>`;
    const f = E.ed.querySelector('form');
    f.addEventListener('input', onEdit); f.addEventListener('change', onEdit); f.addEventListener('submit', e => { e.preventDefault(); save(); });
    f.querySelectorAll('.au-chips').forEach(g => g.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; b.classList.toggle('on'); onEdit(); }));
    f.querySelectorAll('input, textarea, select').forEach(n => n.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') n.blur(); else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); } }));
    E.ed.querySelector('[data-close]').addEventListener('click', () => { sel = null; confirm = null; renderList(); renderEditor(); });
    onEdit(); renderFoot(x);
  }
  function renderFoot(x) {
    const foot = E.ed.querySelector('.au-foot'); if (!foot) return;
    if (confirm) {
      foot.innerHTML = `<div class="au-confirm"><div class="au-confirm-t">${confirm.isNew ? 'Here is the rule I would turn on' : 'Here is the rule after your change'}</div><div class="au-confirm-r"><b>${esc(confirm.rule.title)}</b> — ${esc(confirm.desc)}</div>
        ${confirm.widens.length ? `<div class="au-warn">This lets more through than before: ${confirm.widens.map(esc).join('; ')}.</div>` : ''}
        <p>Anything that fits it goes out without waiting for you. Every action of a draft has to fit, and the daily cap stops it.</p>
        <div class="au-btns"><button class="cv-go" data-yes>${confirm.isNew ? 'TURN IT ON' : 'SAVE THE RULE'}</button><button class="cv-btn" data-back>BACK</button></div></div>`;
      foot.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); // the read back lands under the form
      foot.querySelector('[data-yes]').addEventListener('click', () => save(true)); foot.querySelector('[data-back]').addEventListener('click', () => { confirm = null; renderFoot(x); });
      return;
    }
    const canRun = sel.tab === 'routines' || (sel.tab === 'triggers' && isLive());
    foot.innerHTML = `<div class="au-btns"><button class="cv-go" data-save>${sel.isNew ? (sel.tab === 'rules' ? 'CHECK THE RULE' : 'ADD') : 'SAVE'}</button>${x ? `${canRun ? '<button class="cv-btn" data-a="run">RUN NOW</button>' : ''}<button class="cv-btn" data-a="${x.paused ? 'resume' : 'pause'}">${x.paused ? 'RESUME' : 'PAUSE'}</button><span class="sp"></span><button class="cv-btn warn" data-del>DELETE</button>` : ''}</div>
      ${x ? `<div class="au-n">${sel.tab === 'routines' ? (x.paused ? 'Paused.' : `Next run ${esc(untilText(x.nextAt))}.`) + (x.lastAt ? ` Last ran ${new Date(x.lastAt).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}${x.lastLate ? ' (late)' : ''}, ${x.runs || 0} run${x.runs === 1 ? '' : 's'} in all.` : ' It has not run yet.') : sel.tab === 'triggers' ? `${x.today || 0} of ${x.dailyCount} tasks today${x.held ? `, ${x.held} events held` : ''}.` : esc(x.use || '')}</div>` : ''}`;
    foot.querySelector('[data-save]').addEventListener('click', () => save());
    foot.querySelectorAll('[data-a]').forEach(b => b.addEventListener('click', () => quick(x.id, b.dataset.a)));
    const del = foot.querySelector('[data-del]');
    if (del) del.addEventListener('click', () => { if (del.dataset.sure) quick(x.id, 'delete'); else { del.dataset.sure = '1'; del.textContent = 'SURE? DELETE'; setTimeout(() => { if (del.isConnected) { delete del.dataset.sure; del.textContent = 'DELETE'; } }, 4000); } });
  }

  /* ---------- the form → a draft, checked as it is typed ---------- */
  function read() {
    const f = E.ed.querySelector('form'), v = n => f.querySelector(`[data-f="${n}"]`), val = n => v(n) ? v(n).value : undefined, on = n => !!v(n)?.checked;
    const picked = n => [...(v(n)?.querySelectorAll('button.on') || [])].map(b => b.dataset.v);
    if (sel.tab === 'routines') {
      const cad = val('cad'), at = val('at') || '08:00', start = val('start') || undefined; let when;
      if (cad === 'daily' || cad === 'weekdays') when = { kind: cad, at };
      else if (cad === 'weekly') when = { kind: 'weekly', days: picked('days').map(Number).sort(), at };
      else if (cad === 'hourly') when = { kind: 'hourly', every: Number(val('every')), from: val('from'), to: val('to'), weekdaysOnly: on('weekdaysOnly') };
      else when = { ...(find('routines', sel.id)?.when || { kind: 'minutes', every: 2 }) }; delete when.start;
      if (start) when.start = start;
      return { text: val('text').trim(), title: val('title').trim(), dept: val('dept'), agent: val('agent'), when, needsOk: on('needsOk'), team: on('team'), model: val('model'), effort: val('effort') };
    }
    if (sel.tab === 'triggers') {
      const event = val('event'), minTotal = numOrNull(val('minTotal'));
      return { event, title: val('title').trim(), text: val('text').trim(), dept: val('dept'), agent: val('agent') || undefined, dailyCount: numOrNull(val('dailyCount')) ?? undefined, needsOk: on('needsOk'), customerText: on('customerText'),
        ...(event === 'stock_low' ? { below: numOrNull(val('below')) } : minTotal !== null ? { filter: { minTotal } } : {}) };
    }
    const max = numOrNull(val('max')), dailyMax = numOrNull(val('dailyMax')); // the currency goes with a money limit only, so a reply rule does not carry one
    return { title: val('title').trim(), kinds: picked('kinds'), max, currency: max !== null || dailyMax !== null ? val('currency').trim().toUpperCase() || null : null, dailyMax, maxPercent: numOrNull(val('maxPercent')), dailyCount: numOrNull(val('dailyCount')),
      depts: picked('depts'), routines: picked('routines'), tools: lines(val('tools')), to: lines(val('to')) };
  }
  function check(d) { // → { problems, say } — the same sentences as the server
    const others = (t) => items(t).filter(x => x.id !== sel.id);
    if (sel.tab === 'routines') {
      const p = [];
      if (!d.text) p.push('Say what should happen.');
      if (!RT_DEPTS.includes(d.dept)) p.push(ctx.rtRefuse(d.dept));
      if (d.agent && agentOf(d.agent)?.dept !== d.dept) p.push(`${nameOf(d.agent)} is not in ${DEPTS[d.dept]?.name}.`);
      if (d.when.kind === 'weekly' && !d.when.days.length) p.push('Pick at least one day.');
      else if (!valid(d.when)) p.push(d.when.kind === 'hourly' ? 'The hours must run from an earlier time to a later one.' : 'The schedule is not complete: pick a time.');
      const desk = d.team ? leadOf(d.dept) : d.agent ? agentOf(d.agent) : null;
      return { problems: p, say: p.length ? '' : `${describe(d.when).replace(/^./, c => c.toUpperCase())} · next ${untilText(nextRun(d.when))} · ${desk ? desk.name + (d.team ? ' and the team' : '') : 'Claude picks the desk'}${d.needsOk ? ' · waits for your OK' : ' · read-only, no OK needed'}` };
    }
    if (sel.tab === 'triggers') {
      const v = validateTrigger({ ...d, id: sel.id || 'new' }, deskShape(), others('triggers'));
      return { problems: v.problems.map(strip), say: v.problems.length ? '' : `${describeTrigger(v.trigger).replace(/^./, c => c.toUpperCase())} → ${nameOf(v.trigger.agent)} · at most ${v.trigger.dailyCount} task${v.trigger.dailyCount === 1 ? '' : 's'} a day${v.trigger.needsOk ? ' · waits for your OK' : ' · read-only report'}` };
    }
    const v = validateRule({ ...d, id: sel.id || 'new', title: d.title || 'new' }, others('rules'));
    return { problems: v.problems.map(strip).filter(p => !/^no id or title$/.test(p)).concat(d.title ? [] : ['Give the rule a name.']), say: v.rule ? describeRule(v.rule) : '', rule: v.rule };
  }
  function onEdit(e) {
    const f = E.ed.querySelector('form'); if (!f) return;
    if (e?.target?.dataset?.f === 'dept') { // a new department: its desks
      const a = f.querySelector('[data-f="agent"]'), k = e.target.value;
      a.innerHTML = sel.tab === 'triggers' ? deskOpts(k, '', true, 'The department lead') : deskOpts(k, '', sel.isNew, 'Claude picks the desk');
    }
    const d = read(), c = check(d), cad = sel.tab === 'routines' ? d.when.kind : '';
    const vis = { timed: ['daily', 'weekdays', 'weekly'].includes(cad), weekly: cad === 'weekly', hourly: cad === 'hourly', stock: d.event === 'stock_low', orders: ORDER_EVENTS.includes(d.event), custText: !!d.customerText,
      money: (d.kinds || []).some(k => MONEY.includes(k)) || d.max !== null && d.max !== undefined || d.kinds?.includes('discount'), discount: !!d.kinds?.includes('discount'), count: (d.kinds || []).some(k => !MONEY.includes(k)) || d.dailyCount !== null && d.dailyCount !== undefined || !d.kinds?.length };
    f.querySelectorAll('[data-vis]').forEach(n => { n.hidden = !vis[n.dataset.vis]; });
    E.ed.querySelector('.au-say').innerHTML = c.say ? `<span>${sel.tab === 'rules' ? '⚡' : sel.tab === 'triggers' ? '🛍' : '⏱'}</span> ${esc(c.say)}` : '';
    E.ed.querySelector('.au-probs-f').innerHTML = c.problems.map(p => `<div>${esc(p.charAt(0).toUpperCase() + p.slice(1))}</div>`).join('');
    if (confirm && e) { confirm = null; renderFoot(sel.isNew ? null : find(sel.tab, sel.id)); } // the rule changed under the read back
    return { d, c };
  }

  /* ---------- saving ---------- */
  const say = (html, cls = '') => { const n = E.ed.querySelector('.au-probs-f'); if (n) n.innerHTML = `<div class="${cls}">${html}</div>`; };
  async function send(path, b) { const r = await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.statusText); return j; }
  async function save(sure) {
    if (busy) return;
    const { d, c } = onEdit(); if (c.problems.length) return;
    const live = isLive(), id = sel.id, t = sel.tab; busy = true;
    try {
      if (t === 'routines') {
        const b = { ...d, agent: d.agent || undefined, title: d.title || undefined, model: d.model || '', effort: d.effort || '' };
        if (live) {
          if (sel.isNew && (!b.agent || !b.title)) say('Claude is naming the desk and the title…', 'au-busy');
          const j = await send(sel.isNew ? '/routines' : `/routines/${encodeURIComponent(id)}`, sel.isNew ? { ...b, model: b.model || undefined, effort: b.effort || undefined } : b);
          await refresh(); sel = { tab: t, id: j.routine.id, isNew: false };
        } else sel = { tab: t, id: demoRoutine(id, b).id, isNew: false };
      } else if (t === 'triggers') {
        if (live) { const j = await send(sel.isNew ? '/triggers' : `/triggers/${encodeURIComponent(id)}`, d); ctx.setTriggers(j); await refresh(); sel = { tab: t, id: j.trigger.id, isNew: false }; }
        else sel = { tab: t, id: demoTrigger(id, d).id, isNew: false };
      } else {
        if (!sure) { // read it back first, with what an edit widens
          if (live) { const j = await send(sel.isNew ? '/approvals' : `/approvals/${encodeURIComponent(id)}`, { ...d, dry: true }); confirm = { rule: j.rule, desc: j.desc, widens: j.widens || [], isNew: sel.isNew }; }
          else { const was = id ? find('rules', id) : null; confirm = { rule: c.rule, desc: c.say, widens: was ? widens(was, { ...c.rule, paused: !!was.paused }) : [], isNew: sel.isNew }; }
          busy = false; renderFoot(sel.isNew ? null : find(t, id)); return;
        }
        if (live) { const j = await send(sel.isNew ? '/approvals' : `/approvals/${encodeURIComponent(id)}`, d); ctx.setApprovals(j); await refresh(); sel = { tab: t, id: j.rule.id, isNew: false }; }
        else sel = { tab: t, id: demoRule(id, d).id, isNew: false };
        confirm = null;
      }
      busy = false; renderList(); renderEditor(); say('Saved.', 'au-ok');
    } catch (e) { busy = false; confirm = null; renderFoot(sel.isNew ? null : find(t, id)); say(esc(e.message), 'au-amber'); }
  }
  // demo: the same moves, session only
  function demoRoutine(id, b) {
    let r = id && find('routines', id);
    if (!r) { const k = b.dept, a = b.team ? leadOf(k) : b.agent ? agentOf(b.agent) : leadOf(k); r = ctx.addRoutine(k, a.id, b.text, b.when, b.needsOk); }
    Object.assign(r, { text: b.text, title: b.title || r.title, dept: b.dept, agent: b.team ? leadOf(b.dept).id : b.agent || r.agent, when: b.when, desc: describe(b.when), needsOk: b.needsOk, team: b.team || undefined, model: b.model || undefined, effort: b.effort || undefined, nextAt: r.paused ? null : nextRun(b.when) });
    ctx.touched(); return r;
  }
  function demoTrigger(id, d) {
    const doc = ctx.triggers(), v = validateTrigger({ ...d, id: id || 'trigger-' + seq++, paused: !!find('triggers', id)?.paused }, deskShape(), doc.triggers.filter(x => x.id !== id)).trigger;
    const row = { ...v, desc: describeTrigger(v), today: find('triggers', id)?.today || 0, held: 0 };
    ctx.setTriggers({ ...doc, triggers: id ? doc.triggers.map(x => x.id === id ? row : x) : [...doc.triggers, row] }); return row;
  }
  function demoRule(id, d) {
    const doc = ctx.rules(), v = validateRule({ ...d, id: id || 'rule-' + seq++, paused: !!find('rules', id)?.paused }, doc.rules.filter(x => x.id !== id)).rule;
    const row = { ...v, desc: describeRule(v), use: [v.dailyMax !== null ? `${m2(0)} of ${m2(v.dailyMax)} ${v.currency} today` : '', v.dailyCount !== null ? `0 of ${v.dailyCount} today` : ''].filter(Boolean).join(' · ') };
    ctx.setApprovals({ ...doc, rules: id ? doc.rules.map(x => x.id === id ? row : x) : [...doc.rules, row] }); return row;
  }

  /* ---------- the band, the tools, opening ---------- */
  E.tabs.innerHTML = TABS.map(([t, l]) => `<button data-t="${t}">${l} <b>0</b></button>`).join('');
  E.tabs.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; tab = b.dataset.t; sel = null; confirm = null; renderList(); renderEditor(); });
  E.chips.addEventListener('click', e => { const b = e.target.closest('[data-dept]'); if (!b) return; const k = b.dataset.dept;
    if (deptOn.size === DEPT_KEYS.length) deptOn = new Set([k]); else if (deptOn.has(k) && deptOn.size === 1) deptOn = new Set(DEPT_KEYS); else deptOn.has(k) ? deptOn.delete(k) : deptOn.add(k); renderList(); }); // the first click shows one department, the last one back shows them all
  E.search.addEventListener('input', () => { q = E.search.value.trim().toLowerCase(); renderList(); });
  E.search.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') { E.search.value = ''; q = ''; E.search.blur(); renderList(); } });
  E.add.addEventListener('click', startNew);
  $('#auClose').addEventListener('click', () => close());
  ov.addEventListener('keydown', e => { if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return; if (e.key === 'n' || e.key === 'N') { e.preventDefault(); startNew(); } else if (e.key === '/') { e.preventDefault(); E.search.focus(); } });

  function open(t, id) {
    if (t && TABS.some(x => x[0] === t)) { tab = t; sel = id && find(t, id) ? { tab: t, id, isNew: false } : null; confirm = null; }
    if (!openNow) { openNow = true; E.co.textContent = ctx.business ? ctx.business() : ''; ov.classList.add('on'); document.body.classList.add('autoOpen'); ov.tabIndex = -1; ov.focus(); timer = setInterval(() => { refresh(); }, 6000); }
    renderList(); renderEditor(); refresh();
  }
  function close() { if (!openNow) return; openNow = false; confirm = null; ov.classList.remove('on'); document.body.classList.remove('autoOpen'); clearInterval(timer); timer = null; }
  return { open, close, toggle: () => openNow ? close() : open(), isOpen: () => openNow, refresh, editing: () => !!sel };
}
