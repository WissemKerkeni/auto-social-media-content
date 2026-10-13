// Minimal AWS Signature V4 signer for health checks against S3-compatible stores
// (SeaweedFS locally, Cloudflare R2 in production). Not a general S3 client.
import { createHash, createHmac } from 'node:crypto';

const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

const encodePath = (path) =>
  path.split('/').map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');

/**
 * Build SigV4 headers for a request with an empty body.
 * @returns {Record<string,string>} headers to send (includes Authorization)
 */
export function signRequest({ method, url, region, accessKeyId, secretAccessKey, now = new Date() }) {
  const u = new URL(url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex('');
  const headers = { host: u.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map((k) => `${k}:${headers[k]}\n`).join('');
  const canonicalQuery = [...u.searchParams.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const canonicalRequest = [method, encodePath(u.pathname), canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return {
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** HEAD the bucket with signed credentials. Resolves to the HTTP status code. */
export async function headBucket({ endpoint, bucket, region, accessKeyId, secretAccessKey }) {
  const url = `${endpoint.replace(/\/$/, '')}/${bucket}`;
  const headers = signRequest({ method: 'HEAD', url, region, accessKeyId, secretAccessKey });
  const res = await fetch(url, { method: 'HEAD', headers, signal: AbortSignal.timeout(5000) });
  return res.status;
}
