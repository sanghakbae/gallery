// Remove location data that was inferred by sequence propagation (unreliable at
// trip boundaries). Keeps directly-identified locations (locationInferred falsy)
// and capturedAt. Usage: node scripts/clear-inferred-locations.mjs [--dry-run]

import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const dryRun = process.argv.includes('--dry-run');
const key = 'metadata/photos.json';
const r2 = new S3Client({ region: 'auto', endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, forcePathStyle: true, credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY } });
const bucket = process.env.R2_BUCKET_NAME;

async function main() {
  const res = await r2.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const photos = JSON.parse(Buffer.from(await res.Body.transformToByteArray()).toString('utf8'));
  let cleared = 0;
  const now = new Date().toISOString();
  const updated = photos.map((p) => {
    if (!p.locationInferred) return p;
    cleared += 1;
    const { locationInferred, ...rest } = p;
    return { ...rest, locationText: '', coordinatesText: '', mapsUrl: '', updatedAt: now };
  });
  const located = updated.filter((p) => String(p.locationText || '').trim()).length;
  console.log(`Cleared inferred: ${cleared} | remaining located (verified): ${located}`);
  if (dryRun) { console.log('DRY RUN — no write.'); return; }
  await r2.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: Buffer.from(`${JSON.stringify(updated, null, 2)}\n`, 'utf8'), ContentType: 'application/json; charset=utf-8' }));
  console.log('Wrote metadata/photos.json back to R2.');
}
main().then(() => process.exit(0), (e) => { console.error('ERROR:', e.message); process.exit(1); });
