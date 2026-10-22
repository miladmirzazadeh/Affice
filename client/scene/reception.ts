// The reception: the lobby's counter (built by the Shell) with the general manager behind it. A
// department of kind `lobby` has no room; this is its workplace. It plays the part of a Room for
// its avatars (a chair, a seat behind the counter, spots in front of it for anyone else) and adds
// a name plate on the counter that selects the department, and a hit test for the counter.
//
// Its plan is in world coordinates: the placement is the identity (side 1, origin 0).

import * as THREE from 'three';
import { CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';
import type { Department } from '../../shared/types';
import type { Workplace } from './avatar';
import type { Kit } from './building';
import { FLOOR_Y, RECEPTION, WALL_TALL, planReception, type Pt, type RoomPlan, type SeatRef } from './layout';
import { DEPARTMENT_HEX } from './palette';

const CSS_SCALE = 0.01;
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _up = new THREE.Vector3(0, 1, 0);
const _c = new THREE.Color();

export class Reception implements Workplace {
  readonly id: string;
  dept: Department;
  readonly plan: RoomPlan = planReception();
  readonly walksOut = false;
  readonly floorY = FLOOR_Y;

  private readonly group = new THREE.Group();
  private readonly plate: CSS3DObject;
  private readonly plateDot: HTMLSpanElement;
  private readonly plateText: HTMLSpanElement;
  private readonly chair: number;
  private readonly counterBox: THREE.Box3;
  private owner: string | null = null;
  private standOwner: (string | null)[] = [];

  constructor(
    private readonly kit: Kit,
    dept: Department,
  ) {
    this.id = dept.id;
    this.dept = dept;
    this.group.name = `reception:${dept.id}`;
    kit.root.add(this.group);

    const el = document.createElement('div');
    el.className = 'office-plate';
    el.dataset.officeDept = dept.id;
    this.plateDot = document.createElement('span');
    this.plateDot.className = 'opl-dot';
    this.plateText = document.createElement('span');
    el.append(this.plateDot, this.plateText);
    this.plate = new CSS3DObject(el);
    this.plate.scale.setScalar(CSS_SCALE);
    this.plate.position.set(RECEPTION.x, FLOOR_Y + RECEPTION.h / 2, RECEPTION.z + RECEPTION.d / 2 + 0.004);
    this.group.add(this.plate);

    const seat = this.plan.head.seat;
    this.chair = kit.chairs.alloc();
    _m.compose(_p.set(seat.x, FLOOR_Y, seat.z), _q.setFromAxisAngle(_up, seat.yaw), _s);
    kit.chairs.setMatrix(this.chair, _m);
    kit.chairs.setColor(this.chair, _c.set('#4a4d57'));

    const halfW = RECEPTION.w / 2 + 0.07;
    const halfD = RECEPTION.d / 2 + 0.05;
    this.counterBox = new THREE.Box3(
      new THREE.Vector3(RECEPTION.x - halfW, FLOOR_Y, RECEPTION.z - halfD),
      new THREE.Vector3(RECEPTION.x + halfW, FLOOR_Y + RECEPTION.h + 0.04, RECEPTION.z + halfD),
    );
    this.applyName();
  }

  update(dept: Department): void {
    this.dept = dept;
    this.applyName();
  }

  toWorld(local: Pt): Pt {
    return local;
  }

  yawToWorld(yaw: number): number {
    return yaw;
  }

  setScreen(): void {}

  claim(agentId: string, kind: 'manager' | 'subagent'): SeatRef {
    if (kind === 'manager') {
      this.owner = agentId;
      return { kind: 'head' };
    }
    let spot = this.standOwner.indexOf(null);
    if (spot < 0) spot = this.standOwner.length;
    this.standOwner[spot] = agentId;
    return { kind: 'stand', index: spot };
  }

  release(ref: SeatRef, agentId: string): void {
    if (ref.kind === 'head' && this.owner === agentId) this.owner = null;
    if (ref.kind === 'stand' && this.standOwner[ref.index] === agentId) this.standOwner[ref.index] = null;
  }

  seatOf(agentId: string): SeatRef | null {
    if (this.owner === agentId) return { kind: 'head' };
    const stand = this.standOwner.indexOf(agentId);
    return stand >= 0 ? { kind: 'stand', index: stand } : null;
  }

  /** Does the ray hit the counter? The floor test of a room would miss the top, which stands above it. */
  hit(ray: THREE.Ray): boolean {
    return ray.intersectsBox(this.counterBox);
  }

  /** World corners of the reception corner of the lobby, for framing: the sign, the counter and some floor. */
  corners(): THREE.Vector3[] {
    const out: THREE.Vector3[] = [];
    for (const x of [-6.1, -1.1]) {
      for (const z of [-3.8, 0.3]) out.push(new THREE.Vector3(x, 0, z), new THREE.Vector3(x, WALL_TALL + 0.6, z));
    }
    return out;
  }

  /** The frame drawn on the floor around the counter when the department is hovered or selected. */
  carpetRect(): { minX: number; maxX: number; minZ: number; maxZ: number; y: number } {
    return {
      minX: RECEPTION.x - RECEPTION.w / 2 - 0.35,
      maxX: RECEPTION.x + RECEPTION.w / 2 + 0.35,
      minZ: RECEPTION.z - RECEPTION.d / 2 - 1.2,
      maxZ: RECEPTION.z + RECEPTION.d / 2 + 0.3,
      y: FLOOR_Y + 0.016,
    };
  }

  private applyName(): void {
    if (this.plateText.textContent !== this.dept.name) this.plateText.textContent = this.dept.name;
    this.plateDot.style.background = DEPARTMENT_HEX[this.dept.color];
  }

  dispose(): void {
    this.kit.chairs.release(this.chair);
    this.group.remove(this.plate);
    this.kit.root.remove(this.group);
  }
}
