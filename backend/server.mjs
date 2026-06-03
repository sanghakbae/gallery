import { createServer } from 'node:http';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { getAdminAuth, getDb } from './lib/firebase.mjs';

const photosCollection = 'photos';
const settingsCollection = 'settings';
const settingsDocId = 'site';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, 'data');
const uploadsDir = path.join(dataDir, 'uploads');
const thumbnailsDir = path.join(dataDir, 'thumbnails');
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '127.0.0.1';
const migrationToken = String(process.env.MIGRATION_TOKEN || '').trim();
const allowedAdminEmails = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const verifiedAdminCache = new Map();
const verifiedAdminTtlMs = 1000 * 60 * 10;
const r2AccountId = String(process.env.R2_ACCOUNT_ID || '').trim();
const r2AccessKeyId = String(process.env.R2_ACCESS_KEY_ID || '').trim();
const r2SecretAccessKey = String(process.env.R2_SECRET_ACCESS_KEY || '').trim();
const r2BucketName = String(process.env.R2_BUCKET_NAME || '').trim();
const r2PublicBaseUrl = String(process.env.R2_PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
const r2Enabled = Boolean(
  r2AccountId &&
  r2AccessKeyId &&
  r2SecretAccessKey &&
  r2BucketName,
);
const r2Endpoint = r2Enabled
  ? `https://${r2AccountId}.r2.cloudflarestorage.com`
  : '';
const r2Client = r2Enabled
  ? new S3Client({
      region: 'auto',
      endpoint: r2Endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: r2AccessKeyId,
        secretAccessKey: r2SecretAccessKey,
      },
    })
  : null;

const mimeTypes = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
};
const thumbnailWidth = 640;
const thumbnailHeight = 640;
const defaultSiteTitle = '그날의 기록 (Records of the Day)';

function getUploadObjectKey(fileName) {
  return `uploads/${fileName}`;
}

function getThumbnailObjectKey(photoId) {
  return `thumbnails/${getThumbnailName(photoId)}`;
}

function getPublicAssetUrl(objectKey, fallbackPath) {
  if (r2Enabled && r2PublicBaseUrl) {
    return `${r2PublicBaseUrl}/${objectKey}`;
  }

  return fallbackPath;
}

function getRequestOrigin(request) {
  const forwardedProto = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwardedProto || 'http';
  const hostHeader = String(request.headers['x-forwarded-host'] || request.headers.host || '').split(',')[0].trim();

  if (!hostHeader) {
    return '';
  }

  return `${protocol}://${hostHeader}`;
}

function resolvePublicAssetUrl(objectKey, fallbackPath, requestOrigin = '') {
  const assetUrl = getPublicAssetUrl(objectKey, fallbackPath);
  if (/^https?:\/\//i.test(assetUrl) || !requestOrigin) {
    return assetUrl;
  }

  return new URL(assetUrl, requestOrigin).toString();
}

function isMissingAssetError(error) {
  return (
    error?.code === 'ENOENT' ||
    error?.name === 'NoSuchKey' ||
    error?.name === 'NotFound' ||
    error?.$metadata?.httpStatusCode === 404
  );
}

async function objectExists(key) {
  if (!r2Client) {
    return false;
  }

  try {
    await r2Client.send(new HeadObjectCommand({
      Bucket: r2BucketName,
      Key: key,
    }));
    return true;
  } catch (error) {
    if (error?.$metadata?.httpStatusCode === 404 || error?.name === 'NotFound') {
      return false;
    }

    throw error;
  }
}

async function getObjectBuffer(key) {
  if (!r2Client) {
    throw new Error('R2 storage is not configured.');
  }

  const response = await r2Client.send(new GetObjectCommand({
    Bucket: r2BucketName,
    Key: key,
  }));

  const bytes = await response.Body.transformToByteArray();
  return Buffer.from(bytes);
}

async function putObject(key, body, contentType) {
  if (!r2Client) {
    throw new Error('R2 storage is not configured.');
  }

  await r2Client.send(new PutObjectCommand({
    Bucket: r2BucketName,
    Key: key,
    Body: body,
    ContentType: contentType,
  }));
}

async function deleteObject(key) {
  if (!r2Client) {
    throw new Error('R2 storage is not configured.');
  }

  await r2Client.send(new DeleteObjectCommand({
    Bucket: r2BucketName,
    Key: key,
  }));
}

