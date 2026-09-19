/**
 * Headless balance harness. Runs N seasons and reports whether the
 * championship stays competitive and whether rivals develop on their own.
 */
import { newGame, constructorsTable, driversTable, playerTeam } from '../src/mgmt/state.js';
import { simulateRound, endSeason, seasonComplete, autoSignSponsors, autoAllocation } from '../src/mgmt/season.js';
import { specRating, AREA_IDS } from '../src/mgmt/carspec.js';
import { doctrineName } from '../src/mgmt/rivals.js';

const SEASONS = Number(process.argv[2] || 5);
const SEED = Number(process.argv[3] || 42);
const PLAYER = process.argv[4] || 'halcyon';

const state = newGame({ seed: SEED, playerTeamId: PLAYER });
state.settings.autoStrategy = true;

console.log(`APEX: Principal — ${SEASONS} seasons, seed ${SEED}, playing as ${playerTeam(state).name}\n`);

const champs = [];
for (let s = 0; s < SEASONS; s++) {
  autoSignSponsors(state);
  while (!seasonComplete(state)) simulateRound(state, { allocation: autoAllocation(state), practice: 0.6 });
  const t = constructorsTable(state);
  const d = driversTable(state);
  const res = endSeason(state);
  champs.push(t[0].team.id);
  console.log(`--- SEASON ${s + 1} ---`);
  console.log(t.map((r, i) => `${String(i+1).padStart(2)} ${r.team.short} ${String(r.points).padStart(4)}  car ${specRating(r.team.spec).toFixed(1).padStart(5)}  ${doctrineName(r.team.doctrine).padEnd(16)} comp ${(r.team.competence??1).toFixed(2)}${r.team.id===PLAYER?'  <-- YOU':''}`).join('\n'));
  const rr = state.teams.map(x=>specRating(x.spec));
  console.log(`   car spread ${(Math.max(...rr)-Math.min(...rr)).toFixed(1)}`);
  const led = state.player.ledger.filter(e => e.season === s + 1);
  const by = {};
  for (const e of led) by[e.kind] = (by[e.kind] || 0) + e.amount;
  console.log(`   champion: ${d[0].driver.name} (${d[0].team.short}) ${d[0].points}pts   |   balance $${state.player.balance.toFixed(1)}M   |   ${res.regulation.name}`);
  console.log('   cashflow: ' + Object.entries(by).map(([k,v]) => `${k} ${v>0?'+':''}${v.toFixed(1)}`).join('  ') + `  | sponsors ${state.player.sponsors.length}`);
  console.log('');
}

console.log('=== spread check ===');
const t = constructorsTable(state);
const ratings = state.teams.map(x => specRating(x.spec));
console.log('car rating  best', Math.max(...ratings).toFixed(1), ' worst', Math.min(...ratings).toFixed(1), ' spread', (Math.max(...ratings)-Math.min(...ratings)).toFixed(1));
console.log('points      P1', t[0].points, ' P10', t[9].points);
const uniq = [...new Set(champs)];
console.log('different constructors champions over', SEASONS, 'seasons:', uniq.length, '->', uniq.join(', '));
