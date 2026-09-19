/**
 * APEX: Principal — the car, as eight numbers you can spend money on.
 *
 * Every development area maps onto a REAL physical parameter that the lap
 * solver integrates. There is no hidden "pace" stat: if your aero department
 * delivers, `clA` goes up, cornering speed goes up, and the lap time falls out
 * of the physics. That is the whole point of the game — a downforce upgrade is
 * worth more at Neon Harbour than at Crimson Flats because the solver says so,
 * not because a table says so.
 *
 * Levels run 0..100 and represent where a department has got to, not a
 * percentage of some maximum: 100 is the practical ceiling of the current
 * regulations, and regulation changes between seasons claw part of it back.
 */

export const AREAS = [
  {
    id: 'aero',
    name: 'Aerodynamics',
    short: 'AERO',
    blurb: 'Downforce. Buys cornering speed everywhere and costs you top speed.',
    detail: 'Raises CL·A from 3.79 to 4.76 m². Worth most on circuits that spend their time turning.',
  },
  {
    id: 'efficiency',
    name: 'Aero Efficiency',
    short: 'EFF',
    blurb: 'Downforce per unit of drag. The upgrade that costs you nothing.',
    detail: 'Raises the lift-to-drag ratio from 2.72 to 3.24, so the same wing drags less.',
  },
  {
    id: 'power',
    name: 'Power Unit',
    short: 'PWR',
    blurb: 'Combustion power. Straight-line speed and acceleration.',
    detail: 'Raises peak ICE output from 574 kW to 632 kW.',
  },
  {
    id: 'energy',
    name: 'Energy Recovery',
    short: 'ERS',
    blurb: 'How much electrical power you can deploy, and for how long.',
    detail: 'Raises deployment from 110 kW to 132 kW and the per-lap store from 4.0 MJ to 5.0 MJ.',
  },
  {
    id: 'mechanical',
    name: 'Mechanical Grip',
    short: 'MECH',
    blurb: 'Suspension, geometry, platform control. Grip that does not need speed.',
    detail: 'Raises peak tyre friction from 1.845 to 1.975. Decides slow corners and wet races.',
  },
  {
    id: 'lightweight',
    name: 'Lightweight Design',
    short: 'MASS',
    blurb: 'Every kilo is worth about three hundredths of a second a lap.',
    detail: 'Cuts car mass from 826 kg to the 798 kg regulatory floor.',
  },
  {
    id: 'tyres',
    name: 'Tyre Management',
    short: 'TYRE',
    blurb: 'How gently the car uses its tyres. Decides how long a stint can run.',
    detail: 'Scales wear rate from 1.22 down to 0.82, and widens the thermal window.',
  },
  {
    id: 'reliability',
    name: 'Reliability',
    short: 'REL',
    blurb: 'Finishing races. The cheapest points on the board.',
    detail: 'Cuts per-race failure probability from 26% to about 1.5%.',
  },
];

export const AREA_IDS = AREAS.map((a) => a.id);

/** A fresh spec at a uniform level. */
export function makeSpec(level = 50) {
  const s = {};
  for (const id of AREA_IDS) s[id] = level;
  return s;
}

export function cloneSpec(spec) {
  const s = {};
  for (const id of AREA_IDS) s[id] = spec[id] ?? 0;
  return s;
}

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const n01 = (v) => clamp((v ?? 0) / 100, 0, 1.25);   // slight room above 100

/**
 * Turn a development spec into the physical car.
 *
 * @param spec  {aero, efficiency, power, energy, mechanical, lightweight, tyres, reliability}
 * @returns physical parameters in SI units
 */
export function toPhysics(spec) {
  const aero = n01(spec.aero);
  const eff = n01(spec.efficiency);
  const pwr = n01(spec.power);
  const nrg = n01(spec.energy);
  const mech = n01(spec.mechanical);
  const light = n01(spec.lightweight);
  const tyre = n01(spec.tyres);
  const rel = n01(spec.reliability);

  const clA = lerp(3.79, 4.76, aero);
  const ld = lerp(2.72, 3.24, eff);

  return {
    mass: lerp(826, 798, light),          // kg, car + driver, no fuel
    clA,                                   // m², downforce coefficient × area
    cdA: clA / ld,                         // m², drag coefficient × area
    ld,
    powerICE: lerp(574e3, 632e3, pwr),     // W at the crank, peak
    ersPower: lerp(110e3, 132e3, nrg),     // W deployable
    ersEnergy: lerp(4.0e6, 5.0e6, nrg),    // J available per lap
    mu: lerp(1.845, 1.975, mech),          // peak tyre friction coefficient
    wearRate: lerp(1.22, 0.82, tyre),      // multiplier on compound wear
    thermalWindow: lerp(0.80, 1.30, tyre), // how forgiving the operating window is
    failureRate: lerp(0.26, 0.015, rel),   // probability of a race-ending failure
  };
}

/**
 * A single headline number for standings, scouting and the press — a weighted
 * blend, NOT what the solver uses. Never feed this back into lap time.
 */
export function specRating(spec) {
  const w = { aero: 0.22, efficiency: 0.14, power: 0.18, energy: 0.09, mechanical: 0.16, lightweight: 0.07, tyres: 0.09, reliability: 0.05 };
  let sum = 0;
  for (const id of AREA_IDS) sum += (spec[id] ?? 0) * w[id];
  return sum;
}

/** Cheap stable key so solved laps can be cached per distinct car. */
export function specKey(spec) {
  let k = '';
  for (const id of AREA_IDS) k += Math.round((spec[id] ?? 0) * 4) + ',';
  return k;
}

/**
 * Regulation reset. A rules change devalues development that was tuned to the
 * old regulations, which is what stops one team compounding a lead forever.
 *
 * @param spec     the spec to carry over
 * @param carry    per-area carry-over fraction, e.g. {aero: 0.35}
 * @param fallback carry-over for areas not named
 */
export function applyRegulations(spec, carry = {}, fallback = 0.75) {
  const out = {};
  for (const id of AREA_IDS) {
    const f = carry[id] ?? fallback;
    out[id] = Math.round((spec[id] ?? 0) * f * 10) / 10;
  }
  return out;
}
