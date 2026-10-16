# Publishing (Phase D): `TN-02 Publisher (Facebook + Instagram)`

TN-02 takes `scheduled` posts and publishes them to the **Green Tunisia** Facebook Page and the
linked Instagram account through the Meta Graph API. TikTok is not built.

As in production (Phase C), n8n makes every external call with its own credential, and
`tn-core` decides what to call next and what each response means. **`tn-core` never sees the
Meta access token**: it only knows the Page and Instagram ids.

```
Every 5 min (Africa/Tunis) ─► tn-core claim
  ├─ skip queued publications more than slot_max_lateness_minutes late (never publish late)
  ├─ expired leases: in a publish call → reconciling, otherwise → pending
  ├─ kill switch off / no configured platform → stop
  └─ lock ONE due publication (reconciliation first; daily cap per platform), lease it,
     return its first step
        └─► loop: [SUB] Graph call executes the step → tn-core apply decides → next step
            (up to 5 publications per run)
```

## Phases

```
facebook   fb_publish ─► fb_permalink ─► done
instagram  [ig_stage ─► ig_stage_url] ─► ig_container ─► ig_status ─► ig_publish ─► ig_permalink ─► done
```

| Phase | Graph call | Notes |
|---|---|---|
| `fb_publish` | `POST /{page}/photos` (multipart image + message) | **publishes**; not idempotent |
| `fb_permalink` | `GET /{post}?fields=permalink_url` | after the post is already recorded as published |
| `ig_stage` | `POST /{page}/photos` with `published=false` | only when the media store has no public https URL (local SeaweedFS). Gives Instagram an image URL on Facebook's CDN |
| `ig_stage_url` | `GET /{photo}?fields=images` | largest rendition |
| `ig_container` | `POST /{ig}/media` (`image_url`, `caption`, `alt_text`) | a CDN URL that expired is restaged once |
| `ig_status` | `GET /{container}?fields=status_code` | `IN_PROGRESS` is checked again a minute later, up to 5 times |
| `ig_publish` | `POST /{ig}/media_publish` | **publishes**; not idempotent |
| `ig_permalink` | `GET /{media}?fields=permalink` | |

The image bytes for an upload come from `GET /v1/publish/media` on tn-core, which only serves
them while that upload step is the current one.

## Safety rules

- **Kill switch.** `app_config.publishing_enabled` is checked at claim time **and again right
  before each publishing call**. Turning it off mid-flight stops before anything is posted.
- **Never late.** A publication still queued `slot_max_lateness_minutes` (60) after its time is
  `skipped`.
- **Daily cap.** At most `daily_post_cap` published per platform per Africa/Tunis day.
- **No double posts.** `fb_publish` and `ig_publish` are not idempotent. A timeout or a 5xx
  without a Graph error body means the outcome is unknown, so the publication goes to
  `reconciling`: tn-core reads the Page's recent posts (or the container status and the account's
  recent media) and looks for our exact text before ever publishing again. The same happens when
  a lease expires during a publishing call.
- **Recorded at once.** The moment Graph confirms a post, its id is stored and the publication is
  `published`, before the permalink call, so a crash afterwards cannot lead to a second post.
- **Fenced.** Every apply carries `(publication_id, attempt_no, phase)`; a duplicate or stale
  report gets HTTP 409 and changes nothing.
- **Retries.** Transient errors (rate limits, Graph codes 1, 2, 4, 17, 32, 341, 368, 613, 9007…,
  HTTP 429) back off 2, 4, 8 … up to 30 minutes, for at most `publish_max_attempts` (5) attempts;
  reconciliation gets twice as many. Auth errors (190, 200, 10…) and other 4xx fail at once.
- **Instagram limits** are checked before anything is sent: caption ≤ 2,200 characters and
  ≤ 30 hashtags. Facebook and Instagram get the identical text (Derja, English, hashtags).
- A post is `published` once at least one platform published it, `failed` if none did.

Every step (phase, HTTP status, classified error, the first 2,000 characters of the response) is
kept in `publish_attempts.response`.

## One-time Meta setup

Prerequisites: the Instagram account is a **Professional** account linked to the Facebook Page
(both done for Green Tunisia).

1. Create a Meta app at <https://developers.facebook.com/apps> (type **Business**). Put its
   **App ID** and **App secret** (App settings → Basic) into `.env` as `META_APP_ID` and
   `META_APP_SECRET`. They are only used by the setup script.
2. Open the [Graph API Explorer](https://developers.facebook.com/tools/explorer/), select the app,
   and generate a **User token** with these permissions: `pages_show_list`,
   `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`,
   `instagram_content_publish`. Approve the Green Tunisia Page and Instagram account in the dialog.
3. Run:

   ```bash
   npm run meta:setup
   ```

   Paste the token when asked (it is not echoed). The script exchanges it for a long-lived token,
   finds the Page and its linked Instagram account, checks the permissions, and writes
   `META_PAGE_ID`, `META_IG_USER_ID` and a **never-expiring Page token** (`META_PAGE_ACCESS_TOKEN`)
   into `.env`. With several Pages, add `-- --page-id <id>`.
4. Store the token in n8n and give tn-core the ids:

   ```bash
   npm run bootstrap:n8n
   ```

   ```bash
   docker compose up -d tn-core
   ```

5. Check, at any time, without posting anything:

   ```bash
   npm run meta:check
   ```

While the app is in **Development** mode it can only publish to Pages and accounts whose admins
have a role on the app, which is enough for our own Page. App Review is needed only for other
people's Pages.

## Turning publishing on

Publishing stays off until both of these are done on purpose:

1. `app_config.publishing_enabled = true` and the platforms listed in `enabled_platforms`.
2. TN-02 active: set `"publish": true` for `tn-02-publisher` in `n8n/manifest.json` and run
   `npm run bootstrap:n8n` (or toggle it in the n8n editor).

To run one pass by hand:

```bash
docker compose exec -u node -e N8N_RUNNERS_BROKER_PORT=5690 n8n n8n execute --id=tn-02-publisher
```

## Verified live (2026-10-16)

The Ghar El Melh post produced on 2026-10-13 was published by hand, one platform at a time,
with the kill switch on only for the run:

| Platform | Steps | Result |
|---|---|---|
| Facebook | `fb_publish` → `fb_permalink` | published on attempt 1 |
| Instagram | `ig_stage` → `ig_stage_url` → `ig_container` → `ig_status` → `ig_publish` → `ig_permalink` | published on attempt 1; the container was `FINISHED` at the first status check |

## tn-core API

| Endpoint | Purpose |
|---|---|
| `POST /v1/publish/claim` `{ worker }` | maintenance (late, expired leases), then lock one due publication and return its first step |
| `POST /v1/publish/apply` `{ publication_id, attempt_no, phase, result, worker }` | record a step's Graph response and return the next step, or the outcome |
| `GET /v1/publish/media?publication_id=…&attempt_no=…` | image bytes for the current upload step |

`result` is `{ status, body }` for a Graph response, `{ transport_error }` when the Graph call
itself failed (outcome unknown), or `{ local_error }` when nothing reached Meta.
