#!/usr/bin/env node
// Render prompt templates (prompts/templates/*.md) and push them to Langfuse as prompt versions.
//
// Langfuse is the runtime source of truth (n8n fetches the `production` label). This script:
//   - creates the INITIAL version of a prompt with label `production`;
//   - skips prompts whose production text already equals the rendered template;
//   - for changed templates creates a NEW version WITHOUT promoting it, unless --promote;
//   - refuses to promote over a production version edited in the Langfuse UI unless --force;
//   - writes the live production text to n8n/files/prompts/<name>.md, which the n8n
//     [SUB] Get Prompt workflow serves if Langfuse is unreachable.
//
// Usage:
//   node scripts/seed-prompts.mjs [--dry-run] [--print] [--promote [--force]]
//                                 [--only <name>] [--fallback-only] [--env-file .env]
//
//   --dry-run        render + validate only; no network, no files written
//   --print          with --dry-run, print each rendered prompt
//   --promote        label new versions `production`
//   --force          with --promote, also replace a production version edited in the Langfuse UI
//   --only <name>    seed just one prompt
//   --fallback-only  no Langfuse: write rendered repo templates as the n8n fallback files
//
// Auth: LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_HOST_URL from the environment if
// set, else from .env. Never pass keys as flags (keeps them out of shell history).
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseEnv } from './lib/env.mjs';
import { parseTemplate, renderTemplate, planSeedAction, sha256, SEEDED_BY } from './lib/prompts.mjs';
import { createLangfuseClient } from './lib/langfuse.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

const DRY_RUN = flag('--dry-run');
const PRINT = flag('--print');
const PROMOTE = flag('--promote');
const FORCE = flag('--force');
const FALLBACK_ONLY = flag('--fallback-only');
const ONLY = option('--only');
const ENV_FILE = resolve(root, option('--env-file') ?? '.env');
if (flag('-h') || flag('--help')) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  process.exit(0);
}

let stepNo = 0;
const step = (msg) => console.log(`\n── step ${++stepNo}: ${msg}`);
const ok = (msg) => console.log(`   ✓ ${msg}`);
const warn = (msg) => console.log(`   ⚠ ${msg}`);
const fail = (msg) => { console.error(`   ✗ FAIL: ${msg}`); process.exit(1); };

const TEMPLATES_DIR = resolve(root, 'prompts/templates');
const SHARED_DIR = resolve(root, 'prompts/shared');
const FALLBACK_DIR = resolve(root, 'n8n/files/prompts');

// ── Step 1: render + validate every template (fails on any problem, all reported) ──
step('render templates');
const config = JSON.parse(readFileSync(resolve(root, 'prompts/config.json'), 'utf8'));
const partials = {};
for (const file of readdirSync(SHARED_DIR).filter((f) => f.endsWith('.md'))) {
  partials[basename(file, '.md').replace(/-/g, '_')] = parseTemplate(readFileSync(resolve(SHARED_DIR, file), 'utf8'));
}

const prompts = [];
const problems = [];
for (const file of readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith('.md')).sort()) {
  const path = resolve(TEMPLATES_DIR, file);
  try {
    const tpl = parseTemplate(readFileSync(path, 'utf8'));
    const stem = basename(file, '.md');
    if (tpl.meta.name !== stem) throw new Error(`header name "${tpl.meta.name}" must equal file name "${stem}"`);
    if (ONLY && stem !== ONLY) continue;
    const text = renderTemplate(tpl, { config, partials });
    prompts.push({ name: stem, text, meta: tpl.meta, source: relative(root, path).replace(/\\/g, '/') });
    ok(`${stem}: ${text.split('\n').length} lines, runtime vars [${tpl.meta.runtime_vars.join(', ') || 'none'}]`);
  } catch (err) {
    problems.push(`${file}: ${err.message}`);
  }
}
if (problems.length) {
  for (const p of problems) console.error(`   ✗ ${p}`);
  fail(`${problems.length} template problem(s)`);
}
if (!prompts.length) fail(ONLY ? `no template named ${ONLY}` : 'no templates found');

if (DRY_RUN) {
  if (PRINT) for (const p of prompts) console.log(`\n--- ${p.name} ---\n${p.text}--- end ${p.name} ---`);
  console.log('\nDry run complete — nothing pushed, no files written.');
  process.exit(0);
}

const writeFallback = (name, text) => {
  mkdirSync(FALLBACK_DIR, { recursive: true });
  writeFileSync(resolve(FALLBACK_DIR, `${name}.md`), text, 'utf8');
};

