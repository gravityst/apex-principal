/**
 * APEX: Principal — hub, car and championship screens.
 */

import { h, mount, panel, kv, meter, money, lapTime, signed, ordinal, pct, teamBar } from './dom.js';
import { drawCircuitThumb } from './trackmap.js';
import { getTrack } from '../mgmt/track.js';
import { AREAS, AREA_IDS, toPhysics, specRating } from '../mgmt/carspec.js';
import { solveLap, areaValue } from '../mgmt/laptime.js';
import { constructorsTable, driversTable, playerTeam, roundBudget, seasonCosts } from '../mgmt/state.js';
import { currentRound, seasonComplete } from '../mgmt/season.js';
import { circuitCharacter } from '../mgmt/calendar.js';
import { doctrineName } from '../mgmt/rivals.js';

/** Predicted qualifying pace for every team at a circuit, best first. */
export function paceProjection(state, round) {
  const track = getTrack(round.circuit);
  const rows = state.teams.map((t) => {
    const best = t.drivers.reduce((a, b) => ((a.skill ?? 0) >= (b.skill ?? 0) ? a : b));
    const pace = 1 - (0.98 - (best.skill ?? 0.85)) * 0.185;
    const r = solveLap(track, toPhysics(t.spec), { fuelKg: 10, tyreGrip: 1, pace });
    return { team: t, time: r.time, driver: best, vmax: r.vmax };
  });
  rows.sort((a, b) => a.time - b.time);
  return { track, rows, best: rows[0].time };
}

// ---------------------------------------------------------------------------
// Hub
// ---------------------------------------------------------------------------

export function renderHub(app, root) {
  const state = app.state;
  const team = playerTeam(state);
  const done = seasonComplete(state);
  const round = done ? null : currentRound(state);
  const table = constructorsTable(state);
  const myPos = table.findIndex((r) => r.team.id === team.id) + 1;

  const left = [];

  if (round) {
    const proj = paceProjection(state, round);
    const mine = proj.rows.findIndex((r) => r.team.id === team.id);
    const myRow = proj.rows[mine];
    const thumb = h('canvas', { style: { width: '100%', height: '150px' } });
    requestAnimationFrame(() => drawCircuitThumb(thumb, proj.track, team.colors?.accent || '#ff8a00'));

    left.push(h('div', { class: 'hero' },
      h('div', { class: 'rnd' }, `Round ${round.round} of ${state.calendar.length} — ${round.month}`),
      h('h2', {}, round.name),
      h('div', { class: 'sub' }, `${round.venue} · ${round.location}`),
      h('div', { class: 'facts' },
        fact('Distance', `${round.laps} laps`),
        fact('Length', `${(proj.track.length / 1000).toFixed(3)} km`),
        fact('Character', circuitCharacter(round.circuit)),
        fact('Rain risk', pct(round.weather.rain)),
        fact('Track temp', `${round.weather.track}°C`)),
      thumb,
      h('div', { class: 'btnrow', style: { marginTop: '14px' } },
        h('button', { class: 'btn primary', onClick: () => app.goto('weekend') }, 'Go to the race weekend →'),
        h('button', { class: 'btn', onClick: () => app.goto('factory') }, 'Factory'))));

    left.push(panel('Where you should qualify', `predicted, best driver, low fuel`,
      h('div', { class: 'scroll' }, h('table', {},
        h('thead', {}, h('tr', {},
          h('th', { class: 'r' }, '#'), h('th', {}, 'Constructor'), h('th', {}, 'Driver'),
          h('th', { class: 'r' }, 'Lap'), h('th', { class: 'r' }, 'Gap'), h('th', { class: 'r' }, 'Top speed'))),
        h('tbody', {}, proj.rows.map((r, i) => h('tr', { class: r.team.id === team.id ? 'me' : '' },
          h('td', { class: 'pos r' }, i + 1),
          h('td', {}, teamBar(r.team), r.team.name),
          h('td', { class: 'muted small' }, r.driver.name),
          h('td', { class: 'r mono' }, lapTime(r.time)),
          h('td', { class: 'r mono muted' }, i === 0 ? '—' : `+${(r.time - proj.best).toFixed(3)}`),
          h('td', { class: 'r mono muted' }, `${(r.vmax * 3.6).toFixed(0)} km/h`)))))),
      h('p', { class: 'small dim', style: { marginTop: '10px' } },
        myRow
          ? `Your car is projected ${ordinal(mine + 1)} fastest here — ${mine === 0 ? 'the quickest on the grid' : `${(myRow.time - proj.best).toFixed(3)}s off the pace`}. This is the car, not the result: strategy, reliability and the drivers still have to deliver it.`
          : '')));
  } else {
    left.push(h('div', { class: 'hero' },
      h('div', { class: 'rnd' }, `Season ${state.season} complete`),
      h('h2', {}, 'The season is over'),
      h('div', { class: 'sub' }, 'Settle the year, take the prize money, and see what the regulations do next.'),
      h('div', { class: 'btnrow', style: { marginTop: '16px' } },
        h('button', { class: 'btn primary', onClick: () => app.endSeason() }, 'End the season →'))));
  }

  const right = [];
  const costs = seasonCosts(state);
  right.push(panel('Your team', null,
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' } },
      h('i', { class: 'bar-team', style: { background: team.colors.primary, height: '30px', width: '5px' } }),
      h('div', {}, h('div', { style: { fontWeight: '700', fontSize: '15px' } }, team.name),
        h('div', { class: 'tiny dim' }, `${team.base} · ${team.engine}`))),
    kv('Constructors', `${ordinal(myPos)} — ${table[myPos - 1].points} pts`),
    kv('Balance', money(state.player.balance), state.player.balance < 0 ? 'bad' : state.player.balance > 60 ? 'good' : ''),
    kv('Development left this round', money(roundBudget(state))),
    kv('Season running costs', money(costs.total)),
    kv('Car rating', specRating(team.spec).toFixed(1)),
    kv('Reputation', pct(state.player.reputation))));

  right.push(panel('Championship', `after ${state.round} of ${state.calendar.length}`,
    h('table', {}, h('tbody', {}, table.map((r, i) => h('tr', { class: r.team.id === team.id ? 'me' : '' },
      h('td', { class: 'pos' }, i + 1),
      h('td', {}, teamBar(r.team), h('span', { class: 'small' }, r.team.short), ' ',
        h('span', { class: 'dim tiny' }, doctrineName(r.team.doctrine))),
      h('td', { class: 'r mono' }, r.points)))))));

  right.push(panel('Paddock', null,
    state.news.length
      ? state.news.slice(0, 9).map((n) => h('div', { class: 'newsitem' },
        h('span', { class: 'tag' }, n.kind), n.text))
      : h('p', { class: 'dim small' }, 'Nothing to report.')));

  mount(root, h('div', { class: 'grid g-side' },
    h('div', { class: 'grid' }, ...left),
    h('div', { class: 'grid' }, ...right)));
}

