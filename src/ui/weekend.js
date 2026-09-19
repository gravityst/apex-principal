/**
 * APEX: Principal — the race weekend.
 *
 * Practice, qualifying, and then the part the whole game is built around: a
 * live race you watch from the pit wall and change with four decisions per car.
 */

import { h, mount, panel, kv, meter, money, lapTime, gapTime, pct, ordinal, modal, teamBar } from './dom.js';
import { createTrackMap } from './trackmap.js';
import { getTrack } from '../mgmt/track.js';
import { TYRE_COMPOUNDS } from '../data/teams.js';
import { sensibleCompounds, tyreGrip } from '../mgmt/raceengine.js';
import { buildWeekend, currentRound, applyRaceResults, seasonComplete } from '../mgmt/season.js';
import { playerTeam, spend } from '../mgmt/state.js';
import { developmentPending } from './manage.js';
import { POINTS } from '../mgmt/calendar.js';
import { renderRaceScreen } from './racescreen.js';

const SPEEDS = [0, 1, 2, 5, 15];

export function renderWeekend(app, root) {
  const state = app.state;

  if (seasonComplete(state)) {
    mount(root, panel('Season complete', null,
      h('p', { class: 'muted' }, 'Every round has been run. Settle the season from the hub.'),
      h('button', { class: 'btn primary', onClick: () => app.goto('hub') }, 'To the hub')));
    return;
  }

  const round = currentRound(state);

  if (developmentPending(state)) {
    mount(root, panel(round.name, `Round ${round.round}`,
      h('p', { class: 'muted' }, 'The factory has not committed this round\'s development yet. Spend it before the cars run — an upgrade that arrives after the race is a wasted upgrade.'),
      h('div', { class: 'btnrow', style: { marginTop: '14px' } },
        h('button', { class: 'btn primary', onClick: () => app.goto('factory') }, 'Go to the factory'),
        h('button', {
          class: 'btn', onClick: () => { state.player.developedForRound = state.round; app.save(); app.render(); },
        }, 'Skip development this round'))));
    return;
  }

  if (!app.weekend || app.weekend.round.round !== round.round || app.weekendSeason !== state.season) {
    app.weekend = buildWeekend(state, round);
    app.weekendSeason = state.season;
    app.phase = 'practice';
    app.practiceSpend = 1;
    app.startTyres = {};
    app.speed = 0;
  }

  const race = app.weekend;
  if (app.phase === 'practice') return renderPractice(app, root, race, round);
  if (app.phase === 'qualifying') return renderQualifying(app, root, race, round);
  if (app.phase === 'grid') return renderGrid(app, root, race, round);
  if (app.phase === 'race') return renderRaceScreen(app, root, race, round);
  if (app.phase === 'result') return renderResult(app, root, race, round);
}

// ---------------------------------------------------------------------------
// Practice
// ---------------------------------------------------------------------------

const PRACTICE_OPTIONS = [
  { id: 0, name: 'Skip practice', cost: 0, blurb: 'Save the money and the mileage. You will start the weekend blind.' },
  { id: 1, name: 'Standard programme', cost: 1.2, blurb: 'A normal weekend of setup work.' },
  { id: 2, name: 'Full programme', cost: 3.4, blurb: 'Long runs, aero rakes, both cars on different set-ups. The best chance of finding time.' },
];

function renderPractice(app, root, race, round) {
  const state = app.state;
  const fc = race.weather.forecast[0];

  mount(root, h('div', { class: 'grid g-side' },
    panel(`${round.name} — practice`, `Round ${round.round}`,
      h('p', { class: 'muted small' }, 'Practice does not score points. It buys set-up understanding, which is worth up to about four tenths a lap for the rest of the weekend — more if your race engineer and simulator are good.'),
      h('div', { style: { marginTop: '14px' } }, PRACTICE_OPTIONS.map((o) => h('label', {
        style: {
          display: 'flex', gap: '12px', alignItems: 'flex-start', padding: '12px',
          border: `1px solid ${app.practiceSpend === o.id ? 'var(--accent)' : 'var(--line)'}`,
          borderRadius: '9px', marginBottom: '8px', cursor: 'pointer',
          background: app.practiceSpend === o.id ? '#1d1608' : 'var(--panel-2)',
        },
        onClick: () => { app.practiceSpend = o.id; app.render(); },
      },
        h('input', { type: 'radio', name: 'prac', checked: app.practiceSpend === o.id, onChange: () => {} }),
        h('div', {},
          h('div', { style: { display: 'flex', gap: '10px' } }, h('b', {}, o.name),
            h('span', { class: 'mono dim' }, o.cost ? money(o.cost) : 'free')),
          h('div', { class: 'tiny dim', style: { marginTop: '4px' } }, o.blurb))))),
      h('div', { class: 'btnrow', style: { marginTop: '10px' } },
        h('button', {
          class: 'btn primary',
          onClick: () => {
            const opt = PRACTICE_OPTIONS[app.practiceSpend];
            if (opt.cost) spend(state, opt.cost, `${round.name} practice programme`, 'operating');
            race.runPractice(app.practiceSpend / 2);
            app.phase = 'qualifying';
            app.save(); app.render();
          },
        }, 'Run practice →'))),
    h('div', { class: 'grid' },
      panel('Forecast', null,
        h('p', { style: { fontSize: '15px', marginTop: 0 } }, fc ? fc.text : 'No forecast available.'),
        fc ? h('div', {}, h('div', { class: 'tiny dim', style: { marginBottom: '5px' } }, `Meteorologist confidence ${pct(fc.confidence)}`),
          meter(fc.confidence * 100, 100, fc.confidence > 0.8 ? 'var(--good)' : 'var(--warn)', 'thin')) : null,
        h('p', { class: 'tiny dim', style: { marginTop: '12px' } },
          'The forecast is not the weather. Plan for it, but keep an eye on the sky.')),
      panel('Conditions', null,
        kv('Air temperature', `${round.weather.air}°C`),
        kv('Track temperature', `${round.weather.track}°C`),
        kv('Rain risk', pct(round.weather.rain)),
        kv('Race distance', `${round.laps} laps`),
        kv('Tyre wear here', race.abrasion > 1.0 ? 'High' : race.abrasion > 0.88 ? 'Moderate' : 'Low')))));
}

