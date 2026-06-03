// Backfill the capturedAt field on Firestore photo docs by reading the original
// image's EXIF DateTimeOriginal/CreateDate from R2. Only the first chunk of each
// image is fetched (EXIF lives near the start of a JPEG) to minimize R2 egress.
//
// Usage:
//   node scripts/backfill-captured-at.mjs --dry-run   # report only
//   node scripts/backfill-captured-at.mjs             # write capturedAt
//   node scripts/backfill-captured-at.mjs --force     # overwrite existing capturedAt too
//
// Requires Firebase Admin credentials + R2 credentials in the environment.

import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import exifr from 'exifr';
import { getDb } from '../backend/lib/firebase.mjs';

const dryRun = process.argv.includes('--dry-run');
const force = process.argv.includes('--force');
const photosCollection = 'photos';
const headBytes = 262144; // 256KB — enough for JPEG EXIF (APP1) near the start.
const concurrency = 16;
const writeBatchSize = 400;

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
  console.error('Missing R2 credentials in the environment.');
  process.exit(1);
}

function basename(p) {
  return String(p || '').split('/').pop();
}

async function extractCapturedAt(imageUrl) {
  const key = `uploads/${basename(imageUrl)}`;
  try {
    const res = await r2.send(new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      Range: `bytes=0-${headBytes - 1}`,
    }));
    const buf = Buffer.from(await res.Body.transformToByteArray());
    const parsed = await exifr.parse(buf, { pick: ['DateTimeOriginal', 'CreateDate', 'ModifyDate'] });
    const date = parsed?.DateTimeOriginal || parsed?.CreateDate || parsed?.ModifyDate;
    if (date instanceof Date && !Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  } catch {
    // Missing object or unparseable header — leave capturedAt empty.
  }
  return '';
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index++;
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const db = getDb();
  const docs = (await db.collection(photosCollection).get()).docs.map((d) => d.data());
  const targets = docs.filter((p) => p?.imageUrl && (force || !String(p.capturedAt || '').trim()));

  console.log(`Total photos      : ${docs.length}`);
  console.log(`Already have date : ${docs.filter((p) => String(p.capturedAt || '').trim()).length}`);
  console.log(`To examine        : ${targets.length}${force ? ' (--force: re-reading all)' : ''}`);
  console.log(`Mode              : ${dryRun ? 'DRY RUN (no writes)' : 'WRITE'}`);

  let done = 0;
  const resolved = await mapWithConcurrency(targets, concurrency, async (photo) => {
    const capturedAt = await extractCapturedAt(photo.imageUrl);
    done += 1;
    if (done % 100 === 0) console.log(`  ...examined ${done}/${targets.length}`);
    return capturedAt ? { id: photo.id, capturedAt } : null;
  });

  const updates = resolved.filter(Boolean);
  console.log(`\nRecoverable capturedAt: ${updates.length} / ${targets.length}`);
  if (updates.length) {
    console.log('Sample:', updates.slice(0, 5).map((u) => u.capturedAt.slice(0, 10)).join(', '));
  }

  if (dryRun) {
    console.log('\nDry run complete. Re-run without --dry-run to write.');
    return;
  }

  const now = new Date().toISOString();
  let written = 0;
  for (let start = 0; start < updates.length; start += writeBatchSize) {
    const batch = db.batch();
    for (const u of updates.slice(start, start + writeBatchSize)) {
      batch.set(
        db.collection(photosCollection).doc(u.id),
        { capturedAt: u.capturedAt, updatedAt: now },
        { merge: true },
      );
    }
    await batch.commit();
    written += Math.min(writeBatchSize, updates.length - start);
    console.log(`  ...wrote ${written}/${updates.length}`);
  }

  console.log(`\nDone. Backfilled capturedAt on ${written} photo(s).`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error('\nBackfill failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
