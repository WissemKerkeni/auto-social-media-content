// Request builders, response parsers and deterministic caption gates for the two models:
//   text  → Anthropic Messages API (Claude Opus), structured JSON output
//   image → Gemini image model (Nano Banana family) via generateContent
// Pure functions: no network, no secrets. API keys are added by the caller (n8n credential
// or scripts/verify-models.mjs) — never stored in a request object built here.

export const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';
// `fallbacks: "default"` re-runs a classifier-declined request on Anthropic's recommended
// fallback model inside the same call; this header gates that scalar form.
export const ANTHROPIC_FALLBACK_BETA = 'server-side-fallback-2026-07-01';
export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const GEMINI_IMAGE_SIZES = ['1K', '2K', '4K'];

/**
 * Structured outputs reject JSON-Schema annotation keywords such as `$comment` (HTTP 400,
 * verified 2026-10-13). Strip them recursively; `$ref` / `$defs` are kept (supported).
 */
export function stripSchemaAnnotations(node) {
  if (Array.isArray(node)) return node.map(stripSchemaAnnotations);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith('$') && k !== '$ref' && k !== '$defs') continue;
    out[k] = stripSchemaAnnotations(v);
  }
  return out;
}

/**
 * Anthropic request for one caption.
 * - Thinking is always on for Claude Opus 5.5 (omitting `thinking` = adaptive); depth is set by effort.
 * - The static system prompt carries cache_control; retries within 5 minutes read it from cache.
 * - output_config.format guarantees the reply parses into the caption schema.
 */
export function buildCaptionRequest({ model, effort = 'medium', maxTokens = 16000, systemPrompt, userPrompt, schema }) {
  if (!/^claude-/.test(model ?? '')) throw new Error(`not a Claude model id: ${model}`);
  if (!EFFORT_LEVELS.includes(effort)) throw new Error(`effort must be one of ${EFFORT_LEVELS.join('/')}`);
  return {
    url: ANTHROPIC_API,
    headers: {
      'content-type': 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-beta': ANTHROPIC_FALLBACK_BETA,
    },
    body: {
      model,
      max_tokens: maxTokens,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userPrompt }],
      output_config: { effort, format: { type: 'json_schema', schema: stripSchemaAnnotations(schema) } },
      fallbacks: 'default',
    },
  };
}

/**
 * Interpret an Anthropic Messages response. Never throws.
 * @returns {{ok:true, caption, model, fallbackUsed, usage} | {ok:false, reason, retryable, detail}}
 */
export function parseCaptionResponse(res) {
  const usage = res?.usage ?? {};
  if (res?.type === 'error' || res?.error) {
    const type = res.error?.type ?? 'unknown';
    const message = res.error?.message ? `: ${res.error.message}` : '';
    return { ok: false, reason: 'api_error', retryable: ['rate_limit_error', 'overloaded_error', 'api_error'].includes(type), detail: `${type}${message}` };
  }
  // A refusal means the whole fallback chain declined: never publish, route to needs_review.
  if (res?.stop_reason === 'refusal') {
    return { ok: false, reason: 'refusal', retryable: false, detail: res.stop_details?.category ?? null };
  }
  if (res?.stop_reason === 'max_tokens') {
    return { ok: false, reason: 'max_tokens', retryable: true, detail: 'output truncated; raise max_tokens' };
  }
  const text = (res?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let caption;
  try {
    caption = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'invalid_json', retryable: true, detail: text.slice(0, 200) };
  }
  const fallbackUsed = (res.content ?? []).some((b) => b.type === 'fallback')
    || (usage.iterations ?? []).some((i) => i.type === 'fallback_message');
  return { ok: true, caption, model: res.model, fallbackUsed, usage };
}

// Aspect ratios this model family accepts (from the API's own validation error, 2026-10-13).
export const GEMINI_ASPECT_RATIOS = ['1:1', '1:4', '1:8', '2:3', '3:2', '3:4', '4:1', '4:3', '4:5', '5:4', '8:1', '9:16', '16:9', '21:9'];

