// 공항 주변에 Esri World Imagery(위성사진) + AWS Terrain(고도) 타일을 붙여 줌인 시 해상도와 지형 입체감을 높이는 패치.
// 네트워크가 막혀 있거나 타일이 없으면 조용히 건너뛰고 기본 지구 텍스처만 사용한다.
import * as THREE from 'three';
import { latLonToVec } from './flight.js';

const TILE_URL = (z, x, y) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
// Terrarium 인코딩 고도 타일: 미터 = R*256 + G + B/256 - 32768
const ELEV_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
export const IMAGERY_ATTRIBUTION = 'Imagery © Esri, Maxar, Earthstar Geographics · Terrain: Mapzen/AWS';

const lonToX = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const latToY = (lat, z) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z;
};
const xToLon = (x, z) => (x / 2 ** z) * 360 - 180;
const yToLat = (y, z) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

function loadImageOnce(url, timeoutMs) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const timer = setTimeout(() => { img.src = ''; resolve(null); }, timeoutMs);
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => { clearTimeout(timer); resolve(null); };
    img.src = url;
  });
}

/** 네트워크가 잠깐 불안정해도 타일이 빠지지 않도록 최대 3번(0.8초·1.6초 간격) 시도한다 */
export async function loadImage(url, timeoutMs) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const img = await loadImageOnce(url, timeoutMs);
    if (img) return img;
    await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
  }
  return null;
}

/** n×n 타일을 한 장의 캔버스로 합성 (없는 타일은 비워 둠). 하나도 없으면 null */
async function compose(urlOf, zoom, x0, y0, n, timeout = 12000) {
  const max = 2 ** zoom;
  const jobs = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const tx = ((x0 + i) % max + max) % max, ty = y0 + j;
    jobs.push(ty < 0 || ty >= max ? Promise.resolve(null) : loadImage(urlOf(zoom, tx, ty), timeout));
  }
  const tiles = await Promise.all(jobs);
  if (!tiles.some(Boolean)) return null;
  const size = n * 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  tiles.forEach((img, k) => img && ctx.drawImage(img, (k % n) * 256, Math.floor(k / n) * 256));
  return canvas;
}

/** 고도 캔버스 → 탄젠트 공간 노멀맵 (OpenGL 규약, 초록 = 북쪽). 읽기가 막히면(CORS) null */
function elevationToNormal(elevCanvas, zoom, lat) {
  const size = elevCanvas.width;
  let src;
  try { src = elevCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, size, size).data; } catch { return null; }
  const h = new Float32Array(size * size);
  let any = false;
  for (let i = 0; i < size * size; i++) {
    const a = src[i * 4 + 3];
    if (!a) { h[i] = 0; continue; }
    any = true;
    h[i] = src[i * 4] * 256 + src[i * 4 + 1] + src[i * 4 + 2] / 256 - 32768;
  }
  if (!any) return null;
  // 약한 박스 블러로 8비트 계단 제거
  const b = new Float32Array(h.length);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let sum = 0, c = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue;
      sum += h[yy * size + xx]; c++;
    }
    b[y * size + x] = sum / c;
  }
  const mpp = (156543.03 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom; // 픽셀당 미터
  const EXAG = 3.6; // 지형 과장 (시각적 돌출감)
  const out = document.createElement('canvas');
  out.width = out.height = size;
  const octx = out.getContext('2d');
  const img = octx.createImageData(size, size);
  const at = (x, y) => b[Math.min(size - 1, Math.max(0, y)) * size + Math.min(size - 1, Math.max(0, x))];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const gx = (at(x + 1, y) - at(x - 1, y)) / (2 * mpp);   // 동쪽으로 오를수록 +
    const gy = (at(x, y + 1) - at(x, y - 1)) / (2 * mpp);   // 남쪽(캔버스 아래)으로 오를수록 +
    let nx = -gx * EXAG, ny = gy * EXAG, nz = 1;             // 북쪽 기울기 = -gy
    const l = Math.hypot(nx, ny, nz);
    nx /= l; ny /= l; nz /= l;
    const o = (y * size + x) * 4;
    img.data[o] = (nx * 0.5 + 0.5) * 255;
    img.data[o + 1] = (ny * 0.5 + 0.5) * 255;
    img.data[o + 2] = (nz * 0.5 + 0.5) * 255;
    img.data[o + 3] = 255;
  }
  octx.putImageData(img, 0, 0);
  return out;
}

