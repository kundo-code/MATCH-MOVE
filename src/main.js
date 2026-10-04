import { GlobeScene } from './globe.js';
import { drawHud, FONT } from './hud.js';
import { AIRLINES, DEFAULT_AIRLINE } from './data/airlines.js';
import { greatCircleKm, estimateFlightMinutes, formatDuration } from './flight.js';
import { exportMp4, canvasToPng, downloadBlob, supportsMp4Export } from './exporter.js';

const $ = (id) => document.getElementById(id);
const DEFAULT_ORIGIN = 'ICN-T1';
const DEFAULT_DEST = 'NRT';
// 국가를 고르면 처음 선택되는 대표 공항
const DEFAULT_AIRPORT = {
  JP: 'NRT', CN: 'PVG', HK: 'HKG', MO: 'MFM', TW: 'TPE', MN: 'UBN',
  VN: 'SGN', TH: 'BKK', PH: 'MNL', SG: 'SIN', MY: 'KUL', ID: 'CGK', KH: 'PNH', LA: 'VTE', MM: 'RGN', BN: 'BWN', TL: 'DIL',
};

const state = {
  airline: DEFAULT_AIRLINE,
  originId: DEFAULT_ORIGIN,
  regionId: 'east-asia',
  countryId: 'JP',
  destId: DEFAULT_DEST,
  duration: 8,
  playing: true,
  t: 0,
  exporting: false,
};

let data, scene, hudCtx;
const ASPECTS = { '16:9': [16, 9], '9:16': [9, 16], '1:1': [1, 1] };
/** 선택한 비율·해상도의 출력 픽셀 크기 (짧은 변 기준, 짝수로 맞춤 — H.264 요구사항) */
function outputSize() {
  const [aw, ah] = ASPECTS[$('aspect').value];
  const short = +$('quality').value, k = short / Math.min(aw, ah);
  return [Math.round((aw * k) / 2) * 2, Math.round((ah * k) / 2) * 2];
}
const stage = $('stage'), glCanvas = $('gl'), hudCanvas = $('hud');

// ── 데이터/UI 구성 ───────────────────────────────────────────────────
function airlineOf() { return AIRLINES.find((a) => a.id === state.airline); }
function originOf() { return data.origins.find((a) => a.id === state.originId); }
function destOf() { return data.destinations.find((a) => a.id === state.destId); }

const AIRLINE_GROUPS = [
  ['대한민국', ['KE', 'OZ', '7C', 'LJ', 'TW', 'BX', 'RS', 'ZE', 'YP']],
  ['일본 · 중화권', ['JL', 'NH', 'CX', 'CA', 'MU', 'CI', 'BR']],
  ['동남아시아', ['SQ', 'TG', 'VN', 'VJ', 'PR', 'MH', 'GA', 'ID', 'AK']],
];
function buildAirlineChips() {
  const box = $('airlines');
  box.innerHTML = '';
  for (const [title, ids] of AIRLINE_GROUPS) {
    const sg = document.createElement('div');
    sg.className = 'sg';
    sg.innerHTML = `<div class="sg-title">${title}</div><div class="sg-body chips"></div>`;
    const body = sg.querySelector('.sg-body');
    for (const id of ids) {
      const a = AIRLINES.find((x) => x.id === id);
      if (!a) continue;
      const b = document.createElement('button');
      b.className = 'chip';
      b.type = 'button';
      b.innerHTML = `<i style="background:${a.route}"></i>${a.ko}`;
      b.setAttribute('aria-pressed', a.id === state.airline);
      b.onclick = () => { state.airline = a.id; buildAirlineChips(); applyFlight(); };
      body.appendChild(b);
    }
    box.appendChild(sg);
  }
}

function buildOrigins() {
  const sel = $('origin');
  sel.innerHTML = data.origins.map((o) => `<option value="${o.id}">${o.ko} (${o.iata})</option>`).join('');
  sel.value = state.originId;
  sel.onchange = () => { state.originId = sel.value; applyFlight(); };
}

const KO = (a, b) => a.localeCompare(b, 'ko');

function buildRegions() {
  const box = $('regions');
  box.innerHTML = '';
  for (const r of data.regions) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.type = 'button';
    b.textContent = r.ko;
    b.setAttribute('aria-pressed', r.id === state.regionId);
    b.onclick = () => {
      // 권역을 바꾸면 국가·공항 선택은 다시 순서대로 (현재 노선은 새 공항을 고를 때까지 유지)
      state.regionId = r.id;
      state.countryId = null;
      $('search').value = '';
      buildRegions(); buildCountries(); buildDestinations(); updateStepLocks();
    };
    box.appendChild(b);
  }
}

