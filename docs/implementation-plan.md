# Implementation plan

Status legend: ✅ done & verified · 🟡 in progress · ⬜ not started

| Phase | Scope | Status |
|---|---|---|
| A | Local environment: Docker Compose (n8n + PostgreSQL + S3 stand-in), env tooling, health checks | ✅ |
| A+ | Langfuse (prompt versions + OTLP tracing), `seed-prompts`, `bootstrap-n8n`, `dev-up` (ported from instabot-core) | ✅ |
| B | Prisma schema, migrations, seed data, safe slot claiming ([data model](data-model.md)) | ✅ |
| C | Gemini client, image pipeline, captions, `TN-01 Daily Content Producer` workflow ([content production](content-production.md)) | ✅ (verified live; imported inactive) |
| D | Dispatcher + Facebook / Instagram / TikTok publishing workflows | ⬜ |
| E | Pre-publication gates, retries/backoff, reconciliation, error workflow | ⬜ |
| F | Deployment guides: hosting, Cloudflare R2, Prisma Postgres, migration & backups | ⬜ |

## Architecture

```
                ┌──────────────────────── n8n (orchestration, schedules, credentials) ───────────────────────┐
                │  TN-01 Content Producer   TN-02 Dispatcher   TN-1x Publish FB/IG/TikTok   TN-99 Error handler │
                └───────────────┬─────────────────────────────────────────────┬─────────────────────────────┘
                                │ HTTP (internal token)                        │ official Graph / TikTok APIs
                    ┌───────────▼───────────┐                                  ▼
                    │ tn-core (TypeScript)  │──── Gemini API (images, captions)
                    │ Prisma · gates · hash │──── S3 API (SeaweedFS local / Cloudflare R2 prod)
                    └───────────┬───────────┘
                                ▼
                    PostgreSQL `tn_content` (local Docker → Prisma Postgres in prod)
```

**Why a small TypeScript service (`tn-core`) next to n8n?** Image validation (dimensions, MIME
sniffing), SHA-256 + perceptual hashing, JSON-schema validation of Gemini output, and the
publication gates must be unit-tested and deterministic. That logic is awkward and untestable
inside n8n Code nodes (no `sharp`, no test runner). n8n keeps what it is good at: schedules,
credential storage, visible step-by-step execution history, retries and error routing. Each n8n
node calls one narrow `tn-core` endpoint, so every step stays visible in the n8n UI.

## Key design decisions (to be implemented)

- **Slots are rows.** A `publish_slot` table has a unique `(slot_date, slot_time)`; claiming uses
  `SELECT … FOR UPDATE SKIP LOCKED` inside a transaction plus a status transition, so a delayed
  or duplicated trigger cannot produce two posts for one slot.
- **One content item per slot, one `platform_publication` row per (post, platform)**, enforced by
  unique constraints. Platforms are tracked independently.
- **States:** `draft → validated → scheduled → publishing → published`, with `needs_review`,
  `skipped`, `failed` as terminal/side states. Transitions are written to an audit table.
- **Kill switch + daily cap** are checked by the dispatcher immediately before each publish call,
  from the DB config table (env values seed the defaults).
- **Timeouts are reconciled, not retried:** on an ambiguous publish result the attempt goes to
  `reconciling`; the platform is queried for the post before any retry.
- **TikTok** stays `blocked` until the app's Direct Post audit and creator authorization are
  verified by a real API call; Facebook/Instagram continue independently.
- **Facts:** destination facts start `unverified`. Captions may only state claims linked to a
  `research_source` row with a URL; otherwise the post is routed to `needs_review`.

## Patterns adopted from instabot-core (and deliberate differences)

| instabot-core | Here | Why |
|---|---|---|
| `bootstrap-n8n.sh`, `seed-prompts.sh`, `dev-up.sh` (bash + jq + yq + python) | Same steps and semantics in Node `.mjs`, no dependencies | Runs identically on Windows and Linux; pure logic is unit-tested |
| Langfuse **v2.95.8** self-hosted | Langfuse **4.52.0** profile, or Langfuse Cloud | v2 is unsupported (security updates ended March 2025) |
| Legacy `/api/public/ingestion` trace events | OTLP `/api/public/otel/v1/traces` | v4 rejects the legacy trace/generation events |
| Prompt fallback in `PROMPT_*` env vars | Fallback files `/files/prompts/<name>.md` = live production text | No huge env vars; the fallback tracks what's actually live |
| Redis prompt cache (60 s) | None | 8 posts/day doesn't need a cache |
| `$env` fully open, secrets in env | Secrets via `*_FILE`; `$env` holds non-secret config only | Workflows can't read the encryption key or DB password |
| Promote over UI edits with `--promote` | Requires `--promote --force`; pending versions are reused, not duplicated | Safer and idempotent |
| Workflow IDs hardcoded in the script | `n8n/manifest.json` plus drift validation | One source of truth, checked by tests |

## Verified facts used so far (2026-10-13)

- Langfuse **4.52.0** (released 2026-10-06): headless init works; OTLP ingestion with
  `x-langfuse-ingestion-version: 4` is accepted; generations link to prompt versions via
  `langfuse.observation.prompt.name` / `.version`; reads use `/api/public/v2/observations`;
  `PATCH /api/public/v2/prompts/{name}/versions/{v}` with `newLabels` moves labels. All checked
  against the local instance.
- n8n 2.43.4: `N8N_ENCRYPTION_KEY_FILE` / `DB_POSTGRESDB_PASSWORD_FILE` work (read through the
  config decorator); `n8n execute` needs its own `N8N_RUNNERS_BROKER_PORT` while the main
  instance runs; credential field names come from the bundled credential classes.

- n8n stable is **2.43.4** (docs.n8n.io); `N8N_WEBHOOK_URL` exists from 2.30.0; `N8N_LOG_FORMAT=json` is supported.
- MinIO stopped publishing free Docker images (Oct 2025) and its repo is archived, so local S3 uses
  **SeaweedFS 4.48** (`weed mini`, released 2026-09-28) instead.
