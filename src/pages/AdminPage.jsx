import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import exifr from 'exifr';
import { CheckSquare, LoaderCircle, LogOut, PencilLine, ShieldCheck, Square, Trash2, Upload, X } from 'lucide-react';
import {
  clearAdminSession,
  decodeJwt,
  getConfiguredAdminEmails,
  isAllowedAdminEmail,
  loadAdminSession,
  loadGoogleIdentityScript,
  saveAdminSession,
} from '../lib/googleAuth';
import {
  bulkDeleteAdminPhotos,
  deleteAdminPhoto,
  getAdminPhotos,
  getAdminStorageSummary,
  updateAdminPhoto,
  uploadAdminPhoto,
} from '../lib/galleryApi';
import {
  createDefaultPhotoTitle,
  extractGoogleMapsUrl,
  formatCoordinates,
  formatDate,
  getGoogleMapsUrl,
  getDisplayPhotoTitle,
  getLocationLabel,
  normalizeLocationFields,
  getSeasonLabel,
} from '../lib/photoUtils';

const GOOGLE_CLIENT_ID =
  import.meta.env.VITE_GOOGLE_CLIENT_ID ||
  '924920443826-k59m97pgabmdb42qv9cq63plmuuvvn7s.apps.googleusercontent.com';
const ACCEPTED_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

function isSupportedUploadFile(file) {
  const mimeType = (file.type ?? '').toLowerCase();
  if (ACCEPTED_TYPES.has(mimeType) || mimeType.startsWith('image/')) {
    return true;
  }

  return /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name ?? '');
}

function canRenderPreviewInBrowser(file) {
  const mimeType = (file.type ?? '').toLowerCase();
  if (mimeType === 'image/heic' || mimeType === 'image/heif') {
    return false;
  }

  return !/\.(heic|heif)$/i.test(file.name ?? '');
}

function isMobileUploadEnvironment() {
  if (typeof window === 'undefined') {
    return false;
  }

  const userAgent = navigator.userAgent || '';
  const agentMobile = /Android|iPhone|iPad|iPod|Mobile|CriOS|FxiOS|SamsungBrowser/i.test(userAgent);
  const coarsePointer =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(hover: none) and (pointer: coarse)').matches
      : false;

  return agentMobile || coarsePointer;
}

const uploadConcurrency = 3;
const UPLOAD_RECOVERY_KEY = 'photo-upload-recovery';
const SIMILAR_HASH_DISTANCE = 4;
const MOBILE_METADATA_CONCURRENCY = 1;
const MOBILE_UPLOAD_CONCURRENCY = 2;
const MOBILE_SKIP_SIMILAR_SCAN_THRESHOLD = 12;
const EXIF_PICK_FIELDS = [
  'DateTimeOriginal',
  'CreateDate',
  'ModifyDate',
  'latitude',
  'longitude',
  'lat',
  'lon',
  'GPSLatitude',
  'GPSLongitude',
  'GPSLatitudeRef',
  'GPSLongitudeRef',
];

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runNext() {
    const currentIndex = cursor;
    cursor += 1;

    if (currentIndex >= items.length) {
      return;
    }

    results[currentIndex] = await worker(items[currentIndex], currentIndex);
    await runNext();
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => runNext(),
  );

  await Promise.all(workers);
  return results;
}

function toIsoDateOrEmpty(value) {
  if (!value) {
    return '';
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function toDecimalCoordinate(value, ref) {
  if (typeof value === 'number') {
    return value;
  }

  if (Array.isArray(value) && value.length === 3) {
    const [degrees, minutes, seconds] = value.map((entry) => Number(entry || 0));
    if ([degrees, minutes, seconds].some((entry) => Number.isNaN(entry))) {
      return null;
    }

    const absolute = Math.abs(degrees) + (minutes / 60) + (seconds / 3600);
    const direction = String(ref || '').toUpperCase();
    return direction === 'S' || direction === 'W' ? -absolute : absolute;
  }

  return null;
}

function extractCoordinates(metadata) {
  const latitude =
    metadata?.latitude ??
    metadata?.lat ??
    toDecimalCoordinate(metadata?.GPSLatitude, metadata?.GPSLatitudeRef);
  const longitude =
    metadata?.longitude ??
    metadata?.lon ??
    toDecimalCoordinate(metadata?.GPSLongitude, metadata?.GPSLongitudeRef);

  return {
    latitude: typeof latitude === 'number' && !Number.isNaN(latitude) ? latitude : null,
    longitude: typeof longitude === 'number' && !Number.isNaN(longitude) ? longitude : null,
  };
}

async function parseUploadExifMetadata(file) {
  const quickMetadata = await exifr.parse(file, {
    chunked: true,
    firstChunkSize: 65536,
    firstChunkSizeNode: 65536,
    reviveValues: false,
    sanitize: true,
    pick: EXIF_PICK_FIELDS,
  });

  let metadata = quickMetadata ?? {};
  let { latitude, longitude } = extractCoordinates(metadata);
  let capturedDate =
    metadata?.DateTimeOriginal ??
    metadata?.CreateDate ??
    metadata?.ModifyDate ??
    null;

  if (latitude === null || longitude === null || !capturedDate) {
    const fullMetadata = await exifr.parse(file, {
      reviveValues: false,
      sanitize: true,
      pick: EXIF_PICK_FIELDS,
    });

    if (fullMetadata) {
      metadata = fullMetadata;
      ({ latitude, longitude } = extractCoordinates(fullMetadata));
      capturedDate =
        fullMetadata?.DateTimeOriginal ??
        fullMetadata?.CreateDate ??
        fullMetadata?.ModifyDate ??
        capturedDate;
    }
  }

  return {
    latitude,
    longitude,
    capturedDate,
  };
}

async function computeFileSha256(file) {
  const buffer = await file.arrayBuffer();
  const digest = await window.crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function getHammingDistance(left, right) {
  if (!left || !right || left.length !== right.length) {
    return Number.POSITIVE_INFINITY;
  }

  let distance = 0;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      distance += 1;
    }
  }
  return distance;
}

async function computeVisualHash(file) {
  const imageUrl = URL.createObjectURL(file);

  try {
    const image = await new Promise((resolve, reject) => {
      const nextImage = new Image();
      nextImage.onload = () => resolve(nextImage);
      nextImage.onerror = () => reject(new Error(`이미지를 읽지 못했습니다: ${file.name}`));
      nextImage.src = imageUrl;
    });

    const canvas = document.createElement('canvas');
    canvas.width = 9;
    canvas.height = 8;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      throw new Error('브라우저 캔버스를 초기화하지 못했습니다.');
    }

    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let hash = '';

    for (let row = 0; row < canvas.height; row += 1) {
      for (let column = 0; column < canvas.width - 1; column += 1) {
        const leftOffset = (row * canvas.width + column) * 4;
        const rightOffset = (row * canvas.width + column + 1) * 4;
        const leftLuma = data[leftOffset] * 0.299 + data[leftOffset + 1] * 0.587 + data[leftOffset + 2] * 0.114;
        const rightLuma = data[rightOffset] * 0.299 + data[rightOffset + 1] * 0.587 + data[rightOffset + 2] * 0.114;
        hash += leftLuma >= rightLuma ? '1' : '0';
      }
    }

    return hash;
  } finally {
    URL.revokeObjectURL(imageUrl);
  }
}