/** 권역 안에서 공항 데이터가 있는 국가만 (가나다순) */
function countriesInRegion() {
  const region = data.regions.find((r) => r.id === state.regionId);
  const has = new Set(data.destinations.map((a) => a.country));
  return region.countries.filter((c) => has.has(c.code)).sort((a, b) => KO(a.ko, b.ko));
}

/** 선택한 국가의 공항 (가나다순) */
function airportsInCountry() {
  if (!state.countryId) return [];
  return data.destinations.filter((a) => a.country === state.countryId).sort((a, b) => KO(a.ko || a.en, b.ko || b.en));
}

function buildCountries() {
  const sel = $('country');
  const count = (code) => data.destinations.filter((a) => a.country === code).length;
  sel.innerHTML = `<option value="" disabled ${state.countryId ? '' : 'selected'}>국가를 선택하세요</option>` +
    countriesInRegion().map((c) => `<option value="${c.code}">${c.ko} (${c.en}) · 공항 ${count(c.code)}곳</option>`).join('');
  sel.value = state.countryId || '';
  sel.onchange = () => {
    state.countryId = sel.value || null;
    $('search').value = '';
    buildDestinations();
    updateStepLocks();
  };
}

function buildDestinations() {
  const q = $('search').value.trim().toLowerCase();
  const all = airportsInCountry();
  const list = all.filter((a) => !q || [a.iata, a.icao, a.en, a.ko, a.city].join(' ').toLowerCase().includes(q));
  const sel = $('dest');
  sel.innerHTML = list.map((a) => `<option value="${a.id}">${a.ko || a.en} · ${a.iata}</option>`).join('');
  // 모든 공항이 스크롤 없이 한 번에 보이도록 목록 길이를 공항 수에 맞춘다
  sel.size = Math.max(3, list.length);
  if (list.some((a) => a.id === state.destId)) sel.value = state.destId;
  else sel.selectedIndex = -1;
  sel.onchange = () => { state.destId = sel.value; applyFlight(); };
  $('stpAirportHint').textContent = state.countryId ? `가나다순 · ${list.length}${q ? `/${all.length}` : ''}곳` : '';
}

/** 순서대로 선택해야 다음 단계가 활성화된다: 권역 → 국가 → 공항 */
function updateStepLocks() {
  const regionOk = !!state.regionId, countryOk = regionOk && !!state.countryId;
  $('stpCountry').classList.toggle('is-locked', !regionOk);
  $('country').disabled = !regionOk;
  $('stpAirport').classList.toggle('is-locked', !countryOk);
  $('dest').disabled = !countryOk;
  $('search').disabled = !countryOk;
  $('stpCountryHint').textContent = regionOk && !countryOk ? '← 국가를 선택하세요' : '';
  if (!countryOk) { $('dest').innerHTML = '<option disabled>국가를 먼저 선택하세요</option>'; $('dest').size = 3; }
}

// ── 비행 정보 계산 ────────────────────────────────────────────────────
function flightMeta() {
  const o = originOf(), d = destOf(), airline = airlineOf();
  const distanceKm = greatCircleKm(o, d);
  const outAuto = estimateFlightMinutes(o, d), backAuto = estimateFlightMinutes(d, o);
  const outManual = parseInt($('outMin').value, 10), backManual = parseInt($('backMin').value, 10);
  return {
    airline, origin: o, dest: d,
    originCountry: data.countryNames[o.country], destCountry: data.countryNames[d.country],
    distanceKm, outAuto, backAuto,
    outMin: outManual > 0 ? outManual : outAuto,
    backMin: backManual > 0 ? backManual : backAuto,
    routeColor: airline.route,
    routeCountries: new Set([o.country, d.country]),
    showCountryLabels: $('optCountries').checked,
    showCard: $('optCard').checked,
    showOriginTarget: $('optOriginTarget').checked,
    showDestTarget: $('optDestTarget').checked,
    showTop: $('optTop').checked,
    topBoxScale: +$('topBoxSize').value / 100,
    topFontScale: +$('topFontSize').value / 100,
    cardBoxScale: +$('cardBoxSize').value / 100,
    cardFontScale: +$('cardFontSize').value / 100,
    showOriginBox: $('optOriginBox').checked,
    showDestBox: $('optDestBox').checked,
    originBoxScale: +$('originBoxSize').value / 100,
    destBoxScale: +$('destBoxSize').value / 100,
    originTargetScale: +$('originTargetSize').value / 100,
    destTargetScale: +$('destTargetSize').value / 100,
    tilesActive: false,
  };
}

