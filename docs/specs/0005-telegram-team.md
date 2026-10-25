# 0005. The team on Telegram: a CEO, a secretary and six department leads you can message

**Date**: 2026-10-25
**Status**: Proposed
**Builds on**: 0001 to 0004 (action lists, rules, read-only drafts, store triggers): every safeguard stays the gatekeeper, whichever bot you talk to.

## Summary

Eight Telegram bots, each with its own name, photo and chat with you:
- **six department leads** (Emails, Sales, Marketing, Operations, Accounting, Delivery), who answer for their department, take tasks and report back;
- **a CEO**, who takes your goals, plans them across departments, hands the pieces to the leads, follows up and reports, plus a weekly business brief;
- **a secretary**, who collects every approval (the action list with APPROVE / REJECT buttons), sends a morning brief, keeps your calendar and reminders, runs office admin (rules, routines, triggers, always read back before saving) and triages your inbox.

The office talks to Telegram by connecting out (long polling), so nothing on your machine is exposed. Only your own Telegram account, paired once with a code, can command the bots.

## Context

Today the office answers only on its page, on the machine running it. The owner wants to run the business from the phone, with a distinct bot per role. Constraints and facts:
- **The office is six departments and 35 desks, fixed.** The CEO and the secretary are therefore office-level roles, not desks. They act through what exists: routing, tasks, teams, approvals, rules, routines and triggers.
- **The Telegram Bot API:**
  - `getUpdates` long polling works without a public address;
  - messages are at most 4,096 characters, so longer ones are split or sent as a document;
  - inline keyboards carry callback data of at most 64 bytes;
  - in groups, a bot sees only messages addressed to it unless its privacy mode is off;
  - bots never see other bots' messages;
  - Telegram keeps updates for 24 hours while a bot is offline.
- **Approving can move money.** Whoever controls the bots controls APPROVE.

## Requirements

**User stories**:
- As the store owner, I want to approve or reject drafts from my phone, so that work does not wait for me to be at my desk.
- As the store owner, I want to give a goal to a CEO and have it run across departments, so that I direct the business instead of the desks.
- As the store owner, I want each department lead as its own contact, so that I talk to the right person for the job.
- As the store owner, I want a secretary for my day (brief, calendar, reminders, inbox, admin), so that I am not the office's bookkeeper.

**Acceptance criteria**:
- **AC-1, setup**: `office.config.local.json` takes `"telegram": { "bots": { "secretary": "<token>", "ceo": "<token>", "emails": "<token>", … }, "confirmAbove": 100 }`.
  - Any subset of bots works; a missing lead is reached through the secretary or the CEO ("@sales …").
  - Tokens live only in the local file; `npm run check` refuses them in `office.config.json`.
  - `node telegram.mjs` tests every token and prints each bot's username, starting nothing.
- **AC-2, pairing and lock**:
  - On first start, the office shows a pairing code (console and page). The owner sends `/start <code>` to any bot, and the office records the owner's Telegram user id.
  - From then on, every bot answers only that user, in private chats, plus one optional paired group (the boardroom). Anyone else gets no answer, and the attempt is logged.
  - The code expires after 10 minutes and works once.
  - `"/unpair"` from the owner, or deleting `data/telegram.json`, resets it.
- **AC-3, a lead bot**:
  - Free text is that lead's chat, the same as the page: briefs, skills, lessons, the routines, rules and triggers commands, `revise:`.
  - `/task <text>` adds a task to the department, routed to the right desk as from the bar.
  - When a department task finishes, its lead sends the result (split or as a `.md` document when long). A trigger task also says which store event started it.
- **AC-4, the secretary and approvals**:
  - Every draft that reaches WAITING is sent to the secretary chat: the title, the lead who drafted it, the action lines (0001), `autoWhy` or `runDenied` when present, and buttons **APPROVE · REJECT · DETAILS**.
  - APPROVE runs the same path as the page (`POST /api/tasks/:id/approve`). When the money in the draft is above `confirmAbove`, a second tap shows "Send 912.00 USD?". An unreadable list shows no APPROVE.
  - REJECT asks "What should change?", and the owner's next message is the note.
  - A button for a task that is no longer waiting answers "already handled", and does nothing.
  - What the approved run did (0001 outcomes) comes back to the same message.
