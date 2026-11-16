import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { CardKey } from "../content/strategies";
import type { StripVM } from "../view/build";
import { fieldStateAt, type FieldState } from "./growth";
import type { FieldGeometry } from "../farm/types";
import { insideStage, slabGeometry, stageShape, type FarmLayout, type PlacedShape, type StageShape } from "./polygonShape";

/*
  The 3D farm. Three fields side by side in card order. Everything shown is driven by plan
  dates, the selected past spring and modeled soil wetness; heights are schematic stages,
  not measured growth (playbook p.41). Loaded lazily so the page never waits for it.

  Quality pass (Nov 13): plants are built shapes (grass tufts, leafy corn, bushy soybeans)
  with smooth shading, real cast shadows, textured soil, rain streaks and a light wind.
  Three views that differ on purpose:
  - overview: all three fields from a three-quarter angle;
  - field:    the selected field alone, close;
  - cutaway:  the selected field from the front, low, showing soil layers, roots and the
              modeled water line.
*/

export type CameraPreset = "overview" | "field" | "cutaway";

export interface ScenePalette {
  cover: string;
  coverEnded: string;
  wheat: string;
  wheatGreen: string;
  corn: string;
  cornGreen: string;
  soy: string;
  soyMature: string;
  residue: string;
  rain: string;
  action: string;
  /** Selection color for the frame around the chosen field. */
  accent: string;
  check: string;
  water: string;
}

// Illustration colors for soil (not UI tokens).
const SOIL_DRY = new THREE.Color("#C9A57A");
const SOIL_WET = new THREE.Color("#4B3426");
const SUBSOIL = "#8A6748";
const DEEP = "#6B4F37";

const FIELD_W = 7.4;
const FIELD_D = 7.4;
const GAP = 1.1;
const SOIL_H = 1.6;
const X = [-(FIELD_W + GAP), 0, FIELD_W + GAP];
/*
  A real field is hundreds of metres across and a crop is a metre or two tall, so true scale
  would make the plants invisible. Plants are drawn small (about a tenth of the field's width
  at most, for full-grown corn) and in denser rows so the field reads as a crop, not as trees.
  Zoom in to see the individual plants.
*/
const PLANT_SCALE = 0.32;

function seeded(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

/** Grid positions with a little jitter, deterministic per field and crop. */
function grid(cols: number, rows: number, seed: number, jitter = 0.08) {
  const r = seeded(seed);
  const pts: Array<[number, number, number]> = [];
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const x = -FIELD_W / 2 + 0.35 + (i + 0.5) * ((FIELD_W - 0.7) / cols) + (r() - 0.5) * jitter;
      const z = -FIELD_D / 2 + 0.35 + (j + 0.5) * ((FIELD_D - 0.7) / rows) + (r() - 0.5) * jitter;
      pts.push([x, z, r()]);
    }
  }
  return pts;
}

/* ------------------------------------------------------------------ plant shapes
   Each shape is one merged geometry, 1 unit tall with its base at y = 0, so an instance
   scales straight up from the soil. */

/** A leaning blade: a thin cone tipped outward from the base. */
function blade(radius: number, lean: number, turn: number, height = 1) {
  const g = new THREE.ConeGeometry(radius, height, 6, 3);
  g.translate(0, height / 2, 0);
  g.rotateZ(lean);
  g.rotateY(turn);
  return g;
}

function makeTuft(blades: number, radius: number, spread: number) {
  const parts = [blade(radius, 0, 0)];
  for (let i = 0; i < blades; i++) parts.push(blade(radius * 0.9, spread * (0.6 + (i % 3) * 0.25), (i / blades) * Math.PI * 2, 0.78 + (i % 2) * 0.16));
  return mergeGeometries(parts)!;
}

function makeWheat() {
  const parts = [makeTuft(4, 0.022, 0.2)];
  // A seed head on the tallest stems.
  for (const [dx, dz] of [
    [0, 0],
    [0.05, 0.03],
    [-0.04, 0.05],
  ] as const) {
    const head = new THREE.SphereGeometry(0.045, 8, 6);
    head.scale(1, 2.6, 1);
    head.translate(dx, 0.98, dz);
    parts.push(head);
  }
  return mergeGeometries(parts)!;
}