let meta;
function refreshMeta() {
  meta = flightMeta();
  $('outAuto').textContent = formatDuration(meta.outAuto);
  $('backAuto').textContent = formatDuration(meta.backAuto);
  meta.tilesActive = scene?.hasTiles && $('optHd').checked;
  updateSummaries?.();
}

function applyFlight() {
  const o = originOf(), d = destOf(), a = airlineOf();
  refreshMeta();
  // 동남아시아는 아시아 전체가 보이는 넓은 시작 화면이 기본
  scene.setOptions({ wideStart: state.regionId === 'southeast-asia', duration: state.duration });
  updateSummaries?.();
  scene.setFlight({ origin: o, dest: d, livery: a, routeColor: a.route });
  const badge = $('tilesBadge');
  badge.hidden = !$('optHd').checked;
  badge.textContent = '고해상도 위성 타일 불러오는 중…';
  scene.tilesPromise.then((n) => {
    refreshMeta();
    badge.textContent = n ? '고해상도 위성 타일 적용됨' : '고해상도 타일 없음 (오프라인) · 기본 지구 텍스처 사용';
    setTimeout(() => { badge.hidden = true; }, 3500);
  });
}

// ── 프레임 합성 ───────────────────────────────────────────────────────
function syncPreviewSize() {
  const [w, h] = outputSize();
  stage.style.setProperty('--ar', w / h);
  stage.style.aspectRatio = `${w} / ${h}`;
  const rect = stage.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pw = Math.max(320, Math.round(rect.width * dpr)), ph = Math.max(180, Math.round(pw * (h / w)));
  hudCanvas.width = pw; hudCanvas.height = ph;
  scene.resize(pw, ph);
}

function renderPreview() {
  const info = scene.renderAt(state.t, state.t * state.duration);
  hudCtx.clearRect(0, 0, hudCanvas.width, hudCanvas.height);
  drawHud(hudCtx, hudCanvas.width, hudCanvas.height, info, meta);
  const total = state.duration, cur = state.t * total;
  $('clock').textContent = `${fmt(cur)} / ${fmt(total)}`;
  $('scrub').value = Math.round(state.t * 1000);
}
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

let last = performance.now();
function loop(now) {
  const dt = (now - last) / 1000;
  last = now;
  if (!state.exporting) {
    stepView(dt);
    if (state.playing) {
      state.t += dt / state.duration;
      if (state.t >= 1.12) state.t = 0; // 마지막 장면을 잠시 보여준 뒤 반복
    }
    state.t = Math.min(state.t, 1);
    renderPreview();
  }
  requestAnimationFrame(loop);
}

/** 지정 해상도로 한 프레임(3D + HUD)을 합성한 캔버스를 반환 */
function makeComposer(W, H) {
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const ctx = out.getContext('2d');
  // 슈퍼샘플링: 더 큰 해상도로 렌더한 뒤 축소해 가장자리·가는 선을 부드럽게 (4K는 부하가 커서 제외)
  const ss = $('optSS').checked && Math.min(W, H) <= 1440 ? (Math.min(W, H) <= 1080 ? 1.5 : 1.25) : 1;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return (t, seconds) => {
    scene.resize(Math.round(W * ss), Math.round(H * ss));
    const info = scene.renderAt(t, seconds);
    ctx.drawImage(glCanvas, 0, 0, W, H);
    drawHud(ctx, W, H, info, meta);
    return out;
  };
}

async function ensureAssets() {
  await Promise.all([
    scene.ready,
    scene.options.hdTiles ? scene.tilesPromise : null,
    ...['400', '500', '700', '900'].map((w) => document.fonts.load(`${w} 24px "Noto Sans KR"`).catch(() => {})),
  ]);
  await document.fonts.ready;
  refreshMeta();
}

const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
const baseName = () => `${meta.airline.id}_${meta.origin.iata}-${meta.dest.iata}_${stamp()}`;

