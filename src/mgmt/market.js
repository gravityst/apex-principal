/**
 * APEX: Principal — the driver market.
 *
 * Two things live here. The first is the seat you control: you can put a driver
 * out of the car at any point in the season, pay off what is left of his
 * contract, and put someone else in it — either a driver without a drive, or
 * one of somebody else's, for a price.
 *
 * The second is everyone else's. Rival teams change their minds about drivers
 * during the year as well as over the winter, and the paddock talks about it
 * before it happens. None of it reads the player's results: a team drops a
 * driver because of how HE is going against HIS team mate, which is the only
 * fair version of the rule this game already holds itself to.
 *
 * Pure: no DOM, no globals. The UI calls in, gets news lines back.
 */

import { generateDriver, driverSalary } from './personnel.js';
import { pushNews, spend, constructorsPosition } from './state.js';
import { makeRng, subSeed } from './rng.js';

/** A three-letter code that nobody on the grid is already using. */
export function shortCode(name, taken) {
  const surname = (name.split(' ').pop() || name).toUpperCase().replace(/[^A-Z]/g, '');
  const tries = [
    surname.slice(0, 3),
    surname.slice(0, 2) + surname.slice(-1),
    surname[0] + surname.slice(-2),
    surname.slice(0, 2) + 'X',
  ];
  for (const t of tries) if (t.length === 3 && !taken.has(t)) return t;
  for (let i = 0; i < 26; i++) {
    const t = surname.slice(0, 2) + String.fromCharCode(65 + i);
    if (!taken.has(t)) return t;
  }
  return surname.slice(0, 3);
}

function takenCodes(state) {
  const set = new Set();
  for (const t of state.teams) for (const d of t.drivers) if (d.short) set.add(d.short);
  return set;
}

/** What it costs to put a driver out of the car before his contract is up. */
export function payoffCost(driver) {
  const years = Math.max(0.6, driver.contractYears ?? 1);
  return Math.round((driver.salary ?? 3) * years * 0.55 * 10) / 10;
}

/** What it costs to get one in: a fee to the man, or a buyout to his team. */
export function signingCost(driver, poached) {
  return Math.round((driver.salary ?? 3) * (poached ? 1.2 : 0.35) * 10) / 10;
}

/**
 * Who is available. Drivers without a drive, plus a couple of other teams'
 * who could be bought out of their seat. Regenerated deterministically from the
 * seed, so reloading the page does not reroll the market.
 */
export function driverMarket(state) {
  const rng = makeRng(subSeed(state.seed, 'drivermkt', state.season, state.round));
  const taken = takenCodes(state);
  const out = [];

  // Free agents: a spread from a rookie worth a punt to a veteran on the way
  // down who can still drive. Who will take your call depends on where you are
  // in the championship — a team running last does not get the pick of them.
  const pos = constructorsPosition(state, state.playerTeamId);
  const base = 0.780 + ((11 - pos) / 10) * 0.130;
  const tiers = [base + 0.035, base + 0.010, base - 0.020, base - 0.050, base - 0.080];
  for (let i = 0; i < 5; i++) {
    const tier = tiers[i] + rng.range(-0.015, 0.015);
    const d = generateDriver(rng, tier, i === 4 ? rng.int(19, 22) : rng.int(22, 36));
    d.salary = driverSalary(d);
    d.contractYears = rng.int(1, 3);
    d.short = shortCode(d.name, taken);
    taken.add(d.short);
    d.id = `fa-${state.season}-${state.round}-${i}`;
    out.push({ driver: d, poached: false, from: null });
  }

  // And two who are already in somebody's car.
  const rivals = state.teams.filter((t) => t.id !== state.playerTeamId);
  const shuffled = rng.shuffle(rivals.slice());
  for (const t of shuffled.slice(0, 2)) {
    const d = rng.pick(t.drivers);
    if (!d) continue;
    out.push({ driver: d, poached: true, from: t });
  }
  return out;
}

/**
 * Put a driver in the car. Returns the news lines so the caller can show them.
 * A poached driver leaves a seat behind, and the team he left fills it — which
 * is two stories, not one.
 */
