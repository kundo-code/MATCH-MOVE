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
    const size = (route.has(c.code) ? 21 : 17) * u;
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

function callout(ctx, pt, u, { color, tag, name, sub, dir = 1, big = 1, alpha = 1 }) {
  if (!pt.visible || alpha <= 0.01) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  const nameSize = 28 * u * big, subSize = 19 * u * big, tagSize = 17 * u * big;
  ctx.font = `700 ${nameSize}px ${FONT}`;
  const wName = ctx.measureText(name).width;
  ctx.font = `500 ${subSize}px ${FONT}`;
  const wSub = ctx.measureText(sub).width;
  const padX = 18 * u * big, padY = 14 * u * big;
  const w = Math.max(wName, wSub) + padX * 2;
  const h = tagSize + nameSize + subSize + padY * 2 + 14 * u * big;
  const lift = 90 * u * big;
  let x = pt.x + dir * 40 * u * big - (dir < 0 ? w : 0);
  let y = pt.y - lift - h;
  x = clamp(x, 12 * u, ctx.canvas.width - w - 12 * u);
  y = clamp(y, 12 * u, ctx.canvas.height - h - 12 * u);

  ctx.strokeStyle = color;
  ctx.lineWidth = 2 * u;
  ctx.beginPath();
  ctx.moveTo(pt.x, pt.y);
  ctx.lineTo(clamp(pt.x + dir * 40 * u * big, x, x + w), y + h);
  ctx.stroke();

  glass(ctx, x, y, w, h, 14 * u, 0.68);
  roundRect(ctx, x, y + 12 * u, 5 * u, h - 24 * u, 3 * u);
  ctx.fillStyle = color; ctx.fill();
  let yy = y + padY + tagSize;
  text(ctx, tag, x + padX, yy - 3 * u, { size: tagSize, weight: 700, color });
  yy += nameSize + 6 * u * big;
  text(ctx, name, x + padX, yy - 4 * u, { size: nameSize, weight: 700 });
  yy += subSize + 8 * u * big;
  text(ctx, sub, x + padX, yy - 4 * u, { size: subSize, weight: 500, color: 'rgba(255,255,255,0.78)' });
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

  if (meta.showCountryLabels !== false) countryLabels(ctx, info, u, meta.routeCountries);

  // 공항 콜아웃: 도착지는 줌인할수록 커진다
  const z = info.zoom;
  const oDir = portrait ? -1 : -1, dDir = 1;
  callout(ctx, info.origin, u, {
    color: '#4ade80', tag: '출발 · DEPARTURE', dir: oDir,
    name: `${meta.origin.ko || meta.origin.en}`, sub: `${meta.originCountry.ko} · ${meta.origin.iata}`,
    alpha: intro * (1 - smooth((z - 0.2) / 0.5) * 0.9),
  });
  callout(ctx, info.dest, u, {
    color: '#ffb020', tag: '도착 · ARRIVAL', dir: dDir, big: 1 + 0.25 * z,
    name: `${meta.dest.ko || meta.dest.en}`, sub: `${meta.destCountry.ko} · ${meta.dest.iata}`,
    alpha: intro,
  });

  // ── 상단: 항공사 + 노선 ──────────────────────────────────────────────
  const m = 36 * u;
  const topW = portrait ? w - m * 2 : 560 * u, topH = 108 * u;
  ctx.globalAlpha = intro;
  glass(ctx, m, m, topW, topH, 18 * u, 0.62);
  roundRect(ctx, m, m, 10 * u, topH, 5 * u);
  ctx.fillStyle = meta.airline.tail; ctx.fill();
  text(ctx, meta.airline.ko, m + 34 * u, m + 46 * u, { size: 31 * u, weight: 700 });
  text(ctx, meta.airline.en.toUpperCase(), m + 34 * u, m + 78 * u, { size: 17 * u, weight: 500, color: 'rgba(255,255,255,0.65)' });
  text(ctx, `${meta.origin.iata}  →  ${meta.dest.iata}`, m + topW - 28 * u, m + 62 * u, { size: 44 * u, weight: 900, align: 'right', color: '#fff' });

  // ── 하단: 노선 정보 카드 (항상 표시) ────────────────────────────────
  const cardW = portrait ? w - m * 2 : Math.min(1180 * u, w - m * 2);
  const cardH = (portrait ? 330 : 214) * u;
  const cx = m, cy = h - m - cardH;
  glass(ctx, cx, cy, cardW, cardH, 22 * u, 0.7);
  const colW = portrait ? cardW : (cardW - 40 * u) / 2;

  const rows = (x, y, tag, color, ap, country) => {
    roundRect(ctx, x + 24 * u, y + 6 * u, 6 * u, 70 * u, 3 * u);
    ctx.fillStyle = color; ctx.fill();
    text(ctx, tag, x + 46 * u, y + 24 * u, { size: 17 * u, weight: 700, color });
    ctx.font = `700 ${32 * u}px ${FONT}`;
    text(ctx, fit(ctx, ap.ko || ap.en, colW - 90 * u), x + 46 * u, y + 62 * u, { size: 32 * u, weight: 700 });
    ctx.font = `500 ${20 * u}px ${FONT}`;
    text(ctx, fit(ctx, `${country.ko} (${country.en}) · ${ap.iata}/${ap.icao}`, colW - 90 * u), x + 46 * u, y + 90 * u, { size: 20 * u, weight: 500, color: 'rgba(255,255,255,0.75)' });
  };
  rows(cx, cy + 22 * u, '출발 DEPARTURE', '#4ade80', meta.origin, meta.originCountry);
  if (portrait) rows(cx, cy + 22 * u + 112 * u, '도착 ARRIVAL', '#ffb020', meta.dest, meta.destCountry);
  else rows(cx + colW + 40 * u, cy + 22 * u, '도착 ARRIVAL', '#ffb020', meta.dest, meta.destCountry);

  // 구분선 + 시간 정보
  const ty = portrait ? cy + 22 * u + 112 * u * 2 - 8 * u : cy + 22 * u + 118 * u;
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(cx + 24 * u, ty - 10 * u); ctx.lineTo(cx + cardW - 24 * u, ty - 10 * u); ctx.stroke();

  const stat = (x, label, value, color = '#fff') => {
    text(ctx, label, x, ty + 22 * u, { size: 16 * u, weight: 500, color: 'rgba(255,255,255,0.6)' });
    text(ctx, value, x, ty + 58 * u, { size: 30 * u, weight: 700, color });
  };
  const sw = (cardW - 48 * u) / 3;
  stat(cx + 24 * u, '비행 거리', `${Math.round(meta.distanceKm).toLocaleString('ko-KR')} km`);
  stat(cx + 24 * u + sw, `가는 편  ${meta.origin.iata} → ${meta.dest.iata}`, formatDuration(meta.outMin), '#7dd3fc');
  stat(cx + 24 * u + sw * 2, `오는 편  ${meta.dest.iata} → ${meta.origin.iata}`, formatDuration(meta.backMin), '#fcd34d');

  // 진행 바
  const barY = cy + cardH - 12 * u;
  roundRect(ctx, cx + 24 * u, barY, cardW - 48 * u, 4 * u, 2 * u);
  ctx.fillStyle = 'rgba(255,255,255,0.15)'; ctx.fill();
  roundRect(ctx, cx + 24 * u, barY, Math.max(4 * u, (cardW - 48 * u) * info.p), 4 * u, 2 * u);
  ctx.fillStyle = meta.routeColor; ctx.fill();
  ctx.globalAlpha = 1;

  // 도착 마무리 문구
  const fin = smooth((info.t - 0.93) / 0.05);
  if (fin > 0) {
    ctx.globalAlpha = fin;
    const label = `${meta.destCountry.ko} · ${meta.dest.ko || meta.dest.en} 도착`;
    ctx.font = `900 ${52 * u}px ${FONT}`;
    const tw = ctx.measureText(label).width + 80 * u;
    const fy = portrait ? h * 0.2 : m + topH + 40 * u + (1 - fin) * -12 * u;
    glass(ctx, (w - tw) / 2, fy, tw, 92 * u, 20 * u, 0.62);
    text(ctx, label, w / 2, fy + 46 * u, { size: 52 * u, weight: 900, align: 'center', baseline: 'middle' });
    ctx.globalAlpha = 1;
  }

  // 출처
  const attr = meta.tilesActive ? `NASA Blue Marble · ${IMAGERY_ATTRIBUTION} · Natural Earth` : 'NASA Blue Marble · Natural Earth';
  text(ctx, attr, w - m, h - 16 * u, { size: 13 * u, weight: 400, color: 'rgba(255,255,255,0.5)', align: 'right' });
  void outro;
  ctx.restore();
}
