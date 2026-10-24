# 0001. Outbound action list on drafts, held to by a call gate

**Date**: 2026-10-24
**Status**: Proposed

## Summary

Every draft that waits for your OK will carry a short list of the outbound actions it wants to take (what kind, to whom, how much, and which connector tool), shown on the approval card and the panel row. When you approve, the office lets the agent call only those tools, once per listed action, and blocks anything else at the Claude Code level (a hook, a small script the CLI runs before each tool call). Each action then shows done, failed, not done or unknown from the real tool calls, so a half finished send is never mistaken for one that did not happen. This is also the readable shape the auto approve rules (feature 4) will match against.

## Context

> ⚠️ Premise note: the guarantee here covers the approve run only. The draft run still holds every connector and is kept from sending by its prompt alone, because nothing in the office can tell a read tool from a write tool across connectors. That gap predates this feature and is listed in Follow-up; this spec does not widen it.

Drafts that wait in WAITING ON APPROVAL come from routines and date scheduled tasks with `needsOk` (`runServerTask` in `serve.mjs`). The draft run is told to change nothing and to "end with one line saying exactly what will go out". That line is free text, so neither the owner at a glance nor any future rule can tell a $12 refund from a $900 one, or a reply to one customer from a send to the whole list.

When the owner approves, the office starts a fresh Claude run with every allowed connector and the prompt "carry out the outbound step exactly as drafted". Nothing holds it to the draft: it can call any connected tool, any number of times, and the only record of what went out is the agent's own report in the `AFTER YOUR OK` section.

Feature 4 (auto approve rules, GA) will let small, safe actions go out without waiting. Rules can only read structured data, and money moves on them, so the shape decided here is the contract feature 4 builds on. Getting the shape or the enforcement wrong means either rules that cannot match reliably or an approval that promises more control than it delivers.

Constraints from the codebase: plain Node ESM, no new dependencies, every agent run is a headless `claude -p` from `askX`, Bash and file tools stay disallowed, owner state stays out of the repo, problems are plain sentences never throws, and edits to `serve.mjs` and `src/main.js` stay small because upstream merges into them.

## Requirements

**User stories**:
- As the store owner, I want every draft that waits for me to list exactly what it will send, pay or change, so that I can see the size of what I am approving without reading the whole draft.
- As the store owner, I want approving to run exactly those actions and no others, so that my OK means what the card says.
- As the store owner, I want each action's outcome to come from what really happened, so that I know what went out when something fails partway.
- As the builder of feature 4, I want a fixed, validated action shape, so that a rule can match kind, amount and recipient without guessing.

