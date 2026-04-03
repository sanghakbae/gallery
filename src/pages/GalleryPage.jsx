import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CalendarDays,
  Download,
  Images,
  MapPin,
  MessageSquareText,
  Search,
  X,
} from 'lucide-react';
import { getPhotoDownloadUrl, getPublicPhotos } from '../lib/galleryApi';
import { formatDate } from '../lib/photoUtils';

const PUBLIC_GALLERY_REFRESH_MS = 10000;
const DEFAULT_WATERMARK = 'totoriverce@naver.com';

const starterMemories = [
  {
    id: 'starter-1',
    title: '아직 공개된 사진이 없습니다',
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
          <text x="64" y="164" fill="#fff8ef" font-family="KoPub Dotum, sans-serif" font-size="44">관리자 페이지에서</text>
          <text x="64" y="220" fill="#fff8ef" font-family="KoPub Dotum, sans-serif" font-size="44">첫 사진을 올려 주세요</text>
        </svg>
      `),
    locationText: '공개 갤러리는 로그인 없이 볼 수 있습니다.',
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
      setError('공개 사진을 불러오지 못했습니다.');
    } finally {
      if (!silent) {
        setLoading(false);
      } else {
        setRefreshing(false);
      }
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

    const intervalId = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        loadPublicPhotos({ silent: true });
      }
    }, PUBLIC_GALLERY_REFRESH_MS);

    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') {
        loadPublicPhotos({ silent: true });
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      active = false;
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    function handleKeydown(event) {
      if (event.key === 'Escape') {
        setSelectedPhotoId(null);
      }
    }

    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  }, []);

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

  const selectedPhoto = useMemo(() => {
    const source = photos.length > 0 ? photos : starterMemories;
    return source.find((photo) => photo.id === selectedPhotoId) ?? null;
  }, [photos, selectedPhotoId]);

  return (
    <div className="app-shell">
      <div className="background-orb orb-left" />
      <div className="background-orb orb-right" />

      <header className="hero">
        <div className="gallery-topbar">
          <div className="gallery-topbar-copy">
            <p className="eyebrow">Public Gallery</p>
            <h1>Photo&apos;s room</h1>
            <p className="gallery-topbar-meta">
              공개 사진 {stats.total}장
              <span className="gallery-topbar-divider">·</span>
              최근 촬영 {stats.latest}
            </p>
          </div>

          <div className="gallery-topbar-actions">
            <div className="status-pill topbar-action-button topbar-status-pill">
              <Images size={16} />
              {loading
                ? '불러오는 중'
                : refreshing
                  ? '갱신 중'
                  : '공개 열람'}
            </div>
            <Link className="secondary-button topbar-action-button" to="/admin">
              관리자
            </Link>
          </div>
        </div>
      </header>

      <section className="toolbar">
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

        <div className="toolbar-info">
          <Images size={18} />
          <span>공개 갤러리입니다. 관리자만 업로드와 편집이 가능합니다.</span>
        </div>
      </section>

      {error ? <p className="error-banner">{error}</p> : null}

      <main className="gallery-grid">
        {displayPhotos.map((photo, index) => (
          <article
            className={`photo-card ${photo.isPlaceholder ? 'placeholder-card' : ''}`}
            key={photo.id}
            style={{ animationDelay: `${index * 80}ms` }}
          >
            <button
              type="button"
              className="photo-open-button"
              onClick={() => setSelectedPhotoId(photo.id)}
              aria-label={`${photo.title} 크게 보기`}
            >
              <div className="photo-frame">
                <img src={photo.imageUrl} alt={photo.title} />
                <span className="photo-watermark">{DEFAULT_WATERMARK}</span>
              </div>

              <div className="photo-content">
                <div className="photo-heading">
                  <div>
                    <h2>{photo.title}</h2>
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
          onClick={() => setSelectedPhotoId(null)}
          role="presentation"
        >
          <section
            className="photo-modal"
            onClick={(event) => event.stopPropagation()}
            aria-label={`${selectedPhoto.title} 사진 크게 보기`}
          >
            <div className="photo-modal-media">
              <div className="photo-modal-visual">
                <button
                  type="button"
                  className="icon-button modal-close-button"
                  onClick={() => setSelectedPhotoId(null)}
                  aria-label="상세 보기 닫기"
                >
                  <X size={18} />
                </button>
                <img src={selectedPhoto.imageUrl} alt={selectedPhoto.title} />
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
            </div>
            <div className="photo-modal-meta">
              <h2>{selectedPhoto.title}</h2>
              <p>{selectedPhoto.note || '등록된 메모가 없습니다.'}</p>
              <p>{selectedPhoto.locationText || '위치 정보 없음'}</p>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
