/**
 * APEX: Principal — the paint shop.
 *
 * Names, codes, colours, a badge and a livery, for your team and for everyone
 * else's. It writes straight into `state.teams`, which is what the save already
 * carries, so a customised grid survives a reload like anything else.
 *
 * Images are held as data URLs, resized on the way in. A livery is a 512px
 * square wrapped down the flank of the car; a badge is 96px with transparency.
 * Both are kept small deliberately: browser storage is a few megabytes and a
 * grid of ten teams has to fit in it alongside a career.
 */

import { h, mount, panel, modal, confirmDialog } from './dom.js';
import { playerTeam } from '../mgmt/state.js';

const LIVERY_PX = 512;
const BADGE_PX = 96;

/** Read a file, scale it, and hand back a data URL. */
function readImage(file, maxPx, mime, quality) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error('no file'));
    if (!/^image\//.test(file.type)) return reject(new Error('that is not an image'));
    if (file.size > 12 * 1024 * 1024) return reject(new Error('that image is enormous — under 12MB please'));
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('the file could not be read'));
    fr.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('that image could not be decoded'));
      img.onload = () => {
        const scale = Math.min(1, maxPx / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const hgt = Math.max(1, Math.round(img.naturalHeight * scale));
        const c = document.createElement('canvas');
        c.width = mime === 'image/png' ? w : maxPx;
        c.height = mime === 'image/png' ? hgt : maxPx;
        const ctx = c.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        // A livery is square by definition — the flank of a car is a strip, and
        // stretching to fit is what a wrap does anyway.
        ctx.drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL(mime, quality));
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

/** Decode every custom livery once so the car builder can draw it. */
export function primeLiveries(state) {
  if (!state || !state.teams) return;
  for (const t of state.teams) {
    if (t.liveryImage && (!t._liveryImg || t._liveryImg.src !== t.liveryImage)) {
      const img = new Image();
      img.src = t.liveryImage;
      t._liveryImg = img;
      t.liveryRev = (t.liveryRev || 0) + 1;
    } else if (!t.liveryImage && t._liveryImg) {
      t._liveryImg = null;
      t.liveryRev = (t.liveryRev || 0) + 1;
    }
  }
}

function pickFile(accept, onPicked) {
  const input = h('input', { type: 'file', accept });
  input.addEventListener('change', () => onPicked(input.files && input.files[0]));
  input.click();
}

export function renderCustomise(app, root) {
  const state = app.state;
  const mineTeam = playerTeam(state);

  function save() {
    primeLiveries(state);
    app.save();
    app.render();
  }

  const badge = (t) => t.logo
    ? h('img', { class: 'badge', src: t.logo, alt: '' })
    : h('div', { class: 'badge gen', style: { background: t.colors.primary } }, (t.short || '?').slice(0, 3));

  function teamCard(t, isMine) {
    const nameIn = h('input', { class: 'inp', value: t.name, maxlength: '28' });
    const shortIn = h('input', { class: 'inp short', value: t.short, maxlength: '3' });
    const primary = h('input', { type: 'color', class: 'col', value: t.colors.primary });
    const secondary = h('input', { type: 'color', class: 'col', value: t.colors.secondary || '#ffffff' });
    const accent = h('input', { type: 'color', class: 'col', value: t.colors.accent || '#ffffff' });
    const preview = h('div', { class: 'liverypv' },
      t.liveryImage ? h('img', { src: t.liveryImage, alt: '' }) : h('span', { class: 'tiny dim' }, 'generated'));

    function commit() {
      const n = nameIn.value.trim();
      const sc = shortIn.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (n) t.name = n;
      if (sc.length === 3) t.short = sc;
      t.colors.primary = primary.value;
      t.colors.secondary = secondary.value;
      t.colors.accent = accent.value;
      t.liveryRev = (t.liveryRev || 0) + 1;
      save();
    }

    return h('div', { class: `custcard ${isMine ? 'mine' : ''}` },
      h('div', { class: 'ch' }, badge(t), h('b', {}, t.name),
        isMine ? h('span', { class: 'tierbadge title' }, 'your team') : null),

      h('div', { class: 'frow' },
        h('label', {}, h('span', {}, 'Team name'), nameIn),
        h('label', { style: { flex: '0 0 96px' } }, h('span', {}, 'Code'), shortIn)),

      h('div', { class: 'frow' },
        h('label', {}, h('span', {}, 'Primary'), primary),
        h('label', {}, h('span', {}, 'Secondary'), secondary),
        h('label', {}, h('span', {}, 'Accent'), accent)),

      h('div', { class: 'frow top' },
        h('div', { style: { flex: '1' } },
          h('span', { class: 'flab' }, 'Livery'),
          h('div', { class: 'tiny dim', style: { margin: '2px 0 7px' } },
            'A square image wrapped down the flank — Monoposto templates work well. It is mirrored across the car.'),
          h('div', { class: 'btnrow' },
            h('button', {
              class: 'btn sm', onClick: () => pickFile('image/*', async (f) => {
                try {
                  t.liveryImage = await readImage(f, LIVERY_PX, 'image/jpeg', 0.85);
                  t.liveryRev = (t.liveryRev || 0) + 1;
                  save();
                } catch (e) { alert(e.message); }
              }),
            }, t.liveryImage ? 'Replace livery' : 'Upload livery'),
            t.liveryImage ? h('button', {
              class: 'btn sm danger',
              onClick: () => { t.liveryImage = null; t.liveryRev = (t.liveryRev || 0) + 1; save(); },
            }, 'Remove') : null)),
        preview),

      h('div', { class: 'frow top' },
        h('div', { style: { flex: '1' } },
          h('span', { class: 'flab' }, 'Badge'),
          h('div', { class: 'tiny dim', style: { margin: '2px 0 7px' } },
            'Shown beside the team everywhere. A PNG with transparency looks best.'),
          h('div', { class: 'btnrow' },
            h('button', {
              class: 'btn sm', onClick: () => pickFile('image/*', async (f) => {
                try { t.logo = await readImage(f, BADGE_PX, 'image/png'); save(); }
                catch (e) { alert(e.message); }
              }),
            }, t.logo ? 'Replace badge' : 'Upload badge'),
            t.logo ? h('button', {
              class: 'btn sm danger', onClick: () => { t.logo = null; save(); },
            }, 'Remove') : null))),

      h('div', { class: 'flab', style: { marginTop: '12px' } }, 'Drivers'),
      ...t.drivers.map((d) => {
        const dn = h('input', { class: 'inp', value: d.name, maxlength: '26' });
        const ds = h('input', { class: 'inp short', value: d.short || '', maxlength: '3' });
        const dnum = h('input', { class: 'inp short', value: String(d.num ?? ''), maxlength: '2' });
        return h('div', { class: 'frow' },
          h('label', {}, h('span', {}, 'Driver'), dn),
          h('label', { style: { flex: '0 0 78px' } }, h('span', {}, 'Code'), ds),
          h('label', { style: { flex: '0 0 62px' } }, h('span', {}, 'No.'), dnum),
          h('button', {
            class: 'btn sm', onClick: () => {
              const n = dn.value.trim();
              const sc = ds.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
              const nn = parseInt(dnum.value, 10);
              if (n) d.name = n;
              if (sc.length === 3) d.short = sc;
              if (Number.isFinite(nn) && nn > 0 && nn < 100) d.num = nn;
              save();
            },
          }, 'Save'));
      }),

      h('div', { class: 'btnrow', style: { marginTop: '12px' } },
        h('button', { class: 'btn sm primary', onClick: commit }, 'Save team')));
  }

  const others = state.teams.filter((t) => t.id !== mineTeam.id);

  mount(root, h('div', { class: 'grid' },
    panel('Your team', 'names, colours, badge and livery — saved with your career',
      teamCard(mineTeam, true)),
    panel('The rest of the grid', 'make the whole championship yours',
      h('div', { class: 'custgrid' }, others.map((t) => teamCard(t, false)))),
    panel('Housekeeping', null,
      h('p', { class: 'small muted' },
        'Images are stored inside your save, so they travel with an export and come back with an import. '
        + 'They are resized on the way in — a livery to 512 pixels square, a badge to 96 — to keep the save inside what a browser will hold.'),
      h('div', { class: 'btnrow', style: { marginTop: '10px' } },
        h('button', {
          class: 'btn danger', onClick: () => confirmDialog(
            'Clear every custom image?',
            'Names and colours are kept. Uploaded liveries and badges are removed from every team.',
            'Clear them', () => {
              for (const t of state.teams) { t.logo = null; t.liveryImage = null; t.liveryRev = (t.liveryRev || 0) + 1; }
              save();
            }),
        }, 'Clear all images')))));
}
