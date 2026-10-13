#!/usr/bin/env node
// Creates .env from .env.example with freshly generated secrets.
// NEVER overwrites an existing .env. With an existing .env it reports missing variables;
// `--add-missing` appends only those (secrets generated), leaving every existing line untouched.
//
// Usage: node scripts/setup.mjs [--add-missing]
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv, renderEnvFromTemplate, missingEnvLines } from './lib/env.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const templatePath = resolve(root, '.env.example');
const envPath = resolve(root, '.env');
const addMissing = process.argv.includes('--add-missing');

const template = readFileSync(templatePath, 'utf8');

// Directories mounted into containers must exist before `docker compose up`.
for (const dir of ['n8n/files/prompts', 'n8n/workflows/sub-workflows', 'backups']) {
  mkdirSync(resolve(root, dir), { recursive: true });
}

if (existsSync(envPath)) {
  const existingText = readFileSync(envPath, 'utf8');
  const lines = missingEnvLines(template, parseEnv(existingText));
  const names = lines.map((l) => l.split('=')[0]);
  if (!lines.length) {
    console.log('.env already exists and defines every variable in .env.example; nothing to do.');
    process.exit(0);
  }
  if (!addMissing) {
    console.log('.env already exists; leaving it untouched.');
    console.log(`Variables in .env.example missing from .env:\n  ${names.join('\n  ')}`);
    console.log('Append them (with generated secrets) via: npm run setup -- --add-missing');
    process.exit(0);
  }
  const stamp = new Date().toISOString();
  const sep = existingText.endsWith('\n') ? '' : '\n';
  appendFileSync(envPath, `${sep}\n# ---- Added by setup --add-missing (${stamp}); see .env.example for comments ----\n${lines.join('\n')}\n`);
  console.log(`Appended ${lines.length} variable(s) to .env (values not shown):\n  ${names.join('\n  ')}`);
  process.exit(0);
}

const rendered = renderEnvFromTemplate(template);
// mode 0o600 restricts the file on Linux/macOS; on Windows it is ignored (rely on user-profile ACLs).
writeFileSync(envPath, rendered, { encoding: 'utf8', mode: 0o600, flag: 'wx' });

console.log('Created .env with generated local secrets (values not shown).');
console.log('Next steps:');
console.log('  1. Open .env and set GEMINI_API_KEY to your existing key (never commit it).');
console.log('  2. Back up N8N_ENCRYPTION_KEY and LANGFUSE_ENCRYPTION_KEY somewhere safe (password manager).');
console.log('  3. npm run dev:up   (starts the stack, seeds prompts, provisions n8n)');
