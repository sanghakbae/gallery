# gallery

사진 공개 갤러리 프론트와 관리자 업로드 백엔드를 같은 레포에서 관리합니다.

## 배포 구조

- 프론트: GitHub Pages
- 백엔드: Render Web Service

## 로컬 실행

1. `.env.local`에 값 설정
2. 백엔드 실행: `npm run dev:server`
3. 프론트 실행: `npm run dev -- --host 127.0.0.1`
4. 로컬 접속 주소: `http://127.0.0.1:4173/` 또는 Vite가 출력한 루트 주소

## 환경변수

- `VITE_GOOGLE_CLIENT_ID`
- `VITE_ADMIN_EMAILS`
- `VITE_API_BASE_URL`
- `VITE_APP_BASE_PATH`
- `ADMIN_EMAILS`
- `ALLOWED_ORIGINS`
- `DATA_DIR`
- `MIGRATION_TOKEN`
- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`
- `R2_PUBLIC_BASE_URL`

## Render

- `render.yaml` 포함
- `HOST=0.0.0.0`
- Cloudflare R2를 쓰면 `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_BASE_URL` 를 Render 환경변수에 넣고 `DATA_DIR` 없이도 운영 가능
- 기존 로컬 사진을 Render 디스크로 옮길 때는 `MIGRATION_TOKEN`을 설정한 뒤 `node scripts/migrate-photos-to-render.mjs <api-base-url> <migration-token>` 실행
- Render에 있는 공개 사진을 로컬 `backend/data/uploads`로 가져오려면 `npm run sync:from-remote -- <api-base-url>` 실행
- Render가 실제로 영속 디스크 `/var/data`를 보고 있는지 확인하려면 `GET /api/internal/debug/storage` 를 `Authorization: Bearer <MIGRATION_TOKEN>` 과 함께 호출
- `ADMIN_EMAILS`는 Render 대시보드에서 직접 입력
- `ALLOWED_ORIGINS`는 GitHub Pages 도메인으로 설정
- 업로드 이미지는 `backend/data/uploads`가 아니라 Render 디스크에 저장되어야 재배포 후에도 유지됨

## Cloudflare R2

- R2 환경변수가 모두 설정되면 사진 원본, 썸네일, `photos.json`, `settings.json` 을 모두 R2에 저장합니다
- `R2_PUBLIC_BASE_URL` 까지 설정하면 브라우저가 Render 프록시 대신 Cloudflare 공개 URL에서 이미지와 썸네일을 직접 받아 더 빠르게 로드합니다
- 이 모드에서는 Render free에서도 로컬 디스크 없이 동작할 수 있습니다
- 디버그 응답 `GET /api/internal/debug/storage` 의 `storageBackend` 가 `r2` 여야 정상입니다

## GitHub Pages

- `main` 브랜치 푸시 시 GitHub Actions로 배포
- 저장소 Settings > Pages 에서 source를 `GitHub Actions`로 설정
- 커스텀 도메인 사용 시 프론트 base path는 `/`를 사용하고, 기본 운영 도메인은 `https://gallery.sanghak.kr/`
- 프론트 빌드 시 `VITE_API_BASE_URL`을 Render 백엔드 URL로 지정
- 저장소 하위 경로에 다시 배포해야 하면 `VITE_APP_BASE_PATH=/gallery/` 처럼 오버라이드 가능

## GitHub Actions

- `.github/workflows/deploy-pages.yml`: GitHub Pages 빌드/배포
- `.github/workflows/deploy-render.yml`: `main` 푸시 시 Render deploy hook 호출
- GitHub 저장소 `Settings > Secrets and variables > Actions` 에 `RENDER_DEPLOY_HOOK_URL` secret 이 필요함
- 이 secret 을 넣으면 GitHub `main` push 뒤 Render도 자동으로 다시 배포됨
