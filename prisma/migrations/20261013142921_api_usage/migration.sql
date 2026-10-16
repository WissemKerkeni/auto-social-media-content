-- CreateTable
CREATE TABLE "api_usage" (
    "day" DATE NOT NULL,
    "provider" TEXT NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_usage_pkey" PRIMARY KEY ("day","provider")
);

CREATE TRIGGER tn_touch_updated_at BEFORE UPDATE ON api_usage FOR EACH ROW EXECUTE FUNCTION tn_touch_updated_at();

-- Reserve one external API call against a per-day cap (config key, e.g. 'cap_gemini_image_per_day').
-- Atomic: concurrent callers can never exceed the cap. Returns true if the call may proceed.
CREATE FUNCTION tn_reserve_api_call(p_provider text, p_cap_key text, p_default_cap integer)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  tz  text := coalesce(tn_config('schedule')->>'timezone', 'Africa/Tunis');
  d   date := (now() AT TIME ZONE tz)::date;
  cap integer := tn_config_int(p_cap_key, p_default_cap);
  n   integer;
BEGIN
  INSERT INTO api_usage (day, provider, calls) VALUES (d, p_provider, 0)
  ON CONFLICT (day, provider) DO NOTHING;
  UPDATE api_usage SET calls = calls + 1
   WHERE day = d AND provider = p_provider AND calls < cap
  RETURNING calls INTO n;
  RETURN n IS NOT NULL;
END $$;