**Acceptance criteria**:
- **AC-1**: Every task that lands in `waiting` (routine or date scheduled, single desk or team) carries `actions` (an array, possibly empty) and `actionsRead` (`ok` or `unreadable`).
- **AC-2**: The draft run ends with a fenced ` ```actions ` block. The server takes the **last** such fence, parses its content as a strict JSON array, validates it, and stores it on the task. Only the fence itself is removed from the draft text shown on the card and filed in the brain; the prose before and after it stays.
- **AC-3**: There is no second model call to recover a list. A missing fence, content that is not a strict JSON array, or a list that fails AC-5 makes the list unreadable (AC-4).
- **AC-4**: An unreadable draft still waits with `actionsRead: "unreadable"` and a plain `actionsWhy`. The card shows the reason and a disabled APPROVE; `POST /api/tasks/:id/approve` returns 400 with a plain sentence; REJECT works as today.
- **AC-5**: A list is valid only if, after trimming every string: it has at most 10 actions; every action has a `kind` from the fixed list (an unknown kind is invalid, never mapped to `other`), a non empty `to`, a non empty `summary` of 140 characters or fewer, and a `tool` of the shape `mcp__<server>__<tool>` that is not the browser (`claude-in-chrome`); on the CLI backend the server must be connected and allowed now (`mcp.usable()`), and when that server's tool list is known the tool must be in it; `amount`, when present, is a number or a numeric string greater than 0 (stored as a number); `percent`, when present, is above 0 and at most 100; `refund` and `payment` have `amount`; `discount` has `amount` or `percent`; any `amount` has a `currency` of three letters after uppercasing (filled from config when the agent left it out); `content`, when present, is 4,000 characters or fewer (never cut). One bad action makes the whole list unreadable, and `actionsWhy` names the first problem ("action 2: refund has no amount").
- **AC-6**: The chat approval card shows one line per action (kind, to, amount with currency or percent, summary, tool), or "Nothing goes out" for an empty list, or the `actionsWhy` reason for an unreadable list. The WAITING row in the task panel shows the count and totals per currency ("3 actions · 912.00 USD"); percent discounts count toward the number but not the totals; an unreadable list shows "actions unreadable" in amber.
- **AC-7**: Approving a draft with an empty list moves it to `done` without starting a Claude run: `result` becomes the draft plus "AFTER YOUR OK: Nothing went out, this draft had no outbound actions.", `approved`, `approvedAt` and `doneAt` are set, the brain note is written and the graph rebuilt.
- **AC-8**: Approving a non empty list starts one run whose allowed tools are exactly the listed tool names, with a PreToolUse gate that allows each listed tool as many times as actions name it and blocks every other MCP call, every extra call, web and the browser. `ToolSearch` is allowed. The gate fails closed: any error inside it blocks the call. Each blocked call is recorded on the task and logged.
- **AC-9**: After the approve run, each action has an `outcome` built from the real tool calls in the run's stream, kept even when the run times out or errors: `done` (call returned without error), `failed` (call errored, with the error text), `unknown` (a call started but no result came back), or `not_done` (no allowed call for it). Calls are matched to actions by arguments first (amount and recipient found in the input), then by list order among the actions left with the same tool. An action whose `amount` or `to` is not found in its call's input gets a `flag`, shown in amber; the call is not blocked. Any MCP call in the stream that the gate has no record of marks the task `gateFailed`, shown in red on the card and logged. The task goes to `done` and nothing re-runs by itself.
- **AC-10**: The brain note for an approved draft has an `## Actions` section, placed before the `Read:` footer, with one line per action (`- a1 · refund · to #1001 · 12.50 USD · done`, then `· flag: …` when flagged), and the front matter gains the plain string line `actions: N · done X · failed Y · not done Z · unknown W`.
- **AC-11**: REJECT with a note produces a new draft whose list replaces the old one (same rules, AC-2 to AC-5). The rework prompt includes the previous list as JSON, and the old `actions`, `actionsRead`, `actionsWhy` and `gateDenied` are cleared before the new ones are written.
- **AC-12**: A task already waiting when this ships (`actions` missing) is treated as unreadable with the reason "drafted before action lists, send it back to redraft it".
- **AC-13**: When an action's connector is no longer connected or allowed at approve time, that action is `not_done` with the reason "connector not connected" in `outcome.error`. On the API key backend (no connectors) the connected check in AC-5 is skipped at draft time, so the owner still sees the list, and approve marks every action `not_done` with "the API key backend has no connectors". No run starts when no action is left to run.
- **AC-14**: In a team task, only the lead's final draft carries the block; the pieces are told not to write one.
- **AC-15**: When the office starts and finds an approve that was left in `doing` (the server stopped mid send), it moves the task to `done` with every action that has no outcome marked `unknown` ("the office stopped while sending, check before resending"), and deletes any leftover gate folder.

## Options considered

### Option 1: Fix in place with the prompt and an audit

Keep today's approve run with every connector, make the draft end with the structured block, pass the list into the approve prompt as "do exactly these", and after the run compare the tool calls in the stream against the list, flagging extras.

**Pros**:
- Smallest change: no hook, no change to how `askX` builds its arguments.
- Works the same on every connector and the browser.

