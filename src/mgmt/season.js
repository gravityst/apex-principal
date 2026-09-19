/**
 * APEX: Principal — the season loop.
 *
 * Round in, round out: develop, qualify, race, score, bank the money. Then at
 * the end of the year the regulations move, the drivers move, and everyone
 * starts again from a slightly different place.
 *
 * Everything in here treats all ten teams identically. The only thing that is
 * special about the player's team is that a human chooses its allocation
 * instead of `rivalAllocation` choosing it.
 */

import { getTrack } from './track.js';
import { areaValue } from './laptime.js';
import { AREA_IDS, applyRegulations, specRating, toPhysics } from './carspec.js';
import { POINTS, FASTEST_LAP_POINT, PRIZE_MONEY } from './calendar.js';
import { createWeekend } from './raceengine.js';
import { runDevelopment, allocateByWeights, developmentAdvice } from './rnd.js';
import { developRival, rivalBudget, rivalOffseason } from './rivals.js';
import { midSeasonPaddock } from './market.js';
import {
  applyResultToDriver, decayDriverState, generateDriver, driverSalary,
} from './personnel.js';
import { makeRng, subSeed } from './rng.js';
import {
  prizeMoney, settleSponsors, sponsorRaceIncome, generateSponsorMarket, damageCost, canSign,
} from './finance.js';
import {
  playerTeam, pushNews, constructorsTable, driversTable, constructorsPosition,
  roundBudget, seasonCosts, spend, receive, defaultAllocation,
} from './state.js';

/** Deterministic rng for a specific round of a specific season. */
function roundRng(state, salt = '') {
  return makeRng(subSeed(state.seed, 's', state.season, 'r', state.round, salt));
}

export function currentRound(state) {
  return state.calendar[Math.min(state.round, state.calendar.length - 1)];
}

export function nextRound(state) {
  return state.round < state.calendar.length ? state.calendar[state.round] : null;
}

export function seasonComplete(state) {
  return state.round >= state.calendar.length;
}

// ---------------------------------------------------------------------------
// Development
// ---------------------------------------------------------------------------

/**
 * Spend the player's development budget for this round, then let every rival
 * spend theirs. Called once per round, before the race weekend.
 */
export function runRoundDevelopment(state, allocationWeights) {
  const rng = roundRng(state, 'dev');
  const player = playerTeam(state);
  const budget = roundBudget(state);
  const alloc = allocateByWeights(budget, allocationWeights || state.player.allocation);

  const playerResult = runDevelopment(player, alloc, rng);
  state.player.seasonSpend = Math.round((state.player.seasonSpend + playerResult.spent) * 100) / 100;
  spend(state, playerResult.spent, `R${state.round + 1} development`, 'rnd');

  // Rivals. Their budget comes from their own commercial strength and last
  // season's finish — never from anything the player did.
  const rivalReports = [];
  for (const t of state.teams) {
    if (t.id === state.playerTeamId) continue;
    const season = rivalBudget(t, t.lastSeasonPosition ?? 5);
    const perRound = season / state.calendar.length;
    const res = developRival(t, perRound, rng);
    rivalReports.push({ team: t.id, report: res.report });
  }

  state.player.lastReport = playerResult.report;
  state.rngState = rng.state();
  return { player: playerResult, rivals: rivalReports, budget };
}

// ---------------------------------------------------------------------------
// The race weekend
// ---------------------------------------------------------------------------

