// 도착·출발 공항 주변에 Esri World Imagery 타일을 붙여 줌인 시 해상도를 높이는 패치.
// 네트워크가 막혀 있거나 타일이 없으면 조용히 건너뛰고 기본 지구 텍스처만 사용한다.
import * as THREE from 'three';
import { latLonToVec } from './flight.js';

const TILE_URL = (z, x, y) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
export const IMAGERY_ATTRIBUTION = 'Imagery © Esri, Maxar, Earthstar Geographics';

const lonToX = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const latToY = (lat, z) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z;
};
const xToLon = (x, z) => (x / 2 ** z) * 360 - 180;
const yToLat = (y, z) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

function loadTile(z, x, y, timeoutMs) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const timer = setTimeout(() => { img.src = ''; resolve(null); }, timeoutMs);
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => { clearTimeout(timer); resolve(null); };
    img.src = TILE_URL(z, x, y);
  });
}

/** 한 개 줌 레벨의 n×n 타일을 합성해 구면 위에 얹는 메쉬. 로드된 타일이 하나도 없으면 null. */
async function buildPatch(lat, lon, zoom, n, renderOrder, maxAnisotropy) {
  const x0 = Math.floor(lonToX(lon, zoom)) - Math.floor(n / 2);
  const y0 = Math.floor(latToY(lat, zoom)) - Math.floor(n / 2);
  const max = 2 ** zoom;
  const jobs = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const tx = ((x0 + i) % max + max) % max, ty = y0 + j;
    jobs.push(ty < 0 || ty >= max ? Promise.resolve(null) : loadTile(zoom, tx, ty, 12000));
  }
  const tiles = await Promise.all(jobs);
  if (!tiles.some(Boolean)) return null;

  const size = n * 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  tiles.forEach((img, k) => img && ctx.drawImage(img, (k % n) * 256, Math.floor(k / n) * 256));
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

  const seg = 32, pos = [], uv = [], idx = [];
  const r = 1 + 0.00015 * renderOrder;
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
    map: tex, transparent: true, depthWrite: false, roughness: 1, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: -renderOrder, polygonOffsetUnits: -renderOrder,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = renderOrder;
  return mesh;
}

// 넓은 범위(저해상도) → 좁은 범위(고해상도) 순으로 겹친다
const LEVELS = [
  { zoom: 7, n: 5 },
  { zoom: 9, n: 5 },
  { zoom: 11, n: 5 },
];

export async function buildAirportPatches(lat, lon, maxAnisotropy) {
  const meshes = await Promise.all(LEVELS.map((l, i) => buildPatch(lat, lon, l.zoom, l.n, i + 1, maxAnisotropy)));
  return meshes.filter(Boolean);
}
