// 2D 캔버스에 그리는 정보 오버레이. 미리보기와 영상/이미지 출력에 같은 함수를 쓴다.
import { formatDuration } from './flight.js';
import { IMAGERY_ATTRIBUTION } from './satellite.js';
import { drawLogoMark } from './logos.js';

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

/** 공항 국문명을 짧게 (예: '인천국제공항 제1터미널' → '인천', '나리타국제공항' → '나리타') */
export function shortKo(ap) {
  const n = ap.ko || ap.en || '';
  return n.replace(/\s*제\d\s*터미널/, '').replace(/(국제)?공항$/, '').trim() || n;
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
    if (c.code === 'KP') continue; // 조선민주주의인민공화국 라벨은 표시하지 않는다
    const far = smooth((info.dist - 0.35) / 0.8); // 최대 줌아웃에 가까울수록 1
    const size = (route.has(c.code) ? 23 : 16) * 0.85 * (1 - 0.2 * far) * u;
    ctx.font = `700 ${size}px ${FONT}`;
    const w = ctx.measureText(c.ko).width, h = size;
    const box = [c.x - w / 2 - 6 * u, c.y - h / 2 - 4 * u, w + 12 * u, h + 8 * u];
    if (taken.some((t) => box[0] < t[0] + t[2] && box[0] + box[2] > t[0] && box[1] < t[1] + t[3] && box[1] + box[3] > t[1])) continue;
    taken.push(box);
    // 선택한(출발·도착) 국가는 또렷하게, 나머지 국가는 연한 색·낮은 불투명도로 한 단계 물러나게
    const sel = route.has(c.code);
    ctx.globalAlpha = fade * (sel ? 1 : 0.42);
    text(ctx, c.ko, c.x, c.y, { size, weight: sel ? 800 : 500, color: sel ? '#ffffff' : '#c4cee0', align: 'center', baseline: 'middle', shadow: sel ? 9 * u : 4 * u });
  }
  ctx.globalAlpha = 1;
}

/**
 * 지점 위쪽에 정보박스를 두고 선으로 잇는다.
 *  - 박스 아랫면은 지점에서 박스 높이의 절반만큼 위에 둔다 (비행기와 겹치지 않게)
 *  - 지점이 화면 중심 왼쪽이면 박스의 우측 하단 끝, 오른쪽이면 좌측 하단 끝으로 연결한다
 *  - offX/offY(화면 폭·높이 대비 비율)로 박스를 옮겨도 선은 지점에서 박스 하단 모서리로 자연스럽게 이어진다
 */
