# Tunisia Nature Content Automation

This system creates and publishes posts about Tunisian nature: forests, coastlines, islands,
mountains, oases, deserts, and lesser-known natural places. Each post has one image, either
original AI artwork or an enhanced, properly licensed photograph. The caption comes in
**Tunisian Derja (Arabic script) first, English second**. Each post goes out to Facebook,
Instagram and, once TikTok authorizes the app, TikTok.

There's no manual approval step and no Telegram. Automated checks run before anything is
published. Content that fails a check is skipped or held in `needs_review` and never published.

- **Schedule:** Africa/Tunis, every 2 h from 07:00 to 21:00 inclusive, 8 slots a day.
  Configurable, with a daily cap and a global kill switch.
- **Models:** Claude Opus 5.5 (`claude-opus-5-5`) writes captions; Gemini Nano Banana 2.1
  (`gemini-nano-banana-2.1`, 2K, 4:5) generates and enhances images. See [docs/models.md](docs/models.md).
- **Stack:** n8n (orchestration), PostgreSQL, Prisma, a small TypeScript service, Anthropic,
  Google Gemini, Langfuse (prompt management + LLM tracing), S3-compatible storage (SeaweedFS
  locally, Cloudflare R2 in production).

> **Project status:** the local environment, Langfuse prompt management/tracing, n8n
> provisioning, both models (live-tested) and the data model (Phase B) are done and verified. Content production and publishing are **not built yet**.
> See [docs/implementation-plan.md](docs/implementation-plan.md). No social platform
> integration has been tested against a real API.

## Quick start (local)

Prerequisites: Docker Desktop (Compose v2), Node.js ≥ 22, Git. Roughly 4 GB of free RAM with
the local Langfuse profile.

```bash
npm run dev:up
```

`dev:up` runs these steps (each is also a separate command):

| Step | Command | What it does |
|---|---|---|
| env | `npm run setup` / `npm run check-env` | Creates `.env` with generated secrets (or appends newly added variables), then validates it |
| stack | `npm run up` | Starts every service and waits until each is healthy |
| databases | (init script) | Idempotent roles/DBs for n8n, the app and Langfuse, with passwords synced from `.env`, all UTC |
| prompts | `npm run seed-prompts` | Renders `prompts/templates` and pushes them to Langfuse ([guide](docs/prompts-and-langfuse.md)) |
| n8n | `npm run bootstrap:n8n` | Owner account, workflows (fixed IDs), credentials, publish, restart, self-check |
| app DB | `npm run db:deploy` / `npm run db:seed` | Prisma migrations, runtime config, 22 destinations, today's slots |
| check | `npm run doctor` | End-to-end health checks |

Then:

1. Put your keys in `.env` as `ANTHROPIC_API_KEY=…` and `GEMINI_API_KEY=…`, then re-run
   `npm run bootstrap:n8n`, which adds the Anthropic and Gemini credentials. Check them with
   `npm run verify:models` (free) or `npm run verify:models -- --live` (about $0.05–0.10). Never put the key in source files
   or workflow JSON.
2. Back up `N8N_ENCRYPTION_KEY` and `LANGFUSE_ENCRYPTION_KEY` in a password manager.

Logins (local only, from `.env`):
- n8n: <http://localhost:5678> with `N8N_OWNER_EMAIL` / `N8N_OWNER_PASSWORD`.
- Langfuse: <http://localhost:3000> with `LANGFUSE_INIT_USER_EMAIL` / `LANGFUSE_INIT_USER_PASSWORD`.

Other commands: `npm run logs`, `npm run ps`, `npm run down`, `npm test`.

## Local services

| Service | URL (host) | Purpose |
|---|---|---|
| n8n 2.43.4 | http://localhost:5678 | Workflows, schedules, credentials |
| PostgreSQL 17 | `localhost:5433` | DBs `n8n`, `tn_content` (app) and `langfuse`, each with its own role, all UTC |
| SeaweedFS 4.48 | http://localhost:8333 | S3 API, stand-in for Cloudflare R2. Buckets `tn-nature-media` and `langfuse`, auth required |
| Langfuse 4.52.0 *(profile)* | http://localhost:3000 | Prompt versions + traces. Worker, ClickHouse and Redis are internal only |

