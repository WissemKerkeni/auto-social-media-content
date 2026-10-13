#!/usr/bin/env node
// Health check for the local stack. Prints no secret values. Exit code 1 if any check fails.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseEnv, langfuseProfileEnabled } from './lib/env.mjs';
import { headBucket } from './lib/s3.mjs';
import { createLangfuseClient } from './lib/langfuse.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = resolve(root, '.env');
if (!existsSync(envPath)) {
  console.error('✗ .env not found. Run: npm run setup');
  process.exit(1);
}
const env = parseEnv(readFileSync(envPath, 'utf8'));

let failures = 0;
const ok = (msg) => console.log(`✓ ${msg}`);
const fail = (msg) => { failures++; console.log(`✗ ${msg}`); };

const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const compose = (...args) => run('docker', ['compose', ...args]);

async function check(name, fn) {
  try {
    const detail = await fn();
    ok(detail ? `${name}: ${detail}` : name);
  } catch (err) {
    fail(`${name}: ${(err.stderr || err.message || String(err)).toString().trim().split('\n')[0]}`);
  }
}

await check('Docker daemon', () => run('docker', ['info', '--format', '{{.ServerVersion}}']));

const withLangfuse = langfuseProfileEnabled(env);

await check('Compose services', () => {
  const lines = compose('ps', '--all', '--format', 'json').split('\n').filter(Boolean);
  const services = lines.map((l) => JSON.parse(l));
  const expected = ['postgres', 'n8n', 'seaweedfs', 'tn-core'];
  if (withLangfuse) expected.push('clickhouse', 'langfuse-redis', 'langfuse-worker', 'langfuse-web');
  const summary = expected.map((name) => {
    const s = services.find((x) => x.Service === name);
    if (!s) throw new Error(`${name} is not created (run npm run up)`);
    if (s.State !== 'running') throw new Error(`${name} is ${s.State}`);
    if (s.Health && s.Health !== 'healthy') throw new Error(`${name} health is ${s.Health}`);
    return `${name}=${s.Health || s.State}`;
  });
  if (withLangfuse) {
    const init = services.find((x) => x.Service === 'storage-init');
    if (!init || init.ExitCode !== 0) throw new Error('storage-init did not complete successfully');
  }
  return summary.join(', ');
});

await check('n8n process env holds no secrets (read from /run/secrets)', () => {
  const names = compose('exec', '-T', 'n8n', 'sh', '-c', 'env | cut -d= -f1').split('\n');
  const leaked = names.filter((n) => n === 'N8N_ENCRYPTION_KEY' || n === 'DB_POSTGRESDB_PASSWORD' || /SECRET|API_KEY|PASSWORD$/.test(n));
  if (leaked.length) throw new Error(`secret-looking env vars visible to workflows: ${leaked.join(', ')}`);
  return 'encryption key + DB password via _FILE';
});

await check('n8n /healthz', async () => {
  const res = await fetch(`http://localhost:${env.N8N_HOST_PORT || 5678}/healthz`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return `HTTP ${res.status}`;
});

await check('tn-core health + auth', async () => {
  const base = `http://localhost:${env.TN_CORE_HOST_PORT || 8081}`;
  const health = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(5000) });
  if (!health.ok) throw new Error(`/healthz HTTP ${health.status}`);
  const anon = await fetch(`${base}/v1/production/prepare`, { method: 'POST', signal: AbortSignal.timeout(5000) });
  if (anon.status !== 401) throw new Error(`unauthenticated call returned HTTP ${anon.status}, expected 401`);
  return 'healthy; rejects unauthenticated calls';
});

await check('n8n container timezone', () => {
  const out = compose('exec', '-T', 'n8n', 'sh', '-c', 'echo "$GENERIC_TIMEZONE $(date +%Z%z)"');
  if (!out.startsWith('Africa/Tunis')) throw new Error(`unexpected: ${out}`);
  return out;
});

await check('n8n uses PostgreSQL', () => {
  const out = compose('exec', '-T', 'postgres', 'sh', '-c',
    'psql -U "$POSTGRES_USER" -d "$N8N_DB_NAME" -tAc "select count(*) from information_schema.tables where table_schema = \'public\'"');
  if (Number(out) < 10) throw new Error(`only ${out} tables in n8n DB; n8n may be using SQLite`);
  return `${out} tables in n8n DB`;
});

await check('App DB login (tn_app)', () => {
  const out = compose('exec', '-T', 'postgres', 'sh', '-c',
    'PGPASSWORD="$APP_DB_PASSWORD" psql -h 127.0.0.1 -U "$APP_DB_USER" -d "$APP_DB_NAME" -tAc "select current_user || \'@\' || current_database() || \' tz=\' || current_setting(\'TimeZone\') || \' \' || split_part(version(), \' \', 2)"');
  return out;
});

