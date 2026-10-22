// The plants of the office: seven kinds, each a low polygon shape with vertex colors and one
// InstancedBatch (one draw call per kind). Pure white vertices take the instance color (the pot, or
// the flowers of the flowering pot); every other vertex keeps its own color, so one kind can wear
// many pots and flowers. Placement is deterministic: a slot's kind, size, turn and color come from
// the room id and the slot name, so the scene looks the same after a reload.

import * as THREE from 'three';
import { InstancedBatch } from './batch';
import { GeoBuilder } from './geometry';
import {
  CORRIDOR_W,
  DESK,
  LOBBY_D,
  LOBBY_W,
  WALL_T,
  type BuildingLayout,
  type RoomPlan,
} from './layout';
import { COLORS, hashString } from './palette';

export type PlantKind = 'snake' | 'bush' | 'succulent' | 'flowering' | 'fiddle' | 'palm' | 'trailing';

export const PLANT_KINDS: readonly PlantKind[] = ['snake', 'bush', 'succulent', 'flowering', 'fiddle', 'palm', 'trailing'];

/** A plant to put somewhere: x and z in the frame of whoever asks (room or world), y above the floor. */
export interface PlantSpot {
  kind: PlantKind;
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
  /** The instance color: the pot, or the flowers of a flowering pot. */
  color: string;
}

const WHITE = '#ffffff';
const SOIL = '#4d3d33';
const TABLE_TOP = 0.33;
const SHELF_Y = 0.95;

// Shared unit shapes, scaled and turned per part. Blades are flat pointed diamonds standing on y = 0.
const blob = new THREE.IcosahedronGeometry(1, 0);
const blade = new THREE.ConeGeometry(1, 1, 4, 1, true).translate(0, 0.5, 0);
const rod = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true).translate(0, 0.5, 0);
const disc = new THREE.CircleGeometry(1, 7).rotateX(-Math.PI / 2);

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const GOLDEN = 2.39996;

/** Adds a shape: its center at p, scaled by s, then turned (tilt about x, yaw about y, roll about z; roll first). */
function put(
  b: GeoBuilder,
  geometry: THREE.BufferGeometry,
  color: string,
  p: [number, number, number],
  s: [number, number, number],
  yaw = 0,
  tilt = 0,
  roll = 0,
): void {
  _e.set(tilt, yaw, roll, 'YXZ');
  _m.compose(_p.set(p[0], p[1], p[2]), _q.setFromEuler(_e), _s.set(s[0], s[1], s[2]));
  b.add(geometry, _m, color);
}

/** A pot standing on y = 0 with its soil; the pot takes the instance color. Returns the rim height. */
function addPot(b: GeoBuilder, rTop: number, rBottom: number, height: number, color = WHITE): number {
  put(b, new THREE.CylinderGeometry(rTop, rBottom, height, 7), color, [0, height / 2, 0], [1, 1, 1]);
  put(b, disc, SOIL, [0, height + 0.004, 0], [rTop * 0.92, 1, rTop * 0.92]);
  return height;
}

/** A tall snake plant: stiff pointed blades in two greens, a few pale ones. */
function snakeGeometry(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const top = addPot(b, 0.12, 0.095, 0.22);
  const heights = [0.78, 0.66, 0.7, 0.52, 0.6, 0.46, 0.5, 0.4, 0.34];
  const greens = ['#3c7a4d', '#4f9060', '#2f6c45'];
  heights.forEach((h, i) => {
    const a = i * GOLDEN;
    const r = 0.015 + 0.014 * (i % 3);
    const color = i % 4 === 3 ? '#a7c46a' : greens[i % 3];
    put(b, blade, color, [r * Math.sin(a), top, r * Math.cos(a)], [0.072, h, 0.017], a, 0.05 + 0.045 * (i % 4));
  });
  return b.build();
}