/**
 * Gemini generateContent request: text-to-image, or image editing when `inputImage` is given.
 * Uses generateContent (listed in the model's supportedGenerationMethods, with a half-price
 * batchGenerateContent variant). Field names verified against the live API via countTokens.
 * Image sizes must use an uppercase K ("2K") per the Gemini docs.
 */
export function buildImageRequest({ model, prompt, aspectRatio = '4:5', imageSize = '2K', inputImage = null }) {
  if (!GEMINI_IMAGE_SIZES.includes(imageSize)) throw new Error(`imageSize must be one of ${GEMINI_IMAGE_SIZES.join('/')} (uppercase K)`);
  if (!GEMINI_ASPECT_RATIOS.includes(aspectRatio)) throw new Error(`aspect ratio ${aspectRatio} not supported (${GEMINI_ASPECT_RATIOS.join(', ')})`);
  const parts = [{ text: prompt }];
  if (inputImage) parts.push({ inlineData: { mimeType: inputImage.mimeType, data: inputImage.base64 } });
  return {
    url: `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent`,
    headers: { 'content-type': 'application/json' },
    body: {
      contents: [{ role: 'user', parts }],
      generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio, imageSize } },
    },
  };
}

/**
 * Extract the first image from a generateContent response (candidates[].content.parts[].inlineData).
 * Blocked prompts / safety stops / text-only answers come back as ok:false with the reason.
 */
export function parseImageResponse(res) {
  if (res?.error) return { ok: false, reason: 'api_error', retryable: [429, 500, 503, 504].includes(res.error.code), detail: res.error.status ?? res.error.message };
  if (res?.promptFeedback?.blockReason) return { ok: false, reason: 'blocked', retryable: false, detail: res.promptFeedback.blockReason };
  const candidate = res?.candidates?.[0];
  const part = (candidate?.content?.parts ?? []).find((p) => p.inlineData?.data || p.inline_data?.data);
  if (!part) {
    const finish = candidate?.finishReason ?? 'NO_CANDIDATE';
    const text = (candidate?.content?.parts ?? []).map((p) => p.text).filter(Boolean).join(' ').slice(0, 200);
    return { ok: false, reason: 'no_image', retryable: !/SAFETY|PROHIBITED|BLOCKLIST|RECITATION/.test(finish), detail: `${finish}${text ? `: ${text}` : ''}` };
  }
  const data = part.inlineData ?? part.inline_data;
  return { ok: true, base64: data.data, mimeType: data.mimeType ?? data.mime_type ?? 'application/octet-stream', usage: res.usageMetadata ?? null };
}

// ── Deterministic caption gates ──────────────────────────────────────────────

const ARABIC_LETTER = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/gu;
const LATIN_LETTER = /[A-Za-zÀ-ÿ]/g;
// Arabizi: Latin words with digits standing in for Arabic letters (3=ع, 7=ح, 9=ق, 5=خ, 2=ء)
const ARABIZI = /\b[a-z]*[23579][a-z]+\b|\b[a-z]+[23579][a-z]*\b/i;

const count = (text, re) => (text.match(re) ?? []).length;

/**
 * Validate a parsed caption against hard rules. Anything that fails goes to needs_review;
 * nothing here calls a model.
 * @param caption   parsed JSON from Claude
 * @param expected  { image_origin, source_attribution|null, disclosure_text, fact_ids: string[] }
 * @param limits    prompts/config.json values
 * @returns {{status:'validated'|'needs_review', problems:string[]}}
 */
