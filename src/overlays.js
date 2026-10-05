// 인트로 / 아웃트로 템플릿, 자막, 채널 로고 워터마크. 미리보기·영상·이미지 출력에서 같은 함수를 쓴다.
import { FONT, shortKo } from './hud.js';
import { formatDuration } from './flight.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

export const INTRO_TEMPLATES = [
  ['none', '사용 안 함'],
  ['fade', '블랙 페이드 인 + 타이틀'],
  ['title', '중앙 타이틀'],
  ['lower', '좌측 하단 타이틀'],
  ['wipe', '와이프 오프닝'],
];
export const OUTRO_TEMPLATES = [
  ['none', '사용 안 함'],
  ['fade', '타이틀 + 블랙 페이드 아웃'],
  ['card', '도착 요약 카드'],
  ['title', '중앙 타이틀'],
  ['lower', '좌측 하단 타이틀'],
];

/** {출발} {도착} {항공사} {거리} {시간} {왕복} 치환 */
export function fillTokens(str, meta) {
  if (!str || !meta) return str || '';
  return str
    .replaceAll('{출발}', shortKo(meta.origin))
    .replaceAll('{도착}', shortKo(meta.dest))
    .replaceAll('{출발코드}', meta.origin.iata)
    .replaceAll('{도착코드}', meta.dest.iata)
    .replaceAll('{항공사}', meta.airline.ko)
    .replaceAll('{국가}', meta.destCountry.ko)
    .replaceAll('{거리}', `${Math.round(meta.distanceKm).toLocaleString('ko-KR')}km`)
    .replaceAll('{시간}', formatDuration(meta.outMin))
    .replaceAll('{귀국시간}', formatDuration(meta.backMin));
}

function wrapLines(ctx, str, maxW) {
  const out = [];
  for (const para of String(str).split('\n')) {
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      const test = line + word;
      if (line && ctx.measureText(test).width > maxW) { out.push(line.trim()); line = word.trimStart(); } else line = test;
    }
    out.push(line.trim());
  }
  return out.filter((l, i, a) => l || a.length === 1);
}

function textBlock(ctx, lines, x, y, { size, weight = 700, color = '#fff', align = 'center', lh = 1.25, shadow = 18, alpha = 1 }) {
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.textAlign = align; ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = shadow;
  ctx.fillStyle = color;
  lines.forEach((l, i) => ctx.fillText(l, x, y + i * size * lh));
  ctx.restore();
}

function drawLogo(ctx, img, cx, cy, maxW, maxH, alpha = 1, align = 'center') {
  if (!img) return 0;
  const k = Math.min(maxW / img.width, maxH / img.height);
  const w = img.width * k, h = img.height * k;
  ctx.save();
  ctx.globalAlpha *= alpha;
  const x = align === 'left' ? cx : align === 'right' ? cx - w : cx - w / 2;
  ctx.drawImage(img, x, cy - h / 2, w, h);
  ctx.restore();
  return h;
}

