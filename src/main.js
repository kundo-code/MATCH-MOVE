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
  duration: 15,
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

function buildAirlineChips() {
  const box = $('airlines');
  box.innerHTML = '';
  for (const a of AIRLINES) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.type = 'button';
    b.innerHTML = `<i style="background:${a.route}"></i>${a.ko}`;
    b.setAttribute('aria-pressed', a.id === state.airline);
    b.onclick = () => { state.airline = a.id; buildAirlineChips(); applyFlight(); };
    box.appendChild(b);
  }
}

function buildOrigins() {
  const sel = $('origin');
  sel.innerHTML = data.origins.map((o) => `<option value="${o.id}">${o.ko} (${o.iata})</option>`).join('');
  sel.value = state.originId;
  sel.onchange = () => { state.originId = sel.value; applyFlight(); };
}

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
      state.regionId = r.id;
      state.countryId = countriesInRegion()[0].code;
      pickDefaultAirport();
      $('search').value = '';
      buildRegions(); buildCountries(); buildDestinations(); applyFlight();
    };
    box.appendChild(b);
  }
}

/** 권역 안에서 공항 데이터가 있는 국가만 */
function countriesInRegion() {
  const region = data.regions.find((r) => r.id === state.regionId);
  const has = new Set(data.destinations.map((a) => a.country));
  return region.countries.filter((c) => has.has(c.code));
}

function airportsInCountry() {
  return data.destinations.filter((a) => a.country === state.countryId);
}

function pickDefaultAirport() {
  const list = airportsInCountry();
  state.destId = (list.find((a) => a.iata === DEFAULT_AIRPORT[state.countryId]) || list[0]).id;
}

function buildCountries() {
  const sel = $('country');
  const count = (code) => data.destinations.filter((a) => a.country === code).length;
  sel.innerHTML = countriesInRegion().map((c) => `<option value="${c.code}">${c.ko} (${c.en}) · 공항 ${count(c.code)}곳</option>`).join('');
  sel.value = state.countryId;
  sel.onchange = () => {
    state.countryId = sel.value;
    pickDefaultAirport();
    $('search').value = '';
    buildDestinations();
    applyFlight();
  };
}

function buildDestinations() {
  const q = $('search').value.trim().toLowerCase();
  const list = airportsInCountry().filter((a) => !q || [a.iata, a.icao, a.en, a.ko, a.city].join(' ').toLowerCase().includes(q));
  const sel = $('dest');
  sel.innerHTML = list.map((a) => `<option value="${a.id}">${a.ko || a.en} · ${a.iata}</option>`).join('');
  if (list.some((a) => a.id === state.destId)) sel.value = state.destId;
  sel.onchange = () => { state.destId = sel.value; applyFlight(); };
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
    showTargets: $('optTargets').checked,
    tilesActive: false,
  };
}

let meta;
function refreshMeta() {
  meta = flightMeta();
  $('outAuto').textContent = formatDuration(meta.outAuto);
  $('backAuto').textContent = formatDuration(meta.backAuto);
  meta.tilesActive = scene?.hasTiles && $('optHd').checked;
}

function applyFlight() {
  const o = originOf(), d = destOf(), a = airlineOf();
  refreshMeta();
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

// ── 시작 ──────────────────────────────────────────────────────────────
async function init() {
  data = await (await fetch('data/airports.json')).json();
  scene = new GlobeScene(glCanvas);
  hudCtx = hudCanvas.getContext('2d');
  window.__app = { scene, state, get meta() { return meta; }, compose: (W, H) => makeComposer(W, H), ensureAssets };

  buildAirlineChips(); buildOrigins(); buildRegions(); buildCountries(); buildDestinations();
  syncPreviewSize();
  await scene.ready;
  applyFlight();
  $('loading').hidden = true;

  const reflow = () => { refreshMeta(); };
  const setMapZoom = (pct) => {
    pct = Math.min(300, Math.max(40, Math.round(pct / 5) * 5));
    $('mapZoom').value = pct;
    $('mapZoomOut').textContent = `${pct}%`;
    scene.setOptions({ mapZoom: pct / 100 });
  };
  $('mapZoom').oninput = (e) => setMapZoom(+e.target.value);
  // 미리보기 위에서 휠로 확대/축소, 더블클릭으로 초기화
  stage.addEventListener('wheel', (e) => { e.preventDefault(); setMapZoom(+$('mapZoom').value * (e.deltaY < 0 ? 1.08 : 1 / 1.08)); }, { passive: false });
  stage.addEventListener('dblclick', () => setMapZoom(100));
  $('optCard').onchange = () => { scene.setOptions({ cardShown: $('optCard').checked }); refreshMeta(); };
  $('optTargets').onchange = () => { scene.setOptions({ markers3d: !$('optTargets').checked }); refreshMeta(); };
  scene.setOptions({ markers3d: !$('optTargets').checked, cardShown: $('optCard').checked });
  ['outMin', 'backMin'].forEach((id) => $(id).addEventListener('input', reflow));
  $('search').addEventListener('input', buildDestinations);
  $('optBorders').onchange = (e) => scene.setOptions({ borders: e.target.checked });
  $('optClouds').onchange = (e) => scene.setOptions({ clouds: e.target.checked });
  $('optCountries').onchange = (e) => { scene.setOptions({ countryLabels: e.target.checked }); refreshMeta(); };
  $('optHd').onchange = (e) => { scene.setOptions({ hdTiles: e.target.checked }); refreshMeta(); };
  $('duration').oninput = (e) => { state.duration = +e.target.value; $('durationOut').textContent = `${state.duration}초`; updateBitrateHint(); };
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
