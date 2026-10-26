# 0006. The Automations screen: routines, triggers and rules in one place

**Date**: 2026-10-26
**Status**: Implemented
**Builds on**: [0002](0002-auto-approve-rules.md), [0004](0004-shopify-event-triggers.md), and the V3.5 routines

## Summary

One screen, **AUTOMATIONS** (key **A**, or the ⚡ AUTOMATIONS button in the top bar), for everything the office does without being asked: routines, store triggers and auto approve rules. It has a list and an editor, and lets the owner make, change, pause, run now and delete each one without opening a JSON file.

## Context

Before this, the panel's Scheduled and Waiting chips could pause, run and delete these things, but nothing could make or change a trigger or a rule except a hand edit, Claude Code, or (for rules) a sentence in a lead's chat. A routine could be made from the bar, but not moved to another desk or made a team routine. A broken entry in a file showed up only in `npm run check` and the terminal.

## Decisions

- **One screen, three tabs**, built like the calendar (an overlay with the same band, chips and buttons) and wired in `tasks.js` next to it. It is a new module (`src/automations.js`) so `main.js` and `tasks.js` change by a few lines.
- **The same files.** The screen writes `routines.json`, `triggers.json` and `approvals.json` in the brain through `/api`. The chat, Claude Code and the screen all edit the same files, so they cannot disagree.
- **Checked as typed, checked again on save.** The pure checks for rules and triggers moved to `src/rules.js` and `src/triggerdefs.js`, and `approvals.mjs` and `triggers.mjs` re-export them. The form shows the same sentences as the server and `npm run check`, in both live and demo mode. A routine edit is now checked as a whole and refused with its problems. Before, a bad schedule was dropped without a word.
- **A rule is read back before it turns on**, as in the lead's chat: the form sends `dry: true`, shows the rule in words, and saves only on TURN IT ON. An edit that lets more through (a higher cap, a new kind, a dropped scope, switched back on) names each widening (`widens()` in `src/rules.js`).
- **Ids never change on edit**, so a trigger's run state (when it was added, today's count, held events) and a rule's ledger carry over. A new id is the title's slug, made unique against every entry in the file, broken ones too. `pause` and `resume` are never given to a rule.
- **A routine made with a desk and a title needs no Claude run.** Without them, Claude names what is missing, as before.
- **Customer words on a trigger** can be switched on in the form, with the warning from spec 0004 shown beside the switch.

## API

| Call | Does |
|---|---|
| `POST /api/triggers` | Make a trigger. Body: the trigger's fields; `dry: true` only checks |
| `POST /api/triggers/:id` | Replace that trigger (same id) |
| `POST /api/approvals` | Make a rule; `dry: true` returns `{ rule, desc }` and writes nothing |
| `POST /api/approvals/:id` | Replace that rule; the answer carries `widens` |
| `POST /api/routines` | Now also takes `title` and `team`; with `agent` and `title` there is no Claude run |
| `POST /api/routines/:id` | Now also takes `dept`, `agent` and `team`; a bad edit is a 400 with `problems` |

A bad body is a 400 with `error` (plain sentences) and `problems`; an unknown id is a 404. The trigger and rule writes take `content-type: application/json` only (else 415): a `text/plain` POST needs no CORS preflight, so any web page open in the owner's browser could otherwise write a rule that sends money unattended. `GET /api/approvals` also returns the office `currency`, the default for a new money rule.

## Acceptance

- A opens the screen; Esc or A closes it; MANAGE on the panel's Shopify and rules rows opens it at that tab.
- A routine, a trigger and a rule can each be made, changed, paused, run now (where it applies) and deleted from the screen, live and demo.
- A form names what is missing before save; the server refuses the same things by name.
- A rule turns on only after it is read back; a wider edit says how.
- Entries a file holds but the office skipped are named at the top of their tab, with the file.
- `npm run check`: one unit step, one browser smoke step, one server step.
