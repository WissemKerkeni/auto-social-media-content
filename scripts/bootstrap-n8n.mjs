#!/usr/bin/env node
// One-command n8n provisioning: turns a fresh `docker compose up` into a working instance.
//
//   1. preflight      env vars + workflow set validation (manifest, IDs, credential refs, secret scan)
//   2. container      find the n8n container and wait for /healthz
//   3. owner          create the owner account via the internal REST API (idempotent)
//   4. workflows      n8n import:workflow from the read-only /workflows mount (upsert by fixed ID)
//   5. credentials    generated from .env, streamed into the container over stdin, imported
//                     (encrypted with the instance key), and the temp file deleted
//   6. publish        activate every workflow marked publish=true in n8n/manifest.json
//   7. restart        so published workflows / triggers are picked up
//   8. self-check     run TN-00 Self-check (prompt from Langfuse + test trace), then confirm the
//                     trace exists through the Langfuse API
//
// Idempotent: re-run any time to sync the instance to the repo state, without duplicates.
//
// Usage:
//   node scripts/bootstrap-n8n.mjs [--env-file .env] [--dry-run]
//                                  [--skip-owner] [--skip-restart] [--skip-selfcheck]
//
// Secrets are read from the env file only; nothing secret is passed on a command line or
// written to the host disk. Requires: docker (compose v2), Node >= 22.
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseEnv, isN8nPasswordValid } from './lib/env.mjs';
import { buildCredentials, loadAndValidateWorkflows, extractExecutionResult } from './lib/n8n.mjs';
import { createLangfuseClient, waitFor } from './lib/langfuse.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
if (flag('-h') || flag('--help')) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  process.exit(0);
}
const DRY_RUN = flag('--dry-run');
const ENV_FILE = resolve(root, option('--env-file') ?? '.env');

let stepNo = 0;
const step = (msg) => console.log(`\n── step ${++stepNo}: ${msg}`);
const ok = (msg) => console.log(`   ✓ ${msg}`);
const warn = (msg) => console.log(`   ⚠ ${msg}`);
const fail = (msg) => { console.error(`   ✗ FAIL: ${msg}`); process.exit(1); };

/** Run `docker compose ...` in the project dir. Never pass secrets in args — use `input`. */
function compose(composeArgs, { input, allowFail = false } = {}) {
  const res = spawnSync('docker', ['compose', ...composeArgs], { cwd: root, encoding: 'utf8', input, maxBuffer: 32 * 1024 * 1024 });
  if (res.error) fail(`docker not runnable: ${res.error.message}`);
  if (res.status !== 0 && !allowFail) {
    console.error((res.stdout || '') + (res.stderr || ''));
    fail(`docker compose ${composeArgs.slice(0, 6).join(' ')} … exited ${res.status}`);
  }
  return res;
}
const n8nExec = (cmd, opts) => compose(['exec', '-T', '-u', 'node', 'n8n', ...cmd], opts);

async function waitHealthy(url, tries = 45) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(3000) });
      if (res.status === 200) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

// ── Step 1: preflight — report ALL problems at once, then fail ──
step('preflight');
if (!existsSync(ENV_FILE)) fail(`${ENV_FILE} not found — run npm run setup`);
const env = { ...parseEnv(readFileSync(ENV_FILE, 'utf8')) };
for (const k of Object.keys(env)) if (process.env[k]) env[k] = process.env[k]; // exported vars win

const problems = [];
const REQUIRED = ['N8N_OWNER_EMAIL', 'N8N_OWNER_PASSWORD', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY',
  'APP_DB_NAME', 'APP_DB_USER', 'APP_DB_PASSWORD', 'S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'];
for (const k of REQUIRED) if (!env[k] || /^__(GENERATE|DERIVED)__$/.test(env[k])) problems.push(`${k} is missing or a placeholder`);
if (env.N8N_OWNER_PASSWORD && !isN8nPasswordValid(env.N8N_OWNER_PASSWORD)) problems.push('N8N_OWNER_PASSWORD does not meet n8n policy (8–64 chars, a digit, an uppercase letter)');

