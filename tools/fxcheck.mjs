/**
 * Does anything ask the view for smoke? A headless run drains the effect queue
 * the renderer would drain, and counts what it was asked for.
 */
import { CIRCUITS } from '../src/data/circuits.js';
import { buildTrack } from '../src/mgmt/track.js';
import { makeSpec, AREA_IDS } from '../src/mgmt/carspec.js';
import { buildCalendar } from '../src/mgmt/calendar.js';
import { seedGrid } from '../src/mgmt/personnel.js';
import { makeFacilities } from '../src/mgmt/facilities.js';
import { initRival } from '../src/mgmt/rivals.js';
import { createWeekend } from '../src/mgmt/raceengine.js';
import { makeRng } from '../src/mgmt/rng.js';

let smoke = 0, dust = 0, races = 0, events = 0;
for (let seed = 1; seed <= 8; seed++) {
  const rng = makeRng(seed);
  const { teams } = seedGrid(20260 + seed);
  for (const t of teams) {
    initRival(t, rng);
    const lvl = 30 + (t.performance - 0.84) * 260;
    t.spec = makeSpec(lvl);
    for (const id of AREA_IDS) t.spec[id] = Math.max(5, Math.round((lvl + rng.normal(0, 6)) * 10) / 10);
    t.facilities = makeFacilities(Math.max(1, Math.round(1 + t.resources * 2.4)));
    t.staff = {};
  }
  const cal = buildCalendar();
  const round = cal[seed % cal.length];
  const track = buildTrack(round.circuit);
  const entries = [];
  for (const t of teams) for (const d of t.drivers) entries.push({ team: t, driver: d, spec: t.spec, facilities: t.facilities, isPlayer: t.id === 'halcyon' });
  const race = createWeekend({ track, round, entries, rng, autoStrategy: true });
  race.runPractice(0.6);
  race.runQualifying();
  race.startRace();
  let guard = 0;
  while (race.state === 'racing' && guard++ < 80000) {
    race.step(0.25);
    for (const f of race.fx) { events++; if (f.kind === 'smoke') smoke += f.count; else dust += f.count; }
    race.fx.length = 0;
  }
  races++;
}
console.log(`${races} races · ${events} effects asked for · ${smoke} smoke, ${dust} dust · ${(events / races).toFixed(1)} per race`);
