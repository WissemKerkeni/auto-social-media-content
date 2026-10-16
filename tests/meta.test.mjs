import { test } from 'node:test';
import assert from 'node:assert/strict';
import { missingScopes, pickPage, setEnvValues, REQUIRED_SCOPES } from '../scripts/lib/meta.mjs';

test('missing scopes are reported; a full grant passes', () => {
  assert.deepEqual(missingScopes(REQUIRED_SCOPES), []);
  assert.deepEqual(missingScopes(['pages_show_list', 'pages_manage_posts']), ['pages_read_engagement', 'instagram_basic', 'instagram_content_publish']);
  assert.deepEqual(missingScopes(undefined), REQUIRED_SCOPES);
});

test('pickPage: explicit id, single page, preferred name, ambiguity', () => {
  const a = { id: '1', name: 'Green Tunisia' };
  const b = { id: '2', name: 'Other' };
  assert.equal(pickPage([a, b], { pageId: '2' }).page, b);
  assert.match(pickPage([a], { pageId: '9' }).error, /not among/);
  assert.equal(pickPage([b]).page, b);
  assert.equal(pickPage([a, b], { preferName: 'green tunisia' }).page, a);
  assert.match(pickPage([a, b]).error, /several Pages/);
  assert.match(pickPage([]).error, /no Pages/);
});

test('setEnvValues replaces in place, appends new keys, keeps comments and line endings', () => {
  const text = '# Meta\r\nMETA_PAGE_ID=\r\nOTHER=x\r\n';
  const out = setEnvValues(text, { META_PAGE_ID: '123', META_IG_USER_ID: '456' });
  assert.equal(out, '# Meta\r\nMETA_PAGE_ID=123\r\nOTHER=x\r\nMETA_IG_USER_ID=456\r\n');
  assert.equal(setEnvValues('A=1\nexport B=2', { B: '3' }), 'A=1\nB=3');
  assert.throws(() => setEnvValues('A=1', { A: 'x\ny' }), /single line/);
});
