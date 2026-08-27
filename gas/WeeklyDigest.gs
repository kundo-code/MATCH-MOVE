/**
 * MATCH-MOVE 골프 AI 질문 DB — 주간(금요일) 자동화 스크립트
 *
 * 목표: 더골프트렌드가 AI 답변에 노출(AIVS)되도록, 그리고 그 노출이
 * 문의/구매로 이어지도록 매주 우선순위를 두 갈래로 뽑는다.
 *  ① 신규제작 TOP20: 콘텐츠가 아예 없는(ARS 낮음) 질문 중 수요(GADS) 높은 것
 *  ② GEO 재최적화 대상: 콘텐츠는 있는데(ARS 높음) AI가 안 보여주는(AIVS 낮음) 것
 *
 * 설치: docs/SHEETS_SETUP.md 8절 참고.
 *  - 스프레드시트 > 확장 프로그램 > Apps Script 에 이 파일 내용을 붙여넣는다.
 *  - weeklyDigest 함수에 "매주 금요일" 시간 기반 트리거를 건다.
 *
 * Master_DB 탭 컬럼 순서(고정, A~S):
 *  A:ID  B:L1_카테고리  C:국가  D:지역  E:연령대  F:질문
 *  G:GADS  H:ARS  I:Opportunity  J:콘텐츠상태  K:콘텐츠타입후보
 *  L:콘텐츠링크  M:AIVS  N:AIVS_확인일  O:GEO최적화상태
 *  P:우선순위액션  Q:최종업데이트일  R:담당자  S:비고
 */

const CONFIG = {
  MASTER_SHEET: "Master_DB",
  TOP20_SHEET: "Weekly_TOP20",
  NOTIFY_EMAIL: "", // 예: "edgar.meshugas@gmail.com" — 비워두면 이메일 발송을 건너뜀
  TOP_N: 20,
  AIVS_LOW_THRESHOLD: 40, // 이 미만이면 "AI가 우리를 안 보여준다"고 판단
  ARS_EXISTS_THRESHOLD: 60, // 이 이상이면 "콘텐츠가 있다"고 판단
};

const COL = {
  ID: 1, L1: 2, COUNTRY: 3, REGION: 4, AGE: 5, QUESTION: 6,
  GADS: 7, ARS: 8, OPPORTUNITY: 9, STATUS: 10, CONTENT_TYPE: 11,
  LINK: 12, AIVS: 13, AIVS_DATE: 14, GEO_STATUS: 15,
  PRIORITY_ACTION: 16, UPDATED: 17, OWNER: 18, NOTE: 19,
};
const LAST_COL = 19;

/**
 * 매주 금요일 트리거로 실행되는 메인 함수.
 * 1) Opportunity/우선순위액션 재계산  2) TOP20 + 재최적화 리스트 추출
 * 3) Weekly_TOP20 탭 기록  4) 이메일 요약 발송
 */
function weeklyDigest() {
  recalcScores();
  const newContent = extractNewContentTargets(CONFIG.TOP_N);
  const reopt = extractReoptimizeTargets(CONFIG.TOP_N);
  writeTop20Sheet(newContent, reopt);
  if (CONFIG.NOTIFY_EMAIL) {
    sendDigestEmail(newContent, reopt);
  }
}

/**
 * Master_DB의 Opportunity(I열)와 우선순위액션(P열)을 전체 재계산한다.
 * 우선순위액션은 docs/DESIGN.md 4.2절 매트릭스(ARS × AIVS)를 그대로 구현한다.
 */
function recalcScores() {
  const sheet = getSheet_(CONFIG.MASTER_SHEET);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const range = sheet.getRange(2, 1, lastRow - 1, LAST_COL);
  const values = range.getValues();

  for (let i = 0; i < values.length; i++) {
    const gads = Number(values[i][COL.GADS - 1]) || 0;
    const ars = Number(values[i][COL.ARS - 1]) || 0;
    const aivsRaw = values[i][COL.AIVS - 1];
    const aivs = aivsRaw === "" || aivsRaw === null ? null : Number(aivsRaw);

    values[i][COL.OPPORTUNITY - 1] = gads - ars;

    const hasContent = ars >= CONFIG.ARS_EXISTS_THRESHOLD;
    let action;
    if (aivs === null) {
      action = hasContent ? "AI노출확인필요" : "신규제작대기";
    } else if (!hasContent && aivs < CONFIG.AIVS_LOW_THRESHOLD) {
      action = "신규제작대기";
    } else if (hasContent && aivs < CONFIG.AIVS_LOW_THRESHOLD) {
      action = "GEO최적화필요";
    } else if (hasContent && aivs >= CONFIG.AIVS_LOW_THRESHOLD) {
      action = "전환최적화";
    } else {
      action = "미확인";
    }
    values[i][COL.PRIORITY_ACTION - 1] = action;
  }

  range.setValues(values);
}

/** 콘텐츠상태가 "미제작"인 행 중 Opportunity 상위 N개를 반환한다 (신규제작 대상). */
function extractNewContentTargets(n) {
  const rows = readMasterRows_();
  const backlog = rows.filter(row => String(row[COL.STATUS - 1]).trim() === "미제작");
  backlog.sort((a, b) => Number(b[COL.OPPORTUNITY - 1]) - Number(a[COL.OPPORTUNITY - 1]));
  return backlog.slice(0, n).map(pickSummaryCols_);
}