**Cons**:
- An extra refund or send is only flagged after it went out. The promise "approving runs exactly those actions and no others" is a request to the model, not a guarantee.
- Feature 4 would auto approve money on the same unenforced path.

### Option 2: Structured list, exact tool allowlist, and a PreToolUse call gate

The draft names each action with its exact tool. The approve run gets `--allowedTools` set to exactly those tool names, plus a `--settings` hook (a tiny node script) that the CLI runs before every tool call; it claims one slot per listed action per tool and blocks anything without a free slot. Outcomes come from the stream.

**Pros**:
- The CLI enforces it: an unlisted tool or a second call to a listed tool is refused before it reaches the connector.
- Uses only what Claude Code already offers (`--allowedTools`, `--settings`, hooks); no new dependency, no MCP client of our own.
- The same gate later serves feature 4 unchanged.

**Cons**:
- Only tool name and count are enforced; the arguments are still the agent's (the recipient and amount check flags, it does not block).
- Browser actions cannot be gated by count, so they are not approvable for now.
- Depends on hook behavior in `-p` mode, which must be proved by a live check.

### Option 3: Allowlist only, then audit

Set `--allowedTools` to the listed tools, no hook, and audit extra calls after the run.

**Pros**:
- Simpler than Option 2: no hook script, no gate folder.
- Blocks every unlisted connector outright.

**Cons**:
- A second call to a listed tool (a second refund through the same refund tool) goes out and is only flagged afterwards, which is the exact case that matters for money.

### Option 4: Deterministic executor without a model

The draft carries each tool's full JSON input, and on approve the server calls the MCP tools itself, no Claude run at all.

**Pros**:
- Approve does exactly the stored calls, argument for argument.

**Cons**:
- The connectors live in the owner's Claude Code and claude.ai login (OAuth held there); the office has no MCP client and no credentials to call them directly. Building that is a large new component.
- The draft agent would have to write exact arguments for tools it has not called, and any small mismatch fails the action.

## Decision

**Chosen option**: Option 2: Structured list, exact tool allowlist, and a PreToolUse call gate.

