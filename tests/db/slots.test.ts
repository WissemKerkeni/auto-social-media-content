import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { prepareTestDatabase, pool, reset, setConfig, insertSlot } from './helpers.ts';

const db = pool();
before(prepareTestDatabase);
beforeEach(() => reset(db));
after(() => db.end());

const claim = async (worker: string) => (await db.query('SELECT * FROM tn_claim_due_slot($1)', [worker])).rows;
const slot = async (id: string) => (await db.query('SELECT * FROM publish_slots WHERE id = $1', [id])).rows[0];

test('tn_ensure_slots materializes 07:00–21:00 every 120 min in Africa/Tunis, idempotently', async () => {
  await setConfig(db, 'schedule', { timezone: 'Africa/Tunis', window_start: '07:00', window_end: '21:00', interval_minutes: 120 });
  const first = await db.query("SELECT tn_ensure_slots('2026-11-02') AS n");
  assert.equal(first.rows[0].n, 8);
  const again = await db.query("SELECT tn_ensure_slots('2026-11-02') AS n");
  assert.equal(again.rows[0].n, 0, 'second call creates nothing');
  const rows = await db.query(
    "SELECT local_time, to_char(slot_at AT TIME ZONE 'UTC', 'HH24:MI') AS utc FROM publish_slots WHERE local_date = '2026-11-02' ORDER BY slot_at",
  );
  assert.deepEqual(rows.rows.map((r) => r.local_time), ['07:00', '09:00', '11:00', '13:00', '15:00', '17:00', '19:00', '21:00']);
  assert.deepEqual(rows.rows.map((r) => r.utc), ['06:00', '08:00', '10:00', '12:00', '14:00', '16:00', '18:00', '20:00']);
});

test('25 concurrent workers racing for one due slot: exactly one wins', async () => {
  const id = await insertSlot(db, 10);
  const results = await Promise.all(Array.from({ length: 25 }, (_, i) => claim(`worker-${i}`)));
  const winners = results.flat();
  assert.equal(winners.length, 1);
  assert.equal(winners[0].id, id);
  const s = await slot(id);
  assert.equal(s.status, 'claimed');
  assert.equal(s.attempts, 1);
  assert.equal(s.claimed_by, winners[0].claimed_by);
});

test('lead window: produce ahead (≤ 45 min) but not too early', async () => {
  const far = await insertSlot(db, 120);
  assert.equal((await claim('w')).length, 0, 'slot 2 h ahead is not due');
  const near = await insertSlot(db, 30);
  const got = await claim('w');
  assert.equal(got[0]?.id, near);
  assert.equal((await slot(far)).status, 'pending');
});

test('a missed slot is skipped, never produced late', async () => {
  const missed = await insertSlot(db, -120);
  assert.equal((await claim('w')).length, 0);
  const s = await slot(missed);
  assert.equal(s.status, 'skipped');
  assert.match(s.skip_reason, /missed/);
});

test('slightly late slot (within max lateness) is still claimable', async () => {
  const late = await insertSlot(db, -20);
  assert.equal((await claim('w'))[0]?.id, late);
});

test('expired lease is re-claimable; the old holder is fenced out', async () => {
  const id = await insertSlot(db, 5);
  await claim('w1');
  await db.query("UPDATE publish_slots SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [id]);

  const second = await claim('w2');
  assert.equal(second[0]?.claimed_by, 'w2');
  assert.equal(second[0]?.attempts, 2);

  const stale = await db.query("SELECT tn_complete_slot($1, 'w1', 'produced') AS ok", [id]);
  assert.equal(stale.rows[0].ok, false, 'w1 lost its lease and cannot complete');
  const hb = await db.query("SELECT tn_heartbeat_slot($1, 'w1') AS ok", [id]);
  assert.equal(hb.rows[0].ok, false, 'w1 cannot extend a lease it no longer holds');

  const done = await db.query("SELECT tn_complete_slot($1, 'w2', 'produced') AS ok", [id]);
  assert.equal(done.rows[0].ok, true);
  assert.equal((await slot(id)).status, 'produced');
  assert.equal((await claim('w3')).length, 0, 'a produced slot is never claimed again');
});

test('a slot whose lease expired after max attempts is marked failed', async () => {
  const id = await insertSlot(db, 5);
  await db.query(
    "UPDATE publish_slots SET status = 'claimed', claimed_by = 'x', claimed_at = now(), attempts = 3, lease_expires_at = now() - interval '1 second' WHERE id = $1",
    [id],
  );
  assert.equal((await claim('w')).length, 0);
  assert.equal((await slot(id)).status, 'failed');
});

test('daily cap holds even under concurrent claims', async () => {
  await setConfig(db, 'daily_post_cap', 2);
  const ids = [await insertSlot(db, 1), await insertSlot(db, 2), await insertSlot(db, 3), await insertSlot(db, 4)];
  const results = (await Promise.all(Array.from({ length: 10 }, (_, i) => claim(`w${i}`)))).flat();
  assert.equal(results.length, 2, 'only two slots may be committed for the day');
  const statuses = (await db.query('SELECT status, skip_reason FROM publish_slots WHERE id = ANY($1) ORDER BY slot_at', [ids])).rows;
  assert.deepEqual(statuses.map((s) => s.status), ['claimed', 'claimed', 'skipped', 'skipped']);
  assert.match(statuses[2].skip_reason, /daily cap of 2/);
});

test('production_enabled=false stops all claiming', async () => {
  await setConfig(db, 'production_enabled', false);
  await insertSlot(db, 5);
  assert.equal((await claim('w')).length, 0);
});

test('tn_complete_slot only accepts terminal outcomes', async () => {
  const id = await insertSlot(db, 5);
  await claim('w');
  await assert.rejects(db.query("SELECT tn_complete_slot($1, 'w', 'pending')", [id]), /outcome must be/);
});