/** A round bush: a heap of faceted blobs in three greens. */
function bushGeometry(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const top = addPot(b, 0.16, 0.12, 0.2);
  put(b, blob, '#5c9c58', [0, top + 0.13, 0], [0.2, 0.17, 0.2], 0.4);
  put(b, blob, '#4a8a4c', [0.14, top + 0.1, 0.06], [0.13, 0.11, 0.13], 1.1);
  put(b, blob, '#6aa95d', [-0.13, top + 0.11, -0.05], [0.13, 0.12, 0.13], 2.0);
  put(b, blob, '#4a8a4c', [-0.03, top + 0.1, 0.14], [0.12, 0.1, 0.12], 0.7);
  put(b, blob, '#78b264', [0.02, top + 0.27, -0.01], [0.12, 0.1, 0.12], 0.2);
  return b.build();
}

/** A small succulent: three rings of thick pointed leaves in sage, opening like a rosette. */
function succulentGeometry(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const top = addPot(b, 0.075, 0.06, 0.1);
  const rings: [number, number, number, number, string][] = [
    // leaves, tilt from vertical, length, width, color
    [8, 1.0, 0.11, 0.042, '#86b09a'],
    [6, 0.6, 0.105, 0.04, '#9cc3a8'],
    [4, 0.2, 0.09, 0.036, '#b5d8bb'],
  ];
  rings.forEach(([n, tilt, length, width, color], ring) => {
    for (let i = 0; i < n; i += 1) {
      const a = (i / n) * Math.PI * 2 + ring * 0.5;
      put(b, blade, color, [0.012 * Math.sin(a), top, 0.012 * Math.cos(a)], [width, length, 0.024], a, tilt);
    }
  });
  return b.build();
}

/** A flowering pot: a green mound under a heap of flowers. The flowers take the instance color. */
function floweringGeometry(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const top = addPot(b, 0.13, 0.1, 0.18, '#f2eee6');
  put(b, blob, '#5d9a58', [0, top + 0.07, 0], [0.16, 0.1, 0.16], 0.3);
  put(b, blob, '#4a8a4c', [0.04, top + 0.12, -0.03], [0.11, 0.08, 0.11], 1.2);
  const flowers: [number, number, number, number][] = [
    [0, 0.2, 0, 0.058],
    [0.08, 0.15, 0.04, 0.052],
    [-0.07, 0.16, 0.05, 0.052],
    [0.03, 0.14, -0.08, 0.05],
    [-0.07, 0.13, -0.05, 0.05],
    [0.1, 0.12, -0.04, 0.046],
    [0.0, 0.12, 0.1, 0.046],
  ];
  flowers.forEach(([x, y, z, r], i) => put(b, blob, WHITE, [x, top + y, z], [r, r, r], i));
  return b.build();
}

/** A fiddle leaf tree: a thin trunk under a loose crown of broad leaves, in a large pot. */
function fiddleGeometry(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const top = addPot(b, 0.2, 0.15, 0.3);
  put(b, rod, '#7a5a44', [0, top, 0], [0.022, 0.66, 0.022]);
  const greens = ['#3f7d47', '#4f8f4f', '#356f42'];
  for (let i = 0; i < 9; i += 1) {
    const a = i * GOLDEN;
    const r = 0.1 + 0.025 * (i % 2);
    put(b, blob, greens[i % 3], [r * Math.sin(a), 0.64 + 0.05 * i, r * Math.cos(a)], [0.15, 0.035, 0.1], a + Math.PI / 2, 0, 0.45);
  }
  put(b, blob, '#4f8f4f', [0, 1.1, 0], [0.1, 0.05, 0.1], 0.5);
  return b.build();
}

/** A palm: a bare trunk under a crown of arching fronds, in a large pot. */
function palmGeometry(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const top = addPot(b, 0.22, 0.17, 0.3);
  put(b, rod, '#8a6a4f', [0, top, 0], [0.036, 0.78, 0.036]);
  const crown = top + 0.78;
  const greens = ['#4f9a5a', '#5fae62', '#438c52'];
  const fronds = 9;
  for (let i = 0; i < fronds; i += 1) {
    const a = i * GOLDEN;
    const lift = i < 3 ? 0.35 : 0.85 + 0.12 * (i % 3);
    const color = greens[i % 3];
    const reach = 0.42 - 0.04 * (i % 2);
    // The base of the frond rises and leans out; the tip carries on, bending down.
    put(b, blade, color, [0, crown, 0], [0.1, reach, 0.014], a, lift);
    const bx = Math.sin(a) * Math.sin(lift) * reach;
    const by = Math.cos(lift) * reach;
    const bz = Math.cos(a) * Math.sin(lift) * reach;
    put(b, blade, color, [bx, crown + by, bz], [0.085, reach * 0.8, 0.014], a, lift + 0.8);
  }
  return b.build();
}

