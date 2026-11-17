import * as THREE from "three";

/*
  The start page's picture: six small farms from different parts of the world, one at a time
  on a slowly turning slab, changing every four and a half seconds. Decoration only: nothing here is data,
  and nothing here is read by the rest of the app.

  Each farm is built once from a handful of shared shapes (box, cylinder, cone, ball, roof)
  and shared flat colours, so the whole set is a few hundred small meshes. Loaded lazily, and
  only where the browser can draw 3D, so the page and its button never wait for it.
*/

type V3 = [number, number, number];

/** Seconds each farm is on screen, including its way in and out. */
export const SWITCH_SECONDS = 4.5;
const IN = 0.45;
const OUT = 0.25;
/** One full turn takes about 26 seconds. */
const TURN_SPEED = 0.24;
/** The camera: its angle of view, how steeply it looks down, and how much room the farm needs around its middle. */
const FOV = 30;
const PITCH = 0.54;
const LOOK_AT_Y = -0.2;
const FIT_HIGH = 4.95;
const FIT_WIDE = 6.2;
/** Half the slab's width: everything on a farm stays inside this. */
export const HALF = 4;

const C = {
  soil: "#8b6b4e",
  tile: "#a07d5a",
  grass: "#a9d46e",
  meadow: "#b7dc7b",
  plot: "#bcd47c",
  bund: "#93c466",
  leaf: "#4a9e5c",
  leafDark: "#3d8a52",
  crop: "#63b552",
  veg: "#7cc46a",
  water: "#7fd6ea",
  red: "#d85c4a",
  redDark: "#9c4238",
  white: "#f6f1e7",
  grey: "#d5dbe0",
  greyDark: "#aab4bd",
  wood: "#a67c52",
  woodLight: "#d6b584",
  woodDark: "#6b4f3a",
  thatch: "#c8a55e",
  gold: "#ecc45f",
  goldDark: "#dfb24e",
  stubble: "#e3cf93",
  terracotta: "#cf6f4f",
  orange: "#f59f3a",
  dark: "#3b4046",
  mud: "#d2a070",
  path: "#dcc89c",
  tractor: "#2f9e6b",
  cowDark: "#5b4636",
  cowBrown: "#b57a4d",
  cowBrownDark: "#8d5a36",
} as const;

