import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Download,
  Images,
  LoaderCircle,
  MapPin,
  MessageSquareText,
  Search,
} from 'lucide-react';
import { getPhotoDownloadUrl, getPublicPhotos, getPublicSystemStatus } from '../lib/galleryApi';
import { formatDate, getDisplayPhotoTitle } from '../lib/photoUtils';

const PUBLIC_GALLERY_REFRESH_MS = 10000;
const STATUS_REFRESH_MS = 15000;
const DEFAULT_WATERMARK = 'totoriverce@naver.com';
const SLIDESHOW_SPEED_OPTIONS = [
  { label: '2초', value: 2000 },
  { label: '5초', value: 5000 },
  { label: '10초', value: 10000 },
];

function detectMobileExperience() {
  if (typeof window === 'undefined') {
    return false;
  }

  const userAgent = navigator.userAgent || '';
  const agentMobile = /Android|iPhone|iPad|iPod|Mobile|CriOS|FxiOS|SamsungBrowser/i.test(userAgent);
  const viewportMobile = window.innerWidth <= 900;
  const coarsePointer =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(hover: none) and (pointer: coarse)').matches
      : false;

  return agentMobile || (viewportMobile && coarsePointer);
}

function isMobileLandscapeViewport() {
  if (typeof window === 'undefined') {
    return false;
  }

  const isLandscape = window.innerWidth > window.innerHeight;
  const isMobileSized = Math.min(window.innerWidth, window.innerHeight) <= 900;
  const isTouchPrimary =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(hover: none) and (pointer: coarse)').matches
      : false;

  return isLandscape && (isMobileSized || isTouchPrimary);
}

const starterMemories = [
  {
    id: 'starter-1',
    title: '',
    imageUrl:
      'data:image/svg+xml;utf8,' +
      encodeURIComponent(`
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 560">
          <defs>
            <linearGradient id="g" x1="0%" x2="100%" y1="0%" y2="100%">
              <stop offset="0%" stop-color="#253142"/>
              <stop offset="50%" stop-color="#4c6078"/>
              <stop offset="100%" stop-color="#d77a51"/>
            </linearGradient>
          </defs>
          <rect width="800" height="560" fill="url(#g)"/>
          <circle cx="625" cy="120" r="58" fill="#fff1de" opacity="0.72"/>
          <path d="M0 440 C140 340 260 348 360 418 S580 520 800 420 L800 560 L0 560 Z" fill="#1a212c"/>
          <path d="M0 470 C150 392 268 412 390 470 S650 560 800 468 L800 560 L0 560 Z" fill="#0f141a"/>
        </svg>
      `),
    locationText: '',
    capturedAt: '',
    note: '',
    isPlaceholder: true,
  },
];

