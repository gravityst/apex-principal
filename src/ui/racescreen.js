/**
 * APEX: Principal — the race screen.
 *
 * Three things share this screen and none of them is decoration:
 *
 *   the 3D view    the real APEX F1 cars, seen from close overhead, because a
 *                  gap you can see is easier to act on than a gap you read;
 *   the strategy   what the tyre has left, what a stop costs, whether the
 *                  undercut is on, what pushing buys and what it costs;
 *   the radio      who said what, and how much it matters.
 *
 * The 3D canvas repaints every frame. The panels repaint four times a second,
 * because a number that flickers is a number nobody can read.
 */

import { h, mount, panel, kv, meter, lapTime, gapTime, pct } from './dom.js';
import { createTrackMap } from './trackmap.js';
import { createRaceScene, detectQuality } from '../race3d/scene.js';
import { getTrack } from '../mgmt/track.js';
import { TYRE_COMPOUNDS } from '../data/teams.js';
import { sensibleCompounds } from '../mgmt/raceengine.js';
import { strategyBrief, engineerCalls } from '../mgmt/strategy.js';

const SPEEDS = [0, 1, 2, 5, 15];
const PANEL_HZ = 4;

const SPEAKER_LABEL = {
  engineer: 'ENGINEER', driver: 'DRIVER', control: 'RACE CONTROL',
  pitlane: 'PIT LANE', commentary: 'BROADCAST',
};

