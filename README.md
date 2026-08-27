# MATCH-MOVE
골프 코스 완전정복용 AI 드론 영상 시스템

## 골프 AI 질문 DB & 콘텐츠 갭 자동화

40대~70대 한국 골퍼가 실제 물어볼 법한 골프여행 질문을 "국가→지역→골프장→
패키지→가격→날씨→이동→숙박→식사→후기→여행사 신뢰→안전→비교→구매" 체계로
분류한 마스터 질문 DB, GADS/ARS 점수체계, Google Sheets 대시보드, 매주 금요일
콘텐츠 갭(TOP20) 자동 추출 시스템.

- 설계 문서: [`docs/DESIGN.md`](docs/DESIGN.md)
- Sheets 세팅 가이드: [`docs/SHEETS_SETUP.md`](docs/SHEETS_SETUP.md)
- 마스터 질문 DB: [`data/master_questions.csv`](data/master_questions.csv) (531행)
- 점수 가중치 설정: [`data/score_config.csv`](data/score_config.csv)
- DB 생성 스크립트: [`scripts/generate_questions.py`](scripts/generate_questions.py)
- 주간 자동화(Apps Script): [`gas/WeeklyDigest.gs`](gas/WeeklyDigest.gs)
