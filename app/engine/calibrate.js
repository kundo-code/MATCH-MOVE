// Calibrates engine AERO constants against TrackMan PGA Tour averages.
// Usage: node engine/calibrate.js          -> prints fit report for current constants
//        node engine/calibrate.js --search -> grid-searches constants and prints the best set
const P = require('./golf-physics.js');

// carry [m], apex [m], land angle [deg]  (TrackMan tour averages converted from yards)
const TARGET = {
  driver: [251, 29.3, 38],
  wood3:  [222, 27.4, 43],
  hybrid: [206, 26.5, 47],
  iron5:  [178, 28.3, 49],
  iron7:  [157, 29.3, 50],
  iron9:  [139, 27.4, 51],
  pw:     [124, 26.5, 52],
};

function run() {
  const rows = [];
  let err = 0;
  for (const [k, t] of Object.entries(TARGET)) {
    const c = P.CLUBS[k];
    const r = P.simulate({
      dt: 0.01,
      shot: { ballSpeed: c.clubSpeed * c.smash, launch: c.launch, spin: c.spin, axis: 0, dir: 0, loft: c.loft },
      env: { ...P.STANDARD_ENV, temperature: 25 },
      cond: { ...P.STANDARD_COND, temperature: 25 },
    });
    const e = ((r.carry - t[0]) / 4) ** 2 + ((r.apex - t[1]) / 2) ** 2 + ((r.landAngle - t[2]) / 3) ** 2;
    err += e;
    rows.push({ k, carry: r.carry, apex: r.apex, land: r.landAngle, total: r.total, t });
  }
  return { err, rows };
}

function report() {
  const { err, rows } = run();
  for (const r of rows) {
    console.log(`${r.k.padEnd(7)} carry ${r.carry.toFixed(1).padStart(6)} (${r.t[0]})  apex ${r.apex.toFixed(1).padStart(5)} (${r.t[1]})  land ${r.land.toFixed(1).padStart(5)} (${r.t[2]})  total ${r.total.toFixed(1)}`);
  }
  console.log('error', err.toFixed(2), JSON.stringify(P.AERO));
}

if (process.argv.includes('--search')) {
  let best = null;
  const grid = {
    cd0: [0.20, 0.215, 0.23],
    cdSpin: [0.35, 0.45, 0.55],
    clMax: [0.30, 0.34, 0.38],
    clSlope: [1.9, 2.2, 2.5],
    cdCrisis: [0.1, 0.2],
    reCrit: [4.0e4, 5.0e4],
    sMaxDrag: [0.3, 0.4],
  };
  const keys = Object.keys(grid);
  const idx = keys.map(() => 0);
  for (;;) {
    keys.forEach((k, i) => { P.AERO[k] = grid[k][idx[i]]; });
    const { err } = run();
    if (!best || err < best.err) best = { err, aero: { ...P.AERO } };
    let i = 0;
    while (i < keys.length && ++idx[i] >= grid[keys[i]].length) { idx[i] = 0; i++; }
    if (i === keys.length) break;
  }
  Object.assign(P.AERO, best.aero);
}
report();
