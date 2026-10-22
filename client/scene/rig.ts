// The isometric camera: orthographic, yaw 45 degrees, pitch about 35. It keeps a target on the
// ground and a view half height, and eases both toward their goals.

import * as THREE from 'three';
import type { Bounds } from './layout';

const YAW = Math.PI / 4;
const PITCH = Math.atan(1 / Math.SQRT2); // 35.26 degrees, the true isometric angle
const DISTANCE = 120;
const EASE = 7.5; // per second; higher settles faster

/** Pixels at the edges of the view covered by the chrome, so framing centers in what is left. */
export interface Inset {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export const NO_INSET: Inset = { left: 0, top: 0, right: 0, bottom: 0 };

export class IsoRig {
  readonly camera: THREE.OrthographicCamera;
  /** Unit vectors of the view: screen right, screen up, and toward the camera. */
  readonly right: THREE.Vector3;
  readonly up: THREE.Vector3;
  readonly back: THREE.Vector3;

  private readonly target = new THREE.Vector3();
  private readonly goal = new THREE.Vector3();
  private half = 12;
  private goalHalf = 12;
  private aspect = 1;
  private width = 1;
  private height = 1;
  private limits: Bounds = { minX: -20, maxX: 20, minZ: -20, maxZ: 20 };
  minHalf = 1.6;
  maxHalf = 40;

  constructor() {
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, DISTANCE * 3);
    this.back = new THREE.Vector3(Math.sin(YAW) * Math.cos(PITCH), Math.sin(PITCH), Math.cos(YAW) * Math.cos(PITCH));
    this.right = new THREE.Vector3(this.back.z, 0, -this.back.x).normalize();
    this.up = new THREE.Vector3().crossVectors(this.back, this.right).normalize();
    this.apply();
  }

  get halfHeight(): number {
    return this.half;
  }

  setViewport(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.aspect = this.width / this.height;
    this.apply();
  }

  /** The area the target may move in (the building plus a margin). */
  setLimits(bounds: Bounds, margin: number): void {
    this.limits = {
      minX: bounds.minX - margin,
      maxX: bounds.maxX + margin,
      minZ: bounds.minZ - margin,
      maxZ: bounds.maxZ + margin,
    };
    this.clamp(this.goal);
  }

  setGoal(target: THREE.Vector3, half: number, animate: boolean): void {
    this.goal.set(target.x, 0, target.z);
    this.goalHalf = THREE.MathUtils.clamp(half, this.minHalf, this.maxHalf);
    this.clamp(this.goal);
    if (!animate) {
      this.target.copy(this.goal);
      this.half = this.goalHalf;
    }
    this.apply();
  }

  /** Jumps to the goal (reduced motion). */
  snap(): void {
    this.target.copy(this.goal);
    this.half = this.goalHalf;
    this.apply();
  }

  /** Moves toward the goal. Returns true while still moving. */
  update(dt: number): boolean {
    const dx = this.goal.x - this.target.x;
    const dz = this.goal.z - this.target.z;
    const dh = this.goalHalf - this.half;
    const eps = 0.0008 * this.half;
    if (Math.abs(dx) < eps && Math.abs(dz) < eps && Math.abs(dh) < eps) {
      if (dx !== 0 || dz !== 0 || dh !== 0) {
        this.target.copy(this.goal);
        this.half = this.goalHalf;
        this.apply();
      }
      return false;
    }
    const k = 1 - Math.exp(-dt * EASE);
    this.target.x += dx * k;
    this.target.z += dz * k;
    this.half += dh * k;
    this.apply();
    return true;
  }

  /** Drags the view by a number of pixels; immediate, no easing. */
  pan(dxPx: number, dyPx: number, heightPx: number): void {
    const unit = (2 * this.half) / Math.max(1, heightPx);
    const shift = this.groundShift(-dxPx * unit, dyPx * unit);
    this.target.add(shift);
    this.goal.add(shift);
    this.clamp(this.target);
    this.clamp(this.goal);
    this.apply();
  }

  /** Zooms by a factor, keeping the ground point under the pointer (in NDC) where it is. */
  zoomAt(factor: number, ndcX: number, ndcY: number): void {
    const before = this.goalHalf;
    const after = THREE.MathUtils.clamp(before * factor, this.minHalf, this.maxHalf);
    const shift = this.groundShift(ndcX * this.aspect * (before - after), ndcY * (before - after));
    this.goal.add(shift);
    this.goalHalf = after;
    this.clamp(this.goal);
  }

  /** The target and half height that frame a set of points inside the uncovered part of the view,
   *  with a margin (1.1 is ten percent). */
  frame(points: THREE.Vector3[], margin: number, inset: Inset = NO_INSET): { target: THREE.Vector3; half: number } {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of points) {
      const sx = p.dot(this.right);
      const sy = p.dot(this.up);
      minX = Math.min(minX, sx);
      maxX = Math.max(maxX, sx);
      minY = Math.min(minY, sy);
      maxY = Math.max(maxY, sy);
    }
    const free = this.free(inset);
    const half = Math.max(((maxY - minY) * this.height) / (2 * free.height), ((maxX - minX) * this.height) / (2 * free.width)) * margin;
    return this.centerOn((minX + maxX) / 2, (minY + maxY) / 2, half, inset);
  }

  /** The goal that shows a world point at the middle of the uncovered part of the view. */
  frameAt(point: THREE.Vector3, half: number, inset: Inset = NO_INSET): { target: THREE.Vector3; half: number } {
    return this.centerOn(point.dot(this.right), point.dot(this.up), half, inset);
  }

  private free(inset: Inset): { width: number; height: number } {
    return {
      width: Math.max(80, this.width - inset.left - inset.right),
      height: Math.max(80, this.height - inset.top - inset.bottom),
    };
  }

  private centerOn(sx: number, sy: number, half: number, inset: Inset): { target: THREE.Vector3; half: number } {
    const clamped = Math.max(half, this.minHalf);
    const unit = (2 * clamped) / this.height; // view units per pixel
    const dx = (inset.left - inset.right) / 2;
    const dy = (inset.top - inset.bottom) / 2;
    return { target: this.groundPointAt(sx - dx * unit, sy + dy * unit), half: clamped };
  }

  /** The ground point whose view coordinates are (sx, sy). */
  groundPointAt(sx: number, sy: number): THREE.Vector3 {
    return this.groundShift(sx, sy);
  }

  get goalHalfHeight(): number {
    return this.goalHalf;
  }

  /** The ground (y = 0) vector that moves the view by (sx, sy) view units. */
  private groundShift(sx: number, sy: number): THREE.Vector3 {
    const r = this.right;
    const u = this.up;
    const det = r.x * u.z - r.z * u.x;
    return new THREE.Vector3((sx * u.z - r.z * sy) / det, 0, (r.x * sy - sx * u.x) / det);
  }

  private clamp(v: THREE.Vector3): void {
    v.x = THREE.MathUtils.clamp(v.x, this.limits.minX, this.limits.maxX);
    v.z = THREE.MathUtils.clamp(v.z, this.limits.minZ, this.limits.maxZ);
  }

  private apply(): void {
    const c = this.camera;
    c.left = -this.half * this.aspect;
    c.right = this.half * this.aspect;
    c.top = this.half;
    c.bottom = -this.half;
    c.position.copy(this.target).addScaledVector(this.back, DISTANCE);
    c.lookAt(this.target);
    c.updateProjectionMatrix();
    c.updateMatrixWorld();
  }
}
