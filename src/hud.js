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

let vignetteCache = null;
function vignetteFor(w, h) {
  if (vignetteCache && vignetteCache.width === w && vignetteCache.height === h) return vignetteCache;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d');
  const vg = x.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.45, w / 2, h / 2, Math.hypot(w, h) * 0.62);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.38)');
  x.fillStyle = vg;
  x.fillRect(0, 0, w, h);
  return (vignetteCache = c);
}

function countryLabels(ctx, info, u, route, meta) {
  const taken = [];
  const items = info.countries
    .filter((c) => route.has(c.code) || c.rank <= 3 || info.dist < 0.9)
    .sort((a, b) => (route.has(b.code) - route.has(a.code)) || a.rank - b.rank);
  // 비선택 국가명: 지구 전체·아주 가까운 화면에서 서서히 사라진다
  const fade = smooth((info.dist - 0.12) / 0.25) * smooth((3.4 - info.dist) / 1.0);
  // 선택(출발·도착) 국가명: 가까이 가도 유지되고, 설정한 시점(영상 진행률)에 서서히 사라진다 (100% = 끝까지 유지)
  const fadeAt = (meta.selCountryFadeAt ?? 1);
  const selFade = smooth((3.4 - info.dist) / 1.0) * (fadeAt >= 0.999 ? 1 : 1 - smooth((info.t - fadeAt) / 0.06));
  const scale = meta.countryFontScale ?? 1.3;
  for (const c of items) {
    if (c.code === 'KP') continue; // 조선민주주의인민공화국 라벨은 표시하지 않는다
    const sel = route.has(c.code);
    const far = smooth((info.dist - 0.35) / 0.8); // 최대 줌아웃에 가까울수록 1
    const size = (sel ? 23 : 16) * 0.85 * (1 - 0.2 * far) * u * scale;
    // 선택 국가명은 위·아래·좌·우로 옮길 수 있다 (화면 폭·높이 대비 비율)
    let ox = 0, oy = 0;
    if (sel) {
      const isOrigin = c.code === meta.origin.country;
      ox = (isOrigin ? meta.originCountryX : meta.destCountryX) ?? 0;
      oy = (isOrigin ? meta.originCountryY : meta.destCountryY) ?? 0;
    }
    const cx = c.x + ox * ctx.canvas.width, cy = c.y + oy * ctx.canvas.height;
    ctx.font = `700 ${size}px ${FONT}`;
    const w = ctx.measureText(c.ko).width, h = size;
    const box = [cx - w / 2 - 6 * u, cy - h / 2 - 4 * u, w + 12 * u, h + 8 * u];
    if (taken.some((t) => box[0] < t[0] + t[2] && box[0] + box[2] > t[0] && box[1] < t[1] + t[3] && box[1] + box[3] > t[1])) continue;
    taken.push(box);
    // 선택한 국가는 또렷하게, 나머지 국가는 연한 색·낮은 불투명도로 한 단계 물러나게
    ctx.globalAlpha = sel ? selFade : fade * 0.42;
    if (ctx.globalAlpha <= 0.01) continue;
    // 글자 그림자(shadowBlur)는 라벨이 많으면 프레임마다 비용이 커서, 얇은 외곽선으로 대신한다
    ctx.font = `${sel ? 800 : 500} ${size}px ${FONT}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round'; ctx.lineWidth = (sel ? 4 : 3) * u;
    ctx.strokeStyle = sel ? 'rgba(0,0,0,0.7)' : 'rgba(0,0,0,0.45)';
    ctx.strokeText(c.ko, cx, cy);
    ctx.fillStyle = sel ? '#ffffff' : '#c4cee0';
    ctx.fillText(c.ko, cx, cy);
  }
  ctx.globalAlpha = 1;
}

/**
 * 지점 위쪽에 정보박스를 두고 선으로 잇는다.
 *  - 박스 아랫면은 지점에서 박스 높이의 절반만큼 위에 둔다 (비행기와 겹치지 않게)
 *  - 지점이 화면 중심 왼쪽이면 박스의 우측 중앙 끝, 오른쪽이면 좌측 중앙 끝으로 연결한다 (박스는 지점의 반대 방향 위쪽)
 *  - offX/offY(화면 폭·높이 대비 비율)로 박스를 옮겨도 선은 지점에서 박스 하단 모서리로 자연스럽게 이어진다
 */
function callout(ctx, pt, u, { minY, maxY, gap = 8, color, tag, name, sub, big = 1, alpha = 1, scale = 1, offX = 0, offY = 0 }) {
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
  const margin = 12 * u, gapX = 16 * u * k;
  // 지점이 화면 중심 왼쪽이면 박스는 지점 왼쪽 위(선은 박스 우측 중앙으로), 오른쪽이면 오른쪽 위(선은 좌측 중앙으로).
  // 그쪽에 자리가 없으면 반대쪽에 둔다
  const fitsL = pt.x - gapX - w >= margin, fitsR = pt.x + gapX + w <= cw - margin;
  const boxLeft = pt.x < cw / 2 ? (fitsL || !fitsR) : !(fitsR || !fitsL);
  const x = clamp((boxLeft ? pt.x - gapX - w : pt.x + gapX) + offX * cw, margin, cw - w - margin);
  const y = clamp(pt.y - gap * u - h * 1.5 + offY * ch, minY ?? margin, (maxY ?? ch) - h - margin);

  // 연결선: 지점 → 박스 옆면 중앙. 박스를 옮겨도 지점이 박스 오른쪽이면 우측 중앙, 왼쪽이면 좌측 중앙으로 붙는다
  const ax = pt.x > x + w / 2 ? x + w : x;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2 * u;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(pt.x, pt.y - gap * u);
  ctx.lineTo(ax, y + h / 2);
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

  // 비네트 (크기별로 한 번만 그려 두고 매 프레임 복사한다)
  ctx.drawImage(vignetteFor(w, h), 0, 0);

  const intro = smooth(info.t / 0.08);
  const outro = 1;
  // 지구를 크게 줌아웃한 화면에서는 정보 요소를 70%로 줄여 지도가 가려지지 않게 한다 (줌인하면 원래 크기로)
  const far = smooth((info.dist - 0.35) / 0.8);
  const sc = 1 - 0.3 * far;

  if (meta.showCountryLabels !== false) countryLabels(ctx, info, u, meta.routeCountries, meta);

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

  // 우측 상단 항공사 박스 치수 (정보 카드가 같은 모서리에 올 때 겹치지 않도록 먼저 계산)
  const tbs = meta.topBoxScale ?? 1, tfs = meta.topFontScale ?? 1;
  const topOn = meta.showTop !== false;
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

  // 정보 박스 배치: 항공사 박스와 비행거리 카드는 각각 네 모서리(tl·tr·bl·br) 중 하나에 놓는다.
  // 같은 모서리를 고르면 항공사 박스가 모서리 쪽, 카드가 그 안쪽(화면 중앙 쪽)에 쌓인다.
  const cardPos = meta.cardPos || 'tl', topPos = meta.topPos || 'tr';
  const ck = sc * cbs, cw = cardW * ck, chh = cardH * ck;
  const tk = sc * tbs, tw = topW * tk, th = topH * tk;
  const gapStack = 14 * u;
  const place = (pos, bw, bh, offset) => ({
    x: pos.endsWith('r') ? w - m - bw : m,
    y: pos.startsWith('t') ? m + offset : h - m - bh - offset,
  });
  const topRect = topOn ? { ...place(topPos, tw, th, 0), w: tw, h: th } : null;
  const cardOffset = topOn && topPos === cardPos ? th + gapStack : 0;
  const cardRect = showCard ? { ...place(cardPos, cw, chh, cardOffset), w: cw, h: chh } : null;
  const cardX = cardRect ? cardRect.x : 0, cardY = cardRect ? cardRect.y : 0;
  // 공항 정보박스가 위·아래 박스와 겹치지 않도록 허용 범위를 제한
  let calloutMinY, cy = h;
  for (const r of [topRect, cardRect]) {
    if (!r) continue;
    if (r.y + r.h / 2 < h / 2) calloutMinY = Math.max(calloutMinY ?? 0, r.y + r.h + 10 * u);
    else cy = Math.min(cy, r.y - 4 * u);
  }

  // 공항 콜아웃: 도착지는 줌인할수록 살짝 커진다. 붉은 타겟이 있으면 그 바깥에서 선이 시작한다
  const z = info.zoom;
  // 붉은 타겟(3D 씬)의 바깥에서 선이 시작한다. 타겟 반지름은 줌인할수록 도착 쪽만 커진다
  const gapOf = (on, zz, k = 1) => (on ? (24 + 30 * zz) * k + 4 : 8);
  if (meta.showOriginBox !== false) callout(ctx, info.origin, u, {
    minY: calloutMinY, maxY: cy, scale: sc * (meta.originBoxScale ?? 1), gap: gapOf(meta.showOriginTarget, 0, meta.originTargetScale ?? 1), color: '#4ade80', tag: '출발 · DEPARTURE', offX: meta.originBoxX ?? 0, offY: meta.originBoxY ?? 0,
    name: `${meta.origin.ko || meta.origin.en}`, sub: `${meta.originCountry.ko} · ${meta.origin.iata}`,
    alpha: intro * (1 - smooth((z - 0.2) / 0.5) * 0.9),
  });
  if (meta.showDestBox !== false) callout(ctx, info.dest, u, {
    minY: calloutMinY, maxY: cy, scale: Math.min(sc, 0.7) * (meta.destBoxScale ?? 1), gap: gapOf(meta.showDestTarget, z, meta.destTargetScale ?? 1), color: '#ffb020', tag: '도착 · ARRIVAL', offX: meta.destBoxX ?? 0, offY: meta.destBoxY ?? 0, // 도착 정보박스는 기본 70% 크기
    name: `${meta.dest.ko || meta.dest.en}`, sub: `${meta.destCountry.ko} · ${meta.dest.iata}`,
    alpha: intro,
  });

  // ── 우측 상단: 항공사 + 노선(영문 약어 + 작은 국문 표기) ───────────────────
  if (topOn) {
    const topX = 0, tm = 0; // 박스 좌상단을 원점으로 그린다
    ctx.save();
    ctx.globalAlpha = intro;
    ctx.translate(topRect.x, topRect.y); ctx.scale(tk, tk);
    glass(ctx, topX, tm, topW, topH, 18 * u, 0.62);
    roundRect(ctx, topX, tm, 10 * u, topH, 5 * u);
    ctx.fillStyle = meta.airline.tail; ctx.fill();
    if (logoW) drawLogoMark(ctx, meta.airline, topX + 34 * u + lr, tm + (y1 + y2 - eSize * 0.4) / 2, lr);
    text(ctx, meta.airline.ko, topX + padL, tm + y1, { size: kSize, weight: 700 });
    text(ctx, en, topX + padL, tm + y2, { size: eSize, weight: 500, color: 'rgba(255,255,255,0.65)' });
    text(ctx, route, topX + topW - padR, tm + rBase, { size: rSize, weight: 900, align: 'right', color: '#fff' });
    text(ctx, routeKo, topX + topW - padR, tm + kBase, { size: sSize, weight: 500, align: 'right', color: 'rgba(255,255,255,0.7)' });
    ctx.restore();
  }

  if (showCard) {
    ctx.save();
    ctx.translate(cardX, cardY); ctx.scale(ck, ck);
    const cy0 = 0, cx = 0;
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
