import {
  AdditiveBlending,
  ArrowHelper,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  EdgesGeometry,
  Fog,
  GridHelper,
  Group,
  HemisphereLight,
  InstancedMesh,
  Line,
  LineBasicMaterial,
  LineDashedMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  NeutralToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  PointLight,
  Points,
  PointsMaterial,
  Quaternion,
  Scene,
  ShadowMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  type Material,
  type Object3D,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { dropletRadiusMm } from '../core/foxglove.ts';
import {
  GANTRY,
  LINKS,
  machineGeometry,
  MATERIAL_COLORS,
  type LinkName,
  type MaterialName,
  type Primitive,
} from '../core/geometry.ts';
import type { MachineConfig, Vec3 } from '../core/machine.ts';
import type { SceneState } from '../core/scene.ts';
import {
  blobShadowTexture,
  frostTexture,
  gradientTexture,
  gridMeshTexture,
  labelTexture,
  nameplateTexture,
  radialTexture,
} from './textures.ts';

/**
 * three.js view of the machine. It is a pure function of `SceneState`
 * snapshots: `setScene()` poses the links, the syringe, the frost and the
 * droplets; nothing here knows whether the data is live or replayed.
 *
 * Structural geometry comes from `machineGeometry()` (shared with the Foxglove
 * export) and is rendered with rounded edges; the drag chain, fasteners and LED
 * ring are cosmetic detail added only here. Machine coordinates (mm, Z up) live
 * under one root group that rotates them into three.js' Y-up world.
 */

export interface MachineViewOptions {
  reducedMotion: boolean;
  insetElement?: HTMLElement | null;
}

export class WebGLUnavailableError extends Error {
  override name = 'WebGLUnavailableError';
}

const BACKGROUND = 0x0c1013;
const ICE = 0x7fd3f5;
const COPPER = new Color(MATERIAL_COLORS.copper.r, MATERIAL_COLORS.copper.g, MATERIAL_COLORS.copper.b);
const FROSTED = new Color(0xdbe8ef);
const TRAIL_CAPACITY = 12_000;
const DROPLET_POOL = 24;
const SERIES = { x: '#2a78d6', y: '#eb6834', z: '#1baf7a' } as const;

interface Vapour {
  points: Points;
  material: PointsMaterial;
  seeds: Float32Array;
}

export class MachineView {
  readonly #host: HTMLElement;
  readonly #machine: MachineConfig;
  readonly #options: MachineViewOptions;
  readonly #renderer: WebGLRenderer;
  readonly #scene = new Scene();
  readonly #camera = new PerspectiveCamera(30, 1, 1, 7000);
  readonly #tipCamera = new PerspectiveCamera(46, 4 / 3, 0.4, 900);
  readonly #controls: OrbitControls;
  readonly #root = new Group();
  readonly #links = {} as Record<LinkName, Group>;
  readonly #resize: ResizeObserver;
  readonly #disposables: { dispose(): void }[] = [];

  #coldMaterial!: MeshStandardMaterial;
  #frostMaterial!: MeshStandardMaterial;
  #glowMaterial!: MeshBasicMaterial;
  #coldLight!: PointLight;
  #ledMaterial!: MeshStandardMaterial;
  #vapour!: Vapour;
  #syringeLiquid!: Mesh;
  #plunger!: Group;
  #dragChain!: DragChain;
  #droplets: Mesh[] = [];
  #plannedPath!: Line;
  #plannedPoints!: Points;
  #trail!: Line;
  #trailPositions = new Float32Array(TRAIL_CAPACITY * 3);

  #plate: Primitive | null = null;
  #coldness = 0;
  #lastCarriageX = Number.NaN;
  #insetRect: { x: number; y: number; w: number; h: number } | null = null;
  #userMovedCamera = false;
  #dirty = true;
  #raf = 0;
  #disposed = false;

  constructor(host: HTMLElement, machine: MachineConfig, options: MachineViewOptions) {
    this.#host = host;
    this.#machine = machine;
    this.#options = options;
    try {
      this.#renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    } catch {
      throw new WebGLUnavailableError('WebGL is not available in this browser.');
    }
    const r = this.#renderer;
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.outputColorSpace = SRGBColorSpace;
    r.toneMapping = NeutralToneMapping;
    r.toneMappingExposure = 1.02;
    r.shadowMap.enabled = true;
    r.shadowMap.type = PCFShadowMap;
    r.autoClear = false;
    r.domElement.className = 'machine-canvas';
    r.domElement.setAttribute('aria-hidden', 'true');
    host.appendChild(r.domElement);

    const bg = gradientTexture('#182028', '#080b0e');
    this.#scene.background = bg;
    this.#scene.fog = new Fog(BACKGROUND, 760, 2000);
    this.#disposables.push(bg);

    const pmrem = new PMREMGenerator(r);
    const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.#scene.environment = environment;
    this.#scene.environmentIntensity = 0.82;
    pmrem.dispose();
    this.#disposables.push(environment);

    this.#buildLights();
    this.#buildFloor();
    this.#buildMachine();
    this.#buildOverlays();

    this.#controls = new OrbitControls(this.#camera, r.domElement);
    this.#controls.enableDamping = !options.reducedMotion;
    this.#controls.dampingFactor = 0.08;
    this.#controls.minDistance = 150;
    this.#controls.maxDistance = 1500;
    this.#controls.maxPolarAngle = Math.PI * 0.49;
    this.#controls.screenSpacePanning = true;
    this.#controls.addEventListener('change', () => (this.#dirty = true));
    this.#controls.addEventListener('start', () => (this.#userMovedCamera = true));
    this.resetView();

    this.#resize = new ResizeObserver(() => {
      this.#onResize();
    });
    this.#resize.observe(host);
    if (options.insetElement) this.#resize.observe(options.insetElement);
    this.#onResize();
    this.#raf = requestAnimationFrame(this.#loop);
  }

  /** Pose the machine from a snapshot of recorded topics. */
  setScene(state: SceneState): void {
    this.#links.gantry_y.position.set(0, state.axes.y.actual, 0);
    this.#links.carriage_x.position.set(state.axes.x.actual, 0, 0);
    this.#links.head_z.position.set(0, 0, state.axes.z.actual);

    if (state.axes.x.actual !== this.#lastCarriageX) {
      this.#dragChain.update(state.axes.x.actual);
      this.#lastCarriageX = state.axes.x.actual;
    }

    // Syringe: the liquid column and the plunger follow the pump volume.
    const fill = Math.min(1, Math.max(0, state.pump.volume_nl / this.#machine.pump.capacityNl));
    const column = Math.max(0.05, fill * 30);
    this.#syringeLiquid.scale.set(1, column, 1);
    this.#syringeLiquid.position.z = 21 + column / 2;
    this.#syringeLiquid.visible = fill > 0.002;
    this.#plunger.position.z = 21 + column;

    // LED ring glows while the pump is active.
    this.#ledMaterial.emissiveIntensity = state.pump.mode === 'idle' ? 0.35 : 1.2;

    // Cold block: frost, tint and glow grow as the stage cools.
    const { ambientC } = this.#machine.stage;
    const coldness = Math.min(1, Math.max(0, (ambientC - state.stage.celsius) / (ambientC + 180)));
    if (Math.abs(coldness - this.#coldness) > 1e-3) {
      this.#coldness = coldness;
      const frost = coldness ** 1.6;
      this.#coldMaterial.color.copy(COPPER).lerp(FROSTED, frost * 0.82);
      this.#coldMaterial.roughness = 0.32 + frost * 0.5;
      this.#coldMaterial.metalness = 0.92 - frost * 0.65;
      this.#coldMaterial.emissiveIntensity = coldness * 0.22;
      this.#frostMaterial.opacity = frost * 0.46;
      this.#glowMaterial.opacity = coldness * 0.2;
      this.#coldLight.intensity = coldness * 2400;
      this.#vapour.material.opacity = this.#options.reducedMotion ? 0 : coldness ** 2 * 0.2;
    }

    this.#droplets.forEach((mesh, i) => {
      const d = state.droplets[i];
      mesh.visible = d !== undefined && d.volumeNl > 0.001;
      if (!d || !mesh.visible) return;
      const radius = dropletRadiusMm(d.volumeNl);
      mesh.scale.set(radius, radius, radius * 0.5);
      mesh.position.set(d.x, d.y, 1.55 + radius * 0.3);
    });

    this.#placeTipCamera();
    this.#dirty = true;
  }

  /** Planned tool-tip path from the validator (machine coordinates). */
  setPlannedPath(points: readonly Vec3[]): void {
    const flat = new Float32Array(points.length * 3);
    points.forEach((p, i) => {
      flat.set([p.x, p.y, p.z], i * 3);
    });
    for (const obj of [this.#plannedPath, this.#plannedPoints]) {
      obj.geometry.setAttribute('position', new BufferAttribute(flat, 3));
      obj.geometry.computeBoundingSphere();
    }
    this.#plannedPath.computeLineDistances();
    this.#plannedPath.visible = this.#plannedPoints.visible = points.length > 1;
    this.#dirty = true;
  }

  /** Tool-tip trail up to the playhead (machine coordinates, xyz triples). */
  setTrail(points: Float32Array, count: number): void {
    const n = Math.min(count, TRAIL_CAPACITY);
    this.#trailPositions.set(points.subarray(0, n * 3));
    const attr = this.#trail.geometry.getAttribute('position') as BufferAttribute;
    attr.needsUpdate = true;
    attr.clearUpdateRanges();
    attr.addUpdateRange(0, n * 3);
    this.#trail.geometry.setDrawRange(0, n);
    this.#trail.visible = n > 1;
    this.#dirty = true;
  }

  resetView(): void {
    this.#userMovedCamera = false;
    this.#controls.target.set(20, 66, 2);
    this.#camera.position.set(300, 214, 404);
    this.#fitToAspect();
    this.#controls.update();
    this.#dirty = true;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    cancelAnimationFrame(this.#raf);
    this.#resize.disconnect();
    this.#controls.dispose();
    this.#scene.traverse((obj: Object3D) => {
      const mesh = obj as Partial<Mesh>;
      mesh.geometry?.dispose();
      const material = mesh.material;
      for (const mat of Array.isArray(material) ? material : material ? [material] : []) mat.dispose();
    });
    for (const d of this.#disposables) d.dispose();
    this.#renderer.dispose();
    this.#renderer.forceContextLoss();
    this.#renderer.domElement.remove();
  }

  // ── construction ─────────────────────────────────────────────────

  #buildLights(): void {
    this.#scene.add(new HemisphereLight(0xdce7f1, 0x12171c, 0.55));
    const key = new DirectionalLight(0xfff4e6, 2.2);
    key.position.set(260, 430, 300);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.radius = 5;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.6;
    const cam = key.shadow.camera;
    cam.left = -240;
    cam.right = 240;
    cam.top = 260;
    cam.bottom = -220;
    cam.near = 60;
    cam.far = 1400;
    this.#scene.add(key);

    const fill = new DirectionalLight(0xa9c8e6, 0.5);
    fill.position.set(-340, 180, -40);
    this.#scene.add(fill);

    const rim = new DirectionalLight(0xe8f3ff, 0.8);
    rim.position.set(-160, 170, -380);
    this.#scene.add(rim);
  }

  #buildFloor(): void {
    const floorY = -18;
    const grid = new GridHelper(2600, 130, 0x2b343d, 0x202830);
    grid.position.y = floorY + 0.04;
    grid.material.depthWrite = false;
    this.#scene.add(grid);

    const shadow = new Mesh(new PlaneGeometry(5000, 5000), new ShadowMaterial({ opacity: 0.34 }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = floorY;
    shadow.receiveShadow = true;
    this.#scene.add(shadow);

    // Fake soft AO blob directly under the machine for grounding.
    const blobMap = blobShadowTexture();
    this.#disposables.push(blobMap);
    const blob = new Mesh(
      new PlaneGeometry(430, 360),
      new MeshBasicMaterial({ map: blobMap, transparent: true, depthWrite: false, opacity: 0.9 }),
    );
    blob.rotation.x = -Math.PI / 2;
    blob.position.set(60, floorY + 0.12, 42);
    this.#scene.add(blob);
  }

  #buildMachine(): void {
    const m = this.#machine;
    // Machine frame (mm, Z up) → three.js world (Y up), centred over the origin.
    this.#root.rotation.x = -Math.PI / 2;
    this.#root.position.set(-60, -GANTRY.deckTop, 45);
    this.#scene.add(this.#root);

    for (const link of LINKS) this.#links[link] = new Group();
    this.#root.add(this.#links.world, this.#links.gantry_y);
    this.#links.gantry_y.add(this.#links.carriage_x);
    this.#links.carriage_x.add(this.#links.head_z);

    const materials = createMaterials();
    for (const mat of Object.values(materials)) this.#disposables.push(mat);
    const gridMap = gridMeshTexture();
    this.#disposables.push(gridMap);
    const gridMaterial = new MeshStandardMaterial({ map: gridMap, metalness: 0.85, roughness: 0.4 });

    for (const part of machineGeometry(m)) {
      let material: Material = materials[part.material];
      if (part.role === 'cold-plate') {
        this.#coldMaterial = materials.copper.clone();
        this.#coldMaterial.emissive = new Color(0x4fb8ee);
        this.#coldMaterial.emissiveIntensity = 0;
        material = this.#coldMaterial;
      } else if (part.role === 'grid') {
        material = gridMaterial;
      } else if (part.role === 'led') {
        this.#ledMaterial = materials.white.clone();
        this.#ledMaterial.emissive = new Color(ICE);
        this.#ledMaterial.emissiveIntensity = 0.35;
        material = this.#ledMaterial;
      }
      const mesh = primitiveMesh(part, material);
      const transparent = part.material === 'glass' || part.material === 'sample';
      mesh.castShadow = !transparent;
      mesh.receiveShadow = !transparent && part.role !== 'grid';
      this.#links[part.link].add(mesh);
      if (part.role === 'cold-plate') this.#buildColdEffects(part);
      if (part.role === 'deck-surface') this.#buildBreadboard(part, materials.black);
    }

    this.#buildSyringe(materials);
    this.#buildDroplets();
    this.#buildNameplate();
    this.#dragChain = new DragChain(materials.black.clone());
    this.#links.gantry_y.add(this.#dragChain.object);
    this.#dragChain.update(m.powerOn.x);
    this.#addFasteners(materials.steel);
  }

  /** Threaded-hole pattern on the working surface, as on an optical breadboard. */
  #buildBreadboard(surface: Primitive, material: MeshStandardMaterial): void {
    const pitch = 12.5;
    const holes: [number, number][] = [];
    const halfX = surface.size.x / 2 - 7;
    const halfY = surface.size.y / 2 - 7;
    for (let x = surface.center.x - halfX; x <= surface.center.x + halfX; x += pitch) {
      for (let y = surface.center.y - halfY; y <= surface.center.y + halfY; y += pitch) {
        // Leave the stage and vial footprints clear.
        if (y < 44 && x > 20 && x < 92) continue;
        holes.push([x, y]);
      }
    }
    const mesh = new InstancedMesh(new CylinderGeometry(1.6, 1.6, 0.6, 12), material, holes.length);
    mesh.receiveShadow = true;
    const top = surface.center.z + surface.size.z / 2;
    const rot = new Matrix4().makeRotationX(Math.PI / 2);
    const matrix = new Matrix4();
    holes.forEach(([x, y], i) => mesh.setMatrixAt(i, matrix.makeTranslation(x, y, top).multiply(rot)));
    this.#links.world.add(mesh);
  }

  #buildNameplate(): void {
    const map = nameplateTexture('LabTwin');
    this.#disposables.push(map);
    const material = new MeshStandardMaterial({ map, metalness: 0.3, roughness: 0.5 });
    this.#disposables.push(material);
    const plate = new Mesh(new PlaneGeometry(80, 20), material);
    // On the front face of the back panel (faces −Y, toward the operator).
    plate.position.set(60, 112, GANTRY.deckTop + 30);
    plate.rotation.x = Math.PI / 2;
    this.#links.world.add(plate);
  }

  /** A few bright fasteners at the column flanges, for scale and realism. */
  #addFasteners(material: MeshStandardMaterial): void {
    const spots: Vec3[] = [];
    for (const px of [GANTRY.postX.left, GANTRY.postX.right]) {
      for (const py of [GANTRY.postY.front, GANTRY.postY.back]) {
        for (const [dx, dy] of [
          [-11, -11],
          [11, -11],
          [-11, 11],
          [11, 11],
        ] as const) {
          spots.push({ x: px + dx, y: py + dy, z: GANTRY.deckTop + 8.2 });
        }
      }
    }
    const mesh = new InstancedMesh(new CylinderGeometry(1.7, 1.7, 1.6, 6), material, spots.length);
    mesh.castShadow = true;
    const rot = new Matrix4().makeRotationX(Math.PI / 2);
    const matrix = new Matrix4();
    spots.forEach((s, i) => mesh.setMatrixAt(i, matrix.makeTranslation(s.x, s.y, s.z).multiply(rot)));
    this.#links.world.add(mesh);
  }

  #buildColdEffects(plate: Primitive): void {
    this.#plate = plate;
    const frostMap = frostTexture();
    const glowMap = radialTexture();
    const softDot = radialTexture(64);
    this.#disposables.push(frostMap, glowMap, softDot);

    this.#frostMaterial = new MeshStandardMaterial({
      color: 0xdbeefc,
      roughness: 1,
      metalness: 0,
      transparent: true,
      opacity: 0,
      alphaMap: frostMap,
      depthWrite: false,
    });
    const frost = new Mesh(
      new BoxGeometry(plate.size.x + 0.8, plate.size.y + 0.8, plate.size.z + 0.6),
      this.#frostMaterial,
    );
    frost.position.set(plate.center.x, plate.center.y, plate.center.z);
    this.#links.world.add(frost);

    this.#glowMaterial = new MeshBasicMaterial({
      color: ICE,
      map: glowMap,
      transparent: true,
      opacity: 0,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide,
    });
    const glow = new Mesh(new PlaneGeometry(plate.size.x * 1.7, plate.size.y * 2.2), this.#glowMaterial);
    glow.position.set(plate.center.x, plate.center.y, plate.center.z - plate.size.z / 2 - 0.5);
    this.#links.world.add(glow);

    this.#coldLight = new PointLight(0xc4eaff, 0, 0, 2);
    this.#coldLight.position.set(plate.center.x, plate.center.y - 6, plate.center.z + 22);
    this.#links.world.add(this.#coldLight);

    const count = 38;
    const seeds = new Float32Array(count * 3);
    for (let i = 0; i < count; i++)
      seeds.set([Math.random(), Math.random(), 1.6 + Math.random() * 1.6], i * 3);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(count * 3), 3));
    const material = new PointsMaterial({
      color: 0xeaf7ff,
      size: 12,
      map: softDot,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      sizeAttenuation: true,
    });
    const points = new Points(geometry, material);
    points.frustumCulled = false;
    this.#links.world.add(points);
    this.#vapour = { points, material, seeds };
  }

  #buildSyringe(materials: Record<MaterialName, MeshStandardMaterial>): void {
    const head = this.#links.head_z;
    const liquid = new Mesh(new CylinderGeometry(3.7, 3.7, 1, 24), materials.sample.clone());
    liquid.rotation.x = Math.PI / 2;
    head.add(liquid);
    this.#syringeLiquid = liquid;

    const plunger = new Group();
    const tip = new Mesh(new CylinderGeometry(3.9, 3.9, 2, 24), materials.rubber);
    tip.rotation.x = Math.PI / 2;
    tip.position.z = 1;
    const rod = new Mesh(new CylinderGeometry(1.3, 1.3, 46, 12), materials.steel);
    rod.rotation.x = Math.PI / 2;
    rod.position.z = 25;
    const thumb = new Mesh(new RoundedBoxGeometry(12, 12, 2.4, 2, 0.8), materials.frame);
    thumb.position.z = 48.5;
    for (const part of [tip, rod, thumb]) {
      part.castShadow = true;
      plunger.add(part);
    }
    head.add(plunger);
    this.#plunger = plunger;
  }

  #buildDroplets(): void {
    const material = new MeshPhysicalMaterial({
      color: new Color(MATERIAL_COLORS.sample.r, MATERIAL_COLORS.sample.g, MATERIAL_COLORS.sample.b),
      roughness: 0.05,
      metalness: 0,
      clearcoat: 1,
      transparent: true,
      opacity: 0.92,
      emissive: new Color(0x2a1d5c),
      emissiveIntensity: 0.25,
    });
    this.#disposables.push(material);
    const geometry = new SphereGeometry(1, 28, 18);
    for (let i = 0; i < DROPLET_POOL; i++) {
      const drop = new Mesh(geometry, material);
      drop.visible = false;
      this.#links.world.add(drop);
      this.#droplets.push(drop);
    }
  }

  #buildOverlays(): void {
    const { axes } = this.#machine;
    const size = { x: axes.x.max - axes.x.min, y: axes.y.max - axes.y.min, z: axes.z.max - axes.z.min };
    const box = new LineSegments(
      new EdgesGeometry(new BoxGeometry(size.x, size.y, size.z)),
      new LineBasicMaterial({ color: 0x9fb2c3, transparent: true, opacity: 0.22 }),
    );
    box.position.set(axes.x.min + size.x / 2, axes.y.min + size.y / 2, axes.z.min + size.z / 2);
    this.#root.add(box);

    const origin = new Vector3(axes.x.min, axes.y.min, axes.z.min);
    const dirs: [keyof typeof SERIES, Vector3][] = [
      ['x', new Vector3(1, 0, 0)],
      ['y', new Vector3(0, 1, 0)],
      ['z', new Vector3(0, 0, 1)],
    ];
    for (const [name, dir] of dirs) {
      const color = new Color(SERIES[name]);
      this.#root.add(new ArrowHelper(dir, origin, 18, color, 4, 2.6));
      const label = labelTexture(name.toUpperCase(), SERIES[name]);
      this.#disposables.push(label);
      const sprite = new Sprite(new SpriteMaterial({ map: label, depthTest: false, transparent: true }));
      sprite.position.copy(origin).addScaledVector(dir, 24);
      sprite.scale.set(9, 9, 1);
      this.#root.add(sprite);
    }

    const planned = new BufferGeometry();
    planned.setAttribute('position', new BufferAttribute(new Float32Array(0), 3));
    this.#plannedPath = new Line(
      planned,
      new LineDashedMaterial({ color: ICE, dashSize: 3, gapSize: 2.2, transparent: true, opacity: 0.6 }),
    );
    const plannedDots = new BufferGeometry();
    plannedDots.setAttribute('position', new BufferAttribute(new Float32Array(0), 3));
    this.#plannedPoints = new Points(
      plannedDots,
      new PointsMaterial({ color: ICE, size: 5, sizeAttenuation: false, transparent: true, opacity: 0.85 }),
    );
    const trail = new BufferGeometry();
    trail.setAttribute('position', new BufferAttribute(this.#trailPositions, 3));
    trail.setDrawRange(0, 0);
    this.#trail = new Line(
      trail,
      new LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 }),
    );
    this.#trail.frustumCulled = false;
    this.#root.add(this.#plannedPath, this.#plannedPoints, this.#trail);
  }

  // ── per-frame work ───────────────────────────────────────────────

  #loop = (now: number): void => {
    if (this.#disposed) return;
    this.#raf = requestAnimationFrame(this.#loop);
    const moved = this.#controls.update();
    const vapourActive = this.#animateVapour(now);
    if (!this.#dirty && !moved && !vapourActive) return;
    this.#dirty = false;
    this.#render();
  };

  #render(): void {
    const r = this.#renderer;
    r.setScissorTest(false);
    r.setViewport(0, 0, this.#host.clientWidth, this.#host.clientHeight);
    r.clear();
    r.render(this.#scene, this.#camera);
    const inset = this.#insetRect;
    if (inset && inset.w > 20 && inset.h > 20) {
      r.setScissorTest(true);
      r.setScissor(inset.x, inset.y, inset.w, inset.h);
      r.setViewport(inset.x, inset.y, inset.w, inset.h);
      r.clear();
      r.render(this.#scene, this.#tipCamera);
      r.setScissorTest(false);
    }
  }

  #animateVapour(now: number): boolean {
    const vap = this.#vapour;
    const p = this.#plate;
    if (this.#options.reducedMotion || this.#coldness < 0.15 || !p) {
      vap.points.visible = false;
      return false;
    }
    vap.points.visible = true;
    const plate = { x: p.center.x, y: p.center.y, w: p.size.x, d: p.size.y, top: p.center.z + p.size.z / 2 };
    const attr = vap.points.geometry.getAttribute('position') as BufferAttribute;
    const t = now / 1000;
    for (let i = 0; i < attr.count; i++) {
      const a = vap.seeds[i * 3] ?? 0;
      const b = vap.seeds[i * 3 + 1] ?? 0;
      const life = vap.seeds[i * 3 + 2] ?? 2;
      const phase = (((t / life + a) % 1) + 1) % 1;
      const angle = b * Math.PI * 2;
      const ex = Math.cos(angle);
      const ey = Math.sin(angle);
      const edge = Math.min(Math.abs(plate.w / 2 / (ex || 1e-6)), Math.abs(plate.d / 2 / (ey || 1e-6)));
      const out = edge + phase * 9;
      attr.setXYZ(i, plate.x + ex * out, plate.y + ey * out, plate.top + 2 - phase * 9);
    }
    attr.needsUpdate = true;
    return true;
  }

  #placeTipCamera(): void {
    const head = this.#links.head_z;
    head.updateWorldMatrix(true, false);
    // In front of and above the needle, angled down at the tip and the grid.
    this.#tipCamera.position.copy(head.localToWorld(new Vector3(-8, -12, 13)));
    this.#tipCamera.lookAt(head.localToWorld(new Vector3(1, 2, -2)));
  }

  #fitToAspect(): void {
    const aspect = this.#camera.aspect || 1;
    const factor = aspect < 1.2 ? Math.min(1.9, 1.2 / aspect) : 1;
    const target = this.#controls.target;
    const offset = this.#camera.position.clone().sub(target);
    offset.setLength(600 * factor);
    this.#camera.position.copy(target).add(offset);
  }

  #onResize(): void {
    const w = this.#host.clientWidth;
    const h = this.#host.clientHeight;
    if (w === 0 || h === 0) return;
    this.#renderer.setSize(w, h);
    this.#camera.aspect = w / h;
    this.#camera.updateProjectionMatrix();
    if (!this.#userMovedCamera) {
      this.#fitToAspect();
      this.#controls.update();
    }
    const inset = this.#options.insetElement;
    if (inset) {
      const host = this.#host.getBoundingClientRect();
      const rect = inset.getBoundingClientRect();
      this.#insetRect = {
        x: rect.left - host.left,
        y: host.bottom - rect.bottom,
        w: rect.width,
        h: rect.height,
      };
      this.#tipCamera.aspect = rect.width / Math.max(1, rect.height);
      this.#tipCamera.updateProjectionMatrix();
    }
    this.#dirty = true;
  }
}