async function savePng() {
  snapView();
  const [W, H] = outputSize();
  setBusy(true, '이미지 생성 중…');
  try {
    await ensureAssets();
    const compose = makeComposer(W, H);
    const canvas = compose(state.t, state.t * state.duration);
    downloadBlob(await canvasToPng(canvas), `${baseName()}.png`);
  } finally { setBusy(false); syncPreviewSize(); }
}

let abort = null;
async function saveMp4() {
  snapView();
  const [W, H] = outputSize();
  const fps = +$('fps').value, targetMB = +$('targetMB').value || 50;
  abort = new AbortController();
  setBusy(true, '에셋 준비 중…');
  state.exporting = true;
  $('progress').hidden = false;
  try {
    await ensureAssets();
    const compose = makeComposer(W, H);
    const t0 = performance.now();
    const { blob, codec } = await exportMp4({
      renderFrame: (t) => compose(t, t * state.duration),
      width: W, height: H, fps, durationSec: state.duration, targetMB, signal: abort.signal,
      onProgress: ({ done, total, eta }) => {
        $('progressBar').style.width = `${(done / total) * 100}%`;
        $('progressText').textContent = `인코딩 ${done}/${total} 프레임 · 남은 시간 약 ${Math.ceil(eta)}초`;
      },
    });
    downloadBlob(blob, `${baseName()}.mp4`);
    const sec = Math.round((performance.now() - t0) / 1000);
    const mb = blob.size / 1024 / 1024;
    $('exportNote').textContent = `저장 완료: ${mb.toFixed(1)} MB · ${W}×${H} · ${fps}fps · ${codec} · 소요 ${sec}초` +
      (mb < targetMB * 0.7 ? ' — 목표보다 작게 나왔습니다. 해상도나 fps를 올리면 용량을 더 활용할 수 있어요.' : '');
  } catch (e) {
    $('exportNote').textContent = e.name === 'AbortError' ? '영상 저장을 취소했습니다.' : `영상 저장 실패: ${e.message}`;
    console.error(e);
  } finally {
    state.exporting = false;
    $('progress').hidden = true;
    setBusy(false);
    syncPreviewSize();
  }
}

function updateBitrateHint() {
  const mb = +$('targetMB').value || 50, sec = state.duration, fps = +$('fps').value;
  const mbps = (mb * 8 * 0.94) / sec;
  $('bitrateHint').textContent = `목표 ${mb}MB · ${sec}초 → 약 ${mbps.toFixed(1)} Mbps (${fps}fps). 화면이 단순한 구간이 많으면 실제 용량이 목표보다 작게 나올 수 있고, 해상도·fps를 올리면 같은 용량에서 더 선명해집니다.`;
}

function setBusy(busy, msg) {
  $('savePng').disabled = $('saveMp4').disabled = busy;
  if (msg) $('exportNote').textContent = msg;
}

// ── 시점 컨트롤러 ─────────────────────────────────────────────────────
// 시작 화면과 도착 화면을 각각 설정한다 (확대/축소·회전·기울기·이동). 애니메이션은 시작 → 도착으로 보간된다.
// 슬라이더·휠·드래그는 '편집 중인 화면'의 목표값(tgt)만 바꾸고, 매 프레임 현재값(cur)이 부드럽게 따라간다.
// 영상/이미지 저장 시에는 목표값으로 즉시 맞춘다.
let updateSummaries = null; // 아코디언 요약 갱신 (아래에서 구현)
const VIEW_DEFAULT = {
  start: { zoom: 1, rot: 0, tilt: 38, panX: 0, panY: 0 },
  end: { zoom: 1, rot: 0, tilt: 52, panX: 0, panY: 0 },
};
const cloneView = (v) => ({ start: { ...v.start }, end: { ...v.end } });
const view = { cur: cloneView(VIEW_DEFAULT), tgt: cloneView(VIEW_DEFAULT), active: 'start' };
const ZOOM_MIN = 0.4, ZOOM_MAX = 5; // 40% ~ 500%
const clampN = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
const activeTgt = () => view.tgt[view.active];

