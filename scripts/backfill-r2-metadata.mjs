// Backfill capturedAt (and optionally locationText) into R2's
// metadata/photos.json. capturedAt is read from each original image's EXIF
// (DateTimeOriginal) via a small Range request. Images are not modified.
//
// Usage:
//   node scripts/backfill-r2-metadata.mjs --dry-run
//   node scripts/backfill-r2-metadata.mjs                 # write capturedAt
//   node scripts/backfill-r2-metadata.mjs --locations locations.json   # also merge AI locations
//
// locations.json (optional) = { "<photoId>": "위치 텍스트", ... } for high-confidence only.
//
// Requires R2 creds in env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME

import { readFile } from 'node:fs/promises';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import exifr from 'exifr';

const dryRun = process.argv.includes('--dry-run');
const locFlagIdx = process.argv.indexOf('--locations');
const locFile = locFlagIdx >= 0 ? process.argv[locFlagIdx + 1] : '';
const photosObjectKey = 'metadata/photos.json';
const headBytes = 262144;
const concurrency = 16;

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});
const bucket = process.env.R2_BUCKET_NAME;
if (!process.env.R2_ACCOUNT_ID || !bucket) {
  console.error('Missing R2 creds in env.');
  process.exit(1);
}

const basename = (p) => String(p || '').split('/').pop();

async function getObject(key) {
  const res = await r2.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return Buffer.from(await res.Body.transformToByteArray());
}

async function extractCapturedAt(imageUrl) {
  try {
    const res = await r2.send(new GetObjectCommand({
      Bucket: bucket,
      Key: `uploads/${basename(imageUrl)}`,
      Range: `bytes=0-${headBytes - 1}`,
    }));
    const buf = Buffer.from(await res.Body.transformToByteArray());
    const p = await exifr.parse(buf, { pick: ['DateTimeOriginal', 'CreateDate', 'ModifyDate'] });
    const d = p?.DateTimeOriginal || p?.CreateDate || p?.ModifyDate;
    if (d instanceof Date && !Number.isNaN(d.getTime())) return d.toISOString();
  } catch { /* leave empty */ }
  return '';
}

async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const c = i++; out[c] = await fn(items[c], c); }
  }));
  return out;
}

async function main() {
  const photos = JSON.parse((await getObject(photosObjectKey)).toString('utf8'));
  console.log(`Photos in R2: ${photos.length}`);

  const locations = locFile ? JSON.parse(await readFile(locFile, 'utf8')) : {};
  const locCount = Object.keys(locations).length;
  if (locFile) console.log(`Location entries to merge: ${locCount}`);

  const needDate = photos.filter((p) => p?.imageUrl && !String(p.capturedAt || '').trim());
  console.log(`Missing capturedAt: ${needDate.length}`);

  const resolved = await mapLimited(needDate, concurrency, async (p) => ({ id: p.id, capturedAt: await extractCapturedAt(p.imageUrl) }));
  const dateMap = new Map(resolved.filter((r) => r.capturedAt).map((r) => [r.id, r.capturedAt]));
  console.log(`Recoverable dates: ${dateMap.size}/${needDate.length}`);

  let dateWrites = 0; let locWrites = 0;
  const now = new Date().toISOString();
  const updated = photos.map((p) => {
    const next = { ...p };
    if (dateMap.has(p.id)) { next.capturedAt = dateMap.get(p.id); dateWrites += 1; }
    if (locations[p.id] && !String(p.locationText || '').trim()) { next.locationText = locations[p.id]; locWrites += 1; }
    if (next.capturedAt !== p.capturedAt || next.locationText !== p.locationText) next.updatedAt = now;
    return next;
  });

  console.log(`Will set capturedAt on ${dateWrites}, locationText on ${locWrites}.`);
  if (dryRun) { console.log('DRY RUN — no write.'); return; }

  await r2.send(new PutObjectCommand({
    Bucket: bucket,
    Key: photosObjectKey,
    Body: Buffer.from(`${JSON.stringify(updated, null, 2)}\n`, 'utf8'),
    ContentType: 'application/json; charset=utf-8',
  }));
  console.log('Wrote metadata/photos.json back to R2.');
}

main().then(() => process.exit(0), (e) => { console.error('ERROR:', e.message); process.exit(1); });
