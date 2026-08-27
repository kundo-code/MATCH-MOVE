# Google Sheets 대시보드 세팅 가이드

`docs/DESIGN.md` 5절의 7개 탭을 실제로 만드는 단계별 가이드다.

## 0. 준비

1. Google Sheets에서 새 스프레드시트 생성 (예: "MATCH-MOVE 골프 AI 질문 DB")
2. 아래 순서대로 시트(탭)를 만들고 이름을 정확히 맞춘다.
   `Master_DB`, `Score_Config`, `Weekly_Trend_Log`, `AIVS_Check`,
   `Weekly_TOP20`, `Content_Pipeline`, `Dashboard`

## 1. Master_DB

`파일 > 가져오기 > 업로드` 로 `data/master_questions.csv` 를 "새 시트 삽입" 대신
**"현재 시트 바꾸기"** 옵션으로 `Master_DB` 탭에 로드한다. (구분자: 쉼표, 인코딩:
UTF-8 — 파일이 이미 UTF-8-SIG 이므로 자동 인식된다.)

컬럼은 A~S 순서로 고정되어 있다 (`gas/WeeklyDigest.gs` 도 이 순서를 그대로 참조):

`A:ID B:L1_카테고리 C:국가 D:지역 E:연령대 F:질문 G:GADS H:ARS I:Opportunity
J:콘텐츠상태 K:콘텐츠타입후보 L:콘텐츠링크 M:AIVS N:AIVS_확인일 O:GEO최적화상태
P:우선순위액션 Q:최종업데이트일 R:담당자 S:비고`

헤더(1행) 고정: `보기 > 고정 > 1행`

## 2. Score_Config

동일한 방식으로 `data/score_config.csv` 를 `Score_Config` 탭에 임포트한다.
GADS/ARS 가중치뿐 아니라 AIVS 점수 기준(0/40/70/100)과 측정 방법도 포함되어
있다. 가중치는 담당자가 %를 직접 조정한다.

## 3. Weekly_Trend_Log

아래 헤더로 빈 시트를 만든다.

| 주차 | 관측일 | 관련_질문ID | 출처 | 키워드/내용 | 관측빈도(1~5) | 메모 |
|---|---|---|---|---|---|---|

- **주차**: `=ISOWEEKNUM(B2)&"주차"` 형태로 자동 계산 가능
- **출처**: 네이버 데이터랩 / 구글트렌드 / 카카오톡 상담로그 / 커뮤니티 / 기타
- 담당자가 매주 금요일 오전 여기에 시장 관측 데이터를 5~10건 기록한다.
  (AI 노출 확인은 아래 `AIVS_Check` 탭에 별도 기록한다.)

## 4. AIVS_Check (AI 노출 확인)

더골프트렌드가 실제 AI 답변에 노출되는지 매주 직접 확인해 기록하는 탭.
헤더:

| 확인일 | 질문ID | 질문 | AI엔진 | 노출점수(0/40/70/100) | 노출형태 | 캡처링크 | 확인자 |
|---|---|---|---|---|---|---|---|

- **AI엔진**: ChatGPT / Perplexity / Gemini / 네이버 Cue / 기타 — 엔진별로 행을 나눠 기록
- **노출점수**: `docs/DESIGN.md` 4.1절 기준 (0=미노출, 40=일반언급, 70=간접인용, 100=직접인용+링크)
- **노출형태**: 예) "추천 리스트 3번째로 언급", "가격 정보가 출처 없이 인용됨"
- **캡처링크**: 스크린샷을 Drive에 올리고 링크만 기록 (분쟁·회고용 근거자료)

매주 지난주 `Weekly_TOP20` + 기존 발행 콘텐츠 중 일부를 샘플링해 확인한다.
확인 후 아래 수식으로 `Master_DB!M`(AIVS), `Master_DB!N`(AIVS_확인일)에 최신값을
반영한다 (Master_DB 2행 기준 예시, 아래로 채우기):

