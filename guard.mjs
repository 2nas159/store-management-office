// Agents Office — who may change things through the office's API (STORE, 30 Oct 2026).
// The API has no login: it trusts whoever can reach it. A web page open in the owner's browser can reach it too, and a
// text/plain POST needs no CORS preflight, so without this any site could add a task ("refund order #1001"), approve a
// draft or switch an auto approve rule back on. A browser always names the page that sent a request (Origin, and
// Sec-Fetch-Site in current browsers); a request that changes something is refused unless that page is the office itself.
// Requests with neither header (Node, curl, the check) are not from a web page and pass.
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);

/** → null when the request may go on, else the reason it is refused (a plain sentence) */
export function refuse(req, port) {
  if (SAFE.has(req.method)) return null;
  const h = req.headers || {}, site = String(h['sec-fetch-site'] || '').toLowerCase(), origin = h.origin;
  if (site === 'cross-site' || site === 'same-site') return `a ${site} page tried to change the office; only the office's own page may`;
  if (origin === undefined) return null;
  let u; try { u = new URL(origin); } catch { return `a page with origin "${origin}" tried to change the office; only the office's own page may`; }
  if (u.protocol !== 'http:' || !LOCAL.has(u.hostname) || Number(u.port || 80) !== Number(port)) return `${origin} tried to change the office; only the office's own page (http://localhost:${port}) may`;
  return null;
}
