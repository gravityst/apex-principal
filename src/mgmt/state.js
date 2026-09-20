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

export const SAVE_VERSION = 4;

/**
 * Where each constructor starts. APEX F1 gives every team a `performance`
 * rating between 0.84 and 0.99; that becomes the mean development level, and
 * the team's doctrine decides the shape around it.
 *
 * How wide that spread is decides whether this game has overtaking in it.
 * It used to run 46 to 70 — twenty-four development points, close to four
 * seconds of car, and with the drivers on top a grid covering nearly six per
 * cent of a lap. The car directly ahead of you was, on average, 0.23s a lap
 * quicker than yours by construction. No tow, no flap, no tyre offset and no
 * amount of driving gets past a car that is 0.23s a lap quicker: it simply
 * drives away from you down every straight. The race was decided in
 * qualifying and the afternoon was a procession.
 *
 * Eleven points instead of twenty-four put the grid inside two and a half per
 * cent, which is about where a real field sits. Eight is where it needed to
 * end up. Qualifying spread is not the number that matters to someone
 * playing: a pace difference is paid every lap, so a grid covering a second
 * and three quarters between pole and tenth becomes a hundred seconds by the
 * flag, and being lapped by a car you qualified eight tenths behind does not
 * feel like racing whatever the spreadsheet says. Eight points holds the grid
 * inside about one and a half per cent and brings the finishing order back to
 * something a grand prix produces.
 */
function initialSpec(team, rng) {
  const mean = 57 + (team.performance - 0.84) * 52;
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
    settings: { autoStrategy: true, raceSpeed: 4, difficulty: 'normal', distance: 'full', dirtyAir: 'off' },
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
    if (!s) return null;
    if (s.version === SAVE_VERSION) return rehydrate(s);
    const up = migrate(s);
    return up ? rehydrate(up) : null;
  } catch { return null; }
}

/**
 * Bring an older save forward rather than throwing a career away.
 *
 * Version 4 narrowed the grid: the development levels a team starts with used
 * to run 46 to 70, which put the car ahead of you a quarter of a second a lap
 * up the road by construction and made overtaking arithmetically impossible.
 * A save written before that is carrying the old, strung-out field.
 *
 * Every team is pulled toward the field's mean in each area by the same
 * factor the new grid uses, so the order is unchanged and how far ahead or
 * behind the player's development had put him is preserved in proportion —
 * he keeps the advantage he paid for, in a field that can now be raced.
 */
function migrate(s) {
  if (!s.version || s.version > SAVE_VERSION || !Array.isArray(s.teams)) return null;

  if (s.version < 4) {
    const K = 75 / 160;                       // the new spread against the old
    const meanOf = (t) => {
      const v = AREA_IDS.map((id) => t.spec?.[id]).filter((x) => typeof x === 'number');
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    };
    const means = s.teams.map(meanOf);
    const known = means.filter((m) => m != null);
    if (known.length > 1) {
      const field = known.reduce((a, b) => a + b, 0) / known.length;
      const newField = 56 + (field - 46) * K;
      s.teams.forEach((t, i) => {
        if (means[i] == null || !t.spec) return;
        // Only the tier gap is squeezed. Each team keeps the shape it built
        // around its own mean — a team that went all-in on power is still a
        // power team, and development the player paid for is still there.
        const shift = (newField + (means[i] - field) * K) - means[i];
        for (const id of AREA_IDS) {
          if (typeof t.spec[id] !== 'number') continue;
          t.spec[id] = Math.max(6, Math.round((t.spec[id] + shift) * 10) / 10);
        }
      });
    }
  }

  s.version = SAVE_VERSION;
  return s;
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
  if (!s) throw new Error('That file is not a save.');
  if (s.version === SAVE_VERSION) return rehydrate(s);
  const up = migrate(s);
  if (!up) throw new Error('That save is from a different version of the game.');
  return rehydrate(up);
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
  return repair(s);
}

/**
 * Make a loaded save safe to render.
 *
 * A save is a JSON file that has been round-tripped, possibly written by an
 * older build, possibly hand-edited, possibly truncated. Anything missing
 * from it used to surface as a TypeError several screens later — and because
 * the import handler assigned `app.state` before rendering, a throw left the
 * game holding a new state it had never drawn: the chrome was still there,
 * every button still clicked, and nothing happened. That is the "it imports
 * and then the game is dead" bug.
 *
 * So: fill in what can be defaulted, throw with a sentence a human can read
 * for what cannot, and never let either reach the renderer.
 */
