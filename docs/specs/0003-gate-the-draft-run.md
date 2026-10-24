# 0003. Gate the draft run: unattended runs read, they do not write

**Date**: 2026-10-24
**Status**: Proposed
**Builds on**: [0001](0001-outbound-action-list-drafts.md) (the call gate), [0002](0002-auto-approve-rules.md) (rules that send drafts unattended)

## Summary

The runs the office does on its own get the call gate too, in a read-only mode: drafts that wait for your OK, and routines with needsOk off. In that mode a connector tool that reads (list, get, search …) passes. A tool that writes is blocked before it reaches the connector, and so is any tool the office cannot place. Chrome may look but not touch. A blocked call is shown on the card in amber, and a draft with one never goes out by rule. Tasks you type in the bar and chats are unchanged, because you are there. So the only way anything goes out without you is APPROVE or a rule, both through 0001's gated run.

## Context

0001's premise note: the draft run holds every connector and is kept from sending by its prompt alone. The 24 Oct verify showed it happen, when a draft run saved a Gmail draft itself before any OK. Feature 4 now lets drafts go out unattended, so nobody reads a draft before its actions run. A routine with needsOk off ("only reads and reports") is also unattended and equally unguarded.

Facts that shape the design:
- **Tools come as plain names.** The CLI reports tools as names only (the run's `init` event): no read-only marking, and the office has no MCP client of its own. Any classification works from the name.
- **Names place most tools.** On this machine, 330 of 817 connected tools read by name and 269 write by name. Most of the other 218 have a namespace before the verb (`agents_create`, `creative_generate_image`); a few are truly ambiguous (`graphql_query`, `graphql_mutation`).
- **The hook sees the input.** It receives `tool_input`, so it can tell a Chrome screenshot from a click inside the same `computer` tool.
- **It fails open if it cannot start** (seen in 0001's first probe), so a call with no decision line must be caught after the run.

## Requirements

**User stories**:
- As the store owner, I want a draft to be unable to send, pay or change anything, so that reading it (or a rule passing it) is the only gate before anything goes out.
- As the store owner, I want to see when a draft or a routine tried to write, so that I can fix the routine or the tool's class.
- As the store owner, I want to correct a tool the office classed wrongly, so that a draft can read what it needs.

**Acceptance criteria**:
- **AC-1**: Every draft run (single desk, team pieces and the lead's final) and every read-only routine run starts with the gate in **read mode**. Bar tasks, `revise:`, chat and the approve run are unchanged.
- **AC-2**: In read mode the gate allows:
  - `ToolSearch`, `WebSearch` and `WebFetch`;
  - an MCP tool classed **read**;
  - the Chrome tools that only look: `tabs_context_mcp`, `tabs_create_mcp`, `tabs_close_mcp`, `navigate`, `read_page`, `get_page_text`, `find`, `read_console_messages`, `read_network_requests`, `list_connected_browsers`, `shortcuts_list`, and `computer` only for `screenshot`, `zoom`, `scroll`, `scroll_to`, `wait`, `hover`.

  Everything else is blocked (exit 2, a reason), and any error in the gate blocks.
- **AC-3**: The class of a tool:
  1. The owner's lists in `office.config.json` decide first: `"gate": { "read": [patterns], "write": [patterns] }`, full tool names with `*` as a wildcard. A tool on both lists is write.
  2. Otherwise the name decides. Strip `mcp__<server>__`, split on `_` and `-`. Any token that is a write verb makes it **write**; else any read verb makes it **read**; else it is **unknown**, which counts as write.
- **AC-4**: The verb lists live in one shared module. `node toolclass.mjs` prints every tool the office knows, grouped by connector, with its class and why ("name: search", "yours", "unknown"). `npm run check` prints the counts and any of your patterns that match no known tool.
- **AC-5**: Each blocked call is recorded on the task as `runDenied: [{ tool, why, at }]`, and logged.
  - A waiting draft with blocks shows "blocked while drafting: <tool>" in amber on the card and the row.
  - A finished read-only routine shows the same on its row and card.
  - The brain note lists the blocked calls.
- **AC-6**: A draft with any `runDenied` entry, or with an MCP call that has no gate decision (`gateFailed`), is never sent by rule. `autoWhy` then reads "the draft tried to write while drafting (<tool>), so you look at it yourself", or "the gate did not run for every call while drafting".
- **AC-7**: The draft line tells the agent it may only read, and that a blocked call is expected and must not be retried.
- **AC-8**: The gate folder of a run lives at `data/gates/<task id>-run` (`<task id>-<agent>-run` for a team piece), is deleted after the run, and is emptied at startup like 0001's.

## Options considered

### Option 1: Read mode in the existing gate, classified by name, with the owner's overrides (chosen)
- **Pros**: one more mode in a hook already proven in `-p` mode. Classification works on the first run after install (it needs no list of tools in advance). It fails closed on anything unclear, and the owner can correct it in one config line.
- **Cons**: names are a heuristic, so a read tool with an odd name is blocked until the owner marks it. Every draft tool call starts a node process (tens of ms).

### Option 2: An allowlist the owner writes
- **Pros**: nothing reads unless the owner said so.
- **Cons**: 800+ tools. Drafts are blind until the list exists, and the owner would have to review every new connector by hand. The owner picked Option 1.

### Option 3: Give draft runs only the read tools through `--allowedTools`
- **Pros**: no hook needed for the connectors.
- **Cons**: needs the full tool list before the run (unknown on the first run). The owner's own Claude Code settings may allow more. Chrome's `computer` tool cannot be split into look and touch. The hook is needed anyway.

## Decision

**Chosen option**: Option 1.

Settled during the design (each a pick with the runner up):
- **Names plus the owner's overrides, unknown counts as write** (owner). Runner up: the owner's list only.
- **Chrome: look, don't touch** (owner). Runner up: no Chrome in drafts.
- **Drafts and read-only routines** (owner). Runner up: drafts only.
- **A blocked draft waits with the block shown, and no rule may send it** (owner). Runner up: record it only.
- **Write wins anywhere in the name.** `get_or_create_x` is write, and `run-analytics-query` is write too (wrong, but safe, and one override line fixes it). Runner up: the first verb decides, which lets `get_or_create` read.
- **The gate classifies at call time**, by importing the shared classifier inside its try, so a load failure blocks. Runner up: a read list computed before the run, which is blind on the first run after install.
- **`navigate` is allowed.** Opening a page is how a draft reads a web app. Pages whose plain GET changes something (an unsubscribe link) are the owner's risk, noted below. Runner up: block `navigate`, which leaves Chrome nearly useless for drafts.
- **`javascript_tool`, `form_input`, `file_upload`, `upload_image`, `browser_batch`, `shortcuts_execute` and `gif_creator` are blocked** in read mode. `browser_batch` can carry clicks, so it is blocked whole rather than inspected.
- **Bar tasks are not gated.** The owner typed the request and is watching; the existing prompt rule (send only when asked) stays.

## Feature design

**Config** (`office.config.json`, or the local copy):
```json
"gate": { "read": ["mcp__plugin_small-business_shopify__graphql_query", "mcp__claude_ai_Notion__*"], "write": ["mcp__claude_ai_Canva__get-create-design-async-job"] }
```

**Shared** `src/toolclass.js` (pure JS): `READ_VERBS`, `WRITE_VERBS`, `classify(name, { read, write })` → `{ cls: 'read' | 'write', why, unknown? }`, `LOOK` (the Chrome tools that only look) and `LOOK_ACTIONS` (the `computer` actions that only look).

**Gate** (`gate.mjs`): `budget.json` gains `mode`: `"approve"` (0001 and 0002, unchanged) or `"read"` with `{ "read": [...], "write": [...] }` copied from the config. Read mode allows per AC-2 and writes a decision line for every call; a block line carries `why`.

**Server**: `askX` already takes `settings`. `run()`, `runTeam` and `runTeamLead` pass a read-mode gate for `draft` and `routine` modes (`actions.prepareReadGate(dir, cfg.gate)`), then read the decisions (`runDenied`) and the calls (`gateFailed`). `approvals.decide` refuses a task with either.

**Task fields**: `runDenied: [{ tool, why, at }]`, and `gateFailed` (0001's field, now also set by draft runs).

**Key invariants**:
- No connector call outside the read class runs in a draft or read-only routine.
- An error inside the gate blocks. A hook that never ran is caught after the run (`gateFailed`), and such a draft is never sent by rule.
- The owner's `write` list beats everything; their `read` list beats the name.

**Critical test scenarios**:
- Names: `search_threads` read; `send_message` write; `agents_create` write; `graphql_query` read; `graphql_mutation` write (unknown); `get_or_create_x` write; an owner's `read` pattern lifts `run-analytics-query`; a tool on both lists is write.
- Gate, read mode: `list_events` allowed; `send_message` blocked; Chrome `screenshot` allowed and `left_click` blocked; `form_input` and `javascript_tool` blocked; a missing classifier blocks.
- A draft with a block waits, shows "blocked while drafting", and a matching rule does not send it.
- Live: a draft run told to send an email while drafting is blocked, and lands waiting with `runDenied`.

## Build plan

1. **Classifier**: `src/toolclass.js`, the `gate` config with its checks, `node toolclass.mjs`, and the counts in `npm run check`. Unit steps for the name cases. AC-3, AC-4.
2. **Read mode in the gate, wired into the draft and routine runs**: `prepareReadGate`, `run()`, team pieces and the lead, `runDenied` and `gateFailed` on the task, the draft line, cleanup at startup. Gate unit steps, and a `CHECK_LIVE` step where a draft is told to send while drafting. AC-1, AC-2, AC-5, AC-7, AC-8.
3. **What the owner sees, and the rules**: amber "blocked while drafting" on the card, row and note; `approvals.decide` refuses a blocked or ungated draft. Smoke steps. AC-5, AC-6.

## Consequences

**Positive**: unattended runs cannot send. Outbound goes only through APPROVE or a rule, both gated with exact tools and counts. A routine that tries to write shows up instead of acting quietly.

**Negative / tradeoffs**:
- Read tools with odd names are blocked until the owner marks them, so a draft may come out thinner the first time.
- `navigate` can still trigger a page whose GET changes something.
- Drafts and routines become slightly slower, because every tool call starts a node process.

**Neutral**: one config key, one shared module, one command. The gate gains a mode, and the approve gate is untouched.

## Migration plan

No data migration. The first drafts after shipping may show blocks for read tools with odd names; the owner adds them to `gate.read`. Rollback: revert, after which drafts hold every connector as before.

## Follow-up

- [ ] Show each connector's read/write counts in the top bar, and let the owner flip a tool's class from there.
- [ ] Use MCP tool annotations (`readOnlyHint`) if the CLI ever reports them.