/** 템플릿 하나 그리기. p: 0~1 진행, vis: 0~1 보이는 정도(들어올 때/나갈 때), mode: 'intro' | 'outro' */
function drawTemplate(ctx, w, h, u, tpl, p, vis, cfg, mode, text, meta) {
  const accent = cfg.color;
  const title = fillTokens(text.title, meta), sub = fillTokens(text.sub, meta);
  const tSize = 84 * u, sSize = 34 * u;
  const tLines = (() => { ctx.font = `800 ${tSize}px ${FONT}`; return wrapLines(ctx, title, w * 0.8); })();
  const sLines = (() => { ctx.font = `500 ${sSize}px ${FONT}`; return wrapLines(ctx, sub, w * 0.78); })();
  const blockH = (title ? tLines.length * tSize * 1.25 : 0) + (sub ? sLines.length * sSize * 1.3 + 18 * u : 0);

  const centered = (alpha, yShift = 0) => {
    const logoH = cfg.logo ? drawLogo(ctx, cfg.logo, w / 2, h / 2 - blockH / 2 - 70 * u + yShift, w * 0.3, 110 * u, alpha) : 0;
    const top = h / 2 - blockH / 2 + (logoH ? 30 * u : 0) + yShift;
    if (title) textBlock(ctx, tLines, w / 2, top + tSize * 0.6, { size: tSize, weight: 800, alpha });
    const lineY = top + tLines.length * tSize * 1.25 + 4 * u;
    if (title) {
      ctx.save(); ctx.globalAlpha *= alpha; ctx.fillStyle = accent;
      const lw = 140 * u * smooth(p * 3);
      ctx.fillRect(w / 2 - lw / 2, lineY - 8 * u, lw, 4 * u); ctx.restore();
    }
    if (sub) textBlock(ctx, sLines, w / 2, lineY + sSize * 0.9 + 6 * u, { size: sSize, weight: 500, color: '#dbe6f5', alpha });
  };
  const lower = (alpha) => {
    const x0 = 56 * u, slide = (1 - smooth(mode === 'intro' ? p * 2.5 : 1)) * -60 * u;
    const bottom = h - 150 * u;
    const bh = blockH + 10 * u;
    ctx.save(); ctx.globalAlpha *= alpha;
    const g = ctx.createLinearGradient(0, bottom - bh - 80 * u, 0, h);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = g; ctx.fillRect(0, bottom - bh - 80 * u, w, h - (bottom - bh - 80 * u));
    ctx.fillStyle = accent; ctx.fillRect(x0 + slide, bottom - bh, 6 * u, bh);
    ctx.restore();
    const logoW = cfg.logo ? drawLogo(ctx, cfg.logo, x0 + 26 * u + slide, bottom - bh - 44 * u, 220 * u, 64 * u, alpha, 'left') : 0;
    void logoW;
    if (title) textBlock(ctx, tLines, x0 + 26 * u + slide, bottom - bh + tSize * 0.62, { size: tSize * 0.8, align: 'left', weight: 800, alpha });
    if (sub) textBlock(ctx, sLines, x0 + 26 * u + slide, bottom - bh + (title ? tLines.length * tSize * 1.0 : 0) + sSize * 1.2 + 4 * u, { size: sSize * 0.9, align: 'left', weight: 500, color: '#dbe6f5', alpha });
  };

  switch (tpl) {
    case 'fade': {
      if (mode === 'intro') {
        ctx.fillStyle = `rgba(0,0,0,${1 - smooth(p)})`;
        ctx.fillRect(0, 0, w, h);
        centered(vis);
      } else {
        ctx.fillStyle = `rgba(0,0,0,${smooth(p * 1.15)})`;
        ctx.fillRect(0, 0, w, h);
        centered(smooth((p - 0.1) / 0.3) * (1 - smooth((p - 0.88) / 0.12)));
      }
      break;
    }
    case 'title': {
      ctx.fillStyle = `rgba(4,8,18,${0.5 * vis})`;
      ctx.fillRect(0, 0, w, h);
      centered(vis, (1 - vis) * 14 * u);
      break;
    }
    case 'lower': lower(vis); break;
    case 'wipe': {
      const e = smooth(p / 0.75);
      const x = w * (mode === 'intro' ? e : 1 - e);
      ctx.save();
      ctx.beginPath();
      if (mode === 'intro') ctx.rect(x, 0, w - x, h); else ctx.rect(0, 0, x, h);
      ctx.clip();
      ctx.fillStyle = 'rgba(4,8,18,0.92)'; ctx.fillRect(0, 0, w, h);
      centered(vis);
      ctx.restore();
      if (e > 0.01 && e < 0.99) { ctx.fillStyle = accent; ctx.fillRect(x - 3 * u, 0, 6 * u, h); }
      break;
    }
    case 'card': {
      ctx.fillStyle = `rgba(4,8,18,${0.4 * vis})`; ctx.fillRect(0, 0, w, h);
      const cw = Math.min(w * 0.82, 980 * u), ch = 300 * u, cx = w / 2 - cw / 2, cy = h / 2 - ch / 2 + (1 - vis) * 24 * u;
      ctx.save(); ctx.globalAlpha *= vis;
      ctx.beginPath(); ctx.roundRect(cx, cy, cw, ch, 26 * u);
      ctx.fillStyle = 'rgba(8,14,28,0.78)'; ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 1.5 * u; ctx.stroke();
      ctx.fillStyle = accent; ctx.fillRect(cx + 34 * u, cy + 34 * u, 6 * u, ch - 68 * u);
      ctx.restore();
      const route = `${shortKo(meta.origin)}  →  ${shortKo(meta.dest)}`;
      textBlock(ctx, [route], cx + 70 * u, cy + 88 * u, { size: 64 * u, weight: 800, align: 'left', alpha: vis, shadow: 0 });
      textBlock(ctx, [`${meta.origin.iata} → ${meta.dest.iata} · ${meta.airline.ko} · ${Math.round(meta.distanceKm).toLocaleString('ko-KR')} km`], cx + 70 * u, cy + 150 * u, { size: 26 * u, weight: 500, color: '#b8c7dd', align: 'left', alpha: vis, shadow: 0 });
      textBlock(ctx, [`가는 편  ${formatDuration(meta.outMin)}`], cx + 70 * u, cy + 212 * u, { size: 34 * u, weight: 700, color: '#7dd3fc', align: 'left', alpha: vis, shadow: 0 });
      textBlock(ctx, [`오는 편  ${formatDuration(meta.backMin)}`], cx + cw * 0.5, cy + 212 * u, { size: 34 * u, weight: 700, color: '#fcd34d', align: 'left', alpha: vis, shadow: 0 });
      if (title) textBlock(ctx, [title], cx + 70 * u, cy + ch - 34 * u, { size: 24 * u, weight: 500, color: '#dbe6f5', align: 'left', alpha: vis, shadow: 0 });
      if (cfg.logo) drawLogo(ctx, cfg.logo, cx + cw - 40 * u, cy + 60 * u, 200 * u, 60 * u, vis, 'right');
      break;
    }
    default: break;
  }
}

