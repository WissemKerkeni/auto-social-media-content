import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  backoffMinutes, classify, graphUrl, instagramProblems, isPublicUrl, largestImageSource, postText, sameText, startPhase, stepFor, type MetaConfig,
} from '../../src/core/publish.ts';

const meta: MetaConfig = { graphBaseUrl: 'https://graph.facebook.com', graphVersion: 'v26.0', pageId: '111', igUserId: '222' };
const post = { captionDerja: 'غابة خضراء', captionEn: 'A green forest.', hashtags: ['#Tunisia', '#Nature'], disclosureDerja: 'صورة مولّدة', disclosureEn: 'AI-generated image.' };

test('post text is Derja first, English second, hashtags last', () => {
  assert.equal(postText(post), 'غابة خضراء\nصورة مولّدة\n\nA green forest.\nAI-generated image.\n\n#Tunisia #Nature');
  assert.throws(() => postText({ ...post, disclosureEn: null }), /incomplete/);
});

test('graph URLs carry the version and encode query parameters', () => {
  assert.equal(graphUrl(meta, '/111/photos'), 'https://graph.facebook.com/v26.0/111/photos');
  assert.equal(graphUrl(meta, 'x', { fields: 'id,permalink' }), 'https://graph.facebook.com/v26.0/x?fields=id%2Cpermalink');
});

test('classify: success, transient, auth, permanent and ambiguous outcomes', () => {
  assert.deepEqual(classify({ status: 200, body: { id: '1' } }), { ok: true, body: { id: '1' } });
  const t = classify({ status: 400, body: { error: { code: 4, message: 'Application request limit reached' } } });
  assert.equal(t.ok === false && t.kind, 'transient');
  const notReady = classify({ status: 400, body: { error: { code: 9007, error_subcode: 2207027, message: 'Media ID is not available' } } });
  assert.equal(notReady.ok === false && notReady.kind, 'transient');
  assert.equal(notReady.ok === false && notReady.code, 'graph_9007_2207027');
  const auth = classify({ status: 400, body: { error: { code: 190, type: 'OAuthException', message: 'Error validating access token' } } });
  assert.equal(auth.ok === false && auth.kind, 'auth');
  const perm = classify({ status: 400, body: { error: { code: 100, type: 'GraphMethodException', message: 'Invalid parameter' } } });
  assert.equal(perm.ok === false && perm.kind, 'permanent');
  assert.equal(classify({ transport_error: 'ETIMEDOUT' }).ok === false && (classify({ transport_error: 'x' }) as { kind: string }).kind, 'ambiguous');
  const five = classify({ status: 502, body: 'Bad Gateway' });
  assert.equal(five.ok === false && five.kind, 'ambiguous');
  const transientFlag = classify({ status: 500, body: { error: { code: 2, is_transient: true, message: 'Service temporarily unavailable' } } });
  assert.equal(transientFlag.ok === false && transientFlag.kind, 'transient');
  const local = classify({ local_error: 'image download failed' });
  assert.equal(local.ok === false && local.kind, 'transient', 'nothing reached Meta');
  const errorIn200 = classify({ status: 200, body: { error: { code: 100, message: 'bad' } } });
  assert.equal(errorIn200.ok, false);
});

test('Instagram limits: 2200 characters and 30 hashtags', () => {
  assert.deepEqual(instagramProblems('ok #a #b'), []);
  assert.match(instagramProblems('x'.repeat(2201))[0]!, /2201 characters/);
  assert.match(instagramProblems(Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' '))[0]!, /31 hashtags/);
  assert.deepEqual(instagramProblems('ع'.repeat(2200)), [], 'counted in characters, not bytes');
});

test('reconciliation text match ignores whitespace differences only', () => {
  assert.ok(sameText('a  b\nc ', 'a b c'));
  assert.ok(!sameText('a b c', 'a b d'));
  assert.ok(!sameText(null, 'a'));
});

test('only https non-local URLs count as public for Meta', () => {
  assert.ok(isPublicUrl('https://media.example.com/tn/images/a.jpg'));
  assert.ok(!isPublicUrl('http://media.example.com/a.jpg'));
  assert.ok(!isPublicUrl('https://localhost:8333/a.jpg'));
  assert.ok(!isPublicUrl('https://192.168.1.4/a.jpg'));
  assert.ok(!isPublicUrl('http://localhost:8333/tn-nature-media/a.jpg'));
  assert.ok(!isPublicUrl(null));
});

test('largest rendition of a staged Page photo', () => {
  assert.equal(largestImageSource({ images: [{ source: 's', width: 320 }, { source: 'L', width: 1856 }, { width: 2000 }] }), 'L');
  assert.equal(largestImageSource({}), null);
});

test('start phase: fresh, resumed and reconciling attempts', () => {
  const none = { reconciling: false, state: {}, containerId: null, publicImageUrl: null };
  assert.equal(startPhase('facebook', none), 'fb_publish');
  assert.equal(startPhase('facebook', { ...none, reconciling: true }), 'fb_reconcile');
  assert.equal(startPhase('instagram', none), 'ig_stage');
  assert.equal(startPhase('instagram', { ...none, publicImageUrl: 'https://cdn/x.jpg' }), 'ig_container');
  assert.equal(startPhase('instagram', { ...none, containerId: 'c1' }), 'ig_status');
  assert.equal(startPhase('instagram', { ...none, reconciling: true, containerId: 'c1' }), 'ig_reconcile_status');
  assert.equal(startPhase('instagram', { ...none, reconciling: true }), 'ig_reconcile_media');
});

test('steps: uploads, container with caption + alt text, publish with creation_id', () => {
  const ctx = { text: 'T', altText: 'AI-generated image: hills', state: { image_url: 'https://cdn/x.jpg', staged_photo_id: 'p9', fb_post_id: '111_5', media_id: 'm1' }, containerId: 'c1', since: 100 };
  assert.deepEqual(stepFor('fb_publish', meta, ctx), { kind: 'upload_publish', phase: 'fb_publish', url: 'https://graph.facebook.com/v26.0/111/photos', message: 'T' });
  assert.equal(stepFor('ig_stage', meta, ctx).kind, 'upload_stage');
  assert.deepEqual(stepFor('ig_container', meta, ctx), {
    kind: 'graph_post', phase: 'ig_container', url: 'https://graph.facebook.com/v26.0/222/media',
    body: { image_url: 'https://cdn/x.jpg', caption: 'T', alt_text: 'AI-generated image: hills' },
  });
  assert.deepEqual(stepFor('ig_publish', meta, ctx), { kind: 'graph_post', phase: 'ig_publish', url: 'https://graph.facebook.com/v26.0/222/media_publish', body: { creation_id: 'c1' } });
  assert.match((stepFor('fb_reconcile', meta, ctx) as { url: string }).url, /111\/published_posts\?fields=.*since=100/);
  assert.match((stepFor('ig_stage_url', meta, ctx) as { url: string }).url, /p9\?fields=images$/);
});

test('backoff doubles and caps at 30 minutes', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(backoffMinutes), [2, 4, 8, 16, 30, 30]);
});
