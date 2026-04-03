import { createServer } from 'node:http';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.join(__dirname, 'data');
const uploadsDir = path.join(dataDir, 'uploads');
const photosFile = path.join(dataDir, 'photos.json');
const settingsFile = path.join(dataDir, 'settings.json');
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '127.0.0.1';
const allowedAdminEmails = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
const verifiedAdminCache = new Map();
const verifiedAdminTtlMs = 1000 * 60 * 10;

const mimeTypes = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
};
const downloadWatermark = 'totoriverce@naver.com';

async function ensureDataFiles() {
  await mkdir(uploadsDir, { recursive: true });
  try {
    await stat(photosFile);
  } catch {
    await writeFile(photosFile, '[]\n', 'utf8');
  }

  try {
    await stat(settingsFile);
  } catch {
    await writeFile(
      settingsFile,
      `${JSON.stringify({ siteTitle: "Photo's room" }, null, 2)}\n`,
      'utf8',
    );
  }
}

async function readPhotos() {
  await ensureDataFiles();
  const raw = await readFile(photosFile, 'utf8');
  return JSON.parse(raw);
}

async function writePhotos(photos) {
  await ensureDataFiles();
  await writeFile(photosFile, `${JSON.stringify(photos, null, 2)}\n`, 'utf8');
}

async function readSettings() {
  await ensureDataFiles();
  const raw = await readFile(settingsFile, 'utf8');
  return JSON.parse(raw);
}

async function writeSettings(settings) {
  await ensureDataFiles();
  await writeFile(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
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

function setCorsHeaders(response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Photo-Meta');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
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

function createWatermarkSvg(width, height) {
  const margin = Math.max(18, Math.round(Math.min(width, height) * 0.028));
  const fontSize = Math.max(18, Math.round(Math.min(width, height) * 0.022));
  const x = width - margin;
  const y = height - margin;

  return Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <defs>
        <filter id="text-shadow" x="-20%" y="-20%" width="160%" height="160%">
          <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#000000" flood-opacity="0.28"/>
        </filter>
      </defs>
      <text
        x="${x}"
        y="${y}"
        text-anchor="end"
        fill="rgba(255,255,255,0.94)"
        stroke="rgba(0,0,0,0.18)"
        stroke-width="0.6"
        paint-order="stroke"
        font-size="${fontSize}"
        font-family="'Didot','Bodoni 72','Cormorant Garamond','Times New Roman',serif"
        font-weight="700"
        letter-spacing="0.6"
        filter="url(#text-shadow)"
      >${escapeXml(downloadWatermark)}</text>
    </svg>
  `.trim());
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

async function verifyAdmin(request) {
  const authorization = request.headers.authorization || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';

  if (!token) {
    throw new Error('Missing admin token.');
  }

  const cached = verifiedAdminCache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.admin;
  }

  const response = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`,
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || 'Failed to verify Google ID token.');
  }

  const profile = await response.json();
  const email = String(profile.email || '').toLowerCase();

  if (!email || profile.email_verified !== 'true') {
    throw new Error('Google account is not verified.');
  }

  if (allowedAdminEmails.length > 0 && !allowedAdminEmails.includes(email)) {
    throw new Error('Admin account is not allowed.');
  }

  const admin = {
    email,
    name: profile.name || profile.email || '',
  };
  verifiedAdminCache.set(token, {
    admin,
    expiresAt: Date.now() + verifiedAdminTtlMs,
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
  const photos = await readPhotos();
  const existing = photos.find((photo) => photo.sha256 === sha256);

  if (existing) {
    sendJson(response, 200, {
      ...existing,
      duplicate: true,
    });
    return;
  }

  const id = randomUUID();
  const storageName = `${id}${extension}`;
  const storagePath = path.join(uploadsDir, storageName);
  const now = new Date().toISOString();

  await writeFile(storagePath, buffer);

  const record = {
    id,
    title: title || path.basename(fileName || storageName, extension),
    note,
    locationText,
    capturedAt,
    fileName: sanitizeFileName(fileName || storageName),
    mimeType,
    imageUrl: `/uploads/${storageName}`,
    coordinatesText,
    mapsUrl,
    createdAt: now,
    updatedAt: now,
    createdBy: admin.email,
    sha256,
  };

  photos.unshift(record);
  await writePhotos(photos);
  sendJson(response, 201, record);
}

async function handleUpdatePhoto(request, response, photoId) {
  await verifyAdmin(request);
  const body = await readJsonBody(request);
  const photos = await readPhotos();
  const index = photos.findIndex((photo) => photo.id === photoId);

  if (index === -1) {
    sendJson(response, 404, { error: 'Photo not found.' });
    return;
  }

  photos[index] = {
    ...photos[index],
    title: body.title ?? photos[index].title,
    note: body.note ?? photos[index].note,
    locationText: body.locationText ?? photos[index].locationText,
    capturedAt: body.capturedAt ?? photos[index].capturedAt,
    coordinatesText: body.coordinatesText ?? photos[index].coordinatesText,
    mapsUrl: body.mapsUrl ?? photos[index].mapsUrl,
    updatedAt: new Date().toISOString(),
  };

  await writePhotos(photos);
  sendJson(response, 200, photos[index]);
}

async function handleDeletePhoto(request, response, photoId) {
  await verifyAdmin(request);
  const photos = await readPhotos();
  const target = photos.find((photo) => photo.id === photoId);

  if (!target) {
    sendJson(response, 404, { error: 'Photo not found.' });
    return;
  }

  await rm(path.join(uploadsDir, path.basename(target.imageUrl)), { force: true });
  await writePhotos(photos.filter((photo) => photo.id !== photoId));
  sendJson(response, 200, { ok: true });
}

async function handleDownloadPhoto(response, photoId) {
  const photos = await readPhotos();
  const target = photos.find((photo) => photo.id === photoId);

  if (!target) {
    sendJson(response, 404, { error: 'Photo not found.' });
    return;
  }

  const filePath = path.join(uploadsDir, path.basename(target.imageUrl));
  const buffer = await readFile(filePath);
  const image = sharp(buffer, { failOn: 'none' }).rotate();
  const metadata = await image.metadata();
  const width = metadata.width || 1600;
  const height = metadata.height || 1200;
  const watermarkSvg = createWatermarkSvg(width, height);
  const downloadFormat = getDownloadFormat(target.mimeType, target.fileName);
  let output = image.composite([{ input: watermarkSvg, top: 0, left: 0 }]);

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
      `${baseName}-watermarked${downloadFormat.extension}`,
    )}"`,
    'Cache-Control': 'no-store',
  });
  response.end(rendered);
}