function drawSubtitle(ctx, w, h, u, sec, cfg, meta) {
  const sub = cfg.subs.find((s) => s.text && sec >= s.start && sec <= s.end);
  if (!sub) return;
  const a = smooth((sec - sub.start) / 0.18) * smooth((sub.end - sec) / 0.18);
  if (a <= 0) return;
  const size = 40 * u * cfg.subSize;
  ctx.save();
  ctx.font = `700 ${size}px ${FONT}`;
  const lines = wrapLines(ctx, fillTokens(sub.text, meta), w * 0.78);
  const lh = size * 1.3, bh = lines.length * lh + size * 0.5;
  const maxLine = Math.max(...lines.map((l) => ctx.measureText(l).width));
  const bw = maxLine + size * 1.2;
  const cy = cfg.subPos === 'top' ? 150 * u + bh / 2 : cfg.subPos === 'middle' ? h / 2 : h - 190 * u - bh / 2;
  ctx.globalAlpha = a;
  if (cfg.subBg) {
    ctx.beginPath(); ctx.roundRect(w / 2 - bw / 2, cy - bh / 2, bw, bh, size * 0.3);
    ctx.fillStyle = 'rgba(0,0,0,0.58)'; ctx.fill();
  }
  ctx.font = `700 ${size}px ${FONT}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = cfg.subBg ? 0 : 14 * u;
  ctx.lineWidth = size * 0.1; ctx.strokeStyle = cfg.subBg ? 'transparent' : 'rgba(0,0,0,0.65)'; ctx.lineJoin = 'round';
  ctx.fillStyle = '#fff';
  lines.forEach((l, i) => {
    const y = cy - ((lines.length - 1) * lh) / 2 + i * lh;
    if (!cfg.subBg) ctx.strokeText(l, w / 2, y);
    ctx.fillText(l, w / 2, y);
  });
  ctx.restore();
}

/**
 * @param sec    영상 시작부터의 시간(초)
 * @param total  영상 전체 길이(초, 마지막 장면 연장 포함)
 */
export function drawOverlays(ctx, w, h, sec, total, cfg, meta) {
  if (!cfg || !meta) return;
  const u = Math.min(w, h) / 1080;
  ctx.save();
  const { intro, outro } = cfg;

  // 항상 표시되는 채널 로고 워터마크 (인트로/아웃트로 동안 중앙에 로고가 나오면 겹치지 않게 숨김)
  if (cfg.logo && cfg.logoWater) {
    const busy = (intro.tpl !== 'none' && sec < intro.dur) || (outro.tpl !== 'none' && sec > total - outro.dur);
    if (!busy) drawLogo(ctx, cfg.logo, w - 36 * u, h - 70 * u, 190 * u, 56 * u, 0.9, 'right');
  }

  drawSubtitle(ctx, w, h, u, sec, cfg, meta);

  if (intro.tpl !== 'none' && sec < intro.dur) {
    const p = sec / intro.dur;
    const vis = smooth(p / 0.2) * (1 - smooth((p - 0.72) / 0.28));
    drawTemplate(ctx, w, h, u, intro.tpl, p, vis, cfg, 'intro', intro, meta);
  }
  if (outro.tpl !== 'none' && sec > total - outro.dur) {
    const p = clamp((sec - (total - outro.dur)) / outro.dur, 0, 1);
    const vis = smooth(p / 0.25) * (outro.tpl === 'fade' ? 1 : 1 - smooth((p - 0.9) / 0.1) * 0);
    drawTemplate(ctx, w, h, u, outro.tpl, p, vis, cfg, 'outro', outro, meta);
  }
  ctx.restore();
}
