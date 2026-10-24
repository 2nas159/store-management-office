# 0002. Auto approve rules: small, safe actions go out without waiting

**Date**: 2026-10-24
**Status**: Proposed
**Builds on**: [0001](0001-outbound-action-list-drafts.md) (the action list, the gated approve run)

## Summary

You write rules such as "refunds under 30 USD, at most 200 USD a day" or "replies from the order status routine, at most 20 a day". When a draft lands and **every** action in its list matches a rule with room left under that rule's daily cap, the office approves it straight away. It uses the same gated run as your APPROVE, but the gate is stricter: a call whose input does not show the listed amount and recipient is blocked. Anything else waits for you exactly as today, including a draft no rule covers, an unreadable list, an empty list, and a draft that would go over a cap. The card says why it waits. Rules live in the brain, can be set and paused from a lead's chat and from the panel, and every auto approval names its rule in the panel and the brain note.

## Context

Spec 0001 gave every waiting draft a validated list of actions (`kind`, `tool`, `to`, `amount`, `currency`, `percent`) and an approve run that may call only those tools, once per action. It promised that shape as the contract for this feature. Today every draft waits for a human tick, so a routine that answers order status emails all day needs the owner at the keyboard all day.

Money moves on this path with nobody looking, so three things decide the design. A rule can only read the structured list, never the prose. A runaway routine or a bad draft must hit a ceiling. And a run must not send a different amount or recipient than the one the rule allowed.

> ⚠️ Premise note: 0001's draft run still holds every connector and is kept from sending by its prompt only (seen in the 24 Oct verify, when a draft run saved a Gmail draft itself). This feature does not widen that gap, but it makes the office run unattended more often. The gap stays listed as its own deferred item.

Constraints: plain Node ESM, no new dependencies, owner state in the brain, run state in `data/`, problems are plain sentences, small edits to `serve.mjs` and `src/tasks.js`.

## Requirements

**User stories**:
- As the store owner, I want small, routine actions to go out without me, so that the office keeps up when I am away.
- As the store owner, I want a hard daily ceiling per rule, so that a bad draft or a looping routine cannot spend more than I allowed.
- As the store owner, I want to see which rule sent what and pause any rule in one step, so that I stay in control of what runs without me.

