# Agents Office — for Claude Code

You are in the Agents Office repo. The owner will most often ask you to change **who the agents are and what they do**, to teach an agent **how a kind of work is done** (a brief or a skill), to put something **on the timetable** (a routine), or to change **which connectors the agents may use**. Do that by editing the JSON files and skill folders described below. Do not touch `src/`, `serve.mjs` or the build for those requests.

## Changing the agents

The roster lives in `office.agents.json` (shipped defaults) and `office.agents.local.json` (the owner's copy, ignored by git). **Always write to `office.agents.local.json`**: if it does not exist, create it with `{"agents": []}` and add only the agents you are changing. Never edit `office.agents.json` unless asked to change the shipped defaults.

Each agent looks like:

```json
{ "id": "newt", "department": "marketing", "lead": false,
  "name": "NEWSLETTER", "role": "Newsletter Creator Agent",
  "does": "Writes the monthly newsletter your signups actually open.",
  "tools": ["beehiiv", "loops"],
  "brief": "Five bullets and a pull quote. Subject lines under 40 characters. Never open with the company name." }
```

You may change **name, role, does, tools, brief, model**. Keep `name` short and upper case (it is the label on the desk). `does` is what the agent reads about itself before every task, so write it as a job description in one or two sentences. `tools` names the connectors this agent usually reaches for (match the names shown in the top bar, lower case). `brief` is the owner's standing instructions to that one agent, read before every task and chat turn: up to 2,000 characters, a string or a list of lines. Anything longer, or anything with steps and a template, is a skill (next section). `model` is `sonnet`, `opus` or `fable`, or empty for the office default (Sonnet); set it only when the owner names one — a task or a routine can still set its own above it. `effort` is `low`, `medium`, `high`, `xhigh` or `max`, or empty for the office's setting and then the model's own (Opus runs at high); same rule, same precedence.

The roster is read in this order, later wins: `office.agents.json` → `<brain>/Agents Office/agents.json` → `office.agents.local.json`. The brain is the folder named by `brain` in `office.config.json` (or `office.config.local.json`, which wins). If the owner keeps their roster in the brain, write there instead of the local file.

Fixed, and the office ignores edits to them: `id`, `department`, `lead`. There are **six departments and 35 seats** and that is the office. Do not add or remove agents, departments or pods. When the owner wants a new kind of agent, **rename a seat** in the right department. When they want fewer, leave the seat as is; an idle agent costs nothing.

Department keys: `emails` (5 seats) · `sales` (6) · `marketing` (7) · `ops` (6) · `fin` (4) · `delivery` (7). Every department has a lead (Emails, Sales, Marketing, Operations, Accounting, Delivery) and the lead stays the lead.

After editing: run `npm run check` (it validates the roster and prints every problem), then tell the owner to restart the office (`npm start`). Names, roles and descriptions update on the next page load.

## Teaching an agent how a task is done (skills)

When the owner says "this is how we do X", "make the agent do it this way", "here is our SOP / template / an example I was happy with", or asks why the deliverables are generic, the answer is a **skill**. A skill is a folder with a `SKILL.md` and the files beside it, the same shape as a Claude Code skill. Full guide: `SKILLS.md`. Read it once before writing your first one.

**Where to write it:** `<brain>/Agents Office/skills/<name>/SKILL.md`, where `<brain>` is the folder from `office.config.local.json` → `office.config.json` (`brain`, default `./brain`). Create the folders if they do not exist. Never write the owner's skills into the repo's `skills/` folder; that holds the shipped examples and `git pull` would fight them. A skill of the same name in the brain replaces a shipped one.

**Decide brief or skill first.** Fits in a paragraph with no steps and no template → a `brief` on the agent. Has steps, a shape, rules, or a document to copy → a skill.

**What you need before writing.** The trigger (which tasks this covers), the source material (an SOP, an example, the owner's description), the shape of the finished thing, and the rules. If the owner gave you a document, read it in full first. If one of these is missing, ask one question for it; do not invent the owner's process.

**The folder:**

```
<brain>/Agents Office/skills/proposal/
  SKILL.md       front matter + instructions (under 6,000 characters)
  template.md    the shape of the finished thing, headings kept
  example.md     one real one the owner was happy with (optional, strip anything private the owner did not hand you)
```

**SKILL.md:**

```markdown
---
name: proposal
description: How we write a client proposal
agents: [piper]
---
# Writing a proposal
Use this for any request that ends in a document a client says yes or no to.   ← the trigger, first line

## Before you write
1. …what to read first, by note name (`10-Business/offer-ladder.md`)…
## The shape
Follow `template.md` beside this file, section for section.
## Rules
- short, absolute, one per line
```

**Binding.** `agents: [id, id]` for one or more agents (ids from `office.agents.json`; pick the seat whose `does` matches, and say which one you chose). `departments: [emails]` for a whole department (`emails`, `sales`, `marketing`, `ops`, `fin`, `delivery`). Neither binds it to every agent; only do that for a house style, and say so. Unknown ids are refused and a skill with no valid binding is skipped.

**Limits the loader enforces:** `SKILL.md` body 6,000 characters; each file beside it 4,000, all files together 8,000. Readable files are `.md .txt .csv .json .yaml .html`; anything else is listed by name only. Long reference material goes into the brain as ordinary notes, which the agent reads when the task calls for them; the skill just names them.

**Writing rules.** The first line after the heading says when the skill applies. Steps, then shape, then rules. Point at notes by name. Rules are short and absolute. One skill per kind of work. Never put a number in a skill that should come from the numbers ledger; say where it comes from instead.

**After writing:** run `npm run check` (it lists every skill, its binding and every problem in plain sentences; fix what is red). Skills and briefs take effect on the next task with no restart. Tell the owner: the folder path, which agent it is bound to, and one task to type to try it. Suggest they read the result and send it back with `revise: …` from the chat; when a correction is one they will want every time, fold it into the skill.

**Reading skills back.** http://localhost:4520/api/skills (server running) or `node -e "import('./skills.mjs').then(async m=>console.log(JSON.stringify(m.loadSkills((await import('./config.mjs')).loadConfig().brainPath,(await import('./roster.mjs')).loadRoster().agents).summary(),null,1)))"`.

## Lessons and the set-up interview

Two more things the office writes into the brain on its own. Both are plain files you may edit when the owner asks.

- **Corrections** — `<brain>/Agents Office/feedback/<agent-id>.md`. Every `revise: …` the owner sends lands here, sorted into "## Standing rules" (read by that agent before every task) and "## One-offs". One line each, `- date · rule ← "what the owner said" (task)`. When the owner says "fold the lessons into the skill", "make that a rule", "forget that", or "the agent keeps doing X": read this file, move the durable preferences into the agent's skill (or its `brief` if there is no skill) as short absolute rules, and delete the lines you moved so they are not said twice. Never invent a rule the owner did not give.
- **The interview** — the department lead's chat runs it when the owner says "set up" (`onboard.mjs`). It writes briefs into `<brain>/Agents Office/agents.json` and one skill into `<brain>/Agents Office/skills/<name>/`. An earlier skill of the same name is kept beside it as `SKILL.md.backup-<time>`; if the owner asks you to tidy up, merge what is worth keeping and delete the backup. `data/interviews.json` holds an interview in progress; delete it if one is stuck.

## Routines: tasks on the office's own clock

When the owner says "every Monday …", "each morning …", "on a schedule", "automatically at …", "make X happen every …", that is a **routine**: a task the office fires by itself at that time and runs without anyone typing. **Every department can have routines** (`emails`, `sales`, `marketing`, `ops`, `fin`, `delivery`; the list is `ROUTINE_DEPTS` in `src/data.js`).

**Where:** `<brain>/Agents Office/routines.json` (`<brain>` as above). Create it with `{"routines": []}` if it does not exist. Never write routines anywhere else.

```json
{ "id": "overdue-reminders", "dept": "fin", "agent": "invo",
  "title": "List the overdue invoices and draft the reminders",
  "text": "List the overdue invoices and draft the reminders. Xero read, Gmail drafts.",
  "when": { "kind": "weekly", "days": [1], "at": "09:00" },
  "needsOk": true, "paused": false }
```

- `id` short, unique, lower-case. `dept` one of the six. `agent` an id from the roster in that department; pick the seat whose `does` matches, and say which one you chose.
- `text` is what the agent is asked to do, written as the owner would type it. `title` is the card on the board (under 90 characters).
- `when`: `{"kind":"daily","at":"HH:MM"}` · `{"kind":"weekdays","at":"HH:MM"}` · `{"kind":"weekly","days":[1,4],"at":"HH:MM"}` (0 = Sunday) · `{"kind":"hourly","every":1,"from":"09:00","to":"17:00","weekdaysOnly":true}` · `{"kind":"minutes","every":2}` (filming only). Times are the machine's local clock, 24-hour.
- `when.start`: `"YYYY-MM-DD"`, optional (V3.2.1) — the routine starts on that date and never fires before it ("from next Monday", "starting 5 October"). Leave it out to start now. The owner can also set one by clicking a day in the calendar (P) with REPEAT on.
- `needsOk` (default true): the result waits in WAITING ON APPROVAL for the owner's tick before the agent sends, pays or changes anything. Leave it on unless the routine only reads and reports (a triage, a list, a reconciliation), and say which you chose and why.
- `paused: true` keeps it on the timetable without firing.
- `model`: `sonnet`, `opus` or `fable`, only when the owner names one; otherwise leave it out and the agent's or the office's model applies (the task beats the routine beats the agent beats the office).
- `effort`: `low`, `medium`, `high`, `xhigh` or `max`, only when the owner names one; otherwise the agent's, then the office's, then the model's own.
- `team: true` when the owner wants the whole department on it ("as a team", "get the team to …"): the department lead owns the routine (set `agent` to the lead's id; a specialist id is moved to the lead), plans the pieces when it fires, the desks work at once, the lead writes the final. Leave it out for a one-desk routine — a team costs two to four runs plus the lead's two.

The server re-reads the file every 20 seconds, so a routine lands without a restart; its next run is computed from the moment it is read. Run state (next run, last run) lives in `data/routines.json`, never in the brain file. After writing: run `npm run check` (it validates every routine and names every problem: unknown agent, wrong department, incomplete schedule, duplicate id), then tell the owner the title, the schedule in words, which agent has it, whether it waits for their OK, and that it shows under the SCHEDULED chip with a RUN NOW button to try it straight away.

## Auto approve rules: small, safe actions go out without waiting (store fork, spec 0002)

When the owner says "auto approve refunds under $30", "let replies from the order status routine go out on their own", "stop waiting for me on …", that is a **rule**. A draft that waits for the OK lists its outbound actions (kind, to, amount, tool); when **every** action fits a rule with room left under the rule's daily cap, the office sends it by itself through the same gated run as APPROVE. Anything else waits as before, and the card says why. A draft the owner sent back with REJECT always waits for them after its rework.

**Where:** `<brain>/Agents Office/approvals.json`. Create it with `{"paused": false, "rules": []}` if it does not exist. Never write rules anywhere else.

```json
{ "paused": false, "rules": [
  { "id": "small-refunds", "title": "Small refunds", "kinds": ["refund"], "max": 30, "currency": "USD", "dailyMax": 200, "depts": ["delivery"] },
  { "id": "order-status-replies", "title": "Order status replies", "kinds": ["reply", "email"], "routines": ["order-status"], "tools": ["mcp__claude_ai_Gmail__send_message"], "dailyCount": 20 }
] }
```

- `kinds` from: `email`, `reply`, `post`, `refund`, `discount`, `payment`, `order_update`, `product_update`, `inventory`, `message`, `other`.
- **Every rule has a daily cap.** `refund` and `payment` need `max` (per action), `currency` and `dailyMax` (per day). Any other kind needs `dailyCount`. A `discount` also needs `maxPercent` or `max`. A rule without its cap is skipped.
- Optional narrowing: `depts`, `routines` (routine ids from `routines.json`), `tools` (exact `mcp__` names), `to` (recipient patterns, `*` as a wildcard). Use them: "order status replies" means the routine and the tool, because a rule cannot read what a message says.
- `paused: true` on a rule, or on the file, stops it.
- Never write a rule the owner did not ask for, and never widen one (a higher cap, more kinds) without the owner saying so. Read the number back to the owner in the reply.

After writing: run `npm run check` (it validates the file and names every bad rule), then tell the owner the rule in words, its caps, and that it shows under the **Waiting** chip with PAUSE. A rule takes effect on the next draft; no restart. The owner can also say it to a department lead in chat ("auto approve …", "rules", "pause … rule", "pause auto approvals").

## Store triggers: an event in the Shopify store starts the work (store fork, spec 0004)

When the owner says "when a return is requested, …", "on every new order over $200, …", "when stock runs low, …", that is a **trigger**: the office checks the store every few minutes (its own read-only app, `shopify` in `office.config.local.json`) and an event starts a task for a desk, run like a routine draft (read-only while drafting, its action list, the owner's OK or a rule).

**Where:** `<brain>/Agents Office/triggers.json`. Create it with `{"triggers": []}` if it does not exist. Never write triggers anywhere else.

```json
{ "triggers": [
  { "id": "returns", "event": "return_requested", "dept": "delivery", "agent": "dlead", "title": "Answer the new return requests",
    "text": "Draft the reply and the refund for each return below.", "dailyCount": 10, "needsOk": true },
  { "id": "low-mugs", "event": "stock_low", "dept": "ops", "title": "Restock note for low stock", "text": "Draft the restock note for these.", "below": 5, "dailyCount": 3 }
] }
```

- `event`: `order_created` · `order_cancelled` · `order_refunded` · `return_requested` · `stock_low` (needs `below`: fire at or below that stock, once per variant until it recovers).
- `dept` one of the six; `agent` an id in that department (left out: the lead). `text` is what the desk should do with the events, written as the owner would say it.
- `dailyCount` (1–100, default 10): at most that many tasks a day; one check starts at most one task per trigger, listing every new event. Past the cap, events are held for tomorrow or RUN NOW.
- `filter.minTotal`: only orders at or above that total.
- `needsOk` (default true): the task waits for the owner's OK; false makes it a read-only report.
- `customerText: true` lets the customer's own words (order notes, typed return reasons) into the task, fenced as data. Leave it off unless the owner asks: that text is where a planted instruction would come from.
- `paused: true` keeps it without firing.

The office never writes to Shopify itself; the access must be read-only (`read_orders`, `read_products`, `read_inventory`, `read_returns`). The Client ID and Secret go in `office.config.local.json` only, never in `office.config.json`. `node triggers.mjs` tests the connection read-only and starts nothing. The first check after a store is connected records where things stand and starts nothing.

After writing: run `npm run check`, then tell the owner the trigger in words (the event, the desk, the cap, whether it waits for their OK) and that it shows under the **Scheduled** chip with PAUSE and RUN NOW. A trigger takes effect on the next check; no restart. A lead in chat answers "triggers" and "pause … trigger".

## A task for a date (the calendar)

When the owner says "on Friday, …", "next Tuesday at 10, …", "on the 5th, …" for a one-off (not "every"), that is a **scheduled task**, not a routine. The office does these itself: the owner clicks the day in the calendar (P), or the page posts `{ "dept", "text", "at": <ms or ISO> }` to `/api/tasks`. There is no file to write for them (they live in `data/tasks.json`, state `scheduled`, fired by the server's clock); tell the owner to press P and click the day, and say what to type.

## Changing the connectors

The top bar shows the MCP servers **this machine's Claude Code** is connected to (`claude mcp list`). To add one: `claude mcp add …` or connect it in claude.ai; the office picks it up on restart. To decide what the agents may call, edit `office.config.json` (or `office.config.local.json`):

```json
"mcp": {
  "allow": [],
  "deny": ["Stripe"],
  "departments": { "Slack": ["emails", "ops"] }
},
"tools": { "web": true, "browser": true },
"teams": { "enabled": true, "max": 4 }
```

`allow` empty means every connected server. `deny` keeps a server in the bar but out of the agents' hands (`"Chrome"` works there too). `departments` says which pods a server is wired to; unknown servers default to every pod. `tools.web` gives the agents web search. `tools.browser` (V3.2 (16 Sep)) gives them the owner's own Chrome through Claude Code's Chrome integration — the run starts with `--chrome` and gets the `claude-in-chrome` server (open tabs, read pages, fill forms on sites the owner is signed in to); it needs the Claude in Chrome extension paired to this machine (`claude --chrome` once) and the Claude Code login. The bar shows a Chrome tile wired to every pod. `teams` (V3.2 (16 Sep)) is Agent Teams: `enabled` shows the TEAM button and makes "as a team" mean it; `max` caps the desks (2–6, default 4).

**Drafts and read-only routines may only read (store fork, spec 0003).** Those runs go through a call gate in read mode: a tool whose name reads (list, get, search …) passes, a write tool or one the office cannot place is blocked, and Chrome may look but not click or type. When the owner says "the drafts can't use X" or "X is a read tool", fix its class in `office.config.json` (or the local copy):

```json
"gate": { "read": ["mcp__plugin_small-business_shopify__run-analytics-query"], "write": ["mcp__claude_ai_Canva__get-*"] }
```

Full tool names, `*` as a wildcard; `write` beats `read`, and both beat the name. Only mark a tool `read` when it truly cannot send, post, pay or change anything. `node toolclass.mjs` prints every known tool with its class and why (`--write` for the blocked ones); `npm run check` names a pattern that matches nothing. Takes effect on the next run, no restart.

Agents get only connected servers (plus web when enabled, plus the browser when enabled and paired). They never get Bash, file tools or sub-agents. Their standing rule: read freely; send, post, pay, delete or change data outside this machine **only** when the owner's task explicitly asks for that exact action — in the browser too.

## Agent Teams

When the owner says "as a team", "get the team on it", "spawn three teammates to …", or presses TEAM in the bar, the department **lead** takes the task and splits it into two to `teams.max` independent pieces on the desks whose `does` or skills fit; the pieces run at the same time, one Claude process each; teammates may leave one-line notes (`@lead: …`, `@<id>: …`) which reach the lead; the lead writes the final from the pieces. This is the office's own build of the shape (lead · teammates · shared piece list · notes) from separate headless Claude sessions — Claude Code's own agent teams only spawn in an interactive terminal, so they are not what runs here. Nothing to write for a team task; it is the same roster, briefs and skills. To make a seat a better teammate, improve its `does` (the lead splits by it) and its skills. A team routine is `"team": true` in `routines.json` with the lead as `agent`.

## Everything else

- `npm run check` is the loop. Run it after any change to code; fix what is red.
- `README.md` says what the product does. Keep it true to the code.
- Release: `node scripts/release.mjs --push` (owner only).

## Changing the code (store fork)

Code changes follow AGENTS.md:

@AGENTS.md
