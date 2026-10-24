// Agents Office — the call gate (STORE, spec 0001). Claude Code runs this before every tool call of
// an approve run (a PreToolUse hook, wired by actions.mjs prepareGate through --settings).
//
//   node gate.mjs <gate dir>      hook input JSON on stdin: tool_name, tool_input, tool_use_id
//
// ToolSearch passes. An MCP tool passes when it can claim the slot of a listed action of that tool:
// budget.json lists the actions ({ id, tool, to, amount, strict }), and each claim creates one slot
// file named by the action id with the exclusive flag, so two parallel calls cannot both take the
// last one. STORE spec 0002: on an auto approved run (strict) a call takes an action's slot only when
// that action's amount and recipient are found in its input. Everything else is blocked (exit code 2,
// reason on stderr), and so is any error in here: the gate fails closed. Every decision is one line
// in decisions.jsonl, which the office reads after the run.
// STORE spec 0003: mode "read" (drafts and read-only routines) — a tool passes when src/toolclass.js classes it read
// (the owner's gate lists first, then the name; Chrome may look, not touch); web search and fetch pass; the rest is blocked.
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const line = d => fs.appendFileSync(path.join(dir, 'decisions.jsonl'), JSON.stringify({ at: Date.now(), ...d }) + '\n');
const block = (why, d) => {
  try { if (dir) line({ id: d?.id || null, tool: d?.tool || null, allow: false, why }); } catch {}
  process.stderr.write(`Blocked by the office: ${why}\n`);
  process.exit(2);
};
const slotName = id => String(id).replace(/[^A-Za-z0-9_-]/g, '_');
setTimeout(() => block('the gate did not get its input in time'), 5000).unref(); // a hook that hangs must not pass by timing out

try {
  if (!dir || !path.isAbsolute(dir)) block('no gate folder');
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => { raw += c; });
  process.stdin.on('error', e => block('could not read the hook input: ' + e.message));
  process.stdin.on('end', async () => {
    let d = null;
    try {
      const j = JSON.parse(raw);
      const tool = String(j.tool_name || ''), id = j.tool_use_id || null; d = { id, tool };
      const budget = JSON.parse(fs.readFileSync(path.join(dir, 'budget.json'), 'utf8')); // no budget, no call, in every mode
      if (tool === 'ToolSearch') { line({ id, tool, allow: true }); process.exit(0); }
      if (budget.mode === 'read') { // STORE spec 0003: a draft or read-only routine — reads pass, everything else is blocked
        if (tool === 'WebSearch' || tool === 'WebFetch') { line({ id, tool, allow: true }); process.exit(0); }
        if (!tool.startsWith('mcp__')) return block(`${tool || 'this tool'} is not open to a run that may only read`, d);
        const { classify } = await import('./src/toolclass.js'); // inside the try: if it cannot load, the call is blocked
        const c = classify(tool, budget.gate || {}, j.tool_input || null);
        if (c.cls === 'read') { line({ id, tool, allow: true, why: c.why }); process.exit(0); }
        return block(`${tool} is a write tool (${c.why}); this run may only read`, d);
      }
      if (!tool.startsWith('mcp__')) return block(`${tool || 'this tool'} is not one of the approved actions`, d);
      const { found } = await import('./src/actions.js'); // inside the try: if it cannot load, the call is blocked
      const mine = (budget.actions || []).filter(a => a.tool === tool);
      const misses = [];
      for (const a of mine) {
        if (a.strict) { const f = found(a, j.tool_input || {}); if (!f.ok) { misses.push(`${a.id}: ${f.flag}`); continue; } }
        try { fs.writeFileSync(path.join(dir, slotName(a.id)), String(id), { flag: 'wx' }); }
        catch (e) { if (e.code === 'EEXIST') continue; throw e; }
        line({ id, tool, allow: true, action: a.id });
        process.exit(0);
      }
      block(misses.length ? `blocked: ${misses[0]}` : mine.length ? `${tool} was approved for ${mine.length} call${mine.length > 1 ? 's' : ''} and they are used` : `${tool} is not one of the approved actions`, d);
    } catch (e) { block('the gate failed: ' + e.message, d); }
  });
} catch (e) { block('the gate failed: ' + e.message); }
