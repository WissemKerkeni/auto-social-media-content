import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseEnv, renderEnvFromTemplate, computeSlots, validateEnv, redact, isSecretName, deriveDatabaseUrl,
} from '../scripts/lib/env.mjs';

const template = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');

test('parseEnv handles comments, quotes, export and inline comments', () => {
  const vars = parseEnv([
    '# comment', '', 'A=1', 'export B=two', 'C="quoted # not comment"', "D='single'", 'E=val # trailing', 'F=',
  ].join('\n'));
  assert.deepEqual(vars, { A: '1', B: 'two', C: 'quoted # not comment', D: 'single', E: 'val', F: '' });
});

test('parseEnv tolerates CRLF line endings', () => {
  assert.deepEqual(parseEnv('A=1\r\nB=2\r\n'), { A: '1', B: '2' });
});

test('renderEnvFromTemplate fills every placeholder with unique secrets', () => {
  const vars = parseEnv(renderEnvFromTemplate(template));
  for (const [k, v] of Object.entries(vars)) {
    assert.ok(!v.includes('__GENERATE__') && !v.includes('__DERIVED__'), `${k} still has a placeholder`);
  }
  assert.equal(vars.N8N_ENCRYPTION_KEY.length, 64);
  const secrets = ['POSTGRES_SUPERUSER_PASSWORD', 'N8N_DB_PASSWORD', 'APP_DB_PASSWORD', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'];
  assert.equal(new Set(secrets.map((k) => vars[k])).size, secrets.length, 'secrets must differ');
});

test('rendered DATABASE_URL matches app DB credentials and host port', () => {
  const vars = parseEnv(renderEnvFromTemplate(template));
  const url = new URL(vars.DATABASE_URL);
  assert.equal(url.username, vars.APP_DB_USER);
  assert.equal(decodeURIComponent(url.password), vars.APP_DB_PASSWORD);
  assert.equal(url.port, vars.POSTGRES_HOST_PORT);
  assert.equal(url.pathname, `/${vars.APP_DB_NAME}`);
});

test('deriveDatabaseUrl percent-encodes special characters', () => {
  const url = deriveDatabaseUrl({ APP_DB_USER: 'u', APP_DB_PASSWORD: 'p@ss/w:rd', APP_DB_NAME: 'db', POSTGRES_HOST_PORT: '5433' });
  assert.equal(decodeURIComponent(new URL(url).password), 'p@ss/w:rd');
});

test('default window 07:00–21:00 every 120 min yields the 8 required slots', () => {
  assert.deepEqual(computeSlots('07:00', '21:00', '120'),
    ['07:00', '09:00', '11:00', '13:00', '15:00', '17:00', '19:00', '21:00']);
});

test('computeSlots rejects invalid input', () => {
  assert.throws(() => computeSlots('7:00', '21:00', 120), /HH:MM/);
  assert.throws(() => computeSlots('21:00', '07:00', 120), /before/);
  assert.throws(() => computeSlots('07:00', '21:00', 5), /Interval/);
  assert.throws(() => computeSlots('07:00', '24:00', 120), /HH:MM/);
});

test('validateEnv accepts a freshly rendered env (only API-key warnings)', () => {
  const vars = parseEnv(renderEnvFromTemplate(template));
  const { errors, warnings, info } = validateEnv(vars, { templateVars: parseEnv(template) });
  assert.deepEqual(errors, []);
  assert.ok(warnings.every((w) => /^(GEMINI|ANTHROPIC)_API_KEY is empty/.test(w)), warnings.join('; '));
  assert.ok(info.some((m) => m.includes('= 8/day')));
});

test('validateEnv reports placeholders, bad timezone, bad platforms and short key', () => {
  const vars = parseEnv(renderEnvFromTemplate(template));
  const { errors } = validateEnv({
    ...vars,
    APP_DB_PASSWORD: '__GENERATE__',
    TZ: 'Mars/Olympus',
    ENABLED_PLATFORMS: 'facebook,myspace',
    N8N_ENCRYPTION_KEY: 'short',
    PUBLISHING_ENABLED: 'yes',
  });
  const joined = errors.join('\n');
  assert.match(joined, /APP_DB_PASSWORD still contains a placeholder/);
  assert.match(joined, /TZ is not a valid IANA time zone/);
  assert.match(joined, /unknown entries: myspace/);
  assert.match(joined, /N8N_ENCRYPTION_KEY must be at least 32/);
  assert.match(joined, /PUBLISHING_ENABLED must be true or false/);
});

test('validation messages never contain secret values', () => {
  const vars = parseEnv(renderEnvFromTemplate(template));
  const result = validateEnv({ ...vars, N8N_ENCRYPTION_KEY: 'tooshort-secret' });
  const all = [...result.errors, ...result.warnings, ...result.info].join('\n');
  for (const [k, v] of Object.entries(vars)) {
    if (isSecretName(k) && v.length > 8) assert.ok(!all.includes(v), `${k} leaked`);
  }
  assert.ok(!all.includes('tooshort-secret'));
});

test('redact hides secret-looking names only', () => {
  assert.equal(redact('GEMINI_API_KEY', 'abc'), '***');
  assert.equal(redact('APP_DB_PASSWORD', 'abc'), '***');
  assert.equal(redact('DATABASE_URL', 'postgresql://x'), '***');
  assert.equal(redact('TZ', 'Africa/Tunis'), 'Africa/Tunis');
  assert.equal(redact('GEMINI_API_KEY', ''), '(empty)');
});
