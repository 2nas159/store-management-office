// Agents Office — tokens per piece of work (STORE, 25 Oct 2026). One shape for a run, a task, a Telegram message:
// { input, cacheWrite, cacheRead, output, runs }. Shared by the server (meter.mjs, team.mjs) and the page, so both say it the same way.

export const blank = () => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0, runs: 0 });

/** a Claude run's numbers → the shape. The CLI's result has modelUsage (every model the run used, Chrome's small helper too)
 *  and usage (the main model); the SDK has usage. modelUsage wins when it is there: it is the whole run. */
export function fromRun(usage, modelUsage) {
  const u = blank(); u.runs = 1;
  const mu = modelUsage && typeof modelUsage === 'object' ? Object.values(modelUsage) : [];
  if (mu.length) for (const m of mu) { u.input += m.inputTokens || 0; u.cacheWrite += m.cacheCreationInputTokens || 0; u.cacheRead += m.cacheReadInputTokens || 0; u.output += m.outputTokens || 0; }
  else if (usage) { u.input = usage.input_tokens || 0; u.cacheWrite = usage.cache_creation_input_tokens || 0; u.cacheRead = usage.cache_read_input_tokens || 0; u.output = usage.output_tokens || 0; }
  return u;
}

/** a + b, either may be missing → a new object */
export function add(a, b) {
  const s = blank();
  for (const x of [a, b]) if (x) for (const k of Object.keys(s)) s[k] += Number(x[k]) || 0;
  return s;
}

export const total = u => u ? (u.input || 0) + (u.cacheWrite || 0) + (u.cacheRead || 0) + (u.output || 0) : 0;
export const short = n => n < 1000 ? String(n) : n < 1e6 ? (n / 1000).toFixed(n < 1e4 ? 1 : 0) + 'k' : (n / 1e6).toFixed(1) + 'M';

/** "🔢 48k tokens · 3 runs (5.3k in · 41k cached · 1.9k out)" · "🔢 no Claude run, 0 tokens" */
export function tokensText(u, { label = '' } = {}) {
  const lead = `🔢 ${label ? label + ': ' : ''}`;
  if (!u || !u.runs) return `${lead}no Claude run, 0 tokens`;
  return `${lead}${short(total(u))} tokens · ${u.runs} run${u.runs === 1 ? '' : 's'} (${short((u.input || 0) + (u.cacheWrite || 0))} in · ${short(u.cacheRead || 0)} cached · ${short(u.output || 0)} out)`;
}
