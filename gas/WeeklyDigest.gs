/**
 * MATCH-MOVE 골프 AI 질문 DB — 주간(금요일) 자동화 스크립트
 *
 * 설치: docs/SHEETS_SETUP.md 7절 참고.
 *  - 스프레드시트 > 확장 프로그램 > Apps Script 에 이 파일 내용을 붙여넣는다.
 *  - weeklyDigest 함수에 "매주 금요일" 시간 기반 트리거를 건다.
 *
 * Master_DB 탭 컬럼 순서(고정):
 *  A:ID  B:L1_카테고리  C:국가  D:지역  E:연령대  F:질문
 *  G:GADS  H:ARS  I:Opportunity  J:콘텐츠상태  K:콘텐츠타입후보
 *  L:콘텐츠링크  M:최종업데이트일  N:담당자  O:비고
 */

const CONFIG = {
  MASTER_SHEET: "Master_DB",
  TOP20_SHEET: "Weekly_TOP20",
  TREND_LOG_SHEET: "Weekly_Trend_Log",
  NOTIFY_EMAIL: "", // 예: "edgar.meshugas@gmail.com" — 비워두면 이메일 발송을 건너뜀
  TOP_N: 20,
};

const COL = {
  ID: 1, L1: 2, COUNTRY: 3, REGION: 4, AGE: 5, QUESTION: 6,
  GADS: 7, ARS: 8, OPPORTUNITY: 9, STATUS: 10, CONTENT_TYPE: 11,
  LINK: 12, UPDATED: 13, OWNER: 14, NOTE: 15,
};

/**
 * 매주 금요일 트리거로 실행되는 메인 함수.
 * 1) Opportunity 재계산  2) TOP20 추출  3) 이메일 요약 발송
 */
function weeklyDigest() {
  recalcOpportunity();
  const top20 = extractTopOpportunities(CONFIG.TOP_N);
  writeTop20Sheet(top20);
  if (CONFIG.NOTIFY_EMAIL) {
    sendDigestEmail(top20);
  }
}

/** Master_DB의 Opportunity(I열) = GADS - ARS 를 전체 재계산한다. */
function recalcOpportunity() {
  const sheet = getSheet_(CONFIG.MASTER_SHEET);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const range = sheet.getRange(2, COL.GADS, lastRow - 1, 3); // GADS, ARS, Opportunity
  const values = range.getValues();
  for (let i = 0; i < values.length; i++) {
    const gads = Number(values[i][0]) || 0;
    const ars = Number(values[i][1]) || 0;
    values[i][2] = gads - ars;
  }
  range.setValues(values);
}

/**
 * 콘텐츠상태가 "미제작"인 행 중 Opportunity 상위 N개를 반환한다.
 * 반환 형식: [[ID, L1, 국가, 지역, 질문, GADS, ARS, Opportunity], ...]
 */
function extractTopOpportunities(n) {
  const sheet = getSheet_(CONFIG.MASTER_SHEET);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const data = sheet.getRange(2, 1, lastRow - 1, 15).getValues();
  const backlog = data.filter(row => String(row[COL.STATUS - 1]).trim() === "미제작");

  backlog.sort((a, b) => Number(b[COL.OPPORTUNITY - 1]) - Number(a[COL.OPPORTUNITY - 1]));

  return backlog.slice(0, n).map(row => [
    row[COL.ID - 1], row[COL.L1 - 1], row[COL.COUNTRY - 1], row[COL.REGION - 1],
    row[COL.QUESTION - 1], row[COL.GADS - 1], row[COL.ARS - 1], row[COL.OPPORTUNITY - 1],
  ]);
}

/** Weekly_TOP20 탭을 이번 주 결과로 덮어쓴다. */
function writeTop20Sheet(top20) {
  const sheet = getSheet_(CONFIG.TOP20_SHEET);
  sheet.clear();

  const header = [
    "생성일시", "질문ID", "L1_카테고리", "국가", "지역", "질문",
    "GADS", "ARS", "Opportunity",
  ];
  sheet.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight("bold");

  if (top20.length === 0) return;

  const now = new Date();
  const rows = top20.map(r => [now, r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7]]);
  sheet.getRange(2, 1, rows.length, header.length).setValues(rows);
  sheet.getRange(2, 1, rows.length, 1).setNumberFormat("yyyy-mm-dd hh:mm");
}

/** 담당자에게 이번 주 TOP20 요약 이메일을 발송한다. */
function sendDigestEmail(top20) {
  if (top20.length === 0) {
    MailApp.sendEmail(CONFIG.NOTIFY_EMAIL,
      "[MATCH-MOVE] 이번 주 콘텐츠 갭 없음",
      "이번 주 기준 미제작 백로그 질문이 없습니다.");
    return;
  }

  const lines = top20.map((r, i) =>
    `${i + 1}. [${r[1]}] ${r[4]} (Opportunity ${r[7]}, GADS ${r[5]}/ARS ${r[6]}) - ${r[0]}`
  );

  const subject = `[MATCH-MOVE] 이번 주 콘텐츠 갭 TOP${top20.length} — 블로그/쇼츠 소재`;
  const body =
    "이번 주 수요 대비 콘텐츠가 없는 우선순위 질문입니다.\n\n" +
    lines.join("\n") +
    "\n\n스프레드시트의 Weekly_TOP20 탭에서 확인 후 Content_Pipeline 탭으로 옮겨 제작 상태를 관리하세요.";

  MailApp.sendEmail(CONFIG.NOTIFY_EMAIL, subject, body);
}

function getSheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(name);
  if (!sheet) {
    throw new Error(`시트를 찾을 수 없습니다: ${name} (docs/SHEETS_SETUP.md 참고해 탭을 먼저 만드세요)`);
  }
  return sheet;
}
