// The avatars: short, big-headed figures built from instanced parts (one InstancedMesh per part
// for every avatar), posed on the CPU each frame they move. The status drives the behavior:
// arriving walks in from the door, working sits and types, thinking sways, waiting stands with a
// raised hand and an amber ring, done stands and waves, failed sits with a red ring.

import * as THREE from 'three';
import type { AgentPresence, AgentStatus, DepartmentColor } from '../../shared/types';
import { InstancedBatch } from './batch';
import { Bubble } from './bubble';
import { armGeometry, hairGeometry, handGeometry, headGeometry, legGeometry, ringGeometry, torsoGeometry } from './geometry';
import { doorInside, doorOutside, pathToDoor, pathToSeat, spotOf, standingSpot, type Pt, type RoomPlan, type SeatRef } from './layout';
import { COLORS, DEPARTMENT_HEX, HAIR_COLORS, SKIN_TONES, hashString, managerShirt } from './palette';

const WALK_SPEED = 1.5; // units per second
const STEP_HZ = 1.8;
const POP_MS = 280;
const WAVE_MS = 3200;
const SEATED: ReadonlySet<AgentStatus> = new Set(['idle', 'thinking', 'working', 'failed', 'arriving']);
const AMBIENT: ReadonlySet<AgentStatus> = new Set(['working', 'thinking']);

const RING_COLORS: Partial<Record<AgentStatus, THREE.Color>> = {
  waiting: new THREE.Color(COLORS.waiting),
  failed: new THREE.Color(COLORS.failed),
};

/** What an avatar needs of the place it works in: a Room, or the Reception in the lobby. */
export interface Workplace {
  readonly dept: { readonly color: DepartmentColor };
  readonly plan: RoomPlan;
  readonly floorY: number;
  /** A room's avatars walk in and out through its door; the reception's appear and fade where they are. */
  readonly walksOut: boolean;
  toWorld(local: Pt): Pt;
  yawToWorld(yaw: number): number;
  setScreen(ref: SeatRef, on: boolean): void;
  claim(agentId: string, kind: 'manager' | 'subagent'): SeatRef;
  release(ref: SeatRef, agentId: string): void;
  seatOf(agentId: string): SeatRef | null;
}

export class AvatarParts {
  readonly head: InstancedBatch;
  readonly hair: InstancedBatch;
  readonly torso: InstancedBatch;
  readonly arm: InstancedBatch;
  readonly hand: InstancedBatch;
  readonly leg: InstancedBatch;
  readonly ring: InstancedBatch;
  private readonly all: InstancedBatch[];
  private readonly material = new THREE.MeshLambertMaterial({ vertexColors: true });
  private readonly ringMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.92, depthWrite: false });

  constructor(root: THREE.Object3D, capacity = 32) {
    const cast = { castShadow: true };
    this.head = new InstancedBatch(root, headGeometry(), this.material, capacity, cast);
    this.hair = new InstancedBatch(root, hairGeometry(), this.material, capacity, cast);
    this.torso = new InstancedBatch(root, torsoGeometry(), this.material, capacity, cast);
    this.arm = new InstancedBatch(root, armGeometry(), this.material, capacity * 2, cast);
    this.hand = new InstancedBatch(root, handGeometry(), this.material, capacity * 2);
    this.leg = new InstancedBatch(root, legGeometry(), this.material, capacity * 2, cast);
    this.ring = new InstancedBatch(root, ringGeometry(), this.ringMaterial, capacity);
    this.ring.mesh.renderOrder = 1;
    this.all = [this.head, this.hair, this.torso, this.arm, this.hand, this.leg, this.ring];
  }

  commit(): boolean {
    let changed = false;
    for (const batch of this.all) changed = batch.commit() || changed;
    return changed;
  }

  dispose(): void {
    for (const batch of this.all) {
      batch.dispose();
      batch.geometry.dispose();
    }
    this.material.dispose();
    this.ringMaterial.dispose();
  }
}

interface Pose {
  legL: number;
  legR: number;
  armL: [number, number];
  armR: [number, number];
  bob: number;
  lean: number;
  turn: number;
  tilt: number;
}