export function renderRaceScreen(app, root, race, round) {
  const track = getTrack(round.circuit);
  const mine = race.cars.filter((c) => c.isPlayer);

  // ---- structure --------------------------------------------------------
  const canvas3d = h('canvas', { class: 'r3d' });
  const canvas2d = h('canvas', { id: 'map', style: { display: 'none' } });
  const hudTop = h('div', { class: 'r3d-hud top' });
  const hudFlag = h('div', { class: 'r3d-flags' });
  const hudCams = h('div', { class: 'r3d-hud cams' });
  const hudCtl = h('div', { class: 'r3d-hud ctl' });
  const splitLabels = h('div', { class: 'r3d-split', style: { display: 'none' } },
    h('span', { class: 'sl top' }), h('span', { class: 'sl bot' }));
  const labelLayer = h('div', { class: 'r3d-labels' });
  const viewport = h('div', { class: 'r3d-wrap' }, canvas3d, canvas2d, labelLayer, splitLabels, hudTop, hudFlag, hudCams, hudCtl);

  const pitwallSlot = h('div', {});
  const stratSlot = h('div', { class: 'grid' });
  const towerSlot = h('div', { class: 'tower' });
  const radioSlot = h('div', { class: 'radio' });

  mount(root,
    h('div', { class: 'panel tight', style: { padding: '0', overflow: 'hidden' } }, viewport),
    h('div', { class: 'grid g-race', style: { marginTop: '16px' } },
      h('div', { class: 'grid' }, panel('Pit wall', null, pitwallSlot)),
      h('div', { class: 'grid' }, stratSlot),
      h('div', { class: 'grid' },
        panel('Timing', null, towerSlot),
        panel('Team radio', null, radioSlot))));

  // ---- 3D or fall back to the map --------------------------------------
  let scene = null;
  let map2d = null;
  try {
    scene = createRaceScene(canvas3d, track, { quality: app.state.settings.quality3d || detectQuality() });
  } catch { scene = null; }

  if (scene) {
    scene.addCars(race.cars.map((c) => ({ id: c.id, team: c.team, driver: c.driver, isPlayer: c.isPlayer })));
    scene.setTargets(mine[0]?.id, mine[1]?.id);
    scene.setMode(app.camMode || 'top');
    scene.setZoom(app.camZoom || 80);
  } else {
    canvas3d.style.display = 'none';
    canvas2d.style.display = 'block';
    map2d = createTrackMap(canvas2d, track);
  }

  // ---- camera + speed controls -----------------------------------------
  let followId = app.camFollow || mine[0]?.id || race.cars[0].id;

  function drawCams() {
    const chips = [];
    for (const c of mine) {
      chips.push(h('button', {
        class: `pill ${app.camMode !== 'split' && followId === c.id ? 'on' : ''}`,
        onClick: () => { app.camMode = 'top'; followId = c.id; scene?.setMode('top'); scene?.setTargets(c.id, null); drawCams(); },
      }, c.driver.short || c.driver.name.split(' ').pop()));
    }
    chips.push(h('button', {
      class: `pill ${app.camMode !== 'split' && followId === '__leader' ? 'on' : ''}`,
      onClick: () => { app.camMode = 'top'; followId = '__leader'; drawCams(); },
    }, 'Leader'));
    if (mine.length > 1) {
      chips.push(h('button', {
        class: `pill ${app.camMode === 'split' ? 'on' : ''}`,
        onClick: () => {
          app.camMode = 'split';
          scene?.setMode('split');
          scene?.setOrient('across');
          scene?.setTargets(mine[0].id, mine[1].id);
          drawCams();
        },
      }, 'Both cars'));
    }
    if (splitLabels) {
      splitLabels.style.display = app.camMode === 'split' ? '' : 'none';
      if (app.camMode === 'split' && mine.length > 1) {
        splitLabels.children[0].textContent = mine[0].driver.name;
        splitLabels.children[1].textContent = mine[1].driver.name;
      }
    }
    hudCams.replaceChildren(h('span', { class: 'r3d-lbl' }, 'CAMERA'), ...chips);
  }
  drawCams();

  function drawCtl() {
    hudCtl.replaceChildren(
      h('div', { class: 'r3d-grp' },
        h('span', { class: 'r3d-lbl' }, 'ZOOM'),
        h('button', { class: 'pill', onClick: () => setZoom(scene ? scene.getZoom() * 1.35 : 95) }, '−'),
        h('button', { class: 'pill', onClick: () => setZoom(scene ? scene.getZoom() / 1.35 : 95) }, '+')),
      h('div', { class: 'r3d-grp' },
        h('span', { class: 'r3d-lbl' }, 'SPEED'),
        ...SPEEDS.map((s) => h('button', {
          class: `pill ${app.speed === s ? 'on' : ''}`,
          onClick: () => { app.speed = s; drawCtl(); },
        }, s === 0 ? '❚❚' : `${s}×`))),
      h('button', {
        class: 'btn sm', onClick: () => {
          app.speed = 0; race.autoStrategy = true; race.simulateToEnd(); finish();
        },
      }, 'Simulate to the end'));
  }
  function setZoom(z) { if (scene) { scene.setZoom(z); app.camZoom = scene.getZoom(); } }
  drawCtl();

  canvas3d.addEventListener('wheel', (e) => {
    e.preventDefault();
    setZoom((scene?.getZoom() ?? 95) * (e.deltaY > 0 ? 1.12 : 1 / 1.12));
  }, { passive: false });

  // Pinch to zoom on a phone.
  let pinch = 0;
  canvas3d.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) pinch = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
  }, { passive: true });
  canvas3d.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 2 || !pinch) return;
    const d = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    setZoom((scene?.getZoom() ?? 95) * (pinch / Math.max(1, d)));
    pinch = d;
  }, { passive: true });
  canvas3d.addEventListener('touchend', () => { pinch = 0; }, { passive: true });

  // ---- pit wall + strategy, built once -----------------------------------
  const cards = mine.map((c) => makeCarCard(app, race, c));
  pitwallSlot.replaceChildren(...cards.map((c) => c.el));
  const briefs = mine.map((c) => makeStrategyPanel(race, c));
  stratSlot.replaceChildren(...briefs.map((b) => b.el));

  // ---- lateral placement so cars do not sit inside one another ----------
  function lateralFor(car, order) {
    const f = ((car.u % 1) + 1) % 1;
    const i = Math.min(track.samples - 1, Math.floor(f * track.samples));
    const k = track.curv[i];
    const w = track.width[i];
    // The racing line takes the inside of the corner.
    let lat = -Math.sign(k) * Math.min(w * 0.42, Math.abs(k) * 2600);
    if (car.status === 'pit') return (race.pit.side === 'right' ? 1 : -1) * (w + 9);
    // Anyone fighting sits alongside rather than on top.
    const idx = order.indexOf(car);
    const ahead = order[idx - 1];
    if (ahead && car.interval < 1.1 && ahead.status === 'running') {
      lat += (idx % 2 === 0 ? 1 : -1) * Math.min(w * 0.55, 3.2);
    }
    return Math.max(-w + 1.1, Math.min(w - 1.1, lat));
  }

  // ---- the loop ---------------------------------------------------------
  let last = performance.now();
  let acc = 0;
  let panelAcc = 0;
  let labelAcc = 0;
  const labelPool = new Map();
  const radioMemo = new Map();
  let lastFeedLen = -1;
  let stopped = false;
  app.stopLoop?.();
  app.stopLoop = () => { stopped = true; scene?.dispose(); };

  function finish() {
    app.stopLoop?.();
    app.stopLoop = null;
    app.phase = 'result';
    app.render();
  }

  function frame(now) {
    if (stopped || !document.body.contains(canvas3d)) return;
    requestAnimationFrame(frame);
    const real = Math.min(0.25, (now - last) / 1000);
    last = now;

    if (race.state === 'racing' && app.speed > 0) {
      acc += real * app.speed;
      let steps = 0;
      while (acc >= 0.25 && steps < 400 && race.state === 'racing') {
        race.step(0.25); acc -= 0.25; steps++;
      }
      if (race.state !== 'racing') { finish(); return; }
    }

    const order = race.order || race.updateOrder();

    // The world, every frame.
    if (scene) {
      if (followId === '__leader') {
        const leader = order.find((c) => c.status !== 'retired');
        if (leader && app.camMode !== 'split') scene.setTargets(leader.id, null);
      }
      scene.updateCars(order.map((c) => ({
        id: c.id, u: c.u, status: c.status, tyre: c.tyre, drs: c.drs,
        speed: track.length / Math.max(50, race.currentLapTime(c)),
        lateral: lateralFor(c, order),
      })), real);
      scene.render(real);
      labelAcc += real;
      if (labelAcc >= 1 / 12) { labelAcc = 0; paintLabels(order); }
    } else if (map2d) {
      map2d.draw(order, race.weather, { labels: true });
    }

    // The panels, four times a second.
    panelAcc += real;
    if (panelAcc >= 1 / PANEL_HZ) {
      panelAcc = 0;
      paintPanels(order);
    }
  }

  /**
   * A tag over each car on screen: position, name and tyre. This is what turns
   * the 3D view from something to look at into something to read.
   */
  function paintLabels(order) {
    if (!scene) return;
    const byId = new Map(order.map((c) => [c.id, c]));
    const shots = scene.screenPositions();
    const seen = new Set();
    const zoom = scene.getZoom();
    // Your cars first, so a decluttered tag is never one of yours.
    shots.sort((a, b) => (b.isPlayer ? 1 : 0) - (a.isPlayer ? 1 : 0));
    const placed = [];
    for (const s of shots) {
      const car = byId.get(s.id);
      if (!car || car.status === 'retired') continue;
      // Zoomed far out, label only your cars and the leaders, or the view
      // turns into a wall of overlapping tags.
      if (!s.isPlayer && zoom > 230 && car.position > 3) continue;
      // Keep tags clear of the control bar along the bottom.
      if (s.y > 0.88 || s.y < 0.03) continue;
      // Declutter: drop a rival's tag that would sit on top of one already
      // placed. Yours are always drawn.
      if (!s.isPlayer) {
        let clash = false;
        for (const q of placed) {
          if (Math.abs(q.x - s.x) < 0.052 && Math.abs(q.y - s.y) < 0.055) { clash = true; break; }
        }
        if (clash) continue;
      }
      placed.push(s);
      const key = `${s.id}#${s.pane ?? 0}`;
      let el = labelPool.get(key);
      if (!el) {
        el = h('div', { class: 'carlabel' },
          h('span', { class: 'cp' }), h('span', { class: 'cn' }), h('span', { class: 'ct' }));
        labelPool.set(key, el);
        labelLayer.append(el);
      }
      seen.add(key);
      el.style.display = '';
      el.style.left = `${(s.x * 100).toFixed(2)}%`;
      el.style.top = `${(s.y * 100).toFixed(2)}%`;
      el.className = `carlabel${s.isPlayer ? ' me' : ''}${car.status === 'pit' ? ' pit' : ''}`;
      el.style.setProperty('--team', car.team.colors.primary);
      el.children[0].textContent = `P${car.position}`;
      el.children[1].textContent = car.driver.short || car.driver.name.split(' ').pop();
      el.children[2].textContent = (TYRE_COMPOUNDS[car.tyre]?.short || '?') + Math.floor(car.tyreAge);
      el.children[2].className = `ct ty-${car.tyre}`;
    }
    for (const [k, el] of labelPool) if (!seen.has(k)) el.style.display = 'none';
  }

  function paintPanels(order) {
    // Header.
    hudTop.replaceChildren(
      hudStat('LAP', `${Math.min(race.lap + 1, race.lapsTotal)} / ${race.lapsTotal}`),
      hudStat('TRACK', `${race.weather.state} ${race.weather.trackTemp.toFixed(0)}°C`),
      hudStat('FASTEST', race.fastestLap ? `${race.fastestLap.driver} ${lapTime(race.fastestLap.time)}` : '—'),
      hudStat('LEADER', order[0] ? `${order[0].driver.short || order[0].driver.name} ${order[0].team.short}` : '—'));

    const flags = [];
    if (race.safetyCar) {
      flags.push(h('div', { class: `flagbar ${race.safetyCar.kind}` },
        race.safetyCar.kind === 'sc' ? 'SAFETY CAR' : 'VIRTUAL SAFETY CAR'));
    }
    if (race.weather.wetness > 0.14) {
      flags.push(h('div', { class: 'flagbar rain' },
        race.weather.wetness > 0.5 ? 'HEAVY RAIN' : 'DAMP TRACK'));
    }
    hudFlag.replaceChildren(...flags);

    // Timing tower.
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

    // Engineer calls, once per car per lap.
    for (const c of mine) {
      if (c.status !== 'running') continue;
      const key = c.id;
      const memoLap = radioMemo.get(key + ':lap');
      if (memoLap === c.lap) continue;
      radioMemo.set(key + ':lap', c.lap);
      let memo = radioMemo.get(key);
      if (!memo) { memo = {}; radioMemo.set(key, memo); }
      for (const call of engineerCalls(race, c, memo)) {
        race.pushRadio('engineer', `${c.driver.short || c.driver.name.split(' ').pop()}: ${call.text}`, call.p, c.id);
      }
    }

    // Radio.
    if (race.feed.length !== lastFeedLen) {
      lastFeedLen = race.feed.length;
      radioSlot.replaceChildren(...race.feed.slice(-40).map((f) => h('div', {
        class: `rmsg from-${f.from || 'commentary'} pri-${f.priority || 'low'}`,
      },
        h('div', { class: 'rmeta' },
          h('span', { class: 'rwho' }, SPEAKER_LABEL[f.from] || 'BROADCAST'),
          h('span', { class: 'rlap' }, `LAP ${f.lap}`)),
        h('div', { class: 'rtext' }, f.text))));
    }

    for (const c of cards) c.update();
    for (const b of briefs) b.update();
  }

  window.addEventListener('resize', () => { scene?.resize(); });
  paintPanels(race.order || race.updateOrder());
  requestAnimationFrame(frame);
}

