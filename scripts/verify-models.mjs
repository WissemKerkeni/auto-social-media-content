#!/usr/bin/env node
// Verify the configured text (Claude) and image (Gemini) models against the real APIs.
//
// Default (free): model metadata lookups only.
//   Anthropic  GET /v1/models/{ANTHROPIC_TEXT_MODEL}       → exists, context window, output cap
//   Gemini     GET /v1beta/models/{GEMINI_IMAGE_MODEL}     → exists, supported methods
//
// --live (costs money, roughly $0.05–0.10 in total):
//   1. one real caption: renders tn-editorial-system + tn-caption-request from prompts/,
//      calls Claude with the caption JSON schema, then runs the deterministic caption gates
//   2. one real image (generateContent) at GEMINI_IMAGE_SIZE / GEMINI_IMAGE_ASPECT_RATIO from tn-image-original,
//      saved to n8n/files/verify/ (git-ignored) with its SHA-256
//
// Usage: node scripts/verify-models.mjs [--live] [--only text|image]
// Keys come from .env (ANTHROPIC_API_KEY, GEMINI_API_KEY) and are only sent as request headers.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseEnv } from './lib/env.mjs';
import { parseTemplate, renderTemplate } from './lib/prompts.mjs';
import { buildDisclosure } from './lib/content.mjs';
import {
  buildCaptionRequest, parseCaptionResponse, validateCaption, estimateClaudeCost,
  buildImageRequest, parseImageResponse, ANTHROPIC_VERSION,
} from './lib/models.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const LIVE = args.includes('--live');
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const env = { ...parseEnv(readFileSync(resolve(root, '.env'), 'utf8')) };
for (const k of Object.keys(env)) if (process.env[k]) env[k] = process.env[k];

let failures = 0;
const ok = (m) => console.log(`   ✓ ${m}`);
const warn = (m) => console.log(`   ⚠ ${m}`);
const bad = (m) => { failures++; console.log(`   ✗ ${m}`); };
const section = (m) => console.log(`\n── ${m}`);

async function http(method, url, { headers = {}, body, timeoutMs = 120_000 } = {}) {
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, json, text };
}

// Render prompts from the repo with sample runtime values (no Langfuse needed).
const config = JSON.parse(readFileSync(resolve(root, 'prompts/config.json'), 'utf8'));
const partials = Object.fromEntries(readdirSync(resolve(root, 'prompts/shared')).filter((f) => f.endsWith('.md'))
  .map((f) => [basename(f, '.md').replace(/-/g, '_'), parseTemplate(readFileSync(resolve(root, 'prompts/shared', f), 'utf8'))]));
const render = (name, vars = {}) => {
  const text = renderTemplate(parseTemplate(readFileSync(resolve(root, 'prompts/templates', `${name}.md`), 'utf8')), { config, partials });
  return text.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/g, (_, k) => (k in vars ? vars[k] : `{{${k}}}`));
};
const SAMPLE = {
  destination_name_ar: 'عين دراهم', destination_name_en: 'Aïn Draham', region: 'Jendouba, northwest Tunisia',
  landscape_type: 'mountain forest', image_origin: 'ai_generated',
  image_description: 'Photorealistic AI image of misty forested hills at sunrise.',
  verified_facts_json: '[]', source_attribution: '',
  scene_brief: 'rolling hills covered in dense cork oak forest, morning mist in the valleys', time_of_day: 'soft sunrise light',
};
SAMPLE.disclosure_text = buildDisclosure({ origin: 'ai_generated', placeAr: SAMPLE.destination_name_ar, placeEn: SAMPLE.destination_name_en }, config).text;

