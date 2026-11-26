import type { MachineConfig, Vec3 } from './machine.ts';

/**
 * Visual model of the machine as a kinematic chain of links built from
 * primitive shapes — a compact, URDF-like description. The three.js view and
 * the Foxglove `/scene` export are both generated from this one list, so they
 * can never disagree.
 *
 * Frames (all prismatic joints, no rotation):
 *   world → gantry_y (y) → carriage_x (x) → head_z (z)
 * The head_z origin is the needle tip, so the tool-centre point in world
 * coordinates is exactly (x, y, z). Machine axes: X right, Y away from the
 * operator, Z up; Z = 0 is the grid plane. Units: mm.
 *
 * The three.js renderer rounds the box edges and adds cosmetic-only detail
 * (cable drag chain, fasteners, LED ring); those are not in this list, so the
 * Foxglove scene stays a clean set of primitives.
 */

export type LinkName = 'world' | 'gantry_y' | 'carriage_x' | 'head_z';
export const LINKS: readonly LinkName[] = ['world', 'gantry_y', 'carriage_x', 'head_z'];
export const PARENT: Record<Exclude<LinkName, 'world'>, LinkName> = {
  gantry_y: 'world',
  carriage_x: 'gantry_y',
  head_z: 'carriage_x',
};

export type MaterialName =
  | 'base' // powder-coated cast base
  | 'frame' // bright clear-anodized aluminium structure
  | 'black' // black-anodized brackets and carriages
  | 'steel' // shafts, rails, needle, fasteners
  | 'copper' // cryo cold block
  | 'white' // PTFE / POM insulation and clamps
  | 'glass' // syringe barrel, vial
  | 'sample' // liquid sample
  | 'grid' // gold EM grid
  | 'rubber' // feet, seals, bellows
  | 'hose' // vacuum-insulated cryogen line
  | 'lens'; // camera optics

/** Role tags let the 3D view find and animate or special-case specific parts. */
export type PartRole =
  'cold-plate' | 'grid' | 'syringe' | 'plunger-anchor' | 'camera' | 'led' | 'vial-liquid' | 'deck-surface';

export interface Primitive {
  id: string;
  link: LinkName;
  shape: 'box' | 'cylinder';
  /** Centre in the link frame, mm. */
  center: Vec3;
  /** Box: edge lengths. Cylinder: x = diameter, z = length along its axis. */
  size: Vec3;
  /** Cylinder axis direction (boxes ignore it). */
  axis?: 'x' | 'y' | 'z';
  material: MaterialName;
  role?: PartRole;
  /** Renderer hint: keep crisp edges (thin plates, rails) instead of rounding. */
  sharp?: boolean;
}

/** sRGB colours (0–1) used by both renderers. */
export const MATERIAL_COLORS: Record<MaterialName, { r: number; g: number; b: number; a: number }> = {
  base: rgb(0x2b3037),
  frame: rgb(0xb4bcc5),
  black: rgb(0x242930),
  steel: rgb(0xccd2d8),
  copper: rgb(0xb66a33),
  white: rgb(0xe8e7e1),
  glass: { ...rgb(0xd6ebf2), a: 0.28 },
  sample: { ...rgb(0xb4a3ee), a: 0.85 },
  grid: rgb(0xd7b46a),
  rubber: rgb(0x15181b),
  hose: rgb(0x98a1aa),
  lens: rgb(0x0d1013),
};

function rgb(hex: number) {
  return { r: ((hex >> 16) & 255) / 255, g: ((hex >> 8) & 255) / 255, b: (hex & 255) / 255, a: 1 };
}

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

/**
 * Fixed geometry of the gantry, shared between the parts list and the renderer
 * (the cable drag chain needs the bridge and rail positions).
 */
export const GANTRY = {
  deckTop: -22, // top of the base casting; the grid plane (Z = 0) sits above it
  postX: { left: -26, right: 146 },
  postY: { front: -4, back: 104 },
  railTopZ: 132, // centre height of the Y rails on top of the posts
  bridgeY: 34, // the bridge sits toward the operator side
  bridgeZ: 150, // centre height of the bridge beam
  xRailZ: 134, // X rail on the front face of the bridge
  xRailFrontY: 19, // Y of the X-rail / carriage front face
} as const;

