import { CIRCUITS } from '../src/data/circuits.js';
import { buildTrack } from '../src/mgmt/track.js';
import { makeSpec, AREA_IDS, specRating } from '../src/mgmt/carspec.js';
import { buildCalendar } from '../src/mgmt/calendar.js';
import { seedGrid } from '../src/mgmt/personnel.js';
import { makeFacilities } from '../src/mgmt/facilities.js';
import { initRival } from '../src/mgmt/rivals.js';
import { createWeekend, fmtLap, fmtGap } from '../src/mgmt/raceengine.js';
import { makeRng } from '../src/mgmt/rng.js';

const rng = makeRng(Number(process.argv[3] || 7));
const { teams } = seedGrid(20260);
for (const t of teams) {
  initRival(t, rng);
  const lvl = 30 + (t.performance - 0.84) * 260;   // 0.84 -> 30, 0.99 -> 69
  t.spec = makeSpec(lvl);
  for (const id of AREA_IDS) t.spec[id] = Math.max(5, Math.round((lvl + rng.normal(0, 6)) * 10) / 10);
  t.facilities = makeFacilities(Math.max(1, Math.round(1 + t.resources * 2.4)));
  t.staff = { technical: { rating: 0.6 + t.resources * 0.3 }, aero: { rating: 0.6 + t.resources * 0.28 }, power: { rating: 0.6 + t.resources * 0.26 }, design: { rating: 0.6 + t.resources * 0.26 }, reliability: { rating: 0.6 + t.resources * 0.24 }, race: { rating: 0.6 + t.resources * 0.3 } };
}

const cal = buildCalendar();
const round = cal[Number(process.argv[2] || 0)];
const track = buildTrack(round.circuit);
const entries = [];
for (const t of teams) for (const d of t.drivers) entries.push({ team: t, driver: d, spec: t.spec, facilities: t.facilities, isPlayer: t.id === 'halcyon' });

const race = createWeekend({ track, round, entries, rng });
race.runPractice(0.6);
const grid = race.runQualifying();
console.log(`\n=== ${round.name} — ${round.venue} (${round.laps} laps) ===`);
console.log('QUALIFYING');
grid.slice(0, 20).forEach((c, i) => {
  const gap = i === 0 ? '' : ` (+${(c.quali - grid[0].quali).toFixed(3)})`;
  console.log(` ${String(i+1).padStart(2)} ${c.driver.name.padEnd(18)} ${c.team.short}  ${fmtLap(c.quali)}${gap}`);
});
race.startRace();
const t0 = Date.now();
const res = race.simulateToEnd();
const ms = Date.now() - t0;
console.log(`\nRESULT  (simulated in ${ms}ms, race time ${(race.time/60).toFixed(1)} min)`);
for (const r of res) {
  const pos = r.position ? String(r.position).padStart(2) : ' -';
  const st = r.status === 'retired' ? `DNF (${r.reason})` : `${r.stops} stop${r.stops===1?'':'s'}  best ${fmtLap(r.bestLap)}`;
  console.log(` ${pos} ${r.driver.name.padEnd(18)} ${r.team.short}  grid ${String(r.gridPos).padStart(2)}  ${r.gained>0?'+':''}${r.gained}  ${st}${r.isPlayer?'   <-- YOU':''}`);
}
console.log(`\nFastest lap: ${race.fastestLap ? race.fastestLap.driver + ' ' + fmtLap(race.fastestLap.time) + ' (lap ' + race.fastestLap.lap + ')' : '—'}`);
console.log(`Retirements: ${race.retirements}   Weather: ${race.weather.state} (wetness ${race.weather.wetness.toFixed(2)})`);
console.log('\nFEED (last 18)');
for (const f of race.feed.slice(-18)) console.log(`  L${String(f.lap).padStart(2)} [${f.kind}] ${f.text}`);
