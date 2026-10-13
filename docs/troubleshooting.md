# Troubleshooting

Start with `npm run doctor`. It checks every component and never prints secrets.

## Docker

**`failed to connect to the docker API … dockerDesktopLinuxEngine`**
Docker Desktop isn't running. Start it (Windows per-user install:
`%LOCALAPPDATA%\Programs\DockerDesktop\Docker Desktop.exe`), wait for "Engine running", retry.

**Port already in use (5433 / 5678 / 8333)**
Change `POSTGRES_HOST_PORT`, `N8N_HOST_PORT` or `S3_HOST_PORT` in `.env`. If you change
`POSTGRES_HOST_PORT`, update the port inside `DATABASE_URL` too.

**`required variable … is missing a value: run npm run setup`**
There is no `.env`, or it lacks the variable. Run `npm run setup` (never overwrites) and `npm run check-env`.

## PostgreSQL

**The `n8n` / `tn_content` databases or roles don't exist**
`docker/postgres/init/*.sh` runs **only on the first start of an empty volume**. If the volume
existed before, the script was skipped. Local dev only, **this deletes all local data**:
`docker compose down -v && npm run up`.

**Init script fails with `$'\r': command not found`**
The shell script was checked out with CRLF line endings. `.gitattributes` forces LF; re-checkout
with `git rm --cached -r . && git reset --hard` or convert the file to LF.

**Changed `APP_DB_PASSWORD` in `.env` but login fails**
Passwords are set at volume creation. Change it in the DB too:
`docker compose exec postgres psql -U postgres -c "ALTER ROLE tn_app PASSWORD '…'"`, then update
`DATABASE_URL`.

## n8n

**`Mismatching encryption keys` on startup**
`N8N_ENCRYPTION_KEY` in `.env` differs from the key stored in the `n8n_data` volume. Restore the
original key from your backup. Do not delete the volume unless you accept losing all n8n
credentials.

**Log line `[runner:js] ExperimentalWarning: localStorage is not available…` at level error**
Harmless. It comes from the Node 26 runtime inside n8n's JavaScript task runner and doesn't
affect execution.

**Can't log in / cookie errors over http**
Local dev needs `N8N_SECURE_COOKIE=false` (already the default in `.env.example`). Production must
run on https with secure cookies on.

**What can workflows read through `$env`?**
Only the non-secret config the compose file passes (`LANGFUSE_BASE_URL`, `TN_ENV`, n8n
settings). The encryption key and DB password come from `/run/secrets/*` via `*_FILE`.
`npm run doctor` fails if a secret-looking variable appears. Never add a secret to the n8n
`environment:` block; use an n8n credential.

**`bootstrap:n8n` self-check: "Task Broker's port 5679 is already in use"**
`n8n execute` starts its own task-runner broker. bootstrap passes
`N8N_RUNNERS_BROKER_PORT=5690` for that process. If you run it by hand, do the same:
`docker compose exec -u node -e N8N_RUNNERS_BROKER_PORT=5690 n8n n8n execute --id=tn-00-selfcheck`.

**Self-check: prompt came from `file_fallback`**
n8n couldn't reach Langfuse at `LANGFUSE_BASE_URL` (container network), or the prompt has no
`production` label. Check `docker compose ps langfuse-web` and run `npm run seed-prompts`.

**`require('crypto')` fails in a Code node**
`NODE_FUNCTION_ALLOW_BUILTIN=crypto` must be set on the n8n service (it is in
`docker-compose.yml`). Recreate the container after changing it: `docker compose up -d n8n`.

## Langfuse

**`trace-create … is not accepted by /api/public/ingestion when LANGFUSE_MIGRATION_V4_WRITE_MODE is events_only`**
Langfuse v4 accepts only scores on the legacy ingestion endpoint. Traces must go through OTLP
(`/api/public/otel/v1/traces`), which `[SUB] Trace Generation` uses. Don't copy the legacy
ingestion node from older projects.

**`This endpoint is not available on deployments running in Langfuse v4 events_only mode`**
The v1 `/api/public/traces` and `/api/public/observations` read APIs were removed. Use
`/api/public/v2/observations?traceId=…&fields=core,basic,io,usage,prompt,model,metadata`.

**Langfuse login or API keys don't work**
Headless init (`LANGFUSE_INIT_*`) only runs while the project doesn't exist yet. If you changed
the keys in `.env` afterwards, create new keys in the Langfuse UI (Project Settings → API Keys),
put them in `.env`, then run `npm run bootstrap:n8n`.

**seed-prompts: "production was edited in the Langfuse UI"**
Someone changed the prompt in Langfuse. Review the diff in the UI. To overwrite it with the
repo version: `npm run seed-prompts -- --promote --force`. Better: copy the UI change into
`prompts/templates/` first.

**Langfuse uses too much RAM**
Remove `langfuse` from `COMPOSE_PROFILES` and use Langfuse Cloud
(see [prompts-and-langfuse.md](prompts-and-langfuse.md#local-vs-cloud)), then
`docker compose down` and `npm run dev:up`.

## Models

**Claude 400: `output_config.format.schema: … property '$comment' is not supported`**
Structured outputs don't accept JSON-Schema annotation keywords. Build requests with
`buildCaptionRequest` (it strips them), or remove `$comment` from any schema you send by hand.
The same rule applies to `minLength` / `maxLength` / `minimum`; enforce those after parsing.

**Claude `stop_reason: "refusal"`**
A safety classifier declined, and so did the automatic fallback. The post goes to
`needs_review`. Never retry it into publication.

**Gemini returns no image (`finishReason` IMAGE_SAFETY / PROHIBITED_CONTENT, or text only)**
`parseImageResponse` reports `no_image` / `blocked`. Safety stops aren't retryable, so skip the
slot or pick another scene brief.

**Run `npm run verify:models` first.** It's free. It confirms both keys and both model IDs
before you spend anything.

## Windows / Git Bash

**`sh: can't open 'C:/Program Files/Git/docker-entrypoint-initdb.d/…'`**
Git Bash rewrites absolute container paths in `docker` arguments. The npm scripts aren't
affected. For manual commands, prefix them with `MSYS_NO_PATHCONV=1`.

## Object storage (SeaweedFS locally)

**Doctor: HeadBucket 403** — `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` don't match what the
container was started with. Run `docker compose up -d --force-recreate seaweedfs`.

**Doctor: HeadBucket 404** — the bucket wasn't created. Check `S3_BUCKET` and recreate the container.

**Instagram/Facebook can't fetch `http://localhost:8333/...` images**
Expected. Platforms fetch media from the public internet. Real publishing needs Cloudflare R2
with a public URL (Phase F).
