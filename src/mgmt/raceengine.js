/**
 * APEX: Principal — the race.
 *
 * A time-stepped simulation of twenty cars on one circuit. Every car's speed
 * comes from the lap solver, so a front wing that gained 0.08 s in the wind
 * tunnel gains 0.08 s here, at this circuit, on this fuel load, on these tyres.
 *
 * The pit wall can change four things — when to stop, what to fit, how hard to
 * drive, and how to use the energy store. Everything else is the driver's, and
 * the driver is a person: he makes mistakes, he gets it wrong under pressure,
 * and when you tell him to slow down while he is racing someone for fourth, he
 * may simply decline.
 */

import { TYRE_COMPOUNDS } from '../data/teams.js';
import { racingLine as racingLineFor } from './track.js';
import { lapModel, phaseMap } from './laptime.js';
import { toPhysics } from './carspec.js';
import { driverPace, driverWearFactor, complianceChance, REFUSAL_LINES } from './personnel.js';
import { pitStopTime } from './facilities.js';

export const MODES = ['push', 'neutral', 'conserve', 'hold'];
export const ERS_MODES = ['harvest', 'balanced', 'deploy'];

const DRY_COMPOUNDS = ['soft', 'medium', 'hard'];
const WET_COMPOUNDS = ['inter', 'wet'];

// ---------------------------------------------------------------------------
// Tyres
// ---------------------------------------------------------------------------

/**
 * Grip multiplier for a tyre, from its compound, how worn it is, and how much
 * water is on the track. A slick on a wet track is not slightly slower; it is
 * undriveable, and that is what makes a wrong call at the first spot of rain
 * cost a race.
 */
export function tyreGrip(compound, wear, wetness) {
  const c = TYRE_COMPOUNDS[compound];
  if (!c) return 1;
  let g = c.grip;

  // Wear: gentle, then a cliff once the tyre is done.
  if (wear <= 0.75) g *= 1 - wear * 0.033;
  else if (wear <= 1.0) g *= 0.97525 - (wear - 0.75) * 0.30;
  else g *= Math.max(0.74, 0.90 - (wear - 1.0) * 0.55);

  // Water.
  if (WET_COMPOUNDS.includes(compound)) {
    const ideal = (c.minWet + c.maxWet) / 2;
    const off = Math.abs(wetness - ideal);
    // A wet tyre on a drying track overheats and goes off very quickly.
    g *= wetness < c.minWet ? Math.max(0.58, 1 - (c.minWet - wetness) * 1.35)
       : 1 - off * 0.22;
  } else {
    // Slicks. Below about 12% water a dry line is forming and they are still
    // the right tyre; past that they fall away hard.
    g *= wetness <= 0.10 ? 1 : Math.max(0.40, 1 - (wetness - 0.10) * 1.15);
  }
  return Math.max(0.35, g);
}

/** Wear added per lap. */
function wearPerLap(compound, phys, driver, ctx, abrasion) {
  const c = TYRE_COMPOUNDS[compound] || TYRE_COMPOUNDS.medium;
  const base = 0.052 * abrasion;
  return base * c.wearRate * phys.wearRate * driverWearFactor(driver, ctx)
    * (1 + (ctx.wetness ?? 0) * -0.35);          // a wet track is gentle on tyres
}

/** Which compounds make sense right now. */
export function sensibleCompounds(wetness) {
  if (wetness > 0.55) return ['wet', 'inter'];
  if (wetness > 0.18) return ['inter', 'wet', 'medium'];
  if (wetness > 0.08) return ['inter', 'soft', 'medium'];
  return DRY_COMPOUNDS;
}

// ---------------------------------------------------------------------------
// The weekend
// ---------------------------------------------------------------------------

/**
 * @param opts.track    from mgmt/track.js
 * @param opts.round    from mgmt/calendar.js
 * @param opts.entries  [{ team, driver, spec, facilities, isPlayer }] × 20
 * @param opts.rng      seeded
 */
