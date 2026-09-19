/**
 * APEX: Principal — race day.
 *
 * This screen is the race, not a page about the race. The 3D view is the whole
 * stage; everything drawn on top of it is something you act on:
 *
 *   the lap block     where you are in the race, read at a glance;
 *   the timing window the leader and the four cars around each of yours — not
 *                     all twenty, because nineteen of them are not your problem;
 *   the call          one sentence, only when it is urgent enough to interrupt;
 *   the decks         one per driver: his speed, his tyre, his gaps, and three
 *                     buttons big enough to hit without looking.
 *
 * Everything else — the full field, the strategy numbers, the radio — lives in
 * a sheet under the dock that is closed until you open it. Nothing is gone;
 * it is just not shouting at you while the cars are moving.
 *
 * The 3D repaints every frame. The overlays repaint five times a second,
 * because a number that flickers is a number nobody can read.
 */

import { h, mount, lapTime, gapTime, pct } from './dom.js';
import { createTrackMap } from './trackmap.js';
import { createRaceScene, detectQuality } from '../race3d/scene.js';
import { getTrack } from '../mgmt/track.js';
import { TYRE_COMPOUNDS } from '../data/teams.js';
import { sensibleCompounds } from '../mgmt/raceengine.js';
import { strategyBrief, engineerCalls } from '../mgmt/strategy.js';

const SPEEDS = [0, 1, 2, 5, 15];

// Three ways to watch, because they are three different jobs: the chase is for
// a fight, the broadcast shot is for a stint, the tactical view is for counting
// places. `tilt` sweeps the camera; the zoom is a sensible starting distance.
const VIEWS = [
  { id: 'chase', name: 'Chase', tilt: 0.02, zoom: 24 },
  { id: 'tv', name: 'Broadcast', tilt: 0.22, zoom: 48 },
  { id: 'top', name: 'Tactical', tilt: 0.92, zoom: 130 },
];
const PANEL_HZ = 5;

const SPEAKER_LABEL = {
  engineer: 'ENGINEER', driver: 'DRIVER', control: 'RACE CONTROL',
  pitlane: 'PIT LANE', commentary: 'BROADCAST',
};

const short = (d) => d.short || d.name.split(' ').pop();