// ---------------------------------------------------------------------------
// Qualifying
// ---------------------------------------------------------------------------

function renderQualifying(app, root, race, round) {
  const state = app.state;
  const team = playerTeam(state);

  if (!race.grid) {
    mount(root, panel(`${round.name} — qualifying`, null,
      h('p', { class: 'muted' }, 'Three segments, five cars out after each of the first two. One lap decides where your race starts from.'),
      h('div', { class: 'btnrow', style: { marginTop: '14px' } },
        h('button', {
          class: 'btn primary',
          onClick: () => { race.runQualifying(); app.save(); app.render(); },
        }, 'Run qualifying →'))));
    return;
  }

  const pole = race.grid[0];
  mount(root, h('div', { class: 'grid g-side' },
    panel('Qualifying result', `${round.venue}`,
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', { class: 'r' }, '#'), h('th', {}, 'Driver'), h('th', {}, 'Team'),
          h('th', { class: 'r' }, 'Lap'), h('th', { class: 'r' }, 'Gap'))),
        h('tbody', {}, race.grid.map((c, i) => h('tr', { class: c.isPlayer ? 'me' : '' },
          h('td', { class: 'pos r' }, i + 1),
          h('td', {}, c.driver.name),
          h('td', { class: 'small dim' }, teamBar(c.team), c.team.short),
          h('td', { class: 'r mono' }, lapTime(c.quali)),
          h('td', { class: 'r mono dim' }, i === 0 ? '—' : `+${(c.quali - pole.quali).toFixed(3)}`)))))),
    h('div', { class: 'grid' },
      panel('Your cars', null, race.grid.filter((c) => c.isPlayer).map((c) =>
        h('div', { class: 'carcard' },
          h('div', { class: 'hd' }, h('b', {}, c.driver.name), h('span', { class: 'p' }, `P${c.gridPos}`)),
          kv('Lap', lapTime(c.quali)),
          kv('Gap to pole', `+${(c.quali - pole.quali).toFixed(3)}`),
          kv('Setup gain found', `${(c.setupGain ?? 0).toFixed(3)}s`)))),
      panel(null, null,
        h('button', {
          class: 'btn primary', style: { width: '100%' },
          onClick: () => { app.phase = 'grid'; app.render(); },
        }, 'To the grid →')))));
}

// ---------------------------------------------------------------------------
// Grid — tyre choice
// ---------------------------------------------------------------------------

function renderGrid(app, root, race, round) {
  const mine = race.grid.filter((c) => c.isPlayer);
  const options = sensibleCompounds(race.weather.wetness);
  for (const c of mine) if (!app.startTyres[c.id]) app.startTyres[c.id] = options[0];

  const stintEstimate = (c, compound) => {
    const cmp = TYRE_COMPOUNDS[compound];
    const perLap = 0.0605 * race.abrasion * cmp.wearRate * c.phys.wearRate * 0.95;
    return Math.round(0.95 / perLap);
  };

  mount(root, h('div', { class: 'grid g-side' },
    panel(`${round.name} — starting tyres`, `${round.laps} laps`,
      h('p', { class: 'muted small' }, 'A softer tyre starts faster and stops sooner. Your engineers estimate how long each will last on this circuit with this car.'),
      mine.map((c) => h('div', { class: 'carcard', style: { marginTop: '12px' } },
        h('div', { class: 'hd' }, h('b', {}, c.driver.name), h('span', { class: 'p' }, `P${c.gridPos}`)),
        h('div', { class: 'pillrow' }, options.map((t) => h('button', {
          class: `pill ${app.startTyres[c.id] === t ? 'on' : ''}`,
          onClick: () => { app.startTyres[c.id] = t; app.render(); },
        }, `${TYRE_COMPOUNDS[t].name} · ~${stintEstimate(c, t)} laps`))))),
      h('div', { class: 'btnrow', style: { marginTop: '16px' } },
        h('button', {
          class: 'btn primary',
          onClick: () => {
            race.startRace(app.startTyres);
            app.phase = 'race';
            app.speed = 2;
            app.render();
          },
        }, 'Lights out →'),
        h('button', {
          class: 'btn',
          onClick: () => {
            race.startRace(app.startTyres);
            race.autoStrategy = true;
            race.simulateToEnd();
            app.phase = 'result';
            app.render();
          },
        }, 'Simulate the race instead'))),
    h('div', { class: 'grid' },
      panel('Weather', null,
        kv('Now', race.weather.state),
        kv('Track', `${race.weather.trackTemp.toFixed(0)}°C`),
        h('p', { class: 'small muted', style: { marginTop: '10px' } }, race.weather.forecast[0]?.text || '')),
      panel('The grid', null,
        h('table', {}, h('tbody', {}, race.grid.slice(0, 10).map((c, i) =>
          h('tr', { class: c.isPlayer ? 'me' : '' },
            h('td', { class: 'pos' }, i + 1),
            h('td', { class: 'small' }, c.driver.name),
            h('td', { class: 'dim small r' }, c.team.short)))))))));
}