Drafts end with a validated ` ```actions ` block (no fallback: a broken block locks APPROVE until REJECT redrafts it), the list is shown on the card and the panel row, and approve runs with exactly the listed tools behind a slot counting hook that fails closed, recording each action's outcome from the real calls.

Settled during the design (each a pick with the runner up):
- **No extraction fallback.** A Sonnet call reading the draft prose could invent a plausible action the draft never meant, and feature 4 could later auto approve it unseen. Runner up: keep the fallback and forbid auto approval of extracted lists; more code for a case one REJECT already covers.
- **Old waiting drafts** are unreadable and must be sent back (AC-12). Runner up: redraft them automatically at startup; not worth a code path for a handful of tasks on upgrade day.
- **The approve run uses a short system prompt** (`actions.approveSystem`): who the agent is, the approved actions, the draft content, the rule to make one call per action and nothing else. No company notes, no skills, and team approvals use the same path instead of `runTeamLead`. Runner up: today's full `agentSystem`; longer, and it invites the agent to do more than the list.
- **Team pieces** do not write a block; only the lead's final does (AC-14). Runner up: merge the pieces' blocks; the lead rewrites the final anyway, so its list is the one that matches what was approved.
- **The block is stripped** from the draft text on the card and in the note; the card renders the list itself. Runner up: keep it inline; raw JSON in the draft is noise for the owner.
- **Gate slots are files** created with the exclusive flag (`wx`), one per allowed call, so parallel tool calls cannot both take the last slot. Runner up: a lock file around a JSON counter; more code, same result.
- **The gate lets `ToolSearch` through**, so a run with deferred MCP tool schemas can still load the listed tools. Every other non MCP tool is already disallowed by `askX`.
- **Matching calls to actions** is by arguments first, then order: for each allowed call, the action with the same tool whose amount and recipient are both found in the input wins; otherwise the first unmatched action with that tool. Two refunds of different amounts through one tool are then attributed correctly. Runner up: order only; it puts a failure on the wrong refund.
- **The recipient and amount check** walks every value in the call input. The amount is found when any number or numeric string equals it within 0.005, or equals it in minor units (`Math.round(amount * 100)`). The recipient is found when it is a case insensitive substring of any string value. Flag texts: "amount 12.50 not found in the call", "recipient not found in the call". Missing means a flag, never a block.
- **The gate fails closed and is audited.** `gate.mjs` wraps everything in a try and exits with code 2 on any error. It appends one JSON line per decision, keyed by the hook input's `tool_use_id`, to `decisions.jsonl`; after the run, an MCP `tool_use` with no decision line means the hook never ran, and the task gets `gateFailed: true`. Runner up: trust the exit code alone; a hook that never starts is silent.
- **Timeout and restart keep the evidence.** `askX` keeps the calls it has seen and hands them back on a timeout or a non zero exit (on the error object as `calls`), so outcomes are computed either way; a call with no result is `unknown`, never `not_done`. A restart mid approve is closed out at startup (AC-15). Runner up: mark everything failed; that hides a refund that went out.
- **Connector gone at approve** makes that action `not_done` before the run and leaves it out of the gate (AC-13). Runner up: refuse the whole approval; one dropped connector should not hold back the rest.
- **The API key backend** (`ANTHROPIC_API_KEY` set) has no connectors, so draft validation skips the connected check (the `mcp__` shape is still required) and approve marks every action `not_done` with that reason and starts no run.
- **Rework sees the old list.** The rework prompt carries the previous list as JSON next to the previous draft, because the draft text no longer contains the block. Runner up: leave it out; the agent then rewrites the list from scratch and may drift.
- **Connector freshness at validation** needs no extra step: validation runs after the draft run, whose `system init` event has already refreshed `mcp` (`fromInit`).

## Rationale

The force that decides this is the promise in the Done when line: approving runs exactly the listed actions and no others, and feature 4 will let money move on the same path without the owner looking. Only Options 2 and 4 make that true in the machinery rather than in a prompt. Option 4 needs credentials the office does not hold, because the connectors are the owner's Claude Code and claude.ai connections; rebuilding them would be a second product. Option 2 reaches the same guarantee for the part that matters most (which tool, how many times) with flags Claude Code already has, in one small module and one tiny script.

Option 3 looks close, but it misses the dangerous case: the duplicate call through an allowed tool. A refund tool that is allowed once is allowed twenty times without the count. The hook is the cheapest way to close it.

The draft block costs nothing extra in the normal case. A formatting slip locks APPROVE rather than letting a second model guess the list from prose, which keeps the guarantee free of exceptions and keeps every list one the drafting agent wrote itself; that matters more than the occasional rework click. A gate that fails open would be worse than no gate, because it would look like protection, so the hook fails closed and its own absence is detected from the stream. All or nothing approval and no automatic retry keep this slice small and make a double send impossible; per action ticks and retrying the remainder can be added on the same schema later.

## Feature design

**Data model sketch** (no new store: fields on the task record in `data/tasks.json`):

| Entity | Field | Type | Required | Notes |
|---|---|---|---|---|
| Task (existing) | `actions` | Action[] | on every task that reaches `waiting` | `[]` means nothing goes out; missing means drafted before this feature |
| Task | `actionsRead` | `"ok"` \| `"unreadable"` | with `actions` | unreadable locks APPROVE |
| Task | `actionsWhy` | string | when unreadable | plain sentence naming the first problem |
| Task | `gateDenied` | `{ tool, at }[]` | after approve, when any | calls the gate blocked |
| Task | `gateFailed` | boolean | after approve, when true | an MCP call ran with no gate decision on record |
| Action (embedded, 1 task : N actions, order kept, N ≤ 10) | `id` | `"a1"`…`"aN"` | yes | by position |
| Action | `kind` | enum | yes | `email`, `reply`, `post`, `refund`, `discount`, `payment`, `order_update`, `product_update`, `inventory`, `message`, `other` |
| Action | `tool` | string | yes | full `mcp__<server>__<tool>` |
| Action | `to` | string | yes | email, customer, order number, channel |
| Action | `amount` | number \| null | refund, payment | money moved |
| Action | `percent` | number \| null | discount needs amount or percent | 0 to 100 |
| Action | `currency` | ISO 4217 code \| null | when `amount` set | from the agent, else `cfg.currency` |
| Action | `summary` | string ≤ 140 | yes | the card line |
| Action | `content` | string ≤ 4,000 | no | the text going out |
| Action | `outcome` | `{ status, at, error?, flag? }` | after approve | `status`: `done` \| `failed` \| `unknown` \| `not_done` |

Gate folder (run state in `data/`, deleted after the run and at startup): `data/gates/<taskId>/`
- `settings.json`: `{"hooks":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"\"<process.execPath>\" \"<abs path of gate.mjs>\" \"<abs gate dir>\""}]}]}}`, passed to the CLI as `--settings <abs path>` (a file, so the inner quoting never passes through a second shell argument).
- `budget.json`: `{ "<tool>": <count> }`, written before the run starts and only read by the gate.
- Slot files: `<tool with every character outside [A-Za-z0-9_-] replaced by _>.<n>` for n = 1 to the budget, each created with the exclusive flag (`wx`). A call that fails keeps its slot, so a retry is blocked.
- `decisions.jsonl`: one JSON line per decision, `{ "id": <tool_use_id>, "tool": <name>, "allow": true|false, "at": <ms> }`. `gateDenied` is built from the lines with `allow: false`.

**State transitions** (unchanged states, new guards):

`next` → `doing` (draft run) → `waiting` with a list → on APPROVE: guard `actionsRead === "ok"` → empty list: `done` (no run) · non empty: `doing` (gated run) → `done` with outcomes. On REJECT: `waiting` → `doing` (rework) → `waiting` with a new list. A run error or timeout still lands in `done` with `error: true` as today, with outcomes computed from the calls seen so far. At startup, an approve left in `doing` → `done` (AC-15).

**API surface** (no new endpoints):

| Endpoint | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `/api/tasks` | GET | none | tasks now include `actions`, `actionsRead`, `actionsWhy`, `gateDenied`, `gateFailed` | local, single owner | none new |
| `/api/tasks/:id/approve` | POST | none | `{ ok, id, state: "doing" }` or `{ ok, id, state: "done" }` for an empty list | local | 400 "this task is not waiting for your OK" (today) · 400 "the actions in this draft could not be read: <why>. Send it back with REJECT." |
| `/api/tasks/:id/reject` | POST | `feedback` | unchanged | local | unchanged |

Internal surface:
- `actions.mjs` (new, server only): `KINDS`; `draftLine(role)` (role `single`, `piece`, `lead`; `piece` gets today's draft line with no block); `parse(text)` → `{ list, body } | { why }`; `validate(list, { servers, currency, sdk })` → `{ actions } | { why }`; `reworkLine(prevActions)`; `approveSystem(agent, actions, draft)` and `approveUser(actions)`; `prepareGate(dir, actions)` → the settings path; `readGate(dir)` → `{ decisions }`; `outcomes(actions, calls, decisions)` → `{ actions, gateDenied, gateFailed }`; `summary(actions)` → "3 actions · 912.00 USD"; `noteSection(actions)` and `noteLine(actions)`; `cardLines(actions)`.
- `draftLine('single' | 'lead')` contains: the schema (each field, its type and when it is required), the kind list, one worked example block with two actions, the rule that the block is the last thing in the reply, that an empty list is written as `[]`, that `tool` is the exact name from the agent's own tool list (use `ToolSearch` to find one not yet seen), and that the draft must resolve every id, address and amount now because the approve step cannot look anything up.
- `gate.mjs` (new, the hook): reads the hook's stdin JSON (`tool_name`, `tool_input`, `tool_use_id`) and the gate dir from `argv[2]`; allows `ToolSearch`; for an `mcp__` tool, reads `budget.json` and tries to create slot files 1 to the budget with `wx`, allowing on the first success; everything else, and any error at all, is a block: append the decision line, write a one line reason to stderr, exit with code 2. No imports beyond `node:fs` and `node:path`.
- `askX` in `serve.mjs` gains two options and one output: `only` (exact tool names; replaces the allow list, adds `WebFetch,WebSearch` to the disallowed list, keeps every existing disallowed tool, forces `--no-chrome`), `settings` (a file path, passed as `--settings`), and `calls` (`{ id, name, input, ok, error }`, `ok` null when no result came back). `feed` reads `tool_use` blocks from `assistant` events and `tool_result` blocks (`tool_use_id`, `is_error`, text) from `user` events. On a timeout or a non zero exit, the rejected error carries `calls`.
- `run()` in `serve.mjs` passes `only` and `settings` through to `askX` and returns `calls`. On `mode === 'approve'`, both single desk and team tasks take one short path (`approveSystem` / `approveUser`, the task's agent or lead); `runTeamLead` is no longer used for approve. `modeLineFor` takes the role so team pieces get `draftLine('piece')`.
- Startup in `serve.mjs`: tasks in `doing` with `approve` in flight (marked by `task.approving = true`, set before the gated run) are closed out per AC-15, and `data/gates/` is emptied.

**Value sourcing**:

| Action | Value produced / displayed | Source |
|---|---|---|
| Draft run | the list | the last ` ```actions ` fence in the run's text, strict JSON array (`actions.parse`) |
| Validate | allowed servers and their tool names | `mcp.usable()` after the draft run (server ids, and `s.tools` when known); skipped on the API key backend |
| Validate | `currency` when missing | `cfg.currency` from `office.config.json` / `office.config.local.json`; three letters after uppercasing, otherwise `"USD"` and a line in the config problems |
| Card line | kind, to, amount, percent, currency, summary, tool | the stored Action fields (`actions.cardLines`), passed as the card's `mock` HTML by `askApproval` |
| Card lock | locked or not, reason | `actionsRead`, `actionsWhy`, copied to the page by `copyResult` |
| Panel row | count and totals per currency | derived: count of `actions`, sum of `amount` grouped by `currency` (percent discounts counted, not summed), two decimals; "actions unreadable" when `actionsRead` is unreadable |
| Rework prompt | previous list | the task's `actions` before they are cleared (`actions.reworkLine`) |
| Approve | allowed tools and budget | listed actions whose server is still in `mcp.usable()`; count per tool name |
| Approve | whether to run at all | non empty runnable list and the CLI backend (`sdk` unset) |
| Empty approve | result text | the draft plus the fixed AC-7 sentence |
| Outcome | status, error | `calls` from `askX`: `tool_use` id and name paired with the `tool_result` of the same id (`is_error`, text); no result → `unknown` |
| Outcome | which action a call belongs to | arguments first (amount and recipient found in the input), then list order among that tool's unmatched actions |
| Outcome | flag | the amount and recipient search over the call input's values (rule in Decision) |
| Blocked calls | tool, time | `decisions.jsonl` lines with `allow: false` |
| Gate failure | `gateFailed` | an MCP `tool_use` id in `calls` with no line in `decisions.jsonl` |
| Restart close out | `unknown` outcomes | tasks in `doing` with `approving: true` at startup |
| Brain note | Actions section and front matter line | the stored outcomes (`actions.noteSection`, `actions.noteLine`) |

