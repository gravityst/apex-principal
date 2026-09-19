/**
 * APEX: Principal — drivers, staff and the people problems that come with them.
 *
 * The four ratings APEX F1 already gives every driver (skill, aggression,
 * consistency, wet) are kept exactly as they are, so a driver you know from the
 * cockpit behaves like himself on the pit wall. Three more are added here,
 * because a principal has to manage a person rather than drive a car:
 *
 *   temperament  how hot-headed he is under an instruction he disagrees with
 *   morale       how he currently feels about the team
 *   form         a short-run hot or cold streak, which decays back to nothing
 *
 * Together those decide whether the driver you just told to hold position
 * actually holds position.
 */

import { GRID, TEAMS } from '../data/teams.js';
import { makeRng } from './rng.js';

// ---------------------------------------------------------------------------
// Driver pace
// ---------------------------------------------------------------------------

/**
 * The reference: a 0.98-skill driver extracts everything the car has. Each
 * point of skill below that costs grip, and the lap solver turns the lost grip
 * into lost time — roughly 1.3 s a lap between the best driver on the grid and
 * the worst, in the same car.
 */
export function driverPace(driver, ctx = {}) {
  const skill = driver.skill ?? 0.85;
  let p = 1 - (0.98 - skill) * 0.185;

  // Form and morale are small next to raw skill, but they are what makes a
  // season feel like it has a story in it.
  p += (driver.form ?? 0) * 0.0060;
  p += ((driver.morale ?? 0.65) - 0.65) * 0.0075;

  // Wet weather is where the wet rating and the skill rating come apart.
  const wet = ctx.wet ?? 0;
  if (wet > 0) p -= wet * (0.055 - (driver.wet ?? 0.85) * 0.050);

  // Driving mode, as ordered from the pit wall — or as the driver decided.
  const mode = ctx.mode || 'neutral';
  if (mode === 'push') p += 0.0042;
  else if (mode === 'conserve') p -= 0.0078;
  else if (mode === 'hold') p -= 0.0030;

  // Following closely costs front grip in the corners.
  p -= (ctx.dirtyAir ?? 0) * 0.0145;

  // Fuel saving is a real lift off the throttle, not a mood.
  p -= (ctx.fuelSave ?? 0) * 0.0060;

  return p;
}

/** How hard this driver is using the tyres right now, as a wear multiplier. */
export function driverWearFactor(driver, ctx = {}) {
  const smooth = 1 - (driver.aggression ?? 0.75) * 0.22 + (driver.consistency ?? 0.88) * 0.14;
  const mode = ctx.mode || 'neutral';
  const modeMul = mode === 'push' ? 1.26 : mode === 'conserve' ? 0.74 : mode === 'hold' ? 0.88 : 1;
  return Math.max(0.55, smooth) * modeMul * (1 + (ctx.dirtyAir ?? 0) * 0.20);
}

// ---------------------------------------------------------------------------
// Order compliance — the thing the pit wall actually has to worry about
// ---------------------------------------------------------------------------

/**
 * Probability that a driver carries out an instruction.
 *
 * A calm driver on good terms with the team does almost anything asked. A
 * hot-headed driver, low on morale, told to give a place to his teammate while
 * he is quicker, is a coin toss — and that is the point.
 *
 * @param order  'conserve' | 'push' | 'hold' | 'swap' | 'pit' | 'attack'
 */
export function complianceChance(driver, order, ctx = {}) {
  const temperament = driver.temperament ?? 0.4;
  const morale = driver.morale ?? 0.65;
  const aggression = driver.aggression ?? 0.75;

  // Base willingness. A pit call is nearly never refused; being told to move
  // over for a teammate very often is.
  const base = {
    pit: 0.985,
    push: 0.99,
    attack: 0.98,
    conserve: 0.86,
    hold: 0.82,
    swap: 0.58,
  }[order] ?? 0.9;

  let p = base;
  p -= temperament * 0.22;
  p += (morale - 0.65) * 0.34;

  // Orders that ask a driver to go slower are harder to sell the better his
  // race is going.
  if (order === 'conserve' || order === 'hold' || order === 'swap') {
    p -= aggression * 0.14;
    if (ctx.fightingForPosition) p -= 0.16;
    if (ctx.aheadOfTeammate) p -= 0.10;
    if ((ctx.racePosition ?? 20) <= 3) p -= 0.08;
    if (ctx.lapsRemaining != null && ctx.lapsRemaining < 8) p -= 0.10;
  }
  // Late in a race a tyre-saving call is easier to justify if the tyres are shot.
  if (order === 'conserve' && (ctx.tyreWear ?? 0) > 0.7) p += 0.18;

  return Math.max(0.12, Math.min(0.995, p));
}

