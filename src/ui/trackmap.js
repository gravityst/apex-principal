/**
 * APEX: Principal — the live track map.
 *
 * Canvas 2D, drawn from the real circuit centreline the lap solver integrates,
 * so the shape on screen is the shape the cars are actually racing on. Twenty
 * dots, the pit lane, the DRS zones and the sector boundaries.
 */

export function createTrackMap(canvas, track, setup = {}) {
  const compact = !!setup.compact;
  const ctx = canvas.getContext('2d');
  const pts = track.map.points;                 // normalised [0..1, 0..1]
  const circuit = track.circuit;

  let W = 0, H = 0, dpr = 1;
  let pad = 26;
  let sx = 1, sy = 1, ox = 0, oy = 0;

  function layout() {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssW = Math.max(compact ? 104 : 220, rect.width || (compact ? 150 : 480));
    const aspect = track.map.aspect;
    // Keep the circuit's real proportions, inside a sensible box.
    const cssH = compact
      ? Math.max(84, Math.min(180, cssW / Math.max(0.55, Math.min(2.1, aspect))))
      : Math.max(200, Math.min(520, cssW / Math.max(0.55, Math.min(2.1, aspect))));
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.height = `${cssH}px`;
    W = canvas.width; H = canvas.height;
    pad = (compact ? 9 : 22) * dpr;

    const availW = W - pad * 2, availH = H - pad * 2;
    const s = Math.min(availW, availH * aspect);
    sx = s; sy = s / aspect;
    ox = (W - sx) / 2; oy = (H - sy) / 2;
  }

  const P = (i) => {
    const p = pts[((i % pts.length) + pts.length) % pts.length];
    return [ox + p[0] * sx, oy + p[1] * sy];
  };
  const PU = (u) => {
    const p = track.mapAt(u);
    return [ox + p[0] * sx, oy + p[1] * sy];
  };

  function ribbon(width, style, from = 0, to = 1) {
    ctx.beginPath();
    const n = pts.length;
    const i0 = Math.floor(from * n), i1 = Math.ceil(to * n);
    for (let i = i0; i <= i1; i++) {
      const [x, y] = P(i);
      if (i === i0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    if (from === 0 && to === 1) ctx.closePath();
    ctx.lineWidth = width * dpr;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = style;
    ctx.stroke();
  }

  function band(from, to, width, style) {
    // Bands may wrap the start/finish line.
    if (from <= to) ribbon(width, style, from, to);
    else { ribbon(width, style, from, 1); ribbon(width, style, 0, to); }
  }

  /**
   * @param cars     [{u, status, team, isPlayer, position, driver}]
   * @param weather  {wetness}
   */
  function draw(cars = [], weather = { wetness: 0 }, opts = {}) {
    layout();
    ctx.clearRect(0, 0, W, H);

    // Surface.
    const wet = weather.wetness || 0;
    ribbon(compact ? 7 : 11, '#0f1622');
    ribbon(compact ? 5 : 8, wet > 0.45 ? '#2a3d52' : wet > 0.12 ? '#243444' : '#2b3446');

    // Sectors.
    const sectors = circuit.sectors || [0.333, 0.666];
    for (const s of [0, ...sectors]) {
      const [x, y] = PU(s);
      ctx.beginPath();
      ctx.arc(x, y, 2.4 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = '#4a5c78';
      ctx.fill();
    }

    // DRS zones.
    for (const z of circuit.drsZones || []) band(z.start, z.end, 3, 'rgba(0,215,177,.55)');

    // Pit lane.
    const pit = circuit.pit;
    if (pit) band(pit.entry, pit.exit, 2.5, 'rgba(245,197,24,.45)');

    // Start/finish.
    const [fx, fy] = PU(0);
    ctx.save();
    ctx.translate(fx, fy);
    ctx.fillStyle = '#e8eef8';
    ctx.fillRect(-1.5 * dpr, -7 * dpr, 3 * dpr, 14 * dpr);
    ctx.restore();

    // Cars, backmarkers first so the leaders sit on top.
    const list = cars.filter((c) => c.status !== 'retired').slice().sort((a, b) => b.position - a.position);
    for (const c of list) {
      const [x, y] = PU(c.u);
      const col = c.team?.colors?.primary || '#888';
      const r = (c.isPlayer ? (compact ? 3.9 : 5.4) : (compact ? 2.6 : 4.1)) * dpr;

      if (c.isPlayer) {
        ctx.beginPath();
        ctx.arc(x, y, r + 3.2 * dpr, 0, Math.PI * 2);
        ctx.strokeStyle = '#ff8a00';
        ctx.lineWidth = 1.8 * dpr;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = c.status === 'pit' ? '#5a6883' : col;
      ctx.fill();
      ctx.lineWidth = 1.2 * dpr;
      ctx.strokeStyle = '#080c14';
      ctx.stroke();

      if (opts.labels !== false && (c.isPlayer || c.position <= 3)) {
        ctx.font = `700 ${9.5 * dpr}px ui-monospace, monospace`;
        ctx.fillStyle = '#e8eef8';
        ctx.textAlign = 'center';
        ctx.fillText(c.driver?.short || String(c.position), x, y - (r + 5 * dpr));
      }
    }

    // Rain overlay.
    if (wet > 0.05) {
      ctx.fillStyle = `rgba(90,150,210,${Math.min(0.16, wet * 0.18)})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  return { draw, layout };
}

/** A static thumbnail of a circuit, for the calendar and the hub. */
export function drawCircuitThumb(canvas, track, accent = '#ff8a00') {
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const cssW = rect.width || 200;
  const cssH = rect.height || 120;
  canvas.width = cssW * dpr; canvas.height = cssH * dpr;
  const pad = 12 * dpr;
  const aspect = track.map.aspect;
  const availW = canvas.width - pad * 2, availH = canvas.height - pad * 2;
  const s = Math.min(availW, availH * aspect);
  const sx = s, sy = s / aspect;
  const ox = (canvas.width - sx) / 2, oy = (canvas.height - sy) / 2;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.beginPath();
  track.map.points.forEach((p, i) => {
    const x = ox + p[0] * sx, y = oy + p[1] * sy;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.lineWidth = 3 * dpr; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = '#2b3446';
  ctx.stroke();
  ctx.lineWidth = 1.4 * dpr;
  ctx.strokeStyle = accent;
  ctx.stroke();
}
