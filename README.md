# MATCH-MOVE
골프 코스 완전정복용 AI 드론 영상 시스템

## 골프 AI 질문 DB & 콘텐츠 갭 자동화

**목표**: 40대~70대 한국 골퍼가 AI(챗GPT/퍼플렉시티/제미나이/네이버 Cue 등)에
골프여행을 물었을 때 **더골프트렌드가 답변에 노출·인용**되고, 그 노출이
**문의·구매로 전환**되도록 만드는 시스템.

실제 골퍼가 물어볼 법한 질문을 "국가→지역→골프장→패키지→가격→날씨→이동→
숙박→식사→후기→여행사 신뢰→안전→비교→구매" 체계로 분류한 마스터 질문 DB,
수요(GADS)·콘텐츠 대응력(ARS)·AI 노출(AIVS) 점수체계, Google Sheets 대시보드,
매주 금요일 "신규제작 TOP20 + GEO 재최적화 대상" 자동 추출 시스템으로 구성된다.

- 설계 문서: [`docs/DESIGN.md`](docs/DESIGN.md)
- Sheets 세팅 가이드: [`docs/SHEETS_SETUP.md`](docs/SHEETS_SETUP.md)
- 마스터 질문 DB: [`data/master_questions.csv`](data/master_questions.csv) (531행)
- 점수 가중치 설정: [`data/score_config.csv`](data/score_config.csv)
- DB 생성 스크립트: [`scripts/generate_questions.py`](scripts/generate_questions.py)
- 주간 자동화(Apps Script): [`gas/WeeklyDigest.gs`](gas/WeeklyDigest.gs)