/** A wall shelf with a trailing plant. The wall is the plane z = 0, the plant faces +z. */
function trailingGeometry(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  b.box(0.56, 0.03, 0.2, 0, -0.015, 0.1, COLORS.wood);
  b.box(0.03, 0.12, 0.16, -0.2, -0.09, 0.08, COLORS.woodDark);
  b.box(0.03, 0.12, 0.16, 0.2, -0.09, 0.08, COLORS.woodDark);
  const g = new GeoBuilder();
  const top = addPot(g, 0.085, 0.07, 0.13);
  put(g, blob, '#6aa95d', [0, top + 0.05, 0], [0.1, 0.07, 0.1], 0.6);
  put(g, blob, '#7cb867', [0.03, top + 0.1, 0.02], [0.07, 0.05, 0.07], 1.6);
  b.merge(g, -0.08, 0, 0.1);
  const vines: [number, number, number, string][] = [
    // x, z of the start (the pot's rim), length, color
    [-0.15, 0.17, 0.34, '#7cb867'],
    [-0.1, 0.19, 0.46, '#6aa95d'],
    [-0.04, 0.18, 0.28, '#8cc474'],
    [0.0, 0.16, 0.4, '#6aa95d'],
    [-0.19, 0.12, 0.22, '#8cc474'],
    [-0.01, 0.12, 0.2, '#7cb867'],
  ];
  vines.forEach(([x, z, length, color], i) => {
    put(b, blade, color, [x, 0.1, z], [0.032, length, 0.012], i * 1.3, Math.PI - 0.06);
    put(b, blob, color, [x, 0.1 - length, z], [0.034, 0.034, 0.034], i);
  });
  return b.build();
}

/** Marks the white vertices (the ones that take the instance color) in a `tintMask` attribute. */
function withTintMask(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const color = geometry.getAttribute('color');
  const mask = new Float32Array(color.count);
  for (let i = 0; i < color.count; i += 1) {
    mask[i] = color.getX(i) > 0.999 && color.getY(i) > 0.999 && color.getZ(i) > 0.999 ? 1 : 0;
  }
  geometry.setAttribute('tintMask', new THREE.Float32BufferAttribute(mask, 1));
  return geometry;
}

/** Vertex colors, and the instance color on the vertices marked in `tintMask` only. */
function plantMaterial(): THREE.MeshLambertMaterial {
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  material.customProgramCacheKey = () => 'office-plants';
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <color_pars_vertex>', '#include <color_pars_vertex>\nattribute float tintMask;')
      .replace(
        '#include <color_vertex>',
        `#include <color_vertex>
        #ifdef USE_INSTANCING_COLOR
          vColor.xyz = color.xyz * mix( vec3( 1.0 ), instanceColor.xyz, tintMask );
        #endif`,
      );
  };
  return material;
}

export interface PlantBatches {
  readonly list: InstancedBatch[];
  readonly material: THREE.Material;
  of(kind: PlantKind): InstancedBatch;
}

/** One batch per kind, all in the scene. Dispose the batches and their geometry as the other batches are. */
export function createPlantBatches(parent: THREE.Object3D): PlantBatches {
  const material = plantMaterial();
  const geometries: Record<PlantKind, () => THREE.BufferGeometry> = {
    snake: snakeGeometry,
    bush: bushGeometry,
    succulent: succulentGeometry,
    flowering: floweringGeometry,
    fiddle: fiddleGeometry,
    palm: palmGeometry,
    trailing: trailingGeometry,
  };
  const byKind = new Map<PlantKind, InstancedBatch>();
  for (const kind of PLANT_KINDS) {
    byKind.set(kind, new InstancedBatch(parent, withTintMask(geometries[kind]()), material, 16, { castShadow: true }));
  }
  return {
    list: [...byKind.values()],
    material,
    of: (kind) => byKind.get(kind)!,
  };
}

