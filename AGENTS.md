# Agents Office (store fork)

A fork of Agents Office (Sahni.ai) on the `store` branch, changed to run one Shopify store. `upstream` is github.com/ajsahni/agents-office. `CLAUDE.md` above this import is the author's guide for owner requests (roster, skills, routines, connectors); this file is for changing the code.

## Stack

- **Language / Runtime**: plain JavaScript ES modules, Node 20+ (no TypeScript, no framework)
- **Server**: `serve.mjs` on `node:http`, one process, JSON files for storage (`data/*.json`)
- **Agents**: every run is a headless `claude -p` spawned from `serve.mjs` (`askX`), or the Anthropic SDK when `ANTHROPIC_API_KEY` is set
- **Page**: Three.js scene bundled by esbuild into one file, `dist/command-centre-v2.html`
- **Key dependencies**: three, esbuild, d3-force, playwright-core (checks only)
- **Package manager**: npm

## Build approach

Tracer Bullet (each feature runs end to end through server, page and checks before the next one starts). Scope: `docs/scope/scope.md`.

## Commands

```bash
# Install
npm install
# Dev server (http://localhost:4520)
npm start
# Build (rebuild after any change under src/ or the brain)
node build.mjs
# Test: build, unit steps, browser smoke, server smoke. Exit 1 on any red line.
npm run check
# Live check with real Claude runs (PowerShell: $env:CHECK_LIVE='1'; node check.mjs)
CHECK_LIVE=1 node check.mjs
```

## Specs

Stored in `docs/specs/`. Format: `docs/specs/NNNN-title.md`.

## Rules

- `npm run check` is the only test suite. A feature adds `step('area: what it proves', ...)` lines to `check.mjs`; there is no other test runner.
- Problems are plain sentences collected into a `problems` list and shown, never thrown. Bad config entries are skipped with a reason, not fatal.
- Owner state never lives in the repo: `*.local.json` (gitignored) and `<brain>/Agents Office/` (routines, skills, feedback, notes). Run state lives in `data/`.
- Agents get MCP tools, web and the browser only. `askX` always disallows Bash, file tools and subagents, and runs in an empty temp folder. Keep it that way.
- Anything outbound (send, post, pay, change) waits for the owner unless the task asked for that exact action (`needsOk`, `modeLineFor`).
- Comments tag the version and date that added a behavior (`// V3.5 routines`). Follow that habit for fork changes with a `STORE` tag so upstream merges stay readable.
- Keep the Sahni.ai mark, the licence line and the notices. The fork says it was changed and by whom.
- Prefer new modules and small edits over rewrites of `serve.mjs` or `src/main.js`: upstream ships often and every changed line is a future merge.

## Gotchas

- Department lists repeat in several places: `src/data.js` (`DEPTS`), `routines.mjs` (`ALLOWED`, `NAMES`), `src/tasks.js` (`RT_DEPTS`, `RT_NAMES`), the MOC map in `serve.mjs` `relevantNotes`, and asserts in `check.mjs`. Change them together.
- 35 seats are hardcoded: `src/data.js` grid slots, `roster.mjs`, `check.mjs` asserts and the startup log.
- Three browser smoke steps ("command bar adds a task", "TEAM in the bar", "department focus opens the chat rail") use fixed waits and fail at random on this machine. Rerun before you debug them.
- `./setup` is Bash only; on Windows use `npm install && node build.mjs && npm start`.

## Context files

- [src/AGENTS.md](src/AGENTS.md): the page, its demo and live modes, and the 3D scene

_Drafted by /audit from the repo, worth a quick human pass. Edit freely: once a line stops matching this draft, later runs treat it as curated and will flag rather than overwrite it._
