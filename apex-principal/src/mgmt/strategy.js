/**
 * APEX: Principal — the strategy engine.
 *
 * This file exists because of one complaint that was entirely fair: you could
 * not tell when to push. A pit wall that shows you a tyre bar and a lap counter
 * is asking you to guess. A real one runs the numbers.
 *
 * Everything here is derived from the same lap model the race engine uses, so
 * these are not hints — they are the simulation's own arithmetic, shown to you
 * before it happens instead of after.
 *
 * The four questions a principal actually asks:
 *
 *   How long will this tyre last?      -> tyreOutlook()
 *   What does stopping cost me?        -> pitCost() and rejoinProjection()
 *   Can I undercut the car ahead?      -> undercut()
 *   What does pushing buy, and cost?   -> pushTrade()
 */

import { TYRE_COMPOUNDS } from '../data/teams.js';
import { tyreGrip } from './raceengine.js';
import { driverWearFactor } from './personnel.js';

/** Wear added per lap for a car in its current state. Mirrors the race engine. */
export function wearRateFor(race, car, mode = null) {
  const c = TYRE_COMPOUNDS[car.tyre] || TYRE_COMPOUNDS.medium;
  const ctx = {
    mode: mode || car.mode,
    dirtyAir: car.dirtyAir,
    wetness: race.weather.wetness,
  };
  return 0.052 * race.abrasion * c.wearRate * car.phys.wearRate
    * driverWearFactor(car.driver, ctx)
    * (1 + (race.weather.wetness ?? 0) * -0.35);
}

/**
 * How much time this tyre is costing right now versus a fresh one, and how
 * many laps are left before it falls off the cliff.
 */
export function tyreOutlook(race, car) {
  const fresh = tyreGrip(car.tyre, 0, race.weather.wetness);
  const now = tyreGrip(car.tyre, car.wear, race.weather.wetness);
  const perLap = wearRateFor(race, car);

  // Seconds a lap currently being given away to tyre condition.
  const lossNow = (fresh - now) * car.model.perGripLoss;

  // Degradation right now: what one more lap of wear costs.
  const next = tyreGrip(car.tyre, car.wear + perLap, race.weather.wetness);
  const degPerLap = (now - next) * car.model.perGripLoss;

  // The cliff is at wear 1.0, where the compound falls away sharply.
  const lapsToCliff = perLap > 1e-6 ? Math.max(0, (1.0 - car.wear) / perLap) : 99;
  // Usable life is a little short of the cliff: nobody plans to run past it.
  const lapsUsable = perLap > 1e-6 ? Math.max(0, (0.92 - car.wear) / perLap) : 99;

  return {
    compound: car.tyre,
    wear: car.wear,
    age: car.tyreAge,
    perLap,
    lossNow,
    degPerLap,
    lapsToCliff,
    lapsUsable,
    pastCliff: car.wear >= 1,
    state: car.wear >= 1 ? 'gone' : car.wear > 0.85 ? 'critical' : car.wear > 0.62 ? 'working' : 'healthy',
  };
}

/**
 * The real cost of a pit stop here, in seconds: pit lane transit plus the
 * stationary time, minus the time it would have taken to race that stretch.
 */
export function pitCost(race, car) {
  const pit = race.pit;
  const span = ((pit.exit - pit.entry) % 1 + 1) % 1;
  const lapT = race.currentLapTime(car);
  const racingThatStretch = lapT * span;
  const crewLevel = Math.max(1, Math.min(5, car.facilities?.pitcrew ?? 3));
  const stationary = [3.55, 3.15, 2.80, 2.50, 2.24][crewLevel - 1];
  const total = race.pitTransit + stationary;
  return {
    transit: race.pitTransit,
    stationary,
    net: Math.max(4, total - racingThatStretch),
    crewLevel,
  };
}

/**
 * Where you would rejoin if you boxed at the end of this lap.
 *
 * Works in track position: your distance after paying the pit loss, compared
 * against where everyone else will be by then.
 */
