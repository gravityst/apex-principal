/**
 * APEX: Principal — application shell.
 *
 * Owns the save, the current screen, and nothing else. Every screen is a
 * function that renders into a container; there is no virtual DOM and no build
 * step.
 */

import { h, mount, panel, money, ordinal, modal, confirmDialog, teamBar, pct } from './ui/dom.js';
import { renderHub, renderCar, renderStandings, renderCalendar } from './ui/screens.js';
import { renderFactory, renderFinance, renderTeam, developmentPending } from './ui/manage.js';
import { renderWeekend } from './ui/weekend.js';
import { renderCustomise, primeLiveries } from './ui/customise.js';
import {
  newGame, saveGame, loadGame, hasSave, clearSave, exportSave, importSave,
  playerTeam, constructorsTable, constructorsPosition, isDismissed,
} from './mgmt/state.js';
import { endSeason, seasonComplete, currentRound, autoSignSponsors, DISTANCES } from './mgmt/season.js';
import { specRating } from './mgmt/carspec.js';
import { TEAMS } from './data/teams.js';
import { doctrineName } from './mgmt/rivals.js';

const TABS = [
  { id: 'hub', name: 'Hub' },
  { id: 'weekend', name: 'Race weekend' },
  { id: 'factory', name: 'Factory' },
  { id: 'car', name: 'The car' },
  { id: 'team', name: 'Team' },
  { id: 'finance', name: 'Finance' },
  { id: 'standings', name: 'Championship' },
  { id: 'calendar', name: 'Calendar' },
  { id: 'customise', name: 'Customise' },
];

const app = {
  state: null,
  tab: 'hub',
  weekend: null,
  phase: 'practice',
  speed: 0,
  startTyres: {},
  practiceSpend: 1,
};

const rootEl = document.getElementById('app');

app.save = () => { if (app.state) saveGame(app.state); };

app.goto = (tab) => {
  if (app.tab !== tab) { app.stopLoop?.(); app.stopLoop = null; }
  app.tab = tab;
  app.render();
};

app.render = () => {
  if (!app.state) return renderSplash();
  if (isDismissed(app.state)) return renderDismissed();

  const state = app.state;
  const team = playerTeam(state);
  document.documentElement.style.setProperty('--team', team.colors.primary);
  primeLiveries(state);

  const table = constructorsTable(state);
  const pos = constructorsPosition(state, team.id);
  const round = seasonComplete(state) ? null : currentRound(state);

  const bar = h('div', { class: 'topbar' },
    h('div', { class: 'brand' }, h('b', {}, 'APEX'), h('span', {}, 'Principal')),
    h('div', { class: 'teamchip' },
      h('i', { class: 'dot', style: { background: team.colors.primary } }), h('b', {}, team.name)),
    st('Season', String(state.season)),
    st('Round', round ? `${round.round}/${state.calendar.length}` : 'complete'),
    st('Constructors', `${ordinal(pos)} · ${table[pos - 1].points}`),
    st('Balance', money(state.player.balance), state.player.balance < 0 ? 'neg' : 'pos'),
    st('Car', specRating(team.spec).toFixed(1)),
    h('div', { class: 'spacer' }),
    h('button', { class: 'btn sm', onClick: openMenu }, 'Menu'));

  const nav = h('div', { class: 'nav' }, TABS.map((t) => h('button', {
    'aria-selected': app.tab === t.id ? 'true' : 'false',
    onClick: () => app.goto(t.id),
  }, t.name,
    t.id === 'factory' && developmentPending(state)
      ? h('span', { style: { color: 'var(--accent)', marginLeft: '6px' } }, '●') : null)));

  const main = h('main', {});
  mount(rootEl, bar, nav, main);

  const screens = {
    hub: renderHub, weekend: renderWeekend, factory: renderFactory, car: renderCar,
    team: renderTeam, finance: renderFinance, standings: renderStandings, calendar: renderCalendar,
    customise: renderCustomise,
  };
  (screens[app.tab] || renderHub)(app, main);
};

function st(k, v, cls = '') {
  return h('div', { class: 'stat' }, h('span', { class: 'k' }, k), h('span', { class: `v ${cls}` }, v));
}

// ---------------------------------------------------------------------------
// End of season
// ---------------------------------------------------------------------------