/** The shared shapes and colours, and the few ways a farm places them. A height of 0 is the slab's top. */
function makeKit() {
  const mats = new Map<string, THREE.MeshLambertMaterial>();
  const mat = (color: string) => {
    let m = mats.get(color);
    if (!m) {
      m = new THREE.MeshLambertMaterial({ color, flatShading: true });
      mats.set(color, m);
    }
    return m;
  };

  const box = new THREE.BoxGeometry(1, 1, 1);
  const cyl = new THREE.CylinderGeometry(0.5, 0.5, 1, 16);
  const cone = new THREE.ConeGeometry(0.5, 1, 12);
  /** A four-sided roof over a square of side 1. */
  const pyr = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1, false, Math.PI / 4);
  const ball = new THREE.IcosahedronGeometry(0.5, 1);
  /** A pitched roof: ridge along z, 1 wide, 1 high, 1 long. */
  const gable = new THREE.Shape();
  gable.moveTo(-0.5, -0.5);
  gable.lineTo(0.5, -0.5);
  gable.lineTo(0, 0.5);
  gable.closePath();
  const prism = new THREE.ExtrudeGeometry(gable, { depth: 1, bevelEnabled: false });
  prism.translate(0, 0, -0.5);
  /** The slab: a square with rounded corners, 1 thick, its top at height 0. */
  const r = 0.8;
  const edge = new THREE.Shape();
  edge.moveTo(-HALF + r, -HALF);
  edge.lineTo(HALF - r, -HALF);
  edge.quadraticCurveTo(HALF, -HALF, HALF, -HALF + r);
  edge.lineTo(HALF, HALF - r);
  edge.quadraticCurveTo(HALF, HALF, HALF - r, HALF);
  edge.lineTo(-HALF + r, HALF);
  edge.quadraticCurveTo(-HALF, HALF, -HALF, HALF - r);
  edge.lineTo(-HALF, -HALF + r);
  edge.quadraticCurveTo(-HALF, -HALF, -HALF + r, -HALF);
  const slab = new THREE.ExtrudeGeometry(edge, { depth: 1, bevelEnabled: false, curveSegments: 8 });
  slab.rotateX(-Math.PI / 2);
  slab.translate(0, -1, 0);

  const shapes = [box, cyl, cone, pyr, ball, prism, slab];
  const instanced: THREE.InstancedMesh[] = [];

  /** One shape, sized, standing on `at` (its height is where the shape's underside sits). */
  const put = (g: THREE.Object3D, geo: THREE.BufferGeometry, color: string, size: V3, at: V3, rot?: V3) => {
    const m = new THREE.Mesh(geo, mat(color));
    m.scale.set(size[0], size[1], size[2]);
    m.position.set(at[0], at[1] + size[1] / 2, at[2]);
    if (rot) m.rotation.set(rot[0], rot[1], rot[2]);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
    return m;
  };

  /** The same shape many times (a crop), drawn in one go. Sizes vary a little so rows do not look stamped. */
  const many = (g: THREE.Object3D, geo: THREE.BufferGeometry, color: string, size: V3, points: V3[]) => {
    const m = new THREE.InstancedMesh(geo, mat(color), points.length);
    const o = new THREE.Object3D();
    points.forEach((p, i) => {
      const s = 0.86 + 0.28 * ((i * 0.618034) % 1);
      o.scale.set(size[0] * s, size[1] * s, size[2] * s);
      o.position.set(p[0], p[1] + (size[1] * s) / 2, p[2]);
      o.rotation.y = i * 1.7;
      o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
    });
    m.instanceMatrix.needsUpdate = true;
    m.castShadow = true;
    m.receiveShadow = true;
    instanced.push(m);
    g.add(m);
    return m;
  };

  const ground = (g: THREE.Object3D, top: string) => {
    const under = new THREE.Mesh(slab, mat(C.soil));
    under.scale.y = 0.6;
    under.position.y = -0.14;
    const cover = new THREE.Mesh(slab, mat(top));
    cover.scale.y = 0.14;
    for (const m of [under, cover]) {
      m.castShadow = true;
      m.receiveShadow = true;
      g.add(m);
    }
  };

  const group = (g: THREE.Object3D, at: V3, turn = 0) => {
    const c = new THREE.Group();
    c.position.set(at[0], at[1], at[2]);
    c.rotation.y = turn;
    g.add(c);
    return c;
  };

  const tree = (g: THREE.Object3D, x: number, z: number, s = 1) => {
    put(g, cyl, C.wood, [0.2 * s, 0.6 * s, 0.2 * s], [x, 0, z]);
    put(g, ball, C.leaf, [1.2 * s, 1.1 * s, 1.2 * s], [x, 0.45 * s, z]);
    put(g, ball, C.leafDark, [0.75 * s, 0.7 * s, 0.75 * s], [x + 0.26 * s, 1.05 * s, z + 0.1 * s]);
  };

  const palm = (g: THREE.Object3D, at: V3, height: number) => {
    put(g, cyl, C.wood, [0.15, height, 0.15], at);
    for (let i = 0; i < 6; i++) {
      const leaf = group(g, [at[0], at[1] + height, at[2]], (i * Math.PI) / 3);
      put(leaf, box, i % 2 ? C.leaf : C.leafDark, [0.9, 0.05, 0.3], [0.42, -0.14, 0], [0, 0, -0.42]);
    }
  };

  /** Walls and a pitched roof. The ridge runs front to back until `turn` says otherwise. */
  const house = (g: THREE.Object3D, x: number, z: number, size: V3, wall: string, roof: string, turn = 0) => {
    const c = group(g, [x, 0, z], turn);
    put(c, box, wall, size, [0, 0, 0]);
    put(c, prism, roof, [size[0] + 0.24, size[1] * 0.6, size[2] + 0.24], [0, size[1], 0]);
    return c;
  };

  const dispose = () => {
    for (const s of shapes) s.dispose();
    for (const m of mats.values()) m.dispose();
    for (const m of instanced) m.dispose();
  };

  return { box, cyl, cone, pyr, ball, prism, put, many, ground, group, tree, palm, house, dispose };
}
type Kit = ReturnType<typeof makeKit>;