/**
 * 콘텐츠상태가 "완료"인데 AIVS가 낮은 행 중 GADS 상위 N개를 반환한다.
 * (콘텐츠는 있지만 AI가 노출시켜주지 않는, GEO 재최적화가 필요한 케이스)
 */
function extractReoptimizeTargets(n) {
  const rows = readMasterRows_();
  const target = rows.filter(row => {
    const status = String(row[COL.STATUS - 1]).trim();
    const aivsRaw = row[COL.AIVS - 1];
    const aivs = aivsRaw === "" || aivsRaw === null ? null : Number(aivsRaw);
    return status === "완료" && aivs !== null && aivs < CONFIG.AIVS_LOW_THRESHOLD;
  });
  target.sort((a, b) => Number(b[COL.GADS - 1]) - Number(a[COL.GADS - 1]));
  return target.slice(0, n).map(pickSummaryCols_);
}

function readMasterRows_() {
  const sheet = getSheet_(CONFIG.MASTER_SHEET);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow - 1, LAST_COL).getValues();
}

/** [ID, L1, 국가, 지역, 질문, GADS, ARS, AIVS, Opportunity] 형태로 축약한다. */
function pickSummaryCols_(row) {
  return [
    row[COL.ID - 1], row[COL.L1 - 1], row[COL.COUNTRY - 1], row[COL.REGION - 1],
    row[COL.QUESTION - 1], row[COL.GADS - 1], row[COL.ARS - 1], row[COL.AIVS - 1],
    row[COL.OPPORTUNITY - 1],
  ];
}

/** Weekly_TOP20 탭을 이번 주 결과(신규제작 + GEO 재최적화 2블록)로 덮어쓴다. */
function writeTop20Sheet(newContent, reopt) {
  const sheet = getSheet_(CONFIG.TOP20_SHEET);
  sheet.clear();

  const header = [
    "생성일시", "질문ID", "L1_카테고리", "국가", "지역", "질문",
    "GADS", "ARS", "AIVS", "Opportunity",
  ];
  const now = new Date();

  sheet.getRange(1, 1, 1, 1).setValue("① 신규제작 TOP" + CONFIG.TOP_N + " (콘텐츠 없음, 수요 높음)").setFontWeight("bold");
  sheet.getRange(2, 1, 1, header.length).setValues([header]).setFontWeight("bold");
  let row = 3;
  if (newContent.length > 0) {
    const rows = newContent.map(r => [now, r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8]]);
    sheet.getRange(row, 1, rows.length, header.length).setValues(rows);
    sheet.getRange(row, 1, rows.length, 1).setNumberFormat("yyyy-mm-dd hh:mm");
    row += rows.length;
  }

  row += 1;
  sheet.getRange(row, 1, 1, 1).setValue("② GEO 재최적화 대상 (콘텐츠 있음, AI 노출 낮음)").setFontWeight("bold");
  row += 1;
  sheet.getRange(row, 1, 1, header.length).setValues([header]).setFontWeight("bold");
  row += 1;
  if (reopt.length > 0) {
    const rows = reopt.map(r => [now, r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8]]);
    sheet.getRange(row, 1, rows.length, header.length).setValues(rows);
    sheet.getRange(row, 1, rows.length, 1).setNumberFormat("yyyy-mm-dd hh:mm");
  }
}

/** 담당자에게 이번 주 신규제작 + GEO 재최적화 요약 이메일을 발송한다. */
function sendDigestEmail(newContent, reopt) {
  if (newContent.length === 0 && reopt.length === 0) {
    MailApp.sendEmail(CONFIG.NOTIFY_EMAIL,
      "[MATCH-MOVE] 이번 주 콘텐츠/GEO 갭 없음",
      "이번 주 기준 신규제작 백로그와 GEO 재최적화 대상이 없습니다.");
    return;
  }

  const fmt = (r, i) =>
    `${i + 1}. [${r[1]}] ${r[4]} (GADS ${r[5]} / ARS ${r[6]} / AIVS ${r[7]}, Opportunity ${r[8]}) - ${r[0]}`;

  const parts = [];
  parts.push("이번 주 더골프트렌드 AI 노출 콘텐츠 갭 요약입니다.\n");

  parts.push(`\n[① 신규제작 필요 ${newContent.length}건] — 콘텐츠가 없어 AI가 인용할 것이 없는 질문`);
  parts.push(newContent.length ? newContent.map(fmt).join("\n") : "(없음)");

  parts.push(`\n\n[② GEO 재최적화 필요 ${reopt.length}건] — 콘텐츠는 있지만 AI가 안 보여주는 질문`);
  parts.push(reopt.length ? reopt.map(fmt).join("\n") : "(없음)");

  parts.push(
    "\n\nWeekly_TOP20 탭에서 확인 후 Content_Pipeline 탭으로 옮겨 제작/GEO최적화 상태와 " +
    "문의·구매 전환을 관리하세요. (docs/DESIGN.md 4절 참고)"
  );

  MailApp.sendEmail(
    CONFIG.NOTIFY_EMAIL,
    `[MATCH-MOVE] 이번 주 콘텐츠 갭 — 신규 ${newContent.length}건 / GEO재최적화 ${reopt.length}건`,
    parts.join("\n")
  );
}

function getSheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(name);
  if (!sheet) {
    throw new Error(`시트를 찾을 수 없습니다: ${name} (docs/SHEETS_SETUP.md 참고해 탭을 먼저 만드세요)`);
  }
  return sheet;
}
