// Verifies the SigV4 signer against AWS's published S3 example vectors
// ("Authenticating Requests: Using the Authorization Header", Signature Version 4 examples).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signRequest } from '../scripts/lib/s3.mjs';

const creds = {
  region: 'us-east-1',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  now: new Date('2013-05-24T00:00:00Z'),
};
const signatureOf = (headers) => headers.authorization.split('Signature=')[1];

test('GET Bucket Lifecycle example', () => {
  const h = signRequest({ ...creds, method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/?lifecycle' });
  assert.equal(signatureOf(h), 'fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543');
  assert.match(h.authorization, /Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request/);
  assert.match(h.authorization, /SignedHeaders=host;x-amz-content-sha256;x-amz-date/);
});

test('GET Bucket (List Objects) example with sorted query parameters', () => {
  const h = signRequest({ ...creds, method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J' });
  assert.equal(signatureOf(h), '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
});