/** Points on a grid, from one corner, standing at height `y`. */
function grid(x0: number, z0: number, nx: number, nz: number, dx: number, dz: number, y = 0): V3[] {
  const out: V3[] = [];
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) out.push([x0 + i * dx, y, z0 + j * dz]);
  return out;
}

/** Rows of maize beside a red barn and a silo. */
function maizeFarm(k: Kit) {
  const g = new THREE.Group();
  k.ground(g, C.grass);
  k.put(g, k.box, C.tile, [4.6, 0.05, 6.6], [-1.45, 0, 0]);
  k.many(g, k.cone, C.crop, [0.34, 0.62, 0.34], grid(-3.4, -2.9, 8, 13, 0.56, 0.485, 0.05));
  const barn = k.house(g, 2.45, -1.7, [1.8, 1.25, 2.3], C.red, C.redDark);
  k.put(barn, k.box, C.white, [0.75, 0.85, 0.06], [0, 0, 1.16]);
  k.put(g, k.cyl, C.grey, [0.85, 2, 0.85], [3, 0, 0.35]);
  k.put(g, k.ball, C.greyDark, [0.85, 0.6, 0.85], [3, 1.7, 0.35]);
  k.put(g, k.cyl, C.gold, [0.5, 0.45, 0.5], [1.5, 0.025, 1.3], [0, 0.3, Math.PI / 2]);
  k.put(g, k.cyl, C.gold, [0.5, 0.45, 0.5], [2.1, 0.025, 1.8], [0, -0.5, Math.PI / 2]);
  k.tree(g, 1.5, 2.9);
  k.tree(g, 3, 2.7, 0.8);
  return g;
}

/** Rice in flooded terraces, with a hut on stilts. */
function riceFarm(k: Kit) {
  const g = new THREE.Group();
  k.ground(g, C.grass);
  const tufts: V3[] = [];
  const steps: Array<[number, number]> = [[-2.45, 0.9], [0, 0.5], [2.45, 0.12]];
  steps.forEach(([z, h], row) => {
    k.put(g, k.box, C.bund, [7.3, h, 2.3], [0, 0, z]);
    for (const x of [-1.8, 1.8]) {
      if (row === 2 && x > 0) continue;
      k.put(g, k.box, C.water, [3.3, 0.05, 1.9], [x, h, z]);
      tufts.push(...grid(x - 1.35, z - 0.7, 7, 4, 0.45, 0.47, h + 0.05));
    }
  });
  k.many(g, k.cone, C.leaf, [0.17, 0.34, 0.17], tufts);
  const hut = k.group(g, [1.7, 0.12, 2.5]);
  for (const x of [-0.5, 0.5]) for (const z of [-0.4, 0.4]) k.put(hut, k.cyl, C.wood, [0.09, 0.4, 0.09], [x, 0, z]);
  k.put(hut, k.box, C.wood, [1.35, 0.08, 1.15], [0, 0.4, 0]);
  k.put(hut, k.box, C.woodLight, [1.1, 0.6, 0.9], [0, 0.48, 0]);
  k.put(hut, k.pyr, C.thatch, [1.75, 0.7, 1.5], [0, 1.08, 0]);
  k.palm(g, [2.95, 0.12, 2.1], 1.5);
  return g;
}

