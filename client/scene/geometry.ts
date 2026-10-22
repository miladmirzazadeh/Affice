// Procedural geometry: boxes, cylinders, spheres and capsules merged into one buffer with a color
// per vertex, so a whole prop (or a whole room shell) is one draw call with flat colors.

import * as THREE from 'three';
import { COLORS } from './palette';
import { DESK } from './layout';

const unitBox = new THREE.BoxGeometry(1, 1, 1);
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _n3 = new THREE.Matrix3();
const _v = new THREE.Vector3();
const _c = new THREE.Color();
const _up = new THREE.Vector3(0, 1, 0);

export class GeoBuilder {
  private positions: number[] = [];
  private normals: number[] = [];
  private colors: number[] = [];
  private indices: number[] = [];

  add(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4, color: THREE.ColorRepresentation): this {
    const pos = geometry.getAttribute('position');
    const nor = geometry.getAttribute('normal');
    _n3.getNormalMatrix(matrix);
    _c.set(color);
    const base = this.positions.length / 3;
    for (let i = 0; i < pos.count; i += 1) {
      _v.fromBufferAttribute(pos, i).applyMatrix4(matrix);
      this.positions.push(_v.x, _v.y, _v.z);
      _v.fromBufferAttribute(nor, i).applyMatrix3(_n3).normalize();
      this.normals.push(_v.x, _v.y, _v.z);
      this.colors.push(_c.r, _c.g, _c.b);
    }
    const index = geometry.getIndex();
    if (index) for (let i = 0; i < index.count; i += 1) this.indices.push(base + index.getX(i));
    else for (let i = 0; i < pos.count; i += 1) this.indices.push(base + i);
    return this;
  }

  /** An axis-aligned box (turned by yaw around its center), given by size and center. */
  box(w: number, h: number, d: number, x: number, y: number, z: number, color: THREE.ColorRepresentation, yaw = 0): this {
    _m.compose(_p.set(x, y, z), _q.setFromAxisAngle(_up, yaw), _s.set(w, h, d));
    return this.add(unitBox, _m, color);
  }

  /** A box between two corners on the floor plan, from y0 to y1. */
  slab(x0: number, z0: number, x1: number, z1: number, y0: number, y1: number, color: THREE.ColorRepresentation): this {
    const w = Math.abs(x1 - x0);
    const d = Math.abs(z1 - z0);
    if (w < 1e-4 || d < 1e-4) return this;
    return this.box(w, y1 - y0, d, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, color);
  }

  shape(geometry: THREE.BufferGeometry, x: number, y: number, z: number, color: THREE.ColorRepresentation, scale = 1, yaw = 0): this {
    _m.compose(_p.set(x, y, z), _q.setFromAxisAngle(_up, yaw), _s.set(scale, scale, scale));
    return this.add(geometry, _m, color);
  }

  /** Appends another builder's output, moved and turned. */
  merge(other: GeoBuilder, x: number, y: number, z: number, yaw = 0): this {
    _m.compose(_p.set(x, y, z), _q.setFromAxisAngle(_up, yaw), _s.set(1, 1, 1));
    const n3 = new THREE.Matrix3().getNormalMatrix(_m);
    const base = this.positions.length / 3;
    for (let i = 0; i < other.positions.length; i += 3) {
      _v.set(other.positions[i], other.positions[i + 1], other.positions[i + 2]).applyMatrix4(_m);
      this.positions.push(_v.x, _v.y, _v.z);
      _v.set(other.normals[i], other.normals[i + 1], other.normals[i + 2]).applyMatrix3(n3).normalize();
      this.normals.push(_v.x, _v.y, _v.z);
      this.colors.push(other.colors[i], other.colors[i + 1], other.colors[i + 2]);
    }
    for (const index of other.indices) this.indices.push(base + index);
    return this;
  }

  build(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    geometry.setIndex(this.indices);
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
    return geometry;
  }
}

// Shared primitive shapes (low polygon counts keep the triangle budget).
const bush = new THREE.IcosahedronGeometry(0.075, 0);

