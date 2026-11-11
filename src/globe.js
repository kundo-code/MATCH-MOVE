import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { latLonToVec, buildFlightPath, buildGroundTrack, bearingDeg, greatCircleKm, GROUND_R } from './flight.js';
import { buildPlane, buildShadow } from './plane.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
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
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(VFOV, 16 / 9, 0.001, 100);
    this.maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    this.flight = null;
    this.patches = new Map();
    this.options = { borders: true, clouds: true, hdTiles: true, countryLabels: true, originTarget: true, destTarget: true, originTargetScale: 0.55, destTargetScale: 0.5, cardShown: true, cardPos: 'bl', mapZoom: 1, mapRotate: 0, mapTilt: 38, panX: 0, panY: 0, planeSize: 1, globeIntro: false, endZoom: 1, endRotate: 0, endTilt: 52, endPanX: 0, endPanY: 0, depth: 0.7, planeShadow: true, timeOfDay: 'studio', cityLights: 1, cloudAmt: 0.5, cloudSpeed: 1, atmoAmt: 1, starAmt: 0.8, highlight: true, highlightAmt: 1, regionLines: true, borderAlpha: 0.5, regionAlpha: 0.35, tileRange: 2, cloudScale: 1, duration: 8, wideStart: false, startView: 'auto' };
    this.size = { w: 1280, h: 720 };
    this.tmpCam = new THREE.PerspectiveCamera(VFOV, 16 / 9, 0.001, 100);
    // 기체에 금속 반사·하이라이트를 주는 환경 맵 (스튜디오 조명)
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.#buildStatic();
  }

  /** 고도 맵(2048×1024) → 4096×2048 탄젠트 공간 노멀맵. 위도가 높을수록 가로 픽셀이 좁아지므로 경사를 보정한다 */
  #buildGlobalNormal(topo) {
    const W = 4096, H = 2048;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.filter = 'blur(1.4px)'; // 업스케일 계단을 풀어 부드러운 경사로
    ctx.drawImage(topo.image, 0, 0, W, H);
    const src = ctx.getImageData(0, 0, W, H).data;
    const h = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) h[i] = src[i * 4];
    const img = ctx.createImageData(W, H);
    const K = 0.2;
    for (let y = 0; y < H; y++) {
      const lat = (0.5 - (y + 0.5) / H) * Math.PI;
      const kx = K / Math.max(0.25, Math.cos(lat));
      const y0 = Math.max(0, y - 1) * W, y1 = Math.min(H - 1, y + 1) * W, row = y * W;
      for (let x = 0; x < W; x++) {
        const xl = x === 0 ? W - 1 : x - 1, xr = x === W - 1 ? 0 : x + 1;
        const gx = (h[row + xr] - h[row + xl]) * 0.5, gy = (h[y1 + x] - h[y0 + x]) * 0.5;
        let nx = -gx * kx, ny = gy * K;
        const l = Math.hypot(nx, ny, 1);
        nx /= l; ny /= l;
        const o = (row + x) * 4;
        img.data[o] = (nx * 0.5 + 0.5) * 255;
        img.data[o + 1] = (ny * 0.5 + 0.5) * 255;
        img.data[o + 2] = (1 / l * 0.5 + 0.5) * 255;
        img.data[o + 3] = 255;
      }
    }
    ctx.filter = 'none';
    ctx.putImageData(img, 0, 0);
    return new THREE.CanvasTexture(c);
  }

  #buildStatic() {
    const { scene } = this;
    const loader = new THREE.TextureLoader();
    const load = (url) => new Promise((res, rej) => loader.load(url, res, undefined, rej));
    this.ready = Promise.all([load('textures/earth.jpg'), load('textures/clouds.png'), fetch('data/countries.geojson').then((r) => r.json()), load('textures/topology.png'), load('textures/water.png'), load('textures/night.png').catch(() => null), fetch('data/regions.json').then((r) => (r.ok ? r.json() : null)).catch(() => null)])
      .then(([earth, clouds, geo, topo, water, night, regions]) => {
        this.regionLinesData = regions;
        earth.colorSpace = THREE.SRGBColorSpace;
        earth.anisotropy = this.maxAniso;
        clouds.colorSpace = THREE.SRGBColorSpace; clouds.anisotropy = this.maxAniso; clouds.generateMipmaps = true;
        this.earthMat.map = earth;
        this.earthMat.normalMap = this.#buildGlobalNormal(topo);
        this.earthMat.normalMap.anisotropy = this.maxAniso;
        this.earthMat.specularMap = water;
        if (night) { night.colorSpace = THREE.SRGBColorSpace; night.anisotropy = this.maxAniso; this.nightU.map.value = night; }
        this.earthMat.needsUpdate = true;
        this.cloudU.map.value = clouds;
        this.geo = geo;
        if (this.selCodes) this.#buildSelectionMask(this.selCodes);
        this.#buildBorders(geo);
      });

    // 야경: 태양이 비추지 않는 쪽에 도시 불빛(NASA Earth at Night 계열 텍스처)을 발광으로 얹는다
    // 선택 국가 강조: 국경 안쪽을 밝히고 국경 가장자리에 음영을 준다 (마스크 텍스처 2장 + 세기)
    const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    blank.needsUpdate = true;
    this.selU = { mask: { value: blank }, blur: { value: blank }, k: { value: 0 } };
    this.cloudShadowU = { value: 0 };
    this.nightU = { map: { value: null }, sunView: { value: new THREE.Vector3(0, 0, 1) }, lights: { value: 0 }, close: { value: 0 } };
    this.earthMat = new THREE.MeshPhongMaterial({ color: 0xffffff, shininess: 70, specular: 0x333b44, normalScale: new THREE.Vector2(1, 1), polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    this.earthMat.onBeforeCompile = (sh) => {
      this.#injectSelection(sh);
      sh.uniforms.cloudMap = this.cloudU.map; sh.uniforms.uCloudShadow = this.cloudShadowU; sh.uniforms.uDetail = this.nightU.close;
      sh.uniforms.nightMap = this.nightU.map; sh.uniforms.uSunView = this.nightU.sunView; sh.uniforms.uLights = this.nightU.lights; sh.uniforms.uClose = this.nightU.close;
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
uniform sampler2D nightMap; uniform vec3 uSunView; uniform float uLights; uniform float uClose;
uniform sampler2D cloudMap; uniform float uCloudShadow; uniform float uDetail;
float mmHash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float mmNoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mmHash(i), mmHash(i + vec2(1.0, 0.0)), f.x), mix(mmHash(i + vec2(0.0, 1.0)), mmHash(i + vec2(1.0, 1.0)), f.x), f.y); }`)
        .replace('#include <map_fragment>', `#include <map_fragment>
