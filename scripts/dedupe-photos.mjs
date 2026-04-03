import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const rootDir = process.cwd();
const photosPath = path.join(rootDir, 'backend/data/photos.json');
const uploadsDir = path.join(rootDir, 'backend/data/uploads');

function getPriority(photo) {
  return [
    photo.note ? 1 : 0,
    photo.locationText ? 1 : 0,
    photo.coordinatesText ? 1 : 0,
    photo.mapsUrl ? 1 : 0,
    photo.capturedAt ? 1 : 0,
  ].reduce((sum, value) => sum + value, 0);
}

function comparePhotos(left, right) {
  const priorityDelta = getPriority(right) - getPriority(left);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }

  return String(right.createdAt || '').localeCompare(String(left.createdAt || ''));
}

async function main() {
  const photos = JSON.parse(await readFile(photosPath, 'utf8'));
  const groups = new Map();
  const missingFiles = [];

  for (const photo of photos) {
    const filePath = path.join(uploadsDir, path.basename(photo.imageUrl || ''));
    if (!existsSync(filePath)) {
      missingFiles.push(photo.id);
      continue;
    }

    const buffer = await readFile(filePath);
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    photo.sha256 = sha256;

    if (!groups.has(sha256)) {
      groups.set(sha256, []);
    }

    groups.get(sha256).push({
      photo,
      filePath,
    });
  }

  const kept = [];
  const removed = [];
  const deletedFiles = new Set();

  for (const [, items] of groups) {
    items.sort((left, right) => comparePhotos(left.photo, right.photo));
    const winner = items[0];
    kept.push(winner.photo);

    for (const duplicate of items.slice(1)) {
      removed.push(duplicate.photo);
      if (duplicate.filePath !== winner.filePath && !deletedFiles.has(duplicate.filePath)) {
        deletedFiles.add(duplicate.filePath);
      }
    }
  }

  kept.sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')));
  await writeFile(photosPath, `${JSON.stringify(kept, null, 2)}\n`, 'utf8');

  for (const filePath of deletedFiles) {
    await rm(filePath, { force: true });
  }

  console.log(
    JSON.stringify(
      {
        before: photos.length,
        after: kept.length,
        removedPhotos: removed.length,
        removedFiles: deletedFiles.size,
        missingFiles: missingFiles.length,
      },
      null,
      2,
    ),
  );
}

await main();
