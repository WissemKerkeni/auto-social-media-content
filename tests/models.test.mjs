import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildCaptionRequest, parseCaptionResponse, buildImageRequest, parseImageResponse, validateCaption, estimateClaudeCost,
} from '../scripts/lib/models.mjs';

const schema = JSON.parse(readFileSync(new URL('../prompts/schemas/caption.schema.json', import.meta.url), 'utf8'));
const limits = JSON.parse(readFileSync(new URL('../prompts/config.json', import.meta.url), 'utf8'));

test('caption schema is valid for structured outputs (no length constraints, closed objects)', () => {
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const banned of ['minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems']) {
      assert.ok(!(banned in node), `structured outputs reject ${banned}`);
    }
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort());
    }
    Object.values(node).forEach(walk);
  };
  walk(schema);
});

test('buildCaptionRequest: Opus 5.5 shape — effort + json_schema, cached system, default fallbacks, no thinking/temperature', () => {
  const req = buildCaptionRequest({ model: 'claude-opus-5-5', systemPrompt: 'S', userPrompt: 'U', schema });
  assert.equal(req.headers['anthropic-version'], '2023-06-01');
  assert.equal(req.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.ok(!('x-api-key' in req.headers), 'the key is added by the caller, never built in');
  assert.equal(req.body.output_config.effort, 'medium');
  assert.equal(req.body.output_config.format.type, 'json_schema');
  // The API rejects `$comment` (HTTP 400 seen live); annotations must be stripped, structure kept.
  const sent = JSON.stringify(req.body.output_config.format.schema);
  assert.ok(!sent.includes('$comment'));
  assert.deepEqual(req.body.output_config.format.schema.required, schema.required);
  assert.deepEqual(req.body.system[0].cache_control, { type: 'ephemeral' });
  assert.equal(req.body.fallbacks, 'default');
  for (const k of ['thinking', 'temperature', 'top_p', 'output_format']) assert.ok(!(k in req.body), `${k} must not be sent`);
  assert.throws(() => buildCaptionRequest({ model: 'gpt-x', systemPrompt: 'S', userPrompt: 'U', schema }), /Claude/);
  assert.throws(() => buildCaptionRequest({ model: 'claude-opus-5-5', effort: 'extreme', systemPrompt: 'S', userPrompt: 'U', schema }), /effort/);
});

const caption = {
  title: 'Cork oak mornings in Aïn Draham',
  caption_derja: 'عين دراهم الصباح فيها حاجة أخرى، الغابة خضراء والهواء بارد. برشا ناس ما يعرفوهاش.',
  caption_en: 'Mornings in Aïn Draham feel different: green forest and cool air. Many people have never been.',
  hashtags: ['#تونس', '#AinDraham', '#TunisiaNature'],
  alt_text: 'AI-generated image: misty cork oak forest on green hills at sunrise.',
  image_origin: 'ai_generated',
  source_attribution: null,
  supported_claims: [{ claim: 'cork oak forest', fact_id: 'f1' }],
  disclosure_text: 'AI artwork',
  validation_status: 'ok',
  review_reasons: [],
};
const expected = { image_origin: 'ai_generated', source_attribution: null, disclosure_text: 'AI artwork', fact_ids: ['f1'] };

test('parseCaptionResponse reads the JSON text block and skips thinking blocks', () => {
  const r = parseCaptionResponse({
    model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 },
    content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(caption) }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.caption.title, caption.title);
  assert.equal(r.fallbackUsed, false);
});

