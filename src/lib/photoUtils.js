export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function formatDate(value) {
  if (!value) {
    return '';
  }

  const date = new Date(value);

  return new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(date);
}

export function formatCoordinates(latitude, longitude) {
  if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    return '';
  }

  return `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
}

export function getLocationLabel(latitude, longitude) {
  if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    return '';
  }

  const ns = latitude >= 0 ? 'N' : 'S';
  const ew = longitude >= 0 ? 'E' : 'W';
  return `${Math.abs(latitude).toFixed(4)}°${ns}, ${Math.abs(longitude).toFixed(4)}°${ew}`;
}

export function createDefaultLocationText(latitude, longitude, capturedAt = '') {
  if (typeof latitude === 'number' && typeof longitude === 'number') {
    if (capturedAt) {
      const date = new Date(capturedAt);
      if (!Number.isNaN(date.getTime())) {
        return `${getSeasonLabel(date)} 위치 기록`;
      }
    }

    return '지도 위치 기록';
  }

  return '';
}

export function getGoogleMapsUrl(latitude, longitude) {
  if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    return '';
  }

  return `https://www.google.com/maps?q=${latitude},${longitude}`;
}

export function extractGoogleMapsUrl(value) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }

  const match = text.match(/https?:\/\/[^\s]+/i);
  if (!match) {
    return '';
  }

  try {
    const url = new URL(match[0]);
    const hostname = url.hostname.toLowerCase();
    const isGoogleMapsHost =
      hostname === 'google.com'
      || hostname.endsWith('.google.com')
      || hostname === 'goo.gl'
      || hostname === 'maps.app.goo.gl';

    if (!isGoogleMapsHost) {
      return '';
    }

    return url.toString();
  } catch {
    return '';
  }
}

export function normalizeLocationFields(locationText = '', mapsUrl = '') {
  const nextLocationText = String(locationText || '').trim();
  const nextMapsUrl = String(mapsUrl || '').trim();
  const detectedMapsUrl = extractGoogleMapsUrl(nextLocationText);

  if (detectedMapsUrl) {
    return {
      locationText: 'Google Maps 위치',
      mapsUrl: detectedMapsUrl,
    };
  }

  return {
    locationText: nextLocationText,
    mapsUrl: nextMapsUrl,
  };
}

export function getSeasonLabel(dateValue) {
  const month = new Date(dateValue).getMonth() + 1;

  if ([3, 4, 5].includes(month)) {
    return '봄 여행';
  }
  if ([6, 7, 8].includes(month)) {
    return '여름 여행';
  }
  if ([9, 10, 11].includes(month)) {
    return '가을 여행';
  }
  return '겨울 여행';
}

export function isCoordinateLikeLocation(value) {
  return /°[NS],\s*\d+(\.\d+)?°[EW]/.test(String(value || ''));
}

export function looksLikeMachineTitle(value) {
  const title = String(value || '').trim();
  if (!title) {
    return true;
  }

  if (/[가-힣]/.test(title)) {
    return false;
  }

  if (/\s/.test(title)) {
    return false;
  }

  return /^[A-Za-z0-9_-]{12,}$/.test(title);
}

export function createDefaultPhotoTitle({ fileName = '', capturedAt = '', locationText = '' } = {}) {
  const cleanFileName = String(fileName || '').replace(/\.[^.]+$/, '').trim();
  const hasUsefulFileName = cleanFileName && !looksLikeMachineTitle(cleanFileName);
  const hasUsefulLocation = locationText && !isCoordinateLikeLocation(locationText);

  if (hasUsefulFileName) {
    return cleanFileName;
  }

  if (capturedAt) {
    const date = new Date(capturedAt);
    if (!Number.isNaN(date.getTime())) {
      const month = date.getMonth() + 1;
      if (hasUsefulLocation) {
        return `${month}월 ${locationText} 기록`;
      }

      return `${month}월의 ${getSeasonLabel(date)}`;
    }
  }

  if (hasUsefulLocation) {
    return `${locationText} 기록`;
  }

  return '여행 기록';
}

export function getDisplayPhotoTitle(photo) {
  const storedTitle = String(photo?.title || '').trim();
  if (storedTitle && !looksLikeMachineTitle(storedTitle)) {
    return storedTitle;
  }

  return createDefaultPhotoTitle({
    fileName: photo?.fileName,
    capturedAt: photo?.capturedAt,
    locationText: photo?.locationText,
  });
}
