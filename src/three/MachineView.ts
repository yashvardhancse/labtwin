import {
  AdditiveBlending,
  ArrowHelper,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
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
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { dropletRadiusMm } from '../core/foxglove.ts';
import {
  LINKS,
  machineGeometry,
  MATERIAL_COLORS,
  type LinkName,
  type MaterialName,
  type Primitive,
} from '../core/geometry.ts';
import type { MachineConfig, Vec3 } from '../core/machine.ts';
import type { SceneState } from '../core/scene.ts';
import { frostTexture, gridMeshTexture, labelTexture, radialTexture } from './textures.ts';

/**
 * three.js view of the machine. It is a pure function of `SceneState`
 * snapshots: `setScene()` poses the links, the syringe, the frost and the
 * droplets; nothing here knows whether the data is live or replayed.
 *
 * Geometry comes from `machineGeometry()` (shared with the Foxglove export).
 * Machine coordinates (mm, Z up) live under one root group that rotates them
 * into three.js' Y-up world.
 */

export interface MachineViewOptions {
  reducedMotion: boolean;
  /** Element whose on-screen rectangle receives the tip-camera picture. */
  insetElement?: HTMLElement | null;
}

export class WebGLUnavailableError extends Error {
  override name = 'WebGLUnavailableError';
}

const BACKGROUND = 0x1a2027;
const ICE = 0x7fd3f5;
const COPPER = new Color(MATERIAL_COLORS.copper.r, MATERIAL_COLORS.copper.g, MATERIAL_COLORS.copper.b);
const FROSTED = new Color(0xdde8ee);
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
  readonly #camera = new PerspectiveCamera(32, 1, 1, 6000);
  readonly #tipCamera = new PerspectiveCamera(34, 4 / 3, 0.5, 800);
  readonly #controls: OrbitControls;
  readonly #root = new Group();
  readonly #links = {} as Record<LinkName, Group>;
  readonly #resize: ResizeObserver;
  readonly #disposables: { dispose(): void }[] = [];

  #coldMaterial!: MeshStandardMaterial;
  #frostMaterial!: MeshStandardMaterial;
  #glowMaterial!: MeshBasicMaterial;
  #coldLight!: PointLight;
  #vapour!: Vapour;
  #syringeLiquid!: Mesh;
  #plunger!: Group;
  #droplets: Mesh[] = [];
  #plannedPath!: Line;
  #plannedPoints!: Points;
  #trail!: Line;
  #trailPositions = new Float32Array(TRAIL_CAPACITY * 3);

  #plate: Primitive | null = null;
  #coldness = 0;
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
    r.toneMappingExposure = 1.05;
    r.shadowMap.enabled = true;
    r.shadowMap.type = PCFShadowMap;
    r.autoClear = false;
    r.domElement.className = 'machine-canvas';
    r.domElement.setAttribute('aria-hidden', 'true');
    host.appendChild(r.domElement);

    this.#scene.background = new Color(BACKGROUND);
    this.#scene.fog = new Fog(BACKGROUND, 700, 1700);
    const pmrem = new PMREMGenerator(r);
    const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.#scene.environment = environment;
    this.#scene.environmentIntensity = 0.9;
    pmrem.dispose();
    this.#disposables.push(environment);

    this.#buildLights();
    this.#buildFloor();
    this.#buildMachine();
    this.#buildOverlays();

    this.#controls = new OrbitControls(this.#camera, r.domElement);
    this.#controls.enableDamping = !options.reducedMotion;
    this.#controls.dampingFactor = 0.08;
    this.#controls.minDistance = 160;
    this.#controls.maxDistance = 1400;
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

    // Syringe: the liquid column and the plunger follow the pump volume.
    const fill = Math.min(1, Math.max(0, state.pump.volume_nl / this.#machine.pump.capacityNl));
    const column = Math.max(0.05, fill * 30);
    this.#syringeLiquid.scale.set(1, column, 1);
    this.#syringeLiquid.position.z = 20.6 + column / 2;
    this.#syringeLiquid.visible = fill > 0.002;
    this.#plunger.position.z = 20.6 + column;

    // Cold plate: frost, tint and glow grow as the stage cools.
    const { ambientC } = this.#machine.stage;
    const coldness = Math.min(1, Math.max(0, (ambientC - state.stage.celsius) / (ambientC + 180)));
    if (Math.abs(coldness - this.#coldness) > 1e-3) {
      this.#coldness = coldness;
      const frost = coldness ** 1.6;
      this.#coldMaterial.color.copy(COPPER).lerp(FROSTED, frost * 0.85);
      this.#coldMaterial.roughness = 0.3 + frost * 0.55;
      this.#coldMaterial.metalness = 0.95 - frost * 0.7;
      this.#coldMaterial.emissiveIntensity = coldness * 0.22;
      this.#frostMaterial.opacity = frost * 0.6;
      this.#glowMaterial.opacity = coldness * 0.38;
      this.#coldLight.intensity = coldness * 2600;
      this.#vapour.material.opacity = this.#options.reducedMotion ? 0 : coldness ** 2 * 0.22;
    }

    // Droplets (drawn 10× true size so a few nanolitres are visible).
    this.#droplets.forEach((mesh, i) => {
      const d = state.droplets[i];
      mesh.visible = d !== undefined && d.volumeNl > 0.001;
      if (!d || !mesh.visible) return;
      const r = dropletRadiusMm(d.volumeNl);
      mesh.scale.set(r, r, r * 0.55);
      mesh.position.set(d.x, d.y, 0.06 + r * 0.33);
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
      const geometry = obj.geometry;
      geometry.setAttribute('position', new BufferAttribute(flat, 3));
      geometry.computeBoundingSphere();
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
    // Aim slightly right of the machine's centre so it sits left of the tip-camera inset.
    this.#controls.target.set(20, 46, 4);
    this.#camera.position.set(262, 218, 372);
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
      for (const m of Array.isArray(material) ? material : material ? [material] : []) m.dispose();
    });
    for (const d of this.#disposables) d.dispose();
    this.#renderer.dispose();
    this.#renderer.forceContextLoss();
    this.#renderer.domElement.remove();
  }

  // ── construction ─────────────────────────────────────────────────

  #buildLights(): void {
    this.#scene.add(new HemisphereLight(0xdfe8f0, 0x1c232a, 0.9));
    const key = new DirectionalLight(0xffffff, 2.2);
    key.position.set(220, 420, 260);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.radius = 4;
    key.shadow.bias = -0.0004;
    const cam = key.shadow.camera;
    cam.left = -230;
    cam.right = 230;
    cam.top = 230;
    cam.bottom = -230;
    cam.near = 50;
    cam.far = 1200;
    this.#scene.add(key);
    const fill = new DirectionalLight(0xbcd7ef, 0.55);
    fill.position.set(-300, 180, -200);
    this.#scene.add(fill);
  }

  #buildFloor(): void {
    const floorY = -18; // bottom of the rubber feet (deck top is at y = 0)
    const floor = new Mesh(new PlaneGeometry(4000, 4000), new ShadowMaterial({ opacity: 0.32 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = floorY;
    floor.receiveShadow = true;
    this.#scene.add(floor);
    const grid = new GridHelper(2400, 120, 0x323c47, 0x262e37);
    grid.position.y = floorY + 0.05;
    this.#scene.add(grid);
  }

  #buildMachine(): void {
    const m = this.#machine;
    // Machine frame (mm, Z up) → three.js world (Y up), centred over the origin.
    this.#root.rotation.x = -Math.PI / 2;
    this.#root.position.set(-60, m.deck.gridPlaneHeight, 45);
    this.#scene.add(this.#root);

    for (const link of LINKS) this.#links[link] = new Group();
    this.#root.add(this.#links.world, this.#links.gantry_y);
    this.#links.gantry_y.add(this.#links.carriage_x);
    this.#links.carriage_x.add(this.#links.head_z);

    const materials = createMaterials();
    for (const mat of Object.values(materials)) this.#disposables.push(mat);
    const gridMap = gridMeshTexture();
    this.#disposables.push(gridMap);
    const gridMaterial = new MeshStandardMaterial({ map: gridMap, metalness: 0.9, roughness: 0.35 });

    for (const part of machineGeometry(m)) {
      let material: Material = materials[part.material];
      if (part.role === 'cold-plate') {
        this.#coldMaterial = materials.copper.clone();
        this.#coldMaterial.emissive = new Color(0x4fb8ee);
        this.#coldMaterial.emissiveIntensity = 0;
        material = this.#coldMaterial;
      } else if (part.role === 'grid') {
        material = gridMaterial;
      }
      const mesh = primitiveMesh(part, material);
      const transparent = part.material === 'glass' || part.material === 'sample';
      mesh.castShadow = !transparent;
      mesh.receiveShadow = !transparent;
      this.#links[part.link].add(mesh);
      if (part.role === 'cold-plate') this.#buildColdEffects(part);
    }

    this.#buildBreadboard(materials.lens);
    this.#buildSyringe(materials);
    this.#buildDroplets();
  }

  /** Threaded-hole pattern on the deck, as on an optical breadboard. */
  #buildBreadboard(material: MeshStandardMaterial): void {
    const deck = machineGeometry(this.#machine).find((p) => p.id === 'deck');
    if (!deck) return;
    const pitch = 12.5;
    const holes: [number, number][] = [];
    for (let x = deck.center.x - deck.size.x / 2 + 8; x < deck.center.x + deck.size.x / 2 - 4; x += pitch) {
      for (let y = deck.center.y - deck.size.y / 2 + 8; y < deck.center.y + deck.size.y / 2 - 4; y += pitch) {
        holes.push([x, y]);
      }
    }
    const mesh = new InstancedMesh(new CylinderGeometry(1.7, 1.7, 0.3, 12), material, holes.length);
    const top = deck.center.z + deck.size.z / 2;
    const matrix = new Matrix4();
    const rotate = new Matrix4().makeRotationX(Math.PI / 2);
    holes.forEach(([x, y], i) =>
      mesh.setMatrixAt(i, matrix.makeTranslation(x, y, top + 0.1).multiply(rotate)),
    );
    mesh.receiveShadow = true;
    this.#links.world.add(mesh);
  }

  #buildColdEffects(plate: Primitive): void {
    this.#plate = plate;
    const frostMap = frostTexture();
    const glowMap = radialTexture();
    const softDot = radialTexture(64);
    this.#disposables.push(frostMap, glowMap, softDot);

    this.#frostMaterial = new MeshStandardMaterial({
      color: 0xf4fbff,
      roughness: 1,
      metalness: 0,
      transparent: true,
      opacity: 0,
      alphaMap: frostMap,
      depthWrite: false,
    });
    const frost = new Mesh(
      new BoxGeometry(plate.size.x + 0.8, plate.size.y + 0.8, plate.size.z + 0.5),
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
    });
    const glow = new Mesh(new PlaneGeometry(plate.size.x * 2.1, plate.size.y * 2.6), this.#glowMaterial);
    glow.position.set(plate.center.x, plate.center.y, -this.#machine.deck.gridPlaneHeight + 0.25);
    this.#links.world.add(glow);

    this.#coldLight = new PointLight(0xc4eaff, 0, 0, 2);
    this.#coldLight.position.set(plate.center.x, plate.center.y - 6, plate.center.z + 22);
    this.#links.world.add(this.#coldLight);

    // Cold vapour: denser than air, it rolls off the plate edges and sinks.
    const count = 36;
    const seeds = new Float32Array(count * 3);
    for (let i = 0; i < count; i++)
      seeds.set([Math.random(), Math.random(), 1.6 + Math.random() * 1.6], i * 3);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(count * 3), 3));
    const material = new PointsMaterial({
      color: 0xeaf7ff,
      size: 11,
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
    const liquid = new Mesh(new CylinderGeometry(3.7, 3.7, 1, 24), materials.sample);
    liquid.rotation.x = Math.PI / 2;
    head.add(liquid);
    this.#syringeLiquid = liquid;

    const plunger = new Group();
    const tip = new Mesh(new CylinderGeometry(3.9, 3.9, 2, 24), materials.rubber);
    tip.rotation.x = Math.PI / 2;
    tip.position.z = 1;
    const rod = new Mesh(new CylinderGeometry(1.2, 1.2, 46, 12), materials.steel);
    rod.rotation.x = Math.PI / 2;
    rod.position.z = 25;
    const thumb = new Mesh(new CylinderGeometry(5.5, 5.5, 1.6, 24), materials.steel);
    thumb.rotation.x = Math.PI / 2;
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
      roughness: 0.06,
      metalness: 0,
      clearcoat: 1,
      transparent: true,
      opacity: 0.92,
      emissive: new Color(0x2a1d5c),
      emissiveIntensity: 0.25,
    });
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
    // Reachable tool-tip volume (the axis limits), drawn faintly.
    const size = { x: axes.x.max - axes.x.min, y: axes.y.max - axes.y.min, z: axes.z.max - axes.z.min };
    const box = new LineSegments(
      new EdgesGeometry(new BoxGeometry(size.x, size.y, size.z)),
      new LineBasicMaterial({ color: 0x9fb2c3, transparent: true, opacity: 0.28 }),
    );
    box.position.set(axes.x.min + size.x / 2, axes.y.min + size.y / 2, axes.z.min + size.z / 2);
    this.#root.add(box);

    // Axis triad at the machine origin, in the same colours as the charts.
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

    // Planned path (dashed) and the travelled trail.
    const planned = new BufferGeometry();
    planned.setAttribute('position', new BufferAttribute(new Float32Array(0), 3));
    this.#plannedPath = new Line(
      planned,
      new LineDashedMaterial({ color: ICE, dashSize: 3, gapSize: 2.2, transparent: true, opacity: 0.55 }),
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
    const v = this.#vapour;
    const p = this.#plate;
    if (this.#options.reducedMotion || this.#coldness < 0.15 || !p) {
      v.points.visible = false;
      return false;
    }
    v.points.visible = true;
    const plate = { x: p.center.x, y: p.center.y, w: p.size.x, d: p.size.y, top: p.center.z + p.size.z / 2 };
    const attr = v.points.geometry.getAttribute('position') as BufferAttribute;
    const t = now / 1000;
    for (let i = 0; i < attr.count; i++) {
      const a = v.seeds[i * 3] ?? 0;
      const b = v.seeds[i * 3 + 1] ?? 0;
      const life = v.seeds[i * 3 + 2] ?? 2;
      const phase = (((t / life + a) % 1) + 1) % 1;
      // Start on the plate perimeter, drift outwards and sink.
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
    this.#tipCamera.position.copy(head.localToWorld(new Vector3(-17, 3, 19)));
    this.#tipCamera.lookAt(head.localToWorld(new Vector3(0.5, 0, -0.8)));
  }

  #fitToAspect(): void {
    // Portrait screens: back the camera off so the whole machine stays in view.
    const aspect = this.#camera.aspect || 1;
    const factor = aspect < 1.2 ? Math.min(1.9, 1.2 / aspect) : 1;
    const target = this.#controls.target;
    const offset = this.#camera.position.clone().sub(target);
    const base = 510;
    offset.setLength(base * factor);
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

