// 항공사별 단순화한 로고 마크(스타일화한 벡터). 꼬리날개 텍스처와 상단 항공사 박스에서 같이 쓴다.
// 공식 로고를 그대로 복제한 것이 아니라 색·형태의 특징만 살린 그림이다.

const TAU = Math.PI * 2;

function circle(ctx, x, y, r, fill) { ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fillStyle = fill; ctx.fill(); }
function poly(ctx, pts, fill) { ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); }
function stroke(ctx, w, color, fn) { ctx.save(); ctx.lineWidth = w; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = color; ctx.beginPath(); fn(); ctx.stroke(); ctx.restore(); }
function petals(ctx, x, y, r, n, color, rot = 0, pr = 0.5) {
  for (let i = 0; i < n; i++) {
    const a = rot + (i * TAU) / n;
    circle(ctx, x + Math.cos(a) * r * 0.55, y + Math.sin(a) * r * 0.55, r * pr, color);
  }
}

/**
 * 로고 마크를 (cx, cy)를 중심으로 반지름 r 안에 그린다.
 * @param a 항공사 { id, accent, tail, body }
 */
export function drawLogoMark(ctx, a, cx, cy, r) {
  ctx.save();
  ctx.translate(cx, cy);
  const W = '#ffffff';
  switch (a.id) {
    case 'KE': { // 태극
      ctx.rotate(-0.55);
      circle(ctx, 0, 0, r, '#1c4a9c');
      ctx.beginPath(); ctx.arc(0, 0, r, Math.PI, 0); ctx.fillStyle = '#e0362c'; ctx.fill();
      circle(ctx, -r / 2, 0, r / 2, '#e0362c'); circle(ctx, r / 2, 0, r / 2, '#1c4a9c');
      break;
    }
    case 'OZ': { // 컬러 블록 원
      circle(ctx, 0, 0, r, '#d0202e');
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, r, 0.2, 2.1); ctx.closePath(); ctx.fillStyle = '#5b2b94'; ctx.fill();
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, r, 2.1, 3.6); ctx.closePath(); ctx.fillStyle = '#f5b800'; ctx.fill();
      circle(ctx, 0, 0, r * 0.34, W);
      break;
    }
    case '7C': { // 주황 원 + 물결
      circle(ctx, 0, 0, r, '#ff5a14');
      stroke(ctx, r * 0.16, W, () => { for (let k = -1; k <= 1; k++) { ctx.moveTo(-r * 0.62, k * r * 0.3); ctx.bezierCurveTo(-r * 0.3, k * r * 0.3 - r * 0.2, r * 0.3, k * r * 0.3 + r * 0.2, r * 0.62, k * r * 0.3); } });
      break;
    }
    case 'LJ': { // 초록·보라 사선
      circle(ctx, 0, 0, r, '#6cc24a');
      ctx.save(); ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.clip();
      poly(ctx, [[-r, r * 0.1], [r, -r * 0.5], [r, r], [-r, r]], '#5b2a86'); ctx.restore();
      stroke(ctx, r * 0.14, W, () => { ctx.moveTo(-r * 0.5, r * 0.05); ctx.lineTo(r * 0.5, -r * 0.35); });
      break;
    }
    case 'TW': { // 빨간 원 + t
      circle(ctx, 0, 0, r, '#e8161b');
      stroke(ctx, r * 0.2, W, () => { ctx.moveTo(0, -r * 0.55); ctx.lineTo(0, r * 0.45); ctx.moveTo(-r * 0.32, -r * 0.2); ctx.lineTo(r * 0.34, -r * 0.2); });
      break;
    }
    case 'BX': { // 파란 원 + 새
      circle(ctx, 0, 0, r, '#0a56a6');
      poly(ctx, [[-r * 0.7, r * 0.15], [-r * 0.1, -r * 0.55], [r * 0.2, -r * 0.1], [r * 0.7, -r * 0.35], [r * 0.15, r * 0.35], [-r * 0.2, r * 0.1]], W);
      circle(ctx, r * 0.1, -r * 0.05, r * 0.12, '#e0362c');
      break;
    }
    case 'RS': { // 초록 육각
      poly(ctx, [0, 1, 2, 3, 4, 5].map((i) => [Math.cos(i * TAU / 6 + 0.52) * r, Math.sin(i * TAU / 6 + 0.52) * r]), '#27a85a');
      stroke(ctx, r * 0.18, W, () => { ctx.moveTo(r * 0.4, -r * 0.35); ctx.bezierCurveTo(-r * 0.5, -r * 0.55, -r * 0.5, 0, 0, 0); ctx.bezierCurveTo(r * 0.5, 0, r * 0.5, r * 0.55, -r * 0.4, r * 0.35); });
      break;
    }
    case 'ZE': { // 빨간 별
      const pts = []; for (let i = 0; i < 10; i++) { const rr = i % 2 ? r * 0.45 : r; pts.push([Math.cos(-Math.PI / 2 + i * Math.PI / 5) * rr, Math.sin(-Math.PI / 2 + i * Math.PI / 5) * rr]); }
      poly(ctx, pts, '#e4002b');
      break;
    }
    case 'YP': { // 금색 링 + P
      circle(ctx, 0, 0, r, '#c9a45c'); circle(ctx, 0, 0, r * 0.82, '#2b2f6b');
      stroke(ctx, r * 0.16, '#c9a45c', () => { ctx.moveTo(-r * 0.2, r * 0.5); ctx.lineTo(-r * 0.2, -r * 0.5); ctx.arc(r * 0.05, -r * 0.2, r * 0.3, -Math.PI / 2, Math.PI / 2); ctx.lineTo(-r * 0.2, r * 0.1); });
      break;
    }
    case 'JL': { // 붉은 원 + 흰 날개선
      circle(ctx, 0, 0, r, '#d7001e');
      stroke(ctx, r * 0.16, W, () => { ctx.moveTo(-r * 0.6, r * 0.25); ctx.quadraticCurveTo(-r * 0.1, -r * 0.7, r * 0.6, -r * 0.35); });
      circle(ctx, r * 0.05, r * 0.3, r * 0.2, W);
      break;
    }
    case 'NH': { // 파란 원 + 흰 ANA
      circle(ctx, 0, 0, r, '#1b3f94');
      ctx.fillStyle = W; ctx.font = `900 ${r * 0.78}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('ANA', 0, 0);
      break;
    }
    case 'CX': { // 브러시 윙
      poly(ctx, [[-r, r * 0.3], [-r * 0.2, -r * 0.6], [r * 0.9, -r * 0.8], [r * 0.2, -r * 0.2], [r, r * 0.1], [-r * 0.1, r * 0.1], [r * 0.5, r * 0.7], [-r * 0.5, r * 0.55]], '#00645a');
      break;
    }
    case 'CA': { // 붉은 원 + 봉황 곡선
      circle(ctx, 0, 0, r, '#d71920');
      stroke(ctx, r * 0.16, W, () => { ctx.moveTo(-r * 0.6, r * 0.3); ctx.bezierCurveTo(-r * 0.4, -r * 0.7, r * 0.5, -r * 0.7, r * 0.6, -r * 0.2); ctx.bezierCurveTo(r * 0.2, -r * 0.1, -r * 0.1, r * 0.2, r * 0.2, r * 0.6); });
      break;
    }
    case 'MU': { // 파란 제비 + 빨간 점
      circle(ctx, 0, 0, r, '#1f3f9a');
      poly(ctx, [[-r * 0.8, -r * 0.1], [-r * 0.1, -r * 0.5], [r * 0.8, -r * 0.35], [r * 0.2, -r * 0.05], [r * 0.7, r * 0.45], [-r * 0.1, r * 0.1]], W);
      circle(ctx, r * 0.55, -r * 0.55, r * 0.14, '#e0362c');
      break;
    }
    case 'CI': { // 매화 5엽
      petals(ctx, 0, 0, r, 5, '#c4002f', -Math.PI / 2, 0.42);
      circle(ctx, 0, 0, r * 0.28, '#f5b800');
      break;
    }
    case 'BR': { // 초록 원 + 줄무늬
      circle(ctx, 0, 0, r, '#0f7a3c');
      for (let k = -1; k <= 1; k++) ctx.fillStyle = k === 0 ? '#f5b800' : W, ctx.fillRect(-r * 0.62, k * r * 0.3 - r * 0.07, r * 1.24, r * 0.14);
      break;
    }
    case 'SQ': { // 금색 새
      circle(ctx, 0, 0, r, '#1c2b6b');
      poly(ctx, [[-r * 0.85, r * 0.2], [-r * 0.1, -r * 0.55], [r * 0.15, -r * 0.2], [r * 0.85, -r * 0.5], [r * 0.2, r * 0.15], [r * 0.5, r * 0.6], [-r * 0.1, r * 0.2]], '#f0a30a');
      break;
    }
    case 'TG': { // 보라 난초
      petals(ctx, 0, 0, r, 5, '#8a4fc0', -Math.PI / 2, 0.4);
      circle(ctx, 0, 0, r * 0.3, '#e8c3f5');
      break;
    }
    case 'VN': { // 금빛 연꽃
      circle(ctx, 0, 0, r, '#0a5b9b');
      for (const a of [-0.9, -0.45, 0, 0.45, 0.9]) {
        ctx.save(); ctx.rotate(a); poly(ctx, [[0, r * 0.55], [-r * 0.2, -r * 0.1], [0, -r * 0.7], [r * 0.2, -r * 0.1]], '#e5a823'); ctx.restore();
      }
      break;
    }
    case 'VJ': { // 빨강·노랑 그라디언트 원
      const g = ctx.createLinearGradient(-r, 0, r, 0); g.addColorStop(0, '#e8161b'); g.addColorStop(1, '#ffd400');
      circle(ctx, 0, 0, r, g);
      stroke(ctx, r * 0.18, W, () => { ctx.moveTo(-r * 0.5, -r * 0.1); ctx.lineTo(0, r * 0.45); ctx.lineTo(r * 0.55, -r * 0.45); });
      break;
    }
    case 'PR': { // 파랑·빨강·노랑 삼색
      circle(ctx, 0, 0, r, '#0a2d78');
      ctx.save(); ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.clip();
      poly(ctx, [[-r, 0], [r, -r * 0.6], [r, r * 0.1], [-r, r * 0.7]], '#d52b1e');
      poly(ctx, [[-r, r * 0.45], [r, -r * 0.1], [r, r * 0.35], [-r, r * 0.9]], '#f5c400'); ctx.restore();
      break;
    }
    case 'MH': { // 윙 카이트
      poly(ctx, [[-r, r * 0.1], [-r * 0.1, -r * 0.8], [r * 0.9, -r * 0.2], [r * 0.1, -r * 0.05]], '#d8232f');
      poly(ctx, [[-r * 0.6, r * 0.2], [r * 0.2, r * 0.05], [r * 0.95, r * 0.35], [-r * 0.1, r * 0.85]], '#2441a8');
      break;
    }
    case 'ID': { // 바틱 마름모
      circle(ctx, 0, 0, r, '#d6193e');
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        ctx.save(); ctx.translate(i * r * 0.46, j * r * 0.46); ctx.rotate(Math.PI / 4); ctx.fillStyle = (i + j) % 2 ? '#f2b705' : W; ctx.fillRect(-r * 0.11, -r * 0.11, r * 0.22, r * 0.22); ctx.restore();
      }
      break;
    }
    case 'GA': { // 가루다 날개
      for (const sx of [-1, 1]) {
        ctx.save(); ctx.scale(sx, 1);
        poly(ctx, [[r * 0.08, -r * 0.7], [r, -r * 0.45], [r * 0.7, -r * 0.1], [r * 0.95, r * 0.2], [r * 0.5, r * 0.25], [r * 0.6, r * 0.6], [r * 0.08, r * 0.1]], '#00a3ad');
        ctx.restore();
      }
      circle(ctx, 0, -r * 0.05, r * 0.16, '#0a5b6b');
      break;
    }
    case 'AK': { // 빨간 원 + a
      circle(ctx, 0, 0, r, '#e4002b');
      stroke(ctx, r * 0.2, W, () => { ctx.arc(-r * 0.05, r * 0.05, r * 0.38, 0, TAU); ctx.moveTo(r * 0.33, -r * 0.35); ctx.lineTo(r * 0.33, r * 0.45); });
      break;
    }
    default: {
      circle(ctx, 0, 0, r, a.accent || a.tail);
      stroke(ctx, r * 0.16, W, () => { ctx.moveTo(-r * 0.5, r * 0.2); ctx.quadraticCurveTo(0, -r * 0.7, r * 0.5, r * 0.1); });
    }
  }
  ctx.restore();
}

// ── 실제 항공사 엠블럼 이미지 (public/logos/<항공사코드>.png) ─────────────────────────
// 사용자가 제공한 엠블럼 모음에서 항공사별로 잘라 낸 이미지. 있는 항공사는 상단 항공 정보 박스에 이 이미지를 쓰고,
// 없는 항공사는 위의 스타일화한 벡터 마크(drawLogoMark)로 대신한다.
const EMBLEM_IDS = ['KE', '7C', 'NH', 'CX', 'CA', 'MU', 'CI', 'TG', 'VN', 'VJ', 'PR', 'MH', 'GA', 'AK'];
// 배경이 색으로 꽉 찬 사각형 로고(투명 배경이 아님): 둥근 모서리로 그린다. 나머지는 흰 둥근 배지 위에 얹는다.
const TILE_EMBLEMS = new Set(['7C', 'NH', 'VJ', 'VN']);
const EMBLEM_IMG = {};

/** 엠블럼 이미지를 불러온다. 저장 전에 await 해서 모두 준비되게 한다 */
export function preloadEmblems(base = 'logos/') {
  return Promise.all(EMBLEM_IDS.map((id) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => { EMBLEM_IMG[id] = img; resolve(); };
    img.onerror = () => resolve(); // 파일이 없으면 벡터 마크로 대체
    img.src = `${base}${id}.png`;
  })));
}

/** 높이 h 기준 엠블럼 칸의 크기 {w,h}. 이미지가 없으면 null */
export function emblemSize(a, h) {
  const img = EMBLEM_IMG[a.id];
  if (!img) return null;
  const aspect = img.width / img.height;
  const pad = TILE_EMBLEMS.has(a.id) ? 0 : h * 0.14;
  // 글자형(가로로 긴) 로고는 높이를 줄이고 폭을 넓힌다 (최대 폭 = 높이의 2.6배)
  const inner = Math.min(h - pad * 2, (h * 2.6 - pad * 2) / aspect);
  return { w: inner * aspect + pad * 2, h: inner + pad * 2, inner, aspect, pad };
}

/** 엠블럼을 (cx, cy)를 중심으로 그린다. 그린 폭을 반환(없으면 0) */
export function drawEmblem(ctx, a, cx, cy, h) {
  const img = EMBLEM_IMG[a.id], s = emblemSize(a, h);
  if (!img || !s) return 0;
  const x = cx - s.w / 2, y = cy - s.h / 2;
  ctx.save();
  const rr = Math.min(s.h * 0.2, 14);
  if (TILE_EMBLEMS.has(a.id)) {
    ctx.beginPath(); ctx.roundRect(x, y, s.w, s.h, rr); ctx.clip();
    ctx.drawImage(img, x, y, s.w, s.h);
  } else {
    ctx.beginPath(); ctx.roundRect(x, y, s.w, s.h, rr);
    ctx.fillStyle = 'rgba(255,255,255,0.94)'; ctx.fill();
    ctx.drawImage(img, x + s.pad, y + s.pad, s.w - s.pad * 2, s.h - s.pad * 2);
  }
  ctx.restore();
  return s.w;
}
