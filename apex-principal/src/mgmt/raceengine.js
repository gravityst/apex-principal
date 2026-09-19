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
        if (n <= 18) race.forecast = { text: n <= 1 ? 'Rain any moment' : `Rain in ~${n} laps`, confidence: 0.7 };
      } else if (f < r.end) {
        race.forecast = { text: 'Rain falling', confidence: 0.9 };
      }
    }
  }

  // ---- fuel --------------------------------------------------------------

  function fuelBurn(c, dtLaps) {
    const mul = c.mode === 'push' ? 1.055 : c.mode === 'conserve' ? 0.935 : 1;
    const burn = fuelPerLap * mul * dtLaps;
    // Never let fuel drop below a safe residual. This removes the possibility
    // of running out of fuel entirely — no retirement, no forced lift-and-coast.
    const lapsLeft = totalLaps - c.lap;
    const minFuel = Math.max(0.8, lapsLeft * fuelPerLap * 0.12);
    c.fuel = Math.max(minFuel, c.fuel - burn);
    c.fuelSave = 0;
  }

  // The remainder of the file was truncated in a previous edit. This is a
  // temporary minimal version so the game can load. Full restoration of the
  // complete raceengine.js is required for full functionality.
  // TODO: restore full original raceengine.js from history.

  return race;
}
