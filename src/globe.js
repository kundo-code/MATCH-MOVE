import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { latLonToVec, buildArc, buildFlightPath, buildGroundTrack, bearingDeg, greatCircleKm, GROUND_R } from './flight.js';
import { buildPlane } from './plane.js';
import { buildAirportPatches } from './satellite.js';

const D2R = Math.PI / 180;
const VFOV = 35;
const TAN_HALF = Math.tan((VFOV / 2) * D2R);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const smoother = (t) => { t = clamp(t, 0, 1); return t * t * t * (t * (t * 6 - 15) + 10); };
const lerpAngle = (a, b, t) => a + (((b - a + 540) % 360) - 180) * t;

// 타임라인 구성 (0~1). 비행은 FLY_START~FLY_END, 줌인은 비행 진행률이 ZOOM_FROM을 넘는 시점부터.
// touchdown은 비행 구간(flyStart~flyEnd) 중 90% 지점, 이후 지상 활주하며 정지.
export const TIMELINE = { intro: 0.2, flyStart: 0.12, flyEnd: 0.95, zoomFrom: 0.68, touchdown: 0.9 };

function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);

/** 지표면 한 점 기준 동·북 접선 벡터 */
function localFrame(c) {
  const n = new THREE.Vector3(0, 1, 0).addScaledVector(c, -c.y).normalize();
  if (!isFinite(n.x) || n.lengthSq() < 0.5) n.set(0, 0, -1);
  const e = new THREE.Vector3().crossVectors(n, c).normalize();
  return { n, e };
}

function slerpV(a, b, t) {
  const dot = clamp(a.dot(b), -1, 1);
  const om = Math.acos(dot);
  if (om < 1e-6) return a.clone();
  const s = Math.sin(om);
  return a.clone().multiplyScalar(Math.sin((1 - t) * om) / s).addScaledVector(b, Math.sin(t * om) / s);
}

