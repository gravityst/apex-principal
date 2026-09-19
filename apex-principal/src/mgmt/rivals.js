/**
 * APEX: Principal — the other nine teams.
 *
 * THE RULE OF THIS FILE: nothing here reads the player's results, the player's
 * car, or the player's championship position. Rivals develop against their own
 * budget, their own convictions and their own weaknesses. If you have a season
 * off, they get further away. If you build the fastest car on the grid, they do
 * not mysteriously find half a second to match it — they find whatever their
 * own factory earned them, and you pull clear until they out-develop you again.
 *
 * What keeps the field close over the years is not the player. It is the same
 * three things that keep a real championship close: development gets more
 * expensive the further you push it, the budget cap stops money solving
 * everything, and the regulations periodically throw part of the work away.
 */

import { AREA_IDS } from './carspec.js';
import { runDevelopment, allocateByWeights, costPerPoint } from './rnd.js';
import { FACILITIES, upgradeCost } from './facilities.js';
import { BUDGET_CAP } from './finance.js';

/**
 * Each team believes something different about how to build a racing car.
 * Doctrines drift over seasons but rarely flip, which is what gives a team a
 * recognisable character across a long save.
 */
const DOCTRINES = {
  aeroLed: { aero: 3.0, efficiency: 2.2, power: 1.0, energy: 0.8, mechanical: 1.6, lightweight: 1.0, tyres: 1.2, reliability: 1.0, name: 'Aero-led' },
  powerLed: { aero: 1.2, efficiency: 1.6, power: 3.0, energy: 2.2, mechanical: 1.2, lightweight: 1.0, tyres: 0.9, reliability: 1.1, name: 'Power-led' },
  mechanical: { aero: 1.4, efficiency: 1.3, power: 1.2, energy: 0.9, mechanical: 3.0, lightweight: 1.8, tyres: 1.6, reliability: 1.1, name: 'Chassis-led' },
  efficiency: { aero: 1.6, efficiency: 3.0, power: 1.4, energy: 1.6, mechanical: 1.5, lightweight: 1.6, tyres: 1.3, reliability: 1.0, name: 'Efficiency-led' },
  balanced: { aero: 1.6, efficiency: 1.5, power: 1.5, energy: 1.2, mechanical: 1.6, lightweight: 1.2, tyres: 1.3, reliability: 1.3, name: 'Balanced' },
  conservative: { aero: 1.2, efficiency: 1.2, power: 1.1, energy: 0.9, mechanical: 1.3, lightweight: 0.9, tyres: 1.7, reliability: 2.6, name: 'Reliability-first' },
};

export const DOCTRINE_IDS = Object.keys(DOCTRINES);

/**
 * Commercial strength, independent of results: who has a parent manufacturer,
 * who is running on sponsorship and hope. This decides how close a team can get
 * to the budget cap in a bad year.
 */
const RESOURCES = {
  velocitas: 1.00, argentum: 0.97, scuderia: 0.95, meridian: 0.80, aurora: 0.72,
  monolith: 0.86, nimbus: 0.68, halcyon: 0.62, cobalt: 0.58, apexion: 0.66,
};

const START_DOCTRINE = {
  velocitas: 'aeroLed', argentum: 'efficiency', scuderia: 'powerLed', meridian: 'balanced',
  aurora: 'aeroLed', monolith: 'powerLed', nimbus: 'mechanical', halcyon: 'balanced',
  cobalt: 'conservative', apexion: 'mechanical',
};

/** Attach the AI-side fields to a team record. */
export function initRival(team, rng) {
  team.doctrine = START_DOCTRINE[team.id] || rng.pick(DOCTRINE_IDS);
  team.resources = RESOURCES[team.id] ?? 0.7;
  // Competence is how well a team converts money into lap time. It is
  // deliberately INDEPENDENT of how rich a team is: a well-run small team
  // beating a badly-run works outfit is the whole reason the player's job
  // exists, and tying the two together would make money the only thing that
  // mattered. It drifts across seasons, so teams have eras.
  team.competence = Math.max(0.58, Math.min(1.28, rng.normal(0.95, 0.105)));
  team.ambition = rng.range(0.55, 1.0);
  return team;
}

/**
 * Development money a rival has this season, in millions.
 *
 * This is money left AFTER running the team, exactly like the player's. Rivals
 * used to get a gross figure while the player paid wages, upkeep and travel out
 * of theirs, which quietly made every AI team roughly twice as well funded as
 * the human and put the front of the grid permanently out of reach.
 */
