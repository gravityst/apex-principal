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
  if (app.phase === 'race') return renderRace(app, root, race, round);
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

function renderRace(app, root, race, round) {
  const state = app.state;

  const mapCanvas = h('canvas', { id: 'map' });
  const flagSlot = h('div', {});
  const towerSlot = h('div', { class: 'tower' });
  const feedSlot = h('div', { class: 'feed' });
  const carsSlot = h('div', {});
  const headSlot = h('div', { style: { display: 'flex', gap: '20px', flexWrap: 'wrap', alignItems: 'center' } });
  const speedSlot = h('div', { class: 'speedctl' });

  const track = getTrack(round.circuit);
  const map = createTrackMap(mapCanvas, track);

  mount(root,
    h('div', { class: 'grid g-race' },
      h('div', { class: 'grid' },
        panel('Pit wall', null, carsSlot)),
      h('div', { class: 'grid' },
        h('div', { class: 'panel tight' }, flagSlot, headSlot, mapCanvas,
          h('div', { style: { display: 'flex', justifyContent: 'space-between', marginTop: '10px', alignItems: 'center' } },
            speedSlot,
            h('button', {
              class: 'btn sm', onClick: () => {
                app.speed = 0;
                race.autoStrategy = true;
                race.simulateToEnd();
                finishRace(app, race);
              },
            }, 'Simulate to the end'))),
        panel('Team radio', null, feedSlot)),
      h('div', { class: 'grid' },
        panel('Timing', null, towerSlot))));

  // ---- speed control ----
  function drawSpeed() {
    speedSlot.replaceChildren(
      h('span', { class: 'tiny dim', style: { marginRight: '4px' } }, 'SPEED'),
      ...SPEEDS.map((s) => h('button', {
        class: `pill ${app.speed === s ? 'on' : ''}`,
        onClick: () => { app.speed = s; drawSpeed(); },
      }, s === 0 ? '❚❚' : `${s}×`)));
  }
  drawSpeed();

  // ---- the frame loop ----
  let last = performance.now();
  let acc = 0;
  app.stopLoop?.();
  let stopped = false;
  app.stopLoop = () => { stopped = true; };

  function frame(now) {
    if (stopped) return;
    if (!document.body.contains(mapCanvas)) return;      // screen changed
    requestAnimationFrame(frame);

    const real = Math.min(0.25, (now - last) / 1000);
    last = now;

    if (race.state === 'racing' && app.speed > 0) {
      acc += real * app.speed;
      let steps = 0;
      while (acc >= 0.25 && steps < 400 && race.state === 'racing') {
        race.step(0.25);
        acc -= 0.25;
        steps++;
      }
      if (race.state !== 'racing') { finishRace(app, race); return; }
    }
    paint();
  }
  requestAnimationFrame(frame);

  // ---- painting ----
  let lastFeedLength = -1;
  function paint() {
    const order = race.order || race.updateOrder();
    map.draw(order, race.weather, { labels: true });

    // header
    headSlot.replaceChildren(
      statBlock('Lap', `${Math.min(race.lap + 1, race.lapsTotal)} / ${race.lapsTotal}`),
      statBlock('Weather', race.weather.state + (race.weather.wetness > 0.05 ? ` ${pct(race.weather.wetness)}` : '')),
      statBlock('Track', `${race.weather.trackTemp.toFixed(0)}°C`),
      statBlock('Fastest', race.fastestLap ? `${race.fastestLap.driver} ${lapTime(race.fastestLap.time)}` : '—'));

    // flags
    const flags = [];
    if (race.safetyCar) {
      flags.push(h('div', { class: `flagbar ${race.safetyCar.kind}` },
        race.safetyCar.kind === 'sc' ? 'Safety car deployed' : 'Virtual safety car'));
    }
    if (race.weather.wetness > 0.14) {
      flags.push(h('div', { class: 'flagbar rain' },
        race.weather.wetness > 0.5 ? 'Heavy rain — full wets territory' : 'Damp track — intermediates'));
    }
    flagSlot.replaceChildren(...flags);

    // timing tower
    towerSlot.replaceChildren(...order.map((c) => {
      const cmp = TYRE_COMPOUNDS[c.tyre];
      const cls = c.status === 'retired' ? 'out' : c.status === 'pit' ? 'pit' : '';
      return h('div', { class: `row ${c.isPlayer ? 'me' : ''} ${cls}` },
        h('span', {}, c.status === 'retired' ? '—' : c.position),
        h('i', { style: { display: 'block', width: '4px', height: '14px', borderRadius: '2px', background: c.team.colors.primary } }),
        h('span', { class: 'nm' }, c.driver.short || c.driver.name.split(' ').pop()),
        h('span', { class: 'gap' }, c.status === 'retired' ? 'DNF' : c.position === 1 ? 'LEADER' : gapTime(c.interval)),
        h('span', { class: `tyre ty-${c.tyre}` }, cmp ? cmp.short : '?'),
        h('span', { class: 'age' }, `${Math.floor(c.tyreAge)}L`));
    }));

    // radio feed — only when something new has been said
    if (race.feed.length !== lastFeedLength) {
      lastFeedLength = race.feed.length;
      feedSlot.replaceChildren(...race.feed.slice(-40).map((f) => h('div', { class: `msg k-${f.kind}` },
        h('span', { class: 'lp' }, `L${f.lap}`), f.text)));
    }

    // pit wall — built once, updated in place
    for (const card of cards) card.update();
  }

  const cards = race.cars.filter((c) => c.isPlayer).map((c) => makeCarCard(app, race, c));
  carsSlot.replaceChildren(...cards.map((c) => c.el));
  paint();
}