async function handlePublicPhotos(response) {
  const photos = await readPhotos();
  const sorted = [...photos].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const settings = await readSettings();
  sendJson(response, 200, {
    siteTitle: settings.siteTitle || "Photo's room",
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
    siteTitle: String(body.siteTitle || current.siteTitle || "Photo's room").trim(),
  };
  await writeSettings(next);
  sendJson(response, 200, next);
}

async function handleStaticUpload(response, pathname) {
  const fileName = path.basename(pathname);
  const filePath = path.join(uploadsDir, fileName);
  const extension = path.extname(fileName).toLowerCase();

  try {
    const buffer = await readFile(filePath);
    response.writeHead(200, {
      'Content-Type': mimeTypes[extension] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    response.end(buffer);
  } catch {
    sendText(response, 404, 'Not found');
  }
}

const server = createServer(async (request, response) => {
  setCorsHeaders(response);

  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host}`);
  const { pathname } = url;

  try {
    if (request.method === 'GET' && pathname === '/api/public/photos') {
      await handlePublicPhotos(response);
      return;
    }

    if (request.method === 'GET' && pathname.startsWith('/api/public/photos/') && pathname.endsWith('/download')) {
      const photoId = pathname.split('/')[4];
      await handleDownloadPhoto(response, photoId);
      return;
    }

    if (request.method === 'GET' && pathname === '/api/public/settings') {
      await handleGetSettings(request, response);
      return;
    }

    if (request.method === 'GET' && pathname === '/api/admin/photos') {
      await verifyAdmin(request);
      await handlePublicPhotos(response);
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

    if (request.method === 'GET' && pathname.startsWith('/uploads/')) {
      await handleStaticUpload(response, pathname);
      return;
    }

    sendJson(response, 404, { error: 'Not found.' });
  } catch (error) {
    console.error(error);
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

await ensureDataFiles();
server.listen(port, host, () => {
  console.log(`Photo gallery API listening on http://${host}:${port}`);
});
