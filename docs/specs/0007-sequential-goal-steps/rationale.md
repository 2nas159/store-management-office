# 0007. Sequential CEO goal steps: a step starts when the steps before it are approved · rationale

The decision record behind [index.md](index.md): why it was built this way. The build spec lives in index.md.

## Context

A goal is planned in `team.mjs` `planGoal`: one Claude call returns up to six pieces, at most one per department, and START (`goalButton`) creates a draft task for every piece in one loop (`team.mjs:263`). `goalProgress` runs from `notify` (`team.mjs:118`), and only for a task whose state is `done` (the return at `team.mjs:107` comes first), only when the owner is paired, and only after the Telegram messages for that task were sent. Goals live in `data/goals.json`. They exist only on Telegram; the page shows a goal piece as an ordinary task tagged "CEO goal", and the owner can approve, reject or delete it there.

Real store work is a chain. A product launch is Operations picks the product → Sales prices it → Sales writes the copy → Delivery lists it. Run in parallel, Sales prices nothing and Delivery lists a product nobody chose. The one per department limit also makes the chain impossible, because Sales appears twice.

The owner's standing rule: anything that pays money needs the owner's OK, at any amount. Two existing paths make "approved" weaker than "sent": when the office stops in the middle of a send, `actions.closeOut` (`actions.mjs:186`) marks the task `approved`, without `error`, and every unseen action `unknown`; and a send run that ends cleanly can still leave single actions `failed` or `not_done` (`serve.mjs:447`). When a send run throws early, the task ends `done` with `error` and no `approved` (`serve.mjs:500`), which looks the same as a failed draft. A chain that moves on, or offers a retry, on any of these could repeat or build on a payment the owner never saw succeed.

An earlier step's output is model text, and part of it may come from customers (order notes, return reasons, tool error text), so it can carry an instruction aimed at the next agent. The single run queue that made long chains block approvals was split into a work lane and a send lane on 30 Oct (`lanes.mjs`).

## Options considered

### Option 1: Dependencies in the goal, state worked out from the tasks (chosen)

Each piece stores only its dependencies and its task ids. A small pure function works out each piece's state from its task every time it is asked, and decides what can start.

**Pros**:
- Lives where goals already live (`team.mjs`, `data/goals.json`); no new store.
- The state can never drift from the tasks: a task approved, reworked or deleted on the page is seen as it is.
- Parallel where the plan allows, sequential where it must be; unit testable without Telegram.

**Cons**:
- A chain exists only inside a goal; a store event cannot start one (spec 0008, `nextTask`).
- The state is computed on every pass and every minute; cheap at six pieces, but it is a scan of the task list.

### Option 2: Dependencies with a stored state per piece

The same, but each piece keeps `state` (`blocked`, `running`, `finished` …) in `data/goals.json`, updated as tasks change.

**Pros**:
- The state is readable in the file without the task list.

**Cons**:
- It drifts: any task change that does not pass through the update (a page delete, a restart closeout, a missed notify) leaves a wrong state, and every such path needs its own fix.

### Option 3: Always strictly in order

Piece 2 waits on 1, 3 on 2, and so on. No `after`.

**Pros**:
- Nothing to validate.

**Cons**:
- Independent work waits for no reason; a six step goal takes six approval rounds in a row.

### Option 4: A general follow up on any task (`nextTask`)

An approved task queues the next task itself; goals become a special case.

**Pros**:
- Also serves store event chains.

**Cons**:
- A larger feature with its own loop and safety questions; the owner chose to keep it as spec 0008.

## Rationale

The problem is ordering inside a goal, and the goal already owns its pieces and its progress hook, so the fix belongs there. Storing a state per piece (Option 2) was the first draft of this spec; the cross check showed how many paths change a task without passing through the goal (a page delete, the restart closeout, a notify that returns early), and each would leave the stored state wrong. Working it out from the task each time removes that whole class of bug for a scan of at most six tasks.

"Finished" means sent, not approved, because of the owner's money rule: a send the office cannot vouch for (stopped halfway, an action failed or unknown) stops the chain and goes to the owner with CONTINUE or WAIT, and a retry is offered only where nothing was ever sent. A durable marker on the task when a send starts (`sendStartedAt`) is what tells those two apart, since an early throw looks like a failed draft otherwise. Strict order (Option 3) would be simpler but makes every goal a slow line of approvals; `nextTask` (Option 4) is wider than this problem and is its own spec.

