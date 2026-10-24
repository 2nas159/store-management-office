// Agents Office — the call gate (STORE, spec 0001). Claude Code runs this before every tool call of
// an approve run (a PreToolUse hook, wired by actions.mjs prepareGate through --settings).
//
//   node gate.mjs <gate dir>      hook input JSON on stdin: tool_name, tool_input, tool_use_id
//
// ToolSearch passes. An MCP tool passes when it can claim a free slot: budget.json says how many
// calls each listed tool gets, and each call creates one slot file with the exclusive flag, so two
// parallel calls cannot both take the last one. Everything else is blocked (exit code 2, reason on
// stderr), and so is any error in here: the gate fails closed. Every decision is one line in
// decisions.jsonl, which the office reads after the run.
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const block = (why, d) => {
  try { if (dir) fs.appendFileSync(path.join(dir, 'decisions.jsonl'), JSON.stringify({ id: d?.id || null, tool: d?.tool || null, allow: false, at: Date.now() }) + '\n'); } catch {}
  process.stderr.write(`Blocked by the office: ${why}\n`);
  process.exit(2);
};
const slotName = tool => tool.replace(/[^A-Za-z0-9_-]/g, '_');
setTimeout(() => block('the gate did not get its input in time'), 5000).unref(); // a hook that hangs must not pass by timing out

try {
  if (!dir || !path.isAbsolute(dir)) block('no gate folder');
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => { raw += c; });
  process.stdin.on('error', e => block('could not read the hook input: ' + e.message));
  process.stdin.on('end', () => {
    let d = null;
    try {
      const j = JSON.parse(raw);
      const tool = String(j.tool_name || ''), id = j.tool_use_id || null; d = { id, tool };
      if (tool === 'ToolSearch') { fs.appendFileSync(path.join(dir, 'decisions.jsonl'), JSON.stringify({ id, tool, allow: true, at: Date.now() }) + '\n'); process.exit(0); }
      if (!tool.startsWith('mcp__')) return block(`${tool || 'this tool'} is not one of the approved actions`, d);
      const budget = JSON.parse(fs.readFileSync(path.join(dir, 'budget.json'), 'utf8'));
      const n = Number(budget[tool]) || 0;
      for (let i = 1; i <= n; i++) {
        try { fs.writeFileSync(path.join(dir, `${slotName(tool)}.${i}`), String(id), { flag: 'wx' }); }
        catch (e) { if (e.code === 'EEXIST') continue; throw e; }
        fs.appendFileSync(path.join(dir, 'decisions.jsonl'), JSON.stringify({ id, tool, allow: true, at: Date.now() }) + '\n');
        process.exit(0);
      }
      block(n ? `${tool} was approved for ${n} call${n > 1 ? 's' : ''} and they are used` : `${tool} is not one of the approved actions`, d);
    } catch (e) { block('the gate failed: ' + e.message, d); }
  });
} catch (e) { block('the gate failed: ' + e.message); }
