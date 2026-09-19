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
export function tyreGrip(compound, wear, wetness, age = 9) {
  const c = TYRE_COMPOUNDS[compound];
  if (!c) return 1;
  let g = c.grip;

  // A tyre that has just gone on is not yet a tyre. The out-lap and the first
  // flying lap are worth real time, which is what makes an undercut a decision
  // rather than a formality.
  if (age < 2) g *= 0.955 + Math.min(1, age / 2) * 0.045;

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
  // Difficulty is a handicap on the rest of the field, stated plainly rather
  // than hidden in their car: it does not touch development, money or their
  // decisions, only how hard they are to beat on Sunday.
  const DIFFICULTY = { relaxed: 0.32, normal: 0, brutal: -0.30 };
  const fieldHandicap = DIFFICULTY[opts.difficulty] ?? 0;

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
    chatter: 'driver',
    failure: 'commentary', overtake: 'commentary', battle: 'commentary',
    race: 'commentary', quali: 'commentary',
  };
  const PRIORITY = {
    crash: 'high', failure: 'high', flag: 'high', refusal: 'high',
    weather: 'high', order: 'normal', pit: 'normal', incident: 'normal',
    race: 'high', quali: 'normal', overtake: 'low', battle: 'low', team: 'normal',
    chatter: 'low',
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
    const grip = tyreGrip(c.tyre, c.wear, weather.wetness, c.tyreAge);
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

    // Air. Downforce lost in the wake costs time through the corners — which is
    // exactly what `perGripLoss` measures, so the circuit decides how much it
    // hurts. The tow gives some of it back on the straights, and never all.
    t += (c.dirtyAir ?? 0) * 0.055 * c.model.perGripLoss;
    t -= (c.tow ?? 0) * 0.022 * c.model.perGripLoss;

    if (!c.isPlayer) t += fieldHandicap;
    if (race.safetyCar) t *= race.safetyCar.kind === 'sc' ? 1.40 : 1.37;
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

    // A forecast, because a pit wall has one. The rain window is already in the
    // weekend's seed; this only says how far away it is in laps.
    race.forecast = null;
    if (r) {
      const lapsLeft = (x) => Math.round((x - f) * totalLaps);
      if (f < r.start) {
        const n = lapsLeft(r.start);
        if (n <= 18) race.forecast = { text: n <= 1 ? 'Rain any moment' : `Rain in ~${n} laps`, wet: true, laps: n };
      } else if (f <= r.end && weather.wetness > 0.1) {
        const n = lapsLeft(r.end);
        race.forecast = { text: n <= 1 ? 'Easing now' : `Drying in ~${n} laps`, wet: false, laps: n };
      }
    }
    if (!race.forecast) race.forecast = { text: weather.wetness > 0.14 ? 'Staying wet' : 'Dry throughout', wet: weather.wetness > 0.14, laps: 99 };
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

  /**
   * Some cars are quick over one lap and ordinary over a stint, and some are
   * the other way round — a low-drag qualifying special that eats its tyres, a
   * heavy car that comes to itself when the fuel burns off. Without this the
   * grid is a perfect map of race pace and Sunday has nothing left to say.
   *
   * Stable per team and per season, not random per lap.
   */
  function oneLapTrim(team) {
    const id = `${team.id}`;
    let hsh = 2166136261;
    for (let i = 0; i < id.length; i++) { hsh ^= id.charCodeAt(i); hsh = Math.imul(hsh, 16777619); }
    const u = ((hsh >>> 0) % 1000) / 1000;                // 0..1, fixed for a team
    return (u - 0.5) * 0.34;                              // ±0.17s over one lap
  }

  function qualiLap(c, pressure) {
    const grip = tyreGrip(weather.wetness > 0.2 ? (weather.wetness > 0.55 ? 'wet' : 'inter') : 'soft', 0.06, weather.wetness);
    const pace = driverPace(c.driver, { mode: 'push', wet: weather.wetness, dirtyAir: 0 });
    let t = c.model.at(8, grip) / Math.max(0.9, pace) - oneLapTrim(c.team);
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
      // Not every engineer calls a stop at the same moment. A spread of a few
      // laps across the field is where undercuts, overcuts and the whole point
      // of a pit call come from — without it everyone stops together and the
      // order that comes out is the order that went in.
      c.pitBias = rng.normal(0, 0.075);
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

  /**
   * A safety car and a virtual safety car are not the same length of event and
   * they are not even measured in the same units.
   *
   * A VSC is a delta-time procedure to clear something small. It is over in
   * well under a lap — half a minute to a minute and a bit — so it is counted
   * in seconds. Counting it in laps made a VSC last five laps, which is not a
   * thing that happens.
   *
   * A full safety car is counted in laps because that is how race control
   * counts it: a lap to gather the field, a lap or two while the marshals work,
   * then "safety car in this lap". Three, usually.
   */
  function deploySafetyCar(kind, why) {
    if (race.safetyCar) return;
    race.safetyCar = kind === 'sc'
      ? { kind, lapsLeft: rng.int(2, 4), why, warned: false }
      : { kind, secsLeft: rng.range(28, 78), why, warned: false };
    say(kind === 'sc'
      ? `Safety car deployed — ${why}.`
      : `Virtual safety car — ${why}. Delta positive, everybody.`, { kind: 'flag' });
    // The field closes up over the following lap rather than being teleported
    // into a queue: `distance` is recomputed from `u` every step, so writing it
    // here did nothing at all. The gradual pull is in `step()`.
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
   * The next corner worth a move, within about half a kilometre. An overtake
   * happens somewhere specific — on the brakes for a corner — and aiming the
   * whole manoeuvre at that point is what stops passes completing in the middle
   * of a straight or, worse, halfway round a bend.
   */
  function nextApex(p) {
    const n = track.samples;
    const i0 = trackAt(p);
    const steps = Math.max(10, Math.round(Math.min(0.16, 620 / track.length) * n));
    let best = -1, bestK = 0.0022;
    for (let k = 5; k < steps; k++) {
      const kk = Math.abs(track.curv[(i0 + k) % n]);
      if (kk > bestK) { bestK = kk; best = k; }
    }
    if (best < 0) return null;
    const i = (i0 + best) % n;
    return { u: i / n, metres: best * (track.length / n), k: track.curv[i] };
  }

  /** Zero to one with zero slope at both ends: slow, then the braking zone. */
  function smootherstep(x) {
    const t = Math.max(0, Math.min(1, x));
    return t * t * t * (t * (t * 6 - 15) + 10);
  }


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
      // Down the pit lane, where the pit lane actually is.
      target = (pit.side === 'right' ? 1 : -1) * (pit.laneOffset ?? 15);
    } else if (c.duel) {
      // He commits to a lane: a full car's width off the line, held for as long
      // as the move lasts and given up when he backs out of it.
      // He stays in the tow and only pulls out for the braking zone. Moving
      // across at the start of the run looks decisive and throws away the one
      // thing that was going to get him there.
      const d = c.duel;
      const pullAt = (d.apexAt || 1) * 0.55;
      const env = d.stage === 'backout'
        ? Math.max(0, 1 - (d.t - d.apexAt) / 1.2)
        : Math.max(0, Math.min(1, (d.t - pullAt) / Math.max(0.45, (d.apexAt || 1) * 0.35)));
      target = racingLine(p) + d.side * Math.min(w * 0.62, 3.2) * env;
    } else if (c._launch) {
      target = (c._gridSide || 1) * Math.min(w * 0.44, 2.6);
    } else if (c.defending) {
      // The man being passed does not sit on the ideal line and wait for it. He
      // moves across to cover, and comes back to the line as the move resolves.
      target = racingLine(p) + c.defending * Math.min(w * 0.45, 2.3) * Math.max(0.2, c.defendEnv ?? 1);
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
    // Keep him on the road — except in the pit lane, which is not on it.
    if (c.status !== 'pit') target = Math.max(-w + 1.1, Math.min(w - 1.1, target));

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
      // How close he may get depends on how far across he is. Fully alongside,
      // a couple of metres; on the same line, a car's length and a bit. Graded,
      // because half a car's width of overlap is exactly where two cars end up
      // occupying the same piece of road.
      const lat = Math.abs((ahead.lateral ?? 0) - (c.lateral ?? 0));
      const need = lat >= 2.2 ? 1.9 : 6.6 - (lat / 2.2) * 4.7;
      if (gap >= need) continue;
      // Hold him back, but never push him across the timing line backwards.
      nudge(c, -(need - gap));
    }
  }

  /**
   * Two cars alongside, and one of them gets it wrong. Both pay; the one who
   * was doing the passing pays more, and the stewards take an interest.
   */
  function contact(attacker, victim) {
    const hard = rng.chance(0.34);
    attacker.damage = Math.min(1, attacker.damage + (hard ? 0.42 : 0.15));
    victim.damage = Math.min(1, victim.damage + (hard ? 0.34 : 0.10));
    attacker.incidentTimer += hard ? rng.range(7, 16) : rng.range(1.4, 3.6);
    victim.incidentTimer += hard ? rng.range(5, 13) : rng.range(1.0, 2.8);
    attacker.battleCooldown = 8; victim.battleCooldown = 6;
    attacker.defending = 0; victim.defending = 0; victim.defendEnv = 0;
    fx(attacker, 'smoke', hard ? 10 : 5);
    fx(victim, 'dust', hard ? 8 : 3);
    if (hard) {
      attacker.penalty += 5;
      say(`Contact at the apex — ${attacker.driver.name} into ${victim.driver.name}. Both cars are damaged and the stewards are looking at it.`,
        { kind: 'crash', car: attacker.id, player: attacker.isPlayer || victim.isPlayer });
      if (rng.chance(0.35)) deploySafetyCar('vsc', 'debris on the circuit');
    } else {
      say(`Wheel to wheel and they touch — ${attacker.driver.name} and ${victim.driver.name}. Both carry on.`,
        { kind: 'incident', car: attacker.id, player: attacker.isPlayer || victim.isPlayer });
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

  /**
   * The stewards. Running wide is worth time, and doing it repeatedly is worth
   * five seconds. It gives a driver on the edge something to lose.
   */
  function rollTrackLimits(c, dtLaps) {
    if (c.status !== 'running' || race.safetyCar) return;
    const cons = c.driver.consistency ?? 0.88;
    let p = 0.16 * (1 - cons);
    if (c.mode === 'push') p *= 1.8;
    if (c.defiance > 0) p *= 1.3;
    p *= 1 + Math.max(0, c.wear - 0.7) * 0.9;
    if (!rng.chance(p * dtLaps)) return;
    c.limitStrikes = (c.limitStrikes || 0) + 1;
    if (c.limitStrikes === 3) {
      say(`Black-and-white flag for ${c.driver.name} — third track-limits warning. One more and it is a penalty.`,
        { kind: 'penalty', car: c.id, player: c.isPlayer });
    } else if (c.limitStrikes === 4) {
      c.penalty += 5;
      say(`${c.driver.name} has a fourth track-limits warning — five-second penalty, to be served at his stop.`,
        { kind: 'penalty', car: c.id, player: c.isPlayer });
    } else if (c.isPlayer) {
      say(`Warning for track limits, ${c.driver.short || c.driver.name.split(' ').pop()}. That is ${c.limitStrikes} of three.`,
        { kind: 'penalty', car: c.id, player: true });
    }
  }

  /**
   * A driver says things. Not because the simulation needs him to, but because
   * a silent car is a spreadsheet and a talking one is a person.
   */
  const DRIVER_LINES = {
    good: ['That is the balance I wanted. Keep it coming.', 'Car feels good. I can hold this.',
      'Yes! That is a good one.', 'Happy with that. Same again.'],
    tyres: ['Rears are going away on me.', 'I am starting to slide at the rear.',
      'Front left is done, I am asking a lot of it.', 'Graining at the front. It will not last.'],
    traffic: ['I am in his gearbox and I cannot get by.', 'Give me a plan, I am losing the front here.',
      'He is slow in the corners and quick on the straight. I need help.'],
    fuel: ['How is the fuel? I do not want to be lifting at the end.',
      'Tell me now if I have to save, not on the last lap.'],
    wet: ['It is getting greasy out here.', 'I have no idea where the grip is.',
      'Standing water at the back of the circuit. Be careful with the calls.'],
  };
  function rollChatter(c, dtLaps) {
    if (!c.isPlayer || c.status !== 'running') return;
    if (!rng.chance(0.09 * dtLaps * 4)) return;
    let bucket = 'good';
    if (weather.wetness > 0.25 && rng.chance(0.6)) bucket = 'wet';
    else if (c.wear > 0.72) bucket = 'tyres';
    else if (c.dirtyAir > 0.5) bucket = 'traffic';
    else if ((c.fuel ?? 99) < fuelPerLap * (totalLaps - c.lap) * 1.02) bucket = 'fuel';
    else if (c.lastLapTime && c.bestLap && c.lastLapTime > c.bestLap + 1.2) return;
    say(`${c.driver.name}: "${rng.pick(DRIVER_LINES[bucket])}"`,
      { kind: 'chatter', from: 'driver', priority: 'low', car: c.id, player: true });
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

  /**
   * Shift a car a few metres along the circuit.
   *
   * Everything that nudges a car — a launch being paid out, the closing speed
   * in a move, the field closing up behind a safety car — goes through here,
   * and here refuses to cross the timing line. Crossing it is the main loop's
   * job, because that is where the lap time, the sectors and the pit decision
   * live. A nudge that wrapped `u` past one on its own left the car a whole lap
   * down: it never completed a lap again all afternoon.
   */
  function nudge(c, metres) {
    if (!metres) return;
    // The main loop may already have carried `u` past one this step and not yet
    // turned it into a lap. Touching it here would map it back to the start of
    // the lap without the counter moving, and the car would never complete a
    // lap again — which is exactly what happened.
    if (c.u >= 0.9992 || c.u <= 0.0008) return;
    const p = posOf(c) + metres / track.length;
    if (p >= 0.9992 || p <= 0.0008) return;      // next step, when the line is crossed properly
    c.u = phaseOf(c, p);
    c.distance = c.lap * track.length + c.u * track.length;
  }

  // ---- the radio -----------------------------------------------------------
  //
  // Two voices and they are not interchangeable. The engineer has the numbers:
  // gaps, intervals, tyre life, what the car behind is on. The driver has the
  // car: short, dry, and not always agreeable. Every line below is triggered by
  // something that actually happened in the simulation — none of it is filler.

  const DRIVER_SAYS = {
    attackInside: ['I\'m going up the inside.', 'Got a run. Inside.', 'He\'s left it open. Going.'],
    attackOutside: ['I\'ll go round the outside of him.', 'Taking the long way. Watch this.', 'Outside. Stay with me.'],
    conceded: ['Yes. That\'s him done.', 'Clear. Next one.', 'Told you.'],
    heldUp: ['He shut the door. I had to lift.', 'Nothing there. He got the line.', 'Couldn\'t make it stick.'],
    switchback: ['Right. I\'ll have him on the exit.', 'Switching back. Give me a second.'],
    passed: ['That\'s the place. Where\'s the next one?', 'Done. Gap?', 'Clear air at last.'],
    lost: ['He got me. I had nothing on the exit.', 'Lost it. He was quicker there.'],
    ack: ['Copy.', 'Copy that.', 'Understood.', 'Copy. Leave me to it.', 'Yeah, got it.'],
  };

  function radioDriver(c, bucket, priority = 'low') {
    if (!c.isPlayer) return;
    say(`${c.driver.name}: "${rng.pick(DRIVER_SAYS[bucket])}"`,
      { kind: 'chatter', from: 'driver', priority, car: c.id, player: true });
  }
  function radioEng(c, text, priority = 'normal') {
    if (!c.isPlayer) return;
    say(text, { kind: 'brief', from: 'engineer', priority, car: c.id, player: true });
  }

  function radioAttempt(c, ahead, inside) {
    if (c.isPlayer) {
      radioDriver(c, inside ? 'attackInside' : 'attackOutside', 'normal');
    } else if (ahead.isPlayer) {
      radioEng(ahead, `${short(ahead)}, ${short(c)} is having a go${inside ? ' up the inside' : ' round the outside'}. Cover it.`, 'high');
    }
  }
  function radioConcede(c, ahead) {
    if (c.isPlayer) radioDriver(c, 'conceded', 'normal');
    else if (ahead.isPlayer) radioEng(ahead, `He has the corner, ${short(ahead)}. Give him room and get the exit.`, 'high');
  }
  function radioHold(c, ahead) {
    if (c.isPlayer) radioDriver(c, 'heldUp', 'low');
    else if (ahead.isPlayer) radioEng(ahead, `Good defence, ${short(ahead)}. He had to lift.`, 'normal');
  }
  function radioSwitchback(c, ahead) {
    if (c.isPlayer) radioDriver(c, 'switchback', 'normal');
    else if (ahead.isPlayer) radioEng(ahead, `Watch the switchback — he is crossing back behind you.`, 'high');
  }
  function radioPassed(c, ahead) {
    if (c.isPlayer) {
      radioDriver(c, 'passed', 'normal');
      radioEng(c, `That is P${Math.max(1, c.position - 1)}. Next is ${gapAheadText(c)}.`, 'normal');
    } else if (ahead.isPlayer) {
      radioDriver(ahead, 'lost', 'normal');
      radioEng(ahead, `He is through. You are P${ahead.position + 1}. We go again — ${tyreLifeText(ahead)}.`, 'high');
    }
  }
  const short = (c) => c.driver.short || c.driver.name.split(' ').pop();
  function gapAheadText(c) {
    const order = race.order || updateOrder();
    const a = order[order.indexOf(c) - 1];
    return a ? `${short(a)}, ${Math.abs(c.interval).toFixed(1)} up the road` : 'clear air';
  }
  function tyreLifeText(c) {
    const left = Math.max(0, 1 - c.wear);
    return `tyres are at ${(left * 100).toFixed(0)}%`;
  }

  /**
   * The things the pit wall says without being asked: the tyre crossing a
   * threshold, a rival on fresher rubber, the last lap. Each fires once.
   */
  function radioWatch(c) {
    if (!c.isPlayer || c.status !== 'running') return;
    if (!c._said) c._said = {};
    const m = c._said;
    const stint = `${c.stops}`;

    if (c.wear > 0.60 && m.deg60 !== stint) {
      m.deg60 = stint;
      radioEng(c, `${short(c)}, tyres are through sixty percent. Deg is about ${(0.06 + c.wear * 0.08).toFixed(2)} a lap now. Window opens in a few.`);
      if (rng.chance(0.5)) radioDriver(c, 'ack');
    }
    if (c.wear > 0.80 && m.deg80 !== stint) {
      m.deg80 = stint;
      radioEng(c, `Eighty percent on those tyres. They will fall away quickly from here — we need a decision.`, 'high');
    }
    const order = race.order || updateOrder();
    const behind = order[order.indexOf(c) + 1];
    if (behind && behind.status === 'running' && behind.interval < 2.0
        && behind.stops > c.stops && m.undercut !== `${behind.id}:${behind.stops}`) {
      m.undercut = `${behind.id}:${behind.stops}`;
      radioEng(c, `Car behind is ${behind.interval.toFixed(1)} back on fresh ${TYRE_COMPOUNDS[behind.tyre]?.name ?? behind.tyre}. We should cover.`, 'high');
    }
    const ahead = order[order.indexOf(c) - 1];
    if (ahead && ahead.status === 'running' && ahead.stops < c.stops && c.interval < 3.0
        && m.overcut !== `${ahead.id}:${ahead.stops}`) {
      m.overcut = `${ahead.id}:${ahead.stops}`;
      radioEng(c, `${short(ahead)} has not stopped yet. Stay out and the overcut is on — ${c.interval.toFixed(1)} to find.`);
    }
    if (totalLaps - c.lap === 1 && m.last !== '1') {
      m.last = '1';
      radioEng(c, `Last lap, ${short(c)}. ${c.interval < 2 ? 'Everything you have got.' : 'Bring it home.'}`, 'high');
      if (rng.chance(0.7)) radioDriver(c, 'ack', 'normal');
    }
  }

  // ---- fighting ------------------------------------------------------------

  /** How much of a car length the attacker has on the defender. 1 = alongside. */
  const CAR_LENGTH = 5.6;

  /** True gap in metres between two cars, positive when `b` is behind `a`. */
  function gapMetres(a, b) {
    return (a.lap + posOf(a) - b.lap - posOf(b)) * track.length;
  }

  /** How straight it is here, 0 in a hairpin and 1 on the main straight. */
  function straightness(p) {
    return 1 - Math.min(1, Math.abs(track.curv[trackAt(p)]) / 0.0042);
  }

  /**
   * Air. Two effects, opposite signs, and that is the whole point of following
   * somebody: in the corners you lose downforce and cannot stay with him, and
   * on the straights you get a tow and pull back what you lost. Net, it is a
   * loss — which is why a train forms and why DRS exists.
   *
   * The wake is behind the car, not beside it. Pull fully alongside and it
   * clears, which is what makes a move stick once it is made.
   */
  function updateAir(c, ahead) {
    if (!ahead || ahead.status !== 'running' || c.status !== 'running') {
      c.dirtyAir = 0; c.tow = 0; return;
    }
    const gapS = c.interval;
    const lat = Math.abs((c.lateral ?? 0) - (ahead.lateral ?? 0));
    // Out of the wake sideways: a full car's width clear of him is clean air.
    const inWake = Math.max(0, 1 - lat / 2.9);
    const near = gapS < 2.0 ? Math.min(1, (2.0 - gapS) / 1.5) : 0;
    c.dirtyAir = near * inWake;
    // The tow only exists where there is speed to be had.
    c.tow = near * inWake * straightness(posOf(c)) * (gapS < 1.1 ? 1 : 0.45);
  }

  /**
   * DRS, with a detection point. You are only allowed the flap if you were
   * within a second at the line before the zone — which is why a defender will
   * sometimes deliberately drop back to lose the detection.
   */
  function updateDRS(c, fromPos, toPos) {
    if (!c.drsArm) c.drsArm = {};
    const allowed = !race.safetyCar && c.lap >= 2 && weather.wetness < 0.3;
    for (let i = 0; i < drsZones.length; i++) {
      const z = drsZones[i];
      if (crossed(fromPos, toPos, z.detect)) {
        const was = !!c.drsArm[i];
        c.drsArm[i] = allowed && c.interval < 1.0 && c.position > 1;
        if (c.drsArm[i] && !was && c.isPlayer) {
          say(`You are inside a second at the detection — DRS available in the next zone.`,
            { kind: 'drs', from: 'engineer', priority: 'normal', car: c.id, player: true });
        }
      }
      if (crossed(fromPos, toPos, z.end)) c.drsArm[i] = false;
    }
    let open = false;
    for (let i = 0; i < drsZones.length; i++) {
      if (c.drsArm[i] && inZone(toPos, drsZones[i])) { open = true; break; }
    }
    c.drs = open && allowed;
  }

  /**
   * Open a move. Which side each car takes is decided here and it matters:
   * the defender covers the inside if he sees it coming, and going round the
   * outside then needs the attacker to be fully alongside at turn-in rather
   * than merely overlapping.
   */
  function startMove(c, ahead, apex) {
    const insideSide = apex ? -Math.sign(apex.k) : (ahead.lateral > 0 ? -1 : 1);
    // Can the attacker get to the inside before it is shut? Quick, aggressive
    // drivers against slow-reacting ones, mostly.
    const quick = (c.driver.aggression ?? 0.75) * 0.55 + (c.driver.skill ?? 0.85) * 0.45
      - (ahead.driver.skill ?? 0.85) * 0.35 - (ahead.driver.consistency ?? 0.88) * 0.2 + 0.28;
    const takesInside = rng.chance(Math.max(0.15, Math.min(0.9, quick)));
    const side = takesInside ? insideSide : -insideSide;

    const v = Math.max(28, currentSpeed(c));
    const reach = apex ? apex.metres : 190;
    const apexAt = Math.max(0.9, Math.min(6.5, reach / v));

    c.duel = {
      targetId: ahead.id,
      side,
      inside: takesInside,
      // How much overlap he needs at turn-in to be given the corner. Down the
      // inside, a front wheel alongside is enough. Round the outside it is not.
      needed: takesInside ? 0.45 : 0.76,
      stage: 'run',
      t: 0,
      apexAt,
      overlap: 0,
      contact: false,
      reply: false,
      decided: null,
      announced: false,
    };
    ahead.defending = takesInside ? -insideSide : insideSide;   // he covers the inside
    ahead.defendEnv = 0;
    ahead.battleCooldown = Math.max(ahead.battleCooldown, 1.2);
    radioAttempt(c, ahead, takesInside);
  }

  /**
   * Run a move on. The attacker closes at whatever his real advantage is worth
   * — pace, tyre, tow, DRS — and the overlap that produces at turn-in is what
   * decides the corner. Nothing is scripted: a car that is not quick enough
   * simply does not get there, which is what a failed attempt actually is.
   */
  function stepMove(c, dt) {
    const d = c.duel;
    const ahead = race.cars.find((x) => x.id === d.targetId);
    if (!ahead || ahead.status !== 'running' || c.status !== 'running') { endMove(c, false); return; }
    d.t += dt;

    const gap = gapMetres(ahead, c);
    d.overlap = Math.max(0, Math.min(1, 1 - gap / CAR_LENGTH));
    const lat = Math.abs((c.lateral ?? 0) - (ahead.lateral ?? 0));
    const alongside = lat > 2.4;

    // The defender covers, and lets go once it is over.
    ahead.defendEnv = d.stage === 'backout' ? Math.max(0, (ahead.defendEnv ?? 0) - dt * 1.6)
      : Math.min(1, (ahead.defendEnv ?? 0) + dt * 2.4);

    if (d.stage === 'run' || d.stage === 'alongside' || d.stage === 'switchback') {
      // What he is actually worth, in metres a second.
      const paceAdv = Math.max(-0.6, currentLapTime(ahead) - currentLapTime(c)) * 0.9;
      const tow = alongside ? 0 : (c.tow ?? 0) * 5.5;              // gone once he is out of the wake
      const drs = c.drs ? 7.0 * straightness(posOf(c)) : 0;
      const grit = ((c.driver.aggression ?? 0.75) - 0.5) * 2.2;
      const held = ((ahead.driver.skill ?? 0.85) - 0.8) * 3.0 + (ahead.mode === 'hold' ? 1.4 : 0);
      let closing = paceAdv * 9.0 + tow + drs + grit - held;
      if (d.stage === 'switchback') closing += 5.5;                 // better exit, better drive
      // Once he is level there is nothing left to gain from the tow, so the
      // last half a car length is the hardest. That is the whole feel of it.
      closing *= 1 - d.overlap * 0.40;
      closing = Math.max(-4, Math.min(16, closing));
      nudge(c, closing * dt);

      if (d.overlap > 0.22) d.stage = d.stage === 'switchback' ? 'switchback' : 'alongside';
    }

    // Turn-in. The corner is decided here, once, on the overlap he has.
    if (!d.decided && d.t >= d.apexAt) {
      if (!d.contact) {
        d.contact = true;
        const marginal = d.overlap > 0.3 && d.overlap < d.needed + 0.18;
        if (marginal) {
          const wild = (1 - (c.driver.consistency ?? 0.88)) * (c.driver.aggression ?? 0.75)
            + (1 - (ahead.driver.consistency ?? 0.88)) * 0.55;
          if (rng.chance(wild * (0.05 + weather.wetness * 0.2))) {
            contact(c, ahead);
            c.duel = null;
            return;
          }
        }
      }
      if (d.overlap >= d.needed) {
        d.decided = 'pass';
        d.stage = 'alongside';
        radioConcede(c, ahead, d.inside);
      } else {
        d.decided = 'hold';
        d.stage = 'backout';
        c.incidentTimer += rng.range(0.08, 0.3);      // the lift
        radioHold(c, ahead);
      }
    }

    // Through: he has the corner, so he completes it and takes the place.
    if (d.decided === 'pass') {
      if (gap < -CAR_LENGTH * 1.25) { endMove(c, true); return; }
      if (d.t > d.apexAt + 4.5) { endMove(c, gapMetres(ahead, c) < 0); return; }
      return;
    }

    // Backed out. He drops in behind, and may cross back for the exit.
    if (d.decided === 'hold') {
      if (d.t > d.apexAt + 1.4) {
        if (!d.reply && d.stage !== 'switchback'
            && rng.chance(0.11 + (c.driver.aggression ?? 0.75) * 0.15)) {
          d.stage = 'switchback';
          d.side = -d.side;
          d.inside = !d.inside;
          d.needed = d.inside ? 0.5 : 0.8;
          d.decided = null;
          d.contact = false;
          d.reply = true;
          d.apexAt = d.t + rng.range(1.0, 1.7);
          ahead.defending = -d.side;
          radioSwitchback(c, ahead);
          return;
        }
        endMove(c, false);
      }
    }
  }

  function endMove(c, passed) {
    const d = c.duel;
    if (!d) return;
    const ahead = race.cars.find((x) => x.id === d.targetId);
    if (ahead) { ahead.defending = 0; ahead.defendEnv = 0; ahead.battleCooldown = passed ? 4 : 2.5; }
    c.battleCooldown = passed ? 7 : 5.5;
    if (passed && ahead) {
      say(`${c.driver.name} ${d.inside ? 'goes down the inside of' : 'holds it round the outside of'} ${ahead.driver.name} and takes the place.`,
        { kind: 'overtake', car: c.id, player: c.isPlayer || ahead.isPlayer });
      radioPassed(c, ahead);
      // The switchback the other way: a better exit and he has it straight back.
      const grit = (ahead.driver.skill ?? 0.85) * (ahead.driver.aggression ?? 0.75);
      if (!d.reply && rng.chance(0.03 + grit * 0.055)) {
        ahead.battleCooldown = 0;
        startMove(ahead, c, nextApex(posOf(ahead)));
        if (ahead.duel) { ahead.duel.reply = true; ahead.duel.apexAt = rng.range(1.1, 1.9); }
      }
    }
    c.duel = null;
  }

  function updateBattles(dt) {
    const order = race.order || updateOrder();
    for (let i = 0; i < order.length; i++) {
      const c = order[i], ahead = order[i - 1];
      if (c.status !== 'running') { c.dirtyAir = 0; c.tow = 0; c.drs = false; continue; }
      updateAir(c, i > 0 ? ahead : null);

      if (c.battleCooldown > 0) c.battleCooldown -= dt;
      if (!ahead || ahead.status !== 'running') continue;
      if (c.duel || ahead.duel || c.defending) continue;
      if (c.battleCooldown > 0) continue;
      if (race.safetyCar) continue;

      // The run to the corner is part of the move. From half a second back you
      // need the tow and the flap to get there; from two car lengths you can
      // have a go at anything. Both are attempts — only one of them works.
      const gap = c.interval;
      const metres = gapMetres(ahead, c);
      if (metres > 75 || metres < 0) continue;
      if (gap > 1.05) continue;

      // Opportunities are the braking zones. Every corner counts on lap one,
      // because on lap one it does.
      const firstLap = c.lap < 1;
      const apex = nextApex(posOf(c));
      if (!apex) continue;
      const bigEnough = Math.abs(apex.k) > (firstLap ? 0.0060 : 0.0030);
      // How long a run he is allowed. A pass down a straight IS the straight —
      // five or six seconds of tow and flap — so the window opens much earlier
      // when he is close enough to have one.
      const runway = gap < 0.85 ? currentSpeed(c) * 5.8 : currentSpeed(c) * 2.4;
      const close = apex.metres < Math.max(90, runway);
      if (!bigEnough || !close) continue;
      // One go per corner. Keyed on the corner itself rather than a flag, or a
      // circuit with a corner always in range never re-arms and a car gets one
      // attempt in the whole race.
      const key = `${c.lap}:${apex.u.toFixed(4)}`;
      if (c._lastApex === key) continue;
      c._lastApex = key;

      // He needs a reason. Pace, a better tyre, DRS or a tow — and if he has
      // none of them he sits there and waits, which is a DRS train.
      const paceDelta = currentLapTime(ahead) - currentLapTime(c);
      const tyreDelta = tyreGrip(c.tyre, c.wear, weather.wetness, c.tyreAge)
        - tyreGrip(ahead.tyre, ahead.wear, weather.wetness, ahead.tyreAge);
      const worth = paceDelta * 1.6 + tyreDelta * 9 + (c.drs ? 0.55 : 0) + (c.tow ?? 0) * 0.35
        + ((c.driver.aggression ?? 0.75) - 0.7) * 0.9 + (firstLap ? 0.45 : 0);
      if (worth < 0.04) { c.battleCooldown = 3; continue; }
      if (!rng.chance(Math.min(0.92, 0.28 + worth * 0.5))) { c.battleCooldown = 2.5; continue; }

      startMove(c, ahead, apex);
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
    const threshold = (race.safetyCar ? 0.52 : 0.86) + (c.pitBias || 0);
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
        say(`Box box, box box. ${TYRE_COMPOUNDS[c.pitRequested]?.name ?? c.pitRequested} ready.`, { kind: 'order', car: c.id, player: true });
        if (rng.chance(0.75)) radioDriver(c, 'ack', 'normal');
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
        if (rng.chance(0.55)) radioDriver(c, 'ack');
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

  /**
   * Team orders. You can ask the car in front to let his team mate past. He may
   * well tell you where to go, and he will remember that you asked.
   */
  race.swapCars = (frontId, behindId) => {
    const front = race.cars.find((x) => x.id === frontId);
    const behind = race.cars.find((x) => x.id === behindId);
    if (!front || !behind || front.status !== 'running' || behind.status !== 'running') return { ok: false };
    front.overrideUntilLap = front.lap + 3;
    const ctx = pitContext(front);
    const willing = complianceChance(front.driver, 'hold', ctx) * 0.72
      - (front.driver.aggression ?? 0.75) * 0.22;
    if (front.defiance > 0 || !rng.chance(Math.max(0.05, willing))) {
      front.defiance = rng.range(3, 6);
      front.driver.morale = Math.max(0.15, (front.driver.morale ?? 0.65) - 0.05);
      say(`${front.driver.name}: "${rng.pick(['Negative. I am not moving over.', 'No. Tell him to catch me first.', 'You are joking. I am racing him.'])}"`,
        { kind: 'refusal', car: front.id, player: true });
      return { ok: true, complied: false };
    }
    say(`${front.driver.name} is told to let ${behind.driver.name} through, and he does it cleanly.`,
      { kind: 'order', car: front.id, player: true });
    front.duel = null; behind.duel = null;
    front.defending = 0; front.defendEnv = 0;
    // He lifts: a couple of car lengths, given away over a few seconds.
    front._launch = -11;
    front._gridSide = behind.lateral >= 0 ? -1 : 1;
    behind._launch = 11;
    behind._gridSide = -front._gridSide;
    front.driver.morale = Math.max(0.15, (front.driver.morale ?? 0.65) - 0.03);
    front.battleCooldown = 8; behind.battleCooldown = 8;
    return { ok: true, complied: true };
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
      const behindGap = race.gapBehind(c);

      // Air, as a driver experiences it. Sitting in someone's wake ruins the
      // tyres for nothing, so a driver who cannot pass drops back out of it,
      // cools the car and comes again with a run. A driver being caught puts
      // his head down and tries to break the tow before it matters.
      if (c.dirtyAir > 0.55 && c.battleCooldown > 1.5 && c.interval < 1.0 && lapsLeft > 4) {
        c.mode = 'conserve';
        c._cooling = true;
        return;
      }
      if (c._cooling && c.interval > 1.4) c._cooling = false;
      if (behindGap != null && behindGap < 1.6 && !fuelShort && c.wear < 0.9) {
        c.mode = 'push';                      // he is in my mirrors: break the tow
        return;
      }

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
      rollChatter(c, dLap);
      rollTrackLimits(c, dLap);
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
        nudge(c, take);

        // A launch that has run out of road is a move, not a queue. The
        // manoeuvre system already knows how to put one car alongside another,
        // so a good getaway uses it rather than driving through the man ahead.
        if (c._launch > 0.6 && !c.duel && c.battleCooldown <= 0) {
          const ord = race.order || race.cars;
          const ahead = ord[ord.indexOf(c) - 1];
          if (ahead && ahead.status === 'running' && !ahead.duel && !ahead.defending) {
            const gapM = gapMetres(ahead, c);
            if (gapM > 0 && gapM < 26) {
              startMove(c, ahead, nextApex(posOf(c)));
              if (c.duel) {
                // A start is decided in seconds, not over a run to the corner.
                c.duel.apexAt = Math.min(c.duel.apexAt, rng.range(1.2, 2.0));
                c.duel.side = c._gridSide || c.duel.side;
              }
            }
          }
        }
      }

      // A move in progress: the attacker carries extra speed out of the tow,
      // eased in and out, so the places change while the cars are moving
      // rather than between one frame and the next.
      if (c.duel) stepMove(c, dt);

      updateDRS(c, posOf(c, prevU), posOf(c));

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
          if (c.isPlayer) {
            radioEng(c, `That is the fastest lap of the race — ${fmtLap(lapT)}.`, 'normal');
            if (rng.chance(0.5)) radioDriver(c, 'ack');
          }
        }
        considerPit(c);
        radioWatch(c);
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

    // A virtual safety car is over in seconds, so it is counted in them.
    if (race.safetyCar && race.safetyCar.secsLeft != null) {
      race.safetyCar.secsLeft -= dt;
      if (race.safetyCar.secsLeft <= 6 && !race.safetyCar.warned) {
        race.safetyCar.warned = true;
        say('Virtual safety car ending — get ready to go again.', { kind: 'flag' });
      }
      if (race.safetyCar.secsLeft <= 0) {
        race.safetyCar = null;
        say('Green flag, green flag. We are racing.', { kind: 'flag' });
      }
    }

    // Under the safety car the field closes up. Without this a race neutralised
    // on lap 8 stayed exactly as spread out as it was, which is the one thing
    // a safety car never does.
    if (race.safetyCar && race.safetyCar.kind === 'sc') {
      const run = race.cars.filter((x) => x.status === 'running');
      run.sort((a, b) => b.distance - a.distance);
      for (let i = 1; i < run.length; i++) {
        const ahead = run[i - 1], c = run[i];
        const want = 22 + (i % 2) * 3;                 // metres, nose to nose
        const trueGap = (ahead.lap + posOf(ahead) - c.lap - posOf(c)) * track.length;
        if (trueGap <= want || trueGap > 900) continue;
        nudge(c, Math.min(trueGap - want, 26 * dt));
      }
    }

    // Leader lap counter drives weather and the safety car.
    const order = updateOrder();
    const leader = order.find((c) => c.status === 'running' || c.status === 'pit');
    const newLap = leader ? leader.lap : race.lap;
    if (newLap !== race.lap) {
      race.lap = newLap;
      if (race.safetyCar && race.safetyCar.lapsLeft != null) {
        race.safetyCar.lapsLeft--;
        if (race.safetyCar.lapsLeft === 1 && !race.safetyCar.warned) {
          race.safetyCar.warned = true;
          say('Safety car in this lap. Get the tyres and the brakes ready.', { kind: 'flag' });
        }
        if (race.safetyCar.lapsLeft <= 0) {
          race.safetyCar = null;
          say('Green flag, green flag. We are racing.', { kind: 'flag' });
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
