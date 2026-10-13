// Image validation, normalization, hashing and previews. Deterministic; no network.
import { createHash } from 'node:crypto';
import sharp, { type Metadata } from 'sharp';

export type ImageCheck =
  | { ok: true; buffer: Buffer; mimeType: 'image/jpeg'; width: number; height: number; bytes: number; sha256: string; phash: string; reencoded: boolean }
  | { ok: false; reason: string };

export interface ImageRules {
  /** target aspect ratio "W:H", e.g. "4:5" */
  aspectRatio: string;
  /** relative tolerance on width/height */
  aspectTolerance: number;
  minWidth: number;
  /** Instagram's JPEG limit is 8 MB */
  maxBytes: number;
}

export const DEFAULT_RULES: ImageRules = { aspectRatio: '4:5', aspectTolerance: 0.03, minWidth: 1080, maxBytes: 8 * 1024 * 1024 };

/** Identify the real format from magic bytes (never trust a declared MIME type). */
export function sniffMime(buf: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export const sha256Hex = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

/**
 * 64-bit difference hash (dHash): grayscale 9x8, compare horizontal neighbours.
 * Robust to re-encoding and resizing; Hamming distance <= ~6 means "same picture".
 */
export async function dhash(buf: Buffer): Promise<string> {
  const px = await sharp(buf).rotate().grayscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
  let bits = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits = (bits << 1n) | (px[y * 9 + x]! > px[y * 9 + x + 1]! ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, '0');
}

export function hamming(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}

const parseRatio = (r: string): number => {
  const [w, h] = r.split(':').map(Number);
  if (!w || !h) throw new Error(`invalid aspect ratio ${r}`);
  return w / h;
};

/**
 * Validate a candidate image and normalize it to a publishable JPEG.
 * - format from magic bytes; must decode
 * - aspect within tolerance of the target, width >= minWidth
 * - JPEG kept byte-for-byte when already valid (preserves provenance metadata such as C2PA);
 *   PNG/WebP or oversized files are re-encoded to JPEG
 */
export async function checkImage(input: Buffer, rules: ImageRules = DEFAULT_RULES): Promise<ImageCheck> {
  if (!input.length) return { ok: false, reason: 'empty image' };
  const mime = sniffMime(input);
  if (!mime) return { ok: false, reason: 'unsupported or corrupt image (magic bytes)' };

  let meta: Metadata;
  try {
    meta = await sharp(input).metadata();
  } catch (err) {
    return { ok: false, reason: `image does not decode: ${(err as Error).message}` };
  }
  const { width, height } = meta;
  if (!width || !height) return { ok: false, reason: 'image has no dimensions' };
  if ((meta.orientation ?? 1) > 4) return { ok: false, reason: 'rotated EXIF orientation is not supported' };

  const target = parseRatio(rules.aspectRatio);
  const actual = width / height;
  if (Math.abs(actual - target) / target > rules.aspectTolerance) {
    return { ok: false, reason: `aspect ratio ${width}x${height} (${actual.toFixed(3)}) is not ${rules.aspectRatio}` };
  }
  if (width < rules.minWidth) return { ok: false, reason: `width ${width}px is below ${rules.minWidth}px` };

  let buffer = input;
  let reencoded = false;
  if (mime !== 'image/jpeg' || input.length > rules.maxBytes) {
    for (const quality of [92, 85, 78]) {
      buffer = await sharp(input).jpeg({ quality, mozjpeg: true }).toBuffer();
      if (buffer.length <= rules.maxBytes) break;
    }
    reencoded = true;
  }
  if (buffer.length > rules.maxBytes) return { ok: false, reason: `image is ${(buffer.length / 1048576).toFixed(1)} MB after re-encoding (max ${rules.maxBytes / 1048576} MB)` };

  return { ok: true, buffer, mimeType: 'image/jpeg', width, height, bytes: buffer.length, sha256: sha256Hex(buffer), phash: await dhash(buffer), reencoded };
}

/** Small JPEG for the vision audit (keeps the audit cheap and under API image limits). */
export async function makePreview(buf: Buffer, maxEdge = 1024): Promise<{ base64: string; mimeType: 'image/jpeg'; bytes: number }> {
  const out = await sharp(buf).rotate().resize(maxEdge, maxEdge, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
  return { base64: out.toString('base64'), mimeType: 'image/jpeg', bytes: out.length };
}