async function getStorageUsageSummary() {
  if (r2Enabled) {
    let continuationToken;
    let totalBytes = 0;
    let objectCount = 0;

    do {
      const response = await r2Client.send(new ListObjectsV2Command({
        Bucket: r2BucketName,
        ContinuationToken: continuationToken,
      }));

      for (const item of response.Contents ?? []) {
        totalBytes += Number(item.Size || 0);
        objectCount += 1;
      }

      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);

    return {
      backend: 'r2',
      totalBytes,
      objectCount,
    };
  }

  let totalBytes = 0;
  let objectCount = 0;

  const filePaths = [];
  const photos = await readPhotos();
  for (const photo of photos) {
    filePaths.push(path.join(uploadsDir, path.basename(photo.imageUrl || '')));
    filePaths.push(path.join(thumbnailsDir, getThumbnailName(photo.id)));
  }

  for (const filePath of filePaths) {
    try {
      const fileStat = await stat(filePath);
      totalBytes += fileStat.size;
      objectCount += 1;
    } catch {
      // Ignore missing local files in summary.
    }
  }

  return {
    backend: 'local',
    totalBytes,
    objectCount,
  };
}

// Photo and settings metadata lives in Firestore. Image binaries continue to
// live in Cloudflare R2 (or the local uploads/thumbnails directories).

async function ensureDataFiles() {
  // Only local image directories need to be ensured up-front; Firestore
  // collections/documents are created lazily on first write.
  if (r2Enabled) {
    return;
  }

  await mkdir(uploadsDir, { recursive: true });
  await mkdir(thumbnailsDir, { recursive: true });
}

// In-memory caches to avoid re-reading the entire collection on every public
// request (Firestore bills per document read). Any write invalidates them.
// Writes invalidate these caches immediately, so a long TTL is safe and keeps
// Firestore reads well within the free-tier daily quota: under read-only
// traffic the full photo list is fetched at most once per TTL window.
const photosCacheTtlMs = 10 * 60 * 1000;
const settingsCacheTtlMs = 30 * 60 * 1000;
let photosCache = null;
let photosCacheExpiresAt = 0;
let settingsCache = null;
let settingsCacheExpiresAt = 0;

function invalidatePhotosCache() {
  photosCache = null;
  photosCacheExpiresAt = 0;
}

function invalidateSettingsCache() {
  settingsCache = null;
  settingsCacheExpiresAt = 0;
}

async function readPhotos() {
  const snapshot = await getDb().collection(photosCollection).get();
  return snapshot.docs.map((doc) => doc.data());
}

// Cached read of the full photo list. Used by high-traffic public endpoints.
async function readPhotosCached() {
  const now = Date.now();
  if (photosCache && photosCacheExpiresAt > now) {
    return photosCache;
  }

  photosCache = await readPhotos();
  photosCacheExpiresAt = now + photosCacheTtlMs;
  return photosCache;
}

async function getPhotoById(photoId) {
  const doc = await getDb().collection(photosCollection).doc(photoId).get();
  return doc.exists ? doc.data() : null;
}

async function findPhotoBySha256(sha256) {
  if (!sha256) {
    return null;
  }

  const snapshot = await getDb()
    .collection(photosCollection)
    .where('sha256', '==', sha256)
    .limit(1)
    .get();

  return snapshot.empty ? null : snapshot.docs[0].data();
}

async function savePhoto(record) {
  await getDb().collection(photosCollection).doc(record.id).set(record);
  invalidatePhotosCache();
}

async function updatePhotoFields(photoId, fields) {
  await getDb().collection(photosCollection).doc(photoId).set(fields, { merge: true });
  invalidatePhotosCache();
}

async function deletePhotoById(photoId) {
  await getDb().collection(photosCollection).doc(photoId).delete();
  invalidatePhotosCache();
}

async function deletePhotosByIds(photoIds) {
  const db = getDb();
  const chunkSize = 400;

  for (let start = 0; start < photoIds.length; start += chunkSize) {
    const batch = db.batch();
    for (const photoId of photoIds.slice(start, start + chunkSize)) {
      batch.delete(db.collection(photosCollection).doc(photoId));
    }
    await batch.commit();
  }

  invalidatePhotosCache();
}

async function readSettings() {
  const now = Date.now();
  if (settingsCache && settingsCacheExpiresAt > now) {
    return settingsCache;
  }

  const doc = await getDb().collection(settingsCollection).doc(settingsDocId).get();
  settingsCache = doc.exists ? doc.data() : { siteTitle: defaultSiteTitle };
  settingsCacheExpiresAt = now + settingsCacheTtlMs;
  return settingsCache;
}

async function writeSettings(settings) {
  await getDb().collection(settingsCollection).doc(settingsDocId).set(settings, { merge: true });
  invalidateSettingsCache();
}

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(`${JSON.stringify(data, null, 2)}\n`);
}

function sendText(response, statusCode, message) {
  response.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(message);
}

function setCorsHeaders(request, response) {
  const requestOrigin = request.headers.origin || '';
  const allowAnyOrigin = allowedOrigins.length === 0;
  const allowOrigin = allowAnyOrigin
    ? requestOrigin || '*'
    : allowedOrigins.includes(requestOrigin)
      ? requestOrigin
      : requestOrigin || allowedOrigins[0];

  response.setHeader('Access-Control-Allow-Origin', allowOrigin);
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Photo-Meta');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  response.setHeader('Vary', 'Origin');
}

