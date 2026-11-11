// 비행 사운드(엔진음) + 배경음악 + 내레이션을 하나의 스테레오 버퍼로 믹스한다.
// 미리보기와 MP4 저장이 같은 버퍼를 쓰므로 듣는 소리와 저장되는 소리가 같다.
const SR = 48000;

/** 오디오 파일(mp3/wav/m4a/ogg 등) 또는 녹음 Blob을 48kHz 스테레오 AudioBuffer로 디코딩 */
export async function decodeAudioFile(fileOrBlob) {
  const ab = await fileOrBlob.arrayBuffer();
  const ctx = new OfflineAudioContext(2, 1, SR);
  return ctx.decodeAudioData(ab);
}

/** 내레이션이 나오는 구간을 따라 0~1로 변하는 곡선 (50Hz) — 배경음악 자동 줄임에 사용 */
function duckCurve(narr, totalSec, depth) {
  const HZ = 50, n = Math.ceil(totalSec * HZ) + 2;
  const d = narr.buffer.getChannelData(0), sr = narr.buffer.sampleRate;
  const raw = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const rel = k / HZ - narr.start;
    if (rel < -0.1 || rel > narr.buffer.duration + 0.1) continue;
    const c = Math.floor(rel * sr), half = Math.floor(sr * 0.05);
    let sum = 0, cnt = 0;
    for (let i = Math.max(0, c - half); i < Math.min(d.length, c + half); i += 8) { sum += d[i] * d[i]; cnt++; }
    raw[k] = cnt && Math.sqrt(sum / cnt) > 0.012 ? 1 : 0; // 말하는 중이면 1
  }
  // 말 사이 짧은 쉼에서 음악이 출렁이지 않도록 0.35초 유지 후 천천히 복귀(release), 빠르게 감소(attack)
  const out = new Float32Array(n);
  let env = 0, hold = 0;
  for (let k = 0; k < n; k++) {
    if (raw[k]) hold = 0.35 * HZ;
    const target = raw[k] || hold > 0 ? 1 : 0;
    hold = Math.max(0, hold - 1);
    env += (target - env) * (target > env ? 0.25 : 0.06);
    out[k] = 1 - depth * env;
  }
  return out;
}

/**
 * @param totalSec  영상 전체 길이(초)
 * @param engine    { buffer, gain } 비행 엔진음 (없으면 null)
 * @param bgm       { buffer, gain, fadeIn, fadeOut, loop } 배경음악
 * @param narr      { buffer, gain, start } 내레이션 (start: 영상 내 시작 시간)
 * @param duck      { on, depth } 내레이션 중 배경음악 줄이기
 * @returns AudioBuffer | null (소리가 하나도 없으면 null)
 */
export async function mixAudio({ totalSec, engine, bgm, narr, duck }) {
  if (!engine && !bgm && !narr) return null;
  const ctx = new OfflineAudioContext(2, Math.ceil(totalSec * SR), SR);
  const bus = ctx.createGain();
  // 합산 후 한 번 더 부드럽게 누르고, 넘치는 피크는 소프트 클리핑 (음악 + 내레이션 + 엔진이 겹쳐도 찌그러지지 않게)
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -8; comp.knee.value = 12; comp.ratio.value = 4; comp.attack.value = 0.005; comp.release.value = 0.2;
  const sat = ctx.createWaveShaper();
  const curve = new Float32Array(2048);
  for (let i = 0; i < 2048; i++) curve[i] = Math.tanh((i / 1023.5 - 1) * 1.15) * 0.97;
  sat.curve = curve;
  bus.connect(comp); comp.connect(sat); sat.connect(ctx.destination);

  const src = (buffer, loop = false) => { const s = ctx.createBufferSource(); s.buffer = buffer; s.loop = loop; return s; };

  if (engine) {
    const g = ctx.createGain(); g.gain.value = engine.gain;
    const s = src(engine.buffer); s.connect(g); g.connect(bus); s.start(0);
  }
  if (bgm) {
    const fade = ctx.createGain();
    const fi = Math.max(0, Math.min(bgm.fadeIn, totalSec / 2)), fo = Math.max(0, Math.min(bgm.fadeOut, totalSec / 2));
    fade.gain.setValueAtTime(fi > 0 ? 0 : bgm.gain, 0);
    if (fi > 0) fade.gain.linearRampToValueAtTime(bgm.gain, fi);
    fade.gain.setValueAtTime(bgm.gain, Math.max(fi, totalSec - fo));
    if (fo > 0) fade.gain.linearRampToValueAtTime(0, totalSec);
    const s = src(bgm.buffer, bgm.loop);
    s.connect(fade);
    if (duck?.on && narr) {
      const dg = ctx.createGain();
      dg.gain.setValueCurveAtTime(duckCurve(narr, totalSec, duck.depth), 0, totalSec);
      fade.connect(dg); dg.connect(bus);
    } else fade.connect(bus);
    s.start(0);
  }
  if (narr) {
    const g = ctx.createGain(); g.gain.value = narr.gain;
    const s = src(narr.buffer); s.connect(g); g.connect(bus);
    if (narr.start < totalSec) s.start(Math.max(0, narr.start));
  }
  return ctx.startRendering();
}