// Placement ------------------------------------------------------------------------------------

const POTS = ['#d79a78', '#d79a78', '#d79a78', '#f3efe8', '#f3efe8', '#f3efe8', '#3f434e', '#3f434e', '#aebfa2', '#aebfa2', '#ecbfb2'];
const FLOWERS = ['#f1a1b9', '#f28f78', '#f6d46a', '#c7a9ec', '#fbf7ee', '#f4a6a0'];

const SCALES: Record<PlantKind, [number, number]> = {
  snake: [0.8, 1.25],
  bush: [0.8, 1.3],
  succulent: [0.9, 1.4],
  flowering: [0.85, 1.2],
  fiddle: [0.8, 1.2],
  palm: [0.8, 1.15],
  trailing: [0.9, 1.2],
};

const TALL: PlantKind[] = ['palm', 'fiddle'];
const MID: PlantKind[] = ['bush', 'fiddle', 'snake', 'flowering'];
const EDGE: PlantKind[] = ['flowering', 'bush', 'snake', 'succulent'];
const SMALL: PlantKind[] = ['succulent', 'flowering'];

/** A small seeded generator (mulberry32), so a slot always draws the same numbers. */
function rng(seed: string): () => number {
  let a = hashString(seed);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SpotOptions {
  y?: number;
  yaw?: number;
  scale?: [number, number];
}

/** A slot: picks the kind from the pool, then size, turn and color, all from the seed and the slot name. */
function spot(seed: string, slot: string, pool: readonly PlantKind[], x: number, z: number, options: SpotOptions = {}): PlantSpot {
  const r = rng(`${seed}|${slot}`);
  const kind = pool[Math.floor(r() * pool.length)];
  const [lo, hi] = options.scale ?? SCALES[kind];
  const scale = lo + (hi - lo) * r();
  const yaw = options.yaw ?? r() * Math.PI * 2;
  const palette = kind === 'flowering' ? FLOWERS : POTS;
  return { kind, x, y: options.y ?? 0, z, yaw, scale, color: palette[Math.floor(r() * palette.length)] };
}

/**
 * The plants of one room, in the room's frame. Corners (the tall ones where the walls are tall),
 * the pod ends, beside the sofa and on its table, a shelf on the west wall, and a small succulent
 * on some desks. Walkways, the door and the fronts of the desks stay clear.
 */
export function roomPlants(seed: string, plan: RoomPlan, side: 1 | -1): PlantSpot[] {
  const { w, d, cls, pods, seats, table, frontZ } = plan;
  const out: PlantSpot[] = [];
  // The corridor wall is tall for south rooms (side 1), the far wall for north rooms.
  const tall = side === 1 ? 0 : 2;
  plan.plants.forEach((p, i) => {
    if (i === tall) out.push(spot(seed, `corner${i}`, TALL, -w / 2 + 0.52, i === 0 ? 0.52 : d - 0.52));
    else out.push(spot(seed, `corner${i}`, i === 1 || i === 3 ? EDGE : MID, p.x, p.z));
  });
  pods.forEach((pod, i) => out.push(spot(seed, `pod${i}`, ['snake', 'bush', 'flowering'], pod.x, frontZ + pod.n * DESK.w + 0.42)));
  out.push(spot(seed, 'table', SMALL, table.x, table.z, { y: TABLE_TOP, scale: [0.7, 0.85] }));
  out.push(spot(seed, 'sofaEast', EDGE, w / 2 - 0.45, d - 1.5, { scale: [0.8, 1.05] }));
  if (cls === 'small') out.push(spot(seed, 'eastMid', MID, w / 2 - 0.55, frontZ + 1.2, { scale: [0.8, 1.1] }));
  else out.push(spot(seed, 'sofaWest', EDGE, w / 2 - 2.55, d - 0.42, { scale: [0.8, 1.05] }));
  out.push(spot(seed, 'shelf', ['trailing'], -w / 2 + WALL_T - 0.01, d - 1.5, { y: SHELF_Y, yaw: Math.PI / 2 }));
  seats.forEach((seat, i) => {
    const r = rng(`${seed}|desk${i}`);
    if (r() > 0.3) return;
    // On a back corner of the desk, beside the monitor, never in front of the sitter.
    const lx = r() < 0.5 ? -0.37 : 0.37;
    const { x, z, yaw } = seat.desk;
    out.push(
      spot(seed, `desk${i}`, ['succulent'], x + lx * Math.cos(yaw), z - lx * Math.sin(yaw), { y: DESK.h, scale: [0.7, 0.95] }),
    );
  });
  return out;
}

/** The lobby's plants, in world coordinates: big ones by the entrance and the reception. */
export function lobbyPlants(): PlantSpot[] {
  const LW = LOBBY_W;
  const LD = LOBBY_D;
  const big: [number, number] = [1.15, 1.35];
  return [
    spot('lobby', 'nw', ['palm'], -LW + 0.6, -LD / 2 + 0.6, { scale: big }),
    spot('lobby', 'ne', ['fiddle'], -0.55, -LD / 2 + 0.55, { scale: [1.0, 1.2] }),
    spot('lobby', 'sw', ['bush', 'flowering'], -LW + 0.5, LD / 2 - 0.5),
    spot('lobby', 'se', ['flowering', 'bush'], -0.5, LD / 2 - 0.5),
    spot('lobby', 'entranceWest', ['fiddle'], -LW / 2 - 1.3, LD / 2 - 0.55, { scale: big }),
    spot('lobby', 'entranceEast', ['palm'], -LW / 2 + 1.3, LD / 2 - 0.55, { scale: big }),
    spot('lobby', 'receptionWest', ['snake', 'bush'], -LW / 2 - 1.75, -LD / 2 + 1.75, { scale: big }),
    spot('lobby', 'receptionEast', ['bush', 'flowering'], -LW / 2 + 1.75, -LD / 2 + 1.75, { scale: [1.05, 1.3] }),
    spot('lobby', 'sofa', SMALL, -LW + 0.45, -0.85, { scale: [0.9, 1.2] }),
    spot('lobby', 'sofaTable', SMALL, -LW + 1.5, 0.5, { y: TABLE_TOP, scale: [0.7, 0.85] }),
    spot('lobby', 'shelf', ['trailing'], -LW + WALL_T - 0.01, 0.5, { y: SHELF_Y, yaw: Math.PI / 2, scale: [1.0, 1.1] }),
  ];
}

/** The corridor's plants, in world coordinates: the dead end, and the stretches of low wall between rooms. */
export function corridorPlants(layout: BuildingLayout): PlantSpot[] {
  const CW = CORRIDOR_W;
  const end = layout.corridorEnd;
  const out: PlantSpot[] = [
    spot('corridor', 'endNorth', ['palm', 'fiddle'], end - 0.55, -0.62, { scale: [0.95, 1.15] }),
    spot('corridor', 'endSouth', EDGE, end - 0.5, 0.62, { scale: [0.9, 1.2] }),
  ];
  for (const side of [-1, 1] as const) {
    const covered = [...layout.rooms.values()]
      .filter((p) => p.side === side)
      .map((p) => [p.x - p.plan.w / 2, p.x + p.plan.w / 2] as const)
      .sort((a, b) => a[0] - b[0]);
    let x = 0;
    for (const [a, c] of [...covered, [end - 1.3, end] as const]) {
      const length = a - x;
      if (length >= 1.2) {
        const count = Math.max(1, Math.round(length / 3));
        for (let k = 0; k < count; k += 1) {
          const px = x + (length * (k + 0.5)) / count;
          out.push(spot('corridor', `run${side}:${Math.round(px * 10)}`, EDGE, px, side * (CW / 2 - 0.32), { scale: [0.8, 1.1] }));
        }
      }
      x = Math.max(x, c);
    }
  }
  return out;
}

/** Allocates a batch slot for the spot and sets its color. Returns the batch and the slot. */
export function allocPlant(plants: PlantBatches, spot: PlantSpot, color: THREE.Color): { batch: InstancedBatch; index: number } {
  const batch = plants.of(spot.kind);
  const index = batch.alloc();
  batch.setColor(index, color.set(spot.color));
  return { batch, index };
}