async function readJsonBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function readRawBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

function requireMigrationToken(request) {
  if (!migrationToken) {
    throw new Error('Migration token is not configured.');
  }

  const authorization = request.headers.authorization || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';

  if (!token || token !== migrationToken) {
    const error = new Error('Invalid migration token.');
    error.statusCode = 401;
    throw error;
  }
}

function sanitizeFileName(fileName) {
  return (fileName || 'photo.jpg').replace(/[^a-zA-Z0-9._-]/g, '-');
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function getDownloadFormat(mimeType, fileName) {
  const normalizedMimeType = String(mimeType || '').toLowerCase();
  const extension = path.extname(fileName || '').toLowerCase();

  if (normalizedMimeType === 'image/png' || extension === '.png') {
    return {
      format: 'png',
      contentType: 'image/png',
      extension: '.png',
    };
  }

  if (normalizedMimeType === 'image/webp' || extension === '.webp') {
    return {
      format: 'webp',
      contentType: 'image/webp',
      extension: '.webp',
    };
  }

  return {
    format: 'jpeg',
    contentType: 'image/jpeg',
    extension: '.jpg',
  };
}

function parseDataUrl(dataUrl) {
  const match = dataUrl.match(/^data:(.*?);base64,(.*)$/);
  if (!match) {
    throw new Error('Invalid data URL.');
  }

  return {
    mimeType: match[1],
    buffer: Buffer.from(match[2], 'base64'),
  };
}

function getExtension(mimeType, fileName) {
  const normalizedMimeType = (mimeType || '').toLowerCase();
  const byMime = Object.entries(mimeTypes).find(([, value]) => value === normalizedMimeType)?.[0];
  if (byMime) {
    return byMime;
  }

  const ext = path.extname(fileName || '').toLowerCase();
  return mimeTypes[ext] ? ext : '.jpg';
}

function getThumbnailName(photoId) {
  return `${photoId}.webp`;
}

function getThumbnailUrl(photoId, requestOrigin = '') {
  return resolvePublicAssetUrl(
    getThumbnailObjectKey(photoId),
    `/thumbnails/${getThumbnailName(photoId)}`,
    requestOrigin,
  );
}

async function generateThumbnail(inputBuffer) {
  return sharp(inputBuffer, { failOn: 'none' })
    .rotate()
    .resize(thumbnailWidth, thumbnailHeight, {
      fit: 'cover',
      position: 'attention',
      withoutEnlargement: true,
    })
    .webp({ quality: 78, effort: 4 })
    .toBuffer();
}

async function readUploadBuffer(fileName) {
  if (r2Enabled) {
    try {
      return await getObjectBuffer(getUploadObjectKey(fileName));
    } catch (error) {
      if (!isMissingAssetError(error)) {
        throw error;
      }
    }
  }

  return readFile(path.join(uploadsDir, fileName));
}

async function writeUploadBuffer(fileName, buffer, mimeType) {
  if (r2Enabled) {
    await putObject(getUploadObjectKey(fileName), buffer, mimeType || 'application/octet-stream');
    return;
  }

  await writeFile(path.join(uploadsDir, fileName), buffer);
}

async function deleteUploadBuffer(fileName) {
  if (r2Enabled) {
    await deleteObject(getUploadObjectKey(fileName));
    return;
  }

  await rm(path.join(uploadsDir, fileName), { force: true });
}

async function readThumbnailBuffer(fileName) {
  if (r2Enabled) {
    try {
      return await getObjectBuffer(`thumbnails/${fileName}`);
    } catch (error) {
      if (!isMissingAssetError(error)) {
        throw error;
      }
    }
  }

  return readFile(path.join(thumbnailsDir, fileName));
}

async function writeThumbnailBuffer(photoId, buffer) {
  const fileName = getThumbnailName(photoId);
  if (r2Enabled) {
    await putObject(`thumbnails/${fileName}`, buffer, 'image/webp');
    return;
  }

  await writeFile(path.join(thumbnailsDir, fileName), buffer);
}

async function deleteThumbnailBuffer(photoId) {
  if (r2Enabled) {
    await deleteObject(getThumbnailObjectKey(photoId));
    return;
  }

  await rm(path.join(thumbnailsDir, getThumbnailName(photoId)), { force: true });
}

async function verifyStoredPhotoAssets(fileName, photoId) {
  if (r2Enabled) {
    const [uploadExists, thumbnailExists] = await Promise.all([
      objectExists(getUploadObjectKey(fileName)),
      objectExists(getThumbnailObjectKey(photoId)),
    ]);

    if (!uploadExists || !thumbnailExists) {
      const error = new Error('Stored photo assets are missing.');
      error.code = 'ENOENT';
      throw error;
    }

    return;
  }

  await Promise.all([
    stat(path.join(uploadsDir, fileName)),
    stat(path.join(thumbnailsDir, getThumbnailName(photoId))),
  ]);
}

async function ensurePhotoThumbnail(photo) {
  const thumbUrl = getThumbnailUrl(photo.id);
  const uploadFileName = path.basename(photo.imageUrl || '');
  const imageUrl = getPublicAssetUrl(getUploadObjectKey(uploadFileName), `/uploads/${uploadFileName}`);

  if (!uploadFileName) {
    const error = new Error(`Missing upload file name for photo ${photo.id}`);
    error.code = 'ENOENT';
    throw error;
  }

  try {
    if (r2Enabled) {
      const [uploadExists, thumbnailExists] = await Promise.all([
        objectExists(getUploadObjectKey(uploadFileName)),
        objectExists(getThumbnailObjectKey(photo.id)),
      ]);

      if (!uploadExists) {
        throw Object.assign(new Error('Missing upload.'), { code: 'ENOENT' });
      }

      if (!thumbnailExists) {
        throw Object.assign(new Error('Missing thumbnail.'), { code: 'ENOENT' });
      }
    } else {
      await Promise.all([
        stat(path.join(uploadsDir, uploadFileName)),
        stat(path.join(thumbnailsDir, getThumbnailName(photo.id))),
      ]);
    }
  } catch {
    const sourceBuffer = await readUploadBuffer(uploadFileName);
    const thumbnailBuffer = await generateThumbnail(sourceBuffer);
    await writeThumbnailBuffer(photo.id, thumbnailBuffer);
  }

  if (photo.thumbUrl === thumbUrl && photo.imageUrl === imageUrl) {
    return photo;
  }

  return {
    ...photo,
    imageUrl,
    thumbUrl,
  };
}

function normalizePhotoMetadata(photo, requestOrigin = '') {
  if (!photo) {
    return photo;
  }

  const uploadFileName = path.basename(photo.imageUrl || `${photo.id}.jpg`);
  const imageUrl = resolvePublicAssetUrl(
    getUploadObjectKey(uploadFileName),
    `/uploads/${uploadFileName}`,
    requestOrigin,
  );
  const thumbUrl = getThumbnailUrl(photo.id, requestOrigin);

  if (photo.imageUrl === imageUrl && photo.thumbUrl === thumbUrl) {
    return photo;
  }

  return {
    ...photo,
    isPublic: photo.isPublic !== false,
    likeCount: Math.max(0, Number(photo.likeCount || 0)),
    imageUrl,
    thumbUrl,
  };
}

async function handleTogglePhotoLike(response, photoId, direction) {
  const db = getDb();
  const ref = db.collection(photosCollection).doc(photoId);

  const likeCount = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) {
      return null;
    }

    const currentCount = Math.max(0, Number(snapshot.data().likeCount || 0));
    const nextCount = direction === 'up'
      ? currentCount + 1
      : Math.max(0, currentCount - 1);

    transaction.update(ref, {
      likeCount: nextCount,
      updatedAt: new Date().toISOString(),
    });

    return nextCount;
  });

  if (likeCount === null) {
    sendJson(response, 404, { error: 'Photo not found.' });
    return;
  }

  invalidatePhotosCache();
  sendJson(response, 200, {
    ok: true,
    photoId,
    likeCount,
  });
}