/** Fruit trees in rows, a white house and crates of fruit. */
function orchardFarm(k: Kit) {
  const g = new THREE.Group();
  k.ground(g, C.grass);
  const fruit: V3[] = [];
  const spots: V3[] = [[0.8, 0.3, 0.5], [-0.6, 0.5, 0.6], [0.1, 0.9, -0.4], [-0.5, 0.1, -0.85], [0.6, -0.1, -0.8], [0, 0.2, 1]];
  for (let row = 0; row < 3; row++) {
    const z = -2.6 + row * 1.9;
    k.put(g, k.box, C.tile, [6, 0.05, 0.9], [-0.65, 0, z]);
    for (let col = 0; col < 4; col++) {
      const x = -2.9 + col * 1.5;
      k.put(g, k.cyl, C.wood, [0.17, 0.55, 0.17], [x, 0, z]);
      k.put(g, k.ball, col % 2 ? C.leaf : C.leafDark, [1.15, 1.05, 1.15], [x, 0.45, z]);
      for (const [a, b, c] of spots) {
        const n = Math.hypot(a, b, c);
        fruit.push([x + (a / n) * 0.55, 0.9 + (b / n) * 0.5, z + (c / n) * 0.55]);
      }
    }
  }
  k.many(g, k.ball, C.orange, [0.15, 0.15, 0.15], fruit);
  const home = k.house(g, 3, -1.9, [1.3, 1, 1.7], C.white, C.terracotta);
  k.put(home, k.box, C.wood, [0.06, 0.6, 0.4], [-0.66, 0, 0.2]);
  for (const [x, z] of [[2.9, 0.3], [3.2, 0.95], [2.65, 1.0]] as const) {
    k.put(g, k.box, C.woodLight, [0.5, 0.3, 0.5], [x, 0, z]);
    k.put(g, k.box, C.orange, [0.4, 0.08, 0.4], [x, 0.3, z]);
  }
  k.tree(g, 3, 2.7, 0.8);
  return g;
}

/** Grazing land: a fence, a pond, a shed and four cattle. */
function pastureFarm(k: Kit) {
  const g = new THREE.Group();
  k.ground(g, C.meadow);
  const edge = 3.4;
  for (let i = 0; i < 5; i++) {
    const p = -edge + i * 1.7;
    for (const s of [-edge, edge]) {
      k.put(g, k.box, C.wood, [0.13, 0.62, 0.13], [p, 0, s]);
      if (i > 0 && i < 4) k.put(g, k.box, C.wood, [0.13, 0.62, 0.13], [s, 0, p]);
    }
  }
  for (const y of [0.2, 0.44]) {
    for (const s of [-edge, edge]) {
      k.put(g, k.box, C.woodLight, [edge * 2, 0.07, 0.07], [0, y, s]);
      k.put(g, k.box, C.woodLight, [0.07, 0.07, edge * 2], [s, y, 0]);
    }
  }
  k.put(g, k.cyl, C.water, [2.4, 0.04, 1.8], [-1.5, 0, 1.6]);
  const cow = (x: number, z: number, turn: number, coat: string, patch: string) => {
    const c = k.group(g, [x, 0, z], turn);
    k.put(c, k.box, coat, [0.9, 0.46, 0.42], [0, 0.3, 0]);
    k.put(c, k.box, patch, [0.32, 0.47, 0.44], [-0.12, 0.297, 0]);
    k.put(c, k.box, coat, [0.3, 0.3, 0.3], [0.56, 0.42, 0]);
    k.put(c, k.box, patch, [0.1, 0.12, 0.2], [0.72, 0.42, 0]);
    for (const lx of [-0.32, 0.32]) for (const lz of [-0.13, 0.13]) k.put(c, k.box, coat, [0.1, 0.3, 0.1], [lx, 0, lz]);
  };
  cow(0.9, -0.4, 0.4, C.white, C.cowDark);
  cow(2.2, 1.5, -2.2, C.cowBrown, C.cowBrownDark);
  cow(-0.3, -2, 2.8, C.white, C.cowDark);
  cow(1.4, 2.6, 1.2, C.cowBrown, C.cowBrownDark);
  k.house(g, 2.3, -2.4, [1.2, 0.9, 1.7], C.woodLight, C.greyDark, Math.PI / 2);
  k.put(g, k.box, C.greyDark, [1, 0.24, 0.36], [0.2, 0, -2.75]);
  k.put(g, k.box, C.water, [0.86, 0.03, 0.24], [0.2, 0.24, -2.75]);
  k.tree(g, -2.4, -2.2, 1.15);
  return g;
}