app.endSeason = () => {
  const state = app.state;
  const res = endSeason(state);
  app.weekend = null;
  app.appliedRound = null;
  state.player.developedForRound = -1;
  app.save();

  const close = modal(
    h('h2', {}, `Season ${res.table ? state.season - 1 : ''} — final standings`),
    h('table', { style: { marginTop: '12px' } },
      h('thead', {}, h('tr', {}, h('th', { class: 'r' }, '#'), h('th', {}, 'Constructor'), h('th', { class: 'r' }, 'Pts'))),
      h('tbody', {}, res.table.map((r, i) => h('tr', { class: r.team.id === state.playerTeamId ? 'me' : '' },
        h('td', { class: 'pos r' }, i + 1),
        h('td', {}, teamBar(r.team), r.team.name),
        h('td', { class: 'r mono' }, r.points))))),
    h('h3', { style: { marginTop: '20px' } }, 'The winter'),
    h('div', {}, res.events.map((e) => h('div', { class: 'newsitem' },
      h('span', { class: 'tag' }, e.kind), e.text))),
    h('div', { class: 'btnrow', style: { marginTop: '18px' } },
      h('button', {
        class: 'btn primary', onClick: () => {
          close();
          const signed = autoSignSponsors(state);
          if (signed.length) {
            modalNote('Commercial department', `Your commercial team have brought in ${signed.length} partner${signed.length === 1 ? '' : 's'}. Review them on the finance screen — you can still change who you carry.`);
          }
          app.save(); app.goto('hub');
        },
      }, `Begin season ${state.season} →`),
      h('button', { class: 'btn', onClick: () => { close(); app.goto('finance'); } }, 'Sponsors first')));
};

function modalNote(title, body) {
  const close = modal(h('h2', {}, title), h('p', { class: 'muted' }, body),
    h('div', { class: 'btnrow', style: { marginTop: '16px' } },
      h('button', { class: 'btn primary', onClick: () => close() }, 'OK')));
}