/**
 * Cable drag chain (energy carrier) for the X axis: a string of links that runs
 * from a fixed anchor on the bridge, folds back on itself, and follows the
 * carriage — the fold point tracks the carriage at half its speed.
 */
class DragChain {
  readonly object = new Group();
  readonly #mesh: InstancedMesh;
  readonly #capacity = 52;
  readonly #linkLen = 4.2;
  readonly #r = 6;
  readonly #zLow = GANTRY.bridgeZ + 3;
  readonly #y = GANTRY.xRailFrontY - 9;
  readonly #xFixed = GANTRY.postX.right - 16;
  readonly #chainLen = 172;
  readonly #matrix = new Matrix4();
  readonly #pos = new Vector3();
  readonly #quat = new Quaternion();
  readonly #scale = new Vector3(1, 1, 1);
  readonly #axisY = new Vector3(0, 1, 0);

  constructor(material: Material) {
    const link = new RoundedBoxGeometry(this.#linkLen + 0.4, 7, 5.2, 2, 1);
    this.#mesh = new InstancedMesh(link, material, this.#capacity);
    this.#mesh.castShadow = true;
    this.#mesh.frustumCulled = false;
    this.object.add(this.#mesh);
  }

  /**
   * Lay out the chain for the carriage at machine X `xC`. Anchor at `xFixed`
   * (right); the chain runs left along the lower track, folds up at `xB`, and
   * runs right along the upper track to the carriage. `xB` follows from the
   * constant total length, so the fold tracks the carriage at half speed.
   */
  update(xC: number): void {
    const r = this.#r;
    const arc = Math.PI * r;
    const zHigh = this.#zLow + 2 * r;
    const zMid = this.#zLow + r;
    const xB = (this.#xFixed + xC + arc - this.#chainLen) / 2;
    const lower = Math.max(0, this.#xFixed - xB);
    const upper = Math.max(0, xC - xB);
    const total = lower + arc + upper;
    const n = Math.min(this.#capacity, Math.max(2, Math.round(total / this.#linkLen)));
    const ds = total / n;
    for (let i = 0; i < this.#capacity; i++) {
      if (i >= n) {
        this.#mesh.setMatrixAt(i, this.#matrix.makeScale(0, 0, 0));
        continue;
      }
      const s = (i + 0.5) * ds;
      let x: number;
      let z: number;
      let theta: number; // rotation about machine Y; links lie in the X–Z plane
      if (s < lower) {
        x = this.#xFixed - s;
        z = this.#zLow;
        theta = 0;
      } else if (s < lower + arc) {
        const a = (s - lower) / r; // 0..π, bulging left
        x = xB - Math.sin(a) * r;
        z = zMid - Math.cos(a) * r;
        theta = Math.PI + a;
      } else {
        x = xB + (s - lower - arc);
        z = zHigh;
        theta = 0;
      }
      this.#pos.set(x, this.#y, z);
      this.#quat.setFromAxisAngle(this.#axisY, theta);
      this.#matrix.compose(this.#pos, this.#quat, this.#scale);
      this.#mesh.setMatrixAt(i, this.#matrix);
    }
    this.#mesh.count = this.#capacity;
    this.#mesh.instanceMatrix.needsUpdate = true;
  }
}

function createMaterials(): Record<MaterialName, MeshStandardMaterial> {
  const c = (name: MaterialName) => {
    const { r, g, b } = MATERIAL_COLORS[name];
    return new Color(r, g, b);
  };
  const std = (name: MaterialName, metalness: number, roughness: number) =>
    new MeshStandardMaterial({ color: c(name), metalness, roughness });
  return {
    base: std('base', 0.25, 0.62),
    frame: std('frame', 0.85, 0.32),
    black: std('black', 0.58, 0.42),
    steel: std('steel', 1, 0.19),
    copper: std('copper', 0.95, 0.3),
    white: std('white', 0, 0.58),
    glass: new MeshPhysicalMaterial({
      color: c('glass'),
      metalness: 0,
      roughness: 0.05,
      transparent: true,
      opacity: 0.26,
      depthWrite: false,
      clearcoat: 1,
    }),
    sample: new MeshStandardMaterial({
      color: c('sample'),
      roughness: 0.15,
      transparent: true,
      opacity: 0.85,
    }),
    grid: std('grid', 0.85, 0.4),
    rubber: std('rubber', 0, 0.9),
    hose: std('hose', 0.8, 0.45),
    lens: std('lens', 0.4, 0.08),
  };
}

const roundedCache = new Map<string, RoundedBoxGeometry>();

function primitiveMesh(part: Primitive, material: Material): Mesh {
  if (part.shape === 'box') {
    const { x, y, z } = part.size;
    const min = Math.min(x, y, z);
    const radius = part.sharp ? 0 : Math.min(2.2, min * 0.16);
    let geometry: BoxGeometry | RoundedBoxGeometry;
    if (radius < 0.4) {
      geometry = new BoxGeometry(x, y, z);
    } else {
      const key = `${x.toFixed(2)}x${y.toFixed(2)}x${z.toFixed(2)}r${radius.toFixed(2)}`;
      let cached = roundedCache.get(key);
      if (!cached) {
        cached = new RoundedBoxGeometry(x, y, z, 3, radius);
        roundedCache.set(key, cached);
      }
      geometry = cached;
    }
    const mesh = new Mesh(geometry, material);
    mesh.position.set(part.center.x, part.center.y, part.center.z);
    return mesh;
  }
  const radius = part.size.x / 2;
  const segments = radius < 2 ? 16 : radius < 6 ? 36 : 48;
  const mesh = new Mesh(new CylinderGeometry(radius, radius, part.size.z, segments), material);
  mesh.position.set(part.center.x, part.center.y, part.center.z);
  if (part.axis === 'z' || part.axis === undefined) mesh.rotation.x = Math.PI / 2;
  else if (part.axis === 'x') mesh.rotation.z = -Math.PI / 2;
  return mesh;
}