- **AC-5, the secretary's other jobs**:
  - **Morning brief** (default 08:00, local time): waiting approvals, what ran overnight (routines, triggers, rule sends), store events, today's calendar.
  - **Reminders**: "remind me Friday at 10 to call the supplier" is stored in `data/reminders.json` and sent by the office's clock, LATE once if the office was off.
  - **Calendar**: "what's on today", "book 30 min with Ana on Tuesday", through the owner's Calendar connector in a chat run. A booking is read back, then done on "yes".
  - **Office admin**:
    - rules, through 0002's sentence → read back → "yes";
    - routines, through the existing sentence parser;
    - triggers, new from chat: sentence → read back → "yes", the same validation as the file;
    - pause, resume and lists for all three.
  - **Inbox triage**, on request and in the morning brief: what needs the owner in Gmail (a read-only run). Each item has a button to hand it to a department as a task.
- **AC-6, the CEO**:
  - **Goals.** "Goal: …" (or plain text that the CEO decides is a goal):
    1. The CEO plans one to six pieces across departments (Sonnet, JSON, validated like a team plan) and shows the plan with **START · CHANGE · DROP**.
    2. On START, each piece becomes a department task.
    3. The CEO follows the pieces. When all are done, it writes the result with the outcomes and the open approvals.
    4. Goals live in `data/goals.json`.
  - **The weekly brief** (Monday 08:30, editable): what moved, the store's numbers it can read, what is stuck, and three suggestions.
  - The CEO answers questions about the whole business from the brain and the store.