export function rivalBudget(team, lastSeasonPosition = 5) {
  const commercial = 78 + team.resources * 74;
  const prize = 62 - (lastSeasonPosition - 1) * 5.2;
  // A bigger operation costs more to run, which is why a works team's advantage
  // is real but nothing like as large as its turnover suggests.
  const running = 48 + team.resources * 36;
  return Math.max(12, Math.min(BUDGET_CAP, Math.round((commercial + prize * 0.62 - running) * 10) / 10));
}

/**
 * Where a rival puts its money this round.
 *
 * Two inputs only, both internal: its doctrine, and where its own car is
 * weakest relative to its own average. A team that has neglected reliability
 * and keeps breaking down will start fixing reliability — because its own
 * cars keep stopping, not because of anything the player did.
 */
export function rivalAllocation(team, budgetThisRound, rng) {
  const doc = DOCTRINES[team.doctrine] || DOCTRINES.balanced;
  const weights = {};

  let mean = 0;
  for (const id of AREA_IDS) mean += team.spec[id] ?? 0;
  mean /= AREA_IDS.length;

  for (const id of AREA_IDS) {
    const level = team.spec[id] ?? 0;
    // Doctrine sets the shape.
    let w = doc[id] ?? 1;
    // Self-correction: an area lagging its own car gets attention.
    const lag = (mean - level) / 30;                // + when this area is behind
    w *= 1 + Math.max(-0.45, Math.min(0.9, lag));
    // Value for money: a team is not blind to diminishing returns.
    w *= 1 / Math.pow(costPerPoint(level) / costPerPoint(mean), 0.55);
    // Engineering is a human business.
    w *= rng.range(0.80, 1.22);
    weights[id] = Math.max(0.02, w);
  }

  // A team that has just had a bad run of reliability throws money at it.
  if ((team.seasonRetirements ?? 0) >= 3) weights.reliability *= 1.9;

  return allocateByWeights(budgetThisRound, weights);
}

/**
 * Advance one rival by one round of development. Same `runDevelopment` the
 * player's factory uses.
 */
export function developRival(team, budgetThisRound, rng) {
  const alloc = rivalAllocation(team, budgetThisRound * team.competence, rng);
  const res = runDevelopment(team, alloc, rng);
  team.spentThisSeason = (team.spentThisSeason ?? 0) + budgetThisRound;
  return res;
}

/**
 * Off-season moves: facilities, doctrine drift, and the occasional shake-up.
 * Returns a list of news items for the player's inbox — rivals should be
 * visibly doing things, not silently gaining numbers.
 */
export function rivalOffseason(team, rng, lastPosition) {
  const news = [];
  const budget = rivalBudget(team, lastPosition);

  // Facility investment, in proportion to ambition and money left over.
  let spare = budget * rng.range(0.10, 0.26) * team.ambition;
  const order = rng.shuffle(FACILITIES.map((f) => f.id));
  for (const id of order) {
    const cost = upgradeCost(team.facilities, id);
    if (cost == null || cost > spare) continue;
    team.facilities[id] += 1;
    spare -= cost;
    const f = FACILITIES.find((x) => x.id === id);
    news.push({
      kind: 'facility',
      team: team.name,
      text: `${team.name} have commissioned a ${f.levels[team.facilities[id] - 1].name.toLowerCase()} — their ${f.name.toLowerCase()} programme steps up.`,
    });
  }

  // Competence drifts. Good people arrive and leave; a concept comes good or
  // runs out of road.
  const drift = rng.normal(0, 0.055);
  team.competence = Math.max(0.55, Math.min(1.3, team.competence + drift));
  if (drift > 0.085) {
    news.push({ kind: 'form', team: team.name, text: `${team.name} have restructured their technical group over the winter. Expect them to be stronger.` });
  } else if (drift < -0.085) {
    news.push({ kind: 'form', team: team.name, text: `${team.name} have lost senior technical staff. Their winter has not gone well.` });
  }

  // Doctrine occasionally changes — usually after a poor season.
  const changeChance = lastPosition >= 7 ? 0.28 : 0.09;
  if (rng.chance(changeChance)) {
    const old = DOCTRINES[team.doctrine].name;
    team.doctrine = rng.pick(DOCTRINE_IDS.filter((d) => d !== team.doctrine));
    news.push({
      kind: 'doctrine', team: team.name,
      text: `${team.name} have abandoned their ${old.toLowerCase()} philosophy for a ${DOCTRINES[team.doctrine].name.toLowerCase()} concept.`,
    });
  }

  team.seasonRetirements = 0;
  team.spentThisSeason = 0;
  return news;
}

export function doctrineName(id) {
  return (DOCTRINES[id] || DOCTRINES.balanced).name;
}