```
M2: =IFERROR(QUERY(AIVS_Check!A:E,"select E where B='"&Master_DB!A2&"' order by A desc limit 1",0),"")
N2: =IFERROR(QUERY(AIVS_Check!A:E,"select A where B='"&Master_DB!A2&"' order by A desc limit 1",0),"")
```

## 5. Weekly_TOP20

이 탭은 `gas/WeeklyDigest.gs` 의 `weeklyDigest()` 함수가 매주 자동으로
두 블록으로 나눠 채운다 (`writeTop20Sheet`, `writeReoptimizeSheet` 참고).

- **① 신규제작 TOP20**: `콘텐츠상태(J) = '미제작'` 중 `Opportunity(I)` 상위 20개
- **② GEO 재최적화 대상**: `콘텐츠상태(J) = '완료'` 이면서 `AIVS(M) < 40` 인 항목
  (콘텐츠는 있는데 AI가 안 보여주는 케이스, 4.2절 매트릭스의 🟠 구간)

자동화 전 수동 확인용 수식 (참고):

```
=QUERY(Master_DB!A1:S, "select A,B,F,G,H,I where J = '미제작' order by I desc limit 20", 1)
=QUERY(Master_DB!A1:S, "select A,B,F,G,M where J = '완료' and M < 40 order by G desc limit 20", 1)
```

## 6. Content_Pipeline

TOP20/재최적화 대상을 실제 제작·전환까지 관리한다.

| 질문ID | 질문 | 액션유형 | 콘텐츠타입 | 기획 | 제작 | GEO체크리스트 | 발행 | 발행링크 | 문의링크(UTM) | 문의수 | 구매수 | 전환율 | 담당자 | 발행일 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

- **액션유형**: `신규제작` / `GEO재최적화` — `Weekly_TOP20` 어느 블록에서 왔는지
- **GEO체크리스트**: `docs/DESIGN.md` 4.3절 체크리스트 완료 여부 (체크박스)
- **문의링크(UTM)**: 콘텐츠별 고유 카카오채널/상담 링크 — `?utm_content=질문ID` 형태로 발급
- **전환율**: `=IFERROR(구매수/문의수,0)` 자동 계산
- `기획~발행` 컬럼은 체크박스(`삽입 > 체크박스`)로 진행률을 한눈에 본다.

발행/재최적화 완료 시 `Master_DB` 의 해당 행 `콘텐츠상태`(완료)·`GEO최적화상태`
(예: "완료(FAQ스키마+최신화)")·`콘텐츠링크`를 채워 다음 주 재계산에 반영한다.
문의수/구매수는 카카오톡 채널 관리자센터 또는 CRM에서 UTM별로 집계해 주 1회
입력한다.

## 7. Dashboard

요약 통계용 탭. 예시 수식:

- 카테고리별 커버리지율:
  `=QUERY(Master_DB!A1:S,"select B, count(A), sum(if(J='완료',1,0)) where A is not null group by B",1)`
- 카테고리별 AI 노출율(AIVS≥70 비율):
  `=QUERY(Master_DB!A1:S,"select B, count(A), sum(if(M>=70,1,0)) where A is not null group by B",1)`
- 연령대별 질문 분포:
  `=QUERY(Master_DB!A1:S,"select E, count(A) where E is not null group by E",1)`
- 주간 문의/구매 추이: `Content_Pipeline` 의 `문의수`/`구매수`를 발행일 기준 주차로
  `SUMIFS` 집계 (막대+선 콤보 차트 권장)

`삽입 > 차트` 로 위 QUERY 결과 범위를 선택해 막대/도넛/콤보 차트를 추가한다.

## 8. Apps Script 자동화 연결

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

이후 매주 금요일 자동으로 `Weekly_TOP20`(신규제작 + GEO 재최적화 2블록) 갱신 +
담당자 이메일 요약이 발송된다. 문의/구매 전환 데이터는 `Content_Pipeline`에서
수동 집계 후 `Dashboard`에서 추이를 확인한다.
