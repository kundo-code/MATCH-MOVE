import { GlobeScene } from './globe.js';
import { drawHud, FONT } from './hud.js';
import { AIRLINES, DEFAULT_AIRLINE } from './data/airlines.js';
import { greatCircleKm, estimateFlightMinutes, formatDuration } from './flight.js';
import { exportMp4, canvasToPng, downloadBlob, supportsMp4Export } from './exporter.js';
import { renderFlightAudio, scaleBuffer } from './sound.js';
import { mixAudio, decodeAudioFile } from './mixer.js';
import { drawOverlays, fillTokens, INTRO_TEMPLATES, OUTRO_TEMPLATES } from './overlays.js';

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

// 영상 전체 길이 = 비행 시간 + 마지막 장면 연장. state.t는 비행 시간 기준(0~1)을 넘어 연장 구간까지 이어진다.
const holdSec = () => +($('outroHold')?.value || 0);
const totalSec = () => state.duration + holdSec();
const tMax = () => totalSec() / state.duration;

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
  sel._sync?.();
  sel.onchange = () => {
    state.countryId = sel.value || null;
    $('search').value = '';
    buildDestinations();
    updateStepLocks();
  };
}

/** <select>를 선택 항목 바로 아래로 목록이 펼쳐지는(스크롤 가능) 드롭다운으로 표시 */
function makeCombo(sel) {
  const wrap = document.createElement('div'); wrap.className = 'combo';
  const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'combo-btn';
  const list = document.createElement('div'); list.className = 'combo-list'; list.hidden = true; list.setAttribute('role', 'listbox');
  sel.parentNode.insertBefore(wrap, sel); wrap.append(btn, list); wrap.appendChild(sel); sel.classList.add('combo-native');
  const close = () => { list.hidden = true; wrap.classList.remove('open'); };
  const sync = () => {
    const cur = sel.options[sel.selectedIndex];
    btn.textContent = cur ? cur.textContent : '';
    btn.classList.toggle('is-placeholder', !sel.value);
    btn.disabled = sel.disabled;
    list.innerHTML = '';
    [...sel.options].forEach((o) => {
      if (o.disabled) return;
      const it = document.createElement('div'); it.className = 'combo-item'; it.setAttribute('role', 'option');
      it.textContent = o.textContent; it.dataset.v = o.value;
      if (o.value === sel.value) it.classList.add('sel');
      it.onclick = () => { sel.value = o.value; sync(); close(); sel.dispatchEvent(new Event('change')); };
      list.appendChild(it);
    });
    if (!list.children.length) { const e = document.createElement('div'); e.className = 'combo-empty'; e.textContent = '항목이 없습니다'; list.appendChild(e); }
  };
  btn.onclick = () => {
    if (!list.hidden) return close();
    document.querySelectorAll('.combo.open').forEach((c) => c._close?.());
    sync(); list.hidden = false; wrap.classList.add('open');
    list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  };
  wrap._close = close;
  document.addEventListener('pointerdown', (e) => { if (!wrap.contains(e.target)) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  new MutationObserver(sync).observe(sel, { childList: true, attributes: true, attributeFilter: ['disabled'] });
  sel._sync = sync; sync();
}

function buildDestinations() {
  const q = $('search').value.trim().toLowerCase();
  const all = airportsInCountry();
  const list = all.filter((a) => !q || [a.iata, a.icao, a.en, a.ko, a.city].join(' ').toLowerCase().includes(q));
  const sel = $('dest');
  // 국가 선택과 같은 드롭다운. 검색어를 입력하면 목록이 좁혀진다 (가나다순)
  const current = list.some((a) => a.id === state.destId) ? state.destId : '';
  sel.innerHTML = `<option value="" disabled ${current ? '' : 'selected'}>${list.length ? '공항을 선택하세요' : '검색 결과가 없습니다'}</option>` +
    list.map((a) => `<option value="${a.id}">${a.ko || a.en} · ${a.iata}</option>`).join('');
  sel.value = current;
  sel._sync?.();
  sel.onchange = () => { if (sel.value) { state.destId = sel.value; applyFlight(); } };
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
  if (!countryOk) $('dest').innerHTML = '<option value="" disabled selected>국가를 먼저 선택하세요</option>';
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
    showAirlineLogo: $('optAirlineLogo').checked,
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
  const sec = state.t * state.duration;
  const info = scene.renderAt(Math.min(state.t, 1), sec);
  hudCtx.clearRect(0, 0, hudCanvas.width, hudCanvas.height);
  drawHud(hudCtx, hudCanvas.width, hudCanvas.height, info, meta);
  drawOverlays(hudCtx, hudCanvas.width, hudCanvas.height, sec, totalSec(), storyCfg(), meta);
  $('clock').textContent = `${fmt(sec)} / ${fmt(totalSec())}`;
  $('scrub').value = Math.round((state.t / tMax()) * 1000);
}
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

let last = performance.now();
function loop(now) {
  const dt = (now - last) / 1000;
  last = now;
  if (!state.exporting) {
    stepView(dt);
    audioTick();
    if (state.playing) {
      state.t += dt / state.duration;
      if (recorder.on && state.t >= tMax()) stopRecording();
      if (state.t >= tMax() + 0.12) state.t = 0; // 마지막 장면을 잠시 보여준 뒤 반복
    }
    state.t = Math.min(state.t, tMax());
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
  const cfg = storyCfg(); // 저장 중에는 설정을 한 번만 읽는다
  return (t, seconds) => {
    scene.resize(Math.round(W * ss), Math.round(H * ss));
    const info = scene.renderAt(Math.min(t, 1), seconds);
    ctx.drawImage(glCanvas, 0, 0, W, H);
    drawHud(ctx, W, H, info, meta);
    drawOverlays(ctx, W, H, seconds, totalSec(), cfg, meta);
    return out;
  };
}

/** 저장 전에 필요한 에셋을 기다린다. 타일이 너무 오래 걸리면 40초 뒤에는 기본 지구 텍스처로 진행한다 */
const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r('timeout'), ms))]);
async function ensureAssets() {
  const tiles = scene.options.hdTiles ? await withTimeout(scene.tilesPromise, 40000) : null;
  if (tiles === 'timeout') $('exportNote').textContent = '위성 타일을 불러오는 데 시간이 오래 걸려 기본 지구 텍스처로 저장합니다. (인터넷 연결을 확인해 주세요)';
  await Promise.all([
    scene.ready,
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
    // 비행 사운드: 사용자가 정한 음량을 곱한 같은 버퍼를 오디오 트랙으로 넣는다
    const mixed = $('optSoundVideo').checked && soundVolume() > 0 ? await getAudioBuffer() : null;
    const audioBuffer = mixed ? scaleBuffer(mixed, soundVolume()) : null;
    const { blob, codec, audio: audioLabel } = await exportMp4({
      renderFrame: (u) => compose((u * totalSec()) / state.duration, u * totalSec()),
      width: W, height: H, fps, durationSec: totalSec(), targetMB, signal: abort.signal, audioBuffer,
      onProgress: ({ done, total, eta }) => {
        $('progressBar').style.width = `${(done / total) * 100}%`;
        $('progressText').textContent = `인코딩 ${done}/${total} 프레임 · 남은 시간 약 ${Math.ceil(eta)}초`;
      },
    });
    downloadBlob(blob, `${baseName()}.mp4`);
    const sec = Math.round((performance.now() - t0) / 1000);
    const mb = blob.size / 1024 / 1024;
    $('exportNote').textContent = `저장 완료: ${mb.toFixed(1)} MB · ${W}×${H} · ${fps}fps · ${codec}${audioLabel ? ` + 사운드(${audioLabel})` : ''} · 소요 ${sec}초` +
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
  const mb = +$('targetMB').value || 50, fps = +$('fps').value;
  const mbps = (mb * 8 * 0.94) / totalSec();
  $('bitrateHint').textContent = `목표 ${mb}MB · ${totalSec()}초 → 약 ${mbps.toFixed(1)} Mbps (${fps}fps). 화면이 단순한 구간이 많으면 실제 용량이 목표보다 작게 나올 수 있고, 해상도·fps를 올리면 같은 용량에서 더 선명해집니다.`;
}

function setBusy(busy, msg) {
  $('savePng').disabled = $('saveMp4').disabled = busy;
  if (msg) $('exportNote').textContent = msg;
}

// ── 사운드 (엔진음 + 배경음악 + 내레이션) ─────────────────────────────────
// 엔진음은 오프라인으로 한 번 합성하고, 배경음악·내레이션과 믹스한 버퍼를 만든다.
// 미리보기는 이 버퍼를 재생 위치에 맞춰 재생하고, MP4에는 같은 버퍼를 오디오 트랙으로 넣는다.
const audio = { ctx: null, gain: null, src: null, buf: null, bufKey: '', rendering: null, starting: false, startedAt: 0, startOffset: 0, ver: 0, engine: null, engineKey: '', muted: false };
const tracks = { bgm: null, narr: null }; // { name, buffer }
const recorder = { on: false, mr: null, stream: null, chunks: [] };
const hasAnyAudio = () => $('optSound').checked || !!tracks.bgm || !!tracks.narr;
const soundOn = () => !audio.muted && hasAnyAudio();
const soundVolume = () => +$('soundVol').value / 100;
const engineKey = () => [state.originId, state.destId, state.duration, $('optIntro').checked].join('|');
const audioKey = () => [engineKey(), totalSec(), audio.ver].join('|');

function applyVolume() {
  if (audio.gain) audio.gain.gain.value = soundOn() ? soundVolume() : 0;
  $('soundBtn').textContent = soundOn() && soundVolume() > 0 ? '🔊' : '🔇';
}
/** 사용자가 처음 화면을 누를 때 오디오를 켠다 (브라우저 자동재생 정책) */
function unlockAudio() {
  if (!audio.ctx) {
    audio.ctx = new (window.AudioContext || window.webkitAudioContext)();
    audio.gain = audio.ctx.createGain();
    audio.gain.connect(audio.ctx.destination);
  }
  audio.ctx.resume?.();
  applyVolume();
}
async function getEngineBuffer() {
  const key = engineKey();
  if (audio.engine && audio.engineKey === key) return audio.engine;
  const b = await renderFlightAudio({ duration: state.duration, stateAt: (t) => scene.flightState(t) });
  audio.engine = b; audio.engineKey = key;
  return b;
}
/** 현재 설정으로 믹스한 오디오 (소리가 하나도 없으면 null) */
function getAudioBuffer() {
  const key = audioKey();
  if (audio.buf !== undefined && audio.bufKey === key) return Promise.resolve(audio.buf);
  if (audio.rendering && audio.rendering.key === key) return audio.rendering.promise;
  const promise = (async () => {
    const engine = $('optSound').checked ? { buffer: await getEngineBuffer(), gain: +$('engVol').value / 100 } : null;
    const bgm = tracks.bgm ? { buffer: tracks.bgm.buffer, gain: +$('bgmVol').value / 100, fadeIn: +$('bgmIn').value, fadeOut: +$('bgmOut').value, loop: $('bgmLoop').checked } : null;
    const nar = tracks.narr ? { buffer: tracks.narr.buffer, gain: +$('narrVol').value / 100, start: +$('narrStart').value } : null;
    const mixed = await mixAudio({ totalSec: totalSec(), engine, bgm, narr: nar, duck: { on: $('optDuck').checked, depth: +$('duckAmt').value / 100 } });
    if (audioKey() === key) { audio.buf = mixed; audio.bufKey = key; }
    return mixed;
  })();
  audio.rendering = { key, promise };
  return promise;
}
function stopAudio() {
  const src = audio.src;
  audio.src = null;
  try { src?.stop(); } catch { /* 이미 끝남 */ }
}
async function startAudioAt(sec) {
  if (!audio.ctx || audio.starting) return;
  audio.starting = true;
  try {
    const buf = await getAudioBuffer();
    if (!buf || !state.playing || !soundOn() || state.exporting || recorder.on) return;
    stopAudio();
    const src = audio.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(audio.gain);
    const off = clampN(sec, 0, Math.max(0, buf.duration - 0.02));
    src.start(0, off);
    src.onended = () => { if (audio.src === src) audio.src = null; };
    audio.src = src;
    audio.startedAt = audio.ctx.currentTime;
    audio.startOffset = off;
    audio.srcKey = audioKey();
  } finally { audio.starting = false; }
}
/** 매 프레임: 재생 중이면 애니메이션 위치와 소리 위치를 맞춘다 */
function audioTick() {
  if (!audio.ctx) return;
  const want = soundOn() && state.playing && !state.exporting && !recorder.on && soundVolume() > 0;
  if (!want) { if (audio.src) stopAudio(); return; }
  if (state.t >= tMax()) return; // 마지막 장면 유지 구간: 소리는 자연스럽게 끝난다
  const sec = state.t * state.duration;
  if (!audio.src) { startAudioAt(sec); return; }
  const pos = audio.startOffset + (audio.ctx.currentTime - audio.startedAt);
  if (audio.srcKey !== audioKey() || Math.abs(pos - sec) > 0.25) startAudioAt(sec);
}

/** 배경음악·내레이션 파일/녹음 UI */
function wireAudioTracks() {
  const fmtVal = { bgmIn: (v) => `${v}초`, bgmOut: (v) => `${v}초`, bgmVol: (v) => `${v}%`, narrVol: (v) => `${v}%`, narrStart: (v) => `${(+v).toFixed(1)}초`, duckAmt: (v) => `${v}%`, engVol: (v) => `${v}%` };
  const outId = { bgmIn: 'bgmInOut', bgmOut: 'bgmOutOut', bgmVol: 'bgmVolOut', narrVol: 'narrVolOut', narrStart: 'narrStartOut', duckAmt: 'duckOut', engVol: 'engVolOut' };
  for (const id of Object.keys(fmtVal)) $(id).addEventListener('input', (e) => { $(outId[id]).textContent = fmtVal[id](e.target.value); });
  // 마스터 음량을 제외한 사운드 설정이 바뀌면 믹스를 다시 만든다
  const sec = document.querySelector('[data-sec="sound"]');
  const bump = (e) => { if (e.target.id !== 'soundVol') { audio.ver++; unlockAudio(); } };
  sec.addEventListener('input', bump); sec.addEventListener('change', bump);

  const sync = () => {
    for (const [kind, nameId, clrId] of [['bgm', 'bgmName', 'bgmClear'], ['narr', 'narrName', 'narrClear']]) {
      $(nameId).textContent = tracks[kind] ? `${tracks[kind].name} (${tracks[kind].buffer.duration.toFixed(1)}초)` : '선택 안 됨';
      $(clrId).hidden = !tracks[kind];
    }
    applyVolume(); updateSummaries?.();
  };
  const load = async (kind, file) => {
    if (!file) return;
    $('exportNote').textContent = `${file.name} 불러오는 중…`;
    try {
      tracks[kind] = { name: file.name, buffer: await decodeAudioFile(file) };
      $('exportNote').textContent = `${kind === 'bgm' ? '배경음악' : '내레이션'} 적용: ${file.name}`;
    } catch (e) {
      $('exportNote').textContent = `오디오 파일을 읽을 수 없습니다 (${file.name}). mp3, m4a, wav 파일을 사용해 주세요.`;
      console.error(e);
    }
    audio.ver++; sync();
  };
  $('bgmFile').onchange = (e) => { load('bgm', e.target.files[0]); e.target.value = ''; };
  $('narrFile').onchange = (e) => { load('narr', e.target.files[0]); e.target.value = ''; };
  $('bgmClear').onclick = () => { tracks.bgm = null; audio.ver++; sync(); };
  $('narrClear').onclick = () => { tracks.narr = null; audio.ver++; sync(); };
  $('narrRec').onclick = () => (recorder.on ? stopRecording() : startRecording());
  recorder.sync = sync;
  sync();
}

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { $('exportNote').textContent = '이 브라우저에서는 녹음을 사용할 수 없습니다. 음성 파일을 선택해 주세요.'; return; }
  try {
    recorder.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch { $('exportNote').textContent = '마이크 사용이 허용되지 않았습니다. 브라우저 주소창에서 마이크 권한을 허용해 주세요.'; return; }
  recorder.chunks = [];
  recorder.mr = new MediaRecorder(recorder.stream);
  recorder.mr.ondataavailable = (e) => e.data.size && recorder.chunks.push(e.data);
  recorder.mr.onstop = async () => {
    recorder.stream.getTracks().forEach((t) => t.stop());
    recorder.on = false; $('narrRec').textContent = '● 녹음'; state.playing = false; $('play').textContent = '▶';
    try {
      tracks.narr = { name: '녹음한 내레이션', buffer: await decodeAudioFile(new Blob(recorder.chunks, { type: recorder.mr.mimeType })) };
      $('narrStart').value = 0; $('narrStartOut').textContent = '0.0초';
      $('exportNote').textContent = '내레이션을 녹음했습니다. 영상 처음부터 들어갑니다.';
    } catch (e) { $('exportNote').textContent = '녹음을 읽을 수 없습니다.'; console.error(e); }
    audio.ver++; recorder.sync();
  };
  stopAudio();
  state.t = 0; state.playing = true; $('play').textContent = '❚❚';
  recorder.on = true; $('narrRec').textContent = '■ 녹음 중지';
  recorder.mr.start();
}
function stopRecording() { if (recorder.mr?.state === 'recording') recorder.mr.stop(); }

// ── 인트로 · 아웃트로 · 자막 ─────────────────────────────────────────────
const story = { subs: [], dirty: true, cfg: null, logo: null };
function storyCfg() {
  if (story.cfg && !story.dirty) return story.cfg;
  story.dirty = false;
  const part = (p) => ({ tpl: $(`${p}Tpl`).value, title: $(`${p}Title`).value, sub: $(`${p}Sub`).value, dur: +$(`${p}Dur`).value });
  story.cfg = {
    color: $('storyColor').value, logo: story.logo, logoWater: $('logoWater').checked,
    intro: part('intro'), outro: part('outro'),
    subs: $('optSubs').checked ? story.subs.map((x) => ({ ...x })) : [],
    subPos: $('subPos').value, subBg: $('subBg').checked, subSize: +$('subSize').value / 100,
  };
  return story.cfg;
}

function renderSubList() {
  const box = $('subList');
  box.innerHTML = '';
  story.subs.forEach((sub, i) => {
    const row = document.createElement('div'); row.className = 'subrow';
    const txt = document.createElement('input'); txt.type = 'text'; txt.value = sub.text; txt.placeholder = '자막 내용 ({도착} 같은 값 사용 가능)';
    txt.oninput = () => { sub.text = txt.value; story.dirty = true; };
    const mk = (key, label) => {
      const l = document.createElement('label'); l.className = 'subtime'; l.append(label);
      const n = document.createElement('input'); n.type = 'number'; n.min = 0; n.max = 120; n.step = 0.1; n.value = sub[key];
      n.oninput = () => { sub[key] = Math.max(0, +n.value || 0); story.dirty = true; };
      l.append(n); return l;
    };
    const del = document.createElement('button'); del.type = 'button'; del.className = 'link'; del.textContent = '삭제';
    del.onclick = () => { story.subs.splice(i, 1); story.dirty = true; renderSubList(); updateSummaries?.(); };
    row.append(txt, mk('start', '시작 '), mk('end', '끝 '), del);
    box.appendChild(row);
  });
  if (!story.subs.length) { const e = document.createElement('p'); e.className = 'hint'; e.textContent = '자막이 없습니다. “자막 추가” 또는 “노선 자막 자동 생성”을 눌러 보세요.'; box.appendChild(e); }
}

function autoSubtitles() {
  const D = totalSec(), r = (v) => Math.round(v * 10) / 10;
  story.subs = [
    { text: '{출발}에서 출발합니다', start: r(D * 0.04), end: r(D * 0.3) },
    { text: '{거리} · 약 {시간} 비행', start: r(D * 0.34), end: r(D * 0.62) },
    { text: '{도착}에 곧 도착합니다', start: r(D * 0.68), end: r(D * 0.94) },
  ];
  story.dirty = true; renderSubList(); updateSummaries?.();
}

function wireStory() {
  for (const [id, list] of [['introTpl', INTRO_TEMPLATES], ['outroTpl', OUTRO_TEMPLATES]]) {
    $(id).innerHTML = list.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  }
  for (const [id, out, f] of [['introDur', 'introDurOut', (v) => `${v}초`], ['outroDur', 'outroDurOut', (v) => `${v}초`], ['outroHold', 'holdOut', (v) => `${v}초`], ['subSize', 'subSizeOut', (v) => `${v}%`]]) {
    $(id).addEventListener('input', (e) => { $(out).textContent = f(e.target.value); });
  }
  const dirty = () => { story.dirty = true; };
  document.querySelector('[data-sec="story"]').addEventListener('input', dirty);
  document.querySelector('[data-sec="story"]').addEventListener('change', dirty);
  $('outroHold').addEventListener('input', () => { audio.ver++; updateBitrateHint(); });
  $('subAdd').onclick = () => {
    const last = story.subs.at(-1);
    const start = last ? last.end : 0;
    story.subs.push({ text: '', start, end: Math.round(Math.min(totalSec(), start + 3) * 10) / 10 });
    story.dirty = true; renderSubList(); updateSummaries?.();
  };
  $('subAuto').onclick = autoSubtitles;
  $('optSubs').addEventListener('change', () => updateSummaries?.());
  // 채널 로고
  $('logoFile').onchange = (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    const img = new Image();
    img.onload = () => { story.logo = img; $('logoName').textContent = f.name; $('logoClear').hidden = false; story.dirty = true; };
    img.onerror = () => { $('exportNote').textContent = '이미지를 읽을 수 없습니다.'; };
    img.src = URL.createObjectURL(f);
  };
  $('logoClear').onclick = () => { story.logo = null; $('logoName').textContent = '선택 안 됨'; $('logoClear').hidden = true; story.dirty = true; };
  renderSubList();
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
    t('sumFx', `${{ studio: '스튜디오', dusk: '황혼', night: '야간' }[$('timeOfDay').value]} · 구름 ${$('cloudAmt').value}%`);
    t('sumDepth', `${$('depth').value}%${$('optShadow').checked ? ' · 그림자' : ''}`);
    const maps = ['optIntro', 'optBorders', 'optCountries', 'optClouds', 'optHd'].filter((id) => $(id).checked).length;
    t('sumMap', `${maps}/5 켜짐`);
    const sn = ['introTpl', 'outroTpl'].map((id) => ($(id).value === 'none' ? 'OFF' : 'ON'));
    t('sumStory', `인트로 ${sn[0]} · 아웃트로 ${sn[1]} · 자막 ${$('optSubs').checked ? story.subs.length : 0}개`);
    t('sumSound', soundOn() || hasAnyAudio() ? [audio.muted ? '음소거' : `${$('soundVol').value}%`, $('optSound').checked && '엔진', tracks.bgm && '음악', tracks.narr && '내레이션'].filter(Boolean).join(' · ') : 'OFF');
    t('sumOutput', `${$('aspect').value} · ${q} · ${state.duration}초 · ${$('fps').value}fps · 사운드 ${soundOn() ? $('soundVol').value + '%' : 'OFF'}`);
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
  // 사운드
  const setVol = (v) => { $('soundVol').value = v; $('soundVolQ').value = v; $('soundVolOut').textContent = `${v}%`; $('soundVolQ').title = `음량 ${v}%`; applyVolume(); updateSummaries?.(); };
  $('soundVol').oninput = (e) => { unlockAudio(); setVol(e.target.value); };
  $('soundVolQ').oninput = (e) => { unlockAudio(); if (+e.target.value > 0) audio.muted = false; setVol(e.target.value); };
  $('soundBtn').onclick = () => { audio.muted = !audio.muted; if (!audio.muted && soundVolume() === 0) setVol(60); unlockAudio(); applyVolume(); updateSummaries?.(); };
  document.addEventListener('pointerdown', unlockAudio, { once: true });
  document.addEventListener('keydown', unlockAudio, { once: true });
  wireAudioTracks();
  applyVolume();
  // 분위기·시각 효과
  $('timeOfDay').onchange = () => { scene.setOptions({ timeOfDay: $('timeOfDay').value }); };
  for (const [id, opt, k] of [['cityLights', 'cityLights', 100], ['cloudAmt', 'cloudAmt', 100], ['cloudSpeed', 'cloudSpeed', 100], ['atmoAmt', 'atmoAmt', 100], ['starAmt', 'starAmt', 100]]) {
    $(id).oninput = (e) => { $(`${id}Out`).textContent = `${e.target.value}%`; scene.setOptions({ [opt]: +e.target.value / k }); };
  }
  scene.setOptions({ cloudAmt: +$('cloudAmt').value / 100 });
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
  $('optAirlineLogo').onchange = refresh;
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
  window.__app = { scene, state, get meta() { return meta; }, compose: (W, H) => makeComposer(W, H), ensureAssets, getAudioBuffer, totalSec, scaleBuffer, storyCfg };

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
  wireStory();
  setupPanel();
  syncViewUi();
  $('optIntro').onchange = () => scene.setOptions({ globeIntro: $('optIntro').checked });
  ['outMin', 'backMin'].forEach((id) => $(id).addEventListener('input', reflow));
  makeCombo($('country')); makeCombo($('dest'));
  $('search').addEventListener('input', buildDestinations);
  $('search').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const first = [...$('dest').options].find((o) => o.value);
    if (first) { $('dest').value = first.value; $('dest')._sync(); state.destId = first.value; applyFlight(); }
  });
  $('optBorders').onchange = (e) => scene.setOptions({ borders: e.target.checked });
  $('optClouds').onchange = (e) => scene.setOptions({ clouds: e.target.checked });
  $('optCountries').onchange = (e) => { scene.setOptions({ countryLabels: e.target.checked }); refreshMeta(); };
  $('optHd').onchange = (e) => { scene.setOptions({ hdTiles: e.target.checked }); refreshMeta(); };
  $('duration').oninput = (e) => { state.duration = +e.target.value; scene.setOptions({ duration: state.duration }); $('durationOut').textContent = `${state.duration}초`; updateBitrateHint(); };
  $('targetMB').oninput = $('fps').onchange = updateBitrateHint;
  updateBitrateHint();
  $('aspect').onchange = $('quality').onchange = syncPreviewSize;
  $('play').onclick = () => { state.playing = !state.playing; $('play').textContent = state.playing ? '❚❚' : '▶'; };
  $('scrub').oninput = (e) => { state.playing = false; $('play').textContent = '▶'; state.t = (e.target.value / 1000) * tMax(); };
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

// 예기치 못한 오류는 화면에 알려 준다 (저장 중이면 저장 상태도 정리)
const reportError = (msg) => { console.error(msg); const n = $('exportNote'); if (n) n.textContent = `오류: ${String(msg).slice(0, 160)} — 새로고침 후 다시 시도해 주세요.`; };
window.addEventListener('unhandledrejection', (e) => { if (e.reason?.name !== 'AbortError') reportError(e.reason?.message || e.reason); });
window.addEventListener('error', (e) => reportError(e.message));
// WebGL 컨텍스트가 사라지면(그래픽 메모리 부족 등) 안내
glCanvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); reportError('그래픽 컨텍스트가 끊겼습니다. 4K 해상도·고품질 렌더링 옵션을 낮춰 보세요.'); });

init().catch((e) => { $('loading').textContent = `초기화 실패: ${e.message}`; console.error(e); });