function repair(s) {
  if (!s || typeof s !== 'object') throw new Error('That file is not an APEX save.');
  if (!Array.isArray(s.teams) || !s.teams.length) throw new Error('That save has no teams in it.');
  if (!s.teams.some((t) => t.id === s.playerTeamId)) {
    throw new Error('That save does not say which team is yours, so there is nothing to run.');
  }

  s.settings = {
    autoStrategy: true, difficulty: 'normal', distance: 'full', dirtyAir: 'off',
    ...(s.settings && typeof s.settings === 'object' ? s.settings : {}),
  };

  s.season = Number.isFinite(s.season) ? s.season : 1;
  // A round outside the calendar means the weekend screen has nothing to
  // build, which is a blank screen and a button that does nothing.
  s.round = Math.max(0, Math.min(s.calendar.length, Number.isFinite(s.round) ? s.round : 0));

  // Every field the rest of the game writes to without checking. A missing
  // array here is not a cosmetic gap: `spend()` does `player.ledger.push(...)`,
  // so a save without a ledger has a Run Practice button that throws the
  // moment you choose a programme that costs money — and a button that throws
  // is a button that does nothing at all, with no error anyone can see.
  const p = s.player && typeof s.player === 'object' ? s.player : {};
  s.player = p;
  if (!Number.isFinite(p.balance)) p.balance = 0;
  if (!Number.isFinite(p.reputation)) p.reputation = 0.5;
  if (!Number.isFinite(p.developedForRound)) p.developedForRound = -1;
  if (!Number.isFinite(p.seasonSpend)) p.seasonSpend = 0;
  if (!Array.isArray(p.ledger)) p.ledger = [];
  if (!Array.isArray(p.sponsors)) p.sponsors = [];
  if (!Array.isArray(p.sponsorMarket)) p.sponsorMarket = [];
  if (!Array.isArray(p.inbox)) p.inbox = [];
  if (p.lastReport === undefined) p.lastReport = null;
  p.seasonStats = {
    podiums: 0, wins: 0, pointsFinishes: 0, poles: 0, dnfs: 0,
    ...(p.seasonStats && typeof p.seasonStats === 'object' ? p.seasonStats : {}),
  };
  if (!p.allocation || typeof p.allocation !== 'object') p.allocation = defaultAllocation();
  for (const id of AREA_IDS) {
    if (!Number.isFinite(p.allocation[id])) p.allocation[id] = 1 / AREA_IDS.length;
  }

  if (!Array.isArray(s.news)) s.news = [];
  if (!Array.isArray(s.results)) s.results = [];
  if (!Array.isArray(s.history)) s.history = [];
  if (!Number.isFinite(s.week)) s.week = 0;
  if (!s.standings || typeof s.standings !== 'object') s.standings = { constructors: {}, drivers: {} };
  if (!s.standings.constructors || typeof s.standings.constructors !== 'object') s.standings.constructors = {};
  if (!s.standings.drivers || typeof s.standings.drivers !== 'object') s.standings.drivers = {};
  for (const t of s.teams) {
    if (!Number.isFinite(s.standings.constructors[t.id])) s.standings.constructors[t.id] = 0;
    for (const d of (t.drivers || [])) {
      if (!Number.isFinite(s.standings.drivers[d.id])) s.standings.drivers[d.id] = 0;
    }
  }

  for (const t of s.teams) {
    if (!t.spec || typeof t.spec !== 'object') t.spec = makeSpec(56);
    for (const id of AREA_IDS) {
      if (!Number.isFinite(t.spec[id])) t.spec[id] = 56;
    }
    if (!Array.isArray(t.drivers) || t.drivers.length < 2) {
      throw new Error(`That save is missing drivers for ${t.name || t.id}.`);
    }
    if (!t.staff || typeof t.staff !== 'object') t.staff = {};
    if (!t.facilities || typeof t.facilities !== 'object') t.facilities = makeFacilities(2);
    if (!t.colors || typeof t.colors !== 'object') t.colors = { primary: '#888', accent: '#ff8a00' };
  }

  // A weekend never belongs in a save; if one was written in, drop it.
  delete s.weekend;
  return s;
}

/** True once the board has run out of patience. */
export function isDismissed(state) {
  return state.player.balance < DISMISSAL_BALANCE;
}

export { WEEKS_PER_ROUND, BUDGET_CAP, BASE_OPERATING, DISMISSAL_BALANCE };