**Key invariants**:
- The gate, not `--allowedTools`, is what bounds an approve run: the owner's own Claude Code settings may allow more tools, and the hook still blocks every MCP call without a free slot. `--allowedTools` is set to the listed tools as a second, narrower layer.
- An approve run never gets more allowed calls of a tool than actions naming it, and any error inside the gate is a block.
- A task with `actionsRead !== "ok"` never starts an approve run.
- A call with no result is never reported as `not_done`.
- An empty list never starts a Claude run on approve.
- Nothing re-runs an approve by itself; a second approve is refused because the task is no longer `waiting`.
- The browser is never an approvable tool.
- `askX` still disallows Bash, file tools and subagents and runs in the empty temp folder.

**Security model**: one local owner, no new endpoints, no new credentials. The gate narrows what an approved run can do; it never widens it. The gate folder lives in `data/` (run state, gitignored) and holds tool names and counts only, never call inputs. Money actions carry amounts in `data/tasks.json` and the brain note, which already hold the draft text with the same figures.

**Configuration required**:
- `currency` in `office.config.json` (or the local copy): ISO code used when an action has an amount and no currency. Default `"USD"`. No env vars.

**Critical test scenarios**:
- Happy path: a draft with a valid block of two actions waits, the card shows two lines and the row "2 actions · 42.00 USD"; approve runs with only those two tools; both end `done`; the note has the Actions section. Verifies **AC-1**, **AC-2**, **AC-6**, **AC-8**, **AC-9**, **AC-10**.
- Gate: fed hook inputs for a budget of one refund call, the first call is allowed, the second and an unlisted tool are blocked with exit code 2, `ToolSearch` is allowed, and a missing `budget.json` blocks (fails closed). Verifies **AC-8**.
- Broken block: the block has a refund without an amount; the row shows "actions unreadable", APPROVE is disabled, POST approve returns 400 with the reason. A draft with no fence at all behaves the same. Verifies **AC-3**, **AC-4**, **AC-5**.
- Empty list: approve goes straight to `done` with the AC-7 sentence and no `claude` process starts. Verifies **AC-7**.
- Partial failure: a call list where the first call succeeds, the second errors and a third has no result gives `done`, `failed` and `unknown`; an action with no call is `not_done`; two refunds through one tool with the failure on the second amount are attributed by amount; a call without the listed amount gets a flag; a call id missing from the decisions sets `gateFailed`. Verifies **AC-9**.
- Restart: a task in `doing` with `approving: true` at startup lands in `done` with `unknown` outcomes and its gate folder gone. Verifies **AC-15**.
- Old task: a waiting task without `actions` cannot be approved and shows the redraft reason. Verifies **AC-12**.

