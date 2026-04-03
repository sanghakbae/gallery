import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import exifr from 'exifr';
import { LoaderCircle, LogOut, PencilLine, ShieldCheck, Trash2, Upload } from 'lucide-react';
import {
  clearAdminSession,
  decodeJwt,
  isAllowedAdminEmail,
  loadAdminSession,
  loadGoogleIdentityScript,
  saveAdminSession,
} from '../lib/googleAuth';
import { deleteAdminPhoto, getAdminPhotos, updateAdminPhoto, uploadAdminPhoto } from '../lib/galleryApi';
import {
  formatCoordinates,
  formatDate,
  getGoogleMapsUrl,
  getLocationLabel,
  getSeasonLabel,
} from '../lib/photoUtils';

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '';
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

function AdminLogin({ error, loading, onLogin, buttonContainerRef }) {
  return (
    <div className="admin-login-card">
      <p className="eyebrow">Admin</p>
      <h1>관리자 페이지</h1>
      <p className="hero-text">
        관리자만 Google 계정으로 로그인해서 사진을 업로드하고 제목, 메모, 위치를 수정할 수 있습니다.
      </p>
      <div className="admin-login-actions">
        <div ref={buttonContainerRef} className="google-login-slot" />
        <button type="button" className="secondary-button" onClick={onLogin} disabled={loading}>
          {loading ? <LoaderCircle size={18} className="spin" /> : <ShieldCheck size={18} />}
          Google 로그인 다시 시도
        </button>
      </div>
      {error ? <p className="error-banner admin-error">{error}</p> : null}
      <p className="admin-hint">
        허용 이메일 제한은 `VITE_ADMIN_EMAILS`와 서버 `ADMIN_EMAILS`에서 함께 관리합니다.
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
  const [loading, setLoading] = useState(true);
  const [authLoading, setAuthLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState({
    current: 0,
    total: 0,
    title: '',
    detail: '',
  });
  const [error, setError] = useState('');

  useEffect(() => {
    async function loadPhotos() {
      if (!session?.credential) {
        setPhotos([]);
        setLoading(false);
        return;
      }

      try {
        const result = await getAdminPhotos();
        setPhotos(result);
      } catch (loadError) {
        console.error(loadError);
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
            setError('허용되지 않은 관리자 계정입니다.');
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

  async function handleUpload(event) {
    const selectedFiles = Array.from(event.target.files ?? []);
    if (selectedFiles.length === 0) {
      return;
    }

    setError('');
    setUploading(true);
    setUploadProgress({
      current: 0,
      total: selectedFiles.length * 3,
      title: '',
      detail: '업로드 준비 중',
    });

    try {
      const uploadedPhotos = [];

      for (const [index, file] of selectedFiles.entries()) {
        const baseStep = index * 3;
        setUploadProgress({
          current: baseStep + 1,
          total: selectedFiles.length * 3,
          title: file.name,
          detail: '파일 확인 중',
        });

        if (!isSupportedUploadFile(file)) {
          continue;
        }

        const metadata = await exifr.parse(file, {
          gps: true,
          tiff: true,
          ifd0: true,
          exif: true,
        });
        setUploadProgress({
          current: baseStep + 2,
          total: selectedFiles.length * 3,
          title: file.name,
          detail: '서버로 업로드 중',
        });

        const latitude = metadata?.latitude ?? metadata?.lat ?? null;
        const longitude = metadata?.longitude ?? metadata?.lon ?? null;
        const capturedDate =
          metadata?.DateTimeOriginal ??
          metadata?.CreateDate ??
          metadata?.ModifyDate ??
          null;

        // eslint-disable-next-line no-await-in-loop
        const savedPhoto = await uploadAdminPhoto({
          file,
          meta: {
            title: file.name.replace(/\.[^.]+$/, ''),
            fileName: file.name,
            note: '',
            capturedAt: capturedDate ? new Date(capturedDate).toISOString() : '',
            locationText: getLocationLabel(latitude, longitude),
            coordinatesText: formatCoordinates(latitude, longitude),
            mapsUrl: getGoogleMapsUrl(latitude, longitude),
            seasonLabel: capturedDate ? getSeasonLabel(new Date(capturedDate)) : '',
          },
        });

        uploadedPhotos.push(savedPhoto);
        setUploadProgress({
          current: baseStep + 3,
          total: selectedFiles.length * 3,
          title: file.name,
          detail: '업로드 완료',
        });
      }

      if (uploadedPhotos.length === 0) {
        setError('지원되는 이미지 형식(jpg, png, webp, heic)을 업로드해 주세요.');
      } else {
        setPhotos((current) => [...uploadedPhotos, ...current]);
      }
    } catch (uploadError) {
      console.error(uploadError);
      setError(uploadError instanceof Error ? uploadError.message : '사진 업로드 중 문제가 발생했습니다.');
    } finally {
      setUploading(false);
      setUploadProgress((current) => ({
        ...current,
        title: '',
        detail: '',
      }));
      event.target.value = '';
    }
  }

  async function handleFieldSave(photoId, field, value) {
    try {
      const updated = await updateAdminPhoto(photoId, { [field]: value });
      setPhotos((current) => current.map((photo) => (photo.id === photoId ? updated : photo)));
    } catch (saveError) {
      console.error(saveError);
      setError(saveError instanceof Error ? saveError.message : '사진 정보를 저장하지 못했습니다.');
    }
  }

  async function handleDelete(photoId) {
    try {
      await deleteAdminPhoto(photoId);
      setPhotos((current) => current.filter((photo) => photo.id !== photoId));
    } catch (deleteError) {
      console.error(deleteError);
      setError(deleteError instanceof Error ? deleteError.message : '사진 삭제에 실패했습니다.');
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
              <p className="admin-subtitle">{session.name ?? session.email} 계정으로 로그인됨</p>
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
              <span>공개된 사진</span>
              <strong>{photos.length}</strong>
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
                업로드된 사진은 바로 공개 갤러리에 노출됩니다. 메모와 위치는 아래 카드에서 수정합니다.
              </p>
            </div>

            <div className="admin-sync-actions">
              <button
                type="button"
                className="primary-button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
              >
                {uploading ? <LoaderCircle size={18} className="spin" /> : <Upload size={18} />}
                {uploading ? '업로드 중...' : '사진 업로드'}
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
            <div className="admin-progress-head">
              <p className="admin-loading">
                {uploading
                  ? `업로드 중: ${Math.ceil(uploadProgress.current / 3)}/${Math.max(
                      Math.ceil(uploadProgress.total / 3),
                      0,
                    )}${
                      uploadProgress.title ? ` · ${uploadProgress.title}` : ''
                    }${uploadProgress.detail ? ` · ${uploadProgress.detail}` : ''}`
                  : '업로드 대기 중'}
              </p>
              <span className="admin-progress-percent">
                {uploadProgress.total > 0
                  ? Math.round((uploadProgress.current / uploadProgress.total) * 100)
                  : 0}
                %
              </span>
            </div>
            <div className="admin-progress-bar">
              <div
                className="admin-progress-fill"
                style={{
                  width: `${
                    uploadProgress.total > 0
                      ? (uploadProgress.current / uploadProgress.total) * 100
                      : 0
                  }%`,
                }}
              />
            </div>
          </div>

          {loading ? <p className="admin-loading">사진 목록을 불러오는 중입니다.</p> : null}

          <section className="admin-grid">
            {sortedPhotos.map((photo) => (
              <article className="admin-photo-card" key={photo.id}>
                <div className="admin-photo-preview">
                  <img src={photo.imageUrl} alt={photo.title} />
                </div>

                <div className="admin-photo-fields">
                  <label className="admin-field">
                    <span>제목</span>
                    <input
                      defaultValue={photo.title}
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

                  <div className="admin-photo-meta">
                    <span>{photo.fileName}</span>
                    <span>{photo.capturedAt ? formatDate(photo.capturedAt) : '촬영일 정보 없음'}</span>
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