async function verifyAdmin(request) {
  const authorization = request.headers.authorization || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';

  if (!token) {
    const error = new Error('Missing admin token.');
    error.statusCode = 401;
    throw error;
  }

  const cached = verifiedAdminCache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.admin;
  }

  let decoded;
  try {
    decoded = await getAdminAuth().verifyIdToken(token);
  } catch (verifyError) {
    const error = new Error(
      verifyError instanceof Error ? verifyError.message : 'Failed to verify Firebase ID token.',
    );
    error.statusCode = 401;
    throw error;
  }

  const email = String(decoded.email || '').toLowerCase();

  if (!email || decoded.email_verified !== true) {
    const error = new Error('Google account is not verified.');
    error.statusCode = 401;
    throw error;
  }

  if (allowedAdminEmails.length > 0 && !allowedAdminEmails.includes(email)) {
    const error = new Error('Admin account is not allowed.');
    error.statusCode = 403;
    throw error;
  }

  const admin = {
    email,
    name: decoded.name || decoded.email || '',
  };
  verifiedAdminCache.set(token, {
    admin,
    // Cache no longer than the token itself is valid.
    expiresAt: Math.min(Date.now() + verifiedAdminTtlMs, Number(decoded.exp || 0) * 1000),
  });

  return admin;
}