/** PBR materials by name (MeshPhysicalMaterial extends MeshStandardMaterial). */
function createMaterials(): Record<MaterialName, MeshStandardMaterial> {
  const c = (name: MaterialName) => {
    const { r, g, b } = MATERIAL_COLORS[name];
    return new Color(r, g, b);
  };
  const std = (name: MaterialName, metalness: number, roughness: number) =>
    new MeshStandardMaterial({ color: c(name), metalness, roughness });
  return {
    deck: std('deck', 0.5, 0.55),
    anodized: std('anodized', 0.6, 0.42),
    aluminium: std('aluminium', 0.75, 0.3),
    steel: std('steel', 1, 0.18),
    ptfe: std('ptfe', 0, 0.75),
    copper: std('copper', 0.95, 0.3),
    glass: new MeshPhysicalMaterial({
      color: c('glass'),
      metalness: 0,
      roughness: 0.04,
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
    grid: std('grid', 0.9, 0.35),
    rubber: std('rubber', 0, 0.9),
    hose: std('hose', 0.1, 0.8),
    white: std('white', 0.1, 0.45),
    lens: std('lens', 0.5, 0.08),
  };
}

function primitiveMesh(part: Primitive, material: Material): Mesh {
  if (part.shape === 'box') {
    const mesh = new Mesh(new BoxGeometry(part.size.x, part.size.y, part.size.z), material);
    mesh.position.set(part.center.x, part.center.y, part.center.z);
    return mesh;
  }
  const radius = part.size.x / 2;
  const segments = radius < 2 ? 16 : 40;
  const mesh = new Mesh(new CylinderGeometry(radius, radius, part.size.z, segments), material);
  mesh.position.set(part.center.x, part.center.y, part.center.z);
  // three.js cylinders run along Y; turn them onto the requested machine axis.
  if (part.axis === 'z' || part.axis === undefined) mesh.rotation.x = Math.PI / 2;
  else if (part.axis === 'x') mesh.rotation.z = -Math.PI / 2;
  return mesh;
}
