// Agents Office — is a tool a read or a write? (STORE, spec 0003: docs/specs/0003-gate-the-draft-run.md)
// Shared by the gate (gate.mjs, at call time), the server and `node toolclass.mjs`; pure JS, no DOM or Node APIs.
// The CLI reports tools by name only, so the name decides, after the owner's own lists in office.config.json:
//   "gate": { "read": ["mcp__…__graphql_query", "mcp__claude_ai_Notion__*"], "write": [...] }   ← * is a wildcard; write beats read
// By name: strip mcp__<server>__, split into words. A strong write word anywhere → write (get_or_create_x). Otherwise the
// first verb decides: a read word → read; a word that is also a noun (post, schedule, record …) → write only in first place
// (create_post write, list_post_templates read). No verb at all → unknown, which counts as WRITE: the gate fails closed.
export const READ_VERBS = ['list', 'get', 'search', 'read', 'find', 'query', 'fetch', 'describe', 'lookup', 'look', 'count', 'check', 'show', 'view', 'inspect', 'explain', 'compare', 'aggregate', 'suggest', 'validate', 'download', 'resolve', 'introspect', 'help', 'guide', 'info', 'status', 'summary', 'summarize', 'preview', 'analyze', 'analyse', 'calculate', 'estimate', 'poll', 'browse', 'scan', 'diff', 'retrieve', 'whoami', 'me'];
export const WRITE_VERBS = ['send', 'create', 'update', 'delete', 'publish', 'pay', 'refund', 'cancel', 'archive', 'move', 'trash', 'untrash', 'unlabel', 'unmark', 'set', 'add', 'remove', 'upload', 'reply', 'forward', 'execute', 'edit', 'restore', 'reset', 'rotate', 'revoke', 'apply', 'generate', 'start', 'stop', 'pause', 'resume', 'respond', 'bulk', 'batch', 'complete', 'finalize', 'provision', 'enable', 'disable', 'register', 'approve', 'accept', 'reject', 'buy', 'purchase', 'switch', 'save', 'write', 'attach', 'connect', 'disconnect', 'duplicate', 'kill', 'stage', 'extend', 'authorize', 'activate', 'deactivate', 'invalidate', 'retry', 'recover', 'rerequest', 'upsert', 'patch', 'put', 'assign', 'unassign', 'mutation', 'mutate', 'insert', 'drop', 'replace', 'rename', 'submit', 'sign', 'invite', 'subscribe', 'unsubscribe', 'capture', 'void', 'fulfill', 'adjust', 'increment', 'decrement', 'toggle', 'install', 'uninstall', 'login', 'logout', 'transcribe', 'autofill', 'resize', 'separate', 'convert', 'clear', 'empty', 'purge', 'erase', 'wipe', 'grant', 'deny', 'confirm', 'dismiss', 'sell', 'remind', 'notify', 'dial', 'reserve', 'compose', 'tune', 'train'];
export const NOUN_VERBS = ['post', 'schedule', 'record', 'order', 'comment', 'label', 'tag', 'block', 'share', 'copy', 'issue', 'request', 'draft', 'export', 'mark', 'note', 'like', 'follow', 'reaction', 'react', 'pin', 'star', 'flag', 'report', 'review', 'test', 'compute', 'index', 'process', 'translate', 'crawl', 'run', 'merge', 'deploy', 'trigger', 'import', 'change', 'sync', 'push', 'commit', 'open', 'close', 'return', 'design', 'book', 'lock', 'claim', 'fill', 'ship', 'charge', 'transfer', 'deliver'];
// Chrome (mcp__claude-in-chrome__*) in a read-only run: look, don't touch
export const BROWSER = 'claude-in-chrome';
export const LOOK = ['tabs_context_mcp', 'tabs_create_mcp', 'tabs_close_mcp', 'navigate', 'read_page', 'get_page_text', 'find', 'read_console_messages', 'read_network_requests', 'list_connected_browsers', 'shortcuts_list'];
export const LOOK_ACTIONS = ['screenshot', 'zoom', 'scroll', 'scroll_to', 'wait', 'hover'];
const R = new Set(READ_VERBS), W = new Set(WRITE_VERBS), N = new Set(NOUN_VERBS);
export const glob = (pat, s) => new RegExp('^' + String(pat).split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(String(s));
export const words = name => String(name).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const split = full => { const m = /^mcp__(.+?)__(.+)$/.exec(full); return m ? { server: m[1], tool: m[2] } : { server: null, tool: full }; };
/** → { cls: 'read' | 'write', why, unknown? }. input: the call's input (only Chrome's computer tool needs it). gate: the owner's { read, write } */
export function classify(full, { read = [], write = [] } = {}, input = null) {
  if (write.some(p => glob(p, full))) return { cls: 'write', why: 'yours: write' };
  if (read.some(p => glob(p, full))) return { cls: 'read', why: 'yours: read' };
  const { server, tool } = split(full);
  if (server === BROWSER) {
    if (LOOK.includes(tool)) return { cls: 'read', why: 'Chrome: looks' };
    if (tool === 'computer') return input && LOOK_ACTIONS.includes(input.action) ? { cls: 'read', why: `Chrome: ${input.action}` } : { cls: 'write', why: input ? `Chrome: ${input.action || 'an action'} touches the page` : 'Chrome: looks only for ' + LOOK_ACTIONS.join(', ') };
    return { cls: 'write', why: 'Chrome: touches the page' };
  }
  const ws = words(tool);
  const strong = ws.find(w => W.has(w)); if (strong) return { cls: 'write', why: `name: ${strong}` };
  const first = ws.find(w => R.has(w) || N.has(w));
  if (first && R.has(first)) return { cls: 'read', why: `name: ${first}` };
  if (first) return { cls: 'write', why: `name: ${first}` };
  return { cls: 'write', why: 'unknown, so it counts as write', unknown: true };
}