export function validateCaption(caption, expected, limits) {
  const problems = [];
  const derja = String(caption.caption_derja ?? '');
  const en = String(caption.caption_en ?? '');

  // Derja first: Arabic script, no Arabizi, not mostly Latin.
  const ar = count(derja, ARABIC_LETTER);
  const latinInDerja = count(derja, LATIN_LETTER);
  if (!derja.trim()) problems.push('caption_derja is empty');
  else if (ar / Math.max(ar + latinInDerja, 1) < 0.85) problems.push('caption_derja is not predominantly Arabic script');
  if (ARABIZI.test(derja)) problems.push('caption_derja contains Arabizi');
  // English second: mostly Latin script.
  const latin = count(en, LATIN_LETTER);
  if (!en.trim()) problems.push('caption_en is empty');
  else if (latin / Math.max(latin + count(en, ARABIC_LETTER), 1) < 0.9) problems.push('caption_en is not predominantly English/Latin script');

  const maxLen = [
    ['caption_derja', limits.caption_derja_max_chars],
    ['caption_en', limits.caption_en_max_chars],
    ['alt_text', limits.alt_text_max_chars],
    ['title', 80],
  ];
  for (const [field, max] of maxLen) {
    const len = [...String(caption[field] ?? '')].length;
    if (max && len > max) problems.push(`${field} is ${len} chars (max ${max})`);
  }
  if (!String(caption.alt_text ?? '').trim()) problems.push('alt_text is empty');

  // Photorealistic AI images must never be presented as real photos of the place.
  if (expected.image_origin === 'ai_generated') {
    const prefix = limits.ai_alt_text_prefix ?? 'AI-generated image:';
    if (!String(caption.alt_text ?? '').startsWith(prefix)) problems.push(`alt_text for an AI image must start with "${prefix}"`);
    if (/\b(photo|photograph|photographed|captured|snapped|shot by)\b/i.test(en)) problems.push('caption_en presents the AI image as a photo');
    if (/تصويرة|صوّرت|صورتها/u.test(derja)) problems.push('caption_derja presents the AI image as a photo');
  }
  if (/#/.test(derja) || /#/.test(en)) problems.push('captions must not contain hashtags (they go in hashtags[])');

  const tags = Array.isArray(caption.hashtags) ? caption.hashtags : [];
  if (!tags.length) problems.push('no hashtags');
  if (tags.length > limits.hashtag_max) problems.push(`${tags.length} hashtags (max ${limits.hashtag_max})`);
  const badTags = tags.filter((t) => !/^#[\p{L}\p{N}_]+$/u.test(t));
  if (badTags.length) problems.push(`invalid hashtags: ${badTags.join(' ')}`);
  if (new Set(tags.map((t) => t.toLowerCase())).size !== tags.length) problems.push('duplicate hashtags');

  // Fields the model must copy verbatim (it may not invent credits, licenses or disclosure).
  if (caption.image_origin !== expected.image_origin) problems.push('image_origin does not match the asset record');
  if ((caption.source_attribution ?? null) !== (expected.source_attribution ?? null)) problems.push('source_attribution was altered or invented');
  if (caption.disclosure_text !== expected.disclosure_text) problems.push('disclosure_text was altered');

  // Every factual claim must cite a verified fact we supplied.
  const allowed = new Set(expected.fact_ids ?? []);
  for (const c of caption.supported_claims ?? []) {
    if (!allowed.has(c.fact_id)) problems.push(`claim cites unknown fact_id "${c.fact_id}"`);
  }

  if (caption.validation_status !== 'ok') {
    problems.push(`model flagged needs_review: ${(caption.review_reasons ?? []).join('; ') || 'no reason given'}`);
  }
  return { status: problems.length ? 'needs_review' : 'validated', problems };
}

/** Rough USD cost of one Claude call from its usage block (per-MTok prices passed in). */
export function estimateClaudeCost(usage, price = { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 }) {
  const m = 1_000_000;
  return ((usage.input_tokens ?? 0) * price.input
    + (usage.output_tokens ?? 0) * price.output
    + (usage.cache_creation_input_tokens ?? 0) * price.cacheWrite
    + (usage.cache_read_input_tokens ?? 0) * price.cacheRead) / m;
}
