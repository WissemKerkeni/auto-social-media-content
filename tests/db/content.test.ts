import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { prepareTestDatabase, pool, reset, setConfig, insertSlot, insertLocation, pgErrorCode, TEST_DATABASE_URL } from './helpers.ts';
import { createPrisma } from '../../src/db.ts';

const db = pool();
const prisma = createPrisma(TEST_DATABASE_URL);
before(prepareTestDatabase);
beforeEach(() => reset(db));
after(async () => {
  await prisma.$disconnect();
  await db.end();
});

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const pick = async () => (await db.query('SELECT * FROM tn_pick_location()')).rows[0];

// ── Destinations ──

test('tn_pick_location respects cooldown and falls back (flagged) when everything is cooling', async () => {
  await insertLocation(db, 'recent', 'coast', 2);
  const old = await insertLocation(db, 'old', 'desert', 100);
  const first = await pick();
  assert.equal(first.location_id, old);
  assert.equal(first.cooldown_fallback, false);
  const second = await pick();
  assert.equal(second.cooldown_fallback, true, 'both are now within 48 h');
});

test('tn_pick_location prefers a different landscape type than the last post', async () => {
  await insertLocation(db, 'coast-a', 'coast', 200);
  await insertLocation(db, 'coast-b', 'coast', 300);
  await insertLocation(db, 'desert-a', 'desert', 100);
  const a = await pick(); // oldest-first would pick coast-b
  assert.equal(a.slug, 'coast-b');
  const b = await pick(); // last type = coast → desert-a preferred over coast-a
  assert.equal(b.slug, 'desert-a');
});

test('concurrent picks never hand out the same destination twice', async () => {
  for (let i = 0; i < 10; i++) await insertLocation(db, `loc-${i}`, i % 2 ? 'coast' : 'forest', null);
  const picks = await Promise.all(Array.from({ length: 10 }, () => pick()));
  assert.equal(new Set(picks.map((p) => p.location_id)).size, 10);
  assert.ok(picks.every((p) => p.cooldown_fallback === false));
});

// ── Posts: one per slot + state machine ──

async function makePost() {
  const locationId = await insertLocation(db, `l-${Math.random()}`);
  const slotId = await insertSlot(db, 5);
  const post = await prisma.post.create({ data: { slotId, locationId } });
  return { post, slotId, locationId };
}

async function makeApprovedAiAsset(locationId: string) {
  return prisma.imageAsset.create({
    data: { locationId, origin: 'ai_generated', aiGenerated: true, status: 'approved', sha256: sha(String(Math.random())), mimeType: 'image/jpeg', width: 1856, height: 2304 },
  });
}

test('one post per slot (posts.slot_id is unique)', async () => {
  const { slotId, locationId } = await makePost();
  const code = await pgErrorCode(db.query('INSERT INTO posts (slot_id, location_id) VALUES ($1, $2)', [slotId, locationId]));
  assert.equal(code, '23505');
});

test('posts must start as draft', async () => {
  const locationId = await insertLocation(db, 'x');
  const slotId = await insertSlot(db, 5);
  const code = await pgErrorCode(db.query("INSERT INTO posts (slot_id, location_id, status) VALUES ($1, $2, 'published')", [slotId, locationId]));
  assert.equal(code, '23514');
});

test('state machine: illegal transitions are rejected, legal ones are logged with actor and reason', async () => {
  const { post, locationId } = await makePost();
  await assert.rejects(db.query("SELECT tn_transition_post($1, 'published')", [post.id]), /illegal post status transition draft -> published/);

  // validated requires complete content (CHECK posts_complete_when_validated)
  assert.equal(await pgErrorCode(db.query("SELECT tn_transition_post($1, 'validated')", [post.id])), '23514');

  const asset = await makeApprovedAiAsset(locationId);
  await prisma.post.update({
    where: { id: post.id },
    data: {
      imageAssetId: asset.id, captionDerja: 'درجة', captionEn: 'English', altText: 'AI-generated image: hills',
      disclosureDerja: 'د', disclosureEn: 'd', hashtags: ['#Tunisia'], contentHash: sha('content'),
    },
  });
  await db.query("SELECT tn_transition_post($1, 'validated', 'gates passed', 'n8n:42')", [post.id]);
  // scheduled requires scheduled_for
  assert.equal(await pgErrorCode(db.query("SELECT tn_transition_post($1, 'scheduled')", [post.id])), '23514');
  await prisma.post.update({ where: { id: post.id }, data: { scheduledFor: new Date() } });
  await db.query("SELECT tn_transition_post($1, 'scheduled', 'slot time set', 'n8n:42')", [post.id]);

  const log = (await db.query('SELECT from_status, to_status, reason, actor FROM post_status_transitions WHERE post_id = $1 ORDER BY id', [post.id])).rows;
  assert.deepEqual(log.map((r) => `${r.from_status ?? '∅'}>${r.to_status}`), ['∅>draft', 'draft>validated', 'validated>scheduled']);
  assert.equal(log[1].actor, 'n8n:42');
  assert.equal(log[1].reason, 'gates passed');
  assert.ok(log[0].actor, 'insert is logged with the db user as actor');
});

test('published_at is stamped automatically', async () => {
  const { post, locationId } = await makePost();
  const asset = await makeApprovedAiAsset(locationId);
  await prisma.post.update({ where: { id: post.id }, data: {
    imageAssetId: asset.id, captionDerja: 'د', captionEn: 'e', altText: 'a', disclosureDerja: 'د', disclosureEn: 'd',
    hashtags: ['#t'], contentHash: sha('x'), scheduledFor: new Date(),
  } });
  for (const s of ['validated', 'scheduled', 'publishing', 'published']) {
    await db.query('SELECT tn_transition_post($1, $2)', [post.id, s]);
  }
  const p = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
  assert.ok(p.publishedAt instanceof Date);
});

