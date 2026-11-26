import type { MachineConfig, Vec3 } from './machine.ts';

/**
 * Visual model of the machine as a kinematic chain of links with primitive
 * shapes — a tiny URDF. The three.js view and the Foxglove `/scene` export are
 * both generated from this list, so they can never disagree.
 *
 * Frames (all prismatic, no rotation):
 *   world → gantry_y (y) → carriage_x (x) → head_z (z)
 * The head_z origin is the needle tip, so the tool-centre point in world
 * coordinates is exactly (x, y, z). Machine axes: X right, Y away from the
 * operator, Z up; Z = 0 is the grid plane. Units: mm.
 */

export type LinkName = 'world' | 'gantry_y' | 'carriage_x' | 'head_z';
export const LINKS: readonly LinkName[] = ['world', 'gantry_y', 'carriage_x', 'head_z'];
export const PARENT: Record<Exclude<LinkName, 'world'>, LinkName> = {
  gantry_y: 'world',
  carriage_x: 'gantry_y',
  head_z: 'carriage_x',
};

export type MaterialName =
  | 'deck'
  | 'anodized'
  | 'aluminium'
  | 'steel'
  | 'ptfe'
  | 'copper'
  | 'glass'
  | 'sample'
  | 'grid'
  | 'rubber'
  | 'hose'
  | 'white'
  | 'lens';

/** Role tags let the 3D view animate specific parts (frost, plunger, …). */
export type PartRole = 'cold-plate' | 'grid' | 'syringe' | 'plunger-anchor' | 'camera' | 'vial-liquid';

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
}

/** sRGB colours (0–1) used by both renderers. */
export const MATERIAL_COLORS: Record<MaterialName, { r: number; g: number; b: number; a: number }> = {
  deck: rgb(0x2a3036),
  anodized: rgb(0x3a4149),
  aluminium: rgb(0xb5bdc6),
  steel: rgb(0xd5dade),
  ptfe: rgb(0xe9e7e1),
  copper: rgb(0xb87333),
  glass: { ...rgb(0xd9ecf3), a: 0.3 },
  sample: { ...rgb(0xb7a6ee), a: 0.85 },
  grid: rgb(0xd2ad66),
  rubber: rgb(0x16191c),
  hose: rgb(0x4a525b),
  white: rgb(0xe6eaed),
  lens: rgb(0x0e1114),
};

function rgb(hex: number) {
  return { r: ((hex >> 16) & 255) / 255, g: ((hex >> 8) & 255) / 255, b: (hex & 255) / 255, a: 1 };
}

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

export function machineGeometry(m: MachineConfig): Primitive[] {
  const deckTop = -m.deck.gridPlaneHeight;
  const railZ = 110; // rail centre height
  const parts: Primitive[] = [];
  const box = (
    id: string,
    link: LinkName,
    center: Vec3,
    size: Vec3,
    material: MaterialName,
    role?: PartRole,
  ) => parts.push({ id, link, shape: 'box', center, size, material, ...(role ? { role } : {}) });
  const cyl = (
    id: string,
    link: LinkName,
    center: Vec3,
    diameter: number,
    length: number,
    material: MaterialName,
    axis: 'x' | 'y' | 'z' = 'z',
    role?: PartRole,
  ) =>
    parts.push({
      id,
      link,
      shape: 'cylinder',
      center,
      size: v(diameter, diameter, length),
      axis,
      material,
      ...(role ? { role } : {}),
    });

  // ── Frame (world) ────────────────────────────────────────────────
  box('deck', 'world', v(60, 45, deckTop - 5), v(210, 160, 10), 'deck');
  for (const [x, y] of [
    [-35, -25],
    [155, -25],
    [-35, 115],
    [155, 115],
  ] as const) {
    cyl(`foot-${x}-${y}`, 'world', v(x, y, deckTop - 14), 14, 8, 'rubber');
  }
  for (const x of [-30, 150]) {
    box(`rail-${x}`, 'world', v(x, 55, railZ), v(20, 130, 20), 'aluminium');
    for (const y of [-5, 115]) {
      const h = railZ - 10 - deckTop;
      box(`post-${x}-${y}`, 'world', v(x, y, deckTop + h / 2), v(20, 20, h), 'aluminium');
    }
    box(`y-motor-${x}`, 'world', v(x, 128, railZ), v(22, 6, 22), 'anodized');
  }

  // ── Cryo-stage with grid holder (world) ──────────────────────────
  const stageX = 55;
  const stageY = 25;
  box('stage-insulator', 'world', v(stageX, stageY, deckTop + 7), v(66, 36, 14), 'ptfe');
  box('cold-plate', 'world', v(stageX, stageY, deckTop + 17.5), v(62, 32, 7), 'copper', 'cold-plate');
  const plateTop = deckTop + 21;
  box('grid-holder', 'world', v(stageX, stageY, (plateTop + 0) / 2), v(44, 10, 0 - plateTop), 'anodized');
  for (const g of m.deck.grids) {
    cyl(`grid-${g.id}`, 'world', v(g.x, g.y, 0.03), m.deck.gridRadius * 2, 0.06, 'grid', 'z', 'grid');
  }
  // Cryogen supply: dewar and insulated hose to the back of the stage.
  cyl('dewar', 'world', v(8, 100, deckTop + 30), 26, 60, 'white');
  cyl('dewar-cap', 'world', v(8, 100, deckTop + 62), 16, 4, 'anodized');
  cyl('hose-y', 'world', v(stageX, 72, deckTop + 9), 6, 58, 'hose', 'y');
  cyl('hose-x', 'world', v(38, 101, deckTop + 9), 6, 34, 'hose', 'x');

  // ── Sample vial (world) ──────────────────────────────────────────
  const vial = m.deck.vial;
  box('vial-holder', 'world', v(vial.x, vial.y, deckTop + 6), v(18, 18, 12), 'anodized');
  const vialBottom = deckTop + 10;
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
    'vial-liquid',
  );

  // ── Bridge (gantry_y): spans X, rides on the two Y rails ─────────
  for (const x of [-30, 150])
    box(`bridge-bearing-${x}`, 'gantry_y', v(x, 35, railZ + 13), v(26, 28, 6), 'anodized');
  box('bridge', 'gantry_y', v(60, 35, railZ + 26), v(200, 20, 20), 'aluminium');
  box('x-motor', 'gantry_y', v(166, 35, railZ + 26), v(14, 22, 22), 'anodized');

  // ── X carriage (carriage_x) ──────────────────────────────────────
  box('carriage', 'carriage_x', v(0, 22, 125), v(44, 6, 50), 'anodized');
  box('z-guide', 'carriage_x', v(0, 18.5, 125), v(10, 1, 50), 'steel');

  // ── Dispensing head (head_z, origin = needle tip) ────────────────
  box('slide-plate', 'head_z', v(0, 17, 60), v(34, 3, 100), 'aluminium');
  box('pump-body', 'head_z', v(0, 11, 52), v(24, 9, 64), 'anodized');
  cyl('needle', 'head_z', v(0, 0, 8), 0.7, 16, 'steel');
  cyl('luer', 'head_z', v(0, 0, 18), 3, 4, 'steel');
  cyl('syringe', 'head_z', v(0, 0, 39), 9, 38, 'glass', 'z', 'syringe');
  cyl('syringe-flange', 'head_z', v(0, 0, 59), 14, 2, 'steel', 'z', 'plunger-anchor');
  box('camera', 'head_z', v(-17, 5, 28), v(10, 10, 14), 'anodized', 'camera');
  cyl('camera-lens', 'head_z', v(-17, 5, 20), 6, 2, 'lens');

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