function makeCorn() {
  const stalk = new THREE.CylinderGeometry(0.035, 0.055, 1, 8);
  stalk.translate(0, 0.5, 0);
  const parts: THREE.BufferGeometry[] = [stalk];
  // Long drooping leaves up the stalk, alternating sides.
  for (let i = 0; i < 6; i++) {
    const leaf = new THREE.ConeGeometry(0.07, 0.55, 5, 2);
    leaf.scale(1, 1, 0.22);
    leaf.translate(0, 0.275, 0);
    leaf.rotateZ(1.05 + (i % 2) * 0.2);
    leaf.rotateY((i * Math.PI * 2) / 2.6);
    leaf.translate(0, 0.22 + i * 0.12, 0);
    parts.push(leaf);
  }
  const tassel = new THREE.ConeGeometry(0.03, 0.16, 5);
  tassel.translate(0, 1.06, 0);
  parts.push(tassel);
  return mergeGeometries(parts)!;
}

function makeSoy() {
  const stem = new THREE.CylinderGeometry(0.02, 0.03, 0.5, 6);
  stem.translate(0, 0.25, 0);
  const parts: THREE.BufferGeometry[] = [stem];
  for (const [dx, dy, dz, s] of [
    [0, 0.72, 0, 0.3],
    [0.17, 0.55, 0.06, 0.24],
    [-0.15, 0.56, -0.08, 0.25],
    [0.03, 0.5, -0.17, 0.22],
    [-0.04, 0.48, 0.17, 0.22],
  ] as const) {
    const leaf = new THREE.SphereGeometry(s, 10, 8);
    leaf.scale(1, 0.7, 1);
    leaf.translate(dx, dy, dz);
    parts.push(leaf);
  }
  return mergeGeometries(parts)!;
}

