/**
 * APEX: Principal — the 3D race view.
 *
 * The cars are the real APEX F1 models: the same procedural chassis, wheels,
 * livery and tyre compounds that the driving game renders, ported unchanged in
 * `carModel.js`. What is new here is the world around them, because APEX F1's
 * track builder is written against its own sampler and carries scenery,
 * weather and post-processing this game does not need. Instead the circuit is
 * extruded straight from the same centreline the lap solver integrates, so
 * what you watch is geometrically the thing being simulated.
 *
 * Camera work is deliberately narrow: a close top-down chase that zooms, and a
 * split view with one of those per car. A management game is watched from
 * above — you are reading the gaps, not the apexes.
 */

import * as THREE from '../../vendor/three/build/three.module.js';
import { createCarModel } from './carModel.js';
import { buildSky, buildWorld, createPuffs } from './world.js';
import { surfaces } from './textures.js';
import { racingLine } from '../mgmt/track.js';

const UP = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------------------
// Track geometry
// ---------------------------------------------------------------------------

/**
 * Extrude the circuit from the sampler: asphalt, white lines, kerbs on the
 * corners, a run-off apron and a ground plane.
 */
function buildTrackMesh(track, quality) {
  // Materials the weather may dress; handed back on the group.
  const wetables = [];
  const weatherable = (m) => { m.userData.dryRough = m.roughness ?? 1; m.userData.dryColor = m.color.clone(); wetables.push(m); return m; };
  const n = track.samples;
  const group = new THREE.Group();
  group.name = 'circuit';

  // Per-sample frame: position, forward tangent and the lateral (right) vector.
  const pos = new Float32Array(n * 3);
  const lat = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = (i - 1 + n) % n, b = (i + 1) % n;
    const tx = track.x[b] - track.x[a];
    const tz = track.z[b] - track.z[a];
    const len = Math.hypot(tx, tz) || 1;
    // Right-hand lateral in the ground plane.
    lat[i * 3] = tz / len;
    lat[i * 3 + 1] = 0;
    lat[i * 3 + 2] = -tx / len;
    pos[i * 3] = track.x[i];
    pos[i * 3 + 1] = track.y[i];
    pos[i * 3 + 2] = track.z[i];
  }
  track._frame = { pos, lat };

  /**
   * Build a closed ribbon at a constant offset band from the centreline.
   *
   * `tile` is how many metres one texture tile covers. Given it, the UVs are
   * laid out in metres rather than 0..1 across, so a texture keeps its scale
   * where the track widens and never smears through a corner.
   */
  function ribbon(innerFn, outerFn, yLift, material, tile = 0) {
    const verts = new Float32Array(n * 2 * 3);
    const uvs = new Float32Array(n * 2 * 2);
    const idx = new Uint32Array(n * 6);
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      const a = innerFn(i), b = outerFn(i);
      verts[i * 6] = pos[o] + lat[o] * a;
      verts[i * 6 + 1] = pos[o + 1] + yLift;
      verts[i * 6 + 2] = pos[o + 2] + lat[o + 2] * a;
      verts[i * 6 + 3] = pos[o] + lat[o] * b;
      verts[i * 6 + 4] = pos[o + 1] + yLift;
      verts[i * 6 + 5] = pos[o + 2] + lat[o + 2] * b;
      const v = tile ? (i * track.step) / tile : i * track.step * 0.06;
      uvs[i * 4] = tile ? a / tile : 0;
      uvs[i * 4 + 1] = v;
      uvs[i * 4 + 2] = tile ? b / tile : 1;
      uvs[i * 4 + 3] = v;
      const j = (i + 1) % n;
      const k = i * 6;
      idx[k] = i * 2; idx[k + 1] = j * 2; idx[k + 2] = i * 2 + 1;
      idx[k + 3] = j * 2; idx[k + 4] = j * 2 + 1; idx[k + 5] = i * 2 + 1;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, material);
    m.receiveShadow = !!quality.shadows;
    return m;
  }

  const W = (i) => track.width[i];
  const S = surfaces(quality.tier, quality.anisotropy || 4);

  // Run-off apron, well outside the white lines. Mown grass, with the stripes
  // a groundsman leaves, because a flat green band reads as a colour swatch.
  group.add(ribbon((i) => -W(i) - 16, (i) => W(i) + 16, -0.06,
    new THREE.MeshStandardMaterial({
      map: S.grass, color: 0xffffff, roughness: 1, metalness: 0, side: THREE.DoubleSide,
    }), 11.0));

  // Asphalt. One tile is three metres, which is the scale at which the
  // aggregate reads as stones instead of noise.
  {
    const mat = new THREE.MeshStandardMaterial({
      map: S.asphalt,
      roughnessMap: S.asphaltRough,
      normalMap: S.asphaltNormal || null,
      color: 0xffffff, roughness: 1.0, metalness: 0.02, side: THREE.DoubleSide,
    });
    if (S.asphaltNormal) mat.normalScale.set(0.85, 0.85);
    group.add(ribbon((i) => -W(i) - 0.9, (i) => W(i) + 0.9, 0, weatherable(mat), 3.0));

    // Forty-one metres per tile, multiplied over the three-metre aggregate.
    // Two repeats that share no common factor never line up, so the surface
    // stops marching away from you in squares down the straight.
    if (quality.tier !== 'low') {
      group.add(ribbon((i) => -W(i) - 0.9, (i) => W(i) + 0.9, 0.0015,
        new THREE.MeshBasicMaterial({
          map: S.asphaltMacro, blending: THREE.MultiplyBlending,
          transparent: true, premultipliedAlpha: true, depthWrite: false, side: THREE.DoubleSide,
        }), 41.0));
    }
  }

  // White lines.
  const white = new THREE.MeshStandardMaterial({ color: 0xe9edf2, roughness: 0.6, side: THREE.DoubleSide });
  group.add(ribbon((i) => W(i) - 0.12, (i) => W(i) + 0.12, 0.012, white));
  group.add(ribbon((i) => -W(i) - 0.12, (i) => -W(i) + 0.12, 0.012, white));

  // Kerbs, only where the circuit actually turns, on the inside of the corner.
  buildKerbs(track, group, quality, S);

  // The starting grid. Twenty boxes staggered either side of the centreline,
  // painted where the cars actually line up, so the formation on the grid is
  // something you can see rather than something you take on trust.
  {
    const marks = [];
    const quad = (i0, i1, o0, o1, lift) => {
      const a = i0 * 3, b = i1 * 3;
      const v = new Float32Array([
        pos[a] + lat[a] * o0, pos[a + 1] + lift, pos[a + 2] + lat[a + 2] * o0,
        pos[a] + lat[a] * o1, pos[a + 1] + lift, pos[a + 2] + lat[a + 2] * o1,
        pos[b] + lat[b] * o0, pos[b + 1] + lift, pos[b + 2] + lat[b + 2] * o0,
        pos[b] + lat[b] * o1, pos[b + 1] + lift, pos[b + 2] + lat[b + 2] * o1,
      ]);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(v, 3));
      g.setIndex([0, 2, 1, 1, 2, 3]);
      g.computeVertexNormals();
      marks.push(g);
    };
    // Where the engine actually puts them: just past the line, pole furthest
    // up the road, eight metres a slot, staggered two-by-two about the
    // centreline. The paint has to agree with the simulation or the cars sit
    // in the wrong boxes on the one shot everybody looks at.
    const at = (metres) => ((Math.round(metres / track.step) % n) + n) % n;
    for (let k = 0; k < 20; k++) {
      const gridPos = k + 1;
      const ahead = (20 - gridPos) * 8;             // metres past the timing line
      const side = gridPos % 2 === 1 ? -1 : 1;
      const i0 = at(ahead - 0.2), i1 = at(ahead + 0.25);
      quad(i0, i1, side * 0.9, side * 3.9, 0.014);  // the line you stop on
      // The box's outer edge, running back from it.
      const j0 = at(ahead - 4.8), j1 = at(ahead + 0.25);
      quad(j0, j1, side * 3.72, side * 3.9, 0.014);
    }
    const g = mergeQuads(marks);
    if (g) {
      const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
        color: 0xf2f5f8, roughness: 0.55, side: THREE.DoubleSide,
      }));
      m.receiveShadow = !!quality.shadows;
      group.add(m);
    }
  }

  // Start/finish line.
  const slab = new THREE.Mesh(
    new THREE.PlaneGeometry(track.width[0] * 2, 1.6),
    new THREE.MeshStandardMaterial({ color: 0xf2f5f8, roughness: 0.5, side: THREE.DoubleSide }));
  slab.rotation.x = -Math.PI / 2;
  slab.position.set(track.x[0], track.y[0] + 0.02, track.z[0]);
  const tx = track.x[1] - track.x[0], tz = track.z[1] - track.z[0];
  slab.rotation.z = -Math.atan2(tz, tx) + Math.PI / 2;
  group.add(slab);

  group.userData.wetables = wetables;
  return group;
}