## Build plan

Tracer Bullet: the first two steps carry one plain draft all the way from the draft run to a gated approve and back to the panel; the later steps thicken it.

1. Thread, draft side: add `actions.mjs` with `KINDS`, `draftLine`, `parse`, `validate` (full rules), `summary` and `cardLines`; `modeLineFor` takes the role and uses `draftLine('single')` for single desk drafts; in `runServerTask`, parse the result into `actions` and `actionsRead` and strip the fence from `draft`; add `currency` to config loading with its check; page: `copyResult` copies the new fields, `askApproval` fills the card's `mock` slot with the lines, the WAITING row meta adds `summary`. Add `check.mjs` unit steps for parse and validate. Satisfies **AC-1**, **AC-2**, **AC-5**, **AC-6**.
2. Thread, approve side: add `gate.mjs`; extend `askX` with `only`, `settings` and `calls` (reading `user` events, keeping calls on reject); `run()` passes them through and takes the short approve path (`approveSystem`, `approveUser`); `prepareGate`, set `approving`, run gated, `readGate`, `outcomes`, delete the gate folder; empty list approves to `done` with no run; show outcomes on the card's result. Add unit steps for the gate (stdin fixtures, including fail closed) and for `outcomes` (fake call lists), and a `CHECK_LIVE` step that approves a one action draft and asserts one allowed call, one blocked second call and a decision line for each. Satisfies **AC-7**, **AC-8**, **AC-9**.
3. Thicken, unreadable and recovery: `actionsRead: "unreadable"` with `actionsWhy` for a missing fence, bad JSON or a failed rule; the 400 on approve; the disabled APPROVE and the reason on the card (`m.locked` in the chat card render) and "actions unreadable" on the row; old waiting tasks without `actions`; the startup close out of an interrupted approve and the gate folder cleanup. Add a server smoke step for the 400, a unit step for the close out, and a browser smoke step for the disabled button. Satisfies **AC-3**, **AC-4**, **AC-12**, **AC-15**.
4. Thicken, the rest: `noteSection` and `noteLine` in `writeNote`; the rework path clears the old fields and carries the previous list (`reworkLine`); team pieces get `draftLine('piece')` and the lead's final `draftLine('lead')`; connector gone and the API key backend give `not_done` before any run, and validation skips the connected check on that backend; the argument first matching, the flag in amber and `gateFailed` in red. Add unit steps for the note section, the team draft lines and argument matching. Satisfies **AC-9**, **AC-10**, **AC-11**, **AC-13**, **AC-14**.