function statBlock(k, v) {
  return h('div', { class: 'stat' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v));
}

/**
 * A pit wall card.
 *
 * Built ONCE and updated in place. The race screen repaints sixty times a
 * second; replacing these buttons on every frame meant a click could land on an
 * element that was detached a millisecond later, which made the controls feel
 * broken exactly when a race was at its most frantic.
 */
function makeCarCard(app, race, c) {
  const fuelPerLap = 0.335 * race.track.length / 1000;

  const posEl = h('span', { class: 'p' });
  const tyreEl = h('span', { class: 'v' });
  const wearBar = h('i', {});
  const wearNote = h('div', { class: 'tiny dim', style: { marginTop: '3px' } });
  const fuelEl = h('span', { class: 'v' });
  const lastEl = h('span', { class: 'v mono' });
  const dmgRow = h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Damage'), h('span', { class: 'v bad' }));
  const defiance = h('p', { class: 'tiny', style: { color: '#ffb4a0', margin: '8px 0 4px', display: 'none' } },
    'He is not listening to the pit wall at the moment.');
  const statusNote = h('p', { class: 'small bad', style: { display: 'none' } });
  const footer = h('div', { class: 'tiny dim', style: { marginTop: '7px' } });
  const pitLabel = h('div', { class: 'tiny dim', style: { margin: '10px 0 5px' } }, 'CALL HIM IN');

  const modeBtns = {};
  const modeRow = h('div', { class: 'pillrow' }, ['push', 'neutral', 'conserve', 'hold'].map((m) => {
    const b = h('button', { class: 'pill', onClick: () => race.command(c.id, 'mode', m) }, m);
    modeBtns[m] = b;
    return b;
  }));

  const ersBtns = {};
  const ersRow = h('div', { class: 'pillrow' }, ['harvest', 'balanced', 'deploy'].map((m) => {
    const b = h('button', { class: 'pill', onClick: () => race.command(c.id, 'ers', m) }, m);
    ersBtns[m] = b;
    return b;
  }));

  const pitBtns = {};
  const pitRow = h('div', { class: 'pillrow' });

  const body = h('div', {},
    h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Tyre'), tyreEl),
    h('div', { style: { margin: '2px 0 8px' } }, h('div', { class: 'meter thin' }, wearBar), wearNote),
    h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Fuel'), fuelEl),
    h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Last lap'), lastEl),
    dmgRow, defiance,
    h('div', { class: 'tiny dim', style: { margin: '10px 0 5px' } }, 'PACE'), modeRow,
    h('div', { class: 'tiny dim', style: { margin: '10px 0 5px' } }, 'ENERGY'), ersRow,
    pitLabel, pitRow, footer);

  const el = h('div', { class: 'carcard' },
    h('div', { class: 'hd' },
      h('i', { style: { width: '4px', height: '17px', borderRadius: '2px', background: c.team.colors.primary } }),
      h('b', {}, c.driver.name), posEl),
    statusNote, body);

  let lastCompounds = '';

  function update() {
    const retired = c.status === 'retired';
    const finished = c.status === 'finished';
    posEl.textContent = retired ? 'DNF' : finished ? `P${c.position}` : `P${c.position}`;

    if (retired) {
      statusNote.textContent = `Out — ${c.retireReason}.`;
      statusNote.style.display = '';
      body.style.display = 'none';
      return;
    }
    statusNote.style.display = 'none';
    body.style.display = '';

    const cmp = TYRE_COMPOUNDS[c.tyre];
    tyreEl.replaceChildren(
      h('span', { class: `ty-${c.tyre}` }, cmp.name), ' ',
      h('span', { class: 'dim tiny' }, `${Math.floor(c.tyreAge)} laps`));

    const life = Math.max(0, 1 - c.wear);
    wearBar.style.width = `${life * 100}%`;
    wearBar.style.background = c.wear > 0.92 ? 'var(--bad)' : c.wear > 0.75 ? 'var(--warn)' : 'var(--good)';
    wearNote.textContent = c.wear > 1 ? 'Off the cliff — he is losing seconds a lap'
      : c.wear > 0.85 ? 'Nearly gone' : c.wear > 0.6 ? 'Working' : 'Healthy';

    const lapsLeft = race.lapsTotal - c.lap;
    const needed = lapsLeft * fuelPerLap;
    fuelEl.textContent = `${c.fuel.toFixed(1)} kg${c.fuel < needed ? ' — short' : ''}`;
    fuelEl.className = `v ${c.fuel < needed ? 'warn' : ''}`;

    lastEl.textContent = c.lastLapTime ? lapTime(c.lastLapTime) : '—';
    dmgRow.style.display = c.damage > 0.03 ? '' : 'none';
    dmgRow.lastChild.textContent = pct(c.damage);
    defiance.style.display = c.defiance > 0 ? '' : 'none';

    for (const [m, b] of Object.entries(modeBtns)) {
      b.className = `pill ${c.mode === m ? 'on' : ''}`;
      b.disabled = finished;
    }
    for (const [m, b] of Object.entries(ersBtns)) {
      b.className = `pill ${c.ersMode === m ? 'on' : ''}`;
      b.disabled = finished;
    }

    // The available compounds change when it starts raining, so the row is
    // rebuilt only when that set actually changes.
    const options = sensibleCompounds(race.weather.wetness);
    const key = options.join(',');
    if (key !== lastCompounds) {
      lastCompounds = key;
      for (const k of Object.keys(pitBtns)) delete pitBtns[k];
      pitRow.replaceChildren(...options.map((t) => {
        const b = h('button', { class: 'pill', onClick: () => race.command(c.id, 'pit', t) },
          `${TYRE_COMPOUNDS[t].short} ${TYRE_COMPOUNDS[t].name}`);
        pitBtns[t] = b;
        return b;
      }));
    }
    for (const [t, b] of Object.entries(pitBtns)) {
      b.className = `pill ${c.pitRequested === t ? 'warnon' : ''}`;
      b.disabled = finished || c.status === 'pit';
    }
    pitLabel.textContent = c.pitRequested
      ? `BOX — ${TYRE_COMPOUNDS[c.pitRequested].name} ready`
      : c.status === 'pit' ? 'IN THE PIT LANE' : 'CALL HIM IN';
    footer.textContent = `${c.stops} stop${c.stops === 1 ? '' : 's'} · ${lapsLeft} laps to go`;
  }

  update();
  return { el, update };
}

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
  const applied = app.appliedRound === `${state.season}-${state.round}`;

  if (!applied) {
    applyRaceResults(state, race);
    app.appliedRound = `${state.season}-${state.round}`;
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
