// 여객기 3D 모델. 길이 1(기수 +Z), 날개폭 약 0.95. 항공사별 도색은 liveries.js 의 캔버스 텍스처를 입힌다.
import * as THREE from 'three';
import { liveryFor, paintFuselage, paintTail, paintFan, paintShadow } from './liveries.js';

const R = 0.046; // 동체 반지름

function tex(canvas, aniso = 8) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  return t;
}

/** 동체: 둥근 기수, 직선 몸통, 위로 휘어 올라가는 꼬리 */
function fuselageGeometry() {
  const N = 90, M = 56, zN = 0.5, zT = -0.5;
  const pos = [], uv = [], idx = [];
  const prof = (z) => {
    if (z > 0.36) { const t = (z - 0.36) / (zN - 0.36); return { r: R * Math.pow(Math.max(0, 1 - t * t), 0.55), yc: -0.004 * t }; }
    if (z > -0.18) return { r: R, yc: 0 };
    const k = Math.min(1, (-0.18 - z) / 0.32);
    return { r: R * (1 - 0.93 * Math.pow(k, 1.7)), yc: 0.05 * k * k };
  };
  for (let i = 0; i <= N; i++) {
    const z = zN + (zT - zN) * (i / N);
    const { r, yc } = prof(z);
    for (let j = 0; j <= M; j++) {
      const psi = j / M, th = psi * Math.PI * 2;
      pos.push(r * Math.sin(th), yc + r * Math.cos(th), z);
      uv.push((z - zT) / (zN - zT), 1 - psi);
    }
  }
  for (let i = 0; i < N; i++) for (let j = 0; j < M; j++) {
    const a = i * (M + 1) + j, b = a + 1, c = a + M + 1, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** 평면 형상(x, z 좌표 목록)을 얇게 압출한 날개판. */
function slab(points, thick) {
  const sh = new THREE.Shape();
  points.forEach(([x, z], i) => (i ? sh.lineTo(x, -z) : sh.moveTo(x, -z)));
  sh.closePath();
  const g = new THREE.ExtrudeGeometry(sh, { depth: thick, bevelEnabled: true, bevelThickness: thick * 0.25, bevelSize: thick * 0.25, bevelSegments: 1 });
  g.rotateX(-Math.PI / 2);
  g.translate(0, -thick / 2, 0);
  return g;
}

function uvFromBounds(g, key = ['x', 'y']) {
  const p = g.attributes.position;
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i);
    minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y);
  }
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) { uv[i * 2] = (p.getX(i) - minx) / (maxx - minx); uv[i * 2 + 1] = (p.getY(i) - miny) / (maxy - miny); }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

function nacelle(livery, fanTex) {
  const prof = [[0.026, 0.082], [0.031, 0.077], [0.0345, 0.062], [0.0355, 0.0], [0.032, -0.04], [0.022, -0.075], [0.012, -0.095]]
    .map(([r, y]) => new THREE.Vector2(r, y));
  const make = (phiStart, color) => {
    const g = new THREE.LatheGeometry(prof, 28, phiStart, Math.PI);
    g.rotateX(Math.PI / 2);
    return new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.15, side: THREE.DoubleSide }));
  };
  const grp = new THREE.Group();
  grp.add(make(Math.PI / 2, livery.engineTop));      // 위 반쪽
  grp.add(make(-Math.PI / 2, livery.engineBottom));  // 아래 반쪽
  const fan = new THREE.Mesh(new THREE.CircleGeometry(0.0268, 28), new THREE.MeshBasicMaterial({ map: fanTex }));
  fan.position.z = 0.058;
  grp.add(fan);
  // 중앙 콘
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.008, 0.03, 12), new THREE.MeshStandardMaterial({ color: 0xb8bec6, metalness: 0.5, roughness: 0.3 }));
  cone.rotation.x = Math.PI / 2;
  cone.position.z = 0.072;
  grp.add(cone);
  // 후미 노즐
  const noz = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.016, 0.02, 14, 1, true), new THREE.MeshStandardMaterial({ color: 0x555b64, roughness: 0.6, side: THREE.DoubleSide }));
  noz.rotation.x = Math.PI / 2;
  noz.position.z = -0.1;
  grp.add(noz);
  return grp;
}

