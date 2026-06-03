// Migrate existing photo + settings metadata from the local JSON files into
// Firestore. Image binaries are NOT touched — they stay in Cloudflare R2 (or
// the local uploads/thumbnails directories). Only the metadata moves.
//
// Usage:
//   node scripts/migrate-to-firestore.mjs            # migrate
//   node scripts/migrate-to-firestore.mjs --dry-run  # report only, no writes
//
// Requires Firebase Admin credentials, resolved the same way as the backend:
//   - FIREBASE_SERVICE_ACCOUNT (inline JSON), or
//   - FIREBASE_SERVICE_ACCOUNT_PATH / GOOGLE_APPLICATION_CREDENTIALS (file path), or
//   - backend/firebase-service-account.json
//
// You can point at a different data source with DATA_DIR.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from '../backend/lib/firebase.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(rootDir, 'backend', 'data');
const photosPath = path.join(dataDir, 'photos.json');
const settingsPath = path.join(dataDir, 'settings.json');

const dryRun = process.argv.includes('--dry-run');
const defaultSiteTitle = '그날의 기록 (Records of the Day)';
const photosCollection = 'photos';
const settingsCollection = 'settings';
const settingsDocId = 'site';
const batchSize = 400;

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
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

async function main() {
  const photos = await readJson(photosPath, []);
  const settings = await readJson(settingsPath, { siteTitle: defaultSiteTitle });

  if (!Array.isArray(photos)) {
    throw new Error(`Expected an array in ${photosPath}`);
  }

  const valid = photos.filter((photo) => photo && photo.id);
  const skipped = photos.length - valid.length;

  console.log(`Source data dir : ${dataDir}`);
  console.log(`Photos to import: ${valid.length}${skipped ? ` (skipped ${skipped} without id)` : ''}`);
  console.log(`Site title      : ${settings.siteTitle || defaultSiteTitle}`);
  console.log(`Mode            : ${dryRun ? 'DRY RUN (no writes)' : 'WRITE'}`);

  if (dryRun) {
    console.log('\nDry run complete. Re-run without --dry-run to write to Firestore.');
    return;
  }

  const db = getDb();

  // Settings document.
  await db.collection(settingsCollection).doc(settingsDocId).set(
    { siteTitle: settings.siteTitle || defaultSiteTitle },
    { merge: true },
  );

  // Photo documents, in batches.
  let written = 0;
  for (let start = 0; start < valid.length; start += batchSize) {
    const batch = db.batch();
    const chunk = valid.slice(start, start + batchSize);

    for (const photo of chunk) {
      const record = normalizePhoto(photo);
      batch.set(db.collection(photosCollection).doc(record.id), record);
    }

    await batch.commit();
    written += chunk.length;
    console.log(`  ...wrote ${written}/${valid.length}`);
  }

  console.log(`\nDone. Imported ${written} photo(s) and settings into Firestore.`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error('\nMigration failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