const { manifest, problems: wfProblems } = loadAndValidateWorkflows(root);
problems.push(...wfProblems);
if (problems.length) {
  for (const p of problems) console.error(`     - ${p}`);
  fail(`${problems.length} problem(s) — fix them and re-run`);
}
const { credentials, skipped } = buildCredentials(env);
ok(`env vars present; ${manifest.workflows.length} workflows valid; ${credentials.length} credentials ready`);
for (const s of skipped) warn(`credential "${s.name}" skipped — ${s.missing.join(', ')} empty (re-run bootstrap after setting it)`);

// ── Step 2: container ──
step('n8n container');
const cid = compose(['ps', '-q', 'n8n'], { allowFail: true }).stdout.trim();
if (!cid) fail('n8n container not found — is the stack up? (npm run up)');
const state = spawnSync('docker', ['inspect', '-f', '{{.State.Status}}', cid], { encoding: 'utf8' }).stdout.trim();
if (state !== 'running') fail(`n8n container is ${state || 'unknown'}`);
const N8N_URL = `http://localhost:${env.N8N_HOST_PORT || 5678}`;
if (!(await waitHealthy(N8N_URL, 30))) fail(`n8n /healthz not 200 at ${N8N_URL}`);
ok(`container ${cid.slice(0, 12)} running; ${N8N_URL} healthy`);

const publishIds = manifest.workflows.filter((w) => w.publish).map((w) => w.id);
const importDirs = [...new Set(manifest.workflows.map((w) => dirname(`/workflows/${w.file}`)))].sort();

if (DRY_RUN) {
  console.log('\n── DRY RUN — would run against container', cid.slice(0, 12));
  console.log(`  owner:        POST ${N8N_URL}/rest/owner/setup (${env.N8N_OWNER_EMAIL})${flag('--skip-owner') ? ' [skipped]' : ''}`);
  for (const d of importDirs) console.log(`  import:       n8n import:workflow --separate --input=${d}/`);
  console.log(`  credentials:  ${credentials.map((c) => `${c.id} (${c.type})`).join(', ')}`);
  console.log(`  publish:      ${publishIds.join(', ') || '(none)'}`);
  console.log(`  restart:      docker compose restart n8n${flag('--skip-restart') ? ' [skipped]' : ''}`);
  console.log(`  self-check:   n8n execute --id=tn-00-selfcheck + Langfuse trace lookup${flag('--skip-selfcheck') ? ' [skipped]' : ''}`);
  console.log('\nDry run complete — no changes made.');
  process.exit(0);
}