/** What the driver says when he isn't doing it. */
export const REFUSAL_LINES = {
  conserve: [
    "Negative, I'm not lifting. I've got a run on him.",
    "Tyres are fine. I'm staying on it.",
    "No. Not now. Give me two more laps.",
  ],
  hold: [
    "I'm faster than him. Let me race.",
    "Hold? I'm not holding anything, I'm coming through.",
    "We can talk about it after the flag.",
  ],
  swap: [
    "I'm not moving over. Sort it out later.",
    "No chance. I earned this place.",
    "You're asking the wrong car.",
  ],
  push: ["I'm already flat out, there's nothing left."],
  pit: ["One more lap, one more lap — I can make the gap!"],
  attack: ["Nothing I can do, the car's not there."],
};

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

export const STAFF_ROLES = [
  { id: 'technical', name: 'Technical Director', affects: ['aero', 'efficiency', 'power', 'energy', 'mechanical', 'lightweight', 'tyres', 'reliability'], weight: 0.45, blurb: 'Lifts every department a little. The most expensive signature you will make.' },
  { id: 'aero', name: 'Chief Aerodynamicist', affects: ['aero', 'efficiency'], weight: 1.0, blurb: 'Wind tunnel and CFD output.' },
  { id: 'power', name: 'Head of Powertrain', affects: ['power', 'energy'], weight: 1.0, blurb: 'Combustion and energy recovery.' },
  { id: 'design', name: 'Chief Designer', affects: ['mechanical', 'lightweight'], weight: 1.0, blurb: 'Suspension, structure and mass.' },
  { id: 'reliability', name: 'Head of Reliability', affects: ['reliability', 'tyres'], weight: 1.0, blurb: 'Finishing races, and being kind to tyres.' },
  { id: 'race', name: 'Race Engineer', affects: [], weight: 0, blurb: 'Setup work in practice, and the quality of the strategy you are offered.' },
];

/** R&D multiplier for one area given the current staff. */
export function staffMultiplier(staff, areaId) {
  let m = 1;
  for (const role of STAFF_ROLES) {
    if (!role.affects.includes(areaId)) continue;
    const person = staff[role.id];
    if (!person) { m *= 0.86; continue; }        // the job is vacant
    const above = (person.rating - 0.70) * role.weight;
    m *= 1 + above * 0.62;
  }
  return Math.max(0.55, m);
}

// ---------------------------------------------------------------------------
// Generated people
// ---------------------------------------------------------------------------

const FIRST = ['Kai', 'Elias', 'Luca', 'Mateo', 'Pierre', 'Niklas', 'Yuki', 'Jonas', 'Viktor', 'Alex', 'Tomás', 'Rory', 'Diego', 'Oscar', 'Anouk', 'Sam', 'Liam', 'Andre', 'Zhou', 'Logan', 'Ines', 'Ravi', 'Mikko', 'Enzo', 'Kwame', 'Hugo', 'Petra', 'Nils', 'Salma', 'Theo', 'Ida', 'Bruno', 'Aada', 'Casper', 'Noor', 'Iker', 'Lars', 'Mira', 'Tobias', 'Suki'];
const LAST = ['Renner', 'Vance', 'Bertolini', 'Cruz', 'Vasseur', 'Brandt', 'Sorano', 'Reiter', 'Nyland', 'Marsden', 'Aldair', 'McKellen', 'Salvarez', 'Lindqvist', 'Delacroix', 'Okonkwo', 'Hartley', 'Bassi', 'Ming-Wei', 'Reyes', 'Halvorsen', 'Kestrel', 'Duarte', 'Aaltonen', 'Moreau', 'Weiss', 'Iversen', 'Barbosa', 'Nakamura', 'Olsen', 'Ferreira', 'Lindqvist', 'Sandoval', 'Rask', 'Maroun', 'Bergström', 'Coyle', 'Vargas', 'Adeyemi', 'Haas'];
const COUNTRIES = ['GB', 'IT', 'FR', 'DE', 'ES', 'NL', 'BR', 'JP', 'US', 'AU', 'FI', 'SE', 'MX', 'CA', 'BE', 'DK', 'PT', 'AR', 'ZA', 'NZ'];