export function machineGeometry(m: MachineConfig): Primitive[] {
  const g = GANTRY;
  const parts: Primitive[] = [];
  const box = (
    id: string,
    link: LinkName,
    center: Vec3,
    size: Vec3,
    material: MaterialName,
    opts: { role?: PartRole; sharp?: boolean } = {},
  ) => parts.push({ id, link, shape: 'box', center, size, material, ...opts });
  const cyl = (
    id: string,
    link: LinkName,
    center: Vec3,
    diameter: number,
    length: number,
    material: MaterialName,
    axis: 'x' | 'y' | 'z' = 'z',
    opts: { role?: PartRole; sharp?: boolean } = {},
  ) =>
    parts.push({
      id,
      link,
      shape: 'cylinder',
      center,
      size: v(diameter, diameter, length),
      axis,
      material,
      ...opts,
    });

  // ── Base casting, work surface and feet (world) ──────────────────
  const baseTop = g.deckTop;
  box('base', 'world', v(60, 42, baseTop - 11), v(230, 184, 22), 'base');
  box('base-skirt', 'world', v(60, 42, baseTop - 24), v(214, 168, 8), 'base');
  box('work-surface', 'world', v(62, 34, baseTop + 1.5), v(150, 118, 5), 'black', { role: 'deck-surface' });
  for (const [fx, fy] of [
    [-42, -40],
    [162, -40],
    [-42, 124],
    [162, 124],
  ] as const) {
    cyl(`foot-${fx}-${fy}`, 'world', v(fx, fy, baseTop - 26), 18, 10, 'rubber');
    cyl(`foot-pad-${fx}-${fy}`, 'world', v(fx, fy, baseTop - 31), 22, 3, 'black');
  }
  // Low back panel with a brand-neutral nameplate.
  box('back-panel', 'world', v(60, 118, baseTop + 26), v(176, 10, 52), 'frame');
  box('nameplate', 'world', v(60, 112.5, baseTop + 30), v(84, 1.5, 20), 'black', { sharp: true });

  // ── Four columns carrying the Y rails (world) ────────────────────
  const columnH = g.railTopZ - 7 - baseTop;
  for (const px of [g.postX.left, g.postX.right]) {
    for (const py of [g.postY.front, g.postY.back]) {
      box(`col-${px}-${py}`, 'world', v(px, py, baseTop + columnH / 2), v(22, 22, columnH), 'black');
      box(`col-flange-${px}-${py}`, 'world', v(px, py, baseTop + 4), v(30, 30, 8), 'frame');
      box(`col-cap-${px}-${py}`, 'world', v(px, py, baseTop + columnH), v(26, 26, 6), 'frame');
    }
  }

  // ── Y linear rails on top of the columns (world) ─────────────────
  for (const px of [g.postX.left, g.postX.right]) {
    box(`yrail-base-${px}`, 'world', v(px, 50, g.railTopZ - 4), v(16, 150, 8), 'frame');
    box(`yrail-${px}`, 'world', v(px, 50, g.railTopZ + 2), v(9, 150, 6), 'steel', { sharp: true });
    box(`yrail-groove-${px}`, 'world', v(px, 50, g.railTopZ + 3.4), v(3.4, 150, 3.4), 'black', {
      sharp: true,
    });
    // Y drive: a lead screw and stepper at the back of each rail.
    cyl(`yscrew-${px}`, 'world', v(px, 50, g.railTopZ - 10), 5, 150, 'steel', 'y');
    box(`ymotor-${px}`, 'world', v(px, 128, g.railTopZ - 10), v(26, 30, 26), 'black');
  }

  // ── Gantry bridge riding the Y rails (gantry_y) ──────────────────
  for (const px of [g.postX.left, g.postX.right]) {
    // Y carriage block sitting on the rail.
    box(`ycar-${px}`, 'gantry_y', v(px, g.bridgeY, g.railTopZ + 8), v(30, 40, 20), 'black');
    box(`ycar-rib-${px}`, 'gantry_y', v(px, g.bridgeY, g.railTopZ + 20), v(18, 34, 10), 'black');
  }
  const bridgeLen = g.postX.right - g.postX.left + 34;
  box('bridge', 'gantry_y', v(60, g.bridgeY, g.bridgeZ), v(bridgeLen, 30, 26), 'frame');
  box('bridge-face', 'gantry_y', v(60, g.bridgeY - 15, g.bridgeZ - 2), v(bridgeLen - 8, 4, 34), 'frame', {
    sharp: true,
  });
  // X rail + lead screw on the front face.
  box('xrail', 'gantry_y', v(60, g.xRailFrontY, g.xRailZ), v(bridgeLen - 20, 6, 9), 'steel', { sharp: true });
  box(
    'xrail-groove',
    'gantry_y',
    v(60, g.xRailFrontY - 1.4, g.xRailZ),
    v(bridgeLen - 20, 3.4, 3.4),
    'black',
    { sharp: true },
  );
  cyl('xscrew', 'gantry_y', v(60, g.xRailFrontY + 4, g.xRailZ - 12), 5, bridgeLen - 24, 'steel', 'x');
  box('xmotor', 'gantry_y', v(g.postX.right - 2, g.xRailFrontY, g.xRailZ - 12), v(24, 26, 26), 'black');
  // Fixed end of the X cable drag chain, at the right of the bridge.
  box(
    'xchain-anchor',
    'gantry_y',
    v(g.postX.right - 16, g.xRailFrontY - 7, g.bridgeZ + 6),
    v(16, 12, 10),
    'black',
  );

  // ── X carriage + Z column (carriage_x) ───────────────────────────
  const frontY = g.xRailFrontY - 5;
  box('xcar', 'carriage_x', v(0, g.xRailFrontY, g.xRailZ), v(30, 10, 34), 'black');
  box('xcar-plate', 'carriage_x', v(0, frontY, g.xRailZ - 6), v(34, 6, 54), 'black');
  box('zmotor', 'carriage_x', v(0, frontY - 2, g.xRailZ + 22), v(26, 26, 26), 'black');
  cyl('zmotor-cap', 'carriage_x', v(0, frontY - 2, g.xRailZ + 36), 16, 4, 'frame');
  // Z linear rail the head travels on (fixed in X/Y, head moves in Z along it).
  box('zrail', 'carriage_x', v(0, frontY - 6, g.xRailZ - 30), v(10, 7, 150), 'steel', { sharp: true });
  box('zrail-groove', 'carriage_x', v(0, frontY - 8.6, g.xRailZ - 30), v(3.4, 3.4, 150), 'black', {
    sharp: true,
  });
  // Cable chain moving end bracket.
  box('xchain-car', 'carriage_x', v(0, frontY - 9, g.xRailZ + 6), v(16, 12, 10), 'black');

  // ── Dispensing head (head_z, origin = needle tip, +z is up) ──────
  const hy = -6; // the head body sits behind the needle (toward +y column side)
  box('zcar', 'head_z', v(0, 7, 70), v(26, 14, 40), 'black'); // clamps head to the Z rail
  box('head-bracket', 'head_z', v(0, hy + 10, 48), v(30, 10, 74), 'black');
  box('pump-body', 'head_z', v(0, hy + 2, 52), v(22, 10, 60), 'black');
  box('pump-cap', 'head_z', v(0, hy + 2, 82), v(24, 12, 7), 'frame');
  // Syringe: glass barrel, PTFE clamp, luer, needle.
  cyl('syringe', 'head_z', v(0, 0, 40), 9, 38, 'glass', 'z', { role: 'syringe' });
  cyl('syringe-flange', 'head_z', v(0, 0, 60), 13, 2, 'white', 'z', { role: 'plunger-anchor' });
  box('syringe-clamp', 'head_z', v(0, 5.5, 32), v(14, 4, 7), 'white');
  cyl('luer', 'head_z', v(0, 0, 19), 3.4, 5, 'steel');
  cyl('needle', 'head_z', v(0, 0, 9), 0.7, 16, 'steel');
  // Down-looking machine-vision camera with lens and ring light.
  box('camera', 'head_z', v(-16, 2, 30), v(11, 13, 17), 'black', { role: 'camera' });
  cyl('camera-lens', 'head_z', v(-16, 2, 20.5), 6.5, 4, 'lens');
  cyl('led-ring', 'head_z', v(0, 0, 14), 12, 2.4, 'white', 'z', { role: 'led' });
  // Sample tubing stub.
  cyl('tubing', 'head_z', v(7, hy + 2, 58), 2.4, 10, 'rubber', 'z');

  // ── Cryo-stage: insulated housing, cold block, grids (world) ─────
  // The cold block's top surface is the grid plane (Z = 0).
  const stageX = 55;
  const stageY = 25;
  box('stage-housing', 'world', v(stageX, stageY, -13), v(72, 42, 18), 'white');
  box('stage-housing-lip', 'world', v(stageX, stageY, -5), v(66, 36, 3), 'black', { sharp: true });
  box('cold-block', 'world', v(stageX, stageY, -3), v(60, 30, 6), 'copper', { role: 'cold-plate' });
  box('grid-holder', 'world', v(stageX, stageY, -1.2), v(46, 13, 5.2), 'black');
  for (const gr of m.deck.grids) {
    cyl(`grid-${gr.id}`, 'world', v(gr.x, gr.y, 1.45), m.deck.gridRadius * 2, 0.1, 'grid', 'z', {
      role: 'grid',
    });
  }

  // ── Cryogen supply: dewar + vacuum-insulated transfer line (world) ─
  cyl('dewar', 'world', v(2, 96, baseTop + 32), 30, 64, 'frame');
  cyl('dewar-neck', 'world', v(2, 96, baseTop + 66), 14, 8, 'black');
  cyl('dewar-cap', 'world', v(2, 96, baseTop + 71), 18, 4, 'frame');
  cyl('xfer-riser', 'world', v(2, 96, baseTop + 20), 7, 30, 'hose', 'z');
  cyl('xfer-run', 'world', v(28, 82, baseTop + 9), 7, 52, 'hose', 'x');
  cyl('xfer-elbow', 'world', v(stageX, 70, baseTop + 9), 7, 30, 'hose', 'y');

  // ── Sample vial in its holder (world) ────────────────────────────
  const vial = m.deck.vial;
  box('vial-holder', 'world', v(vial.x, vial.y, baseTop + 7), v(20, 20, 16), 'black');
  cyl('vial-collar', 'world', v(vial.x, vial.y, baseTop + 15), 11, 3, 'frame');
  const vialBottom = baseTop + 11;
  cyl(
    'vial',
    'world',
    v(vial.x, vial.y, (vialBottom + vial.rimZ) / 2),
    vial.radius * 2,
    vial.rimZ - vialBottom,
    'glass',
  );
  cyl(
    'vial-liquid',
    'world',
    v(vial.x, vial.y, (vialBottom + 1 + vial.liquidZ) / 2),
    vial.radius * 2 - 1,
    vial.liquidZ - vialBottom - 1,
    'sample',
    'z',
    { role: 'vial-liquid' },
  );

  return parts;
}

/** World position of every link origin for the given axis positions. */
export function linkOrigins(axes: Vec3): Record<LinkName, Vec3> {
  return {
    world: v(0, 0, 0),
    gantry_y: v(0, axes.y, 0),
    carriage_x: v(axes.x, axes.y, 0),
    head_z: v(axes.x, axes.y, axes.z),
  };
}

/** Translation of each link relative to its parent (what goes into /tf). */
export function jointTranslations(axes: Vec3): Record<Exclude<LinkName, 'world'>, Vec3> {
  return { gantry_y: v(0, axes.y, 0), carriage_x: v(axes.x, 0, 0), head_z: v(0, 0, axes.z) };
}
