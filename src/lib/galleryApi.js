import { loadAdminSession } from './googleAuth';

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

function createDetailedError(summary, details) {
  const message = [
    summary,
    ...details.filter(Boolean),
  ].join('\n');

  const error = new Error(message);
  error.name = 'ApiRequestError';
  return error;
}

function summarizeResponseText(text, maxLength = 180) {
  if (!text) {
    return '';
  }

  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }

  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}...`
    : normalized;
}

function toApiUrl(path) {
  if (!apiBaseUrl) {
    return path;
  }

  return `${apiBaseUrl}${path}`;
}

function toAbsoluteAssetUrl(assetUrl) {
  if (!assetUrl || /^https?:\/\//.test(assetUrl) || !apiBaseUrl) {
    return assetUrl;
  }

  return `${apiBaseUrl}${assetUrl}`;
}

function withAssetUrl(photo) {
  if (!photo) {
    return photo;
  }

  return {
    ...photo,
    imageUrl: toAbsoluteAssetUrl(photo.imageUrl),
    thumbUrl: toAbsoluteAssetUrl(photo.thumbUrl),
  };
}

async function request(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (!('Content-Type' in headers) && !('content-type' in headers) && options.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  const requestUrl = toApiUrl(path);
  const response = await fetch(requestUrl, {
    ...options,
    headers,
  });

  const text = await response.text();
  const contentType = response.headers.get('content-type') ?? '';
  const responsePreview = summarizeResponseText(text);
  const apiBaseState = apiBaseUrl || '(empty)';

  if (text && /^<!doctype html/i.test(text.trimStart())) {
    throw createDetailedError(
      'API 대신 HTML 문서를 받았습니다.',
      [
        `request=${requestUrl}`,
        `status=${response.status}`,
        `content-type=${contentType || 'unknown'}`,
        `VITE_API_BASE_URL=${apiBaseState}`,
        apiBaseUrl
          ? '가능한 원인: 배포된 프론트가 잘못된 백엔드 URL을 사용 중이거나, 프록시/리다이렉트가 HTML 페이지를 반환했습니다.'
          : '가능한 원인: GitHub Pages 빌드 시 VITE_API_BASE_URL이 비어 있어서 상대 경로 /api/... 로 요청했습니다.',
        responsePreview ? `response-preview=${responsePreview}` : '',
      ],
    );
  }

  if (text && !contentType.includes('application/json')) {
    throw createDetailedError(
      'JSON 응답이 아닙니다.',
      [
        `request=${requestUrl}`,
        `status=${response.status}`,
        `content-type=${contentType || 'unknown'}`,
        `VITE_API_BASE_URL=${apiBaseState}`,
        responsePreview ? `response-preview=${responsePreview}` : '',
      ],
    );
  }

  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (error) {
    throw createDetailedError(
      'JSON 파싱에 실패했습니다.',
      [
        `request=${requestUrl}`,
        `status=${response.status}`,
        `content-type=${contentType || 'unknown'}`,
        `VITE_API_BASE_URL=${apiBaseState}`,
        error instanceof Error ? `parse-error=${error.message}` : '',
        responsePreview ? `response-preview=${responsePreview}` : '',
      ],
    );
  }

  if (!response.ok) {
    throw createDetailedError(
      data?.error || `Request failed: ${response.status}`,
      [
        `request=${requestUrl}`,
        `status=${response.status}`,
        `content-type=${contentType || 'unknown'}`,
        `VITE_API_BASE_URL=${apiBaseState}`,
      ],
    );
  }

  return data;
}

function getAdminToken() {
  return loadAdminSession()?.credential ?? '';
}

export function getPublicPhotos() {
  return request('/api/public/photos').then((data) => (data?.photos ?? []).map(withAssetUrl));
}

export function getPublicSystemStatus() {
  return request('/api/public/status');
}

export function getAdminPhotos() {
  return request('/api/admin/photos', {
    headers: {
      Authorization: `Bearer ${getAdminToken()}`,
    },
  }).then((data) => (data?.photos ?? []).map(withAssetUrl));
}

export function getAdminStorageSummary() {
  return request('/api/admin/storage-summary', {
    headers: {
      Authorization: `Bearer ${getAdminToken()}`,
    },
  });
}

export function uploadAdminPhoto(payload) {
  const meta = typeof window !== 'undefined' ? window.btoa(unescape(encodeURIComponent(JSON.stringify(payload.meta)))) : '';

  return request('/api/admin/photos', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getAdminToken()}`,
      'Content-Type': payload.file.type || 'application/octet-stream',
      'X-Photo-Meta': meta,
    },
    body: payload.file,
  }).then(withAssetUrl);
}

export function updateAdminPhoto(photoId, payload) {
  return request(`/api/admin/photos/${photoId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${getAdminToken()}`,
    },
    body: JSON.stringify(payload),
  }).then(withAssetUrl);
}

export function deleteAdminPhoto(photoId) {
  return request(`/api/admin/photos/${photoId}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${getAdminToken()}`,
    },
  });
}

export function bulkDeleteAdminPhotos(photoIds) {
  return request('/api/admin/photos/bulk-delete', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getAdminToken()}`,
    },
    body: JSON.stringify({ photoIds }),
  });
}

export function getPhotoDownloadUrl(photo) {
  if (!photo?.id) {
    return '';
  }

  return toApiUrl(`/api/public/photos/${photo.id}/download`);
}