export function rejoinProjection(race, car) {
  const cost = pitCost(race, car);
  const order = race.order || race.updateOrder();
  const myLapT = race.currentLapTime(car);
  const mySpeed = race.track.length / myLapT;

  // My position after the stop, in metres of race distance.
  const myAfter = car.distance + mySpeed * 0 - cost.net * mySpeed;

  let ahead = 0;
  const behindWho = [];
  for (const o of order) {
    if (o === car || o.status === 'retired') continue;
    // Where they will be when I come out.
    const theirSpeed = race.track.length / race.currentLapTime(o);
    const theirAfter = o.distance + theirSpeed * cost.net;
    if (theirAfter > myAfter) ahead++;
    else behindWho.push(o);
  }
  const position = ahead + 1;

  // Who I would come out right behind, and how far back.
  let justAhead = null, gap = null;
  let best = Infinity;
  for (const o of order) {
    if (o === car || o.status === 'retired') continue;
    const theirSpeed = race.track.length / race.currentLapTime(o);
    const theirAfter = o.distance + theirSpeed * cost.net;
    const d = theirAfter - myAfter;
    if (d > 0 && d < best) { best = d; justAhead = o; gap = d / mySpeed; }
  }

  return { position, lost: position - car.position, justAhead, gap, cost: cost.net };
}

/**
 * Undercut maths against the car directly ahead.
 *
 * You box now on a fresh set; they stay out one more lap and box next lap. Do
 * you come out in front? The answer is the difference between what a fresh
 * tyre gains you on your out-lap and what their worn tyre loses them on theirs.
 *
 * @param compound the compound you would fit
 */
export function undercut(race, car, compound = null) {
  const order = race.order || race.updateOrder();
  const idx = order.indexOf(car);
  const target = order[idx - 1];
  if (!target || target.status === 'retired') return null;

  const fit = compound || bestAvailableCompound(race, car);
  // The out-lap on a cold set is part of what an undercut costs.
  const myFreshGrip = tyreGrip(fit, 0.02, race.weather.wetness, 0.6);
  const myNowGrip = tyreGrip(car.tyre, car.wear, race.weather.wetness);
  const theirGrip = tyreGrip(target.tyre, target.wear, race.weather.wetness);
  const theirNextGrip = tyreGrip(target.tyre, target.wear + wearRateFor(race, target), race.weather.wetness);

  // Per-lap advantage a fresh tyre gives me over what I am on now.
  const myGain = (myFreshGrip - myNowGrip) * car.model.perGripLoss;
  // What staying out one more lap costs them.
  const theirLoss = (theirGrip - theirNextGrip) * target.model.perGripLoss;

  // A fresh tyre does not deliver everything on the out-lap; call it 60%.
  const outLapGain = myGain * 0.6;
  const swing = outLapGain + theirLoss;
  const gapNow = car.interval;

  return {
    target,
    compound: fit,
    gapNow,
    perLapGain: myGain,
    swing,
    // You need the swing to cover the gap you are currently behind by.
    works: swing > gapNow && gapNow < 2.6,
    marginal: swing > gapNow * 0.7 && gapNow < 3.2,
    verdict: swing > gapNow && gapNow < 2.6 ? 'on'
      : swing > gapNow * 0.7 && gapNow < 3.2 ? 'marginal' : 'off',
  };
}

function bestAvailableCompound(race, car) {
  const wet = race.weather.wetness;
  if (wet > 0.5) return 'wet';
  if (wet > 0.18) return 'inter';
  const left = race.lapsTotal - car.lap;
  return left < 14 ? 'soft' : left < 26 ? 'medium' : 'hard';
}

/**
 * What pushing actually buys and costs, in the units a principal decides in:
 * seconds a lap gained, laps of tyre life given up, and how much more likely
 * the driver is to bin it.
 */