export default function GalleryPage() {
  const [photos, setPhotos] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [selectedPhotoId, setSelectedPhotoId] = useState(null);
  const [selectedPhotoState, setSelectedPhotoState] = useState(null);
  const [modalImageSrc, setModalImageSrc] = useState('');
  const [modalImageLoading, setModalImageLoading] = useState(false);
  const [slideshowSpeed, setSlideshowSpeed] = useState(5000);
  const [activeSlideIndex, setActiveSlideIndex] = useState(0);
  const [slideshowVisible, setSlideshowVisible] = useState(true);
  const [isMobileExperience, setIsMobileExperience] = useState(() => detectMobileExperience());
  const [systemStatus, setSystemStatus] = useState({
    loading: true,
    renderOk: false,
    storageOk: false,
    storageBackend: '',
    message: '상태 확인 중',
  });
  const imagePreloadCacheRef = useRef(new Set());

  function preloadImage(src) {
    if (!src || imagePreloadCacheRef.current.has(src)) {
      return;
    }

    imagePreloadCacheRef.current.add(src);
    const image = new Image();
    image.decoding = 'async';
    image.src = src;
  }

  async function loadPublicPhotos({ silent = false } = {}) {
    if (!silent) {
      setLoading(true);
    } else {
      setRefreshing(true);
    }

    try {
      const response = await getPublicPhotos();
      setPhotos(response);
      setError('');
    } catch (loadError) {
      console.error(loadError);
      setError(loadError instanceof Error ? loadError.message : '공개 사진을 불러오지 못했습니다.');
    } finally {
      if (!silent) {
        setLoading(false);
      } else {
        setRefreshing(false);
      }
    }
  }

  async function loadSystemStatus() {
    try {
      const status = await getPublicSystemStatus();
      setSystemStatus({
        loading: false,
        renderOk: Boolean(status?.render?.ok),
        storageOk: Boolean(status?.storage?.ok),
        storageBackend: status?.storage?.backend || '',
        message: status?.storage?.message || status?.render?.message || '상태 확인 완료',
      });
    } catch (statusError) {
      console.error(statusError);
      setSystemStatus({
        loading: false,
        renderOk: false,
        storageOk: false,
        storageBackend: '',
        message: statusError instanceof Error ? statusError.message : '상태를 불러오지 못했습니다.',
      });
    }
  }

  useEffect(() => {
    let active = true;

    async function loadPhotos() {
      if (!active) {
        return;
      }

      await loadPublicPhotos();
    }

    loadPhotos();
    loadSystemStatus();

    const intervalId = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !selectedPhotoId) {
        loadPublicPhotos({ silent: true });
      }
    }, PUBLIC_GALLERY_REFRESH_MS);
    const statusIntervalId = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !selectedPhotoId) {
        loadSystemStatus();
      }
    }, STATUS_REFRESH_MS);

    function handleVisibilityChange() {
      if (document.visibilityState === 'visible' && !selectedPhotoId) {
        loadPublicPhotos({ silent: true });
        loadSystemStatus();
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      active = false;
      window.clearInterval(intervalId);
      window.clearInterval(statusIntervalId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [selectedPhotoId]);

  const displayPhotos = useMemo(() => {
    const source = photos.length > 0 ? photos : starterMemories;
    const keyword = search.trim().toLowerCase();

    if (!keyword) {
      return source;
    }

    return source.filter((photo) => {
      const values = [photo.title, photo.locationText, photo.note, photo.fileName]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      return values.includes(keyword);
    });
  }, [photos, search]);

  const stats = useMemo(() => {
    const latest = photos
      .map((photo) => photo.capturedAt)
      .filter(Boolean)
      .sort()
      .at(-1);

    return {
      total: photos.length,
      latest: latest ? formatDate(latest) : '아직 없음',
    };
  }, [photos]);

  const slideshowPhotos = useMemo(() => {
    const source = photos.length > 0 ? photos : starterMemories;
    return source;
  }, [photos]);

  const activeSlide = slideshowPhotos[activeSlideIndex] ?? slideshowPhotos[0] ?? null;

  const selectedPhoto = useMemo(() => {
    if (!selectedPhotoId) {
      return null;
    }

    const source = photos.length > 0 ? photos : starterMemories;
    return source.find((photo) => photo.id === selectedPhotoId) ?? selectedPhotoState ?? null;
  }, [photos, selectedPhotoId, selectedPhotoState]);

  const selectedPhotoIndex = useMemo(() => {
    if (!selectedPhotoId) {
      return -1;
    }

    return displayPhotos.findIndex((photo) => photo.id === selectedPhotoId);
  }, [displayPhotos, selectedPhotoId]);

  const hasMultipleDisplayPhotos = displayPhotos.length > 1;
  const hasMultipleSlides = slideshowPhotos.length > 1;
  const systemStatusClassName = systemStatus.loading
    ? 'status-pill status-pill-pending topbar-action-button topbar-status-pill'
    : systemStatus.renderOk && systemStatus.storageOk
      ? 'status-pill status-pill-connected topbar-action-button topbar-status-pill'
      : 'status-pill status-pill-disconnected topbar-action-button topbar-status-pill';

  function openPhoto(photo, event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();

    const previewSrc = photo.thumbUrl || photo.imageUrl || '';
    setSelectedPhotoState(photo);
    setSelectedPhotoId(photo.id);
    setModalImageSrc(previewSrc);
    setModalImageLoading(Boolean(photo.imageUrl && photo.imageUrl !== previewSrc));
    preloadImage(previewSrc);
    preloadImage(photo.imageUrl);
  }

  function closePhoto() {
    setSelectedPhotoId(null);
    setSelectedPhotoState(null);
    setModalImageSrc('');
    setModalImageLoading(false);
  }

  function moveSelectedPhoto(direction) {
    if (!hasMultipleDisplayPhotos || selectedPhotoIndex < 0) {
      return;
    }

    const nextIndex =
      (selectedPhotoIndex + direction + displayPhotos.length) % displayPhotos.length;
    setSelectedPhotoId(displayPhotos[nextIndex]?.id ?? null);
  }

  useEffect(() => {
    if (!selectedPhoto) {
      setModalImageSrc('');
      setModalImageLoading(false);
      return;
    }

    const previewSrc = selectedPhoto.thumbUrl || selectedPhoto.imageUrl;
    setModalImageSrc(previewSrc);
    setModalImageLoading(Boolean(selectedPhoto.imageUrl && selectedPhoto.imageUrl !== previewSrc));

    if (!selectedPhoto.imageUrl || selectedPhoto.imageUrl === previewSrc) {
      return;
    }

    let active = true;
    const nextImage = new Image();
    nextImage.onload = () => {
      if (!active) {
        return;
      }

      setModalImageSrc(selectedPhoto.imageUrl);
      setModalImageLoading(false);
    };
    nextImage.onerror = () => {
      if (!active) {
        return;
      }

      setModalImageLoading(false);
    };
    nextImage.src = selectedPhoto.imageUrl;

    return () => {
      active = false;
    };
  }, [selectedPhoto]);

  useEffect(() => {
    if (!selectedPhotoId || !photos.length) {
      return;
    }

    const latestPhoto = photos.find((photo) => photo.id === selectedPhotoId);
    if (latestPhoto) {
      setSelectedPhotoState(latestPhoto);
    }
  }, [photos, selectedPhotoId]);

  useEffect(() => {
    if (!displayPhotos.length || selectedPhotoIndex < 0) {
      return;
    }

    const current = displayPhotos[selectedPhotoIndex];
    const previous = displayPhotos[(selectedPhotoIndex - 1 + displayPhotos.length) % displayPhotos.length];
    const next = displayPhotos[(selectedPhotoIndex + 1) % displayPhotos.length];

    [current, previous, next].forEach((photo) => {
      if (!photo) {
        return;
      }

      preloadImage(photo.thumbUrl || photo.imageUrl);
      preloadImage(photo.imageUrl);
    });
  }, [displayPhotos, selectedPhotoIndex]);

  useEffect(() => {
    displayPhotos.slice(0, 18).forEach((photo) => {
      preloadImage(photo.thumbUrl || photo.imageUrl);
    });
  }, [displayPhotos]);

  function moveSlide(direction) {
    if (!hasMultipleSlides) {
      return;
    }

    setActiveSlideIndex((currentIndex) => {
      const nextIndex =
        (currentIndex + direction + slideshowPhotos.length) % slideshowPhotos.length;
      return nextIndex;
    });
  }

  function handleBackdropClick(event) {
    if (event.target !== event.currentTarget) {
      return;
    }

    closePhoto();
  }

  useEffect(() => {
    function handleKeydown(event) {
      if (event.key === 'Escape') {
        setSelectedPhotoId(null);
        return;
      }

      if (!selectedPhotoId) {
        return;
      }

      if (event.key === 'ArrowLeft') {
        moveSelectedPhoto(-1);
      } else if (event.key === 'ArrowRight') {
        moveSelectedPhoto(1);
      }
    }

    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  }, [displayPhotos, hasMultipleDisplayPhotos, selectedPhotoId, selectedPhotoIndex]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }

    function syncMobileExperience() {
      setIsMobileExperience(detectMobileExperience());
    }

    function syncLandscapeSlideshow() {
      if (isMobileLandscapeViewport()) {
        setSlideshowVisible(true);
      }
    }

    syncMobileExperience();
    syncLandscapeSlideshow();
    window.addEventListener('resize', syncMobileExperience);
    window.addEventListener('resize', syncLandscapeSlideshow);
    window.addEventListener('orientationchange', syncLandscapeSlideshow);

    return () => {
      window.removeEventListener('resize', syncMobileExperience);
      window.removeEventListener('resize', syncLandscapeSlideshow);
      window.removeEventListener('orientationchange', syncLandscapeSlideshow);
    };
  }, []);

  useEffect(() => {
    if (isMobileExperience && isMobileLandscapeViewport()) {
      setSlideshowVisible(true);
    }
  }, [isMobileExperience]);

  useEffect(() => {
    if (!slideshowPhotos.length) {
      setActiveSlideIndex(0);
      return;
    }

    setActiveSlideIndex((currentIndex) =>
      Math.min(currentIndex, slideshowPhotos.length - 1),
    );
  }, [slideshowPhotos]);

  useEffect(() => {
    if (!hasMultipleSlides) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      setActiveSlideIndex((currentIndex) => (currentIndex + 1) % slideshowPhotos.length);
    }, slideshowSpeed);

    return () => window.clearInterval(intervalId);
  }, [hasMultipleSlides, slideshowPhotos.length, slideshowSpeed]);

  return (
    <div className="app-shell">
      <div className="background-orb orb-left" />
      <div className="background-orb orb-right" />

      <header className="hero">
        {isMobileExperience ? (
          <div className="mobile-gallery-header">
            <div className="mobile-gallery-copy">
              <p className="eyebrow">Mobile Public Gallery</p>
              <h1>그날의 기록</h1>
              <p className="gallery-topbar-meta">
                공개 사진 {stats.total}장
                <span className="gallery-topbar-divider">·</span>
                최근 촬영 {stats.latest}
              </p>
            </div>
            <div className="mobile-gallery-actions">
              <div className={systemStatusClassName} title={systemStatus.message}>
                {systemStatus.loading ? <LoaderCircle size={16} className="spin" /> : <Images size={16} />}
                {systemStatus.loading
                  ? '신호 확인 중'
                  : systemStatus.renderOk && systemStatus.storageOk
                    ? `정상 연결 · ${systemStatus.storageBackend === 'r2' ? 'Cloudflare' : 'Local'}`
                    : '연결 이상'}
              </div>
              <button
                type="button"
                className="secondary-button topbar-action-button"
                onClick={() => setSlideshowVisible((current) => !current)}
              >
                {slideshowVisible ? '슬라이드 숨기기' : '슬라이드 보기'}
              </button>
            </div>
          </div>
        ) : (
          <div className="gallery-topbar">
            <div className="gallery-topbar-copy">
              <p className="eyebrow">Public Gallery</p>
              <h1>그날의 기록 (Records of the Day)</h1>
              <p className="gallery-topbar-meta">
                공개 사진 {stats.total}장
                <span className="gallery-topbar-divider">·</span>
                최근 촬영 {stats.latest}
              </p>
            </div>

            <div className="gallery-topbar-actions">
              <div className={systemStatusClassName} title={systemStatus.message}>
                {systemStatus.loading ? <LoaderCircle size={16} className="spin" /> : <Images size={16} />}
                {systemStatus.loading
                  ? '신호 확인 중'
                  : systemStatus.renderOk && systemStatus.storageOk
                    ? `정상 연결 · ${systemStatus.storageBackend === 'r2' ? 'Cloudflare' : 'Local'}`
                    : '연결 이상'}
              </div>
              <button
                type="button"
                className="secondary-button topbar-action-button"
                onClick={() => setSlideshowVisible((current) => !current)}
              >
                {slideshowVisible ? '슬라이드쇼 숨기기' : '슬라이드쇼 보기'}
              </button>
              <Link className="secondary-button topbar-action-button" to="/admin">
                관리자
              </Link>
            </div>
          </div>
        )}
      </header>

      {slideshowVisible && activeSlide ? (
        <section className="hero-panel slideshow-panel">
          <div className="slideshow-stage">
            <button
              type="button"
              className="slideshow-photo-button"
              onPointerUp={(event) => openPhoto(activeSlide, event)}
              onClick={(event) => {
                if (event.detail === 0) {
                  openPhoto(activeSlide, event);
                }
              }}
              aria-label={`${getDisplayPhotoTitle(activeSlide)} 슬라이드 사진 크게 보기`}
            >
              <img
                src={activeSlide.imageUrl}
                alt={getDisplayPhotoTitle(activeSlide)}
                className="slideshow-image"
                decoding="async"
              />
              <div className="slideshow-overlay">
                <div className="slideshow-copy">
                  <p className="eyebrow">Slideshow</p>
                  <h2>{getDisplayPhotoTitle(activeSlide)}</h2>
                  <p>{activeSlide.locationText || '위치 정보 없음'}</p>
                </div>
              </div>
            </button>

            {hasMultipleSlides ? (
              <>
                <button
                  type="button"
                  className="icon-button slideshow-nav-button slideshow-nav-button-left"
                  onClick={() => moveSlide(-1)}
                  aria-label="이전 슬라이드 보기"
                >
                  <ChevronLeft size={20} />
                </button>
                <button
                  type="button"
                  className="icon-button slideshow-nav-button slideshow-nav-button-right"
                  onClick={() => moveSlide(1)}
                  aria-label="다음 슬라이드 보기"
                >
                  <ChevronRight size={20} />
                </button>
              </>
            ) : null}
          </div>

          <div className="slideshow-controls">
            <div className="slideshow-speed-selector" role="radiogroup" aria-label="슬라이드쇼 속도">
              {SLIDESHOW_SPEED_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`slideshow-speed-button ${
                    slideshowSpeed === option.value ? 'is-active' : ''
                  }`}
                  onClick={() => setSlideshowSpeed(option.value)}
                  aria-pressed={slideshowSpeed === option.value}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <div className="slideshow-position" aria-live="polite">
              {slideshowPhotos.length > 0 ? `${activeSlideIndex + 1} / ${slideshowPhotos.length}` : '0 / 0'}
            </div>
          </div>
        </section>
      ) : null}

      <section className={isMobileExperience ? 'toolbar mobile-gallery-toolbar' : 'toolbar'}>
        <label className="search-field" htmlFor="photo-search">
          <Search size={18} />
          <input
            id="photo-search"
            type="search"
            placeholder="제목, 위치, 메모, 파일명으로 검색"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>

        {!isMobileExperience ? (
          <div className="toolbar-info">
            <Images size={18} />
            <span>공개 갤러리입니다. 관리자만 업로드와 편집이 가능합니다.</span>
          </div>
        ) : null}
      </section>

      {error ? <p className="error-banner">{error}</p> : null}

      <main className={isMobileExperience ? 'gallery-grid mobile-gallery-grid' : 'gallery-grid'}>
        {displayPhotos.map((photo, index) => (
          <article
            className={`photo-card ${photo.isPlaceholder ? 'placeholder-card' : ''}`}
            key={photo.id}
            style={{ animationDelay: `${index * 80}ms` }}
          >
            <button
              type="button"
              className="photo-open-button"
              onPointerUp={(event) => openPhoto(photo, event)}
              onClick={(event) => {
                if (event.detail === 0) {
                  openPhoto(photo, event);
                }
              }}
              aria-label={`${getDisplayPhotoTitle(photo)} 크게 보기`}
            >
              <div className="photo-frame">
                <img
                  src={photo.thumbUrl || photo.imageUrl}
                  alt={photo.title}
                  loading="lazy"
                  decoding="async"
                />
                <span className="photo-watermark">{DEFAULT_WATERMARK}</span>
              </div>

              <div className="photo-content">
                <div className="photo-heading">
                  <div>
                    <h2>{getDisplayPhotoTitle(photo)}</h2>
                    <p>{photo.fileName ?? '안내 카드'}</p>
                  </div>
                </div>

                <div className="meta-list">
                  <div className="meta-item">
                    <CalendarDays size={16} />
                    <span>{photo.capturedAt ? formatDate(photo.capturedAt) : '촬영일 정보 없음'}</span>
                  </div>
                  <div className="meta-item">
                    <MapPin size={16} />
                    <span>{photo.locationText || '위치 정보 없음'}</span>
                  </div>
                  {photo.note ? (
                    <div className="meta-item">
                      <MessageSquareText size={16} />
                      <span>{photo.note}</span>
                    </div>
                  ) : null}
                </div>
              </div>
            </button>
          </article>
        ))}
      </main>

      {selectedPhoto ? (
        <div
          className="photo-modal-backdrop"
          onClick={handleBackdropClick}
          role="presentation"
        >
          <section
            className="photo-modal"
            aria-label={`${getDisplayPhotoTitle(selectedPhoto)} 사진 크게 보기`}
          >
            <div
              className="photo-modal-panel"
              onClick={(event) => {
                if (event.target === event.currentTarget) {
                  closePhoto();
                }
              }}
            >
              <div className="photo-modal-media">
                <div
                  className="photo-modal-visual"
                  onClick={(event) => event.stopPropagation()}
                >
                  {hasMultipleDisplayPhotos ? (
                    <button
                      type="button"
                      className="icon-button photo-nav-button photo-nav-button-left"
                      onClick={() => moveSelectedPhoto(-1)}
                      aria-label="이전 사진 보기"
                    >
                      <ChevronLeft size={20} />
                    </button>
                  ) : null}
                  <img
                    src={modalImageSrc || selectedPhoto.imageUrl}
                    alt={getDisplayPhotoTitle(selectedPhoto)}
                    decoding="async"
                  />
                  {modalImageLoading ? (
                    <div className="photo-modal-loading-indicator">
                      <LoaderCircle size={18} className="spin" />
                      원본 불러오는 중
                    </div>
                  ) : null}
                  {hasMultipleDisplayPhotos ? (
                    <button
                      type="button"
                      className="icon-button photo-nav-button photo-nav-button-right"
                      onClick={() => moveSelectedPhoto(1)}
                      aria-label="다음 사진 보기"
                    >
                      <ChevronRight size={20} />
                    </button>
                  ) : null}
                </div>
              </div>
              <div
                className="photo-modal-meta"
                onClick={(event) => event.stopPropagation()}
              >
                <h2>{getDisplayPhotoTitle(selectedPhoto)}</h2>
                <div className="photo-modal-note-row">
                  <p>{selectedPhoto.note || '등록된 메모가 없습니다.'}</p>
                  {!selectedPhoto.isPlaceholder ? (
                    <a
                      className="secondary-button topbar-action-button photo-download-button"
                      href={getPhotoDownloadUrl(selectedPhoto)}
                      download
                    >
                      <Download size={16} />
                      사진 다운로드
                    </a>
                  ) : null}
                </div>
                <p>{selectedPhoto.locationText || '위치 정보 없음'}</p>
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