function pushView() {
  const s = view.cur.start, e = view.cur.end;
  scene.setOptions({
    mapZoom: s.zoom, mapRotate: wrap180(s.rot), mapTilt: s.tilt, panX: s.panX, panY: s.panY,
    endZoom: e.zoom, endRotate: wrap180(e.rot), endTilt: e.tilt, endPanX: e.panX, endPanY: e.panY,
  });
}
/** 현재값이 목표값을 지수 감쇠로 따라간다 (프레임 속도와 무관) */
function stepView(dt) {
  const k = 1 - Math.exp(-Math.min(dt, 0.1) * 12);
  for (const key of ['start', 'end']) {
    const c = view.cur[key], t = view.tgt[key];
    c.zoom = Math.exp(Math.log(c.zoom) + (Math.log(t.zoom) - Math.log(c.zoom)) * k);
    for (const f of ['rot', 'tilt', 'panX', 'panY']) c[f] += (t[f] - c[f]) * k;
  }
  pushView();
}
function snapView() { view.cur = cloneView(view.tgt); pushView(); }

function syncViewUi() {
  const t = activeTgt();
  $('mapZoom').value = Math.round(t.zoom * 100);
  $('mapZoomOut').textContent = `${Math.round(t.zoom * 100)}%`;
  const r = Math.round(wrap180(t.rot));
  $('mapRotate').value = r;
  $('mapRotateOut').textContent = `${r}°`;
  $('mapTilt').value = Math.round(t.tilt);
  $('mapTiltOut').textContent = `${Math.round(t.tilt)}°`;
  for (const tab of document.querySelectorAll('[data-viewtab]')) tab.setAttribute('aria-pressed', tab.dataset.viewtab === view.active);
  $('viewEditing').textContent = view.active === 'start' ? '시작 화면' : '도착 화면';
  updateSummaries?.();
}

/** 편집할 화면을 고르고, 미리보기를 그 시점(처음/끝)으로 옮겨 바로 확인할 수 있게 한다 */
function setActiveView(name) {
  view.active = name;
  state.playing = false;
  $('play').textContent = '▶';
  state.t = name === 'start' ? 0.07 : 1; // 처음 장면은 정보 UI가 서서히 나타나기 전(0)이 아니라 막 보이는 시점
  syncViewUi();
}

function wireView() {
  $('mapZoom').oninput = (e) => { activeTgt().zoom = clampN(+e.target.value / 100, ZOOM_MIN, ZOOM_MAX); syncViewUi(); };
  // 슬라이더 값(-180~180)에 가장 가까운 각도로 이동 → 경계를 넘을 때 반대로 한 바퀴 돌지 않는다
  $('mapRotate').oninput = (e) => { const t = activeTgt(); t.rot += wrap180(+e.target.value - wrap180(t.rot)); syncViewUi(); };
  $('mapTilt').oninput = (e) => { activeTgt().tilt = clampN(+e.target.value, 0, 70); syncViewUi(); };
  const reset = () => {
    const key = view.active, t = activeTgt();
    Object.assign(t, VIEW_DEFAULT[key]);
    t.rot = view.cur[key].rot + wrap180(0 - wrap180(view.cur[key].rot));
    syncViewUi();
  };
  $('viewReset').onclick = reset;
  for (const tab of document.querySelectorAll('[data-viewtab]')) tab.onclick = () => setActiveView(tab.dataset.viewtab);
  stage.addEventListener('dblclick', reset);
  stage.addEventListener('contextmenu', (e) => e.preventDefault());
  // 휠: 변화량에 비례해 연속적으로 (트랙패드의 작은 값도 부드럽게)
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    const t = activeTgt();
    t.zoom = clampN(t.zoom * Math.exp(-dy * 0.0015), ZOOM_MIN, ZOOM_MAX);
    syncViewUi();
  }, { passive: false });
  // 드래그: 기본 = 지도 이동, Shift 또는 우클릭 = 회전(좌우)·기울기(상하). 편집 중인 화면(시작/도착)에 적용된다
  let drag = null;
  stage.addEventListener('pointerdown', (e) => {
    const rect = stage.getBoundingClientRect();
    drag = { x: e.clientX, y: e.clientY, h: rect.height, mode: e.shiftKey || e.button === 2 ? 'rotate' : 'pan', start: { ...activeTgt() } };
    stage.setPointerCapture(e.pointerId);
    stage.classList.add('dragging');
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const t = activeTgt();
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (drag.mode === 'pan') {
      t.panX = drag.start.panX - dx / drag.h;
      t.panY = drag.start.panY + dy / drag.h;
    } else {
      t.rot = drag.start.rot + dx * 0.3;
      t.tilt = clampN(drag.start.tilt - dy * 0.2, 0, 70);
    }
    syncViewUi();
  });
  const end = () => { drag = null; stage.classList.remove('dragging'); };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
}