async function handleUploadPhoto(request, response) {
  const admin = await verifyAdmin(request);
  const contentType = String(request.headers['content-type'] || '').toLowerCase();
  let title = '';
  let note = '';
  let locationText = '';
  let capturedAt = '';
  let fileName = '';
  let coordinatesText = '';
  let mapsUrl = '';
  let mimeType = '';
  let buffer;

  if (contentType.includes('application/json')) {
    const body = await readJsonBody(request);
    title = body.title || '';
    note = body.note || '';
    locationText = body.locationText || '';
    capturedAt = body.capturedAt || '';
    fileName = body.fileName || '';
    coordinatesText = body.coordinatesText || '';
    mapsUrl = body.mapsUrl || '';

    if (!body.preview) {
      sendJson(response, 400, { error: 'Missing preview data.' });
      return;
    }

    const parsed = parseDataUrl(body.preview);
    mimeType = parsed.mimeType;
    buffer = parsed.buffer;
  } else {
    const metaHeader = String(request.headers['x-photo-meta'] || '');
    if (!metaHeader) {
      sendJson(response, 400, { error: 'Missing photo metadata.' });
      return;
    }

    const meta = JSON.parse(Buffer.from(metaHeader, 'base64').toString('utf8'));
    title = meta.title || '';
    note = meta.note || '';
    locationText = meta.locationText || '';
    capturedAt = meta.capturedAt || '';
    fileName = meta.fileName || '';
    coordinatesText = meta.coordinatesText || '';
    mapsUrl = meta.mapsUrl || '';
    mimeType = contentType || 'application/octet-stream';
    buffer = await readRawBody(request);
    if (!buffer.length) {
      sendJson(response, 400, { error: 'Missing image data.' });
      return;
    }
  }

  const extension = getExtension(mimeType, fileName);
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const existing = await findPhotoBySha256(sha256);

  if (existing) {
    const requestOrigin = getRequestOrigin(request);
    const existingPhoto = normalizePhotoMetadata(await ensurePhotoThumbnail(existing), requestOrigin);
    sendJson(response, 200, {
      ...existingPhoto,
      duplicate: true,
    });
    return;
  }

  const id = randomUUID();
  const storageName = `${id}${extension}`;
  const now = new Date().toISOString();
  const imageUrl = getPublicAssetUrl(getUploadObjectKey(storageName), `/uploads/${storageName}`);

  await writeUploadBuffer(storageName, buffer, mimeType);
  const thumbnailBuffer = await generateThumbnail(buffer);
  await writeThumbnailBuffer(id, thumbnailBuffer);
  await verifyStoredPhotoAssets(storageName, id);

  const record = {
    id,
    title: title || path.basename(fileName || storageName, extension),
    note,
    locationText,
    capturedAt,
    fileName: sanitizeFileName(fileName || storageName),
    mimeType,
    imageUrl,
    thumbUrl: getThumbnailUrl(id),
    coordinatesText,
    mapsUrl,
    createdAt: now,
    updatedAt: now,
    createdBy: admin.email,
    sha256,
    likeCount: 0,
    isPublic: true,
  };

  await savePhoto(record);
  const requestOrigin = getRequestOrigin(request);
  const verifiedRecord = normalizePhotoMetadata(await ensurePhotoThumbnail(record), requestOrigin);
  sendJson(response, 201, verifiedRecord);
}

async function handleUpdatePhoto(request, response, photoId) {
  await verifyAdmin(request);
  const body = await readJsonBody(request);
  const current = await getPhotoById(photoId);

  if (!current) {
    sendJson(response, 404, { error: 'Photo not found.' });
    return;
  }

  const updated = {
    ...current,
    title: body.title ?? current.title,
    note: body.note ?? current.note,
    locationText: body.locationText ?? current.locationText,
    capturedAt: body.capturedAt ?? current.capturedAt,
    coordinatesText: body.coordinatesText ?? current.coordinatesText,
    mapsUrl: body.mapsUrl ?? current.mapsUrl,
    likeCount:
      typeof body.likeCount === 'number'
        ? Math.max(0, Number(body.likeCount))
        : current.likeCount ?? 0,
    isPublic: typeof body.isPublic === 'boolean' ? body.isPublic : current.isPublic !== false,
    updatedAt: new Date().toISOString(),
  };

  await savePhoto(updated);
  const requestOrigin = getRequestOrigin(request);
  sendJson(response, 200, normalizePhotoMetadata(updated, requestOrigin));
}

async function handleDeletePhoto(request, response, photoId) {
  await verifyAdmin(request);
  const target = await getPhotoById(photoId);

  if (!target) {
    sendJson(response, 404, { error: 'Photo not found.' });
    return;
  }

  await deleteUploadBuffer(path.basename(target.imageUrl));
  await deleteThumbnailBuffer(photoId);
  await deletePhotoById(photoId);
  sendJson(response, 200, { ok: true });
}

