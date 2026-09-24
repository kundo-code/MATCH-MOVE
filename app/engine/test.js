// Sanity tests for the flight engine. Run: node engine/test.js
const P = require('./golf-physics.js');
const assert = require('assert');

const club = (k, o = {}) => {
  const c = P.CLUBS[k];
  return { ballSpeed: c.clubSpeed * c.smash, launch: c.launch, spin: c.spin, axis: 0, dir: 0, loft: c.loft, ...o };
};
const sim = (k, env = {}, cond = {}, o = {}, extra = {}) =>
  P.simulate({ shot: club(k, o), env: { ...P.STANDARD_ENV, ...env }, cond: { ...P.STANDARD_COND, ...cond }, ...extra });

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ', name); }
  catch (e) { console.error('  FAIL', name, '-', e.message); process.exitCode = 1; }
}

const base7 = sim('iron7');
const baseD = sim('driver');

test('air density at sea level ~1.22 kg/m3', () => {
  const rho = P.airDensity(15, P.pressureAtAltitude(0), 0);
  assert(Math.abs(rho - 1.225) < 0.005, rho);
});
test('humid air is LESS dense than dry air', () => {
  assert(P.airDensity(30, 101325, 100) < P.airDensity(30, 101325, 0));
});
test('driver carry within 6 % of tour average (251 m)', () => {
  const r = sim('driver', { temperature: 25 }, { temperature: 25 });
  assert(Math.abs(r.carry - 251) / 251 < 0.06, r.carry);
});
test('7-iron carry within 6 % of tour average (157 m)', () => {
  const r = sim('iron7', { temperature: 25 }, { temperature: 25 });
  assert(Math.abs(r.carry - 157) / 157 < 0.06, r.carry);
});
test('smooth ball flies roughly half as far as a dimpled one', () => {
  const r = sim('driver', {}, {}, {}, { dimpled: false });
  assert(r.carry < baseD.carry * 0.65, r.carry);
});
test('altitude increases carry', () => assert(sim('iron7', { altitude: 1600 }).carry > base7.carry));
test('cold air shortens carry', () => assert(sim('iron7', { temperature: 0 }, { temperature: 0 }).carry < base7.carry));
test('headwind shortens, tailwind lengthens', () => {
  assert(sim('iron7', { windSpeed: 5, windDir: 0 }).carry < base7.carry);
  assert(sim('iron7', { windSpeed: 5, windDir: 180 }).carry > base7.carry);
});
test('wind from the right pushes the ball left', () => assert(sim('iron7', { windSpeed: 5, windDir: 90 }).totalLateral < -3));
test('ball above feet -> left (draw/hook); below -> right', () => {
  assert(sim('iron7', {}, { sideSlope: 10 }).totalLateral < -5);
  assert(sim('iron7', {}, { sideSlope: -10 }).totalLateral > 5);
});
test('slope effect on direction grows with loft', () => {
  const d = Math.abs(sim('driver', {}, { sideSlope: 10 }).applied.dir);
  const w = Math.abs(sim('pw', {}, { sideSlope: 10 }).applied.dir);
  assert(w > d, `${w} vs ${d}`);
});
test('uphill lie launches higher, downhill lower', () => {
  assert(sim('iron7', {}, { fwdSlope: 8 }).apex > base7.apex);
  assert(sim('iron7', {}, { fwdSlope: -8 }).apex < base7.apex);
});
test('positive axis tilt curves right (fade/slice)', () => assert(sim('driver', {}, {}, { axis: 10 }).totalLateral > 5));
test('heavy rain shortens carry and roll', () => {
  const r = sim('iron7', {}, { weather: 'heavyRain' });
  assert(r.carry < base7.carry && r.rollOut < base7.rollOut);
});
test('flyer lie reduces spin and increases roll', () => {
  const r = sim('iron7', {}, { lie: 'flyer' });
  assert(r.applied.spin < base7.applied.spin && r.rollOut > base7.rollOut);
});
test('half-submerged ball goes a short way', () => assert(sim('iron7', {}, { lie: 'water' }).total < base7.total * 0.5));
test('elevated target shortens carry, downhill target lengthens', () => {
  assert(sim('iron7', { elevation: 15 }).carry < base7.carry);
  assert(sim('iron7', { elevation: -20 }).carry > base7.carry);
});
test('wedge on firm green stops within a few metres', () => {
  const r = sim('sw', {}, { landing: 'greenFirm' });
  assert(Math.abs(r.rollOut) < 10, r.rollOut);
});
test('driver roll-out on fairway is realistic (5-40 m)', () => assert(baseD.rollOut > 5 && baseD.rollOut < 40, baseD.rollOut));
test('optimiser returns a deliverable driver window', () => {
  const o = P.optimise({ shot: club('driver'), env: P.STANDARD_ENV, cond: P.STANDARD_COND }, 'carry');
  assert(o.launch > 10 && o.launch < 20 && o.spin > 1700 && o.spin < 3400, JSON.stringify(o));
});
test('factor attribution produces one row per group', () => {
  const a = P.attribute({ shot: club('iron7'), env: { ...P.STANDARD_ENV, windSpeed: 4 }, cond: P.STANDARD_COND });
  assert(a.rows.length === 7 && a.rows.find((r) => r.key === 'wind').dCarry < 0);
});
test('left-handed golfer mirrors lateral result', () => {
  const r = sim('iron7', {}, { sideSlope: 10 }, { hand: 'L' });
  assert(r.totalLateral > 5, r.totalLateral);
});

console.log(`\n${passed} passed`);