export function buildPlane(airline) {
  const L = liveryFor(airline);
  const g = new THREE.Group();
  const grey = new THREE.MeshStandardMaterial({ color: L.wing, emissive: L.wing, emissiveIntensity: 0.22, roughness: 0.5, metalness: 0.1, side: THREE.DoubleSide });
  const tipMat = new THREE.MeshStandardMaterial({ color: L.winglet, roughness: 0.4, metalness: 0.15, side: THREE.DoubleSide });

  // 동체
  const bodyTex = tex(paintFuselage(L));
  g.add(new THREE.Mesh(fuselageGeometry(), new THREE.MeshStandardMaterial({ map: bodyTex, emissiveMap: bodyTex, emissive: 0xffffff, emissiveIntensity: 0.28, roughness: 0.36, metalness: 0.05 })));

  // 주날개: 후퇴각 + 상반각 + 윙렛
  const wingPlan = [[0.03, 0.08], [0.47, -0.2], [0.47, -0.255], [0.03, -0.17]];
  for (const side of [1, -1]) {
    const wg = slab(wingPlan, 0.014);
    wg.rotateZ(0.085);
    wg.translate(0, -0.03, 0);
    const w = new THREE.Mesh(wg, grey);
    // 윙렛: 날개 끝에서 위로 휘어 올라간 작은 날개
    const lg = new THREE.ShapeGeometry(new THREE.Shape([new THREE.Vector2(0.2, 0), new THREE.Vector2(0.245, 0.078), new THREE.Vector2(0.285, 0.078), new THREE.Vector2(0.255, 0)]));
    lg.rotateY(Math.PI / 2);
    lg.rotateZ(-0.22);
    lg.translate(0.465, -0.03 + 0.465 * Math.sin(0.085) + 0.007, 0);
    const wlMesh = new THREE.Mesh(lg, tipMat);
    const grp = new THREE.Group();
    grp.add(w, wlMesh);
    grp.scale.x = side;
    g.add(grp);
    // 항법등
    const light = new THREE.Mesh(new THREE.SphereGeometry(0.006, 8, 8), new THREE.MeshBasicMaterial({ color: side > 0 ? 0x2cff6a : 0xff3030 }));
    light.position.set(side * 0.47, -0.03 + 0.47 * Math.sin(0.085) + 0.012, -0.22);
    g.add(light);

    // 엔진 + 파일런
    const eng = nacelle(L, FAN());
    eng.scale.setScalar(0.85);
    eng.position.set(side * 0.16, -0.052, 0.012);
    g.add(eng);
    const pylon = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.034, 0.13), grey);
    pylon.position.set(side * 0.16, -0.03, -0.01);
    g.add(pylon);

    // 수평 꼬리날개
    const sg = slab([[0.02, 0.0], [0.19, -0.1], [0.19, -0.135], [0.02, -0.095]], 0.009);
    sg.rotateZ(0.05);
    sg.translate(0, 0.03, -0.36);
    const st = new THREE.Mesh(sg, grey);
    st.scale.x = side;
    g.add(st);
  }

  // 수직 꼬리날개 (도색 텍스처)
  const fs = new THREE.Shape();
  [[0.27, 0.04], [0.41, 0.26], [0.465, 0.26], [0.475, 0.04]].forEach(([x, y], i) => (i ? fs.lineTo(x, y) : fs.moveTo(x, y)));
  fs.closePath();
  const fin = new THREE.ExtrudeGeometry(fs, { depth: 0.012, bevelEnabled: false });
  uvFromBounds(fin);
  fin.rotateY(Math.PI / 2);
  fin.translate(-0.006, 0.02, 0);
  const finMesh = new THREE.Mesh(fin, new THREE.MeshStandardMaterial({ map: tex(paintTail(L)), emissiveMap: tex(paintTail(L)), emissive: 0xffffff, emissiveIntensity: 0.25, roughness: 0.4, metalness: 0.05, side: THREE.DoubleSide }));
  g.add(finMesh);

  // 날개-동체 페어링
  const fair = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), new THREE.MeshStandardMaterial({ color: L.belly, roughness: 0.45 }));
  fair.scale.set(0.058, 0.03, 0.2);
  fair.position.set(0, -0.037, -0.03);
  g.add(fair);

  // 랜딩기어 (저고도에서만 표시)
  const gear = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a2f3a, roughness: 0.8 });
  const strut = new THREE.MeshStandardMaterial({ color: 0xb9bec6, roughness: 0.4, metalness: 0.5 });
  const gearAt = (x, z, len, wheels, wr) => {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, len, 8), strut);
    leg.position.set(x, -0.04 - len / 2, z);
    gear.add(leg);
    for (const dz of wheels) {
      const w = new THREE.Mesh(new THREE.CylinderGeometry(wr, wr, 0.014, 14), dark);
      w.rotation.z = Math.PI / 2;
      w.position.set(x, -0.04 - len, z + dz);
      gear.add(w);
      if (x !== 0) { const w2 = w.clone(); w2.position.x = x + (x > 0 ? 0.016 : -0.016); gear.add(w2); }
    }
  };
  gearAt(0, 0.3, 0.04, [0], 0.014);
  gearAt(0.1, -0.02, 0.05, [-0.03, 0, 0.03], 0.016);
  gearAt(-0.1, -0.02, 0.05, [-0.03, 0, 0.03], 0.016);
  gear.visible = false;
  g.add(gear);
  g.userData.gear = gear;
  return g;
}

let fanTexture;
function FAN() { return (fanTexture ||= tex(paintFan(), 4)); }

/** 지면에 드리우는 그림자 (지면 접선 평면 위, 기수 +Z) */
export function buildShadow() {
  const t = new THREE.CanvasTexture(paintShadow());
  const g = new THREE.PlaneGeometry(1, 1);
  g.rotateX(-Math.PI / 2);
  g.rotateY(Math.PI); // 텍스처의 위쪽(기수)을 +Z로
  return new THREE.Mesh(g, new THREE.MeshBasicMaterial({
    map: t, transparent: true, opacity: 0.4, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  }));
}
