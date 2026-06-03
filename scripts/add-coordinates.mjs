// Add representative Google Maps coordinates + URL to photos that have an
// AI-identified locationText. These are place-level coordinates (city/landmark
// centroid), NOT each photo's exact GPS (originals have no GPS).
//
// Usage: node scripts/add-coordinates.mjs [--dry-run]
// Requires R2 creds in env. Reads location labels straight from R2 photos.json.

import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const dryRun = process.argv.includes('--dry-run');
const key = 'metadata/photos.json';

// label -> [lat, lng] (representative point for the place)
const COORDS = {
  '베네치아, 이탈리아': [45.4371, 12.3326],
  '부라노, 베네치아, 이탈리아': [45.4853, 12.4167],
  '로마, 이탈리아': [41.8902, 12.4922],
  '아말피 해안, 이탈리아': [40.6340, 14.6029],
  '토스카나, 이탈리아': [43.0703, 11.6580],
  '피사, 이탈리아': [43.7230, 10.3966],
  '밀라노, 이탈리아': [45.4641, 9.1919],
  '스위스': [46.8182, 8.2275],
  '레만호, 스위스': [46.4500, 6.5500],
  '제네바, 스위스': [46.2074, 6.1557],
  '베른, 스위스': [46.9480, 7.4474],
  '루체른, 스위스': [47.0516, 8.3076],
  '카이에 초콜릿 공장, 스위스': [46.6053, 7.0997],
  '하와이, 미국': [21.3069, -157.8583],
  '제부도, 대한민국': [37.1672, 126.6206],
};

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  forcePathStyle: true,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
});
const bucket = process.env.R2_BUCKET_NAME;

async function main() {
  const res = await r2.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const photos = JSON.parse(Buffer.from(await res.Body.transformToByteArray()).toString('utf8'));

  const now = new Date().toISOString();
  let n = 0;
  const unknown = new Set();
  const updated = photos.map((p) => {
    const loc = String(p.locationText || '').trim();
    const coord = COORDS[loc];
    if (!loc || !coord) { if (loc && !coord) unknown.add(loc); return p; }
    if (String(p.coordinatesText || '').trim() && String(p.mapsUrl || '').trim()) return p; // keep existing
    const [lat, lng] = coord;
    n += 1;
    return {
      ...p,
      coordinatesText: `${lat.toFixed(4)}, ${lng.toFixed(4)}`,
      mapsUrl: `https://www.google.com/maps?q=${lat},${lng}`,
      updatedAt: now,
    };
  });

  console.log(`Photos: ${photos.length} | will set coords on: ${n}`);
  if (unknown.size) console.log(`Labels without coords (skipped): ${[...unknown].join(' | ')}`);
  if (dryRun) { console.log('DRY RUN — no write.'); return; }

  await r2.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: Buffer.from(`${JSON.stringify(updated, null, 2)}\n`, 'utf8'),
    ContentType: 'application/json; charset=utf-8',
  }));
  console.log('Wrote metadata/photos.json back to R2.');
}

main().then(() => process.exit(0), (e) => { console.error('ERROR:', e.message); process.exit(1); });
