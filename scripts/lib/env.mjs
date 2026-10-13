// Dependency-free helpers for reading and validating .env files.
// Shared by setup/check-env/doctor scripts and covered by tests/env.test.mjs.
import { randomBytes } from 'node:crypto';
import { GEMINI_ASPECT_RATIOS } from './models.mjs';

export const GENERATE_PLACEHOLDER = '__GENERATE__';
export const DERIVED_PLACEHOLDER = '__DERIVED__';
export const SUPPORTED_PLATFORMS = ['facebook', 'instagram', 'tiktok'];

const SECRET_NAME = /(PASSWORD|SECRET|TOKEN|API_KEY|ENCRYPTION_KEY|ACCESS_KEY|DATABASE_URL)/i;

/** True when a variable's value must never be printed. */
export function isSecretName(name) {
  return SECRET_NAME.test(name);
}

/** Display-safe rendering of a variable value. */
export function redact(name, value) {
  if (value === undefined || value === '') return '(empty)';
  return isSecretName(name) ? '***' : value;
}

/**
 * Parse dotenv-style text. Supports comments, blank lines, `export ` prefix and
 * single/double-quoted values. No variable expansion (docker compose does its own).
 */
export function parseEnv(text) {
  const vars = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2];
    const quoted = value.match(/^(['"])(.*)\1$/);
    if (quoted) value = quoted[2];
    else value = value.replace(/\s+#.*$/, '').trim();
    vars[m[1]] = value;
  }
  return vars;
}

/** Hex secrets are URL/shell/YAML safe, so they can go straight into DATABASE_URL. */
export function generateSecret(bytes = 24) {
  return randomBytes(bytes).toString('hex');
}

/**
 * Secret for a given variable name. Most are plain hex; some services impose formats:
 *  - 64-hex-char keys (n8n encryption, Langfuse ENCRYPTION_KEY)
 *  - Langfuse API keys conventionally prefixed pk-lf- / sk-lf-
 *  - login passwords must satisfy n8n's policy (8–64 chars, >=1 digit, >=1 uppercase)
 */
export function generateSecretFor(name, secret = generateSecret) {
  if (name === 'N8N_ENCRYPTION_KEY' || name === 'LANGFUSE_ENCRYPTION_KEY') return secret(32);
  if (name === 'LANGFUSE_PUBLIC_KEY') return `pk-lf-${secret(16)}`;
  if (name === 'LANGFUSE_SECRET_KEY') return `sk-lf-${secret(16)}`;
  if (/(OWNER|USER)_PASSWORD$/.test(name)) return `Tn-${secret(12)}-9X`;
  return secret(24);
}

export function deriveDatabaseUrl(vars) {
  const user = encodeURIComponent(vars.APP_DB_USER ?? 'tn_app');
  const pass = encodeURIComponent(vars.APP_DB_PASSWORD ?? '');
  const port = vars.POSTGRES_HOST_PORT || '5433';
  const db = encodeURIComponent(vars.APP_DB_NAME ?? 'tn_content');
  return `postgresql://${user}:${pass}@localhost:${port}/${db}?schema=public`;
}

/**
 * Render a new .env from the template text: fill __GENERATE__ with random secrets
 * and __DERIVED__ values from other variables. Comments and ordering are preserved.
 */
export function renderEnvFromTemplate(templateText, { secret = generateSecret } = {}) {
  const lines = templateText.split(/\r?\n/);
  const values = {};
  const out = lines.map((line) => {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) return line;
    const [, name, value] = m;
    if (value === GENERATE_PLACEHOLDER) {
      values[name] = generateSecretFor(name, secret);
      return `${name}=${values[name]}`;
    }
    values[name] = value;
    return line;
  });
  return out
    .map((line) => {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=__DERIVED__$/);
      if (!m) return line;
      if (m[1] === 'DATABASE_URL') return `DATABASE_URL=${deriveDatabaseUrl(values)}`;
      throw new Error(`No derivation rule for ${m[1]}`);
    })
    .join('\n');
}

