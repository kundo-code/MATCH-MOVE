// 지리·비행 계산 유틸 (구면 좌표는 반지름 1 단위구 기준)
const D2R = Math.PI / 180;
const EARTH_KM = 6371;

export function latLonToVec(lat, lon, r = 1) {
  const phi = lat * D2R, lam = lon * D2R;
  return [r * Math.cos(phi) * Math.cos(lam), r * Math.sin(phi), -r * Math.cos(phi) * Math.sin(lam)];
}

export function vecToLatLon([x, y, z]) {
  const r = Math.hypot(x, y, z);
  return { lat: Math.asin(y / r) / D2R, lon: Math.atan2(-z, x) / D2R };
}

export function greatCircleKm(a, b) {
  const p1 = a.lat * D2R, p2 = b.lat * D2R;
  const dp = p2 - p1, dl = (b.lon - a.lon) * D2R;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 초기 방위각(도, 북=0, 동=90) */
export function bearingDeg(a, b) {
  const p1 = a.lat * D2R, p2 = b.lat * D2R, dl = (b.lon - a.lon) * D2R;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) / D2R) + 360) % 360;
}

/**
 * 편도 소요시간(분) 추정.
 * 순항속도 + 제트기류(서→동) 성분 + 이·착륙/지상 이동 고정 시간.
 * 동행(가는 편)은 순풍, 서행은 맞바람이라 왕복 시간이 달라진다. 실제 시간표와는 차이가 있을 수 있다.
 */
export function estimateFlightMinutes(from, to, { cruiseKmh = 800, jetStreamKmh = 60, overheadMin = 45 } = {}) {
  const km = greatCircleKm(from, to);
  const brg = bearingDeg(from, to) * D2R;
  const midLat = Math.abs((from.lat + to.lat) / 2);
  // 중위도에서 제트기류가 가장 강하다고 가정
  const lift = Math.max(0.35, 1 - Math.abs(midLat - 38) / 45);
  const tailwind = jetStreamKmh * lift * Math.sin(brg);
  const speed = cruiseKmh + tailwind;
  return Math.round((km / speed) * 60 + overheadMin);
}

export function formatDuration(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h}시간 ${String(m).padStart(2, '0')}분` : `${m}분`;
}

/** 두 단위벡터 사이 구면 보간 */
export function slerp(a, b, t) {
  const dot = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const om = Math.acos(dot);
  if (om < 1e-6) return [...a];
  const s = Math.sin(om);
  const k1 = Math.sin((1 - t) * om) / s, k2 = Math.sin(t * om) / s;
  return [a[0] * k1 + b[0] * k2, a[1] * k1 + b[1] * k2, a[2] * k1 + b[2] * k2];
}

/**
 * 대권 경로 위의 고도 있는 점들. 고도는 sin 곡선으로 올라갔다 내려온다.
 * lift = 경로 길이 대비 최대 고도 비율.
 */
export function buildArc(from, to, { segments = 240, lift = 0.16, groundLift = 0.0012, offset = 0 } = {}) {
  const a = latLonToVec(from.lat, from.lon), b = latLonToVec(to.lat, to.lon);
  const chord = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const peak = chord * lift;
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const p = slerp(a, b, t);
    // 왕복 경로를 분리해 보이게 하는 옆 방향 오프셋
    let side = [0, 0, 0];
    if (offset) {
      const n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      const nl = Math.hypot(...n) || 1;
      side = n.map((v) => (v / nl) * offset * Math.sin(Math.PI * t));
    }
    const h = groundLift + peak * Math.pow(Math.sin(Math.PI * t), 0.8);
    pts.push([(p[0] + side[0]) * (1 + h), (p[1] + side[1]) * (1 + h), (p[2] + side[2]) * (1 + h)]);
  }
  return pts;
}

const smoothstep = (t) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };

/**
 * 이륙 → 순항 → 활주로 접근(글라이드) → 접지 → 지상 활주까지 포함한 비행경로.
 * 구면 위 대권을 φ(라디안)로 샘플링하고, 고도는 양 끝에서 완만한 경사(약 3°)로 지면에 닿는다.
 * 반환: { pts, theta(출발~도착 각거리), phi(활주 포함 총 각도), rollout, touchdownIndex }
 */
export function buildFlightPath(from, to, { segments = 480, lift = 0.12 } = {}) {
  const a = latLonToVec(from.lat, from.lon), b = latLonToVec(to.lat, to.lon);
  const theta = Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
  const n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const nl = Math.hypot(...n) || 1;
  const t0 = [(n[1] * a[2] - n[2] * a[1]) / nl, (n[2] * a[0] - n[0] * a[2]) / nl, (n[0] * a[1] - n[1] * a[0]) / nl];
  const chord = 2 * Math.sin(theta / 2);
  const rollout = Math.min(0.004, 0.03 * theta);
  const total = theta + rollout;

  const hc = chord * lift;            // 순항 고도
  const xa = Math.min(0.02, 0.1 * theta); // 최종 접근 구간 길이
  const ha = xa * 0.055;              // 접근 시작 고도 (경사각 약 3°)
  const xd = 0.3 * theta;             // 순항 고도까지 오르내리는 구간
  const ground = (x) => {
    if (x <= 0) return 0;
    if (x < xa) return ha * Math.pow(x / xa, 1.15);
    if (x < xd) return ha + (hc - ha) * smoothstep((x - xa) / (xd - xa));
    return hc;
  };

  const pts = [];
  let touchdownIndex = 0;
  for (let i = 0; i <= segments; i++) {
    const phi = (i / segments) * total;
    const h = phi >= theta ? 0 : Math.min(ground(phi), ground(theta - phi));
    if (phi <= theta) touchdownIndex = i;
    const c = Math.cos(phi), s = Math.sin(phi), r = 1 + h;
    pts.push([(a[0] * c + t0[0] * s) * r, (a[1] * c + t0[1] * s) * r, (a[2] * c + t0[2] * s) * r]);
  }
  return { pts, theta, phi: total, rollout, touchdownIndex };
}