/** A small family plot: round thatched houses, a maize patch and a vegetable patch. */
function plotFarm(k: Kit) {
  const g = new THREE.Group();
  k.ground(g, C.plot);
  k.put(g, k.box, C.path, [0.7, 0.03, 7.2], [0.55, 0, 0]);
  k.put(g, k.box, C.tile, [3.1, 0.05, 3], [-1.85, 0, -1.85]);
  const maize = grid(-3, -2.95, 5, 5, 0.58, 0.55, 0.05);
  k.many(g, k.cone, C.crop, [0.3, 0.9, 0.3], maize);
  k.many(g, k.ball, C.gold, [0.12, 0.12, 0.12], maize.map(([x, , z]) => [x, 0.78, z] as V3));
  k.put(g, k.box, C.tile, [3.1, 0.05, 2.9], [-1.85, 0, 1.85]);
  const beds = grid(-3.05, 0.75, 6, 5, 0.48, 0.55, 0.05);
  k.many(g, k.ball, C.veg, [0.36, 0.28, 0.36], beds.filter((_, i) => i % 5 !== 1 && i % 5 !== 3));
  k.many(g, k.ball, C.leafDark, [0.3, 0.24, 0.3], beds.filter((_, i) => i % 5 === 1 || i % 5 === 3));
  k.put(g, k.cyl, C.mud, [1.6, 0.85, 1.6], [2.4, 0, -2]);
  k.put(g, k.cone, C.thatch, [2.3, 1.05, 2.3], [2.4, 0.85, -2]);
  k.put(g, k.box, C.woodDark, [0.08, 0.6, 0.4], [1.6, 0, -2]);
  k.put(g, k.cyl, C.mud, [1.1, 0.65, 1.1], [2.6, 0, 0.5]);
  k.put(g, k.cone, C.thatch, [1.6, 0.8, 1.6], [2.6, 0.65, 0.5]);
  k.palm(g, [2.5, 0, 2.6], 1.3);
  return g;
}

/** Wheat being cut: standing grain, stubble, a tractor and a wind turbine. */
function wheatFarm(k: Kit) {
  const g = new THREE.Group();
  k.ground(g, C.grass);
  for (let i = 0; i < 11; i++) {
    const cut = i > 7;
    k.put(g, k.box, cut ? C.stubble : i % 2 ? C.gold : C.goldDark, [0.57, cut ? 0.08 : 0.36, 4.6], [-3.3 + i * 0.6, 0, 1]);
  }
  const t = k.group(g, [2.1, 0.08, 0.5], Math.PI / 2);
  k.put(t, k.box, C.tractor, [0.8, 0.36, 0.46], [0.15, 0.22, 0]);
  k.put(t, k.box, C.dark, [0.42, 0.42, 0.44], [-0.2, 0.58, 0]);
  k.put(t, k.box, C.tractor, [0.52, 0.05, 0.52], [-0.2, 1, 0]);
  k.put(t, k.cyl, C.dark, [0.06, 0.3, 0.06], [0.4, 0.58, 0.1]);
  for (const z of [-0.3, 0.3]) {
    k.put(t, k.cyl, C.dark, [0.56, 0.14, 0.56], [-0.22, 0.21, z], [Math.PI / 2, 0, 0]);
    k.put(t, k.cyl, C.dark, [0.34, 0.12, 0.34], [0.42, 0.11, z * 0.93], [Math.PI / 2, 0, 0]);
  }
  k.put(g, k.cyl, C.gold, [0.5, 0.45, 0.5], [1.6, 0.105, 2.4], [0, 0.4, Math.PI / 2]);
  k.put(g, k.cyl, C.gold, [0.5, 0.45, 0.5], [2.6, 0.105, 1.9], [0, -0.3, Math.PI / 2]);
  k.put(g, k.cyl, C.white, [0.2, 2.5, 0.2], [-2.7, 0, -2.6]);
  k.put(g, k.box, C.grey, [0.26, 0.22, 0.5], [-2.7, 2.45, -2.5]);
  const rotor = k.group(g, [-2.7, 2.56, -2.2]);
  k.put(rotor, k.ball, C.grey, [0.24, 0.24, 0.24], [0, -0.12, 0]);
  for (let i = 0; i < 3; i++) {
    const arm = new THREE.Group();
    arm.rotation.z = (i * Math.PI * 2) / 3;
    rotor.add(arm);
    k.put(arm, k.box, C.white, [0.13, 1, 0.04], [0, 0.06, 0]);
  }
  g.userData.tick = (seconds: number) => {
    rotor.rotation.z = seconds * 1.6;
  };
  k.house(g, 1.6, -2.5, [1.2, 1, 1.9], C.white, C.terracotta, Math.PI / 2);
  k.tree(g, 3.1, -2.4, 0.9);
  k.tree(g, -0.6, -2.5);
  return g;
}

