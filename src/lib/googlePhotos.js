import { loadGoogleIdentityScript } from './googleAuth';

const GOOGLE_PHOTOS_SCOPES = [
  'https://www.googleapis.com/auth/photoslibrary.appendonly',
  'https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata',
].join(' ');

const API_BASE = 'https://photoslibrary.googleapis.com/v1';
const UPLOADS_URL = 'https://photoslibrary.googleapis.com/v1/uploads';
const TOKEN_STORAGE_KEY = 'google-photos-access-token';
let cachedToken = '';

export function getCachedPhotosToken() {
  if (cachedToken) {
    return cachedToken;
  }

  if (typeof window === 'undefined') {
    return '';
  }

  cachedToken = sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? '';
  return cachedToken;
}

export async function requestPhotosAccessToken(clientId) {
  const google = await loadGoogleIdentityScript();

  return new Promise((resolve, reject) => {
    const tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: GOOGLE_PHOTOS_SCOPES,
      callback: (response) => {
        if (response.error || !response.access_token) {
          reject(new Error(response.error || 'Failed to acquire Google Photos token.'));
          return;
        }

        cachedToken = response.access_token;
        if (typeof window !== 'undefined') {
          sessionStorage.setItem(TOKEN_STORAGE_KEY, response.access_token);
        }
        resolve(response.access_token);
      },
    });

    tokenClient.requestAccessToken({
      prompt: cachedToken ? '' : 'consent',
      include_granted_scopes: true,
    });
  });
}

export function clearCachedPhotosToken() {
  cachedToken = '';

  if (typeof window !== 'undefined') {
    sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  }
}

async function photosRequest(path, token, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers ?? {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Google Photos request failed: ${response.status}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

export async function ensureAlbum(token, title) {
  let nextPageToken = '';

  do {
    const query = new URLSearchParams({
      pageSize: '50',
      ...(nextPageToken ? { pageToken: nextPageToken } : {}),
    });
    const result = await photosRequest(`/albums?${query.toString()}`, token, {
      method: 'GET',
    });

    const album = result.albums?.find((item) => item.title === title);
    if (album) {
      return album;
    }

    nextPageToken = result.nextPageToken ?? '';
  } while (nextPageToken);

  const created = await photosRequest('/albums', token, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      album: { title },
    }),
  });

  return created;
}

export async function listAlbums(token) {
  const albums = [];
  let nextPageToken = '';

  do {
    const query = new URLSearchParams({
      pageSize: '50',
      ...(nextPageToken ? { pageToken: nextPageToken } : {}),
    });
    const result = await photosRequest(`/albums?${query.toString()}`, token, {
      method: 'GET',
    });

    albums.push(...(result.albums ?? []));
    nextPageToken = result.nextPageToken ?? '';
  } while (nextPageToken);

  return albums;
}

export async function listAlbumMediaItems(token, albumId) {
  const mediaItems = [];
  let nextPageToken = '';

  do {
    const result = await photosRequest('/mediaItems:search', token, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        albumId,
        pageSize: 100,
        ...(nextPageToken ? { pageToken: nextPageToken } : {}),
      }),
    });

    mediaItems.push(...(result.mediaItems ?? []));
    nextPageToken = result.nextPageToken ?? '';
  } while (nextPageToken);

  return mediaItems;
}

export async function listMediaItems(token) {
  const mediaItems = [];
  let nextPageToken = '';

  do {
    const query = new URLSearchParams({
      pageSize: '100',
      ...(nextPageToken ? { pageToken: nextPageToken } : {}),
    });
    const result = await photosRequest(`/mediaItems?${query.toString()}`, token, {
      method: 'GET',
    });

    mediaItems.push(...(result.mediaItems ?? []));
    nextPageToken = result.nextPageToken ?? '';
  } while (nextPageToken);

  return mediaItems;
}

export async function getMediaItem(token, mediaItemId) {
  return photosRequest(`/mediaItems/${mediaItemId}`, token, {
    method: 'GET',
  });
}

export function isSupportedMediaItem(mediaItem) {
  const mimeType = (mediaItem?.mimeType ?? '').toLowerCase();

  if (mimeType.startsWith('image/')) {
    return true;
  }

  const filename = (mediaItem?.filename ?? '').toLowerCase();
  return /\.(jpe?g|png|webp|heic|heif|gif|avif|bmp|tiff?)$/.test(filename);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read blob.'));
    reader.readAsDataURL(blob);
  });
}

export async function downloadMediaItemAsDataUrl(token, mediaItem) {
  const response = await fetch(`${mediaItem.baseUrl}=d`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Failed to download media item: ${response.status}`);
  }

  const blob = await response.blob();
  return blobToDataUrl(blob);
}

export function getMediaItemImageUrl(mediaItem, width = 1600, height = 1600) {
  if (!mediaItem?.baseUrl) {
    return '';
  }

  return `${mediaItem.baseUrl}=w${width}-h${height}`;
}

function dataUrlToBlob(dataUrl) {
  const [meta, data] = dataUrl.split(',');
  const mimeType = meta.match(/data:(.*?);base64/)?.[1] ?? 'image/jpeg';
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new Blob([bytes], { type: mimeType });
}

export async function uploadPhotoToAlbum(token, albumId, photo) {
  const blob = dataUrlToBlob(photo.preview);
  const uploadResponse = await fetch(UPLOADS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'X-Goog-Upload-Content-Type': blob.type,
      'X-Goog-Upload-File-Name': photo.fileName || `${photo.title}.jpg`,
      'X-Goog-Upload-Protocol': 'raw',
    },
    body: blob,
  });

  if (!uploadResponse.ok) {
    const body = await uploadResponse.text();
    throw new Error(body || `Upload bytes failed: ${uploadResponse.status}`);
  }

  const uploadToken = await uploadResponse.text();
  const result = await photosRequest('/mediaItems:batchCreate', token, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      albumId,
      newMediaItems: [
        {
          description: photo.locationText || photo.title,
          simpleMediaItem: {
            fileName: photo.fileName || `${photo.title}.jpg`,
            uploadToken,
          },
        },
      ],
    }),
  });

  const status = result.newMediaItemResults?.[0]?.status;
  if (status?.code && status.code !== 0) {
    throw new Error(status.message || 'Failed to create Google Photos media item.');
  }

  return result.newMediaItemResults?.[0]?.mediaItem ?? null;
}
