#!/usr/bin/env node
// One command to stand up the local stack and provision everything:
//   1. env        create .env (or append variables added to .env.example since), then validate it
//   2. up         docker compose up -d --wait (core + profiles from COMPOSE_PROFILES)
//   3. databases  re-run the idempotent Postgres init (new DBs/roles, password sync, UTC),
//                 then prisma migrate deploy + seed (config keys, destinations, today's slots)
//   4. prompts    seed-prompts → Langfuse (falls back to writing local fallback files if Langfuse is off)
//   5. n8n        bootstrap-n8n (owner, workflows, credentials, publish, self-check)
//   6. doctor     end-to-end health checks
//
// Usage: node scripts/dev-up.mjs [--recreate] [--skip-bootstrap] [--skip-prompts]
//   --recreate        docker compose down first (volumes are kept)
//   --skip-bootstrap  don't run bootstrap-n8n
//   --skip-prompts    don't run seed-prompts
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseEnv, langfuseProfileEnabled } from './lib/env.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const flag = (name) => process.argv.includes(name);

let stepNo = 0;
const step = (msg) => console.log(`\n══ step ${++stepNo}: ${msg}`);
const fail = (msg) => { console.error(`   ✗ FAIL: ${msg}`); process.exit(1); };

/** Run a command with inherited stdio; returns exit status. */
function run(cmd, args, { allowFail = false } = {}) {
  const res = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  if (res.error) fail(`${cmd}: ${res.error.message}`);
  if (res.status !== 0 && !allowFail) fail(`${cmd} ${args.join(' ')} exited ${res.status}`);
  return res.status;
}
const node = (script, args = [], opts) => run(process.execPath, [resolve(root, script), ...args], opts);

step('env file');
node('scripts/setup.mjs', ['--add-missing']);
node('scripts/check-env.mjs');
const env = parseEnv(readFileSync(resolve(root, '.env'), 'utf8'));

step(`docker compose up (profiles: ${env.COMPOSE_PROFILES || 'none'})`);
if (flag('--recreate')) run('docker', ['compose', 'down']);
run('docker', ['compose', 'up', '-d', '--wait']);

step('databases (idempotent init)');
run('docker', ['compose', 'exec', '-T', 'postgres', 'sh', '/docker-entrypoint-initdb.d/10-create-databases.sh']);

step('app schema: migrations + seed');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const runNpx = (args) => {
  const res = spawnSync(npx, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (res.status !== 0) fail(`npx ${args.join(' ')} exited ${res.status}`);
};
runNpx(['prisma', 'migrate', 'deploy']);
runNpx(['prisma', 'db', 'seed']);

step('prompts → Langfuse');
if (flag('--skip-prompts')) {
  console.log('   ⚠ skipped (--skip-prompts)');
} else if (node('scripts/seed-prompts.mjs', [], { allowFail: true }) !== 0) {
  console.log('   ⚠ seeding failed — writing repo-rendered fallback files so n8n can still serve prompts');
  node('scripts/seed-prompts.mjs', ['--fallback-only']);
}

step('provision n8n');
if (flag('--skip-bootstrap')) {
  console.log('   ⚠ skipped (--skip-bootstrap) — run npm run bootstrap:n8n later');
} else {
  node('scripts/bootstrap-n8n.mjs', langfuseProfileEnabled(env) || env.LANGFUSE_HOST_URL ? [] : ['--skip-selfcheck']);
}

step('doctor');
node('scripts/doctor.mjs');

console.log(`\n✓ Dev stack ready.  n8n → ${env.N8N_EDITOR_BASE_URL || 'http://localhost:5678'}  (login: N8N_OWNER_EMAIL / N8N_OWNER_PASSWORD in .env)`);
if (langfuseProfileEnabled(env)) console.log(`                   Langfuse → http://localhost:${env.LANGFUSE_HOST_PORT || 3000}  (login: LANGFUSE_INIT_USER_EMAIL / LANGFUSE_INIT_USER_PASSWORD)`);
