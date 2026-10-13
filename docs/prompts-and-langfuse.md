# Prompts and Langfuse

Langfuse is the **runtime source of truth** for prompts and the record of every LLM/image call.
The repository holds the **templates**, and `npm run seed-prompts` pushes them to Langfuse as
versions.

```
prompts/templates/*.md ──render──► seed-prompts ──► Langfuse prompt versions (label: production)
prompts/config.json ──────┘              │                    │
prompts/shared/*.md (partials) ──────────┘                    ▼
                         n8n/files/prompts/<name>.md ◄── [SUB] Get Prompt (n8n) ──► Gemini call
                              (fallback copy)                   │
                                                                ▼
                                       [SUB] Trace Generation ──► Langfuse (OTLP span, linked
                                                                  to prompt name + version)
```

## Templates

`prompts/templates/<name>.md`. The file name is the Langfuse prompt name. Each template starts
with a header:

```
<!--
name: tn-caption-request
description: one line
config_vars: base_hashtags               ← filled by seed-prompts from prompts/config.json
runtime_vars: destination_name_en, ...   ← stay as {{var}}; filled per post at run time
-->
```

- Placeholders are `{{snake_case}}`. seed-prompts fails if a placeholder isn't declared, if a
  declared runtime var isn't used, or if a config var has no value. It reports every problem
  at once.
- `config_vars` can also name a partial in `prompts/shared/` (`voice-and-language.md` →
  `{{voice_and_language}}`).
- No secrets in templates or `config.json`.

| Prompt | Used for |
|---|---|
| `tn-editorial-system` | System prompt for captions. Your editorial rules verbatim, the Derja-first voice policy, and the JSON output contract |
| `tn-caption-request` | Per-post user message: destination, image origin, verified facts, attribution, disclosure |
| `tn-image-original` | Text-to-image: original artwork *inspired by* a region (stylized, no landmarks, no text) |
| `tn-image-enhance` | Image-to-image: enhance a licensed photo **without changing its geography** |

## seed-prompts semantics

| Situation | Result |
|---|---|
| Prompt doesn't exist | Version 1 is created with label `production` |
| Repo text equals production | Skipped |
| Repo text changed | New version created **without** `production`. Review it in Langfuse |
| Same change already pushed (newest version) | No duplicate. Reported as awaiting review |
| `--promote` | The new or pending version becomes `production` |
| Production was edited in the Langfuse UI | Warning. `--promote` refuses; `--promote --force` overrides |

After each prompt, the **live production text** is written to `n8n/files/prompts/<name>.md`.
n8n serves that file only if Langfuse is unreachable.

```bash
npm run seed-prompts -- --dry-run --print      # render + validate, print, no network
npm run seed-prompts                           # push changes (unpromoted)
npm run seed-prompts -- --promote              # push and promote
npm run seed-prompts -- --fallback-only        # no Langfuse: write repo text as fallback files
```

## n8n sub-workflows

- **`[SUB] Get Prompt`** (`get-prompt`). Inputs `prompt_name`, optional `label`. Returns
  `prompt_text`, `prompt_version`, `prompt_config`, and `source` (`langfuse` or
  `file_fallback`). The name is validated (`^[a-z0-9-]+$`) before it's used in a URL or file path.
- **`[SUB] Trace Generation`** (`trace-generation`). Records one call as an OpenTelemetry
  `generation` span via `POST /api/public/otel/v1/traces` (header
  `x-langfuse-ingestion-version: 4`).
  - `trace_key` is any stable string, e.g. `post:<uuid>`. Its SHA-256 gives the 32-hex trace id,
    so every call for one post lands in one trace.
  - Pass `prompt_name` + `prompt_version` from Get Prompt so Langfuse links cost and quality to
    the prompt version.
  - Never pass image bytes or base64. Tracing never blocks: a failure returns `traced: false`.

> **Langfuse v4 note.** v4 rejects the legacy `/api/public/ingestion` `trace-create` /
> `generation-create` events (only scores are accepted there), and has removed the v1
> `/api/public/traces` read API. Use OTLP for writes and `/api/public/v2/observations` for reads.
> This applies to Langfuse Cloud as well.

## Local vs. Cloud

- **Local (default):** `COMPOSE_PROFILES=langfuse` runs Langfuse **4.52.0** (web, worker,
  ClickHouse 25.12, Redis 7). It reuses this stack's Postgres (`langfuse` DB, UTC) and SeaweedFS
  (`langfuse` bucket).
  - Headless init creates the org, project `tn-nature-dev`, the API keys from `.env`, and an
    admin user.
  - UI: <http://localhost:3000>, login `LANGFUSE_INIT_USER_EMAIL` / `LANGFUSE_INIT_USER_PASSWORD`.
  - Needs roughly 2–3 GB of RAM and about 4.7 GB of images.
- **Langfuse Cloud (Hobby, free):** 50k units/month, 30-day data, 2 users. This project's volume
  (8 posts/day, a few calls each) is about 1–2k units/month.
  - Clear `COMPOSE_PROFILES`.
  - Set `LANGFUSE_BASE_URL` and `LANGFUSE_HOST_URL` to `https://cloud.langfuse.com` (EU).
  - Replace both keys with your project's keys.
  - Run `npm run seed-prompts` and `npm run bootstrap:n8n`.
  - Nothing else changes.

The reference project (instabot-core) pins self-hosted **Langfuse v2**. This project
deliberately doesn't: v2 is unsupported, and its security updates ended in March 2025.