function fact(k, v) {
  return h('div', { class: 'stat' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v));
}

// ---------------------------------------------------------------------------
// The car
// ---------------------------------------------------------------------------

export function renderCar(app, root) {
  const state = app.state;
  const team = playerTeam(state);
  const phys = toPhysics(team.spec);
  const remaining = state.calendar.slice(state.round);
  const circuits = remaining.length ? remaining : state.calendar;

  // Where each department pays off, circuit by circuit.
  const perCircuit = [];
  const seen = new Set();
  for (const r of circuits) {
    if (seen.has(r.circuitId)) continue;
    seen.add(r.circuitId);
    const track = getTrack(r.circuit);
    perCircuit.push({ round: r, track, values: areaValue(track, team.spec, toPhysics, AREA_IDS, { fuelKg: 55 }) });
  }

  const specPanel = panel('Development', 'level out of 100',
    AREAS.map((a) => h('div', { class: 'arearow' },
      h('span', { class: 'nm' }, a.short),
      meter(team.spec[a.id] ?? 0, 100, levelColour(team.spec[a.id] ?? 0)),
      h('span', { class: 'vl' }, (team.spec[a.id] ?? 0).toFixed(1)))));

  const physPanel = panel('What that actually is', 'the numbers the solver integrates',
    kv('Mass (no fuel)', `${phys.mass.toFixed(1)} kg`),
    kv('Downforce, CL·A', `${phys.clA.toFixed(3)} m²`),
    kv('Drag, CD·A', `${phys.cdA.toFixed(3)} m²`),
    kv('Lift-to-drag', phys.ld.toFixed(2)),
    kv('Peak ICE power', `${(phys.powerICE / 1000).toFixed(0)} kW`),
    kv('ERS deployment', `${(phys.ersPower / 1000).toFixed(0)} kW · ${(phys.ersEnergy / 1e6).toFixed(2)} MJ/lap`),
    kv('Peak tyre friction', phys.mu.toFixed(3)),
    kv('Tyre wear rate', `×${phys.wearRate.toFixed(2)}`),
    kv('Failure risk per race', pct(phys.failureRate, 1), phys.failureRate > 0.12 ? 'bad' : phys.failureRate < 0.05 ? 'good' : 'warn'));

  const valueTable = panel('Where a department pays off', 'seconds a lap per +10 development',
    h('div', { class: 'scroll' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Circuit'),
        ...AREAS.map((a) => h('th', { class: 'r' }, a.short)))),
      h('tbody', {}, perCircuit.map((p) => {
        const best = Math.max(...AREA_IDS.map((id) => p.values[id]));
        return h('tr', {}, h('td', { class: 'small' }, p.round.venue.replace(/ (International Circuit|Street Circuit|Motorsport Park|Grand Prix Circuit|Autodrome)$/, '')),
          ...AREA_IDS.map((id) => h('td', {
            class: 'r mono small',
            style: p.values[id] >= best - 0.001 && best > 0.02 ? { color: 'var(--accent-2)', fontWeight: '700' } : {},
          }, p.values[id] <= 0.0005 ? '·' : p.values[id].toFixed(3))));
      })))),
    h('p', { class: 'small dim', style: { marginTop: '10px' } },
      'Tyre management and reliability do not show here because a single flying lap cannot measure them. They are worth points over a race distance, not tenths over a lap.'));

  mount(root,
    h('div', { class: 'grid g3' }, specPanel, physPanel,
      panel('Compared with the grid', null,
        h('div', { class: 'scroll' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Constructor'), h('th', { class: 'r' }, 'Car'), h('th', {}, 'Philosophy'))),
          h('tbody', {}, state.teams.slice().sort((a, b) => specRating(b.spec) - specRating(a.spec)).map((t) =>
            h('tr', { class: t.id === team.id ? 'me' : '' },
              h('td', {}, teamBar(t), h('span', { class: 'small' }, t.name)),
              h('td', { class: 'r mono' }, specRating(t.spec).toFixed(1)),
              h('td', { class: 'dim tiny' }, doctrineName(t.doctrine))))))))),
    h('div', { class: 'grid', style: { marginTop: '16px' } }, valueTable));
}

