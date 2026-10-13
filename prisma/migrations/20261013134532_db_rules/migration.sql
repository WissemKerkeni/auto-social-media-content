-- Database-level rules that must hold for every caller (Prisma, n8n Postgres node, psql).
-- Sections:
--   1. updated_at maintenance
--   2. CHECK constraints (rights, provenance, completeness)
--   3. Post state machine (guard + audit log)
--   4. Runtime config helpers
--   5. Slots: materialize, claim (atomic, leased, capped), complete (fenced)
--   6. Destination picking (cooldown + variety)
--   7. Image near-duplicate search (perceptual hash)
--   8. Platform publication rows (one per post/platform)

-- ─────────────────────────────────────────────────────────────── 1. updated_at
CREATE FUNCTION tn_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER tn_touch_updated_at BEFORE UPDATE ON locations             FOR EACH ROW EXECUTE FUNCTION tn_touch_updated_at();
CREATE TRIGGER tn_touch_updated_at BEFORE UPDATE ON location_facts        FOR EACH ROW EXECUTE FUNCTION tn_touch_updated_at();
CREATE TRIGGER tn_touch_updated_at BEFORE UPDATE ON image_assets          FOR EACH ROW EXECUTE FUNCTION tn_touch_updated_at();
CREATE TRIGGER tn_touch_updated_at BEFORE UPDATE ON publish_slots         FOR EACH ROW EXECUTE FUNCTION tn_touch_updated_at();
CREATE TRIGGER tn_touch_updated_at BEFORE UPDATE ON posts                 FOR EACH ROW EXECUTE FUNCTION tn_touch_updated_at();
CREATE TRIGGER tn_touch_updated_at BEFORE UPDATE ON platform_publications FOR EACH ROW EXECUTE FUNCTION tn_touch_updated_at();
CREATE TRIGGER tn_touch_updated_at BEFORE UPDATE ON app_config            FOR EACH ROW EXECUTE FUNCTION tn_touch_updated_at();

-- ─────────────────────────────────────────────────────────────── 2. CHECK constraints
-- Licensed photos are unusable without a source, a license and an attribution.
ALTER TABLE image_assets ADD CONSTRAINT image_assets_rights_required CHECK (
  origin = 'ai_generated'
  OR (source_url IS NOT NULL AND license_code IS NOT NULL AND attribution_text IS NOT NULL)
);
-- Provenance flags must agree with the origin.
ALTER TABLE image_assets ADD CONSTRAINT image_assets_provenance CHECK (
     (origin = 'ai_generated'            AND ai_generated)
  OR (origin = 'licensed_photo'          AND NOT ai_generated AND NOT ai_edited)
  OR (origin = 'licensed_photo_enhanced' AND NOT ai_generated AND ai_edited AND parent_asset_id IS NOT NULL)
);
-- Nothing non-AI is approved before its rights are verified.
ALTER TABLE image_assets ADD CONSTRAINT image_assets_approval_needs_rights CHECK (
  status <> 'approved' OR origin = 'ai_generated' OR (rights_verified AND rights_verified_at IS NOT NULL)
);
ALTER TABLE image_assets ADD CONSTRAINT image_assets_sha256_hex CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$');
ALTER TABLE image_assets ADD CONSTRAINT image_assets_phash_hex  CHECK (phash  IS NULL OR phash  ~ '^[0-9a-f]{16}$');
ALTER TABLE image_assets ADD CONSTRAINT image_assets_dimensions CHECK (
  (width IS NULL OR width > 0) AND (height IS NULL OR height > 0) AND (bytes IS NULL OR bytes > 0)
);

ALTER TABLE location_facts ADD CONSTRAINT location_facts_verified_at CHECK (status <> 'verified' OR verified_at IS NOT NULL);

ALTER TABLE posts ADD CONSTRAINT posts_content_hash_hex CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$');
-- A post past draft (and not parked) must be complete, including its disclosure.
ALTER TABLE posts ADD CONSTRAINT posts_complete_when_validated CHECK (
  status IN ('draft', 'needs_review', 'skipped', 'failed')
  OR (    caption_derja    IS NOT NULL AND caption_en    IS NOT NULL
      AND alt_text         IS NOT NULL
      AND disclosure_derja IS NOT NULL AND disclosure_en IS NOT NULL
      AND image_asset_id   IS NOT NULL AND content_hash  IS NOT NULL
      AND cardinality(hashtags) > 0)
);
ALTER TABLE posts ADD CONSTRAINT posts_scheduled_has_time CHECK (
  status NOT IN ('scheduled', 'publishing', 'published') OR scheduled_for IS NOT NULL
);

