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

const UP = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------------------
// Track geometry
// ---------------------------------------------------------------------------

/**
 * Extrude the circuit from the sampler: asphalt, white lines, kerbs on the
 * corners, a run-off apron and a ground plane.
 */
function buildTrackMesh(track, quality) {
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

  /** Build a closed ribbon at a constant offset band from the centreline. */
  function ribbon(innerFn, outerFn, yLift, material, uvRepeat = 0.06) {
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
      const v = i * track.step * uvRepeat;
      uvs[i * 4] = 0; uvs[i * 4 + 1] = v;
      uvs[i * 4 + 2] = 1; uvs[i * 4 + 3] = v;
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

  // Run-off apron, well outside the white lines.
  group.add(ribbon((i) => -W(i) - 14, (i) => W(i) + 14, -0.06,
    new THREE.MeshStandardMaterial({ color: 0x2f3b30, roughness: 1, metalness: 0, side: THREE.DoubleSide })));

  // Asphalt.
  group.add(ribbon((i) => -W(i) - 0.9, (i) => W(i) + 0.9, 0,
    new THREE.MeshStandardMaterial({ color: 0x35383f, roughness: 0.92, metalness: 0.02, side: THREE.DoubleSide })));

  // White lines.
  const white = new THREE.MeshStandardMaterial({ color: 0xe9edf2, roughness: 0.6, side: THREE.DoubleSide });
  group.add(ribbon((i) => W(i) - 0.12, (i) => W(i) + 0.12, 0.012, white));
  group.add(ribbon((i) => -W(i) - 0.12, (i) => -W(i) + 0.12, 0.012, white));

  // Kerbs, only where the circuit actually turns, on the inside of the corner.
  buildKerbs(track, group, quality);

  // Start/finish line.
  const slab = new THREE.Mesh(
    new THREE.PlaneGeometry(track.width[0] * 2, 1.6),
    new THREE.MeshStandardMaterial({ color: 0xf2f5f8, roughness: 0.5, side: THREE.DoubleSide }));
  slab.rotation.x = -Math.PI / 2;
  slab.position.set(track.x[0], track.y[0] + 0.02, track.z[0]);
  const tx = track.x[1] - track.x[0], tz = track.z[1] - track.z[0];
  slab.rotation.z = -Math.atan2(tz, tx) + Math.PI / 2;
  group.add(slab);

  return group;
}

function buildKerbs(track, group, quality) {
  const n = track.samples;
  const { pos, lat } = track._frame;
  const segs = [];
  let run = null;
  for (let i = 0; i < n; i++) {
    const k = track.curv[i];
    if (Math.abs(k) > 1 / 320) {
      const side = k > 0 ? -1 : 1;                 // inside of the corner
      if (run && run.side === side) run.end = i;
      else { if (run) segs.push(run); run = { start: i, end: i, side }; }
    } else if (run) { segs.push(run); run = null; }
  }
  if (run) segs.push(run);

  const red = new THREE.MeshStandardMaterial({ color: 0xd8232f, roughness: 0.75, side: THREE.DoubleSide });
  const pale = new THREE.MeshStandardMaterial({ color: 0xeef1f4, roughness: 0.75, side: THREE.DoubleSide });

  for (const s of segs) {
    if (s.end - s.start < 3) continue;
    for (let i = s.start; i < s.end; i++) {
      const o = (i % n) * 3;
      const w = track.width[i % n];
      const inner = s.side * (w + 0.12);
      const outer = s.side * (w + 1.5);
      const j = (i + 1) % n;
      const oj = j * 3;
      const wj = track.width[j];
      const g = new THREE.BufferGeometry();
      const v = new Float32Array([
        pos[o] + lat[o] * inner, pos[o + 1] + 0.02, pos[o + 2] + lat[o + 2] * inner,
        pos[o] + lat[o] * outer, pos[o + 1] + 0.09, pos[o + 2] + lat[o + 2] * outer,
        pos[oj] + lat[oj] * (s.side * (wj + 0.12)), pos[oj + 1] + 0.02, pos[oj + 2] + lat[oj + 2] * (s.side * (wj + 0.12)),
        pos[oj] + lat[oj] * (s.side * (wj + 1.5)), pos[oj + 1] + 0.09, pos[oj + 2] + lat[oj + 2] * (s.side * (wj + 1.5)),
      ]);
      g.setAttribute('position', new THREE.BufferAttribute(v, 3));
      g.setIndex([0, 1, 2, 2, 1, 3]);
      g.computeVertexNormals();
      const mesh = new THREE.Mesh(g, (i - s.start) % 4 < 2 ? red : pale);
      mesh.receiveShadow = !!quality.shadows;
      group.add(mesh);
    }
  }
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
  renderer.toneMappingExposure = 1.34;
  renderer.shadowMap.enabled = quality.shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  // Fog matched to the sky's horizon, so distance fades into the sky rather
  // than into a flat colour that cuts the world off.
  scene.fog = new THREE.Fog(0x9fb8cf, 480, 2100);

  // Lighting: a broad sky term plus one sun that casts the car shadows, and a
  // cool fill from the opposite side so the bodywork is never a silhouette.
  const hemi = new THREE.HemisphereLight(0xdcecfb, 0x3d4434, 2.15);
  scene.add(hemi);
  const fill = new THREE.DirectionalLight(0x9fc4f0, 0.55);
  fill.position.set(-160, 120, -200);
  scene.add(fill);
  const sun = new THREE.DirectionalLight(0xfff1d8, 2.9);
  sun.position.set(180, 260, 120);
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

  const circuit = buildTrackMesh(track, quality);
  scene.add(circuit);

  /** The line a car takes if nobody is in the way. Mirrors the race engine. */
  function racingLineAt(u) {
    const f = ((u % 1) + 1) % 1;
    const i = Math.min(track.samples - 1, Math.floor(f * track.samples));
    const k = track.curv[i], w = track.width[i];
    return Math.max(-w * 0.55, Math.min(w * 0.55,
      -Math.sign(k) * Math.min(w * 0.45, Math.abs(k) * 2600)));
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
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(span * 5, span * 5),
      new THREE.MeshStandardMaterial({ color: 0x2c4430, roughness: 1 }));
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
    follow: [new THREE.Vector3(), new THREE.Vector3()],
    heading: [0, 0],
  };

  // ---- cars -------------------------------------------------------------
  const cars = new Map();   // id -> { model, group, data, lastPos }

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
      rec.model.group.visible = !out;
      if (rec.marker) rec.marker.visible = !out;
      if (out) { rec.smoothU = null; continue; }

      const targetLat = d.lateral ?? 0;
      const speed = d.speed ?? 70;

      // Interpolate along the ring by the shortest way round.
      const from = d.prevU ?? d.u;
      let span = d.u - from;
      span -= Math.round(span);
      rec.smoothU = ((from + span * a) % 1 + 1) % 1;

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
      rec.model.setTyreCompound(d.tyre || 'medium');
      rec.model.setDRS(!!d.drs);
      rec.model.update({
        wheels: rec.wheels,
        speed: rec.speed,
        steer,
        gForce: { lat: k * rec.speed * rec.speed, lon: 0 },
        throttle: 0.8, brake: 0, rpm: 11000,
      }, rd);
    }
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
    cam.position.set(f.x - sh * back, f.y + up, f.z - ch * back);
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
    sun.position.set(f.x + 120, f.y + 210, f.z + 90);
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
    hemi.intensity = 2.15 - wet * 0.75;
    sun.intensity = 2.9 - wet * 2.2;
    fill.intensity = 0.55 + wet * 0.35;
    const sky = scene._sky;
    if (sky) {
      sky.uniforms.uTop.value.setHex(wet > 0.4 ? 0x33414f : 0x2a4f86).lerp(new THREE.Color(0x36404b), wet * 0.6);
      sky.uniforms.uHorizon.value.setHex(wet > 0.4 ? 0x6f7b88 : 0x9fb8cf);
    }
    scene.fog.color.setHex(wet > 0.4 ? 0x6f7b88 : 0x9fb8cf);
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
    getTilt: () => state.tilt,
    setTimeScale: (t) => { state.timeScale = Math.max(1, t || 1); },
    getZoom: () => state.zoom,
    quality,
  };
}
