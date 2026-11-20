import * as THREE from 'three';

export interface ProceduralSurfaceTextureSet {
  map: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
}

function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

function finalizeTileTexture(
  canvas: HTMLCanvasElement,
  isSrgb: boolean,
  repeatX = 1,
  repeatY = 1,
): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.anisotropy = 8;
  if (isSrgb) {
    tex.colorSpace = THREE.SRGBColorSpace;
  }
  tex.needsUpdate = true;
  return tex;
}

/**
 * Generates tileable asphalt aggregate albedo & roughness textures
 * (world-meter scale ~0.22 repeat/m -> ~4.5m tile).
 */
export function createAsphaltTextureSet(): ProceduralSurfaceTextureSet {
  const size = 512;
  const albedo = document.createElement('canvas');
  albedo.width = size;
  albedo.height = size;
  const ctx = albedo.getContext('2d');
  const rough = document.createElement('canvas');
  rough.width = size;
  rough.height = size;
  const rCtx = rough.getContext('2d');
  if (!ctx || !rCtx) {
    throw new Error('Failed to acquire 2D canvas context for asphalt texture.');
  }

  ctx.fillStyle = '#262b33';
  ctx.fillRect(0, 0, size, size);

  rCtx.fillStyle = 'rgb(220, 220, 220)';
  rCtx.fillRect(0, 0, size, size);

  const rng = makePrng(4012026);
  // Subtle blotches for weathered tarmac variation
  for (let i = 0; i < 48; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const rad = 18 + rng() * 48;
    const dark = rng() > 0.5;
    const g = ctx.createRadialGradient(x, y, 2, x, y, rad);
    g.addColorStop(0, dark ? 'rgba(18, 22, 28, 0.22)' : 'rgba(92, 102, 114, 0.14)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }

  // Fine mineral aggregate stone speckle
  for (let i = 0; i < 16000; i++) {
    const x = Math.floor(rng() * size);
    const y = Math.floor(rng() * size);
    const v = rng();
    if (v > 0.68) {
      ctx.fillStyle = 'rgba(215, 222, 232, 0.12)';
      rCtx.fillStyle = 'rgb(195, 195, 195)';
    } else if (v < 0.35) {
      ctx.fillStyle = 'rgba(10, 14, 18, 0.18)';
      rCtx.fillStyle = 'rgb(240, 240, 240)';
    } else {
      ctx.fillStyle = 'rgba(120, 128, 138, 0.08)';
      rCtx.fillStyle = 'rgb(218, 218, 218)';
    }
    ctx.fillRect(x, y, 2, 2);
    rCtx.fillRect(x, y, 2, 2);
  }

  // Thin sealed crack seams
  ctx.strokeStyle = 'rgba(14, 17, 22, 0.25)';
  ctx.lineWidth = 1.2;
  for (let c = 0; c < 6; c++) {
    let cx = rng() * size;
    let cy = rng() * size;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    for (let s = 0; s < 10; s++) {
      cx += (rng() - 0.3) * 24;
      cy += (rng() - 0.5) * 18;
      ctx.lineTo(cx, cy);
    }
    ctx.stroke();
  }

  return {
    map: finalizeTileTexture(albedo, true),
    roughnessMap: finalizeTileTexture(rough, false),
  };
}

/**
 * Generates tileable poured-concrete textures with broom-finish grain and expansion joints.
 */
export function createConcreteTextureSet(): ProceduralSurfaceTextureSet {
  const size = 512;
  const albedo = document.createElement('canvas');
  albedo.width = size;
  albedo.height = size;
  const ctx = albedo.getContext('2d');
  const rough = document.createElement('canvas');
  rough.width = size;
  rough.height = size;
  const rCtx = rough.getContext('2d');
  if (!ctx || !rCtx) {
    throw new Error('Failed to acquire 2D canvas context for asphalt texture.');
  }

  ctx.fillStyle = '#aeb6bf';
  ctx.fillRect(0, 0, size, size);

  rCtx.fillStyle = 'rgb(225, 225, 225)';
  rCtx.fillRect(0, 0, size, size);

  const rng = makePrng(7789123);
  for (let i = 0; i < 40; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = 22 + rng() * 56;
    const grad = ctx.createRadialGradient(x, y, 2, x, y, r);
    grad.addColorStop(0, rng() > 0.5 ? 'rgba(255,255,255,0.09)' : 'rgba(65,72,82,0.1)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // Fine sand & broom-finish speckle
  for (let i = 0; i < 12000; i++) {
    const x = Math.floor(rng() * size);
    const y = Math.floor(rng() * size);
    ctx.fillStyle =
      rng() > 0.5 ? 'rgba(255,255,255,0.08)' : 'rgba(40,46,56,0.09)';
    ctx.fillRect(x, y, 2, 1);
  }

  // Subtle sidewalk expansion joints (1.5m slab intervals at 0.22 uv/m)
  ctx.strokeStyle = 'rgba(65, 74, 86, 0.22)';
  ctx.lineWidth = 2;
  for (const offset of [0, size * 0.5]) {
    ctx.beginPath();
    ctx.moveTo(offset, 0);
    ctx.lineTo(offset, size);
    ctx.moveTo(0, offset);
    ctx.lineTo(size, offset);
    ctx.stroke();
  }

  return {
    map: finalizeTileTexture(albedo, true),
    roughnessMap: finalizeTileTexture(rough, false),
  };
}

/**
 * Generates realistic urban turf, earth, and parkland ground textures for Aerial & Realistic 3D mode.
 */
export function createEarthTerrainTextureSet(
  repeat = 1,
): ProceduralSurfaceTextureSet {
  const size = 512;
  const albedo = document.createElement('canvas');
  albedo.width = size;
  albedo.height = size;
  const ctx = albedo.getContext('2d');
  const rough = document.createElement('canvas');
  rough.width = size;
  rough.height = size;
  const rCtx = rough.getContext('2d');
  if (!ctx || !rCtx) {
    throw new Error('Failed to acquire 2D canvas context for asphalt texture.');
  }

  // Warm muted urban grass/soil blend like southern Ontario satellite imagery
  ctx.fillStyle = '#3f523b';
  ctx.fillRect(0, 0, size, size);

  rCtx.fillStyle = 'rgb(242, 242, 242)';
  rCtx.fillRect(0, 0, size, size);

  const rng = makePrng(9021041);
  // Subtle urban parcel / rooftop / park patch tones
  for (let i = 0; i < 110; i++) {
    const px = Math.floor(rng() * 16) * 32;
    const py = Math.floor(rng() * 16) * 32;
    const pw = 32 + Math.floor(rng() * 3) * 32;
    const ph = 32 + Math.floor(rng() * 3) * 32;
    const choice = rng();
    if (choice < 0.36) {
      ctx.fillStyle = 'rgba(52, 76, 46, 0.34)'; // Lush tree canopy/parkland
    } else if (choice < 0.68) {
      ctx.fillStyle = 'rgba(78, 86, 68, 0.30)'; // Residential lots / soil
    } else {
      ctx.fillStyle = 'rgba(92, 96, 98, 0.25)'; // Built-up concrete/roof pad
    }
    ctx.fillRect(px, py, pw, ph);
  }

  // Soft canopy clumps & organic ground texture
  for (let i = 0; i < 6500; i++) {
    const x = Math.floor(rng() * size);
    const y = Math.floor(rng() * size);
    const bright = rng();
    if (bright > 0.65) {
      ctx.fillStyle = 'rgba(116, 138, 92, 0.16)';
    } else if (bright < 0.3) {
      ctx.fillStyle = 'rgba(24, 34, 22, 0.22)';
    } else {
      ctx.fillStyle = 'rgba(84, 92, 74, 0.14)';
    }
    ctx.fillRect(x, y, 3, 3);
  }

  return {
    map: finalizeTileTexture(albedo, true, repeat, repeat),
    roughnessMap: finalizeTileTexture(rough, false, repeat, repeat),
  };
}
