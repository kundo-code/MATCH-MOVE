/*
 * MATCH-MOVE Golf Ball Flight Engine (골프공 탄도 물리엔진)
 * ---------------------------------------------------------------
 * 3D point-mass ball flight with:
 *   - gravity, aerodynamic drag, Magnus lift (spin-axis aware)
 *   - Reynolds-number drag crisis (dimpled vs smooth ball)
 *   - air density from altitude, temperature, humidity (moist air)
 *   - height-dependent wind profile (power law)
 *   - rain / fog / cloud weather effects
 *   - slope-lie (stance) effects on launch, direction, spin axis
 *   - impact-surface effects (fairway, rough, bunker, dirt, water ...)
 *   - bounce + roll model on landing surface
 *
 * Coordinate system (right-handed golfer view):
 *   x : down-range (target line)       [m]
 *   y : up                              [m]
 *   z : right of target line            [m]
 *
 * Works in the browser (window.GolfPhysics) and Node (module.exports).
 */
(function (root) {
  'use strict';

  // ---------- constants ----------
  const G = 9.80665;               // gravity [m/s^2]
  const BALL_MASS = 0.04593;       // [kg]   (R&A / USGA max 45.93 g)
  const BALL_DIAM = 0.04267;       // [m]    (min 42.67 mm)
  const BALL_R = BALL_DIAM / 2;
  const BALL_AREA = Math.PI * BALL_R * BALL_R;
  const RPM_TO_RADS = (2 * Math.PI) / 60;
  const DEG = Math.PI / 180;
  const M_TO_YD = 1.0936133;
  const MS_TO_MPH = 2.2369363;

  // ---------- presets ----------
  // Typical tour launch data (TrackMan tour averages, rounded) used as starting points.
  const CLUBS = {
    driver: { ko: '드라이버', en: 'Driver', loft: 10.5, clubSpeed: 50.8, smash: 1.48, launch: 10.9, spin: 2686, axis: 0 },
    wood3:  { ko: '3번 우드', en: '3-Wood', loft: 15, clubSpeed: 47.6, smash: 1.47, launch: 9.2, spin: 3655, axis: 0 },
    hybrid: { ko: '하이브리드', en: 'Hybrid', loft: 19, clubSpeed: 45.6, smash: 1.46, launch: 10.2, spin: 4437, axis: 0 },
    iron5:  { ko: '5번 아이언', en: '5-Iron', loft: 26, clubSpeed: 42.9, smash: 1.41, launch: 12.1, spin: 5361, axis: 0 },
    iron7:  { ko: '7번 아이언', en: '7-Iron', loft: 33, clubSpeed: 40.2, smash: 1.33, launch: 16.3, spin: 7097, axis: 0 },
    iron9:  { ko: '9번 아이언', en: '9-Iron', loft: 41, clubSpeed: 38.0, smash: 1.28, launch: 20.4, spin: 8647, axis: 0 },
    pw:     { ko: '피칭 웨지', en: 'Pitching Wedge', loft: 46, clubSpeed: 37.1, smash: 1.23, launch: 24.2, spin: 9304, axis: 0 },
    sw:     { ko: '샌드 웨지', en: 'Sand Wedge', loft: 56, clubSpeed: 32.0, smash: 1.15, launch: 30.0, spin: 10000, axis: 0 },
  };

  // Impact-lie surface: multipliers applied to the "flat fairway" shot.
  //  speed: ball-speed factor, spin: spin factor, launch: added launch [deg],
  //  dir: added start direction [deg, + = right], axis: added spin-axis tilt [deg]
  //  spread: dispersion (1-sigma, deg) used for the dispersion cone
  const LIES = {
    tee:        { ko: '티 (Tee)', speed: 1.00, spin: 1.00, launch: 0.0, dir: 0, axis: 0, spread: 1.0 },
    fairway:    { ko: '페어웨이 (Fairway)', speed: 1.00, spin: 1.00, launch: 0.0, dir: 0, axis: 0, spread: 1.0 },
    wetFairway: { ko: '젖은 페어웨이 (Wet fairway)', speed: 0.99, spin: 0.80, launch: 0.5, dir: 0, axis: 0, spread: 1.3 },
    firstCut:   { ko: '퍼스트 컷 (First cut)', speed: 0.98, spin: 0.85, launch: 0.5, dir: 0, axis: 0, spread: 1.3 },
    flyer:      { ko: '가벼운 러프·플라이어 (Light rough / flyer)', speed: 0.99, spin: 0.60, launch: 1.0, dir: -0.5, axis: -1, spread: 1.8 },
    heavyRough: { ko: '깊은 러프 (Heavy rough)', speed: 0.82, spin: 0.50, launch: 2.0, dir: -2.0, axis: -3, spread: 3.0 },
    fwBunker:   { ko: '페어웨이 벙커 (Fairway bunker)', speed: 0.94, spin: 0.85, launch: -0.5, dir: 0, axis: 0, spread: 1.8 },
    gsBunker:   { ko: '그린사이드 벙커 폭발샷 (Greenside bunker explosion)', speed: 0.42, spin: 0.55, launch: 8.0, dir: 0, axis: 1, spread: 3.0 },
    hardpan:    { ko: '맨땅·흙바닥 (Hardpan / bare dirt)', speed: 0.98, spin: 1.05, launch: -1.0, dir: 0, axis: 0, spread: 1.6 },
    divot:      { ko: '디봇 자국 (Divot)', speed: 0.93, spin: 0.90, launch: -2.0, dir: 0.5, axis: 1, spread: 2.0 },
    water:      { ko: '물에 살짝 잠긴 볼 (Half-submerged in water)', speed: 0.40, spin: 0.30, launch: 6.0, dir: 0, axis: 0, spread: 4.0 },
  };

  // Landing surface: bounce/roll parameters.
  //  e: normal restitution scale, mu: sliding friction, roll: rolling resistance (decel = roll*g),
  //  plow: horizontal speed lost to turf deformation per 10 m/s of vertical impact speed
  //  crater: tilt of the effective contact plane per m/s of impact speed [deg] -- the ball
  //          digs a small crater and hits its rising front wall (Penner's green-impact model)
  const SURFACES = {
    greenFirm:  { ko: '단단한 그린 (Firm green)', e: 1.00, mu: 0.55, roll: 0.060, plow: 0.22, crater: 0.75 },
    greenSoft:  { ko: '부드러운 그린 (Soft green)', e: 0.70, mu: 0.65, roll: 0.075, plow: 0.25, crater: 1.35 },
    fairway:    { ko: '페어웨이 (Fairway)', e: 0.85, mu: 0.45, roll: 0.13, plow: 0.16, crater: 0.55 },
    fairwayFirm:{ ko: '마른 페어웨이 (Firm fairway)', e: 1.05, mu: 0.40, roll: 0.09, plow: 0.10, crater: 0.35 },
    rough:      { ko: '러프 (Rough)', e: 0.45, mu: 0.70, roll: 0.30, plow: 0.30, crater: 0.45 },
    sand:       { ko: '벙커 모래 (Sand)', e: 0.10, mu: 0.90, roll: 1.20, plow: 0.90, crater: 1.40 },
  };

  // Weather presets.
  //  drag: drag multiplier (rain drops hitting the ball), spin: spin multiplier at impact
  //  (water film between face and ball), speed: ball-speed factor (wet grip / wet ball),
  //  ground: landing restitution & roll multipliers (wet ground is soft).
  const WEATHER = {
    sunny:     { ko: '맑음 (Sunny)', drag: 1.00, spin: 1.00, speed: 1.000, groundE: 1.00, groundRoll: 1.0, rh: null },
    cloudy:    { ko: '흐림 (Cloudy)', drag: 1.00, spin: 1.00, speed: 1.000, groundE: 1.00, groundRoll: 1.0, rh: null },
    fog:       { ko: '안개 (Fog)', drag: 1.005, spin: 0.98, speed: 0.998, groundE: 0.92, groundRoll: 1.25, rh: 100 },
    lightRain: { ko: '약한 비 (Light rain)', drag: 1.03, spin: 0.85, speed: 0.990, groundE: 0.75, groundRoll: 1.8, rh: 95 },
    heavyRain: { ko: '강한 비 (Heavy rain)', drag: 1.08, spin: 0.70, speed: 0.975, groundE: 0.55, groundRoll: 2.8, rh: 100 },
  };

  // ---------- atmosphere ----------
  // Saturation vapour pressure [Pa] (Tetens / Buck formula)
  function saturationVaporPressure(tC) {
    return 611.21 * Math.exp((18.678 - tC / 234.5) * (tC / (257.14 + tC)));
  }

  // Station pressure [Pa] from altitude (ISA troposphere barometric formula)
  function pressureAtAltitude(altM) {
    return 101325 * Math.pow(1 - 2.25577e-5 * altM, 5.25588);
  }

  // Moist air density [kg/m^3]
  function airDensity(tC, pressurePa, rhPct) {
    const T = tC + 273.15;
    const pv = (rhPct / 100) * saturationVaporPressure(tC);
    const pd = pressurePa - pv;
    return pd / (287.058 * T) + pv / (461.495 * T);
  }

  // Dynamic viscosity of air [Pa s] (Sutherland)
  function airViscosity(tC) {
    const T = tC + 273.15;
    return 1.716e-5 * Math.pow(T / 273.15, 1.5) * (273.15 + 110.4) / (T + 110.4);
  }

  // ---------- aerodynamic coefficients ----------
  // Spin factor S = r*omega / v.  Reynolds number Re = rho*v*D/mu.
  // Tunable aerodynamic constants (calibrated to TrackMan tour averages, see engine/calibrate.js)
  const AERO = {
    cd0: 0.20,         // dimpled-ball drag above the drag crisis
    cdCrisis: 0.20,    // extra drag below the crisis Reynolds number
    reCrit: 5.0e4,     // drag-crisis Reynolds number for a dimpled ball
    cdSpin: 0.55,      // drag growth with spin factor
    sMaxDrag: 0.30,    // spin factor where drag stops growing
    clMax: 0.34,       // lift saturation
    clSlope: 1.9,      // initial lift slope dCl/dS
  };

  function dragCoeff(Re, S, dimpled) {
    if (!dimpled) {
      // Smooth sphere: laminar boundary layer separates early -> Cd ~ 0.47 across golf speeds
      return 0.47 + 0.10 * Math.min(S, AERO.sMaxDrag);
    }
    // Dimpled ball: dimples trip the boundary layer turbulent -> drag crisis at low Re.
    const base = AERO.cd0 + AERO.cdCrisis / (1 + Math.exp((Re - AERO.reCrit) / 6.0e3));
    return base + AERO.cdSpin * Math.min(S, AERO.sMaxDrag);
  }

  function liftCoeff(S, dimpled) {
    // Saturating Magnus lift: Cl = Clmax * tanh(slope * S / Clmax)
    const cl = AERO.clMax * Math.tanh(AERO.clSlope * S / AERO.clMax);
    return dimpled ? cl : cl * 0.45;       // smooth ball: weak, irregular lift
  }

  // ---------- helpers ----------
  const v3 = {
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    mul: (a, k) => [a[0] * k, a[1] * k, a[2] * k],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    len: (a) => Math.hypot(a[0], a[1], a[2]),
    norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
  };

  // Wind vector at height h. windDirDeg: direction the wind is blowing FROM, measured
  // relative to the target line: 0 = headwind (from the target), 180 = tailwind,
  // 90 = from the right (pushes ball left), 270 = from the left (pushes ball right).
  function windAt(h, env) {
    if (!env.windSpeed) return [0, 0, 0];
    const refH = 10;                                       // anemometer height [m]
    const hh = Math.max(h, 0.3);
    const factor = Math.pow(hh / refH, env.windShear == null ? 0.12 : env.windShear);
    // WIND_CAL: calibrated so a 10 mph head/tail wind changes a tour 7-iron's carry by
    // about -8 % / +6 % (TrackMan wind tests); accounts for gusts, shelter and turbulence.
    const speed = env.windSpeed * WIND_CAL * Math.min(factor, 1.3);
    const a = env.windDir * DEG;
    // blowing FROM direction a  -> air moves TOWARD a+180
    return [-Math.cos(a) * speed, 0, -Math.sin(a) * speed];
  }

  const WIND_CAL = 0.68;

  // ---------- lie & condition adjustments ----------
  /**
   * Converts the golfer's "normal flat-lie shot" into the actual launch conditions
   * given stance slope, impact surface and weather.
   * sideSlope  : + ball ABOVE feet (발끝 오르막), - ball BELOW feet (발끝 내리막) [deg]
   * fwdSlope   : + UPHILL lie, lead(left) foot higher (왼발 오르막), - DOWNHILL [deg]
   */
  function applyConditions(shot, cond) {
    const out = { ...shot };
    const notes = [];
    const loft = shot.loft;
    const side = cond.sideSlope || 0;
    const fwd = cond.fwdSlope || 0;

    // 1) Side slope: lie angle tilt rotates the lofted face.
    //    Face direction change = atan(tan(loft) * sin(tilt))   (loft-dependent!)
    // Golfers only partly tilt the shaft with the slope (they choke down / stand closer),
    // so ~60 % of the slope becomes lie-angle change at impact.
    const tilt = 0.6 * side;
    const faceShift = Math.atan(Math.tan(loft * DEG) * Math.sin(tilt * DEG)) / DEG; // + = face points LEFT
    const face = -faceShift;                    // face angle change, + = open (right)
    // Swing-plane effect: ball above feet -> flatter, in-to-out path (+ = right);
    // ball below feet -> steeper, out-to-in path.
    const path = 0.15 * side;
    // Start direction is face-dominated (~80 % face, ~20 % path).
    out.dir = shot.dir + 0.80 * face + 0.20 * path;
    // Face-to-path difference tilts the spin axis (negative = draw/hook for RH)
    const faceToPath = face - path;
    out.axis = shot.axis + 1.3 * faceToPath;
    out.faceShift = faceShift;

    // 2) Forward slope: effective loft follows the slope.
    out.launch = shot.launch + 0.80 * fwd;
    out.spin = shot.spin * (fwd >= 0 ? 1 + 0.012 * fwd : 1 + 0.008 * fwd);
    out.dir += -0.35 * fwd;                     // uphill pulls left, downhill pushes right
    out.axis += -0.30 * fwd;                    // uphill -> draw tendency, downhill -> fade
    // Uneven stance costs balance and centred contact
    const balance = 1 - 0.0035 * Math.abs(fwd) - 0.003 * Math.abs(side) - 0.00012 * fwd * fwd;
    // More loft means less energy transfer (smash drops as loft rises)
    const loftTransfer = 1 - 0.0025 * fwd;
    out.ballSpeed = shot.ballSpeed * balance * loftTransfer;

    // 3) Impact surface
    const lie = LIES[cond.lie] || LIES.fairway;
    out.ballSpeed *= lie.speed;
    out.spin *= lie.spin;
    out.launch += lie.launch;
    out.dir += lie.dir;
    out.axis += lie.axis;
    out.spread = lie.spread * (1 + 0.03 * (Math.abs(side) + Math.abs(fwd)));

    // 4) Weather at impact (wet ball / face)
    const w = WEATHER[cond.weather] || WEATHER.sunny;
    out.spin *= w.spin;
    out.ballSpeed *= w.speed;

    // 5) Ball temperature changes the core's resilience (COR): ~0.07 %/degC around 15 degC
    const tBall = cond.temperature == null ? 15 : cond.temperature;
    out.ballSpeed *= 1 + 0.0007 * Math.max(-25, Math.min(20, tBall - 15));

    out.notes = notes;
    return out;
  }

  // ---------- flight integration ----------
  function simulate(input) {
    const env = input.env;
    const cond = input.cond;
    const shot = applyConditions(input.shot, cond);
    const hand = input.shot.hand === 'L' ? -1 : 1;

    const weather = WEATHER[cond.weather] || WEATHER.sunny;
    const rh = weather.rh != null ? Math.max(weather.rh, env.humidity) : env.humidity;
    const pressure = env.pressure != null ? env.pressure : pressureAtAltitude(env.altitude || 0);
    const rho = airDensity(env.temperature, pressure, rh);
    const mu = airViscosity(env.temperature);
    const dimpled = input.dimpled !== false;
    const dragMult = weather.drag;

    // initial velocity
    const la = shot.launch * DEG;
    const da = shot.dir * DEG;
    const v0 = shot.ballSpeed;
    let vel = [v0 * Math.cos(la) * Math.cos(da), v0 * Math.sin(la), v0 * Math.cos(la) * Math.sin(da)];
    let pos = [0, 0, 0];

    // spin axis: perpendicular to the initial velocity, tilted by `axis` (+ = fade for RH)
    const vh = v3.norm(vel);
    const sideU = v3.norm(v3.cross(vh, [0, 1, 0]));
    const upU = v3.norm(v3.cross(sideU, vh));
    const ax = shot.axis * DEG;
    const spinAxis = v3.norm(v3.sub(v3.mul(sideU, Math.cos(ax)), v3.mul(upU, Math.sin(ax))));
    const omega0 = shot.spin * RPM_TO_RADS;
    const tau = input.spinDecay || 24;           // spin decay time constant [s]

    const targetH = env.elevation || 0;          // target is this high above the ball [m]
    const k = 0.5 * rho * BALL_AREA / BALL_MASS;

    function accel(p, v, t) {
      const w = windAt(p[1], env);
      const vr = v3.sub(v, w);                  // velocity relative to air
      const speed = v3.len(vr) || 1e-9;
      const omega = omega0 * Math.exp(-t / tau);
      const S = BALL_R * omega / speed;
      const Re = rho * speed * BALL_DIAM / mu;
      const cd = dragCoeff(Re, S, dimpled) * dragMult;
      const cl = liftCoeff(S, dimpled);
      const aDrag = v3.mul(vr, -k * cd * speed);
      const liftDir = v3.norm(v3.cross(spinAxis, vr));
      const aLift = v3.mul(liftDir, k * cl * speed * speed);
      return { a: v3.add(v3.add(aDrag, aLift), [0, -G, 0]), cd, cl, S, Re };
    }

    const dt = input.dt || 0.004;
    let t = 0;
    const pts = [{ t: 0, x: 0, y: 0, z: 0, v: v0 }];
    let apex = { y: 0, x: 0, t: 0 };
    let maxT = 20;
    let landed = null;
    let cdLog = 0, clLog = 0, nLog = 0;
    let ascending = true;

    while (t < maxT) {
      // RK4
      const k1 = accel(pos, vel, t);
      const p2 = v3.add(pos, v3.mul(vel, dt / 2)), v2 = v3.add(vel, v3.mul(k1.a, dt / 2));
      const k2 = accel(p2, v2, t + dt / 2);
      const p3 = v3.add(pos, v3.mul(v2, dt / 2)), v3_ = v3.add(vel, v3.mul(k2.a, dt / 2));
      const k3 = accel(p3, v3_, t + dt / 2);
      const p4 = v3.add(pos, v3.mul(v3_, dt)), v4 = v3.add(vel, v3.mul(k3.a, dt));
      const k4 = accel(p4, v4, t + dt);
      const newPos = v3.add(pos, v3.mul(v3.add(v3.add(vel, v3.mul(v2, 2)), v3.add(v3.mul(v3_, 2), v4)), dt / 6));
      const newVel = v3.add(vel, v3.mul(v3.add(v3.add(k1.a, v3.mul(k2.a, 2)), v3.add(v3.mul(k3.a, 2), k4.a)), dt / 6));
      cdLog += k1.cd; clLog += k1.cl; nLog++;
      t += dt;

      if (newPos[1] > apex.y) apex = { y: newPos[1], x: newPos[0], t };
      if (newVel[1] < 0) ascending = false;

      // landing: descending through target height (or ground if the ball never reaches it)
      const floor = ascending ? -Infinity : (apex.y > targetH ? targetH : Math.min(0, targetH));
      if (!ascending && newPos[1] <= floor) {
        const f = (pos[1] - floor) / ((pos[1] - newPos[1]) || 1e-9);
        const lp = v3.add(pos, v3.mul(v3.sub(newPos, pos), f));
        const lv = v3.add(vel, v3.mul(v3.sub(newVel, vel), f));
        const lt = t - dt + dt * f;
        pts.push({ t: lt, x: lp[0], y: lp[1], z: lp[2] * hand, v: v3.len(lv) });
        landed = { pos: lp, vel: lv, t: lt, omega: omega0 * Math.exp(-lt / tau), floor };
        break;
      }
      pos = newPos; vel = newVel;
      if (pts.length === 0 || t - pts[pts.length - 1].t >= 0.02) {
        pts.push({ t, x: pos[0], y: pos[1], z: pos[2] * hand, v: v3.len(vel) });
      }
    }
    if (!landed) {
      landed = { pos, vel, t, omega: omega0 * Math.exp(-t / tau), floor: pos[1] };
    }

    // ---------- bounce & roll ----------
    const surfKey = cond.landing || 'fairway';
    const surf = SURFACES[surfKey] || SURFACES.fairway;
    const eScale = surf.e * weather.groundE;
    const rollRes = surf.roll * weather.groundRoll;
    const plow = Math.min(0.95, surf.plow * (weather.groundRoll > 1 ? 1 + 0.25 * (weather.groundRoll - 1) : 1));
    const crater = surf.crater * (weather.groundRoll > 1 ? 1 + 0.15 * (weather.groundRoll - 1) : 1);
    const roll = bounceAndRoll(landed, spinAxis, surf.mu, eScale, rollRes, plow, crater);

    const lv = landed.vel;
    const landAngle = Math.atan2(-lv[1], Math.hypot(lv[0], lv[2])) / DEG;
    const carryPt = landed.pos;
    const finalPt = roll.final;

    return {
      input,
      applied: shot,
      airDensity: rho,
      pressure,
      humidity: rh,
      trajectory: pts,
      bounce: roll.path.map((p) => ({ x: p[0], y: p[1], z: p[2] * hand })),
      carry: carryPt[0],
      carryLateral: carryPt[2] * hand,
      carryDist: Math.hypot(carryPt[0], carryPt[2]),
      total: finalPt[0],
      totalLateral: finalPt[2] * hand,
      totalDist: Math.hypot(finalPt[0], finalPt[2]),
      rollOut: finalPt[0] - carryPt[0],
      apex: apex.y,
      apexX: apex.x,
      apexT: apex.t,
      flightTime: landed.t,
      landAngle,
      landSpeed: v3.len(lv),
      landSpin: landed.omega / RPM_TO_RADS,
      landHeight: landed.floor,
      reachedTarget: apex.y >= targetH,
      avgCd: cdLog / (nLog || 1),
      avgCl: clLog / (nLog || 1),
      spinBack: roll.spinBack,
    };
  }

  // Simple rigid-ball impact model on a horizontal deformable surface.
  function bounceAndRoll(landed, spinAxis, mu, eScale, rollRes, plow, crater) {
    let p = landed.pos.slice();
    const path = [p.slice()];
    let v = landed.vel.slice();
    // backspin component about the horizontal axis perpendicular to travel direction
    let hdir = v3.norm([v[0], 0, v[2]]);
    const sideH = v3.norm(v3.cross(hdir, [0, 1, 0]));
    let wb = landed.omega * v3.dot(spinAxis, sideH);     // backspin [rad/s] (+ = backspin)
    let spinBack = false;
    let bounces = 0;

    while (bounces < 8) {
      const vy = -v[1];
      if (vy <= 0) break;
      const vhG = Math.hypot(v[0], v[2]);
      // Crater: contact plane tilts up toward the ball by thC, so work in that tilted frame.
      const thC = Math.min(25, crater * vy) * DEG;  // deeper crater for steeper, faster impacts
      const vn = vy * Math.cos(thC) + vhG * Math.sin(thC);
      const vh = vhG * Math.cos(thC) - vy * Math.sin(thC);
      // Normal restitution drops with impact speed (Penner-style fit), scaled by surface.
      const e = Math.max(0.02, Math.min(0.6, (0.510 - 0.0375 * vn + 0.000903 * vn * vn) * eScale));
      const J = mu * (1 + e) * vn;                    // max tangential impulse per unit mass
      const slip = vh + BALL_R * wb;                  // contact-point slip speed
      let vh2, wb2, rolling = false;
      if (J >= (2 / 7) * Math.abs(slip)) {           // friction brings it to rolling
        vh2 = vh - (2 / 7) * slip;
        rolling = true;
      } else {
        const s = Math.sign(slip);
        vh2 = vh - s * J;
        wb2 = wb - s * (5 / 2) * J / BALL_R;
      }
      // Turf deformation (ball mark / plowing) removes extra horizontal speed.
      const keep = Math.max(0.05, 1 - plow * vn / 10);
      vh2 *= keep;
      if (rolling) wb2 = -vh2 / BALL_R;               // stays rolling at the reduced speed
      else if (wb2 < 0) wb2 *= keep;                  // embedded ball also loses forward roll
      // back to the level frame
      const vnOut = e * vn;
      const vh2G = vh2 * Math.cos(thC) + vnOut * Math.sin(thC);
      const vy2 = Math.max(0, vnOut * Math.cos(thC) - vh2 * Math.sin(thC));
      vh2 = vh2G;
      v = [hdir[0] * vh2, vy2, hdir[2] * vh2];
      wb = wb2;
      bounces++;
      if (vy2 < 0.6) break;
      // ballistic hop (low speed, aerodynamics negligible)
      const th = 2 * vy2 / G;
      const steps = 8;
      for (let i = 1; i <= steps; i++) {
        const tt = th * i / steps;
        path.push([p[0] + v[0] * tt, p[1] + vy2 * tt - 0.5 * G * tt * tt, p[2] + v[2] * tt]);
      }
      p = [p[0] + v[0] * th, p[1], p[2] + v[2] * th];
      v = [v[0], -vy2, v[2]];
    }
    // Slide-to-roll transition: remaining backspin brakes the ball (angular momentum about
    // the contact point is conserved) -> v_roll = 5/7 v - 2/7 r w_b. Negative = spins back.
    const vh = v[0] * hdir[0] + v[2] * hdir[2];
    const vRoll = (5 / 7) * vh - (2 / 7) * BALL_R * wb;
    if (vRoll < -0.05) spinBack = true;
    // Rolling resistance grows with speed (grass blades): a = c*g*(1 + |v|/8)
    //  -> distance x = (8/(c g)) * (v - 8 ln(1 + v/8))
    const c = rollRes * G;
    const sp = Math.abs(vRoll);
    const d = Math.sign(vRoll) * (8 / c) * (sp - 8 * Math.log(1 + sp / 8));
    const final = [p[0] + hdir[0] * d, p[1], p[2] + hdir[2] * d];
    path.push(final.slice());
    return { final, path, spinBack };
  }

  // ---------- standard / baseline ----------
  const STANDARD_ENV = { altitude: 0, temperature: 15, humidity: 50, pressure: null, windSpeed: 0, windDir: 0, elevation: 0 };
  const STANDARD_COND = { sideSlope: 0, fwdSlope: 0, lie: 'fairway', weather: 'sunny', landing: 'fairway', temperature: 15 };

  // ---------- factor attribution ----------
  // Apply each group of conditions alone on top of the standard baseline to see its effect.
  function attribute(input) {
    const base = simulate({ ...input, env: { ...STANDARD_ENV }, cond: { ...STANDARD_COND } });
    const e = input.env, c = input.cond;
    const groups = [
      { key: 'air', ko: '공기 밀도 (고도·기온·습도)', en: 'Air density',
        env: { altitude: e.altitude, temperature: e.temperature, humidity: e.humidity, pressure: e.pressure }, cond: { temperature: e.temperature } },
      { key: 'wind', ko: '바람', en: 'Wind', env: { windSpeed: e.windSpeed, windDir: e.windDir, windShear: e.windShear } },
      { key: 'weather', ko: '날씨 (비·안개)', en: 'Weather', cond: { weather: c.weather } },
      { key: 'slope', ko: '경사 라이', en: 'Slope lie', cond: { sideSlope: c.sideSlope, fwdSlope: c.fwdSlope } },
      { key: 'lie', ko: '볼이 놓인 자리', en: 'Ball lie', cond: { lie: c.lie } },
      { key: 'elev', ko: '목표 고저차', en: 'Elevation', env: { elevation: e.elevation } },
      { key: 'landing', ko: '착지면', en: 'Landing surface', cond: { landing: c.landing } },
    ];
    const rows = groups.map((g) => {
      const r = simulate({
        ...input,
        env: { ...STANDARD_ENV, ...(g.env || {}) },
        cond: { ...STANDARD_COND, ...(g.cond || {}) },
      });
      return { ...g, dCarry: r.carry - base.carry, dTotal: r.total - base.total, dSide: r.totalLateral - base.totalLateral };
    });
    return { base, rows };
  }

  // ---------- optimiser ----------
  // Typical launch / spin a club of this loft produces (interpolated from tour data),
  // spin scaled with ball speed. Used to keep the optimiser inside a deliverable window.
  function typicalFor(loft, ballSpeed) {
    const list = Object.values(CLUBS).sort((a, b) => a.loft - b.loft);
    let lo = list[0], hi = list[list.length - 1];
    for (let i = 0; i < list.length - 1; i++) {
      if (loft >= list[i].loft && loft <= list[i + 1].loft) { lo = list[i]; hi = list[i + 1]; break; }
    }
    const f = hi.loft === lo.loft ? 0 : Math.max(0, Math.min(1, (loft - lo.loft) / (hi.loft - lo.loft)));
    const lerp = (a, b) => a + (b - a) * f;
    const bs = lerp(lo.clubSpeed * lo.smash, hi.clubSpeed * hi.smash);
    return { launch: lerp(lo.launch, hi.launch), spin: lerp(lo.spin, hi.spin) * Math.sqrt(ballSpeed / bs) };
  }

  // Search launch angle & spin that maximise carry (or total) for the current ball speed
  // and conditions, inside the window a club of this loft can deliver.
  // For 'total' the landing angle must stay >= minLand so the ball still holds a
  // fairway/green (a low skipping shot is not a playable solution).
  function optimise(input, goal, minLand) {
    goal = goal || 'carry';
    minLand = minLand == null ? 30 : minLand;
    const typ = typicalFor(input.shot.loft, input.shot.ballSpeed);
    const lMin = Math.max(3, typ.launch - 5), lMax = typ.launch + 6;
    const sMin = Math.max(1700, typ.spin * 0.65), sMax = typ.spin * 1.25;
    let best = null;
    const run = (launch, spin) => {
      if (launch < lMin || launch > lMax || spin < sMin || spin > sMax) return;
      const r = simulate({ ...input, dt: 0.01, shot: { ...input.shot, launch, spin } });
      if (goal === 'total' && r.landAngle < minLand) return;
      const score = goal === 'carry' ? r.carry : r.total;
      if (!best || score > best.score) best = { launch, spin, score, carry: r.carry, total: r.total, apex: r.apex, landAngle: r.landAngle };
    };
    const ls = (lMax - lMin) / 7, ss = (sMax - sMin) / 7;
    for (let i = 0; i <= 7; i++) for (let j = 0; j <= 7; j++) run(lMin + i * ls, sMin + j * ss);
    if (!best) return null;
    const c = { ...best };
    for (let i = -4; i <= 4; i++) for (let j = -4; j <= 4; j++) run(c.launch + i * ls / 4, c.spin + j * ss / 4);
    best.window = { lMin, lMax, sMin, sMax, typ };
    return best;
  }

  // ---------- shot shape classifier ----------
  function classify(res) {
    const hand = res.input.shot.hand === 'L' ? -1 : 1;
    const start = res.applied.dir;           // deg (RH frame), + = right
    const axis = res.applied.axis;           // deg (RH frame), + = fade/slice
    const startTxt = start < -1.5 ? 'pull' : start > 1.5 ? 'push' : 'straight';
    let shape;
    if (Math.abs(axis) < 2) shape = 'straight';
    else if (axis < 0) shape = axis < -9 ? 'hook' : 'draw';
    else shape = axis > 9 ? 'slice' : 'fade';
    // curvature relative to the start line (includes wind drift)
    const curve = res.carryLateral * hand - Math.tan(start * DEG) * res.carry;
    const heightTxt = res.apex > 36 ? 'high' : res.apex < 18 && res.carry > 110 ? 'low' : 'mid';
    const names = {
      straight: ['스트레이트', 'Straight'], draw: ['드로우', 'Draw'], hook: ['훅', 'Hook'],
      fade: ['페이드', 'Fade'], slice: ['슬라이스', 'Slice'],
      pull: ['왼쪽 출발 (풀)', 'Pull'], push: ['오른쪽 출발 (푸시)', 'Push'],
      high: ['높은 탄도', 'High'], mid: ['중간 탄도', 'Mid'], low: ['낮은 탄도', 'Low'],
    };
    return { start: startTxt, shape, height: heightTxt, curve, names };
  }

  const api = {
    G, BALL_MASS, BALL_DIAM, BALL_R, BALL_AREA, DEG, RPM_TO_RADS, M_TO_YD, MS_TO_MPH,
    AERO, CLUBS, LIES, SURFACES, WEATHER, STANDARD_ENV, STANDARD_COND,
    saturationVaporPressure, pressureAtAltitude, airDensity, airViscosity,
    dragCoeff, liftCoeff, windAt, applyConditions, simulate, attribute, typicalFor, optimise, classify,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GolfPhysics = api;
})(typeof window !== 'undefined' ? window : globalThis);
