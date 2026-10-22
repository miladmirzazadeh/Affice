// One InstancedMesh per repeated shape for the whole building: every desk is one instance of the
// desk mesh, every head one instance of the head mesh. Slots are reused; a free slot is scaled to
// zero, and the mesh grows by doubling when it runs out.

import * as THREE from 'three';

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const WHITE = new THREE.Color('#ffffff');

export interface BatchOptions {
  castShadow?: boolean;
  receiveShadow?: boolean;
}

export class InstancedBatch {
  mesh: THREE.InstancedMesh;
  private free: number[] = [];
  private top = 0;
  private dirtyMatrix = false;
  private dirtyColor = false;

  constructor(
    private readonly parent: THREE.Object3D,
    readonly geometry: THREE.BufferGeometry,
    readonly material: THREE.Material,
    capacity: number,
    private readonly options: BatchOptions = {},
  ) {
    this.mesh = this.create(capacity);
    parent.add(this.mesh);
  }

  private create(capacity: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(this.geometry, this.material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = this.options.castShadow ?? false;
    mesh.receiveShadow = this.options.receiveShadow ?? false;
    for (let i = 0; i < capacity; i += 1) mesh.setColorAt(i, WHITE);
    return mesh;
  }

  alloc(): number {
    const reused = this.free.pop();
    if (reused !== undefined) return reused;
    if (this.top >= this.mesh.instanceMatrix.count) this.grow();
    const index = this.top;
    this.top += 1;
    this.mesh.count = this.top;
    return index;
  }

  release(index: number): void {
    this.mesh.setMatrixAt(index, ZERO);
    this.dirtyMatrix = true;
    this.free.push(index);
  }

  setMatrix(index: number, matrix: THREE.Matrix4): void {
    this.mesh.setMatrixAt(index, matrix);
    this.dirtyMatrix = true;
  }

  setColor(index: number, color: THREE.Color): void {
    this.mesh.setColorAt(index, color);
    this.dirtyColor = true;
  }

  /** Uploads what changed since the last frame. Returns true when anything did. */
  commit(): boolean {
    const changed = this.dirtyMatrix || this.dirtyColor;
    if (this.dirtyMatrix) this.mesh.instanceMatrix.needsUpdate = true;
    if (this.dirtyColor && this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.dirtyMatrix = false;
    this.dirtyColor = false;
    return changed;
  }

  private grow(): void {
    const old = this.mesh;
    const next = this.create(old.instanceMatrix.count * 2);
    (next.instanceMatrix.array as Float32Array).set(old.instanceMatrix.array as Float32Array);
    if (old.instanceColor && next.instanceColor) {
      (next.instanceColor.array as Float32Array).set(old.instanceColor.array as Float32Array);
    }
    next.count = old.count;
    this.parent.remove(old);
    old.dispose();
    this.parent.add(next);
    this.mesh = next;
    this.dirtyMatrix = true;
    this.dirtyColor = true;
  }

  dispose(): void {
    this.parent.remove(this.mesh);
    this.mesh.dispose();
  }
}
