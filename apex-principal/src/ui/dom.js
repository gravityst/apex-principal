/**
 * APEX: Principal — a very small DOM helper.
 *
 * No framework, no build step. `h()` builds elements, `mount()` replaces a
 * container's children, and that is the entire rendering strategy.
 */

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  add(el, children);
  return el;
}

function add(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) add(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function mount(container, ...children) {
  container.replaceChildren();
  add(container, children);
  return container;
}

export function clear(el) { el.replaceChildren(); return el; }

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export const money = (m) => {
  const v = Math.round(m * 10) / 10;
  return `${v < 0 ? '−' : ''}$${Math.abs(v).toFixed(1)}M`;
};

export const signed = (v, digits = 1) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}`;

export function lapTime(t) {
  if (t == null || !isFinite(t)) return '—';
  const m = Math.floor(t / 60), s = t - m * 60;
  return m > 0 ? `${m}:${s.toFixed(3).padStart(6, '0')}` : s.toFixed(3);
}

export function gapTime(t) {
  if (t == null || !isFinite(t)) return '—';
  if (t >= 60) { const m = Math.floor(t / 60); return `+${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`; }
  return `+${t.toFixed(1)}`;
}

export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export const pct = (v, d = 0) => `${(v * 100).toFixed(d)}%`;

// ---------------------------------------------------------------------------
// Little components
// ---------------------------------------------------------------------------

export function meter(value, max = 100, color = null, cls = '') {
  const w = Math.max(0, Math.min(1, value / max));
  return h('div', { class: `meter ${cls}` },
    h('i', { style: { width: `${w * 100}%`, background: color || '' } }));
}

export function kv(k, v, cls = '') {
  return h('div', { class: 'kv' }, h('span', { class: 'k' }, k), h('span', { class: `v ${cls}` }, v));
}

export function stat(label, value, cls = '') {
  return h('div', { class: 'stat' },
    h('span', { class: 'k' }, label),
    h('span', { class: `v ${cls}` }, value));
}

export function panel(title, right, ...body) {
  return h('div', { class: 'panel' },
    title ? h('h3', {}, title, right ? h('span', { class: 'right' }, right) : null) : null,
    ...body);
}

export function teamBar(team) {
  return h('i', { class: 'bar-team', style: { background: team.colors?.primary || '#666' } });
}

/** A modal. Returns a close function. */
export function modal(...content) {
  const wrap = h('div', { class: 'modal-wrap' });
  const box = h('div', { class: 'modal' }, ...content);
  wrap.append(box);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  document.body.append(wrap);
  function close() { wrap.remove(); }
  return close;
}

export function confirmDialog(title, body, confirmLabel, onConfirm) {
  const close = modal(
    h('h2', {}, title),
    h('p', { class: 'muted' }, body),
    h('div', { class: 'btnrow', style: { marginTop: '18px' } },
      h('button', { class: 'btn primary', onClick: () => { close(); onConfirm(); } }, confirmLabel),
      h('button', { class: 'btn', onClick: () => close() }, 'Cancel')));
  return close;
}