test('parseCaptionResponse: refusal is final, max_tokens and bad JSON are retryable, fallback is reported', () => {
  assert.deepEqual(parseCaptionResponse({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] }),
    { ok: false, reason: 'refusal', retryable: false, detail: 'cyber' });
  assert.equal(parseCaptionResponse({ stop_reason: 'max_tokens', content: [] }).retryable, true);
  assert.equal(parseCaptionResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{oops' }] }).reason, 'invalid_json');
  assert.equal(parseCaptionResponse({ type: 'error', error: { type: 'overloaded_error' } }).retryable, true);
  assert.equal(parseCaptionResponse({ type: 'error', error: { type: 'invalid_request_error' } }).retryable, false);
  const fb = parseCaptionResponse({ stop_reason: 'end_turn', model: 'claude-opus-5', content: [{ type: 'fallback' }, { type: 'text', text: '{}' }] });
  assert.equal(fb.fallbackUsed, true);
});

test('validateCaption accepts a clean Derja-first caption', () => {
  assert.deepEqual(validateCaption(caption, expected, limits), { status: 'validated', problems: [] });
});

test('validateCaption routes rule violations to needs_review', () => {
  const bad = {
    ...caption,
    caption_derja: 'sbe7 el khir, 3in draham ya3jbek',
    caption_en: '',
    hashtags: ['#ok', 'no-hash', '#ok'],
    source_attribution: 'Photo by Someone (CC BY)',
    disclosure_text: 'changed',
    supported_claims: [{ claim: 'invented', fact_id: 'f999' }],
  };
  const { status, problems } = validateCaption(bad, expected, limits);
  assert.equal(status, 'needs_review');
  const all = problems.join('\n');
  for (const p of ['not predominantly Arabic', 'Arabizi', 'caption_en is empty', 'invalid hashtags: no-hash', 'duplicate hashtags',
    'source_attribution was altered', 'disclosure_text was altered', 'unknown fact_id "f999"']) {
    assert.match(all, new RegExp(p), p);
  }
});

test('validateCaption: a photorealistic AI image is never presented as a real photo', () => {
  const { problems } = validateCaption({
    ...caption,
    alt_text: 'Misty forest',
    caption_en: 'A photo we captured at dawn in Aïn Draham.',
    caption_derja: 'تصويرة من عين دراهم الصباح',
  }, expected, limits);
  const all = problems.join('\n');
  assert.match(all, /alt_text for an AI image must start with "AI-generated image:"/);
  assert.match(all, /caption_en presents the AI image as a photo/);
  assert.match(all, /caption_derja presents the AI image as a photo/);
  // The same words are fine for a real licensed photo.
  const real = { ...expected, image_origin: 'licensed_photo', source_attribution: 'Photo: X (CC BY 4.0)' };
  const ok = validateCaption({ ...caption, image_origin: 'licensed_photo', source_attribution: 'Photo: X (CC BY 4.0)', alt_text: 'Forest', caption_en: 'A photo of the forest.' }, real, limits);
  assert.ok(!ok.problems.some((p) => /presents the AI image|AI image must start/.test(p)), ok.problems.join());
});

test('validateCaption honours the model flag and length limits', () => {
  const flagged = validateCaption({ ...caption, validation_status: 'needs_review', review_reasons: ['no facts'] }, expected, limits);
  assert.match(flagged.problems.join(), /model flagged needs_review: no facts/);
  const long = validateCaption({ ...caption, caption_en: 'a'.repeat(limits.caption_en_max_chars + 1) }, expected, limits);
  assert.match(long.problems.join(), /caption_en is \d+ chars/);
});

test('buildImageRequest: generateContent shape (verified via countTokens), uppercase K, editing input', () => {
  const req = buildImageRequest({ model: 'gemini-nano-banana-2.1', prompt: 'P' });
  assert.equal(req.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-nano-banana-2.1:generateContent');
  assert.deepEqual(req.body.generationConfig, { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '4:5', imageSize: '2K' } });
  assert.ok(!('x-goog-api-key' in req.headers), 'the key is added by the caller, never built in');
  const edit = buildImageRequest({ model: 'm', prompt: 'P', inputImage: { mimeType: 'image/jpeg', base64: 'AAA' } });
  assert.deepEqual(edit.body.contents[0].parts[1], { inlineData: { mimeType: 'image/jpeg', data: 'AAA' } });
  assert.throws(() => buildImageRequest({ model: 'm', prompt: 'P', imageSize: '2k' }), /uppercase/);
  assert.throws(() => buildImageRequest({ model: 'm', prompt: 'P', aspectRatio: '4:7' }), /not supported/);
});

test('parseImageResponse: image, safety block, text-only and API errors', () => {
  const ok = parseImageResponse({ candidates: [{ content: { parts: [{ text: 'here' }, { inlineData: { mimeType: 'image/png', data: 'B64' } }] } }], usageMetadata: { totalTokenCount: 9 } });
  assert.deepEqual(ok, { ok: true, base64: 'B64', mimeType: 'image/png', usage: { totalTokenCount: 9 } });
  assert.deepEqual(parseImageResponse({ promptFeedback: { blockReason: 'SAFETY' } }), { ok: false, reason: 'blocked', retryable: false, detail: 'SAFETY' });
  const safety = parseImageResponse({ candidates: [{ finishReason: 'IMAGE_SAFETY', content: { parts: [] } }] });
  assert.equal(safety.retryable, false);
  const textOnly = parseImageResponse({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'I cannot' }] } }] });
  assert.equal(textOnly.reason, 'no_image');
  assert.equal(parseImageResponse({ error: { code: 503, status: 'UNAVAILABLE' } }).retryable, true);
});

test('estimateClaudeCost uses Opus 5.5 list prices', () => {
  assert.equal(estimateClaudeCost({ input_tokens: 1_000_000 }), 4);
  assert.equal(estimateClaudeCost({ output_tokens: 1_000_000 }), 20);
  assert.equal(estimateClaudeCost({ cache_read_input_tokens: 1_000_000 }), 0.2);
});
