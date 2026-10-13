# Data model (Phase B)

PostgreSQL database `tn_content`, managed by Prisma 7.10.0. The schema is in
[`prisma/schema.prisma`](../prisma/schema.prisma) and the migrations are in `prisma/migrations/`.

Two layers:
1. **Prisma schema** (`*_init`): 11 tables, enums, unique keys and foreign keys.
2. **Database rules** (`*_db_rules`): CHECK constraints, the post state machine and the claim
   functions.

These rules live in Postgres so they hold for every caller: Prisma, n8n's Postgres node, or a
human with `psql`.

```
locations ─┬─< research_sources ─< location_facts      (facts need a source; verified needs verified_at)
           ├─< image_assets (self-ref: enhanced → licensed parent)
           └─< posts >── publish_slots (1:1, slot_id UNIQUE)
                 ├─< platform_publications (UNIQUE post_id+platform) ─< publish_attempts
                 └─< post_status_transitions (audit, written by trigger)
app_config (runtime config, incl. kill switch)    generation_errors (structured failures)
```

## Conventions

- **Naming:** snake_case tables and columns (`@@map`/`@map`), so SQL from n8n is natural.
- **Time:** every timestamp is `timestamptz`, and all databases default to `UTC`. Slots store
  both the instant (`slot_at`) and the Africa/Tunis wall clock (`local_date`, `local_time`).
- **IDs:** database-generated UUIDs (`gen_random_uuid()`).
- **Generated client:** `src/generated/prisma` is git-ignored and regenerated on `npm install`.
  Connect through `createPrisma()` in [`src/db.ts`](../src/db.ts).

## Guarantees enforced by the database

| Rule | Mechanism |
|---|---|
| One post per slot | `posts.slot_id` UNIQUE |
| One publication record per post and platform | `platform_publications (post_id, platform)` UNIQUE |
| No duplicate content | `posts.content_hash` UNIQUE (SHA-256 of normalized caption + image SHA-256) |
| No duplicate image files | `image_assets.sha256` UNIQUE |
| Near-duplicate images | `tn_similar_assets(phash, max_distance)`: Hamming distance on the 64-bit perceptual hash |
| Licensed photos must carry a source, license and attribution | CHECK `image_assets_rights_required` |
| No licensed photo is approved before its rights are verified | CHECK `image_assets_approval_needs_rights` |
| Provenance can't lie: AI images are flagged as AI; enhanced photos are AI-edited and point at their licensed parent | CHECK `image_assets_provenance` |
| A post past draft is complete, including both disclosure lines | CHECK `posts_complete_when_validated` |
| Scheduled and published posts have a time | CHECK `posts_scheduled_has_time` |
| A publication is `published` only with an external post ID and a timestamp | CHECK `platform_publications_published_has_id` |
| A fact is `verified` only with `verified_at` and an existing source | CHECK + FK |

## Post state machine

```
draft ──► validated ──► scheduled ──► publishing ──► published
  │           │             │             ├──► failed ──► draft (retry) / skipped
  │           │             │             └──► needs_review
  ├──► needs_review ◄───────┴─────────────────┘   needs_review ──► draft / skipped
  ├──► skipped
  └──► failed
```

- Posts must be inserted as `draft`.
- Any transition not in this diagram raises `check_violation`. The guard is the
  `tn_post_status_guard` trigger, backed by `tn_post_transition_allowed`.
- Every change is appended to `post_status_transitions`. Use `tn_transition_post(id, status,
  reason, actor)` so the log records who and why.
- `published_at` is stamped automatically.

## Scheduling and safe claiming

The schedule lives in `app_config` and is seeded from `.env`. After seeding, the database value
wins.

