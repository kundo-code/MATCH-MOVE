// 자동 점검: `npm test` (개발 서버 없이 빌드 결과를 직접 띄워 확인한다)
//  - 화면이 오류 없이 뜨는지, 권역→국가→공항 선택, 인트로/아웃트로/자막, 배경음악·내레이션 믹스,
//    야경 모드, 작은 MP4 저장(영상+소리 트랙)이 되는지 확인한다.
// 필요: Chromium 실행 파일. 경로는 CHROMIUM_PATH 환경변수 또는 Playwright 기본 경로를 쓴다.
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const results = [];
const ok = (name, cond, extra = '') => { results.push([name, !!cond]); console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ` — ${extra}` : ''}`); };

// 테스트용 WAV (사인파)
const dir = mkdtempSync(join(tmpdir(), 'mm-'));
function wav(name, sec, fn) {
  const sr = 44100, n = sr * sec, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, fn(i / sr))) * 32767), 44 + i * 2);
  const p = join(dir, name); writeFileSync(p, b); return p;
}
const bgm = wav('bgm.wav', 4, (t) => 0.3 * Math.sin(2 * Math.PI * 220 * t));
const narr = wav('narr.wav', 3, (t) => (t > 0.5 && t < 2.5 ? 0.5 * Math.sin(2 * Math.PI * 440 * t) : 0));

const server = await createServer({ server: { port: 5199, strictPort: false }, logLevel: 'error' });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errs = [];
page.setDefaultTimeout(90000); // 소프트웨어 렌더링에서는 프레임이 느려 클릭 안정화 대기가 길어질 수 있다
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text().slice(0, 200)); });
// 외부 서비스(위성 타일)는 막아 오프라인 동작을 함께 확인한다
for (const u of ['**/server.arcgisonline.com/**', '**/elevation-tiles-prod/**', '**/fonts.g*/**']) await page.route(u, (r) => r.abort());
try {
  await page.goto(url);
  await page.waitForFunction(() => window.__app?.scene?.tilesPromise, null, { timeout: 90000 });
  await page.evaluate(() => { __app.state.playing = false; });
  ok('앱이 오류 없이 시작', errs.length === 0, errs.join(' | '));

  // 권역 → 국가 → 공항
  await page.click('#regions button:nth-child(2)');
  await page.click('#stpCountry .combo-btn');
  await page.click('#stpCountry .combo-item:nth-child(1)');
  await page.click('#stpAirport .combo-btn');
  const n = await page.locator('#stpAirport .combo-item').count();
  await page.click('#stpAirport .combo-item:nth-child(1)');
  ok('권역→국가→공항 선택', n > 0 && (await page.evaluate(() => !!__app.meta.dest.iata)), `${n}개 공항`);

  // 인트로/아웃트로/자막/믹스
  const set = (id, v) => page.evaluate(([id, v]) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, [id, v]);
  await set('introTpl', 'title'); await set('outroTpl', 'card'); await set('outroHold', '2');
  await page.evaluate(() => document.getElementById('subAuto').click());
  await page.setInputFiles('#bgmFile', bgm); await page.setInputFiles('#narrFile', narr);
  await page.waitForFunction(() => document.getElementById('narrName').textContent.includes('초'));
  const total = await page.evaluate(() => __app.totalSec());
  ok('마지막 장면 연장이 전체 길이에 반영', total === 10, `${total}초`);
  ok('자막 자동 생성', (await page.locator('.subrow').count()) === 3);

  // 야경 모드 (있으면)
  const hasNight = await page.evaluate(() => !!document.getElementById('timeOfDay'));
  if (hasNight) { await set('timeOfDay', 'night'); ok('야경 모드 전환', (await page.evaluate(() => __app.scene.options.timeOfDay)) === 'night'); }

  // 작은 MP4 저장 (영상 + 소리 트랙)
  await page.evaluate(() => { __app.state.exporting = true; });
  const r = await page.evaluate(async () => {
    const { exportMp4 } = await import('/src/exporter.js');
    const A = __app, tot = A.totalSec();
    const mixed = await A.getAudioBuffer();
    const compose = A.compose(320, 180);
    const res = await exportMp4({ renderFrame: (u) => compose((u * tot) / A.state.duration, u * tot), width: 320, height: 180, fps: 10, durationSec: tot, targetMB: 2, audioBuffer: mixed, onProgress: () => {} });
    return { size: res.blob.size, codec: res.codec, audio: res.audio, mixSec: mixed?.duration };
  });
  ok('MP4 저장 (영상)', r.size > 20000, `${r.codec} ${(r.size / 1024).toFixed(0)}KB`);
  ok('MP4 저장 (소리 트랙 포함)', !!r.audio && Math.abs(r.mixSec - total) < 0.1, `${r.audio} ${r.mixSec?.toFixed(1)}초`);
  ok('실행 중 오류 없음', errs.length === 0, errs.join(' | '));
} catch (e) {
  ok('테스트 진행', false, e.message);
} finally {
  await browser.close();
  await server.close();
}
const failed = results.filter(([, p]) => !p).length;
console.log(failed ? `\n실패 ${failed}건` : '\n모두 통과');
process.exit(failed ? 1 : 0);