const BUILDERS = [maizeFarm, riceFarm, orchardFarm, pastureFarm, plotFarm, wheatFarm];

/** The farms, built but not drawn. `dispose` frees their shapes and colours. */
export function buildFarms(): { farms: THREE.Group[]; dispose: () => void } {
  const kit = makeKit();
  return { farms: BUILDERS.map((b) => b(kit)), dispose: kit.dispose };
}

/** How big the farm on screen is, `u` seconds into its turn: it grows in, holds, and shrinks away. */
export function sizeAt(u: number): number {
  if (u < IN) {
    const k = u / IN - 1;
    return Math.max(0.001, 1 + 2.1 * k * k * k + 1.1 * k * k);
  }
  if (u > SWITCH_SECONDS - OUT) {
    const k = Math.min(1, (u - (SWITCH_SECONDS - OUT)) / OUT);
    return Math.max(0.001, 1 - k * k * k);
  }
  return 1;
}

/**
 * Draws the turning farms on `canvas` and returns a function that stops and frees everything.
 * With `still`, one farm is drawn once and nothing moves (for people who ask for less motion).
 */
export function startFarmScene(canvas: HTMLCanvasElement, opts: { still?: boolean } = {}): () => void {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "low-power" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 4 / 3, 1, 80);

  scene.add(new THREE.HemisphereLight("#ffffff", "#d9c7a6", 1.7));
  const sun = new THREE.DirectionalLight("#fff3dc", 2.3);
  sun.position.set(-6, 11, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -8;
  sun.shadow.camera.right = 8;
  sun.shadow.camera.top = 8;
  sun.shadow.camera.bottom = -8;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 32;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.03;
  scene.add(sun);

  // The slab floats: its soft shadow falls on an unseen floor a little below it.
  const floorGeo = new THREE.PlaneGeometry(40, 40);
  const floorMat = new THREE.ShadowMaterial({ opacity: 0.13 });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -1.15;
  floor.receiveShadow = true;
  scene.add(floor);

  const table = new THREE.Group();
  table.rotation.y = -0.6;
  scene.add(table);

  const { farms, dispose } = buildFarms();
  let shown = 0;
  table.add(farms[0]!);

  const draw = () => renderer.render(scene, camera);
  const fit = () => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    // Stand back far enough for the whole slab, whatever shape the picture's box is.
    const tan = Math.tan((FOV * Math.PI) / 360);
    const back = Math.max(FIT_HIGH / tan, FIT_WIDE / (tan * (w / h)));
    camera.position.set(0, LOOK_AT_Y + Math.sin(PITCH) * back, Math.cos(PITCH) * back);
    camera.lookAt(0, LOOK_AT_Y, 0);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // Drawn here as well as in the loop, so the first farm is on screen at once, even in a tab that is not animating yet.
    draw();
  };
  const watch = new ResizeObserver(fit);
  watch.observe(canvas);
  fit();

  let raf = 0;
  let last = performance.now();
  // The first farm starts at full size (the picture itself fades in); later farms grow in.
  let seconds = IN;
  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    // A long gap (a hidden tab) counts as one short step, so the farms never skip ahead.
    seconds += Math.min((now - last) / 1000, 0.1);
    last = now;
    const index = Math.floor(seconds / SWITCH_SECONDS) % farms.length;
    if (index !== shown) {
      table.remove(farms[shown]!);
      table.add(farms[index]!);
      shown = index;
    }
    const farm = farms[shown]!;
    farm.scale.setScalar(sizeAt(seconds % SWITCH_SECONDS));
    (farm.userData.tick as ((s: number) => void) | undefined)?.(seconds);
    table.rotation.y = -0.6 + seconds * TURN_SPEED;
    draw();
  };
  if (!opts.still) raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf);
    watch.disconnect();
    dispose();
    floorGeo.dispose();
    floorMat.dispose();
    renderer.dispose();
  };
}
