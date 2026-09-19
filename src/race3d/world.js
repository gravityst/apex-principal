/**
 * APEX: Principal — the world around the circuit.
 *
 * The first version of the 3D view was a grey ribbon on a green plane, which
 * read as a prototype rather than a race. Everything here exists to give the
 * eye something to judge speed and place against: a sky with a horizon in it,
 * walls that tell you where the track ends, grandstands and trees that go past,
 * and a racing line rubbered into the asphalt.
 *
 * All of it is generated from the circuit's own geometry, and all of it is
 * either instanced or merged, so twenty cars still have the frame to themselves.
 */

import * as THREE from '../../vendor/three/build/three.module.js';

// ---------------------------------------------------------------------------
// Sky
// ---------------------------------------------------------------------------

const SKY_VERT = `
varying vec3 vWorld;
void main() {
  vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SKY_FRAG = `
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform float uCentre;
varying vec3 vWorld;
void main() {
  float hRaw = (vWorld.y - uCentre) / 900.0;
  float h = clamp(hRaw, -1.0, 1.0);
  vec3 c = h > 0.0
    ? mix(uHorizon, uTop, pow(h, 0.55))
    : mix(uHorizon, uGround, pow(-h, 0.6));
  gl_FragColor = vec4(c, 1.0);
}`;

/** A gradient dome. Cheap, and it gives the scene a horizon to sit against. */
export function buildSky(centre) {
  const uniforms = {
    uTop: { value: new THREE.Color(0x2a4f86) },
    uHorizon: { value: new THREE.Color(0x9fb8cf) },
    uGround: { value: new THREE.Color(0x1a241d) },
    uCentre: { value: centre.y },
  };
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(2400, 32, 20),
    new THREE.ShaderMaterial({
      uniforms, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
      side: THREE.BackSide, depthWrite: false, fog: false,
    }));
  mesh.position.copy(centre);
  mesh.renderOrder = -1;
  mesh.frustumCulled = false;
  return { mesh, uniforms };
}

// ---------------------------------------------------------------------------
// The circuit's furniture
// ---------------------------------------------------------------------------

/**
 * @param track   from mgmt/track.js, already carrying `_frame`
 * @param opts    { quality, racingLine(u) -> metres }
 */
/** A box spanning a to b, `h` tall and `d` deep, lifted to sit on the ground. */
function boxBetween(a, b, h, d, lift) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const len = Math.max(0.6, Math.hypot(dx, dz));
  const g = new THREE.BoxGeometry(len, h, d);
  const m = new THREE.Matrix4();
  m.makeRotationY(Math.atan2(dx, dz) - Math.PI / 2);
  m.setPosition((a.x + b.x) / 2, (a.y + b.y) / 2 + lift, (a.z + b.z) / 2);
  g.applyMatrix4(m);
  return g;
}

export function buildWorld(track, opts) {
  const { pos, lat } = track._frame;
  const n = track.samples;
  const quality = opts.quality;
  const group = new THREE.Group();
  group.name = 'world';

  const P = (i, off, lift = 0) => {
    const o = (i % n) * 3;
    return new THREE.Vector3(
      pos[o] + lat[o] * off,
      pos[o + 1] + lift,
      pos[o + 2] + lat[o + 2] * off);
  };

  // ---- rubbered-in racing line -------------------------------------------
  // The darker strip a circuit acquires over a weekend. It also tells the eye,
  // instantly, which way the corner goes.
  {
    const verts = new Float32Array(n * 6);
    const idx = new Uint32Array(n * 6);
    for (let i = 0; i < n; i++) {
      const c = opts.racingLine(i / n);
      const a = P(i, c - 1.9, 0.006), b = P(i, c + 1.9, 0.006);
      verts.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6);
      const j = (i + 1) % n, k = i * 6;
      idx[k] = i * 2; idx[k + 1] = j * 2; idx[k + 2] = i * 2 + 1;
      idx[k + 3] = j * 2; idx[k + 4] = j * 2 + 1; idx[k + 5] = i * 2 + 1;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals();
    group.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({
      color: 0x22242a, roughness: 0.78, transparent: true, opacity: 0.85, side: THREE.DoubleSide,
    })));
  }

  // ---- the pit lane --------------------------------------------------------
  // A car serving a stop used to be drawn on the grass beside the track, doing
  // eighty. It is a lane, a wall and a row of garages, built from the same
  // centreline as everything else, between the entry and the exit.
  {
    const pit = track.circuit && track.circuit.pit;
    if (pit) {
      const side = pit.side === 'right' ? 1 : -1;
      const off = (pit.laneOffset ?? 15) * side;
      const HALF = 6.0;                                // lane half-width
      const i0 = Math.round(pit.entry * n);
      const span = Math.round((((pit.exit - pit.entry) % 1 + 1) % 1) * n);
      const steps = Math.max(8, span);

      // How far out the lane sits: it peels off the track and rejoins it, so
      // the ends taper rather than starting in mid-air.
      const outAt = (t) => {
        const ease = Math.min(1, Math.min(t, 1 - t) * 6);
        return off * ease + (track.width[(i0 + Math.round(t * steps)) % n] + 2) * side * (1 - ease);
      };

      const verts = new Float32Array((steps + 1) * 6);
      const idx = new Uint32Array(steps * 6);
      for (let k = 0; k <= steps; k++) {
        const i = (i0 + k) % n;
        const c = outAt(k / steps);
        const a = P(i, c - HALF, 0.012), b = P(i, c + HALF, 0.012);
        verts.set([a.x, a.y, a.z, b.x, b.y, b.z], k * 6);
        if (k < steps) {
          const j = k * 6;
          idx[j] = k * 2; idx[j + 1] = (k + 1) * 2; idx[j + 2] = k * 2 + 1;
          idx[j + 3] = (k + 1) * 2; idx[j + 4] = (k + 1) * 2 + 1; idx[j + 5] = k * 2 + 1;
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(verts, 3));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      g.computeVertexNormals();
      group.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({
        color: 0x3a3d45, roughness: 0.92, side: THREE.DoubleSide,
      })));

      // The wall between the lane and the circuit, and the garages behind it.
      const wallMat = new THREE.MeshStandardMaterial({ color: 0xd8dce2, roughness: 0.8 });
      const garageMat = new THREE.MeshStandardMaterial({ color: 0x2a3140, roughness: 0.9 });
      const doorMat = new THREE.MeshStandardMaterial({ color: 0x151a22, roughness: 0.95 });
      const wallParts = [], garageParts = [], doorParts = [];
      const seg = Math.max(2, Math.round(steps / 26));
      for (let k = 0; k < steps; k += seg) {
        const t0 = k / steps, t1 = Math.min(1, (k + seg) / steps);
        if (t0 < 0.08 || t1 > 0.92) continue;          // leave the tapers clear
        const a = P((i0 + k) % n, outAt(t0) - HALF * side, 0);
        const b = P((i0 + k + seg) % n, outAt(t1) - HALF * side, 0);
        wallParts.push(boxBetween(a, b, 1.0, 0.45, 0.5));
        const ga = P((i0 + k) % n, outAt(t0) + (HALF + 8) * side, 0);
        const gb = P((i0 + k + seg) % n, outAt(t1) + (HALF + 8) * side, 0);
        garageParts.push(boxBetween(ga, gb, 4.6, 7, 2.3));
        doorParts.push(boxBetween(ga, gb, 3.0, 5.6, 1.5));
      }
      const merged = (parts, mat) => {
        const m = mergeSimple(parts);
        if (m) group.add(new THREE.Mesh(m, mat));
      };
      merged(wallParts, wallMat);
      merged(garageParts, garageMat);
      merged(doorParts, doorMat);
    }
  }

  // ---- barriers, with advertising hoardings -------------------------------
  // A wall on each side gives the track an edge. Without one the asphalt just
  // dissolves into grass and there is no sense of a corridor.
  const HOARDING = quality.tier === 'low'
    ? [0xd8232f, 0x1f6fd0]
    : [0xd8232f, 0xf2f5f8, 0x1f6fd0, 0xf5c518, 0x0f8f6d];
  for (const sign of [-1, 1]) {
    const per = 6;                                   // samples per hoarding panel
    const groups = new Map();                        // colour -> geometry chunks
    for (let i = 0; i < n; i += per) {
      const w0 = track.width[i % n] + 11;
      const w1 = track.width[(i + per) % n] + 11;
      const a = P(i, sign * w0, 0);
      const b = P(i + per, sign * w1, 0);
      const h = 1.35;
      const v = new Float32Array([
        a.x, a.y, a.z, a.x, a.y + h, a.z,
        b.x, b.y, b.z, b.x, b.y + h, b.z,
      ]);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(v, 3));
      g.setIndex([0, 2, 1, 1, 2, 3]);
      g.computeVertexNormals();
      const col = HOARDING[(i / per) % HOARDING.length];
      if (!groups.has(col)) groups.set(col, []);
      groups.get(col).push(g);
    }
    for (const [col, geoms] of groups) {
      const merged = mergeSimple(geoms);
      const m = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({
        color: col, roughness: 0.62, metalness: 0.02, side: THREE.DoubleSide,
      }));
      m.castShadow = false;
      group.add(m);
      // A white capping rail along the top reads as a real barrier.
      group.add(new THREE.Mesh(merged.clone().translate(0, 1.36, 0),
        new THREE.MeshStandardMaterial({ color: 0xe8edf4, roughness: 0.5, side: THREE.DoubleSide })));
      break;                                          // one merge per side is enough
    }
    // Full-length wall behind the hoardings, so gaps never show sky through.
    const wallGeoms = [];
    for (let i = 0; i < n; i += 3) {
      const a = P(i, sign * (track.width[i % n] + 11.2), 0);
      const b = P(i + 3, sign * (track.width[(i + 3) % n] + 11.2), 0);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
        a.x, a.y, a.z, a.x, a.y + 1.5, a.z,
        b.x, b.y, b.z, b.x, b.y + 1.5, b.z,
      ]), 3));
      g.setIndex([0, 2, 1, 1, 2, 3]);
      g.computeVertexNormals();
      wallGeoms.push(g);
    }
    group.add(new THREE.Mesh(mergeSimple(wallGeoms), new THREE.MeshStandardMaterial({
      color: 0x38414f, roughness: 0.85, side: THREE.DoubleSide,
    })));
  }

  // ---- gravel traps on the outside of the quick corners --------------------
  {
    const geoms = [];
    for (let i = 0; i < n; i += 2) {
      const k = track.curv[i % n];
      if (Math.abs(k) < 1 / 260) continue;
      const sign = k > 0 ? 1 : -1;                   // outside of the corner
      const w = track.width[i % n];
      const a0 = P(i, sign * (w + 1.6), -0.02), a1 = P(i, sign * (w + 10.4), -0.04);
      const b0 = P(i + 2, sign * (track.width[(i + 2) % n] + 1.6), -0.02);
      const b1 = P(i + 2, sign * (track.width[(i + 2) % n] + 10.4), -0.04);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
        a0.x, a0.y, a0.z, a1.x, a1.y, a1.z, b0.x, b0.y, b0.z, b1.x, b1.y, b1.z,
      ]), 3));
      g.setIndex([0, 2, 1, 1, 2, 3]);
      g.computeVertexNormals();
      geoms.push(g);
    }
    if (geoms.length) {
      const m = new THREE.Mesh(mergeSimple(geoms), new THREE.MeshStandardMaterial({
        color: 0x8d7f63, roughness: 1, side: THREE.DoubleSide,
      }));
      m.receiveShadow = !!quality.shadows;
      group.add(m);
    }
  }

  // ---- grandstands --------------------------------------------------------
  // Placed on the outside of the slowest corners and along the pit straight,
  // which is where a circuit actually puts them.
  {
    const spots = [];
    spots.push({ i: 0, sign: 1, len: 26 });          // start/finish
    for (let i = 0; i < n; i += 14) {
      const k = Math.abs(track.curv[i % n]);
      if (k > 1 / 150 && spots.length < 9) {
        spots.push({ i, sign: track.curv[i % n] > 0 ? 1 : -1, len: 16 + Math.round(k * 2000) });
      }
    }
    const tierMat = new THREE.MeshStandardMaterial({ color: 0x3b4455, roughness: 0.9 });
    const crowdMat = new THREE.MeshStandardMaterial({ color: 0x6e7f9c, roughness: 1 });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x232a36, roughness: 0.7, metalness: 0.15 });
    for (const s of spots) {
      const a = P(s.i, s.sign * (track.width[s.i % n] + 13));
      const b = P(s.i + s.len, s.sign * (track.width[(s.i + s.len) % n] + 13));
      const dir = new THREE.Vector3().subVectors(b, a);
      const length = dir.length();
      if (length < 12) continue;
      const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
      const angle = Math.atan2(dir.x, dir.z);
      const out = new THREE.Vector3(Math.cos(angle), 0, -Math.sin(angle)).multiplyScalar(s.sign);

      // Stepped seating: three tiers going back and up.
      for (let t = 0; t < 3; t++) {
        const depth = 4.5;
        const hgt = 2.4 + t * 2.3;
        const box = new THREE.Mesh(new THREE.BoxGeometry(length, hgt, depth), t === 1 ? crowdMat : tierMat);
        box.position.copy(mid).addScaledVector(out, 2.6 + t * depth).setY(mid.y + hgt / 2);
        box.rotation.y = angle;
        box.castShadow = false;
        box.receiveShadow = false;
        group.add(box);
      }
      const roof = new THREE.Mesh(new THREE.BoxGeometry(length + 2, 0.6, 15), roofMat);
      roof.position.copy(mid).addScaledVector(out, 9).setY(mid.y + 9.6);
      roof.rotation.y = angle;
      group.add(roof);
    }
  }

  // ---- trees, instanced ---------------------------------------------------
  if (quality.tier !== 'low') {
    const COUNT = 420;
    const trunkGeo = new THREE.CylinderGeometry(0.28, 0.42, 2.4, 5);
    const leafGeo = new THREE.ConeGeometry(2.6, 6.4, 6);
    const trunk = new THREE.InstancedMesh(trunkGeo,
      new THREE.MeshStandardMaterial({ color: 0x4a3c2c, roughness: 1 }), COUNT);
    const leaf = new THREE.InstancedMesh(leafGeo,
      new THREE.MeshStandardMaterial({ color: 0x2f5233, roughness: 1 }), COUNT);
    const m4 = new THREE.Matrix4();
    let seed = 20260919;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let t = 0; t < COUNT; t++) {
      const i = Math.floor(rnd() * n);
      const sign = rnd() < 0.5 ? -1 : 1;
      const off = sign * (track.width[i] + 22 + rnd() * 120);
      const p = P(i, off);
      const sc = 0.7 + rnd() * 0.9;
      m4.makeScale(sc, sc, sc).setPosition(p.x, p.y + 1.2 * sc, p.z);
      trunk.setMatrixAt(t, m4);
      m4.makeScale(sc, sc, sc).setPosition(p.x, p.y + 5.2 * sc, p.z);
      leaf.setMatrixAt(t, m4);
    }
    trunk.instanceMatrix.needsUpdate = true;
    leaf.instanceMatrix.needsUpdate = true;
    trunk.frustumCulled = false; leaf.frustumCulled = false;
    group.add(trunk, leaf);
  }

  // ---- start/finish gantry ------------------------------------------------
  {
    const w = track.width[0];
    const a = P(0, -(w + 2)), b = P(0, w + 2);
    const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
    const angle = Math.atan2(b.x - a.x, b.z - a.z);
    const legMat = new THREE.MeshStandardMaterial({ color: 0x2b3341, roughness: 0.6, metalness: 0.3 });
    for (const sgn of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.7, 8, 0.7), legMat);
      leg.position.copy(P(0, sgn * (w + 2))).setY(mid.y + 4);
      group.add(leg);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry((w + 2) * 2, 1.6, 1.2), legMat);
    beam.position.copy(mid).setY(mid.y + 8.2);
    beam.rotation.y = angle;
    group.add(beam);
  }

  return group;
}

/** Merge a handful of small non-indexed-friendly geometries into one buffer. */
function mergeSimple(geoms) {
  let vCount = 0, iCount = 0;
  for (const g of geoms) {
    vCount += g.getAttribute('position').count;
    iCount += g.getIndex() ? g.getIndex().count : 0;
  }
  const pos = new Float32Array(vCount * 3);
  const idx = new Uint32Array(iCount);
  let vo = 0, io = 0, base = 0;
  for (const g of geoms) {
    const p = g.getAttribute('position');
    pos.set(p.array, vo * 3);
    const gi = g.getIndex();
    if (gi) for (let k = 0; k < gi.count; k++) idx[io + k] = gi.array[k] + base;
    io += gi ? gi.count : 0;
    base += p.count;
    vo += p.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeVertexNormals();
  return out;
}

// ---------------------------------------------------------------------------
// Dust and smoke
// ---------------------------------------------------------------------------

/**
 * A small pool of soft sprites. Cars kick these up when they lock a wheel, run
 * wide or spin — the cue that tells you something just went wrong without
 * having to read the radio.
 */
export function createPuffs(scene, max = 90) {
  const geo = new THREE.PlaneGeometry(1, 1);
  const tex = softDot();
  const mat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, depthWrite: false, opacity: 0.6,
    blending: THREE.NormalBlending, side: THREE.DoubleSide,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, max);
  mesh.frustumCulled = false;
  mesh.count = max;
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
  scene.add(mesh);

  const live = new Array(max).fill(null).map(() => ({ t: 0, life: 0 }));
  const m4 = new THREE.Matrix4();
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < max; i++) mesh.setMatrixAt(i, hidden);
  let cursor = 0;

  return {
    mesh,
    /** @param kind 'smoke' | 'dust' | 'spray' */
    emit(x, y, z, kind = 'smoke', count = 3) {
      for (let k = 0; k < count; k++) {
        const p = live[cursor];
        p.t = 0;
        p.life = kind === 'smoke' ? 1.1 + Math.random() * 0.7
          : kind === 'spray' ? 0.5 + Math.random() * 0.35
            : 0.8 + Math.random() * 0.5;
        p.x = x + (Math.random() - 0.5) * 2.4;
        p.y = y + 0.2;
        p.z = z + (Math.random() - 0.5) * 2.4;
        p.vy = kind === 'spray' ? 2.6 + Math.random() * 2.2 : 1.4 + Math.random() * 1.6;
        p.size = kind === 'smoke' ? 1.6 : kind === 'spray' ? 0.9 : 1.1;
        p.grow = kind === 'smoke' ? 5.5 : kind === 'spray' ? 7.5 : 3.4;
        const c = kind === 'smoke' ? [0.82, 0.82, 0.84]
          : kind === 'spray' ? [0.78, 0.84, 0.92] : [0.62, 0.55, 0.40];
        mesh.instanceColor.setXYZ(cursor, c[0], c[1], c[2]);
        cursor = (cursor + 1) % max;
      }
      mesh.instanceColor.needsUpdate = true;
    },
    update(dt, camera) {
      let any = false;
      for (let i = 0; i < max; i++) {
        const p = live[i];
        if (p.life <= 0) { mesh.setMatrixAt(i, hidden); continue; }
        any = true;
        p.t += dt;
        if (p.t >= p.life) { p.life = 0; mesh.setMatrixAt(i, hidden); continue; }
        const f = p.t / p.life;
        const s = p.size + p.grow * f;
        m4.makeScale(s, s, s);
        m4.setPosition(p.x, p.y + p.vy * p.t, p.z);
        // Face the camera.
        if (camera) {
          const q = new THREE.Quaternion();
          camera.getWorldQuaternion(q);
          const r = new THREE.Matrix4().makeRotationFromQuaternion(q);
          r.setPosition(p.x, p.y + p.vy * p.t, p.z);
          r.scale(new THREE.Vector3(s, s, s));
          m4.copy(r);
        }
        mesh.setMatrixAt(i, m4);
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.visible = any;
    },
    dispose() { geo.dispose(); mat.dispose(); tex.dispose(); },
  };
}

function softDot() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,0.95)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