ALTER TABLE publish_slots ADD CONSTRAINT publish_slots_local_time CHECK (local_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
ALTER TABLE publish_slots ADD CONSTRAINT publish_slots_claim_consistency CHECK (
  status <> 'claimed' OR (claimed_by IS NOT NULL AND claimed_at IS NOT NULL AND lease_expires_at IS NOT NULL)
);
ALTER TABLE publish_slots ADD CONSTRAINT publish_slots_attempts_nonneg CHECK (attempts >= 0);

ALTER TABLE platform_publications ADD CONSTRAINT platform_publications_published_has_id CHECK (
  status <> 'published' OR (external_post_id IS NOT NULL AND published_at IS NOT NULL)
);
ALTER TABLE platform_publications ADD CONSTRAINT platform_publications_attempts_nonneg CHECK (attempt_count >= 0);

-- ─────────────────────────────────────────────────────────────── 3. Post state machine
CREATE FUNCTION tn_post_transition_allowed(f "PostStatus", t "PostStatus") RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT (f::text || '>' || t::text) = ANY (ARRAY[
    'draft>validated', 'draft>needs_review', 'draft>skipped', 'draft>failed',
    'validated>scheduled', 'validated>needs_review', 'validated>skipped', 'validated>failed',
    'scheduled>publishing', 'scheduled>needs_review', 'scheduled>skipped',
    'publishing>published', 'publishing>failed', 'publishing>needs_review',
    'needs_review>draft', 'needs_review>skipped',
    'failed>draft', 'failed>skipped'
  ])
$$;

-- BEFORE: validate the transition (rows must be created as draft).
CREATE FUNCTION tn_post_status_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'posts must be created as draft (got %)', NEW.status USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT tn_post_transition_allowed(OLD.status, NEW.status) THEN
      RAISE EXCEPTION 'illegal post status transition % -> % (post %)', OLD.status, NEW.status, OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'published' AND NEW.published_at IS NULL THEN
      NEW.published_at := now();
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- AFTER: append to the audit log. Actor/reason come from transaction-local settings
-- (set by tn_transition_post), falling back to the database user.
CREATE FUNCTION tn_post_status_log() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO post_status_transitions (post_id, from_status, to_status, reason, actor)
    VALUES (
      NEW.id,
      CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status END,
      NEW.status,
      nullif(current_setting('tn.reason', true), ''),
      coalesce(nullif(current_setting('tn.actor', true), ''), current_user)
    );
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER tn_post_status_guard BEFORE INSERT OR UPDATE OF status ON posts
  FOR EACH ROW EXECUTE FUNCTION tn_post_status_guard();
CREATE TRIGGER tn_post_status_log AFTER INSERT OR UPDATE OF status ON posts
  FOR EACH ROW EXECUTE FUNCTION tn_post_status_log();

-- Preferred way to change status: records who and why.
CREATE FUNCTION tn_transition_post(p_post_id uuid, p_to "PostStatus", p_reason text DEFAULT NULL, p_actor text DEFAULT NULL)
RETURNS posts LANGUAGE plpgsql AS $$
DECLARE r posts;
BEGIN
  PERFORM set_config('tn.reason', coalesce(p_reason, ''), true);
  PERFORM set_config('tn.actor',  coalesce(p_actor,  ''), true);
  UPDATE posts SET status = p_to WHERE id = p_post_id RETURNING * INTO r;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'post % not found', p_post_id USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM set_config('tn.reason', '', true);
  PERFORM set_config('tn.actor',  '', true);
  RETURN r;
END $$;

-- ─────────────────────────────────────────────────────────────── 4. Config helpers
CREATE FUNCTION tn_config(p_key text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT value FROM app_config WHERE key = p_key
$$;

CREATE FUNCTION tn_config_int(p_key text, p_default integer) RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT (value #>> '{}')::integer FROM app_config WHERE key = p_key), p_default)
$$;

CREATE FUNCTION tn_config_bool(p_key text, p_default boolean) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT (value #>> '{}')::boolean FROM app_config WHERE key = p_key), p_default)
$$;

-- ─────────────────────────────────────────────────────────────── 5. Slots
-- Materialize the day's slots from app_config.schedule. Idempotent (unique slot_at).
CREATE FUNCTION tn_ensure_slots(p_local_date date) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  s     jsonb := tn_config('schedule');
  tz    text;
  st    time;
  en    time;
  step  integer;
  n     integer;
BEGIN
  IF s IS NULL THEN
    RAISE EXCEPTION 'app_config.schedule is missing (run npm run db:seed)' USING ERRCODE = 'no_data_found';
  END IF;
  tz   := s->>'timezone';
  st   := (s->>'window_start')::time;
  en   := (s->>'window_end')::time;
  step := (s->>'interval_minutes')::integer;
  IF step IS NULL OR step < 15 THEN RAISE EXCEPTION 'schedule.interval_minutes must be >= 15'; END IF;
  IF en < st THEN RAISE EXCEPTION 'schedule.window_end is before window_start'; END IF;

  INSERT INTO publish_slots (slot_at, local_date, local_time)
  SELECT g.ts AT TIME ZONE tz, p_local_date, to_char(g.ts, 'HH24:MI')
  FROM generate_series(p_local_date + st, p_local_date + en, make_interval(mins => step)) AS g(ts)
  ON CONFLICT (slot_at) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- Today and the next p_days-1 days, in the schedule's timezone.
CREATE FUNCTION tn_ensure_slots_ahead(p_days integer DEFAULT 2) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  tz    text := coalesce(tn_config('schedule')->>'timezone', 'Africa/Tunis');
  today date := (now() AT TIME ZONE tz)::date;
  total integer := 0;
  d     date;
BEGIN
  FOR d IN SELECT generate_series(today::timestamp, (today + (p_days - 1))::timestamp, interval '1 day')::date LOOP
    total := total + tn_ensure_slots(d);
  END LOOP;
  RETURN total;
END $$;

-- Atomically claim the next due slot for one worker. Returns 0 or 1 row.
--  * Serialized by a transaction-scoped advisory lock (claims are rare; correctness first),
--    plus FOR UPDATE SKIP LOCKED on the row.
--  * Due = slot_at within [now - max_lateness, now + lead]. Produce ahead, never publish late.
--  * Missed pending slots become skipped; expired leases are reclaimable until max attempts,
--    then the slot fails. A delayed or duplicated trigger can never yield two posts per slot
--    (posts.slot_id is also UNIQUE).
--  * Daily cap counted inside the lock, so concurrent claimers cannot overrun it.
CREATE FUNCTION tn_claim_due_slot(p_worker text) RETURNS SETOF publish_slots LANGUAGE plpgsql AS $$
DECLARE
  lead_min  integer := tn_config_int('slot_lead_minutes', 45);
  late_min  integer := tn_config_int('slot_max_lateness_minutes', 60);
  lease_min integer := tn_config_int('slot_lease_minutes', 20);
  max_att   integer := tn_config_int('slot_max_attempts', 3);
  cap       integer := tn_config_int('daily_post_cap', 8);
  used      integer;
  r         publish_slots;
BEGIN
  IF p_worker IS NULL OR p_worker = '' THEN
    RAISE EXCEPTION 'p_worker is required';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('tn_claim_due_slot'));

  IF NOT tn_config_bool('production_enabled', true) THEN
    RETURN;
  END IF;

  PERFORM tn_ensure_slots_ahead(2);

  UPDATE publish_slots
     SET status = 'skipped', skip_reason = 'missed: not produced within max lateness'
   WHERE status = 'pending' AND slot_at < now() - make_interval(mins => late_min);

  UPDATE publish_slots
     SET status = 'failed', last_error = coalesce(last_error, 'lease expired after max attempts')
   WHERE status = 'claimed' AND lease_expires_at < now() AND attempts >= max_att;

  SELECT * INTO r
    FROM publish_slots
   WHERE slot_at <= now() + make_interval(mins => lead_min)
     AND slot_at >= now() - make_interval(mins => late_min)
     AND (status = 'pending' OR (status = 'claimed' AND lease_expires_at < now() AND attempts < max_att))
   ORDER BY slot_at
   LIMIT 1
   FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Slots of the same local day already committed to a post that may be published.
  SELECT count(*) INTO used
    FROM publish_slots s
    LEFT JOIN posts p ON p.slot_id = s.id
   WHERE s.local_date = r.local_date
     AND s.id <> r.id
     AND (s.status = 'claimed'
          OR (s.status = 'produced' AND coalesce(p.status::text, '') NOT IN ('needs_review', 'skipped', 'failed')));
  IF used >= cap THEN
    UPDATE publish_slots SET status = 'skipped', skip_reason = format('daily cap of %s reached', cap) WHERE id = r.id;
    RETURN;
  END IF;

  UPDATE publish_slots
     SET status = 'claimed', claimed_by = p_worker, claimed_at = now(),
         lease_expires_at = now() + make_interval(mins => lease_min), attempts = attempts + 1
   WHERE id = r.id
   RETURNING * INTO r;
  RETURN NEXT r;
END $$;

-- Extend a lease (long-running generation). Fenced: only the current holder, only while valid.
CREATE FUNCTION tn_heartbeat_slot(p_slot_id uuid, p_worker text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE lease_min integer := tn_config_int('slot_lease_minutes', 20);
BEGIN
  UPDATE publish_slots SET lease_expires_at = now() + make_interval(mins => lease_min)
   WHERE id = p_slot_id AND status = 'claimed' AND claimed_by = p_worker AND lease_expires_at > now();
  RETURN FOUND;
END $$;

-- Finish a claimed slot. Fenced by worker + unexpired lease, so a worker that lost its lease
-- (and whose slot was re-claimed) cannot overwrite the new holder's outcome.
CREATE FUNCTION tn_complete_slot(p_slot_id uuid, p_worker text, p_outcome "SlotStatus", p_note text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  IF p_outcome NOT IN ('produced', 'skipped', 'failed') THEN
    RAISE EXCEPTION 'outcome must be produced, skipped or failed (got %)', p_outcome;
  END IF;
  UPDATE publish_slots
     SET status = p_outcome,
         skip_reason = CASE WHEN p_outcome = 'skipped' THEN p_note ELSE skip_reason END,
         last_error  = CASE WHEN p_outcome = 'failed'  THEN p_note ELSE last_error  END,
         lease_expires_at = NULL
   WHERE id = p_slot_id AND status = 'claimed' AND claimed_by = p_worker AND lease_expires_at > now();
  RETURN FOUND;
END $$;

-- ─────────────────────────────────────────────────────────────── 6. Destinations
-- Pick the next destination: active, outside its cooldown, preferring a different landscape
-- type than the last featured one, then least recently featured. If every destination is
-- cooling down, fall back to the least recently featured and report it.
CREATE FUNCTION tn_pick_location()
RETURNS TABLE (location_id uuid, slug text, cooldown_fallback boolean) LANGUAGE plpgsql AS $$
DECLARE
  cd        integer := tn_config_int('destination_cooldown_hours', 48);
  last_type text;
  r         locations;
  fallback  boolean := false;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('tn_pick_location'));

  SELECT l.landscape_type INTO last_type
    FROM locations l WHERE l.last_featured_at IS NOT NULL
   ORDER BY l.last_featured_at DESC LIMIT 1;

  SELECT * INTO r FROM locations l
   WHERE l.active
     AND (l.last_featured_at IS NULL
          OR l.last_featured_at < now() - make_interval(hours => coalesce(l.cooldown_hours, cd)))
   ORDER BY (l.landscape_type IS NOT DISTINCT FROM last_type), l.last_featured_at NULLS FIRST, random()
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    SELECT * INTO r FROM locations l
     WHERE l.active
     ORDER BY l.last_featured_at NULLS FIRST
     LIMIT 1
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'no active locations' USING ERRCODE = 'no_data_found';
    END IF;
    fallback := true;
  END IF;

  UPDATE locations SET last_featured_at = now() WHERE id = r.id;
  RETURN QUERY SELECT r.id, r.slug, fallback;
END $$;

-- ─────────────────────────────────────────────────────────────── 7. Near-duplicate images
CREATE FUNCTION tn_hamming_hex64(a text, b text) RETURNS integer LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT bit_count(('x' || a)::bit(64) # ('x' || b)::bit(64))::integer
$$;

-- Assets whose perceptual hash is within p_max_distance bits (0 = identical, <=6 ≈ same picture).
CREATE FUNCTION tn_similar_assets(p_phash text, p_max_distance integer DEFAULT 6, p_exclude uuid DEFAULT NULL)
RETURNS TABLE (asset_id uuid, distance integer, status "AssetStatus", created_at timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT a.id, tn_hamming_hex64(a.phash, p_phash) AS d, a.status, a.created_at
    FROM image_assets a
   WHERE a.phash IS NOT NULL
     AND (p_exclude IS NULL OR a.id <> p_exclude)
     AND a.status <> 'rejected'
     AND tn_hamming_hex64(a.phash, p_phash) <= p_max_distance
   ORDER BY d, a.created_at
$$;

-- ─────────────────────────────────────────────────────────────── 8. Publications
-- One publication row per enabled platform for a post. Idempotent.
CREATE FUNCTION tn_create_publications(p_post_id uuid) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  INSERT INTO platform_publications (post_id, platform)
  SELECT p_post_id, p::"Platform"
    FROM jsonb_array_elements_text(coalesce(tn_config('enabled_platforms'), '[]'::jsonb)) AS p
  ON CONFLICT (post_id, platform) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