export class GlobeScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setClearColor(0x02030a, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(VFOV, 16 / 9, 0.001, 100);
    this.maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    this.flight = null;
    this.patches = new Map();
    this.options = { borders: true, clouds: true, hdTiles: true, countryLabels: true, markers3d: false, cardShown: true, mapZoom: 1, mapRotate: 0, mapTilt: 38, globeIntro: false };
    this.size = { w: 1280, h: 720 };
    this.#buildStatic();
  }

  #buildStatic() {
    const { scene } = this;
    const loader = new THREE.TextureLoader();
    const load = (url) => new Promise((res, rej) => loader.load(url, res, undefined, rej));
    this.ready = Promise.all([load('textures/earth.jpg'), load('textures/clouds.png'), fetch('data/countries.geojson').then((r) => r.json())])
      .then(([earth, clouds, geo]) => {
        earth.colorSpace = THREE.SRGBColorSpace;
        earth.anisotropy = this.maxAniso;
        clouds.colorSpace = THREE.SRGBColorSpace;
        this.earthMat.map = earth;
        this.earthMat.needsUpdate = true;
        this.cloudMat.map = clouds;
        this.cloudMat.needsUpdate = true;
        this.geo = geo;
        this.#buildBorders(geo);
      });

    this.earthMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    this.earth = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 96), this.earthMat);
    scene.add(this.earth);

    this.cloudMat = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.55, depthWrite: false, roughness: 1 });
    this.clouds = new THREE.Mesh(new THREE.SphereGeometry(1.006, 96, 72), this.cloudMat);
    scene.add(this.clouds);

    this.atmoMat = new THREE.ShaderMaterial({
      transparent: true, side: THREE.BackSide, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { fade: { value: 1 } },
      vertexShader: 'varying vec3 vN; void main(){ vN = normalize(normalMatrix*normal); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0);} ',
      fragmentShader: 'varying vec3 vN; uniform float fade; void main(){ float i = pow(max(0.0, 0.68 - dot(vN, vec3(0.0,0.0,1.0))), 3.2); gl_FragColor = vec4(0.28,0.58,1.0,1.0) * i * 1.6 * fade; }',
    });
    scene.add(new THREE.Mesh(new THREE.SphereGeometry(1.07, 96, 72), this.atmoMat));

    // 별 (시드 고정 → 프레임마다 동일)
    const r = rng(7), p = [];
    for (let i = 0; i < 2600; i++) {
      const u = r() * 2 - 1, th = r() * Math.PI * 2, s = Math.sqrt(1 - u * u);
      p.push(40 * s * Math.cos(th), 40 * u, 40 * s * Math.sin(th));
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    scene.add(new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 1.4, sizeAttenuation: false, transparent: true, opacity: 0.8, depthWrite: false })));

    scene.add(new THREE.AmbientLight(0xbfd3ff, 0.9));
    this.sun = new THREE.DirectionalLight(0xffffff, 2.4);
    scene.add(this.sun, this.sun.target);

    this.dynamic = new THREE.Group();
    scene.add(this.dynamic);
    this.lineMats = [];
  }

  #lineMat(opts) {
    const m = new LineMaterial({ worldUnits: false, transparent: true, depthWrite: false, ...opts });
    m.userData.basePx = opts.linewidth;
    this.lineMats.push(m);
    return m;
  }

  #buildBorders(geo) {
    const pos = [];
    const addRing = (ring) => {
      for (let i = 0; i < ring.length - 1; i++) {
        pos.push(...latLonToVec(ring[i][1], ring[i][0], 1.0004), ...latLonToVec(ring[i + 1][1], ring[i + 1][0], 1.0004));
      }
    };
    for (const f of geo.features) {
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      for (const poly of polys) for (const ring of poly) addRing(ring);
    }
    const g = new LineSegmentsGeometry();
    g.setPositions(pos);
    this.borderMat = this.#lineMat({ color: 0xffffff, linewidth: 1.1, opacity: 0.5 });
    this.borders = new LineSegments2(g, this.borderMat);
    this.borders.frustumCulled = false;
    this.scene.add(this.borders);
  }

  /** 비행 구성 변경 시 호출 */
  setFlight({ origin, dest, livery, routeColor }) {
    this.flight = { origin, dest, livery, routeColor };
    this.dynamic.clear();
    this.lineMats = this.lineMats.filter((m) => m === this.borderMat);

    const A = latLonToVec(origin.lat, origin.lon), B = latLonToVec(dest.lat, dest.lon);
    this.A = v3(A); this.B = v3(B);
    this.M = this.A.clone().add(this.B).normalize();
    this.chord = this.A.distanceTo(this.B);
    this.routeBearing = bearingDeg(origin, dest);

    const path = buildFlightPath(origin, dest, { segments: 480, lift: 0.1 });
    this.arc = path.pts;
    this.segments = path.pts.length - 1;
    this.theta = path.theta;
    this.pathPhi = path.phi;
    this.rollout = path.rollout;
    this.phiTouch = path.touchdown;
    this.sTouch = path.touchdown / path.phi;

    // 경로선은 위성 타일 패치(renderOrder 1~3)보다 나중에 그려 육지·바다 어디서나 끊김 없이 보이게 한다
    const addLine = (geo, mat, order, dashed = false) => {
      const line = new Line2(geo, mat);
      if (dashed) line.computeLineDistances();
      line.frustumCulled = false;
      line.renderOrder = order;
      this.dynamic.add(line);
      return line;
    };
    const col = new THREE.Color(routeColor);
    const flat = (pts) => pts.flat();

    // 비행 고도를 따라가는 항공사 색 점선 (전체 경로)
    const full = new LineGeometry(); full.setPositions(flat(this.arc));
    const fullMat = this.#lineMat({ color: col, linewidth: 2.2, opacity: 0.45, dashed: true, dashSize: 0.01, gapSize: 0.01 });
    fullMat.userData.dash = [0.05, 0.03];
    addLine(full, fullMat, 10, true);

    // 귀환 경로: 흰색 점선, 살짝 옆으로 띄운 호
    const backArc = buildArc(dest, origin, { segments: 160, lift: 0.1, groundLift: 0.0002, offset: this.chord * 0.07 });
    const back = new LineGeometry(); back.setPositions(flat(backArc));
    const backMat = this.#lineMat({ color: 0xffffff, linewidth: 1.4, opacity: 0.4, dashed: true, dashSize: 0.01, gapSize: 0.01 });
    backMat.userData.dash = [0.025, 0.04];
    addLine(back, backMat, 10, true);

    // 지나온 궤적: 항공사 색 실선 + 글로우
    this.trailGeo = new LineGeometry(); this.trailGeo.setPositions(flat(this.arc));
    this.trail = addLine(this.trailGeo, this.#lineMat({ color: col, linewidth: 4.2, opacity: 1 }), 11);
    this.trailGlow = addLine(this.trailGeo, this.#lineMat({ color: col, linewidth: 11, opacity: 0.22 }), 11);

    // 출발~도착을 잇는 지표면 직선(대권) — 빨간 점선, 투명도 70%
    const ground = new LineGeometry();
    ground.setPositions(buildGroundTrack(origin, dest).flat());
    const groundMat = this.#lineMat({ color: 0xff3b30, linewidth: 3.2, opacity: 0.7, dashed: true, dashSize: 0.01, gapSize: 0.01 });
    groundMat.userData.dash = [0.045 / 4, 0.03 / 4]; // 점선 간격 1/4
    addLine(ground, groundMat, 12, true);

    this.plane = buildPlane(livery);
    this.dynamic.add(this.plane);

    this.markers = [[origin, 0x4ade80], [dest, 0xffb020]].map(([ap, color]) => {
      const n = v3(latLonToVec(ap.lat, ap.lon));
      const grp = new THREE.Group();
      const mk = (geo, opacity) => new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
      const dot = mk(new THREE.CircleGeometry(0.22, 32), 0.95);
      const ring = mk(new THREE.RingGeometry(0.62, 0.72, 48), 0.9);
      const pulse = mk(new THREE.RingGeometry(0.9, 1.0, 48), 0.6);
      grp.add(dot, ring, pulse);
      grp.position.copy(n.clone().multiplyScalar(1.0003));
      // XY 평면을 접면에 맞춤 (+z → 법선)
      grp.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
      grp.userData = { pulse, n };
      this.dynamic.add(grp);
      return grp;
    });

    this.#loadPatches();
  }

  async #loadPatches() {
    this.patchGroup?.removeFromParent();
    this.patchGroup = new THREE.Group();
    this.scene.add(this.patchGroup);
    const f = this.flight;
    const group = this.patchGroup;
    const jobs = [f.origin, f.dest].map(async (ap) => {
      const key = `${ap.lat},${ap.lon}`;
      if (!this.patches.has(key)) this.patches.set(key, buildAirportPatches(ap.lat, ap.lon, this.maxAniso).catch(() => []));
      return this.patches.get(key);
    });
    this.tilesStatus = 'loading';
    this.tilesPromise = Promise.all(jobs).then((sets) => {
      if (this.patchGroup !== group) return 0;
      let count = 0;
      for (const s of sets) for (const m of s) { group.add(m.clone()); count++; }
      this.tilesStatus = count ? 'ok' : 'none';
      this.hasTiles = count > 0;
      return count;
    });
    return this.tilesPromise;
  }

  setOptions(o) {
    Object.assign(this.options, o);
  }

  resize(w, h) {
    if (this.size.w === w && this.size.h === h && this.camera.aspect === w / h && this.sized) return;
    this.sized = true;
    this.size = { w, h };
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ── 타임라인 ────────────────────────────────────────────────────────
  /** 지구 전체 인트로를 쓰면 이륙이 늦게, 아니면 설정한 지도 범위에서 곧바로 시작 */
  #flyStart() { return this.options.globeIntro ? TIMELINE.flyStart : 0.06; }

  /** 시간 → 경로 진행률 s(0~1). 이륙 가속 → 순항 → 접지 후 감속 활주 */
  flightProgress(t) {
    const { flyEnd, touchdown } = TIMELINE;
    const flyStart = this.#flyStart();
    const p = clamp((t - flyStart) / (flyEnd - flyStart), 0, 1);
    let phi;
    if (p <= touchdown) {
      const w = p / touchdown, a = 0.15;
      // 속도: 0에서 부드럽게 가속해 순항속도 유지
      const integral = w < a ? a * ((w / a) ** 3 - (w / a) ** 4 / 2) : a / 2 + (w - a);
      phi = this.phiTouch * (integral / (1 - a / 2));
    } else {
      const q = (p - touchdown) / (1 - touchdown);
      phi = this.phiTouch + this.rollout * (1 - (1 - q) ** 2);
    }
    return phi / this.pathPhi;
  }

  #pointAt(s) {
    const f = clamp(s, 0, 1) * this.segments;
    const i = Math.min(this.segments - 1, Math.floor(f)), k = f - i;
    const a = this.arc[i], b = this.arc[i + 1];
    return new THREE.Vector3(lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k));
  }

  #tangentAt(s) {
    const e = 1 / this.segments;
    return this.#pointAt(clamp(s + e, 0, 1)).sub(this.#pointAt(clamp(s - e, 0, 1))).normalize();
  }

  #bearingOfTangent(pos, tan) {
    const c = pos.clone().normalize();
    const { n, e } = localFrame(c);
    return (Math.atan2(tan.dot(e), tan.dot(n)) / D2R + 360) % 360;
  }

  /** 가로 화면에서는 비행기가 좌→우(또는 우→좌)로 가로지르게, 세로 화면에서는 위로 향하게 */
  #fitHeading(aspect) {
    const b = this.routeBearing;
    if (aspect < 1) return b;
    return Math.sin(b * D2R) >= 0 ? (b - 90 + 360) % 360 : (b + 90) % 360;
  }

  #cameraState(t, aspect) {
    const { intro, zoomFrom } = TIMELINE;
    const s = this.flightProgress(t);
    const p = clamp((t - this.#flyStart()) / (TIMELINE.flyEnd - this.#flyStart()), 0, 1);
    const tiltFit = this.options.mapTilt;
    // 화면 회전: 기본 배치(경로가 가로로 지나감)에 사용자가 지정한 회전각을 더한다
    const psiFit = (this.#fitHeading(aspect) + this.options.mapRotate + 360) % 360;

    // 경로 전체가 한 화면에 들어오는 거리
    // 경로가 화면에서 놓이는 각도에 따라 가로·세로로 필요한 폭이 달라진다 (회전해도 두 공항이 화면 안에 들어오도록)
    const rel = (this.routeBearing - psiFit) * D2R;
    const ex = this.chord * Math.abs(Math.sin(rel));
    const ey = this.chord * Math.abs(Math.cos(rel)) * Math.cos(tiltFit * D2R);
    const margin = (aspect < 1 ? 2.0 : 1.7) / 2;
    // 사용자가 지정한 지도 확대/축소 배율(mapZoom, 1 = 두 공항이 딱 들어오는 크기)
    const dFit = clamp(Math.max((ex * margin) / (TAN_HALF * aspect), (ey * margin) / TAN_HALF, 0.02) / this.options.mapZoom, 0.03, 3.2);
    // 기본: 사용자가 설정한 지도 범위(dFit)에서 바로 시작. 인트로 옵션을 켜면 지구 전체에서 내려온다
    const dOver = this.options.globeIntro ? Math.max(2.5, dFit * 1.5) : dFit;
    const dEnd = 0.03;

    // 1) 전체 지구 → 경로 전체 샷
    const a = this.options.globeIntro ? smoother(t / intro) : 1;
    let C = this.M.clone();
    let dist = Math.exp(lerp(Math.log(dOver), Math.log(dFit), a));
    let tilt = lerp(0, tiltFit, a);
    let psi = lerpAngle(0, psiFit, a);

    // 2) 비행기를 느슨하게 따라가기
    const planePos = this.#pointAt(s).normalize();
    const f = smooth(p / 0.7) * a;
    C = slerpV(C, planePos, 0.55 * f);
    dist *= 1 - 0.18 * f;

    // 3) 도착 직전 공항으로 줌인
    const z = smoother((p - zoomFrom) / (1 - zoomFrom));
    const arriveBearing = this.#bearingOfTangent(this.#pointAt(this.sTouch), this.#tangentAt(this.sTouch));
    if (z > 0) {
      C = slerpV(C, this.B, z);
      dist = Math.exp(lerp(Math.log(dist), Math.log(dEnd), z));
      tilt = lerp(tilt, 52, z);
      // 정면 뒤가 아니라 비스듬히 보면 기체가 훨씬 잘 보인다
      psi = lerpAngle(psi, (arriveBearing - 42 + 360) % 360, z);
    }
    return { C, dist, tilt, psi, z, p, s };
  }

  /** t(0~1)에 해당하는 장면을 렌더하고 HUD용 투영 정보를 반환 */
  renderAt(t, seconds = 0) {
    const { w, h } = this.size;
    const cam = this.camera;
    const st = this.#cameraState(t, w / h);
    const { n, e } = localFrame(st.C);
    const psi = st.psi * D2R;
    const head = n.clone().multiplyScalar(Math.cos(psi)).addScaledVector(e, Math.sin(psi));
    const th = st.tilt * D2R;
    const dir = st.C.clone().multiplyScalar(Math.cos(th)).addScaledVector(head, -Math.sin(th));
    cam.position.copy(st.C).addScaledVector(dir, st.dist);
    cam.up.copy(head);
    cam.lookAt(st.C);
    const height = Math.max(1e-4, cam.position.length() - 1);
    // 하단 정보 카드에 가리지 않도록 장면을 위로 살짝 올린다
    cam.setViewOffset(w, h, 0, this.options.cardShown ? Math.round(h * (w < h ? 0.04 : 0.02)) : 0, w, h);
    cam.near = Math.max(0.0008, Math.min(0.5, height * 0.25));
    cam.far = 120;
    cam.updateProjectionMatrix();

    // 조명은 카메라 기준으로 고정 → 어느 각도에서도 낮 면이 보이고 가장자리만 어두워짐
    this.sun.position.copy(cam.position).addScaledVector(head, 0.4).addScaledVector(st.C, 0.3).multiplyScalar(1.0);
    this.sun.target.position.copy(st.C);

    const dCam = cam.position.length();
    this.atmoMat.uniforms.fade.value = smooth((height - 0.02) / 0.25);
    this.cloudMat.opacity = 0.5 * smooth((height - 0.06) / 0.35);
    this.clouds.visible = this.options.clouds && height > 0.06;
    this.clouds.rotation.y = seconds * 0.004;
    if (this.borders) this.borders.visible = this.options.borders;
    if (this.patchGroup) this.patchGroup.visible = this.options.hdTiles;

    const scale = h / 1080;
    for (const m of this.lineMats) {
      m.linewidth = m.userData.basePx * Math.max(0.8, scale);
      m.resolution.set(w, h);
      if (m.userData.dash) { m.dashSize = st.dist * m.userData.dash[0]; m.gapSize = st.dist * m.userData.dash[1]; }
    }
    // 가까이 갈수록 국경선은 얇고 흐리게
    if (this.borderMat) this.borderMat.opacity = 0.5 * (1 - 0.7 * smooth((0.3 - height) / 0.25));

    // 비행기
    const planePos = this.#pointAt(st.s);
    const tan = this.#tangentAt(st.s);
    const up = planePos.clone().normalize();
    const pScale = Math.min(0.02, (0.07 + 0.05 * st.z) * st.dist);
    const altitude = planePos.length() - GROUND_R;
    // 바퀴가 지면에 닿도록 기체 중심을 바퀴 길이만큼 띄운다 (지상에서만 적용)
    planePos.addScaledVector(up, 0.105 * pScale * (1 - smooth(altitude / (0.5 * pScale + 1e-6))));
    this.plane.userData.gear.visible = altitude < 0.0025;
    const x = new THREE.Vector3().crossVectors(up, tan).normalize();
    const y = new THREE.Vector3().crossVectors(tan, x).normalize();
    this.plane.matrix.makeBasis(x, y, tan).setPosition(planePos);
    this.plane.matrixAutoUpdate = false;
    this.plane.matrix.scale(new THREE.Vector3(pScale, pScale, pScale));
    this.plane.matrixWorldNeedsUpdate = true;

    // 지나온 궤적
    const count = Math.floor(st.s * this.segments);
    this.trail.visible = this.trailGlow.visible = count >= 1;
    if (count >= 1) this.trailGeo.instanceCount = Math.min(this.segments, count);

    // 마커 (거리에 비례한 크기 + 펄스)
    this.markers.forEach((g, i) => {
      g.visible = this.options.markers3d;
      const base = Math.max(0.0012, Math.min(0.03, st.dist * 0.018));
      const ph = (seconds * 0.8 + i * 0.4) % 1;
      g.scale.setScalar(base);
      g.userData.pulse.scale.setScalar(1 + ph * 1.2);
      g.userData.pulse.material.opacity = 0.6 * (1 - ph);
    });

    this.renderer.render(this.scene, cam);

    // HUD용 투영
    const camPos = cam.position;
    const project = (vec, lift = 0) => {
      const p = vec.clone().normalize().multiplyScalar(1 + lift);
      const visible = vec.clone().normalize().dot(camPos) > 1.0005 * 1;
      const q = p.clone().project(cam);
      return { x: (q.x * 0.5 + 0.5) * w, y: (1 - (q.y * 0.5 + 0.5)) * h, visible: visible && q.z < 1 && q.z > -1 };
    };
    const info = {
      t, seconds, p: st.p, zoom: st.z, dist: st.dist, height,
      origin: project(this.A), dest: project(this.B),
      plane: project(planePos),
      countries: [],
    };
    if (this.geo && this.options.countryLabels && st.dist > 0.12) {
      for (const f of this.geo.features) {
        if (!f.properties.ko || f.properties.lx == null) continue;
        const pr = project(v3(latLonToVec(f.properties.ly, f.properties.lx)));
        if (pr.visible && pr.x > 0 && pr.x < w && pr.y > 0 && pr.y < h) {
          info.countries.push({ ...pr, ko: f.properties.ko, en: f.properties.en, code: f.properties.code, rank: f.properties.rank ?? 5 });
        }
      }
    }
    return info;
  }

  dispose() { this.renderer.dispose(); }
}

export { greatCircleKm };