await check('App DB reachable from host (DATABASE_URL port)', async () => {
  const net = await import('node:net');
  const port = Number(new URL(env.DATABASE_URL).port || 5432);
  await new Promise((res, rej) => {
    const sock = net.connect({ host: '127.0.0.1', port, timeout: 3000 }, () => { sock.end(); res(); });
    sock.on('error', rej);
    sock.on('timeout', () => { sock.destroy(); rej(new Error('timeout')); });
  });
  return `localhost:${port} open`;
});

await check('Object storage bucket (signed HeadBucket)', async () => {
  const status = await headBucket({
    endpoint: `http://localhost:${env.S3_HOST_PORT || 8333}`,
    bucket: env.S3_BUCKET,
    region: env.S3_REGION || 'auto',
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  });
  if (status !== 200) throw new Error(`HTTP ${status} (403 = bad credentials, 404 = bucket missing)`);
  return `${env.S3_BUCKET} HTTP ${status}`;
});

await check('Object storage rejects anonymous access', async () => {
  const res = await fetch(`http://localhost:${env.S3_HOST_PORT || 8333}/${env.S3_BUCKET}`, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
  if (res.status === 200) throw new Error('bucket is publicly readable without credentials');
  return `HTTP ${res.status}`;
});

await check('All databases default to UTC', () => {
  const out = compose('exec', '-T', 'postgres', 'sh', '-c',
    'psql -U "$POSTGRES_USER" -d postgres -tAc "select d.datname || \'=\' || coalesce((select split_part(c, \'=\', 2) from unnest(s.setconfig) c where c ilike \'timezone=%\'), \'server-default\') from pg_database d left join pg_db_role_setting s on s.setdatabase = d.oid and s.setrole = 0 where d.datname in (\'$N8N_DB_NAME\', \'$APP_DB_NAME\', \'$LANGFUSE_DB_NAME\') order by 1"');
  const rows = out.split('\n').filter(Boolean);
  const bad = rows.filter((r) => !r.endsWith('=UTC'));
  if (bad.length) throw new Error(`not UTC: ${bad.join(', ')} (run npm run dev:up to re-apply init)`);
  return rows.join(', ');
});

await check('App schema migrated and seeded', () => {
  const expected = readdirSync(resolve(root, 'prisma/migrations'), { withFileTypes: true }).filter((d) => d.isDirectory()).length;
  const sql = [
    "select (select count(*) from _prisma_migrations where finished_at is not null and rolled_back_at is null)",
    "(select count(*) from app_config where key in ('schedule','daily_post_cap','publishing_enabled'))",
    "(select count(*) from locations where active)",
    "(select count(*) from publish_slots where local_date = (now() at time zone 'Africa/Tunis')::date)",
    "(select value::text from app_config where key = 'publishing_enabled')",
  ].join(" || ',' || ");
  const out = compose('exec', '-T', 'postgres', 'sh', '-c',
    `PGPASSWORD="$APP_DB_PASSWORD" psql -h 127.0.0.1 -U "$APP_DB_USER" -d "$APP_DB_NAME" -tAc "${sql}"`);
  const [migrations, config, locations, slots, publishing] = out.split(',');
  if (Number(migrations) !== expected) throw new Error(`${migrations}/${expected} migrations applied (npm run db:deploy)`);
  if (Number(config) !== 3) throw new Error('app_config not seeded (npm run db:seed)');
  if (Number(locations) === 0) throw new Error('no active locations (npm run db:seed)');
  return `${migrations} migrations, ${locations} active destinations, ${slots} slots today, publishing_enabled=${publishing}`;
});

if (env.LANGFUSE_HOST_URL && env.LANGFUSE_PUBLIC_KEY) {
  const lf = createLangfuseClient({ baseUrl: env.LANGFUSE_HOST_URL, publicKey: env.LANGFUSE_PUBLIC_KEY, secretKey: env.LANGFUSE_SECRET_KEY, timeoutMs: 5000 });
  const templates = readdirSync(resolve(root, 'prompts/templates')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));

  await check('Langfuse API + keys', async () => {
    const res = await lf.projects();
    if (!res.ok) throw new Error(`HTTP ${res.status} at ${env.LANGFUSE_HOST_URL}`);
    return `project "${res.json?.data?.[0]?.name}"`;
  });

  await check('Langfuse prompts have a production version', async () => {
    const versions = [];
    for (const name of templates) {
      const res = await lf.getPrompt(name);
      if (res.status !== 200) throw new Error(`${name}: HTTP ${res.status} (run npm run seed-prompts)`);
      versions.push(`${name}@v${res.json.version}`);
    }
    return versions.join(', ');
  });
}

await check('n8n prompt fallback files', () => {
  const missing = readdirSync(resolve(root, 'prompts/templates')).filter((f) => f.endsWith('.md'))
    .filter((f) => !existsSync(resolve(root, 'n8n/files/prompts', f)));
  if (missing.length) throw new Error(`missing for ${missing.join(', ')} (run npm run seed-prompts)`);
  return 'present for every template';
});

console.log(failures ? `\n${failures} check(s) failed. See docs/troubleshooting.md` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
