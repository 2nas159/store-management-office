# 0008. A daily token and cost ledger per desk, routine and trigger

**Date**: 2026-10-31
**Status**: Proposed
**Builds on**: the token meter (`meter.mjs`, `src/tokens.js`, 25 Oct), the usage gauge (`usage.mjs`, V3.6), [0004](0004-shopify-event-triggers.md) (triggers), [0005](0005-telegram-team.md) (morning and weekly briefs)

## Summary

The office already counts tokens for each task and each chat answer, but the count lives only on the task, has no dollars, and is lost for chat, Telegram, briefs and goal planning. With this change every Claude run is also written into one small file per day, split by desk, routine, trigger, kind of work and model, and carries a dollar figure at API list price (clearly labelled as not your subscription bill). You see it in the usage gauge, on the Automations screen, in each desk's chat, and in the Telegram morning and weekly briefs. Nothing is ever stopped by it. It only shows the numbers.

## Context

The owner runs 35 desks, routines in every department, store triggers, a CEO that plans goals and eight Telegram bots. Each of these calls Claude. Today the only answer to "what is this costing me" is the plan gauge (session and week percent, from Claude's own endpoint) and a per task token line. Neither says which desk, routine or trigger is expensive, so a routine that burns a quarter of the week's plan on every run looks the same as one that costs nothing.

The token numbers already exist for every run. `askX` reads the CLI's final `result` event (with `usage`, `modelUsage` and `total_cost_usd`), or the SDK's `usage`, and calls `bumpUsage`, which feeds `meter.charge()`. `meter.measure(fn)` uses `AsyncLocalStorage` (Node's way of carrying context through async calls) so every run inside `fn` is added to that measure, however deep. Tasks keep the sum in `task.usage`. Chat replies return it but don't store it. Telegram messages print it under the answer. The page's "tokens today" adds up `task.usage` across loaded tasks, so anything that is not a task is missing, and a deleted task disappears from the day.

Dollars are the awkward part. Upstream wrote "No dollars anywhere" in `usage.mjs` because most owners run on a subscription, where per run dollars are not what they pay. The CLI still reports `total_cost_usd` (and `costUSD` per model inside `modelUsage`), which is the API list price of the run. It is the only figure that makes an Opus desk and a Sonnet desk comparable, because Opus tokens cost several times more. The SDK path (`ANTHROPIC_API_KEY` set) reports tokens and no cost.

Constraints from `AGENTS.md`: plain Node ES modules, JSON files in `data/` for run state, problems shown as plain sentences and never thrown, `npm run check` is the only test suite, prefer new modules and small edits to `serve.mjs` and `src/main.js`, `STORE` tags in comments. Runs use `--no-session-persistence`, so there are no Claude Code transcripts to read afterwards.

## Requirements

**User stories**:
- As the store owner, I want to see what each desk, routine and trigger cost today and this week, so that I can cut or change the expensive ones.
- As the store owner, I want one dollar figure that compares Opus and Sonnet work fairly, clearly marked as API price and not my bill.
- As the store owner, I want yesterday's usage in my morning brief and the week's trend in the CEO's weekly brief, without opening the page.

**Acceptance criteria**:
- **AC-1, every run is in the ledger once**: every Claude run that returns a result (CLI or SDK; draft, send, rework, routing, team plan, team piece, team final, chat, Telegram, brief, goal plan, goal report, reminder parsing, anything else) adds its tokens to `data/costs/YYYY-MM-DD.json` for the machine's local day on which the run ended. Its `total` grows by exactly that run's `input`, `cacheWrite`, `cacheRead`, `output`, `runs: 1` and `usd`.
- **AC-2, the four token fields stay apart**: input, cache write, cache read and output are stored and shown separately everywhere the ledger is shown. Where space allows one line, cache read is shown as "cached" and is never added into "in". The popover explains in one sentence that cached tokens are context read again, billed far lower, and not new work.
- **AC-3, splits add up**: each run lands in exactly one key in each split: `byAgent`, `byKind`, `byModel`, and in `byRoutine` / `byTrigger` only when it ran for a routine or trigger. For the four token fields and `runs`, the sum of `byAgent` equals `total` exactly, and so do the sums of `byKind` and `byModel`. A run whose model is not known goes under `byModel.unknown`. For `usd` the same sums hold within 0.000001. `byModel` usd may differ from `total` usd by fees the CLI does not split per model, such as web search. In that case `total` (the CLI's own figure) wins.
- **AC-4, attribution**: a run's `agent`, `dept`, `routine`, `trigger` and `kind` come from the tags of the measures around it. Inner tags win field by field, and an inner tag may set a field to `null` to clear it. A seat runs under its roster id. The CEO role is `@ceo`, the secretary `@secretary`, and routing before a desk is chosen is `@office`. Tasks run in their own lane, so they never inherit the tags of whatever queued them. `runServerTask` sets every field itself from the task: agent, dept, routine (or `null`), trigger (or `null`), and kind (`send` when approving, `rework` when there is feedback, `draft` for a task that waits for an OK, `task` otherwise). A team piece counts on the desk that ran it (`team-piece`, its own measure per piece). The lead's plan counts as `team-plan` and the lead's final as `team-final` (`rework` when the final is redone after feedback). Routing counts as `@office` / `routing`, with no routine or trigger, even when it routes a routine's task. A task started by a routine or a trigger carries that id on every run it makes.
- **AC-5, dollars from the CLI**: a CLI run's `usd` is the result's `total_cost_usd`. That covers everything the run used, including the small helper model Chrome uses. Its `byModel` entries take `costUSD` from each `modelUsage` entry. When the result has no `total_cost_usd`, the run is priced from the table (AC-6). The lookup uses the model ids in `modelUsage`, or the family `askX` was asked to run when `modelUsage` is missing, and the model is then filed under `byModel.unknown`.
- **AC-6, dollars for the SDK**: an SDK run is priced from a built-in table of list prices per model (`src/prices.js`, USD per million tokens for input, cache write, cache read and output), which `office.config.json` / `office.config.local.json` `prices` can override per model. A run whose model is in neither gets `usd: 0` and `unpriced: 1`, and everywhere it is shown the dollar figure says `+ N runs unpriced`.
- **AC-7, always labelled**: every place that shows a dollar figure from the ledger labels it "at API prices" (the popover and briefs add "not your subscription bill"). Amounts show as `$0.42`. Under one cent shows as `<$0.01`, and zero shows as `$0`.
- **AC-8, runs without a result**: a CLI run that ends without a result event adds `noResult: 1` to the day and to its agent's bucket, with no tokens, exactly once. A guard per run makes a timeout followed by `close`, a spawn `error`, a non-zero exit, and exit 0 with no result each count once. A run that timed out after its result event arrived records its real tokens, not `noResult`. On the SDK path, a refusal records the tokens it reports before it throws, and any other thrown error counts as `noResult`. The popover shows `N runs ended without a count` when N > 0. A run still going when the office stops is lost, and that is accepted.
- **AC-9, task and chat lines show dollars**: `task.usage` and the usage returned with a chat reply gain `usd` and `unpriced`. `tokensText` appends ` · $X at API prices` when at least one run was priced (`runs - unpriced > 0`), and ` (+ N unpriced)` when `unpriced > 0`. A usage with no `usd` field (tasks from before this change) shows no dollar part at all, never `$0`. The task card, chat file lines and Telegram footers show it with no other change.
- **AC-10, the usage gauge popover**: clicking the usage gauge in the top bar opens a panel with today, yesterday and the last 7 days (today and the 6 days before it). For each period it shows the totals (four token fields, runs, $), then the top 5 desks, the top 5 routines and triggers together, every kind, and every model, each with tokens and $. Routine and trigger titles and desk names come from the current roster and brain files. `@ceo`, `@secretary` and `@office` show as "CEO", "Secretary" and "Office (routing)". In the mixed routines and triggers list, each line carries a small `routine` or `trigger` label so equal ids never merge. An id no longer found shows as the id with "(removed)".
- **AC-11, Automations screen**: each routine and trigger row shows `yesterday $X · 7 days $Y` (tokens in the tooltip), or `no runs in 7 days`.
- **AC-12, the desk's own day**: the department focus chat rail header shows today's tokens and $ for the desk whose chat is open (the department lead when the rail opens). It reads `/api/costs?days=1` `byAgent[<id>]`, and refreshes on the page's existing task poll and after each chat reply. It shows runs with a result only, with `noResult` in the tooltip when greater than 0.
- **AC-13, morning brief**: the secretary's morning brief gets a block `CLAUDE YESTERDAY (at API prices, not your bill)` with yesterday's total (tokens, runs, $), the 3 desks with the most $, and the one routine or trigger with the most $. At most 5 lines. When yesterday had no runs, it shows one line: `No Claude runs yesterday.`
- **AC-14, weekly brief**: the CEO's weekly brief gets a block with the $ of the 7 full days before today against the 7 days before those (with the percent change), and the routine or trigger whose $ grew the most (its name with `routine` or `trigger`, and both figures). With no earlier week on file, it shows this week only.
- **AC-15, kept 90 days**: day files older than 90 days are deleted when the office starts, and inside `record()` the first time the local date changes. Nothing else in `data/costs/` is touched.
- **AC-16, a broken file never stops work**: a day file that cannot be parsed is renamed to `YYYY-MM-DD.json.bad-<ms>`, that day starts again from zero, and the startup log and `npm run check` say so in one sentence. Writes go to a temp file and are then renamed. A failed rename (Windows can refuse while a reader has the file open) is retried once, and the in memory day stays the truth for `/api/costs`. A write that still fails is logged once per day and never fails the run.
- **AC-17, no new limit**: the ledger never blocks, delays or pauses a run, a routine or a trigger.

## Options considered

### Option 1: Tag the meter, write a day ledger from `bumpUsage`

Give `meter.measure(fn, tag)` an optional tag (`agent`, `dept`, `routine`, `trigger`, `kind`). `bumpUsage` already runs once per finished run, so it hands the run's numbers plus the merged tags to a new `costs.mjs`, which adds them to today's in memory ledger and writes the day file. Dollars come from the CLI result, or from a price table for the SDK.

**Pros**:
- One hook that already sees every run, so nothing is missed and nothing is counted twice.
- Reuses the tested meter and the existing token shape. Upstream files change by a few lines.
- Survives deleted tasks, and counts chat, Telegram, briefs and goal planning, which are not tasks.

**Cons**:
- Every place that starts work must pass a tag, and a missing tag puts the run under `@office` / `other` instead of the right desk.
- A new `data/` folder and one more write per run.

### Option 2: Add up `data/tasks.json` when asked

Compute the splits on demand from the stored tasks, which already carry `usage`, `agent`, `routine` and `trigger`.

**Pros**:
- No new storage, no tags to thread through.

**Cons**:
- Misses everything that is not a task (chat, Telegram, briefs, goal plans, reminders), which is a large share on a busy day.
- A deleted or cleared task removes its cost from history, and a task that spans midnight counts on one day only.

### Option 3: Read Claude Code transcripts, the way ajan-ofisi does

Scan `~/.claude/projects/*/*.jsonl` and count usage per message id.

**Pros**:
- Would also count the owner's own Claude Code sessions.

**Cons**:
- The office runs with `--no-session-persistence`, so its runs leave no transcript. It would count nothing the office does.
- The SDK path writes no transcript either.

## Decision

**Chosen option**: Option 1: Tag the meter, write a day ledger from `bumpUsage`.

Every finished run is added once, with its tags, to a per day JSON ledger in `data/costs/`, priced from the CLI's own cost or a price table, and read by the gauge popover, the Automations screen, the desk chat and the Telegram briefs.

## Rationale

The forces are: every run must count once (the owner is deciding what to cut, so a missing chat or brief run hides real spend), the code must stay mergeable with upstream, and the office already has exactly one place that sees every finished run. `bumpUsage` and the `AsyncLocalStorage` meter are that place, and they already nest correctly (a Telegram message that starts a task counts both). Adding a tag to the existing measure calls costs a handful of one line edits. Option 2 is simpler but fails the first force, and Option 3 cannot see the office's runs at all.

You chose dollars at API price over upstream's "no dollars" rule. That is the right call for this owner: the splits exist to compare desks and routines, and tokens alone make an Opus routine look cheaper than it is. The risk upstream was avoiding (an owner reading $ as their bill) is handled by labelling every figure (AC-7). Keeping the CLI's own `total_cost_usd` as the main source means the office does not keep its own prices for the common path. The table is only for the SDK path, and an unknown model is shown as unpriced rather than guessed.

Their de-duplication by `message.id` is not needed here. That project reads transcripts line by line and can see the same message twice. The office receives one final result per run, so one run is one add.

## Feature design

**Data model sketch**:

**Bucket** (extends `src/tokens.js` `blank()`; used by the ledger, `task.usage` and chat usage):

| Field | Type | Notes |
|---|---|---|
| `input` | int | uncached input tokens |
| `cacheWrite` | int | tokens written to the prompt cache |
| `cacheRead` | int | tokens read from the cache (context read again) |
| `output` | int | output tokens |
| `runs` | int | runs with a result |
| `usd` | number | API list price, full precision, rounded only for display |
| `unpriced` | int | runs that had no price (AC-6) |
| `noResult` | int | runs without a result (AC-8). Ledger only (day `total` and `byAgent`), not in the shared `blank()` / `add()`, so `task.usage` keeps its shape |

**Day ledger**: `data/costs/YYYY-MM-DD.json` (local date), one per day, kept 90 days:

| Field | Type | Notes |
|---|---|---|
| `day` | string | `YYYY-MM-DD`, matches the file name |
| `total` | Bucket | |
| `byAgent` | { id: Bucket } | roster id, or `@ceo` / `@secretary` / `@office` |
| `byKind` | { kind: Bucket } | `draft` · `task` (no OK needed, e.g. a read only routine) · `send` · `rework` · `routing` · `team-plan` · `team-piece` · `team-final` · `chat` · `telegram` · `brief` · `goal-plan` · `goal-report` · `parse` (reminders, rule, trigger and schedule sentences) · `learn` (sorting a `revise:` note) · `onboard` (the set up interview) · `other` |
| `byModel` | { modelId: Bucket } | full model id from `modelUsage` / the SDK response, or `unknown` |
| `byRoutine` | { routineId: Bucket } | only runs tagged with a routine |
| `byTrigger` | { triggerId: Bucket } | only runs tagged with a trigger |

**Run tag** (in memory only): `{ agent?, dept?, routine?, trigger?, kind? }`, passed as `meter.measure(fn, tag)`. The merged tag is the outer tags overlaid by inner ones, field by field. An inner `null` clears the field, and `undefined` leaves the outer value. When no `kind` is set it becomes `other`, and when no `agent` is set, `@office`. The ledger keeps a count of `other` runs per day, which `npm run check` reports so an untagged call site is visible.

**Display names** for ids outside the roster: `@ceo` "CEO", `@secretary` "Secretary", `@office` "Office (routing)". They are fixed in `costs.mjs` and returned in `names.agents`.

**Price table** (`src/prices.js`, overridable by config `prices`): `{ "<model id or family>": { input, cacheWrite, cacheRead, output } }`, USD per million tokens. Lookup is the exact model id first, then the family (`opus`, `sonnet`, `fable`, `haiku`) found in the id. `cacheWrite` is the 5 minute cache write price. The SDK path does not ask for the 1 hour cache, so this is an accepted approximation.

**Formatting helpers** live in `src/tokens.js`, which the server, the page and `team.mjs` already share: `usdText(bucket)` gives `$0.42`, `<$0.01`, `$0`, or `''` when `usd` is missing, plus ` (+ N unpriced)`.

**API surface**:

| Endpoint | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `/api/costs` | GET | `days` int 1 to 90, default 7 | `{ days: [DayLedger, newest first], label: "at API prices, not your subscription bill", names: { agents: {id: name}, routines: {id: title}, triggers: {id: title} } }`. Days with no file are left out. | localhost only, as every `/api/*` route | never 500: a bad file is skipped and named in `problems: [string]` |

Telegram has no new command. The briefs read the ledger through `ctx.costs` (the `costs.mjs` reader) passed into `team.mjs`.

**Value sourcing**:

| Action | Value produced / displayed | Source |
|---|---|---|
| ledger add (CLI) | tokens | `modelUsage` summed, else `usage` (existing `fromRun`) |
| ledger add (CLI) | `usd` | `result.total_cost_usd`, captured in `askX`'s result handler (today it is dropped). Per model: `modelUsage[m].costUSD`. Missing → price table |
| ledger add (SDK) | tokens | SDK `res.usage` |
| ledger add (SDK) | `usd` | `src/prices.js` merged with config `prices` × tokens / 1e6. Unknown model → `unpriced` |
| ledger add | model id | `modelUsage` keys (CLI) or `res.model` (SDK), passed to `bumpUsage` as `{ cost, model }`. No `modelUsage` → `unknown`, priced by the requested family |
| ledger add | the hook | `bumpUsage(u, mu, { cost, model })` calls `costs.record` before its existing `if (!u) return`, because a CLI result may carry `modelUsage` without `usage` |
| ledger add | day | local date (`YYYY-MM-DD`) of `Date.now()` when the run ends |
| ledger add | agent / dept / routine / trigger / kind | merged run tag (AC-4): `runServerTask` sets all five from the task, with kind from `approve` / `feedback` / `needsOk`. Routing in `teamTask` and `/api/tasks` uses `@office` / `routing` with routine and trigger `null`. The chat endpoint uses its agent and `chat`. The team runner gives each piece its own measure (piece agent, `team-piece`), and the plan and final their own (lead, `team-plan` / `team-final`, `rework` on feedback). In `team.mjs`: a message is `telegram` under the bot's role (`@ceo`, `@secretary`) or the lead's id. A gated act or send run is `send`. Morning and weekly briefs are `brief` (`@secretary`, `@ceo`), including the calendar and inbox reads inside them. Goal plan and report are `goal-plan` / `goal-report` as `@ceo`. Reminder parsing is `parse`. In other modules: `approvals` and `triggers` sentence parsing and the routine schedule parse are `parse`, `learn.classify` is `learn`, and `onboard` is `onboard` (each under the desk or lead it serves, else `@office`) |
| popover / Automations / briefs | desk name, routine title, trigger title | current roster (`roster.mjs`), `routines.json`, `triggers.json`, fixed names for `@` ids. Missing → id + "(removed)" |
| popover | "today", "yesterday", "7 days" | local day files: today, today minus 1, today and the 6 days before |
| weekly brief | the two weeks | the 7 full days before today, and the 7 before those (14 files) |
| weekly brief | % change | (this 7 days − previous 7 days) / previous 7 days, whole percent. Previous = 0 → "new this week" |
| every $ shown | rounding | two decimals, `<$0.01` below one cent, `$0` at zero (AC-7) |

**Key invariants**:
- One finished run adds exactly once to the day `total`, and once to each split it belongs to.
- `sum(byAgent) == total`, `sum(byKind) == total` and `sum(byModel) == total` exactly for every token field and `runs`, and within 0.000001 for `usd` (`byModel` usd may fall short of `total` by fees not split per model).
- One run adds `noResult` at most once, and never alongside tokens.
- The ledger never throws into a run. Every read and write is wrapped, and problems are collected as sentences.
- The CLI's own cost is used whenever present. The table never overrides it.
- The process is single threaded and one process owns `data/`, so the in memory day plus an atomic write (temp file then rename, one retry) after each run is enough. No locking. `/api/costs` serves today from memory and caches the parsed older days, so a poll does not read 90 files.

**Security model**: read only figures about the office's own runs, kept in `data/` on this machine. `/api/costs` is behind the existing localhost Host/Origin handling. The briefs go only to the paired owner, as today. No token, prompt or message text is stored in the ledger: only counts, ids and model names. No new secrets.

**Configuration required**:
- `prices` (optional, `office.config.json` or `.local.json`): per model overrides of the price table. `npm run check` names a malformed entry (a non number or a negative number) and skips it.

**Critical test scenarios**:
- Happy path: a routine task with a draft and a send on a CLI run adds two runs under its agent, its routine, `draft` and `send`, with the result's cost, and `/api/costs` returns them. Verifies **AC-1**, **AC-4**, **AC-5**.
- Nesting and clearing: a routine's measure around a chat turn tagged with `routine: null` files the turn under no routine. A team task counts each piece on its own desk and the plan and final on the lead. A task queued from a Telegram message counts its draft under the desk only, never `telegram`. Each run is counted once, and the splits sum to the total. Verifies **AC-3**, **AC-4**.
- SDK: a fake SDK run on a known model is priced from the table, a config override changes it, and an unknown model counts as unpriced. Verifies **AC-6**.
- Failure: a run that times out before its result adds `noResult` once (not twice, though `fail` runs on timeout and again on `close`). A run that times out after its result records its tokens. A corrupt day file is renamed and the day restarts, with one problem sentence. Verifies **AC-8**, **AC-16**.
- Old tasks: a `task.usage` with no `usd` prints no dollar part. Verifies **AC-9**.
- Midnight and retention: a run ending after midnight lands in the new day, and a 91 day old file is deleted on start. Verifies **AC-1**, **AC-15**.
- Briefs: the morning brief block from a seeded yesterday file, the empty day line, and the weekly comparison with and without a previous week. Verifies **AC-13**, **AC-14**.
- Page: the popover opens from the gauge with the three periods and the label, the Automations rows show yesterday and 7 days, and the desk header updates. Verifies **AC-2**, **AC-7**, **AC-10**, **AC-11**, **AC-12**.

## Build plan

Tracer Bullet: one thin thread from a CLI run to the page first, then widen.

1. Thin thread: `src/tokens.js` adds `usd` and `unpriced` to the bucket and to `fromRun`, plus `usdText`. `askX` captures `total_cost_usd`, and both paths call `bumpUsage(u, mu, { cost, model })`. New `costs.mjs` (in memory day, atomic write with one retry to `data/costs/`, cached reader for N days) is called from `bumpUsage` before its early return. Then `/api/costs`, and the gauge popover showing today's total only, labelled. Satisfies **AC-1**, **AC-2**, **AC-5**, **AC-7**.
2. Tags: `meter.measure(fn, tag)` with the innermost-wins merge and `null` clearing, and `meter.tag()` to read the merged tag. `runServerTask` sets all five fields and works out the kind. Routing, chat and the `team.mjs` calls (Telegram, act and send, briefs, goal plan and report, reminder) get tagged, and so do `approvals`, `triggers`, routine parsing, `learn` and `onboard`. The team runner gets a measure per piece plus the plan and final. `byAgent`, `byKind`, `byModel`, `byRoutine`, `byTrigger` and the `other` count are filled. Satisfies **AC-3**, **AC-4**.
3. Runs without a result: a once per run guard in `askX` covering timeout, spawn error, non-zero exit and exit 0 with no result. A timeout after the result records the tokens. SDK refusal tokens are recorded and other SDK throws count as `noResult`. Satisfies **AC-8**.
4. SDK pricing: `src/prices.js` (values copied from the `claude-api` skill's current pricing reference at build time, never guessed), config `prices` merge, `check.mjs` validation of `prices`. Satisfies **AC-6**.
5. Task and chat lines: `tokensText` appends the $ part. Task card, chat and Telegram footers pick it up. Satisfies **AC-9**, **AC-7**.
6. The full popover: three periods, top desks, routines and triggers, kinds, models, the cached-tokens sentence, removed ids. Satisfies **AC-10**, **AC-2**.
7. Automations rows and the desk chat header. Satisfies **AC-11**, **AC-12**.
8. Telegram: the morning brief block and the weekly comparison via `ctx.costs`. Satisfies **AC-13**, **AC-14**.
9. Retention and broken files: prune on start and lazily in `record()` when the date changes. Rename an unparseable file, and log one line per failed write per day. `npm run check` lists ledger problems and today's count of `other` runs. Satisfies **AC-15**, **AC-16**, **AC-17**.
10. `check.mjs` steps for every scenario above (`costs: …`), including the sum invariants and the nesting case. Satisfies **AC-1** to **AC-17**.

## Consequences

**Positive**:
- The owner can see which desk, routine and trigger is expensive, in dollars that compare models fairly.
- Chat, Telegram, briefs and goal planning are counted for the first time, and history survives deleted tasks.
- The morning brief makes a runaway routine visible within a day.

**Negative / tradeoffs**:
- This breaks upstream's "no dollars" rule, so merges touching `usage.mjs` or `src/tokens.js` need care, and the label must stay on every figure.
- Every new place that starts Claude work must pass a tag, or its runs fall under `@office` / `other`. The guard is the daily `other` count that `npm run check` reports, which makes an untagged call site visible.
- A run still going when the office stops is never counted (the ledger writes when a run ends).
- The SDK price table goes stale when prices change. An outdated price misstates SDK runs until someone updates the table or the config.
- One more small file write per run.

**Neutral**:
- `usage.mjs` (the plan gauge and its five hour fallback) is unchanged. The popover opens from the same gauge element.
- No migration: old tasks without `usd` show tokens only, and the ledger starts empty on first run.

## Follow-up

- [ ] Fill `src/prices.js` from the `claude-api` skill's pricing reference during step 4, and note the date the prices were copied in the file's header comment.
- [ ] After a week of real data, decide whether a daily spend warning is worth adding (deliberately left out now, AC-17).
- [ ] Update the `usage.mjs` header comment ("No dollars anywhere") to point at this spec, so an upstream merge sees why the fork differs.
- [ ] Possible later: show the owner's own Claude Code sessions too (ajan-ofisi's session bridge idea). That is a separate decision with its own privacy questions.