function hudStat(k, v) {
  return h('div', { class: 'r3d-stat' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v));
}

// ---------------------------------------------------------------------------
// Pit wall card — the controls
// ---------------------------------------------------------------------------

function makeCarCard(app, race, c) {
  const posEl = h('span', { class: 'p' });
  const statusNote = h('p', { class: 'small bad', style: { display: 'none' } });
  const defiance = h('p', { class: 'tiny', style: { color: '#ffb4a0', margin: '6px 0', display: 'none' } },
    'He has stopped listening to the pit wall.');
  const pitLabel = h('div', { class: 'tiny dim', style: { margin: '10px 0 5px' } }, 'CALL HIM IN');
  const pitRow = h('div', { class: 'pillrow' });
  const footer = h('div', { class: 'tiny dim', style: { marginTop: '7px' } });

  const modeBtns = {};
  const modeRow = h('div', { class: 'pillrow' }, ['push', 'neutral', 'conserve', 'hold'].map((m) => {
    const b = h('button', { class: 'pill', onClick: () => race.command(c.id, 'mode', m) }, m);
    modeBtns[m] = b; return b;
  }));
  const ersBtns = {};
  const ersRow = h('div', { class: 'pillrow' }, ['harvest', 'balanced', 'deploy'].map((m) => {
    const b = h('button', { class: 'pill', onClick: () => race.command(c.id, 'ers', m) }, m);
    ersBtns[m] = b; return b;
  }));

  const body = h('div', {},
    defiance,
    h('div', { class: 'tiny dim', style: { margin: '4px 0 5px' } }, 'PACE'), modeRow,
    h('div', { class: 'tiny dim', style: { margin: '10px 0 5px' } }, 'ENERGY'), ersRow,
    pitLabel, pitRow, footer);

  const el = h('div', { class: 'carcard' },
    h('div', { class: 'hd' },
      h('i', { style: { width: '4px', height: '17px', borderRadius: '2px', background: c.team.colors.primary } }),
      h('b', {}, c.driver.name), posEl),
    statusNote, body);

  let lastCompounds = '';
  const pitBtns = {};

  function update() {
    const retired = c.status === 'retired';
    const finished = c.status === 'finished';
    posEl.textContent = retired ? 'DNF' : `P${c.position}`;
    if (retired) {
      statusNote.textContent = `Out — ${c.retireReason}.`;
      statusNote.style.display = ''; body.style.display = 'none';
      return;
    }
    statusNote.style.display = 'none'; body.style.display = '';
    defiance.style.display = c.defiance > 0 ? '' : 'none';

    for (const [m, b] of Object.entries(modeBtns)) {
      b.className = `pill ${c.mode === m ? 'on' : ''}`; b.disabled = finished;
    }
    for (const [m, b] of Object.entries(ersBtns)) {
      b.className = `pill ${c.ersMode === m ? 'on' : ''}`; b.disabled = finished;
    }

    const options = sensibleCompounds(race.weather.wetness);
    const key = options.join(',');
    if (key !== lastCompounds) {
      lastCompounds = key;
      for (const k of Object.keys(pitBtns)) delete pitBtns[k];
      pitRow.replaceChildren(...options.map((t) => {
        const b = h('button', { class: 'pill', onClick: () => race.command(c.id, 'pit', t) },
          `${TYRE_COMPOUNDS[t].short} ${TYRE_COMPOUNDS[t].name}`);
        pitBtns[t] = b; return b;
      }));
    }
    for (const [t, b] of Object.entries(pitBtns)) {
      b.className = `pill ${c.pitRequested === t ? 'warnon' : ''}`;
      b.disabled = finished || c.status === 'pit';
    }
    pitLabel.textContent = c.pitRequested ? `BOX — ${TYRE_COMPOUNDS[c.pitRequested].name} ready`
      : c.status === 'pit' ? 'IN THE PIT LANE' : 'CALL HIM IN';
    footer.textContent = `${c.stops} stop${c.stops === 1 ? '' : 's'} · lap ${c.lap} of ${race.lapsTotal}`;
  }

  update();
  return { el, update };
}

