# 치과 리뷰 작성 페이지 — 배포 가이드

## 구성
- `index.html` — 환자가 스캔하는 실제 리뷰 작성 페이지 (URL 파라미터로 치과별 정보를 받음)
- `setup.html` — 치과 담당자가 치과 이름·구글 리뷰 링크를 입력해 전용 링크/QR을 만드는 관리 페이지
- `api/generate-review.js` — AI 리뷰 문구를 생성하는 서버 함수 (API 키를 안전하게 보관)

## 왜 서버 함수가 필요한가요?
AI 리뷰 생성은 Anthropic API를 호출합니다. API 키를 `index.html` 안에 그대로 넣으면 누구나
브라우저 개발자도구로 키를 볼 수 있어 위험해요. 그래서 키는 서버(`api/generate-review.js`)에만
두고, 페이지는 그 서버에 요청만 보내는 구조로 만들었습니다.

## 배포 방법 (Vercel 기준, 무료로 가능)

1. 이 `deploy` 폴더를 GitHub 저장소에 올립니다.
2. [vercel.com](https://vercel.com) 에서 New Project → 방금 만든 저장소 선택
3. **Environment Variables**에 아래 항목 추가
   - `ANTHROPIC_API_KEY` = 발급받은 Anthropic API 키 ([console.anthropic.com](https://console.anthropic.com)에서 발급)
4. Deploy 클릭 → 배포 완료 후 `https://[프로젝트명].vercel.app` 형태의 주소가 생성됨

## 사용 방법 (치과 담당자)

1. 배포된 주소 뒤에 `/setup.html`을 붙여서 접속
   예: `https://내치과리뷰.vercel.app/setup.html`
2. 치과 이름, 구글 리뷰 작성 링크 입력 후 "링크 · QR 코드 생성" 클릭
3. 생성된 QR 코드를 인쇄해서 데스크·대기실에 비치
   (환자가 스캔하면 `index.html?name=...&google=...` 형태의 전용 링크로 바로 연결됩니다)

## 참고
- 같은 배포 하나로 여러 치과를 지원할 수 있어요. 치과마다 `setup.html`에서 각자 링크를 새로 생성하면 됩니다.
- Netlify를 쓰실 경우 `api/generate-review.js`를 Netlify Functions 형식(`exports.handler`)으로
  살짝 바꿔야 해요. 필요하시면 그 버전도 만들어드릴게요.