/**
 * Lines to append to an existing .env so it defines every variable in the template.
 * Generated secrets are filled in; existing values are never touched.
 * DATABASE_URL-style derived values are computed from the merged variables.
 */
export function missingEnvLines(templateText, existingVars, { secret = generateSecret } = {}) {
  const template = parseEnv(templateText);
  const merged = { ...existingVars };
  const lines = [];
  for (const [name, value] of Object.entries(template)) {
    if (name in existingVars) continue;
    merged[name] = value === GENERATE_PLACEHOLDER ? generateSecretFor(name, secret) : value;
    lines.push([name, merged[name]]);
  }
  return lines.map(([name, value]) => {
    if (value !== DERIVED_PLACEHOLDER) return `${name}=${value}`;
    if (name === 'DATABASE_URL') return `${name}=${deriveDatabaseUrl(merged)}`;
    throw new Error(`No derivation rule for ${name}`);
  });
}

/** Parse "HH:MM" to minutes since midnight, or null if invalid. */
export function parseClock(value) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value ?? '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

const pad = (n) => String(n).padStart(2, '0');

/** Local wall-clock publishing slots, e.g. ['07:00','09:00',...,'21:00']. */
export function computeSlots(start, end, intervalMinutes) {
  const s = parseClock(start);
  const e = parseClock(end);
  const step = Number(intervalMinutes);
  if (s === null || e === null) throw new Error('Window times must be HH:MM (24h)');
  if (!Number.isInteger(step) || step < 15) throw new Error('Interval must be an integer >= 15 minutes');
  if (e < s) throw new Error('Window end must not be before window start');
  const slots = [];
  for (let t = s; t <= e; t += step) slots.push(`${pad(Math.floor(t / 60))}:${pad(t % 60)}`);
  return slots;
}

export function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return Boolean(tz);
  } catch {
    return false;
  }
}

export function isN8nPasswordValid(pw) {
  return pw.length >= 8 && pw.length <= 64 && /\d/.test(pw) && /[A-Z]/.test(pw);
}

export function langfuseProfileEnabled(vars) {
  return (vars.COMPOSE_PROFILES ?? '').split(',').map((p) => p.trim()).includes('langfuse');
}

const REQUIRED = [
  'TZ', 'GENERIC_TIMEZONE',
  'POSTGRES_SUPERUSER_PASSWORD', 'N8N_DB_NAME', 'N8N_DB_USER', 'N8N_DB_PASSWORD',
  'APP_DB_NAME', 'APP_DB_USER', 'APP_DB_PASSWORD', 'DATABASE_URL',
  'N8N_ENCRYPTION_KEY',
  'S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY',
  'PUBLISH_TIMEZONE', 'PUBLISH_WINDOW_START', 'PUBLISH_WINDOW_END', 'PUBLISH_INTERVAL_MINUTES',
  'DAILY_POST_CAP', 'PUBLISHING_ENABLED', 'ENABLED_PLATFORMS',
];

/**
 * Validate a parsed env. Returns { errors, warnings, info } as arrays of strings.
 * Messages never contain secret values.
 */