export function signDriver(state, seatIndex, entry) {
  const team = state.teams.find((t) => t.id === state.playerTeamId);
  const outgoing = team.drivers[seatIndex];
  const incoming = entry.driver;
  const news = [];

  const payoff = outgoing ? payoffCost(outgoing) : 0;
  const fee = signingCost(incoming, entry.poached);
  if (payoff) spend(state, payoff, `Contract pay-off — ${outgoing.name}`, 'staff');
  spend(state, fee, entry.poached ? `Buyout — ${incoming.name}` : `Signing fee — ${incoming.name}`, 'staff');

  // The seat he is leaving, if he had one.
  if (entry.poached && entry.from) {
    const i = entry.from.drivers.indexOf(incoming);
    const taken = takenCodes(state);
    const brng = makeRng(subSeed(state.seed, 'backfill', state.season, state.round, entry.from.id));
    const replacement = generateDriver(brng, 0.79 + brng.range(0, 0.08), brng.int(19, 27));
    replacement.salary = driverSalary(replacement);
    replacement.short = shortCode(replacement.name, taken);
    replacement.num = incoming.num;
    replacement.id = `${entry.from.id}-${replacement.short}-s${state.season}r${state.round}`;
    replacement.helmet = incoming.helmet;
    if (i >= 0) entry.from.drivers[i] = replacement;
    state.standings.drivers[replacement.id] = state.standings.drivers[replacement.id] ?? 0;
    news.push(`${entry.from.name} put ${replacement.name} in the car ${incoming.name} has vacated.`);
  }

  team.drivers[seatIndex] = incoming;
  incoming.morale = 0.62;
  incoming.form = 0;
  state.standings.drivers[incoming.id] = state.standings.drivers[incoming.id] ?? 0;

  news.unshift(entry.poached
    ? `${incoming.name} signs for ${team.name}, bought out of his ${entry.from.name} contract.`
    : `${incoming.name} signs for ${team.name}.`);
  if (outgoing) {
    news.unshift(`${team.name} part company with ${outgoing.name} with immediate effect.`);
  }
  for (const n of news) pushNews(state, 'driver', n);
  return { news, payoff, fee };
}

/**
 * The paddock between races: a team that has seen enough of a driver, and the
 * talk that goes round before anything is signed. Called once per round.
 */
export function midSeasonPaddock(state, rng) {
  const news = [];
  const rivals = state.teams.filter((t) => t.id !== state.playerTeamId);

  // A change of driver, occasionally, and only where one of the two is being
  // comprehensively beaten by the other.
  if (rng.chance(0.13) && state.round > 2) {
    const t = rng.pick(rivals);
    if (t && t.drivers.length === 2) {
      const [a, b] = t.drivers;
      const pa = state.standings.drivers[a.id] ?? 0;
      const pb = state.standings.drivers[b.id] ?? 0;
      const loser = pa < pb ? a : b;
      const winner = pa < pb ? b : a;
      if ((state.standings.drivers[winner.id] ?? 0) - (state.standings.drivers[loser.id] ?? 0) >= 12) {
        const i = t.drivers.indexOf(loser);
        const taken = takenCodes(state);
        const rep = generateDriver(rng, 0.80 + rng.range(0, 0.07), rng.int(19, 27));
        rep.salary = driverSalary(rep);
        rep.short = shortCode(rep.name, taken);
        rep.num = loser.num;
        rep.id = `${t.id}-${rep.short}-s${state.season}r${state.round}`;
        rep.helmet = loser.helmet;
        t.drivers[i] = rep;
        state.standings.drivers[rep.id] = 0;
        news.push(`${t.name} drop ${loser.name} with immediate effect. ${rep.name} takes the seat from the next round.`);
      }
    }
  }

  // Talk. It costs nothing and it is what a paddock sounds like.
  if (rng.chance(0.34)) {
    const t = rng.pick(rivals);
    const d = rng.pick(rng.pick(state.teams).drivers || []);
    if (t && d && !t.drivers.includes(d)) {
      news.push(rng.pick([
        `${d.name} is being linked with ${t.name} for next season.`,
        `${t.name} are understood to have spoken to ${d.name}'s management.`,
        `Paddock talk has ${d.name} in a ${t.name} car next year. Both sides say nothing.`,
        `${d.name} says he is happy where he is. Nobody in the paddock believes him.`,
      ]));
    }
  }

  for (const n of news) pushNews(state, 'driver', n);
  return news;
}
