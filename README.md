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

## 아키텍처

- 인증: **Firebase Authentication** (Google 로그인)
- 메타데이터 DB: **Firebase Firestore** (`photos`, `settings` 컬렉션)
- 이미지 저장: Cloudflare R2 또는 로컬 디스크 (그대로 유지)

## 환경변수

프론트 (Vite, 빌드 시 주입):

- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_STORAGE_BUCKET`
- `VITE_FIREBASE_MESSAGING_SENDER_ID`
- `VITE_FIREBASE_APP_ID`
- `VITE_ADMIN_EMAILS`
- `VITE_API_BASE_URL`
- `VITE_APP_BASE_PATH`

백엔드 (Node 서버):

- `FIREBASE_SERVICE_ACCOUNT` (서비스 계정 JSON 전체) 또는 `FIREBASE_SERVICE_ACCOUNT_PATH`
- `FIREBASE_PROJECT_ID` (서비스 계정에 있으면 생략 가능)
- `ADMIN_EMAILS`
- `ALLOWED_ORIGINS`
- `DATA_DIR`
- `MIGRATION_TOKEN`
- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`
- `R2_PUBLIC_BASE_URL`

## Firebase 설정 (최초 1회)

1. [Firebase 콘솔](https://console.firebase.google.com/)에서 새 프로젝트 생성
2. **Authentication > Sign-in method**에서 **Google** 공급업체 사용 설정
3. **Authentication > Settings > 승인된 도메인**에 `localhost`, `127.0.0.1`, 운영 도메인(`gallery.sanghak.kr`, `sanghakbae.github.io`) 추가
4. **Firestore Database** 만들기 (프로덕션 모드, 가까운 리전 선택). 서버가 Admin SDK로 접근하므로 보안 규칙은 기본 잠금 상태로 둬도 됩니다
5. **프로젝트 설정 > 일반 > 내 앱**에서 웹 앱(`</>`) 등록 → 출력된 `firebaseConfig` 값을 위 `VITE_FIREBASE_*` 변수에 채움
6. **프로젝트 설정 > 서비스 계정 > 새 비공개 키 생성**으로 JSON 키 다운로드
   - 로컬: `backend/firebase-service-account.json`으로 저장 (gitignore됨)
   - Render: JSON 내용 전체를 `FIREBASE_SERVICE_ACCOUNT` 환경변수에 붙여넣기
7. 기존 데이터 이전: R2의 `metadata/photos.json`이 권위 있는 소스입니다. R2 자격증명(`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`)을 환경에 설정한 뒤 `npm run migrate:firestore -- --dry-run`로 확인하고 `npm run migrate:firestore` 실행 (Firestore의 기존 사진을 R2 데이터로 교체)

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

- R2 환경변수가 모두 설정되면 사진 원본과 썸네일을 R2에 저장합니다 (사진/설정 메타데이터는 Firestore에 저장됨)
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
