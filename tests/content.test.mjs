import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildDisclosure, composeCaption } from '../scripts/lib/content.mjs';

const config = JSON.parse(readFileSync(new URL('../prompts/config.json', import.meta.url), 'utf8'));
const place = { placeAr: 'عين دراهم', placeEn: 'Aïn Draham' };

test('AI disclosure is bilingual, names the place and says it is not a real photo', () => {
  const d = buildDisclosure({ origin: 'ai_generated', ...place }, config);
  assert.match(d.derja, /الذكاء الاصطناعي/);
  assert.match(d.derja, /عين دراهم/);
  assert.match(d.derja, /موش تصويرة حقيقية/);
  assert.match(d.en, /^🤖 AI-generated image inspired by Aïn Draham; not a real photo/);
  assert.equal(d.text, `${d.derja}\n${d.en}`);
  assert.ok(!/\{\{/.test(d.text), 'no unfilled placeholders');
});

test('real-photo disclosures require and include the license attribution', () => {
  assert.throws(() => buildDisclosure({ origin: 'licensed_photo', ...place }, config), /requires an attribution/);
  const d = buildDisclosure({ origin: 'licensed_photo_enhanced', ...place, attribution: 'Photo: A. Ben Salah, CC BY 4.0' }, config);
  assert.match(d.en, /enhanced with AI\. Photo: A\. Ben Salah, CC BY 4\.0$/);
  assert.match(d.derja, /CC BY 4\.0$/);
  assert.throws(() => buildDisclosure({ origin: 'stock', ...place, attribution: 'x' }, config), /no disclosure template/);
});

test('composeCaption fixes the order: Derja + disclosure, then English + disclosure, then hashtags', () => {
  const d = buildDisclosure({ origin: 'ai_generated', ...place }, config);
  const text = composeCaption({ caption_derja: 'درجة', caption_en: 'English', hashtags: ['#تونس', '#Tunisia'] }, d);
  const lines = text.split('\n');
  assert.deepEqual(lines, ['درجة', d.derja, '', 'English', d.en, '', '#تونس #Tunisia']);
  assert.ok(text.indexOf('درجة') < text.indexOf('English'));
});
