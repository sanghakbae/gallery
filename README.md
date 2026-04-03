# photos-mgmt-system

사진 공개 갤러리 프론트와 관리자 업로드 백엔드를 같은 레포에서 관리합니다.

## 배포 구조

- 프론트: GitHub Pages
- 백엔드: Render Web Service

## 로컬 실행

1. `.env.local`에 값 설정
2. 백엔드 실행: `npm run dev:server`
3. 프론트 실행: `npm run dev -- --host 127.0.0.1`

## 환경변수

- `VITE_GOOGLE_CLIENT_ID`
- `VITE_ADMIN_EMAILS`
- `VITE_API_BASE_URL`
- `ADMIN_EMAILS`
- `ALLOWED_ORIGINS`
- `DATA_DIR`

## Render

- `render.yaml` 포함
- `HOST=0.0.0.0`
- `DATA_DIR=/var/data`로 영속 디스크 경로 사용
- `ADMIN_EMAILS`는 Render 대시보드에서 직접 입력
- `ALLOWED_ORIGINS`는 GitHub Pages 도메인으로 설정
- 업로드 이미지는 `backend/data/uploads`가 아니라 Render 디스크에 저장되어야 재배포 후에도 유지됨

## GitHub Pages

- `main` 브랜치 푸시 시 GitHub Actions로 배포
- 저장소 Settings > Pages 에서 source를 `GitHub Actions`로 설정
- 프론트 빌드 시 `VITE_API_BASE_URL`을 Render 백엔드 URL로 지정
