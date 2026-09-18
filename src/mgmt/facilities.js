/**
 * APEX: Principal — the factory.
 *
 * Facilities do not make the car faster. They make development faster, which
 * is a slower and more interesting kind of decision: money spent on a wind
 * tunnel is money not spent on this month's front wing, and it only pays back
 * if you are still here next season.
 */

export const FACILITIES = [
  {
    id: 'windtunnel',
    name: 'Wind Tunnel',
    blurb: 'Correlation you can trust. Raises aerodynamic output and cuts the chance of a dud upgrade.',
    affects: ['aero', 'efficiency'],
    rate: 0.30,            // multiplier added per level above 1
    levels: [
      { name: 'Leased slot', cost: 0, upkeep: 1.6 },
      { name: '50% closed circuit', cost: 24, upkeep: 2.9 },
      { name: '60% closed circuit', cost: 46, upkeep: 4.5 },
      { name: 'Full-scale tunnel', cost: 88, upkeep: 6.8 },
      { name: 'Full-scale, rolling road', cost: 155, upkeep: 9.7 },
    ],
  },
  {
    id: 'cfd',
    name: 'CFD Cluster',
    blurb: 'Cheap aerodynamic iteration. Less decisive than the tunnel, and far less to run.',
    affects: ['aero', 'efficiency'],
    rate: 0.20,
    levels: [
      { name: 'Rented compute', cost: 0, upkeep: 0.8 },
      { name: 'In-house cluster', cost: 16, upkeep: 1.7 },
      { name: 'Expanded cluster', cost: 34, upkeep: 2.6 },
      { name: 'Dedicated data hall', cost: 62, upkeep: 3.9 },
      { name: 'Exascale partnership', cost: 112, upkeep: 5.8 },
    ],
  },
  {
    id: 'dyno',
    name: 'Powertrain Dyno',
    blurb: 'Combustion and energy recovery development, and engine life.',
    affects: ['power', 'energy'],
    rate: 0.34,
    levels: [
      { name: 'Single-cell dyno', cost: 0, upkeep: 1.3 },
      { name: 'Twin-cell dyno', cost: 22, upkeep: 2.4 },
      { name: 'Transient dyno', cost: 45, upkeep: 4.0 },
      { name: 'Full power-unit test bed', cost: 84, upkeep: 5.9 },
      { name: 'Altitude-capable test bed', cost: 148, upkeep: 8.6 },
    ],
  },
  {
    id: 'machineshop',
    name: 'Machine Shop',
    blurb: 'Turns a drawing into a part. Raises chassis output and cuts what every upgrade costs.',
    affects: ['mechanical', 'lightweight'],
    rate: 0.28,
    levels: [
      { name: 'Outsourced', cost: 0, upkeep: 1.0 },
      { name: 'In-house 5-axis', cost: 19, upkeep: 2.0 },
      { name: 'Composites bay', cost: 38, upkeep: 3.2 },
      { name: 'Additive manufacturing', cost: 71, upkeep: 4.9 },
      { name: 'Integrated production hall', cost: 126, upkeep: 7.3 },
    ],
  },
  {
    id: 'simulator',
    name: 'Driver Simulator',
    blurb: 'Setup work without burning a tyre. Improves practice gains and tyre understanding.',
    affects: ['tyres'],
    rate: 0.26,
    levels: [
      { name: 'Static rig', cost: 0, upkeep: 0.7 },
      { name: 'Motion platform', cost: 17, upkeep: 1.7 },
      { name: '8-axis simulator', cost: 36, upkeep: 3.0 },
      { name: 'Driver-in-loop, live model', cost: 68, upkeep: 4.7 },
      { name: 'Twin rigs, 24-hour running', cost: 118, upkeep: 6.9 },
    ],
  },
  {
    id: 'quality',
    name: 'Quality & Test',
    blurb: 'Rig testing, part tracing, failure analysis. Reliability development and fewer failures.',
    affects: ['reliability'],
    rate: 0.38,
    levels: [
      { name: 'Basic inspection', cost: 0, upkeep: 0.6 },
      { name: 'Rig test cell', cost: 14, upkeep: 1.4 },
      { name: 'Accelerated life testing', cost: 30, upkeep: 2.4 },
      { name: 'Full traceability programme', cost: 56, upkeep: 3.7 },
      { name: 'Predictive failure analysis', cost: 96, upkeep: 5.5 },
    ],
  },
  {
    id: 'pitcrew',
    name: 'Pit Crew Programme',
    blurb: 'Stop time, and how rarely it goes wrong.',
    affects: [],
    rate: 0,
    levels: [
      { name: 'Untrained', cost: 0, upkeep: 0.6 },
      { name: 'Weekly practice', cost: 9, upkeep: 1.2 },
      { name: 'Dedicated crew', cost: 21, upkeep: 2.1 },
      { name: 'Athlete programme', cost: 40, upkeep: 3.2 },
      { name: 'Sub-two-second programme', cost: 70, upkeep: 4.5 },
    ],
  },
];