function renderDismissed() {
  const state = app.state;
  mount(rootEl, h('div', { class: 'splash' }, h('div', { class: 'panel card' },
    h('h2', { style: { fontSize: '24px', color: 'var(--bad)' } }, 'You have been dismissed'),
    h('p', { class: 'muted' },
      `The board has run out of patience. ${money(state.player.balance)} is not a deficit anyone was prepared to carry, and ${playerTeam(state).name} have appointed someone else.`),
    h('p', { class: 'small dim' }, `You lasted ${state.season} season${state.season === 1 ? '' : 's'}.`),
    h('div', { class: 'btnrow', style: { marginTop: '18px' } },
      h('button', { class: 'btn primary', onClick: () => { clearSave(); app.state = null; app.render(); } }, 'Start again')))));
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

function openMenu() {
  const state = app.state;
  const close = modal(
    h('h2', {}, 'Menu'),
    h('div', { class: 'btnrow', style: { marginTop: '16px' } },
      h('button', {
        class: 'btn', onClick: () => {
          const blob = new Blob([exportSave(state)], { type: 'application/json' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `apex-principal-s${state.season}-r${state.round}.json`;
          a.click();
          URL.revokeObjectURL(a.href);
        },
      }, 'Export save'),
      h('button', {
        class: 'btn', onClick: () => {
          const input = h('input', { type: 'file', accept: '.json,application/json' });
          input.addEventListener('change', async () => {
            try {
              const text = await input.files[0].text();
              app.state = importSave(text);
              app.weekend = null; app.appliedRound = null;
              close(); app.save(); app.goto('hub');
            } catch (e) { alert(`That save could not be loaded. ${e.message}`); }
          });
          input.click();
        },
      }, 'Import save'),
      h('button', {
        class: 'btn danger', onClick: () => {
          close();
          confirmDialog('Abandon this career?', 'The save will be deleted and cannot be recovered.', 'Delete it', () => {
            clearSave(); app.state = null; app.weekend = null; app.render();
          });
        },
      }, 'New career')),
    h('h3', { style: { marginTop: '22px' } }, 'Settings'),
    h('label', { style: { display: 'flex', gap: '10px', alignItems: 'center', padding: '10px 0' } },
      h('input', {
        type: 'checkbox', checked: state.settings.autoStrategy,
        onChange: (e) => { state.settings.autoStrategy = e.target.checked; app.save(); },
      }),
      h('div', {}, h('b', {}, 'Race engineer runs strategy when you do not'),
        h('div', { class: 'tiny dim' }, 'If you leave a car alone, it will pit on worn tyres and react to rain by itself. Turn this off for full manual control.'))),
    h('div', { style: { padding: '12px 0 4px' } },
      h('b', {}, 'Difficulty'),
      h('div', { class: 'tiny dim', style: { margin: '3px 0 9px' } },
        'A handicap on the rest of the field, and nothing else — it does not touch their development, their money or their decisions, only how hard they are to beat on Sunday.'),
      h('div', { class: 'btnrow' }, [
        ['relaxed', 'Relaxed', 'a third of a second a lap your way'],
        ['normal', 'Normal', 'no handicap either way'],
        ['brutal', 'Brutal', 'a third of a second a lap against you'],
      ].map(([id, name, blurb]) => h('button', {
        class: `btn sm ${(state.settings.difficulty || 'normal') === id ? 'on' : ''}`,
        title: blurb,
        onClick: () => {
          state.settings.difficulty = id;
          app.weekend = null;                  // takes effect from the next session
          app.save(); close(); openMenu();
        },
      }, name)))),

    h('div', { style: { padding: '12px 0 4px' } },
      h('b', {}, 'Race distance'),
      h('div', { class: 'tiny dim', style: { margin: '3px 0 9px' } },
        'A grand prix is about 305 kilometres. Anything less is a shorter race, not a faster one — the strategy changes with it.'),
      h('div', { class: 'btnrow' }, Object.values(DISTANCES).map((d) => h('button', {
        class: `btn sm ${(state.settings.distance || 'full') === d.id ? 'on' : ''}`,
        title: d.blurb,
        onClick: () => {
          state.settings.distance = d.id;
          app.weekend = null;
          app.save(); close(); openMenu();
        },
      }, d.name)))),

    h('h3', { style: { marginTop: '18px' } }, 'About'),
    h('p', { class: 'small muted' },
      'Built on the physics of APEX F1. Lap times come from a quasi-steady-state solver running over the real circuit geometry — every development point moves a genuine physical parameter. Teams, drivers, sponsors and circuits are invented.'),
    h('div', { class: 'btnrow', style: { marginTop: '16px' } },
      h('button', { class: 'btn primary', onClick: () => close() }, 'Close')));
}

// ---------------------------------------------------------------------------
// Splash
// ---------------------------------------------------------------------------

function renderSplash() {
  let picked = 'halcyon';
  const grid = h('div', { class: 'teampick' });

  function drawPicks() {
    grid.replaceChildren(...TEAMS.map((t) => h('button', {
      class: 'teamopt', 'aria-pressed': picked === t.id ? 'true' : 'false',
      onClick: () => { picked = t.id; drawPicks(); },
    },
      h('div', { class: 'nm' },
        h('i', { class: 'bar-team', style: { background: t.colors.primary } }), t.name),
      h('div', { class: 'dsc' }, describeTeam(t)))));
  }
  drawPicks();

  mount(rootEl, h('div', { class: 'splash' }, h('div', { class: 'panel card' },
    h('div', { class: 'brand', style: { marginBottom: '6px' } },
      h('b', { style: { fontSize: '26px' } }, 'APEX'), h('span', {}, 'Principal')),
    h('p', { class: 'muted', style: { maxWidth: '620px' } },
      'You are the team principal. You will never drive. You build the car, you hire the people, you spend the money, and on Sunday you call the race from the pit wall — and then watch two grown adults decide whether to listen to you.'),
    hasSave() ? h('div', { class: 'btnrow', style: { margin: '18px 0' } },
      h('button', {
        class: 'btn primary', onClick: () => {
          const s = loadGame();
          if (s) { app.state = s; app.goto('hub'); } else alert('That save could not be read.');
        },
      }, 'Continue your career')) : null,
    h('h3', { style: { marginTop: '22px' } }, 'Choose a constructor'),
    h('p', { class: 'small dim' }, 'A works team hands you a quick car and no excuses. A small team hands you a slow one and a long job.'),
    grid,
    h('div', { class: 'btnrow', style: { marginTop: '18px' } },
      h('button', {
        class: 'btn primary', onClick: () => {
          app.state = newGame({ playerTeamId: picked });
          app.state.player.developedForRound = -1;
          app.save();
          app.goto('hub');
        },
      }, 'Take the job →')))));
}

function describeTeam(t) {
  const tier = t.performance >= 0.96 ? 'A works team expected to win. Anything less is a failure.'
    : t.performance >= 0.90 ? 'A strong midfield team with the resources to move forward.'
      : t.performance >= 0.86 ? 'Solid, underfunded, and a long way from the front.'
        : 'A backmarker. Nobody expects anything, which is its own kind of freedom.';
  return `${tier} ${t.engine}, based in ${t.base}.`;
}

// ---------------------------------------------------------------------------

const existing = loadGame();
if (existing) { app.state = existing; app.tab = 'hub'; }
app.render();
window.addEventListener('beforeunload', () => app.save());
window.apexPrincipal = app;
