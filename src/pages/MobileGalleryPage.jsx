import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarDays, ChevronLeft, ChevronRight, Download, Images, MapPin, MessageSquareText, Search, X } from 'lucide-react';
import ResilientImage from '../components/ResilientImage';
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
const INITIAL_PHOTO_BATCH_SIZE = 30;
const FOLLOW_UP_BATCH_SIZE = 60;
const SLIDESHOW_SPEED_OPTIONS = [
  { label: '2초', value: 2000 },
  { label: '5초', value: 5000 },
  { label: '10초', value: 10000 },
];

function isMobileLandscapeViewport() {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.innerWidth > window.innerHeight;
}

export default function MobileGalleryPage() {
  const [photos, setPhotos] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [totalPhotoCount, setTotalPhotoCount] = useState(0);
  const [error, setError] = useState('');
  const [selectedPhoto, setSelectedPhoto] = useState(null);
  const [activeSlideIndex, setActiveSlideIndex] = useState(0);
  const [slideshowVisible, setSlideshowVisible] = useState(false);
  const [slideshowSpeed, setSlideshowSpeed] = useState(5000);
  const [isLandscapeViewport, setIsLandscapeViewport] = useState(() => isMobileLandscapeViewport());
  const [systemStatus, setSystemStatus] = useState(() => createInitialSystemStatus());
  const slideshowTouchStartRef = useRef(null);
  const progressiveLoadGenerationRef = useRef(0);

  async function loadPublicGallery() {
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

    async function boot() {
      if (!active) {
        return;
      }

      await loadPublicGallery();
    }

    boot();
    loadSystemStatus();

    const statusInterval = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !selectedPhoto) {
        loadSystemStatus();
      }
    }, STATUS_REFRESH_MS);

    return () => {
      active = false;
      progressiveLoadGenerationRef.current += 1;
      window.clearInterval(statusInterval);
    };
  }, [selectedPhoto]);

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

  const selectedPhotoIndex = useMemo(() => {
    if (!selectedPhoto) {
      return -1;
    }
    return displayPhotos.findIndex((photo) => photo.id === selectedPhoto.id);
  }, [displayPhotos, selectedPhoto]);

  useBodyScrollLock(Boolean(selectedPhoto));

  const hasMultiplePhotos = displayPhotos.length > 1;
  const activeSlide = displayPhotos[activeSlideIndex] ?? displayPhotos[0] ?? null;

  useEffect(() => {
    function handleKeydown(event) {
      if (event.key === 'Escape') {
        if (selectedPhoto) {
          setSelectedPhoto(null);
          return;
        }

        if (slideshowVisible) {
          setSlideshowVisible(false);
          return;
        }
      }

      if (selectedPhoto) {
        if (event.key === 'ArrowLeft' && hasMultiplePhotos) {
          const nextIndex = (selectedPhotoIndex - 1 + displayPhotos.length) % displayPhotos.length;
          setSelectedPhoto(displayPhotos[nextIndex] ?? null);
        } else if (event.key === 'ArrowRight' && hasMultiplePhotos) {
          const nextIndex = (selectedPhotoIndex + 1) % displayPhotos.length;
          setSelectedPhoto(displayPhotos[nextIndex] ?? null);
        }
        return;
      }

      if (!slideshowVisible) {
        return;
      }

      if (event.key === 'ArrowLeft' && hasMultiplePhotos) {
        setActiveSlideIndex((current) => (current - 1 + displayPhotos.length) % displayPhotos.length);
      } else if (event.key === 'ArrowRight' && hasMultiplePhotos) {
        setActiveSlideIndex((current) => (current + 1) % displayPhotos.length);
      }
    }

    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  }, [selectedPhoto, slideshowVisible, hasMultiplePhotos, selectedPhotoIndex, displayPhotos]);

  useEffect(() => {
    function syncLandscapeSlideshow() {
      const nextLandscape = isMobileLandscapeViewport();
      setIsLandscapeViewport(nextLandscape);
    }

    syncLandscapeSlideshow();
    window.addEventListener('resize', syncLandscapeSlideshow);
    window.addEventListener('orientationchange', syncLandscapeSlideshow);

    return () => {
      window.removeEventListener('resize', syncLandscapeSlideshow);
      window.removeEventListener('orientationchange', syncLandscapeSlideshow);
    };
  }, []);

  useEffect(() => {
    if (!displayPhotos.length) {
      setActiveSlideIndex(0);
      return;
    }

    setActiveSlideIndex((current) => Math.min(current, displayPhotos.length - 1));
  }, [displayPhotos]);

  useEffect(() => {
    if (displayPhotos.length < 2 || !slideshowVisible) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      setActiveSlideIndex((current) => (current + 1) % displayPhotos.length);
    }, slideshowSpeed);

    return () => window.clearInterval(intervalId);
  }, [displayPhotos.length, slideshowSpeed, slideshowVisible]);

  const statusPresentation = getSystemStatusPresentation(systemStatus);
  const statusClassName = `${statusPresentation.className} mobile-public-status`;

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
    if (Math.abs(deltaX) < 48 || !hasMultiplePhotos) {
      return;
    }

    setActiveSlideIndex((current) =>
      deltaX < 0
        ? (current + 1) % displayPhotos.length
        : (current - 1 + displayPhotos.length) % displayPhotos.length,
    );
  }

  return (
    <div
      className={`mobile-public-shell ${
        slideshowVisible && activeSlide && isLandscapeViewport ? 'is-landscape' : ''
      } ${slideshowVisible && activeSlide ? 'is-slideshow-only' : ''}`}
    >
      {!slideshowVisible || !activeSlide ? (
        <>
          <header className="mobile-public-header">
            <div>
              <p className="eyebrow">Mobile Public Gallery</p>
              <h1>그날의 기록</h1>
              <p className="mobile-public-subtitle">
                공개 사진 {totalPhotoCount || photos.length}장
              </p>
            </div>
            {!systemStatus.loading ? (
              <div className={statusClassName} title={systemStatus.message}>
                <Images size={16} />
                {statusPresentation.label}
              </div>
            ) : null}
          </header>

          <section className="mobile-public-toolbar">
            <label className="search-field" htmlFor="mobile-photo-search">
              <Search size={18} />
              <input
                id="mobile-photo-search"
                type="search"
                placeholder="제목, 위치, 메모, 파일명 검색"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <div className="mobile-public-toolbar-actions">
              <button
                type="button"
                className="secondary-button topbar-action-button"
                onClick={() => setSlideshowVisible(true)}
              >
                슬라이드 보기
              </button>
              <Link className="secondary-button topbar-action-button" to="/admin">
                관리자
              </Link>
            </div>
          </section>

          {error ? <p className="error-banner">{error}</p> : null}
          {loading && !photos.length ? <p className="admin-loading">사진 목록을 불러오는 중입니다.</p> : null}
          {!loading && loadingMore ? <p className="admin-loading">사진을 순차적으로 더 불러오는 중입니다.</p> : null}
        </>
      ) : null}

      {slideshowVisible && activeSlide ? (
        <section className="mobile-public-slideshow">
          <div
            className="mobile-public-slideshow-stage"
            onTouchStart={handleSlideshowTouchStart}
            onTouchEnd={handleSlideshowTouchEnd}
          >
            <div
              className="mobile-public-slideshow-backdrop"
              style={{ backgroundImage: `url(${activeSlide.thumbUrl || activeSlide.imageUrl})` }}
              aria-hidden="true"
            />
            <button
              type="button"
              className="mobile-public-slideshow-photo"
              onClick={() => setSelectedPhoto(activeSlide)}
            >
              <ResilientImage
                sources={[activeSlide.thumbUrl, activeSlide.imageUrl]}
                alt={getDisplayPhotoTitle(activeSlide)}
                className="mobile-public-slideshow-image"
              />
            </button>
            <button
              type="button"
              className="icon-button mobile-public-slideshow-close"
              onClick={() => setSlideshowVisible(false)}
              aria-label="슬라이드쇼 닫기"
            >
              <X size={18} />
            </button>
            {hasMultiplePhotos ? (
              <>
                <button
                  type="button"
                  className="icon-button mobile-public-slideshow-nav mobile-public-slideshow-nav-left"
                  onClick={() => {
                    setActiveSlideIndex((current) => (current - 1 + displayPhotos.length) % displayPhotos.length);
                  }}
                  aria-label="이전 슬라이드"
                >
                  <ChevronLeft size={18} />
                </button>
                <button
                  type="button"
                  className="icon-button mobile-public-slideshow-nav mobile-public-slideshow-nav-right"
                  onClick={() => {
                    setActiveSlideIndex((current) => (current + 1) % displayPhotos.length);
                  }}
                  aria-label="다음 슬라이드"
                >
                  <ChevronRight size={18} />
                </button>
              </>
            ) : null}
          </div>
          <div className="mobile-public-slideshow-controls">
            <div className="slideshow-speed-selector" role="radiogroup" aria-label="모바일 슬라이드쇼 속도">
              {SLIDESHOW_SPEED_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`slideshow-speed-button ${slideshowSpeed === option.value ? 'is-active' : ''}`}
                  onClick={() => setSlideshowSpeed(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <div className="slideshow-position" aria-live="polite">
              {displayPhotos.length > 0 ? `${activeSlideIndex + 1} / ${displayPhotos.length}` : '0 / 0'}
            </div>
            <button
              type="button"
              className="secondary-button topbar-action-button"
              onClick={() => setSlideshowVisible(false)}
            >
              갤러리 보기
            </button>
          </div>
        </section>
      ) : null}

      {!slideshowVisible || !activeSlide ? (
        <main className="mobile-public-feed">
        {displayPhotos.map((photo) => (
          <button
            key={photo.id}
            type="button"
            className="mobile-public-card"
            onClick={() => setSelectedPhoto(photo)}
          >
            <div className="mobile-public-photo-frame">
              <ResilientImage
                sources={[photo.thumbUrl, photo.imageUrl]}
                alt={getDisplayPhotoTitle(photo)}
                className="mobile-public-card-image"
                loading="lazy"
                decoding="async"
              />
            </div>

            <div className="mobile-public-copy">
              <h2>{getDisplayPhotoTitle(photo)}</h2>
              <div className="mobile-public-meta">
                <span>
                  <CalendarDays size={14} />
                  {photo.capturedAt ? formatDate(photo.capturedAt) : '촬영일 정보 없음'}
                </span>
                <span>
                  <MapPin size={14} />
                  {photo.locationText || '위치 정보 없음'}
                </span>
                {photo.note ? (
                  <span>
                    <MessageSquareText size={14} />
                    {photo.note}
                  </span>
                ) : null}
              </div>
            </div>
          </button>
        ))}
        {!loading && !displayPhotos.length ? (
          <div className="mobile-public-card mobile-public-card-empty">
            <div className="mobile-public-copy">
              <h2>표시할 사진이 없습니다.</h2>
            </div>
          </div>
        ) : null}
        </main>
      ) : null}

      {selectedPhoto ? (
        <div
          className="mobile-public-modal-backdrop"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) {
              setSelectedPhoto(null);
            }
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setSelectedPhoto(null);
            }
          }}
          role="presentation"
        >
          <section
            className="mobile-public-modal"
            aria-label={`${getDisplayPhotoTitle(selectedPhoto)} 사진 크게 보기`}
          >
            <button
              type="button"
              className="icon-button mobile-public-close"
              onClick={() => setSelectedPhoto(null)}
              aria-label="사진 닫기"
            >
              <X size={18} />
            </button>

            <div className="mobile-public-modal-image-wrap">
              {hasMultiplePhotos ? (
                <button
                  type="button"
                  className="icon-button mobile-public-modal-nav mobile-public-modal-nav-left"
                  onClick={() => {
                    const nextIndex = (selectedPhotoIndex - 1 + displayPhotos.length) % displayPhotos.length;
                    setSelectedPhoto(displayPhotos[nextIndex] ?? null);
                  }}
                  aria-label="이전 사진"
                >
                  <ChevronLeft size={18} />
                </button>
              ) : null}
              <ResilientImage
                sources={[selectedPhoto.imageUrl, selectedPhoto.thumbUrl]}
                className="mobile-public-modal-image"
                alt={getDisplayPhotoTitle(selectedPhoto)}
                decoding="async"
                onClick={() => setSelectedPhoto(null)}
              />
              {hasMultiplePhotos ? (
                <button
                  type="button"
                  className="icon-button mobile-public-modal-nav mobile-public-modal-nav-right"
                  onClick={() => {
                    const nextIndex = (selectedPhotoIndex + 1) % displayPhotos.length;
                    setSelectedPhoto(displayPhotos[nextIndex] ?? null);
                  }}
                  aria-label="다음 사진"
                >
                  <ChevronRight size={18} />
                </button>
              ) : null}
            </div>

            <div className="mobile-public-modal-copy">
              <h2>{getDisplayPhotoTitle(selectedPhoto)}</h2>
              <p>{selectedPhoto.note || '등록된 메모가 없습니다.'}</p>
              <p>{selectedPhoto.locationText || '위치 정보 없음'}</p>
              <a
                className="secondary-button topbar-action-button mobile-public-download"
                href={getPhotoDownloadUrl(selectedPhoto)}
                download
              >
                <Download size={16} />
                사진 다운로드
              </a>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
