# Scope: Agents Office, store fork

Agents Office changed to run one Shopify store end to end, for its owner only. This slice adds the code the store needs before the office is set up for it: routines in every department and approval rules that let small, safe actions go out without waiting.

**Build approach:** Tracer Bullet (each feature runs end to end through server, page and checks before the next one starts).
**Workflow:** Beta (after `/develop`: `/check verify` on the real office, then `/test` adds regression steps to `check.mjs`). The project default level of rigor. `/architect` is the recommended first stop for a feature with a real decision, but skippable when you already know the build. Any feature can carry its own tag (e.g. `· GA`) to do more or less.

_These are recommendations to keep your build orderly, not requirements. Skip anything that does not fit: if you already know how to build a feature, use `/develop` and skip `/architect`. You decide when a feature is `done`._

## At a glance

| # | Feature | Phase | Status |
|---|---------|-------|--------|
| A | The office, routing and chat | Existing | existing |
| B | Briefs, skills and lessons | Existing | existing |
| C | Routines and the approval step | Existing | existing |
| D | Agent Teams | Existing | existing |
| E | Calendar and scheduled tasks | Existing | existing |
| F | Connectors, browser, models and usage | Existing | existing |
| 1 | Steady smoke checks | Foundation | in-progress |
| 2 | Routines for every department | Slice 1 | in-progress |
| 3 | Outbound action list on drafts | Slice 2 | in-progress |
| 4 | Auto approve rules | Slice 3 | in-progress |
| 5 | Gate the draft run | Slice 3 | in-progress |

## Already there

### A. The office, routing and chat · existing
The 3D office, the command bar that routes a task to the right seat, agent runs through `claude -p`, deliverables filed as notes in the brain, chat with any agent. code in `serve.mjs`, `src/main.js`, `src/tasks.js`

### B. Briefs, skills and lessons · existing
Per agent briefs, skills bound to agents or departments, corrections learned from `revise:`, the lead's set up interview. code in `roster.mjs`, `skills.mjs`, `learn.mjs`, `onboard.mjs`

### C. Routines and the approval step · existing
Routines on the office's own clock for Emails, Accounting and Sales; drafts that wait in WAITING ON APPROVAL until approve or reject. code in `routines.mjs`, `src/when.js`, `serve.mjs`

### D. Agent Teams · existing
The lead splits a task across up to four desks that run at once, then writes the final. code in `teams.mjs`, `serve.mjs`

### E. Calendar and scheduled tasks · existing
The calendar (P), tasks scheduled for a date, routines starting from a date. code in `src/calendar.js`, `serve.mjs`

### F. Connectors, browser, models and usage · existing
MCP servers from `claude mcp list` wired to pods, Claude in Chrome, Sonnet, Opus or Fable with effort, the plan usage gauge. code in `mcp.mjs`, `src/models.js`, `usage.mjs`

## Foundations

### 1. Steady smoke checks · in-progress
Three browser smoke steps fail at random because they wait a fixed time. Every later feature is proven by `npm run check`, so it has to be trustworthy first. code in `check.mjs`
**Done when:** `npm run check` passes 47 of 47 on three runs in a row on this machine, with no step slowed down by more than a few seconds.
- [x] `/develop steady smoke checks`

## Slice 1: Routines everywhere

### 2. Routines for every department · in-progress
Marketing, Operations and Delivery get routines too, so daily posts, inventory checks and review replies can run on the clock. The department list lives in one place so the next change is one edit. code in `src/data.js` (`ROUTINE_DEPTS`), `routines.mjs`, `src/tasks.js`, `check.mjs`
**Done when:** a routine can be set for any of the six departments from the bar, the REPEAT picker, a lead's chat, the calendar and `routines.json`; it fires and lands like today's; the refusal text and its checks are gone or updated.
- [x] `/develop routines for every department`

## Slice 2: Outbound actions

### 3. Outbound action list on drafts · in-progress
Today a draft that waits for the OK is free text, so nothing can tell a $12 refund from a $900 one. The draft step should also name each outbound action it wants to take (what kind, to whom, how much), so a rule can read it and the owner can see it at a glance.
spec [0001](../specs/0001-outbound-action-list-drafts.md) · code in `actions.mjs`, `gate.mjs`, `src/actions.js`, `serve.mjs`, `src/tasks.js`, `src/main.js`, `check.mjs`
**Done when:** every draft waiting for the OK carries a list of the outbound actions it will take, the panel shows them, and approving runs exactly those actions and no others.
- [x] Design it (spec): `/architect outbound action list on drafts`
- [x] Build it: `/develop outbound action list on drafts`
  - [x] Draft side thread: actions block parsed and validated, card lines and row totals (AC-1, AC-2, AC-5, AC-6)
  - [x] Approve side thread: call gate, short approve run, outcomes from real calls, empty list path (AC-7, AC-8, AC-9)
  - [x] Unreadable and recovery: locked approve, old drafts, restart close out (AC-3, AC-4, AC-12, AC-15)
  - [x] The rest: brain note section, rework, teams, missing connectors, argument matching (AC-9, AC-10, AC-11, AC-13, AC-14)
- [ ] Verify it: `/check verify outbound action list on drafts`
- [ ] Test it: `/test outbound action list on drafts`

## Slice 3: Approval rules