// ── Claude ──
if (ONLY !== 'image') {
  section(`text model: ${env.ANTHROPIC_TEXT_MODEL} (Anthropic)`);
  if (!env.ANTHROPIC_API_KEY) {
    warn('ANTHROPIC_API_KEY not set in .env — skipped');
  } else {
    const auth = { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': ANTHROPIC_VERSION };
    const meta = await http('GET', `https://api.anthropic.com/v1/models/${encodeURIComponent(env.ANTHROPIC_TEXT_MODEL)}`, { headers: auth });
    if (meta.status === 200) ok(`${meta.json.display_name ?? meta.json.id}: context ${meta.json.max_input_tokens ?? '?'} tokens, max output ${meta.json.max_tokens ?? '?'}`);
    else if (meta.status === 401) bad('API key rejected (401)');
    else bad(`model lookup HTTP ${meta.status}: ${meta.json?.error?.message ?? meta.text.slice(0, 200)}`);

    if (LIVE && meta.status === 200) {
      const schema = JSON.parse(readFileSync(resolve(root, 'prompts/schemas/caption.schema.json'), 'utf8'));
      const req = buildCaptionRequest({
        model: env.ANTHROPIC_TEXT_MODEL, effort: env.ANTHROPIC_EFFORT || 'medium', maxTokens: Number(env.ANTHROPIC_MAX_TOKENS) || 16000,
        systemPrompt: render('tn-editorial-system'), userPrompt: render('tn-caption-request', SAMPLE), schema,
      });
      const t0 = Date.now();
      const res = await http('POST', req.url, { headers: { ...req.headers, 'x-api-key': env.ANTHROPIC_API_KEY }, body: req.body, timeoutMs: 300_000 });
      const parsed = parseCaptionResponse(res.json ?? { type: 'error', error: { type: `http_${res.status}` } });
      if (!parsed.ok) {
        bad(`caption call failed: ${parsed.reason} ${parsed.detail ?? ''} (HTTP ${res.status})`);
      } else {
        const u = parsed.usage;
        ok(`caption in ${((Date.now() - t0) / 1000).toFixed(1)} s from ${parsed.model}${parsed.fallbackUsed ? ' (served by fallback)' : ''}; tokens in ${u.input_tokens} / out ${u.output_tokens} / cache write ${u.cache_creation_input_tokens ?? 0}; ≈ $${estimateClaudeCost(u).toFixed(4)}`);
        const gate = validateCaption(parsed.caption, { image_origin: SAMPLE.image_origin, source_attribution: null, disclosure_text: SAMPLE.disclosure_text, fact_ids: [] }, config);
        console.log(`\n   ${parsed.caption.caption_derja}\n\n   ${parsed.caption.caption_en}\n\n   ${parsed.caption.hashtags.join(' ')}\n`);
        if (gate.status === 'validated') ok('deterministic caption gates: validated');
        else warn(`caption gates → needs_review: ${gate.problems.join('; ')}`);
      }
    }
  }
}

// ── Gemini ──
if (ONLY !== 'text') {
  section(`image model: ${env.GEMINI_IMAGE_MODEL} (Gemini, ${env.GEMINI_IMAGE_SIZE} ${env.GEMINI_IMAGE_ASPECT_RATIO})`);
  if (!env.GEMINI_API_KEY) {
    warn('GEMINI_API_KEY not set in .env — skipped');
  } else {
    const auth = { 'x-goog-api-key': env.GEMINI_API_KEY };
    const meta = await http('GET', `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(env.GEMINI_IMAGE_MODEL)}`, { headers: auth });
    if (meta.status === 200) ok(`${meta.json.displayName ?? meta.json.name}: methods ${(meta.json.supportedGenerationMethods ?? []).join(', ') || 'not listed'}`);
    else if (meta.status === 400 || meta.status === 403) bad(`API key rejected (HTTP ${meta.status}): ${meta.json?.error?.message ?? ''}`);
    else bad(`model lookup HTTP ${meta.status}: ${meta.json?.error?.message ?? meta.text.slice(0, 200)}`);

    if (LIVE && meta.status === 200) {
      const req = buildImageRequest({
        model: env.GEMINI_IMAGE_MODEL, prompt: render('tn-image-original', SAMPLE),
        aspectRatio: env.GEMINI_IMAGE_ASPECT_RATIO || '4:5', imageSize: env.GEMINI_IMAGE_SIZE || '2K',
      });
      const t0 = Date.now();
      const res = await http('POST', req.url, { headers: { ...req.headers, ...auth }, body: req.body, timeoutMs: 300_000 });
      const img = parseImageResponse(res.json ?? { error: { code: res.status, status: `HTTP ${res.status}` } });
      if (!img.ok) {
        bad(`image call failed (HTTP ${res.status}): ${img.reason} ${img.detail ?? ''} ${res.status >= 400 ? res.text.slice(0, 300) : ''}`);
      } else {
        const buf = Buffer.from(img.base64, 'base64');
        const ext = img.mimeType === 'image/jpeg' ? 'jpg' : img.mimeType.split('/')[1] ?? 'bin';
        const dir = resolve(root, 'n8n/files/verify');
        mkdirSync(dir, { recursive: true });
        const file = resolve(dir, `verify-${Date.now()}.${ext}`);
        writeFileSync(file, buf);
        ok(`image in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${img.mimeType}, ${(buf.length / 1024).toFixed(0)} KB, sha256 ${createHash('sha256').update(buf).digest('hex').slice(0, 16)}… → ${relative(root, file)}`);
      }
    }
  }
}

if (!LIVE) console.log('\n(metadata only — add --live for one real caption + one real image, ≈ $0.05–0.10)');
console.log(failures ? `\n${failures} check(s) failed.` : '\nDone.');
process.exit(failures ? 1 : 0);
