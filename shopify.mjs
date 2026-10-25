// Agents Office — the office's own read-only view of the Shopify store (STORE, spec 0004: docs/specs/0004-shopify-event-triggers.md).
// Used only by triggers.mjs to notice events. It never writes: a GraphQL document containing "mutation" is refused here,
// and the office will not poll with a token whose scopes are not all read_*. Every change to the store still goes through
// an agent's connector behind the call gate (spec 0001).
//
// office.config.local.json (gitignored; the shared office.config.json must never hold these):
//   "shopify": { "shop": "mystore.myshopify.com", "clientId": "…", "clientSecret": "…", "poll": 5 }   ← a Dev Dashboard app
//   "shopify": { "shop": "mystore.myshopify.com", "token": "shpat_…" }                                 ← or a legacy custom app's token
// The client credentials token lasts 24 hours; it is kept in memory only and fetched again a minute before it runs out or after a 401.
export const API_VERSION = '2026-10';
const RENEW_EARLY = 60 * 1000;

/** office config → { on, shop, clientId, clientSecret, token, poll, problems } — never logs a secret */
export function settings(cfg) {
  const s = cfg.shopify || {}, problems = [];
  let shop = String(s.shop || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (shop && !shop.includes('.')) shop += '.myshopify.com';
  if (shop && !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) problems.push(`shopify.shop must be your store's address like mystore.myshopify.com (got "${s.shop}")`);
  const token = s.token ? String(s.token).trim() : '', clientId = s.clientId ? String(s.clientId).trim() : '', clientSecret = s.clientSecret ? String(s.clientSecret).trim() : '';
  if (s.shop !== undefined && !token && !(clientId && clientSecret)) problems.push('shopify needs clientId and clientSecret (a Dev Dashboard app) or token (a legacy custom app)');
  let poll = s.poll === undefined ? 5 : Number(s.poll);
  if (!(poll >= 1 && poll <= 60)) { problems.push(`shopify.poll must be 1 to 60 minutes (got "${s.poll}"), using 5`); poll = 5; }
  return { on: !!shop && !problems.length, shop, clientId, clientSecret, token, poll, problems };
}

class ShopifyError extends Error { constructor(message, status, retry) { super(message); this.status = status; this.retry = !!retry; } }
const cache = new Map(); // shop → { token, until, scopes }
export const forget = shop => cache.delete(shop);

async function accessToken(s, fetchImpl) {
  if (s.token) return { token: s.token, scopes: null };
  const c = cache.get(s.shop); if (c && c.until - Date.now() > RENEW_EARLY) return c;
  let r;
  try { r = await fetchImpl(`https://${s.shop}/admin/oauth/access_token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: s.clientId, client_secret: s.clientSecret }).toString() }); }
  catch (e) { throw new ShopifyError(`Shopify did not answer (${e.code || e.message})`, 0, true); }
  if (!r.ok) { // Shopify answers JSON or an HTML page titled "400 - Oauth error <code>"
    let why = ''; try { const t = await r.text(); try { const j = JSON.parse(t); why = j.error_description || j.error || ''; } catch { why = (/Oauth error ([a-z_]+)/i.exec(t) || [])[1] || ''; } } catch {}
    const plain = { app_not_installed: 'the app is not installed on the store yet: install it from the Dev Dashboard', shop_not_permitted: 'the app and the store are not in the same Dev Dashboard organization', invalid_client: 'Shopify does not recognise the Client ID and secret' }[why];
    throw new ShopifyError(plain ? `${plain} (${why})` : `Shopify refused the app's credentials (${r.status}${why ? ': ' + why : ''})`, r.status, r.status >= 500 || r.status === 429);
  }
  const j = await r.json();
  if (!j.access_token) throw new ShopifyError('Shopify sent no access token', r.status, false);
  const out = { token: j.access_token, until: Date.now() + (Number(j.expires_in) || 86399) * 1000, scopes: String(j.scope || '').split(',').map(x => x.trim()).filter(Boolean) };
  cache.set(s.shop, out); return out;
}

/** One read-only GraphQL query → data. Refuses a mutation. A 401 renews the token once. Errors carry status and retry. */
export async function query(s, doc, variables = {}, { fetchImpl = fetch } = {}) {
  if (/\bmutation\b/i.test(doc)) throw new ShopifyError('the office never writes to Shopify: a mutation was refused', 0, false);
  for (let attempt = 0; attempt < 2; attempt++) {
    const { token } = await accessToken(s, fetchImpl);
    let r;
    try { r = await fetchImpl(`https://${s.shop}/admin/api/${API_VERSION}/graphql.json`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-shopify-access-token': token }, body: JSON.stringify({ query: doc, variables }) }); }
    catch (e) { throw new ShopifyError(`Shopify did not answer (${e.code || e.message})`, 0, true); }
    if (r.status === 401 && !s.token && attempt === 0) { forget(s.shop); continue; }
    if (!r.ok) throw new ShopifyError(r.status === 401 ? 'Shopify says the access is no longer valid (401)' : r.status === 429 ? 'Shopify asked the office to slow down (429)' : `Shopify answered ${r.status}`, r.status, r.status === 429 || r.status >= 500);
    const j = await r.json();
    const throttled = (j.errors || []).some(e => e.extensions?.code === 'THROTTLED');
    if (throttled) throw new ShopifyError('Shopify asked the office to slow down (throttled)', 429, true);
    if (j.errors?.length) throw new ShopifyError('Shopify: ' + j.errors.map(e => e.message).join('; ').slice(0, 300), r.status, false);
    return j.data;
  }
}

/** The scopes this access really has → { scopes, write: [the ones that are not read_*] } */
export async function scopes(s, { fetchImpl = fetch } = {}) {
  let list = (await accessToken(s, fetchImpl)).scopes;
  if (!list) list = ((await query(s, '{ currentAppInstallation { accessScopes { handle } } }', {}, { fetchImpl })).currentAppInstallation?.accessScopes || []).map(x => x.handle);
  return { scopes: list, write: list.filter(x => !/^read_/.test(x)) };
}
export const shopName = async (s, opts) => (await query(s, '{ shop { name myshopifyDomain currencyCode ianaTimezone } }', {}, opts)).shop;
