// Agents Office — the read/write table (STORE, spec 0003). Every connector tool the office knows, with its class and why.
//   node toolclass.mjs            the table, grouped by connector (from data/connectors.json: what runs have reported)
//   node toolclass.mjs --write    only the tools a draft may not call
// Correct a class in office.config.json (or the local copy): "gate": { "read": [...], "write": [...] }, full names, * wildcard.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, glob } from './src/toolclass.js';
import { loadConfig, ROOT } from './config.mjs';

const toolId = name => String(name).replace(/[^A-Za-z0-9_-]+/g, '_');
/** [{ server, tools: [{ name, cls, why, unknown }] }] for the tools runs have reported */
export function table(dataDir, gate) {
  let doc = { servers: [] }; try { doc = JSON.parse(fs.readFileSync(path.join(dataDir, 'connectors.json'), 'utf8')); } catch {}
  return (doc.servers || []).map(s => ({ server: s.name, status: s.status, tools: (s.tools || []).map(t => { const name = `mcp__${toolId(s.name)}__${t}`; return { name, ...classify(name, gate) }; }) }));
}
export function counts(rows) { const c = { read: 0, write: 0, unknown: 0 }; for (const r of rows) for (const t of r.tools) t.unknown ? c.unknown++ : c[t.cls]++; return c; }
/** the owner's patterns that match no known tool (a typo, or a connector not seen yet) */
export function unused(rows, gate) { const names = rows.flatMap(r => r.tools.map(t => t.name)); return ['read', 'write'].flatMap(k => gate[k].filter(p => !names.some(n => glob(p, n))).map(p => `gate.${k}: ${p}`)); }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cfg = loadConfig(), rows = table(path.join(ROOT, 'data'), cfg.gate), onlyWrite = process.argv.includes('--write');
  if (!rows.length) console.log('No tools known yet: the office learns them from its runs. Start it and run one task, then try again.');
  for (const r of rows) {
    const list = r.tools.filter(t => !onlyWrite || t.cls === 'write'); if (!list.length) continue;
    console.log(`\n${r.server} (${r.status})`);
    for (const t of list) console.log(`  ${t.cls === 'read' ? 'read ' : 'WRITE'}  ${t.name.replace(/^mcp__.+?__/, '').padEnd(42)} ${t.why}`);
  }
  const c = counts(rows); console.log(`\n${c.read} read · ${c.write} write · ${c.unknown} unknown (counted as write)`);
  for (const u of unused(rows, cfg.gate)) console.log('⚠ matches no known tool — ' + u);
  for (const p of cfg.problems) console.log('⚠ ' + p);
}