export function renderRaceScreen(app, root, race, round) {
  const track = getTrack(round.circuit);
  const mine = race.cars.filter((c) => c.isPlayer);
  const mineIds = new Set(mine.map((c) => c.id));
  document.body.classList.add('racing');

  // ---- the stage --------------------------------------------------------
  const canvas3d = h('canvas', { class: 'r3d' });
  const canvas2d = h('canvas', { id: 'map', style: { display: 'none' } });
  const labelLayer = h('div', { class: 'r3d-labels' });
  const splitLabels = h('div', { class: 'r3d-split', style: { display: 'none' } },
    h('span', { class: 'sl top' }), h('span', { class: 'sl bot' }));

  const lapNum = h('b', {});
  const lapTot = h('span', {});
  const lapBox = h('div', { class: 'lapbox' },
    h('span', { class: 'lk' }, 'LAP'), lapNum, lapTot);
  const chipTrack = infoChip('TRACK');
  const chipSky = infoChip('FORECAST');
  const chipFast = infoChip('FASTEST LAP');
  const chipLead = infoChip('LEADER');
  const ovTop = h('div', { class: 'ov top' }, lapBox,
    h('div', { class: 'chips' }, chipTrack.el, chipSky.el, chipFast.el, chipLead.el));

  const ovFlags = h('div', { class: 'ov flags' });
  const miniCanvas = h('canvas', { class: 'minimap' });
  const ovMini = h('div', { class: 'ov mini' }, miniCanvas);
  const lightsRow = h('div', { class: 'lights' }, [0, 1, 2, 3, 4].map(() => h('i', {})));
  const ovLights = h('div', { class: 'ov startlights', style: { display: 'none' } }, lightsRow);
  const ovTower = h('div', { class: 'ov tower2' });
  const liveRadio = h('div', { class: 'ov radiolive' });
  const ovCall = h('div', { class: 'callout', style: { display: 'none' } });
  const deckRow = h('div', { class: 'decks' });
  const ovBottom = h('div', { class: 'ov bottom' }, ovCall, deckRow);

  const stage = h('div', { class: 'stage' },
    canvas3d, canvas2d, labelLayer, splitLabels, ovTop, ovFlags, ovMini, liveRadio, ovTower, ovLights, ovBottom);

  // ---- the dock ---------------------------------------------------------
  const speedBtns = {};
  const camWrap = h('div', { class: 'dgrp' });
  const viewWrap = h('div', { class: 'dgrp' });
  const tabBtns = {};

  const dock = h('div', { class: 'dock' },
    h('div', { class: 'dgrp' }, h('span', { class: 'dlbl' }, 'SPEED'),
      ...SPEEDS.map((s) => {
        const b = h('button', { class: 'dbtn', onClick: () => { app.speed = s; paintDock(); } },
          s === 0 ? '❚❚' : `${s}×`);
        speedBtns[s] = b; return b;
      })),
    camWrap, viewWrap,
    h('div', { class: 'dgrp zoomgrp' }, h('span', { class: 'dlbl' }, 'ZOOM'),
      h('button', { class: 'dbtn', onClick: () => setZoom(sceneZoom() * 1.35) }, '−'),
      h('button', { class: 'dbtn', onClick: () => setZoom(sceneZoom() / 1.35) }, '+')),
    h('div', { class: 'spacer' }),
    h('div', { class: 'dgrp tabs' },
      ...[['strategy', 'Strategy'], ['timing', 'Timing'], ['radio', 'Radio']].map(([id, name]) => {
        const b = h('button', { class: 'tabbtn', onClick: () => setTab(id) }, name);
        tabBtns[id] = b; return b;
      })),
    h('button', {
      class: 'dbtn sim', onClick: () => {
        app.speed = 0; race.autoStrategy = true; race.simulateToEnd(); finish();
      },
    }, 'Sim rest'),
    h('button', {
      class: 'dbtn', onClick: () => {
        // Run on until one of yours is in the pit lane or the flag falls. Most
        // of a stint is waiting; this is the skip button for it.
        const before = mine.map((c) => c.stops);
        let guard = 0;
        while (race.state === 'racing' && guard++ < 40000) {
          race.step(0.25);
          if (mine.some((c, i) => c.stops > before[i] || c.status === 'pit')) break;
        }
        if (race.state !== 'racing') { finish(); return; }
        acc = 0;
        paintPanels(race.order || race.updateOrder());
      },
    }, 'To my stop'));

  // ---- the sheet --------------------------------------------------------
  const stratSlot = h('div', { class: 'stratrow' });
  const paneStrategy = h('div', { class: 'pane' }, stratSlot);

  const timingSlot = h('div', { class: 'bigtower' });
  const paneTiming = h('div', { class: 'pane' }, timingSlot);

  const radioSlot = h('div', { class: 'radio2' });
  const radioFilter = h('div', { class: 'seg' },
    h('button', { class: 'segbtn', onClick: () => setFilter('team') }, 'Your race'),
    h('button', { class: 'segbtn', onClick: () => setFilter('all') }, 'Everything'));
  const paneRadio = h('div', { class: 'pane' },
    h('div', { class: 'panehd' }, h('span', {}, 'TEAM RADIO'), radioFilter), radioSlot);

  const sheet = h('div', { class: 'sheet' }, paneStrategy, paneTiming, paneRadio);

  const wrap = h('div', { class: 'racestage' }, stage, dock, sheet);
  mount(root, wrap);

  // The stage is the page: whatever the chrome above it leaves, it takes.
  function fitHeight() {
    const top = wrap.getBoundingClientRect().top + window.scrollY;
    // A host page may pad the root by the phone's safe-area insets; the bottom
    // one is not in `top`, so take it off explicitly or the dock sits under it.
    const pad = parseFloat(getComputedStyle(document.documentElement).paddingBottom) || 0;
    wrap.style.height = `${Math.max(440, window.innerHeight - top - pad)}px`;
  }

  function setFilter(f) {
    app.radioFilter = f;
    radioFilter.children[0].className = `segbtn ${f === 'team' ? 'on' : ''}`;
    radioFilter.children[1].className = `segbtn ${f === 'all' ? 'on' : ''}`;
    lastFeedLen = -1;
  }

  let openTab = app.raceTab || null;
  function setTab(t) {
    openTab = openTab === t ? null : t;
    app.raceTab = openTab;
    for (const [id, b] of Object.entries(tabBtns)) b.className = `tabbtn ${openTab === id ? 'on' : ''}`;
    sheet.className = `sheet ${openTab ? 'open' : ''}`;
    ovBottom.className = `ov bottom ${openTab ? 'compact' : ''}`;
    paneStrategy.style.display = openTab === 'strategy' ? '' : 'none';
    paneTiming.style.display = openTab === 'timing' ? '' : 'none';
    paneRadio.style.display = openTab === 'radio' ? '' : 'none';
    lastFeedLen = -1;
    paintPanels(race.order || race.updateOrder());
    sizeSheet();
  }

  /**
   * The sheet takes what is left, not a fixed slice. The decks are overlaid on
   * the stage, so a sheet that grows past its share does not merely crop the
   * 3D — it buries it underneath them.
   */
  function sizeSheet() {
    if (!openTab) { sheet.style.height = '0px'; return; }
    const total = wrap.clientHeight;
    const need = ovBottom.offsetHeight + 250;
    const avail = total - dock.offsetHeight - need;
    sheet.style.height = `${Math.round(Math.max(170, Math.min(440, avail)))}px`;
  }

  // ---- 3D, or the flat map if the machine cannot ------------------------
  let scene = null;
  let map2d = null;
  try {
    scene = createRaceScene(canvas3d, track, { quality: app.state.settings.quality3d || detectQuality() });
  } catch { scene = null; }

  if (scene) {
    scene.addCars(race.cars.map((c) => ({ id: c.id, team: c.team, driver: c.driver, isPlayer: c.isPlayer })));
    scene.setTargets(mine[0]?.id, mine[1]?.id);
    scene.setMode(app.camMode || 'top');
    scene.setZoom(app.camZoom || 48);
    scene.setTilt(app.camTilt ?? 0.22);
    // Lap phase is what the simulation steps in; the circuit is measured in
    // metres. The engine owns the mapping, so hand it to the view.
    scene.setWarp(race.lapPos);
    scene.setWeather(race.weather);
    // A hook for measuring, not for playing: ?debug in the URL only.
    try {
      if (location.search.indexOf('debug') >= 0) window.__apex = { race, scene, app };
    } catch { /* not important */ }
  } else {
    canvas3d.style.display = 'none';
    canvas2d.style.display = 'block';
    map2d = createTrackMap(canvas2d, track);
  }

  // A small plan of the circuit, because a chase camera tells you everything
  // about the next corner and nothing about where you are on the lap.
  let mini = null;
  try { mini = createTrackMap(miniCanvas, track, { compact: true }); } catch { mini = null; }

  const sceneZoom = () => scene?.getZoom() ?? 48;
  function setZoom(z) { if (scene) { scene.setZoom(z); app.camZoom = scene.getZoom(); } }

  // ---- camera -----------------------------------------------------------
  let followId = app.camFollow || mine[0]?.id || race.cars[0].id;

  /** On a phone there is no room for six camera buttons, so one cycles. */
  function camOptions() {
    const opts = mine.map((c) => ({ id: c.id, name: short(c.driver) }));
    opts.push({ id: '__leader', name: 'Leader' });
    if (mine.length > 1) opts.push({ id: '__split', name: 'Both' });
    return opts;
  }
  function pickCam(id) {
    if (id === '__split') {
      app.camMode = 'split';
      scene?.setMode('split');
      scene?.setTargets(mine[0].id, mine[1].id);
    } else {
      app.camMode = 'top';
      followId = app.camFollow = id;
      scene?.setMode('top');
      if (id !== '__leader') scene?.setTargets(id, null);
    }
    paintCams();
  }
  function currentCam() {
    return app.camMode === 'split' ? '__split' : followId;
  }

  function paintCams() {
    const opts = camOptions();
    const cur = currentCam();
    const idx = Math.max(0, opts.findIndex((o) => o.id === cur));
    const cycle = h('button', {
      class: 'dbtn dcycle', onClick: () => pickCam(opts[(idx + 1) % opts.length].id),
    }, h('span', { class: 'ck' }, 'CAM'), h('b', {}, opts[idx].name));
    const chips = [h('span', { class: 'dlbl' }, 'CAMERA'), cycle];
    for (const c of mine) {
      chips.push(h('button', {
        class: `dbtn dfull ${app.camMode !== 'split' && followId === c.id ? 'on' : ''}`,
        onClick: () => pickCam(c.id),
      }, short(c.driver)));
    }
    chips.push(h('button', {
      class: `dbtn dfull ${app.camMode !== 'split' && followId === '__leader' ? 'on' : ''}`,
      onClick: () => pickCam('__leader'),
    }, 'Leader'));
    if (mine.length > 1) {
      chips.push(h('button', {
        class: `dbtn dfull ${app.camMode === 'split' ? 'on' : ''}`,
        onClick: () => pickCam('__split'),
      }, 'Both'));
    }
    splitLabels.style.display = app.camMode === 'split' ? '' : 'none';
    if (app.camMode === 'split' && mine.length > 1) {
      splitLabels.children[0].textContent = mine[0].driver.name;
      splitLabels.children[1].textContent = mine[1].driver.name;
    }
    camWrap.replaceChildren(...chips);
  }

  function paintDock() {
    for (const [s, b] of Object.entries(speedBtns)) {
      b.className = `dbtn ${app.speed === Number(s) ? 'on' : ''}`;
    }
  }

  function pickView(v) {
    app.camView = v.id;
    app.camTilt = v.tilt;
    scene?.setTilt(v.tilt);
    setZoom(v.zoom);
    paintViews();
  }
  function paintViews() {
    const i = Math.max(0, VIEWS.findIndex((v) => v.id === app.camView));
    viewWrap.replaceChildren(
      h('span', { class: 'dlbl' }, 'VIEW'),
      h('button', {
        class: 'dbtn dcycle', onClick: () => pickView(VIEWS[(i + 1) % VIEWS.length]),
      }, h('span', { class: 'ck' }, 'VIEW'), h('b', {}, VIEWS[i].name)),
      ...VIEWS.map((v) => h('button', {
        class: `dbtn dfull ${app.camView === v.id ? 'on' : ''}`,
        onClick: () => pickView(v),
      }, v.name)));
  }

  canvas3d.addEventListener('wheel', (e) => {
    e.preventDefault();
    setZoom(sceneZoom() * (e.deltaY > 0 ? 1.12 : 1 / 1.12));
  }, { passive: false });

  let pinch = 0;
  canvas3d.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) pinch = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
  }, { passive: true });
  canvas3d.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 2 || !pinch) return;
    const d = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    setZoom(sceneZoom() * (pinch / Math.max(1, d)));
    pinch = d;
  }, { passive: true });
  canvas3d.addEventListener('touchend', () => { pinch = 0; }, { passive: true });

  // ---- built once, updated in place -------------------------------------
  const decks = mine.map((c) => makeCarDeck(race, c, mine));
  deckRow.replaceChildren(...decks.map((d) => d.el));
  const briefs = mine.map((c) => makeStrategyPanel(race, c));
  stratSlot.replaceChildren(...briefs.map((b) => b.el));

  // ---- the loop ---------------------------------------------------------
  let last = performance.now();
  let acc = 0;
  let panelAcc = 0;
  let labelAcc = 0;
  const labelPool = new Map();
  const towerPool = new Map();
  const radioMemo = new Map();
  let lastFeedLen = -1;
  let lastWet = null;
  let stopped = false;
  app.stopLoop?.();
  app.stopLoop = () => {
    stopped = true;
    document.body.classList.remove('racing');
    window.removeEventListener('resize', onResize);
    window.removeEventListener('keydown', onKey);
    ro?.disconnect();
    scene?.dispose();
  };

  const ro = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(() => scene?.resize()) : null;
  ro?.observe(stage);

  function onResize() { fitHeight(); sizeSheet(); scene?.resize(); }

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

    if (scene) {
      if (followId === '__leader') {
        const leader = order.find((c) => c.status !== 'retired');
        if (leader && app.camMode !== 'split') scene.setTargets(leader.id, null);
      }
      scene.setTimeScale(app.speed);
      // How far this frame sits between the last simulation step and the next.
      const alpha = app.speed > 0 ? Math.max(0, Math.min(1, acc / 0.25)) : 1;
      scene.updateCars(order.map((c) => ({
        id: c.id, u: c.u, prevU: c.prevU, status: c.status, tyre: c.tyre, drs: c.drs,
        speed: race.currentSpeed(c),
        lateral: c.lateral, prevLateral: c.prevLateral,
      })), alpha, real);

      // Smoke and dust the simulation asked for: locked wheels, gravel, spins.
      if (race.fx.length) {
        for (const f of race.fx) scene.puff(f.car, f.kind, f.count);
        race.fx.length = 0;
      }

      scene.render(real);
      labelAcc += real;
      if (labelAcc >= 1 / 14) {
        labelAcc = 0;
        paintLabels(order);
        if (mini) { try { mini.draw(order, race.weather, { labels: false, compact: true }); } catch { mini = null; } }
      }
    } else if (map2d) {
      map2d.draw(order, race.weather, { labels: true });
    } else if (race.fx.length) {
      race.fx.length = 0;
    }

    panelAcc += real;
    if (panelAcc >= 1 / PANEL_HZ) { panelAcc = 0; paintPanels(order); }
  }

  /**
   * A tag over each car. The stage is not a diagram, so the tags keep clear of
   * the decks along the bottom and of the timing window down the right.
   */
  function paintLabels(order) {
    if (!scene) return;
    const byId = new Map(order.map((c) => [c.id, c]));
    const shots = scene.screenPositions();
    const seen = new Set();
    const zoom = sceneZoom();
    const H = Math.max(1, stage.clientHeight);
    const W = Math.max(1, stage.clientWidth);
    const floor = 1 - (ovBottom.offsetHeight + 6) / H;
    const wall = 1 - (ovTower.offsetWidth + 24) / W;

    // Nearest first, and yours always. A tag is a fixed number of PIXELS wide,
    // so the spacing that keeps them apart has to be in pixels too — as a
    // fraction of the viewport it let them pile up on a narrow screen.
    shots.sort((a, b) => (b.isPlayer ? 1 : 0) - (a.isPlayer ? 1 : 0) || a.dist - b.dist);
    const minX = 92 / W, minY = 30 / H;
    const maxRivals = W < 520 ? 4 : W < 900 ? 8 : 20;
    let rivals = 0;
    const placed = [];
    for (const s of shots) {
      const car = byId.get(s.id);
      if (!car || car.status === 'retired') continue;
      if (!s.isPlayer && zoom > 230 && car.position > 3) continue;
      if (s.y > floor || s.y < 0.10) continue;
      if (s.x > wall && s.y < 0.62) continue;
      if (!s.isPlayer) {
        if (rivals >= maxRivals) continue;
        let clash = false;
        for (const q of placed) {
          if (Math.abs(q.x - s.x) < minX && Math.abs(q.y - s.y) < minY) { clash = true; break; }
        }
        if (clash) continue;
        rivals++;
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
      el.children[1].textContent = short(car.driver);
      el.children[2].textContent = (TYRE_COMPOUNDS[car.tyre]?.short || '?') + Math.floor(car.tyreAge);
      el.children[2].className = `ct ty-${car.tyre}`;
    }
    for (const [k, el] of labelPool) if (!seen.has(k)) el.style.display = 'none';
  }

  /**
   * The timing window: the leader, and the cars either side of each of yours.
   * A gap in the order is drawn as a gap, so you always know what you are
   * looking at. The full twenty is one tap away in the Timing tab.
   */
  function towerWindow(order) {
    // However many rows the stage has room for above the decks. A tower that
    // runs off the bottom of the screen is worse than a shorter one.
    const room = stage.clientHeight - 104 - ovBottom.offsetHeight - 10;
    const budget = Math.floor(room / 34);
    if (budget < 2) return [];

    const build = (r) => {
      const want = new Set([0]);
      order.forEach((c, i) => {
        if (!mineIds.has(c.id)) return;
        for (let k = i - r; k <= i + r; k++) if (k >= 0 && k < order.length) want.add(k);
      });
      const idx = [...want].sort((a, b) => a - b);
      const out = [];
      let prev = -1;
      for (const i of idx) {
        if (prev >= 0 && i > prev + 1) out.push(null);
        out.push(order[i]);
        prev = i;
      }
      return out;
    };
    for (let r = 2; r >= 0; r--) {
      const rows = build(r);
      if (rows.length <= budget) return rows;
    }
    // Too tight even for that: your two cars, and nothing else.
    return order.filter((c) => mineIds.has(c.id)).slice(0, budget);
  }

  function paintTower(order) {
    const rows = towerWindow(order);
    ovTower.style.display = rows.length ? '' : 'none';
    if (!rows.length) { ovTower.replaceChildren(); return; }
    const seen = new Set();
    const els = [];
    let gapN = 0;
    for (const c of rows) {
      if (!c) {
        const key = `gap${gapN++}`;
        let el = towerPool.get(key);
        if (!el) { el = h('div', { class: 't2gap' }, '⋯'); towerPool.set(key, el); }
        seen.add(key); els.push(el);
        continue;
      }
      const key = c.id;
      let el = towerPool.get(key);
      if (!el) {
        el = h('div', { class: 't2row' },
          h('span', { class: 'p' }), h('i', {}), h('span', { class: 'nm' }),
          h('span', { class: 'mv' }), h('span', { class: 'gp' }), h('span', { class: 'ty' }));
        el.children[1].style.background = c.team.colors.primary;
        towerPool.set(key, el);
      }
      seen.add(key);
      const cls = c.status === 'retired' ? 'out' : c.status === 'pit' ? 'inpit' : '';
      el.className = `t2row ${c.isPlayer ? 'me' : ''} ${cls}`;
      el.children[0].textContent = c.status === 'retired' ? '–' : c.position;
      el.children[2].textContent = short(c.driver);
      const moved = (c.gridPos || c.position) - c.position;
      el.children[3].textContent = c.status === 'retired' ? '' : moved > 0 ? `▲${moved}` : moved < 0 ? `▼${-moved}` : '';
      el.children[3].className = `mv ${moved > 0 ? 'up' : moved < 0 ? 'down' : ''}`;
      el.children[4].textContent = c.status === 'retired' ? 'DNF'
        : c.status === 'pit' ? 'PIT'
          : c.position === 1 ? 'LEADER' : gapTime(c.interval);
      el.children[5].textContent = (TYRE_COMPOUNDS[c.tyre]?.short || '?') + Math.floor(c.tyreAge);
      el.children[5].className = `ty ty-${c.tyre}`;
      els.push(el);
    }
    ovTower.replaceChildren(...els);
    for (const [k, el] of towerPool) if (!seen.has(k)) el.remove();
  }

  /** One sentence over the race, and only when it is worth interrupting for. */
  function paintCallout() {
    let best = null;
    for (const d of decks) {
      const b = d.brief;
      if (!b || d.car.status !== 'running') continue;
      if (b.urgency !== 'high' && b.urgency !== 'act') continue;
      if (!best || (b.urgency === 'high' && best.b.urgency !== 'high')) best = { car: d.car, b };
    }
    if (!best) { ovCall.style.display = 'none'; return; }
    ovCall.style.display = '';
    ovCall.className = `callout pri-${best.b.urgency}`;
    ovCall.replaceChildren(
      h('span', { class: 'who' }, short(best.car.driver)),
      h('span', { class: 'what' }, best.b.call));
  }

  /**
   * The radio, on the track, all the time. Newest on top so it never needs
   * scrolling, four at once so it never becomes a wall, and it fades out from
   * the bottom so the eye goes to the new one. It is a feed, not a panel: no
   * pointer events, nothing behind it to click.
   */
  const LIVE_MAX = 4;
  let liveSeen = 0;
  function paintLiveRadio() {
    const mineIdsL = mineIds;
    const shown = [];
    for (let i = race.feed.length - 1; i >= 0 && shown.length < LIVE_MAX; i--) {
      const f = race.feed[i];
      if (!(f.player || mineIdsL.has(f.car) || f.priority === 'high')) continue;
      shown.push(f);
    }
    if (race.feed.length === liveSeen && liveRadio.childElementCount === shown.length) return;
    liveSeen = race.feed.length;
    liveRadio.replaceChildren(...shown.map((f, i) => h('div', {
      class: `lrm from-${f.from || 'commentary'} pri-${f.priority || 'low'}`,
      style: { opacity: String(1 - i * 0.22) },
    },
      h('div', { class: 'lrh' },
        h('span', { class: 'who' }, SPEAKER_LABEL[f.from] || 'BROADCAST'),
        h('span', { class: 'when' }, `L${f.lap} · ${clock(f.time)}`)),
      h('div', { class: 'lrt' }, f.text))));
  }

  function paintPanels(order) {
    lapNum.textContent = String(Math.min(race.lap + 1, race.lapsTotal));
    lapTot.textContent = `/${race.lapsTotal}`;
    chipTrack.set(`${race.weather.state} · ${race.weather.trackTemp.toFixed(0)}°C`);
    chipSky.set(race.forecast ? race.forecast.text : '—');
    if (scene && Math.abs((lastWet ?? -9) - race.weather.wetness) > 0.02) {
      lastWet = race.weather.wetness;
      scene.setWeather(race.weather);
    }
    chipSky.el.className = `chip ${race.forecast && race.forecast.wet && race.forecast.laps < 8 ? 'alert' : ''}`;
    chipFast.set(race.fastestLap ? `${race.fastestLap.driver} ${lapTime(race.fastestLap.time)}` : '—');
    chipLead.set(order[0] ? `${short(order[0].driver)} · ${order[0].team.short}` : '—');

    const flags = [];
    if (race.safetyCar) {
      const sc = race.safetyCar;
      const tail = sc.lapsLeft != null
        ? (sc.lapsLeft <= 1 ? ' — IN THIS LAP' : `  ·  ${sc.lapsLeft} LAPS`)
        : (sc.secsLeft != null && sc.secsLeft <= 10 ? ' — ENDING' : `  ·  ${Math.max(0, Math.ceil(sc.secsLeft || 0))}s`);
      flags.push(h('div', { class: `flagbar ${sc.kind}` },
        (sc.kind === 'sc' ? 'SAFETY CAR' : 'VIRTUAL SAFETY CAR') + tail));
    }
    if (race.weather.wetness > 0.14) {
      flags.push(h('div', { class: 'flagbar rain' },
        race.weather.wetness > 0.5 ? 'HEAVY RAIN' : 'DAMP TRACK'));
    }
    ovFlags.replaceChildren(...flags);

    paintTower(order);

    // Engineer calls, once per car per lap.
    for (const c of mine) {
      if (c.status !== 'running') continue;
      if (radioMemo.get(`${c.id}:lap`) === c.lap) continue;
      radioMemo.set(`${c.id}:lap`, c.lap);
      let memo = radioMemo.get(c.id);
      if (!memo) { memo = {}; radioMemo.set(c.id, memo); }
      for (const call of engineerCalls(race, c, memo)) {
        race.pushRadio('engineer', `${short(c.driver)}: ${call.text}`, call.p, c.id);
      }
    }

    for (const d of decks) d.update();
    paintCallout();
    paintLiveRadio();

    if (openTab === 'strategy') for (const b of briefs) b.update();
    if (openTab === 'timing') paintBigTower(order);
    if (openTab === 'radio' && race.feed.length !== lastFeedLen) {
      lastFeedLen = race.feed.length;
      const shown = race.feed.filter((f) => app.radioFilter === 'all'
        || f.player || mineIds.has(f.car) || f.priority === 'high');
      radioSlot.replaceChildren(...shown.slice(-50).map((f) => h('div', {
        class: `rmsg from-${f.from || 'commentary'} pri-${f.priority || 'low'}`,
      },
        h('div', { class: 'rmeta' },
          h('span', { class: 'rwho' }, SPEAKER_LABEL[f.from] || 'BROADCAST'),
          h('span', { class: 'rlap' }, `LAP ${f.lap} · ${clock(f.time)}`)),
        h('div', { class: 'rtext' }, f.text))));
    }
  }

  // Twenty rows of eleven cells, rebuilt five times a second, is two hundred
  // and twenty elements a paint. Build them once and write the text.
  const bigRows = new Map();
  let bigHead = null;
  function paintBigTower(order) {
    if (!bigHead) {
      bigHead = h('div', { class: 'bt hd' },
        h('span', {}, 'POS'), h('span', {}, ''), h('span', {}, 'DRIVER'), h('span', {}, 'TEAM'),
        h('span', { class: 'r' }, 'GAP'), h('span', { class: 'r' }, 'INTERVAL'),
        h('span', { class: 'c' }, 'TYRE'), h('span', { class: 'r' }, 'AGE'),
        h('span', { class: 'r' }, 'STOPS'), h('span', { class: 'r' }, 'LAST'), h('span', { class: 'r' }, 'BEST'));
    }
    const rows = [bigHead];
    for (const c of order) {
      let el = bigRows.get(c.id);
      if (!el) {
        el = h('div', { class: 'bt' },
          h('span', {}), h('i', { style: { background: c.team.colors.primary } }),
          h('span', { class: 'nm' }, c.driver.name), h('span', { class: 'tm' }, c.team.short),
          h('span', { class: 'r mono' }), h('span', { class: 'r mono' }),
          h('span', { class: 'c ty' }), h('span', { class: 'r mono' }),
          h('span', { class: 'r mono' }), h('span', { class: 'r mono' }), h('span', { class: 'r mono' }));
        bigRows.set(c.id, el);
      }
      const k = el.children;
      const cls = c.status === 'retired' ? 'out' : c.status === 'pit' ? 'inpit' : '';
      el.className = `bt ${c.isPlayer ? 'me' : ''} ${cls}`;
      k[0].textContent = c.status === 'retired' ? '–' : c.position;
      k[2].textContent = c.driver.name;
      k[4].textContent = c.status === 'retired' ? 'DNF' : c.position === 1 ? '—' : gapTime(c.gapToLeader ?? c.interval);
      k[5].textContent = c.position === 1 || c.status === 'retired' ? '—' : gapTime(c.interval);
      k[6].textContent = TYRE_COMPOUNDS[c.tyre]?.short || '?';
      k[6].className = `c ty ty-${c.tyre}`;
      k[7].textContent = `${Math.floor(c.tyreAge)}`;
      k[8].textContent = `${c.stops}`;
      const purple = race.fastestLap && race.fastestLap.car === c.id;
      k[9].textContent = c.lastLapTime ? lapTime(c.lastLapTime) : '—';
      k[10].textContent = c.bestLap ? lapTime(c.bestLap) : '—';
      k[10].className = `r mono ${purple ? 'purple' : ''}`;
      rows.push(el);
    }
    timingSlot.replaceChildren(...rows);
  }

  setFilter(app.radioFilter || 'team');
  if (!app.camView) app.camView = 'tv';
  paintCams();
  paintViews();
  paintDock();
  setTab(openTab);
  // Lights out. Five reds, then they go, and the overlay goes with them.
  if (race.lap === 0 && race.time < 1.5) {
    ovLights.style.display = '';
    let lit = 0;
    const lamp = setInterval(() => {
      if (stopped) { clearInterval(lamp); return; }
      if (lit < 5) { lightsRow.children[lit].className = 'on'; lit++; return; }
      clearInterval(lamp);
      ovLights.className = 'ov startlights out';
      setTimeout(() => { ovLights.style.display = 'none'; }, 700);
    }, 420);
  }

  /**
   * Keys, because reaching for a mouse while two cars are fighting is not how
   * anyone wants to call a race. Space pauses, the number keys set the speed,
   * C and V cycle the camera and the view, and S/T/R open the panels.
   */
  function onKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const k = e.key.toLowerCase();
    if (k === ' ') { app.speed = app.speed > 0 ? 0 : 1; paintDock(); e.preventDefault(); return; }
    const n = '01234'.indexOf(e.key);
    if (n > 0) { app.speed = SPEEDS[n]; paintDock(); return; }
    if (k === 'c') { const o = camOptions(); const i = o.findIndex((x) => x.id === currentCam()); pickCam(o[(i + 1) % o.length].id); return; }
    if (k === 'v') { const i = VIEWS.findIndex((x) => x.id === app.camView); pickView(VIEWS[(i + 1) % VIEWS.length]); return; }
    if (k === 's') setTab('strategy');
    else if (k === 't') setTab('timing');
    else if (k === 'r') setTab('radio');
    else if (k === '+' || k === '=') setZoom(sceneZoom() / 1.25);
    else if (k === '-') setZoom(sceneZoom() * 1.25);
  }
  window.addEventListener('keydown', onKey);

  fitHeight();
  window.addEventListener('resize', onResize);
  paintPanels(race.order || race.updateOrder());
  requestAnimationFrame(frame);
}