#if defined( USE_MAP )
  {
    // 구름 그림자: 구름이 드리운 곳의 지표를 어둡게 (구름 지도를 살짝 비껴 읽는다)
    float cs = texture2D(cloudMap, vMapUv + vec2(0.0042, -0.003)).a;
    diffuseColor.rgb *= 1.0 - uCloudShadow * smoothstep(0.15, 0.85, cs);
    // 가까이서 확대되어 뭉개지는 지표 질감에 잔 결을 더해 선명하게 보이게 한다
    vec2 dq = vMapUv * vec2(4096.0, 2048.0);
    float g = mmNoise(dq * 3.1) * 0.5 + mmNoise(dq * 9.7) * 0.3 + mmNoise(dq * 27.0) * 0.2;
    diffuseColor.rgb *= 1.0 + (g - 0.5) * 0.34 * uDetail;
  }
#endif`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
#if defined( USE_MAP )
  {
    float ndl = dot(normalize(vNormal), uSunView);
    float nf = smoothstep(0.10, -0.24, ndl);
    vec3 nl = texture2D(nightMap, vMapUv).rgb;
    // 가까이서 보면 2048px 텍스처가 뭉개져 보이므로, 대비를 높이고 잔 점 노이즈로 도시 불빛의 알갱이감을 만든다
    vec2 q = vMapUv * vec2(2048.0, 1024.0);
    // 가까이서는 번진 덩어리 대신 점 같은 도시 불빛 알갱이로 표현한다 (밀집 지역일수록 촘촘하고 밝게)
    float nlum = dot(nl, vec3(0.3333));
    float rnd = mmNoise(q * 6.0) * 0.6 + mmNoise(q * 15.0) * 0.4;
    float dotsV = smoothstep(0.56, 0.92, nlum * 1.05 + (rnd - 0.5) * 1.25);
    vec3 dotLit = nl * (0.04 + 1.5 * dotsV) + pow(nl, vec3(2.2)) * 0.22;
    vec3 lit = mix(pow(nl, vec3(1.35)), dotLit, uClose);
    totalEmissiveRadiance += lit * vec3(1.0, 0.8, 0.52) * nf * uLights * mix(2.6, 1.25, uClose);
  }