async function handleBulkDeletePhotos(request, response) {
  await verifyAdmin(request);
  const body = await readJsonBody(request);
  const targetIds = Array.isArray(body?.photoIds)
    ? body.photoIds.map((value) => String(value).trim()).filter(Boolean)
    : [];

  if (targetIds.length === 0) {
    sendJson(response, 400, { error: 'Missing photo ids.' });
    return;
  }

  const targets = (await Promise.all(targetIds.map((id) => getPhotoById(id)))).filter(Boolean);

  if (targets.length === 0) {
    sendJson(response, 200, { ok: true, deletedCount: 0 });
    return;
  }

  await Promise.all(
    targets.map(async (photo) => {
      await Promise.allSettled([
        deleteUploadBuffer(path.basename(photo.imageUrl)),
        deleteThumbnailBuffer(photo.id),
      ]);
    }),
  );

  await deletePhotosByIds(targets.map((photo) => photo.id));
  sendJson(response, 200, { ok: true, deletedCount: targets.length });
}

async function handleDownloadPhoto(response, photoId) {
  const target = await getPhotoById(photoId);

  if (!target) {
    sendJson(response, 404, { error: 'Photo not found.' });
    return;
  }

  const buffer = await readUploadBuffer(path.basename(target.imageUrl));
  const image = sharp(buffer, { failOn: 'none' }).rotate();
  const downloadFormat = getDownloadFormat(target.mimeType, target.fileName);
  let output = image;

  if (downloadFormat.format === 'png') {
    output = output.png();
  } else if (downloadFormat.format === 'webp') {
    output = output.webp({ quality: 94 });
  } else {
    output = output.jpeg({ quality: 94, mozjpeg: true });
  }

  const rendered = await output.toBuffer();
  const baseName = (target.fileName?.replace(/\.[^.]+$/, '') || target.title || 'photo').trim();

  response.writeHead(200, {
    'Content-Type': downloadFormat.contentType,
    'Content-Disposition': `attachment; filename="${sanitizeFileName(
      `${baseName}${downloadFormat.extension}`,
    )}"`,
    'Cache-Control': 'no-store',
  });
  response.end(rendered);
}

function clampPublicPhotoLimit(value) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (Number.isNaN(parsed)) {
    return 60;
  }

  return Math.min(Math.max(parsed, 1), 120);
}

function clampPublicPhotoOffset(value) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    return 0;
  }

  return parsed;
}

async function handlePublicPhotos(request, response, url) {
  const requestOrigin = getRequestOrigin(request);
  const photos = (await readPhotosCached())
    .filter((photo) => photo?.isPublic !== false)
    .map((photo) => normalizePhotoMetadata(photo, requestOrigin));
  const sorted = [...photos].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const settings = await readSettings();
  const hasPaging = url.searchParams.has('offset') || url.searchParams.has('limit');
  const offset = hasPaging ? clampPublicPhotoOffset(url.searchParams.get('offset')) : 0;
  const limit = hasPaging ? clampPublicPhotoLimit(url.searchParams.get('limit')) : sorted.length;
  const items = sorted.slice(offset, offset + limit);

  sendJson(response, 200, {
    siteTitle: settings.siteTitle || defaultSiteTitle,
    totalCount: sorted.length,
    offset,
    limit,
    hasMore: offset + items.length < sorted.length,
    photos: items,
  });
}

async function handleAdminPhotos(request, response) {
  const requestOrigin = getRequestOrigin(request);
  const photos = (await readPhotos())
    .map((photo) => normalizePhotoMetadata(photo, requestOrigin));
  const sorted = [...photos].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const settings = await readSettings();
  sendJson(response, 200, {
    siteTitle: settings.siteTitle || defaultSiteTitle,
    photos: sorted,
  });
}

async function handleGetSettings(request, response) {
  if (request.url?.startsWith('/api/admin/')) {
    await verifyAdmin(request);
  }

  const settings = await readSettings();
  sendJson(response, 200, settings);
}

async function handleUpdateSettings(request, response) {
  await verifyAdmin(request);
  const body = await readJsonBody(request);
  const current = await readSettings();
  const next = {
    ...current,
    siteTitle: String(body.siteTitle || current.siteTitle || defaultSiteTitle).trim(),
  };
  await writeSettings(next);
  sendJson(response, 200, next);
}

