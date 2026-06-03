// Re-migrate photo + settings metadata from the AUTHORITATIVE Cloudflare R2
// source (metadata/photos.json) into Firestore. This is the correct source for
// production data — the local backend/data/photos.json is a stale git copy and
// must NOT be used.
//
// Image binaries are NOT touched — they stay in R2. This only moves metadata.
//
// Usage:
//   node scripts/migrate-r2-to-firestore.mjs --dry-run   # report only
//   node scripts/migrate-r2-to-firestore.mjs             # replace Firestore data
//
// Requires:
//   - Firebase Admin credentials (backend/firebase-service-account.json or env)
//   - R2 credentials in the environment:
//       R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME
//     (export them, or put them in a gitignored file and `source` it first)

import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getDb } from '../backend/lib/firebase.mjs';

const dryRun = process.argv.includes('--dry-run');
const defaultSiteTitle = '그날의 기록 (Records of the Day)';
const photosCollection = 'photos';
const settingsCollection = 'settings';
const settingsDocId = 'site';
const photosObjectKey = 'metadata/photos.json';
const settingsObjectKey = 'metadata/settings.json';
const batchSize = 400;

const r2AccountId = String(process.env.R2_ACCOUNT_ID || '').trim();
const r2AccessKeyId = String(process.env.R2_ACCESS_KEY_ID || '').trim();
const r2SecretAccessKey = String(process.env.R2_SECRET_ACCESS_KEY || '').trim();
const r2BucketName = String(process.env.R2_BUCKET_NAME || '').trim();

if (!r2AccountId || !r2AccessKeyId || !r2SecretAccessKey || !r2BucketName) {
  console.error(
    'Missing R2 credentials. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, ' +
      'R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME in the environment.',
  );
  process.exit(1);
}

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${r2AccountId}.r2.cloudflarestorage.com`,
  forcePathStyle: true,
  credentials: { accessKeyId: r2AccessKeyId, secretAccessKey: r2SecretAccessKey },
});

async function getJson(key, fallback) {
  try {
    const res = await r2.send(new GetObjectCommand({ Bucket: r2BucketName, Key: key }));
    const bytes = await res.Body.transformToByteArray();
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (error) {
    if (error?.$metadata?.httpStatusCode === 404 || error?.name === 'NoSuchKey') {
      return fallback;
    }
    throw error;
  }
}

async function objectExists(key) {
  try {
    await r2.send(new HeadObjectCommand({ Bucket: r2BucketName, Key: key }));
    return true;
  } catch (error) {
    if (error?.$metadata?.httpStatusCode === 404 || error?.name === 'NotFound') {
      return false;
    }
    throw error;
  }
}

function basename(p) {
  return String(p || '').split('/').pop();
}

function normalizePhoto(photo) {
  const now = new Date().toISOString();
  return {
    ...photo,
    id: String(photo.id),
    likeCount: Math.max(0, Number(photo.likeCount || 0)),
    isPublic: photo.isPublic !== false,
    createdAt: photo.createdAt || now,
    updatedAt: photo.updatedAt || photo.createdAt || now,
  };
}

async function clearCollection(db, name) {
  let deleted = 0;
  // Delete in pages to avoid loading everything at once.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const snap = await db.collection(name).limit(batchSize).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    deleted += snap.size;
    console.log(`  ...deleted ${deleted} stale doc(s)`);
  }
  return deleted;
}

async function main() {
  const photos = await getJson(photosObjectKey, []);
  const settings = await getJson(settingsObjectKey, { siteTitle: defaultSiteTitle });

  if (!Array.isArray(photos)) {
    throw new Error(`Expected an array in R2 ${photosObjectKey}`);
  }

  const valid = photos.filter((p) => p && p.id);
  console.log(`R2 bucket       : ${r2BucketName}`);
  console.log(`Photos in R2    : ${valid.length}`);
  console.log(`Site title      : ${settings.siteTitle || defaultSiteTitle}`);
  console.log(`Mode            : ${dryRun ? 'DRY RUN (no writes)' : 'WRITE (replaces Firestore)'}`);

  // Verify a sample of image objects actually exist in R2.
  const sample = valid.slice(0, 5);
  console.log('\nVerifying sample image objects in R2:');
  for (const p of sample) {
    const key = `uploads/${basename(p.imageUrl)}`;
    const exists = await objectExists(key);
    console.log(`  ${exists ? '✅' : '❌'} ${key}`);
  }

  if (dryRun) {
    console.log('\nDry run complete. Re-run without --dry-run to replace Firestore data.');
    return;
  }

  const db = getDb();

  console.log('\nClearing stale Firestore photos...');
  await clearCollection(db, photosCollection);

  await db.collection(settingsCollection).doc(settingsDocId).set(
    { siteTitle: settings.siteTitle || defaultSiteTitle },
    { merge: true },
  );

  let written = 0;
  for (let start = 0; start < valid.length; start += batchSize) {
    const batch = db.batch();
    for (const photo of valid.slice(start, start + batchSize)) {
      const record = normalizePhoto(photo);
      batch.set(db.collection(photosCollection).doc(record.id), record);
    }
    await batch.commit();
    written += Math.min(batchSize, valid.length - start);
    console.log(`  ...wrote ${written}/${valid.length}`);
  }

  console.log(`\nDone. Replaced Firestore with ${written} photo(s) from R2 + settings.`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error('\nMigration failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