export function createWeekend(opts) {
  const { track, round, entries, rng } = opts;
  // When the pit wall is not being manned — the player chose to simulate, or
  // simply did not call a stop — the race engineer runs a sensible strategy
  // rather than leaving the car out on dead tyres for the whole afternoon.
  const autoStrategy = opts.autoStrategy !== false;
  const circuit = track.circuit;
  const totalLaps = round.laps;

  // Track abrasion: a rough, high-energy circuit eats tyres. Derived from how
  // much of the lap is spent at high lateral load.
  let load = 0;
  for (let i = 0; i < track.samples; i++) load += Math.min(0.02, Math.abs(track.curv[i]));
  const abrasion = 0.72 + (load / track.samples) * 46;

  // Pit lane geometry, straight out of the circuit definition.
  const pit = circuit.pit || { entry: 0.95, exit: 0.05, speedLimit: 22.2 };
  const pitSpan = ((pit.exit - pit.entry) % 1 + 1) % 1;
  const pitLaneLength = pitSpan * track.length + (pit.laneOffset ?? 15) * 2;
  const pitTransit = pitLaneLength / (pit.speedLimit || 22.2) + 3.4;

  const weather = {
    wetness: 0,
    rainIntensity: 0,
    airTemp: round.weather.air,
    trackTemp: round.weather.track,
    state: 'dry',
    forecast: [],
  };

  const race = {
    track, circuit, round, rng,
    state: 'setup',            // setup | practice | qualifying | grid | racing | finished
    lapsTotal: totalLaps,
    time: 0,
    lap: 0,
    cars: [],
    weather,
    abrasion,
    pitTransit,
    pit,
    safetyCar: null,           // {kind:'sc'|'vsc', lapsLeft}
    feed: [],                  // radio + commentary, newest last
    fx: [],                    // visual effects the renderer drains: smoke, dust
    results: null,
    fastestLap: null,
    retirements: 0,
    autoStrategy,
  };

  // Lap phase <-> place on the circuit. Filled in once the first car has been
  // solved; see `posOf` below for what it is for.
  let MAP = null;

  // ---- build the cars ----------------------------------------------------
  const fuelPerLap = 0.335 * (track.length / 1000);
  for (const e of entries) {
    const phys = toPhysics(e.spec);
    const model = lapModel(track, phys, {
      fuelKg: fuelPerLap * totalLaps * 0.5, tyreGrip: 1, wet: 0,
    });
    race.cars.push({
      id: `${e.team.id}-${e.driver.num}`,
      team: e.team,
      driver: e.driver,
      isPlayer: !!e.isPlayer,
      spec: e.spec,
      phys,
      model,
      facilities: e.facilities,

      // race state
      u: 0,                    // lap fraction 0..1
      lap: 0,
      distance: 0,             // metres since the start
      raceTime: 0,
      status: 'ready',         // ready | running | pit | retired | finished
      retireReason: null,

      tyre: 'medium',
      tyreAge: 0,
      wear: 0,
      fuel: fuelPerLap * totalLaps * 1.055,
      mode: 'neutral',
      ersMode: 'balanced',
      orderedMode: null,
      damage: 0,

      // Who is running this car's strategy. Two cars is too much to hand-fly,
      // so one of yours can be left to its own race engineer while you still
      // keep the ability to override any call at any moment.
      strategyMode: 'auto',
      overrideUntilLap: -1,
      ersCharge: 0.72,
      speed: 0,
      sectors: [null, null, null],
      lastSectors: [null, null, null],
      bestSectors: [null, null, null],
      _lapStart: 0,
      _sectorMark: 0,

      gridPos: 0,
      position: 0,
      lastLapTime: 0,
      bestLap: null,
      laps: [],
      stops: 0,
      stintStart: 0,
      pitRequested: null,      // compound to fit
      pitRemaining: 0,
      pitFrom: 0,
      penalty: 0,
      incidentTimer: 0,        // seconds of time loss still being paid
      dirtyAir: 0,
      drs: false,
      battleCooldown: 0,
      // Where the car sits across the track, in metres from the centreline.
      // This is simulation state, not a rendering flourish: an overtake IS a
      // change of line, and it has to happen over seconds like a real one.
      lateral: 0,
      // A driver's own small bias off the ideal line, so twenty cars are not
      // one car drawn twenty times.
      lineBias: rng.normal(0, 0.30),
      duel: null,
      interval: 0,
      gapToLeader: 0,
      defiance: 0,             // how long he is ignoring the pit wall for
      quali: null,
    });
  }

  // One phase map for the whole field, from the first car's solved profile.
  MAP = phaseMap(track.length, race.cars[0].model.speeds);


  // ---- helpers -----------------------------------------------------------

  /** Who a message is from, derived from what kind of message it is. */
  const SPEAKER = {
    refusal: 'driver', order: 'engineer', team: 'engineer',
    flag: 'control', penalty: 'control',
    pit: 'pitlane',
    weather: 'control', crash: 'commentary', incident: 'commentary',
    failure: 'commentary', overtake: 'commentary', race: 'commentary', quali: 'commentary',
  };
  const PRIORITY = {
    crash: 'high', failure: 'high', flag: 'high', refusal: 'high',
    weather: 'high', order: 'normal', pit: 'normal', incident: 'normal',
    race: 'high', quali: 'normal', overtake: 'low', team: 'normal',
  };

  function say(text, opts = {}) {
    race.feed.push({
      from: opts.from || SPEAKER[opts.kind] || 'commentary',
      priority: opts.priority || PRIORITY[opts.kind] || 'low',
      // Lap numbers are one-based for a reader: the opening lap is lap 1, not
      // lap 0, even though the leader has completed none.
      lap: race.state === 'racing' ? Math.min(totalLaps, race.lap + 1) : race.lap,
      time: race.time, text,
      kind: opts.kind || 'info',
      car: opts.car || null,
      player: !!opts.player,
    });
    if (race.feed.length > 400) race.feed.splice(0, race.feed.length - 400);
  }
  race.say = say;

  /**
   * Ask the view for smoke or dust at a car. The simulation does not know
   * whether anything is drawing it, so this is a queue the renderer drains and
   * a headless run simply ignores.
   */
  function fx(car, kind, count) {
    race.fx.push({ car: car.id, kind, count });
    if (race.fx.length > 60) race.fx.splice(0, race.fx.length - 60);
  }

  /**
   * A line from the pit wall's own engineer — strategy advice rather than
   * narration. Driven from the race screen, which owns the strategy module.
   */
  race.pushRadio = (from, text, priority, carId) => {
    say(text, { kind: 'brief', from, priority, car: carId, player: true });
  };

  function running() { return race.cars.filter((c) => c.status === 'running' || c.status === 'pit'); }

  /** Current lap time for a car in seconds, at this instant. */
  function currentLapTime(c) {
    const grip = tyreGrip(c.tyre, c.wear, weather.wetness);
    const ctx = {
      mode: c.mode,
      wet: weather.wetness,
      dirtyAir: c.dirtyAir,
      fuelSave: c.fuelSave ?? 0,
    };
    const pace = driverPace(c.driver, ctx);
    let t = c.model.at(c.fuel, grip * (1 - c.damage * 0.22));

    // `pace` is expressed as a fraction of the car's grip the driver actually
    // uses. Converting it to time through this circuit's own measured grip
    // sensitivity is what keeps a driver worth the same tenths here as the lap
    // solver says he is — rather than a flat percentage, which would make the
    // field three times too spread out.
    t -= (pace - 1) * c.model.perGripLoss;

    // Energy management: deploying more makes you faster now and slower later.
    if (c.ersMode === 'deploy' && c.ersCharge > 0.02) t -= 0.16;
    else if (c.ersMode === 'harvest') t += 0.22;

    if (race.safetyCar) t *= race.safetyCar.kind === 'sc' ? 1.62 : 1.34;
    return t;
  }
  race.currentLapTime = currentLapTime;

  /**
   * Speed right now, in m/s: the solved speed at this point of the lap, scaled
   * by how far off the reference lap the car currently is. Real physics at a
   * real place on the circuit, not a lap average.
   */
  function currentSpeed(c) {
    const prof = c.model.speeds;
    if (!prof || !prof.length) return track.length / Math.max(50, currentLapTime(c));
    const f = posOf(c);
    const v = prof[Math.min(prof.length - 1, Math.floor(f * prof.length))];
    if (c.status === 'pit') return pit.speedLimit || 22.2;
    const scale = c.model.base / Math.max(1, currentLapTime(c));
    return v * scale;
  }
  race.currentSpeed = currentSpeed;

  /**
   * `c.u` is lap PHASE — the fraction of the lap's time the car has used, which
   * is what advancing by `dt / lapTime` produces. It is the right quantity for
   * gaps and for the order, and the wrong one for a position: a car spends far
   * more time per metre in a hairpin than on the straight. `posOf` maps phase
   * through the solved speed profile to the fraction of the lap's LENGTH, which
   * is what the circuit's geometry — corners, kerbs, DRS zones, the pit entry —
   * is indexed by, and what the view draws. `phaseOf` is the inverse.
   *
   * The map is built once, from one car, and every car on the circuit uses it.
   * See `phaseMap`: per-car maps disagree by enough to put two cars in the same
   * piece of road.
   */
  function posOf(c, phase) {
    const p = phase == null ? (c ? c.u : 0) : phase;
    return MAP ? MAP.lapPos(p) : ((p % 1) + 1) % 1;
  }
  function phaseOf(c, dist) {
    return MAP ? MAP.lapPhase(dist) : ((dist % 1) + 1) % 1;
  }
  race.posOf = posOf;
  race.phaseOf = phaseOf;
  /** For the view, which has no car to ask. */
  race.lapPos = (phase) => posOf(null, phase);

  /** Gap in seconds to the car behind, or null if last. */
  race.gapBehind = (c) => {
    const order = race.order || updateOrder();
    const behind = order[order.indexOf(c) + 1];
    if (!behind || behind.status === 'retired') return null;
    return behind.interval;
  };

  /** Sort and assign running order; compute intervals. */
  function updateOrder() {
    const order = race.cars.slice().sort(compareCars);
    for (let i = 0; i < order.length; i++) {
      order[i].position = i + 1;
      if (i === 0) { order[i].interval = 0; order[i].gapToLeader = 0; continue; }
      const ahead = order[i - 1];
      const speed = track.length / Math.max(40, order[i].lastLapTime || order[i].model.base);
      order[i].interval = Math.max(0, (ahead.distance - order[i].distance) / speed);
      order[i].gapToLeader = Math.max(0, (order[0].distance - order[i].distance) / speed);
    }
    race.order = order;
    return order;
  }
  race.updateOrder = updateOrder;

  // ---- weather -----------------------------------------------------------

  function initWeather() {
    const w = round.weather;
    const willRain = rng.chance(w.rain);
    weather.forecast = [];
    if (willRain) {
      const start = rng.range(0.05, 0.75);
      const len = rng.range(0.18, 0.55);
      weather._rain = { start, end: Math.min(1.05, start + len), peak: w.severity * rng.range(0.55, 1.0) };
      // The forecast the player sees is deliberately imprecise.
      const err = rng.range(-0.08, 0.08);
      weather.forecast.push({
        at: Math.max(0, start + err),
        text: `Rain expected around lap ${Math.max(1, Math.round((start + err) * totalLaps))}`,
        confidence: rng.range(0.55, 0.92),
      });
    } else {
      weather._rain = null;
      weather.forecast.push({ at: 1, text: 'Dry throughout. Low chance of rain.', confidence: rng.range(0.7, 0.95) });
    }
  }

  function updateWeather(rate = 1) {
    const leader = race.order ? race.order.find((c) => c.status === 'running' || c.status === 'pit') : null;
    const f = ((leader ? leader.lap + leader.u : race.lap)) / Math.max(1, totalLaps);
    const r = weather._rain;
    let target = 0;
    if (r && f >= r.start && f <= r.end) {
      const span = Math.max(0.01, r.end - r.start);
      const phase = (f - r.start) / span;
      // Arrives quickly, clears slowly.
      target = r.peak * Math.sin(Math.min(1, Math.pow(phase, 0.65)) * Math.PI);
    }
    const prev = weather.wetness;
    weather.wetness += (target - weather.wetness) * Math.min(0.9, 0.22 * rate);
    weather.rainIntensity = Math.max(0, target);
    const state = weather.wetness > 0.5 ? 'wet' : weather.wetness > 0.14 ? 'damp' : 'dry';
    if (state !== weather.state) {
      weather.state = state;
      if (state === 'damp' && prev < weather.wetness) say('Spots of rain being reported around the circuit.', { kind: 'weather' });
      else if (state === 'wet') say('It is raining properly now. Standing water off the racing line.', { kind: 'weather' });
      else if (state === 'dry') say('The track is drying. A dry line is appearing.', { kind: 'weather' });
    }
    weather.trackTemp = round.weather.track - weather.wetness * 12;
  }

  // ---- practice ----------------------------------------------------------

  /**
   * Practice does not set a grid; it buys understanding. Investment converts
   * into a small, permanent setup gain for the weekend, scaled by the race
   * engineer and the simulator.
   */
  race.runPractice = (playerInvestment = 0) => {
    race.state = 'practice';
    for (const c of race.cars) {
      let quality;
      if (c.isPlayer) {
        const eng = c.team.staff?.race?.rating ?? 0.7;
        const sim = (c.facilities?.simulator ?? 1) - 1;
        quality = (0.35 + playerInvestment * 0.65) * (0.7 + eng * 0.55) * (1 + sim * 0.06);
      } else {
        quality = (0.5 + rng.range(0, 0.5)) * (c.team.competence ?? 0.9);
      }
      // A good weekend of setup work is worth around three tenths.
      c.setupGain = Math.max(0, Math.min(0.42, rng.normal(quality * 0.26, 0.06)));
      c.model.base -= c.setupGain;
    }
    const p = race.cars.find((x) => x.isPlayer);
    if (p) say(`Practice complete. Setup work found ${p.setupGain.toFixed(3)}s a lap.`, { kind: 'team', player: true });
    return race.cars.map((c) => ({ id: c.id, gain: c.setupGain }));
  };

  // ---- qualifying --------------------------------------------------------

  function qualiLap(c, pressure) {
    const grip = tyreGrip(weather.wetness > 0.2 ? (weather.wetness > 0.55 ? 'wet' : 'inter') : 'soft', 0.06, weather.wetness);
    const pace = driverPace(c.driver, { mode: 'push', wet: weather.wetness, dirtyAir: 0 });
    let t = c.model.at(8, grip) / Math.max(0.9, pace);
    // A qualifying lap is one lap: consistency matters more here than anywhere.
    t += Math.abs(rng.normal(0, 0.09 + (1 - (c.driver.consistency ?? 0.88)) * 0.62));
    // And it can simply go wrong.
    const bin = (1 - (c.driver.consistency ?? 0.88)) * 0.55 * (1 + weather.wetness * 1.4) * pressure;
    if (rng.chance(bin)) {
      t += rng.range(0.35, 1.9);
      if (c.isPlayer) say(`${c.driver.name} ran wide at the final corner — lap compromised.`, { kind: 'incident', car: c.id, player: true });
    }
    return t;
  }

  race.runQualifying = () => {
    race.state = 'qualifying';
    updateWeather();
    let pool = race.cars.slice();
    const tail = [];            // groups of eliminated cars, fastest group last
    const segments = [
      { name: 'Q1', keep: 15, pressure: 0.85 },
      { name: 'Q2', keep: 10, pressure: 1.0 },
      { name: 'Q3', keep: 0, pressure: 1.25 },
    ];
    for (const seg of segments) {
      const times = pool.map((c) => ({ c, t: qualiLap(c, seg.pressure) }));
      times.sort((a, b) => a.t - b.t);
      for (const x of times) x.c.quali = x.t;
      if (seg.keep > 0 && times.length > seg.keep) {
        tail.unshift(times.slice(seg.keep).map((x) => x.c));
        pool = times.slice(0, seg.keep).map((x) => x.c);
      } else {
        tail.unshift(times.map((x) => x.c));
        pool = [];
      }
    }
    const grid = tail.flat();
    for (let i = 0; i < grid.length; i++) {
      grid[i].gridPos = i + 1;
      grid[i].position = i + 1;
    }
    const pole = grid[0];
    say(`${pole.driver.name} takes pole for ${pole.team.name}, ${fmtLap(pole.quali)}.`, { kind: 'quali' });
    race.grid = grid;
    return grid;
  };

  // ---- race --------------------------------------------------------------

  race.startRace = (playerTyres = {}) => {
    race.state = 'grid';
    const grid = race.grid || race.cars.slice();
    const openers = sensibleCompounds(weather.wetness);
    for (const c of grid) {
      c.status = 'running';
      c.lap = 0;
      c._lapStart = 0;
      c._sectorMark = 0;
      c.ersCharge = 0.72;
      // The grid sits just past the timing line, pole furthest up the road.
      // Every car then completes the same number of line crossings, so the
      // eight metres a slot is a real advantage and nothing else moves.
      c.u = phaseOf(c, (grid.length - c.gridPos) * (8 / track.length));
      c.prevU = c.u;
      // The grid is two-by-two, staggered across the track, and they hold
      // those two columns until the launch has been paid out — which is what
      // lets a good getaway stream past the car in front instead of queueing
      // behind it.
      c._gridSide = c.gridPos % 2 === 1 ? -1 : 1;
      c.lateral = c._gridSide * 2.4;
      c._launch = 0;
      c.duel = null; c.defending = 0;
      c.distance = c.u * track.length;
      c.tyre = c.isPlayer && playerTyres[c.id] ? playerTyres[c.id] : pickStartTyre(c, openers);
      c.wear = 0; c.tyreAge = 0; c.stintStart = 0;
      c.raceTime = 0;
    }
    // Two cars is a lot to hand-fly. By default the better-placed of yours is
    // yours to call and the other runs on its own race engineer, which you can
    // swap either way at any point.
    const yours = grid.filter((c) => c.isPlayer);
    yours.forEach((c, i) => {
      c.strategyMode = i === 0 ? 'manual' : 'auto';
      c.overrideUntilLap = i === 0 ? 1e9 : 0;
    });

    race.state = 'racing';
    race.time = 0;
    race.lap = 0;
    say(`Lights out at ${circuit.name}. ${totalLaps} laps.`, { kind: 'race' });
    // The start itself: a place where aggression and a good launch matter.
    resolveStart(grid);
    enforceSpacing();
    updateOrder();
    return grid;
  };

  function pickStartTyre(c, openers) {
    if (weather.wetness > 0.5) return 'wet';
    if (weather.wetness > 0.16) return 'inter';
    // A one-stopper on the harder tyre, or a soft start for track position.
    const wantsTrackPosition = (c.gridPos <= 6 && rng.chance(0.55)) || rng.chance(0.2);
    return wantsTrackPosition ? 'soft' : rng.chance(0.62) ? 'medium' : 'hard';
  }

  function resolveStart(grid) {
    const quality = new Map();
    for (const c of grid) {
      quality.set(c, rng.normal(0, 1)
        + (c.driver.aggression ?? 0.75) * 0.9
        + (c.driver.skill ?? 0.85) * 0.7
        - weather.wetness * 0.5);
    }
    const sorted = grid.slice().sort((a, b) => quality.get(b) - quality.get(a));
    // Convert launch quality into a few metres either way, which the normal
    // running order then resolves into actual places. It has to move `u`:
    // `distance` is recomputed from `u` on every step.
    for (const c of grid) {
      // Clamped: a start is worth a few car lengths, not half the grid. How
      // many places that turns into is decided by the running order, so the
      // radio does not claim a number that has not happened yet.
      //
      // And it is PAID OUT over the first few seconds rather than applied at
      // the lights. Applied at once it was a teleport of up to twenty metres —
      // two and a half grid slots — which is how a car that qualified fifth
      // ended up leading, inside the car that qualified on pole, before anyone
      // had moved.
      const gain = Math.max(-6, Math.min(6, (sorted.indexOf(c) - grid.indexOf(c)) * -1));
      c._launch = gain * 3.4;              // metres still owed, either way
      if (gain >= 4 && c.isPlayer) say(`Blinding launch from ${c.driver.name} — he is all over the car in front already.`, { kind: 'race', car: c.id, player: true });
      else if (gain <= -4 && c.isPlayer) say(`Poor getaway for ${c.driver.name}. He is swamped off the line.`, { kind: 'race', car: c.id, player: true });
    }
    // First-lap contact.
    if (rng.chance(0.16 + weather.wetness * 0.30)) {
      const victims = rng.shuffle(grid.slice(4)).slice(0, rng.int(1, 2));
      for (const v of victims) {
        const heavy = rng.chance(0.35);
        if (heavy) {
          retire(v, 'accident damage');
          say(`Contact at turn one — ${v.driver.name} is out on the spot.`, { kind: 'incident', car: v.id, player: v.isPlayer });
        } else {
          v.damage = Math.min(1, v.damage + rng.range(0.12, 0.34));
          v.incidentTimer += rng.range(3, 9);
          say(`${v.driver.name} is tagged at the first corner and drops back with damage.`, { kind: 'incident', car: v.id, player: v.isPlayer });
        }
      }
      if (rng.chance(0.45)) deploySafetyCar(rng.chance(0.5) ? 'vsc' : 'sc', 'first-lap contact');
    }
  }

  function retire(c, reason) {
    if (c.status === 'retired' || c.status === 'finished') return;
    c.duel = null; c.defending = 0;
    c.status = 'retired';
    c.retireReason = reason;
    race.retirements++;
    if (c.team) c.team.seasonRetirements = (c.team.seasonRetirements ?? 0) + 1;
  }
  race.retire = retire;

  function deploySafetyCar(kind, why) {
    if (race.safetyCar) return;
    race.safetyCar = { kind, lapsLeft: kind === 'sc' ? rng.int(3, 5) : rng.int(2, 3), why };
    say(kind === 'sc'
      ? `Safety car deployed — ${why}.`
      : `Virtual safety car — ${why}.`, { kind: 'flag' });
    if (kind === 'sc') {
      // Bunch the field up behind the leader.
      const order = updateOrder().filter((c) => c.status === 'running');
      for (let i = 0; i < order.length; i++) {
        order[i].distance = order[0].distance - i * 22;
      }
    }
  }
  race.deploySafetyCar = deploySafetyCar;

  // ---- where a car sits across the track ---------------------------------

  const trackAt = (u) => {
    const f = ((u % 1) + 1) % 1;
    return Math.min(track.samples - 1, Math.floor(f * track.samples));
  };

  /** The line a car would take if nobody else were on the circuit. */
  const LINE = racingLineFor(track);
  function racingLine(u) { return LINE[trackAt(u)]; }

  /**
   * Move the car across the track. Cars do not jump sideways, so the lateral
   * position is integrated at a real rate — about four metres a second, which
   * is roughly how long a switch of line actually takes.
   */
  function updateLateral(c, dt) {
    const p = posOf(c);
    const i = trackAt(p);
    const w = track.width[i];
    let target;

    if (c.status === 'pit') {
      target = (pit.side === 'right' ? 1 : -1) * (w + 9);
    } else if (c.duel) {
      // Alongside: far enough over to be a second car abreast, and eased in
      // and out so the move reads as a move.
      const shape = Math.sin(Math.PI * Math.min(1, c.duel.t / c.duel.dur));
      target = racingLine(p) + c.duel.side * Math.min(w * 0.62, 3.1) * Math.max(0.35, shape);
    } else if (c._launch) {
      target = (c._gridSide || 1) * Math.min(w * 0.44, 2.6);
    } else if (c.defending) {
      target = racingLine(p) + c.defending * Math.min(w * 0.45, 2.1);
    } else {
      // Twenty cars on one ideal line is a train, not a race. Each driver has
      // his own small bias, and a car sitting in someone's wake edges out of it
      // towards wherever the next corner is going to want him.
      target = racingLine(p) + c.lineBias;
      if (c.dirtyAir > 0.3) {
        const nextK = track.curv[trackAt(p + 0.012)];
        const side = Math.abs(nextK) > 0.002 ? (nextK > 0 ? -1 : 1) : (c.lineBias >= 0 ? 1 : -1);
        target += side * Math.min(w * 0.30, 1.5) * Math.min(1, (c.dirtyAir - 0.3) * 2.2);
      }
    }
    target = Math.max(-w + 1.1, Math.min(w - 1.1, target));

    // How fast a car can change line is a function of how fast it is going: a
    // fixed rate either slides at 60km/h or cannot make the turn-in at 280.
    // A tenth of forward speed is about six degrees of yaw, which is right.
    const rate = Math.max(2.5, Math.min(9, (c.speed || 60) * 0.10)) * dt;
    const d = target - c.lateral;
    c.lateral += Math.abs(d) < rate ? d : Math.sign(d) * rate;
  }

  /**
   * Cars cannot drive through each other.
   *
   * The simulation resolves an overtake as a manoeuvre, which takes seconds —
   * so between deciding and completing one, a faster car is closing on a slower
   * one and nothing stopped it ending up inside the bodywork. Holding it a car's
   * length back is not a cosmetic fix: queueing behind somebody you cannot pass
   * is most of what a race actually is, and the dirty-air penalty that goes with
   * it is already in the lap time.
   *
   * Two cars side by side are not stacked, so the limit relaxes as soon as they
   * are more than a car's width apart across the road — which is what lets the
   * grid line up in staggered rows eight metres apart, and what lets a move
   * happen at all.
   */
  function enforceSpacing() {
    const list = race.cars.filter((c) => c.status === 'running');
    list.sort((a, b) => b.distance - a.distance);
    for (let i = 1; i < list.length; i++) {
      const ahead = list[i - 1], c = list[i];
      if (c.duel || ahead.duel) continue;                 // alongside, or going by
      const pa = ahead.lap + posOf(ahead);
      const pc = c.lap + posOf(c);
      const gap = (pa - pc) * track.length;
      if (gap > 12 || gap < 0) continue;
      const need = Math.abs(ahead.lateral - c.lateral) > 2.6 ? 2.2 : 7.0;
      if (gap >= need) continue;
      // Hold him back, but never push him across the timing line backwards.
      const back = (need - gap) / track.length;
      const pos = posOf(c) - back;
      if (pos <= 0.0008) continue;
      c.u = phaseOf(c, pos);
      c.distance = c.lap * track.length + c.u * track.length;
    }
  }

  // ---- incidents ---------------------------------------------------------

  /**
   * A driver mistake. The user asked for drivers who are not machines: they
   * lock up, they run wide, they spin, and occasionally they put it in the
   * wall. How often depends on consistency, how hard they are being asked to
   * push, how worn the tyres are, how wet it is and whether somebody is
   * climbing all over the back of them.
   */
  function rollMistake(c, dtLaps) {
    if (c.status !== 'running' || race.safetyCar) return;
    const cons = c.driver.consistency ?? 0.88;
    let p = 0.065 * (1 - cons);
    if (c.mode === 'push') p *= 1.55;
    else if (c.mode === 'conserve') p *= 0.72;
    p *= 1 + weather.wetness * 1.9;
    p *= 1 + Math.max(0, c.wear - 0.7) * 1.4;
    p *= 1 + (c.dirtyAir > 0.3 ? 0.38 : 0);
    p *= 1 + c.damage * 0.7;
    p *= 1 + (c.defiance > 0 ? 0.25 : 0);       // driving on emotion
    if (c.lap < 2) p *= 1.4;

    if (!rng.chance(p * dtLaps)) return;

    const roll = rng();
    if (roll < 0.60) {
      const loss = rng.range(0.25, 1.1);
      c.incidentTimer += loss;
      c.wear += 0.012;
      fx(c, 'smoke', 6);
      say(`${c.driver.name} locks up into the braking zone — loses ${loss.toFixed(1)}s.`, { kind: 'incident', car: c.id, player: c.isPlayer });
    } else if (roll < 0.83) {
      const loss = rng.range(1.6, 4.2);
      c.incidentTimer += loss;
      c.wear += 0.03;
      fx(c, 'dust', 12);
      say(`${c.driver.name} runs wide and goes through the gravel. ${loss.toFixed(1)}s gone.`, { kind: 'incident', car: c.id, player: c.isPlayer });
    } else if (roll < 0.94) {
      const loss = rng.range(7, 17);
      c.incidentTimer += loss;
      c.wear = Math.min(1.25, c.wear + rng.range(0.08, 0.18));
      fx(c, 'smoke', 14); fx(c, 'dust', 8);
      say(`${c.driver.name} has spun it. He keeps the engine running but that is a long way down the order.`, { kind: 'incident', car: c.id, player: c.isPlayer });
      if (rng.chance(0.20)) deploySafetyCar('vsc', `${c.driver.name} spun`);
    } else {
      // Into the wall.
      const survivable = rng.chance(0.30);
      if (survivable) {
        c.damage = Math.min(1, c.damage + rng.range(0.3, 0.6));
        c.incidentTimer += rng.range(12, 26);
        fx(c, 'dust', 16); fx(c, 'smoke', 10);
        say(`${c.driver.name} is into the barrier. He is crawling back to the pits with the front wing gone.`, { kind: 'crash', car: c.id, player: c.isPlayer });
      } else {
        fx(c, 'dust', 22); fx(c, 'smoke', 16);
        retire(c, 'accident');
        say(`Big one for ${c.driver.name} — he is out of the race. He is out of the car and he is fine.`, { kind: 'crash', car: c.id, player: c.isPlayer });
      }
      deploySafetyCar(rng.chance(0.6) ? 'sc' : 'vsc', `${c.driver.name} in the barriers`);
    }
  }

  function rollFailure(c, dtLaps) {
    if (c.status !== 'running') return;
    const perRace = c.phys.failureRate * (1 + c.damage * 1.6);
    const perLap = perRace / Math.max(1, totalLaps);
    if (!rng.chance(perLap * dtLaps)) return;
    const what = rng.pick(['power unit', 'gearbox', 'hydraulics', 'energy store', 'cooling', 'brake-by-wire']);
    retire(c, what);
    say(`${c.driver.name} is slowing — ${what} failure. That is his race over.`, { kind: 'failure', car: c.id, player: c.isPlayer });
    if (rng.chance(0.25)) deploySafetyCar('vsc', 'a stopped car');
  }

  // ---- overtaking --------------------------------------------------------

  const drsZones = circuit.drsZones || [{ detect: 0.9, start: 0.93, end: 0.05 }];

  function inZone(u, z) {
    return z.start <= z.end ? (u >= z.start && u <= z.end) : (u >= z.start || u <= z.end);
  }

  function updateBattles(dt) {
    const order = race.order || updateOrder();
    for (let i = 1; i < order.length; i++) {
      const c = order[i], ahead = order[i - 1];
      if (c.status !== 'running' || ahead.status !== 'running') { c.dirtyAir = 0; c.drs = false; continue; }

      const gap = c.interval;
      c.dirtyAir = gap < 1.6 ? Math.min(1, (1.6 - gap) / 1.6) : 0;
      c.drs = !race.safetyCar && gap < 1.0 && drsZones.some((z) => inZone(posOf(c), z)) && weather.wetness < 0.3;

      if (c.battleCooldown > 0) { c.battleCooldown -= dt; continue; }
      if (race.safetyCar || gap > 0.9) continue;

      // An attempt is only resolved at the end of a DRS zone or a big braking
      // zone; this is checked once per pass through that point, not per tick.
      // On the opening lap every corner is an opportunity, because it is: the
      // field is bunched, nobody has clean air, and everyone is still on the
      // tyres and the fuel they started with.
      const firstLap = c.lap < 1;
      const atCorner = firstLap && Math.abs(track.curv[trackAt(posOf(c))]) > 0.004;
      const zone = drsZones.find((z) => inZone(posOf(c), z));
      if (!zone && !atCorner) { c._armed = true; continue; }
      if (!c._armed) continue;
      c._armed = false;

      const paceDelta = currentLapTime(ahead) - currentLapTime(c);   // + = attacker faster
      const tyreDelta = (tyreGrip(c.tyre, c.wear, weather.wetness) - tyreGrip(ahead.tyre, ahead.wear, weather.wetness)) * 14;
      const drsBonus = c.drs ? 0.50 : 0;
      const attack = (c.driver.aggression ?? 0.75) * 0.8 + (c.driver.skill ?? 0.85) * 0.6;
      const defend = (ahead.driver.skill ?? 0.85) * 0.75 + (ahead.driver.consistency ?? 0.88) * 0.35
        + (ahead.mode === 'hold' ? 0.22 : 0);

      // A car that is not actually faster does not get past. Without this a
      // train of evenly matched cars shuffles itself every lap and qualifying
      // stops meaning anything.
      if (paceDelta < -0.10 && !c.drs && !firstLap) { c.battleCooldown = 4; continue; }

      const score = paceDelta * 1.05 + tyreDelta * 0.42 + drsBonus + (attack - defend) * 0.75 + (0.9 - gap) * 0.55
        + (firstLap ? 0.26 : 0);
      // Overtaking an evenly matched car is genuinely hard. The offset is what
      // makes track position worth something and a pit call a real decision.
      const p = 1 / (1 + Math.exp(-score * 1.9)) - 0.45;

      // Which side he goes down: the inside of whatever is coming next.
      const nextK = track.curv[trackAt(posOf(c) + 0.02)];
      const side = Math.abs(nextK) > 0.002 ? (nextK > 0 ? -1 : 1) : (ahead.lateral > 0 ? -1 : 1);

      if (rng.chance(Math.max(0, p))) {
        // A pass is not a swap of positions. He comes out of the tow, pulls
        // alongside, and takes the place over the next few seconds — which is
        // both what happens in a race and the only way it looks like one.
        const dur = rng.range(2.6, 4.4);
        const gapM = Math.max(4, (ahead.distance - c.distance));
        c.duel = {
          targetId: ahead.id, side, outcome: 'pass', t: 0, dur,
          // Enough closing speed to complete the move inside `dur`, which is
          // what a slipstream plus DRS plus a late brake is actually worth.
          rate: (gapM + 13) / dur,
          announced: false,
        };
        ahead.defending = -side;
        ahead.battleCooldown = 2;
      } else {
        // He has a look, gets alongside, and cannot make it stick.
        const dur = rng.range(1.8, 3.0);
        c.duel = {
          targetId: ahead.id, side, outcome: 'fail', t: 0, dur,
          rate: Math.max(3, (ahead.distance - c.distance) * 0.55) / dur,
          announced: false,
        };
        ahead.defending = -side;
        c.incidentTimer += rng.range(0.15, 0.55);
        c.battleCooldown = 3;
        // A failed lunge from an aggressive driver sometimes ends in contact.
        const contactP = 0.012 + (c.driver.aggression ?? 0.75) * 0.022 + weather.wetness * 0.035;
        if (rng.chance(contactP)) {
          const hard = rng.chance(0.3);
          c.damage = Math.min(1, c.damage + (hard ? 0.4 : 0.14));
          ahead.damage = Math.min(1, ahead.damage + (hard ? 0.3 : 0.1));
          c.incidentTimer += hard ? rng.range(8, 18) : rng.range(1.5, 4);
          ahead.incidentTimer += hard ? rng.range(6, 15) : rng.range(1, 3);
          c.penalty += hard ? 5 : 0;
          say(`Contact! ${c.driver.name} into the back of ${ahead.driver.name}.${hard ? ' Both cars are damaged, and the stewards are looking at it.' : ''}`, {
            kind: 'incident', car: c.id, player: c.isPlayer || ahead.isPlayer,
          });
          if (hard && rng.chance(0.4)) deploySafetyCar('vsc', 'debris on the racing line');
        }
      }
    }
  }

  // ---- pit stops ---------------------------------------------------------

  function considerPit(c) {
    // A player car runs its own engineer unless YOU have taken it over, and
    // even then your explicit calls hold the engineer off for a few laps.
    if (c.isPlayer) {
      if (c.strategyMode !== 'auto' && !race.autoStrategy) return;
      if (c.lap < c.overrideUntilLap) return;
    }
    if (c.status !== 'running' || c.pitRequested) return;
    const lapsLeft = totalLaps - c.lap;
    if (lapsLeft < 4) return;

    const wet = weather.wetness;
    const onWets = WET_COMPOUNDS.includes(c.tyre);
    // Wrong tyre for the conditions is the only truly urgent call.
    if (wet > 0.30 && !onWets) { c.pitRequested = wet > 0.55 ? 'wet' : 'inter'; return; }
    if (wet < 0.10 && onWets && c.lap > 2) { c.pitRequested = 'medium'; return; }

    // Otherwise: stop when the tyre is done, a bit earlier under a safety car.
    const threshold = race.safetyCar ? 0.52 : 0.86;
    if (c.wear > threshold && lapsLeft > 6) {
      const opts = sensibleCompounds(wet).filter((x) => !WET_COMPOUNDS.includes(x) || wet > 0.15);
      // Fit something that can reach the flag. A tyre that needs another stop
      // it does not have time for is worse than a slower one that gets there.
      const pick = lapsLeft < 14 ? 'soft' : lapsLeft < 26 ? 'medium' : 'hard';
      c.pitRequested = opts.includes(pick) ? pick : opts[0];
    }
  }

  function enterPit(c) {
    c.duel = null; c.defending = 0;
    const crewRng = rng;
    const stop = pitStopTime(c.facilities || { pitcrew: 3 }, crewRng);
    c.status = 'pit';
    c.pitRemaining = pitTransit + stop.time + c.penalty;
    c.pitFrom = posOf(c);
    c._pitTotal = c.pitRemaining;
    c._newTyre = c.pitRequested;
    c._fumble = stop.fumble;
    if (c.penalty) { say(`${c.driver.name} serves his ${c.penalty}-second penalty.`, { kind: 'flag', car: c.id, player: c.isPlayer }); c.penalty = 0; }
    if (c.isPlayer && c.strategyMode === 'auto' && c.lap >= c.overrideUntilLap) {
      say(`Boxing ${c.driver.short || c.driver.name.split(' ').pop()} — my call. ${TYRE_COMPOUNDS[c._newTyre]?.name ?? c._newTyre} going on.`,
        { kind: 'brief', from: 'engineer', priority: 'normal', car: c.id, player: true });
    }
    if (stop.fumble) say(`Trouble in the pit box for ${c.driver.name} — that is a slow stop.`, { kind: 'pit', car: c.id, player: c.isPlayer });
    else say(`${c.driver.name} boxes for ${TYRE_COMPOUNDS[c.pitRequested]?.name ?? c.pitRequested}. ${stop.time.toFixed(1)}s stationary.`, { kind: 'pit', car: c.id, player: c.isPlayer });
    c.pitRequested = null;
  }

  function exitPit(c) {
    c.status = 'running';
    fx(c, 'smoke', 5);
    c.tyre = c._newTyre || 'medium';
    c.wear = 0;
    c.tyreAge = 0;
    c.stops++;
    c.stintStart = c.lap;
    c.u = phaseOf(c, pit.exit);
  }

  // ---- pit wall commands -------------------------------------------------

  /**
   * An instruction from the pit wall. It is a request, not a control input:
   * the driver decides whether to take it.
   */
  race.command = (carId, cmd, arg) => {
    const c = race.cars.find((x) => x.id === carId);
    if (!c || c.status === 'retired' || c.status === 'finished') return { ok: false };
    // You have spoken, so the engineer holds off on this car for a few laps.
    c.overrideUntilLap = c.lap + 3;

    if (cmd === 'ers') { c.ersMode = arg; return { ok: true, complied: true }; }

    if (cmd === 'pit') {
      if (c.pitRequested) return { ok: true, complied: true, redundant: true };
      if (c.defiance > 0) return { ok: true, complied: false, stillRefusing: true };
      const ctx = pitContext(c);
      if (rng.chance(complianceChance(c.driver, 'pit', ctx))) {
        c.pitRequested = arg || 'medium';
        say(`Box, box. ${TYRE_COMPOUNDS[c.pitRequested]?.name ?? c.pitRequested} ready.`, { kind: 'order', car: c.id, player: true });
        return { ok: true, complied: true };
      }
      c.defiance = 2;
      say(`${c.driver.name}: "${rng.pick(REFUSAL_LINES.pit)}"`, { kind: 'refusal', car: c.id, player: true });
      return { ok: true, complied: false };
    }

    if (cmd === 'mode') {
      // Telling a driver to do what he is already doing is not an instruction.
      if (c.orderedMode === arg && c.defiance <= 0) return { ok: true, complied: true, redundant: true };
      // While he is ignoring the pit wall he is ignoring the pit wall. Asking
      // again every second does not help, and it does not get a new answer.
      if (c.defiance > 0) return { ok: true, complied: false, stillRefusing: true };
      const order = arg === 'push' ? 'push' : arg === 'conserve' ? 'conserve' : arg === 'hold' ? 'hold' : 'push';
      const ctx = pitContext(c);
      const p = complianceChance(c.driver, order, ctx);
      if (rng.chance(p)) {
        c.mode = arg;
        c.orderedMode = arg;
        c.defiance = 0;
        say(orderText(c, arg), { kind: 'order', car: c.id, player: true });
        return { ok: true, complied: true };
      }
      // Refused. He keeps doing what he was doing, and for a while he stops
      // listening — which is its own problem.
      c.defiance = rng.range(2, 5);
      const lines = REFUSAL_LINES[order] || REFUSAL_LINES.hold;
      say(`${c.driver.name}: "${rng.pick(lines)}"`, { kind: 'refusal', car: c.id, player: true });
      c.driver.morale = Math.max(0.15, (c.driver.morale ?? 0.65) - 0.015);
      return { ok: true, complied: false };
    }
    return { ok: false };
  };

  function orderText(c, mode) {
    if (mode === 'push') return `${c.driver.name}, we are going to push now. Target plus two.`;
    if (mode === 'conserve') return `${c.driver.name}, manage the tyres. Target minus three.`;
    if (mode === 'hold') return `${c.driver.name}, hold position. Bring it home.`;
    return `${c.driver.name}, back to normal pace.`;
  }

  function pitContext(c) {
    const order = race.order || updateOrder();
    const idx = order.indexOf(c);
    const ahead = order[idx - 1], behind = order[idx + 1];
    const mate = race.cars.find((x) => x !== c && x.team.id === c.team.id);
    return {
      racePosition: c.position,
      lapsRemaining: totalLaps - c.lap,
      tyreWear: c.wear,
      fightingForPosition: (ahead && c.interval < 1.4) || (behind && behind.interval < 1.4),
      aheadOfTeammate: mate ? c.position < mate.position : false,
    };
  }

  /** Drivers who are not being managed drift back toward a sensible default. */
  function updateDriverIntent(c, dtLaps) {
    if (c.defiance > 0) c.defiance -= dtLaps;

    // A player car on its own engineer is managed exactly like a rival — and
    // it says what it is doing, so you can disagree in time.
    if (c.isPlayer && c.strategyMode === 'auto' && c.lap >= c.overrideUntilLap) {
      const lapsLeft = totalLaps - c.lap;
      const fuelShort = c.fuel < lapsLeft * fuelPerLap * 1.01;
      const want = fuelShort && lapsLeft > 2 ? 'conserve'
        : c.wear > 0.88 && lapsLeft > 5 ? 'conserve'
          : (lapsLeft < 8 || c.interval < 1.2) ? 'push' : 'neutral';
      if (want !== c.mode) {
        c.mode = want;
        c.orderedMode = want;
        say(`${c.driver.short || c.driver.name.split(' ').pop()} going to ${want}${fuelShort ? ' — fuel is tight' : c.wear > 0.88 ? ' — tyres are going' : ''}.`,
          { kind: 'brief', from: 'engineer', priority: 'low', car: c.id, player: true });
      }
      return;
    }

    if (!c.isPlayer) {
      // Rival drivers manage themselves: hard early if they can, careful when
      // the tyre is going, flat out at the end.
      const lapsLeft = totalLaps - c.lap;
      const fuelShort = c.fuel < lapsLeft * fuelPerLap * 1.01;
      if (fuelShort && lapsLeft > 2) c.mode = 'conserve';
      else if (c.wear > 0.88 && lapsLeft > 5) c.mode = 'conserve';
      else if (lapsLeft < 8 || c.interval < 1.2) c.mode = 'push';
      else c.mode = 'neutral';
      return;
    }

    // A player driver who has refused an order keeps doing his own thing until
    // the fight is over.
    if (c.defiance > 0) {
      c.mode = c.interval < 1.5 ? 'push' : c.mode;
      return;
    }
    if (c.orderedMode) c.mode = c.orderedMode;

    // Even a compliant driver has limits: nobody conserves on the last lap.
    if (totalLaps - c.lap < 2 && c.mode === 'conserve' && (c.driver.temperament ?? 0.4) > 0.35) {
      c.mode = 'neutral';
    }
  }

  // ---- fuel --------------------------------------------------------------

  function fuelBurn(c, dtLaps) {
    const mul = c.mode === 'push' ? 1.055 : c.mode === 'conserve' ? 0.935 : 1;
    const burn = fuelPerLap * mul * dtLaps;
    c.fuel = Math.max(0, c.fuel - burn);
    const lapsLeft = totalLaps - c.lap;
    const needed = lapsLeft * fuelPerLap;
    // Short on fuel: the driver has to lift and coast, and it costs real time.
    c.fuelSave = c.fuel < needed ? Math.min(1, (needed - c.fuel) / Math.max(0.5, needed * 0.25)) : 0;
    if (c.fuel <= 0.001 && c.lap < totalLaps - 1) retire(c, 'out of fuel');
  }

  // ---- the step ----------------------------------------------------------

  /** Advance the race by `dt` seconds of race time. */
  race.step = (dt) => {
    if (race.state !== 'racing') return;
    race.time += dt;

    // Remember where everyone was, so the renderer can draw the frames BETWEEN
    // simulation steps instead of snapping to each one. This is what the eye
    // reads as smooth motion.
    for (const c of race.cars) { c.prevU = c.u; c.prevLateral = c.lateral; c.prevStatus = c.status; }

    for (const c of race.cars) {
      if (c.status === 'retired' || c.status === 'finished') continue;

      if (c.status === 'pit') {
        c.pitRemaining -= dt;
        // Show the car creeping down the pit lane while it is in there.
        const done = 1 - Math.max(0, c.pitRemaining) / Math.max(0.01, c._pitTotal);
        const span = ((pit.exit - c.pitFrom) % 1 + 1) % 1;
        const np = (c.pitFrom + span * done) % 1;
        const nu = phaseOf(c, np);
        if (nu < c.u) c.lap++;             // crossed the line inside the pit lane
        c.u = nu;
        c.distance = c.lap * track.length + c.u * track.length;
        if (c.pitRemaining <= 0) exitPit(c);
        continue;
      }

      // Time paid to an incident is time not spent moving.
      if (c.incidentTimer > 0) {
        const paid = Math.min(dt, c.incidentTimer);
        c.incidentTimer -= paid;
        if (paid >= dt) continue;
      }

      const lapT = currentLapTime(c);
      const dLap = dt / lapT;

      // Energy store. Deploying spends it, harvesting rebuilds it, and running
      // it flat empties the store in a couple of laps — so 'deploy' is a
      // decision with a cost rather than a free button.
      const ersRate = c.ersMode === 'deploy' ? -0.46 : c.ersMode === 'harvest' ? 0.50 : 0.045;
      c.ersCharge = Math.max(0, Math.min(1, c.ersCharge + ersRate * dLap));
      if (c.ersCharge <= 0.001 && c.ersMode === 'deploy') {
        c.ersMode = 'balanced';
        if (c.isPlayer) say(`${c.driver.name} has run the battery flat — back to balanced.`, { kind: 'brief', from: 'engineer', priority: 'normal', car: c.id, player: true });
      }

      c.speed = currentSpeed(c);
      updateLateral(c, dt);
      updateDriverIntent(c, dLap);
      fuelBurn(c, dLap);
      c.wear += wearPerLap(c.tyre, c.phys, c.driver, {
        mode: c.mode, dirtyAir: c.dirtyAir, wetness: weather.wetness,
      }, abrasion) * dLap;
      c.tyreAge += dLap;
      rollMistake(c, dLap);
      rollFailure(c, dLap);
      if (c.status !== 'running') continue;

      const prevU = c.u;
      c.u += dLap;

      // The start: the launch is worth a few car lengths and they arrive over
      // the first seconds, so the places change while the cars are moving.
      if (c._launch) {
        const take = c._launch * (1 - Math.exp(-dt / 2.2));
        c._launch -= take;
        if (Math.abs(c._launch) < 0.05) c._launch = 0;
        c.u = phaseOf(c, Math.max(0, posOf(c) + take / track.length));

        // A launch that has run out of road is a move, not a queue. The
        // manoeuvre system already knows how to put one car alongside another,
        // so a good getaway uses it rather than driving through the man ahead.
        if (c._launch > 0.6 && !c.duel && c.battleCooldown <= 0) {
          const ord = race.order || race.cars;
          const ahead = ord[ord.indexOf(c) - 1];
          if (ahead && ahead.status === 'running' && !ahead.duel) {
            const gapM = (ahead.lap + posOf(ahead) - c.lap - posOf(c)) * track.length;
            if (gapM > 0 && gapM < 22) {
              const dur = rng.range(1.7, 2.9);
              c.duel = {
                targetId: ahead.id, side: c._gridSide || 1, outcome: 'pass',
                t: 0, dur, rate: (gapM + 9) / dur, announced: false,
              };
              ahead.battleCooldown = 1.6;
            }
          }
        }
      }

      // A move in progress: the attacker carries extra speed out of the tow,
      // eased in and out, so the places change while the cars are moving
      // rather than between one frame and the next.
      if (c.duel) {
        c.duel.t += dt;
        const phase = Math.min(1, c.duel.t / c.duel.dur);
        const shape = c.duel.outcome === 'pass'
          ? Math.sin(Math.PI * 0.5 * Math.min(1, phase * 1.15))   // push, then hold
          : Math.sin(Math.PI * phase);                             // out, and back
        c.u += (c.duel.rate * shape * dt) / track.length;
        if (c.duel.t >= c.duel.dur) {
          const target = race.cars.find((x) => x.id === c.duel.targetId);
          if (c.duel.outcome === 'pass' && target) {
            say(`${c.driver.name} goes around the outside of ${target.driver.name} and takes the place.`.replace('around the outside of', c.duel.side > 0 ? 'down the inside of' : 'around the outside of'), {
              kind: 'overtake', car: c.id, player: c.isPlayer || target.isPlayer,
            });
            target.defending = 0;
            c.battleCooldown = 6; target.battleCooldown = 4;
          } else if (target) {
            target.defending = 0;
          }
          c.duel = null;
        }
      }

      // Sector splits. The crossing point is interpolated inside the step so
      // the times are real rather than rounded to the simulation tick.
      // Sector lines are places on the circuit, not fractions of the lap time,
      // so the boundary is converted into this car's phase before it is tested.
      // Tested against phase directly, every sector came out as exactly a third
      // of the lap.
      const bounds = circuit.sectors || [0.333, 0.666];
      for (let sIdx = 0; sIdx < bounds.length; sIdx++) {
        const bnd = phaseOf(c, bounds[sIdx]);
        if (prevU < bnd && c.u >= bnd && c._sectorMark <= sIdx) {
          const frac = (bnd - prevU) / Math.max(1e-9, c.u - prevU);
          const at = race.time - dt + dt * frac;
          c.sectors[sIdx] = at - c._lapStart - (sIdx > 0 ? (c.sectors[0] ?? 0) : 0);
          c._sectorMark = sIdx + 1;
        }
      }

      // Pit entry.
      if (c.pitRequested && crossed(posOf(c, prevU), posOf(c), pit.entry)) {
        c.u = phaseOf(c, pit.entry);
        c.distance = c.lap * track.length + c.u * track.length;
        enterPit(c);
        continue;
      }

      if (c.u >= 1) {
        c.u -= 1;
        c.lap++;
        c.lastLapTime = lapT;
        c.laps.push(lapT);
        c.sectors[2] = Math.max(0, lapT - (c.sectors[0] ?? 0) - (c.sectors[1] ?? 0));
        c.lastSectors = c.sectors.slice();
        for (let i = 0; i < 3; i++) {
          if (c.lastSectors[i] != null && (c.bestSectors[i] == null || c.lastSectors[i] < c.bestSectors[i])) {
            c.bestSectors[i] = c.lastSectors[i];
          }
        }
        c.sectors = [null, null, null];
        c._sectorMark = 0;
        c._lapStart = race.time;
        if (!race.safetyCar && (c.bestLap == null || lapT < c.bestLap)) c.bestLap = lapT;
        if (!race.safetyCar && (!race.fastestLap || lapT < race.fastestLap.time)) {
          race.fastestLap = { time: lapT, car: c.id, driver: c.driver.name, lap: c.lap };
        }
        considerPit(c);
        if (c.lap >= totalLaps) {
          c.status = 'finished';
          c.raceTime = race.time;
          if (!race.winnerTime) {
            race.winnerTime = race.time;
            race.flagFallen = true;
          }
        }
      }
      c.distance = c.lap * track.length + c.u * track.length;
    }

    enforceSpacing();

    // Leader lap counter drives weather and the safety car.
    const order = updateOrder();
    const leader = order.find((c) => c.status === 'running' || c.status === 'pit');
    const newLap = leader ? leader.lap : race.lap;
    if (newLap !== race.lap) {
      race.lap = newLap;
      if (race.safetyCar) {
        race.safetyCar.lapsLeft--;
        if (race.safetyCar.lapsLeft <= 0) {
          say(race.safetyCar.kind === 'sc' ? 'Safety car in this lap — we go racing again.' : 'Virtual safety car ending.', { kind: 'flag' });
          race.safetyCar = null;
        }
      }
    }

    updateWeather(dt / 12);
    updateBattles(dt);

    // A car that genuinely jumped — into the pit lane, or recovered — must not
    // be interpolated across the gap; it would slide sideways across the
    // circuit. Anything under about a hundred metres is a real move and is
    // drawn as one.
    for (const c of race.cars) {
      if (c.prevU == null) { c.prevU = c.u; continue; }
      let d = c.u - c.prevU;
      d -= Math.round(d);
      if (Math.abs(d) * track.length > 110 || c.prevStatus !== c.status) { c.prevU = c.u; c.prevLateral = c.lateral; }
    }

    // Once the leader has taken the flag the rest get one more lap at most, as
    // they would in reality; nobody is left circulating on their own.
    if (race.flagFallen && race.time > race.winnerTime + 210) {
      for (const c of race.cars) {
        if (c.status === 'running' || c.status === 'pit') { c.status = 'finished'; c.raceTime = race.time + 1; }
      }
    }
    if (race.cars.every((c) => c.status === 'retired' || c.status === 'finished')) finish();
  };

  /**
   * Running order. Cars that have taken the flag are ranked by WHEN they took
   * it — every one of them has covered the same distance, so distance cannot
   * separate them and sorting by it scrambles the result.
   */
  function compareCars(a, b) {
    const af = a.status === 'finished' ? 1 : 0, bf = b.status === 'finished' ? 1 : 0;
    if (af !== bf) return bf - af;
    if (af && bf) return a.raceTime - b.raceTime;
    const ar = a.status === 'retired' ? 1 : 0, br = b.status === 'retired' ? 1 : 0;
    if (ar !== br) return ar - br;
    return b.distance - a.distance;
  }

  function crossed(a, b, point) {
    if (b >= 1) return (a <= point) || (b - 1 >= point);
    return a <= point && b >= point;
  }

  function finish() {
    race.state = 'finished';
    const order = race.cars.slice().sort(compareCars);
    race.results = order.map((c, i) => ({
      position: c.status === 'retired' ? null : i + 1,
      id: c.id, driver: c.driver, team: c.team, isPlayer: c.isPlayer,
      status: c.status, reason: c.retireReason,
      laps: c.lap, stops: c.stops, bestLap: c.bestLap,
      gridPos: c.gridPos, tyre: c.tyre,
      gained: c.gridPos ? c.gridPos - (i + 1) : 0,
    }));
    const w = race.results.find((r) => r.position === 1);
    if (w) say(`${w.driver.name} wins the ${round.name} for ${w.team.name}.`, { kind: 'race' });
    return race.results;
  }
  race.finish = finish;

  /** Run the rest of the race as fast as the machine will go. */
  race.simulateToEnd = (maxSeconds = 20000) => {
    let guard = 0;
    while (race.state === 'racing' && guard < maxSeconds * 4) {
      race.step(0.25);
      guard++;
    }
    if (race.state !== 'finished') finish();
    return race.results;
  };

  initWeather();
  return race;
}

export function fmtLap(t) {
  if (t == null) return '—';
  const m = Math.floor(t / 60), s = t - m * 60;
  return m > 0 ? `${m}:${s.toFixed(3).padStart(6, '0')}` : s.toFixed(3);
}

export function fmtGap(t) {
  if (t == null) return '—';
  if (t >= 60) { const m = Math.floor(t / 60); return `+${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`; }
  return `+${t.toFixed(1)}`;
}
