/**
 * APEX: Principal — quasi-steady-state lap solver.
 *
 * This is the arbiter of the whole game. Every development point, every kilo
 * of fuel, every degree of track temperature and every millimetre of tyre wear
 * reaches the timing screen through this file and nowhere else.
 *
 * Method — the standard three-pass solution for a closed circuit:
 *
 *   1. LIMIT PASS     the cornering speed each point can hold, from the local
 *                     radius against a friction budget that grows with speed
 *                     because downforce grows with speed;
 *   2. BACKWARD PASS  walk the lap in reverse applying the braking limit, so
 *                     every corner pulls its braking zone back up the straight;
 *   3. FORWARD PASS   walk it forwards applying the lesser of the traction and
 *                     power limits.
 *
 * Both passes respect a friction ellipse: a car already using its grip to turn
 * has less left for accelerating or braking. That single term is why downforce
 * is worth so much more at Neon Harbour than at Crimson Flats, and it falls
 * out of the physics rather than being written into a table.
 *
 * The lap is a ring, so the passes are iterated until the start/finish speed
 * stops moving.
 *
 * Depends only on carspec for the calibration reference; runs in the browser
 * and under node.
 */
import { makeSpec, toPhysics } from './carspec.js';

const G = 9.80665;
const ROLL_RESIST = 0.011;        // coefficient, tyres + driveline losses
const DRIVELINE_EFF = 0.94;
const TRACTION_SHARE = 0.68;      // rear axle share under power, with transfer
const MIN_V = 8;                  // m/s floor, keeps the integration well behaved

/**
 * Solve one flying lap.
 *
 * @param track  from mgmt/track.js
 * @param phys   from carspec.toPhysics()
 * @param cond   {
 *    fuelKg, gripMul, wet, rho, ersOn, pace,
 *    tyreGrip  — compound + wear + temperature, as a multiplier on mu
 * }
 * @returns { time, raw, speeds, vmax, vavg, sectors, ersTime }
 */
export function solveLap(track, phys, cond = {}) {
  const n = track.samples;
  const ds = track.step;
  const rho = cond.rho ?? 1.20;
  const fuel = cond.fuelKg ?? 0;
  const mass = phys.mass + fuel;

  // Grip on the day: compound and wear (tyreGrip), surface water (wet), plus
  // any blanket modifier the caller wants (gripMul).
  const wet = cond.wet ?? 0;
  const mu = phys.mu
    * (cond.tyreGrip ?? 1)
    * (cond.gripMul ?? 1)
    * (1 - wet * 0.26);

  // A driver running at 97% of the car's limit is not 3% slower round the lap;
  // the pace factor scales the grip the solver is allowed to use.
  const pace = cond.pace ?? 1;
  const muEff = mu * pace;

  const kDown = 0.5 * rho * phys.clA;    // N per (m/s)²
  const kDrag = 0.5 * rho * phys.cdA;

  const v = new Float64Array(n);
  const vLim = new Float64Array(n);
  const powerLimited = new Uint8Array(n);

  // Absolute ceiling: where drag eats all the power.
  const pMax = phys.powerICE * DRIVELINE_EFF;
  const vCeil = Math.cbrt(pMax / Math.max(1e-6, kDrag)) * 1.02;

  // ---- 1. cornering limit -------------------------------------------------
  for (let i = 0; i < n; i++) {
    const k = Math.abs(track.curv[i]);
    if (k < 1e-6) { vLim[i] = vCeil; continue; }
    const R = 1 / k;
    // m v²/R = mu (m g + kDown v²)  →  v² (m/R − mu·kDown) = mu·m·g
    const denom = mass / R - muEff * kDown;
    if (denom <= 1e-9) { vLim[i] = vCeil; continue; }   // aero-limited: flat out
    const vv = (muEff * mass * G) / denom;
    vLim[i] = Math.min(vCeil, Math.sqrt(Math.max(0, vv)));
  }

  v.set(vLim);

  // ---- 2 & 3. braking and traction passes, iterated round the ring --------
  // Two full sweeps converge the wrap-around; a third changes the lap by well
  // under a millisecond.
  let ersMask = null;
  for (let pass = 0; pass < 3; pass++) {
    // backward — braking
    for (let rep = 0; rep < 2; rep++) {
      for (let j = n - 1; j >= 0; j--) {
        const i = j, next = (j + 1) % n;
        const vi = v[i], vn = v[next];
        if (vi <= vn) continue;
        const vm = (vi + vn) * 0.5;
        const aMax = muEff * (G + (kDown * vm * vm) / mass);
        const aLat = (vm * vm) * Math.abs(track.curv[i]);
        const ell = ellipse(aLat, aMax);
        const aDec = aMax * ell
          + (kDrag * vm * vm) / mass
          + ROLL_RESIST * G
          + G * track.grade[i];
        const cap = Math.sqrt(Math.max(MIN_V * MIN_V, vn * vn + 2 * Math.max(0.5, aDec) * ds));
        if (cap < v[i]) v[i] = cap;
      }
    }

    // forward — traction and power
    for (let rep = 0; rep < 2; rep++) {
      for (let i = 0; i < n; i++) {
        const next = (i + 1) % n;
        const vi = Math.max(MIN_V, v[i]);
        const vm = vi;
        const aMax = muEff * (G + (kDown * vm * vm) / mass);
        const aLat = (vm * vm) * Math.abs(track.curv[i]);
        const ell = ellipse(aLat, aMax);
        const aGrip = aMax * ell * TRACTION_SHARE;

        let power = pMax;
        if (ersMask && ersMask[i]) power += phys.ersPower;
        const aPow = power / (mass * vm);
        powerLimited[i] = aPow < aGrip ? 1 : 0;

        const aNet = Math.min(aGrip, aPow)
          - (kDrag * vm * vm) / mass
          - ROLL_RESIST * G
          - G * track.grade[i];

        if (aNet > 0) {
          const cap = Math.sqrt(vi * vi + 2 * aNet * ds);
          if (cap < v[next]) v[next] = cap;
        } else {
          // Drag-limited: the car is already decelerating at full throttle.
          const cap = Math.sqrt(Math.max(MIN_V * MIN_V, vi * vi + 2 * aNet * ds));
          if (cap < v[next]) v[next] = cap;
        }
      }
    }

    // After the first solved lap, decide where the ERS store is worth spending
    // and re-solve once with it. Deployment only helps where the car is power
    // limited rather than traction limited, and among those points it is worth
    // most where the car spends the most time — so, lowest speed first.
    if (pass === 0 && (cond.ersOn ?? true) && phys.ersEnergy > 0) {
      const budget = phys.ersEnergy / Math.max(1, phys.ersPower);   // seconds
      const cand = [];
      for (let i = 0; i < n; i++) if (powerLimited[i]) cand.push(i);
      cand.sort((a, b) => v[a] - v[b]);
      ersMask = new Uint8Array(n);
      let used = 0;
      for (const i of cand) {
        const dt = ds / Math.max(MIN_V, v[i]);
        if (used + dt > budget) break;
        ersMask[i] = 1;
        used += dt;
      }
      // Re-seed and solve again with deployment available.
      v.set(vLim);
    }
  }

  // ---- integrate ----------------------------------------------------------
  let t = 0, vmax = 0;
  const sectorBounds = track.circuit.sectors || [0.333, 0.666];
  const sectorTimes = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const a = Math.max(MIN_V, v[i]);
    const b = Math.max(MIN_V, v[(i + 1) % n]);
    const dt = (2 * ds) / (a + b);
    t += dt;
    if (a > vmax) vmax = a;
    const u = i / n;
    const si = u < sectorBounds[0] ? 0 : u < sectorBounds[1] ? 1 : 2;
    sectorTimes[si] += dt;
  }

  const cal = calibration(track);
  return {
    raw: t,
    time: t * cal,
    speeds: v,
    vmax,
    vavg: track.length / t,
    sectors: sectorTimes.map((x) => x * cal),
    cal,
  };
}

