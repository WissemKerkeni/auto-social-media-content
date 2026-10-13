import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { checkImage, dhash, hamming, makePreview, sniffMime } from '../../src/core/images.ts';

/** Deterministic test picture: horizontal + vertical gradients with a block, so hashes are meaningful. */
async function picture(width: number, height: number, format: 'jpeg' | 'png' | 'webp' = 'jpeg', shift = 0): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const block = x > width * 0.3 && x < width * 0.6 && y > height * 0.4 && y < height * 0.7 ? 80 : 0;
      raw[i] = (x * 255) / width;
      raw[i + 1] = ((y + shift) * 255) / height;
      raw[i + 2] = 120 + block;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } })[format]().toBuffer();
}

test('sniffMime trusts magic bytes, not names', async () => {
  assert.equal(sniffMime(await picture(16, 20, 'jpeg')), 'image/jpeg');
  assert.equal(sniffMime(await picture(16, 20, 'png')), 'image/png');
  assert.equal(sniffMime(await picture(16, 20, 'webp')), 'image/webp');
  assert.equal(sniffMime(Buffer.from('<html>not an image</html>')), null);
});

test('checkImage accepts a 4:5 JPEG ≥ 1080 px and keeps its bytes unchanged', async () => {
  const jpg = await picture(1856, 2304, 'jpeg');
  const r = await checkImage(jpg);
  assert.ok(r.ok, !r.ok ? r.reason : '');
  if (!r.ok) return;
  assert.equal(r.reencoded, false, 'valid JPEG kept byte-for-byte (provenance metadata preserved)');
  assert.ok(r.buffer.equals(jpg));
  assert.match(r.sha256, /^[0-9a-f]{64}$/);
  assert.match(r.phash, /^[0-9a-f]{16}$/);
  assert.deepEqual([r.width, r.height], [1856, 2304]);
});

test('checkImage converts PNG to JPEG', async () => {
  const r = await checkImage(await picture(1080, 1350, 'png'));
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.reencoded, true);
    assert.equal(sniffMime(r.buffer), 'image/jpeg');
  }
});

test('checkImage rejects wrong aspect, too small, and non-images', async () => {
  const square = await checkImage(await picture(1200, 1200));
  assert.ok(!square.ok && /aspect ratio/.test(square.reason));
  const small = await checkImage(await picture(800, 1000));
  assert.ok(!small.ok && /below 1080/.test(small.reason));
  const junk = await checkImage(Buffer.from('definitely not an image'));
  assert.ok(!junk.ok && /magic bytes/.test(junk.reason));
  const truncated = await checkImage((await picture(1080, 1350)).subarray(0, 200));
  assert.ok(!truncated.ok);
});

test('dhash: re-encoded/resized copy is near-identical, a different picture is far', async () => {
  const a = await picture(1080, 1350, 'jpeg');
  const aSmaller = await sharp(a).resize(540, 675).jpeg({ quality: 60 }).toBuffer();
  const b = await sharp(await picture(1080, 1350, 'jpeg')).flop().toBuffer();
  const ha = await dhash(a);
  assert.ok(hamming(ha, await dhash(aSmaller)) <= 6, 'same picture after resize + recompression');
  assert.ok(hamming(ha, await dhash(b)) > 10, 'mirrored picture is a different image');
  assert.equal(hamming('ffffffffffffffff', '0000000000000000'), 64);
});

test('makePreview downsizes to the max edge as JPEG', async () => {
  const p = await makePreview(await picture(1856, 2304), 1024);
  const meta = await sharp(Buffer.from(p.base64, 'base64')).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(Math.max(meta.width!, meta.height!), 1024);
});
