// n8n provisioning helpers: credential definitions and workflow-set validation.
// Pure functions (no Docker / network) so they are unit-tested in tests/n8n.test.mjs.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';

/**
 * Fixed credential IDs. Workflow JSON references credentials by these IDs and names, so a
 * re-run of bootstrap upserts them instead of creating duplicates.
 * `needs` lists env vars that must be non-empty; otherwise the credential is skipped.
 */
export const CREDENTIAL_SPECS = [
  {
    id: 'langfuse', name: 'Langfuse API', type: 'httpBasicAuth',
    needs: ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY'],
    data: (e) => ({ user: e.LANGFUSE_PUBLIC_KEY, password: e.LANGFUSE_SECRET_KEY }),
  },
  {
    id: 'tn-app-db', name: 'TN App DB', type: 'postgres',
    needs: ['APP_DB_NAME', 'APP_DB_USER', 'APP_DB_PASSWORD'],
    data: (e) => ({ host: 'postgres', port: 5432, database: e.APP_DB_NAME, user: e.APP_DB_USER, password: e.APP_DB_PASSWORD, ssl: 'disable', maxConnections: 5 }),
  },
  {
    id: 'tn-media-s3', name: 'TN Media S3', type: 's3',
    needs: ['S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'],
    data: (e) => ({ endpoint: e.S3_ENDPOINT, region: e.S3_REGION || 'auto', accessKeyId: e.S3_ACCESS_KEY_ID, secretAccessKey: e.S3_SECRET_ACCESS_KEY, forcePathStyle: e.S3_FORCE_PATH_STYLE !== 'false', ignoreSSLIssues: false }),
  },
  {
    // n8n → tn-core (internal content service)
    id: 'tn-core', name: 'tn-core API', type: 'httpHeaderAuth',
    needs: ['TN_CORE_TOKEN'],
    data: (e) => ({ name: 'Authorization', value: `Bearer ${e.TN_CORE_TOKEN}` }),
  },
  {
    // Preferred for HTTP Request nodes calling the Messages API (captions).
    id: 'anthropic-header', name: 'Anthropic API (x-api-key)', type: 'httpHeaderAuth',
    needs: ['ANTHROPIC_API_KEY'],
    data: (e) => ({ name: 'x-api-key', value: e.ANTHROPIC_API_KEY }),
  },
  {
    // For n8n's native Anthropic Chat Model nodes (this type has no generic HTTP auth hook).
    id: 'anthropic', name: 'Anthropic', type: 'anthropicApi',
    needs: ['ANTHROPIC_API_KEY'],
    data: (e) => ({ apiKey: e.ANTHROPIC_API_KEY, url: 'https://api.anthropic.com', header: false, headerName: '', headerValue: '' }),
  },
  {
    // For n8n's native Gemini nodes. NOTE: this credential type sends the key as a ?key= query param.
    id: 'gemini', name: 'Google Gemini', type: 'googlePalmApi',
    needs: ['GEMINI_API_KEY'],
    data: (e) => ({ host: 'https://generativelanguage.googleapis.com', apiKey: e.GEMINI_API_KEY }),
  },
  {
    // Preferred for HTTP Request nodes: key travels in a header, never in URLs or logs.
    id: 'gemini-header', name: 'Gemini API (x-goog-api-key)', type: 'httpHeaderAuth',
    needs: ['GEMINI_API_KEY'],
    data: (e) => ({ name: 'x-goog-api-key', value: e.GEMINI_API_KEY }),
  },
  {
    // Meta Graph API (Facebook Page + Instagram), used only by [SUB] Graph call. A Page access
    // token (long-lived, from `npm run meta:setup`) sent as a Bearer header, never in URLs.
    id: 'meta-graph', name: 'Meta Graph API', type: 'httpHeaderAuth',
    needs: ['META_PAGE_ACCESS_TOKEN'],
    data: (e) => ({ name: 'Authorization', value: `Bearer ${e.META_PAGE_ACCESS_TOKEN}` }),
  },
];

const isBlank = (v) => v === undefined || v === null || String(v).trim() === '' || /^__(GENERATE|DERIVED)__$/.test(v);

/** Build the credential import payload from env. Returns { credentials, skipped }. */
export function buildCredentials(env, specs = CREDENTIAL_SPECS) {
  const credentials = [];
  const skipped = [];
  for (const spec of specs) {
    const missing = spec.needs.filter((k) => isBlank(env[k]));
    if (missing.length) {
      skipped.push({ id: spec.id, name: spec.name, missing });
      continue;
    }
    credentials.push({ id: spec.id, name: spec.name, type: spec.type, data: spec.data(env) });
  }
  return { credentials, skipped };
}

/** All *.json files under dir (recursive), as paths relative to dir with forward slashes. */
export function listWorkflowFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      const p = resolve(d, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (entry.endsWith('.json')) out.push(relative(dir, p).replace(/\\/g, '/'));
    }
  };
  walk(dir);
  return out.sort();
}