/**
 * Kerbs and the astroturf behind them.
 *
 * This used to be one mesh per sample — several hundred draw calls on a fast
 * circuit, each two triangles, each with its own material. Now every kerb on
 * the lap is one buffer and one draw, with the red-and-white carried by a
 * texture instead of by swapping materials, and a real four-point profile:
 * flush at the white line, rising to a crest, falling away to the run-off.
 * Riding it should look like riding something.
 */
/** Merge a handful of four-vertex quads into one buffer. */
function mergeQuads(geoms) {
  if (!geoms.length) return null;
  const verts = new Float32Array(geoms.length * 12);
  const idx = new Uint32Array(geoms.length * 6);
  geoms.forEach((g, k) => {
    verts.set(g.getAttribute('position').array, k * 12);
    const gi = g.getIndex().array;
    for (let q = 0; q < 6; q++) idx[k * 6 + q] = gi[q] + k * 4;
    g.dispose();
  });
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeVertexNormals();
  return out;
}

function buildKerbs(track, group, quality, S) {
  const n = track.samples;
  const { pos, lat } = track._frame;

  // Where the circuit actually turns, and which side is the inside.
  const segs = [];
  let run = null;
  for (let i = 0; i < n; i++) {
    const k = track.curv[i];
    if (Math.abs(k) > 1 / 320) {
      const side = k > 0 ? -1 : 1;
      if (run && run.side === side) run.end = i;
      else { if (run) segs.push(run); run = { start: i, end: i, side }; }
    } else if (run) { segs.push(run); run = null; }
  }
  if (run) segs.push(run);

  // Exit kerbs. A circuit does not only kerb the apex — the outside of the
  // exit gets one too, because that is the other place a car puts a wheel.
  // Taken from the back half of each corner, on the opposite side.
  for (const seg of segs.slice()) {
    const len = seg.end - seg.start;
    if (len < 10) continue;
    segs.push({ start: seg.start + Math.round(len * 0.45), end: seg.end + Math.round(len * 0.30), side: -seg.side });
  }

  // Across the kerb: offset from the white line, height above the road, and
  // where that lands in the texture.
  const PROFILE = [
    { off: 0.08, lift: 0.015, u: 0.02 },
    { off: 0.60, lift: 0.085, u: 0.32 },
    { off: 1.55, lift: 0.120, u: 0.94 },
    { off: 1.95, lift: 0.020, u: 1.00 },
  ];
  const COLS = PROFILE.length;
  const TILE_V = 2.6;                       // metres per red-and-white pair

  const kv = [], ku = [], ki = [];
  const tv = [], tu = [], ti = [];

  const push = (verts, uvs, idx, rows, cols) => {
    // Stitch a rows × cols grid that was just appended to `verts`.
    const base = verts.length / 3 - rows * cols;
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = base + r * cols + c, b = a + 1, d = a + cols, e = d + 1;
        idx.push(a, d, b, b, d, e);
      }
    }
  };

  for (const seg of segs) {
    const len = seg.end - seg.start;
    if (len < 3) continue;
    const rows = len + 1;

    for (let r = 0; r <= len; r++) {
      const i = (seg.start + r) % n;
      const o = i * 3;
      const w = track.width[i];
      const v = ((seg.start + r) * track.step) / TILE_V;
      for (const c of PROFILE) {
        const off = seg.side * (w + c.off);
        kv.push(pos[o] + lat[o] * off, pos[o + 1] + c.lift, pos[o + 2] + lat[o + 2] * off);
        ku.push(c.u, v);
      }
    }
    push(kv, ku, ki, rows, COLS);

    // Astroturf: beyond the kerb, at run-off level, two and a bit metres of it.
    for (let r = 0; r <= len; r++) {
      const i = (seg.start + r) % n;
      const o = i * 3;
      const w = track.width[i];
      const vv = ((seg.start + r) * track.step) / 2.5;
      for (const [off, uu] of [[1.95, 0], [4.30, 0.94]]) {
        const d = seg.side * (w + off);
        tv.push(pos[o] + lat[o] * d, pos[o + 1] + 0.004, pos[o + 2] + lat[o + 2] * d);
        tu.push(uu, vv);
      }
    }
    push(tv, tu, ti, rows, 2);
  }

  const build = (verts, uvs, idx, mat) => {
    if (!idx.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, mat);
    m.receiveShadow = !!quality.shadows;
    group.add(m);
  };

  build(kv, ku, ki, new THREE.MeshStandardMaterial({
    map: S.kerb, color: 0xffffff, roughness: 0.68, side: THREE.DoubleSide,
  }));
  build(tv, tu, ti, new THREE.MeshStandardMaterial({
    map: S.turf, color: 0xffffff, roughness: 1, side: THREE.DoubleSide,
  }));
}