export function buildWeekend(state, round) {
  const track = getTrack(round.circuit);
  const rng = roundRng(state, 'race');
  const entries = [];
  for (const t of state.teams) {
    for (const d of t.drivers) {
      entries.push({
        team: t, driver: d, spec: t.spec, facilities: t.facilities,
        isPlayer: t.id === state.playerTeamId,
      });
    }
  }
  const race = createWeekend({
    track, round, entries, rng,
    autoStrategy: state.settings.autoStrategy,
    difficulty: state.settings.difficulty || 'normal',
  });
  race.playerTeamId = state.playerTeamId;
  return race;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export function applyRaceResults(state, race) {
  const results = race.results || race.finish();
  const round = currentRound(state);
  const rng = roundRng(state, 'post');

  // Championship points.
  for (const r of results) {
    if (r.position == null || r.position > POINTS.length) continue;
    const pts = POINTS[r.position - 1];
    state.standings.drivers[r.driver.id] = (state.standings.drivers[r.driver.id] ?? 0) + pts;
    state.standings.constructors[r.team.id] = (state.standings.constructors[r.team.id] ?? 0) + pts;
  }
  // Fastest lap, if inside the points.
  if (race.fastestLap) {
    const fl = results.find((r) => r.id === race.fastestLap.car);
    if (fl && fl.position && fl.position <= 10) {
      state.standings.drivers[fl.driver.id] += FASTEST_LAP_POINT;
      state.standings.constructors[fl.team.id] += FASTEST_LAP_POINT;
    }
  }

  // Driver heads. `expected` is where the car's own pace said they should be,
  // so beating a bad car is worth as much as winning in a good one.
  const paceOrder = race.cars.slice().sort((a, b) => a.model.base - b.model.base).map((c) => c.id);
  for (const r of results) {
    const car = race.cars.find((c) => c.id === r.id);
    const expected = paceOrder.indexOf(r.id) + 1;
    const mate = results.find((x) => x.team.id === r.team.id && x.id !== r.id);
    applyResultToDriver(r.driver, {
      finished: r.status === 'finished',
      position: r.position ?? 20,
      expected,
      teammateBeaten: mate ? ((r.position ?? 21) < (mate.position ?? 21)) : false,
      retired: r.status === 'retired',
      crashed: r.reason === 'accident' || r.reason === 'accident damage',
    });
    // Accident repair bills land on the player only; rivals are abstracted.
    if (car && car.isPlayer && (car.damage > 0.05 || r.reason === 'accident')) {
      const sev = r.reason === 'accident' ? 0.85 : car.damage;
      const cost = damageCost(sev);
      spend(state, cost, `Repairs — ${r.driver.name}`, 'damage');
    }
  }

  // Player bookkeeping.
  const stats = state.player.seasonStats;
  for (const r of results) {
    if (r.team.id !== state.playerTeamId) continue;
    if (r.status === 'retired') stats.dnfs++;
    if (r.position === 1) stats.wins++;
    if (r.position && r.position <= 3) stats.podiums++;
    if (r.position && r.position <= 10) stats.pointsFinishes++;
  }
  const pole = race.grid && race.grid[0];
  if (pole && pole.team.id === state.playerTeamId) stats.poles++;

  // Income for the weekend.
  const sponsorIncome = sponsorRaceIncome(state.player.sponsors, state.calendar.length);
  receive(state, sponsorIncome, `R${state.round + 1} sponsorship`, 'sponsor');
  const costs = seasonCosts(state);
  spend(state, costs.total / state.calendar.length, `R${state.round + 1} operating costs`, 'operating');

  // News.
  const winner = results.find((r) => r.position === 1);
  if (winner) {
    pushNews(state, 'result', `${winner.driver.name} wins the ${round.name} for ${winner.team.name}.`);
  }
  const best = results.filter((r) => r.team.id === state.playerTeamId && r.position).sort((a, b) => a.position - b.position)[0];
  if (best && best.position <= 3) pushNews(state, 'result', `Podium! ${best.driver.name} finishes P${best.position} at the ${round.name}.`);

  for (const t of state.teams) for (const d of t.drivers) decayDriverState(d);

  // The paddock between races: a seat changing hands, and the talk about the
  // ones that might.
  midSeasonPaddock(state, rng);

  state.round++;
  state.rngState = rng.state();
  return results;
}

// ---------------------------------------------------------------------------
// End of season
// ---------------------------------------------------------------------------

const REGULATION_CHANGES = [
  { id: 'aero', name: 'Aerodynamic regulations rewritten', carry: { aero: 0.42, efficiency: 0.55 }, fallback: 0.88,
    text: 'The governing body has rewritten the aerodynamic regulations. Floor and wing development starts again from a much lower base.' },
  { id: 'power', name: 'Power unit homologation reset', carry: { power: 0.48, energy: 0.58 }, fallback: 0.90,
    text: 'Power unit homologation has been reset. Combustion and recovery development carries over only in part.' },
  { id: 'chassis', name: 'New chassis and safety structures', carry: { mechanical: 0.55, lightweight: 0.44 }, fallback: 0.90,
    text: 'New survival cell and suspension rules. Chassis work has to be redone, and the minimum weight has moved.' },
  { id: 'tyres', name: 'New tyre construction', carry: { tyres: 0.40, mechanical: 0.78 }, fallback: 0.92,
    text: 'The tyre supplier has changed construction. Everything the field knew about degradation is worth less than it was.' },
  { id: 'stable', name: 'Regulations unchanged', carry: {}, fallback: 0.94,
    text: 'The regulations are stable for the coming season. Development carries over almost intact.' },
];

export function endSeason(state) {
  const rng = makeRng(subSeed(state.seed, 'endseason', state.season));
  const table = constructorsTable(state);
  const drivers = driversTable(state);
  const events = [];

  // ---- prize money and sponsor clauses -----------------------------------
  const playerPos = table.findIndex((r) => r.team.id === state.playerTeamId) + 1;
  const prize = prizeMoney(playerPos);
  receive(state, prize, `Constructors' prize money (P${playerPos})`, 'prize');
  events.push({ kind: 'money', text: `Constructors' prize money for P${playerPos}: $${prize}M.` });

  const settle = settleSponsors(state.player.sponsors, {
    constructorsPosition: playerPos,
    podiums: state.player.seasonStats.podiums,
    pointsFinishes: state.player.seasonStats.pointsFinishes,
  });
  if (settle.total > 0) {
    receive(state, settle.total, 'Sponsor bonuses', 'sponsor');
    for (const p of settle.paid) events.push({ kind: 'money', text: `${p.sponsor} bonus met — ${p.clause}. $${p.amount}M.` });
  }

  // Reputation follows results, and reputation is what the sponsor market sees.
  state.player.reputation = Math.max(0.05, Math.min(1,
    state.player.reputation * 0.72 + ((11 - playerPos) / 10) * 0.28));

  // ---- the parent company takes its cut ----------------------------------
  // Without this a winning team simply accumulates money it can never spend,
  // because the budget cap stops it buying performance with the surplus.
  if (state.player.balance > 150) {
    const dividend = Math.round((state.player.balance - 150) * 0.6 * 10) / 10;
    spend(state, dividend, 'Dividend to the shareholders', 'dividend');
    events.push({ kind: 'money', text: `The board have taken a $${dividend}M dividend. Money the cap will not let you spend on the car does not stay in the team.` });
  }

  // ---- record the season -------------------------------------------------
  state.history.push({
    season: state.season,
    constructors: table.map((r) => ({ team: r.team.id, name: r.team.name, points: r.points })),
    drivers: drivers.slice(0, 10).map((r) => ({ driver: r.driver.name, team: r.team.short, points: r.points })),
    champion: drivers[0] ? drivers[0].driver.name : null,
    constructorsChampion: table[0] ? table[0].team.name : null,
    playerPosition: playerPos,
  });
  events.push({ kind: 'title', text: `${drivers[0].driver.name} is champion. ${table[0].team.name} take the constructors'.` });

  // ---- regulations -------------------------------------------------------
  // Weighted so a big change does not land every single year.
  const change = rng.weighted(REGULATION_CHANGES, [1, 1, 0.9, 0.8, 2.6]);
  for (const t of state.teams) t.spec = applyRegulations(t.spec, change.carry, change.fallback);
  events.push({ kind: 'regs', text: change.text });
  pushNews(state, 'regs', change.name + '. ' + change.text);

  // ---- rivals do their winter --------------------------------------------
  for (let i = 0; i < table.length; i++) {
    const t = table[i].team;
    t.lastSeasonPosition = i + 1;
    if (t.id === state.playerTeamId) continue;
    const news = rivalOffseason(t, rng, i + 1);
    for (const n of news) { events.push({ kind: 'rival', text: n.text }); pushNews(state, 'rival', n.text); }
  }

  // ---- driver market -----------------------------------------------------
  const moves = runDriverMarket(state, rng);
  for (const m of moves) { events.push({ kind: 'driver', text: m }); pushNews(state, 'driver', m); }

  // ---- reset for the new season ------------------------------------------
  state.season++;
  state.round = 0;
  state.player.seasonSpend = 0;
  state.player.seasonStats = { podiums: 0, wins: 0, pointsFinishes: 0, poles: 0, dnfs: 0 };
  for (const t of state.teams) { t.seasonRetirements = 0; t.spentThisSeason = 0; }
  for (const id of Object.keys(state.standings.constructors)) state.standings.constructors[id] = 0;
  for (const id of Object.keys(state.standings.drivers)) state.standings.drivers[id] = 0;

  // Contracts tick down; expiring sponsors leave and a new market appears.
  state.player.sponsors = state.player.sponsors.filter((s) => (state.season - s.signedSeason) < s.years);
  state.player.sponsorMarket = generateSponsorMarket(rng, playerPos, state.season, state.player.reputation);

  for (const t of state.teams) {
    for (const d of t.drivers) {
      d.contractYears = Math.max(0, (d.contractYears ?? 1) - 1);
      d.age = (d.age ?? 26) + 1;
      // Young drivers improve, older ones tail off.
      const curve = d.age < 27 ? 0.010 : d.age > 33 ? -0.012 : 0.002;
      d.skill = Math.max(0.60, Math.min(0.995, d.skill + curve + rng.normal(0, 0.008)));
      d.consistency = Math.max(0.55, Math.min(0.995, d.consistency + (d.age < 30 ? 0.008 : -0.004)));
      d.salary = driverSalary(d);
    }
  }

  state.rngState = rng.state();
  return { events, table, drivers, playerPosition: playerPos, regulation: change };
}

/**
 * Retirements and signings. Rival teams move drivers around on their own
 * judgement; the player is offered whoever is left.
 */
function runDriverMarket(state, rng) {
  const moves = [];
  const pool = [];

  // Retirements.
  for (const t of state.teams) {
    for (let i = 0; i < t.drivers.length; i++) {
      const d = t.drivers[i];
      const retireChance = d.age >= 38 ? 0.75 : d.age >= 35 ? 0.28 : d.age >= 33 ? 0.08 : 0;
      if (rng.chance(retireChance)) {
        moves.push(`${d.name} retires from the sport after a career of ${d.age - 19} seasons.`);
        const rookie = generateDriver(rng, 0.78 + rng.range(0, 0.10), rng.int(19, 23));
        rookie.short = d.short;
        rookie.num = d.num;
        rookie.id = `${t.id}-${rookie.num}-s${state.season}`;
        rookie.helmet = d.helmet;
        t.drivers[i] = rookie;
        state.standings.drivers[rookie.id] = 0;
        moves.push(`${t.name} promote ${rookie.name} to a race seat.`);
      }
    }
  }

  // A couple of swaps between rival teams each winter, driven by who wants a
  // better seat and who has a seat to fill.
  const swaps = rng.int(1, 3);
  for (let k = 0; k < swaps; k++) {
    const a = rng.pick(state.teams.filter((t) => t.id !== state.playerTeamId));
    const b = rng.pick(state.teams.filter((t) => t.id !== state.playerTeamId && t.id !== a.id));
    if (!a || !b) continue;
    const ia = rng.int(0, 1), ib = rng.int(0, 1);
    const da = a.drivers[ia], db = b.drivers[ib];
    if (!da || !db) continue;
    if ((da.contractYears ?? 0) > 0 && (db.contractYears ?? 0) > 0) continue;
    a.drivers[ia] = db; b.drivers[ib] = da;
    moves.push(`${db.name} signs for ${a.name}.`);
    moves.push(`${da.name} signs for ${b.name}.`);
  }

  return moves;
}

// ---------------------------------------------------------------------------
// The stand-in principal
// ---------------------------------------------------------------------------

/**
 * What a competent but unimaginative principal would do. It runs the balance
 * harness, and it is what the game falls back on if the player skips an
 * off-season — so a save left alone does not quietly go bankrupt.
 */
export function autoSignSponsors(state) {
  const p = state.player;
  const signed = [];
  // Best fee first, within the slots the team is allowed.
  const offers = p.sponsorMarket.slice().sort((a, b) => b.fee - a.fee);
  for (const offer of offers) {
    if (!canSign(p.sponsors, offer.tier)) continue;
    offer.signedSeason = state.season;
    p.sponsors.push(offer);
    signed.push(offer);
  }
  p.sponsorMarket = p.sponsorMarket.filter((o) => !signed.includes(o));
  return signed;
}

/**
 * Aim the development budget at whatever the remaining calendar rewards, using
 * the same `areaValue` the factory screen shows the player.
 */
export function autoAllocation(state) {
  const team = playerTeam(state);
  const remaining = state.calendar.slice(state.round);
  const tracks = {};
  for (const r of remaining) tracks[r.circuitId] = getTrack(r.circuit);
  const advice = developmentAdvice(tracks, team.spec, toPhysics, areaValue, remaining, { fuelKg: 55 });
  const weights = {};
  let i = 0;
  for (const a of advice) {
    // A soft ranking rather than all-in on one department: a real team spreads.
    weights[a.area] = Math.max(0.35, 1.9 - i * 0.19);
    i++;
  }
  // Tyres and reliability never show up in a single-lap valuation, but they
  // decide races. Keep a floor under them.
  weights.reliability = Math.max(weights.reliability, (team.spec.reliability ?? 0) < 55 ? 1.5 : 0.7);
  weights.tyres = Math.max(weights.tyres, (team.spec.tyres ?? 0) < 50 ? 1.2 : 0.6);
  return weights;
}

// ---------------------------------------------------------------------------
// Headless convenience — used by the balance tools and by "simulate race"
// ---------------------------------------------------------------------------

export function simulateRound(state, { allocation = null, practice = 0.5 } = {}) {
  runRoundDevelopment(state, allocation);
  const round = currentRound(state);
  const race = buildWeekend(state, round);
  race.runPractice(practice);
  race.runQualifying();
  race.startRace();
  race.simulateToEnd();
  const results = applyRaceResults(state, race);
  return { race, results, round };
}

export function simulateSeason(state, opts = {}) {
  while (!seasonComplete(state)) simulateRound(state, opts);
  return endSeason(state);
}
