// 지역(시·도·성) 구분선 데이터: Natural Earth 10m admin-1 경계선 → 출발·도착 권역 국가만 골라 단순화한 public/data/regions.json
//   npm run data:regions
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces_lines.geojson';
// 한국 + 권역 국가 (ISO 3166-1 alpha-3). 대륙을 확장하면 여기에 추가한다
const KEEP = new Set(['KOR', 'JPN', 'CHN', 'HKG', 'MAC', 'TWN', 'MNG', 'VNM', 'THA', 'PHL', 'SGP', 'MYS', 'IDN', 'KHM', 'LAO', 'MMR', 'BRN', 'TLS']);
const TOL = 0.015; // 단순화 허용 오차(도) ≈ 1.6km

const dir = join(tmpdir(), 'match-move-data');
mkdirSync(dir, { recursive: true });
const file = join(dir, 'admin1-lines.geojson');
execFileSync('curl', ['-sSL', '--fail', '-o', file, URL], { stdio: 'inherit' });
const geo = JSON.parse(readFileSync(file, 'utf8'));

// Ramer–Douglas–Peucker
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let md = 0, mi = -1;
    const [ax, ay] = pts[a], [bx, by] = pts[b], dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1e-12;
    for (let i = a + 1; i < b; i++) {
      const t = Math.max(0, Math.min(1, ((pts[i][0] - ax) * dx + (pts[i][1] - ay) * dy) / l2));
      const d = Math.hypot(pts[i][0] - (ax + t * dx), pts[i][1] - (ay + t * dy));
      if (d > md) { md = d; mi = i; }
    }
    if (md > tol && mi > 0) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

const lines = [];
for (const f of geo.features) {
  if (!KEEP.has(f.properties.ADM0_A3)) continue;
  const parts = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
  for (const part of parts) {
    const s = simplify(part, TOL);
    if (s.length >= 2) lines.push(s.flatMap(([x, y]) => [+x.toFixed(2), +y.toFixed(2)]));
  }
}
writeFileSync('public/data/regions.json', JSON.stringify(lines));
console.log(`지역 구분선 ${lines.length}개, 좌표 ${lines.reduce((n, l) => n + l.length / 2, 0)}개 → public/data/regions.json`);
