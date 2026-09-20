/**
 * APEX: Principal — money.
 *
 * Everything is in millions. The budget cap is the spine of the whole design:
 * it stops the richest team simply outspending the problem, which is what keeps
 * a well-run small team competitive and what makes *where* you spend matter
 * more than *how much* you have.
 */

import { PRIZE_MONEY } from './calendar.js';

export const BUDGET_CAP = 125;          // millions per season, on car development
export const BASE_OPERATING = 20;       // millions per season, outside the cap

/**
 * How much of a year's development happens over the winter.
 *
 * In-season upgrades are worth real time, but the single biggest step any team
 * takes is the car it turns up with in March. A season where development is
 * spread evenly over the rounds has no winter in it at all: nobody arrives
 * transformed, nobody arrives having got it wrong, and the order in March is
 * the order from last November. A third of the money, spent in one go with
 * the whole calendar still to come, is what makes a winter matter.
 */
export const WINTER_SHARE = 0.35;

/** How many of each sponsor tier a team can carry at once. */
export const SPONSOR_SLOTS = { title: 1, major: 2, minor: 3 };

/** Below this, the board loses patience and you lose the job. */
export const DISMISSAL_BALANCE = -60;

const SPONSOR_NAMES = {
  title: ['ORAVAX', 'KINETIQ', 'HELION', 'STRATOS', 'TITANIS', 'QUANTA', 'NOVAFUEL', 'AERONOVA'],
  major: ['VESPRA', 'CASTELL', 'ZENTARA', 'PULSE', 'HYDRON', 'OBSIDIAN', 'VOLTIC', 'ORBITAL', 'TERRAFIN', 'AQUEVA'],
  minor: ['MARANO', 'BWX', 'AERIS', 'CASH-X', 'SOLARIX', 'DELTAWING', 'IRONHOLT', 'NORDVIK', 'PARAGON', 'VANTA'],
};

const TIER = {
  title: { base: 44, perPos: 2.9, bonusScale: 1.0 },
  major: { base: 19, perPos: 1.3, bonusScale: 0.55 },
  minor: { base: 7.5, perPos: 0.5, bonusScale: 0.28 },
};

/**
 * Generate a sponsor offer. Better-placed teams are offered more money and
 * harder clauses; a backmarker gets a small cheque and an easy target.
 *
 * @param standing  expected constructors' position, 1..10
 */
export function makeSponsorOffer(rng, tier, standing, season) {
  const t = TIER[tier];
  const strength = (11 - standing) / 10;                     // 0.1 .. 1.0
  // The curve is deliberately shallow at the bottom. A backmarker has to be
  // able to fund its way out, or a bad season becomes a spiral that no amount
  // of good management can escape.
  const fee = Math.round((t.base * (0.62 + strength * 0.62)) * rng.range(0.88, 1.14) * 10) / 10;

  // The clause is pitched just beyond what the team is currently managing, so
  // it is worth chasing and not a formality.
  const target = Math.max(1, Math.round(standing - rng.int(0, 2)));
  const clauses = [];
  clauses.push({
    type: 'constructors',
    target,
    amount: Math.round(fee * rng.range(0.30, 0.55) * 10) / 10,
    label: `Finish the season ${ordinal(target)} or better in the constructors'`,
  });
  if (standing <= 7) {
    clauses.push({
      type: 'podiums',
      target: Math.max(1, Math.round((8 - standing) * rng.range(0.6, 1.1))),
      amount: Math.round(fee * rng.range(0.18, 0.34) * 10) / 10,
      label: null,
    });
  }
  clauses.push({
    type: 'points-finishes',
    target: Math.max(2, Math.round((12 - standing) * rng.range(0.8, 1.3))),
    amount: Math.round(fee * rng.range(0.14, 0.26) * 10) / 10,
    label: null,
  });
  for (const c of clauses) {
    if (!c.label) {
      c.label = c.type === 'podiums'
        ? `${c.target} podium${c.target === 1 ? '' : 's'} this season`
        : `${c.target} points finishes this season`;
    }
  }

  return {
    id: `spn-${Math.floor(rng() * 1e9).toString(36)}`,
    name: rng.pick(SPONSOR_NAMES[tier]),
    tier,
    fee,
    years: rng.int(1, 3),
    signedSeason: season,
    clauses,
  };
}

/** Three offers per tier the team is eligible for, refreshed each off-season. */
export function generateSponsorMarket(rng, standing, season, reputation = 0.5) {
  const market = [];
  const eligible = ['major', 'minor'];
  if (standing <= 8 || reputation > 0.45) eligible.unshift('title');
  for (const tier of eligible) {
    const n = tier === 'title' ? 2 : 3;
    for (let i = 0; i < n; i++) market.push(makeSponsorOffer(rng, tier, standing, season));
  }
  return market;
}

/** Income from sponsors for one race weekend. */
export function sponsorRaceIncome(sponsors, rounds = 10) {
  let sum = 0;
  for (const s of sponsors) sum += s.fee / rounds;   // the fee is a season figure
  return Math.round(sum * 100) / 100;
}

/** Whether another sponsor of this tier can be signed. */
export function canSign(sponsors, tier) {
  const held = sponsors.filter((s) => s.tier === tier).length;
  return held < (SPONSOR_SLOTS[tier] ?? 1);
}

/** Settle every sponsor clause at the end of a season. */
export function settleSponsors(sponsors, seasonStats) {
  const paid = [];
  let total = 0;
  for (const s of sponsors) {
    for (const c of s.clauses) {
      let met = false;
      if (c.type === 'constructors') met = seasonStats.constructorsPosition <= c.target;
      else if (c.type === 'podiums') met = seasonStats.podiums >= c.target;
      else if (c.type === 'points-finishes') met = seasonStats.pointsFinishes >= c.target;
      if (met) { total += c.amount; paid.push({ sponsor: s.name, clause: c.label, amount: c.amount }); }
    }
  }
  return { total: Math.round(total * 10) / 10, paid };
}

/** Constructors' prize money for a finishing position. */
export function prizeMoney(position) {
  return PRIZE_MONEY[Math.max(0, Math.min(PRIZE_MONEY.length - 1, position - 1))];
}

/** Seasonal wage bill, in millions. */
export function wageBill(drivers, staff) {
  let sum = 0;
  for (const d of drivers) sum += d.salary ?? 0;
  for (const k of Object.keys(staff)) sum += staff[k]?.salary ?? 0;
  return Math.round(sum * 10) / 10;
}

/** A ledger entry. Keep them; the finance screen shows the season's history. */
export function entry(round, label, amount, kind) {
  return { round, label, amount: Math.round(amount * 100) / 100, kind };
}

export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** Cost of repairing accident damage, in millions. */
export function damageCost(severity) {
  // severity 0..1, where 1 is a destroyed chassis
  return Math.round((0.4 + severity * severity * 6.5) * 100) / 100;
}
