/**
 * APEX: Principal — factory, finance and personnel screens.
 */

import { h, mount, panel, kv, meter, money, pct, ordinal, modal, confirmDialog, teamBar, signed } from './dom.js';
import { AREAS, AREA_IDS, toPhysics, specRating } from '../mgmt/carspec.js';
import { areaValue } from '../mgmt/laptime.js';
import { getTrack } from '../mgmt/track.js';
import { expectedPoints, costPerPoint, allocateByWeights, developmentAdvice, OUTCOME_TEXT } from '../mgmt/rnd.js';
import { FACILITIES, upgradeCost, facilityUpkeep, facilityMultiplier } from '../mgmt/facilities.js';
import { STAFF_ROLES, staffMultiplier, staffSalary, generateStaff, driverSalary } from '../mgmt/personnel.js';
import { canSign, SPONSOR_SLOTS, BUDGET_CAP } from '../mgmt/finance.js';
import {
  playerTeam, roundBudget, seasonCosts, spend, constructorsPosition, pushNews,
} from '../mgmt/state.js';
import { runRoundDevelopment, currentRound, seasonComplete } from '../mgmt/season.js';
import { makeRng, subSeed } from '../mgmt/rng.js';

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function developmentPending(state) {
  return !seasonComplete(state) && state.player.developedForRound !== state.round;
}