// Strings that must never appear in committed workflow exports.
const SECRET_PATTERNS = [
  [/sk-lf-[0-9a-z-]{8,}/i, 'Langfuse secret key'],
  [/pk-lf-[0-9a-z-]{8,}/i, 'Langfuse public key'],
  [/AIza[0-9A-Za-z_-]{30,}/, 'Google API key'],
  [/EAA[A-Za-z0-9]{30,}/, 'Meta access token'],
  [/"(password|apiKey|accessToken|secretAccessKey)"\s*:\s*"[^"={][^"]{3,}"/, 'inline credential field'],
  [/Bearer\s+[A-Za-z0-9._-]{16,}/, 'bearer token'],
];

/**
 * Validate the workflow set against the manifest and credential specs.
 * @param manifest   parsed n8n/manifest.json
 * @param files      { 'relative/path.json': parsedJson | Error }
 * @param rawTexts   { 'relative/path.json': fileText } for secret scanning
 * @returns string[] problems (empty = valid)
 */
export function validateWorkflowSet(manifest, files, rawTexts = {}, specs = CREDENTIAL_SPECS) {
  const problems = [];
  const entries = manifest.workflows ?? [];
  const ids = new Set(entries.map((e) => e.id));
  const credById = new Map(specs.map((s) => [s.id, s]));

  if (ids.size !== entries.length) problems.push('manifest has duplicate workflow ids');
  for (const file of Object.keys(files)) {
    if (!entries.some((e) => e.file === file)) problems.push(`${file} is not listed in n8n/manifest.json`);
  }

  for (const entry of entries) {
    const wf = files[entry.file];
    if (!wf) { problems.push(`manifest entry ${entry.id}: file ${entry.file} not found`); continue; }
    if (wf instanceof Error) { problems.push(`${entry.file}: invalid JSON (${wf.message})`); continue; }
    if (wf.id !== entry.id) problems.push(`${entry.file}: id "${wf.id}" does not match manifest id "${entry.id}"`);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(wf.id ?? '')) problems.push(`${entry.file}: id must be kebab-case`);
    if (!wf.name) problems.push(`${entry.file}: missing name`);
    if (!Array.isArray(wf.nodes) || !wf.nodes.length) { problems.push(`${entry.file}: no nodes`); continue; }

    const names = new Set();
    for (const node of wf.nodes) {
      if (names.has(node.name)) problems.push(`${entry.file}: duplicate node name "${node.name}"`);
      names.add(node.name);
      if (node.type === 'n8n-nodes-base.executeWorkflow') {
        const target = node.parameters?.workflowId?.value;
        if (!ids.has(target)) problems.push(`${entry.file}: node "${node.name}" calls unknown workflow "${target}"`);
      }
      for (const [credType, ref] of Object.entries(node.credentials ?? {})) {
        const spec = credById.get(ref.id);
        if (!spec) problems.push(`${entry.file}: node "${node.name}" uses unknown credential id "${ref.id}"`);
        else if (spec.type !== credType || spec.name !== ref.name) {
          problems.push(`${entry.file}: node "${node.name}" credential "${ref.id}" should be ${spec.type} "${spec.name}"`);
        }
      }
    }
    for (const [from, conn] of Object.entries(wf.connections ?? {})) {
      if (!names.has(from)) problems.push(`${entry.file}: connection from unknown node "${from}"`);
      for (const outputs of conn.main ?? []) {
        for (const c of outputs ?? []) if (!names.has(c.node)) problems.push(`${entry.file}: connection to unknown node "${c.node}"`);
      }
    }
    const text = rawTexts[entry.file] ?? '';
    for (const [re, label] of SECRET_PATTERNS) {
      if (re.test(text)) problems.push(`${entry.file}: contains what looks like a ${label}`);
    }
  }
  return problems;
}

/**
 * Extract the first output item of `nodeName` from `n8n execute --rawOutput` stdout.
 * Handles both log formats: with N8N_LOG_FORMAT=json the execution JSON is the `message`
 * of a log line; with text logs it is printed raw (possibly spanning many lines).
 * Returns { status, json } or null if no execution result is found.
 */
export function extractExecutionResult(stdout, nodeName) {
  const candidates = [];
  for (const line of stdout.split('\n')) {
    try {
      const obj = JSON.parse(line);
      if (typeof obj?.message === 'string' && obj.message.includes('resultData')) candidates.push(obj.message);
    } catch { /* not a JSON log line */ }
  }
  // Raw output: a pretty-printed object starting on its own line with "{".
  const rawStart = stdout.search(/(^|\n)\{\r?\n/);
  if (rawStart >= 0) candidates.push(stdout.slice(rawStart, stdout.lastIndexOf('}') + 1).trim());

  for (const text of candidates) {
    try {
      const exec = JSON.parse(text);
      const runs = exec?.data?.resultData?.runData?.[nodeName];
      const item = runs?.[runs.length - 1]?.data?.main?.[0]?.[0]?.json;
      if (item) return { status: exec.status, json: item };
    } catch { /* try next candidate */ }
  }
  return null;
}

/** Load manifest + workflow files from disk and validate. */
export function loadAndValidateWorkflows(root) {
  const workflowsDir = resolve(root, 'n8n/workflows');
  const manifest = JSON.parse(readFileSync(resolve(root, 'n8n/manifest.json'), 'utf8'));
  const files = {};
  const rawTexts = {};
  for (const file of listWorkflowFiles(workflowsDir)) {
    const text = readFileSync(resolve(workflowsDir, file), 'utf8');
    rawTexts[file] = text;
    try { files[file] = JSON.parse(text); } catch (err) { files[file] = err; }
  }
  return { manifest, files, problems: validateWorkflowSet(manifest, files, rawTexts) };
}
