// Build a labeled montage (contact sheet) of photo thumbnails from R2 so many
// can be visually scanned at once for high-confidence location identification.
//
// Usage: node scripts/make-montage.mjs <offset> <count>
// Outputs: /tmp/montage_<offset>.png and prints index->photoId mapping (JSON to
//          /tmp/montage_<offset>.json). Photos are ordered by capturedAt.
//
// Requires R2 creds in env.

import { writeFile } from 'node:fs/promises';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import sharp from 'sharp';

const offset = Number(process.argv[2] || 0);
const count = Number(process.argv[3] || 24);
const cols = Number(process.env.MCOLS || 8);
const cell = Number(process.env.MCELL || 175);
const label = 22;

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  forcePathStyle: true,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
});
const bucket = process.env.R2_BUCKET_NAME;
const basename = (p) => String(p || '').split('/').pop();

async function getObj(key) {
  const res = await r2.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return Buffer.from(await res.Body.transformToByteArray());
}

async function main() {
  const photos = JSON.parse((await getObj('metadata/photos.json')).toString('utf8'));
  photos.sort((a, b) => String(a.capturedAt || a.createdAt || '').localeCompare(String(b.capturedAt || b.createdAt || '')));
  const slice = photos.slice(offset, offset + count);
  const rows = Math.ceil(slice.length / cols);
  const W = cols * cell;
  const H = rows * (cell + label);

  const composites = [];
  const mapping = {};
  await Promise.all(slice.map(async (p, i) => {
    const gi = offset + i;
    const col = i % cols; const row = Math.floor(i / cols);
    const x = col * cell; const y = row * (cell + label);
    mapping[gi] = { id: p.id, capturedAt: p.capturedAt || '', title: p.title || '' };
    try {
      const buf = await getObj(`thumbnails/${basename(p.thumbUrl) || p.id + '.webp'}`);
      const img = await sharp(buf).resize(cell, cell, { fit: 'cover' }).png().toBuffer();
      composites.push({ input: img, top: y + label, left: x });
    } catch { /* skip missing */ }
    const cap = `#${gi}  ${(p.capturedAt || '').slice(0, 10)}`;
    const svg = Buffer.from(`<svg width="${cell}" height="${label}"><rect width="100%" height="100%" fill="#111"/><text x="6" y="18" font-family="sans-serif" font-size="15" fill="#fff">${cap}</text></svg>`);
    composites.push({ input: svg, top: y, left: x });
  }));

  const out = `/tmp/montage_${offset}.png`;
  await sharp({ create: { width: W, height: H, channels: 3, background: '#000' } })
    .composite(composites).png().toBuffer().then((b) => writeFile(out, b));
  await writeFile(`/tmp/montage_${offset}.json`, JSON.stringify(mapping, null, 2));
  console.log(`wrote ${out} (${slice.length} photos, idx ${offset}..${offset + slice.length - 1})`);
  console.log(`total photos: ${photos.length}`);
}

main().then(() => process.exit(0), (e) => { console.error('ERROR:', e.message); process.exit(1); });
