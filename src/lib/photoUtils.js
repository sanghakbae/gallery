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

export function getGoogleMapsUrl(latitude, longitude) {
  if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    return '';
  }

  return `https://www.google.com/maps?q=${latitude},${longitude}`;
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
