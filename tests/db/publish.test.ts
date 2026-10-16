// TN-02 publishing state machine against a real database. Graph responses are simulated:
// each test plays n8n, executing the returned step by "answering" it.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { prepareTestDatabase, pool, reset, setConfig, insertSlot, insertLocation, TEST_DATABASE_URL } from './helpers.ts';
import { createPrisma } from '../../src/db.ts';
import { PublishService, type ApplyResult, type ClaimResult } from '../../src/core/publisher.ts';
import type { CoreConfig } from '../../src/core/config.ts';
import type { StepResult } from '../../src/core/publish.ts';

const db = pool();
const prisma = createPrisma(TEST_DATABASE_URL);
before(prepareTestDatabase);
beforeEach(() => reset(db, { publishing_enabled: true }));
after(async () => {
  await prisma.$disconnect();
  await db.end();
});

const cfg = {
  s3: { publicBaseUrl: 'http://localhost:8333/tn-nature-media' },
  meta: { graphBaseUrl: 'https://graph.test', graphVersion: 'v26.0', pageId: '111', igUserId: '222' },
} as unknown as CoreConfig;
const svc = new PublishService(prisma, cfg);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** A scheduled post due `minutesAgo` minutes ago, with one publication per enabled platform. */
async function scheduledPost(minutesAgo = 1): Promise<string> {
  const locationId = await insertLocation(db, `l-${Math.random()}`);
  const slotId = await insertSlot(db, -minutesAgo);
  const asset = await prisma.imageAsset.create({
    data: { locationId, origin: 'ai_generated', aiGenerated: true, status: 'approved', sha256: sha(String(Math.random())), mimeType: 'image/jpeg', width: 1856, height: 2304, storageKey: `images/${Math.random()}.jpg` },
  });
  const post = await prisma.post.create({ data: { slotId, locationId } });
  await prisma.post.update({
    where: { id: post.id },
    data: {
      imageAssetId: asset.id, captionDerja: `غابة ${post.id}`, captionEn: 'Green hills.', hashtags: ['#Tunisia'], altText: 'AI-generated image: hills',
      disclosureDerja: 'صورة مولّدة', disclosureEn: 'AI-generated image.', contentHash: sha(post.id), scheduledFor: new Date(Date.now() - minutesAgo * 60_000),
    },
  });
  await db.query("SELECT tn_transition_post($1, 'validated')", [post.id]);
  await db.query('SELECT tn_create_publications($1)', [post.id]);
  await db.query("SELECT tn_transition_post($1, 'scheduled')", [post.id]);
  return post.id;
}

const ok = (body: unknown): StepResult => ({ status: 200, body });
const err = (status: number, code: number, extra: Record<string, unknown> = {}): StepResult => ({ status, body: { error: { code, message: `error ${code}`, ...extra } } });
const pubOf = (postId: string, platform: 'facebook' | 'instagram') => prisma.platformPublication.findUniqueOrThrow({ where: { postId_platform: { postId, platform } } });
const postStatus = async (id: string) => (await prisma.post.findUniqueOrThrow({ where: { id } })).status;

function answer(r: ClaimResult | ApplyResult, result: StepResult): Promise<ApplyResult> {
  assert.ok(r.step, `expected a step, got ${JSON.stringify(r)}`);
  return svc.apply({ publication_id: r.publication_id!, attempt_no: r.attempt_no!, phase: r.step.phase, result, worker: 'test' });
}

/** Claim until the given platform comes up (claims are ordered by platform name). */
async function claimFor(platform: 'facebook' | 'instagram'): Promise<ClaimResult> {
  await setConfig(db, 'enabled_platforms', [platform]);
  const c = await svc.claim({ worker: 'test' });
  await setConfig(db, 'enabled_platforms', ['facebook', 'instagram']);
  return c;
}

