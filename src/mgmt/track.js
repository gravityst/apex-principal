/**
 * APEX: Principal — circuit geometry sampler.
 *
 * Rebuilds the centreline of an APEX circuit from its Catmull-Rom control
 * points and produces the two things the rest of the game needs:
 *
 *   1. an arc-length table with curvature, gradient, width and elevation,
 *      which the lap solver integrates over;
 *   2. a normalised 2D polyline, which the track map draws.
 *
 * Pure. No DOM, no three.js, no imports. The same module runs in the browser
 * and under `node tools/simseason.mjs`.
 *
 * Convention matches src/data/circuits.js: control points are `[x, z, y,
 * halfWidth]` in metres, ordered in the direction of travel, forming a ring
 * whose last point flows back into the first.
 */

/** Centripetal Catmull-Rom (alpha = 0.5) through p0..p3, evaluated at t in 0..1. */
function catmullRom(p0, p1, p2, p3, t, out) {
  const alpha = 0.5;
  const d01 = Math.pow(dist3(p0, p1), alpha);
  const d12 = Math.pow(dist3(p1, p2), alpha);
  const d23 = Math.pow(dist3(p2, p3), alpha);

  // Degenerate spacing collapses the knot sequence; fall back to a plain
  // uniform segment rather than dividing by zero.
  if (d01 < 1e-6 || d12 < 1e-6 || d23 < 1e-6) {
    out[0] = p1[0] + (p2[0] - p1[0]) * t;
    out[1] = p1[1] + (p2[1] - p1[1]) * t;
    out[2] = p1[2] + (p2[2] - p1[2]) * t;
    out[3] = p1[3] + (p2[3] - p1[3]) * t;
    return out;
  }

  const t0 = 0, t1 = t0 + d01, t2 = t1 + d12, t3 = t2 + d23;
  const tt = t1 + (t2 - t1) * t;

  for (let k = 0; k < 4; k++) {
    const a1 = ((t1 - tt) * p0[k] + (tt - t0) * p1[k]) / (t1 - t0);
    const a2 = ((t2 - tt) * p1[k] + (tt - t1) * p2[k]) / (t2 - t1);
    const a3 = ((t3 - tt) * p2[k] + (tt - t2) * p3[k]) / (t3 - t2);
    const b1 = ((t2 - tt) * a1 + (tt - t0) * a2) / (t2 - t0);
    const b2 = ((t3 - tt) * a2 + (tt - t1) * a3) / (t3 - t1);
    out[k] = ((t2 - tt) * b1 + (tt - t1) * b2) / (t2 - t1);
  }
  return out;
}

function dist3(a, b) {
  const dx = a[0] - b[0], dz = a[1] - b[1], dy = a[2] - b[2];
  return Math.sqrt(dx * dx + dz * dz + dy * dy) || 1e-9;
}

/**
 * Menger curvature of the circle through three points, in the ground plane.
 * κ = 4·Area / (a·b·c). Signed by the cross product so that left-hand and
 * right-hand corners can be told apart.
 */
function curvatureAt(pa, pb, pc) {
  const ax = pa[0], az = pa[1], bx = pb[0], bz = pb[1], cx = pc[0], cz = pc[1];
  const a = Math.hypot(bx - cx, bz - cz);
  const b = Math.hypot(ax - cx, az - cz);
  const c = Math.hypot(ax - bx, az - bz);
  if (a < 1e-6 || b < 1e-6 || c < 1e-6) return 0;
  const cross = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const area2 = cross;                       // twice the signed area
  return (2 * area2) / (a * b * c);
}

/**
 * Build the sampled centreline.
 *
 * @param circuit  an entry from src/data/circuits.js
 * @param spacing  target sample spacing in metres (default 6 m)
 * @returns {{
 *   id, name, length, samples: Number,
 *   s: Float64Array, x: Float64Array, z: Float64Array, y: Float64Array,
 *   width: Float64Array, curv: Float64Array, grade: Float64Array,
 *   map: {points: Array<[number,number]>, w: Number, h: Number},
 *   at(s): {x,z,y,width,curv,grade}
 * }}
 */