/** 한 개 줌 레벨의 n×n 위성사진(+고도 노멀맵)을 구면 위에 얹는 메쉬. 사진이 하나도 없으면 null */
async function buildPatch(lat, lon, { zoom, n, elev }, renderOrder, maxAnisotropy) {
  const x0 = Math.floor(lonToX(lon, zoom)) - Math.floor(n / 2);
  const y0 = Math.floor(latToY(lat, zoom)) - Math.floor(n / 2);
  const [canvas, elevCanvas] = await Promise.all([
    compose(TILE_URL, zoom, x0, y0, n),
    elev ? compose(ELEV_URL, zoom, x0, y0, n, 15000) : Promise.resolve(null),
  ]);
  if (!canvas) return null;

  const size = n * 256;
  const ctx = canvas.getContext('2d');
  // 가장자리를 투명하게 페이드해 기본 텍스처와 자연스럽게 이어 붙인다
  ctx.globalCompositeOperation = 'destination-in';
  const g = ctx.createRadialGradient(size / 2, size / 2, size * 0.28, size / 2, size / 2, size * 0.5);
  g.addColorStop(0, 'rgba(0,0,0,1)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAnisotropy;

  let normalMap = null;
  if (elevCanvas) {
    const nc = elevationToNormal(elevCanvas, zoom, lat);
    if (nc) { normalMap = new THREE.CanvasTexture(nc); normalMap.anisotropy = maxAnisotropy; }
  }

  const seg = 40, pos = [], uv = [], idx = [];
  const r = 1 + 0.00003 * renderOrder; // 최대 1.0001 — 기체·경로선보다 항상 아래
  for (let j = 0; j <= seg; j++) for (let i = 0; i <= seg; i++) {
    const [px, py, pz] = latLonToVec(yToLat(y0 + (n * j) / seg, zoom), xToLon(x0 + (n * i) / seg, zoom), r);
    pos.push(px, py, pz);
    uv.push(i / seg, 1 - j / seg);
  }
  for (let j = 0; j < seg; j++) for (let i = 0; i < seg; i++) {
    const a = j * (seg + 1) + i, b = a + 1, c = a + seg + 1, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({
    map: tex, normalMap, normalScale: new THREE.Vector2(1, 1), transparent: true, depthWrite: false, roughness: 1, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: -renderOrder, polygonOffsetUnits: -renderOrder,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = renderOrder;
  mesh.userData.hasNormal = !!normalMap;
  return mesh;
}

// 넓은 범위(저해상도) → 좁은 범위(고해상도) 순으로 겹친다.
// 도착 공항은 줌인이 끝나는 곳이라 더 촘촘한 레벨과 고도(노멀맵)까지 불러온다.
const LEVELS_ORIGIN = [{ zoom: 7, n: 5 }, { zoom: 9, n: 5 }];
const LEVELS_DEST = [{ zoom: 7, n: 5 }, { zoom: 9, n: 7, elev: true }, { zoom: 11, n: 5, elev: true }];

export async function buildAirportPatches(lat, lon, maxAnisotropy, role = 'dest') {
  const levels = role === 'origin' ? LEVELS_ORIGIN : LEVELS_DEST;
  const meshes = await Promise.all(levels.map((l, i) => buildPatch(lat, lon, l, i + 1, maxAnisotropy)));
  return meshes.filter(Boolean);
}