/** A desk: the sitter is on +z, the width runs along x. */
export function deskGeometry(): THREE.BufferGeometry {
  const top = DESK.h;
  return new GeoBuilder()
    .box(DESK.w, 0.04, DESK.d, 0, top - 0.02, 0, COLORS.wood)
    .box(0.04, top - 0.04, DESK.d - 0.06, -DESK.w / 2 + 0.04, (top - 0.04) / 2, 0, COLORS.woodDark)
    .box(0.04, top - 0.04, DESK.d - 0.06, DESK.w / 2 - 0.04, (top - 0.04) / 2, 0, COLORS.woodDark)
    .build();
}

/** A monitor standing on a desk, screen facing +z. The lit screen is a separate mesh. */
export function monitorGeometry(): THREE.BufferGeometry {
  const top = DESK.h;
  return new GeoBuilder()
    .box(0.46, 0.28, 0.03, 0, top + 0.26, 0, COLORS.dark)
    .box(0.04, 0.12, 0.03, 0, top + 0.06, -0.03, COLORS.dark)
    .box(0.17, 0.014, 0.12, 0, top + 0.007, -0.02, COLORS.dark)
    .build();
}

export function screenGeometry(): THREE.BufferGeometry {
  const plane = new THREE.PlaneGeometry(0.42, 0.24);
  plane.translate(0, DESK.h + 0.26, 0.0155);
  plane.deleteAttribute('uv');
  return plane;
}

/** An office chair, the sitter facing +z. White parts take the instance color. */
export function chairGeometry(): THREE.BufferGeometry {
  return new GeoBuilder()
    .box(0.4, 0.05, 0.4, 0, 0.255, 0, '#ffffff')
    .box(0.4, 0.32, 0.05, 0, 0.45, -0.2, '#ffffff')
    .box(0.05, 0.2, 0.05, 0, 0.13, 0, '#3a3d46')
    .box(0.42, 0.03, 0.06, 0, 0.03, 0, '#3a3d46')
    .box(0.06, 0.03, 0.42, 0, 0.03, 0, '#3a3d46')
    .build();
}

/** The planter strip along the middle of a pod, as part of a room shell. */
export function addPlanter(builder: GeoBuilder, x: number, z0: number, length: number): void {
  const y = DESK.h;
  builder.box(0.14, 0.08, length - 0.1, x, y + 0.04, z0 + length / 2, COLORS.woodDark);
  const count = Math.max(2, Math.round(length / 0.26));
  for (let i = 0; i < count; i += 1) {
    const z = z0 + 0.12 + (i * (length - 0.24)) / (count - 1);
    builder.shape(bush, x, y + 0.13, z, i % 2 === 0 ? COLORS.leaf : COLORS.leafDeep, i % 3 === 0 ? 1.15 : 1);
  }
}

/** A sofa facing +z. */
export function addSofa(builder: GeoBuilder, x: number, z: number, yaw: number, y = 0): void {
  const sofa = new GeoBuilder()
    .box(1.5, 0.2, 0.62, 0, 0.14, 0, COLORS.sofa)
    .box(1.26, 0.09, 0.48, 0, 0.285, 0.05, COLORS.cushion)
    .box(1.5, 0.36, 0.16, 0, 0.36, -0.23, COLORS.sofa)
    .box(0.13, 0.3, 0.62, -0.69, 0.25, 0, COLORS.sofa)
    .box(0.13, 0.3, 0.62, 0.69, 0.25, 0, COLORS.sofa);
  builder.merge(sofa, x, y, z, yaw);
}

const tableTop = new THREE.CylinderGeometry(0.3, 0.3, 0.04, 14);
const tableLeg = new THREE.CylinderGeometry(0.035, 0.035, 0.28, 6);
const tableFoot = new THREE.CylinderGeometry(0.16, 0.16, 0.02, 10);

export function addTable(builder: GeoBuilder, x: number, z: number, y = 0): void {
  builder.shape(tableTop, x, y + 0.31, z, COLORS.wood);
  builder.shape(tableLeg, x, y + 0.15, z, COLORS.woodDark);
  builder.shape(tableFoot, x, y + 0.01, z, COLORS.woodDark);
}