All ports bind to `127.0.0.1` only. Data lives in named volumes and survives `npm run down`.
`docker compose down -v` deletes it. To use Langfuse Cloud instead of the local profile, see
[docs/prompts-and-langfuse.md](docs/prompts-and-langfuse.md#local-vs-cloud).

## n8n provisioning

`npm run bootstrap:n8n` is idempotent: re-run it any time to sync n8n to the repo.

- **Workflows:** `n8n/workflows/**.json`, all listed in `n8n/manifest.json` with fixed kebab-case
  IDs and a `publish` flag. Preflight fails on drift: unlisted files, ID mismatches, unknown
  sub-workflow targets or credential references, or secret-looking strings in an export.
- **Credentials** are generated from `.env` and streamed into the container over stdin, never
  written to host disk:

  | ID | Type | Use |
  |---|---|---|
  | `langfuse` | httpBasicAuth | Langfuse API |
  | `tn-app-db` | postgres | App database |
  | `tn-media-s3` | s3 | Media bucket |
  | `gemini` | googlePalmApi | n8n's native Gemini nodes; key travels as `?key=` |
  | `gemini-header` | httpHeaderAuth | HTTP Request nodes; key travels in the `x-goog-api-key` header, so prefer this one |

- **Self-check:** `TN-00 Self-check` fetches a prompt from Langfuse and writes a test generation.
  Bootstrap then confirms in Langfuse that the generation exists and is linked to the prompt
  version.

## Security rules

- `.env` is git-ignored, and `npm run check-env` fails if it ever isn't.
- Platform tokens and API keys go into **n8n credentials**, not workflow JSON. Exported
  workflows reference credentials by ID and name only, and a test scans exports for leaked
  secrets.
- n8n reads its encryption key and DB password from **files** (`*_FILE`, Compose secrets), so
  they aren't in its process environment. Workflows may read `$env` only for the non-secret
  config the compose file passes (`LANGFUSE_BASE_URL`, `TN_ENV`). `npm run doctor` asserts that
  no secret-looking variable is visible.
- Scripts never print secret values. Tests check that validation messages don't leak them.
- Production uses a separate env file and separate credentials (Phase F).

## Repository layout

```
docker-compose.yml            local stack + "langfuse" profile (pinned images, healthchecks, volumes)
docker/postgres/init/         idempotent roles + databases (injection-safe psql variables, UTC)
scripts/dev-up.mjs            one command: env → up → DBs → seed prompts → bootstrap n8n → doctor
scripts/setup.mjs             create .env / append new variables, with random secrets
scripts/check-env.mjs         validate .env (schedule, timezone, platforms, Langfuse, placeholders)
scripts/seed-prompts.mjs      render prompt templates → Langfuse versions + n8n fallback files
scripts/bootstrap-n8n.mjs     owner, workflows, credentials, publish, restart, self-check
scripts/doctor.mjs            end-to-end health checks
scripts/lib/                  shared helpers (env, prompts, n8n, Langfuse client, SigV4)
prompts/                      templates/, shared/ partials, config.json (deploy-time values)
n8n/workflows/                workflow exports (mounted read-only at /workflows)
n8n/manifest.json             workflow IDs + publish flags (bootstrap source of truth)
n8n/files/                    runtime files mounted at /files (prompt fallbacks; git-ignored)
tests/                        unit tests (node:test, no dependencies)
docs/                         plan, prompts & Langfuse guide, troubleshooting
```

## Documentation

- [Implementation plan & architecture](docs/implementation-plan.md)
- [Models: Claude Opus (text) + Gemini Nano Banana 2.1 (image)](docs/models.md)
- [Data model: tables, state machine, slot claiming](docs/data-model.md)
- [Prompts and Langfuse](docs/prompts-and-langfuse.md)
- [Troubleshooting](docs/troubleshooting.md)