#endif`);
    };
    this.earth = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 96), this.earthMat);
    scene.add(this.earth);

    // 구름: 구름 지도(알파=밀도) + 3D 노이즈로 가까이서도 솜털 같은 디테일, 태양 쪽은 밝고 반대쪽은 푸른 회색으로 음영,
    // 두꺼운 곳은 하얗고 가장자리는 얇게. 지표에는 구름 그림자가 드리운다(지구 셰이더).
    this.cloudU = { map: { value: null }, sun: { value: new THREE.Vector3(0.5, 0.6, 0.6) }, opacity: { value: 0.5 }, lit: { value: 1 }, scale: { value: 1 }, close: { value: 0 }, cover: { value: 0.5 } };
    this.cloudMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, uniforms: { map: this.cloudU.map, uSun: this.cloudU.sun, uOpacity: this.cloudU.opacity, uLit: this.cloudU.lit, uScale: this.cloudU.scale, uClose: this.cloudU.close, uCover: this.cloudU.cover },
      vertexShader: 'varying vec2 vUv; varying vec3 vN; varying vec3 vObj; void main(){ vUv = uv; vN = normalize(normalMatrix * normal); vObj = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        varying vec2 vUv; varying vec3 vN; varying vec3 vObj;
        uniform sampler2D map; uniform vec3 uSun; uniform float uOpacity, uLit, uScale, uClose, uCover;
        float h3(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
        float n3(vec3 x){ vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(h3(i), h3(i + vec3(1,0,0)), f.x), mix(h3(i + vec3(0,1,0)), h3(i + vec3(1,1,0)), f.x), f.y),
                     mix(mix(h3(i + vec3(0,0,1)), h3(i + vec3(1,0,1)), f.x), mix(h3(i + vec3(0,1,1)), h3(i + vec3(1,1,1)), f.x), f.y), f.z); }
        float fbm(vec3 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * n3(p); p = p * 2.03 + 11.7; a *= 0.5; } return s; }
        void main(){
          float base = texture2D(map, vUv).a;
          // 도메인 워프한 노이즈: 구름 덩어리 안쪽의 결을 만든다. uScale이 작을수록 큰 구름
          vec3 p = vObj * (9.0 / uScale);
          float warp = fbm(p * 0.6);
          float n = fbm(p * 2.2 + warp * 2.5);
          float dens = base * 1.35 + (n - 0.5) * (0.5 + 0.7 * uClose) * smoothstep(0.02, 0.35, base + 0.1);
          dens = smoothstep(0.34 - 0.2 * uCover, 0.84 - 0.2 * uCover, dens + 0.12 * uCover);
          // 조명: 태양 반대쪽(밤)은 어둡고 푸른 회색
          float ndl = dot(normalize(vN), uSun);
          float lit = smoothstep(-0.2, 0.6, ndl) * uLit + (1.0 - uLit) * 0.25;
          // 두께 음영: 태양 쪽으로 조금 옮겨 본 밀도가 더 두꺼우면 그늘이 진다
          float toward = texture2D(map, vUv + vec2(-0.004, 0.0028)).a;
          float shade = clamp((toward - base) * 2.2 + (n - 0.5) * 0.4, 0.0, 0.7);
          vec3 shadowC = vec3(0.50, 0.57, 0.70), sunC = vec3(1.0, 0.99, 0.96);
          vec3 col = mix(shadowC, sunC, lit) * (1.0 - 0.34 * shade);
          col = mix(col * 0.82, col * 1.06, dens);               // 얇은 가장자리는 살짝 탁하게, 두꺼운 중심은 밝게
          gl_FragColor = vec4(col, dens * uOpacity);
        }`,
    });
    this.clouds = new THREE.Mesh(new THREE.SphereGeometry(1.01, 128, 96), this.cloudMat);
    scene.add(this.clouds);

    this.atmoMat = new THREE.ShaderMaterial({
      transparent: true, side: THREE.BackSide, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { fade: { value: 1 } },
      vertexShader: 'varying vec3 vN; void main(){ vN = normalize(normalMatrix*normal); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0);} ',
      fragmentShader: 'varying vec3 vN; uniform float fade; void main(){ float d = 0.68 - dot(vN, vec3(0.0,0.0,1.0)); float i = pow(max(0.0, d), 3.2); float rim = pow(max(0.0, d), 11.0) * 2.2; gl_FragColor = vec4(mix(vec3(0.28,0.58,1.0), vec3(0.62,0.82,1.0), clamp(rim, 0.0, 1.0)), 1.0) * (i * 1.7 + rim) * fade; }',
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
    this.starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 1.4, sizeAttenuation: false, transparent: true, opacity: 0.8, depthWrite: false });
    scene.add(new THREE.Points(sg, this.starMat));

    this.ambient = new THREE.AmbientLight(0xbfd3ff, 0.9);
    scene.add(this.ambient);
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

  /** 강조할 국가 코드 목록(출발국 + 선택한 권역의 국가들 또는 선택한 도착 국가). 바로 반영된다 */
  setHighlightCodes(codes) {
    this.selCodes = [...new Set(codes)];
    this.#buildSelectionMask(this.selCodes);
  }

  /** 선택 국가 강조 셰이더 조각을 지구·위성 패치 머티리얼에 주입한다 */
  #injectSelection(sh) {
    sh.uniforms.selMask = this.selU.mask; sh.uniforms.selBlur = this.selU.blur; sh.uniforms.uSel = this.selU.k;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSelPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSelPos = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSelPos; uniform sampler2D selMask; uniform sampler2D selBlur; uniform float uSel;')
      .replace('#include <map_fragment>', `#include <map_fragment>
  if (uSel > 0.001) {
    vec3 sp = normalize(vSelPos);
    vec2 suv = vec2(atan(-sp.z, sp.x) / 6.2831853 + 0.5, asin(clamp(sp.y, -1.0, 1.0)) / 3.1415927 + 0.5);
    float inside = texture2D(selMask, suv).r;
    float blurV = texture2D(selBlur, suv).r;
    // 빛(북서쪽)을 향한 경계는 밝게, 반대쪽 경계와 그 바깥은 어둡게 → 선택 국가가 지도에서 솟아오른 것처럼 보인다
    vec2 L = vec2(-0.7, 0.7) * 0.0030;
    float bevel = clamp((texture2D(selBlur, suv - L).r - texture2D(selBlur, suv + L).r) * 2.4, -1.0, 1.0);
    float edgeIn = smoothstep(1.0, 0.35, blurV) * inside;
    vec3 c = diffuseColor.rgb;
    float lum = dot(c, vec3(0.299, 0.587, 0.114));
    vec3 lifted = c * 1.7 + vec3(0.06, 0.065, 0.05) + c * lum * 0.45;             // 선택 영역: 밝고 선명하게
    vec3 dimmed = mix(c, vec3(lum), 0.22 * uSel) * (1.0 - 0.2 * uSel);          // 주변 땅·바다: 한 톤만 가라앉혀 물러나게 (예전보다 밝게)
    c = mix(dimmed, lifted, inside * clamp(uSel, 0.0, 1.5));
    c *= 1.0 + 0.55 * max(bevel, 0.0) * inside * uSel;                             // 빛 받는 안쪽 가장자리 하이라이트
    c *= 1.0 - 0.38 * max(-bevel, 0.0) * inside * uSel;                            // 반대쪽 안쪽 가장자리 음영
    c *= 1.0 - 0.34 * edgeIn * uSel;                                               // 국경선 안쪽으로 번지는 그늘
    c *= 1.0 - 0.55 * max(-bevel, 0.0) * (1.0 - inside) * uSel;                    // 선택 영역이 드리우는 바깥 그림자
    diffuseColor.rgb = c;
  }`);
  }

  /** 선택한 국가들의 영역 마스크(등장방형 텍스처). 안쪽 1 / 바깥 0, 블러 버전은 경계 거리 계산용 */
  #buildSelectionMask(codes) {
    const key = [...codes].sort().join(',');
    if (!this.geo || key === this.selKey) return;
    this.selKey = key;
    this.#buildSelectedBorders(codes);
    const W = 4096, H = 2048;
    const draw = (cv, w, h, blurPx) => {
      cv.width = w; cv.height = h;
      const c = cv.getContext('2d');
      c.fillStyle = '#000'; c.fillRect(0, 0, w, h);
      c.fillStyle = '#fff';
      if (blurPx) c.filter = `blur(${blurPx}px)`;
      for (const f of this.geo.features) {
        if (!codes.includes(f.properties.code)) continue;
        const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
        for (const poly of polys) {
          c.beginPath();
          for (const ring of poly) ring.forEach(([lon, lat], i) => {
            const px = ((lon + 180) / 360) * w, py = ((90 - lat) / 180) * h;
            i ? c.lineTo(px, py) : c.moveTo(px, py);
          });
          c.fill('evenodd');
        }
      }
      return cv;
    };
    const mk = (cv) => { const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.NoColorSpace; t.anisotropy = this.maxAniso; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; return t; };
    const old = [this.selU.mask.value, this.selU.blur.value];
    this.selU.mask.value = mk(draw(document.createElement('canvas'), W, H, 0));
    this.selU.blur.value = mk(draw(document.createElement('canvas'), 2048, 1024, 5));
    for (const t of old) if (t && t.image && t.image.width > 1) t.dispose();
  }

  /**
   * 선분 좌표(x1 y1 z1 x2 y2 z2 …)를 약 20°×20° 구역으로 나눠 구역별 LineSegments2로 만든다.
   * 전 세계 국경선(약 10만 선분)을 한 덩어리로 그리면 선 하나가 삼각형 여러 개라 GPU 부담이 커서 장면이 끊기므로,
   * 화면에 보이는 구역만 그리도록(#cullChunks) 쪼갠다.
   */
  #makeLineChunks(pos, mat, renderOrder = 0) {
    const cell = (x, y, z) => {
      const lon = Math.atan2(-z, x) / D2R, lat = Math.asin(clamp(y, -1, 1)) / D2R;
      return `${Math.floor((lon + 180) / 20)}_${Math.floor((lat + 90) / 20)}`;
    };
    const buckets = new Map();
    for (let i = 0; i < pos.length; i += 6) {
      const k = cell((pos[i] + pos[i + 3]) / 2, (pos[i + 1] + pos[i + 4]) / 2, (pos[i + 2] + pos[i + 5]) / 2);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(pos[i], pos[i + 1], pos[i + 2], pos[i + 3], pos[i + 4], pos[i + 5]);
    }
    const chunks = [];
    for (const arr of buckets.values()) {
      const g = new LineSegmentsGeometry();
      g.setPositions(arr);
      g.computeBoundingSphere();
      const mesh = new LineSegments2(g, mat);
      mesh.renderOrder = renderOrder;
      mesh.frustumCulled = false; // 구역 가시성은 #cullChunks에서 직접 판단
      const c = g.boundingSphere.center.clone();
      const len = c.length() || 1;
      // 구역 중심 방향과 각 반경(라디안): 구면 위 선분들이 퍼진 정도
      const dir = c.clone().divideScalar(len);
      let r = 0;
      for (let i = 0; i < arr.length; i += 3) r = Math.max(r, Math.acos(clamp(dir.x * arr[i] / Math.hypot(arr[i], arr[i + 1], arr[i + 2]) + dir.y * arr[i + 1] / Math.hypot(arr[i], arr[i + 1], arr[i + 2]) + dir.z * arr[i + 2] / Math.hypot(arr[i], arr[i + 1], arr[i + 2]), -1, 1)));
      this.scene.add(mesh);
      chunks.push({ mesh, dir, r });
    }
    return chunks;
  }

  /** 카메라에서 수평선 너머(지구 뒤편)이거나 시야각 밖인 구역은 그리지 않는다 */
  #cullChunks(chunks, on, camPos, cam) {
    if (!chunks) return;
    const d = camPos.length(), camDir = camPos.clone().divideScalar(d);
    const horizon = Math.acos(clamp(1 / d, -1, 1));
    const half = Math.atan(TAN_HALF * Math.max(1, cam.aspect)) + 0.12; // 시야 반각(+여유)
    const look = this.camLookDir || camDir;
    for (const { mesh, dir, r } of chunks) {
      const ang = Math.acos(clamp(dir.dot(camDir), -1, 1));
      let vis = on && ang - r < horizon;
      if (vis && d < 1.6) { // 가까이서는 화면 방향 밖의 구역도 걸러낸다
        const toChunk = dir.clone().multiplyScalar(1).sub(camPos).normalize();
        vis = Math.acos(clamp(toChunk.dot(look), -1, 1)) < half + r * 1.5 + 0.1;
      }
      mesh.visible = vis;
    }
  }

  #buildBorders(geo) {
    const pos = [];
    const addRing = (ring) => {
      let last = ring[0];
      for (let i = 1; i < ring.length; i++) {
        const p = ring[i];
        // 0.02° 미만의 아주 짧은 구간은 건너뛰어 선분 수를 줄인다 (고리의 끝점은 유지)
        if (i < ring.length - 1 && Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1]) < 0.02) continue;
        pos.push(...latLonToVec(last[1], last[0], 1.0004), ...latLonToVec(p[1], p[0], 1.0004));
        last = p;
      }
    };
    for (const f of geo.features) {
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      for (const poly of polys) for (const ring of poly) addRing(ring);
    }
    this.borderMat = this.#lineMat({ color: 0xffffff, linewidth: 1.1, opacity: 0.5 });
    this.borderChunks = this.#makeLineChunks(pos, this.borderMat);
    this.borderSelMat = this.#lineMat({ color: 0xffffff, linewidth: 1.35, opacity: 0.95 });
    this.regionMat = this.#lineMat({ color: 0xd7e6ff, linewidth: 0.9, opacity: 0.3 });
    if (this.regionLinesData) this.#buildRegionLines();
  }

  /** 지역(시·도·성) 구분선 — public/data/regions.json (npm run data:regions) */
  #buildRegionLines() {
    if (!this.regionLinesData || !this.regionMat || this.regionChunks) return;
    const pos = [];
    for (const flat of this.regionLinesData) {
      for (let i = 0; i + 3 < flat.length; i += 2) pos.push(...latLonToVec(flat[i + 1], flat[i], 1.0004), ...latLonToVec(flat[i + 3], flat[i + 2], 1.0004));
    }
    this.regionChunks = this.#makeLineChunks(pos, this.regionMat, 1);
  }

  /** 선택(출발·도착) 국가의 국경선만 따로 굵고 선명하게 */
  #buildSelectedBorders(codes) {
    if (!this.geo) return;
    const pos = [];
    for (const f of this.geo.features) {
      if (!codes.includes(f.properties.code)) continue;
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      for (const poly of polys) for (const ring of poly) {
        for (let i = 0; i < ring.length - 1; i++) pos.push(...latLonToVec(ring[i][1], ring[i][0], 1.0005), ...latLonToVec(ring[i + 1][1], ring[i + 1][0], 1.0005));
      }
    }
    for (const c of this.selBorderChunks || []) { this.scene.remove(c.mesh); c.mesh.geometry.dispose(); }
    this.selBorderChunks = pos.length ? this.#makeLineChunks(pos, this.borderSelMat, 2) : [];
  }

  /** 비행 구성 변경 시 호출 */
  setFlight({ origin, dest, livery, routeColor }) {
    this.flight = { origin, dest, livery, routeColor };
    this.distCache = null;
    this.dynamic.clear();
    this.lineMats = this.lineMats.filter((m) => m === this.borderMat || m === this.borderSelMat || m === this.regionMat);

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
    this.maxAlt = Math.max(1e-6, ...path.pts.map((q) => Math.hypot(q[0], q[1], q[2]) - GROUND_R));

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

    // 기체는 붉은 타겟(renderOrder 9)보다 나중에 그려 항상 타겟 위에 보이게 한다 (재질을 반투명 패스로)
    this.plane = buildPlane(livery);
    this.plane.traverse((o) => { if (o.material) { for (const m of [].concat(o.material)) m.transparent = true; } });
    // 날개·엔진·기어는 하위 Group이라 각각 renderOrder를 지정해야 타겟(9) 뒤에 그려진다
    this.plane.traverse((o) => { if (o.isGroup) o.renderOrder = 20; });
    // 환경 반사(금속 느낌)와 명암 대비를 입체감 강도에 맞춰 조절하기 위해 재질을 모아 둔다
    this.planeMats = [];
    this.plane.traverse((o) => {
      for (const m of [].concat(o.material || [])) {
        if (m.isMeshStandardMaterial) { m.envMap = this.envTex; this.planeMats.push({ m, emissive: m.emissiveIntensity }); }
      }
    });
    this.dynamic.add(this.plane);
    this.shadow = buildShadow();
    this.shadow.renderOrder = 6;
    this.dynamic.add(this.shadow);

    // 출발·도착 지점의 붉은 타겟 (카메라를 향하는 원형, 화면상 크기 일정)
    this.targets = [[origin, 'originTarget'], [dest, 'destTarget']].map(([ap, opt]) => {
      const grp = this.#buildTarget();
      Object.assign(grp.userData, { n: v3(latLonToVec(ap.lat, ap.lon)), opt });
      this.dynamic.add(grp);
      return grp;
    });

    this.#loadPatches();
  }

  #buildTarget() {
    const grp = new THREE.Group();
    grp.renderOrder = 9;
    const red = (opacity) => new THREE.MeshBasicMaterial({ color: 0xff3b30, transparent: true, opacity, depthTest: false, depthWrite: false });
    const dark = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthTest: false, depthWrite: false });
    const add = (geo, mat, x = 0, y = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, 0); grp.add(m); return m; };
    add(new THREE.RingGeometry(0.88, 1.12, 64), dark);
    add(new THREE.RingGeometry(0.933, 1.067, 64), red(1));
    const detail = red(1);
    add(new THREE.RingGeometry(0.46, 0.54, 48), detail);
    add(new THREE.CircleGeometry(0.15, 24), detail);
    for (const [x, y, rot] of [[1.05, 0, 0], [-1.05, 0, 0], [0, 1.05, 1], [0, -1.05, 1]]) {
      const t = add(new THREE.PlaneGeometry(0.66, 0.125), detail, x, y);
      if (rot) t.rotation.z = Math.PI / 2;
    }
    const pulse = add(new THREE.RingGeometry(0.96, 1.04, 64), red(0.55));
    grp.userData = { detail, pulse };
    return grp;
  }

  async #loadPatches() {
    this.patchGroup?.removeFromParent();
    this.patchGroup = new THREE.Group();
    this.scene.add(this.patchGroup);
    const f = this.flight;
    const group = this.patchGroup;
    const jobs = [[f.origin, 'origin'], [f.dest, 'dest']].map(async ([ap, role]) => {
      const range = this.options.tileRange ?? 1;
      const key = `${role}:${ap.lat},${ap.lon}:${range}`;
      if (!this.patches.has(key)) this.patches.set(key, buildAirportPatches(ap.lat, ap.lon, this.maxAniso, role, range).catch(() => []));
      return this.patches.get(key);
    });
    this.tilesStatus = 'loading';
    this.tilesPromise = Promise.all(jobs).then((sets) => {
      if (this.patchGroup !== group) return 0;
      let count = 0;
      for (const s of sets) for (const m of s) {
        if (!m.material.userData.selHooked) {
          m.material.userData.selHooked = true;
          const prev = m.material.onBeforeCompile;
          m.material.onBeforeCompile = (sh, r) => { prev?.call(m.material, sh, r); this.#injectSelection(sh); };
          m.material.needsUpdate = true;
        }
        group.add(m.clone()); count++;
      }
      this.tilesStatus = count ? 'ok' : 'none';
      this.hasTiles = count > 0;
      return count;
    });
    return this.tilesPromise;
  }

  setOptions(o) {
    Object.assign(this.options, o);
  }

  /** 고해상도 위성 타일 범위(1~4)를 바꾸고 다시 불러온다 */
  setTileRange(r) {
    this.options.tileRange = r;
    if (this.flight) return this.#loadPatches();
  }

  /** 미리보기 렌더 해상도 배율(0.5~1). 논리 좌표(HUD 투영)는 그대로 두고 그려지는 픽셀 수만 줄여 끊김을 막는다 */
  setRenderScale(s) {
    s = clamp(s, 0.4, 1);
    if (s === (this.renderScale ?? 1)) return;
    this.renderScale = s;
    this.renderer.setPixelRatio(s);
    this.renderer.setSize(this.size.w, this.size.h, false);
  }

  resize(w, h) {
    if (this.size.w === w && this.size.h === h && this.camera.aspect === w / h && this.sized) return;
    this.sized = true;
    this.size = { w, h };
    this.renderer.setPixelRatio(this.renderScale ?? 1);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ── 타임라인 ────────────────────────────────────────────────────────
  /** 지구 전체 인트로를 쓰면 이륙이 늦게, 아니면 설정한 지도 범위에서 곧바로 시작 */
  /** 도착(정지) 시점: 영상 길이에 맞춘다 (끝 5%는 도착 장면 유지) */
  #flyEnd() { return TIMELINE.flyEnd; }

  #flyStart() { return this.options.globeIntro ? TIMELINE.flyStart : 0.06; }

  /** 시간 → 경로 진행률 s(0~1). 이륙 가속 → 순항 → 접지 후 감속 활주 */
  flightProgress(t) {
    const { touchdown } = TIMELINE;
    const flyEnd = this.#flyEnd();
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

  /** 사운드용 비행 상태: p(비행 진행 0~1), altN(최고 고도 대비 0~1), 접지 여부 */
  flightState(t) {
    const s = this.flightProgress(t);
    const alt = this.#pointAt(s).length() - GROUND_R;
    const p = clamp((t - this.#flyStart()) / (this.#flyEnd() - this.#flyStart()), 0, 1);
    return { t, s, p, altN: clamp(alt / this.maxAlt, 0, 1), touchdown: s >= this.sTouch - 1e-6 };
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

  /** 주어진 카메라 상태에서 월드 점들의 NDC(-1~1) 좌표 */
  #ndc(points, C, dist, tilt, psi, aspect) {
    const cam = this.tmpCam;
    const { n, e } = localFrame(C);
    const ps = psi * D2R, th = tilt * D2R;
    const head = n.clone().multiplyScalar(Math.cos(ps)).addScaledVector(e, Math.sin(ps));
    const dir = C.clone().multiplyScalar(Math.cos(th)).addScaledVector(head, -Math.sin(th));
    cam.aspect = aspect;
    cam.near = 0.0005; cam.far = 100;
    cam.updateProjectionMatrix();
    cam.position.copy(C).addScaledVector(dir, dist);
    cam.up.copy(head);
    cam.lookAt(C);
    cam.updateMatrixWorld(true);
    return points.map((v) => v.clone().project(cam));
  }

  /**
   * 카메라 거리 곡선: 줌인이 '줌인 → 줌아웃 → 다시 줌인'으로 출렁이지 않고 도착 지점까지 한 방향으로 서서히 이어지게 한다.
   *  1) 장면마다 필요한 거리(원래 계산값, 기체·도착지·UI가 화면에 들어오는 최소 거리)를 시간축으로 촘촘히 샘플링
   *  2) 로그 거리의 '위쪽 오목 포락선'(upper concave hull)을 잡는다 → 항상 원래 값 이상이라 화면 밖으로 잘리지 않고,
   *     줌인 속도가 줄었다 늘었다 하지 않고 점점 일정하게 빨라지는 한 방향 곡선이 된다
   *  3) 과거 방향 가우시안으로 부드럽게 만든다(과거 값은 항상 더 크므로 여전히 원래 값 이상) → 속도 꺾임이 사라진다
   *  4) 마지막 15%는 포락선 값으로 수렴시켜, 도착 거리(도착 확대 설정)에 정확히 도달한다
   */
  #distCurve(aspect) {
    const o = this.options;
    const key = [this.flight?.origin.lat, this.flight?.origin.lon, this.flight?.dest.lat, this.flight?.dest.lon, aspect.toFixed(3),
      o.mapZoom, o.mapRotate, o.mapTilt, o.panX, o.panY, o.endZoom, o.endRotate, o.endTilt, o.endPanX, o.endPanY, o.globeIntro, o.wideStart, o.startView].join('|');
    if (this.distCache?.key === key) return this.distCache.fn;
    const N = 200;
    const L = new Float64Array(N + 1);
    for (let i = 0; i <= N; i++) L[i] = Math.log(this.#cameraRaw(i / N, aspect, null).dist);
    // 뒤에서부터 최댓값 → 시간에 따라 줄어들기만 하는 상한선
    const E = new Float64Array(N + 1);
    let m = -Infinity;
    for (let i = N; i >= 0; i--) { m = Math.max(m, L[i]); E[i] = m; }
    // 위쪽 오목 포락선 (단조 체인)
    const hull = [];
    for (let i = 0; i <= N; i++) {
      while (hull.length >= 2) {
        const a = hull[hull.length - 2], b = hull[hull.length - 1];
        if ((E[b] - E[a]) * (i - a) <= (E[i] - E[a]) * (b - a)) hull.pop(); else break;
      }
      hull.push(i);
    }
    const H = new Float64Array(N + 1);
    for (let k = 0; k < hull.length - 1; k++) {
      const a = hull[k], b = hull[k + 1];
      for (let i = a; i <= b; i++) H[i] = E[a] + ((E[b] - E[a]) * (i - a)) / (b - a);
    }
    // 과거 방향 가우시안 평활 (폭 약 20%)
    const K = Math.round(N * 0.2), sig = K / 2.2;
    const w = Array.from({ length: K + 1 }, (_, k) => Math.exp(-(k * k) / (2 * sig * sig)));
    const wsum = w.reduce((x, y) => x + y, 0);
    const F = new Float64Array(N + 1);
    for (let i = 0; i <= N; i++) {
      let acc = 0;
      for (let k = 0; k <= K; k++) acc += w[k] * H[Math.max(0, i - k)];
      const smoothed = acc / wsum;
      const blend = smooth((i / N - 0.85) / 0.15); // 끝에서는 도착 거리에 정확히 수렴
      F[i] = lerp(smoothed, H[i], blend);
    }
    const fn = (t) => {
      const x = clamp(t, 0, 1) * N, i = Math.min(N - 1, Math.floor(x)), k = x - i;
      return Math.exp(lerp(F[i], F[i + 1], k));
    };
    this.distCache = { key, fn, F, L };
    return fn;
  }

  #cameraState(t, aspect) {
    return this.#cameraRaw(t, aspect, this.#distCurve(aspect)(t));
  }

  /** fixedDist가 없으면 장면 구성에서 계산한 거리를 쓴다 (곡선 생성용). 있으면 그 거리로 중심·보정을 계산 */
  #cameraRaw(t, aspect, fixedDist) {
    const { intro } = TIMELINE;
    const s = this.flightProgress(t);
    const p = clamp((t - this.#flyStart()) / (this.#flyEnd() - this.#flyStart()), 0, 1);
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
    const dFitRaw = Math.max((ex * margin) / (TAN_HALF * aspect), (ey * margin) / TAN_HALF, 0.02);
    // 동남아시아는 아시아 전체가 보이는 넓은 화면에서 시작 (거리가 가까울수록 조금 더 확대)
    // 첨부 이미지(지구 윤곽이 거의 다 보이는 화면) 기준: 쿠알라룸푸르(chord 0.71)에서 카메라 거리 ≈ 1.45
    const sv = this.options.startView;
    const wide = sv === 'wide' || (sv === 'auto' && this.options.wideStart);
    const wideCtx = wide ? 0.78 + 0.95 * this.chord : 0;
    const dFit = clamp(Math.max(dFitRaw, wideCtx) / this.options.mapZoom, 0.008, 3.2);
    // 기본: 사용자가 설정한 지도 범위(dFit)에서 바로 시작. 인트로 옵션을 켜면 지구 전체에서 내려온다
    const dOver = this.options.globeIntro ? Math.max(2.5, dFit * 1.5) : dFit;
    // 도착 화면의 기본 거리(비행기·타겟·정보박스·지나온 경로 일부가 함께 보이는 정도). 도착 확대/축소 설정으로 배율 조절
    const dEnd = Math.max(0.006, 0.05 / this.options.endZoom);

    // 1) (옵션) 전체 지구 → 설정한 지도 범위
    const a = this.options.globeIntro ? smoother(t / intro) : 1;
    const dist0 = Math.exp(lerp(Math.log(dOver), Math.log(dFit), a));
    const tilt0 = lerp(0, tiltFit, a);
    const psi0 = lerpAngle(0, psiFit, a);

    // 2) 줌인은 출발 지점부터 도착 지점까지 '전체 구간'에 걸쳐 자연스럽게 진행된다
    //    (시작은 설정한 지도 범위, 끝은 도착 공항 근접). zs: 전 구간 진행도, z: 마무리 연출(기체·타겟 크기 등)용
    const zs = smoother(s);
    const z = smoother((s - 0.5) / 0.5);

    // 도착 연출 방향 (대한민국 출발 기준 지도 화면):
    //  · 도착지가 서쪽(좌측·좌하단)이면 비행기가 화면 우상단 → 좌하단으로 들어와 착륙
    //  · 도착지가 동쪽(우측·우하단)이면 비행기가 화면 좌상단 → 우하단으로 들어와 착륙
    // 화면 위쪽이 가리키는 방위(psi)를 비행 방위에서 135°/225° 돌려 맞춘다.
    const arriveBearing = this.#bearingOfTangent(this.#pointAt(this.sTouch), this.#tangentAt(this.sTouch));
    const westbound = Math.sin(this.routeBearing * D2R) < 0;
    const psiEnd = (arriveBearing - (westbound ? 225 : 135) + 720) % 360;
    // 시작 시점(mapTilt/mapRotate) → 도착 시점(endTilt/endRotate) 으로 전 구간에 걸쳐 보간
    const tilt = lerp(tilt0, this.options.endTilt, zs);
    const psi = lerpAngle(psi0, (psiEnd + this.options.endRotate + 360) % 360, zs);

    // 카메라 중심/거리: '이미 지나온 경로 일부(Q) ↔ 도착지(B)'가 함께 보이도록 잡아, 줌인 중에도 경로가 충분히 길게 보인다.
    //  · 초반(Q=출발지)에는 두 공항의 중간에 고정, 이후 점차 도착지 쪽으로 이동
    //  · 도착 무렵에는 도착지(= 비행기가 멈추는 지점)가 화면 중앙에 오도록 수렴
    const P = this.#pointAt(s);
    const planePos = P.clone().normalize();
    const Q = this.#pointAt(Math.max(0, s - 0.2)).normalize();
    const wC = smoother((s - 0.5) / 0.5); // 도착 지점이 화면 중앙으로 수렴하는 정도 (경로 후반 전체에 걸쳐 완만하게)
    let C = slerpV(slerpV(Q, this.B, 0.5), this.B, wC);

    // 거리: 완만한 로그 줌(easeDist)과 '둘 다 보이는 최소 거리(reqDist)' 중 큰 값을 부드럽게 선택
    const zd = Math.pow(zs, 1.2); // 후반부 줌인을 조금 더 느리게 → 경로를 더 오래 보여준다
    const easeDist = Math.exp(lerp(Math.log(dist0), Math.log(dEnd), zd));
    const rem = Q.distanceTo(this.B) * (1 - 0.55 * wC);
    const travel = this.#bearingOfTangent(P, this.#tangentAt(s));
    const rel2 = (travel - psi) * D2R;
    const exR = rem * Math.abs(Math.sin(rel2));
    const eyR = rem * Math.abs(Math.cos(rel2)) * Math.cos(tilt * D2R);
    const zoomEff = lerp(this.options.mapZoom, this.options.endZoom, zs);
    const reqDist = (Math.max((exR * margin) / (TAN_HALF * aspect), (eyR * margin) / TAN_HALF) / zoomEff) * 0.95;
    const N = 10; // 소프트 맥스: 두 값이 교차해도 꺾이지 않는다
    let dist = fixedDist ?? Math.pow(Math.pow(easeDist, N) + Math.pow(reqDist, N), 1 / N);
    {
      // 드래그로 옮긴 지도 위치(화면 높이 단위): 시작 설정 → 도착 설정으로 보간
      const px = lerp(this.options.panX, this.options.endPanX, zs), py = lerp(this.options.panY, this.options.endPanY, zs);
      if (px || py) {
        const { n, e } = localFrame(C);
        const ps = psi * D2R;
        const head = n.clone().multiplyScalar(Math.cos(ps)).addScaledVector(e, Math.sin(ps));
        const right = new THREE.Vector3().crossVectors(head, C).normalize();
        const unit = dist * 2 * TAN_HALF;
        C = C.clone()
          .addScaledVector(right, px * unit)
          .addScaledVector(head, (py * unit) / Math.max(0.45, Math.cos(tilt * D2R)))
          .normalize();
      }
    }

    // 도착 공항이 화면 중앙이 아니라 진행 방향 쪽 아래 구석에 놓이도록 카메라 중심을 반대편(위·안쪽)으로 서서히 비켜 둔다
    {
      const { n, e } = localFrame(C);
      const ps = psi * D2R;
      const head = n.clone().multiplyScalar(Math.cos(ps)).addScaledVector(e, Math.sin(ps));
      const right = new THREE.Vector3().crossVectors(head, C).normalize();
      const unit = dist * 2 * TAN_HALF * zs * zs;
      C = C.clone()
        .addScaledVector(right, (westbound ? 0.12 : -0.12) * unit * aspect / 1.78)
        .addScaledVector(head, 0.04 * unit)
        .normalize();
    }
    // 안전영역 보정: 도착 공항 + 위 정보박스, 비행기, (초반엔) 지나온 경로가 화면 UI(상단 박스·하단 카드)와 겹치거나
    // 화면 밖으로 나가지 않도록, 필요한 만큼만 거리를 늘린다. 거리·방향과 무관하게 같은 규칙이 적용된다.
    {
      let d = dist;
      const relax = Math.max(1, zoomEff); // 사용자가 확대했으면 화면 밖으로 나가는 것을 허용
      for (let it = 0; it < 3; it++) {
        const [nb, np, nq, na] = this.#ndc([this.B, P, Q, this.A], C, d, tilt, psi, aspect);
        let f = 1;
        const need = (v, bound) => { f = Math.max(f, Math.abs(v) / bound); };
        // 도착지: 좌우 78%, 아래 카드(-0.50)와 위 정보박스(+0.50) 사이
        need(nb.x, 0.78 * relax);
        f = Math.max(f, nb.y > 0 ? nb.y / (0.5 * relax) : -nb.y / (0.5 * relax));
        // 출발지(초반에만): 좌우 80%, 위 정보박스·상단 항공 박스와 겹치지 않도록 위쪽 55% 이내
        if (s < 0.3) {
          need(na.x, 0.8 * relax);
          f = Math.max(f, na.y > 0 ? na.y / (0.55 * relax) : -na.y / (0.6 * relax));
        }
        // 비행기: 화면 안쪽 90%
        need(np.x, 0.9 * relax); need(np.y, 0.85 * relax);
        // 지나온 경로 일부(Q): 도착이 중앙으로 수렴하면 화면 밖으로 나가도 된다
        if (wC < 0.5) { need(nq.x, 1.0 * relax); need(nq.y, 1.0 * relax); }
        if (f <= 1.001) break;
        d *= Math.min(f, 2.2);
      }
      dist = d;
    }
    return { C, dist, tilt, psi, z, p, s };
  }

  /** 렌더 없이 카메라 상태만 계산 (점검·튜닝용) */
  cameraAt(t) { return this.#cameraState(t, this.size.w / this.size.h); }

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
    // 정보 카드에 가리지 않도록 장면을 카드 반대쪽으로 살짝 옮긴다 (카드가 아래면 위로, 위면 아래로)
    const cardSign = this.options.cardPos?.startsWith('t') ? -1 : 1;
    cam.setViewOffset(w, h, 0, this.options.cardShown ? Math.round(h * (w < h ? 0.04 : 0.02)) * cardSign : 0, w, h);
    cam.near = Math.max(0.0008, Math.min(0.5, height * 0.25));
    cam.far = 120;
    cam.updateProjectionMatrix();

    // 입체감 조명: 카메라 왼쪽 위에서 비스듬히 비추는 주광 + 낮춘 환경광 → 지형 요철·지구 가장자리에 명암이 생긴다.
    // 값이 클수록 대비가 커지고, 0이면 이전의 평평한 조명.
    const dp = this.options.depth;
    const camRight = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const toCam = cam.position.clone().sub(st.C).normalize();
    this.sun.position.copy(st.C)
      .addScaledVector(toCam, 5)
      .addScaledVector(camRight, -lerp(0.3, 4.2, dp))
      .addScaledVector(head, lerp(0.6, 2.4, dp));
    this.sun.target.position.copy(st.C);
    this.sun.intensity = lerp(2.4, 3.5, dp);
    this.ambient.intensity = lerp(0.9, 0.5, dp);
    // 시간대: 스튜디오(기본) / 황혼 / 밤. 황혼·밤은 실제 태양 방향(고정)을 정해 야경 불빛이 어둠 속에서만 보이게 한다
    const tod = this.options.timeOfDay;
    let lights = 0, expo = 1;
    if (tod !== 'studio' && this.M) {
      const M = this.M, d = this.B.clone().sub(this.A);
      const T = d.addScaledVector(M, -d.dot(M)).normalize();
      const side = new THREE.Vector3().crossVectors(M, T);
      const sunDir = tod === 'dusk'
        ? T.clone().multiplyScalar(-0.95).addScaledVector(M, 0.1).addScaledVector(side, 0.25).normalize() // 출발지 쪽에서 해가 지는 방향 → 도착지가 어둠
        : M.clone().multiplyScalar(-0.9).addScaledVector(T, 0.1).normalize();                             // 밤: 노선 전체가 그림자 쪽
      cam.updateMatrixWorld(true);
      this.nightU.sunView.value.copy(sunDir).transformDirection(cam.matrixWorldInverse.copy(cam.matrixWorld).invert());
      if (tod === 'dusk') {
        this.sun.position.copy(st.C).addScaledVector(sunDir, 5);
        this.sun.color.set(0xffb27a); this.sun.intensity = 4.6;
        this.ambient.color.set(0x7d8fd6); this.ambient.intensity = 0.2;
        expo = 1.2;
      } else {
        this.sun.color.set(0x8fb0ff); this.sun.intensity = 0.55; // 달빛: 카메라 쪽 은은한 보조광
        this.ambient.color.set(0x5c74c8); this.ambient.intensity = 0.28;
        expo = 1.3;
      }
      lights = this.options.cityLights;
    } else {
      this.sun.color.set(0xffffff); this.ambient.color.set(0xbfd3ff);
    }
    this.nightU.lights.value = lights;
    this.selU.k.value = this.options.highlight ? this.options.highlightAmt : 0;
    this.nightU.close.value = 1 - smooth((height - 0.04) / 0.8);
    const ns = 0.25 + 1.55 * dp; // 지형 노멀맵 강도
    this.earthMat.normalScale.set(ns, ns);
    if (this.patchGroup) for (const m of this.patchGroup.children) if (m.userData.hasNormal) m.material.normalScale.set(ns * 0.9, ns * 0.9);
    // 비행기: 입체감이 클수록 환경 반사는 강하게, 평평하게 밝히던 자체발광은 줄여 명암을 만든다
    for (const { m, emissive } of this.planeMats || []) {
      m.envMapIntensity = lerp(0.15, 1.5, dp);
      m.emissiveIntensity = emissive * lerp(1, 0.3, dp);
    }
    // Phong 반사는 (shininess+2)/8 배로 증폭되므로 아주 작은 값이면 충분하다 (바다에만 은은한 윤기)
    this.earthMat.specular.setScalar(lerp(0, 0.03, dp)); // 바다에 햇빛이 반사되는 은은한 글린트
    this.renderer.toneMappingExposure = lerp(1, 1.12, dp) * expo;

    const dCam = cam.position.length();
    this.atmoMat.uniforms.fade.value = smooth((height - 0.02) / 0.25) * this.options.atmoAmt;
    this.starMat.opacity = this.options.starAmt;
    const cloudFade = smooth((height - 0.02) / 0.22);
    this.cloudU.opacity.value = Math.min(1, this.options.cloudAmt * 1.25) * cloudFade;
    {
      // 구름 음영용 광원 방향(카메라 공간)
      cam.updateMatrixWorld(true);
      this.tmpM = this.tmpM || new THREE.Matrix4();
      const sd = this.sun.position.clone().sub(this.sun.target.position).normalize();
      this.cloudU.sun.value.copy(sd.transformDirection(this.tmpM.copy(cam.matrixWorld).invert()));
    }
    this.cloudU.lit.value = tod === 'night' ? 0.12 : 1;
    this.cloudU.scale.value = this.options.cloudScale;
    this.cloudU.cover.value = this.options.cloudAmt;
    this.cloudU.close.value = this.nightU.close.value;
    this.cloudShadowU.value = this.options.clouds ? 0.3 * (this.options.cloudAmt / 0.5) * cloudFade : 0;
    this.clouds.visible = this.options.clouds && height > 0.02;
    this.clouds.rotation.y = seconds * 0.004 * this.options.cloudSpeed;
    // 구역별 국경선: 보이는 구역만 그린다
    this.camLookDir = cam.getWorldDirection(this.tmpLook || (this.tmpLook = new THREE.Vector3()));
    if (this.regionMat) this.regionMat.opacity = this.options.regionAlpha * (1 - smooth((height - 0.5) / 1.0));
    this.#cullChunks(this.borderChunks, this.options.borders, cam.position, cam);
    this.#cullChunks(this.selBorderChunks, this.options.borders && this.options.highlight, cam.position, cam);
    this.#cullChunks(this.regionChunks, this.options.regionLines, cam.position, cam);
    if (this.patchGroup) this.patchGroup.visible = this.options.hdTiles;

    const scale = h / 1080;
    for (const m of this.lineMats) {
      m.linewidth = m.userData.basePx * Math.max(0.8, scale);
      m.resolution.set(w, h);
      if (m.userData.dash) { m.dashSize = st.dist * m.userData.dash[0]; m.gapSize = st.dist * m.userData.dash[1]; }
    }
    // 가까이 갈수록 국경선은 얇고 흐리게
    // 강조가 켜져 있으면 비선택 국가 국경선은 연하게, 선택 국가 국경선은 굵고 선명하게
    const hk = this.options.highlight ? Math.min(1, this.options.highlightAmt) : 0;
    const near = 1 - 0.7 * smooth((0.3 - height) / 0.25);
    const ba = this.options.borderAlpha / 0.5; // 진하기 슬라이더(기본 50%) 배율
    if (this.borderMat) this.borderMat.opacity = Math.min(1, 0.5 * ba * near * (1 - 0.62 * hk));
    if (this.borderSelMat) this.borderSelMat.opacity = Math.min(1, (0.55 + 0.45 * near) * ba);

    // 비행기
    const planePos = this.#pointAt(st.s);
    const tan = this.#tangentAt(st.s);
    const up = planePos.clone().normalize();
    // 출발 직후 기수가 수평에서 상승각으로 자연스럽게 들리도록 자세를 보간
    const flat = tan.clone().addScaledVector(up, -tan.dot(up)).normalize();
    tan.lerpVectors(flat, tan, smooth(st.s / 0.03)).normalize();
    // 기체 크기: 화면 너비 대비 비율을 유지한다 (멀리 축소돼도 작아 보이지 않게). planeSize로 배율 조절
    const aspect = w / h;
    const pScale = (aspect >= 1 ? 0.055 * 0.85 : 0.09 * 0.85) * (1 + 0.7 * st.z) * this.options.planeSize * (2 * TAN_HALF * aspect * st.dist);
    const altitude = planePos.length() - GROUND_R;
    // 바퀴가 지면에 닿도록 기체 중심을 바퀴 길이만큼 띄운다 (지상에서만 적용)
    planePos.addScaledVector(up, 0.105 * pScale * (1 - smooth(altitude / (0.5 * pScale + 1e-6))));
    this.plane.userData.gear.visible = altitude < 0.35 * pScale;
    const x = new THREE.Vector3().crossVectors(up, tan).normalize();
    const y = new THREE.Vector3().crossVectors(tan, x).normalize();
    this.plane.matrix.makeBasis(x, y, tan).setPosition(planePos);
    this.plane.matrixAutoUpdate = false;
    this.plane.matrix.scale(new THREE.Vector3(pScale, pScale, pScale));
    this.plane.matrixWorldNeedsUpdate = true;

    // 비행기 그림자: 기체 바로 아래 지면 (옵션). 고도가 높을수록 옅어진다
    const gUp = up.clone().multiplyScalar(GROUND_R + 0.00005);
    const gFwd = tan.clone().addScaledVector(up, -tan.dot(up)).normalize();
    const gX = new THREE.Vector3().crossVectors(up, gFwd).normalize();
    this.shadow.visible = this.options.planeShadow;
    this.shadow.matrixAutoUpdate = false;
    this.shadow.matrix.makeBasis(gX, up, gFwd).setPosition(gUp).scale(new THREE.Vector3(pScale, pScale, pScale));
    this.shadow.matrixWorldNeedsUpdate = true;
    this.shadow.material.opacity = (0.28 + 0.2 * dp) * (1 - smooth(altitude / (25 * pScale + 1e-6)));

    // 지나온 궤적
    const count = Math.floor(st.s * this.segments);
    this.trail.visible = this.trailGlow.visible = count >= 1;
    if (count >= 1) this.trailGeo.instanceCount = Math.min(this.segments, count);

    // 붉은 타겟: 화면상 반지름을 일정하게 유지(줌인하면 도착 쪽은 커짐), 카메라를 향해 회전, 뒷면이면 숨김
    const uPx = Math.min(w, h) / 1080;
    this.targets.forEach((g, i) => {
      const ground = g.userData.n.clone().multiplyScalar(GROUND_R + 0.00005);
      const facing = g.userData.n.dot(cam.position) > 1.0005;
      g.visible = this.options[g.userData.opt] && facing;
      const rPx = (24 + 30 * (i ? st.z : 0)) * uPx * (i ? this.options.destTargetScale : this.options.originTargetScale);
      const d = cam.position.distanceTo(ground);
      g.position.copy(ground);
      g.quaternion.copy(cam.quaternion);
      g.scale.setScalar((rPx * 2 * TAN_HALF * d) / h);
      const { detail, pulse } = g.userData;
      detail.opacity = 1 - 0.8 * (i ? st.z : 0);
      const ph = (seconds * 0.9 + i * 0.5) % 1;
      pulse.scale.setScalar(1 + ph * 0.9);
      pulse.material.opacity = 0.55 * (1 - ph);
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
