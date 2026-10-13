// Integration-test harness: a dedicated database (<APP_DB>_test) migrated with the real
// migrations, truncated before each test. Never touches the development database.
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import pg from 'pg';

const devUrl = process.env.DATABASE_URL;
if (!devUrl) throw new Error('DATABASE_URL not set; run npm run setup');

const url = new URL(devUrl);
const devDb = url.pathname.slice(1);
export const TEST_DB = `${devDb}_test`;
url.pathname = `/${TEST_DB}`;
export const TEST_DATABASE_URL = url.toString();

const TABLES = [
  'api_usage', 'publish_attempts', 'platform_publications', 'post_status_transitions', 'generation_errors',
  'posts', 'publish_slots', 'image_assets', 'location_facts', 'research_sources', 'locations', 'app_config',
];

let prepared = false;

/** Create (once) and migrate the test database. */
export async function prepareTestDatabase(): Promise<void> {
  if (prepared) return;
  const admin = new pg.Client({ connectionString: devUrl });
  await admin.connect();
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB]);
    if (!exists.rowCount) {
      await admin.query(`CREATE DATABASE "${TEST_DB.replace(/"/g, '')}"`);
      await admin.query(`ALTER DATABASE "${TEST_DB.replace(/"/g, '')}" SET timezone TO 'UTC'`);
    }
  } finally {
    await admin.end();
  }
  const res = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (res.status !== 0) throw new Error(`prisma migrate deploy failed:\n${res.stdout}\n${res.stderr}`);
  prepared = true;
}

export function pool(max = 30): pg.Pool {
  return new pg.Pool({ connectionString: TEST_DATABASE_URL, max });
}

export const DEFAULT_CONFIG: Record<string, unknown> = {
  daily_post_cap: 8,
  publishing_enabled: false,
  production_enabled: true,
  enabled_platforms: ['facebook', 'instagram'],
  destination_cooldown_hours: 48,
  slot_lead_minutes: 45,
  slot_max_lateness_minutes: 60,
  slot_lease_minutes: 20,
  slot_max_attempts: 3,
};

/**
 * A schedule with one slot per day placed ~6 h away from "now" in Tunis, so the
 * automatically materialized slots never fall inside a test's claim window. Tests then
 * insert their own slots at exact offsets from now().
 */
function isolatedSchedule(): Record<string, unknown> {
  const tunisNow = new Date(Date.now() + 60 * 60 * 1000); // Africa/Tunis = UTC+1, no DST
  const h = (tunisNow.getUTCHours() + 6) % 24;
  const hhmm = `${String(h).padStart(2, '0')}:00`;
  return { timezone: 'Africa/Tunis', window_start: hhmm, window_end: hhmm, interval_minutes: 120 };
}

/** Empty every table and install default config. */
export async function reset(db: pg.Pool, overrides: Record<string, unknown> = {}): Promise<void> {
  await db.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
  const config = { schedule: isolatedSchedule(), ...DEFAULT_CONFIG, ...overrides };
  for (const [key, value] of Object.entries(config)) {
    await db.query('INSERT INTO app_config (key, value) VALUES ($1, $2::jsonb)', [key, JSON.stringify(value)]);
  }
}

export async function setConfig(db: pg.Pool, key: string, value: unknown): Promise<void> {
  await db.query(
    'INSERT INTO app_config (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, JSON.stringify(value)],
  );
}

/** Insert a pending slot at now() + offsetMinutes (local date/time are only labels here). */
export async function insertSlot(db: pg.Pool, offsetMinutes: number, localDate = '2030-01-01'): Promise<string> {
  const r = await db.query(
    `INSERT INTO publish_slots (slot_at, local_date, local_time)
     VALUES (now() + make_interval(mins => $1), $2::date, to_char(now() + make_interval(mins => $1), 'HH24:MI'))
     RETURNING id`,
    [offsetMinutes, localDate],
  );
  return r.rows[0].id;
}

export async function insertLocation(db: pg.Pool, slug: string, landscapeType = 'coast', lastFeaturedHoursAgo: number | null = null): Promise<string> {
  const r = await db.query(
    `INSERT INTO locations (slug, name_en, name_ar, governorate, region, landscape_type, last_featured_at)
     VALUES ($1, $1, $1, 'Test', 'test', $2, CASE WHEN $3::int IS NULL THEN NULL ELSE now() - make_interval(hours => $3::int) END)
     RETURNING id`,
    [slug, landscapeType, lastFeaturedHoursAgo],
  );
  return r.rows[0].id;
}

/** Postgres error code of a rejected promise (e.g. 23505 unique, 23514 check). */
export async function pgErrorCode(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? 'unknown';
  }
}