/** Race time as a clock, for the radio stamps. */
function clock(t) {
  const s = Math.max(0, Math.floor(t || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function infoChip(label) {
  const v = h('span', { class: 'v' });
  return { el: h('div', { class: 'chip' }, h('span', { class: 'k' }, label), v), set: (t) => { v.textContent = t; } };
}

// ---------------------------------------------------------------------------
// The deck — one driver, three buttons
// ---------------------------------------------------------------------------

function makeCarDeck(race, c, mine) {
  const posEl = h('span', { class: 'dpos' });
  const nameEl = h('span', { class: 'dnm' });
  const tyreEl = h('span', { class: 'dty' });

  const engBtn = h('button', { class: 'segbtn', onClick: () => setMode('auto') }, 'Engineer');
  const youBtn = h('button', { class: 'segbtn', onClick: () => setMode('manual') }, 'You');
  const seg = h('div', { class: 'seg tiny' }, engBtn, youBtn);

  function setMode(m) {
    c.strategyMode = m;
    c.overrideUntilLap = m === 'manual' ? 1e9 : c.lap;
    race.pushRadio('engineer',
      m === 'auto' ? `Understood — I have ${short(c.driver)} from here.`
        : `Copy, ${short(c.driver)} is yours. I will keep quiet.`,
      'normal', c.id);
    update();
  }

  // ---- telemetry ----
  const spdEl = h('b', {});
  const drsEl = h('span', { class: 'drs' }, 'DRS');
  const ersFill = h('i', {});
  const ersTxt = h('span', { class: 'ev' });
  const aheadEl = h('span', { class: 'gv' });
  const behindEl = h('span', { class: 'gv' });
  const lastEl = h('span', { class: 'gv mono' });
  const bestEl = h('span', { class: 'gv mono' });
  const secRow = h('div', { class: 'dsec' });

  const telem = h('div', { class: 'dtel' },
    h('div', { class: 'spd' }, spdEl, h('em', {}, 'km/h'), drsEl),
    h('div', { class: 'ers' },
      h('span', { class: 'ek' }, 'ERS'),
      h('div', { class: 'ebar' }, ersFill), ersTxt),
    h('div', { class: 'gaps' },
      h('div', { class: 'g' }, h('span', { class: 'gk' }, 'AHEAD'), aheadEl),
      h('div', { class: 'g' }, h('span', { class: 'gk' }, 'BEHIND'), behindEl),
      h('div', { class: 'g' }, h('span', { class: 'gk' }, 'LAST'), lastEl),
      h('div', { class: 'g' }, h('span', { class: 'gk' }, 'BEST'), bestEl)),
    secRow);

  // ---- the three buttons ----
  let trayOpen = false;
  const boxBtn = h('button', { class: 'act box', onClick: () => boxNow() },
    h('b', {}, 'BOX'), h('em', {}, ''));
  const boxMore = h('button', {
    class: 'act caret', onClick: () => { trayOpen = !trayOpen; update(); },
  }, '▾');
  const pushBtn = h('button', {
    class: 'act', onClick: () => race.command(c.id, 'mode', c.mode === 'push' ? 'neutral' : 'push'),
  }, h('b', {}, 'PUSH'), h('em', {}, ''));
  const ersBtn = h('button', {
    class: 'act', onClick: () => race.command(c.id, 'ers', c.ersMode === 'deploy' ? 'balanced' : 'deploy'),
  }, h('b', {}, 'DEPLOY'), h('em', {}, ''));

  const actRow = h('div', { class: 'dact' },
    h('div', { class: 'split' }, boxBtn, boxMore), pushBtn, ersBtn);

  // Tyre health, on the deck rather than behind a tab. It is the one number
  // every call on this screen comes back to.
  const tyreFill = h('i', {});
  const tyreLife = h('span', { class: 'tl mono' });
  const tyreNote = h('span', { class: 'tn' });
  const tyreRow = h('div', { class: 'dtyre' },
    tyreEl,
    h('div', { class: 'tbar' }, tyreFill),
    tyreLife, tyreNote);

  // Team orders. Only offered when it is actually a question: your other car is
  // right behind and going quicker.
  const teamRow = h('div', { class: 'trow' });
  function paintTeamRow() {
    const other = (mine || []).find((x) => x !== c);
    if (!other || other.status !== 'running' || c.status !== 'running') {
      teamRow.replaceChildren(h('span', { class: 'tiny dim' }, 'Nothing to ask for.'));
      return;
    }
    const order = race.order || race.updateOrder();
    const ia = order.indexOf(c), ib = order.indexOf(other);
    if (ia < 0 || ib < 0) return;
    const ahead = ia < ib ? c : other;
    const behind = ia < ib ? other : c;
    const gap = Math.abs(behind.distance - ahead.distance) / Math.max(30, race.currentSpeed(behind));
    if (ahead !== c || gap > 3.2) {
      teamRow.replaceChildren(h('span', { class: 'tiny dim' },
        ahead === c ? `${short(behind.driver)} is ${gap.toFixed(1)}s back — too far to ask.` : `He is behind ${short(ahead.driver)}.`));
      return;
    }
    teamRow.replaceChildren(h('button', {
      class: 'tbtn warn', onClick: () => { race.swapCars(c.id, behind.id); update(); },
    }, `Let ${short(behind.driver)} through`),
      h('span', { class: 'tiny dim', style: { alignSelf: 'center' } }, `${gap.toFixed(1)}s behind`));
  }

  const tray = h('div', { class: 'dtray', style: { display: 'none' } });
  const noteEl = h('div', { class: 'dnote' });
  const outEl = h('div', { class: 'dout', style: { display: 'none' } });

  const el = h('div', { class: 'deck' },
    h('div', { class: 'dhd' },
      h('i', { style: { background: c.team.colors.primary } }),
      posEl, nameEl, h('span', { class: 'spacer' }), seg),
    tyreRow, telem, actRow, tray, noteEl, outEl);

  let lastCompounds = '';
  const pitBtns = {};

  /** What the engineer would fit, given the weather and the laps left. */
  function recommend() {
    const opts = sensibleCompounds(race.weather.wetness);
    if (race.weather.wetness > 0.14) return opts[opts.length - 1];
    const left = race.lapsTotal - c.lap;
    const life = { soft: 0.62, medium: 0.82, hard: 1.0 };
    for (const t of ['soft', 'medium', 'hard']) {
      if (!opts.includes(t)) continue;
      if (left <= race.lapsTotal * life[t] * 0.55) return t;
    }
    return opts.includes('medium') ? 'medium' : opts[0];
  }

  function boxNow() {
    if (c.pitRequested || c.status === 'pit') return;
    race.command(c.id, 'pit', recommend());
    trayOpen = false;
    update();
  }

  function update() {
    const retired = c.status === 'retired';
    const finished = c.status === 'finished';
    posEl.textContent = retired ? 'DNF' : `P${c.position}`;
    nameEl.textContent = c.driver.name;

    if (retired) {
      el.className = 'deck out';
      telem.style.display = 'none'; actRow.style.display = 'none';
      tray.style.display = 'none'; noteEl.style.display = 'none';
      tyreRow.style.display = 'none';
      outEl.style.display = '';
      outEl.textContent = `Out of the race — ${c.retireReason}.`;
      return;
    }
    el.className = `deck ${c.defiance > 0 ? 'angry' : ''}`;
    telem.style.display = ''; actRow.style.display = ''; outEl.style.display = 'none';
    tyreRow.style.display = '';

    const cmp = TYRE_COMPOUNDS[c.tyre];
    tyreEl.textContent = cmp?.short || '?';
    tyreEl.className = `dty ty-${c.tyre}`;

    const brief = c.status === 'running' ? strategyBrief(race, c) : null;
    const wear = brief ? brief.tyre.wear : Math.min(1, c.wear ?? 0);
    const life = Math.max(0, Math.min(1, 1 - wear));
    tyreFill.style.width = `${(life * 100).toFixed(0)}%`;
    tyreFill.style.background = wear > 0.92 ? 'var(--bad)' : wear > 0.72 ? 'var(--warn)' : 'var(--good)';
    tyreLife.textContent = `${(life * 100).toFixed(0)}%`;
    tyreLife.className = `tl mono ${wear > 0.92 ? 'bad' : wear > 0.72 ? 'warn' : ''}`;
    tyreNote.textContent = brief
      ? `${cmp?.name || ''} · ${Math.floor(c.tyreAge)} laps · `
        + (brief.tyre.pastCliff ? 'past the cliff' : `${brief.tyre.lapsUsable.toFixed(0)} usable left`)
      : `${cmp?.name || ''} · ${Math.floor(c.tyreAge)} laps`;
    tyreNote.className = `tn ${brief && brief.tyre.pastCliff ? 'bad' : ''}`;

    const auto = c.strategyMode === 'auto';
    engBtn.className = `segbtn ${auto ? 'on' : ''}`;
    youBtn.className = `segbtn ${auto ? '' : 'on'}`;

    spdEl.textContent = (race.currentSpeed(c) * 3.6).toFixed(0);
    drsEl.style.visibility = c.drs ? 'visible' : 'hidden';
    ersFill.style.width = `${(c.ersCharge * 100).toFixed(0)}%`;
    ersFill.style.background = c.ersCharge < 0.15 ? 'var(--bad)'
      : c.ersCharge < 0.4 ? 'var(--warn)' : 'var(--accent-2)';
    ersTxt.textContent = `${(c.ersCharge * 100).toFixed(0)}%`;

    const order = race.order || race.updateOrder();
    const idx = order.indexOf(c);
    const ah = order[idx - 1], bh = order[idx + 1];
    aheadEl.textContent = ah && ah.status !== 'retired'
      ? `+${c.interval.toFixed(1)} ${short(ah.driver)}` : 'leading';
    behindEl.textContent = bh && bh.status !== 'retired'
      ? `−${bh.interval.toFixed(1)} ${short(bh.driver)}` : 'last';
    lastEl.textContent = c.lastLapTime ? lapTime(c.lastLapTime) : '—';
    bestEl.textContent = c.bestLap ? lapTime(c.bestLap) : '—';
    bestEl.className = `gv mono ${race.fastestLap && race.fastestLap.car === c.id ? 'purple' : ''}`;

    secRow.replaceChildren(...[0, 1, 2].map((i) => {
      const live = c.sectors[i], done = c.lastSectors[i], best = c.bestSectors[i];
      const t = live ?? done;
      const cls = t == null ? 'dim'
        : (best != null && t <= best + 0.001) ? 'good'
          : (best != null && t > best + 0.35) ? 'bad' : '';
      return h('div', { class: `sc ${live != null ? 'live' : ''}` },
        h('span', { class: 'k' }, `S${i + 1}`),
        h('span', { class: `v mono ${cls}` }, t != null ? t.toFixed(1) : '—'));
    }));

    // Buttons.
    const inPit = c.status === 'pit';
    boxBtn.className = `act box ${c.pitRequested ? 'armed' : ''}`;
    boxBtn.children[0].textContent = inPit ? 'IN PIT' : 'BOX';
    boxBtn.children[1].textContent = c.pitRequested
      ? TYRE_COMPOUNDS[c.pitRequested].name
      : inPit ? 'stationary' : `${TYRE_COMPOUNDS[recommend()].name} ready`;
    boxBtn.disabled = finished || inPit || !!c.pitRequested;
    boxMore.disabled = finished || inPit || !!c.pitRequested;

    pushBtn.className = `act ${c.mode === 'push' ? 'on' : ''}`;
    pushBtn.children[0].textContent = c.mode === 'push' ? 'PUSHING' : 'PUSH';
    pushBtn.children[1].textContent = c.mode === 'conserve' ? 'saving tyres'
      : c.mode === 'hold' ? 'holding station' : c.mode === 'push' ? 'tap to settle' : 'normal pace';
    pushBtn.disabled = finished;

    ersBtn.className = `act ${c.ersMode === 'deploy' ? 'on' : ''}`;
    ersBtn.children[0].textContent = c.ersMode === 'deploy' ? 'DEPLOYING' : 'DEPLOY';
    ersBtn.children[1].textContent = c.ersMode === 'harvest' ? 'harvesting'
      : c.ersMode === 'deploy' ? 'tap to balance' : 'balanced';
    ersBtn.disabled = finished || (c.ersMode !== 'deploy' && c.ersCharge <= 0.02);

    // Tray: everything the three buttons do not cover.
    const options = sensibleCompounds(race.weather.wetness);
    const key = options.join(',');
    if (key !== lastCompounds) {
      lastCompounds = key;
      for (const k of Object.keys(pitBtns)) delete pitBtns[k];
      tray.replaceChildren(
        h('div', { class: 'trk' }, 'FIT'),
        h('div', { class: 'trow' }, options.map((t) => {
          const b = h('button', {
            class: 'tbtn', onClick: () => { race.command(c.id, 'pit', t); trayOpen = false; update(); },
          }, TYRE_COMPOUNDS[t].name);
          pitBtns[t] = b; return b;
        })),
        h('div', { class: 'trk' }, 'PACE'),
        h('div', { class: 'trow' }, ['push', 'neutral', 'conserve', 'hold'].map((m) => h('button', {
          class: `tbtn ${c.mode === m ? 'on' : ''}`,
          onClick: () => { race.command(c.id, 'mode', m); update(); },
        }, m))),
        h('div', { class: 'trk' }, 'ENERGY'),
        h('div', { class: 'trow' }, ['harvest', 'balanced', 'deploy'].map((m) => h('button', {
          class: `tbtn ${c.ersMode === m ? 'on' : ''}`,
          onClick: () => { race.command(c.id, 'ers', m); update(); },
        }, m))),
        h('div', { class: 'trk' }, 'TEAM'), teamRow);
    }
    if (trayOpen) paintTeamRow();
    tray.style.display = trayOpen ? '' : 'none';
    boxMore.textContent = trayOpen ? '▴' : '▾';
    for (const [t, b] of Object.entries(pitBtns)) b.disabled = finished || inPit || !!c.pitRequested;

    noteEl.style.display = '';
    if (c.defiance > 0) {
      noteEl.className = 'dnote bad';
      noteEl.textContent = 'He has stopped listening to the pit wall.';
    } else if (auto && c.lap < c.overrideUntilLap) {
      noteEl.className = 'dnote warn';
      noteEl.textContent = `Your call stands ${Math.max(0, c.overrideUntilLap - c.lap)} more laps.`;
    } else if (auto) {
      noteEl.className = 'dnote';
      noteEl.textContent = 'His engineer is calling it. Any button overrides for three laps.';
    } else {
      noteEl.className = 'dnote';
      noteEl.textContent = `You are calling everything · ${c.stops} stop${c.stops === 1 ? '' : 's'} · lap ${Math.min(c.lap + 1, race.lapsTotal)}/${race.lapsTotal}`;
    }

    // Kept on the deck so the callout can read it without recomputing.
    deck.brief = brief;
  }

  const deck = { el, update, car: c, brief: null };
  update();
  return deck;
}

// ---------------------------------------------------------------------------
// Strategy panel — the numbers, given room to breathe
// ---------------------------------------------------------------------------

function makeStrategyPanel(race, c) {
  const posEl = h('span', { class: 'p' });
  const callEl = h('div', { class: 'call' });
  const grid = h('div', { class: 'stratgrid' });
  const tyreBar = h('i', {});
  const tyreNote = h('div', { class: 'tnote' });
  const lapWrap = h('div', { class: 'laps' });

  const el = h('div', { class: 'stratpanel' },
    h('div', { class: 'sp-hd' },
      h('i', { style: { background: c.team.colors.primary } }),
      h('b', {}, c.driver.name), posEl),
    callEl,
    h('div', { class: 'tyrebox' }, h('div', { class: 'meter' }, tyreBar), tyreNote),
    grid,
    h('div', { class: 'lapwrap' }, h('div', { class: 'sk' }, 'RECENT LAPS'), lapWrap));

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
      grid.replaceChildren(); lapWrap.replaceChildren();
      tyreBar.style.width = '0%'; tyreNote.textContent = '';
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
        b.rejoin.justAhead ? `${b.rejoin.gap.toFixed(1)}s behind ${short(b.rejoin.justAhead.driver)}` : 'clear air'),
      cell('Undercut', b.undercut ? b.undercut.verdict.toUpperCase() : '—',
        b.undercut ? (b.undercut.verdict === 'on' ? 'good' : b.undercut.verdict === 'marginal' ? 'warn' : 'dim') : 'dim',
        b.undercut ? `${b.undercut.swing.toFixed(1)}s swing vs ${b.undercut.gapNow.toFixed(1)}s gap` : 'leading'),
      cell('Fuel', `${b.fuel.margin >= 0 ? '+' : ''}${b.fuel.margin.toFixed(1)}`,
        b.fuel.short ? 'bad' : 'good', `laps ${b.fuel.short ? 'short' : 'spare'}`),
      cell('Push', `+${b.push.gain.toFixed(2)}s`, 'good', `costs ${b.push.lifeCostPush.toFixed(1)} laps of tyre`),
      cell('Save', `−${b.push.save.toFixed(2)}s`, 'warn', `gains ${b.push.lifeGainSave.toFixed(1)} laps of tyre`),
      cell('Risk', pct(b.push.riskPush, 1), b.push.riskPush > 0.02 ? 'bad' : '', 'a mistake, per lap pushing'),
    );

    const laps = c.laps.slice(-8);
    const ref = race.fastestLap ? race.fastestLap.time : Math.min(...laps, 999);
    lapWrap.replaceChildren(...(laps.length
      ? laps.map((t) => h('div', { class: 'lapchip' },
        h('span', { class: 'lt' }, lapTime(t)),
        h('span', { class: `ld ${t - ref < 0.35 ? 'good' : t - ref > 1.6 ? 'bad' : ''}` },
          `+${(t - ref).toFixed(2)}`)))
      : [h('span', { class: 'dim' }, 'no laps yet')]));
  }

  update();
  return { el, update };
}
