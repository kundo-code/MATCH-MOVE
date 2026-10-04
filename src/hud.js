// 2D 캔버스에 그리는 정보 오버레이. 미리보기와 영상/이미지 출력에 같은 함수를 쓴다.
import { formatDuration } from './flight.js';
import { IMAGERY_ATTRIBUTION } from './satellite.js';

export const FONT = "'Noto Sans KR','Pretendard','Apple SD Gothic Neo','Malgun Gothic',system-ui,sans-serif";
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h);
}

function glass(ctx, x, y, w, h, r, alpha = 0.6) {
  roundRect(ctx, x, y, w, h, r);
  ctx.fillStyle = `rgba(8,14,28,${alpha})`;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.stroke();
}

function text(ctx, str, x, y, { size, weight = 500, color = '#fff', align = 'left', baseline = 'alphabetic', shadow = 0 }) {
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  if (shadow) { ctx.shadowColor = 'rgba(0,0,0,0.85)'; ctx.shadowBlur = shadow; }
  ctx.fillStyle = color;
  ctx.fillText(str, x, y);
  ctx.shadowBlur = 0;
}

/** 폭을 넘으면 말줄임 */
function fit(ctx, str, maxW) {
  if (ctx.measureText(str).width <= maxW) return str;
  while (str.length > 1 && ctx.measureText(str + '…').width > maxW) str = str.slice(0, -1);
  return str + '…';
}

function countryLabels(ctx, info, u, route) {
  const taken = [];
  const items = info.countries
    .filter((c) => route.has(c.code) || c.rank <= 3 || info.dist < 0.9)
    .sort((a, b) => (route.has(b.code) - route.has(a.code)) || a.rank - b.rank);
  const fade = smooth((info.dist - 0.12) / 0.25) * smooth((3.4 - info.dist) / 1.0);
  for (const c of items) {
    const far = smooth((info.dist - 0.35) / 0.8); // 최대 줌아웃에 가까울수록 1
    const size = (route.has(c.code) ? 21 : 17) * 0.85 * (1 - 0.2 * far) * u;
    ctx.font = `700 ${size}px ${FONT}`;
    const w = ctx.measureText(c.ko).width, h = size;
    const box = [c.x - w / 2 - 6 * u, c.y - h / 2 - 4 * u, w + 12 * u, h + 8 * u];
    if (taken.some((t) => box[0] < t[0] + t[2] && box[0] + box[2] > t[0] && box[1] < t[1] + t[3] && box[1] + box[3] > t[1])) continue;
    taken.push(box);
    ctx.globalAlpha = fade * (route.has(c.code) ? 0.95 : 0.7);
    text(ctx, c.ko, c.x, c.y, { size, weight: 700, align: 'center', baseline: 'middle', shadow: 6 * u });
  }
  ctx.globalAlpha = 1;
}

/** 지점 위로 수직선을 올리고 그 끝에 정보박스를 중앙정렬로 배치. 박스·글자 모두 0.8배 */
function callout(ctx, pt, u, { maxY, gap = 8, color, tag, name, sub, big = 1, alpha = 1, scale = 1 }) {
  if (!pt.visible || alpha <= 0.01) return;
  const k = 0.8 * big * scale;
  ctx.save();
  ctx.globalAlpha = alpha;
  const nameSize = 28 * u * k, subSize = 19 * u * k, tagSize = 17 * u * k;
  ctx.font = `700 ${nameSize}px ${FONT}`;
  const wName = ctx.measureText(name).width;
  ctx.font = `500 ${subSize}px ${FONT}`;
  const wSub = ctx.measureText(sub).width;
  ctx.font = `700 ${tagSize}px ${FONT}`;
  const wTag = ctx.measureText(tag).width;
  const padX = 18 * u * k, padY = 14 * u * k;
  const w = Math.max(wName, wSub, wTag) + padX * 2;
  const h = tagSize + nameSize + subSize + padY * 2 + 14 * u * k;
  const lineLen = 62 * u * k;
  const x = clamp(pt.x - w / 2, 12 * u, ctx.canvas.width - w - 12 * u);
  const y = clamp(pt.y - gap * u - lineLen - h, 12 * u, (maxY ?? ctx.canvas.height) - h - 12 * u);

  // 지점에서 박스 하단 중앙으로 이어지는 선
  ctx.strokeStyle = color;
  ctx.lineWidth = 2 * u;
  ctx.beginPath();
  ctx.moveTo(pt.x, pt.y - gap * u);
  ctx.lineTo(clamp(pt.x, x + 10 * u, x + w - 10 * u), y + h);
  ctx.stroke();

  glass(ctx, x, y, w, h, 12 * u, 0.68);
  roundRect(ctx, x, y + 10 * u, 4 * u, h - 20 * u, 2 * u);
  ctx.fillStyle = color; ctx.fill();
  // 텍스트는 박스 안에서 중앙정렬
  const cx = x + w / 2 + 2 * u;
  let yy = y + padY + tagSize;
  text(ctx, tag, cx, yy - 3 * u, { size: tagSize, weight: 700, color, align: 'center' });
  yy += nameSize + 6 * u * k;
  text(ctx, name, cx, yy - 4 * u, { size: nameSize, weight: 700, align: 'center' });
  yy += subSize + 8 * u * k;
  text(ctx, sub, cx, yy - 4 * u, { size: subSize, weight: 500, color: 'rgba(255,255,255,0.78)', align: 'center' });
  ctx.restore();
}

/**
 * info: GlobeScene.renderAt의 반환값, meta: 항공편 정보
 * meta = { airline, origin, dest, originCountry, destCountry, distanceKm, outMin, backMin, routeColor, routeCountries:Set, tilesActive }
 */
