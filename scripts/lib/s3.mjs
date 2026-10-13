// Minimal AWS Signature V4 signer for health checks against S3-compatible stores
// (SeaweedFS locally, Cloudflare R2 in production). Not a general S3 client.
import { createHash, createHmac } from 'node:crypto';

const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

const encodePath = (path) =>
  path.split('/').map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');

/**
 * Build SigV4 headers. The body (Buffer/string, default empty) is hashed into the signature,
 * so the store can verify the payload was not altered in transit.
 * `extraHeaders` (e.g. content-type) are signed too.
 * @returns {Record<string,string>} headers to send (includes Authorization)
 */
export function signRequest({ method, url, region, accessKeyId, secretAccessKey, body = '', extraHeaders = {}, now = new Date() }) {
  const u = new URL(url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body);
  const lowered = Object.fromEntries(Object.entries(extraHeaders).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const headers = { ...lowered, host: u.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
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
    ...lowered,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

const objectUrl = ({ endpoint, bucket }, key) =>
  `${endpoint.replace(/\/$/, '')}/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;

/**
 * PUT an object (path-style; works with SeaweedFS and Cloudflare R2).
 * @param cfg { endpoint, bucket, region, accessKeyId, secretAccessKey }
 */
export async function putObject(cfg, key, body, contentType, { cacheControl } = {}) {
  const url = objectUrl(cfg, key);
  const extraHeaders = { 'content-type': contentType, ...(cacheControl ? { 'cache-control': cacheControl } : {}) };
  const headers = signRequest({ method: 'PUT', url, region: cfg.region, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, body, extraHeaders });
  const res = await fetch(url, { method: 'PUT', headers, body, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`S3 PUT ${key} failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return { etag: res.headers.get('etag') };
}

/** GET an object. Resolves to a Buffer, or null on 404. */
export async function getObject(cfg, key) {
  const url = objectUrl(cfg, key);
  const headers = signRequest({ method: 'GET', url, region: cfg.region, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey });
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`S3 GET ${key} failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** HEAD the bucket with signed credentials. Resolves to the HTTP status code. */
export async function headBucket({ endpoint, bucket, region, accessKeyId, secretAccessKey }) {
  const url = `${endpoint.replace(/\/$/, '')}/${bucket}`;
  const headers = signRequest({ method: 'HEAD', url, region, accessKeyId, secretAccessKey });
  const res = await fetch(url, { method: 'HEAD', headers, signal: AbortSignal.timeout(5000) });
  return res.status;
}