async function handleMigrationPhoto(request, response) {
  requireMigrationToken(request);

  const metaHeader = String(request.headers['x-photo-meta'] || '');
  if (!metaHeader) {
    sendJson(response, 400, { error: 'Missing photo metadata.' });
    return;
  }

  const meta = JSON.parse(Buffer.from(metaHeader, 'base64').toString('utf8'));
  const fileBuffer = await readRawBody(request);
  if (!fileBuffer.length) {
    sendJson(response, 400, { error: 'Missing image data.' });
    return;
  }

  const fileName = String(meta.fileName || '').trim();
  const mimeType = String(meta.mimeType || request.headers['content-type'] || 'application/octet-stream');
  const imagePathName = path.basename(meta.imageUrl || `${meta.id || randomUUID()}.jpg`);
  const photoId = String(meta.id || randomUUID()).trim();
  const now = new Date().toISOString();
  const imageUrl = getPublicAssetUrl(getUploadObjectKey(imagePathName), `/uploads/${imagePathName}`);

  await writeUploadBuffer(imagePathName, fileBuffer, mimeType);
  const thumbnailBuffer = await generateThumbnail(fileBuffer);
  await writeThumbnailBuffer(photoId, thumbnailBuffer);
  await verifyStoredPhotoAssets(imagePathName, photoId);

  const record = {
    id: photoId,
    title: meta.title || path.basename(fileName || imagePathName, path.extname(imagePathName)),
    note: meta.note || '',
    locationText: meta.locationText || '',
    capturedAt: meta.capturedAt || '',
    fileName: sanitizeFileName(fileName || imagePathName),
    mimeType,
    imageUrl,
    thumbUrl: getThumbnailUrl(photoId),
    coordinatesText: meta.coordinatesText || '',
    mapsUrl: meta.mapsUrl || '',
    createdAt: meta.createdAt || now,
    updatedAt: meta.updatedAt || meta.createdAt || now,
    createdBy: meta.createdBy || 'migration',
    sha256: meta.sha256 || createHash('sha256').update(fileBuffer).digest('hex'),
    likeCount: Math.max(0, Number(meta.likeCount || 0)),
    isPublic: meta.isPublic !== false,
  };

  await savePhoto(record);
  sendJson(response, 200, { ok: true, photo: record });
}

async function handleMigrationSettings(request, response) {
  requireMigrationToken(request);
  const body = await readJsonBody(request);
  const next = {
    siteTitle: String(body.siteTitle || defaultSiteTitle).trim(),
  };
  await writeSettings(next);
  sendJson(response, 200, next);
}

async function handleStorageDebug(request, response) {
  requireMigrationToken(request);

  await ensureDataFiles();
  const photos = await readPhotos();
  const settings = await readSettings();
  const uploadChecks = await Promise.all(
    photos.map(async (photo) => {
      const uploadMissing = r2Enabled
        ? !(await objectExists(getUploadObjectKey(path.basename(photo.imageUrl || ''))))
        : await stat(path.join(uploadsDir, path.basename(photo.imageUrl || '')))
            .then(() => false)
            .catch(() => true);
      const thumbnailMissing = r2Enabled
        ? !(await objectExists(getThumbnailObjectKey(photo.id)))
        : await stat(path.join(thumbnailsDir, getThumbnailName(photo.id)))
            .then(() => false)
            .catch(() => true);

      if (!uploadMissing && !thumbnailMissing) {
        return null;
      }

      return {
        id: photo.id,
        fileName: photo.fileName,
        imageUrl: photo.imageUrl,
        uploadMissing,
        thumbnailMissing,
      };
    }),
  );

  const missingUploads = uploadChecks.filter(Boolean);

  sendJson(response, 200, {
    storageBackend: r2Enabled ? 'r2' : 'local',
    bucketName: r2Enabled ? r2BucketName : '',
    publicBaseUrl: r2Enabled ? r2PublicBaseUrl : '',
    dataDir,
    uploadsDir,
    thumbnailsDir,
    siteTitle: settings.siteTitle || defaultSiteTitle,
    photoCount: photos.length,
    missingUploadCount: missingUploads.length,
    missingUploads: missingUploads.slice(0, 50),
  });
}

async function handlePublicStatus(response) {
  let storageOk = false;
  let storageMessage = '';

  try {
    await ensureDataFiles();

    if (r2Enabled) {
      // Listing succeeds even on an empty bucket; failure indicates a real issue.
      await getStorageUsageSummary();
      storageOk = true;
      storageMessage = 'Cloudflare R2 연결 정상';
    } else {
      await stat(uploadsDir);
      storageOk = true;
      storageMessage = '로컬 저장소 사용 중';
    }
  } catch (error) {
    storageOk = false;
    storageMessage = error instanceof Error ? error.message : '저장소 상태를 확인하지 못했습니다.';
  }

  let databaseOk = false;
  let databaseMessage = '';

  try {
    await readSettings();
    databaseOk = true;
    databaseMessage = 'Firebase Firestore 연결 정상';
  } catch (error) {
    databaseOk = false;
    databaseMessage = error instanceof Error ? error.message : 'Firestore 상태를 확인하지 못했습니다.';
  }

  sendJson(response, 200, {
    ok: storageOk && databaseOk,
    render: {
      ok: true,
      message: 'Render API 응답 정상',
    },
    storage: {
      backend: r2Enabled ? 'r2' : 'local',
      provider: r2Enabled ? 'cloudflare-r2' : 'local',
      ok: storageOk,
      message: storageMessage,
    },
    database: {
      provider: 'firebase-firestore',
      ok: databaseOk,
      message: databaseMessage,
    },
    checkedAt: new Date().toISOString(),
  });
}

async function handleAdminStorageSummary(request, response) {
  await verifyAdmin(request);
  const summary = await getStorageUsageSummary();
  sendJson(response, 200, summary);
}