export function validateEnv(vars, { templateVars = {} } = {}) {
  const errors = [];
  const warnings = [];
  const info = [];

  for (const name of REQUIRED) {
    if (!vars[name]) errors.push(`${name} is missing or empty`);
  }
  for (const [name, value] of Object.entries(vars)) {
    if (value === GENERATE_PLACEHOLDER || value === DERIVED_PLACEHOLDER) {
      errors.push(`${name} still contains a placeholder; run npm run setup or set it manually`);
    }
  }
  for (const name of Object.keys(templateVars)) {
    if (!(name in vars)) warnings.push(`${name} is defined in .env.example but missing from .env`);
  }

  if (vars.N8N_ENCRYPTION_KEY && vars.N8N_ENCRYPTION_KEY.length < 32) {
    errors.push('N8N_ENCRYPTION_KEY must be at least 32 characters');
  }

  for (const name of ['TZ', 'GENERIC_TIMEZONE', 'PUBLISH_TIMEZONE']) {
    if (!vars[name]) continue;
    if (!isValidTimeZone(vars[name])) errors.push(`${name} is not a valid IANA time zone`);
    else if (vars[name] !== 'Africa/Tunis') warnings.push(`${name} is ${vars[name]}, expected Africa/Tunis`);
  }

  if (vars.PUBLISH_WINDOW_START && vars.PUBLISH_WINDOW_END && vars.PUBLISH_INTERVAL_MINUTES) {
    try {
      const slots = computeSlots(vars.PUBLISH_WINDOW_START, vars.PUBLISH_WINDOW_END, vars.PUBLISH_INTERVAL_MINUTES);
      info.push(`Publishing slots (${vars.PUBLISH_TIMEZONE}): ${slots.join(', ')} = ${slots.length}/day`);
      const cap = Number(vars.DAILY_POST_CAP);
      if (Number.isInteger(cap) && cap < slots.length) {
        warnings.push(`DAILY_POST_CAP=${cap} is below the ${slots.length} scheduled slots; later slots will be skipped`);
      }
    } catch (err) {
      errors.push(`Schedule: ${err.message}`);
    }
  }

  if (vars.DAILY_POST_CAP && !/^\d+$/.test(vars.DAILY_POST_CAP)) {
    errors.push('DAILY_POST_CAP must be a non-negative integer');
  }
  if (vars.DESTINATION_COOLDOWN_HOURS && !/^\d+$/.test(vars.DESTINATION_COOLDOWN_HOURS)) {
    errors.push('DESTINATION_COOLDOWN_HOURS must be a non-negative integer');
  }
  if ('DESTINATION_COOLDOWN_DAYS' in vars) {
    warnings.push('DESTINATION_COOLDOWN_DAYS is replaced by DESTINATION_COOLDOWN_HOURS; you can delete it');
  }

  if (vars.PUBLISHING_ENABLED && !['true', 'false'].includes(vars.PUBLISHING_ENABLED)) {
    errors.push('PUBLISHING_ENABLED must be true or false');
  } else if (vars.PUBLISHING_ENABLED === 'false') {
    info.push('Kill switch active: PUBLISHING_ENABLED=false (content may be produced, nothing is published)');
  }

  if (vars.ENABLED_PLATFORMS) {
    const platforms = vars.ENABLED_PLATFORMS.split(',').map((p) => p.trim()).filter(Boolean);
    const unknown = platforms.filter((p) => !SUPPORTED_PLATFORMS.includes(p));
    if (unknown.length) errors.push(`ENABLED_PLATFORMS has unknown entries: ${unknown.join(', ')}`);
    if (platforms.includes('tiktok')) {
      warnings.push('tiktok is enabled; it will be skipped automatically unless Direct Post authorization is confirmed');
    }
  }

  if (vars.DATABASE_URL && !/^postgres(ql)?:\/\//.test(vars.DATABASE_URL)) {
    errors.push('DATABASE_URL must start with postgresql://');
  }

  // n8n owner (created by bootstrap-n8n)
  for (const name of ['N8N_OWNER_EMAIL', 'N8N_OWNER_PASSWORD']) {
    if (!vars[name]) errors.push(`${name} is missing or empty (needed by npm run bootstrap:n8n)`);
  }
  if (vars.N8N_OWNER_PASSWORD && !isN8nPasswordValid(vars.N8N_OWNER_PASSWORD)) {
    errors.push('N8N_OWNER_PASSWORD must be 8–64 chars with at least one digit and one uppercase letter');
  }

  // Langfuse (local profile or Cloud)
  for (const name of ['LANGFUSE_BASE_URL', 'LANGFUSE_HOST_URL', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY']) {
    if (!vars[name]) errors.push(`${name} is missing or empty`);
  }
  for (const name of ['LANGFUSE_BASE_URL', 'LANGFUSE_HOST_URL']) {
    if (vars[name] && !/^https?:\/\/[^\s/]+/.test(vars[name])) errors.push(`${name} must be an http(s) URL`);
  }
  if (langfuseProfileEnabled(vars)) {
    for (const name of ['LANGFUSE_DB_PASSWORD', 'LANGFUSE_NEXTAUTH_SECRET', 'LANGFUSE_SALT', 'LANGFUSE_ENCRYPTION_KEY',
      'LANGFUSE_CLICKHOUSE_PASSWORD', 'LANGFUSE_REDIS_PASSWORD', 'LANGFUSE_INIT_USER_EMAIL', 'LANGFUSE_INIT_USER_PASSWORD']) {
      if (!vars[name]) errors.push(`${name} is required when COMPOSE_PROFILES includes langfuse`);
    }
    if (vars.LANGFUSE_ENCRYPTION_KEY && !/^[0-9a-f]{64}$/i.test(vars.LANGFUSE_ENCRYPTION_KEY)) {
      errors.push('LANGFUSE_ENCRYPTION_KEY must be 64 hex characters');
    }
    info.push('Langfuse: local self-hosted profile enabled');
  } else if (vars.LANGFUSE_BASE_URL) {
    info.push('Langfuse: external instance (profile "langfuse" not enabled)');
  }

  // Text model (Claude) and image model (Gemini)
  if (!vars.ANTHROPIC_API_KEY) warnings.push('ANTHROPIC_API_KEY is empty (captions need it; then run npm run bootstrap:n8n)');
  if (vars.ANTHROPIC_TEXT_MODEL && !/^claude-[a-z0-9-]+$/.test(vars.ANTHROPIC_TEXT_MODEL)) errors.push('ANTHROPIC_TEXT_MODEL must be a Claude model id (e.g. claude-opus-5-5)');
  if (vars.ANTHROPIC_EFFORT && !['low', 'medium', 'high', 'xhigh', 'max'].includes(vars.ANTHROPIC_EFFORT)) errors.push('ANTHROPIC_EFFORT must be low|medium|high|xhigh|max');
  if (vars.ANTHROPIC_MAX_TOKENS && !/^\d+$/.test(vars.ANTHROPIC_MAX_TOKENS)) errors.push('ANTHROPIC_MAX_TOKENS must be an integer');
  if (!vars.GEMINI_API_KEY) warnings.push('GEMINI_API_KEY is empty (images need it; then run npm run bootstrap:n8n)');
  if (!vars.GEMINI_IMAGE_MODEL) warnings.push('GEMINI_IMAGE_MODEL is empty (recommended: gemini-nano-banana-2.1)');
  else if (vars.GEMINI_IMAGE_MODEL === 'gemini-2.5-flash-image') errors.push('GEMINI_IMAGE_MODEL gemini-2.5-flash-image was shut down on 2026-10-02; use gemini-nano-banana-2.1');
  if (vars.GEMINI_IMAGE_SIZE && !['1K', '2K', '4K'].includes(vars.GEMINI_IMAGE_SIZE)) errors.push('GEMINI_IMAGE_SIZE must be 1K, 2K or 4K (uppercase K)');
  if (vars.GEMINI_IMAGE_ASPECT_RATIO && !GEMINI_ASPECT_RATIOS.includes(vars.GEMINI_IMAGE_ASPECT_RATIO)) {
    errors.push(`GEMINI_IMAGE_ASPECT_RATIO must be one of ${GEMINI_ASPECT_RATIOS.join(', ')}`);
  }
  for (const old of ['GEMINI_TEXT_MODEL', 'GEMINI_MAX_TEXT_CALLS_PER_DAY']) {
    if (old in vars) warnings.push(`${old} is no longer used (text model is Claude: ANTHROPIC_TEXT_MODEL); you can delete it`);
  }

  if (vars.N8N_PROTOCOL === 'https' && vars.N8N_SECURE_COOKIE === 'false') {
    warnings.push('N8N_SECURE_COOKIE=false with https; enable secure cookies in production');
  }

  return { errors, warnings, info };
}
