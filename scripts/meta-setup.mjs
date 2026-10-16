#!/usr/bin/env node
// Meta setup for Phase D: turns a short-lived USER token from the Graph API Explorer into a
// never-expiring PAGE access token, finds the linked Instagram account, checks permissions,
// and writes META_PAGE_ID, META_IG_USER_ID and META_PAGE_ACCESS_TOKEN into .env.
//
//   1. exchange   user token → long-lived user token (needs META_APP_ID + META_APP_SECRET)
//   2. page       GET /me/accounts → the Page (+ its never-expiring Page token, linked IG account)
//   3. verify     debug_token: scopes present, token does not expire
//   4. write      .env (values replaced in place; the token is never printed)
//
// Usage:
//   npm run meta:setup                    paste the user token when asked (input is not echoed)
//   npm run meta:setup -- --page-id 123   pick a Page when you manage several
//   npm run meta:setup -- --check         only verify the token already in .env (read-only calls)
//
// Afterwards: npm run bootstrap:n8n (stores the token as the n8n credential "Meta Graph API")
// and `docker compose up -d tn-core` (picks up the ids).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from './lib/env.mjs';
import { missingScopes, pickPage, setEnvValues } from './lib/meta.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const ENV_FILE = resolve(root, option('--env-file') ?? '.env');
const ok = (m) => console.log(`   ✓ ${m}`);
const fail = (m) => { console.error(`   ✗ ${m}`); process.exit(1); };

if (!existsSync(ENV_FILE)) fail(`${ENV_FILE} not found — run npm run setup`);
const envText = readFileSync(ENV_FILE, 'utf8');
const env = parseEnv(envText);
const version = env.META_GRAPH_VERSION || 'v26.0';
const base = `https://graph.facebook.com/${version}`;

/** GET a Graph endpoint. The token travels in the Authorization header, never in the URL. */
async function graph(path, token, query = {}) {
  const u = new URL(`${base}/${path}`);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  const res = await fetch(u, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(20_000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(`${path}: ${body.error?.message ?? `HTTP ${res.status}`}`);
  return body;
}

/** Read a secret from the terminal without echoing it. */
async function askSecret(prompt) {
  if (process.env.META_USER_TOKEN) return process.env.META_USER_TOKEN.trim();
  if (!process.stdin.isTTY) return readFileSync(0, 'utf8').trim();
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let value = '';
  return new Promise((done) => {
    process.stdin.on('data', (chunk) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') { process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); done(value.trim()); return; }
        if (ch === '\u0003') process.exit(130);
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1); else value += ch;
      }
    });
  });
}

async function verify(pageToken, pageId, igUserId) {
  console.log('\n── verify');
  const page = await graph(pageId, pageToken, { fields: 'id,name,instagram_business_account{id,username}' });
  ok(`Page: ${page.name} (${page.id})`);
  if (env.META_APP_ID && env.META_APP_SECRET) {
    const dbg = (await graph('debug_token', `${env.META_APP_ID}|${env.META_APP_SECRET}`, { input_token: pageToken })).data ?? {};
    if (!dbg.is_valid) fail('token is not valid');
    const missing = missingScopes(dbg.scopes);
    if (missing.length) fail(`token lacks permissions: ${missing.join(', ')} — grant them in the Graph API Explorer and run meta:setup again`);
    ok(`permissions: ${dbg.scopes.filter((s) => /^(pages_|instagram_)/.test(s)).join(', ')}`);
    if (dbg.type !== 'PAGE') fail(`META_PAGE_ACCESS_TOKEN is a ${dbg.type} token, not a Page token — run npm run meta:setup instead of pasting the Explorer token into .env`);
    if (dbg.expires_at !== 0) fail(`token expires ${new Date(dbg.expires_at * 1000).toISOString()} — expected a never-expiring Page token; run npm run meta:setup again`);
    ok('Page token, does not expire');
  }
  if (igUserId) {
    const ig = await graph(igUserId, pageToken, { fields: 'id,username' });
    ok(`Instagram: @${ig.username} (${ig.id})`);
    const limit = await graph(`${igUserId}/content_publishing_limit`, pageToken, { fields: 'quota_usage,config' });
    const d = limit.data?.[0];
    if (d) ok(`Instagram publishing quota: ${d.quota_usage ?? 0}/${d.config?.quota_total ?? '?'} in the last 24 h`);
  } else {
    console.log('   ⚠ no Instagram account linked to this Page — Instagram will not be published');
  }
}

if (args.includes('--check')) {
  if (!env.META_PAGE_ACCESS_TOKEN || !env.META_PAGE_ID) fail('META_PAGE_ACCESS_TOKEN / META_PAGE_ID are empty — run npm run meta:setup first');
  await verify(env.META_PAGE_ACCESS_TOKEN, env.META_PAGE_ID, env.META_IG_USER_ID).catch((e) => fail(e.message));
  console.log('\n✓ Meta credentials work (read-only check; nothing was posted).');
  process.exit(0);
}

if (!env.META_APP_ID || !env.META_APP_SECRET) fail('set META_APP_ID and META_APP_SECRET in .env first (Meta app → App settings → Basic)');

console.log('── exchange user token');
const userToken = await askSecret('   Paste the user access token from the Graph API Explorer: ');
if (!userToken) fail('no token given');
let longLived;
try {
  const u = new URL(`${base}/oauth/access_token`);
  u.search = new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: env.META_APP_ID, client_secret: env.META_APP_SECRET, fb_exchange_token: userToken }).toString();
  const res = await fetch(u, { signal: AbortSignal.timeout(20_000) });
  const body = await res.json();
  if (!res.ok || !body.access_token) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  longLived = body.access_token;
} catch (e) {
  fail(`token exchange failed: ${e.message}`);
}
ok('long-lived user token obtained');

console.log('\n── page');
const accounts = await graph('me/accounts', longLived, { fields: 'id,name,access_token,instagram_business_account{id,username}', limit: '100' }).catch((e) => fail(e.message));
const { page, error } = pickPage(accounts.data, { pageId: option('--page-id') || env.META_PAGE_ID || undefined, preferName: 'Green Tunisia' });
if (error) fail(error);
const igUserId = page.instagram_business_account?.id ?? '';
ok(`Page: ${page.name} (${page.id})${igUserId ? `; Instagram @${page.instagram_business_account.username} (${igUserId})` : ''}`);

await verify(page.access_token, page.id, igUserId).catch((e) => fail(e.message));

writeFileSync(ENV_FILE, setEnvValues(envText, { META_PAGE_ID: page.id, META_IG_USER_ID: igUserId, META_PAGE_ACCESS_TOKEN: page.access_token }));
console.log(`\n✓ Wrote META_PAGE_ID, META_IG_USER_ID and META_PAGE_ACCESS_TOKEN to ${ENV_FILE}.`);
console.log('  Next: npm run bootstrap:n8n   (stores the token as the n8n credential "Meta Graph API")');
console.log('        docker compose up -d tn-core   (picks up the ids)');