export function pushTrade(race, car) {
  const base = race.currentLapTime(car);
  const wearNeutral = wearRateFor(race, car, 'neutral');
  const wearPush = wearRateFor(race, car, 'push');
  const wearSave = wearRateFor(race, car, 'conserve');

  // Lap time in each mode, from the same function the race uses.
  const prevMode = car.mode;
  car.mode = 'push'; const tPush = race.currentLapTime(car);
  car.mode = 'conserve'; const tSave = race.currentLapTime(car);
  car.mode = 'neutral'; const tNeutral = race.currentLapTime(car);
  car.mode = prevMode;

  const lapsLeftNeutral = wearNeutral > 1e-6 ? (0.92 - car.wear) / wearNeutral : 99;
  const lapsLeftPush = wearPush > 1e-6 ? (0.92 - car.wear) / wearPush : 99;
  const lapsLeftSave = wearSave > 1e-6 ? (0.92 - car.wear) / wearSave : 99;

  // Mistake probability per lap, mirroring rollMistake().
  const cons = car.driver.consistency ?? 0.88;
  const riskBase = 0.065 * (1 - cons) * (1 + race.weather.wetness * 1.9)
    * (1 + Math.max(0, car.wear - 0.7) * 1.4);

  return {
    gain: tNeutral - tPush,            // seconds a lap faster when pushing
    save: tSave - tNeutral,            // seconds a lap slower when conserving
    lapsLeftNeutral, lapsLeftPush, lapsLeftSave,
    lifeCostPush: lapsLeftNeutral - lapsLeftPush,
    lifeGainSave: lapsLeftSave - lapsLeftNeutral,
    riskNeutral: riskBase,
    riskPush: riskBase * 1.55,
    riskSave: riskBase * 0.72,
    current: base,
  };
}

/** Fuel: how many laps you can do, against how many are left. */
export function fuelOutlook(race, car) {
  const perLap = 0.335 * (race.track.length / 1000);
  const lapsLeft = race.lapsTotal - car.lap;
  const modeMul = car.mode === 'push' ? 1.055 : car.mode === 'conserve' ? 0.935 : 1;
  const lapsOfFuel = car.fuel / (perLap * modeMul);
  const margin = lapsOfFuel - lapsLeft;
  return {
    kg: car.fuel,
    lapsOfFuel,
    lapsLeft,
    margin,
    short: margin < 0,
    // How much lift-and-coast is needed to make it, in seconds a lap.
    saveNeeded: margin < 0 ? Math.min(1.2, (-margin / Math.max(1, lapsLeft)) * 14) : 0,
  };
}

/**
 * Everything at once, plus a single sentence saying what it all implies.
 * The sentence is the point: a number nobody reads is not data.
 */
export function strategyBrief(race, car) {
  if (car.status === 'retired') return { retired: true };
  const tyre = tyreOutlook(race, car);
  const fuel = fuelOutlook(race, car);
  const push = pushTrade(race, car);
  const pit = pitCost(race, car);
  const rejoin = rejoinProjection(race, car);
  const uc = undercut(race, car);
  const lapsLeft = race.lapsTotal - car.lap;

  // The pit window: stop early enough that the tyre reaches the flag, late
  // enough that you are not fitting a set you will have to replace again.
  const stopsLeftIfBoxNow = Math.max(0, Math.ceil((lapsLeft - tyre.lapsUsable) / Math.max(1, tyre.lapsUsable)));
  const canReachEnd = tyre.lapsUsable >= lapsLeft;
  const windowOpens = Math.max(0, Math.round(lapsLeft - tyre.lapsUsable));

  let call, urgency;
  if (lapsLeft <= 1) {
    call = 'Last lap. Bring it home.'; urgency = 'none';
  } else if (fuel.short && fuel.saveNeeded > 0.3) {
    call = `Fuel is short by ${Math.abs(fuel.margin).toFixed(1)} laps. He has to lift and coast — put him on conserve or he will not finish.`;
    urgency = 'high';
  } else if (tyre.pastCliff) {
    call = `The tyre is gone — costing ${tyre.lossNow.toFixed(1)}s a lap. Box now; every lap out here is a lost place.`;
    urgency = 'high';
  } else if (tyre.lapsUsable < 2.5 && lapsLeft > 5) {
    call = `Tyre is done in ${tyre.lapsUsable.toFixed(0)} laps. Box now or commit to nursing it.`;
    urgency = 'high';
  } else if (uc && uc.verdict === 'on') {
    call = `Undercut is on: ${uc.swing.toFixed(1)}s of swing against a ${uc.gapNow.toFixed(1)}s gap. Box this lap and you come out ahead of ${uc.target.driver.name}.`;
    urgency = 'act';
  } else if (canReachEnd && lapsLeft < 12 && car.mode !== 'push') {
    call = `The tyre will reach the flag. Nothing left to save — send him.`;
    urgency = 'act';
  } else if (car.dirtyAir > 0.45 && car.interval < 1.2) {
    call = `Stuck in dirty air, losing ${(car.dirtyAir * 0.0145 * car.model.perGripLoss).toFixed(1)}s a lap and eating the tyres. Either he passes in the next few laps or you stop and undercut.`;
    urgency = 'act';
  } else if (tyre.state === 'healthy' && lapsLeft > tyre.lapsUsable + 4) {
    call = `Nothing to do yet. Pit window opens in about ${windowOpens} laps.`;
    urgency = 'none';
  } else if (canReachEnd) {
    call = `He can run to the end on this set. Hold pace unless someone forces your hand.`;
    urgency = 'none';
  } else {
    call = `One more stop needed. Window is open now — ${tyre.lapsUsable.toFixed(0)} laps of tyre against ${lapsLeft} to run.`;
    urgency = 'act';
  }

  return {
    tyre, fuel, push, pit, rejoin, undercut: uc,
    lapsLeft, canReachEnd, windowOpens, stopsLeftIfBoxNow,
    call, urgency,
  };
}