/** 좌측 패널: 항목별 한 줄 요약 + 접기/펼치기 상태 기억 */
function setupPanel() {
  const panel = document.querySelector('.panel');
  const onoff = (id) => ($(id).checked ? 'ON' : 'OFF');
  const t = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  updateSummaries = () => {
    if (!meta) return;
    const q = { '1080': 'FHD', '1440': 'QHD', '2160': '4K' }[$('quality').value];
    t('sumAirline', meta.airline.ko);
    t('sumOrigin', meta.origin.ko || meta.origin.en);
    t('sumDest', `${meta.destCountry.ko} · ${meta.dest.ko || meta.dest.en}`);
    t('sumTime', `가는 편 ${formatDuration(meta.outMin)} · 오는 편 ${formatDuration(meta.backMin)}`);
    t('sumView', `시작 ${Math.round(view.tgt.start.zoom * 100)}% → 도착 ${Math.round(view.tgt.end.zoom * 100)}%`);
    t('sumDisplay', `입체감 ${$('depth').value}% · 기체 ${$('planeSize').value}%`);
    t('sumOriginOpt', `타겟 ${onoff('optOriginTarget')} · 박스 ${onoff('optOriginBox')}`);
    t('sumDestOpt', `타겟 ${onoff('optDestTarget')} · 박스 ${onoff('optDestBox')}`);
    t('sumPlane', `${$('planeSize').value}%`);
    t('sumTopOpt', `${onoff('optTop')} · 박스 ${$('topBoxSize').value}% · 글자 ${$('topFontSize').value}%`);
    t('sumCardOpt', `${onoff('optCard')} · 박스 ${$('cardBoxSize').value}% · 글자 ${$('cardFontSize').value}%`);
    t('sumDepth', `${$('depth').value}%${$('optShadow').checked ? ' · 그림자' : ''}`);
    const maps = ['optIntro', 'optBorders', 'optCountries', 'optClouds', 'optHd'].filter((id) => $(id).checked).length;
    t('sumMap', `${maps}/5 켜짐`);
    t('sumOutput', `${$('aspect').value} · ${q} · ${state.duration}초 · ${$('fps').value}fps`);
  };
  panel.addEventListener('input', () => updateSummaries());
  panel.addEventListener('change', () => updateSummaries());

  // 접기 상태 기억 (저장소를 쓸 수 없는 환경에서도 동작)
  const KEY = 'match-move.panel.v2';
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { /* 무시 */ }
  const all = [...panel.querySelectorAll('details')];
  all.forEach((d, i) => {
    const id = d.dataset.sec || `grp${i}`;
    d.dataset.key = id;
    d.open = id in saved ? !!saved[id] : (id === 'origin' || id === 'dest'); // 기본: 출발·도착 공항만 펼침
    d.addEventListener('toggle', () => {
      saved[id] = d.open;
      try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch { /* 무시 */ }
    });
  });
  $('expandAll').onclick = () => all.forEach((d) => { d.open = true; });
  $('collapseAll').onclick = () => all.forEach((d) => { d.open = false; });
  updateSummaries();
}

function wirePointOptions() {
  const refresh = () => refreshMeta();
  const bind = (id, opt) => { $(id).onchange = () => { if (opt) scene.setOptions({ [opt]: $(id).checked }); refresh(); }; };
  bind('optOriginTarget', 'originTarget');
  bind('optDestTarget', 'destTarget');
  bind('optOriginBox');
  bind('optDestBox');
  $('startView').onchange = () => scene.setOptions({ startView: $('startView').value });
  $('depth').oninput = (e) => {
    $('depthOut').textContent = `${e.target.value}%`;
    scene.setOptions({ depth: +e.target.value / 100 });
  };
  $('optShadow').onchange = () => scene.setOptions({ planeShadow: $('optShadow').checked });
  // 상단 항공 정보 / 하단 카드: 박스·글자 크기
  for (const id of ['topBoxSize', 'topFontSize', 'cardBoxSize', 'cardFontSize']) {
    $(id).oninput = (e) => { $(`${id}Out`).textContent = `${e.target.value}%`; refresh(); };
  }
  $('optTop').onchange = refresh;
  // 하단 카드 표시: 타임라인 옆 스위치와 같은 값을 공유
  const syncCard = (on) => { $('optCard').checked = on; $('optCardGrp').checked = on; scene.setOptions({ cardShown: on }); refreshMeta(); };
  $('optCard').onchange = () => syncCard($('optCard').checked);
  $('optCardGrp').onchange = () => syncCard($('optCardGrp').checked);
  // 출발/도착 지점별 타겟·정보박스 크기
  for (const [id, label, apply] of [
    ['originTargetSize', 'originTargetSizeOut', (v) => scene.setOptions({ originTargetScale: v })],
    ['destTargetSize', 'destTargetSizeOut', (v) => scene.setOptions({ destTargetScale: v })],
    ['originBoxSize', 'originBoxSizeOut', () => {}],
    ['destBoxSize', 'destBoxSizeOut', () => {}],
  ]) {
    $(id).oninput = (e) => { $(label).textContent = `${e.target.value}%`; apply(+e.target.value / 100); refresh(); };
  }
  // 기본 크기값(HTML 슬라이더 값)을 씬에 반영
  scene.setOptions({ originTargetScale: +$('originTargetSize').value / 100, destTargetScale: +$('destTargetSize').value / 100 });
  $('planeSize').oninput = (e) => {
    $('planeSizeOut').textContent = `${e.target.value}%`;
    scene.setOptions({ planeSize: +e.target.value / 100 });
  };
}

