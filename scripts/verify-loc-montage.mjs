// Build a montage of photos assigned a given locationText, labeled with the
// location + whether it was inferred, to visually check correctness.
// Usage: node scripts/verify-loc-montage.mjs "<location substring>" <offset> <count>

import { writeFile } from 'node:fs/promises';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import sharp from 'sharp';

const q = process.argv[2] || '';
const offset = Number(process.argv[3] || 0);
const count = Number(process.argv[4] || 48);
const cols = 8; const cell = 175; const label = 22;

const r2 = new S3Client({ region: 'auto', endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, forcePathStyle: true, credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY } });
const bucket = process.env.R2_BUCKET_NAME;
const basename = (p) => String(p || '').split('/').pop();
async function getObj(key) { const r = await r2.send(new GetObjectCommand({ Bucket: bucket, Key: key })); return Buffer.from(await r.Body.transformToByteArray()); }

async function main() {
  const photos = JSON.parse((await getObj('metadata/photos.json')).toString('utf8'));
  let sel = photos.filter((p) => String(p.locationText || '').includes(q));
  sel.sort((a, b) => String(a.capturedAt || '').localeCompare(String(b.capturedAt || '')));
  const total = sel.length;
  sel = sel.slice(offset, offset + count);
  const rows = Math.ceil(sel.length / cols);
  const W = cols * cell; const H = rows * (cell + label);
  const comp = [];
  await Promise.all(sel.map(async (p, i) => {
    const x = (i % cols) * cell; const y = Math.floor(i / cols) * (cell + label);
    try { const b = await getObj(`thumbnails/${basename(p.thumbUrl) || p.id + '.webp'}`); comp.push({ input: await sharp(b).resize(cell, cell, { fit: 'cover' }).png().toBuffer(), top: y + label, left: x }); } catch {}
    const tag = `${offset + i}${p.locationInferred ? ' INF' : ' OK'} ${(p.locationText || '').slice(0, 16)}`;
    const svg = Buffer.from(`<svg width="${cell}" height="${label}"><rect width="100%" height="100%" fill="${p.locationInferred ? '#7a1f1f' : '#1f5a1f'}"/><text x="5" y="16" font-family="sans-serif" font-size="12" fill="#fff">${tag.replace(/&/g, '')}</text></svg>`);
    comp.push({ input: svg, top: y, left: x });
  }));
  const out = `/tmp/verify_${q.slice(0, 6)}_${offset}.png`;
  await sharp({ create: { width: W, height: H, channels: 3, background: '#000' } }).composite(comp).png().toBuffer().then((b) => writeFile(out, b));
  console.log(`wrote ${out} — "${q}" total=${total}, showing ${offset}..${offset + sel.length - 1}`);
}
main().then(() => process.exit(0), (e) => { console.error('ERROR:', e.message); process.exit(1); });
