/**
 * APEX: Principal — the save file.
 *
 * One plain object holds everything: ten teams, twenty drivers, a calendar, a
 * ledger and a seed. It serialises to JSON with no special handling, which is
 * what makes the game saveable, exportable, and reproducible under
 * `tools/simseason.mjs`.
 */

import { TEAMS } from '../data/teams.js';
import { AREA_IDS, makeSpec } from './carspec.js';
import { buildCalendar, WEEKS_PER_ROUND } from './calendar.js';
import { makeFacilities } from './facilities.js';
import { seedGrid, driverSalary, staffSalary, generateStaff, STAFF_ROLES } from './personnel.js';
import { initRival, rivalBudget } from './rivals.js';
import { makeRng } from './rng.js';
import { BUDGET_CAP, BASE_OPERATING, DISMISSAL_BALANCE, generateSponsorMarket, wageBill } from './finance.js';
import { facilityUpkeep } from './facilities.js';

export const SAVE_VERSION = 3;

/**
 * Where each constructor starts. APEX F1 gives every team a `performance`
 * rating between 0.84 and 0.99; that becomes the mean development level, and
 * the team's doctrine decides the shape around it. The spread is deliberately
 * tight — about two and a bit seconds of car between the best and the worst —
 * because the drivers are worth another second and a half on top.
 */
function initialSpec(team, rng) {
  const mean = 46 + (team.performance - 0.84) * 160;
  const spec = makeSpec(mean);
  const shape = {
    velocitas: { aero: 8, efficiency: 4, reliability: 4 },
    argentum: { efficiency: 9, reliability: 6, aero: 2 },
    scuderia: { power: 9, energy: 5, reliability: -7 },
    meridian: { mechanical: 5, tyres: 5 },
    aurora: { aero: 6, reliability: -5 },
    monolith: { power: 6, lightweight: 4, reliability: 3 },
    nimbus: { mechanical: 6, tyres: 3, aero: -3 },
    halcyon: { tyres: 6, reliability: 4, power: -4 },
    cobalt: { reliability: 7, tyres: 4, aero: -5 },
    apexion: { mechanical: 5, lightweight: 5, power: -3 },
  }[team.id] || {};
  for (const id of AREA_IDS) {
    spec[id] = Math.max(6, Math.round((mean + (shape[id] ?? 0) + rng.normal(0, 2.4)) * 10) / 10);
  }
  return spec;
}

function initialStaff(team, rng) {
  const tier = 0.58 + team.resources * 0.30;
  const staff = {};
  for (const role of STAFF_ROLES) {
    const s = generateStaff(rng, role.id, tier);
    s.salary = staffSalary(s.rating, role.id);
    staff[role.id] = s;
  }
  return staff;
}

export function newGame({ seed = Date.now() & 0x7fffffff, playerTeamId = 'halcyon' } = {}) {
  const rng = makeRng(seed);
  const { teams } = seedGrid(seed ^ 0x5eed);

  for (const t of teams) {
    initRival(t, rng);
    t.spec = initialSpec(t, rng);
    t.facilities = makeFacilities(Math.max(1, Math.min(5, Math.round(1 + t.resources * 2.6))));
    t.staff = initialStaff(t, rng);
    t.seasonRetirements = 0;
    t.spentThisSeason = 0;
    t.points = 0;
    t.lastSeasonPosition = 11 - Math.round(t.performance * 10);
    for (const d of t.drivers) d.salary = driverSalary(d);
  }

  const player = teams.find((t) => t.id === playerTeamId) || teams[teams.length - 1];
  player.isPlayer = true;

  const calendar = buildCalendar();

  const state = {
    version: SAVE_VERSION,
    seed,
    created: Date.now(),
    season: 1,
    round: 0,                    // 0 = before round 1
    week: 0,                     // development weeks used this round window
    playerTeamId: player.id,
    teams,
    calendar,
    standings: { constructors: {}, drivers: {} },
    history: [],
    news: [],
    player: {
      balance: 42 + player.resources * 30,
      reputation: 0.35 + player.resources * 0.25,
      sponsors: [],
      ledger: [],
      allocation: defaultAllocation(),
      seasonSpend: 0,
      seasonStats: { podiums: 0, wins: 0, pointsFinishes: 0, poles: 0, dnfs: 0 },
      sponsorMarket: [],
      inbox: [],
      lastReport: null,
    },
    settings: { autoStrategy: true, raceSpeed: 4, difficulty: 'normal' },
  };

  for (const t of teams) {
    state.standings.constructors[t.id] = 0;
    for (const d of t.drivers) state.standings.drivers[d.id] = 0;
  }

  // Two starting sponsors so the team is solvent on day one.
  const mkt = generateSponsorMarket(rng, player.lastSeasonPosition, 1, state.player.reputation);
  const minors = mkt.filter((s) => s.tier === 'minor');
  state.player.sponsors = [
    mkt.find((s) => s.tier === 'major') || mkt[0],
    minors[0], minors[1],
  ].filter(Boolean);
  state.player.sponsorMarket = mkt.filter((s) => !state.player.sponsors.includes(s));

  state.rngState = rng.state();
  pushNews(state, 'season', `Season 1 begins. You have taken over ${player.name}.`);
  return state;
}

