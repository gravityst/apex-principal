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
  renderer.toneMappingExposure = 1.18;
  renderer.shadowMap.enabled = quality.shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0f18);
  scene.fog = new THREE.Fog(0x0a0f18, 320, 1400);

  // Lighting: a broad sky term plus one sun that casts the car shadows.
  const hemi = new THREE.HemisphereLight(0xcfe2f5, 0x33392c, 1.85);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff3e0, 2.2);
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
      new THREE.PlaneGeometry(span * 4, span * 4),
      new THREE.MeshStandardMaterial({ color: 0x1d2a20, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(cx, track.y[0] - 0.9, cz);
    ground.receiveShadow = !!quality.shadows;
    scene.add(ground);
  }

  // ---- cameras ----------------------------------------------------------
  const camA = new THREE.PerspectiveCamera(46, 1, 1, 3000);
  const camB = new THREE.PerspectiveCamera(46, 1, 1, 3000);
  const state = {
    mode: 'top',            // 'top' | 'split'
    zoom: 80,               // metres above the car
    targets: [null, null],
    orient: 'across',       // 'across' uses a wide panel properly; 'along' is portrait
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
        new THREE.RingGeometry(2.9, 3.5, 40),
        new THREE.MeshBasicMaterial({ color: 0xff8a00, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }));
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

      if (rec.smoothLat == null) rec.smoothLat = targetLat;

      // Moving across the track is a manoeuvre, not a teleport.
      const prevLat = rec.smoothLat;
      rec.smoothLat += (targetLat - rec.smoothLat) * Math.min(1, rd * 2.0);

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

    const h = state.zoom;
    // A touch behind and above, looking down: close enough to read the car,
    // high enough to see who is next to it.
    const back = h * 0.30;
    cam.position.set(
      f.x - Math.sin(state.heading[slot]) * back,
      f.y + h,
      f.z - Math.cos(state.heading[slot]) * back);
    cam.up.set(0, 1, 0);
    cam.lookAt(f.x, f.y + 0.4, f.z);
    // The panel is far wider than it is tall, so the track is turned to run
    // ACROSS the screen rather than up it: the car sits left of centre and the
    // road ahead uses the width instead of wasting it on run-off.
    if (state.orient === 'across') cam.rotateZ(-Math.PI / 2);
    sun.target.position.copy(f);
    sun.position.set(f.x + 120, f.y + 210, f.z + 90);
    if (sun.castShadow) {
      const d = Math.max(60, state.zoom * 1.1);
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
      ? [{ cam: camB, y0: 0, h: 0.5 }, { cam: camA, y0: 0.5, h: 0.5 }]
      : [{ cam: camA, y0: 0, h: 1 }];
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
          x: nx,
          // Map into the pane's slice of the canvas. Pane 0 is the LOWER half
          // of the framebuffer, which is the BOTTOM of the element.
          y: (1 - pane.y0 - pane.h) + ny * pane.h,
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
    if (state.mode === 'split') {
      const half = Math.floor(H / 2);
      renderer.setScissorTest(true);
      const slots = [
        { cam: camA, target: state.targets[0], y: half, h: H - half },
        { cam: camB, target: state.targets[1], y: 0, h: half },
      ];
      for (let s = 0; s < 2; s++) {
        const sl = slots[s];
        sl.cam.aspect = W / Math.max(1, sl.h);
        sl.cam.updateProjectionMatrix();
        renderer.setViewport(0, sl.y, W, sl.h);
        renderer.setScissor(0, sl.y, W, sl.h);
        if (aimCamera(sl.cam, sl.target, s, dt)) renderer.render(scene, sl.cam);
      }
      renderer.setScissorTest(false);
    } else {
      camA.aspect = W / H;
      camA.updateProjectionMatrix();
      renderer.setViewport(0, 0, W, H);
      if (aimCamera(camA, state.targets[0], 0, dt)) renderer.render(scene, camA);
    }
  }

  function setWeather(w) {
    const wet = w?.wetness ?? 0;
    hemi.intensity = 1.55 - wet * 0.55;
    sun.intensity = 2.2 - wet * 1.5;
    scene.background.setHex(wet > 0.4 ? 0x141a22 : 0x0a0f18);
    scene.fog.color.copy(scene.background);
    scene.fog.far = 1400 - wet * 700;
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
    renderer.dispose();
  }

  resize();
  return {
    scene, renderer, state, cars,
    addCars, updateCars, render, resize, setWeather, dispose, screenPositions,
    setMode: (m) => { state.mode = m; },
    setTargets: (a, b) => { state.targets[0] = a; state.targets[1] = b; },
    setZoom: (z) => { state.zoom = Math.max(18, Math.min(420, z)); },
    setOrient: (o) => { state.orient = o; },
    setTimeScale: (t) => { state.timeScale = Math.max(1, t || 1); },
    getZoom: () => state.zoom,
    quality,
  };
}