export function generateName(rng) {
  return `${rng.pick(FIRST)} ${rng.pick(LAST)}`;
}

export function generateDriver(rng, tier = 0.85, age = null) {
  const skill = clamp01(rng.normal(tier, 0.045));
  return {
    id: `gen-${Math.floor(rng() * 1e9).toString(36)}`,
    num: rng.int(2, 99),
    name: generateName(rng),
    short: null,                       // filled in by the caller from the name
    country: rng.pick(COUNTRIES),
    age: age ?? rng.int(19, 34),
    skill,
    aggression: clamp01(rng.normal(0.74, 0.10)),
    consistency: clamp01(rng.normal(skill - 0.02, 0.055)),
    wet: clamp01(rng.normal(skill - 0.01, 0.065)),
    temperament: clamp01(rng.normal(0.42, 0.18)),
    morale: 0.65,
    form: 0,
    salary: Math.round((2 + Math.pow(Math.max(0, skill - 0.74) * 4.6, 2.3) * 9) * 10) / 10,
    contractYears: rng.int(1, 3),
    helmet: { base: '#20242c', stripe: '#c8c8c8', visor: '#151515' },
  };
}

export function generateStaff(rng, roleId, tier = 0.75) {
  return {
    id: `staff-${Math.floor(rng() * 1e9).toString(36)}`,
    role: roleId,
    name: generateName(rng),
    rating: clamp01(rng.normal(tier, 0.075)),
    age: rng.int(34, 62),
    salary: 0,           // set by the caller from the rating
    contractYears: rng.int(1, 3),
  };
}

function clamp01(v) { return Math.max(0.35, Math.min(0.995, v)); }

/** Salary a staff member of this rating expects, in millions per season. */
export function staffSalary(rating, roleId) {
  const scarcity = roleId === 'technical' ? 2.1 : 1;
  return Math.round((0.6 + Math.pow(Math.max(0, rating - 0.55) * 2.4, 2.1) * 4.4) * scarcity * 10) / 10;
}

/** Salary a driver of this quality expects, in millions per season. */
export function driverSalary(driver) {
  const s = driver.skill ?? 0.85;
  return Math.round((1.6 + Math.pow(Math.max(0, s - 0.74) * 4.6, 2.3) * 9) * 10) / 10;
}

// ---------------------------------------------------------------------------
// Season bookkeeping
// ---------------------------------------------------------------------------

/** Move form toward zero and morale toward its resting point after each race. */
export function decayDriverState(driver) {
  driver.form = (driver.form ?? 0) * 0.62;
  const rest = 0.62;
  driver.morale = (driver.morale ?? rest) + (rest - (driver.morale ?? rest)) * 0.16;
}

/**
 * Apply a race result to a driver's head.
 * @param delta  positions gained versus where the car's pace said he should be
 */
export function applyResultToDriver(driver, { finished, position, expected, teammateBeaten, retired, crashed }) {
  let dm = 0, df = 0;
  if (retired) dm -= crashed ? 0.10 : 0.05;
  if (finished) {
    const over = (expected - position);
    df += Math.max(-1, Math.min(1, over * 0.28));
    dm += Math.max(-0.12, Math.min(0.14, over * 0.035));
    if (position === 1) dm += 0.09;
    else if (position <= 3) dm += 0.05;
    if (teammateBeaten) dm += 0.035; else dm -= 0.030;
  }
  driver.form = Math.max(-1, Math.min(1, (driver.form ?? 0) + df));
  driver.morale = Math.max(0.12, Math.min(1, (driver.morale ?? 0.65) + dm));
}

/** Build the starting 20 from APEX F1's own grid, with the extra traits added. */
export function seedGrid(seed = 20260) {
  const rng = makeRng(seed);
  const teams = TEAMS.map((t) => ({ ...t, drivers: t.drivers.map((d) => ({ ...d })) }));
  for (const t of teams) {
    for (const d of t.drivers) {
      d.id = `${t.id}-${d.num}`;
      d.age = rng.int(20, 36);
      // A driver's temperament correlates with aggression but is not the same
      // thing: plenty of fast, aggressive drivers do exactly as they are told.
      d.temperament = Math.max(0.05, Math.min(0.95, rng.normal(0.18 + d.aggression * 0.42, 0.13)));
      d.morale = 0.65;
      d.form = 0;
      d.salary = driverSalary(d);
      d.contractYears = rng.int(1, 3);
    }
  }
  return { teams, rng };
}

export { GRID };
