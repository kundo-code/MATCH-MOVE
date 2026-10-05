// 비행 사운드: 이륙 → 상승 → 순항 → 하강 → 접지·역추력 → 정지까지 엔진음을 합성한다.
// 전부 Web Audio로 만들기 때문에 별도 음원 파일이 필요 없고, 같은 버퍼를 미리보기 재생과 MP4 오디오 트랙에 그대로 쓴다.
// 음량·음높이는 비행 애니메이션(진행률·고도·접지)에 맞춰 자동으로 변한다.

const smoothstep01 = (t) => t * t * (3 - 2 * t);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

export const SAMPLE_RATE = 48000;

/** 비행 진행(p)에서의 엔진 출력(0~1) */
function throttleAt(p) {
  if (p <= 0) return 0.2;                               // 대기: 아이들
  if (p < 0.12) return lerp(0.2, 1, smooth(p / 0.08));  // 이륙 추력
  if (p < 0.5) return lerp(1, 0.72, (p - 0.12) / 0.38); // 상승
  if (p < 0.88) return lerp(0.72, 0.38, (p - 0.5) / 0.38); // 순항 → 하강
  if (p < 0.9) return 0.42;                              // 최종 접근
  const q = (p - 0.9) / 0.1;                             // 접지 이후: 역추력 후 감속
  return 0.1 + 0.85 * Math.exp(-q * 3.2);
}

/** 소음 버퍼 (white / pink / brown) */
function makeNoise(ctx, kind, seconds = 3) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
  if (kind === 'white') for (let i = 0; i < n; i++) d[i] = rnd();
  else if (kind === 'pink') {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
      const w = rnd();
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
    }
  } else {
    let last = 0;
    for (let i = 0; i < n; i++) { last = (last + 0.02 * rnd()) / 1.02; d[i] = last * 3.5; }
  }
  return buf;
}

/** 곡선을 오디오 파라미터에 적용 (샘플링된 값 배열) */
function curve(param, values, start, dur) {
  param.setValueCurveAtTime(Float32Array.from(values), start, dur);
}

/**
 * @param duration   영상 길이(초)
 * @param stateAt    (t01) => { p, altN, touchdown }  — GlobeScene.flightState
 * @returns AudioBuffer (2채널, 48kHz). 음량은 1.0 기준이며 사용자가 따로 곱한다.
 */