/** Friction-ellipse: the share of grip still available longitudinally. */
function ellipse(aLat, aMax) {
  if (aMax <= 1e-6) return 0;
  const r = aLat / aMax;
  if (r >= 1) return 0.06;              // already sliding; a sliver remains
  return Math.sqrt(1 - r * r) * 0.94 + 0.06;
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

/**
 * The solver is honest about *relative* effects but its absolute level depends
 * on choices like traction share. Anchor each circuit to the lap record the
 * APEX series has on its books, so the times a principal sees match the world
 * the drivers race in.
 */
const REFERENCE_LEVEL = 88;
let _refPhys = null;
function referencePhys() {
  if (!_refPhys) _refPhys = toPhysics(makeSpec(REFERENCE_LEVEL));
  return _refPhys;
}

function calibration(track) {
  if (track._cal) return track._cal;
  track._cal = 1;                            // avoid recursion on the probe lap
  const probe = solveLap(track, referencePhys(), {
    fuelKg: 12, tyreGrip: 1.0, wet: 0, pace: 1, ersOn: true,
  });
  const record = track.circuit.lapRecord || probe.raw;
  track._cal = record / probe.raw;
  return track._cal;
}

// ---------------------------------------------------------------------------
// Sensitivities — so the race engine does not re-solve 20 cars × 60 laps
// ---------------------------------------------------------------------------

/**
 * Finite-difference the two things that change every single lap: fuel burning
 * off, and grip falling away as the tyre wears. One solve each, then the race
 * engine works in linear terms and stays exact to a few thousandths.
 */
export function lapModel(track, phys, cond = {}) {
  const base = solveLap(track, phys, cond);

  const dFuel = 20;
  const hiFuel = solveLap(track, phys, { ...cond, fuelKg: (cond.fuelKg ?? 0) + dFuel });
  const perKg = (hiFuel.time - base.time) / dFuel;

  const dGrip = 0.06;
  const loGrip = solveLap(track, phys, { ...cond, tyreGrip: (cond.tyreGrip ?? 1) - dGrip });
  const perGrip = (loGrip.time - base.time) / dGrip;    // seconds per unit grip lost

  return {
    base: base.time,
    vmax: base.vmax,
    vavg: base.vavg,
    sectors: base.sectors,
    perKgFuel: perKg,
    perGripLoss: perGrip,
    /** Lap time at an arbitrary fuel load and grip level. */
    at(fuelKg, tyreGrip) {
      return base.time
        + (fuelKg - (cond.fuelKg ?? 0)) * perKg
        + ((cond.tyreGrip ?? 1) - tyreGrip) * perGrip;
    },
  };
}

/**
 * How much each development area is worth at this circuit, in seconds per lap
 * for ten points of development. This is what the factory screen shows the
 * player so they can aim their money at the right department.
 */
export function areaValue(track, spec, toPhysics, areaIds, cond = {}) {
  const basePhys = toPhysics(spec);
  const base = solveLap(track, basePhys, cond).time;
  const out = {};
  for (const id of areaIds) {
    const bumped = { ...spec, [id]: Math.min(110, (spec[id] ?? 0) + 10) };
    const t = solveLap(track, toPhysics(bumped), cond).time;
    out[id] = base - t;                       // seconds gained per +10 points
  }
  return out;
}