**Acceptance criteria**:
- **AC-1**: Rules live in `<brain>/Agents Office/approvals.json` as `{ "paused": false, "rules": [ … ] }`. The file is read again before every check, so an edit needs no restart. `npm run check` validates it, and a bad rule is skipped with a plain sentence.
- **AC-2**: A rule has `id`, `title`, `kinds` (non empty, from 0001's kind list), and optionally: `tools` (exact `mcp__` names), `to` (patterns, `*` as a wildcard, case insensitive), `depts`, `routines` (routine ids), `max` + `currency` (the most money one action may move), `maxPercent`, `dailyMax` (money per local day, in the rule's currency), `dailyCount` (actions per local day), `paused`. A rule for a money kind (`refund`, `payment`, or `discount` with an amount) needs `max`, `currency` and `dailyMax`. A rule for any other kind needs `dailyCount`. A discount by percent needs `maxPercent`.
- **AC-3**: An action matches a rule when the rule and the file are not paused, and the kind, tool, `to` pattern, department and routine all fit. If the action moves money, the rule's currency must equal the action's and the amount must be at most `max`. If it is a percent discount, the percent must be at most `maxPercent`. An action that moves money never matches a rule without `max`.
- **AC-4**: A draft is auto approved only when its list is readable, has at least one action, the office is on the CLI backend, and every action matches a rule (the first match in file order) with room left. Room means today's ledger total plus the amounts already taken by earlier actions in the same draft stays within `dailyMax`, and the count stays within `dailyCount`. Otherwise the draft waits, with `autoWhy` naming the first reason ("a2: no rule covers payment", "a1: Small refunds is at 190.00 of 200.00 USD today", "auto approvals are paused").
- **AC-5**: An auto approval writes the ledger first (`data/approvals.json`: rule, task, action, amount, currency, time), then sets `task.autoApproved = { rules, at }` and runs 0001's approve path. Nothing else differs from a manual approve. The ledger counts what was approved, not what succeeded, so a failed refund still uses its share of the cap.
- **AC-6**: On an auto approved run the gate is strict: each call must claim the slot of an action of that tool whose amount (when set) and recipient are found in the call's input (0001's `found` rule). A call that matches no free slot is blocked, and that action ends `not_done` with the reason ("blocked: amount 12.50 not found in the call"). Manual approvals keep 0001's flag only check.
- **AC-7**: A rework after REJECT always waits for the owner, with `autoWhy` "you sent this one back, so its rework waits for you", and uses none of the cap. *(Changed 24 Oct after the review, the owner's call: it was "checked against the rules again", which let a draft the owner had just sent back go out unseen.)*
- **AC-8**: The panel shows the rules under the **Waiting** chip: title, limits, today's use ("40.00 of 200.00 USD today"), and PAUSE / RESUME / DELETE buttons. There is also one switch for all auto approvals. A waiting card shows `autoWhy` when rules exist. A done row says "approved by rule <title>". The brain note's front matter gains `approved by: rule <id> (<title>)`, one line per rule used.
- **AC-9**: In any department lead's chat:
  - "auto approve refunds under 30 USD, at most 200 a day" becomes a proposed rule, scoped to that department. The lead reads it back field by field and saves it only on "yes"; any other reply drops it.
  - "rules" lists them.
  - "pause / resume / delete <words>" acts on the best word match.
  - "pause auto approvals" and "resume auto approvals" flip the file switch.
- **AC-10**: `GET /api/approvals` returns rules, today's use, the switch and the problems. `POST /api/approvals/:id/pause|resume` and `DELETE /api/approvals/:id` edit the file. `POST /api/approvals/pause|resume` flips the switch.
- **AC-11**: `CLAUDE.md` gains a section telling Claude Code how to write a rule, as it does for routines.

## Options considered

### Option 1: Rules on the structured list, the same gated run, a stricter gate (chosen)
The server matches the stored actions against rules in code and approves through 0001's path, with the gate also checking arguments.
- **Pros**: deterministic, testable, and no model judges money. Reuses the enforced path. Caps are plain arithmetic on a ledger.
- **Cons**: rules can only say what the list carries. "Replies to order status questions" has to be expressed by routine, tool or recipient, not by meaning.

### Option 2: A model judges each draft against rules written in prose
- **Pros**: rules read like the owner talks ("polite replies about shipping times").
- **Cons**: a model decides whether money moves. It cannot be tested against a fixed answer, and a persuasive draft can talk its way through.

### Option 3: Split drafts, send the matching actions, hold the rest
- **Pros**: more goes out without waiting.
- **Cons**: needs per action approval first (deferred in 0001). The owner picked all or nothing.

## Decision

**Chosen option**: Option 1.

Settled during the design (each a pick with the runner up):
- **All or nothing** (owner). Runner up: split drafts (Option 3).
- **Per rule daily caps, required** (owner, and every rule must have one). Runner up: per action limits only. Twenty refunds just under the limit would all go out.
- **Strict gate on auto runs** (owner). Runner up: flag only, as for manual approvals. A wrong amount would then go out unseen.
- **File, lead chat and panel** (owner). Runner up: file only.
- **An empty list still waits.** "Every action matches" is true of an empty list, but those drafts are reports the owner may want to read. A routine that never needs reading should have `needsOk` off. Runner up: auto close empty lists.
- **Rules from chat need a "yes".** A model turns the sentence into fields, so the lead reads them back before saving. The file and the panel need no confirmation. Runner up: save straight away and show it.
- **The first matching rule in file order takes the action.** It is predictable, and the owner orders the file. Runner up: the rule with the most room left, which is harder to predict.
- **The ledger counts approvals, not successes.** It is written before the run, so a crash mid run cannot hand out the same room twice. Runner up: count only `done` outcomes, which reopens room after a failure but races with a restart.
- **Day = the machine's local calendar day**, the same clock routines use.
- **No auto approval on the API key backend.** Approve there marks everything `not_done` anyway.
- **The gate reads the actions, not only the counts.** `budget.json` carries the listed actions (`tool`, `to`, `amount`, `strict`), and slot files are named by action id. The `found` check moves to `src/actions.js` (pure JS), and `gate.mjs` imports it. That is one relative import, replacing 0001's "fs and path only".

## Rationale

The owner is not there when this fires, so every safety has to live in code and data, not in a prompt. Matching on 0001's validated fields keeps the decision exact and testable, and the existing gated run means auto approved sends obey the same tool and count limits as manual ones. The daily caps bound the worst case to what the owner wrote down. The strict gate closes the one hole 0001 left open (arguments are only flagged), at the cost of some legit calls being blocked when an input names an order by a different id. That failure is visible and safe, and the owner chose it. All or nothing keeps the change small and leaves no half-sent drafts to reason about.

## Feature design

**Rule** (`<brain>/Agents Office/approvals.json`):

```json
{ "paused": false, "rules": [
  { "id": "small-refunds", "title": "Small refunds", "kinds": ["refund"], "max": 30, "currency": "USD", "dailyMax": 200, "depts": ["delivery"] },
  { "id": "order-status-replies", "title": "Order status replies", "kinds": ["reply", "email"], "routines": ["order-status"], "tools": ["mcp__claude_ai_Gmail__send_message"], "dailyCount": 20 }
] }
```

**Task fields** (in `data/tasks.json`): `autoApproved: { rules: [{ id, title }], at }` when sent by rule (the title is kept so the note and the panel need no lookup). `autoWhy: string` when rules exist and the draft waits. `actions[i].rule: id` for the rule that took the action.

**Ledger** (`data/approvals.json`, run state): `{ "entries": [{ "rule", "task", "action", "amount", "currency", "at" }] }`. Entries older than 8 days are dropped on write.

**Flow**: the draft lands (`runServerTask`, after `fromDraft`) → `approvals.decide(task, rules, ledger, { sdk, now })` → `{ ok, take: [{ action, rule }] }` or `{ why }`. If ok: write the ledger, set `autoApproved`, enqueue `runServerTask(id, { approve: true, strict: true })`. Otherwise set `autoWhy` and wait.

**Gate** (`budget.json`): `{ "actions": [{ "id", "tool", "to", "amount", "strict" }] }`. A call claims the first free action slot (`<id>` file, `wx`) of its tool whose arguments are found. When not strict, the arguments are not needed. A blocked call writes `why` into its decision line, and `outcomes` copies it into that action's `error`.

**API**: `GET /api/approvals` · `POST /api/approvals/pause|resume` · `POST /api/approvals/:id/pause|resume` · `DELETE /api/approvals/:id`.

**Internal**: `approvals.mjs` (new): `load`, `validate`, `save`, `matches(action, rule, task)`, `decide`, `use(ledger, rule, day)`, `record`, `describeRule`, `listText`, `parseSentence` (a Sonnet JSON call, validated), `confirmText`.

**Key invariants**:
- No auto approval without a readable, non empty list in which every action matches, within every cap.
- An action that moves money never matches a rule without `max`, `currency` and `dailyMax`.
- The ledger entry exists before the run starts.
- An auto approved call whose arguments do not show the listed amount and recipient is blocked.
- Pausing a rule or the switch takes effect on the next draft. Nothing already approved is recalled.

**Security model**: one local owner. Rules widen what goes out without a tick, so they come only from the owner's file, the panel, or a confirmed chat sentence. Nothing an agent writes in a draft can create or change a rule.

**Critical test scenarios**:
- A refund of 12.50 USD with a 30/200 rule is auto approved, the ledger shows 12.50, and the note names the rule (AC-3, AC-4, AC-5, AC-8).
- Two refunds of 25 with 190 used of 200: the first fits, the second does not, so the whole draft waits with the cap reason (AC-4).
- A payment, a 45 USD refund, an EUR refund, a paused rule, the paused switch, an empty list, an unreadable list, the API key backend: all wait, each with its reason (AC-3, AC-4).
- A strict gate fed a call with the wrong amount blocks it, and the action is `not_done` with the reason. A manual approve passes the same call with a flag (AC-6).
- A bad rule (money kind with no cap, an unknown kind, a duplicate id) is skipped with a sentence (AC-1, AC-2).
- The panel lists the rules with today's use, and PAUSE takes effect on the next draft (AC-8, AC-10).
- Chat: a rule is proposed, saved only on "yes", and listed, paused and deleted (AC-9).

## Build plan

Tracer Bullet: the first step carries one refund from a rule file to an auto approved, noted send. The rest thicken it.

1. **Thread**: `approvals.mjs` (load, validate, matches, decide, ledger). `runServerTask` decides after a draft lands and runs the approve path. `autoApproved` and `autoWhy` on the task, the note line, "approved by rule" on the done row, `GET /api/approvals`. Unit steps for validate, match and caps, and a server smoke step that auto approves a planted draft with no connector (outcome `not_done`, ledger written, note line). Satisfies AC-1 to AC-5, AC-7.
2. **Strict gate**: per action slots in `gate.mjs`, `found` shared from `src/actions.js`, the blocked reason in outcomes. Gate unit steps (strict versus manual), and a `CHECK_LIVE` step with a read-only tool and a wrong `to`, expected blocked. Satisfies AC-6.
3. **Panel**: the rules under the Waiting chip with use, buttons and the switch. `autoWhy` on the waiting card. The pause, resume and delete endpoints. A browser smoke step and a server step. Satisfies AC-8, AC-10.
4. **Chat and docs**: the lead's sentence, confirm, list, pause, resume and delete; the `CLAUDE.md` section. Unit steps with a stubbed Sonnet call. Satisfies AC-9, AC-11.

## Consequences

**Positive**: routine outbound work runs while the owner is away, inside caps the owner wrote. Arguments become enforced on unattended sends.

**Negative / tradeoffs**:
- Rules cannot read meaning, so "order status replies" means "from that routine, through that tool".
- The strict gate blocks legit calls whose input names the target differently. They end `not_done`, and the owner approves by hand.
- A failed action still uses its share of the cap.
- The draft run's own reach (premise note) is unchanged.

**Neutral**: one new brain file, one new data file, four small endpoints. The gate's budget file changes shape (written and read by the office only).

## Migration plan

No migration. No rules file means no auto approvals, and the office behaves as today. Rollback: delete `approvals.json` or flip the switch. Reverting the code leaves the extra task fields ignored.

## Follow-up

- [ ] Gate the draft run too (deferred from 0001). More urgent once drafts can be sent unattended.
- [ ] Per action approval, so a draft can be split (Option 3).
- [ ] Rules on content (an allowed template, a maximum length) if routines need more than kind, tool and recipient.