### 4. Auto approve rules · GA
Rules the owner writes (for example: refunds under $30, discounts up to 10%, replies to order status questions) approve matching actions straight away; anything else, or anything the rule cannot read, waits as it does today. Money moves on these, so it gets the full review.
**Done when:** a matching action goes out without waiting and its note says which rule approved it; a non matching or unreadable action waits; a rule can be paused; every auto approval shows in the panel and in the brain note.
spec [0002](../specs/0002-auto-approve-rules.md) · code in `approvals.mjs`, `gate.mjs`, `actions.mjs`, `src/actions.js`, `serve.mjs`, `src/tasks.js`, `check.mjs`
- [x] Design it (spec): `/architect auto approve rules`
- [x] Build it: `/develop auto approve rules`
  - [x] Thread: rules file, match and daily caps, auto approve through the gated run, ledger, note line (AC-1 to AC-5, AC-7)
  - [x] Strict gate: per action slots, arguments must match on auto runs (AC-6)
  - [x] Panel: rules under Waiting with use and pause, why a draft waits, the endpoints (AC-8, AC-10)
  - [x] Chat and docs: a lead turns a sentence into a rule on "yes", list, pause, delete; CLAUDE.md (AC-9, AC-11)
- [x] Verify it: `/check verify auto approve rules`
- [ ] Test it: `/test auto approve rules`
- [ ] Review it: `/check review auto approve rules`
- [ ] Document it: `/document auto approve rules`

### 5. Gate the draft run · GA
Drafts and read-only routines still hold every connector and rely on the prompt not to send; the 24 Oct verify saw a draft run save a Gmail draft itself. Now that rules send drafts unattended, those runs get the call gate in a read-only mode, so anything outbound goes only through APPROVE or a rule. From spec 0001's follow-up.
spec [0003](../specs/0003-gate-the-draft-run.md) · code in `src/toolclass.js`, `toolclass.mjs`, `gate.mjs`, `actions.mjs`, `approvals.mjs`, `serve.mjs`, `src/tasks.js`, `check.mjs`
**Done when:** a draft or read-only routine cannot call a write tool (blocked before the connector, unknown counts as write), Chrome only looks, a blocked call shows on the card, a blocked draft is never sent by rule, and the owner can correct a tool's class in one config line.
- [x] Design it (spec): `/architect gate the draft run`
- [x] Build it: `/develop gate the draft run`
  - [x] Classifier: names plus the owner's overrides, the table command, counts in the check (AC-3, AC-4)
  - [x] Read mode in the gate for drafts, team pieces and read-only routines (AC-1, AC-2, AC-5, AC-7, AC-8)
  - [x] The card, row and note show blocks; rules refuse a blocked or ungated draft (AC-5, AC-6)
- [x] Verify it: `/check verify gate the draft run`
- [ ] Test it: `/test gate the draft run`
- [ ] Review it: `/check review gate the draft run`
- [ ] Document it: `/document gate the draft run`

## Deferred
Out of scope for this build pass, kept so the plan stays honest.
- **Store numbers panel**: revenue, average order, conversion, low stock and open tickets from Shopify in the office · needs a decision
- **Shopify event triggers**: a new order, low stock, a refund request or a bad review starts a task · needs a decision
- **Brain health routine**: the vault linter runs weekly and reports in the office; easy once feature 2 ships
- **More seats or a seventh department**: beyond the fixed 35 desks · needs a decision
- **Approvable browser actions**: how an approved Chrome action is bounded (call budget, allowed site, final submit check) · needs a decision · from spec 0001
- **Per action approval and retry**: untick single actions, and approve the not done remainder again, on the 0001 schema · from spec 0001

## Legend

**The decision box.** Every feature carries exactly one, the sub-task whose label ends with `(spec)`. Its wording varies, so skills locate it by that `(spec)` suffix, never by an exact label. Every other box is an execution box and `/architect` never ticks one.

**Feature lifecycle**: the scope updates as a feature moves; each row is what it shows and who sets it:

| State | Set by | The feature shows |
|---|---|---|
| `planned` · needs a decision | `/scope` | one box: `Design it (spec): /architect <feature>` |
| `in-progress` (designed) | **`/architect` at spec capture** | `Design it` ticked; spec linked; `Build it: /develop <feature>` + **2 to 5 milestones**; the tier's closing boxes (`Verify it` Alpha+, `Test it` Beta+, `Review it` + `Document it` GA); any surfaced follow-up enrolled |
| `in-progress` (building) | `/develop` | milestone sub-boxes tick one by one; code pointer filled |
| `in-progress` (verified) | `/check verify` | `Build it` + milestones ticked; `Verify it` ticked |
| `done` | **you, when you decide it is** (any skill sets it when you say so); `/sync` reconciles | boxes you ran ticked, skipped ones marked skipped; the tier's last stage (`Prototype` → after `/develop`; `Alpha` → after `/check verify`; `Beta`/`GA` → after `/test`) is the suggested point to call it done; `/sync` captures conventions |

- **Next step** = the first unticked box (always a command or a tracked milestone).
- **needs a decision** = run `/architect` first; otherwise straight to `/develop`. The tag drops once the spec is captured.
- **Atomic build tasks live in the spec's `## Build plan`, not here**: the scope carries only the milestone rollup.
- **Status** `planned` → `in-progress` → `done`, plus `existing` (pre-workflow) and `dropped` (de-scoped, kept for history).
- **Workflow tier tag** beside a heading (e.g. `· GA`) sets that one feature's rigor above or below the project default; no tag inherits the default.
- **Workflow** (header line) is the project default, what runs after `/develop`: **Prototype** = nothing; **Alpha** = `/check verify`; **Beta** = `/check verify` then `/test`; **GA** = adds a fresh model `/check review` then `/document`.
- **Pointer line** (`spec <n> · code in <path>`): the spec link added by `/architect`, the code path by `/develop`.
