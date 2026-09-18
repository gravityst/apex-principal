import { CIRCUITS } from '../src/data/circuits.js';
import { buildTrack } from '../src/mgmt/track.js';
import { makeSpec, toPhysics, AREA_IDS } from '../src/mgmt/carspec.js';
import { solveLap, areaValue } from '../src/mgmt/laptime.js';

const fmt = (t) => { const m = Math.floor(t/60), s = t - m*60; return `${m}:${s.toFixed(3).padStart(6,'0')}`; };

console.log('=== raw solver vs published lap record ===');
const tracks = {};
for (const c of CIRCUITS) {
  const t = buildTrack(c); tracks[c.id] = t;
  const phys = toPhysics(makeSpec(88));
  const r = solveLap(t, phys, { fuelKg: 12 });
  console.log(
    c.id.padEnd(15), 'record', fmt(c.lapRecord),
    '| raw', fmt(r.raw), '| cal', r.cal.toFixed(3),
    '| calibrated', fmt(r.time),
    '| vmax', (r.vmax*3.6).toFixed(0)+'km/h',
    '| vavg', (r.vavg*3.6).toFixed(0)+'km/h');
}

console.log('\n=== spec level -> lap time (Aurora Bay, 12kg fuel) ===');
for (const lvl of [10,30,50,70,90,100]) {
  const r = solveLap(tracks['aurora-bay'], toPhysics(makeSpec(lvl)), { fuelKg: 12 });
  console.log(`level ${String(lvl).padStart(3)}  ${fmt(r.time)}   vmax ${(r.vmax*3.6).toFixed(0)} km/h`);
}

console.log('\n=== seconds gained per +10 development, by circuit ===');
const spec = makeSpec(60);
const hdr = AREA_IDS.map(a=>a.slice(0,5).padStart(6)).join('');
console.log('circuit'.padEnd(16)+hdr);
for (const c of CIRCUITS) {
  const v = areaValue(tracks[c.id], spec, toPhysics, AREA_IDS, { fuelKg: 60 });
  console.log(c.id.padEnd(16) + AREA_IDS.map(a=>v[a].toFixed(3).padStart(6)).join(''));
}

console.log('\n=== fuel + wear sensitivity (Aurora Bay, level 60) ===');
const t = tracks['aurora-bay'], p = toPhysics(makeSpec(60));
for (const f of [0, 50, 100]) {
  const r = solveLap(t, p, { fuelKg: f });
  console.log(`fuel ${String(f).padStart(3)}kg  ${fmt(r.time)}`);
}
for (const g of [1.0, 0.95, 0.90, 0.85]) {
  const r = solveLap(t, p, { fuelKg: 50, tyreGrip: g });
  console.log(`grip ${g.toFixed(2)}   ${fmt(r.time)}`);
}
