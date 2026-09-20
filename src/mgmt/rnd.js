/**
 * APEX: Principal — research and development.
 *
 * One rule governs this file: it is applied to the player and to all nine
 * rivals by exactly the same code, with exactly the same numbers. There is no
 * branch anywhere that asks whether a team is the player's. Rivals develop on
 * their own budgets and their own convictions, and they will keep developing
 * whether you are chasing them or not.
 *
 * Development is not a guarantee. You buy an expected gain, and then the wind
 * tunnel tells you what you actually got — which is sometimes more than you
 * hoped for and occasionally a part that goes straight in the bin.
 */

import { AREA_IDS } from './carspec.js';
import { facilityMultiplier, developmentReliability } from './facilities.js';
import { staffMultiplier } from './personnel.js';

/** Millions per development point at level zero. */
const COST_BASE = 0.55;

/**
 * Development gets harder the further you have already pushed it. This is what
 * stops a team that wins the first season winning every season after it: the
 * leader is buying points at three times what the backmarker pays.
 */
export function costPerPoint(level) {
  const l = Math.max(0, level) / 100;
  return COST_BASE * (1 + Math.pow(l, 2.4) * 9.5);
}

/** Expected development points from spending `millions` in one area. */
export function expectedPoints(millions, level, facilities, staff, areaId) {
  if (millions <= 0) return 0;
  const mul = facilityMultiplier(facilities, areaId) * staffMultiplier(staff, areaId);
  return (millions * mul) / costPerPoint(level);
}

/**
 * Resolve what a block of development actually delivered.
 *
 * The distribution is deliberately fat-tailed in both directions. A team with
 * a good wind tunnel gets fewer disasters, not bigger successes — correlation
 * buys you certainty, not performance.
 */
export function resolveDelivery(expected, facilities, areaId, rng) {
  if (expected <= 0) return { points: 0, outcome: 'none' };
  const reliability = Math.min(0.94, developmentReliability(facilities, areaId));

  // Outcome bands. The dud band shrinks as correlation improves; the
  // breakthrough band barely moves.
  const pDud = Math.max(0.015, 0.16 * (1 - reliability) * 2.6);
  const pUnder = Math.max(0.04, 0.34 * (1 - reliability) * 2.0);
  const pBreak = 0.085;

  const roll = rng();
  let mul, outcome;
  if (roll < pDud) {
    mul = rng.range(-0.25, 0.18);
    outcome = 'dud';
  } else if (roll < pDud + pUnder) {
    mul = rng.range(0.42, 0.78);
    outcome = 'under';
  } else if (roll > 1 - pBreak) {
    mul = rng.range(1.34, 1.85);
    outcome = 'breakthrough';
  } else {
    mul = rng.normal(1.0, 0.11);
    outcome = 'normal';
  }

  return { points: Math.round(expected * mul * 100) / 100, outcome, multiplier: mul };
}

/** A blank per-area allocation. */
export function emptyAllocation() {
  const a = {};
  for (const id of AREA_IDS) a[id] = 0;
  return a;
}

/** Split `millions` across areas in the given proportions. */
export function allocateByWeights(millions, weights) {
  let total = 0;
  for (const id of AREA_IDS) total += Math.max(0, weights[id] ?? 0);
  const out = emptyAllocation();
  if (total <= 0) return out;
  for (const id of AREA_IDS) out[id] = (millions * Math.max(0, weights[id] ?? 0)) / total;
  return out;
}

/**
 * Run one development block for a team and mutate its spec.
 *
 * @param team        {spec, facilities, staff}
 * @param allocation  {areaId: millions}
 * @param rng
 * @returns per-area report for the factory screen
 */
/**
 * Wind tunnel time, by last season's finish.
 *
 * The sport's own answer to a championship that compounds: the team that won
 * gets the least development time and the team that finished last gets the
 * most. Without something like it the money advantage runs away — the grid
 * here spread from nine points of car to fifteen over four seasons, and it
 * would keep going.
 *
 * It does not cancel the money, and it is not meant to. A winner still ends
 * up with the better car; it just cannot keep pulling away forever, and a
 * team at the back has a road out that does not depend on somebody else
 * failing.
 */
export function testingAllowance(lastSeasonPosition) {
  const p = Math.max(1, Math.min(10, lastSeasonPosition || 5));
  return 0.88 + (p - 1) * (0.28 / 9);                // P1 0.88 .. P10 1.16
}

export function runDevelopment(team, allocation, rng) {
  const report = [];
  let spent = 0;
  const allowance = testingAllowance(team.lastSeasonPosition);
  for (const id of AREA_IDS) {
    const money = Math.max(0, allocation[id] ?? 0);
    if (money <= 0.001) continue;
    spent += money;
    const before = team.spec[id] ?? 0;
    const exp = expectedPoints(money, before, team.facilities, team.staff, id) * allowance;
    const res = resolveDelivery(exp, team.facilities, id, rng);
    const after = Math.max(0, Math.min(112, before + res.points));
    team.spec[id] = Math.round(after * 100) / 100;
    report.push({
      area: id, spend: money,
      expected: Math.round(exp * 100) / 100,
      gained: Math.round((after - before) * 100) / 100,
      outcome: res.outcome,
      before: Math.round(before * 100) / 100,
      after: Math.round(after * 100) / 100,
    });
  }
  return { report, spent: Math.round(spent * 100) / 100 };
}

/** Human-readable outcome text for the factory feed. */
export const OUTCOME_TEXT = {
  breakthrough: 'Breakthrough — it correlated better than the tunnel said it would.',
  normal: 'Delivered as expected.',
  under: 'Underdelivered. Some of it did not translate to the track.',
  dud: 'It did not work. The parts have been shelved.',
  none: '',
};

/**
 * What the team's own engineers think each area is worth, given the remaining
 * calendar. This is advice, not truth: it is computed from the circuits still
 * to come, so it changes as the season goes on.
 */
export function developmentAdvice(tracks, spec, toPhysics, areaValue, remainingRounds, cond = {}) {
  const totals = {};
  for (const id of AREA_IDS) totals[id] = 0;
  for (const r of remainingRounds) {
    const track = tracks[r.circuitId];
    if (!track) continue;
    const v = areaValue(track, spec, toPhysics, AREA_IDS, cond);
    for (const id of AREA_IDS) totals[id] += v[id] * r.laps;
  }
  // Convert to seconds gained over the remaining season per +10 points, then
  // normalise against what each point costs so the advice is value for money.
  const out = [];
  for (const id of AREA_IDS) {
    const perPoint = costPerPoint(spec[id] ?? 0);
    out.push({
      area: id,
      secondsPerTen: totals[id],
      valuePerMillion: totals[id] / Math.max(0.01, perPoint * 10),
    });
  }
  out.sort((a, b) => b.valuePerMillion - a.valuePerMillion);
  return out;
}
