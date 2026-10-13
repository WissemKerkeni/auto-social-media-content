import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { parseTemplate, renderTemplate, placeholdersIn, planSeedAction, SEEDED_BY } from '../scripts/lib/prompts.mjs';

const tpl = (header, body) => parseTemplate(`<!--\n${header}\n-->\n${body}`);

test('parseTemplate reads header lists and strips the header', () => {
  const t = tpl('name: x\nconfig_vars: a, b\nruntime_vars: c', 'Hello {{a}} {{c}}');
  assert.equal(t.meta.name, 'x');
  assert.deepEqual(t.meta.config_vars, ['a', 'b']);
  assert.deepEqual(t.meta.runtime_vars, ['c']);
  assert.equal(t.body, 'Hello {{a}} {{c}}\n');
});

test('parseTemplate requires a header and tolerates CRLF', () => {
  assert.throws(() => parseTemplate('no header'), /header/);
  assert.equal(parseTemplate('<!--\r\nname: y\r\n-->\r\nbody\r\n').meta.name, 'y');
});

test('renderTemplate fills config vars, joins arrays, keeps runtime vars', () => {
  const t = tpl('name: x\nconfig_vars: page, tags\nruntime_vars: place', '{{page}} {{tags}} {{ place }}');
  assert.equal(renderTemplate(t, { config: { page: 'P', tags: ['#a', '#b'] } }), 'P #a #b {{ place }}\n');
});

test('renderTemplate embeds partials (rendered with the same config)', () => {
  const partial = tpl('name: voice\nconfig_vars: page', 'Voice of {{page}}');
  const t = tpl('name: x\nconfig_vars: page, voice', '{{voice}}!');
  assert.equal(renderTemplate(t, { config: { page: 'P' }, partials: { voice: partial } }), 'Voice of P!\n');
});

test('renderTemplate reports every problem at once', () => {
  const t = tpl('name: x\nconfig_vars: missing\nruntime_vars: unused', '{{missing}} {{typo}}');
  try {
    renderTemplate(t, { config: {} });
    assert.fail('should throw');
  } catch (err) {
    assert.equal(err.problems.length, 3);
    assert.match(err.message, /"missing" has no value/);
    assert.match(err.message, /undeclared placeholders: \{\{typo\}\}/);
    assert.match(err.message, /declared but not used: unused/);
  }
});

test('every repo template renders and its name matches the file', () => {
  const root = new URL('../prompts/', import.meta.url);
  const config = JSON.parse(readFileSync(new URL('config.json', root), 'utf8'));
  const partials = {};
  for (const f of readdirSync(new URL('shared/', root))) {
    partials[basename(f, '.md').replace(/-/g, '_')] = parseTemplate(readFileSync(new URL(`shared/${f}`, root), 'utf8'));
  }
  const files = readdirSync(new URL('templates/', root)).filter((f) => f.endsWith('.md'));
  assert.ok(files.length >= 4);
  for (const f of files) {
    const t = parseTemplate(readFileSync(new URL(`templates/${f}`, root), 'utf8'));
    assert.equal(t.meta.name, basename(f, '.md'));
    const out = renderTemplate(t, { config, partials });
    assert.deepEqual(placeholdersIn(out).sort(), [...t.meta.runtime_vars].sort(), f);
  }
});

test('editorial system prompt keeps the Derja-first / English-second rule and JSON contract', () => {
  const t = parseTemplate(readFileSync(new URL('../prompts/templates/tn-editorial-system.md', import.meta.url), 'utf8'));
  assert.match(t.body, /must begin in natural Tunisian Derja using Arabic script, followed by an English version/);
  for (const key of ['caption_derja', 'caption_en', 'hashtags', 'alt_text', 'image_origin', 'source_attribution', 'supported_claims', 'disclosure_text', 'validation_status']) {
    assert.match(t.body, new RegExp(`"${key}"`), key);
  }
});

const current = (prompt, seeded = true) => ({ prompt, version: 3, config: seeded ? { seeded_by: SEEDED_BY } : {} });

test('planSeedAction: initial seed goes straight to production', () => {
  assert.deepEqual(planSeedAction({ current: null, rendered: 'a' }).labels, ['production']);
});

test('planSeedAction: unchanged text is skipped', () => {
  assert.equal(planSeedAction({ current: current('a'), rendered: 'a' }).action, 'skip');
});

test('planSeedAction: changed text creates an UNPROMOTED version by default', () => {
  const plan = planSeedAction({ current: current('a'), rendered: 'b' });
  assert.equal(plan.action, 'create');
  assert.deepEqual(plan.labels, []);
});

test('planSeedAction: --promote promotes script-seeded prompts', () => {
  assert.deepEqual(planSeedAction({ current: current('a'), rendered: 'b', promote: true }).labels, ['production']);
});

test('planSeedAction: re-running without --promote does not create duplicate versions', () => {
  const plan = planSeedAction({ current: current('a'), latest: { prompt: 'b', version: 4 }, rendered: 'b' });
  assert.equal(plan.action, 'skip');
  assert.match(plan.reason, /already pushed as v4/);
});

test('planSeedAction: --promote moves production onto the existing pending version', () => {
  const plan = planSeedAction({ current: current('a'), latest: { prompt: 'b', version: 4 }, rendered: 'b', promote: true });
  assert.equal(plan.action, 'promote');
  assert.equal(plan.version, 4);
});

test('planSeedAction: pending version is not promoted over a UI edit without --force', () => {
  const plan = planSeedAction({ current: current('a', false), latest: { prompt: 'b', version: 4 }, rendered: 'b', promote: true });
  assert.equal(plan.action, 'skip');
  assert.match(plan.reason, /--force/);
});

test('planSeedAction: UI-edited production is never replaced without --force', () => {
  const plan = planSeedAction({ current: current('a', false), rendered: 'b', promote: true });
  assert.equal(plan.uiEdited, true);
  assert.deepEqual(plan.labels, []);
  assert.deepEqual(planSeedAction({ current: current('a', false), rendered: 'b', promote: true, force: true }).labels, ['production']);
});