test('content_hash is unique: the same post content cannot be stored twice', async () => {
  const a = await makePost();
  const b = await makePost();
  await prisma.post.update({ where: { id: a.post.id }, data: { contentHash: sha('same') } });
  assert.equal(await pgErrorCode(db.query('UPDATE posts SET content_hash = $1 WHERE id = $2', [sha('same'), b.post.id])), '23505');
});

// ── Publications ──

test('tn_create_publications: one row per enabled platform, idempotent, unique per (post, platform)', async () => {
  await setConfig(db, 'enabled_platforms', ['facebook', 'instagram']);
  const { post } = await makePost();
  assert.equal((await db.query('SELECT tn_create_publications($1) AS n', [post.id])).rows[0].n, 2);
  assert.equal((await db.query('SELECT tn_create_publications($1) AS n', [post.id])).rows[0].n, 0);
  assert.equal(await pgErrorCode(db.query("INSERT INTO platform_publications (post_id, platform) VALUES ($1, 'facebook')", [post.id])), '23505');
  assert.equal(
    await pgErrorCode(db.query("UPDATE platform_publications SET status = 'published' WHERE post_id = $1 AND platform = 'facebook'", [post.id])),
    '23514', 'published requires external_post_id + published_at',
  );
});

// ── Image rights, provenance, duplicates ──

test('a licensed photo cannot exist without source, license and attribution', async () => {
  await assert.rejects(
    prisma.imageAsset.create({ data: { origin: 'licensed_photo', sourceUrl: 'https://x/y.jpg' } }),
    /image_assets_rights_required/,
    'rejected through Prisma too, naming the constraint',
  );
  const raw = await pgErrorCode(db.query("INSERT INTO image_assets (origin, source_url) VALUES ('licensed_photo', 'https://x/y.jpg')"));
  assert.equal(raw, '23514');
});

test('a licensed photo cannot be approved before its rights are verified', async () => {
  const base = "INSERT INTO image_assets (origin, source_url, license_code, attribution_text, status, rights_verified, rights_verified_at) VALUES ('licensed_photo', 'https://x', 'CC-BY-4.0', 'Photo: A (CC BY 4.0)', 'approved', $1, $2)";
  assert.equal(await pgErrorCode(db.query(base, [false, null])), '23514');
  assert.equal(await pgErrorCode(db.query(base, [true, new Date()])), null);
});

test('provenance flags must match the origin (no AI image disguised as a photo)', async () => {
  assert.equal(await pgErrorCode(db.query("INSERT INTO image_assets (origin, ai_generated) VALUES ('ai_generated', false)")), '23514');
  const src = (await db.query("INSERT INTO image_assets (origin, source_url, license_code, attribution_text) VALUES ('licensed_photo', 'https://s', 'CC0', 'CC0') RETURNING id")).rows[0].id;
  assert.equal(await pgErrorCode(db.query(
    "INSERT INTO image_assets (origin, source_url, license_code, attribution_text, ai_edited) VALUES ('licensed_photo_enhanced', 'https://s', 'CC0', 'CC0', true)")), '23514', 'enhanced needs its parent');
  assert.equal(await pgErrorCode(db.query(
    "INSERT INTO image_assets (origin, source_url, license_code, attribution_text, ai_edited, parent_asset_id) VALUES ('licensed_photo_enhanced', 'https://s', 'CC0', 'CC0', true, $1)", [src])), null);
});

test('exact duplicates are rejected by sha256; near-duplicates are found by perceptual hash', async () => {
  const h = sha('img');
  await db.query("INSERT INTO image_assets (origin, ai_generated, sha256, phash) VALUES ('ai_generated', true, $1, 'f0f0f0f0f0f0f0f0')", [h]);
  assert.equal(await pgErrorCode(db.query("INSERT INTO image_assets (origin, ai_generated, sha256) VALUES ('ai_generated', true, $1)", [h])), '23505');
  assert.equal(await pgErrorCode(db.query("INSERT INTO image_assets (origin, ai_generated, phash) VALUES ('ai_generated', true, 'NOTHEX')")), '23514');

  const near = await db.query("SELECT * FROM tn_similar_assets('f0f0f0f0f0f0f0f1', 6)");
  assert.equal(near.rows.length, 1);
  assert.equal(near.rows[0].distance, 1);
  const far = await db.query("SELECT * FROM tn_similar_assets('0f0f0f0f0f0f0f0f', 6)");
  assert.equal(far.rows.length, 0, '64 bits apart is not a duplicate');
});

test('a fact can only be verified with a timestamp and must cite a source', async () => {
  const locationId = await insertLocation(db, 'f');
  assert.equal(await pgErrorCode(db.query("INSERT INTO location_facts (location_id, source_id, claim_en) VALUES ($1, gen_random_uuid(), 'x')", [locationId])), '23503', 'unknown source');
  const src = (await db.query("INSERT INTO research_sources (url, title, kind, accessed_at) VALUES ('https://example.org/a', 'A', 'official', now()) RETURNING id")).rows[0].id;
  assert.equal(await pgErrorCode(db.query("INSERT INTO location_facts (location_id, source_id, claim_en, status) VALUES ($1, $2, 'x', 'verified')", [locationId, src])), '23514');
  assert.equal(await pgErrorCode(db.query("INSERT INTO location_facts (location_id, source_id, claim_en, status, verified_at) VALUES ($1, $2, 'x', 'verified', now())", [locationId, src])), null);
});