test('Facebook: photo upload publishes, permalink is recorded, post is published once both platforms finish', async () => {
  const postId = await scheduledPost();
  const c = await claimFor('facebook');
  assert.equal(c.step?.kind, 'upload_publish');
  assert.match(c.step && 'message' in c.step ? c.step.message : '', /^غابة .*\nصورة مولّدة\n\nGreen hills\.\nAI-generated image\.\n\n#Tunisia$/);
  assert.equal(await postStatus(postId), 'publishing');

  const s1 = await answer(c, ok({ id: 'photo1', post_id: '111_9' }));
  assert.equal(s1.step?.phase, 'fb_permalink');
  let fb = await pubOf(postId, 'facebook');
  assert.equal(fb.status, 'published', 'recorded as published before any follow-up call');
  assert.equal(fb.externalPostId, '111_9');
  const s2 = await answer(s1, ok({ id: '111_9', permalink_url: 'https://www.facebook.com/x/posts/9' }));
  assert.deepEqual([s2.done, s2.outcome], [true, 'published']);
  fb = await pubOf(postId, 'facebook');
  assert.equal(fb.permalink, 'https://www.facebook.com/x/posts/9');
  assert.equal(await postStatus(postId), 'publishing', 'instagram still pending');

  // Instagram fails permanently → post is still published (one platform succeeded).
  const ig = await claimFor('instagram');
  const done = await answer(ig, err(400, 100));
  assert.equal(done.outcome, 'failed');
  assert.equal(await postStatus(postId), 'published');
});

test('Instagram: stage on the Page, container, status, publish, permalink', async () => {
  const postId = await scheduledPost();
  const c = await claimFor('instagram');
  assert.equal(c.step?.kind, 'upload_stage', 'local media URL is not public, so the image is staged on the Page');
  const s1 = await answer(c, ok({ id: 'staged1' }));
  assert.equal(s1.step?.phase, 'ig_stage_url');
  const s2 = await answer(s1, ok({ images: [{ source: 'https://scontent.fbcdn.net/small.jpg', width: 320 }, { source: 'https://scontent.fbcdn.net/big.jpg', width: 1856 }] }));
  assert.equal(s2.step?.phase, 'ig_container');
  assert.equal(s2.step && 'body' in s2.step && s2.step.body.image_url, 'https://scontent.fbcdn.net/big.jpg');
  assert.equal(s2.step && 'body' in s2.step && s2.step.body.alt_text, 'AI-generated image: hills');
  const s3 = await answer(s2, ok({ id: 'container1' }));
  assert.equal((await pubOf(postId, 'instagram')).externalContainerId, 'container1');
  const s4 = await answer(s3, ok({ status_code: 'FINISHED', id: 'container1' }));
  assert.equal(s4.step?.phase, 'ig_publish');
  assert.deepEqual(s4.step && 'body' in s4.step && s4.step.body, { creation_id: 'container1' });
  const s5 = await answer(s4, ok({ id: 'media1' }));
  assert.equal((await pubOf(postId, 'instagram')).status, 'published');
  const s6 = await answer(s5, ok({ id: 'media1', permalink: 'https://www.instagram.com/p/abc/' }));
  assert.equal(s6.outcome, 'published');
  const ig = await pubOf(postId, 'instagram');
  assert.deepEqual([ig.externalPostId, ig.permalink], ['media1', 'https://www.instagram.com/p/abc/']);
  const attempt = await prisma.publishAttempt.findFirstOrThrow({ where: { publicationId: ig.id } });
  assert.equal(attempt.outcome, 'success');
  assert.equal((attempt.response as { steps: unknown[] }).steps.length, 6);
});

test('kill switch: nothing is claimed while publishing is disabled', async () => {
  await scheduledPost();
  await setConfig(db, 'publishing_enabled', false);
  assert.deepEqual(await svc.claim({ worker: 'test' }), { action: 'none', reason: 'publishing_disabled' });
});

test('kill switch flipped mid-flow: the publish call is never handed out', async () => {
  const postId = await scheduledPost();
  const c = await claimFor('instagram');
  const s1 = await answer(c, ok({ id: 'staged1' }));
  const s2 = await answer(s1, ok({ images: [{ source: 'https://scontent.fbcdn.net/big.jpg', width: 1856 }] }));
  const s3 = await answer(s2, ok({ id: 'container1' }));
  await setConfig(db, 'publishing_enabled', false);
  const s4 = await answer(s3, ok({ status_code: 'FINISHED' }));
  assert.deepEqual([s4.done, s4.outcome, s4.step], [true, 'pending', undefined]);
  const ig = await pubOf(postId, 'instagram');
  assert.equal(ig.lastErrorCode, 'kill_switch');
  assert.equal(ig.externalContainerId, 'container1', 'container kept; the next run resumes at the status check');
});

test('timeout on the Facebook publish call → reconciling → found on the Page → published (no second post)', async () => {
  const postId = await scheduledPost();
  const c = await claimFor('facebook');
  const message = c.step && 'message' in c.step ? c.step.message : '';
  const r1 = await answer(c, { transport_error: 'timeout of 120000ms exceeded' });
  assert.equal(r1.outcome, 'reconciling');
  await db.query("UPDATE platform_publications SET next_attempt_at = now() WHERE post_id = $1 AND platform = 'facebook'", [postId]);

  const rc = await claimFor('facebook');
  assert.equal(rc.step?.phase, 'fb_reconcile', 'the platform is queried before anything is retried');
  const r2 = await answer(rc, ok({ data: [{ id: '111_1', message: 'someone else' }, { id: '111_2', message: message.replace(/\n/g, '\n '), permalink_url: 'https://fb/2' }] }));
  assert.equal(r2.outcome, 'published');
  const fb = await pubOf(postId, 'facebook');
  assert.deepEqual([fb.externalPostId, fb.permalink, fb.attemptCount], ['111_2', 'https://fb/2', 2]);
  const outcomes = (await prisma.publishAttempt.findMany({ where: { publicationId: fb.id }, orderBy: { attemptNo: 'asc' } })).map((a) => a.outcome);
  assert.deepEqual(outcomes, ['timeout_unknown', 'reconciled_published']);
});

test('reconciliation that finds nothing re-queues a fresh publish', async () => {
  const postId = await scheduledPost();
  await answer(await claimFor('facebook'), { status: 503, body: 'Service Unavailable' });
  await db.query('UPDATE platform_publications SET next_attempt_at = now() WHERE post_id = $1', [postId]);
  const r = await answer(await claimFor('facebook'), ok({ data: [] }));
  assert.equal(r.outcome, 'pending');
  await db.query('UPDATE platform_publications SET next_attempt_at = now() WHERE post_id = $1', [postId]);
  const again = await claimFor('facebook');
  assert.equal(again.step?.phase, 'fb_publish');
});

test('transient errors back off; auth errors fail without retry', async () => {
  const postId = await scheduledPost();
  const r = await answer(await claimFor('facebook'), err(400, 4));
  assert.equal(r.outcome, 'pending');
  const fb = await pubOf(postId, 'facebook');
  assert.ok(fb.nextAttemptAt! > new Date(Date.now() + 60_000), 'backoff of at least a minute');
  assert.deepEqual(await claimFor('facebook'), { action: 'none', reason: 'nothing_due' });

  await db.query('UPDATE platform_publications SET next_attempt_at = now() WHERE post_id = $1', [postId]);
  const a = await answer(await claimFor('facebook'), err(400, 190, { type: 'OAuthException' }));
  assert.equal(a.outcome, 'failed');
  assert.equal((await pubOf(postId, 'facebook')).lastErrorCode, 'auth_graph_190');
});

test('stale or duplicate step reports are rejected and change nothing', async () => {
  const postId = await scheduledPost();
  const c = await claimFor('facebook');
  await answer(c, ok({ id: 'photo1', post_id: '111_9' }));
  await assert.rejects(answer(c, ok({ id: 'photo2', post_id: '111_10' })), /not current/);
  assert.equal((await pubOf(postId, 'facebook')).externalPostId, '111_9');
});

test('never late: a publication past the lateness window is skipped and the post closed', async () => {
  const postId = await scheduledPost(90);
  assert.equal((await svc.claim({ worker: 'test' })).action, 'none');
  const pubs = await prisma.platformPublication.findMany({ where: { postId } });
  assert.deepEqual(pubs.map((p) => p.status).sort(), ['skipped', 'skipped']);
  assert.equal(await postStatus(postId), 'skipped');
});

test('a lease that expires during the publish call is reconciled, not retried', async () => {
  const postId = await scheduledPost();
  await claimFor('facebook'); // step handed out, n8n never reports back
  await db.query("UPDATE platform_publications SET next_attempt_at = now() - interval '1 second' WHERE post_id = $1 AND platform = 'facebook'", [postId]);
  const c = await claimFor('facebook');
  assert.equal(c.step?.phase, 'fb_reconcile');
});

test('daily cap per platform', async () => {
  await setConfig(db, 'daily_post_cap', 1);
  const first = await scheduledPost();
  const c = await claimFor('facebook');
  await answer(c, ok({ id: 'p', post_id: '111_1' }));
  assert.equal((await pubOf(first, 'facebook')).status, 'published');
  await scheduledPost();
  assert.deepEqual(await claimFor('facebook'), { action: 'none', reason: 'nothing_due' });
});

test('concurrent claimers never get the same publication', async () => {
  await scheduledPost();
  const results = await Promise.all(Array.from({ length: 8 }, () => svc.claim({ worker: `w${Math.random()}` })));
  const ids = results.filter((r) => r.action === 'step').map((r) => r.publication_id);
  assert.equal(ids.length, 2, 'exactly the two publications are claimed');
  assert.equal(new Set(ids).size, 2);
});