function computeVisualHashFromImage(image) {
  const canvas = document.createElement('canvas');
  canvas.width = 9;
  canvas.height = 8;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    throw new Error('브라우저 캔버스를 초기화하지 못했습니다.');
  }

  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  let hash = '';

  for (let row = 0; row < canvas.height; row += 1) {
    for (let column = 0; column < canvas.width - 1; column += 1) {
      const leftOffset = (row * canvas.width + column) * 4;
      const rightOffset = (row * canvas.width + column + 1) * 4;
      const leftLuma = data[leftOffset] * 0.299 + data[leftOffset + 1] * 0.587 + data[leftOffset + 2] * 0.114;
      const rightLuma = data[rightOffset] * 0.299 + data[rightOffset + 1] * 0.587 + data[rightOffset + 2] * 0.114;
      hash += leftLuma >= rightLuma ? '1' : '0';
    }
  }

  return hash;
}

async function loadImageFromUrls(urls) {
  let lastErrorUrl = '';

  for (const url of urls.filter(Boolean)) {
    try {
      const image = await new Promise((resolve, reject) => {
        const nextImage = new Image();
        nextImage.crossOrigin = 'anonymous';
        nextImage.onload = () => resolve(nextImage);
        nextImage.onerror = () => reject(new Error(`이미지를 읽지 못했습니다: ${url}`));
        nextImage.src = url;
      });

      return image;
    } catch {
      lastErrorUrl = url;
    }
  }

  throw new Error(`이미지를 읽지 못했습니다: ${lastErrorUrl}`);
}

async function computeVisualHashFromUrls(urls) {
  const image = await loadImageFromUrls(urls);
  return computeVisualHashFromImage(image);
}

function mergeUniquePhotos(photos) {
  const seen = new Set();
  const unique = [];

  for (const photo of photos) {
    if (!photo?.id || seen.has(photo.id)) {
      continue;
    }

    seen.add(photo.id);
    unique.push(photo);
  }

  return unique;
}

function revokePreviewUrls(items) {
  for (const item of items ?? []) {
    if (item?.previewUrl) {
      URL.revokeObjectURL(item.previewUrl);
    }
  }
}