type Mode = 'enter' | 'walk' | 'still' | 'leave' | 'exit' | 'gone';

export interface AvatarTick {
  /** Needs frames at full rate (walking, standing up, turning). */
  moving: boolean;
  /** Has a small looping motion (typing, swaying, waving). */
  ambient: boolean;
  /** Wrote new matrices this frame. */
  wrote: boolean;
}

const _root = new THREE.Matrix4();
const _upper = new THREE.Matrix4();
const _m = new THREE.Matrix4();
const _t = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

function angleDiff(to: number, from: number): number {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function approach(value: number, target: number, step: number): number {
  return value < target ? Math.min(target, value + step) : Math.max(target, value - step);
}

export class Avatar {
  readonly id: string;
  agent: AgentPresence;
  readonly room: Workplace;
  seat: SeatRef;
  mode: Mode = 'still';
  readonly bubble: Bubble;

  private x = 0;
  private z = 0;
  private yaw = 0;
  private targetYaw = 0;
  private scale = 1;
  private sit = 1;
  private path: Pt[] = [];
  private walked: Pt[] = [];
  private walkClock = 0;
  private modeStart = 0;
  private statusEpoch = Date.now();
  private waveUntil = 0;
  private readonly phase: number;
  private readonly slots: Record<'head' | 'hair' | 'torso' | 'armL' | 'armR' | 'handL' | 'handR' | 'legL' | 'legR' | 'ring', number>;
  private dirty = true;
  private screen = false;

  constructor(
    private readonly parts: AvatarParts,
    private readonly root: THREE.Object3D,
    agent: AgentPresence,
    room: Workplace,
    seat: SeatRef,
    arrive: boolean,
    now: number,
  ) {
    this.id = agent.id;
    this.agent = agent;
    this.room = room;
    this.seat = seat;
    const hash = hashString(agent.id);
    this.phase = (hash % 1000) / 160;
    this.slots = {
      head: parts.head.alloc(),
      hair: parts.hair.alloc(),
      torso: parts.torso.alloc(),
      armL: parts.arm.alloc(),
      armR: parts.arm.alloc(),
      handL: parts.hand.alloc(),
      handR: parts.hand.alloc(),
      legL: parts.leg.alloc(),
      legR: parts.leg.alloc(),
      ring: parts.ring.alloc(),
    };
    this.bubble = new Bubble(agent.id);
    root.add(this.bubble.object);
    this.paint();
    if (arrive) {
      const door = doorOutside(room.plan);
      this.x = door.x;
      this.z = door.z;
      this.yaw = 0;
      this.targetYaw = 0;
      this.scale = 0;
      this.sit = 0;
      this.mode = 'enter';
      this.modeStart = now;
      this.path = this.walkInPath();
    } else {
      this.snapToSeat();
    }
    this.setAgent(agent, now, true);
  }

  setAgent(agent: AgentPresence, now: number, first = false): void {
    const changed = first || agent.status !== this.agent.status;
    this.agent = agent;
    if (changed) {
      this.statusEpoch = Date.now();
      this.waveUntil = agent.status === 'done' ? now + WAVE_MS : 0;
    }
    const started = Date.parse(agent.startedAt);
    const since = agent.kind === 'subagent' && Number.isFinite(started) ? started : this.statusEpoch;
    this.bubble.set(agent, since);
    const ring = RING_COLORS[agent.status];
    if (ring) this.parts.ring.setColor(this.slots.ring, ring);
    this.dirty = true;
  }

  /** Colors from the agent id (skin, hair) and the department (shirt). */
  paint(): void {
    const hash = hashString(this.id);
    const skin = new THREE.Color(SKIN_TONES[hash % SKIN_TONES.length]);
    const hair = new THREE.Color(HAIR_COLORS[(hash >>> 4) % HAIR_COLORS.length]);
    const color = this.room.dept.color;
    const shirt = new THREE.Color(this.agent.kind === 'manager' ? managerShirt(color) : DEPARTMENT_HEX[color]);
    const pants = new THREE.Color(COLORS.pants);
    const { parts, slots } = this;
    parts.head.setColor(slots.head, skin);
    parts.hand.setColor(slots.handL, skin);
    parts.hand.setColor(slots.handR, skin);
    parts.hair.setColor(slots.hair, hair);
    parts.torso.setColor(slots.torso, shirt);
    parts.arm.setColor(slots.armL, shirt);
    parts.arm.setColor(slots.armR, shirt);
    parts.leg.setColor(slots.legL, pants);
    parts.leg.setColor(slots.legR, pants);
    this.dirty = true;
  }

  /** The agent left the store: walk back out through the door. */
  leave(now: number): void {
    if (this.mode === 'leave' || this.mode === 'exit' || this.mode === 'gone') return;
    this.bubble.setMode('hidden');
    this.setScreen(false);
    if (this.mode === 'enter' || !this.room.walksOut) {
      const entering = this.mode === 'enter';
      this.mode = 'exit';
      this.modeStart = entering ? now - (1 - this.scale) * POP_MS : now;
      return;
    }
    this.path =
      this.mode === 'walk' ? [...this.walked].reverse().concat(doorOutside(this.room.plan)) : pathToDoor(this.room.plan, this.seat);
    this.mode = 'leave';
    this.walkClock = 0;
  }

  /** Something moved under the avatar (its room moved or rose): write its matrices again. */
  invalidate(): void {
    this.dirty = true;
  }

  /** The room was rebuilt at another size: take the same seat at its new place. */
  reseat(seat: SeatRef): void {
    this.seat = seat;
    if (this.mode === 'still') this.snapToSeat();
    else if (this.mode === 'walk' || this.mode === 'enter') this.path = this.walkInPath();
    this.dirty = true;
  }

  get pickable(): boolean {
    return this.mode !== 'leave' && this.mode !== 'exit' && this.mode !== 'gone';
  }

  /** The world point to aim at: the middle of the body. */
  center(out: THREE.Vector3): THREE.Vector3 {
    const w = this.room.toWorld({ x: this.x, z: this.z });
    return out.set(w.x, this.room.floorY + 0.62, w.z);
  }

  /** The world point of the seat, for framing the desk. */
  seatPoint(out: THREE.Vector3): THREE.Vector3 {
    const s = this.room.toWorld(spotOf(this.room.plan, this.seat));
    return out.set(s.x, this.room.floorY, s.z);
  }

  update(dt: number, now: number, reduced: boolean): AvatarTick {
    let moving = false;
    let ambient = false;
    switch (this.mode) {
      case 'enter':
        if (reduced) {
          this.snapToSeat();
          break;
        }
        this.scale = Math.min(1, (now - this.modeStart) / POP_MS);
        if (this.scale >= 1) this.mode = 'walk';
        moving = true;
        break;
      case 'walk':
        if (reduced) {
          this.snapToSeat();
          break;
        }
        if (this.follow(dt)) {
          this.mode = 'still';
          this.sit = 0;
        }
        moving = true;
        break;
      case 'leave':
        if (reduced) {
          this.mode = 'gone';
          break;
        }
        if (this.follow(dt)) {
          this.mode = 'exit';
          this.modeStart = now;
        }
        moving = true;
        break;
      case 'exit':
        this.scale = reduced ? 0 : Math.max(0, 1 - (now - this.modeStart) / POP_MS);
        if (this.scale <= 0) this.mode = 'gone';
        moving = true;
        break;
      case 'still': {
        const plan = this.room.plan;
        const seated = this.seat.kind !== 'stand' && SEATED.has(this.agent.status);
        const target = seated ? 1 : 0;
        if (this.sit !== target) {
          this.sit = reduced ? target : approach(this.sit, target, dt * 4);
          moving = true;
        }
        const seat = spotOf(plan, this.seat);
        const stand = standingSpot(plan, this.seat);
        const nx = stand.x + (seat.x - stand.x) * this.sit;
        const nz = stand.z + (seat.z - stand.z) * this.sit;
        if (Math.abs(nx - this.x) > 1e-5 || Math.abs(nz - this.z) > 1e-5) {
          this.x = nx;
          this.z = nz;
          moving = true;
        }
        const turn = angleDiff(seat.yaw, this.yaw);
        if (Math.abs(turn) > 0.002) {
          this.yaw = reduced ? seat.yaw : this.yaw + turn * Math.min(1, dt * 8);
          moving = true;
        }
        if (!reduced) ambient = AMBIENT.has(this.agent.status) || now < this.waveUntil;
        break;
      }
      case 'gone':
        break;
    }
    if (moving) this.dirty = true;
    const wrote = this.mode !== 'gone' && (this.dirty || ambient);
    if (wrote) this.write(now, reduced);
    this.dirty = false;
    this.setScreen(this.mode === 'still' && this.sit > 0.5 && AMBIENT.has(this.agent.status));
    return { moving, ambient, wrote };
  }

  dispose(): void {
    const { parts, slots } = this;
    parts.head.release(slots.head);
    parts.hair.release(slots.hair);
    parts.torso.release(slots.torso);
    parts.arm.release(slots.armL);
    parts.arm.release(slots.armR);
    parts.hand.release(slots.handL);
    parts.hand.release(slots.handR);
    parts.leg.release(slots.legL);
    parts.leg.release(slots.legR);
    parts.ring.release(slots.ring);
    this.setScreen(false);
    this.root.remove(this.bubble.object);
  }

  private walkInPath(): Pt[] {
    const path = pathToSeat(this.room.plan, this.seat);
    path[path.length - 1] = standingSpot(this.room.plan, this.seat);
    // Start from the doorway even when the avatar is already inside.
    if (this.z > doorInside(this.room.plan).z) path.shift();
    return path;
  }

  private snapToSeat(): void {
    const seat = spotOf(this.room.plan, this.seat);
    const seated = this.seat.kind !== 'stand' && SEATED.has(this.agent.status);
    const stand = standingSpot(this.room.plan, this.seat);
    this.sit = seated ? 1 : 0;
    this.x = seated ? seat.x : stand.x;
    this.z = seated ? seat.z : stand.z;
    this.yaw = seat.yaw;
    this.targetYaw = seat.yaw;
    this.scale = 1;
    this.path = [];
    this.mode = 'still';
    this.dirty = true;
  }

  /** Walks along the path. Returns true at its end. */
  private follow(dt: number): boolean {
    let step = WALK_SPEED * dt;
    while (this.path.length > 0 && step > 0) {
      const p = this.path[0];
      const dx = p.x - this.x;
      const dz = p.z - this.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 1e-4) this.targetYaw = Math.atan2(dx, dz);
      if (dist <= step) {
        this.x = p.x;
        this.z = p.z;
        step -= dist;
        this.walked.push(p);
        this.path.shift();
      } else {
        this.x += (dx / dist) * step;
        this.z += (dz / dist) * step;
        step = 0;
      }
    }
    this.yaw += angleDiff(this.targetYaw, this.yaw) * Math.min(1, dt * 10);
    this.walkClock += dt;
    return this.path.length === 0;
  }

  private setScreen(on: boolean): void {
    if (on === this.screen || this.seat.kind === 'stand') return;
    this.screen = on;
    this.room.setScreen(this.seat, on);
  }

  private pose(now: number, reduced: boolean): Pose {
    const p: Pose = { legL: 0, legR: 0, armL: [0, -0.12], armR: [0, 0.12], bob: 0, lean: 0, turn: 0, tilt: 0 };
    if (this.mode !== 'still') {
      const w = Math.sin(this.walkClock * Math.PI * 2 * STEP_HZ);
      p.legL = w * 0.55;
      p.legR = -w * 0.55;
      p.armL = [-w * 0.45, -0.1];
      p.armR = [w * 0.45, 0.1];
      p.bob = Math.abs(w) * 0.025;
      return p;
    }
    const t = reduced ? 0 : now / 1000 + this.phase;
    const status = this.agent.status;
    p.legL = p.legR = -1.4 * this.sit;
    if (this.sit > 0.5) {
      if (status === 'working') {
        p.armL = [-1.2 + Math.sin(t * 11) * 0.07, -0.05];
        p.armR = [-1.2 + Math.sin(t * 11 + 1.9) * 0.07, 0.05];
        p.bob = Math.sin(t * 5.5) * 0.006;
        p.lean = 0.1;
      } else if (status === 'thinking') {
        p.armL = [-0.75, -0.12];
        p.armR = [-0.75, 0.12];
        p.turn = Math.sin(t * 1.3) * 0.16;
        p.tilt = Math.sin(t * 0.9) * 0.07;
      } else if (status === 'failed') {
        p.armL = [-0.45, -0.12];
        p.armR = [-0.45, 0.12];
        p.lean = 0.22;
        p.tilt = 0.2;
      } else {
        p.armL = [-0.95, -0.08];
        p.armR = [-0.95, 0.08];
      }
      return p;
    }
    // A raised hand goes up and out, so it shows beside the big head from any side.
    if (status === 'waiting') {
      p.armR = [-2.95, -0.6];
    } else if (status === 'done' && !reduced && now < this.waveUntil) {
      p.armR = [-2.85, -0.62 + Math.sin(t * 9) * 0.32];
    } else if (status === 'working') {
      p.armL = [-0.6, -0.1];
      p.armR = [-0.6, 0.1];
      p.bob = Math.sin(t * 5.5) * 0.006;
    } else if (status === 'thinking') {
      p.turn = Math.sin(t * 1.3) * 0.16;
    }
    return p;
  }

  private write(now: number, reduced: boolean): void {
    const pose = this.pose(now, reduced);
    const { parts, slots } = this;
    const w = this.room.toWorld({ x: this.x, z: this.z });
    const y = this.room.floorY;
    const s = Math.max(this.scale, 1e-4);
    _root.compose(_p.set(w.x, y, w.z), _q.setFromAxisAngle(_up, this.room.yawToWorld(this.yaw)), _s.set(s, s, s));

    const limb = (batch: InstancedBatch, slot: number, base: THREE.Matrix4, x: number, py: number, rz: number, rx: number) => {
      _m.copy(base).multiply(_t.makeTranslation(x, py, 0));
      if (rz !== 0) _m.multiply(_t.makeRotationZ(rz));
      _m.multiply(_t.makeRotationX(rx));
      batch.setMatrix(slot, _m);
      return _m;
    };
    limb(parts.leg, slots.legL, _root, -0.08, 0.3, 0, pose.legL);
    limb(parts.leg, slots.legR, _root, 0.08, 0.3, 0, pose.legR);

    _upper.copy(_root).multiply(_t.makeTranslation(0, 0.3 + pose.bob, 0));
    if (pose.turn !== 0) _upper.multiply(_t.makeRotationY(pose.turn));
    if (pose.lean !== 0) _upper.multiply(_t.makeRotationX(pose.lean));
    _upper.multiply(_t.makeTranslation(0, -0.3, 0));

    parts.torso.setMatrix(slots.torso, _m.copy(_upper).multiply(_t.makeTranslation(0, 0.48, 0)));
    _m.copy(_upper).multiply(_t.makeTranslation(0, 0.87, 0));
    if (pose.tilt !== 0) _m.multiply(_t.makeRotationX(pose.tilt));
    parts.head.setMatrix(slots.head, _m);
    parts.hair.setMatrix(slots.hair, _m);
    parts.hand.setMatrix(slots.handL, limb(parts.arm, slots.armL, _upper, -0.205, 0.62, pose.armL[1], pose.armL[0]));
    parts.hand.setMatrix(slots.handR, limb(parts.arm, slots.armR, _upper, 0.205, 0.62, pose.armR[1], pose.armR[0]));

    const ring = this.mode === 'still' && RING_COLORS[this.agent.status] !== undefined;
    if (ring) {
      _m.compose(_p.set(w.x, y + 0.012, w.z), _q.identity(), _s.set(1, 1, 1));
      parts.ring.setMatrix(slots.ring, _m);
    } else {
      parts.ring.setMatrix(slots.ring, _ZERO);
    }
    this.bubble.object.position.set(w.x, y + 1.3 + pose.bob, w.z);
  }
}