- **AC-7, safety**:
  - Tasks the CEO creates always run as drafts (`needsOk`, 0003's read-only gate). Nothing a bot says to another bot is an instruction; bots only hand work through the office's task records.
  - Chats with leads, the CEO and the secretary follow the page chat's rule (send only when the owner asks for that exact action). An owner request that sends, books or pays is read back with a "yes" before it runs.
- **AC-8, the boardroom group (optional)**: when paired, leads post short updates there (a task done, a store event, a goal finished) and stay quiet otherwise. The owner can mention any bot there.
- **AC-9, offline and limits**:
  - Updates that arrive while the office is off are handled on start. A stale button answers "already handled".
  - Sending respects Telegram's limits: one message a second per chat, retries after a 429's `retry_after`.
  - A bot that fails (a bad token, revoked) is shown in the panel and the console in plain words, and the rest keep working.

## Options considered

### Option 1: Eight Telegram bots on long polling, the office as the brain (chosen)
- **Pros**: true separate identities, on the phone, with nothing exposed, and it reuses every office path.
- **Cons**: the owner creates eight bots in @BotFather, and the office must be running.

### Option 2: Slack, one app with eight identities
- **Pros**: one app, team friendly.
- **Cons**: the identities are names on one app, not separate contacts. It needs a workspace. The owner picked Telegram.

### Option 3: One bot that switches persona ("/sales …")
- **Pros**: one token.
- **Cons**: not what was asked; one chat for everything.

## Decision

**Chosen option**: Option 1.

Settled during the design (each a pick with the runner up):
- **Telegram** (owner). Runner up: Slack.
- **The CEO runs goals** (owner). Runner up: an advisor only.
- **The secretary collects approvals** (owner). Runner up: each lead asks for its own.
- **The secretary does all four jobs** (owner).
- **CEO and secretary are office-level roles, not desks**, because the 35 desks are fixed. Their persona, brief and model live in `office.config.local.json` under `telegram.roles`. Runner up: renaming two desks, which would take them out of their departments.
- **Pairing by a one-time code, locked to one Telegram user id.** Runner up: a list of allowed usernames, which can be changed by their owners.
- **A second tap above `confirmAbove`** (default 100 in the office currency). Runner up: always one tap.
- **The CEO's tasks are drafts, always.** The owner set a goal, not the specific sends. Runner up: run them like bar tasks.
- **Triggers can now be made from chat**, read back with "yes" (0004's follow-up), because the secretary's admin job needs it. Runner up: file only.
- **Long results go as a document** past 3,500 characters. Runner up: split messages.
- **Voice notes are out of this build** (they need a transcription service). Follow-up.

## Feature design

**Modules**:
- `telegram.mjs`: the Bot API client (`getUpdates` per bot, `sendMessage` with chunking and buttons, `sendDocument`, `answerCallbackQuery`, `editMessageText`), rate limits, pairing and the owner lock, `node telegram.mjs` to test tokens.
- `team.mjs`: the roles (CEO, secretary, leads), message routing (which bot → which handler), the button grammar (`a:<taskId>`, `r:<taskId>`, `c:<taskId>` for confirm, `g:<goalId>:start`), briefs, reminders and goals.
- `serve.mjs`:
  - a hook where a task reaches WAITING or done → `team.notify(task)`;
  - the bots' handlers call the same functions as the endpoints (no HTTP to itself);
  - the clock adds reminders and the briefs.

**State** (`data/`, run state):
- `telegram.json`: the owner id, the paired group, each bot's update offset, and the sent message per waiting task, for editing it.
- `reminders.json` and `goals.json`.

**Config** (`office.config.local.json`):

```json
"telegram": { "bots": { "secretary": "…", "ceo": "…", "emails": "…", "sales": "…", "marketing": "…", "ops": "…", "fin": "…", "delivery": "…" },
  "confirmAbove": 100, "morning": "08:00", "weekly": { "days": [1], "at": "08:30" },
  "roles": { "ceo": { "name": "CEO", "brief": "…", "model": "opus" }, "secretary": { "name": "Secretary", "brief": "…" } } }
```

**Key invariants**:
- Only the paired owner (and the paired group) gets an answer. An unpaired office answers only `/start <code>`.
- APPROVE from Telegram is the same approve as the page. It is refused when the list is unreadable, refused when the task is no longer waiting, and confirmed again above `confirmAbove`.
- CEO tasks run as drafts behind the read-only gate.
- No bot reads another bot's text as an instruction.
- Tokens never leave the local config and never reach a log or a prompt.

**Critical test scenarios** (a fake Bot API, no network):
- A stranger's message gets no answer. A wrong or expired code does not pair. The right code pairs, and only once.
- A draft with a 912 USD refund → a secretary message with the line, then APPROVE → "Send 912.00 USD?" → confirm → approve runs. A second APPROVE answers "already handled".
- REJECT → the owner's next message becomes the note, and the task reworks.
- `/task` in the Sales bot creates a Sales task, and its result comes back to the Sales bot.
- A goal plans 3 pieces in 3 departments. START creates 3 draft tasks, and the CEO reports when all 3 are done.
- A reminder set for 10:00 fires once at 10:00, and LATE once if the office was off.
- A 9,000 character result arrives as a document.
- Live (`CHECK_LIVE`, the owner's tokens): `node telegram.mjs` lists the bots, and a test message reaches the owner after pairing.

## Build plan

1. **Thread, the secretary and approvals**: `telegram.mjs` (the client, pairing, the lock), the config and its checks, waiting drafts pushed with buttons, approve, reject with the note, confirm above the amount, "already handled", the outcome edited into the message. AC-1, AC-2, AC-4, AC-9.
2. **Lead bots**: free-text chat through the existing handlers, `/task`, results and store events pushed to the right lead, documents for long results. AC-3.
3. **The secretary's day**: the morning brief, reminders on the clock, calendar through the connector with read back, inbox triage with hand-off buttons, office admin including triggers from chat. AC-5.
4. **The CEO**: goals (plan, START, follow, report), the weekly brief, questions about the whole business, the boardroom group. AC-6, AC-7, AC-8.

## Consequences

**Positive**: the office is in your pocket. Approvals stop waiting for your desk, goals replace hand-routing, and each role is a contact.

**Negative / tradeoffs**:
- Eight bots to create and eight tokens to keep.
- The office must be running for anything to happen. Telegram queues 24 hours, and a reminder or brief missed while off is sent LATE once.
- More Claude runs (CEO planning, briefs, triage) count against the plan.
- A lost phone with an open Telegram session can approve, which is what `confirmAbove` and Telegram's own passcode are for.

**Neutral**: four new modules or files, three data files, and one hook in `serve.mjs` where tasks change state.

## Migration plan

None. No `telegram` config means no bots, and the office works as today.

## Follow-up

- [ ] Voice notes (transcribe, then route as text).
- [ ] Per-lead approval chats as an option (the owner chose the secretary).
- [ ] Photos in (a receipt to Accounting, a product photo to Marketing).
- [ ] The CEO setting rules or triggers itself, which would need the owner's "yes" every time.