/** The head desk: wider, with a modesty panel, the sitter on +z. Monitors are added by the caller. */
export function addHeadDesk(builder: GeoBuilder, x: number, z: number, yaw: number, y = 0): void {
  const top = DESK.h;
  const desk = new GeoBuilder()
    .box(1.6, 0.045, 0.74, 0, top - 0.02, 0, COLORS.wood)
    .box(0.05, top - 0.04, 0.68, -0.76, (top - 0.04) / 2, 0, COLORS.woodDark)
    .box(0.05, top - 0.04, 0.68, 0.76, (top - 0.04) / 2, 0, COLORS.woodDark)
    .box(1.48, 0.34, 0.03, 0, 0.3, -0.33, COLORS.woodDark);
  builder.merge(desk, x, y, z, yaw);
}

export function addMonitor(builder: GeoBuilder, x: number, z: number, yaw: number, y = 0): void {
  const top = DESK.h;
  const monitor = new GeoBuilder()
    .box(0.46, 0.28, 0.03, 0, top + 0.26, 0, COLORS.dark)
    .box(0.04, 0.12, 0.03, 0, top + 0.06, -0.03, COLORS.dark)
    .box(0.17, 0.014, 0.12, 0, top + 0.007, -0.02, COLORS.dark);
  builder.merge(monitor, x, y, z, yaw);
}

// Avatar parts. Each part is one instanced mesh for every avatar; white vertices take the
// instance color (skin, hair, shirt, pants), dark vertices stay dark (the eyes).

/** The head with its eyes, centered on the head's center, face toward +z. */
export function headGeometry(): THREE.BufferGeometry {
  const head = new THREE.SphereGeometry(0.22, 14, 10);
  const eye = new THREE.SphereGeometry(0.026, 6, 4);
  return new GeoBuilder()
    .shape(head, 0, 0, 0, '#ffffff')
    .shape(eye, -0.075, 0.0, 0.205, COLORS.eye)
    .shape(eye, 0.075, 0.0, 0.205, COLORS.eye)
    .build();
}

/** The hair: a cap over the top and the back of the head. */
export function hairGeometry(): THREE.BufferGeometry {
  const cap = new THREE.SphereGeometry(0.235, 14, 6, 0, Math.PI * 2, 0, Math.PI * 0.5);
  _m.makeRotationX(-0.42);
  _m.setPosition(0, 0.015, -0.01);
  return new GeoBuilder().add(cap, _m, '#ffffff').build();
}

export function torsoGeometry(): THREE.BufferGeometry {
  const torso = new THREE.CapsuleGeometry(0.15, 0.12, 3, 10);
  _m.makeScale(1, 1, 0.8);
  return new GeoBuilder().add(torso, _m, '#ffffff').build();
}

/** An arm hanging down from its shoulder pivot at the origin. */
export function armGeometry(): THREE.BufferGeometry {
  const arm = new THREE.CapsuleGeometry(0.05, 0.13, 2, 6);
  _m.makeTranslation(0, -0.115, 0);
  return new GeoBuilder().add(arm, _m, '#ffffff').build();
}

/** A hand at the end of an arm, in the arm's frame. */
export function handGeometry(): THREE.BufferGeometry {
  const hand = new THREE.IcosahedronGeometry(0.055, 0);
  _m.makeTranslation(0, -0.25, 0);
  return new GeoBuilder().add(hand, _m, '#ffffff').build();
}

/** A leg hanging down from its hip pivot at the origin. */
export function legGeometry(): THREE.BufferGeometry {
  const leg = new THREE.CapsuleGeometry(0.062, 0.16, 2, 6);
  _m.makeTranslation(0, -0.142, 0);
  return new GeoBuilder().add(leg, _m, '#ffffff').build();
}

/** A flat ring on the floor around an avatar's feet. */
export function ringGeometry(inner = 0.34, outer = 0.47): THREE.BufferGeometry {
  const ring = new THREE.RingGeometry(inner, outer, 36);
  ring.rotateX(-Math.PI / 2);
  ring.deleteAttribute('uv');
  return ring;
}