// ---------------------------------------------------------------------------
// The race
// ---------------------------------------------------------------------------

function finishRace(app, race) {
  app.stopLoop?.();
  app.phase = 'result';
  app.render();
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

function renderResult(app, root, race, round) {
  const state = app.state;
  const results = race.results || race.finish();

  // The key has to be read BEFORE the results are applied, because applying
  // them is what moves the season on. Reading it afterwards stamped this round
  // with the NEXT round's key, so the next race's results were treated as
  // already counted and the season stopped dead on round two.
  const key = `${state.season}-${state.round}`;
  if (app.appliedRound !== key) {
    applyRaceResults(state, race);
    app.appliedRound = key;
    app.save();
  }

  const mine = results.filter((r) => r.team.id === state.playerTeamId);

  mount(root, h('div', { class: 'grid g-side' },
    panel(`${round.name} — result`, round.venue,
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', { class: 'r' }, '#'), h('th', {}, 'Driver'), h('th', {}, 'Team'),
          h('th', { class: 'r' }, 'Grid'), h('th', { class: 'r' }, '+/−'), h('th', { class: 'r' }, 'Stops'),
          h('th', { class: 'r' }, 'Best lap'), h('th', { class: 'r' }, 'Pts'))),
        h('tbody', {}, results.map((r) => h('tr', { class: r.isPlayer ? 'me' : '' },
          h('td', { class: 'pos r' }, r.position ?? '—'),
          h('td', {}, r.driver.name, r.status === 'retired' ? h('span', { class: 'tiny bad' }, `  ${r.reason}`) : null),
          h('td', { class: 'small dim' }, teamBar(r.team), r.team.short),
          h('td', { class: 'r mono dim' }, r.gridPos),
          h('td', { class: `r mono ${r.gained > 0 ? 'good' : r.gained < 0 ? 'bad' : 'dim'}` },
            r.position ? (r.gained > 0 ? `+${r.gained}` : r.gained || '–') : ''),
          h('td', { class: 'r mono dim' }, r.stops),
          h('td', { class: 'r mono' }, lapTime(r.bestLap)),
          h('td', { class: 'r mono', style: { fontWeight: '700' } },
            r.position && r.position <= POINTS.length ? POINTS[r.position - 1] : '')))))),
    h('div', { class: 'grid' },
      panel('Your afternoon', null, mine.map((r) => h('div', { class: 'carcard' },
        h('div', { class: 'hd' }, h('b', {}, r.driver.name),
          h('span', { class: 'p' }, r.position ? `P${r.position}` : 'DNF')),
        r.status === 'retired'
          ? h('p', { class: 'small bad' }, `Retired — ${r.reason}.`)
          : [kv('Started', `P${r.gridPos}`),
          kv('Gained', r.gained > 0 ? `+${r.gained}` : String(r.gained)),
          kv('Stops', String(r.stops)),
          kv('Best lap', lapTime(r.bestLap)),
          kv('Points', String(r.position <= POINTS.length ? POINTS[r.position - 1] : 0))]))),
      panel('Radio highlights', null,
        h('div', { class: 'feed', style: { maxHeight: '300px' } },
          race.feed.filter((f) => f.player || ['crash', 'flag', 'weather', 'race'].includes(f.kind))
            .slice(-24).map((f) => h('div', { class: `msg k-${f.kind}` },
              h('span', { class: 'lp' }, `L${f.lap}`), f.text)))),
      panel(null, null,
        h('button', {
          class: 'btn primary', style: { width: '100%' },
          onClick: () => {
            app.weekend = null;
            app.phase = 'practice';
            app.goto(seasonComplete(state) ? 'hub' : 'factory');
          },
        }, seasonComplete(state) ? 'To the end of the season →' : 'On to the next round →')))));
}
