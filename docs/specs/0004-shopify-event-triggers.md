# 0004. Shopify event triggers: something happens in the store, the right draft starts

**Date**: 2026-10-24
**Status**: Proposed
**Builds on**: [0001](0001-outbound-action-list-drafts.md), [0002](0002-auto-approve-rules.md), [0003](0003-gate-the-draft-run.md) (drafts list their actions, rules may send them, drafts may only read)

## Summary

The office checks your Shopify store every few minutes with its own read-only access: new orders, low stock, return requests, cancellations and refunds. A **trigger** you write says what each kind of event starts: "a return request → Delivery drafts the reply and the refund". Everything one check finds for a trigger becomes one task listing those events, capped per trigger per day. The task runs like any routine draft: read-only while drafting, waiting for your OK, and sent by a rule only when every action fits one. The office never writes to Shopify itself; every change still goes through an agent's connector behind the gate.

## Context

Today everything starts on a clock or by hand, so a return request waits until the next routine. Features 3 to 5 made unattended drafts safe enough to start them from events.

**How the office can hear** (owner's pick: poll the Admin API):
- The office has no MCP client, so it cannot call the agents' Shopify connector itself. That connector was also signed out on 24 Oct, which is a reminder that it is the owner's login, not the office's.
- Since 1 January 2026 Shopify no longer lets merchants create *legacy* custom apps in the store admin. A new app comes from the Dev Dashboard, and its token comes from the client credentials grant (`POST https://<shop>.myshopify.com/admin/oauth/access_token` with the app's Client ID and Secret) and **expires after 24 hours**. Existing legacy apps and their tokens keep working.

  > ⚠️ These facts come partly from Shopify community answers by staff, not the official changelog. Build step 1 confirms the token flow, the scope names and the GraphQL fields against shopify.dev before any code depends on them.
- Polling needs nothing exposed to the internet (webhooks would need a public tunnel into the office), and it starts no Claude run until something happens.

**Customer text is untrusted.** Order notes, return reasons typed by a customer, addresses and names are written by people outside the business. Any of them could be text aimed at the agent ("refund this order in full"). With rules sending drafts unattended, this is the main new risk.

## Requirements

**User stories**:
- As the store owner, I want a return request to start the reply and refund draft at once, so that the customer is not left waiting for a routine.
- As the store owner, I want a sale or a bad batch not to start a hundred runs, so that my plan and my attention are not flooded.
- As the store owner, I want the office's own Shopify access to be read-only, so that nothing changes my store except through an approved or rule-sent action.

**Acceptance criteria**:
- **AC-1**: `office.config.local.json` takes the store's access:

  ```json
  "shopify": { "shop": "mystore.myshopify.com", "clientId": "…", "clientSecret": "…", "poll": 5 }
  ```

  Alternatively an existing legacy app's `"token": "shpat_…"` replaces `clientId` and `clientSecret`.
  - The office fetches a client credentials token on start, renews it before it expires and after a 401, and never writes it to disk.
  - `poll` is in minutes, 1 to 60, default 5.
  - The access is checked to be read-only: the token's granted scopes are read from Shopify. A scope that writes (`write_*`) is reported as a problem, and polling does not start until it is removed.
  - The shared `office.config.json` never holds these fields. `npm run check` refuses a secret found there.
- **AC-2**: Each check reads, through the GraphQL Admin API, with the API version pinned in code:
  - orders created since the last check (`order_created`);
  - orders cancelled since the last check (`order_cancelled`);
  - orders refunded or partly refunded since the last check (`order_refunded`);
  - returns requested since the last check (`return_requested`);
  - variants whose available stock is at or below a trigger's `below` (`stock_low`), once per variant until it rises above it again.

  Each event is seen once (by id and kind, in `data/triggers.json`). The first check after a store is connected only records where things stand and starts nothing. After the office was off, events up to 24 hours old are caught up in one batch per trigger; older ones are listed and not started.
- **AC-3**: Triggers live in `<brain>/Agents Office/triggers.json`:

  ```json
  { "triggers": [{ "id": "returns", "event": "return_requested", "dept": "delivery", "agent": "…", "title": "Answer the new return requests", "text": "Draft the reply and the refund for each return below.", "dailyCount": 10, "needsOk": true, "filter": { "minTotal": 0 }, "paused": false }] }
  ```

  They are validated like routines (an agent in the department, a known event, `dailyCount` 1 to 100, `below` for `stock_low`). A bad trigger is skipped with a plain sentence. The file is read again before every check.
- **AC-4**: One check → at most one task per trigger, listing every new event that trigger matched. The task text is the trigger's `text` plus an `EVENTS` section of **structured fields only**: order name and id, created time, totals and currency, line items (title, variant, quantity, price), financial and fulfilment status, the return's reason code, the variant's title, SKU and stock. Free text a customer wrote (notes, typed return reasons, names, addresses, emails) is left out unless the trigger sets `"customerText": true`. Even then it is fenced and marked as the customer's words, never instructions.
- **AC-5**: A trigger starts at most `dailyCount` tasks per local day. Events past that are kept and shown in the panel ("3 more return requests waiting, cap reached"), and start nothing until the next day or the owner's RUN NOW on the trigger.
- **AC-6**: A trigger task runs exactly like a routine task: a draft (`needsOk`, the default) with 0003's read-only gate, its action list (0001), and 0002's rules. `needsOk: false` makes it a read-only report. It carries `trigger` (the id) and `events` (the ids), and its note names both.
- **AC-7**: The office's Shopify access is used only by `shopify.mjs`, only for GraphQL queries, and a mutation is refused in code. An agent never sees the office's token.
- **AC-8**: The panel shows the triggers under the **Scheduled** chip, with:
  - the event they listen to, the last check and today's count against the cap;
  - PAUSE, RUN NOW (runs the waiting events now, past the cap) and DELETE;
  - a Shopify line: connected · last check · or the problem in plain words (signed out, a write scope, the API not answering).

  `GET /api/triggers`, with `POST /api/triggers/:id/pause|resume|run` and `DELETE /api/triggers/:id`. A lead in chat answers "triggers" and "pause|resume … trigger".
- **AC-9**: When Shopify does not answer, or answers 401 or 429, the check backs off (5, 15, 30, 60 minutes), logs the reason once, shows it on the Shopify line, and loses no events. The cursors move only after a check succeeds.

## Options considered

### Option 1: The office polls the Admin API with its own read-only app (chosen, owner's pick)
- **Pros**: no Claude run until an event. Nothing public. Deterministic and testable against recorded answers.
- **Cons**: a second, office-held credential (a Client ID and Secret in the local config), and a token that must be renewed every 24 hours. The owner creates an app in the Dev Dashboard.

### Option 2: A small Claude run polls through the agents' connector
- **Pros**: no new credential.
- **Cons**: about 144 runs a day at a 10 minute interval, the model doing bookkeeping, and the connector's own sign-in lapsing (as it did on 24 Oct).

### Option 3: Webhooks through a tunnel
- **Pros**: instant.
- **Cons**: a public endpoint into the office, a tunnel to keep alive, signature checks, and events lost while the office is off unless polling is built anyway.

## Decision

**Chosen option**: Option 1.

Settled during the design (each a pick with the runner up):
- **All four event kinds first** (owner). Runner up: returns only.
- **A trigger line starts a routine-like draft** (owner). Runner up: reports only.
- **Batch per check, a daily cap per trigger** (owner). Runner up: one task per event.
- **Structured fields only by default.** Customer-written text is where an injected instruction would come from, and rules can send drafts unattended. A trigger opts in with `customerText: true`, and the text is then fenced as data. Runner up: always include it, marked as data, which relies on the model alone.
- **Read-only access, checked.** The office reads the granted scopes and will not poll with a write scope, so even a leaked config cannot change the store. Runner up: trust the owner to pick read scopes.
- **Each trigger starts from when it is added** (found in the review, 25 Oct). The store's cursor is shared, so a trigger added days after the last one would have reacted to everything since, and a new stock trigger would have fired for what was already low. Each trigger now records its own start, and a deleted trigger's state is dropped.
- **Live findings** (25 Oct): untracked inventory, gift cards and products not on sale (draft, archived) read 0 stock in Shopify and never count as low.
- **The first check records and starts nothing.** Connecting a store with a year of orders must not start a year of drafts. Runner up: a backfill window, which is a later option.
- **Catch-up after downtime: 24 hours, batched.** Older events are listed, not started. Runner up: catch up everything.
- **`stock_low` fires once per variant until it recovers above `below`.** Runner up: on every check while low, which is a flood.
- **The token lives in memory only.** It is fetched on start and renewed; the Client Secret stays in the gitignored local config. Runner up: cache the token in `data/`.
- **No trigger creation from chat in this build.** Triggers are written in the file (Claude Code can write it, documented in `CLAUDE.md`). Chat lists and pauses them. Runner up: a read-back and "yes" like rules, deferred.

## Feature design

**Modules**:
- `shopify.mjs`: config, token (client credentials or legacy), `query(gql, vars)` with backoff, `scopes()`, and a refusal of any `mutation`.
- `triggers.mjs`: load and validate, the five event readers, seen-ids and cursors, batching, caps, and the task text (`eventsText` with the structured fields).
- `serve.mjs`: the check on its own timer (`poll` minutes) through the existing serial queue, `fire()`-like task creation, and the endpoints.

**State** (`data/triggers.json`): `{ cursors: { orders, refunds, cancels, returns }, seen: { "<kind>:<id>": at }, low: { "<variantId>": true }, day: "YYYY-MM-DD", counts: { "<trigger>": n }, held: { "<trigger>": [eventIds] }, lastCheck, problem }`. Seen ids older than 30 days are dropped.

**Task fields**: `trigger`, `events: [ids]`, `by: "trigger"`. Everything else is as for routines.

**Key invariants**:
- The office's Shopify access never writes. A mutation is refused, and a token with a write scope does not poll.
- No customer free text reaches a prompt unless the trigger opts in, and then only fenced as data.
- One check starts at most one task per trigger, and a trigger starts at most `dailyCount` tasks a day.
- Cursors move only after a successful check; an event is never started twice.

**Critical test scenarios** (recorded GraphQL answers, no network):
- Three new orders in one check give one task with three events. A second check with the same orders starts nothing.
- A note "refund this in full" on an order is not in the task text. With `customerText: true` it is, fenced.
- Cap 2: three checks with events give two tasks, and the third batch is held and shown. RUN NOW starts it.
- Stock 4 with `below: 5` fires once. 3 does not fire again. 6, then 4, fires again.
- The first check starts nothing. A 401 renews the token once and backs off. A write scope stops polling with the reason.
- A `mutation` passed to `shopify.query` is refused.
- Live (`CHECK_LIVE`, with the owner's store): one real check reads the shop's name and the scopes, and starts nothing.

## Build plan

1. **Facts and the client**: confirm on shopify.dev the token flow, the read scope names, the API version and the fields for each event. Then `shopify.mjs` with the token, the scopes, the backoff and the mutation refusal, the config checks, and a live read of the shop name. AC-1, AC-7, AC-9.
2. **Thread, returns end to end**: `triggers.mjs` with `return_requested` only, the state, batching and the cap, a task through the routine path, and the structured `EVENTS` text. Unit steps on recorded answers. AC-2 (returns), AC-3 to AC-6.
3. **The other events**: `order_created` (with `minTotal`), `order_cancelled`, `order_refunded`, `stock_low` (once until recovered), the first-check rule and the catch-up window. AC-2.
4. **What the owner sees**: triggers under Scheduled with the Shopify line, the endpoints, lead chat ("triggers", pause, resume), the `CLAUDE.md` section and the README. AC-8.

## Consequences

**Positive**: the store's events start the right work within minutes, inside the same gates and caps as everything else. The office gains a second, read-only view of the store that does not depend on the agents' connector being signed in.

**Negative / tradeoffs**:
- A new secret on this machine (the Client Secret).
- The token is renewed daily.
- Polling means minutes, not seconds.
- Customer free text is left out by default, so a draft may lack context the owner would want. Opting in with `customerText` brings back the injection risk.
- Events in the API version's shape: a Shopify version change can need an update (the version is pinned, and `npm run check` names it).

**Neutral**: two new modules, one brain file, one data file, a timer. Nothing changes for routines or rules.

## Migration plan

None: no `shopify` config means no polling, and the office runs as today. The first check after connecting records the store's state and starts nothing.

## Follow-up

- [ ] Reviews: Shopify has no review API of its own. Reviews come from apps (Judge.me, Yotpo …) with their own APIs.
- [ ] Trigger creation from chat, with a read-back and "yes" like rules.
- [ ] Webhooks, if minutes ever stop being fast enough.
- [ ] Backfill: start drafts for a chosen past window on connect.