export function buildTrack(circuit, spacing = 6) {
  const pts = circuit.points;
  const n = pts.length;
  if (!n || n < 4) throw new Error(`circuit ${circuit.id}: need at least 4 control points`);

  // ---- dense pass: walk every segment at a fixed parameter step -----------
  const dense = [];
  const out = [0, 0, 0, 0];
  const PER_SEG = 24;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    for (let j = 0; j < PER_SEG; j++) {
      catmullRom(p0, p1, p2, p3, j / PER_SEG, out);
      dense.push([out[0], out[1], out[2], out[3]]);
    }
  }

  // ---- arc length along the dense ring -----------------------------------
  const m = dense.length;
  const cum = new Float64Array(m + 1);
  for (let i = 0; i < m; i++) {
    const a = dense[i], b = dense[(i + 1) % m];
    cum[i + 1] = cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const rawLength = cum[m];

  // The control points are authored against a target length; honour it so lap
  // distances line up with the circuit's own sector and DRS positions.
  const scale = circuit.lengthTarget ? circuit.lengthTarget / rawLength : 1;
  const length = rawLength * scale;

  // ---- resample at uniform arc length ------------------------------------
  const count = Math.max(64, Math.round(length / spacing));
  const step = length / count;
  const S = new Float64Array(count);
  const X = new Float64Array(count);
  const Z = new Float64Array(count);
  const Y = new Float64Array(count);
  const W = new Float64Array(count);

  let cursor = 0;
  for (let i = 0; i < count; i++) {
    const target = (i * step) / scale;             // back into raw units
    while (cursor < m - 1 && cum[cursor + 1] < target) cursor++;
    const seg = Math.max(1e-9, cum[cursor + 1] - cum[cursor]);
    const f = (target - cum[cursor]) / seg;
    const a = dense[cursor], b = dense[(cursor + 1) % m];
    S[i] = i * step;
    X[i] = a[0] + (b[0] - a[0]) * f;
    Z[i] = a[1] + (b[1] - a[1]) * f;
    Y[i] = a[2] + (b[2] - a[2]) * f;
    W[i] = a[3] + (b[3] - a[3]) * f;
  }

  // ---- curvature and gradient --------------------------------------------
  // Curvature is measured over a ±14 m chord rather than between neighbouring
  // samples: at 6 m spacing the point-to-point estimate is dominated by
  // resampling noise and invents corners on the straights.
  const span = Math.max(2, Math.round(14 / step));
  const C = new Float64Array(count);
  const G = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const a = i - span, b = i, c = i + span;
    C[i] = curvatureAt(
      [X[(a % count + count) % count], Z[(a % count + count) % count]],
      [X[b], Z[b]],
      [X[(c % count + count) % count], Z[(c % count + count) % count]],
    );
    const up = Y[(i + 1) % count] - Y[i];
    G[i] = up / step;                              // rise over run
  }

  // A light smoothing pass: real circuits do not change radius discontinuously
  // and the solver's braking integration is sensitive to spikes.
  smoothRing(C, 2);
  smoothRing(G, 3);

  // ---- normalised 2D polyline for the map --------------------------------
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    if (X[i] < minX) minX = X[i];
    if (X[i] > maxX) maxX = X[i];
    if (Z[i] < minZ) minZ = Z[i];
    if (Z[i] > maxZ) maxZ = Z[i];
  }
  const w = Math.max(1, maxX - minX), h = Math.max(1, maxZ - minZ);
  const mapPoints = new Array(count);
  for (let i = 0; i < count; i++) mapPoints[i] = [(X[i] - minX) / w, (Z[i] - minZ) / h];

  const track = {
    id: circuit.id,
    name: circuit.name,
    circuit,
    length,
    samples: count,
    step,
    s: S, x: X, z: Z, y: Y, width: W, curv: C, grade: G,
    map: { points: mapPoints, w, h, aspect: w / h },
  };

  track.indexAt = (s) => {
    const u = ((s % length) + length) % length;
    return Math.min(count - 1, Math.floor(u / step));
  };
  track.at = (s) => {
    const i = track.indexAt(s);
    return { x: X[i], z: Z[i], y: Y[i], width: W[i], curv: C[i], grade: G[i], index: i };
  };
  /** Normalised lap fraction (0..1) for a distance in metres. */
  track.fraction = (s) => (((s % length) + length) % length) / length;
  /** Point on the map polyline for a lap fraction, as [0..1, 0..1]. */
  track.mapAt = (u) => {
    const f = ((u % 1) + 1) % 1;
    const idx = f * count;
    const i0 = Math.floor(idx) % count, i1 = (i0 + 1) % count;
    const t = idx - Math.floor(idx);
    const a = mapPoints[i0], b = mapPoints[i1];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  };

  return track;
}

function smoothRing(arr, passes) {
  const n = arr.length;
  const tmp = new Float64Array(n);
  for (let p = 0; p < passes; p++) {
    for (let i = 0; i < n; i++) {
      const a = arr[(i - 1 + n) % n], b = arr[i], c = arr[(i + 1) % n];
      tmp[i] = a * 0.25 + b * 0.5 + c * 0.25;
    }
    arr.set(tmp);
  }
}

/** Cache so a circuit is only rebuilt once per session. */
const _cache = new Map();
export function getTrack(circuit, spacing = 6) {
  const key = `${circuit.id}:${spacing}`;
  let t = _cache.get(key);
  if (!t) { t = buildTrack(circuit, spacing); _cache.set(key, t); }
  return t;
}
