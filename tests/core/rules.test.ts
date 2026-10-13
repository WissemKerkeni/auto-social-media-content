import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseSceneBrief, compilePrompt, contentHash, decideAudit, timeOfDay, type ImageAudit } from '../../src/core/rules.ts';

const clean: ImageAudit = {
  description: 'Misty forested hills at sunrise.', contains_text_or_letters: false, contains_watermark_logo_or_signature: false,
  contains_people: false, contains_animals: false, contains_buildings_or_infrastructure: false, buildings_detail: '', contains_paths_or_tracks: false,
  looks_photorealistic: true, has_visual_defects: false, defects_detail: '', plausible_for_landscape_type: true,
  matches_scene_brief: true, overall_quality: 'good', notes: '',
};

test('light follows the slot time (07:00 … 21:00)', () => {
  assert.match(timeOfDay('07:00'), /early-morning/);
  assert.match(timeOfDay('13:00'), /midday/);
  assert.match(timeOfDay('17:00'), /golden-hour/);
  assert.match(timeOfDay('19:00'), /sunset/);
  assert.match(timeOfDay('21:00'), /blue-hour/);
});

test('scene briefs rotate per destination', () => {
  const b = ['a', 'b', 'c'];
  assert.deepEqual([0, 1, 2, 3, 4].map((n) => chooseSceneBrief(b, n)), ['a', 'b', 'c', 'a', 'b']);
  assert.throws(() => chooseSceneBrief([], 0), /no scene_briefs/);
});

test('compilePrompt fills variables and refuses to send unfilled ones', () => {
  assert.equal(compilePrompt('Hi {{ name }} at {{place}}', { name: 'A', place: 'B' }), 'Hi A at B');
  assert.throws(() => compilePrompt('Hi {{name}} {{missing}}', { name: 'A' }), /missing: missing/);
});

test('contentHash ignores whitespace/case noise but depends on the image', () => {
  const a = contentHash('Line one\n\nLine  TWO', 'f'.repeat(64));
  assert.equal(a, contentHash('line one line two', 'f'.repeat(64)));
  assert.notEqual(a, contentHash('line one line two', 'e'.repeat(64)));
});

test('decideAudit approves a clean photorealistic AI scene', () => {
  assert.deepEqual(decideAudit(clean, 'ai_generated'), { approved: true, problems: [], warnings: [] });
});

test('decideAudit quarantines invented structures, wildlife, text, people and defects in AI scenes', () => {
  const r = decideAudit({
    ...clean, contains_buildings_or_infrastructure: true, buildings_detail: 'tiny houses on the far ridge',
    contains_animals: true, contains_text_or_letters: true, contains_people: true, has_visual_defects: true, defects_detail: 'melted tree',
  }, 'ai_generated');
  assert.equal(r.approved, false);
  const all = r.problems.join('\n');
  for (const p of ['tiny houses on the far ridge', 'no invented wildlife', 'text or letters', 'people', 'melted tree']) assert.match(all, new RegExp(p));
});

test('natural-looking paths/tracks are allowed with a warning; buildings are not', () => {
  const paths = decideAudit({ ...clean, contains_paths_or_tracks: true }, 'ai_generated');
  assert.equal(paths.approved, true);
  assert.match(paths.warnings.join(), /paths or tracks/);
  assert.equal(decideAudit({ ...clean, contains_paths_or_tracks: true, contains_buildings_or_infrastructure: true }, 'ai_generated').approved, false);
});

test('decideAudit requires photorealism and plausibility for AI scenes, but only warns on brief mismatch', () => {
  assert.equal(decideAudit({ ...clean, looks_photorealistic: false }, 'ai_generated').approved, false);
  assert.equal(decideAudit({ ...clean, plausible_for_landscape_type: false }, 'ai_generated').approved, false);
  const loose = decideAudit({ ...clean, matches_scene_brief: false }, 'ai_generated');
  assert.equal(loose.approved, true);
  assert.equal(loose.warnings.length, 1);
});

test('real enhanced photos may show real structures/animals, but never text, watermarks or people', () => {
  assert.equal(decideAudit({ ...clean, contains_buildings_or_infrastructure: true, contains_animals: true }, 'licensed_photo_enhanced').approved, true);
  assert.equal(decideAudit({ ...clean, contains_watermark_logo_or_signature: true }, 'licensed_photo_enhanced').approved, false);
  assert.equal(decideAudit({ ...clean, contains_people: true }, 'licensed_photo_enhanced').approved, false);
});