## Consequences

**Positive**:
- The owner sees what a draft will do and how much money it moves before opening it.
- Approve is held to the listed tools and counts by the CLI, not by the model's good behavior.
- Each outcome is evidence from the run's stream, so a partial failure is visible per action.
- Feature 4 gets a fixed, validated shape and an enforced execution path to build on.

**Negative / tradeoffs**:
- Arguments are not enforced; a wrong amount through the right tool goes out and is only flagged.
- Browser actions cannot be approved until they get their own design, so a routine that needs Chrome to send will lock until reworked.
- Drafts that fail validation cost a rework click; there is no automatic recovery.
- The approve run cannot look anything up; a draft that did not resolve ids up front fails at approve.
- Nothing tells a read tool from a write tool: a listed search tool passes validation and counts `done`. The draft agent is trusted to list the tool that really sends (for example a send tool, not a create draft tool).
- Approve runs share the one serial queue with routine drafts, so an approve can wait behind a draft run.
- The hook depends on Claude Code's PreToolUse behavior in `-p` mode with `--settings`; a CLI change there breaks the gate, which is why a live check guards it.

**Neutral**:
- `askX`, `run()` and startup each gain a small change other callers ignore; upstream merges touch three spots more.
- A new `data/gates/` folder appears during approve runs.
- Each gate decision starts a node process (tens of milliseconds); fine for a handful of calls per approval.
- The approve prompt changes from "exactly as drafted" to "exactly these actions", so the `AFTER YOUR OK` report gets shorter.