/** Fine grain for the soil surface, so the top reads as earth instead of a flat color. */
function useSoilTexture() {
  return useMemo(() => {
    const c = document.createElement("canvas");
    c.width = c.height = 256;
    const g = c.getContext("2d");
    if (g) {
      g.fillStyle = "#d9d9d9";
      g.fillRect(0, 0, 256, 256);
      const r = seeded(7);
      for (let i = 0; i < 5200; i++) {
        const v = 150 + Math.floor(r() * 105);
        g.fillStyle = `rgb(${v},${v},${v})`;
        g.fillRect(r() * 256, r() * 256, 1 + r() * 2.2, 1 + r() * 2.2);
      }
      // Faint planting rows.
      g.fillStyle = "rgba(90,90,90,0.16)";
      for (let i = 0; i < 16; i++) g.fillRect(i * 16 + 6, 0, 3, 256);
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(1.5, 1.5);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, []);
}

/** A soft contact shadow so each field sits on the white stage instead of a painted ground. */
function useShadowTexture() {
  return useMemo(() => {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d");
    if (g) {
      const grad = g.createRadialGradient(64, 64, 8, 64, 64, 64);
      grad.addColorStop(0, "rgba(14,21,24,0.34)");
      grad.addColorStop(0.6, "rgba(14,21,24,0.12)");
      grad.addColorStop(1, "rgba(14,21,24,0)");
      g.fillStyle = grad;
      g.fillRect(0, 0, 128, 128);
    }
    return new THREE.CanvasTexture(c);
  }, []);
}

function Crop({
  geometry,
  points,
  show,
  height,
  color,
  size,
  tilt = 0,
  sway = 0.05,
}: {
  geometry: THREE.BufferGeometry;
  points: Array<[number, number, number]>;
  show: boolean;
  /** Growth stage, 0 to 1. */
  height: number;
  color: string;
  /** Full-grown height in scene units. */
  size: number;
  tilt?: number;
  sway?: number;
}) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const tmp = useMemo(() => new THREE.Object3D(), []);
  const { frameloop, invalidate } = useThree();
  // Plants ease toward their stage instead of snapping, so scrubbing the season reads as growth.
  const shown = useRef<{ h: number; tilt: number; mesh: THREE.InstancedMesh | null }>({ h: 0, tilt, mesh: null });
  const place = (h0: number, t: number, time: number) => {
    const mesh = ref.current;
    if (!mesh) return;
    points.forEach(([x, z, r], i) => {
      const h = Math.max(0.001, h0 * (0.82 + r * 0.36));
      const wind = time ? Math.sin(time * 1.5 + x * 0.9 + z * 0.6 + r * 6) * sway : 0;
      tmp.position.set(x, 0, z);
      tmp.rotation.set(t * (r - 0.5) + wind, r * Math.PI * 2, t * (0.5 - r) + wind * 0.6);
      const girth = (0.55 + 0.45 * Math.min(1, h0 * 1.4)) * PLANT_SCALE;
      tmp.scale.set(girth, size * PLANT_SCALE * h, girth);
      tmp.updateMatrix();
      mesh.setMatrixAt(i, tmp.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.visible = show && h0 > 0.01;
  };
  useLayoutEffect(() => {
    const target = show ? height : 0;
    if (frameloop === "demand") {
      shown.current = { h: target, tilt, mesh: ref.current };
      place(target, tilt, 0);
      invalidate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, height, size, tilt, show, frameloop]);
  useFrame((state, dt) => {
    if (frameloop === "demand") return;
    const target = show ? height : 0;
    const c = shown.current;
    const settled = Math.abs(c.h - target) < 0.002 && Math.abs(c.tilt - tilt) < 0.002;
    // Standing plants keep moving in the wind; flat or absent ones rest once they settle.
    if (settled && c.mesh === ref.current && (c.h < 0.02 || sway === 0)) return;
    c.mesh = ref.current;
    const k = Math.min(1, dt * 7);
    c.h += (target - c.h) * k;
    c.tilt += (tilt - c.tilt) * k;
    place(c.h, c.tilt, state.clock.elapsedTime);
  });
  return (
    <instancedMesh ref={ref} args={[geometry, undefined, points.length]} visible={false} castShadow>
      <meshStandardMaterial color={color} roughness={0.78} />
    </instancedMesh>
  );
}

function Residue({ amount, color, seed, shape }: { amount: number; color: string; seed: number; shape?: StageShape | null }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const count = 640;
  const geo = useMemo(() => {
    const g = new THREE.CylinderGeometry(0.022, 0.03, 0.46, 6);
    g.rotateZ(Math.PI / 2);
    return g;
  }, []);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const r = seeded(seed);
    const tmp = new THREE.Object3D();
    for (let i = 0; i < count; i++) {
      tmp.position.set((r() - 0.5) * (FIELD_W - 0.5), 0.03, (r() - 0.5) * (FIELD_D - 0.5));
      tmp.rotation.set(0, r() * Math.PI, (r() - 0.5) * 0.25);
      // Straw that would fall outside a drawn outline (or in a hole) is not drawn.
      tmp.scale.setScalar(shape && !insideStage(shape, tmp.position.x, -tmp.position.z) ? 0 : (0.75 + r() * 0.6) * 0.5);
      tmp.updateMatrix();
      mesh.setMatrixAt(i, tmp.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }, [seed, geo, shape]);
  // Straw thins out or fills in over a moment instead of jumping.
  const shown = useRef(amount);
  const { frameloop, invalidate } = useThree();
  useLayoutEffect(() => {
    if (frameloop !== "demand" || !ref.current) return;
    shown.current = amount;
    ref.current.count = Math.round(count * amount);
    invalidate();
  }, [amount, frameloop, invalidate]);
  useFrame((_, dt) => {
    if (frameloop === "demand" || !ref.current) return;
    if (Math.abs(shown.current - amount) < 0.004) return;
    shown.current += (amount - shown.current) * Math.min(1, dt * 5);
    ref.current.count = Math.round(count * shown.current);
  });
  return (
    <instancedMesh ref={ref} args={[geo, undefined, count]} castShadow>
      <meshStandardMaterial color={color} roughness={0.9} />
    </instancedMesh>
  );
}

/** Rain as short falling streaks; how many follows the replayed spring's rain against the median. */
function Rain({ intensity, color, animate, seed }: { intensity: number; color: string; animate: boolean; seed: number }) {
  const count = Math.round(380 * intensity);
  const ref = useRef<THREE.InstancedMesh>(null);
  const drops = useMemo(() => {
    const r = seeded(seed);
    return Array.from({ length: count }, () => ({ x: (r() - 0.5) * FIELD_W, y: r() * 8, z: (r() - 0.5) * FIELD_D, v: 7 + r() * 4 }));
  }, [count, seed]);
  const tmp = useMemo(() => new THREE.Object3D(), []);
  const write = () => {
    const mesh = ref.current;
    if (!mesh) return;
    drops.forEach((d, i) => {
      tmp.position.set(d.x, d.y, d.z);
      tmp.updateMatrix();
      mesh.setMatrixAt(i, tmp.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  };
  useLayoutEffect(write);
  useFrame((_, dt) => {
    if (!animate) return;
    for (const d of drops) {
      d.y -= dt * d.v;
      if (d.y < 0) d.y = 8;
    }
    write();
  });
  if (!count) return null;
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, count]}>
      <boxGeometry args={[0.014, 0.42, 0.014]} />
      <meshBasicMaterial color={color} transparent opacity={0.7} depthWrite={false} />
    </instancedMesh>
  );
}

/** Roots on the cut face: only while a cover or grain crop is alive, deeper as it grows. */
function Roots({ depth, color, seed }: { depth: number; color: string; seed: number }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const count = 46;
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const r = seeded(seed);
    const tmp = new THREE.Object3D();
    for (let i = 0; i < count; i++) {
      const len = Math.max(0.02, depth * (0.35 + r() * 0.95));
      tmp.position.set(-FIELD_W / 2 + 0.25 + (i / (count - 1)) * (FIELD_W - 0.5) + (r() - 0.5) * 0.1, -len / 2, 0);
      tmp.rotation.set(0, 0, (r() - 0.5) * 0.5);
      tmp.scale.set(1, len, 1);
      tmp.updateMatrix();
      mesh.setMatrixAt(i, tmp.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }, [depth, seed]);
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, count]} position={[0, 0, FIELD_D / 2 + 0.03]} visible={depth > 0.03}>
      <boxGeometry args={[0.03, 1, 0.012]} />
      <meshBasicMaterial color={color} />
    </instancedMesh>
  );
}

function Flag({ color }: { color: string }) {
  return (
    <group position={[-FIELD_W / 2 + 0.5, 0, FIELD_D / 2 - 0.5]}>
      <mesh position={[0, 1.1, 0]} castShadow>
        <cylinderGeometry args={[0.035, 0.035, 2.2, 10]} />
        <meshStandardMaterial color="#3a3a32" />
      </mesh>
      <mesh position={[0.42, 1.9, 0]} castShadow>
        <boxGeometry args={[0.8, 0.5, 0.03]} />
        <meshStandardMaterial color={color} />
      </mesh>
    </group>
  );
}

function SelectionFrame({ color }: { color: string }) {
  const t = 0.1;
  const y = 0.02;
  return (
    <group>
      {[FIELD_D / 2 + t / 2, -FIELD_D / 2 - t / 2].map((z) => (
        <mesh key={`h${z}`} position={[0, y, z]}>
          <boxGeometry args={[FIELD_W + 2 * t, 0.06, t]} />
          <meshBasicMaterial color={color} />
        </mesh>
      ))}
      {[-1, 1].map((s) => (
        <mesh key={`v${s}`} position={[(s * (FIELD_W + t)) / 2, y, 0]}>
          <boxGeometry args={[t, 0.06, FIELD_D]} />
          <meshBasicMaterial color={color} />
        </mesh>
      ))}
    </group>
  );
}

/** The selection frame for a drawn outline: an accent line along each outer ring, just above the soil. */
function OutlineFrame({ shape, color }: { shape: StageShape; color: string }) {
  const lines = useMemo(
    () =>
      shape.rings.map(([outerRing]) => {
        const g = new THREE.BufferGeometry().setFromPoints(outerRing!.map(([x, y]) => new THREE.Vector3(x, 0.04, -y)));
        return new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color }));
      }),
    [shape, color],
  );
  useEffect(() => () => lines.forEach((l) => (l.geometry.dispose(), (l.material as THREE.Material).dispose())), [lines]);
  return (
    <group>
      {lines.map((l, i) => (
        <primitive key={i} object={l} />
      ))}
    </group>
  );
}

