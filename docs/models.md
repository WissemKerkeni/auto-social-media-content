# Models: text = Claude Opus, image = Gemini Nano Banana 2.1

Selected 2026-10-13. Sources: Anthropic model reference, ai.google.dev model, pricing and
image-generation pages, and checks against the live Gemini API (below).

## Text: `claude-opus-5-5` (Anthropic Messages API)

Used for captions: Tunisian Derja (Arabic script) first, English second, as structured JSON.

| Setting | Value | Why |
|---|---|---|
| `ANTHROPIC_TEXT_MODEL` | `claude-opus-5-5` | Current Opus |
| `ANTHROPIC_EFFORT` | `medium` | Opus 5.5's default, set explicitly. Thinking can't be turned off on this model; effort is the cost/depth control. Raise to `high` only if measured caption quality needs it |
| Output format | `output_config.format` = `json_schema` from [`prompts/schemas/caption.schema.json`](../prompts/schemas/caption.schema.json) | The response is guaranteed to parse into the caption contract |
| Caching | `cache_control` on the static system prompt | Cuts cost on retries within 5 minutes. Slots are 2 hours apart, so it doesn't carry across slots |
| Refusals | `fallbacks: "default"` + `anthropic-beta: server-side-fallback-2026-07-01` | A false-positive safety decline is re-run on Anthropic's recommended fallback model inside the same call. A final `stop_reason: "refusal"` sends the post to `needs_review` and nothing is published |
| Not sent | `thinking`, `temperature`, `top_p`, assistant prefill | Each returns a 400 on Opus 5.5 |

**Price:** $4 / $20 per million input/output tokens, cache reads $0.20. The measured caption
cost about **$0.034** (live run below). At 240 captions a month, plus some retries, that's about
**$8–10/month**.

> Cheaper option, if you want it later: `claude-haiku-5-5` ($0.10 / $0.50) would cost well
> under $1/month. Change `ANTHROPIC_TEXT_MODEL` and nothing else. Opus stays the default
> because you asked for it.

**After parsing,** [`validateCaption`](../scripts/lib/models.mjs) applies deterministic gates.
Any failure routes the post to `needs_review`:
- The Derja caption must be ≥ 85% Arabic script, with no Arabizi (Latin letters with 3/7/9 for
  Arabic sounds).
- The English caption must be Latin script.
- Length limits from `prompts/config.json`.
- Hashtags must be well-formed, unique, and within the count limit.
- `image_origin`, `source_attribution` and `disclosure_text` must match the asset record exactly,
  so the model can't invent credits or licenses.
- Every factual claim must cite a fact id that was supplied.
- The model's own `needs_review` flag is honoured.

## Image: `gemini-nano-banana-2.1` (Gemini API, `generateContent`)

| Model | Status | Editing | Sizes | Price per image (standard) | Verdict |
|---|---|---|---|---|---|
| **`gemini-nano-banana-2.1`** | Stable (Oct 2026) | Yes, multi-turn consistency | 1K / 2K / 4K | 1K $0.0336 · **2K $0.0504** · 4K $0.113 | **Chosen** |
| `gemini-3.1-flash-lite-image` | Stable | Not optimized for editing | 1K only | 1K $0.0336 | Same 1K price, fewer features |
| `gemini-3.1-flash-image` | Previous generation | Yes | 0.5K–4K | 1K $0.067 · 2K $0.101 | Twice the price; Google recommends 2.1 for new projects |
| `gemini-3-pro-image` | Stable | Yes | 1K–4K | 1K/2K $0.134 | Studio/typography work we don't need (no text in images) |
| `gemini-2.5-flash-image` | Shut down 2026-10-02 | | | | `check-env` rejects it |

**Why 2.1:**
- It's Google's recommended general-purpose image model.
- It's stable.
- It does both jobs this project needs: original artwork (text-to-image) and enhancing licensed
  photos (image-to-image) while keeping the geography.
- At 1K it costs the same as Lite, and Lite isn't optimized for editing.

| Setting | Value | Why |
|---|---|---|
| `GEMINI_IMAGE_SIZE` | `2K` | At 4:5, 1K output is narrower than Instagram's 1080 px. Uppercase `K` is required per Google's docs |
| `GEMINI_IMAGE_ASPECT_RATIO` | `4:5` | Instagram's portrait format, and Facebook displays it well. Accepted values come from the API's own validation list |

**Price:** 240 images a month at 2K comes to about **$12/month**. With
`batchGenerateContent` (half price; the model supports it) it's about **$6/month**. That fits
this project because images can be produced ahead of their slot. **There is no free tier for
Gemini image models.**

All generated images carry Google's invisible **SynthID** watermark. That's fine, and consistent
with disclosing AI artwork.

### Verified against the live API (2026-10-13, using your key; no images generated, $0)

- `GET /v1beta/models/gemini-nano-banana-2.1` lists `generateContent`, `countTokens` and
  `batchGenerateContent`.
- Request shape checked through `countTokens`, which parses the full request:
  - `generationConfig.responseModalities: ["IMAGE"]` and `imageConfig.{aspectRatio, imageSize}`
    are accepted, and an unknown field is rejected (so the check is real).
  - The editing input `parts[].inlineData.{mimeType, data}` is accepted (a 1×1 PNG counted as
    258 tokens).
  - `4:5` is in the model's allowed aspect-ratio list.
### Live end-to-end results (2026-10-13, `npm run verify:models -- --live`)

| Check | Result |
|---|---|
| Claude `claude-opus-5-5` caption | 16.6 s; 314 input + 1,847 cache-write + 1,167 output tokens; **≈ $0.034**; JSON matched the schema; deterministic gates passed (Derja in Arabic script first, English second, disclosure copied exactly) |
| Gemini `gemini-nano-banana-2.1` image | 24.5 s; **JPEG 1856×2304** (4:5, above Instagram's 1080 px width); 3.3 MB; painterly style; no text, watermark, buildings, people or animals |

Lessons from the live run:
- **Structured outputs reject JSON-Schema annotations** such as `$comment` (HTTP 400:
  `property '$comment' is not supported`). `buildCaptionRequest` strips them with
  `stripSchemaAnnotations`, so the schema file can keep its comment.
- Gemini returned **JPEG** even though no output MIME type was requested. Treat the returned
  `mimeType` as authoritative, and validate the bytes (Phase C) rather than assuming PNG.

## Commands

```bash
npm run verify:models                 # free: model metadata for both providers
npm run verify:models -- --live       # one real caption + one real 2K image (≈ $0.05–0.10)
npm run verify:models -- --live --only text
```

Keys go in `.env` (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`). Then run `npm run bootstrap:n8n`, which
creates these n8n credentials:

| Credential ID | Type | Use |
|---|---|---|
| `anthropic-header` | httpHeaderAuth, `x-api-key` | HTTP Request nodes. **Use this one** |
| `anthropic` | anthropicApi | n8n's native Anthropic nodes |
| `gemini-header` | httpHeaderAuth, `x-goog-api-key` | HTTP Request nodes. **Use this one**; the key stays out of URLs |
| `gemini` | googlePalmApi | n8n's native Gemini nodes; sends the key as a `?key=` URL parameter |

n8n workflows read model names from `$env` (`ANTHROPIC_TEXT_MODEL`, `ANTHROPIC_EFFORT`,
`GEMINI_IMAGE_MODEL`, `GEMINI_IMAGE_SIZE`, `GEMINI_IMAGE_ASPECT_RATIO`). Changing a model is an
`.env` edit plus `docker compose up -d n8n`, with no workflow change.
