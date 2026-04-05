import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, Download, Images, LoaderCircle, MapPin, MessageSquareText, Search, X } from 'lucide-react';
import { getPhotoDownloadUrl, getPublicPhotos, getPublicSystemStatus } from '../lib/galleryApi';
import { formatDate, getDisplayPhotoTitle } from '../lib/photoUtils';

const PUBLIC_GALLERY_REFRESH_MS = 10000;
const STATUS_REFRESH_MS = 15000;

export default function MobileGalleryPage() {
  const [photos, setPhotos] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [selectedPhoto, setSelectedPhoto] = useState(null);
  const [systemStatus, setSystemStatus] = useState({
    loading: true,
    renderOk: false,
    storageOk: false,
    storageBackend: '',
    message: '상태 확인 중',
  });

  async function loadPublicGallery({ silent = false } = {}) {
    if (!silent) {
      setLoading(true);
    } else {
      setRefreshing(true);
    }

    try {
      const nextPhotos = await getPublicPhotos();
      setPhotos(nextPhotos);
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

    async function boot() {
      if (!active) {
        return;
      }

      await loadPublicGallery();
      await loadSystemStatus();
    }

    boot();

    const galleryInterval = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !selectedPhoto) {
        loadPublicGallery({ silent: true });
      }
    }, PUBLIC_GALLERY_REFRESH_MS);

    const statusInterval = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !selectedPhoto) {
        loadSystemStatus();
      }
    }, STATUS_REFRESH_MS);

    return () => {
      active = false;
      window.clearInterval(galleryInterval);
      window.clearInterval(statusInterval);
    };
  }, [selectedPhoto]);

  useEffect(() => {
    function handleKeydown(event) {
      if (event.key === 'Escape') {
        setSelectedPhoto(null);
      }
    }

    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  }, []);

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

  const statusClassName = systemStatus.loading
    ? 'status-pill status-pill-pending mobile-public-status'
    : systemStatus.renderOk && systemStatus.storageOk
      ? 'status-pill status-pill-connected mobile-public-status'
      : 'status-pill status-pill-disconnected mobile-public-status';

  return (
    <div className="mobile-public-shell">
      <header className="mobile-public-header">
        <div>
          <p className="eyebrow">Mobile Public Gallery</p>
          <h1>그날의 기록</h1>
          <p className="mobile-public-subtitle">
            공개 사진 {photos.length}장
            {refreshing ? ' · 새로고침 중' : ''}
          </p>
        </div>
        <div className={statusClassName} title={systemStatus.message}>
          {systemStatus.loading ? <LoaderCircle size={16} className="spin" /> : <Images size={16} />}
          {systemStatus.loading
            ? '신호 확인 중'
            : systemStatus.renderOk && systemStatus.storageOk
              ? `정상 연결 · ${systemStatus.storageBackend === 'r2' ? 'Cloudflare' : 'Local'}`
              : '연결 이상'}
        </div>
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
      </section>

      {error ? <p className="error-banner">{error}</p> : null}
      {loading ? <p className="admin-loading">사진 목록을 불러오는 중입니다.</p> : null}

      <main className="mobile-public-feed">
        {displayPhotos.map((photo) => (
          <button
            key={photo.id}
            type="button"
            className="mobile-public-card"
            onPointerUp={() => setSelectedPhoto(photo)}
            onClick={(event) => {
              if (event.detail === 0) {
                setSelectedPhoto(photo);
              }
            }}
          >
            <div className="mobile-public-photo-frame">
              <img
                src={photo.thumbUrl || photo.imageUrl}
                alt={getDisplayPhotoTitle(photo)}
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
      </main>

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
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
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
              <img
                className="mobile-public-modal-image"
                src={selectedPhoto.imageUrl || selectedPhoto.thumbUrl}
                alt={getDisplayPhotoTitle(selectedPhoto)}
                decoding="async"
              />
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
