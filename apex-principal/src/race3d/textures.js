/**
 * APEX: Principal — procedural surfaces.
 *
 * Every texture in the game is drawn here, at load, into a canvas. Nothing is
 * downloaded, so the game stays a folder of text files and still starts
 * offline, and nothing about the look depends on a CDN staying up.
 *
 * The rules each of these follows:
 *
 *   - They tile. Anything drawn near an edge is drawn again on the opposite
 *     edge, so a seam never appears down the middle of a straight.
 *   - They are deterministic. One seeded generator, so a circuit looks the
 *     same every time you visit it.
 *   - They are small. 512 on a desktop, 256 on a phone; the asphalt is the
 *     only one that gets a normal map, because it is the only one a camera
 *     ever sits two metres above.
 */

import * as THREE from '../../vendor/three/build/three.module.js';

// One stream, seeded, so every surface is reproducible.
function rngFrom(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

function canvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

/** Draw a blob at (x, y) and again wherever it would wrap, so the tile seams. */
function wrapped(g, size, x, y, r, draw) {
  for (const dx of [0, -size, size]) {
    for (const dy of [0, -size, size]) {
      if (Math.abs(x + dx) > size + r || Math.abs(y + dy) > size + r) continue;
      draw(x + dx, y + dy);
    }
  }
}

function texFrom(c, { srgb = true, repeat = 1, aniso = 4 } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.repeat.set(repeat, repeat);
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

/**
 * Height field -> normal map. A Sobel over the luminance, which is enough to
 * give asphalt the grain that catches the sun at a low camera angle. Done once
 * at load; a 512² pass is about three milliseconds.
 */
function normalFrom(src, strength = 2.0) {
  const size = src.width;
  const sg = src.getContext('2d');
  const s = sg.getImageData(0, 0, size, size).data;
  const out = canvas(size);
  const og = out.getContext('2d');
  const img = og.createImageData(size, size);
  const L = (x, y) => {
    const i = (((y + size) % size) * size + ((x + size) % size)) * 4;
    return (s[i] * 0.299 + s[i + 1] * 0.587 + s[i + 2] * 0.114) / 255;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (L(x - 1, y - 1) + 2 * L(x - 1, y) + L(x - 1, y + 1))
               - (L(x + 1, y - 1) + 2 * L(x + 1, y) + L(x + 1, y + 1));
      const dy = (L(x - 1, y - 1) + 2 * L(x, y - 1) + L(x + 1, y - 1))
               - (L(x - 1, y + 1) + 2 * L(x, y + 1) + L(x + 1, y + 1));
      let nx = dx * strength, ny = dy * strength, nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      const i = (y * size + x) * 4;
      img.data[i] = (nx * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      img.data[i + 2] = (nz * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  og.putImageData(img, 0, 0);
  return out;
}

/** Grey-scale copy, contrast-shifted, for a roughness channel. */
function roughFrom(src, lo = 0.72, hi = 1.0) {
  const size = src.width;
  const s = src.getContext('2d').getImageData(0, 0, size, size);
  const d = s.data;
  for (let i = 0; i < d.length; i += 4) {
    const l = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255;
    // Darker aggregate is the coarse, rough stuff; the polished binder shines.
    const v = Math.round((hi - (hi - lo) * l) * 255);
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  const out = canvas(size);
  out.getContext('2d').putImageData(s, 0, 0);
  return out;
}

// ---------------------------------------------------------------------------
// The surfaces
// ---------------------------------------------------------------------------

/**
 * Asphalt: a dark binder, a spread of aggregate in half a dozen greys, a few
 * old patch repairs and the odd crack. The scale is set by the caller's UVs —
 * one tile is three metres square, which is the size at which the stones read
 * as stones rather than as noise.
 */
function asphaltCanvas(size, seed) {
  const rnd = rngFrom(seed);
  const c = canvas(size);
  const g = c.getContext('2d');

  g.fillStyle = '#31343a';
  g.fillRect(0, 0, size, size);

  // Large-scale tone stays very quiet. Anything with contrast at this scale
  // becomes the thing your eye locks onto, and then you can count the tiles
  // down the straight. The macro variation is a separate, far larger overlay.
  for (let i = 0; i < 18; i++) {
    const x = rnd() * size, y = rnd() * size, r = size * (0.14 + rnd() * 0.26);
    const light = rnd() < 0.5;
    wrapped(g, size, x, y, r, (px, py) => {
      const rad = g.createRadialGradient(px, py, 0, px, py, r);
      rad.addColorStop(0, light ? 'rgba(130,136,146,0.018)' : 'rgba(10,11,14,0.026)');
      rad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = rad;
      g.beginPath(); g.arc(px, py, r, 0, Math.PI * 2); g.fill();
    });
  }

  // Aggregate. The stones are what make it asphalt and not grey paint.
  const stones = Math.round(size * size / 34);
  for (let i = 0; i < stones; i++) {
    const x = rnd() * size, y = rnd() * size;
    const r = 0.5 + rnd() * (size / 190);
    const v = 44 + Math.round(rnd() * rnd() * 62);
    g.fillStyle = `rgba(${v},${v + 2},${v + 6},${0.26 + rnd() * 0.42})`;
    wrapped(g, size, x, y, r, (px, py) => {
      g.beginPath(); g.ellipse(px, py, r, r * (0.6 + rnd() * 0.7), rnd() * 3.14, 0, Math.PI * 2); g.fill();
    });
  }

  // Hairline cracks — fine enough that the repeat does not read.
  g.strokeStyle = 'rgba(12,12,15,0.20)';
  g.lineWidth = 1;
  for (let i = 0; i < 9; i++) {
    let x = rnd() * size, y = rnd() * size;
    let a = rnd() * Math.PI * 2;
    g.beginPath(); g.moveTo(x, y);
    for (let k = 0; k < 8; k++) {
      a += (rnd() - 0.5) * 1.1;
      x += Math.cos(a) * size * 0.035; y += Math.sin(a) * size * 0.035;
      g.lineTo(x, y);
    }
    g.stroke();
  }

  return c;
}

/**
 * The macro pass: forty metres of surface at a time. Mostly white, so it can
 * be multiplied over the asphalt, and it carries what the small tile cannot —
 * old resurfacing joins, a patch repair, the darker line where the sun never
 * quite dries it. Tiled at a different rate to the aggregate, it breaks the
 * repeat that otherwise marches away down every straight.
 */
function asphaltMacroCanvas(size, seed) {
  const rnd = rngFrom(seed);
  const c = canvas(size);
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, size, size);

  for (let i = 0; i < 30; i++) {
    const x = rnd() * size, y = rnd() * size, r = size * (0.08 + rnd() * 0.30);
    const dark = rnd() < 0.62;
    wrapped(g, size, x, y, r, (px, py) => {
      const rad = g.createRadialGradient(px, py, 0, px, py, r);
      rad.addColorStop(0, dark ? 'rgba(96,100,108,0.42)' : 'rgba(255,255,255,0.55)');
      rad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = rad;
      g.beginPath(); g.arc(px, py, r, 0, Math.PI * 2); g.fill();
    });
  }

  // A resurfacing join and a patch, at a scale where they look like repairs
  // rather than like pattern.
  for (let i = 0; i < 2; i++) {
    const y = rnd() * size;
    g.strokeStyle = 'rgba(110,114,122,0.5)';
    g.lineWidth = size / 110;
    g.beginPath();
    g.moveTo(0, y);
    for (let x = 0; x <= size; x += size / 16) g.lineTo(x, y + (rnd() - 0.5) * size * 0.02);
    g.stroke();
  }
  {
    const x = rnd() * size, y = rnd() * size;
    const w = size * 0.28, h = size * 0.17;
    wrapped(g, size, x, y, Math.max(w, h), (px, py) => {
      g.fillStyle = 'rgba(120,124,132,0.34)';
      g.fillRect(px - w / 2, py - h / 2, w, h);
    });
  }
  return c;
}

/**
 * A kerb tile, one red block and one pale block along V, with the outer edge
 * (high U) dirtied by the cars that ride it.
 */
function kerbCanvas(size, seed) {
  const rnd = rngFrom(seed);
  const c = canvas(size);
  const g = c.getContext('2d');
  const half = size / 2;

  g.fillStyle = '#cf2b30'; g.fillRect(0, 0, size, half);
  g.fillStyle = '#e9ecf0'; g.fillRect(0, half, size, half);

  // The joint between blocks, and a chamfer down the leading edge.
  g.fillStyle = 'rgba(0,0,0,0.30)';
  g.fillRect(0, half - 2, size, 3);
  g.fillRect(0, 0, size, 2);

  // Grime and rubber where the tyres actually land: the outer half.
  for (let i = 0; i < 420; i++) {
    const x = half + rnd() * half, y = rnd() * size;
    const r = 1 + rnd() * (size / 60);
    const t = (x - half) / half;
    g.fillStyle = `rgba(22,20,20,${0.04 + t * 0.20 * rnd()})`;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  // Two black tyre stripes: the line the cars take over it.
  for (const at of [0.62, 0.79]) {
    const grd = g.createLinearGradient(size * (at - 0.1), 0, size * (at + 0.1), 0);
    grd.addColorStop(0, 'rgba(18,16,16,0)');
    grd.addColorStop(0.5, 'rgba(18,16,16,0.30)');
    grd.addColorStop(1, 'rgba(18,16,16,0)');
    g.fillStyle = grd;
    g.fillRect(size * (at - 0.1), 0, size * 0.2, size);
  }
  return c;
}

/** Astroturf: the green strip that punishes running wide past the kerb. */
function turfCanvas(size, seed) {
  const rnd = rngFrom(seed);
  const c = canvas(size);
  const g = c.getContext('2d');
  g.fillStyle = '#356b45'; g.fillRect(0, 0, size, size);
  for (let i = 0; i < size * 14; i++) {
    const x = rnd() * size, y = rnd() * size;
    const v = rnd();
    g.strokeStyle = v < 0.5 ? 'rgba(34,82,50,0.55)' : 'rgba(78,124,86,0.42)';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + (rnd() - 0.5) * 3, y + 2 + rnd() * 3); g.stroke();
  }
  for (let i = 0; i < 140; i++) {
    const x = rnd() * size, y = rnd() * size, r = 2 + rnd() * (size / 22);
    g.fillStyle = `rgba(26,26,28,${0.05 + rnd() * 0.16})`;
    wrapped(g, size, x, y, r, (px, py) => { g.beginPath(); g.arc(px, py, r, 0, Math.PI * 2); g.fill(); });
  }
  return c;
}

/** Grass with mower stripes — the thing that says "this is a real venue". */
function grassCanvas(size, seed) {
  const rnd = rngFrom(seed);
  const c = canvas(size);
  const g = c.getContext('2d');
  g.fillStyle = '#31512f'; g.fillRect(0, 0, size, size);

  // Soft patches rather than mower stripes. Stripes tile into a chequerboard
  // the moment the ribbon's UVs run across as well as along, and a grid is the
  // one thing grass must never look like.
  for (let i = 0; i < 22; i++) {
    const x = rnd() * size, y = rnd() * size, r = size * (0.12 + rnd() * 0.3);
    const light = rnd() < 0.55;
    wrapped(g, size, x, y, r, (px, py) => {
      const rad = g.createRadialGradient(px, py, 0, px, py, r);
      rad.addColorStop(0, light ? 'rgba(96,140,84,0.055)' : 'rgba(28,54,32,0.065)');
      rad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = rad;
      g.beginPath(); g.arc(px, py, r, 0, Math.PI * 2); g.fill();
    });
  }
  for (let i = 0; i < size * 11; i++) {
    const x = rnd() * size, y = rnd() * size;
    const v = 30 + Math.round(rnd() * 50);
    g.fillStyle = `rgba(${Math.round(v * 0.62)},${v + 30},${Math.round(v * 0.66)},0.45)`;
    g.fillRect(x, y, 1 + rnd() * 2, 1 + rnd() * 2);
  }
  return c;
}

/** Gravel: pea shingle, pale, and coarse enough to read from the pit wall. */
function gravelCanvas(size, seed) {
  const rnd = rngFrom(seed);
  const c = canvas(size);
  const g = c.getContext('2d');
  g.fillStyle = '#9d9078'; g.fillRect(0, 0, size, size);
  for (let i = 0; i < size * 26; i++) {
    const x = rnd() * size, y = rnd() * size, r = 1 + rnd() * (size / 90);
    const v = 118 + Math.round(rnd() * 82);
    g.fillStyle = `rgba(${v},${v - 8},${v - 26},${0.35 + rnd() * 0.5})`;
    wrapped(g, size, x, y, r, (px, py) => { g.beginPath(); g.arc(px, py, r, 0, Math.PI * 2); g.fill(); });
  }
  return c;
}

/** A packed grandstand: people, not a blue box. */
function crowdCanvas(size, seed) {
  const rnd = rngFrom(seed);
  const c = canvas(size);
  const g = c.getContext('2d');
  // Pale seating, not a black void. A full stand at two hundred metres is a
  // bright mass with colour in it; if the gaps are dark the whole thing reads
  // as an empty building.
  g.fillStyle = '#5d6b7d'; g.fillRect(0, 0, size, size);
  const rows = 9;
  const pitch = size / 15;
  for (let r = 0; r < rows; r++) {
    const y = (r + 0.55) * (size / rows);
    // The step in front of each row.
    g.fillStyle = 'rgba(30,38,50,0.40)';
    g.fillRect(0, y + size / rows * 0.30, size, Math.max(2, size / 150));
    for (let i = 0; i < size / pitch; i++) {
      if (rnd() < 0.10) continue;                 // empty seats
      const x = (i + 0.5) * pitch + (rnd() - 0.5) * pitch * 0.4;
      const hue = Math.round(rnd() * 360);
      const lum = 50 + Math.round(rnd() * 30);
      const rad = pitch * 0.34;
      // Body.
      g.fillStyle = `hsl(${hue} ${6 + rnd() * 24}% ${lum}%)`;
      g.fillRect(x - rad, y - rad * 0.2, rad * 2, rad * 2.6);
      // Head.
      g.fillStyle = `hsl(${28 + rnd() * 18} ${22 + rnd() * 28}% ${38 + rnd() * 34}%)`;
      g.beginPath(); g.arc(x, y - rad * 0.8, rad * 0.78, 0, Math.PI * 2); g.fill();
    }
  }
  // Shade under the roof: a stand lit evenly top to bottom looks like a screen.
  const shade = g.createLinearGradient(0, 0, 0, size);
  shade.addColorStop(0, 'rgba(10,14,22,0.42)');
  shade.addColorStop(0.45, 'rgba(10,14,22,0.10)');
  shade.addColorStop(1, 'rgba(10,14,22,0.00)');
  g.fillStyle = shade; g.fillRect(0, 0, size, size);
  return c;
}

/** A stack of tyres, painted on the face of a barrier. */
function tyreWallCanvas(size, seed) {
  const rnd = rngFrom(seed);
  const c = canvas(size);
  const g = c.getContext('2d');
  g.fillStyle = '#15171b'; g.fillRect(0, 0, size, size);
  const cols = 8, rows = 4;
  const w = size / cols, h = size / rows;
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i < cols; i++) {
      const x = (i + 0.5) * w + (r % 2 ? w / 2 : 0), y = (r + 0.5) * h;
      const rad = Math.min(w, h) * 0.46;
      wrapped(g, size, x, y, rad, (px, py) => {
        const grd = g.createRadialGradient(px - rad * 0.3, py - rad * 0.3, rad * 0.1, px, py, rad);
        grd.addColorStop(0, '#3a3d43');
        grd.addColorStop(0.62, '#202227');
        grd.addColorStop(1, '#0d0e11');
        g.fillStyle = grd;
        g.beginPath(); g.arc(px, py, rad, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#0a0b0e';
        g.beginPath(); g.arc(px, py, rad * 0.42, 0, Math.PI * 2); g.fill();
      });
    }
  }
  // The white conveyor belting strapped over the front.
  g.fillStyle = 'rgba(226,232,240,0.80)';
  for (let r = 0; r < rows; r++) g.fillRect(0, (r + 0.5) * h - 3, size, 6);
  for (let i = 0; i < 260; i++) {
    const x = rnd() * size, y = rnd() * size;
    g.fillStyle = `rgba(0,0,0,${rnd() * 0.25})`;
    g.fillRect(x, y, 2 + rnd() * 6, 2 + rnd() * 4);
  }
  return c;
}

/**
 * The rubbered-in line. Across U it fades to nothing at both edges, because a
 * racing line has no border — it is where more cars have been, not a painted
 * strip. Along V it varies, because braking zones and traction zones lay down
 * more than the middle of a corner does.
 */
function rubberCanvas(size, seed) {
  const rnd = rngFrom(seed);
  const c = canvas(size);
  const g = c.getContext('2d');
  g.clearRect(0, 0, size, size);
  const grd = g.createLinearGradient(0, 0, size, 0);
  grd.addColorStop(0.00, 'rgba(24,24,28,0)');
  grd.addColorStop(0.22, 'rgba(24,24,28,0.62)');
  grd.addColorStop(0.50, 'rgba(20,20,24,0.92)');
  grd.addColorStop(0.78, 'rgba(24,24,28,0.62)');
  grd.addColorStop(1.00, 'rgba(24,24,28,0)');
  g.fillStyle = grd; g.fillRect(0, 0, size, size);
  // Thin it unevenly along the lap.
  for (let i = 0; i < 34; i++) {
    const y = rnd() * size, h = size * (0.04 + rnd() * 0.16);
    g.globalCompositeOperation = 'destination-out';
    const f = g.createLinearGradient(0, y, 0, y + h);
    f.addColorStop(0, 'rgba(0,0,0,0)');
    f.addColorStop(0.5, `rgba(0,0,0,${0.10 + rnd() * 0.30})`);
    f.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = f; g.fillRect(0, y, size, h);
    g.globalCompositeOperation = 'source-over';
  }
  return c;
}

/** Debris fencing: mostly hole, which is the point. */
function fenceCanvas(size) {
  const c = canvas(size);
  const g = c.getContext('2d');
  g.clearRect(0, 0, size, size);
  g.strokeStyle = 'rgba(196,206,218,0.80)';
  g.lineWidth = Math.max(1, size / 128);
  const step = size / 8;
  for (let i = -8; i <= 16; i++) {
    g.beginPath(); g.moveTo(i * step, 0); g.lineTo(i * step + size, size); g.stroke();
    g.beginPath(); g.moveTo(i * step, size); g.lineTo(i * step + size, 0); g.stroke();
  }
  return c;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

let CACHE = null;

/**
 * Build (once) and return every surface the circuit needs.
 * @param tier 'low' | 'medium' | 'high'
 */
export function surfaces(tier = 'medium', aniso = 4) {
  if (CACHE && CACHE.tier === tier) return CACHE;

  const big = tier === 'low' ? 256 : 512;
  const small = tier === 'low' ? 128 : 256;

  const asph = asphaltCanvas(big, 0x9e3779b9);
  const out = {
    tier,
    asphalt: texFrom(asph, { aniso }),
    // The grain only earns its keep where a camera gets close to the road.
    asphaltNormal: tier === 'low' ? null : texFrom(normalFrom(asph, 1.5), { srgb: false, aniso }),
    asphaltRough: texFrom(roughFrom(asph, 0.74, 0.99), { srgb: false, aniso }),
    asphaltMacro: texFrom(asphaltMacroCanvas(big, 0xc0ffee1), { aniso }),
    kerb: texFrom(kerbCanvas(small, 0x5bd1d7), { aniso }),
    turf: texFrom(turfCanvas(small, 0x1f123d), { aniso }),
    grass: texFrom(grassCanvas(big, 0x2545ab), { aniso }),
    gravel: texFrom(gravelCanvas(small, 0x77aa31), { aniso }),
    crowd: texFrom(crowdCanvas(big, 0x3ea5b1), { aniso: 1 }),
    tyreWall: texFrom(tyreWallCanvas(small, 0x8812fe), { aniso }),
    fence: texFrom(fenceCanvas(small), { srgb: false, aniso: 1 }),
    rubber: texFrom(rubberCanvas(small, 0x4d2b17), { aniso }),
  };
  CACHE = out;
  return out;
}