export function renderFactory(app, root) {
  const state = app.state;
  const team = playerTeam(state);
  const budget = roundBudget(state);
  const pending = developmentPending(state);
  const weights = state.player.allocation;

  // Engineering advice for what is left of the calendar.
  const remaining = state.calendar.slice(state.round);
  const tracks = {};
  for (const r of remaining) tracks[r.circuitId] = getTrack(r.circuit);
  const advice = developmentAdvice(tracks, team.spec, toPhysics, areaValue, remaining, { fuelKg: 55 });
  const adviceRank = new Map(advice.map((a, i) => [a.area, i]));
  const bestValue = advice[0] ? advice[0].valuePerMillion : 1;

  const rows = h('div', {});

  function redraw() {
    const alloc = allocateByWeights(budget, weights);
    rows.replaceChildren(...AREAS.map((a) => {
      const level = team.spec[a.id] ?? 0;
      const spendHere = alloc[a.id] ?? 0;
      const exp = expectedPoints(spendHere, level, team.facilities, team.staff, a.id);
      const adv = advice.find((x) => x.area === a.id);
      const rank = adviceRank.get(a.id);

      const slider = h('input', {
        type: 'range', min: '0', max: '100', value: String(Math.round((weights[a.id] ?? 0) * 100)),
        class: 'slider',
        oninput: (e) => { weights[a.id] = Number(e.target.value) / 100; redraw(); },
      });

      return h('div', {
        style: {
          padding: '11px 0', borderBottom: '1px solid rgba(26,37,54,.6)',
          display: 'grid', gridTemplateColumns: 'minmax(0,1.25fr) minmax(0,1fr)', gap: '14px', alignItems: 'center',
        },
      },
        h('div', {},
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px' } },
            h('b', { style: { fontSize: '13.5px' } }, a.name),
            rank < 3 ? h('span', { class: 'tiny', style: { color: 'var(--accent-2)', fontWeight: '700' } }, ['BEST VALUE', '2ND', '3RD'][rank]) : null,
            h('span', { class: 'mono dim', style: { marginLeft: 'auto', fontSize: '12px' } }, level.toFixed(1))),
          meter(level, 100, level >= 75 ? 'var(--purple)' : level >= 55 ? 'var(--accent-2)' : 'var(--warn)'),
          h('div', { class: 'tiny dim', style: { marginTop: '5px' } }, a.blurb)),
        h('div', {},
          slider,
          h('div', { class: 'tiny', style: { display: 'flex', gap: '12px', color: 'var(--ink-3)' } },
            h('span', {}, money(spendHere)),
            h('span', { class: exp > 0 ? 'good' : '' }, `≈ +${exp.toFixed(1)} pts`),
            h('span', {}, `${money(costPerPoint(level))}/pt`))));
    }));
  }
  redraw();

  const presets = h('div', { class: 'btnrow', style: { marginBottom: '12px' } },
    h('button', {
      class: 'btn sm', onClick: () => {
        for (const a of AREA_IDS) weights[a] = 1 / AREA_IDS.length;
        redraw();
      },
    }, 'Spread evenly'),
    h('button', {
      class: 'btn sm', onClick: () => {
        let i = 0;
        for (const a of advice) { weights[a.area] = Math.max(0.08, 1 - i * 0.12); i++; }
        redraw();
      },
    }, 'Follow the engineers'),
    h('button', {
      class: 'btn sm', onClick: () => {
        for (const a of AREA_IDS) weights[a] = 0;
        weights[advice[0].area] = 1;
        redraw();
      },
    }, 'All-in on the best area'),
    h('button', {
      class: 'btn sm', onClick: () => {
        for (const a of AREA_IDS) weights[a] = 0.25;
        weights.reliability = 1; weights.tyres = 0.8;
        redraw();
      },
    }, 'Fix reliability'));

  const runBtn = h('button', {
    class: 'btn primary',
    disabled: !pending || budget <= 0.05,
    onClick: () => {
      const res = runRoundDevelopment(state, weights);
      state.player.developedForRound = state.round;
      app.save();
      showReport(app, res);
    },
  }, pending ? `Commit ${money(budget)} to development` : 'Development already run this round');

  const left = panel('Research and development',
    `round ${Math.min(state.round + 1, state.calendar.length)} · cap used ${money(state.player.seasonSpend)} of ${money(BUDGET_CAP)}`,
    h('p', { class: 'small muted', style: { marginTop: '-4px', marginBottom: '12px' } },
      'Set where the money goes. Every point delivered changes a real number on the car, and the wind tunnel decides how much of it survives contact with the track.'),
    presets, rows,
    h('div', { style: { marginTop: '14px', display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' } },
      runBtn,
      h('span', { class: 'small dim' }, pending
        ? `Budget this round: ${money(budget)}. Rivals develop at the same time.`
        : 'Come back next round.')));

  const advicePanel = panel('Your engineers say', `over the ${remaining.length} rounds left`,
    advice.map((a, i) => {
      const area = AREAS.find((x) => x.id === a.area);
      return h('div', { class: 'arearow' },
        h('span', { class: 'nm' }, area.short),
        meter(a.valuePerMillion, Math.max(1e-6, bestValue), i === 0 ? 'var(--accent-2)' : 'var(--ink-3)'),
        h('span', { class: 'vl' }, a.secondsPerTen > 0.001 ? `${a.secondsPerTen.toFixed(1)}s` : '—'));
    }),
    h('p', { class: 'tiny dim', style: { marginTop: '10px' } },
      'Total seconds gained across every remaining lap of the season per +10 development, weighted against what those points cost you now. Tyres and reliability are not measured on a single lap; judge them by how your races actually end.'));

  const lastReport = state.player.lastReport
    ? panel('Last delivery', null,
      state.player.lastReport.map((r) => {
        const area = AREAS.find((x) => x.id === r.area);
        return h('div', { class: 'kv' },
          h('span', { class: 'k' }, area.name),
          h('span', {},
            h('span', { class: `outcome ${r.outcome}` }, r.outcome),
            h('span', { class: 'mono', style: { marginLeft: '10px' } }, `${signed(r.gained, 2)}`)));
      }))
    : null;

  mount(root, h('div', { class: 'grid g-side' },
    h('div', { class: 'grid' }, left, renderFacilities(app)),
    h('div', { class: 'grid' }, advicePanel, lastReport)));
}

function showReport(app, res) {
  const rows = res.player.report;
  const close = modal(
    h('h2', {}, 'Development report'),
    h('p', { class: 'muted small' }, `${money(res.player.spent)} spent. The tunnel and the track do not always agree.`),
    h('table', { style: { marginTop: '14px' } },
      h('thead', {}, h('tr', {}, h('th', {}, 'Department'), h('th', { class: 'r' }, 'Spent'),
        h('th', { class: 'r' }, 'Expected'), h('th', { class: 'r' }, 'Delivered'), h('th', {}, 'Outcome'))),
      h('tbody', {}, rows.length ? rows.map((r) => {
        const area = AREAS.find((x) => x.id === r.area);
        return h('tr', {},
          h('td', {}, area.name),
          h('td', { class: 'r mono dim' }, money(r.spend)),
          h('td', { class: 'r mono dim' }, `+${r.expected.toFixed(1)}`),
          h('td', { class: 'r mono', style: { fontWeight: '700', color: r.gained < 0 ? 'var(--bad)' : 'var(--ink)' } }, signed(r.gained, 2)),
          h('td', { class: 'small' }, h('span', { class: `outcome ${r.outcome}` }, r.outcome)));
      }) : h('tr', {}, h('td', { colspan: '5', class: 'dim' }, 'Nothing was spent.')))),
    h('div', { style: { marginTop: '14px' } },
      ...[...new Set(rows.map((r) => r.outcome))]
        .filter((o) => o === 'breakthrough' || o === 'dud')
        .map((o) => h('p', { class: 'small', style: { color: o === 'dud' ? 'var(--bad)' : 'var(--purple)' } }, OUTCOME_TEXT[o]))),
    h('div', { class: 'btnrow', style: { marginTop: '18px' } },
      h('button', { class: 'btn primary', onClick: () => { close(); app.render(); } }, 'Understood'),
      h('button', { class: 'btn go', onClick: () => { close(); app.goto('weekend'); } }, 'To the race weekend →')));
}

// ---------------------------------------------------------------------------
// Facilities
// ---------------------------------------------------------------------------

export function renderFacilities(app) {
  const state = app.state;
  const team = playerTeam(state);
  return panel('Facilities', `upkeep ${money(facilityUpkeep(team.facilities))} a season`,
    FACILITIES.map((f) => {
      const lvl = team.facilities[f.id] ?? 1;
      const cost = upgradeCost(team.facilities, f.id);
      const affordable = cost != null && state.player.balance >= cost;
      return h('div', {
        style: { padding: '10px 0', borderBottom: '1px solid rgba(26,37,54,.6)', display: 'flex', gap: '14px', alignItems: 'center' },
      },
        h('div', { style: { flex: '1', minWidth: '0' } },
          h('div', { style: { display: 'flex', gap: '8px', alignItems: 'baseline' } },
            h('b', { style: { fontSize: '13.5px' } }, f.name),
            h('span', { class: 'tiny dim' }, f.levels[lvl - 1].name)),
          meter(lvl, f.levels.length, 'var(--accent)', 'thin'),
          h('div', { class: 'tiny dim', style: { marginTop: '5px' } }, f.blurb)),
        h('div', { style: { textAlign: 'right', minWidth: '110px' } },
          cost == null
            ? h('span', { class: 'tiny good' }, 'Fully developed')
            : h('button', {
              class: 'btn sm', disabled: !affordable,
              onClick: () => confirmDialog(`Upgrade the ${f.name.toLowerCase()}?`,
                `${f.levels[lvl].name} — ${money(cost)} now, and upkeep rises to ${money(f.levels[lvl].upkeep)} a season.`,
                'Commission it', () => {
                  spend(state, cost, `${f.name} upgrade`, 'facility');
                  team.facilities[f.id] = lvl + 1;
                  pushNews(state, 'facility', `${team.name} commission a ${f.levels[lvl].name.toLowerCase()}.`);
                  app.save(); app.render();
                }),
            }, `Upgrade ${money(cost)}`)));
    }));
}

// ---------------------------------------------------------------------------
// Finance
// ---------------------------------------------------------------------------

export function renderFinance(app, root) {
  const state = app.state;
  const p = state.player;
  const team = playerTeam(state);
  const costs = seasonCosts(state);

  const bySeason = {};
  for (const e of p.ledger) {
    const s = bySeason[e.season] = bySeason[e.season] || {};
    s[e.kind] = (s[e.kind] || 0) + e.amount;
  }
  const thisSeason = bySeason[state.season] || {};

  const summary = panel('This season', null,
    kv('Balance', money(p.balance), p.balance < 0 ? 'bad' : 'good'),
    kv('Development cap', `${money(p.seasonSpend)} of ${money(BUDGET_CAP)}`),
    ...Object.entries(thisSeason).sort((a, b) => b[1] - a[1]).map(([k, v]) =>
      kv(k.charAt(0).toUpperCase() + k.slice(1), money(v), v >= 0 ? 'good' : 'bad')),
    h('div', { style: { height: '10px' } }),
    kv('Driver + staff wages', money(costs.wages)),
    kv('Facility upkeep', money(costs.upkeep)),
    kv('Base operating', money(costs.operating)),
    kv('Total running cost', money(costs.total), 'bad'));

  const held = panel('Sponsors', `${p.sponsors.length} under contract`,
    p.sponsors.length ? p.sponsors.map((s) => h('div', { class: 'offer' },
      h('div', { class: 'hd' },
        h('span', { class: `tierbadge ${s.tier}` }, s.tier),
        h('b', {}, s.name),
        h('span', { class: 'fee' }, `${money(s.fee)}/season`)),
      h('ul', {}, s.clauses.map((c) => h('li', {}, `${c.label} — ${money(c.amount)} bonus`))),
      h('div', { class: 'tiny dim' }, `Signed season ${s.signedSeason} · ${s.years} year${s.years === 1 ? '' : 's'} · expires after season ${s.signedSeason + s.years - 1}`)))
      : h('p', { class: 'dim small' }, 'No sponsors under contract. That is going to hurt.'));

  const slots = Object.entries(SPONSOR_SLOTS)
    .map(([t, n]) => `${p.sponsors.filter((s) => s.tier === t).length}/${n} ${t}`).join(' · ');

  const market = panel('Sponsor market', slots,
    p.sponsorMarket.length ? p.sponsorMarket.map((s) => {
      const allowed = canSign(p.sponsors, s.tier);
      return h('div', { class: 'offer' },
        h('div', { class: 'hd' },
          h('span', { class: `tierbadge ${s.tier}` }, s.tier),
          h('b', {}, s.name),
          h('span', { class: 'fee' }, `${money(s.fee)}/season`)),
        h('ul', {}, s.clauses.map((c) => h('li', {}, `${c.label} — ${money(c.amount)} bonus`))),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
          h('button', {
            class: 'btn sm', disabled: !allowed,
            onClick: () => {
              s.signedSeason = state.season;
              p.sponsors.push(s);
              p.sponsorMarket = p.sponsorMarket.filter((x) => x !== s);
              pushNews(state, 'sponsor', `${team.name} sign ${s.name} as a ${s.tier} partner.`);
              app.save(); app.render();
            },
          }, allowed ? 'Sign' : 'No slot free'),
          h('span', { class: 'tiny dim' }, `${s.years} year deal`)));
    }) : h('p', { class: 'dim small' }, 'Nothing on the table right now. The market refreshes over the winter.'));

  const ledger = panel('Ledger', `season ${state.season}`,
    h('div', { style: { maxHeight: '420px', overflowY: 'auto' } },
      h('table', {}, h('tbody', {},
        p.ledger.filter((e) => e.season === state.season).slice().reverse().map((e) =>
          h('tr', {}, h('td', { class: 'small' }, e.label),
            h('td', { class: 'r mono', style: { color: e.amount >= 0 ? 'var(--good)' : 'var(--ink-2)' } }, money(e.amount))))))));

  mount(root, h('div', { class: 'grid g-side' },
    h('div', { class: 'grid' }, market, held),
    h('div', { class: 'grid' }, summary, ledger)));
}