// ---------------------------------------------------------------------------
// Strategy panel — the numbers
// ---------------------------------------------------------------------------

function makeStrategyPanel(race, c) {
  const nameEl = h('b', {}, c.driver.name);
  const posEl = h('span', { class: 'p mono' });
  const callEl = h('div', { class: 'call' });
  const grid = h('div', { class: 'stratgrid' });
  const tyreBar = h('i', {});
  const tyreNote = h('div', { class: 'tiny dim' });
  const lapRow = h('div', { class: 'laprow' });

  const el = h('div', { class: 'panel' },
    h('h3', {}, 'Strategy', h('span', { class: 'right' }, posEl)),
    h('div', { class: 'hd', style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '10px' } },
      h('i', { style: { width: '4px', height: '16px', borderRadius: '2px', background: c.team.colors.primary } }),
      nameEl),
    callEl,
    h('div', { style: { margin: '12px 0 4px' } }, h('div', { class: 'meter' }, tyreBar), tyreNote),
    grid, lapRow);

  function cell(label, value, cls = '', sub = null) {
    return h('div', { class: 'scell' },
      h('div', { class: 'sk' }, label),
      h('div', { class: `sv ${cls}` }, value),
      sub ? h('div', { class: 'ss' }, sub) : null);
  }

  function update() {
    if (c.status === 'retired') {
      posEl.textContent = 'DNF';
      callEl.className = 'call pri-high';
      callEl.textContent = `Out of the race — ${c.retireReason}.`;
      grid.replaceChildren(); lapRow.replaceChildren();
      tyreBar.style.width = '0%';
      tyreNote.textContent = '';
      return;
    }
    const b = strategyBrief(race, c);
    posEl.textContent = `P${c.position}`;

    callEl.className = `call pri-${b.urgency}`;
    callEl.textContent = b.call;

    const life = Math.max(0, Math.min(1, 1 - b.tyre.wear));
    tyreBar.style.width = `${life * 100}%`;
    tyreBar.style.background = b.tyre.wear > 0.92 ? 'var(--bad)' : b.tyre.wear > 0.72 ? 'var(--warn)' : 'var(--good)';
    tyreNote.textContent = `${TYRE_COMPOUNDS[c.tyre].name} · ${Math.floor(c.tyreAge)} laps old · `
      + (b.tyre.pastCliff ? 'past the cliff' : `${b.tyre.lapsUsable.toFixed(0)} usable laps left`);

    grid.replaceChildren(
      cell('Deg', `${b.tyre.degPerLap.toFixed(2)}s`, b.tyre.degPerLap > 0.12 ? 'bad' : '', 'per lap, now'),
      cell('Tyre cost', `${b.tyre.lossNow.toFixed(1)}s`, b.tyre.lossNow > 1.2 ? 'bad' : '', 'vs a fresh set'),
      cell('Stop costs', `${b.pit.net.toFixed(1)}s`, '', `${b.pit.stationary.toFixed(1)}s stationary`),
      cell('Rejoin', `P${b.rejoin.position}`, b.rejoin.lost > 2 ? 'bad' : b.rejoin.lost <= 0 ? 'good' : 'warn',
        b.rejoin.justAhead ? `${b.rejoin.gap.toFixed(1)}s behind ${b.rejoin.justAhead.driver.short || b.rejoin.justAhead.driver.name.split(' ').pop()}` : 'clear air'),
      cell('Undercut', b.undercut ? b.undercut.verdict.toUpperCase() : '—',
        b.undercut ? (b.undercut.verdict === 'on' ? 'good' : b.undercut.verdict === 'marginal' ? 'warn' : 'dim') : 'dim',
        b.undercut ? `${b.undercut.swing.toFixed(1)}s swing vs ${b.undercut.gapNow.toFixed(1)}s gap` : 'leading'),
      cell('Fuel', `${b.fuel.margin >= 0 ? '+' : ''}${b.fuel.margin.toFixed(1)}`,
        b.fuel.short ? 'bad' : 'good', `laps ${b.fuel.short ? 'short' : 'spare'}`),
      cell('Push', `+${b.push.gain.toFixed(2)}s`, 'good', `costs ${b.push.lifeCostPush.toFixed(1)} laps of tyre`),
      cell('Save', `−${b.push.save.toFixed(2)}s`, 'warn', `gains ${b.push.lifeGainSave.toFixed(1)} laps of tyre`),
      cell('Risk', pct(b.push.riskPush, 1), b.push.riskPush > 0.02 ? 'bad' : '', 'a mistake, per lap pushing'),
    );

    // Recent laps, with a delta to the best of the race.
    const laps = c.laps.slice(-6);
    const ref = race.fastestLap ? race.fastestLap.time : Math.min(...laps, 999);
    lapRow.replaceChildren(
      h('div', { class: 'tiny dim', style: { marginBottom: '4px' } }, 'RECENT LAPS'),
      h('div', { class: 'laps' }, laps.length
        ? laps.map((t, i) => h('div', { class: 'lapchip' },
          h('span', { class: 'lt' }, lapTime(t)),
          h('span', { class: `ld ${t - ref < 0.35 ? 'good' : t - ref > 1.6 ? 'bad' : ''}` },
            `+${(t - ref).toFixed(2)}`)))
        : h('span', { class: 'tiny dim' }, 'no laps yet')));
  }

  update();
  return { el, update };
}