// ── Step 3: owner account (tolerant: already set up is fine) ──
step('owner account');
if (flag('--skip-owner')) {
  warn('skipped (--skip-owner)');
} else {
  const res = await fetch(`${N8N_URL}/rest/owner/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: env.N8N_OWNER_EMAIL, firstName: 'TN', lastName: 'Owner', password: env.N8N_OWNER_PASSWORD }),
  }).catch((err) => ({ status: 0, text: async () => err.message }));
  if (res.status >= 200 && res.status < 300) ok(`owner created (${env.N8N_OWNER_EMAIL}); password is N8N_OWNER_PASSWORD in .env`);
  else if ([400, 403, 404, 409].includes(res.status)) ok(`owner already set up (HTTP ${res.status}) — nothing to do`);
  else warn(`owner setup returned HTTP ${res.status} — continuing (imports do not need it)`);
}

// ── Step 4: import workflows (upsert on fixed IDs; --separate is non-recursive) ──
step('import workflows');
for (const dir of importDirs) {
  n8nExec(['n8n', 'import:workflow', '--separate', `--input=${dir}/`]);
  ok(`imported ${dir}/`);
}

// ── Step 5: credentials — streamed over stdin, never written to host disk ──
step('import credentials');
const TMP = '/tmp/tn-credentials.json';
n8nExec(['sh', '-c', `umask 077 && cat > ${TMP}`], { input: JSON.stringify(credentials) });
const imported = n8nExec(['n8n', 'import:credentials', `--input=${TMP}`], { allowFail: true });
n8nExec(['rm', '-f', TMP], { allowFail: true });
if (imported.status !== 0) {
  console.error(imported.stdout + imported.stderr);
  fail('credential import failed (temp file removed)');
}
ok(`imported ${credentials.length}: ${credentials.map((c) => c.id).join(', ')} (temp file removed)`);

// ── Step 6: publish (n8n 2.x: publish:workflow) ──
step('publish workflows');
let published = 0;
for (const id of publishIds) {
  const res = n8nExec(['n8n', 'publish:workflow', `--id=${id}`], { allowFail: true });
  if (res.status === 0) published++;
  else warn(`could not publish ${id}: ${(res.stderr || res.stdout).trim().split('\n').pop()}`);
}
if (published === publishIds.length) ok(`published ${published}: ${publishIds.join(', ')}`);
else fail(`published ${published}/${publishIds.length}`);

// ── Step 7: restart so published workflows are loaded ──
step('restart n8n');
if (flag('--skip-restart')) {
  warn('skipped (--skip-restart) — published workflows activate on the next restart');
} else {
  compose(['restart', 'n8n']);
  if (!(await waitHealthy(N8N_URL, 45))) fail("n8n not healthy after restart — check 'docker compose logs n8n'");
  ok('restarted and healthy');
}

// ── Step 8: self-check ──
step('self-check: prompt from Langfuse + trace written');
if (flag('--skip-selfcheck')) {
  warn('skipped (--skip-selfcheck)');
} else {
  // The CLI process starts its own task-runner broker; the running instance already holds 5679.
  const run = compose(['exec', '-T', '-u', 'node', '-e', 'N8N_RUNNERS_BROKER_PORT=5690', 'n8n',
    'n8n', 'execute', '--id=tn-00-selfcheck', '--rawOutput'], { allowFail: true });
  const result = extractExecutionResult(run.stdout, 'Result');
  if (run.status !== 0 || !result || result.status !== 'success') {
    console.error(run.stdout.slice(-3000) + run.stderr.slice(-2000));
    fail('TN-00 Self-check did not run successfully');
  }
  const data = result.json;
  if (data.prompt_source !== 'langfuse') {
    fail(`prompt came from "${data.prompt_source}", not Langfuse — is Langfuse up and seeded? (npm run seed-prompts)`);
  }
  ok(`prompt tn-editorial-system v${data.prompt_version} fetched from Langfuse (${data.prompt_chars} chars)`);
  if (!data.traced) fail(`trace ingestion failed: ${JSON.stringify(data.trace_errors)}`);
  ok(`ingestion accepted trace ${data.trace_id}`);

  if (env.LANGFUSE_HOST_URL) {
    const lf = createLangfuseClient({ baseUrl: env.LANGFUSE_HOST_URL, publicKey: env.LANGFUSE_PUBLIC_KEY, secretKey: env.LANGFUSE_SECRET_KEY });
    const gen = await waitFor(async () => {
      const observations = await lf.getTraceObservations(data.trace_id);
      return observations.find((o) => o.type === 'GENERATION') ?? null;
    }, { timeoutMs: 60_000, intervalMs: 2_000 });
    if (!gen) fail(`generation for trace ${data.trace_id} not queryable in Langfuse after 60 s (check langfuse-worker logs)`);
    if (gen.promptName !== 'tn-editorial-system' || !gen.promptId) {
      fail(`generation found but not linked to prompt tn-editorial-system (promptName=${gen.promptName ?? 'none'})`);
    }
    ok(`generation visible in Langfuse, linked to ${gen.promptName} v${gen.promptVersion}`);
  }
}

console.log(`\n✓ Bootstrap complete. n8n at ${N8N_URL} matches the repo; re-run any time.`);