export const FACILITY_IDS = FACILITIES.map((f) => f.id);

export function makeFacilities(level = 1) {
  const f = {};
  for (const id of FACILITY_IDS) f[id] = level;
  return f;
}

/** Development-rate multiplier for one area, from the facilities that serve it. */
export function facilityMultiplier(facilities, areaId) {
  let m = 1;
  for (const f of FACILITIES) {
    if (!f.affects.includes(areaId)) continue;
    const lvl = (facilities[f.id] ?? 1) - 1;       // 0..4
    m *= 1 + lvl * f.rate * 0.25;
  }
  return m;
}

/** Total seasonal upkeep, in millions. */
export function facilityUpkeep(facilities) {
  let sum = 0;
  for (const f of FACILITIES) {
    const lvl = Math.max(1, Math.min(f.levels.length, facilities[f.id] ?? 1));
    sum += f.levels[lvl - 1].upkeep;
  }
  return Math.round(sum * 10) / 10;
}

/** Cost to take a facility to its next level, or null if it is maxed. */
export function upgradeCost(facilities, id) {
  const f = FACILITIES.find((x) => x.id === id);
  if (!f) return null;
  const lvl = facilities[id] ?? 1;
  if (lvl >= f.levels.length) return null;
  return f.levels[lvl].cost;
}

/**
 * Pit stop time in seconds: the stationary part only. The pit lane transit is
 * computed from the circuit's own pit entry and exit by the race engine.
 */
export function pitStopTime(facilities, rng) {
  const lvl = Math.max(1, Math.min(5, facilities.pitcrew ?? 1));
  const base = [3.55, 3.15, 2.80, 2.50, 2.24][lvl - 1];
  const spread = [0.55, 0.42, 0.32, 0.24, 0.18][lvl - 1];
  const t = base + Math.abs(rng.normal(0, spread));
  // Something goes properly wrong from time to time, and less often with a
  // better-drilled crew.
  const fumbleChance = [0.075, 0.055, 0.038, 0.024, 0.014][lvl - 1];
  if (rng.chance(fumbleChance)) {
    return { time: t + rng.range(2.2, 9.5), fumble: true };
  }
  return { time: t, fumble: false };
}

/** How much a dud upgrade is mitigated by good correlation tools. */
export function developmentReliability(facilities, areaId) {
  const tunnel = (facilities.windtunnel ?? 1) - 1;
  const cfd = (facilities.cfd ?? 1) - 1;
  const quality = (facilities.quality ?? 1) - 1;
  if (areaId === 'aero' || areaId === 'efficiency') return 0.62 + tunnel * 0.06 + cfd * 0.03;
  if (areaId === 'reliability') return 0.70 + quality * 0.055;
  return 0.68 + (tunnel + cfd + quality) * 0.012;
}
