// 항공사별 도색(동체·꼬리 텍스처). 첨부된 기체 사진을 참고해 주요 항공사는 개별 디자인, 나머지는 항공사 색으로 자동 생성한다.
// 동체 캔버스: 가로 = 꼬리(0) → 기수(1), 세로 = 위(0) → 오른쪽 면(.25) → 배(.5) → 왼쪽 면(.75) → 위(1)

const FONT = "'Noto Sans KR','Helvetica Neue',Arial,sans-serif";

const luminance = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
};

/** 양 옆면을 같은 코드로 그리기 위한 좌표 변환. px(s): 몸통 비율(0 꼬리~1 기수) → 캔버스 x */
function eachSide(ctx, W, H, fn) {
  for (const side of ['starboard', 'port']) {
    ctx.save();
    if (side === 'starboard') ctx.setTransform(-1, 0, 0, 1, W, 0);
    else ctx.setTransform(1, 0, 0, -1, 0, H);
    const px = side === 'starboard' ? (s) => (1 - s) * W : (s) => s * W;
    fn({ ctx, px, W, H, side });
    ctx.restore();
  }
}

function poly(ctx, pts, color) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function taegeuk(ctx, cx, cy, r, rot = -0.55) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  const circle = (x, y, rr, c) => { ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2); ctx.fillStyle = c; ctx.fill(); };
  circle(0, 0, r, '#1c4a9c');
  ctx.beginPath(); ctx.arc(0, 0, r, Math.PI, 0); ctx.fillStyle = '#e0362c'; ctx.fill();
  circle(-r / 2, 0, r / 2, '#e0362c');
  circle(r / 2, 0, r / 2, '#1c4a9c');
  ctx.restore();
}