// ---------------------------------------------------------------------------
// Personnel
// ---------------------------------------------------------------------------

export function renderTeam(app, root) {
  const state = app.state;
  const team = playerTeam(state);

  const drivers = panel('Drivers', null, team.drivers.map((d) => h('div', { class: 'offer' },
    h('div', { class: 'hd' },
      h('b', {}, `#${d.num}  ${d.name}`),
      h('span', { class: 'fee' }, `${money(d.salary ?? 0)}/season`)),
    h('div', { class: 'tiny dim', style: { marginBottom: '9px' } },
      `${d.country} · age ${d.age} · ${d.contractYears > 0 ? `${d.contractYears} year${d.contractYears === 1 ? '' : 's'} left` : 'contract expiring'}`),
    ratingRow('Skill', d.skill),
    ratingRow('Consistency', d.consistency),
    ratingRow('Aggression', d.aggression),
    ratingRow('Wet weather', d.wet),
    ratingRow('Temperament', d.temperament, true),
    h('div', { style: { height: '6px' } }),
    ratingRow('Morale', d.morale, false, d.morale > 0.72 ? 'var(--good)' : d.morale < 0.45 ? 'var(--bad)' : 'var(--warn)'),
    h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Form'),
      h('span', { class: `v ${d.form > 0.15 ? 'good' : d.form < -0.15 ? 'bad' : ''}` },
        d.form > 0.4 ? 'On a roll' : d.form > 0.15 ? 'Going well' : d.form < -0.4 ? 'In a slump' : d.form < -0.15 ? 'Struggling' : 'Level')),
    h('p', { class: 'tiny dim', style: { marginTop: '8px' } }, temperamentNote(d)))));

  const staff = panel('Technical staff', `wage bill ${money(Object.values(team.staff).reduce((a, s) => a + (s?.salary ?? 0), 0))}`,
    STAFF_ROLES.map((role) => {
      const s = team.staff[role.id];
      const effect = role.affects.length
        ? `×${staffMultiplier(team.staff, role.affects[0]).toFixed(2)} on ${role.affects.map((a) => AREAS.find((x) => x.id === a).short).join(', ')}`
        : 'setup work and strategy';
      return h('div', { style: { padding: '10px 0', borderBottom: '1px solid rgba(26,37,54,.6)' } },
        h('div', { style: { display: 'flex', gap: '10px', alignItems: 'baseline' } },
          h('b', { style: { fontSize: '13.5px' } }, role.name),
          h('span', { class: 'tiny dim', style: { marginLeft: 'auto' } }, money(s?.salary ?? 0))),
        h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', marginTop: '6px' } },
          h('span', { class: 'small', style: { minWidth: '120px' } }, s ? s.name : h('span', { class: 'bad' }, 'Vacant')),
          meter((s?.rating ?? 0) * 100, 100, ratingColour(s?.rating ?? 0)),
          h('span', { class: 'mono tiny', style: { minWidth: '34px', textAlign: 'right' } }, s ? (s.rating * 100).toFixed(0) : '—'),
          h('button', { class: 'btn sm', onClick: () => openStaffMarket(app, role) }, 'Market')),
        h('div', { class: 'tiny dim', style: { marginTop: '5px' } }, `${role.blurb} · ${effect}`));
    }));

  mount(root, h('div', { class: 'grid g-side' }, drivers, h('div', { class: 'grid' }, staff, renderFacilities(app))));
}