function formatStorageSize(totalBytes) {
  const value = Number(totalBytes || 0);
  if (value < 1024) {
    return `${value} B`;
  }

  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function AdminLogin({ error, loading, onLogin, buttonContainerRef }) {
  return (
    <div className="admin-login-card">
      <p className="eyebrow">Admin</p>
      <h1>관리자 페이지</h1>
      <p className="hero-text">
        관리자만 Google 계정으로 로그인해 사진을 관리할 수 있습니다.
      </p>
      <div className="admin-login-actions">
        <div ref={buttonContainerRef} className="google-login-slot" />
      </div>
      {error ? <p className="error-banner admin-error">{error}</p> : null}
      <p className="admin-hint">
        허용된 관리자 계정으로만 로그인할 수 있습니다.
      </p>
      <Link className="admin-back-link" to="/">
        공개 갤러리로 돌아가기
      </Link>
    </div>
  );
}

export default function AdminPage() {
  const googleButtonRef = useRef(null);
  const fileInputRef = useRef(null);
  const [session, setSession] = useState(() => loadAdminSession());
  const [photos, setPhotos] = useState([]);
  const [storageSummary, setStorageSummary] = useState({
    totalBytes: 0,
    objectCount: 0,
    backend: '',
  });
  const [loading, setLoading] = useState(true);
  const [authLoading, setAuthLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [preparingUpload, setPreparingUpload] = useState(false);
  const [scanningSimilar, setScanningSimilar] = useState(false);
  const [deletingSimilar, setDeletingSimilar] = useState(false);
  const [similarScanProgress, setSimilarScanProgress] = useState({
    current: 0,
    total: 0,
    title: '',
    detail: '',
  });
  const [uploadProgress, setUploadProgress] = useState({
    current: 0,
    total: 0,
    fileTotal: 0,
    initialPhotoCount: 0,
    title: '',
    detail: '',
    uploaded: 0,
    duplicate: 0,
    failed: 0,
  });
  const [pendingUploadBatch, setPendingUploadBatch] = useState(null);
  const [similarGroups, setSimilarGroups] = useState([]);
  const [selectedSimilarIds, setSelectedSimilarIds] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }

    try {
      const raw = window.sessionStorage.getItem(UPLOAD_RECOVERY_KEY);
      if (!raw) {
        return undefined;
      }

      const recovery = JSON.parse(raw);
      if (recovery?.interrupted && Array.isArray(recovery.fileNames) && recovery.fileNames.length > 0) {
        setError(
          `새로고침으로 업로드가 중단되었습니다. 같은 파일 ${recovery.fileNames.length}개를 다시 선택하면 이미 성공한 항목은 건너뛰고 이어서 업로드할 수 있습니다.`,
        );
      }
    } catch {
      // Ignore corrupted recovery state.
    }

    return undefined;
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !uploading) {
      return undefined;
    }

    function handleBeforeUnload(event) {
      try {
        const raw = window.sessionStorage.getItem(UPLOAD_RECOVERY_KEY);
        const current = raw ? JSON.parse(raw) : {};
        window.sessionStorage.setItem(
          UPLOAD_RECOVERY_KEY,
          JSON.stringify({
            ...current,
            interrupted: true,
          }),
        );
      } catch {
        // Ignore storage errors.
      }

      event.preventDefault();
      event.returnValue = '';
    }

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [uploading]);

  useEffect(() => {
    async function loadPhotos() {
      if (!session?.credential) {
        setPhotos([]);
        setLoading(false);
        return;
      }

      try {
        const [photosResult, summaryResult] = await Promise.allSettled([
          getAdminPhotos(),
          getAdminStorageSummary(),
        ]);

        if (photosResult.status !== 'fulfilled') {
          throw photosResult.reason;
        }

        const result = photosResult.value;
        setPhotos(mergeUniquePhotos(result));

        if (summaryResult.status === 'fulfilled') {
          const summary = summaryResult.value;
          setStorageSummary({
            totalBytes: Number(summary?.totalBytes || 0),
            objectCount: Number(summary?.objectCount || 0),
            backend: String(summary?.backend || ''),
          });
        } else {
          console.warn('Storage summary is unavailable.', summaryResult.reason);
          setStorageSummary({
            totalBytes: 0,
            objectCount: 0,
            backend: '',
          });
        }
      } catch (loadError) {
        console.error(loadError);
        if (isAuthFailure(loadError)) {
          handleAuthExpired();
          return;
        }
        setError(loadError instanceof Error ? loadError.message : '사진 목록을 불러오지 못했습니다.');
      } finally {
        setLoading(false);
      }
    }

    loadPhotos();
  }, [session]);

  async function renderGoogleButton() {
    if (!GOOGLE_CLIENT_ID) {
      setError('Google 로그인 설정이 없습니다. .env.local에 VITE_GOOGLE_CLIENT_ID를 추가해 주세요.');
      return;
    }

    setAuthLoading(true);
    setError('');

    try {
      const google = await loadGoogleIdentityScript();
      if (!googleButtonRef.current) {
        return;
      }

      google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: (response) => {
          const profile = decodeJwt(response.credential);
          if (!profile?.email) {
            setError('Google 계정 정보를 확인할 수 없습니다.');
            return;
          }

          if (!isAllowedAdminEmail(profile.email)) {
            const configuredAdminEmails = getConfiguredAdminEmails();
            setError(
              configuredAdminEmails.length > 0
                ? [
                    `허용되지 않은 관리자 계정입니다: ${profile.email}`,
                    '배포 프론트의 `VITE_ADMIN_EMAILS`와 서버의 `ADMIN_EMAILS`에 이 이메일이 포함되어 있는지 확인해 주세요.',
                  ].join('\n')
                : `허용되지 않은 관리자 계정입니다: ${profile.email}`,
            );
            return;
          }

          saveAdminSession(profile, response.credential);
          setSession({ ...profile, credential: response.credential });
          setLoading(true);
          setError('');
        },
      });

      googleButtonRef.current.innerHTML = '';
      google.accounts.id.renderButton(googleButtonRef.current, {
        type: 'standard',
        theme: 'outline',
        size: 'large',
        shape: 'pill',
        text: 'signin_with',
        width: 280,
      });
    } catch (scriptError) {
      console.error(scriptError);
      setError('Google 로그인 버튼을 불러오지 못했습니다.');
    } finally {
      setAuthLoading(false);
    }
  }

  useEffect(() => {
    if (!session) {
      renderGoogleButton();
    }
  }, [session]);

  const sortedPhotos = useMemo(
    () => [...photos].sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    [photos],
  );
  const publicPhotoCount = useMemo(
    () => photos.filter((photo) => photo.isPublic !== false).length,
    [photos],
  );
  const privatePhotoCount = photos.length - publicPhotoCount;
  const publishedSelectionCount = uploadProgress.uploaded + uploadProgress.duplicate;
  const publishedSelectionPercent = uploadProgress.fileTotal > 0
    ? Math.round((publishedSelectionCount / uploadProgress.fileTotal) * 100)
    : 0;

  function isAuthFailure(error) {
    return error instanceof Error
      && (error.message.includes('status=401') || error.message.includes('invalid_token'));
  }

  function handleAuthExpired(message = '로그인 세션이 만료되었습니다. 다시 로그인해 주세요.') {
    clearAdminSession();
    setSession(null);
    setPhotos([]);
    setUploading(false);
    setError(message);
  }

  function clearPendingUploadBatch() {
    setPendingUploadBatch((current) => {
      if (current) {
        revokePreviewUrls(current.items);
      }
      return null;
    });
  }

  async function startUpload(preparedFiles) {
    setError('');
    setUploading(true);
    setUploadProgress({
      current: 0,
      total: preparedFiles.length * 2,
      fileTotal: preparedFiles.length,
      initialPhotoCount: photos.length,
      title: '',
      detail: '업로드 준비 중',
      uploaded: 0,
      duplicate: 0,
      failed: 0,
    });

    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem(
        UPLOAD_RECOVERY_KEY,
        JSON.stringify({
          interrupted: false,
          fileNames: preparedFiles.map((item) => item.file.name),
        }),
      );
    }

    try {
      const effectiveUploadConcurrency = isMobileUploadEnvironment()
        ? MOBILE_UPLOAD_CONCURRENCY
        : uploadConcurrency;
      let completedUploadCount = 0;
      let uploadedCount = 0;
      let duplicateCount = 0;
      let failedCount = 0;
      const uploadedPhotos = await mapWithConcurrency(preparedFiles, effectiveUploadConcurrency, async (item) => {
        if (item.isDuplicate) {
          completedUploadCount += 1;
          duplicateCount += 1;
          setUploadProgress({
            current: preparedFiles.length + completedUploadCount,
            total: preparedFiles.length * 2,
            fileTotal: preparedFiles.length,
            title: item.file.name,
            detail: `업로드 ${uploadedCount} · 중복 ${duplicateCount} · 실패 ${failedCount}`,
            uploaded: uploadedCount,
            duplicate: duplicateCount,
            failed: failedCount,
          });

          return {
            ok: true,
            photo: null,
            duplicate: true,
          };
        }

        try {
          const savedPhoto = await uploadAdminPhoto(item);
          completedUploadCount += 1;
          if (savedPhoto?.duplicate) {
            duplicateCount += 1;
          } else {
            uploadedCount += 1;
            setPhotos((current) => mergeUniquePhotos([savedPhoto, ...current]));
          }
          setUploadProgress({
            current: preparedFiles.length + completedUploadCount,
            total: preparedFiles.length * 2,
            fileTotal: preparedFiles.length,
            title: item.file.name,
            detail: `업로드 ${uploadedCount} · 중복 ${duplicateCount} · 실패 ${failedCount}`,
            uploaded: uploadedCount,
            duplicate: duplicateCount,
            failed: failedCount,
          });

          return {
            ok: true,
            photo: savedPhoto,
            duplicate: Boolean(savedPhoto?.duplicate),
          };
        } catch (uploadError) {
          if (isAuthFailure(uploadError)) {
            throw uploadError;
          }

          completedUploadCount += 1;
          failedCount += 1;
          setUploadProgress({
            current: preparedFiles.length + completedUploadCount,
            total: preparedFiles.length * 2,
            fileTotal: preparedFiles.length,
            title: item.file.name,
            detail: `업로드 ${uploadedCount} · 중복 ${duplicateCount} · 실패 ${failedCount}`,
            uploaded: uploadedCount,
            duplicate: duplicateCount,
            failed: failedCount,
          });

          return {
            ok: false,
            fileName: item.file.name,
          };
        }
      });

      if (failedCount > 0) {
        setError(
          `업로드 완료 ${uploadedCount}개, 실패 ${failedCount}개${
            duplicateCount > 0 ? `, 중복 건너뜀 ${duplicateCount}개` : ''
          }. 같은 파일을 다시 선택하면 이어서 업로드할 수 있습니다.`,
        );
        if (typeof window !== 'undefined') {
          window.sessionStorage.setItem(
            UPLOAD_RECOVERY_KEY,
            JSON.stringify({
              interrupted: true,
              fileNames: preparedFiles.map((item) => item.file.name),
            }),
          );
        }
      } else if (duplicateCount > 0) {
        setError(`중복 파일 ${duplicateCount}개는 건너뛰었습니다. 같은 파일을 다시 선택해도 이미 올라간 사진은 중복 저장되지 않습니다.`);
        if (typeof window !== 'undefined') {
          window.sessionStorage.removeItem(UPLOAD_RECOVERY_KEY);
        }
      } else if (typeof window !== 'undefined') {
        window.sessionStorage.removeItem(UPLOAD_RECOVERY_KEY);
      }
    } catch (uploadError) {
      console.error(uploadError);
      if (isAuthFailure(uploadError)) {
        handleAuthExpired();
        return;
      }
      setError(uploadError instanceof Error ? uploadError.message : '사진 업로드 중 문제가 발생했습니다.');
      if (typeof window !== 'undefined') {
        try {
          const raw = window.sessionStorage.getItem(UPLOAD_RECOVERY_KEY);
          const current = raw ? JSON.parse(raw) : {};
          window.sessionStorage.setItem(
            UPLOAD_RECOVERY_KEY,
            JSON.stringify({
              ...current,
              interrupted: true,
            }),
          );
        } catch {
          // Ignore storage errors.
        }
      }
    } finally {
      setUploading(false);
      setUploadProgress((current) => ({
        ...current,
        title: '',
        detail: '',
      }));
    }
  }

  async function handleUpload(event) {
    const selectedFiles = Array.from(event.target.files ?? []);
    if (selectedFiles.length === 0) {
      return;
    }

    setError('');
    setPreparingUpload(true);
    setUploadProgress({
      current: 0,
      total: selectedFiles.length * 2,
      fileTotal: selectedFiles.length,
      initialPhotoCount: photos.length,
      title: '',
      detail: '업로드 준비 중',
      uploaded: 0,
      duplicate: 0,
      failed: 0,
    });

    try {
      const supportedFiles = selectedFiles.filter(isSupportedUploadFile);
      const existingHashes = new Set(photos.map((photo) => photo.sha256).filter(Boolean));
      const isMobileUpload = isMobileUploadEnvironment();
      const metadataConcurrency = isMobileUpload ? MOBILE_METADATA_CONCURRENCY : 4;
      const skipSimilarScan = isMobileUpload && supportedFiles.length > MOBILE_SKIP_SIMILAR_SCAN_THRESHOLD;

      if (supportedFiles.length === 0) {
        setError('지원되는 이미지 형식(jpg, png, webp, heic)을 업로드해 주세요.');
        return;
      }

      let completedMetadataCount = 0;
      const preparedFiles = await mapWithConcurrency(
        supportedFiles,
        metadataConcurrency,
        async (file) => {
          const sha256 = await computeFileSha256(file);
          const isDuplicate = existingHashes.has(sha256);

          if (isDuplicate) {
            completedMetadataCount += 1;
            setUploadProgress({
              current: completedMetadataCount,
              total: supportedFiles.length * 2,
              title: file.name,
              detail: '메타데이터 확인 완료',
            });

            return {
              id: `${file.name}-${sha256.slice(0, 8)}`,
              file,
              previewUrl: canRenderPreviewInBrowser(file) ? URL.createObjectURL(file) : '',
              previewUnavailable: !canRenderPreviewInBrowser(file),
              sha256,
              visualHash: '',
              include: false,
              isDuplicate: true,
              similarToId: null,
              similarDistance: null,
              meta: {
                title: createDefaultPhotoTitle({
                  fileName: file.name,
                  capturedAt: '',
                  locationText: '',
                }),
                fileName: file.name,
                note: '',
                capturedAt: '',
                locationText: '',
                coordinatesText: '',
                mapsUrl: '',
                seasonLabel: '',
              },
            };
          }

          const visualHash = skipSimilarScan ? '' : await computeVisualHash(file);
          const {
            latitude,
            longitude,
            capturedDate,
          } = await parseUploadExifMetadata(file);

          completedMetadataCount += 1;
          setUploadProgress({
            current: completedMetadataCount,
            total: supportedFiles.length * 2,
            title: file.name,
            detail: '메타데이터 확인 완료',
          });

          return {
            id: `${file.name}-${sha256.slice(0, 8)}`,
            file,
            previewUrl: canRenderPreviewInBrowser(file) ? URL.createObjectURL(file) : '',
            previewUnavailable: !canRenderPreviewInBrowser(file),
            sha256,
            visualHash,
            include: true,
            isDuplicate: false,
            similarToId: null,
            similarDistance: null,
            meta: {
              title: createDefaultPhotoTitle({
                fileName: file.name,
                capturedAt: toIsoDateOrEmpty(capturedDate),
                locationText: getLocationLabel(latitude, longitude),
              }),
              fileName: file.name,
              note: '',
              capturedAt: toIsoDateOrEmpty(capturedDate),
              locationText: getLocationLabel(latitude, longitude),
              coordinatesText: formatCoordinates(latitude, longitude),
              mapsUrl: getGoogleMapsUrl(latitude, longitude),
              seasonLabel: capturedDate ? getSeasonLabel(new Date(capturedDate)) : '',
            },
          };
        },
      );

      const reviewedFiles = preparedFiles.map((item, index, allItems) => {
        if (item.isDuplicate) {
          return item;
        }

        if (!item.visualHash) {
          return item;
        }

        for (let previousIndex = 0; previousIndex < index; previousIndex += 1) {
          const previousItem = allItems[previousIndex];
          if (previousItem.isDuplicate || !previousItem.visualHash) {
            continue;
          }

          const distance = getHammingDistance(item.visualHash, previousItem.visualHash);
          if (distance <= SIMILAR_HASH_DISTANCE) {
            return {
              ...item,
              similarToId: previousItem.id,
              similarDistance: distance,
            };
          }
        }

        return item;
      });

      const exactDuplicateCount = reviewedFiles.filter((item) => item.isDuplicate).length;
      const similarCandidateCount = reviewedFiles.filter((item) => item.similarToId).length;
      const uploadableCount = reviewedFiles.filter((item) => item.include && !item.isDuplicate).length;
      setPendingUploadBatch((current) => {
        if (current) {
          revokePreviewUrls(current.items);
        }

        return {
          items: reviewedFiles,
          total: reviewedFiles.length,
          exactDuplicateCount,
          similarCandidateCount,
          uploadableCount,
          skippedSimilarScan: skipSimilarScan,
        };
      });
      setError(
        `총 ${reviewedFiles.length}개 중 업로드 예정 ${uploadableCount}개, 완전 중복 ${exactDuplicateCount}개${skipSimilarScan ? ', 모바일 대량 업로드라 유사 검사는 생략했습니다.' : similarCandidateCount > 0 ? `, 유사 후보 ${similarCandidateCount}개` : ''}`,
      );
    } catch (uploadError) {
      console.error(uploadError);
      if (isAuthFailure(uploadError)) {
        handleAuthExpired();
        return;
      }
      setError(uploadError instanceof Error ? uploadError.message : '사진 업로드 중 문제가 발생했습니다.');
      if (typeof window !== 'undefined') {
        try {
          const raw = window.sessionStorage.getItem(UPLOAD_RECOVERY_KEY);
          const current = raw ? JSON.parse(raw) : {};
          window.sessionStorage.setItem(
            UPLOAD_RECOVERY_KEY,
            JSON.stringify({
              ...current,
              interrupted: true,
            }),
          );
        } catch {
          // Ignore storage errors.
        }
      }
    } finally {
      setPreparingUpload(false);
      setUploading(false);
      setUploadProgress((current) => ({
        ...current,
        title: '',
        detail: '',
      }));
      event.target.value = '';
    }
  }

  function handleTogglePendingUpload(itemId) {
    setPendingUploadBatch((current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        items: current.items.map((item) => (
          item.id === itemId && !item.isDuplicate
            ? { ...item, include: !item.include }
            : item
        )),
      };
    });
  }

  function handlePendingPreviewError(itemId) {
    setPendingUploadBatch((current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        items: current.items.map((item) => {
          if (item.id !== itemId || item.previewUnavailable) {
            return item;
          }

          if (item.previewUrl) {
            URL.revokeObjectURL(item.previewUrl);
          }

          return {
            ...item,
            previewUrl: '',
            previewUnavailable: true,
          };
        }),
      };
    });
  }

  async function handleConfirmPendingUpload() {
    if (!pendingUploadBatch) {
      return;
    }

    const selectedItems = pendingUploadBatch.items.filter((item) => item.include && !item.isDuplicate);
    if (selectedItems.length === 0) {
      setError('업로드할 사진이 없습니다. 유사 사진 후보에서 포함할 사진을 선택해 주세요.');
      return;
    }

    revokePreviewUrls(pendingUploadBatch.items);
    clearPendingUploadBatch();
    await startUpload(selectedItems);
  }

  useEffect(() => () => {
    revokePreviewUrls(pendingUploadBatch?.items ?? []);
  }, [pendingUploadBatch]);

  async function handleFieldSave(photoId, field, value) {
    try {
      const currentPhoto = photos.find((photo) => photo.id === photoId);
      const payload = field === 'locationText'
        ? normalizeLocationFields(value, currentPhoto?.mapsUrl ?? '')
        : { [field]: value };
      const updated = await updateAdminPhoto(photoId, payload);
      setPhotos((current) => current.map((photo) => (photo.id === photoId ? updated : photo)));
    } catch (saveError) {
      console.error(saveError);
      if (isAuthFailure(saveError)) {
        handleAuthExpired();
        return;
      }
      setError(saveError instanceof Error ? saveError.message : '사진 정보를 저장하지 못했습니다.');
    }
  }

  async function handleDelete(photoId) {
    try {
      await deleteAdminPhoto(photoId);
      setPhotos((current) => current.filter((photo) => photo.id !== photoId));
    } catch (deleteError) {
      console.error(deleteError);
      if (isAuthFailure(deleteError)) {
        handleAuthExpired();
        return;
      }
      setError(deleteError instanceof Error ? deleteError.message : '사진 삭제에 실패했습니다.');
    }
  }

  async function handleDeleteSelectedSimilar() {
    if (selectedSimilarIds.length === 0) {
      setError('삭제할 파일을 먼저 선택해 주세요.');
      return;
    }

    setDeletingSimilar(true);
    setError(`선택한 파일 ${selectedSimilarIds.length}개를 삭제하는 중입니다...`);

    try {
      await bulkDeleteAdminPhotos(selectedSimilarIds);

      setPhotos((current) => current.filter((photo) => !selectedSimilarIds.includes(photo.id)));
      setSimilarGroups((current) => current
        .map((group) => ({
          ...group,
          items: group.items.filter((item) => !selectedSimilarIds.includes(item.id)),
        }))
        .filter((group) => group.items.length > 1));
      setSelectedSimilarIds([]);
      setError('선택한 파일을 삭제했습니다.');
    } catch (deleteError) {
      console.error(deleteError);
      if (isAuthFailure(deleteError)) {
        handleAuthExpired();
        return;
      }
      setError(deleteError instanceof Error ? deleteError.message : '선택한 파일 삭제에 실패했습니다.');
    } finally {
      setDeletingSimilar(false);
    }
  }

  function toggleSimilarSelection(photoId) {
    setSelectedSimilarIds((current) => (
      current.includes(photoId)
        ? current.filter((id) => id !== photoId)
        : [...current, photoId]
    ));
  }

  async function handleScanSimilarPhotos() {
    if (photos.length < 2) {
      setError('유사 사진을 검사하려면 사진이 2장 이상 필요합니다.');
      setSimilarGroups([]);
      setSelectedSimilarIds([]);
      return;
    }

    setScanningSimilar(true);
    setError('');
    setSimilarScanProgress({
      current: 0,
      total: photos.length,
      title: '',
      detail: '유사 사진 해시를 준비하는 중입니다.',
    });

    try {
      let processedCount = 0;
      const photoHashes = (await mapWithConcurrency(photos, isMobileUploadEnvironment() ? 2 : 8, async (photo) => {
        try {
          const result = {
            photo,
            visualHash: await computeVisualHashFromUrls([photo.thumbUrl, photo.imageUrl]),
          };
          processedCount += 1;
          setSimilarScanProgress({
            current: processedCount,
            total: photos.length,
            title: photo.fileName || getDisplayPhotoTitle(photo),
            detail: '유사 사진 해시 계산 중',
          });
          return result;
        } catch (photoError) {
          processedCount += 1;
          setSimilarScanProgress({
            current: processedCount,
            total: photos.length,
            title: photo.fileName || getDisplayPhotoTitle(photo),
            detail: '읽지 못한 사진을 건너뛰는 중',
          });
          console.warn(photoError);
          return null;
        }
      })).filter(Boolean);

      const skippedCount = photos.length - photoHashes.length;

      const groups = [];
      const consumed = new Set();

      for (let index = 0; index < photoHashes.length; index += 1) {
        if (consumed.has(photoHashes[index].photo.id)) {
          continue;
        }

        const groupItems = [{ ...photoHashes[index].photo, distance: 0 }];

        for (let nextIndex = index + 1; nextIndex < photoHashes.length; nextIndex += 1) {
          if (consumed.has(photoHashes[nextIndex].photo.id)) {
            continue;
          }

          const distance = getHammingDistance(
            photoHashes[index].visualHash,
            photoHashes[nextIndex].visualHash,
          );

          if (distance <= SIMILAR_HASH_DISTANCE) {
            groupItems.push({
              ...photoHashes[nextIndex].photo,
              distance,
            });
            consumed.add(photoHashes[nextIndex].photo.id);
          }
        }

        if (groupItems.length > 1) {
          consumed.add(photoHashes[index].photo.id);
          groups.push({
            id: photoHashes[index].photo.id,
            items: groupItems,
          });
        }
      }

      setSimilarGroups(groups);
      setSelectedSimilarIds([]);
      setError(
        groups.length > 0
          ? `시각적으로 비슷한 사진 묶음 ${groups.length}개를 찾았습니다.${skippedCount > 0 ? ` 읽지 못한 사진 ${skippedCount}개는 건너뛰었습니다.` : ''} 완전 중복은 아니므로, 비교 기준과 삭제 후보를 직접 확인해 주세요.`
          : `시각적으로 비슷한 사진 후보를 찾지 못했습니다.${skippedCount > 0 ? ` 읽지 못한 사진 ${skippedCount}개는 건너뛰었습니다.` : ''}`,
      );
    } catch (scanError) {
      console.error(scanError);
      setError(scanError instanceof Error ? scanError.message : '유사 사진 검사 중 문제가 발생했습니다.');
    } finally {
      setScanningSimilar(false);
      setSimilarScanProgress((current) => ({
        ...current,
        detail: current.total > 0 ? '유사 사진 검사 결과가 준비되었습니다.' : '',
      }));
    }
  }

  function handleSignOut() {
    clearAdminSession();
    setSession(null);
    setPhotos([]);
  }

  return (
    <div className="admin-shell">
      <div className="background-orb orb-left" />
      <div className="background-orb orb-right" />

      {!session ? (
        <AdminLogin
          error={error}
          loading={authLoading}
          onLogin={renderGoogleButton}
          buttonContainerRef={googleButtonRef}
        />
      ) : (
        <div className="admin-layout">
          <header className="admin-topbar">
            <div>
              <p className="eyebrow">Admin</p>
              <h1>갤러리 관리</h1>
            </div>

            <div className="admin-topbar-actions">
              <Link className="secondary-button topbar-action-button admin-topbar-button" to="/">
                공개 갤러리 보기
              </Link>
              <button
                type="button"
                className="secondary-button topbar-action-button admin-topbar-button"
                onClick={handleSignOut}
              >
                <LogOut size={18} />
                로그아웃
              </button>
            </div>
          </header>

          {error ? <p className="error-banner admin-error">{error}</p> : null}

          <section className="admin-summary-card">
            <div className="stat-card">
              <span>전체 사진</span>
              <strong>{photos.length}</strong>
            </div>
            <div className="stat-card stat-card-compact">
              <span>공개 사진</span>
              <strong>{publicPhotoCount}</strong>
            </div>
            <div className="stat-card stat-card-compact">
              <span>비공개 사진</span>
              <strong>{privatePhotoCount}</strong>
            </div>
            <div className="stat-card stat-card-compact">
              <span>선택 파일 반영</span>
              <strong>
                {uploadProgress.fileTotal > 0
                  ? `${publishedSelectionCount}/${uploadProgress.fileTotal} (${publishedSelectionPercent}%)`
                  : '대기 중'}
              </strong>
            </div>
            <div className="stat-card stat-card-compact">
              <span>총 저장 용량</span>
              <strong>{formatStorageSize(storageSummary.totalBytes)}</strong>
            </div>
            <div className="stat-card stat-card-compact">
              <span>최근 업로드</span>
              <strong>
                {photos[0]?.createdAt ? formatDate(photos[0].createdAt) : '아직 없음'}
              </strong>
            </div>
          </section>

          <section className="admin-photos-sync">
            <div className="admin-photos-copy">
              <p className="eyebrow">Upload</p>
              <h2>관리자 업로드</h2>
              <p className="admin-subtitle">
                업로드된 사진은 기본적으로 공개 상태로 추가됩니다. 아래 카드에서 공개/비공개를 바로 전환할 수 있습니다.
              </p>
            </div>

            <div className="admin-sync-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={handleScanSimilarPhotos}
                disabled={uploading || preparingUpload || scanningSimilar || loading}
              >
                {scanningSimilar ? <LoaderCircle size={18} className="spin" /> : <CheckSquare size={18} />}
                {scanningSimilar ? '유사 사진 검사 중...' : '유사 사진 검사'}
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading || preparingUpload}
              >
                {uploading || preparingUpload ? <LoaderCircle size={18} className="spin" /> : <Upload size={18} />}
                {uploading ? '업로드 중...' : preparingUpload ? '업로드 준비 중...' : '사진 업로드'}
              </button>
            </div>
          </section>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/jpg,image/png,image/webp,image/heic,image/heif"
            multiple
            hidden
            onChange={handleUpload}
          />

          <div className="admin-progress-block">
            {(() => {
              const completedFileCount = uploadProgress.uploaded + uploadProgress.duplicate + uploadProgress.failed;
              const completedPercent = uploadProgress.fileTotal > 0
                ? Math.round((completedFileCount / uploadProgress.fileTotal) * 100)
                : 0;
              const similarCompletedPercent = similarScanProgress.total > 0
                ? Math.round((similarScanProgress.current / similarScanProgress.total) * 100)
                : 0;

              return (
                <>
            <div className="admin-progress-head">
              <div className="admin-progress-copy">
                <p className="admin-loading">
                  {scanningSimilar
                    ? `유사 사진 검사 중: ${similarScanProgress.current}/${similarScanProgress.total} (${similarCompletedPercent}%)`
                    : uploading
                    ? `업로드 중: ${uploadProgress.fileTotal > 0
                        ? uploadProgress.uploaded + uploadProgress.duplicate + uploadProgress.failed
                        : 0}/${uploadProgress.fileTotal > 0 ? uploadProgress.fileTotal : 0} (${uploadProgress.fileTotal > 0
                        ? Math.round(((uploadProgress.uploaded + uploadProgress.duplicate + uploadProgress.failed) / uploadProgress.fileTotal) * 100)
                        : 0}%)`
                    : '업로드 대기 중'}
                </p>
                <p className="admin-progress-detail-text">
                  {scanningSimilar
                    ? `${similarScanProgress.title ? `${similarScanProgress.title} · ` : ''}${similarScanProgress.detail || ''}`
                    : uploading
                    ? `${uploadProgress.title ? `${uploadProgress.title} · ` : ''}${uploadProgress.detail || ''}`
                    : '업로드 결과가 여기에 표시됩니다.'}
                </p>
              </div>
              <span className="admin-progress-percent">
                {scanningSimilar ? similarCompletedPercent : completedPercent}
                %
              </span>
            </div>
            <div className="admin-progress-bar">
              <div
                className="admin-progress-fill"
                style={{
                  width: `${scanningSimilar ? similarCompletedPercent : completedPercent}%`,
                }}
              />
            </div>
                </>
              );
            })()}
          </div>

          {pendingUploadBatch ? (
            <section className="admin-debug-panel">
              <div className="admin-card-actions">
                <strong>업로드 전 유사 사진 검토</strong>
                <div className="admin-photo-buttons">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={handleConfirmPendingUpload}
                  >
                    <CheckSquare size={16} />
                    {`선택한 사진 업로드 (${pendingUploadBatch.uploadableCount})`}
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={clearPendingUploadBatch}
                  >
                    <X size={16} />
                    취소
                  </button>
                </div>
              </div>
              <p className="admin-progress-detail-text">
                완전 중복은 자동으로 건너뜁니다. 유사 후보는 체크를 끄면 업로드에서 제외됩니다.
                {pendingUploadBatch.skippedSimilarScan ? ' 모바일 대량 업로드에서는 속도를 위해 유사 검사를 생략했습니다.' : ''}
              </p>
              <div className="admin-summary-card">
                <div className="stat-card stat-card-compact">
                  <span>선택 파일</span>
                  <strong>{pendingUploadBatch.total}</strong>
                </div>
                <div className="stat-card stat-card-compact">
                  <span>업로드 예정</span>
                  <strong>{pendingUploadBatch.uploadableCount}</strong>
                </div>
                <div className="stat-card stat-card-compact">
                  <span>완전 중복</span>
                  <strong>{pendingUploadBatch.exactDuplicateCount}</strong>
                </div>
                <div className="stat-card stat-card-compact">
                  <span>유사 후보</span>
                  <strong>{pendingUploadBatch.skippedSimilarScan ? '생략' : pendingUploadBatch.similarCandidateCount}</strong>
                </div>
              </div>
              <div className="admin-grid">
                {pendingUploadBatch.items.map((item) => (
                  <article className="admin-photo-card" key={item.id}>
                    <div className="admin-photo-preview">
                      {item.previewUnavailable ? (
                        <div className="admin-preview-fallback">
                          <strong>{(item.file.name.split('.').pop() || 'image').toUpperCase()}</strong>
                          <span>브라우저 미리보기 불가</span>
                        </div>
                      ) : (
                        <img
                          src={item.previewUrl}
                          alt={item.meta.title || item.file.name}
                          onError={() => handlePendingPreviewError(item.id)}
                        />
                      )}
                    </div>
                    <div className="admin-photo-fields">
                      <div className="admin-photo-meta">
                        <span>{item.file.name}</span>
                        <span>
                          {item.isDuplicate
                            ? '완전 중복 · 자동 제외'
                            : item.similarToId
                              ? `유사 후보 · 거리 ${item.similarDistance}`
                              : '업로드 예정'}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={item.isDuplicate}
                        onClick={() => handleTogglePendingUpload(item.id)}
                      >
                        {item.isDuplicate ? <CheckSquare size={16} /> : item.include ? <CheckSquare size={16} /> : <Square size={16} />}
                        {item.isDuplicate
                          ? '중복으로 제외됨'
                          : item.include
                            ? '업로드 포함'
                            : '업로드 제외'}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ) : null}

          {similarGroups.length > 0 ? (
            <section className="admin-debug-panel">
              <div className="admin-card-actions">
                <strong>현재 공개 사진 유사 후보</strong>
                <div className="admin-photo-buttons">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      const allCandidateIds = similarGroups.flatMap((group) => group.items.slice(1).map((item) => item.id));
                      setSelectedSimilarIds(allCandidateIds);
                    }}
                  >
                    <CheckSquare size={16} />
                    삭제 후보 전체 선택
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => setSelectedSimilarIds([])}
                  >
                    <Square size={16} />
                    선택 해제
                  </button>
                  <button
                    type="button"
                    className="secondary-button danger-button"
                    onClick={handleDeleteSelectedSimilar}
                    disabled={deletingSimilar || selectedSimilarIds.length === 0}
                  >
                    {deletingSimilar ? <LoaderCircle size={16} className="spin" /> : <Trash2 size={16} />}
                    {deletingSimilar ? `삭제 중... (${selectedSimilarIds.length})` : `선택한 파일 삭제 (${selectedSimilarIds.length})`}
                  </button>
                </div>
              </div>
              <p className="admin-progress-detail-text">
                왼쪽은 남길 비교 기준 사진, 오른쪽은 비슷하다고 잡힌 삭제 후보 사진입니다. 완전 중복은 아니므로 직접 보고 삭제할 파일만 선택해 주세요.
              </p>
              {similarGroups.map((group, groupIndex) => (
                <div className="admin-card-actions" key={group.id}>
                  <strong>비슷한 사진 묶음 {groupIndex + 1}</strong>
                  <div className="admin-similar-pair-grid">
                    {group.items.slice(1).map((item) => {
                      const checked = selectedSimilarIds.includes(item.id);
                      return (
                        <div className="admin-similar-pair" key={item.id}>
                          <article className="admin-photo-card admin-similar-photo-card">
                            <div className="admin-photo-preview">
                              <img
                                src={group.items[0].thumbUrl || group.items[0].imageUrl}
                                alt={group.items[0].title}
                                loading="lazy"
                                decoding="async"
                              />
                            </div>
                            <div className="admin-photo-fields">
                              <div className="tag-row">
                                <span className="tag muted">왼쪽 · 비교 기준</span>
                              </div>
                              <div className="admin-photo-meta">
                                <span>{getDisplayPhotoTitle(group.items[0])}</span>
                                <span>{group.items[0].fileName || '기준 사진'}</span>
                              </div>
                              <button
                                type="button"
                                className="secondary-button"
                                disabled
                              >
                                <Square size={16} />
                                남길 사진
                              </button>
                            </div>
                          </article>

                          <article className="admin-photo-card admin-similar-photo-card">
                            <div className="admin-photo-preview">
                              <img
                                src={item.thumbUrl || item.imageUrl}
                                alt={item.title}
                                loading="lazy"
                                decoding="async"
                              />
                            </div>
                            <div className="admin-photo-fields">
                              <div className="tag-row">
                                <span className="tag">오른쪽 · 삭제 후보</span>
                              </div>
                              <div className="admin-photo-meta">
                                <span>{getDisplayPhotoTitle(item)}</span>
                                <span>{`${item.fileName || '후보 사진'} · 시각 유사도 ${item.distance}`}</span>
                              </div>
                              <button
                                type="button"
                                className="secondary-button"
                                onClick={() => toggleSimilarSelection(item.id)}
                              >
                                {checked ? <CheckSquare size={16} /> : <Square size={16} />}
                                {checked ? '삭제 선택됨' : '오른쪽 사진 삭제'}
                              </button>
                            </div>
                          </article>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </section>
          ) : null}

          {loading ? <p className="admin-loading">사진 목록을 불러오는 중입니다.</p> : null}

          <section className="admin-grid">
            {sortedPhotos.map((photo) => (
              <article className="admin-photo-card" key={photo.id}>
                <div className="admin-photo-preview">
                  <img src={photo.thumbUrl || photo.imageUrl} alt={photo.title} loading="lazy" decoding="async" />
                </div>

                <div className="admin-photo-fields">
                  <label className="admin-field">
                    <span>제목</span>
                    <input
                      defaultValue={getDisplayPhotoTitle(photo)}
                      onBlur={(event) => handleFieldSave(photo.id, 'title', event.target.value.trim())}
                    />
                  </label>

                  <label className="admin-field">
                    <span>메모</span>
                    <textarea
                      defaultValue={photo.note ?? ''}
                      rows={4}
                      onBlur={(event) => handleFieldSave(photo.id, 'note', event.target.value.trim())}
                    />
                  </label>

                  <label className="admin-field">
                    <span>위치 표시명</span>
                    <input
                      defaultValue={photo.locationText ?? ''}
                      onBlur={(event) =>
                        handleFieldSave(photo.id, 'locationText', event.target.value.trim())
                      }
                    />
                  </label>

                  {extractGoogleMapsUrl(photo.mapsUrl) ? (
                    <div className="admin-photo-meta">
                      <span>연결된 지도</span>
                      <a href={photo.mapsUrl} target="_blank" rel="noreferrer">
                        Google Maps 열기
                      </a>
                    </div>
                  ) : null}

                  <div className="admin-photo-meta">
                    <span>{photo.fileName}</span>
                    <span>{photo.capturedAt ? formatDate(photo.capturedAt) : '촬영일 정보 없음'}</span>
                  </div>

                  <div className="admin-card-actions">
                    <div className="admin-save-hint">
                      <ShieldCheck size={16} />
                      {photo.isPublic !== false ? '공개 중' : '비공개'}
                    </div>
                    <div className="admin-photo-buttons">
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => handleFieldSave(photo.id, 'isPublic', photo.isPublic === false)}
                      >
                        <ShieldCheck size={16} />
                        {photo.isPublic !== false ? '비공개로 전환' : '공개로 전환'}
                      </button>
                    </div>
                  </div>

                  <div className="admin-card-actions">
                    <div className="admin-save-hint">
                      <PencilLine size={16} />
                      입력 후 포커스를 벗어나면 저장됩니다.
                    </div>
                    <div className="admin-photo-buttons">
                      <button
                        type="button"
                        className="secondary-button danger-button"
                        onClick={() => handleDelete(photo.id)}
                      >
                        <Trash2 size={16} />
                        삭제
                      </button>
                    </div>
                  </div>
                </div>
              </article>
            ))}
          </section>
        </div>
      )}
    </div>
  );
}
