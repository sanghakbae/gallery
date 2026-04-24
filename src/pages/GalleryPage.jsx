import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Download,
  Images,
  MapPin,
  MessageSquareText,
  Search,
  X,
} from 'lucide-react';
import ResilientImage from '../components/ResilientImage';
import TransitioningModalImage from '../components/TransitioningModalImage';
import { getPhotoDownloadUrl, getPublicPhotosPage, getPublicSystemStatus } from '../lib/galleryApi';
import { formatDate, getDisplayPhotoTitle } from '../lib/photoUtils';
import {
  buildSystemStatusFromError,
  buildSystemStatusFromResponse,
  createInitialSystemStatus,
  getSystemStatusPresentation,
} from '../lib/systemStatus';
import { useBodyScrollLock } from '../lib/useBodyScrollLock';

const STATUS_REFRESH_MS = 300000;
const INITIAL_PHOTO_BATCH_SIZE = 36;
const FOLLOW_UP_BATCH_SIZE = 72;
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

export default function GalleryPage() {
  const [photos, setPhotos] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [totalPhotoCount, setTotalPhotoCount] = useState(0);
  const [error, setError] = useState('');
  const [selectedPhotoId, setSelectedPhotoId] = useState(null);
  const [selectedPhotoState, setSelectedPhotoState] = useState(null);
  const [slideshowSpeed, setSlideshowSpeed] = useState(5000);
  const [activeSlideIndex, setActiveSlideIndex] = useState(0);
  const [slideshowVisible, setSlideshowVisible] = useState(false);
  const [isMobileExperience, setIsMobileExperience] = useState(() => detectMobileExperience());
  const [systemStatus, setSystemStatus] = useState(() => createInitialSystemStatus());
  const imagePreloadCacheRef = useRef(new Set());
  const slideshowTouchStartRef = useRef(null);
  const progressiveLoadGenerationRef = useRef(0);

  function preloadImage(src) {
    if (!src || imagePreloadCacheRef.current.has(src)) {
      return;
    }

    imagePreloadCacheRef.current.add(src);
    const image = new Image();
    image.decoding = 'async';
    image.src = src;
  }

  async function loadPublicPhotos() {
    const generation = progressiveLoadGenerationRef.current + 1;
    progressiveLoadGenerationRef.current = generation;
    setLoading(true);
    setLoadingMore(false);
    try {
      const firstPage = await getPublicPhotosPage({
        offset: 0,
        limit: INITIAL_PHOTO_BATCH_SIZE,
      });

      if (progressiveLoadGenerationRef.current !== generation) {
        return;
      }

      setPhotos(firstPage.photos);
      setTotalPhotoCount(firstPage.totalCount);
      setError('');
      setLoading(false);

      if (!firstPage.hasMore) {
        return;
      }

      let offset = firstPage.offset + firstPage.photos.length;
      setLoadingMore(true);

      while (offset < firstPage.totalCount && progressiveLoadGenerationRef.current === generation) {
        const nextPage = await getPublicPhotosPage({
          offset,
          limit: FOLLOW_UP_BATCH_SIZE,
        });

        if (progressiveLoadGenerationRef.current !== generation) {
          return;
        }

        setPhotos((current) => [...current, ...nextPage.photos]);
        setTotalPhotoCount(nextPage.totalCount);
        offset += nextPage.photos.length;

        if (!nextPage.hasMore || nextPage.photos.length === 0) {
          break;
        }
      }
    } catch (loadError) {
      console.error(loadError);
      setError(loadError instanceof Error ? loadError.message : '공개 사진을 불러오지 못했습니다.');
    } finally {
      if (progressiveLoadGenerationRef.current === generation) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }

  async function loadSystemStatus() {
    try {
      const status = await getPublicSystemStatus();
      setSystemStatus((previousStatus) => buildSystemStatusFromResponse(previousStatus, status));
    } catch (statusError) {
      console.error(statusError);
      setSystemStatus((previousStatus) => buildSystemStatusFromError(previousStatus, statusError));
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

    const statusIntervalId = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !selectedPhotoId) {
        loadSystemStatus();
      }
    }, STATUS_REFRESH_MS);

    function handleVisibilityChange() {
      if (document.visibilityState === 'visible' && !selectedPhotoId) {
        loadSystemStatus();
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      active = false;
      progressiveLoadGenerationRef.current += 1;
      window.clearInterval(statusIntervalId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [selectedPhotoId]);

  const displayPhotos = useMemo(() => {
    const keyword = search.trim().toLowerCase();

    if (!keyword) {
      return photos;
    }

    return photos.filter((photo) => {
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
      total: totalPhotoCount || photos.length,
      latest: latest ? formatDate(latest) : '아직 없음',
    };
  }, [photos, totalPhotoCount]);

  const slideshowPhotos = photos;

  const activeSlide = slideshowPhotos[activeSlideIndex] ?? slideshowPhotos[0] ?? null;

  const selectedPhoto = useMemo(() => {
    if (!selectedPhotoId) {
      return null;
    }

    return photos.find((photo) => photo.id === selectedPhotoId) ?? selectedPhotoState ?? null;
  }, [photos, selectedPhotoId, selectedPhotoState]);

  useBodyScrollLock(Boolean(selectedPhotoId));

  const selectedPhotoIndex = useMemo(() => {
    if (!selectedPhotoId) {
      return -1;
    }

    return displayPhotos.findIndex((photo) => photo.id === selectedPhotoId);
  }, [displayPhotos, selectedPhotoId]);

  const hasMultipleDisplayPhotos = displayPhotos.length > 1;
  const hasMultipleSlides = slideshowPhotos.length > 1;
  const statusPresentation = getSystemStatusPresentation(systemStatus);
  const systemStatusClassName = `${statusPresentation.className} topbar-action-button topbar-status-pill`;

  function openPhoto(photo, event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();

    setSelectedPhotoState(photo);
    setSelectedPhotoId(photo.id);
    preloadImage(photo.imageUrl);
    preloadImage(photo.thumbUrl);
  }

  function closePhoto() {
    setSelectedPhotoId(null);
    setSelectedPhotoState(null);
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
    displayPhotos.slice(0, 6).forEach((photo) => {
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

  function handleSlideshowTouchStart(event) {
    slideshowTouchStartRef.current = event.changedTouches?.[0]?.clientX ?? null;
  }

  function handleSlideshowTouchEnd(event) {
    const startX = slideshowTouchStartRef.current;
    const endX = event.changedTouches?.[0]?.clientX ?? null;
    slideshowTouchStartRef.current = null;

    if (startX === null || endX === null) {
      return;
    }

    const deltaX = endX - startX;
    if (Math.abs(deltaX) < 48) {
      return;
    }

    moveSlide(deltaX < 0 ? 1 : -1);
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
        if (selectedPhotoId) {
          closePhoto();
          return;
        }

        if (slideshowVisible) {
          setSlideshowVisible(false);
        }
        return;
      }

      if (selectedPhotoId && event.key === 'ArrowLeft') {
        moveSelectedPhoto(-1);
      } else if (selectedPhotoId && event.key === 'ArrowRight') {
        moveSelectedPhoto(1);
      } else if (slideshowVisible && event.key === 'ArrowLeft') {
        moveSlide(-1);
      } else if (slideshowVisible && event.key === 'ArrowRight') {
        moveSlide(1);
      }
    }

    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  }, [selectedPhotoId, slideshowVisible, selectedPhotoIndex, hasMultipleDisplayPhotos, hasMultipleSlides]);

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
    <div className={`app-shell ${slideshowVisible ? 'is-slideshow-mode' : ''}`}>
      <div className="background-orb orb-left" />
      <div className="background-orb orb-right" />

      {!slideshowVisible ? (
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
                {!systemStatus.loading ? (
                  <div className={systemStatusClassName} title={systemStatus.message}>
                    <Images size={16} />
                    {statusPresentation.label}
                  </div>
                ) : null}
                <button
                  type="button"
                  className="secondary-button topbar-action-button"
                  onClick={() => setSlideshowVisible(true)}
                >
                  슬라이드 보기
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
                {!systemStatus.loading ? (
                  <div className={systemStatusClassName} title={systemStatus.message}>
                    <Images size={16} />
                    {statusPresentation.label}
                  </div>
                ) : null}
                <button
                  type="button"
                  className="secondary-button topbar-action-button"
                  onClick={() => setSlideshowVisible(true)}
                >
                  슬라이드쇼 보기
                </button>
                <Link className="secondary-button topbar-action-button" to="/admin">
                  관리자
                </Link>
              </div>
            </div>
          )}
        </header>
      ) : null}

      {slideshowVisible && activeSlide ? (
        <section className="hero-panel slideshow-panel">
          <div
            className="slideshow-stage"
            onTouchStart={handleSlideshowTouchStart}
            onTouchEnd={handleSlideshowTouchEnd}
          >
            <div
              className="slideshow-backdrop-image"
              style={{ backgroundImage: `url(${activeSlide.thumbUrl || activeSlide.imageUrl})` }}
              aria-hidden="true"
            />
            <button
              type="button"
              className="slideshow-photo-button"
              onClick={(event) => openPhoto(activeSlide, event)}
              aria-label={`${getDisplayPhotoTitle(activeSlide)} 슬라이드 사진 크게 보기`}
              >
                <ResilientImage
                  sources={[activeSlide.thumbUrl, activeSlide.imageUrl]}
                  alt={getDisplayPhotoTitle(activeSlide)}
                  className="slideshow-image"
                  decoding="async"
                />
            </button>
            <button
              type="button"
              className="icon-button slideshow-close-button"
              onClick={() => setSlideshowVisible(false)}
              aria-label="슬라이드쇼 닫기"
            >
              <X size={20} />
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

            <div className="hero-actions-inline">
              <button
                type="button"
                className="secondary-button topbar-action-button"
                onClick={() => setSlideshowVisible(false)}
              >
                갤러리 보기
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {!slideshowVisible ? (
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
            <span>{loadingMore ? `사진 ${photos.length}/${stats.total}장을 불러오는 중` : `사진 ${stats.total}장`}</span>
          </div>
        ) : null}
        </section>
      ) : null}

      {!slideshowVisible && error ? <p className="error-banner">{error}</p> : null}
      {!slideshowVisible && loading && !photos.length ? <p className="admin-loading">사진 목록을 불러오는 중입니다.</p> : null}

      {!slideshowVisible ? (
        <main className={isMobileExperience ? 'gallery-grid mobile-gallery-grid' : 'gallery-grid'}>
        {displayPhotos.map((photo, index) => (
          <article
            className="photo-card"
            key={photo.id}
            style={{ animationDelay: `${index * 80}ms` }}
          >
            <button
              type="button"
              className="photo-open-button"
              onClick={(event) => openPhoto(photo, event)}
              aria-label={`${getDisplayPhotoTitle(photo)} 크게 보기`}
            >
              <div className="photo-frame">
                <ResilientImage
                  sources={[photo.thumbUrl, photo.imageUrl]}
                  alt={photo.title}
                  className="photo-card-image"
                  loading="lazy"
                  decoding="async"
                />
              </div>

              <div className="photo-content">
                <div className="photo-heading">
                  <div>
                    <h2>{getDisplayPhotoTitle(photo)}</h2>
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
        {!loading && !displayPhotos.length ? (
          <article className="photo-card photo-card-empty">
            <div className="photo-content">
              <div className="photo-heading">
                <div>
                  <h2>표시할 사진이 없습니다.</h2>
                </div>
              </div>
            </div>
          </article>
        ) : null}
        </main>
      ) : null}

      {selectedPhoto ? (
        <div
          className="photo-modal-backdrop"
          onClick={handleBackdropClick}
          role="presentation"
        >
          <section
            className="photo-modal"
            aria-label={`${getDisplayPhotoTitle(selectedPhoto)} 사진 크게 보기`}
            onClick={() => closePhoto()}
          >
            <div className="photo-modal-panel">
              <div className="photo-modal-media">
                <div className="photo-modal-visual">
                  <TransitioningModalImage
                    photo={selectedPhoto}
                    alt={getDisplayPhotoTitle(selectedPhoto)}
                    className="photo-modal-image"
                    onClick={() => closePhoto()}
                  />
                </div>
              </div>
              <div className="photo-modal-meta">
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