function callout(ctx, pt, u, { maxY, gap = 8, color, tag, name, sub, big = 1, alpha = 1, scale = 1, offX = 0, offY = 0 }) {
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
  const cw = ctx.canvas.width, ch = ctx.canvas.height;
  const x = clamp(pt.x - w / 2 + offX * cw, 12 * u, cw - w - 12 * u);
  const y = clamp(pt.y - gap * u - h * 0.5 - h + offY * ch, 12 * u, (maxY ?? ch) - h - 12 * u);

  // 연결선: 지점 → 박스 하단 모서리 (지점이 박스 가로 범위 밖이면 가까운 모서리)
  const inset = 12 * u * k;
  const leftCorner = x + inset, rightCorner = x + w - inset;
  // 박스 가로 범위 안: 지점이 화면 중심 왼쪽이면 우측 하단, 오른쪽이면 좌측 하단. 범위 밖: 가까운 모서리
  const useRightEnd = pt.x >= x && pt.x <= x + w ? pt.x < cw / 2 : pt.x > x + w;
  const ax = useRightEnd ? rightCorner : leftCorner;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2 * u;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(pt.x, pt.y - gap * u);
  ctx.lineTo(ax, y + h);
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

  // ── 하단 카드 치수: 글자 크기에 맞춰 폭·높이가 자동으로 정해진다 (박스 크기 배율은 따로) ──
  const showCard = meta.showCard !== false;
  const cbs = meta.cardBoxScale ?? 1, cfs = meta.cardFontScale ?? 1;
  const stats = [
    { label: '비행 거리', value: `${Math.round(meta.distanceKm).toLocaleString('ko-KR')} km`, color: '#fff' },
    { label: `가는 편  ${meta.origin.iata} → ${meta.dest.iata}`, value: formatDuration(meta.outMin), color: '#7dd3fc' },
    { label: `오는 편  ${meta.dest.iata} → ${meta.origin.iata}`, value: formatDuration(meta.backMin), color: '#fcd34d' },
  ];
  const labelSize = 15 * u * cfs, valueSize = 28 * u * cfs;
  const measure = (str, size, weight) => { ctx.font = `${weight} ${size}px ${FONT}`; return ctx.measureText(str).width; };
  const colWs = stats.map((st) => Math.max(measure(st.label, labelSize, 500), measure(st.value, valueSize, 700)));
  const colGap = 44 * u;
  const cardW = 22 * u * 2 + colWs.reduce((x, y) => x + y, 0) + colGap * 2;
  const cardH = 18 * u + labelSize + 8 * u + valueSize + 28 * u;
  const cyFull = h - m - cardH;
  const cy = showCard ? h - m - cardH * sc * cbs : h;

  // 공항 콜아웃: 도착지는 줌인할수록 살짝 커진다. 붉은 타겟이 있으면 그 바깥에서 선이 시작한다
  const z = info.zoom;
  // 붉은 타겟(3D 씬)의 바깥에서 선이 시작한다. 타겟 반지름은 줌인할수록 도착 쪽만 커진다
  const gapOf = (on, zz, k = 1) => (on ? (24 + 30 * zz) * k + 4 : 8);
  if (meta.showOriginBox !== false) callout(ctx, info.origin, u, {
    maxY: cy, scale: sc * (meta.originBoxScale ?? 1), gap: gapOf(meta.showOriginTarget, 0, meta.originTargetScale ?? 1), color: '#4ade80', tag: '출발 · DEPARTURE', offX: meta.originBoxX ?? 0, offY: meta.originBoxY ?? 0,
    name: `${meta.origin.ko || meta.origin.en}`, sub: `${meta.originCountry.ko} · ${meta.origin.iata}`,
    alpha: intro * (1 - smooth((z - 0.2) / 0.5) * 0.9),
  });
  if (meta.showDestBox !== false) callout(ctx, info.dest, u, {
    maxY: cy, scale: Math.min(sc, 0.7) * (meta.destBoxScale ?? 1), gap: gapOf(meta.showDestTarget, z, meta.destTargetScale ?? 1), color: '#ffb020', tag: '도착 · ARRIVAL', offX: meta.destBoxX ?? 0, offY: meta.destBoxY ?? 0, // 도착 정보박스는 기본 70% 크기
    name: `${meta.dest.ko || meta.dest.en}`, sub: `${meta.destCountry.ko} · ${meta.dest.iata}`,
    alpha: intro,
  });

  // ── 우측 상단: 항공사 + 노선(영문 약어 + 작은 국문 표기) ───────────────────
  if (meta.showTop !== false) {
    const tbs = meta.topBoxScale ?? 1, tfs = meta.topFontScale ?? 1;
    const kSize = 31 * u * tfs, eSize = 17 * u * tfs, rSize = 44 * 0.9 * u * tfs, sSize = 16 * u * tfs;
    const route = `${meta.origin.iata}  →  ${meta.dest.iata}`;
    const routeKo = `${shortKo(meta.origin)}  →  ${shortKo(meta.dest)}`;
    const en = meta.airline.en.toUpperCase();
    const leftW = Math.max(measure(meta.airline.ko, kSize, 700), measure(en, eSize, 500));
    const rightW = Math.max(measure(route, rSize, 900), measure(routeKo, sSize, 500));
    const lr = (kSize + eSize * 0.7) * 0.62, logoW = meta.showAirlineLogo === false ? 0 : lr * 2 + 14 * u;
    const padL = 34 * u + logoW, padR = 28 * u, gapT = 44 * u;
    const topW = Math.min(w - m * 2, padL + leftW + gapT + rightW + padR);
    const y1 = 15 * u + kSize, y2 = y1 + 14 * u + eSize;
    const rBase = 12 * u + rSize * 0.95, kBase = rBase + 10 * u + sSize;
    const topH = Math.max(y2 + 30 * u, kBase + 22 * u);
    const topX = w - m - topW; // 우측 상단
    ctx.save();
    ctx.globalAlpha = intro;
    ctx.translate(w - m, m); ctx.scale(sc * tbs, sc * tbs); ctx.translate(-(w - m), -m);
    glass(ctx, topX, m, topW, topH, 18 * u, 0.62);
    roundRect(ctx, topX, m, 10 * u, topH, 5 * u);
    ctx.fillStyle = meta.airline.tail; ctx.fill();
    if (logoW) drawLogoMark(ctx, meta.airline, topX + 34 * u + lr, m + (y1 + y2 - eSize * 0.4) / 2, lr);
    text(ctx, meta.airline.ko, topX + padL, m + y1, { size: kSize, weight: 700 });
    text(ctx, en, topX + padL, m + y2, { size: eSize, weight: 500, color: 'rgba(255,255,255,0.65)' });
    text(ctx, route, topX + topW - padR, m + rBase, { size: rSize, weight: 900, align: 'right', color: '#fff' });
    text(ctx, routeKo, topX + topW - padR, m + kBase, { size: sSize, weight: 500, align: 'right', color: 'rgba(255,255,255,0.7)' });
    ctx.restore();
  }

  if (showCard) {
    ctx.save();
    ctx.translate(m, h - m); ctx.scale(sc * cbs, sc * cbs); ctx.translate(-m, -(h - m));
    const cy0 = cyFull, cx = m;
    glass(ctx, cx, cy0, cardW, cardH, 18 * u, 0.7);
    let x = cx + 22 * u;
    stats.forEach((st, i) => {
      text(ctx, st.label, x, cy0 + 18 * u + labelSize * 0.85, { size: labelSize, weight: 500, color: 'rgba(255,255,255,0.62)' });
      text(ctx, st.value, x, cy0 + 18 * u + labelSize + 8 * u + valueSize * 0.85, { size: valueSize, weight: 700, color: st.color });
      x += colWs[i] + colGap;
    });
    // 진행 바
    const barY = cy0 + cardH - 13 * u;
    roundRect(ctx, cx + 22 * u, barY, cardW - 44 * u, 4 * u, 2 * u);
    ctx.fillStyle = 'rgba(255,255,255,0.15)'; ctx.fill();
    roundRect(ctx, cx + 22 * u, barY, Math.max(4 * u, (cardW - 44 * u) * info.p), 4 * u, 2 * u);
    ctx.fillStyle = meta.routeColor; ctx.fill();
    ctx.restore();
  }

  ctx.globalAlpha = 1;
  // 출처
  const attr = meta.tilesActive ? `NASA Blue Marble · ${IMAGERY_ATTRIBUTION} · Natural Earth` : 'NASA Blue Marble · Natural Earth';
  text(ctx, attr, w - m, h - 16 * u, { size: 13 * u, weight: 400, color: 'rgba(255,255,255,0.5)', align: 'right' });
  void outro;
  ctx.restore();
}
