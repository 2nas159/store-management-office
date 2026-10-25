// Agents Office — the token meter (STORE, 25 Oct 2026). measure(fn) counts every Claude run made while fn runs, however deep
// (a task's routing, its team's desks, the draft, the approve run; a Telegram message's chat turn). Meters nest: a run inside a
// task that a Telegram message started counts for both. serve.mjs calls charge() from bumpUsage, once per run.
import { AsyncLocalStorage } from 'node:async_hooks';
import { add } from './src/tokens.js';

const als = new AsyncLocalStorage();

/** → { value, usage }: what fn returned, and the tokens of every run inside it ({ input, cacheWrite, cacheRead, output, runs }) */
export async function measure(fn) {
  const m = { usage: null }, chain = [...(als.getStore() || []), m];
  const value = await als.run(chain, fn);
  return { value, usage: add(m.usage, null) };
}

/** one run's numbers (src/tokens.js fromRun) → every open meter */
export function charge(u) { for (const m of als.getStore() || []) m.usage = add(m.usage, u); }
