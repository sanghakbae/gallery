import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CalendarDays,
  Download,
  Heart,
  Images,
  MapPin,
  MessageSquareText,
  Search,
} from 'lucide-react';
import ResilientImage from '../components/ResilientImage';
import TransitioningModalImage from '../components/TransitioningModalImage';
import {
  addPublicPhotoLike,
  getPhotoDownloadUrl,
  getPublicPhotosPage,
  getPublicSystemStatus,
  removePublicPhotoLike,
} from '../lib/galleryApi';
import { loadLikedPhotoIds, saveLikedPhotoIds } from '../lib/photoLikes';
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
  const [likedPhotoIds, setLikedPhotoIds] = useState(() => loadLikedPhotoIds());
  const slideshowTouchStartRef = useRef(null);
  const slideshowOpenedAtRef = useRef(0);
  const wasLandscapeRef = useRef(false);
  const progressiveLoadGenerationRef = useRef(0);
  const photoCardRefs = useRef(new Map());
  const pendingRestorePhotoIdRef = useRef(null);
  const lastModalCloseAtRef = useRef(0);

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

      // Auto-start the slideshow when the phone is rotated to landscape, and
      // return to the feed when rotated back to portrait. Only act on an actual
      // orientation change so a manual portrait slideshow isn't disturbed.
      if (nextLandscape && !wasLandscapeRef.current) {
        slideshowOpenedAtRef.current = Date.now();
        setSlideshowVisible(true);
      } else if (!nextLandscape && wasLandscapeRef.current) {
        setSlideshowVisible(false);
      }
      wasLandscapeRef.current = nextLandscape;
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

  useEffect(() => {
    if (selectedPhoto || !pendingRestorePhotoIdRef.current) {
      return;
    }

    const restorePhotoId = pendingRestorePhotoIdRef.current;
    pendingRestorePhotoIdRef.current = null;

    const frameId = window.requestAnimationFrame(() => {
      const target = photoCardRefs.current.get(restorePhotoId);
      if (!target) {
        return;
      }

      target.scrollIntoView({
        block: 'center',
        inline: 'nearest',
        behavior: 'smooth',
      });
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [selectedPhoto, displayPhotos]);

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

  function updatePhotoLikeCount(photoId, likeCount) {
    setPhotos((current) =>
      current.map((photo) => (
        photo.id === photoId
          ? { ...photo, likeCount }
          : photo
      )),
    );
    setSelectedPhoto((current) => (
      current?.id === photoId
        ? { ...current, likeCount }
        : current
    ));
  }

  async function togglePhotoLike(photo, event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();

    if (!photo?.id) {
      return;
    }

    const liked = likedPhotoIds.has(photo.id);
    const nextLikeCount = Math.max(0, Number(photo.likeCount || 0) + (liked ? -1 : 1));
    const nextLikedPhotoIds = new Set(likedPhotoIds);

    if (liked) {
      nextLikedPhotoIds.delete(photo.id);
    } else {
      nextLikedPhotoIds.add(photo.id);
    }

    setLikedPhotoIds(nextLikedPhotoIds);
    saveLikedPhotoIds(nextLikedPhotoIds);
    updatePhotoLikeCount(photo.id, nextLikeCount);

    try {
      const response = liked
        ? await removePublicPhotoLike(photo.id)
        : await addPublicPhotoLike(photo.id);
      updatePhotoLikeCount(photo.id, Math.max(0, Number(response?.likeCount || 0)));
    } catch (error) {
      const rollbackLikedPhotoIds = new Set(nextLikedPhotoIds);
      if (liked) {
        rollbackLikedPhotoIds.add(photo.id);
      } else {
        rollbackLikedPhotoIds.delete(photo.id);
      }

      setLikedPhotoIds(rollbackLikedPhotoIds);
      saveLikedPhotoIds(rollbackLikedPhotoIds);
      updatePhotoLikeCount(photo.id, Math.max(0, Number(photo.likeCount || 0)));
      console.error(error);
    }
  }

  function openSlideshow() {
    slideshowOpenedAtRef.current = Date.now();
    setSlideshowVisible(true);
  }

  function closeSlideshowToGallery(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    setSlideshowVisible(false);
    setSelectedPhoto(null);
  }

  function handleSlideshowSpeedChange(event, speed) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    setSlideshowSpeed(speed);
  }

  function openSelectedPhoto(photo) {
    if (Date.now() - lastModalCloseAtRef.current < 400) {
      return;
    }
    pendingRestorePhotoIdRef.current = null;
    setSelectedPhoto(photo);
  }

  function closeSelectedPhoto(event, photoId = selectedPhoto?.id) {
    event?.preventDefault?.();
    event?.stopPropagation?.();

    if (photoId) {
      pendingRestorePhotoIdRef.current = photoId;
    }

    lastModalCloseAtRef.current = Date.now();
    setSelectedPhoto(null);
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
                onClick={openSlideshow}
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
              aria-label="다음 사진"
              onClick={() => {
                if (hasMultiplePhotos) {
                  setActiveSlideIndex((current) => (current + 1) % displayPhotos.length);
                }
              }}
            >
              <ResilientImage
                sources={[activeSlide.imageUrl, activeSlide.thumbUrl]}
                alt={getDisplayPhotoTitle(activeSlide)}
                className="mobile-public-slideshow-image"
              />
            </button>
            <button
              type="button"
              className="icon-button mobile-public-slideshow-close"
              onPointerUp={closeSlideshowToGallery}
              onClick={closeSlideshowToGallery}
              aria-label="슬라이드쇼 닫기"
            >
              <X size={18} />
            </button>
          </div>
          <div
            className="mobile-public-slideshow-controls"
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="slideshow-speed-selector" role="radiogroup" aria-label="모바일 슬라이드쇼 속도">
              {SLIDESHOW_SPEED_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`slideshow-speed-button ${slideshowSpeed === option.value ? 'is-active' : ''}`}
                  onPointerUp={(event) => handleSlideshowSpeedChange(event, option.value)}
                  onClick={(event) => handleSlideshowSpeedChange(event, option.value)}
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
              onPointerUp={closeSlideshowToGallery}
              onClick={closeSlideshowToGallery}
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
            ref={(node) => {
              if (node) {
                photoCardRefs.current.set(photo.id, node);
              } else {
                photoCardRefs.current.delete(photo.id);
              }
            }}
            onClick={() => openSelectedPhoto(photo)}
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
              <div className="mobile-public-card-heading">
                <h2>{getDisplayPhotoTitle(photo)}</h2>
                <button
                  type="button"
                  className={`icon-button like-button ${likedPhotoIds.has(photo.id) ? 'is-liked' : ''}`}
                  onClick={(event) => togglePhotoLike(photo, event)}
                  aria-label={likedPhotoIds.has(photo.id) ? '좋아요 취소' : '좋아요'}
                >
                  <Heart size={16} fill={likedPhotoIds.has(photo.id) ? 'currentColor' : 'none'} />
                  <span>{Math.max(0, Number(photo.likeCount || 0))}</span>
                </button>
              </div>
              <div className="mobile-public-meta">
                <span>
                  <CalendarDays size={14} />
                  {photo.capturedAt ? formatDate(photo.capturedAt) : '촬영일 정보 없음'}
                </span>
                {photo.mapsUrl ? (
                  <a
                    className="photo-location-link"
                    href={photo.mapsUrl}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <MapPin size={14} />
                    {photo.locationText || '지도에서 보기'}
                  </a>
                ) : (
                  <span>
                    <MapPin size={14} />
                    {photo.locationText || '위치 정보 없음'}
                  </span>
                )}
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
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          role="presentation"
        >
          <section
            className="mobile-public-modal"
            aria-label={`${getDisplayPhotoTitle(selectedPhoto)} 사진 크게 보기`}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <div
              className="mobile-public-modal-image-wrap"
              onPointerUp={(event) => closeSelectedPhoto(event, selectedPhoto.id)}
              onClick={(event) => closeSelectedPhoto(event, selectedPhoto.id)}
            >
              <TransitioningModalImage
                photo={selectedPhoto}
                className="mobile-public-modal-image"
                alt={getDisplayPhotoTitle(selectedPhoto)}
              />
            </div>

            <div className="mobile-public-modal-copy">
              <div className="mobile-public-modal-heading">
                <h2>{getDisplayPhotoTitle(selectedPhoto)}</h2>
                <a
                  className="secondary-button topbar-action-button mobile-public-download"
                  href={getPhotoDownloadUrl(selectedPhoto)}
                  download
                  onPointerDown={(event) => event.stopPropagation()}
                  onPointerUp={(event) => event.stopPropagation()}
                  onClick={(event) => event.stopPropagation()}
                >
                  <Download size={16} />
                  사진 다운로드
                </a>
                <button
                  type="button"
                  className={`icon-button like-button ${likedPhotoIds.has(selectedPhoto.id) ? 'is-liked' : ''}`}
                  onPointerDown={(event) => event.stopPropagation()}
                  onPointerUp={(event) => event.stopPropagation()}
                  onClick={(event) => togglePhotoLike(selectedPhoto, event)}
                  aria-label={likedPhotoIds.has(selectedPhoto.id) ? '좋아요 취소' : '좋아요'}
                >
                  <Heart size={16} fill={likedPhotoIds.has(selectedPhoto.id) ? 'currentColor' : 'none'} />
                  <span>{Math.max(0, Number(selectedPhoto.likeCount || 0))}</span>
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
