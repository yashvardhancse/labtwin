import { CanvasTexture, RepeatWrapping, SRGBColorSpace } from 'three';

/** Small procedural textures, drawn once on a canvas — no image assets to load. */

function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const el = document.createElement('canvas');
  el.width = el.height = size;
  const ctx = el.getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  return [el, ctx];
}

/** White radial falloff for glows and soft particles. */
export function radialTexture(size = 128, inner = 0): CanvasTexture {
  const [el, ctx] = canvas(size);
  const g = ctx.createRadialGradient(size / 2, size / 2, inner * size, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new CanvasTexture(el);
}

/** Speckled frost pattern, used as an alpha map so the frost builds up unevenly. */
export function frostTexture(size = 256, seed = 7): CanvasTexture {
  const [el, ctx] = canvas(size);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  let s = seed;
  const rand = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  for (let i = 0; i < 2200; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 0.4 + rand() * 2.2;
    const v = Math.floor(120 + rand() * 135);
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // Fern-like crystal strokes.
  ctx.strokeStyle = 'rgba(255,255,255,0.7)';
  ctx.lineWidth = 0.7;
  for (let i = 0; i < 90; i++) {
    let x = rand() * size;
    let y = rand() * size;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let k = 0; k < 4; k++) {
      x += (rand() - 0.5) * 14;
      y += (rand() - 0.5) * 14;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  const texture = new CanvasTexture(el);
  texture.wrapS = texture.wrapT = RepeatWrapping;
  return texture;
}

/** Square mesh of an EM grid (copper bars with open squares). */
export function gridMeshTexture(size = 256): CanvasTexture {
  const [el, ctx] = canvas(size);
  ctx.fillStyle = '#d2ad66';
  ctx.fillRect(0, 0, size, size);
  const cells = 14;
  const pitch = size / cells;
  ctx.fillStyle = '#4b3a22';
  for (let i = 0; i < cells; i++) {
    for (let j = 0; j < cells; j++) {
      ctx.fillRect(i * pitch + pitch * 0.18, j * pitch + pitch * 0.18, pitch * 0.64, pitch * 0.64);
    }
  }
  // Solid rim.
  ctx.strokeStyle = '#d2ad66';
  ctx.lineWidth = size * 0.08;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - ctx.lineWidth / 2, 0, Math.PI * 2);
  ctx.stroke();
  const texture = new CanvasTexture(el);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/** A single letter for axis labels. */
export function labelTexture(text: string, color: string, size = 64): CanvasTexture {
  const [el, ctx] = canvas(size);
  ctx.font = `600 ${size * 0.62}px "Instrument Sans Variable", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(text, size / 2, size / 2 + size * 0.04);
  const texture = new CanvasTexture(el);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}