function drawText(ctx, str, x, y, size, color, { weight = 800, italic = true, spacing = 0 } = {}) {
  ctx.font = `${italic ? 'italic ' : ''}${weight} ${size}px ${FONT}`;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${spacing}px`;
  ctx.fillText(str, x, y);
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
}

/** 도색 사양 */
export function liveryFor(airline) {
  const dark = luminance(airline.body) < 0.45;
  const base = {
    top: airline.body, belly: dark ? airline.body : '#e3e7ec', split: 0.3,
    text: airline.en, textColor: dark ? '#ffffff' : airline.accent, textSize: 64, textS: 0.74,
    engineTop: '#d3d8df', engineBottom: '#d3d8df', winglet: airline.accent, tail: airline.tail, wing: '#aeb6c1',
    kind: 'generic', airline,
  };
  switch (airline.id) {
    case 'KE': return { ...base, top: '#86cdf0', belly: '#e6ebf0', split: 0.31, text: 'KOREAN AIR', textColor: '#1c3f94', textSize: 78, textS: 0.7, winglet: '#6cc3ec', tail: '#86cdf0', kind: 'KE' };
    case 'OZ': return { ...base, top: '#f6f7f9', belly: '#d9dce1', split: 0.34, text: 'ASIANA AIRLINES', textColor: '#59606b', textSize: 58, textS: 0.7, winglet: '#f2a900', kind: 'OZ' };
    case '7C': return { ...base, top: '#fbfbfb', belly: '#ff5a14', split: 0.36, text: 'JEJUair', textColor: '#ff5a14', textSize: 100, textS: 0.7, engineBottom: '#ff5a14', winglet: '#ff5a14', tail: '#ff6a1f', kind: '7C' };
    case 'MH': return { ...base, top: '#f7f8fa', belly: '#e7eaef', split: 0.34, text: 'malaysia airlines', textColor: '#1b3f94', textSize: 62, textS: 0.72, winglet: '#1b3f94', kind: 'MH' };
    case 'ID': return { ...base, top: '#fcfcfc', belly: '#e9ecef', split: 0.34, text: 'Batik', textColor: '#d6193e', textSize: 96, textS: 0.78, engineTop: '#d6193e', engineBottom: '#d6193e', winglet: '#d6193e', tail: '#d6193e', kind: 'ID' };
    default: return base;
  }
}

function windows(ctx, px, H) {
  ctx.fillStyle = '#26364a';
  for (let s = 0.17; s < 0.87; s += 0.0068) {
    if (Math.abs(s - 0.58) < 0.012 || Math.abs(s - 0.33) < 0.012) continue; // 도어 자리
    const x = px(s);
    ctx.beginPath();
    ctx.roundRect(x - 3.5, 0.2 * H - 5, 7, 10, 3);
    ctx.fill();
  }
  // 조종석 창
  ctx.fillStyle = '#1b2736';
  poly(ctx, [[px(0.955), 0.085 * H], [px(0.985), 0.11 * H], [px(0.985), 0.14 * H], [px(0.957), 0.125 * H]], '#1b2736');
  ctx.fillStyle = '#26364a';
}

export function paintFuselage(livery) {
  const W = 2048, H = 512;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = livery.top;
  ctx.fillRect(0, 0, W, H);
  // 배(아랫면)
  const y0 = livery.split * H, y1 = (1 - livery.split) * H;
  ctx.fillStyle = livery.belly;
  if (livery.kind === '7C') {
    // 제주항공: 물결 모양 경계의 주황 하단 + 기수 쪽에서 위로 올라오는 주황
    ctx.beginPath();
    ctx.moveTo(0, y0);
    for (let x = 0; x <= W; x += 16) ctx.lineTo(x, y0 - Math.pow(x / W, 3) * 0.1 * H);
    ctx.lineTo(W, y1 + 0.1 * H);
    for (let x = W; x >= 0; x -= 16) ctx.lineTo(x, y1 + Math.pow(x / W, 3) * 0.1 * H);
    ctx.closePath();
    ctx.fill();
  } else {
    const g = ctx.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, livery.belly); g.addColorStop(0.5, livery.belly); g.addColorStop(1, livery.belly);
    ctx.fillStyle = g;
    ctx.fillRect(0, y0, W, y1 - y0);
    // 윗면과 배의 경계를 살짝 부드럽게
    for (const [ya, yb] of [[y0 - 6, y0 + 6], [y1 - 6, y1 + 6]]) {
      const gg = ctx.createLinearGradient(0, ya, 0, yb);
      gg.addColorStop(0, ya < H / 2 ? livery.top : livery.belly);
      gg.addColorStop(1, ya < H / 2 ? livery.belly : livery.top);
      ctx.fillStyle = gg;
      ctx.fillRect(0, ya, W, yb - ya);
    }
  }

  eachSide(ctx, W, H, ({ ctx, px, W, H }) => {
    // 항공사별 꼬리 쪽 장식
    if (livery.kind === 'OZ') {
      poly(ctx, [[px(0), 0.04 * H], [px(0.16), 0.04 * H], [px(0.04), 0.3 * H]], '#f5b800');
      poly(ctx, [[px(0), 0.28 * H], [px(0.2), 0.12 * H], [px(0.36), 0.33 * H], [px(0.3), 0.5 * H], [px(0), 0.5 * H]], '#d0202e');
      poly(ctx, [[px(0), 0.36 * H], [px(0.12), 0.31 * H], [px(0.26), 0.5 * H], [px(0), 0.5 * H]], '#5b2b94');
      poly(ctx, [[px(0.2), 0.12 * H], [px(0.4), 0.2 * H], [px(0.5), 0.5 * H], [px(0.36), 0.5 * H], [px(0.36), 0.33 * H]], '#b9bcc2');
      // 기수 쪽 붉은 'A' 마크
      poly(ctx, [[px(0.905), 0.015 * H], [px(0.975), 0.015 * H], [px(0.94), 0.12 * H], [px(0.928), 0.07 * H], [px(0.89), 0.095 * H]], '#ee2d3a');
    }
    if (livery.kind === 'MH') {
      poly(ctx, [[px(0), 0.1 * H], [px(0.2), 0.1 * H], [px(0.34), 0.34 * H], [px(0.28), 0.5 * H], [px(0), 0.5 * H]], '#2441a8');
      for (let k = 0; k < 4; k++) {
        poly(ctx, [[px(0.04 + k * 0.07), 0.5 * H], [px(0.2 + k * 0.07), 0.2 * H], [px(0.215 + k * 0.07), 0.2 * H], [px(0.075 + k * 0.07), 0.5 * H]], k % 2 ? '#f4f4f6' : '#d8232f');
      }
      ctx.fillStyle = '#f5c400';
      ctx.beginPath(); ctx.arc(px(0.12), 0.2 * H, 38, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#2441a8';
      ctx.beginPath(); ctx.arc(px(0.12) + 12, 0.2 * H, 33, 0, Math.PI * 2); ctx.fill();
      // 오른쪽 위 국기 느낌의 작은 직사각형
      ctx.fillStyle = '#d8232f'; ctx.fillRect(px(0.935) - 28, 0.075 * H - 14, 56, 28);
      ctx.fillStyle = '#fff'; for (let i = 0; i < 3; i++) ctx.fillRect(px(0.935) - 28, 0.075 * H - 14 + 6 + i * 8, 56, 3);
    }
    if (livery.kind === 'ID') {
      poly(ctx, [[px(0), 0.12 * H], [px(0.26), 0.3 * H], [px(0.32), 0.5 * H], [px(0), 0.5 * H]], '#d6193e');
      poly(ctx, [[px(0), 0.34 * H], [px(0.22), 0.4 * H], [px(0.28), 0.5 * H], [px(0), 0.5 * H]], '#1a2f7a');
      ctx.fillStyle = '#f2b705';
      for (let k = 0; k < 6; k++) { ctx.fillRect(px(0.04 + k * 0.035) - 9, 0.42 * H, 18, 18); }
    }
    windows(ctx, px, H);
    drawText(ctx, livery.text, px(livery.textS), 0.115 * H, livery.textSize, livery.textColor,
      { weight: livery.kind === 'OZ' ? 700 : 800, italic: livery.kind !== 'OZ', spacing: livery.kind === 'OZ' ? 2 : 0 });
  });
  return c;
}

/** 꼬리날개(수직안정판) 텍스처. 앞전이 왼쪽, 아래가 동체 쪽 */
export function paintTail(livery) {
  const W = 512, H = 640;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = livery.tail;
  ctx.fillRect(0, 0, W, H);
  switch (livery.kind) {
    case 'KE':
      taegeuk(ctx, W * 0.46, H * 0.66, W * 0.26);
      break;
    case 'OZ':
      poly(ctx, [[0, 0], [W * 0.55, 0], [0, H * 0.55]], '#a9a79f');
      poly(ctx, [[0, H * 0.18], [W * 0.5, 0], [W * 0.2, H * 0.62], [0, H * 0.7]], '#f5b800');
      poly(ctx, [[W * 0.5, 0], [W, 0], [W, H * 0.8], [W * 0.2, H * 0.62]], '#d0202e');
      poly(ctx, [[0, H * 0.62], [W * 0.2, H * 0.62], [W, H * 0.8], [W, H], [0, H]], '#2a3f9a');
      poly(ctx, [[W * 0.45, H * 0.75], [W, H * 0.8], [W, H], [W * 0.3, H]], '#5b2b94');
      break;
    case '7C': {
      ctx.fillStyle = '#ff8a3a';
      for (let k = 0; k < 3; k++) {
        ctx.beginPath(); ctx.moveTo(0, H * (0.2 + k * 0.16));
        for (let x = 0; x <= W; x += 16) ctx.lineTo(x, H * (0.2 + k * 0.16) + Math.sin(x / 70 + k) * 26);
        ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
        ctx.fillStyle = ['#ff7a28', '#ff8f3f', '#ffa05a'][k]; ctx.fill();
      }
      ctx.fillStyle = '#2aa8e8';
      ctx.beginPath(); ctx.arc(W * 0.14, H * 0.74, W * 0.14, Math.PI, 0); ctx.fill();
      drawText(ctx, 'JEJUair', W * 0.5, H * 0.86, 78, '#ffffff');
      break;
    }
    case 'MH': {
      ctx.fillStyle = '#f7f8fa'; ctx.fillRect(0, 0, W, H);
      // 윙 로고: 붉은 윗날개 + 푸른 아랫날개
      poly(ctx, [[W * 0.1, H * 0.5], [W * 0.5, H * 0.34], [W * 0.92, H * 0.5], [W * 0.62, H * 0.52], [W * 0.3, H * 0.58]], '#d8232f');
      poly(ctx, [[W * 0.2, H * 0.6], [W * 0.62, H * 0.56], [W * 0.84, H * 0.74], [W * 0.5, H * 0.92], [W * 0.38, H * 0.78]], '#2441a8');
      break;
    }
    case 'ID': {
      ctx.fillStyle = '#d6193e'; ctx.fillRect(0, 0, W, H);
      for (let r = 0; r < 8; r++) for (let q = 0; q < 6; q++) {
        const cx = q * 100 + (r % 2) * 50 + 10, cy = r * 88 + 20;
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(Math.PI / 4);
        ctx.fillStyle = '#1f3a8a'; ctx.fillRect(-30, -30, 60, 60);
        ctx.fillStyle = '#f2b705'; ctx.fillRect(-12, -12, 24, 24);
        ctx.restore();
      }
      break;
    }
    default: {
      ctx.fillStyle = 'rgba(255,255,255,0.16)';
      poly(ctx, [[0, H * 0.7], [W, H * 0.3], [W, H * 0.5], [0, H * 0.9]], 'rgba(255,255,255,0.18)');
      drawText(ctx, livery.airline.id, W * 0.5, H * 0.62, 150, luminance(livery.tail) < 0.6 ? '#ffffff' : '#222', { weight: 900, italic: true });
    }
  }
  return c;
}

export function paintFan() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 6, 64, 64, 64);
  g.addColorStop(0, '#9aa0a8'); g.addColorStop(0.18, '#2c3138'); g.addColorStop(1, '#0c0e11');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
  ctx.strokeStyle = 'rgba(180,188,198,0.5)';
  ctx.lineWidth = 3;
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(64 + Math.cos(a) * 14, 64 + Math.sin(a) * 14);
    ctx.quadraticCurveTo(64 + Math.cos(a + 0.35) * 40, 64 + Math.sin(a + 0.35) * 40, 64 + Math.cos(a + 0.5) * 62, 64 + Math.sin(a + 0.5) * 62);
    ctx.stroke();
  }
  return c;
}

export function paintShadow() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  // 위에서 본 기체 실루엣 (기수가 위)
  poly(ctx, [[60, 6], [68, 6], [70, 40], [122, 84], [122, 92], [70, 80], [68, 108], [86, 120], [86, 126], [42, 126], [42, 120], [60, 108], [58, 80], [6, 92], [6, 84], [58, 40]], '#000');
  return c;
}

/**
 * 주날개 윗면 텍스처: 슬랫(앞전), 플랩, 에일러론, 스포일러, 패널 라인으로 조종면 디테일을 표현한다.
 * 가로 = 날개 뿌리(0) → 끝(1), 세로 = 앞전(위) → 뒷전(아래). 평면 형상(plan)에 맞춰 앞전·뒷전 곡선을 따라 그린다.
 */
export function paintWing() {
  const W = 1024, H = 512;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  // 날개 평면 형상: 앞전/뒷전의 세로 위치(0=위 … 1=아래)를 u(뿌리→끝)의 함수로
  const yLE = (u) => 0.836 * u;
  const yTE = (u) => 0.746 + 0.254 * u;
  const P = (u, k) => [u * W, (yLE(u) + k * (yTE(u) - yLE(u))) * H]; // k: 0=앞전 … 1=뒷전

  const base = ctx.createLinearGradient(0, 0, W, 0);
  base.addColorStop(0, '#9aa3af');
  base.addColorStop(0.55, '#8b94a1');
  base.addColorStop(1, '#76808d');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, W, H);

  const strip = (u0, u1, k0, k1, color) => {
    ctx.beginPath();
    const a = P(u0, k0), b = P(u1, k0), d = P(u1, k1), e = P(u0, k1);
    ctx.moveTo(...a); ctx.lineTo(...b); ctx.lineTo(...d); ctx.lineTo(...e); ctx.closePath();
    ctx.fillStyle = color; ctx.fill();
  };
  const line = (u0, k0, u1, k1, alpha = 0.6, w = 2.2) => {
    ctx.beginPath(); ctx.moveTo(...P(u0, k0)); ctx.lineTo(...P(u1, k1));
    ctx.strokeStyle = `rgba(36,44,56,${alpha})`; ctx.lineWidth = w; ctx.stroke();
  };

  // 앞전 슬랫: 한 단계 어두운 띠 + 구획선
  strip(0.03, 0.99, 0, 0.09, '#6c7581');
  for (let u = 0.1; u < 0.99; u += 0.095) line(u, 0, u, 0.09, 0.5);
  line(0.03, 0.09, 0.99, 0.09, 0.55);
  // 내측 플랩(뒷전 38%): 구획선 + 플랩 트랙 페어링
  strip(0.05, 0.56, 0.62, 1, '#a0a8b4');
  for (const u of [0.05, 0.2, 0.34, 0.46, 0.56]) line(u, 0.62, u, 1, 0.65, 2.6);
  line(0.05, 0.62, 0.56, 0.62, 0.55);
  ctx.fillStyle = 'rgba(70,78,90,0.55)';
  for (const u of [0.13, 0.27, 0.4, 0.51]) { const [x, y] = P(u, 0.96); ctx.beginPath(); ctx.ellipse(x, y, 16, 7, 0.1, 0, Math.PI * 2); ctx.fill(); }
  // 에일러론(외측 뒷전)
  strip(0.62, 0.93, 0.66, 1, '#7d8693');
  line(0.62, 0.66, 0.62, 1, 0.65, 2.6); line(0.93, 0.66, 0.93, 1, 0.65, 2.6); line(0.62, 0.66, 0.93, 0.66, 0.55);
  // 스포일러 패널
  for (let i = 0; i < 6; i++) {
    const u0 = 0.1 + i * 0.085, u1 = u0 + 0.075;
    ctx.beginPath();
    ctx.moveTo(...P(u0, 0.46)); ctx.lineTo(...P(u1, 0.46)); ctx.lineTo(...P(u1, 0.62)); ctx.lineTo(...P(u0, 0.62)); ctx.closePath();
    ctx.fillStyle = 'rgba(70,78,90,0.3)'; ctx.fill();
    ctx.strokeStyle = 'rgba(36,44,56,0.5)'; ctx.lineWidth = 1.6; ctx.stroke();
  }
  // 연료탱크 점검 패널
  ctx.strokeStyle = 'rgba(36,44,56,0.28)'; ctx.lineWidth = 1.4;
  for (let u = 0.08; u < 0.95; u += 0.06) line(u, 0.15, u, 0.44, 0.22, 1.2);
  line(0.04, 0.3, 0.96, 0.3, 0.2, 1.2);
  // 날개 끝은 조금 더 어둡게 (끝단 페어링)
  const tip = ctx.createLinearGradient(W * 0.9, 0, W, 0);
  tip.addColorStop(0, 'rgba(60,68,80,0)'); tip.addColorStop(1, 'rgba(60,68,80,0.35)');
  ctx.fillStyle = tip; ctx.fillRect(W * 0.9, 0, W * 0.1, H);
  return c;
}
