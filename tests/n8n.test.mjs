import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { buildCredentials, validateWorkflowSet, loadAndValidateWorkflows, extractExecutionResult, CREDENTIAL_SPECS } from '../scripts/lib/n8n.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

test('repo workflows are valid against the manifest and credential specs', () => {
  const { problems, manifest } = loadAndValidateWorkflows(root);
  assert.deepEqual(problems, []);
  assert.ok(manifest.workflows.length >= 3);
});

test('buildCredentials skips credentials whose env vars are empty or placeholders', () => {
  const { credentials, skipped } = buildCredentials({
    LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk',
    APP_DB_NAME: 'db', APP_DB_USER: 'u', APP_DB_PASSWORD: '__GENERATE__',
    S3_ENDPOINT: 'http://s3', S3_ACCESS_KEY_ID: 'a', S3_SECRET_ACCESS_KEY: 's',
    GEMINI_API_KEY: '',
  });
  assert.deepEqual(credentials.map((c) => c.id), ['langfuse', 'tn-media-s3']);
  assert.deepEqual(skipped.map((s) => s.id), ['tn-app-db', 'tn-core', 'anthropic-header', 'anthropic', 'gemini', 'gemini-header', 'meta-graph']);
});

test('Meta credential sends the Page token as a Bearer header', () => {
  const { credentials } = buildCredentials({ META_PAGE_ACCESS_TOKEN: 'tok' });
  assert.deepEqual(credentials.find((c) => c.id === 'meta-graph').data, { name: 'Authorization', value: 'Bearer tok' });
});

test('Gemini header credential uses x-goog-api-key, not a URL query param', () => {
  const { credentials } = buildCredentials({ GEMINI_API_KEY: 'k' });
  const header = credentials.find((c) => c.id === 'gemini-header');
  assert.deepEqual(header.data, { name: 'x-goog-api-key', value: 'k' });
});

test('credential IDs are unique and kebab-case', () => {
  const ids = CREDENTIAL_SPECS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[a-z0-9-]+$/);
});

const wf = (extra = {}) => ({
  id: 'a', name: 'A',
  nodes: [{ name: 'Start', type: 'n8n-nodes-base.manualTrigger' }],
  connections: {},
  ...extra,
});

test('validateWorkflowSet catches drift between manifest and files', () => {
  const problems = validateWorkflowSet(
    { workflows: [{ id: 'a', file: 'a.json' }, { id: 'b', file: 'b.json' }] },
    { 'a.json': wf({ id: 'wrong' }), 'extra.json': wf() },
  );
  assert.ok(problems.some((p) => p.includes('extra.json is not listed')));
  assert.ok(problems.some((p) => p.includes('b.json not found')));
  assert.ok(problems.some((p) => p.includes('id "wrong" does not match')));
});

test('validateWorkflowSet catches bad sub-workflow targets and credential refs', () => {
  const problems = validateWorkflowSet({ workflows: [{ id: 'a', file: 'a.json' }] }, {
    'a.json': wf({
      nodes: [
        { name: 'Call', type: 'n8n-nodes-base.executeWorkflow', parameters: { workflowId: { value: 'ghost' } } },
        { name: 'HTTP', type: 'n8n-nodes-base.httpRequest', credentials: { httpBasicAuth: { id: 'langfuse', name: 'Wrong name' } } },
        { name: 'DB', type: 'n8n-nodes-base.postgres', credentials: { postgres: { id: 'nope', name: 'x' } } },
      ],
      connections: { Call: { main: [[{ node: 'Missing', type: 'main', index: 0 }]] } },
    }),
  });
  assert.ok(problems.some((p) => p.includes('unknown workflow "ghost"')));
  assert.ok(problems.some((p) => p.includes('should be httpBasicAuth "Langfuse API"')));
  assert.ok(problems.some((p) => p.includes('unknown credential id "nope"')));
  assert.ok(problems.some((p) => p.includes('connection to unknown node "Missing"')));
});

const execution = { status: 'success', data: { resultData: { runData: { Result: [{ data: { main: [[{ json: { ok: true } }]] } }] } } } };

test('extractExecutionResult reads the JSON-log-format output of n8n execute', () => {
  const stdout = [
    '{"level":"info","message":"Task broker ready"}',
    JSON.stringify({ level: 'info', message: JSON.stringify(execution, null, 2) }),
  ].join('\n');
  assert.deepEqual(extractExecutionResult(stdout, 'Result'), { status: 'success', json: { ok: true } });
});

test('extractExecutionResult reads the text-log-format (raw) output', () => {
  const stdout = `Some log line\n${JSON.stringify(execution, null, 2)}\n`;
  assert.deepEqual(extractExecutionResult(stdout, 'Result')?.json, { ok: true });
  assert.equal(extractExecutionResult('no json here', 'Result'), null);
});

test('validateWorkflowSet flags secrets embedded in workflow exports', () => {
  const manifest = { workflows: [{ id: 'a', file: 'a.json' }] };
  for (const secret of ['sk-lf-0123456789abcdef', 'AIzaSyA1234567890abcdefghijklmnopqrstu', '"password": "hunter22"']) {
    const problems = validateWorkflowSet(manifest, { 'a.json': wf() }, { 'a.json': `{"x": 1, ${secret.startsWith('"') ? secret : `"v": "${secret}"`}}` });
    assert.ok(problems.some((p) => p.includes('looks like')), secret);
  }
});
