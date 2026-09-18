/**
 * APEX: Principal — the season calendar.
 *
 * Ten rounds over five circuits. Each venue hosts two grands prix a season at
 * opposite ends of the year, which is how the calendar stays short enough to
 * play while still making a wet-weather car worth building: Monsoon Valley in
 * round 4 is a different proposition from Monsoon Valley in round 9.
 */

import { CIRCUITS } from '../data/circuits.js';

/**
 * Weather profiles. `rain` is the probability that the race is affected at all;
 * `severity` scales how hard it falls when it does. `track` is the base track
 * temperature in °C, which drives tyre warm-up and degradation.
 */
const ROUNDS = [
  { circuit: 'aurora-bay',     gp: 'Marenna Grand Prix',        month: 'March',     rain: 0.12, severity: 0.55, air: 19, track: 34, wind: 0.35 },
  { circuit: 'crimson-flats',  gp: 'Desert Grand Prix',         month: 'April',     rain: 0.04, severity: 0.35, air: 31, track: 48, wind: 0.55 },
  { circuit: 'neon-harbour',   gp: 'Harbour Grand Prix',        month: 'May',       rain: 0.22, severity: 0.70, air: 22, track: 33, wind: 0.30 },
  { circuit: 'monsoon-valley', gp: 'Valley Grand Prix',         month: 'June',      rain: 0.62, severity: 0.95, air: 27, track: 38, wind: 0.45 },
  { circuit: 'summit-ridge',   gp: 'Summit Grand Prix',         month: 'July',      rain: 0.26, severity: 0.60, air: 21, track: 36, wind: 0.50 },
  { circuit: 'aurora-bay',     gp: 'Solvaire Bay Grand Prix',   month: 'August',    rain: 0.18, severity: 0.60, air: 26, track: 44, wind: 0.40 },
  { circuit: 'summit-ridge',   gp: 'Mountain Grand Prix',       month: 'September', rain: 0.34, severity: 0.75, air: 16, track: 27, wind: 0.65 },
  { circuit: 'neon-harbour',   gp: 'City Nocturne',             month: 'October',   rain: 0.20, severity: 0.65, air: 18, track: 26, wind: 0.25, night: true },
  { circuit: 'monsoon-valley', gp: 'Monsoon Grand Prix',        month: 'November',  rain: 0.48, severity: 0.85, air: 24, track: 33, wind: 0.40 },
  { circuit: 'crimson-flats',  gp: 'Season Finale',             month: 'December',  rain: 0.06, severity: 0.40, air: 27, track: 41, wind: 0.50 },
];

/** Championship points, positions 1..10, plus a point for the fastest lap. */
export const POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
export const FASTEST_LAP_POINT = 1;

/** Race distance is capped so a full season stays playable. */
function raceLaps(circuit) {
  // The APEX circuits carry a full grand-prix distance; keep roughly 60% of it
  // so a race resolves in a few minutes at speed without losing the shape of a
  // two-stop strategy.
  return Math.max(24, Math.round(circuit.laps * 0.62));
}

export function buildCalendar() {
  return ROUNDS.map((r, i) => {
    const circuit = CIRCUITS.find((c) => c.id === r.circuit);
    if (!circuit) throw new Error(`calendar: unknown circuit ${r.circuit}`);
    return {
      round: i + 1,
      circuitId: r.circuit,
      circuit,
      name: r.gp,
      venue: circuit.name,
      location: `${circuit.location}, ${circuit.country}`,
      month: r.month,
      laps: raceLaps(circuit),
      night: !!r.night,
      weather: { rain: r.rain, severity: r.severity, air: r.air, track: r.track, wind: r.wind },
    };
  });
}

/** Development weeks between one round and the next. */
export const WEEKS_PER_ROUND = 2;

/** Prize money by constructors' championship position, in millions. */
export const PRIZE_MONEY = [62, 54, 47, 41, 36, 31, 27, 23, 19, 15];

/** A short description used on the hub and the weekend header. */
export function circuitCharacter(circuit) {
  const t = circuit.turns || [];
  const slow = t.filter((x) => x.severity === 'slow' || x.severity === 'hairpin').length;
  const fast = t.filter((x) => x.severity === 'fast' || x.severity === 'kink').length;
  if (slow > fast * 1.6) return 'Traction and mechanical grip';
  if (fast > slow * 1.6) return 'High speed, aero-limited';
  return 'Balanced, rewards a complete car';
}