export function drawHud(ctx, w, h, info, meta) {
  const u = Math.min(w, h) / 1080;
  const portrait = h > w;
  ctx.save();

  // 비네트
  const vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.45, w / 2, h / 2, Math.hypot(w, h) * 0.62);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.38)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, w, h);

  const intro = smooth(info.t / 0.08);
  const outro = 1;
  // 지구를 크게 줌아웃한 화면에서는 정보 요소를 70%로 줄여 지도가 가려지지 않게 한다 (줌인하면 원래 크기로)
  const far = smooth((info.dist - 0.35) / 0.8);
  const sc = 1 - 0.3 * far;

  if (meta.showCountryLabels !== false) countryLabels(ctx, info, u, meta.routeCountries);

  const m = 36 * u;
  const cardH = 98 * u; // 비행거리·가는 편·오는 편만 보여주는 컴팩트 카드
  const showCard = meta.showCard !== false;
  const cyFull = h - m - cardH;
  const cy = showCard ? h - m - cardH * sc : h;

  // 공항 콜아웃: 도착지는 줌인할수록 살짝 커진다. 붉은 타겟이 있으면 그 바깥에서 선이 시작한다
  const z = info.zoom;
  // 붉은 타겟(3D 씬)의 바깥에서 선이 시작한다. 타겟 반지름은 줌인할수록 도착 쪽만 커진다
  const gapOf = (on, zz) => (on ? 24 + 30 * zz + 4 : 8);
  if (meta.showOriginBox !== false) callout(ctx, info.origin, u, {
    maxY: cy, scale: sc, gap: gapOf(meta.showOriginTarget, 0), color: '#4ade80', tag: '출발 · DEPARTURE',
    name: `${meta.origin.ko || meta.origin.en}`, sub: `${meta.originCountry.ko} · ${meta.origin.iata}`,
    alpha: intro * (1 - smooth((z - 0.2) / 0.5) * 0.9),
  });
  if (meta.showDestBox !== false) callout(ctx, info.dest, u, {
    maxY: cy, scale: Math.min(sc, 0.7), gap: gapOf(meta.showDestTarget, z), color: '#ffb020', tag: '도착 · ARRIVAL', // 도착 정보박스는 항상 70% 크기
    name: `${meta.dest.ko || meta.dest.en}`, sub: `${meta.destCountry.ko} · ${meta.dest.iata}`,
    alpha: intro,
  });

  // ── 상단: 항공사 + 노선 ──────────────────────────────────────────────
  const topW = portrait ? w - m * 2 : 560 * u, topH = 108 * u;
  ctx.globalAlpha = intro;
  ctx.save();
  ctx.translate(m, m); ctx.scale(sc, sc); ctx.translate(-m, -m);
  glass(ctx, m, m, topW, topH, 18 * u, 0.62);
  roundRect(ctx, m, m, 10 * u, topH, 5 * u);
  ctx.fillStyle = meta.airline.tail; ctx.fill();
  text(ctx, meta.airline.ko, m + 34 * u, m + 46 * u, { size: 31 * u, weight: 700 });
  text(ctx, meta.airline.en.toUpperCase(), m + 34 * u, m + 78 * u, { size: 17 * u, weight: 500, color: 'rgba(255,255,255,0.65)' });
  text(ctx, `${meta.origin.iata}  →  ${meta.dest.iata}`, m + topW - 28 * u, m + 62 * u, { size: 44 * 0.9 * u, weight: 900, align: 'right', color: '#fff' });
  ctx.restore();

  if (showCard) {
    ctx.save();
    ctx.translate(m, h - m); ctx.scale(sc, sc); ctx.translate(-m, -(h - m));
    const cy = cyFull;
    const cardW = Math.min(w - m * 2, 660 * u);
    const cx = m;
    glass(ctx, cx, cy, cardW, cardH, 18 * u, 0.7);
    const colW = (cardW - 44 * u) / 3;
    const stat = (i, label, value, color = '#fff') => {
      const x = cx + 22 * u + colW * i;
      text(ctx, label, x, cy + 30 * u, { size: 15 * u, weight: 500, color: 'rgba(255,255,255,0.62)' });
      text(ctx, value, x, cy + 63 * u, { size: 28 * u, weight: 700, color });
    };
    stat(0, '비행 거리', `${Math.round(meta.distanceKm).toLocaleString('ko-KR')} km`);
    stat(1, `가는 편  ${meta.origin.iata} → ${meta.dest.iata}`, formatDuration(meta.outMin), '#7dd3fc');
    stat(2, `오는 편  ${meta.dest.iata} → ${meta.origin.iata}`, formatDuration(meta.backMin), '#fcd34d');

    // 진행 바
    const barY = cy + cardH - 13 * u;
    roundRect(ctx, cx + 22 * u, barY, cardW - 44 * u, 4 * u, 2 * u);
    ctx.fillStyle = 'rgba(255,255,255,0.15)'; ctx.fill();
    roundRect(ctx, cx + 22 * u, barY, Math.max(4 * u, (cardW - 44 * u) * info.p), 4 * u, 2 * u);
    ctx.fillStyle = meta.routeColor; ctx.fill();
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  ctx.globalAlpha = 1;
  // 출처
  const attr = meta.tilesActive ? `NASA Blue Marble · ${IMAGERY_ATTRIBUTION} · Natural Earth` : 'NASA Blue Marble · Natural Earth';
  text(ctx, attr, w - m, h - 16 * u, { size: 13 * u, weight: 400, color: 'rgba(255,255,255,0.5)', align: 'right' });
  void outro;
  ctx.restore();
}
