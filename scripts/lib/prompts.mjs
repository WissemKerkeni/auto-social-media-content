// Prompt templates: parse header metadata, render deploy-time variables, validate placeholders,
// and decide what seed-prompts should do against Langfuse. Pure functions; no I/O.
//
// Template format (prompts/templates/<name>.md):
//   <!--
//   name: tn-caption-request
//   description: one line
//   config_vars: page_name, base_hashtags      ← filled at seed time from prompts/config.json
//                                                 (or from prompts/shared/<var>.md partials)
//   runtime_vars: destination_name_en, ...     ← left as {{var}} for Langfuse/n8n to compile at run time
//   -->
//   prompt body with {{placeholders}}
import { createHash } from 'node:crypto';

const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;

export const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

const list = (value) => (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/** Split a template into { meta, body }. The header comment is required for templates. */
export function parseTemplate(text, { requireHeader = true } = {}) {
  const normalized = text.replace(/\r\n/g, '\n');
  const m = normalized.match(/^<!--\n([\s\S]*?)\n-->\n?/);
  if (!m) {
    if (requireHeader) throw new Error('template must start with a <!-- ... --> header block');
    return { meta: { config_vars: [], runtime_vars: [] }, body: normalized.trim() + '\n' };
  }
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return {
    meta: { ...meta, config_vars: list(meta.config_vars), runtime_vars: list(meta.runtime_vars) },
    body: normalized.slice(m[0].length).trim() + '\n',
  };
}

export function placeholdersIn(text) {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]))];
}

function formatValue(value) {
  if (Array.isArray(value)) return value.join(' ');
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Render deploy-time variables. `config` supplies values; `partials` maps names to
 * already-parsed partial templates (e.g. voice_and_language). Runtime vars are left intact.
 * Throws with every problem listed at once.
 */
export function renderTemplate({ meta, body }, { config = {}, partials = {} } = {}) {
  const problems = [];
  const values = {};
  for (const name of meta.config_vars) {
    if (partials[name]) {
      values[name] = renderTemplate(partials[name], { config }).trimEnd();
    } else if (config[name] === undefined || config[name] === null || config[name] === '') {
      problems.push(`config var "${name}" has no value in prompts/config.json`);
    } else {
      values[name] = formatValue(config[name]);
    }
  }
  const overlap = meta.config_vars.filter((v) => meta.runtime_vars.includes(v));
  if (overlap.length) problems.push(`declared as both config and runtime: ${overlap.join(', ')}`);

  const rendered = body.replace(PLACEHOLDER, (whole, name) => (name in values ? values[name] : whole));

  const remaining = placeholdersIn(rendered);
  // Config vars without a value were already reported above; don't report them twice.
  const undeclared = remaining.filter((v) => !meta.runtime_vars.includes(v) && !meta.config_vars.includes(v));
  if (undeclared.length) problems.push(`undeclared placeholders: ${undeclared.map((v) => `{{${v}}}`).join(', ')}`);
  const unused = meta.runtime_vars.filter((v) => !remaining.includes(v));
  if (unused.length) problems.push(`runtime_vars declared but not used: ${unused.join(', ')}`);

  if (problems.length) {
    const err = new Error(`${meta.name ?? 'template'}: ${problems.join('; ')}`);
    err.problems = problems;
    throw err;
  }
  return rendered;
}

/** Marker stored in prompt.config so later runs can tell script-seeded versions from UI edits. */
export const SEEDED_BY = 'seed-prompts';

/**
 * Decide the seed action for one prompt.
 * @param current  Langfuse GET ?label=production response JSON, or null when 404
 * @param latest   Langfuse GET ?label=latest response JSON, or null (newest version, any label)
 * @param rendered rendered prompt text from the repo
 * @param promote  --promote flag
 * @param force    --force flag: allows --promote to replace a production version edited in the UI
 * @returns {{action:'create'|'promote'|'skip', labels:string[], version?:number, reason:string, uiEdited:boolean}}
 *   create  → POST a new version with `labels`
 *   promote → move `production` onto existing `version` (its text already equals the repo)
 */
export function planSeedAction({ current, latest = null, rendered, promote = false, force = false }) {
  // The repo text was already pushed as the newest version but isn't production yet:
  // reuse that version instead of creating duplicates on every run.
  const pending = latest && latest.prompt === rendered && latest.version !== current?.version ? latest : null;

  if (!current) {
    if (pending) return { action: 'promote', labels: ['production'], version: pending.version, reason: `no production version → promoting existing v${pending.version}`, uiEdited: false };
    return { action: 'create', labels: ['production'], reason: 'initial seed → production', uiEdited: false };
  }
  if (current.prompt === rendered) {
    return { action: 'skip', labels: [], reason: `unchanged (production v${current.version})`, uiEdited: false };
  }
  // A production version not created by this script was edited in the Langfuse UI.
  // Never replace it silently: repo changes stay unpromoted unless --promote --force.
  const uiEdited = current.config?.seeded_by !== SEEDED_BY;
  const blocked = !promote || (uiEdited && !force);
  const why = !promote
    ? 'NOT promoted (review in Langfuse or re-run with --promote)'
    : 'NOT promoted: production was edited in the Langfuse UI (use --promote --force to override)';

  if (pending) {
    if (blocked) return { action: 'skip', labels: [], uiEdited, reason: `repo text already pushed as v${pending.version}, ${why}` };
    return { action: 'promote', labels: ['production'], version: pending.version, uiEdited, reason: `promoting existing v${pending.version} to production (--promote)` };
  }
  if (blocked) return { action: 'create', labels: [], uiEdited, reason: `changed → new version, ${why}` };
  return { action: 'create', labels: ['production'], uiEdited, reason: 'changed → new version promoted to production (--promote)' };
}
