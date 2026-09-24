# MATCH-MOVE
골프 코스 완전정복용 AI 드론 영상 시스템

## 골프공 탄도 물리엔진 · Golf Ball Flight Engine

| 파일 | 내용 |
| --- | --- |
| [`app/index.html`](app/index.html) | **탄도 계산기** — 경사 라이·볼 라이·날씨·고도·바람·고저차·착지면을 반영한 비거리·구질 예측, 요인 분해, 최대 비거리 솔루션. 한/영 병기 + 용어 툴팁 |
| [`app/guide.html`](app/guide.html) | **골프공 비행 교과서** — 필요한 수학·물리 기초부터 3가지 힘, 딤플, 마그누스 효과, 구질, 경사 라이별 스핀 역학, 환경·라이·착지까지 공식과 그림으로 설명 |
| [`app/engine/golf-physics.js`](app/engine/golf-physics.js) | 물리엔진 (브라우저·Node 겸용) |
| [`app/engine/test.js`](app/engine/test.js) | 물리 상식 테스트 22개 — `node app/engine/test.js` |
| [`app/engine/calibrate.js`](app/engine/calibrate.js) | TrackMan 투어 평균 대비 공력 상수 보정 — `node app/engine/calibrate.js [--search]` |
| [`docs/PROMPTS.md`](docs/PROMPTS.md) | Claude·Astra용 프롬프트 모음 (`node app/prompts.js > docs/PROMPTS.md`로 생성) |

### 실행
브라우저에서 `app/index.html`을 열면 됩니다(빌드 불필요). 로컬 서버를 쓰려면 `npx serve app` 또는 `python3 -m http.server -d app`.

### 모델 요약
- 3D 질점 + 중력·항력·마그누스 양력, RK4 적분(Δt = 4 ms)
- 레이놀즈 수 기반 항력 위기(딤플 vs 매끈한 공), 포화형 양력 곡선, 스핀 감쇠
- 습윤 공기 밀도(고도·기온·습도), 높이별 바람(윈드 시어) + 투어 측정 보정
- 경사 라이: 로프트 의존 페이스 방향 변화 `atan(tan(loft)·sin(tilt))`, 유효 로프트, D-plane 스핀 축
- 볼 라이 11종, 날씨 5종, 착지면 6종(분화구·반발·마찰·스핀백·구름 저항)
- 캐리 오차: 투어 평균 대비 전 클럽 ±5 % 이내

교육·연습용 추정치이며, 개인 런치 모니터 데이터로 계수를 보정하면 더 정확해집니다.
