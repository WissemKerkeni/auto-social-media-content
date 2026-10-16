# Content production (Phase C): `TN-01 Daily Content Producer`

n8n orchestrates, and every model call is made by n8n with its own credentials. `tn-core` is a
small internal TypeScript service ([`src/core/`](../src/core)) for the deterministic work n8n
can't do reliably:
- image decoding and checks;
- SHA-256 and perceptual hashing;
- S3 upload;
- building model requests from the repo's schemas;
- the caption and image gates;
- the database state machine.

**`tn-core` holds no third-party API keys.**

```
Every 15 min (Africa/Tunis) ─► Claim due slot (tn_claim_due_slot, Postgres)
  └─► tn-core prepare: resume or create the slot's post, pick the destination (cooldown + variety),
      choose image source (rights-verified licensed photo → enhance, else original AI), scene brief,
      light from the slot time
      └─► [needs image] Langfuse prompt → tn-core image request (reserves a Gemini call)
            → Gemini generateContent (gemini-nano-banana-2.1, 2K, 4:5)
            → tn-core ingest: magic-byte format check, decode, 4:5 ±3 %, ≥1080 px, ≤8 MB,
              SHA-256 exact dup, dHash near-dup (≤6 bits), S3 upload, asset row, 1024 px preview
            → Claude vision audit (claude-opus-5-5, effort low) → tn-core decides approve/quarantine
      └─► Langfuse prompts → tn-core caption request (reserves a Claude call)
            → Claude caption (structured JSON) → tn-core gates + compose + content hash
            → validated → tn-core schedule: scheduled_for = slot time, one publication per platform
  any failure ─► tn-core park: retry (lease released, ≤3 attempts per slot), needs_review, or skipped
```

All three model calls are traced into **one Langfuse trace per post** (`trace_key = post:<id>`),
each linked to the exact prompt version used.

## Safeguards (all automatic, no human approval)

| Stage | Rule | On failure |
|---|---|---|
| Claim | atomic, leased, fenced; daily cap; never late (> 60 min after the slot time it's skipped) | slot skipped |
| Cost | `tn_reserve_api_call` atomically consumes a daily cap before **every** model call (`cap_gemini_image_per_day`, `cap_anthropic_per_day`) | slot skipped (`daily_cap`) |
| Image file | real JPEG/PNG/WebP by magic bytes; decodes; 4:5 ±3 %; width ≥ 1080; ≤ 8 MB (re-encodes if needed); valid JPEGs are kept byte-for-byte, so provenance metadata is preserved | retry |
| Duplicates | exact SHA-256 (also UNIQUE in the DB) and perceptual dHash within 6 bits | retry |
| Image audit | Claude reports what it observes. **Code decides** (`decideAudit`). For AI scenes it rejects text, watermarks, people, animals (no invented wildlife), buildings or infrastructure of any size, visual defects, a non-photorealistic look, or a landscape implausible for Tunisia. Faint natural paths are allowed with a warning | image quarantined, retry |
| Caption | schema-constrained JSON; Derja in Arabic script first (≥ 85 % Arabic letters, no Arabizi), English second; lengths; hashtags; attribution and disclosure copied exactly; every claim cites a verified fact; an AI image is never called a "photo"/"تصويرة"; alt text starts "AI-generated image:"; content hash unique | `needs_review`, never published |
| Disclosure | built by code from `prompts/config.json` (Derja + English), appended under each language block | n/a |
| State | DB trigger enforces the post state machine and logs every transition | rejected |

The caption may only state facts from `location_facts` with `status = 'verified'`. None are
seeded yet, so captions are currently evocative and make no factual claims.

## Verified live (2026-10-13)

The first real production ran through n8n against the real APIs. The slot was 15:00
Africa/Tunis, and the destination was Ghar El Melh lagoon.

| Attempt | Result |
|---|---|
| 1 | Image generated and stored. The audit flagged possible distant structures, so it was **quarantined** and the slot released for retry |
| 2 | **Quarantined** again, for faint paths the audit itself called "maybe natural sand channels". This showed the original rule was too strict. Paths are now a separate, allowed signal, while buildings and infrastructure stay a hard reject |
| 3 | Approved (paths warning only), caption **validated** by every gate, post **scheduled**, 2 publication rows (facebook, instagram) created |

Measured cost per call:
- **Gemini image (2K):** about $0.050.
- **Claude audit (low effort, 1024 px preview, about 2.5k input / 0.4k output tokens):** about $0.019.
- **Claude caption (about 0.5k input + cached system prompt, about 1.3k output tokens):** about $0.034.

**About $0.10 per post when the first image passes.** Allowing about 1.5 attempts on average,
expect **$25–35 a month** at 8 posts a day. The daily caps bound the worst case at about
$0.60 + $0.75 = **$1.35/day**.

## Turning on automatic production

TN-01 is imported **inactive** on purpose, because once active it spends money every day. To
enable it:

```bash
# n8n/manifest.json: set "publish": true for tn-01-content-producer, then
npm run bootstrap:n8n
```

Or toggle it in the n8n editor (`Workflows → TN-01 Daily Content Producer → Active`).

**Publishing to Facebook and Instagram is a separate workflow** ([Phase D, TN-02](publishing.md)) behind the
global kill switch (`app_config.publishing_enabled`, currently `false`). Production only queues
`scheduled` posts.

To run one production by hand (for example to test):

```bash
docker compose exec -u node -e N8N_RUNNERS_BROKER_PORT=5690 n8n n8n execute --id=tn-01-content-producer
```

This only does work if a slot is due: within 45 minutes before its time, up to 60 minutes after.

## tn-core API

Internal only: port 8080 inside Docker, mapped to `127.0.0.1:8081` for debugging. Calls need
`Authorization: Bearer $TN_CORE_TOKEN`; n8n uses the `tn-core` credential. Every mutating call
takes `slot_id` and `worker`, and is **fenced**: a worker whose lease expired gets HTTP 409 and
changes nothing.

| Endpoint | Purpose |
|---|---|
| `POST /v1/production/prepare` | resume or create the slot's post; destination, image source, scene, light |
| `POST /v1/production/image-request` | Gemini request (reserves 1 image call) |
| `POST /v1/production/ingest-image` | validate, hash, dedupe, store, asset row; returns the audit request (reserves 1 Claude call) |
| `POST /v1/production/apply-audit` | parse the audit; approve or quarantine |
| `POST /v1/production/caption-request` | caption request with verified facts and disclosure (reserves 1 Claude call) |
| `POST /v1/production/apply-caption` | gates, compose, content hash; `validated` or `needs_review` |
| `POST /v1/production/schedule` | `scheduled_for`, publication rows, slot `produced` |
| `POST /v1/production/park` | `retry` (release the lease) / `needs_review` / `skipped` / `failed`, logged to `generation_errors` |