if (FALLBACK_ONLY) {
  step('write n8n fallback files (repo render, no Langfuse)');
  for (const p of prompts) writeFallback(p.name, p.text);
  ok(`wrote ${prompts.length} file(s) to ${relative(root, FALLBACK_DIR)}`);
  process.exit(0);
}

// ── Step 2: connect to Langfuse ──
step('connect to Langfuse');
const fileEnv = existsSync(ENV_FILE) ? parseEnv(readFileSync(ENV_FILE, 'utf8')) : {};
const envValue = (k) => process.env[k] || fileEnv[k] || '';
const baseUrl = envValue('LANGFUSE_HOST_URL');
const publicKey = envValue('LANGFUSE_PUBLIC_KEY');
const secretKey = envValue('LANGFUSE_SECRET_KEY');
if (!baseUrl || !publicKey || !secretKey) fail(`LANGFUSE_HOST_URL / LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY not set (env or ${ENV_FILE})`);

const lf = createLangfuseClient({ baseUrl, publicKey, secretKey });
try {
  const health = await lf.health();
  if (!health.ok) fail(`health check HTTP ${health.status} at ${baseUrl}`);
  const projects = await lf.projects();
  if (projects.status === 401 || projects.status === 403) fail('Langfuse rejected the API keys (HTTP 401/403)');
  if (!projects.ok) fail(`GET /api/public/projects HTTP ${projects.status}`);
  const project = projects.json?.data?.[0];
  ok(`${baseUrl} healthy; project "${project?.name ?? 'unknown'}"`);
} catch (err) {
  fail(`cannot reach Langfuse at ${baseUrl}: ${err.cause?.code || err.message} (is the stack up? use --fallback-only to work offline)`);
}

let repoCommit = 'unknown';
try { repoCommit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* no commits yet */ }

// ── Step 3..n: seed each prompt ──
let created = 0;
let promoted = 0;
let unpromoted = 0;
for (const p of prompts) {
  step(p.name);
  const got = await lf.getPrompt(p.name, 'production');
  if (got.status !== 404 && got.status !== 200) fail(`GET production prompt HTTP ${got.status}: ${got.text.slice(0, 300)}`);
  const current = got.status === 200 ? got.json : null;
  // Production is often also the newest version; only fetch `latest` separately when it isn't.
  const latestRes = current?.labels?.includes('latest') ? { status: 200, json: current } : await lf.getPrompt(p.name, 'latest');
  const latest = latestRes.status === 200 ? latestRes.json : null;

  const plan = planSeedAction({ current, latest, rendered: p.text, promote: PROMOTE, force: FORCE });
  if (plan.uiEdited) warn('production version was NOT created by this script (edited in the Langfuse UI) — review the diff there');

  if (plan.action === 'promote') {
    const res = await lf.request('PATCH', `/api/public/v2/prompts/${encodeURIComponent(p.name)}/versions/${plan.version}`, { newLabels: ['production'] });
    if (!res.ok) fail(`promote v${plan.version} failed HTTP ${res.status}: ${res.text.slice(0, 300)}`);
    promoted++;
    ok(plan.reason);
  } else if (plan.action === 'create') {
    const res = await lf.createPrompt({
      name: p.name,
      type: 'text',
      prompt: p.text,
      labels: plan.labels,
      tags: ['tn-nature'],
      commitMessage: `seed-prompts ${repoCommit} (${sha256(p.text).slice(0, 12)})`,
      config: {
        seeded_by: SEEDED_BY,
        template: p.source,
        template_sha256: sha256(p.text),
        runtime_vars: p.meta.runtime_vars,
        repo_commit: repoCommit,
        seeded_at: new Date().toISOString(),
      },
    });
    if (!res.ok) fail(`create failed HTTP ${res.status}: ${res.text.slice(0, 300)}`);
    created++;
    if (plan.labels.includes('production')) promoted++; else unpromoted++;
    ok(`created version ${res.json?.version} — ${plan.reason}`);
  } else {
    if (plan.reason.includes('NOT promoted')) unpromoted++;
    ok(plan.reason);
  }

  // Fallback file = what is LIVE in production (may differ from the repo if not promoted).
  const live = await lf.getPrompt(p.name, 'production');
  if (live.status === 200) {
    writeFallback(p.name, live.json.prompt);
    ok(`fallback file updated from production v${live.json.version}`);
  } else {
    warn(`could not refresh fallback file (HTTP ${live.status})`);
  }
}

console.log(`\nDone. ${prompts.length} prompt(s): ${created} new version(s), ${promoted} promoted to production, ${unpromoted} awaiting review.`);
if (unpromoted) console.log('Review unpromoted versions in Langfuse → Prompts, then promote there or re-run with --promote.');