| Key | Default | Meaning |
|---|---|---|
| `schedule` | 07:00–21:00 every 120 min, Africa/Tunis | 8 slots a day |
| `daily_post_cap` | 8 | Maximum posts committed per local day |
| `publishing_enabled` | `false` | **Global kill switch.** Nothing is published; queued posts are kept |
| `production_enabled` | `true` | `false` stops claiming slots and generating content |
| `enabled_platforms` | `["facebook","instagram"]` | One publication row per platform |
| `destination_cooldown_hours` | 48 | 22 destinations at 8 a day rotate about every 66 h |
| `slot_lead_minutes` / `slot_max_lateness_minutes` | 45 / 60 | Produce up to 45 min early; never publish more than 60 min late |
| `slot_lease_minutes` / `slot_max_attempts` | 20 / 3 | Crash recovery |

`tn_claim_due_slot(worker)` returns zero or one slot. It:
- serializes on a transaction-scoped advisory lock and uses `FOR UPDATE SKIP LOCKED`;
- materializes today's and tomorrow's slots;
- marks missed slots `skipped` instead of producing them late;
- re-claims expired leases until `slot_max_attempts`, then marks the slot `failed`;
- enforces the daily cap inside the lock.

Two more functions complete the cycle:
- `tn_heartbeat_slot(slot, worker)` extends a lease.
- `tn_complete_slot(slot, worker, outcome)` finishes a slot. Both are **fenced**: a worker whose
  lease expired, and whose slot was re-claimed, can't overwrite the new holder's result.

`tn_pick_location()` picks a destination:
1. active and outside its cooldown;
2. prefers a different landscape type from the last post;
3. least recently featured first;
4. if every destination is cooling down, takes the least recently featured and returns
   `cooldown_fallback = true`.

### Using it from n8n (Postgres node, credential `tn-app-db`)

```sql
-- claim (returns 0 or 1 row)
SELECT * FROM tn_claim_due_slot('n8n:' || '{{ $execution.id }}');
-- pick a destination for it
SELECT * FROM tn_pick_location();
-- finish
SELECT tn_complete_slot('{{ $json.slot_id }}'::uuid, 'n8n:{{ $execution.id }}', 'produced');
-- status change with audit
SELECT * FROM tn_transition_post('{{ $json.post_id }}'::uuid, 'validated', 'all gates passed', 'n8n:{{ $execution.id }}');
-- kill switch
UPDATE app_config SET value = 'false'::jsonb WHERE key = 'publishing_enabled';
```

Pass values through query parameters (`$1`, `$2`) in the n8n node rather than string
interpolation. The examples above are written for readability.

## Seed data

`npm run db:seed` creates or updates:
- the config keys (only missing ones are inserted; `--reset-config` overwrites them from `.env`);
- **22 natural destinations**: your list plus well-known natural sites in the north, centre,
  south and on the islands;
- today's and tomorrow's slots.

**Nothing is marked verified.** Every destination has `geo_verified = false`, and no
`location_facts` are seeded. Captions may only state facts that have a recorded source and
`status = 'verified'`. Until research is recorded, captions stay evocative and make no factual
claims; the caption gates enforce this.

`scene_briefs` are visual ideas for AI images, not claims. They deliberately contain no wildlife,
no human structures and no identifiable landmarks.

Excluded on purpose: Jebel Chambi (restricted security zone), and Zembra and La Galite (access
restricted, so posts could encourage illegal visits).

## Commands

```bash
npm run db:migrate      # create/apply migrations in development (prisma migrate dev)
npm run db:deploy       # apply committed migrations (CI / production)
npm run db:seed         # config + destinations + slots (idempotent)
npm run db:studio       # browse data
npm run test:db         # 24 integration tests on a separate <db>_test database
npm run typecheck
```

`test:db` creates `tn_content_test` on first run, applies the real migrations, and truncates it
before each test. Your development data is never touched. It covers:
- 25 workers racing for one slot (exactly one wins);
- the daily cap under 10 concurrent claimers;
- lease expiry and fencing;
- missed and late slots;
- destination cooldown, variety, and concurrent picks;
- the state machine and its audit log;
- rights and provenance CHECKs;
- SHA-256 and perceptual-hash duplicate detection.