export function defaultAllocation() {
  const a = {};
  for (const id of AREA_IDS) a[id] = 1 / AREA_IDS.length;
  return a;
}

export function playerTeam(state) {
  return state.teams.find((t) => t.id === state.playerTeamId);
}

export function teamById(state, id) {
  return state.teams.find((t) => t.id === id);
}

export function driverById(state, id) {
  for (const t of state.teams) for (const d of t.drivers) if (d.id === id) return d;
  return null;
}

export function pushNews(state, kind, text) {
  state.news.unshift({ kind, text, season: state.season, round: state.round, at: Date.now() });
  if (state.news.length > 120) state.news.length = 120;
}

/** Constructors' table, best first. */
export function constructorsTable(state) {
  return state.teams
    .map((t) => ({ team: t, points: state.standings.constructors[t.id] ?? 0 }))
    .sort((a, b) => b.points - a.points || (b.team.performance - a.team.performance));
}

/** Drivers' table, best first. */
export function driversTable(state) {
  const rows = [];
  for (const t of state.teams) {
    for (const d of t.drivers) rows.push({ driver: d, team: t, points: state.standings.drivers[d.id] ?? 0 });
  }
  return rows.sort((a, b) => b.points - a.points || (b.driver.skill - a.driver.skill));
}

export function constructorsPosition(state, teamId) {
  return constructorsTable(state).findIndex((r) => r.team.id === teamId) + 1;
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * Development money the player has this round.
 *
 * Capped three ways: what the budget cap still allows, what is actually in the
 * bank, and a per-round pace so the whole season's allowance is not gone by
 * round three. A team may run a small overdraft — the board tolerates it, up to
 * a point (see DISMISSAL_BALANCE).
 */
export function roundBudget(state) {
  const p = state.player;
  const remainingRounds = Math.max(1, state.calendar.length - state.round);
  const capLeft = Math.max(0, BUDGET_CAP - p.seasonSpend);
  const cashLeft = Math.max(0, p.balance + 18);       // a modest overdraft is allowed
  const pace = Math.max(capLeft / remainingRounds * 2.2, 2);
  return Math.round(Math.min(capLeft, cashLeft, pace) * 10) / 10;
}

export function seasonCosts(state) {
  const team = playerTeam(state);
  const wages = wageBill(team.drivers, team.staff);
  const upkeep = facilityUpkeep(team.facilities);
  return { wages, upkeep, operating: BASE_OPERATING, total: Math.round((wages + upkeep + BASE_OPERATING) * 10) / 10 };
}

export function spend(state, amount, label, kind = 'cost') {
  state.player.balance = Math.round((state.player.balance - amount) * 100) / 100;
  state.player.ledger.push({ round: state.round, label, amount: -Math.round(amount * 100) / 100, kind, season: state.season });
  return state.player.balance;
}

export function receive(state, amount, label, kind = 'income') {
  state.player.balance = Math.round((state.player.balance + amount) * 100) / 100;
  state.player.ledger.push({ round: state.round, label, amount: Math.round(amount * 100) / 100, kind, season: state.season });
  return state.player.balance;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const KEY = 'apex-principal-save-v3';

/**
 * Browser storage is per-viewer and can be unavailable (private windows,
 * blocked site data). Every path here is wrapped, and the game runs perfectly
 * well with no persistence at all — the export button is the reliable one.
 */
export function saveGame(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(stripTransient(state)));
    return true;
  } catch { return false; }
}

export function loadGame() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    return s && s.version === SAVE_VERSION ? rehydrate(s) : null;
  } catch { return null; }
}

export function hasSave() {
  try { return !!localStorage.getItem(KEY); } catch { return false; }
}

export function clearSave() {
  try { localStorage.removeItem(KEY); return true; } catch { return false; }
}

export function exportSave(state) {
  return JSON.stringify(stripTransient(state), null, 1);
}

export function importSave(text) {
  const s = JSON.parse(text);
  if (!s || s.version !== SAVE_VERSION) throw new Error('That save is from a different version of the game.');
  return rehydrate(s);
}

function stripTransient(state) {
  const { weekend, ...rest } = state;
  return rest;
}

/** Re-link the object graph JSON cannot keep: drivers point back at teams. */
function rehydrate(s) {
  for (const t of s.teams) {
    for (const d of t.drivers) d.team = undefined;   // never serialise a cycle
  }
  s.calendar = buildCalendar();                      // circuits are data, not save state
  return s;
}

/** True once the board has run out of patience. */
export function isDismissed(state) {
  return state.player.balance < DISMISSAL_BALANCE;
}

export { WEEKS_PER_ROUND, BUDGET_CAP, BASE_OPERATING, DISMISSAL_BALANCE };