function levelColour(v) {
  if (v >= 80) return 'var(--purple)';
  if (v >= 62) return 'var(--accent-2)';
  if (v >= 42) return 'var(--warn)';
  return 'var(--bad)';
}

// ---------------------------------------------------------------------------
// Championship
// ---------------------------------------------------------------------------

export function renderStandings(app, root) {
  const state = app.state;
  const team = playerTeam(state);
  const cons = constructorsTable(state);
  const drv = driversTable(state);

  const consPanel = panel('Constructors', `season ${state.season}`,
    h('table', {},
      h('thead', {}, h('tr', {}, h('th', { class: 'r' }, '#'), h('th', {}, 'Constructor'), h('th', { class: 'r' }, 'Car'), h('th', { class: 'r' }, 'Pts'))),
      h('tbody', {}, cons.map((r, i) => h('tr', { class: r.team.id === team.id ? 'me' : '' },
        h('td', { class: 'pos r' }, i + 1),
        h('td', {}, teamBar(r.team), r.team.name),
        h('td', { class: 'r mono dim small' }, specRating(r.team.spec).toFixed(1)),
        h('td', { class: 'r mono', style: { fontWeight: '700' } }, r.points))))));

  const drvPanel = panel('Drivers', null,
    h('table', {},
      h('thead', {}, h('tr', {}, h('th', { class: 'r' }, '#'), h('th', {}, 'Driver'), h('th', {}, 'Team'), h('th', { class: 'r' }, 'Pts'))),
      h('tbody', {}, drv.map((r, i) => h('tr', { class: r.team.id === team.id ? 'me' : '' },
        h('td', { class: 'pos r' }, i + 1),
        h('td', {}, r.driver.name),
        h('td', { class: 'dim small' }, teamBar(r.team), r.team.short),
        h('td', { class: 'r mono', style: { fontWeight: '700' } }, r.points))))));

  const history = state.history.length
    ? panel('Previous seasons', null,
      state.history.slice().reverse().map((s) => h('div', { class: 'newsitem' },
        h('span', { class: 'tag' }, `S${s.season}`),
        h('b', {}, s.constructorsChampion), ' take the constructors\'. ',
        h('span', { class: 'muted' }, `${s.champion} is drivers' champion. You finished ${ordinal(s.playerPosition)}.`))))
    : null;

  mount(root,
    h('div', { class: 'grid g2' }, consPanel, drvPanel),
    history ? h('div', { class: 'grid', style: { marginTop: '16px' } }, history) : null);
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export function renderCalendar(app, root) {
  const state = app.state;
  mount(root, panel('Calendar', `season ${state.season}`,
    h('div', { class: 'scroll' }, h('table', {},
      h('thead', {}, h('tr', {},
        h('th', { class: 'r' }, 'R'), h('th', {}, 'Grand Prix'), h('th', {}, 'Venue'),
        h('th', {}, 'Month'), h('th', { class: 'r' }, 'Laps'), h('th', { class: 'r' }, 'Rain'),
        h('th', { class: 'r' }, 'Track °C'), h('th', {}, 'Character'))),
      h('tbody', {}, state.calendar.map((r, i) => h('tr', { class: i === state.round ? 'me' : '' },
        h('td', { class: 'pos r' }, r.round),
        h('td', {}, h('b', {}, r.name), i < state.round ? h('span', { class: 'tiny dim' }, '  done') : null),
        h('td', { class: 'small muted' }, r.venue),
        h('td', { class: 'small dim' }, r.month),
        h('td', { class: 'r mono' }, r.laps),
        h('td', { class: 'r mono' }, pct(r.weather.rain)),
        h('td', { class: 'r mono dim' }, r.weather.track),
        h('td', { class: 'small dim' }, circuitCharacter(r.circuit)))))))));
}
