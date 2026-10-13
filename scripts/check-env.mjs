#!/usr/bin/env node
// Validates .env without ever printing secret values. Exit code 1 on errors.
// Usage: node scripts/check-env.mjs [path-to-env]
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseEnv, validateEnv } from './lib/env.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = resolve(root, process.argv[2] ?? '.env');

if (!existsSync(envPath)) {
  console.error(`✗ ${envPath} not found. Run: npm run setup`);
  process.exit(1);
}

const vars = parseEnv(readFileSync(envPath, 'utf8'));
const templateVars = parseEnv(readFileSync(resolve(root, '.env.example'), 'utf8'));
const { errors, warnings, info } = validateEnv(vars, { templateVars });

// The env file must be git-ignored.
try {
  execFileSync('git', ['check-ignore', '-q', envPath], { cwd: root, stdio: 'ignore' });
} catch (err) {
  if (err.status === 1) errors.push(`${envPath} is NOT git-ignored; fix .gitignore before committing`);
}

for (const m of info) console.log(`ℹ ${m}`);
for (const m of warnings) console.log(`⚠ ${m}`);
for (const m of errors) console.log(`✗ ${m}`);
console.log(errors.length ? `\n${errors.length} error(s).` : `\n✓ .env is valid (${warnings.length} warning(s)).`);
process.exit(errors.length ? 1 : 0);