function ratingRow(label, v, invert = false, colour = null) {
  const val = v ?? 0;
  return h('div', { style: { display: 'grid', gridTemplateColumns: '104px 1fr 34px', gap: '9px', alignItems: 'center', padding: '3px 0' } },
    h('span', { class: 'tiny muted' }, label),
    meter(val * 100, 100, colour || (invert ? (val > 0.6 ? 'var(--bad)' : 'var(--accent-2)') : ratingColour(val)), 'thin'),
    h('span', { class: 'mono tiny r', style: { textAlign: 'right' } }, (val * 100).toFixed(0)));
}

function ratingColour(v) {
  if (v >= 0.92) return 'var(--purple)';
  if (v >= 0.84) return 'var(--accent-2)';
  if (v >= 0.74) return 'var(--warn)';
  return 'var(--bad)';
}

function temperamentNote(d) {
  const t = d.temperament ?? 0.4;
  if (t > 0.72) return 'Volatile. Expect him to argue with the pit wall, and to ignore it when he does not agree.';
  if (t > 0.5) return 'Headstrong. He will take an instruction he agrees with and question one he does not.';
  if (t > 0.3) return 'Generally does as he is asked, unless the race is on the line.';
  return 'Calm and coachable. He will run the strategy you give him.';
}

function openStaffMarket(app, role) {
  const state = app.state;
  const team = playerTeam(state);
  const rng = makeRng(subSeed(state.seed, 'staffmkt', state.season, state.round, role.id));
  const pos = constructorsPosition(state, team.id);
  const candidates = [];
  for (let i = 0; i < 4; i++) {
    const tier = 0.58 + ((11 - pos) / 10) * 0.26 + rng.range(-0.06, 0.12);
    const c = generateStaff(rng, role.id, tier);
    c.salary = staffSalary(c.rating, role.id);
    candidates.push(c);
  }
  const current = team.staff[role.id];
  const close = modal(
    h('h2', {}, role.name),
    h('p', { class: 'muted small' }, role.blurb),
    current ? h('div', { class: 'offer', style: { marginTop: '14px', borderColor: 'var(--accent)' } },
      h('div', { class: 'hd' }, h('b', {}, current.name), h('span', { class: 'fee' }, `${money(current.salary)}/season`)),
      h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } },
        h('span', { class: 'tiny dim' }, 'Currently in post'),
        meter(current.rating * 100, 100, ratingColour(current.rating)),
        h('span', { class: 'mono tiny' }, (current.rating * 100).toFixed(0)))) : null,
    h('h3', { style: { marginTop: '18px' } }, 'Available'),
    candidates.map((c) => h('div', { class: 'offer' },
      h('div', { class: 'hd' }, h('b', {}, c.name),
        h('span', { class: 'tiny dim' }, `age ${c.age}`),
        h('span', { class: 'fee' }, `${money(c.salary)}/season`)),
      h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '9px' } },
        meter(c.rating * 100, 100, ratingColour(c.rating)),
        h('span', { class: 'mono tiny' }, (c.rating * 100).toFixed(0)),
        c.rating > (current?.rating ?? 0)
          ? h('span', { class: 'tiny good' }, `+${((c.rating - (current?.rating ?? 0)) * 100).toFixed(0)} on who you have`)
          : h('span', { class: 'tiny dim' }, 'No better than who you have')),
      h('button', {
        class: 'btn sm',
        onClick: () => {
          const signingFee = Math.round(c.salary * 0.4 * 10) / 10;
          spend(state, signingFee, `${role.name} signing fee — ${c.name}`, 'staff');
          team.staff[role.id] = c;
          pushNews(state, 'staff', `${team.name} appoint ${c.name} as ${role.name}.`);
          close(); app.save(); app.render();
        },
      }, `Sign — ${money(Math.round(c.salary * 0.4 * 10) / 10)} fee`))),
    h('div', { class: 'btnrow', style: { marginTop: '16px' } },
      h('button', { class: 'btn', onClick: () => close() }, 'Close')));
}