function Field({
  strip,
  state,
  x,
  index,
  palette,
  animate,
  hidden,
  flat,
  onSelect,
  outline,
  placed,
}: {
  strip: StripVM;
  /** Farm layout: this field's outline at the farm's shared scale and its place on the stage. */
  placed?: PlacedShape | null;
  /** The drawn outline (card C3). Without one the field is the classic square slab. */
  outline?: FieldGeometry | null;
  state: FieldState | null;
  x: number;
  index: number;
  palette: ScenePalette;
  animate: boolean;
  /** In the one-field and soil views only the selected field is drawn. */
  hidden: boolean;
  /** The soil view looks straight at the cut face, so the floor shadow is left out. */
  flat: boolean;
  onSelect: (k: CardKey) => void;
}) {
  const shape = useMemo(() => placed?.shape ?? stageShape(outline, FIELD_W, FIELD_D), [outline, placed]);
  // Soil layers as slabs cut to the outline: topsoil, subsoil, deep layer, and the pale "not evaluated" slab.
  const slabs = useMemo(
    () => (shape ? { top: slabGeometry(shape, 0.35), sub: slabGeometry(shape, 0.55), deep: slabGeometry(shape, 0.7), ghost: slabGeometry(shape, 0.5) } : null),
    [shape],
  );
  useEffect(
    () => () => {
      if (slabs) for (const g of Object.values(slabs)) g.dispose();
    },
    [slabs],
  );
  const geos = useMemo(() => ({ corn: makeCorn(), tuft: makeTuft(7, 0.05, 0.42), wheat: makeWheat(), soy: makeSoy() }), []);
  const pts = useMemo(() => {
    // Plants only grow inside the drawn outline (stage z points south, so north is -z).
    const keep = (g: Array<[number, number, number]>) => (shape ? g.filter(([x, z]) => insideStage(shape, x, -z)) : g);
    return {
      corn: keep(grid(16, 26, 11 + index, 0.04)),
      tuft: keep(grid(34, 34, 21 + index, 0.12)),
      wheat: keep(grid(32, 36, 31 + index, 0.08)),
      soy: keep(grid(18, 40, 41 + index, 0.03)),
    };
  }, [index, shape]);

  const w = strip.weather;
  const wet = w.wetness;
  const soilColor = useMemo(() => {
    if (wet === null || !w.wetnessRange) return SOIL_DRY.clone().lerp(SOIL_WET, 0.5);
    const [lo, hi] = w.wetnessRange;
    const t = hi > lo ? (wet - lo) / (hi - lo) : 0.5;
    return SOIL_DRY.clone().lerp(SOIL_WET, 0.15 + 0.85 * t);
  }, [wet, w.wetnessRange]);
  // A plan the backend cannot evaluate yet is drawn as a pale glass slab, never as bare soil.
  const ghost = state === null;
  const waterTop = wet === null || ghost ? null : -SOIL_H + SOIL_H * Math.min(0.95, Math.max(0.05, wet));
  const rainIntensity =
    state?.inSpringWindow && w.complete && w.totalMm !== null && w.medianMm ? Math.min(2, Math.max(0.08, w.totalMm / w.medianMm)) : 0;
  const wheatColor = useMemo(
    () => "#" + new THREE.Color(palette.wheatGreen).lerp(new THREE.Color(palette.wheat), state?.wheat.ripe ?? 0).getHexString(),
    [palette, state?.wheat.ripe],
  );
  const rootDepth = state ? Math.max(state.cover.show && !state.cover.ended ? state.cover.h * 1.25 : 0, state.wheat.show ? state.wheat.h * 1.1 : 0) : 0;

  const grain = useSoilTexture();
  const shadow = useShadowTexture();
  const body = useRef<THREE.Group>(null);
  const outer = useRef<THREE.Group>(null);
  const topMat = useRef<THREE.MeshStandardMaterial>(null);
  const waterFill = useRef<THREE.Mesh>(null);
  const waterLine = useRef<THREE.Mesh>(null);
  const motion = useRef({ t: animate ? -index * 0.14 : 1, lift: 0, sink: hidden ? 1 : 0, dip: 0, water: waterTop ?? -SOIL_H });
  const { invalidate } = useThree();
  useEffect(() => invalidate(), [strip.selected, hidden, invalidate]);
  // The topsoil starts at its color and glides to a new one when the spring changes.
  useLayoutEffect(() => {
    topMat.current?.color.copy(soilColor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ghost]);
  useEffect(() => invalidate(), [soilColor, waterTop, invalidate]);
  // A different plan on this field (another winter, or evaluated to not evaluated) settles in with a short dip.
  const planKey = `${strip.plan?.plan_id ?? "none"}:${ghost}`;
  const lastPlan = useRef(planKey);
  useEffect(() => {
    if (lastPlan.current !== planKey) {
      lastPlan.current = planKey;
      if (animate) motion.current.dip = 1;
      invalidate();
    }
  }, [planKey, animate, invalidate]);
  useFrame((_, dt) => {
    const g = body.current;
    if (!g) return;
    const m = motion.current;
    const lift = strip.selected && !hidden ? 0.35 : 0;
    const waterTarget = waterTop ?? -SOIL_H;
    if (!animate) {
      m.t = 1;
      m.lift = lift;
      m.sink = hidden ? 1 : 0;
      m.dip = 0;
      m.water = waterTarget;
      topMat.current?.color.copy(soilColor);
    } else {
      m.t = Math.min(1, m.t + dt / 0.7);
      m.lift += (lift - m.lift) * Math.min(1, dt * 8);
      m.sink += ((hidden ? 1 : 0) - m.sink) * Math.min(1, dt * 7);
      m.dip += (0 - m.dip) * Math.min(1, dt * 5);
      m.water += (waterTarget - m.water) * Math.min(1, dt * 4);
      topMat.current?.color.lerp(soilColor, Math.min(1, dt * 4));
    }
    const e = m.t <= 0 ? 0 : 1 - Math.pow(1 - m.t, 3);
    g.visible = m.t > 0;
    // A field leaving the view (one-field and soil views) folds down into its own footprint:
    // it shrinks as it settles, so it is already gone when it stops being drawn. Dropping it
    // at full size and then hiding it left a block that vanished in plain sight.
    const away = m.sink * m.sink * (3 - 2 * m.sink);
    g.position.y = (e - 1) * 1.6 + m.lift - m.dip * 0.45 - away * 0.6;
    if (outer.current) {
      outer.current.scale.setScalar(Math.max(0.0001, 1 - away));
      outer.current.visible = m.sink < 0.985;
    }
    // The water plane is a unit square scaled to the modeled level.
    if (waterFill.current && waterLine.current) {
      const h = Math.max(0.001, m.water + SOIL_H);
      waterFill.current.scale.y = h;
      waterFill.current.position.y = -SOIL_H + h / 2;
      waterLine.current.position.y = m.water;
    }
  });

  const pick = (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    onSelect(strip.key);
  };

  return (
    <group ref={outer} position={[placed?.x ?? x, 0, placed?.z ?? 0]}>
      <mesh position={[0, -SOIL_H - 0.45, 0.4]} rotation={[-Math.PI / 2, 0, 0]} visible={!flat}>
        <planeGeometry args={[FIELD_W * 1.7, FIELD_D * 1.7]} />
        <meshBasicMaterial map={shadow} transparent depthWrite={false} />
      </mesh>
      <group ref={body}>
        {ghost && slabs ? (
          <mesh position={[0, -0.5, 0]} geometry={slabs.ghost} onClick={pick}>
            <meshPhysicalMaterial color="#BFEFF4" transparent opacity={0.5} roughness={0.15} clearcoat={1} />
          </mesh>
        ) : ghost ? (
          <mesh position={[0, -0.25, 0]} onClick={pick}>
            <boxGeometry args={[FIELD_W, 0.5, FIELD_D]} />
            <meshPhysicalMaterial color="#BFEFF4" transparent opacity={0.5} roughness={0.15} clearcoat={1} />
          </mesh>
        ) : slabs ? (
          <>
            {/* The drawn outline as three soil layers. The square's cut-face water line and roots are left out. */}
            <mesh
              position={[0, -0.35, 0]}
              geometry={slabs.top}
              receiveShadow
              onClick={pick}
              onPointerOver={() => (document.body.style.cursor = "pointer")}
              onPointerOut={() => (document.body.style.cursor = "")}
            >
              <meshStandardMaterial ref={topMat} map={grain} roughness={1} />
            </mesh>
            <mesh position={[0, -0.9, 0]} geometry={slabs.sub}>
              <meshStandardMaterial color={SUBSOIL} map={grain} roughness={1} />
            </mesh>
            <mesh position={[0, -1.6, 0]} geometry={slabs.deep}>
              <meshStandardMaterial color={DEEP} map={grain} roughness={1} />
            </mesh>
          </>
        ) : (
          <>
            {/* Soil block: grainy topsoil tinted by modeled wetness, then subsoil and a deeper layer on the cut face. */}
            <mesh
              position={[0, -0.175, 0]}
              receiveShadow
              onClick={pick}
              onPointerOver={() => (document.body.style.cursor = "pointer")}
              onPointerOut={() => (document.body.style.cursor = "")}
            >
              <boxGeometry args={[FIELD_W, 0.35, FIELD_D]} />
              <meshStandardMaterial ref={topMat} map={grain} roughness={1} />
            </mesh>
            <mesh position={[0, -0.625, 0]}>
              <boxGeometry args={[FIELD_W, 0.55, FIELD_D]} />
              <meshStandardMaterial color={SUBSOIL} map={grain} roughness={1} />
            </mesh>
            <mesh position={[0, -1.25, 0]}>
              <boxGeometry args={[FIELD_W, 0.7, FIELD_D]} />
              <meshStandardMaterial color={DEEP} map={grain} roughness={1} />
            </mesh>
            {waterTop !== null ? (
              <group position={[0, 0, FIELD_D / 2 + 0.012]}>
                <mesh ref={waterFill}>
                  <planeGeometry args={[FIELD_W, 1]} />
                  <meshBasicMaterial color={palette.water} transparent opacity={0.42} />
                </mesh>
                <mesh ref={waterLine} position={[0, waterTop, 0.002]}>
                  <planeGeometry args={[FIELD_W, 0.05]} />
                  <meshBasicMaterial color={palette.water} />
                </mesh>
              </group>
            ) : null}
            <Roots depth={rootDepth} color="#EADFC2" seed={71 + index} />
          </>
        )}

        {strip.selected ? placed && shape ? <OutlineFrame shape={shape} color={palette.accent} /> : <SelectionFrame color={palette.accent} /> : null}

        {state ? (
          <>
            <Residue amount={state.residue} color={palette.residue} seed={51 + index} shape={shape} />
            <Crop geometry={geos.corn} points={pts.corn} show={state.corn.show} height={state.corn.h} size={2.3} color={state.corn.mature ? palette.corn : palette.cornGreen} sway={0.03} />
            <Crop
              geometry={geos.tuft}
              points={pts.tuft}
              show={state.cover.show}
              height={state.cover.h}
              size={1.25}
              color={state.cover.ended ? palette.coverEnded : palette.cover}
              tilt={state.cover.ended ? 2.4 : 0.2}
              sway={state.cover.ended ? 0 : 0.07}
            />
            <Crop geometry={geos.wheat} points={pts.wheat} show={state.wheat.show} height={state.wheat.h} size={1.2} color={wheatColor} tilt={0.14} sway={0.08} />
            <Crop geometry={geos.soy} points={pts.soy} show={state.soy.show} height={state.soy.h} size={0.9} color={state.soy.mature ? palette.soyMature : palette.soy} sway={0.025} />
            {rainIntensity > 0 ? <Rain intensity={rainIntensity} color={palette.rain} animate={animate} seed={61 + index} /> : null}
          </>
        ) : null}
        {strip.status?.kind === "check" ? <Flag color={palette.check} /> : null}
      </group>
    </group>
  );
}

const FOV = 26;
const SCENE_HALF_W = (3 * FIELD_W + 2 * GAP) / 2 + 0.6;

/**
 * Camera position that fits a box (half-width hw, half-depth hd, half-height hh) seen from
 * the given elevation and turn, in a canvas of this aspect ratio.
 */
function fit(look: [number, number, number], hw: number, hd: number, hh: number, elevDeg: number, azDeg: number, aspect: number) {
  const v = Math.tan(((FOV / 2) * Math.PI) / 180);
  const a = (azDeg * Math.PI) / 180;
  const e = (elevDeg * Math.PI) / 180;
  // Width of the scene as the turned camera sees it.
  const across = hw * Math.abs(Math.cos(a)) + hd * Math.abs(Math.sin(a));
  const d = Math.max(across / (v * aspect), hh / v) * 1.04;
  return {
    pos: [look[0] + d * Math.sin(a) * Math.cos(e), look[1] + d * Math.sin(e), look[2] + d * Math.cos(a) * Math.cos(e)] as [number, number, number],
    look,
  };
}

/** Where the camera looks: the selected field's centre, and the half extents of the whole stage. */
interface Focus {
  x: number;
  z: number;
  halfW: number;
  halfD: number;
  /** Half the height the overview must fit on screen (a deep farm seen from above is taller). */
  halfH: number;
}
const STRIP_FOCUS = (x: number): Focus => ({ x, z: 0, halfW: SCENE_HALF_W + 0.3, halfD: FIELD_D / 2 + 0.6, halfH: 3.6 });

function presetFor(preset: CameraPreset, f: Focus, aspect: number, sway = 0) {
  // One field: close and a little lower, so the plants' shapes and height are the subject.
  if (preset === "field") return fit([f.x, 0.1, f.z + 0.4], FIELD_W / 2 + 0.2, FIELD_D / 2 + 0.2, 1.8, 26, -34 + sway, aspect);
  // Soil: straight at the cut face, almost level, so the layers, roots and water line fill the view.
  if (preset === "cutaway") return fit([f.x, -0.55, f.z + FIELD_D / 2], FIELD_W / 2 + 0.2, 0, 1.45, 3, 0, aspect);
  return fit([0, -0.9, 0], f.halfW, f.halfD, f.halfH, 33, -20 + sway, aspect);
}

/**
 * Moves the camera to the chosen view, then hands it to the reader: drag to rotate, scroll or
 * pinch to zoom, right-drag (or two fingers) to pan. Choosing a view, or resetKey changing,
 * flies back to that view's framing.
 */
function CameraRig({ preset, focus, animate, resetKey = 0 }: { preset: CameraPreset; focus: Focus; animate: boolean; resetKey?: number }) {
  const { camera, gl, invalidate, size } = useThree();
  const aspect = size.width / Math.max(1, size.height);
  const fx = focus.x, fz = focus.z, fw = focus.halfW, fd = focus.halfD, fh = focus.halfH;
  const controls = useMemo(() => {
    const c = new OrbitControls(camera, gl.domElement);
    c.enableDamping = animate;
    c.dampingFactor = 0.12;
    c.screenSpacePanning = true;
    c.minDistance = 1.5;
    c.maxDistance = 90;
    // Never under the ground.
    c.maxPolarAngle = Math.PI / 2 - 0.02;
    return c;
  }, [camera, gl, animate]);
  const flying = useRef(true);
  const first = useRef(true);
  useEffect(() => {
    const stop = () => (flying.current = false);
    const change = () => invalidate();
    controls.addEventListener("start", stop);
    controls.addEventListener("change", change);
    return () => {
      controls.removeEventListener("start", stop);
      controls.removeEventListener("change", change);
      controls.dispose();
    };
  }, [controls, invalidate]);
  useEffect(() => {
    flying.current = true;
    invalidate();
  }, [preset, fx, fz, fw, fd, fh, aspect, resetKey, invalidate]);
  const goal = useRef(new THREE.Vector3());
  const goalLook = useRef(new THREE.Vector3());
  useFrame((_, dt) => {
    if (flying.current) {
      const target = presetFor(preset, focus, aspect);
      goal.current.set(...target.pos);
      goalLook.current.set(...target.look);
      const k = animate && !first.current ? 1 - Math.pow(0.0015, dt) : 1;
      first.current = false;
      camera.position.lerp(goal.current, k);
      controls.target.lerp(goalLook.current, k);
      if (camera.position.distanceTo(goal.current) < 0.005 && controls.target.distanceTo(goalLook.current) < 0.005) flying.current = false;
      else if (!animate) invalidate();
    }
    controls.update();
  });
  return null;
}

export default function FarmWorld({
  strips,
  day,
  preset,
  animate,
  palette,
  onSelect,
  children,
  outlines,
  layout,
  resetKey,
  states: givenStates,
}: {
  /** Changing this flies the camera back to the chosen view after the reader moved it. */
  resetKey?: number;
  /** Field states worked out by the caller (multi-year strategy simulations) instead of from `day`. */
  states?: Array<FieldState | null>;
  strips: StripVM[];
  /**
   * Farm layout (field workspace): each strip is a field drawn at its real shape, size and
   * place on the farm, from farmLayout in ./polygonShape, in the same order as strips.
   */
  layout?: FarmLayout | null;
  /**
   * Card C3: the drawn outline for each strip, in the same order. A strip with no outline
   * (and the NC demo, which passes none) keeps the square field. Label the view with
   * SCENE_SHAPE_LABEL from ./polygonShape when outlines are shown.
   */
  outlines?: Array<FieldGeometry | null | undefined>;
  day: number;
  preset: CameraPreset;
  animate: boolean;
  palette: ScenePalette;
  onSelect: (k: CardKey) => void;
  children?: ReactNode;
}) {
  const states = givenStates ?? strips.map((s) => (s.plan ? fieldStateAt(s.plan, day) : null));
  const selectedIndex = Math.max(0, strips.findIndex((s) => s.selected));
  const solo = preset !== "overview";
  return (
    <Canvas
      className="world-canvas"
      shadows
      dpr={[1, 1.5]}
      camera={{ position: [0, 9, 14], fov: FOV, near: 0.1, far: 200 }}
      gl={{ antialias: true, alpha: true, preserveDrawingBuffer: true }}
      frameloop={animate ? "always" : "demand"}
      onPointerMissed={() => (document.body.style.cursor = "")}
    >
      <hemisphereLight args={["#ffffff", "#8a7a66", 1.05]} />
      <directionalLight
        position={[-9, 16, 9]}
        intensity={1.9}
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-bias={-0.0006}
        shadow-camera-left={-18}
        shadow-camera-right={18}
        shadow-camera-top={12}
        shadow-camera-bottom={-12}
        shadow-camera-near={1}
        shadow-camera-far={50}
      />
      {strips.map((s, i) => (
        <Field
          key={s.key}
          strip={s}
          state={states[i]!}
          x={X[i] ?? 0}
          index={i}
          palette={palette}
          animate={animate}
          hidden={solo && i !== selectedIndex}
          flat={preset === "cutaway"}
          onSelect={onSelect}
          outline={outlines?.[i]}
          placed={layout?.fields[i]}
        />
      ))}
      <CameraRig
        preset={preset}
        focus={
          layout
            ? { x: layout.fields[selectedIndex]?.x ?? 0, z: layout.fields[selectedIndex]?.z ?? 0, halfW: Math.max(layout.halfW, FIELD_W / 2) + 0.9, halfD: Math.max(layout.halfD, FIELD_D / 2) + 0.9, halfH: Math.max(3.6, (layout.halfD + 0.9) * Math.sin((33 * Math.PI) / 180) + 2.2) }
            : STRIP_FOCUS(X[selectedIndex]!)
        }
        animate={animate}
        resetKey={resetKey}
      />
      {children}
    </Canvas>
  );
}