/**
 * Proactive engineer calls. The race engine narrates what happened; this
 * narrates what is about to. Each returns at most one message per car per lap,
 * so the radio stays readable.
 */
export function engineerCalls(race, car, memo) {
  const out = [];
  if (car.status !== 'running') return out;
  const lap = car.lap;
  const said = (key, laps = 6) => {
    const last = memo[key];
    if (last != null && lap - last < laps) return true;
    memo[key] = lap;
    return false;
  };

  const tyre = tyreOutlook(race, car);
  const fuel = fuelOutlook(race, car);
  const lapsLeft = race.lapsTotal - car.lap;

  if (tyre.pastCliff && !said('cliff', 4)) {
    out.push({ p: 'high', text: `Tyres are past the cliff — we are losing ${tyre.lossNow.toFixed(1)} a lap. We need to box.` });
  } else if (tyre.lapsUsable < 3 && lapsLeft > 5 && !said('tyreEnd', 5)) {
    out.push({ p: 'high', text: `Three laps of tyre left, maybe less. Decide on the stop.` });
  } else if (tyre.lapsUsable < 7 && lapsLeft > 8 && !said('window', 8)) {
    out.push({ p: 'normal', text: `Pit window is open. Tyres good for about ${tyre.lapsUsable.toFixed(0)} more.` });
  }

  if (fuel.short && fuel.saveNeeded > 0.25 && !said('fuel', 6)) {
    out.push({ p: 'high', text: `Fuel is ${Math.abs(fuel.margin).toFixed(1)} laps short. We need lift and coast from here.` });
  }

  const uc = undercut(race, car);
  if (uc && uc.verdict === 'on' && !said('undercut', 6)) {
    out.push({ p: 'high', text: `${uc.target.driver.name} is ${uc.gapNow.toFixed(1)} up the road and the undercut is on. Box this lap and we have him.` });
  }

  if (car.dirtyAir > 0.5 && car.interval < 1.0 && !said('dirty', 7)) {
    out.push({ p: 'normal', text: `We are in his dirty air, losing front end and killing the tyres. We need to do something with this.` });
  }

  // Someone behind has stopped and is coming at us on fresh rubber.
  const order = race.order || race.updateOrder();
  const idx = order.indexOf(car);
  const chaser = order[idx + 1];
  if (chaser && chaser.status === 'running' && chaser.stops > car.stops
      && chaser.interval < 3.5 && chaser.wear < 0.3 && !said('chased', 6)) {
    out.push({ p: 'high', text: `${chaser.driver.name} has stopped and is ${chaser.interval.toFixed(1)} behind on new tyres. He will be on us in two laps.` });
  }

  if (lapsLeft === 5 && !said('fiveToGo', 99)) {
    out.push({ p: 'normal', text: `Five laps to go. P${car.position}.` });
  }

  return out;
}