## Migration plan

**Strategy**: no data migration. New fields are added as drafts are produced.
**Phases**:
1. Ship. Tasks already waiting have no `actions` and are shown as unreadable with the redraft reason (AC-12); the owner sends them back once.
**Rollback**: revert the commit. Older code ignores the extra task fields; a task left waiting approves the old way, with every connector.
**Risks**: if the hook does not fire in `-p` mode, only the narrow `--allowedTools` list bounds the run. The `CHECK_LIVE` step in build task 2 fails in that case (it asserts a blocked second call and a decision line per call), so the build stops there, and in production `gateFailed` flags every such run. `CHECK_LIVE` needs the real CLI and the owner's connectors, so it runs on this machine only, not in a plain `npm run check`.

## Follow-up

- [ ] Draft runs still hold every connector and rely on the prompt not to send. Design a read only classification of connector tools (or a gate with zero budget plus an allowed read list per connector) so the draft run cannot send either.
- [ ] Browser actions: decide how an approved Chrome action is bounded (a call budget, an allowed site, a final submit check) so routines that send through the browser can be approved.
- [ ] Per action approval (untick single actions) and retrying the not done remainder, both on this schema.
- [ ] Feature 4 (auto approve rules) builds on `kind`, `amount`, `percent`, `currency` and `to`, and on the gated approve path; its spec should reference this one.