// ---------------------------------------------------------------------------
// The scene
// ---------------------------------------------------------------------------

export const QUALITY = {
  low: { tier: 'low', shadows: false, pixelRatio: 1, anisotropy: 1, carLod: 2 },
  medium: { tier: 'medium', shadows: true, pixelRatio: 1.25, anisotropy: 4, carLod: 1 },
  high: { tier: 'high', shadows: true, pixelRatio: 1.75, anisotropy: 8, carLod: 0 },
};

export function detectQuality() {
  try {
    const cores = navigator.hardwareConcurrency || 4;
    const mem = navigator.deviceMemory || 4;
    const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    if (mobile) return cores >= 6 && mem >= 4 ? 'medium' : 'low';
    return cores >= 8 && mem >= 8 ? 'high' : 'medium';
  } catch { return 'medium'; }
}

/**
 * @param canvas  a <canvas> already in the document
 * @param track   from mgmt/track.js
 */
export function createRaceScene(canvas, track, opts = {}) {
  const quality = QUALITY[opts.quality] || QUALITY[detectQuality()];

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: quality.tier !== 'low', powerPreference: 'high-performance' });
  } catch {
    return null;                                    // caller falls back to the 2D map
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.pixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.34;   // adjusted per circuit below
  renderer.shadowMap.enabled = quality.shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  // Materials the weather is allowed to change. Each remembers what it looked
  // like dry, so the effect is applied rather than accumulated.
  scene._surfaces = [];
  // Fog matched to the sky's horizon, so distance fades into the sky rather
  // than into a flat colour that cuts the world off.
  scene.fog = new THREE.Fog(0x9fb8cf, 480, 2100);   // recoloured per circuit by setWeather

  // Lighting: a broad sky term plus one sun that casts the car shadows, and a
  // cool fill from the opposite side so the bodywork is never a silhouette.
  // Every circuit gets its own hour of the day, derived from its name, so a
  // season does not look like the same afternoon five times. Nothing about it
  // is random at run time: the same circuit is always the same light.
  const HOURS = [
    { name: 'noon', sun: [180, 260, 120], warm: 0xfff6e6, sky: 0x2a4f86, hor: 0x9fb8cf, exp: 1.34, amb: 2.15 },
    { name: 'afternoon', sun: [230, 150, 60], warm: 0xffe9c4, sky: 0x2f5a93, hor: 0xc0cbd4, exp: 1.30, amb: 2.00 },
    { name: 'evening', sun: [300, 70, -40], warm: 0xffcf96, sky: 0x1d3a6b, hor: 0xe0a06a, exp: 1.22, amb: 1.70 },
    { name: 'overcast', sun: [120, 320, 200], warm: 0xeef2f7, sky: 0x4a5a6b, hor: 0xb8c2cb, exp: 1.28, amb: 2.45 },
  ];
  const hourIdx = (() => {
    const id = (track.circuit && track.circuit.id) || '';
    let hsh = 0;
    for (let i = 0; i < id.length; i++) hsh = (hsh * 31 + id.charCodeAt(i)) >>> 0;
    return HOURS[hsh % HOURS.length];
  })();

  const hemi = new THREE.HemisphereLight(0xdcecfb, 0x3d4434, hourIdx.amb);
  scene.add(hemi);
  const fill = new THREE.DirectionalLight(0x9fc4f0, 0.55);
  fill.position.set(-160, 120, -200);
  scene.add(fill);
  const sun = new THREE.DirectionalLight(0xfff1d8, 2.9);
  sun.position.set(hourIdx.sun[0], hourIdx.sun[1], hourIdx.sun[2]);
  sun.color.setHex(hourIdx.warm);
  if (quality.shadows) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    const d = 90;
    sun.shadow.camera.left = -d; sun.shadow.camera.right = d;
    sun.shadow.camera.top = d; sun.shadow.camera.bottom = -d;
    sun.shadow.camera.near = 1; sun.shadow.camera.far = 700;
    sun.shadow.bias = -0.0012;
  }
  scene.add(sun);
  scene.add(sun.target);

  renderer.toneMappingExposure = hourIdx.exp;

  const circuit = buildTrackMesh(track, quality);
  scene.add(circuit);
  if (circuit.userData.wetables) scene._surfaces.push(...circuit.userData.wetables);

  /** The line a car takes if nobody is in the way. Mirrors the race engine. */
  // The same line the cars drive, so the rubber is laid where they actually go.
  const LINE = racingLine(track);
  function racingLineAt(u) {
    const f = ((u % 1) + 1) % 1;
    return LINE[Math.min(track.samples - 1, Math.floor(f * track.samples))];
  }

  // Ground. Without it the world simply stops at the edge of the run-off and
  // the cars appear to be racing over a void.
  {
    let cx = 0, cz = 0, span = 0;
    for (let i = 0; i < track.samples; i++) { cx += track.x[i]; cz += track.z[i]; }
    cx /= track.samples; cz /= track.samples;
    for (let i = 0; i < track.samples; i++) {
      span = Math.max(span, Math.hypot(track.x[i] - cx, track.z[i] - cz));
    }
    // Same grass as the run-off ribbon, so the join between the two does not
    // draw a line round the circuit.
    // A far coarser tile out here: at this distance a seven-metre repeat
    // minifies into moire, and nobody is close enough to want the detail.
    const gt = surfaces(quality.tier).grass.clone();
    gt.needsUpdate = true;
    gt.repeat.set(span * 5 / 26, span * 5 / 26);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(span * 5, span * 5),
      new THREE.MeshStandardMaterial({ map: gt, color: 0xa9bda4, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(cx, track.y[0] - 0.9, cz);
    ground.receiveShadow = !!quality.shadows;
    scene.add(ground);

    const sky = buildSky(new THREE.Vector3(cx, track.y[0], cz));
    scene.add(sky.mesh);
    scene._sky = sky;
  }

  // Barriers, hoardings, gravel, grandstands, trees and the gantry.
  scene.add(buildWorld(track, { quality, racingLine: racingLineAt }));

  // A contact shadow under every car. Only a handful cast a real shadow —
  // a shadow map is a second pass over the geometry — but a car with nothing
  // underneath it looks like it is hovering, so every one gets a dark ellipse
  // and all twenty of them are a single draw call.
  const blobs = (() => {
    const tex = (() => {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const g = c.getContext('2d');
      const rad = g.createRadialGradient(32, 32, 2, 32, 32, 31);
      rad.addColorStop(0, 'rgba(0,0,0,0.85)');
      rad.addColorStop(0.55, 'rgba(0,0,0,0.42)');
      rad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = rad; g.fillRect(0, 0, 64, 64);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    })();
    const mesh = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.62 }),
      24);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    scene.add(mesh);
    return mesh;
  })();
  const _m4 = new THREE.Matrix4();
  const _mr = new THREE.Matrix4();
  const _sc = new THREE.Vector3();
  const _hide = new THREE.Matrix4().makeScale(0, 0, 0);

  // Smoke and dust, for the moments something goes wrong.
  const puffs = createPuffs(scene, quality.tier === 'low' ? 40 : 96);

  // ---- cameras ----------------------------------------------------------
  const camA = new THREE.PerspectiveCamera(46, 1, 1, 3000);
  const camB = new THREE.PerspectiveCamera(46, 1, 1, 3000);

  /**
   * Keep the HORIZONTAL field of view fixed and let the vertical one follow the
   * pane. A split pane is nearly four times wider than it is tall; holding the
   * vertical angle instead would bend the world at the edges.
   */
  const HFOV = 64 * Math.PI / 180;
  function setAspect(cam, aspect) {
    cam.aspect = aspect;
    const v = 2 * Math.atan(Math.tan(HFOV / 2) / Math.max(0.6, aspect)) * 180 / Math.PI;
    cam.fov = Math.max(20, Math.min(52, v));
    cam.updateProjectionMatrix();
  }
  const state = {
    mode: 'top',            // 'top' | 'split'
    zoom: 48,               // slant distance from the car, in metres
    tilt: 0.22,             // 0 = broadcast chase, 1 = straight down
    targets: [null, null],
    timeScale: 1,           // the camera has to turn as fast as the car does
    wet: 0,
    follow: [new THREE.Vector3(), new THREE.Vector3()],
    heading: [0, 0],
    shakeT: 0,
  };

  // ---- cars -------------------------------------------------------------
  const cars = new Map();   // id -> { model, group, data, lastPos }

  // Lap phase -> fraction of the lap's length. Supplied by the race engine,
  // which owns the solved speed profile. Identity until it is set.
  let warp = null;

  function addCar(entry) {
    const model = createCarModel({
      team: entry.team,
      driver: entry.driver,
      quality: { tier: quality.tier, shadows: quality.shadows, anisotropy: quality.anisotropy },
      tyreCompound: 'medium',
    });
    model.setLOD(quality.carLod);
    scene.add(model.group);
    let marker = null;
    if (entry.isPlayer) {
      marker = new THREE.Mesh(
        new THREE.RingGeometry(2.25, 2.62, 40),
        new THREE.MeshBasicMaterial({ color: 0xff8a00, transparent: true, opacity: 0.62, side: THREE.DoubleSide, depthWrite: false }));
      marker.rotation.x = -Math.PI / 2;
      marker.renderOrder = 2;
      scene.add(marker);
    }

    const rec = {
      model,
      marker,
      id: entry.id,
      isPlayer: !!entry.isPlayer,
      pos: new THREE.Vector3(),
      heading: 0,
      // A fake wheel state: the models want compression and spin, and a
      // management sim does not compute suspension. Plausible beats absent.
      wheels: [0, 1, 2, 3].map(() => ({ spinAngle: 0, steerAngle: 0, compression: 0.5 })),
      speed: 0,
      visible: true,
      // Render-side position. The simulation advances in quarter-second steps;
      // drawing those steps raw is what made the cars stutter. These integrate
      // the car's own speed every frame and are sprung onto the simulation's
      // position, so the motion is continuous and still honest.
      smoothU: null,
      smoothLat: null,
      yaw: 0,
      // Detail bookkeeping: see applyDetail().
      alive: true,
      isPlayer: !!entry.isPlayer,
      dist: 0,
      lod: -1,
      shadow: null,
    };
    cars.set(entry.id, rec);
    return rec;
  }
  function addCars(entries) { for (const e of entries) addCar(e); return cars; }

  const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion();

  /** Position on the circuit for a lap fraction and a lateral offset in metres. */
  function placeAt(u, lateral, out) {
    const f = ((u % 1) + 1) % 1;
    const idx = f * track.samples;
    const i0 = Math.floor(idx) % track.samples;
    const i1 = (i0 + 1) % track.samples;
    const t = idx - Math.floor(idx);
    const { pos, lat } = track._frame;
    const a = i0 * 3, b = i1 * 3;
    const px = pos[a] + (pos[b] - pos[a]) * t;
    const py = pos[a + 1] + (pos[b + 1] - pos[a + 1]) * t;
    const pz = pos[a + 2] + (pos[b + 2] - pos[a + 2]) * t;
    const lx = lat[a] + (lat[b] - lat[a]) * t;
    const lz = lat[a + 2] + (lat[b + 2] - lat[a + 2]) * t;
    const ll = Math.hypot(lx, lz) || 1;
    out.set(px + (lx / ll) * lateral, py, pz + (lz / ll) * lateral);
    // Heading from the tangent.
    const tx = pos[b] - pos[a], tz = pos[b + 2] - pos[a + 2];
    return Math.atan2(tx, tz);
  }
  const curvAt = (u) => {
    const f = ((u % 1) + 1) % 1;
    return track.curv[Math.min(track.samples - 1, Math.floor(f * track.samples))];
  };

  /**
   * @param list    [{ id, u, prevU, status, tyre, drs, speed, lateral }]
   * @param alpha   how far the renderer is between the last simulation step
   *                and the next one, 0..1
   * @param realDt  wall-clock seconds, for the filters that are cosmetic
   *
   * The simulation advances in quarter-second steps. Drawing those steps raw
   * teleports the cars fourteen metres at a time; chasing the newest step with
   * a spring just turns the teleport into a lurch. Interpolating BETWEEN the
   * last two states is what actually produces constant velocity on screen.
   */
  function updateCars(list, alpha, realDt) {
    const rd = Math.max(1e-4, realDt ?? 0.016);
    const a = Math.max(0, Math.min(1, alpha ?? 1));
    for (const d of list) {
      const rec = cars.get(d.id);
      if (!rec) continue;
      const out = d.status === 'retired';
      rec.alive = !out;
      if (out) { rec.smoothU = null; continue; }

      const targetLat = d.lateral ?? 0;
      const speed = d.speed ?? 70;

      // Interpolate along the ring by the shortest way round — in lap PHASE,
      // which is what the simulation steps in, and only then map to a place on
      // the circuit. Interpolating the mapped positions instead would draw the
      // chord across a braking zone; mapping after interpolating gives the real
      // deceleration and the real exit.
      const from = d.prevU ?? d.u;
      let span = d.u - from;
      span -= Math.round(span);
      const phase = ((from + span * a) % 1 + 1) % 1;
      rec.smoothU = warp ? warp(phase) : phase;

      // Lateral is interpolated the same way as distance: the engine moves the
      // car across the track at a real rate, and the renderer draws the frames
      // in between.
      const prevLat = rec.smoothLat == null ? targetLat : rec.smoothLat;
      const fromLat = d.prevLateral ?? targetLat;
      rec.smoothLat = fromLat + (targetLat - fromLat) * a;

      const heading = placeAt(rec.smoothU, rec.smoothLat, _v);
      // A car changing line yaws into it slightly.
      const latRate = (rec.smoothLat - prevLat) / rd;
      const targetYaw = THREE.MathUtils.clamp(-latRate / Math.max(12, speed), -0.10, 0.10);
      rec.yaw += (targetYaw - rec.yaw) * Math.min(1, rd * 6);

      rec.model.group.position.copy(_v);
      rec.model.group.rotation.y = heading + rec.yaw;
      rec.pos.copy(_v);
      rec.heading = heading;
      if (rec.marker) rec.marker.position.set(_v.x, _v.y + 0.05, _v.z);
      rec.speed = speed;

      // Wheels: spin from speed, steer and body roll from local curvature.
      const k = curvAt(rec.smoothU);
      const steer = THREE.MathUtils.clamp(-k * 220, -0.42, 0.42);
      const spin = (rec.speed / 0.36) * rd;
      for (let i = 0; i < 4; i++) {
        const w = rec.wheels[i];
        w.spinAngle = (w.spinAngle + spin) % 6.283185307179586;
        w.steerAngle = i < 2 ? steer : 0;
        // Lateral load transfer: outside wheels compress in a corner.
        const side = (i % 2 === 0) ? -1 : 1;
        w.compression = THREE.MathUtils.clamp(0.5 + k * side * 140, 0.18, 0.86);
      }
      // Braking and throttle are not simulated, but they are implied: the solved
      // speed profile says what the car is doing, and the rate of change of that
      // is the pedal. It is what lights the brake discs and throws the smoke.
      const dv = (rec.speed - (rec.lastSpeed ?? rec.speed)) / Math.max(1e-3, rd);
      rec.lastSpeed = rec.speed;
      const brake = Math.max(0, Math.min(1, -dv / 26));
      const throttle = Math.max(0, Math.min(1, 0.25 + dv / 12));
      rec.brake = brake;
      // Hard on the brakes on a worn tyre picks up a wheel. It is the same pool
      // the spins and the gravel use.
      if (brake > 0.78 && rec.speed > 28 && Math.random() < rd * (0.5 + brake)) {
        puffs.emit(rec.pos.x, rec.pos.y, rec.pos.z, 'smoke', 1);
      }
      // In the wet the spray is the thing you actually see, so it comes off
      // every car that is moving, near the camera, all the time.
      if (state.wet > 0.18 && rec.speed > 24 && rec.lod < 2
          && Math.random() < rd * (2 + state.wet * 8)) {
        puffs.emit(rec.pos.x - Math.sin(rec.heading) * 2.4, rec.pos.y,
          rec.pos.z - Math.cos(rec.heading) * 2.4, 'spray', 1);
      }

      rec.model.setTyreCompound(d.tyre || 'medium');
      rec.model.setDRS(!!d.drs);
      // A car two hundred metres away does not need its suspension solved. The
      // wheels still turn — it is the per-corner work that is skipped.
      if (rec.lod >= 2 && !rec.isPlayer) continue;
      rec.model.update({
        wheels: rec.wheels,
        speed: rec.speed,
        steer,
        gForce: { lat: k * rec.speed * rec.speed, lon: -dv },
        throttle,
        brake,
        rpm: 5200 + Math.min(1, rec.speed / 92) * 7300,
      }, rd);
    }

    applyDetail();

    // Shadows follow the cars, squashed a little by speed so a quick car reads
    // as quick even from above.
    let bi = 0;
    for (const rec of cars.values()) {
      if (bi >= 24) break;
      if (!rec.alive || !rec.model.group.visible) { blobs.setMatrixAt(bi++, _hide); continue; }
      const len = 5.6 + Math.min(1.6, rec.speed * 0.02);
      _m4.makeRotationX(-Math.PI / 2);
      _m4.multiply(_mr.makeRotationZ(-rec.heading));
      _m4.scale(_sc.set(3.4, len, 1));
      _m4.setPosition(rec.pos.x, rec.pos.y + 0.035, rec.pos.z);
      blobs.setMatrixAt(bi++, _m4);
    }
    while (bi < 24) blobs.setMatrixAt(bi++, _hide);
    blobs.instanceMatrix.needsUpdate = true;
  }

  /**
   * Twenty cars at full detail is about six hundred draw calls a frame, and a
   * phone will not do that. Detail is spent where it can be seen: the cars near
   * the camera get the real model, the ones down the road get the cheap one,
   * and the ones a quarter of a mile away are not drawn at all. Only a handful
   * cast shadows, because a shadow map costs a second pass over the geometry.
   */
  const _byDist = [];
  function applyDetail() {
    const cam = state.mode === 'split' ? camA : camA;
    const eye = cam.position;
    _byDist.length = 0;
    for (const rec of cars.values()) {
      if (!rec.alive) { rec.model.group.visible = false; if (rec.marker) rec.marker.visible = false; continue; }
      rec.dist = rec.pos.distanceTo(eye);
      _byDist.push(rec);
    }
    _byDist.sort((a, b) => a.dist - b.dist);

    const thin = thrift > 0 || quality.tier !== 'high';
    const far = (state.mode === 'split' ? 200 : 260) * (thin ? 0.72 : 1);
    const shadowBudget = (quality.shadows && !thrift) ? (state.mode === 'split' ? 2 : 4) : 0;
    const nearCut = (state.mode === 'split' ? 24 : 30) * (thin ? 0.7 : 1);
    const midCut = (state.mode === 'split' ? 70 : 100) * (thin ? 0.7 : 1);

    // On a small machine, draw the cars that are actually in the fight and let
    // the timing tower speak for the rest. Nine cars is a whole battle.
    const maxDrawn = thin ? (quality.tier === 'low' ? 8 : 12) : _byDist.length;

    for (let i = 0; i < _byDist.length; i++) {
      const rec = _byDist[i];
      // Hysteresis: a car already on screen keeps its place until it is clearly
      // out of the picture, or the ones on the boundary blink in and out.
      const cut = rec.model.group.visible ? maxDrawn + 3 : maxDrawn;
      if (i >= cut && !rec.isPlayer) {
        rec.model.group.visible = false;
        if (rec.marker) rec.marker.visible = false;
        continue;
      }
      // In split view a car can be far from camA and right beside camB, so the
      // second camera gets a vote before anything is hidden.
      let d = rec.dist;
      if (state.mode === 'split') d = Math.min(d, rec.pos.distanceTo(camB.position));
      const show = rec.isPlayer || d < far;
      rec.model.group.visible = show;
      if (rec.marker) rec.marker.visible = show;
      if (!show) continue;
      const lv = d < nearCut ? 0 : d < midCut ? 1 : 2;
      const capped = Math.max(lv, quality.carLod === 2 ? 2 : lv);
      if (rec.lod !== capped) { rec.model.setLOD(capped); rec.lod = capped; }
      const wantShadow = i < shadowBudget && d < 90;
      if (rec.shadow !== wantShadow) { rec.model.setShadows?.(wantShadow); rec.shadow = wantShadow; }
    }
  }

  /**
   * If the machine cannot hold a frame, take something away rather than letting
   * it stutter: shadows first, then resolution, then the last of the detail.
   */
  let frameEma = 16;
  let thrift = 0;
  function adapt(rd) {
    frameEma += (Math.min(0.2, rd) * 1000 - frameEma) * 0.04;
    if (frameEma > 30 && thrift < 3) setThrift(thrift + 1);
    else if (frameEma < 15 && thrift > 0) setThrift(thrift - 1);
  }
  function setThrift(level) {
    thrift = level;
    if (level >= 1 && quality.shadows) { renderer.shadowMap.enabled = false; }
    if (level < 1 && quality.shadows) { renderer.shadowMap.enabled = true; }
    const pr = Math.min(window.devicePixelRatio || 1, quality.pixelRatio)
      * (level >= 2 ? 0.75 : 1) * (level >= 3 ? 0.8 : 1);
    if (Math.abs(renderer.getPixelRatio() - pr) > 0.02) { renderer.setPixelRatio(pr); resize(); }
  }

  // ---- camera update ----------------------------------------------------

  function aimCamera(cam, targetId, slot, dt) {
    const rec = targetId ? cars.get(targetId) : null;
    if (!rec) return false;
    const f = state.follow[slot];
    f.copy(rec.pos);
    // Heading follows too, so the car's direction of travel stays "up".
    let dh = rec.heading - state.heading[slot];
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    // At 15x the car changes direction fifteen times faster, so the view has
    // to follow fifteen times harder or the circuit swings around underneath it.
    state.heading[slot] += dh * Math.min(1, dt * (2.2 + state.timeScale * 1.6));

    // One control, two views. `tilt` sweeps the camera from a broadcast chase
    // — low, behind, the road running away to the horizon — to the tactical
    // overhead you want when you are counting places rather than watching.
    const d = state.zoom;
    const pitch = 0.220 + state.tilt * 1.25;         // 13° … 84° above horizontal
    const back = Math.cos(pitch) * d;
    const up = Math.sin(pitch) * d;
    const sh = Math.sin(state.heading[slot]);
    const ch = Math.cos(state.heading[slot]);
    // A hand-held wobble that grows with speed and dies away as the camera
    // climbs. From above it would just look like a fault.
    const rec2 = rec;
    const amp = (1 - state.tilt) * Math.min(1, (rec2.speed || 0) / 85) * 0.5;
    const tt = (state.shakeT += 0.016);
    const jx = (Math.sin(tt * 23.3) + Math.sin(tt * 37.7) * 0.6) * amp * 0.16;
    const jy = (Math.sin(tt * 19.1) + Math.sin(tt * 29.3) * 0.5) * amp * 0.12;
    cam.position.set(f.x - sh * back + jx, f.y + up + jy, f.z - ch * back);
    cam.up.set(0, 1, 0);
    // Aim down the road rather than at the car, so the car sits low in frame
    // and what you are looking at is where he is going.
    const lead = d * 0.06 * (1 - state.tilt);
    cam.lookAt(f.x + sh * lead, f.y + 1.0 - state.tilt * 0.6, f.z + ch * lead);
    // Frame the car in the lower third rather than dead centre: the road ahead
    // is what you are reading, and the pit wall decks live along the bottom.
    // Expressed as a fraction of the lens, or a split pane's long lens would
    // swing the car clean out of shot.
    const halfV = (cam.fov * Math.PI / 180) / 2;
    cam.rotateX(-halfV * 0.30 * (1 - state.tilt));
    sun.target.position.copy(f);
    sun.position.set(f.x + hourIdx.sun[0] * 0.55, f.y + hourIdx.sun[1] * 0.8, f.z + hourIdx.sun[2] * 0.55);
    if (sun.castShadow) {
      const d = Math.max(55, state.zoom * 1.25);
      if (Math.abs(sun.shadow.camera.right - d) > 8) {
        sun.shadow.camera.left = -d; sun.shadow.camera.right = d;
        sun.shadow.camera.top = d; sun.shadow.camera.bottom = -d;
        sun.shadow.camera.updateProjectionMatrix();
      }
    }
    return true;
  }

  /**
   * Where each car currently sits on screen, per viewport. Used to hang labels
   * over the cars so the view carries names, positions and tyres rather than
   * leaving you to guess which dot is yours.
   */
  const _p = new THREE.Vector3();
  function screenPositions() {
    const out = [];
    const panes = state.mode === 'split'
      ? [{ cam: camA, x0: 0, w: 0.5 }, { cam: camB, x0: 0.5, w: 0.5 }]
      : [{ cam: camA, x0: 0, w: 1 }];
    for (let pi = 0; pi < panes.length; pi++) {
      const pane = panes[pi];
      for (const rec of cars.values()) {
        if (!rec.model.group.visible) continue;
        _p.copy(rec.pos);
        _p.y += 1.1;
        _p.project(pane.cam);
        if (_p.z < -1 || _p.z > 1) continue;
        const nx = (_p.x + 1) / 2;
        const ny = (1 - _p.y) / 2;
        if (nx < -0.05 || nx > 1.05 || ny < -0.05 || ny > 1.05) continue;
        out.push({
          id: rec.id,
          pane: pi,
          isPlayer: rec.isPlayer,
          // Map into the pane's slice of the canvas: pane 0 is the left half.
          x: pane.x0 + nx * pane.w,
          y: ny,
          dist: rec.pos.distanceTo(pane.cam.position),
        });
      }
    }
    return out;
  }

  // ---- render -----------------------------------------------------------

  let W = 1, H = 1;
  function resize() {
    const rect = canvas.getBoundingClientRect();
    W = Math.max(1, Math.round(rect.width));
    H = Math.max(1, Math.round(rect.height));
    renderer.setSize(W, H, false);
  }

  function render(dt) {
    adapt(dt);
    puffs.update(dt, state.mode === 'split' ? camB : camA);
    if (state.mode === 'split') {
      // Side by side, not stacked. A stacked pane on a wide panel is four times
      // wider than it is tall, which no camera can frame; half the width each
      // gives both drivers a shot you can actually read.
      const half = Math.floor(W / 2);
      renderer.setScissorTest(true);
      const slots = [
        { cam: camA, target: state.targets[0], x: 0, w: half },
        { cam: camB, target: state.targets[1], x: half, w: W - half },
      ];
      for (let s = 0; s < 2; s++) {
        const sl = slots[s];
        setAspect(sl.cam, sl.w / Math.max(1, H));
        renderer.setViewport(sl.x, 0, sl.w, H);
        renderer.setScissor(sl.x, 0, sl.w, H);
        if (aimCamera(sl.cam, sl.target, s, dt)) renderer.render(scene, sl.cam);
      }
      renderer.setScissorTest(false);
    } else {
      setAspect(camA, W / H);
      renderer.setViewport(0, 0, W, H);
      if (aimCamera(camA, state.targets[0], 0, dt)) renderer.render(scene, camA);
    }
  }

  function setWeather(w) {
    const wet = w?.wetness ?? 0;
    state.wet = wet;
    // A wet circuit is darker and shinier, which is most of what tells you it
    // is wet before the spray starts.
    if (scene._surfaces) {
      for (const m of scene._surfaces) {
        m.roughness = m.userData.dryRough * (1 - wet * 0.72);
        m.color.copy(m.userData.dryColor).multiplyScalar(1 - wet * 0.30);
        m.needsUpdate = false;
      }
    }
    hemi.intensity = 2.15 - wet * 0.75;
    sun.intensity = 2.9 - wet * 2.2;
    fill.intensity = 0.55 + wet * 0.35;
    const sky = scene._sky;
    if (sky) {
      sky.uniforms.uTop.value.setHex(wet > 0.4 ? 0x33414f : hourIdx.sky).lerp(new THREE.Color(0x36404b), wet * 0.6);
      sky.uniforms.uHorizon.value.setHex(wet > 0.4 ? 0x6f7b88 : hourIdx.hor);
    }
    scene.fog.color.setHex(wet > 0.4 ? 0x6f7b88 : hourIdx.hor);
    scene.fog.far = 2100 - wet * 1100;
    for (const rec of cars.values()) rec.model.setRainLight(wet > 0.25);
  }

  function dispose() {
    for (const rec of cars.values()) {
      try { rec.model.dispose(); } catch {}
      if (rec.marker) { rec.marker.geometry.dispose(); rec.marker.material.dispose(); }
    }
    cars.clear();
    scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
    });
    puffs.dispose();
    renderer.dispose();
  }

  resize();
  return {
    scene, renderer, state, cars,
    addCars, updateCars, render, resize, setWeather, dispose, screenPositions,
    /** Kick up smoke or dust at a car's current position. */
    puff(id, kind = 'smoke', count = 4) {
      const rec = cars.get(id);
      if (rec && rec.model.group.visible) puffs.emit(rec.pos.x, rec.pos.y, rec.pos.z, kind, count);
    },
    setMode: (m) => { state.mode = m; },
    setTargets: (a, b) => { state.targets[0] = a; state.targets[1] = b; },
    setZoom: (z) => { state.zoom = Math.max(14, Math.min(420, z)); },
    setTilt: (t) => { state.tilt = Math.max(0, Math.min(1, t)); },
    /** How lap phase maps onto the circuit. See `updateCars`. */
    setWarp: (fn) => { warp = typeof fn === 'function' ? fn : null; },
    getTilt: () => state.tilt,
    setTimeScale: (t) => { state.timeScale = Math.max(1, t || 1); },
    getZoom: () => state.zoom,
    quality,
  };
}