export async function renderFlightAudio({ duration, stateAt }) {
  const ctx = new OfflineAudioContext(2, Math.ceil(duration * SAMPLE_RATE), SAMPLE_RATE);
  const RATE = 40; // 초당 자동화 샘플
  const N = Math.max(2, Math.ceil(duration * RATE));
  const sample = (fn) => Array.from({ length: N }, (_, i) => fn(stateAt(Math.min(1, i / (N - 1))), i / (N - 1)));

  const thr = sample((s) => throttleAt(s.p));
  // 카메라(지면)와 가까울수록 크게: 이륙·착륙은 크고 순항은 작게
  const near = sample((s) => lerp(1, 0.5, Math.pow(s.altN, 0.8)));
  const loud = thr.map((v, i) => near[i] * (0.35 + 0.65 * v));

  // 접지 시점(처음으로 touchdown이 참이 되는 지점)
  let tdIndex = -1;
  const states = sample((s) => s);
  states.forEach((s, i) => { if (tdIndex < 0 && s.touchdown && s.p >= 0.85) tdIndex = i; });
  const tdTime = tdIndex >= 0 ? (tdIndex / (N - 1)) * duration : null;

  const master = ctx.createGain();
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14; comp.ratio.value = 5;
  const sat = ctx.createWaveShaper();
  const sc = new Float32Array(2048); for (let i = 0; i < 2048; i++) sc[i] = Math.tanh((i / 1023.5 - 1) * 1.2) * 0.95;
  sat.curve = sc;
  master.connect(comp); comp.connect(sat); sat.connect(ctx.destination);
  // 시작·끝 클릭 방지 페이드
  master.gain.setValueAtTime(0, 0);
  master.gain.linearRampToValueAtTime(0.9, 0.06);
  master.gain.setValueAtTime(0.9, Math.max(0.07, duration - 0.12));
  master.gain.linearRampToValueAtTime(0, duration);

  const loop = (buf) => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.start(0); return s; };
  const white = makeNoise(ctx, 'white'), pink = makeNoise(ctx, 'pink'), brown = makeNoise(ctx, 'brown');

  // 1) 제트 소음 (밴드패스, 출력에 따라 높아짐)
  const jet = ctx.createBiquadFilter(); jet.type = 'bandpass'; jet.Q.value = 0.6;
  const jetGain = ctx.createGain();
  loop(pink).connect(jet); jet.connect(jetGain); jetGain.connect(master);
  curve(jet.frequency, thr.map((v) => 300 + 2200 * Math.pow(v, 1.3)), 0, duration);
  curve(jetGain.gain, thr.map((v, i) => loud[i] * (0.15 + 0.85 * v) * 0.95), 0, duration);

  // 2) 공기 가르는 쉭 소리 (고역)
  const hiss = ctx.createBiquadFilter(); hiss.type = 'highpass'; hiss.frequency.value = 2600;
  const hissGain = ctx.createGain();
  loop(white).connect(hiss); hiss.connect(hissGain); hissGain.connect(master);
  curve(hissGain.gain, thr.map((v, i) => loud[i] * Math.pow(v, 1.6) * 0.16), 0, duration);

  // 3) 저음 럼블
  const rumble = ctx.createBiquadFilter(); rumble.type = 'lowpass'; rumble.frequency.value = 150;
  const rumbleGain = ctx.createGain();
  loop(brown).connect(rumble); rumble.connect(rumbleGain); rumbleGain.connect(master);
  curve(rumbleGain.gain, thr.map((v, i) => loud[i] * (0.25 + 0.75 * v) * 0.9), 0, duration);

  // 4) 터빈 휘파람 (두 개의 발진기)
  for (const [type, mul, g] of [['sawtooth', 1, 0.05], ['triangle', 2.02, 0.035]]) {
    const osc = ctx.createOscillator(); osc.type = type;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 4; f.frequency.value = 1400;
    const og = ctx.createGain();
    osc.connect(f); f.connect(og); og.connect(master);
    curve(osc.frequency, thr.map((v) => (420 + 1700 * Math.pow(v, 1.1)) * mul), 0, duration);
    curve(f.frequency, thr.map((v) => (700 + 2200 * v) * mul), 0, duration);
    curve(og.gain, thr.map((v, i) => loud[i] * Math.pow(v, 2) * g), 0, duration);
    osc.start(0);
  }

  // 5) 접지 후 활주(타이어·바닥 진동): 접지 직후부터 속도가 줄며 사라진다
  if (tdTime !== null) {
    const roll = ctx.createBiquadFilter(); roll.type = 'lowpass'; roll.frequency.value = 320;
    const rollGain = ctx.createGain();
    loop(brown).connect(roll); roll.connect(rollGain); rollGain.connect(master);
    curve(rollGain.gain, states.map((s, i) => {
      if (i < tdIndex) return 0;
      const q = clamp(((i - tdIndex) / (N - 1) * duration) / Math.max(0.3, duration - tdTime), 0, 1);
      return Math.pow(1 - q, 1.4) * 0.8;
    }), 0, duration);

    // 6) 접지: 주바퀴가 활주로에 닿는 소리(충격 + 타이어 마찰 찍 소리 + 연기 같은 스크럽)
    //    → 두 번째 바퀴 쿵 → 앞바퀴 내려앉는 소리 → 활주로 이음매를 지나는 덜컹 소리 → 감속하며 잦아드는 타이어 구름 소리
    const at = (t) => Math.min(t, duration - 0.05);
    const burst = (buf, type, f0, f1, q, t0, dur, peak, atk = 0.006) => {
      if (t0 >= duration - 0.05) return;
      const src = ctx.createBufferSource(); src.buffer = buf;
      const f = ctx.createBiquadFilter(); f.type = type; f.Q.value = q;
      f.frequency.setValueAtTime(f0, t0); f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(peak, t0 + atk); g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      src.connect(f); f.connect(g); g.connect(master); src.start(t0); src.stop(at(t0 + dur + 0.05));
    };
    const thump = (t0, f0, f1, peak, dur) => {
      if (t0 >= duration - 0.05) return;
      const o = ctx.createOscillator(); o.type = 'sine';
      const g = ctx.createGain();
      o.frequency.setValueAtTime(f0, t0); o.frequency.exponentialRampToValueAtTime(f1, t0 + dur * 0.8);
      g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(peak, t0 + 0.008); g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      o.connect(g); g.connect(master); o.start(t0); o.stop(at(t0 + dur + 0.05));
    };
    // 주바퀴 접지
    thump(tdTime, 105, 38, 0.62, 0.5);
    burst(brown, 'lowpass', 220, 90, 0.7, tdTime, 0.55, 0.9);          // 기체가 내려앉는 둔탁한 울림
    burst(white, 'bandpass', 2600, 1100, 1.8, tdTime, 0.32, 0.34, 0.003); // 타이어가 닿는 '찍' 소리
    burst(white, 'bandpass', 900, 500, 1.2, tdTime + 0.02, 0.7, 0.22, 0.02); // 고무가 노면을 긁는 스크럽
    // 타이어 스퀼(짧은 고음 마찰음): 속도가 붙었다가 빠르게 사라진다
    if (tdTime < duration - 0.3) {
      const sq = ctx.createOscillator(); sq.type = 'sawtooth';
      const sf = ctx.createBiquadFilter(); sf.type = 'bandpass'; sf.Q.value = 6;
      const sg = ctx.createGain();
      sq.frequency.setValueAtTime(1150, tdTime); sq.frequency.exponentialRampToValueAtTime(620, tdTime + 0.3);
      sf.frequency.setValueAtTime(1500, tdTime); sf.frequency.exponentialRampToValueAtTime(900, tdTime + 0.3);
      sg.gain.setValueAtTime(0, tdTime); sg.gain.linearRampToValueAtTime(0.09, tdTime + 0.01); sg.gain.exponentialRampToValueAtTime(0.001, tdTime + 0.3);
      sq.connect(sf); sf.connect(sg); sg.connect(master); sq.start(tdTime); sq.stop(at(tdTime + 0.35));
    }
    // 반대쪽 바퀴(살짝 늦게)
    thump(tdTime + 0.1, 92, 40, 0.38, 0.35);
    burst(white, 'bandpass', 2100, 1000, 1.6, tdTime + 0.1, 0.25, 0.2, 0.003);
    // 스포일러·역추력 바람 소리
    burst(white, 'bandpass', 700, 2400, 0.6, tdTime + 0.15, 1.4, 0.16, 0.25);
    // 앞바퀴 접지
    const noseT = tdTime + Math.min(0.95, (duration - tdTime) * 0.5);
    thump(noseT, 72, 34, 0.36, 0.3);
    burst(white, 'bandpass', 1400, 700, 1.4, noseT, 0.18, 0.16, 0.004);
    // 활주로 이음매 덜컹: 간격이 점점 벌어진다(감속)
    let tt = tdTime + 0.35, gapT = 0.075, amp = 0.2;
    while (tt < duration - 0.15 && amp > 0.02) {
      thump(tt, 62, 40, amp, 0.12);
      burst(white, 'lowpass', 700, 300, 0.7, tt, 0.07, amp * 0.5, 0.002);
      tt += gapT; gapT *= 1.1; amp *= 0.93;
    }
    // 타이어 구름 소리(중고역): 속도에 따라 낮아지며 사라진다
    const hum = ctx.createBiquadFilter(); hum.type = 'bandpass'; hum.Q.value = 0.9;
    const humGain = ctx.createGain();
    loop(pink).connect(hum); hum.connect(humGain); humGain.connect(master);
    curve(hum.frequency, states.map((s, i) => {
      const q = clamp((((i - tdIndex) / (N - 1)) * duration) / Math.max(0.3, duration - tdTime), 0, 1);
      return 900 - 500 * q;
    }), 0, duration);
    curve(humGain.gain, states.map((s, i) => {
      if (i < tdIndex) return 0;
      const q = clamp((((i - tdIndex) / (N - 1)) * duration) / Math.max(0.3, duration - tdTime), 0, 1);
      return Math.pow(1 - q, 1.2) * 0.24 * smoothstep01(clamp((q * 6), 0, 1));
    }), 0, duration);
  }

  return ctx.startRendering();
}

/** AudioBuffer에 선형 이득을 곱한 복사본 (MP4에 넣을 때 사용자가 정한 음량 적용) */
export function scaleBuffer(buf, gain) {
  const out = new AudioBuffer({ length: buf.length, numberOfChannels: buf.numberOfChannels, sampleRate: buf.sampleRate });
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const src = buf.getChannelData(c), dst = out.getChannelData(c);
    for (let i = 0; i < src.length; i++) dst[i] = Math.max(-1, Math.min(1, src[i] * gain));
  }
  return out;
}
