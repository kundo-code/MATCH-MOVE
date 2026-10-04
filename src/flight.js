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