async function handleStaticUpload(response, pathname) {
  const fileName = path.basename(pathname);
  const extension = path.extname(fileName).toLowerCase();

  try {
    const buffer = await readUploadBuffer(fileName);
    response.writeHead(200, {
      'Content-Type': mimeTypes[extension] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    response.end(buffer);
  } catch {
    sendText(response, 404, 'Not found');
  }
}

async function handleStaticThumbnail(response, pathname) {
  const fileName = path.basename(pathname);

  try {
    let buffer;
    try {
      buffer = await readThumbnailBuffer(fileName);
    } catch (error) {
      if (!isMissingAssetError(error)) {
        throw error;
      }

      const photoId = fileName.replace(/\.webp$/i, '');
      if (!photoId || photoId === fileName) {
        throw error;
      }

      const photo = await getPhotoById(photoId);
      if (!photo) {
        throw error;
      }

      const sourceBuffer = await readUploadBuffer(path.basename(photo.imageUrl || ''));
      buffer = await generateThumbnail(sourceBuffer);
      await writeThumbnailBuffer(photo.id, buffer);
    }

    response.writeHead(200, {
      'Content-Type': 'image/webp',
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    response.end(buffer);
  } catch {
    sendText(response, 404, 'Not found');
  }
}

const server = createServer(async (request, response) => {
  setCorsHeaders(request, response);

  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host}`);
  const { pathname } = url;

  try {
    if (request.method === 'GET' && pathname === '/api/public/photos') {
      await handlePublicPhotos(request, response, url);
      return;
    }

    if (request.method === 'GET' && pathname === '/api/health') {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === 'GET' && pathname === '/api/public/status') {
      await handlePublicStatus(response);
      return;
    }

    if (request.method === 'GET' && pathname.startsWith('/api/public/photos/') && pathname.endsWith('/download')) {
      const photoId = pathname.split('/')[4];
      await handleDownloadPhoto(response, photoId);
      return;
    }

    if (request.method === 'POST' && pathname.startsWith('/api/public/photos/') && pathname.endsWith('/like')) {
      const photoId = pathname.split('/')[4];
      await handleTogglePhotoLike(response, photoId, 'up');
      return;
    }

    if (request.method === 'DELETE' && pathname.startsWith('/api/public/photos/') && pathname.endsWith('/like')) {
      const photoId = pathname.split('/')[4];
      await handleTogglePhotoLike(response, photoId, 'down');
      return;
    }

    if (request.method === 'GET' && pathname === '/api/public/settings') {
      await handleGetSettings(request, response);
      return;
    }

    if (request.method === 'GET' && pathname === '/api/admin/photos') {
      await verifyAdmin(request);
      await handleAdminPhotos(request, response);
      return;
    }

    if (request.method === 'GET' && pathname === '/api/admin/storage-summary') {
      await handleAdminStorageSummary(request, response);
      return;
    }

    if (request.method === 'GET' && pathname === '/api/admin/settings') {
      await handleGetSettings(request, response);
      return;
    }

    if (request.method === 'PATCH' && pathname === '/api/admin/settings') {
      await handleUpdateSettings(request, response);
      return;
    }

    if (request.method === 'POST' && pathname === '/api/internal/migrate/photos') {
      await handleMigrationPhoto(request, response);
      return;
    }

    if (request.method === 'POST' && pathname === '/api/internal/migrate/settings') {
      await handleMigrationSettings(request, response);
      return;
    }

    if (request.method === 'GET' && pathname === '/api/internal/debug/storage') {
      await handleStorageDebug(request, response);
      return;
    }

    if (request.method === 'POST' && pathname === '/api/admin/photos') {
      await handleUploadPhoto(request, response);
      return;
    }

    if (request.method === 'PATCH' && pathname.startsWith('/api/admin/photos/')) {
      const photoId = pathname.split('/').pop();
      await handleUpdatePhoto(request, response, photoId);
      return;
    }

    if (request.method === 'DELETE' && pathname.startsWith('/api/admin/photos/')) {
      const photoId = pathname.split('/').pop();
      await handleDeletePhoto(request, response, photoId);
      return;
    }

    if (request.method === 'POST' && pathname === '/api/admin/photos/bulk-delete') {
      await handleBulkDeletePhotos(request, response);
      return;
    }

    if (request.method === 'GET' && pathname.startsWith('/uploads/')) {
      await handleStaticUpload(response, pathname);
      return;
    }

    if (request.method === 'GET' && pathname.startsWith('/thumbnails/')) {
      await handleStaticThumbnail(response, pathname);
      return;
    }

    sendJson(response, 404, { error: 'Not found.' });
  } catch (error) {
    console.error(error);
    sendJson(response, error?.statusCode || 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

await ensureDataFiles();
server.listen(port, host, () => {
  console.log(`Photo gallery API listening on http://${host}:${port}`);
  console.log(`Photo gallery data directory: ${dataDir}`);
});
