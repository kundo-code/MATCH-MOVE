# Google Sheets 대시보드 세팅 가이드

`docs/DESIGN.md` 4절의 6개 탭을 실제로 만드는 단계별 가이드다.

## 0. 준비

1. Google Sheets에서 새 스프레드시트 생성 (예: "MATCH-MOVE 골프 AI 질문 DB")
2. 아래 순서대로 시트(탭)를 만들고 이름을 정확히 맞춘다.
   `Master_DB`, `Score_Config`, `Weekly_Trend_Log`, `Weekly_TOP20`,
   `Content_Pipeline`, `Dashboard`

## 1. Master_DB

`파일 > 가져오기 > 업로드` 로 `data/master_questions.csv` 를 "새 시트 삽입" 대신
**"현재 시트 바꾸기"** 옵션으로 `Master_DB` 탭에 로드한다. (구분자: 쉼표, 인코딩:
UTF-8 — 파일이 이미 UTF-8-SIG 이므로 자동 인식된다.)

헤더(1행) 고정: `보기 > 고정 > 1행`

## 2. Score_Config

동일한 방식으로 `data/score_config.csv` 를 `Score_Config` 탭에 임포트한다.
가중치는 담당자가 %를 직접 조정하며, `Master_DB` 의 GADS/ARS는 재계산 스크립트가
이 값을 참조하도록 `gas/WeeklyDigest.gs` 를 확장할 수 있다.

## 3. Weekly_Trend_Log

아래 헤더로 빈 시트를 만든다.

| 주차 | 관측일 | 관련_질문ID | 출처 | 키워드/내용 | 관측빈도(1~5) | 메모 |
|---|---|---|---|---|---|---|

- **주차**: `=ISOWEEKNUM(B2)&"주차"` 형태로 자동 계산 가능
- **출처**: 네이버 데이터랩 / 구글트렌드 / 카카오톡 상담로그 / 커뮤니티 / 기타
- 담당자가 매주 금요일 오전 여기에 관측 데이터를 5~10건 기록한다.

## 4. Weekly_TOP20

이 탭은 `gas/WeeklyDigest.gs` 의 `weeklyDigest()` 함수가 매주 자동으로
덮어쓴다. 최초 1회는 수식으로도 동일한 결과를 볼 수 있도록 A1에 아래 수식을
넣어둔다 (자동화 전 임시 확인용):

```
=QUERY(Master_DB!A1:O, "select A,B,F,G,H,I,J where J = '미제작' order by I desc limit 20", 1)
```

- I열 = Opportunity, J열 = 콘텐츠상태 (CSV 컬럼 순서 기준, 실제 시트에서 열 문자가
  다르면 맞춰 수정)

## 5. Content_Pipeline

TOP20을 콘텐츠 제작 상태로 관리한다.

| 질문ID | 질문 | 콘텐츠타입 | 기획 | 촬영/작성 | 편집 | 발행 | 발행링크 | 담당자 | 발행일 |
|---|---|---|---|---|---|---|---|---|---|

`기획~발행` 컬럼은 체크박스(`삽입 > 체크박스`)로 만들어 진행률을 한눈에 본다.
발행 완료 시 `Master_DB` 의 해당 질문 행 `콘텐츠상태`를 "완료", `콘텐츠링크`를
채워 다음 주 ARS 재계산에 반영한다.

## 6. Dashboard

요약 통계용 탭. 예시 수식:

- 카테고리별 커버리지율:
  `=QUERY(Master_DB!A1:O,"select B, count(A), sum(if(J='완료',1,0)) where A is not null group by B",1)`
- 연령대별 질문 분포:
  `=QUERY(Master_DB!A1:O,"select E, count(A) where E is not null group by E",1)`
- 이번 주 Opportunity 상위 카테고리 (막대 차트로 시각화 권장)

`삽입 > 차트` 로 위 QUERY 결과 범위를 선택해 막대/도넛 차트를 추가한다.

## 7. Apps Script 자동화 연결

1. 스프레드시트에서 `확장 프로그램 > Apps Script` 클릭
2. `gas/WeeklyDigest.gs` 내용을 그대로 붙여넣기 (상단 `CONFIG` 값은 본인 환경에
   맞게 수정: 알림 받을 이메일 등)
3. 좌측 `트리거(시계 아이콘) > 트리거 추가`
   - 실행할 함수: `weeklyDigest`
   - 이벤트 소스: 시간 기반
   - 시간 기반 트리거 유형: 주 타이머
   - 요일: 매주 금요일
   - 시간: 오전 9시~10시
4. 저장 후 최초 1회 `weeklyDigest` 를 수동 실행해 권한 승인(Gmail 발송 등)

이후 매주 금요일 자동으로 `Weekly_TOP20` 갱신 + 담당자 이메일 요약이 발송된다.