// ── 시작 ──────────────────────────────────────────────────────────────
async function init() {
  data = await (await fetch('data/airports.json')).json();
  scene = new GlobeScene(glCanvas);
  hudCtx = hudCanvas.getContext('2d');
  window.__app = { scene, state, get meta() { return meta; }, compose: (W, H) => makeComposer(W, H), ensureAssets };

  buildAirlineChips(); buildOrigins(); buildRegions(); buildCountries(); buildDestinations(); updateStepLocks();
  syncPreviewSize();
  await scene.ready;
  applyFlight();
  $('loading').hidden = true;

  const reflow = () => { refreshMeta(); };
  // ── 시점 조절: 확대/축소 · 회전 · 기울기 · 이동 ────────────────────────────
  // 슬라이더·휠·드래그는 목표값(tgt)만 바꾸고, 매 프레임 현재값(cur)이 목표값을 부드럽게 따라간다.
  // 영상/이미지 저장 시에는 목표값으로 즉시 맞춘다.
  wireView();
  wirePointOptions();
  setupPanel();
  syncViewUi();
  $('optIntro').onchange = () => scene.setOptions({ globeIntro: $('optIntro').checked });
  ['outMin', 'backMin'].forEach((id) => $(id).addEventListener('input', reflow));
  $('search').addEventListener('input', buildDestinations);
  $('optBorders').onchange = (e) => scene.setOptions({ borders: e.target.checked });
  $('optClouds').onchange = (e) => scene.setOptions({ clouds: e.target.checked });
  $('optCountries').onchange = (e) => { scene.setOptions({ countryLabels: e.target.checked }); refreshMeta(); };
  $('optHd').onchange = (e) => { scene.setOptions({ hdTiles: e.target.checked }); refreshMeta(); };
  $('duration').oninput = (e) => { state.duration = +e.target.value; scene.setOptions({ duration: state.duration }); $('durationOut').textContent = `${state.duration}초`; updateBitrateHint(); };
  $('targetMB').oninput = $('fps').onchange = updateBitrateHint;
  updateBitrateHint();
  $('aspect').onchange = $('quality').onchange = syncPreviewSize;
  $('play').onclick = () => { state.playing = !state.playing; $('play').textContent = state.playing ? '❚❚' : '▶'; };
  $('scrub').oninput = (e) => { state.playing = false; $('play').textContent = '▶'; state.t = e.target.value / 1000; };
  $('savePng').onclick = savePng;
  $('saveMp4').onclick = saveMp4;
  $('cancel').onclick = () => abort?.abort();
  window.addEventListener('resize', () => { if (!state.exporting) syncPreviewSize(); });
  if (!supportsMp4Export()) {
    $('saveMp4').disabled = true;
    $('exportNote').textContent = '이 브라우저는 MP4 인코딩(WebCodecs)을 지원하지 않습니다. 최신 Chrome/Edge를 사용해 주세요. (이미지 저장은 가능)';
  }
  document.fonts?.load(`700 20px ${FONT}`);
  requestAnimationFrame(loop);
}

init().catch((e) => { $('loading').textContent = `초기화 실패: ${e.message}`; console.error(e); });
