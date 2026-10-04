// 지리·비행 계산 유틸 (구면 좌표는 반지름 1 단위구 기준)
const D2R = Math.PI / 180;
/** 지면(활주로) 높이를 나타내는 구 반지름. 위성 타일 패치보다 위에 있어야 기체가 묻히지 않는다. */
export const GROUND_R = 1.0002;
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
 * 이륙 활주 → 포물선 형태의 상승·하강 → 접근(약 3° 글라이드) → 접지 → 도착 지점에서 정지.
 * 구면 위 대권을 φ(라디안)로 샘플링한다. 경로의 끝(φ = theta)이 도착 공항 좌표다.
 * 반환: { pts, theta, phi(=theta), rollout, touchdown(접지 φ) }
 */
export function buildFlightPath(from, to, { segments = 480, lift = 0.1 } = {}) {
  const a = latLonToVec(from.lat, from.lon), b = latLonToVec(to.lat, to.lon);
  const theta = Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
  const n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const nl = Math.hypot(...n) || 1;
  const t0 = [(n[1] * a[2] - n[2] * a[1]) / nl, (n[2] * a[0] - n[0] * a[2]) / nl, (n[0] * a[1] - n[1] * a[0]) / nl];
  const chord = 2 * Math.sin(theta / 2);
  const rollout = Math.min(0.004, 0.03 * theta); // 이륙 활주 / 접지 후 활주 거리
  const liftoff = rollout, touchdown = theta - rollout;
  const air = touchdown - liftoff;

  const hc = chord * lift;                 // 정점 고도
  const xa = Math.min(0.02, 0.1 * air);    // 활주로 직전·직후의 완만한 구간
  const ha = xa * 0.055;                   // 경사 약 3°
  const xd = air / 2;                      // 정점은 경로 중간
  // 지면에서 x만큼 떨어진 지점의 고도: 지면 부근은 완만하게, 이후 부드러운 S곡선으로 정점까지
  const alt = (x) => {
    if (x <= 0) return 0;
    if (x < xa) return ha * Math.pow(x / xa, 1.15);
    return ha + (hc - ha) * smoothstep((x - xa) / (xd - xa));
  };

  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const phi = (i / segments) * theta;
    let h = 0;
    if (phi > liftoff && phi < touchdown) {
      if (phi - liftoff <= xd) {
        // 상승: 이륙 직후 살짝 들어올린 뒤 거의 직선으로 정점까지 올라간다 (정점에서는 수평)
        const u = (phi - liftoff) / xd;
        h = hc * (1 - Math.pow(1 - u, 1.35)) * smoothstep(u / 0.1);
      } else {
        h = alt(touchdown - phi); // 하강: 완만한 글라이드 후 접지
      }
    }
    const c = Math.cos(phi), s = Math.sin(phi), r = GROUND_R + h;
    pts.push([(a[0] * c + t0[0] * s) * r, (a[1] * c + t0[1] * s) * r, (a[2] * c + t0[2] * s) * r]);
  }
  return { pts, theta, phi: theta, rollout, touchdown };
}

/** 지표면(고도 0)을 따라가는 대권 점들 — 지도 위 경로선용 */
export function buildGroundTrack(from, to, { segments = 200, radius = 1.0003 } = {}) {
  const a = latLonToVec(from.lat, from.lon), b = latLonToVec(to.lat, to.lon);
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const p = slerp(a, b, i / segments);
    pts.push([p[0] * radius, p[1] * radius, p[2] * radius]);
  }
  return pts;
}
