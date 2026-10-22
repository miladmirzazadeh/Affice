// The building: one Room per department (floor, walls, carpet, board, head desk, sofa corner as one
// mesh; desks, chairs, monitors, screens and plants as instances of shared meshes) and the Shell
// (lobby with the company name, the corridor, the low walls between rooms).

import * as THREE from 'three';
import { CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';
import type { Department, SessionState } from '../../shared/types';
import type { InstancedBatch } from './batch';
import { GeoBuilder, addHeadDesk, addMonitor, addPlanter, addSofa, addTable } from './geometry';
import {
  CORRIDOR_W,
  DESK,
  DESK_CAPACITY,
  FLOOR_Y,
  LOBBY_D,
  LOBBY_W,
  RECEPTION,
  WALL_LOW,
  WALL_T,
  WALL_TALL,
  footprint,
  planRoom,
  toWorld,
  yawToWorld,
  type BuildingLayout,
  type Placement,
  type Pt,
  type RoomClass,
  type RoomPlan,
  type SeatRef,
} from './layout';
import { CHAIR_COLORS, COLORS, DEPARTMENT_HEX, floorTint, hashString } from './palette';
import { allocPlant, corridorPlants, lobbyPlants, roomPlants, type PlantBatches, type PlantSpot } from './plants';

export interface Kit {
  root: THREE.Object3D;
  shellMaterial: THREE.Material;
  desks: InstancedBatch;
  chairs: InstancedBatch;
  monitors: InstancedBatch;
  screens: InstancedBatch;
  plants: PlantBatches;
}

const SCREEN_OFF = new THREE.Color(COLORS.screenOff);
const SCREEN_ON = new THREE.Color(COLORS.screenOn);
const RISE_MS = 700;
const RISE_DEPTH = 2.2;
const CSS_SCALE = 0.01; // one CSS pixel is a hundredth of a unit

interface PropRef {
  batch: InstancedBatch;
  index: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _c = new THREE.Color();

function sessionWord(session: SessionState | undefined): string {
  switch (session?.status) {
    case 'starting':
      return 'Starting';
    case 'ready':
      return 'Ready';
    case 'busy':
      return 'Busy';
    case 'waiting':
      return 'Waiting for you';
    case 'error':
      return 'Error';
    default:
      return 'Off';
  }
}

export class Room {
  readonly id: string;
  dept: Department;
  cls: RoomClass;
  plan: RoomPlan;
  place: Placement | null = null;
  readonly group = new THREE.Group();
  readonly walksOut = true;
  /** Agent ids by desk and by standing spot. */
  seatOwner: (string | null)[];
  standOwner: (string | null)[] = [];

  private mesh: THREE.Mesh | null = null;
  private builtKey = '';
  private props: PropRef[] = [];
  private seatScreens: number[] = [];
  private headScreens: number[] = [];
  private screenOn = new Set<string>();
  private riseStart = -1;
  private riseY = 0;

  private readonly label: CSS3DObject;
  private readonly labelText: HTMLSpanElement;
  private readonly labelSub: HTMLDivElement;
  private readonly labelDot: HTMLSpanElement;
  private readonly board: CSS3DObject;
  private readonly boardText: HTMLDivElement;

  constructor(
    private readonly kit: Kit,
    dept: Department,
    cls: RoomClass,
  ) {
    this.id = dept.id;
    this.dept = dept;
    this.cls = cls;
    this.plan = planRoom(cls);
    this.seatOwner = new Array(DESK_CAPACITY[cls]).fill(null);
    this.group.name = `room:${dept.id}`;
    kit.root.add(this.group);

    const labelEl = document.createElement('div');
    labelEl.className = 'office-room-label';
    const name = document.createElement('div');
    name.className = 'orl-name';
    name.dataset.officeDept = dept.id;
    this.labelDot = document.createElement('span');
    this.labelDot.className = 'orl-dot';
    this.labelText = document.createElement('span');
    name.append(this.labelDot, this.labelText);
    this.labelSub = document.createElement('div');
    this.labelSub.className = 'orl-sub';
    this.labelSub.dataset.officeDept = dept.id;
    labelEl.append(name, this.labelSub);
    this.label = new CSS3DObject(labelEl);
    labelEl.style.pointerEvents = 'none';
    this.label.scale.setScalar(CSS_SCALE);
    this.label.rotation.x = -Math.PI / 2;
    this.group.add(this.label);

    const boardEl = document.createElement('div');
    boardEl.className = 'office-board';
    this.boardText = document.createElement('div');
    this.boardText.className = 'obd-name';
    boardEl.append(this.boardText);
    this.board = new CSS3DObject(boardEl);
    boardEl.style.pointerEvents = 'none';
    this.board.scale.setScalar(CSS_SCALE);
    this.board.rotation.y = Math.PI / 2;
    this.group.add(this.board);

    this.applyNames();
  }

  /** A new department object or class. Returns true when the room needs a new layout. */
  update(dept: Department, cls: RoomClass): boolean {
    const relayout = dept.slot !== this.dept.slot || cls !== this.cls;
    this.dept = dept;
    if (cls !== this.cls) {
      this.cls = cls;
      this.plan = planRoom(cls);
      const owners = this.seatOwner;
      this.seatOwner = new Array(DESK_CAPACITY[cls]).fill(null);
      owners.forEach((owner, i) => {
        if (i < this.seatOwner.length) this.seatOwner[i] = owner;
      });
    }
    this.applyNames();
    if (!relayout && this.place) this.rebuildIfNeeded();
    return relayout;
  }

  /** Puts the room at its place in the building; rises out of the ground when asked. */
  setPlace(place: Placement, rise: boolean, now: number): void {
    this.place = place;
    this.group.position.set(place.x, this.riseY, place.z);
    this.rebuildIfNeeded();
    this.writeProps();
    const { w, d } = this.plan;
    const south = place.side === 1;
    this.label.position.set(0, south ? 0.01 : FLOOR_Y + 0.005, south ? d + 0.62 : 0.62);
    (this.label.element as HTMLElement).style.width = `${Math.round((w - 0.5) / CSS_SCALE)}px`;
    this.label.element.classList.toggle('on-floor', !south);
    this.board.position.set(-w / 2 + WALL_T + 0.04, FLOOR_Y + 1.07, place.side * this.plan.board.z);
    if (rise) {
      this.riseStart = now;
      this.setRise(-RISE_DEPTH);
    }
  }

  /** Advances the rise animation. Returns true while rising. */
  updateRise(now: number): boolean {
    if (this.riseStart < 0) return false;
    const t = Math.min(1, (now - this.riseStart) / RISE_MS);
    const eased = 1 - Math.pow(1 - t, 3);
    this.setRise(-RISE_DEPTH * (1 - eased));
    if (t >= 1) this.riseStart = -1;
    return true;
  }

  get rising(): boolean {
    return this.riseStart >= 0;
  }

  get floorY(): number {
    return this.riseY + FLOOR_Y;
  }

  private setRise(y: number): void {
    this.riseY = y;
    this.group.position.y = y;
    const settled = y > -0.01;
    this.label.visible = settled;
    this.board.visible = settled;
    this.writeProps();
  }

  setSummary(session: SessionState | undefined, agents: number): void {
    const text = `${agents} ${agents === 1 ? 'agent' : 'agents'} · ${sessionWord(session)}`;
    if (this.labelSub.textContent !== text) this.labelSub.textContent = text;
  }

  setScreen(ref: SeatRef, on: boolean): void {
    const key = ref.kind === 'head' ? 'head' : ref.kind === 'desk' ? `d${ref.index}` : '';
    if (!key) return;
    if (on === this.screenOn.has(key)) return;
    if (on) this.screenOn.add(key);
    else this.screenOn.delete(key);
    this.paintScreens();
  }

  claim(agentId: string, kind: 'manager' | 'subagent'): SeatRef {
    if (kind === 'manager') return { kind: 'head' };
    const free = this.seatOwner.indexOf(null);
    if (free >= 0) {
      this.seatOwner[free] = agentId;
      return { kind: 'desk', index: free };
    }
    let spot = this.standOwner.indexOf(null);
    if (spot < 0) spot = this.standOwner.length;
    this.standOwner[spot] = agentId;
    return { kind: 'stand', index: spot };
  }

  release(ref: SeatRef, agentId: string): void {
    if (ref.kind === 'desk' && this.seatOwner[ref.index] === agentId) this.seatOwner[ref.index] = null;
    if (ref.kind === 'stand' && this.standOwner[ref.index] === agentId) this.standOwner[ref.index] = null;
    if (ref.kind !== 'stand') this.setScreen(ref, false);
  }

  /** The seat an agent holds, after a class change moved the desks. */
  seatOf(agentId: string): SeatRef | null {
    const desk = this.seatOwner.indexOf(agentId);
    if (desk >= 0) return { kind: 'desk', index: desk };
    const stand = this.standOwner.indexOf(agentId);
    if (stand >= 0) return { kind: 'stand', index: stand };
    return null;
  }

  contains(x: number, z: number): boolean {
    if (!this.place) return false;
    const f = footprint(this.place);
    return x >= f.minX && x <= f.maxX && z >= f.minZ && z <= f.maxZ;
  }

  /** World corners of the room, walls and name label included, for framing. */
  corners(): THREE.Vector3[] {
    if (!this.place) return [];
    const f = footprint(this.place);
    const out: THREE.Vector3[] = [];
    for (const x of [f.minX, f.maxX]) {
      for (const z of [f.minZ, f.maxZ + 1.2]) {
        out.push(new THREE.Vector3(x, 0, z), new THREE.Vector3(x, WALL_TALL + 0.6, z));
      }
    }
    return out;
  }

  /** The inner edge of the carpet, in world coordinates, for the selection frame. */
  carpetRect(): { minX: number; maxX: number; minZ: number; maxZ: number; y: number } | null {
    if (!this.place) return null;
    const inset = WALL_T + 0.32;
    const { w, d } = this.plan;
    const a = toWorld(this.place, { x: -w / 2 + inset, z: inset });
    const b = toWorld(this.place, { x: w / 2 - inset, z: d - inset });
    return {
      minX: Math.min(a.x, b.x),
      maxX: Math.max(a.x, b.x),
      minZ: Math.min(a.z, b.z),
      maxZ: Math.max(a.z, b.z),
      y: this.floorY + 0.016,
    };
  }

  toWorld(local: Pt): Pt {
    return this.place ? toWorld(this.place, local) : local;
  }

  yawToWorld(yaw: number): number {
    return this.place ? yawToWorld(this.place, yaw) : yaw;
  }

  private applyNames(): void {
    if (this.labelText.textContent !== this.dept.name) this.labelText.textContent = this.dept.name;
    if (this.boardText.textContent !== this.dept.name) this.boardText.textContent = this.dept.name;
    this.labelDot.style.background = DEPARTMENT_HEX[this.dept.color];
    this.boardText.style.borderColor = DEPARTMENT_HEX[this.dept.color];
  }

  private rebuildIfNeeded(): void {
    if (!this.place) return;
    const key = `${this.cls}|${this.place.side}|${this.dept.color}`;
    if (key === this.builtKey) return;
    this.builtKey = key;
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
    }
    this.mesh = new THREE.Mesh(this.buildShell(this.place.side), this.kit.shellMaterial);
    this.mesh.scale.z = this.place.side;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.group.add(this.mesh);
    this.allocProps();
  }

  private buildShell(side: 1 | -1): THREE.BufferGeometry {
    const { w, d, door, pods, head, sofa, table, board, frontZ } = this.plan;
    const b = new GeoBuilder();
    const inset = WALL_T + 0.32;
    b.slab(-w / 2, 0, w / 2, d, 0, FLOOR_Y, COLORS.floor);
    b.slab(-w / 2 + inset, inset, w / 2 - inset, d - inset, FLOOR_Y, FLOOR_Y + 0.012, floorTint(this.dept.color));
    // Walls facing the camera stay low so the room can be seen into; the others are full height.
    const corridorH = side === 1 ? WALL_TALL : WALL_LOW;
    const farH = side === 1 ? WALL_LOW : WALL_TALL;
    b.slab(-w / 2, 0, -w / 2 + WALL_T, d, 0, WALL_TALL, COLORS.wall);
    b.slab(-w / 2 + WALL_T, 0, door.x - door.width / 2, WALL_T, 0, corridorH, COLORS.wall);
    b.slab(door.x + door.width / 2, 0, w / 2, WALL_T, 0, corridorH, COLORS.wall);
    b.slab(-w / 2 + WALL_T, d - WALL_T, w / 2, d, 0, farH, COLORS.wall);
    b.slab(w / 2 - WALL_T, WALL_T, w / 2, d - WALL_T, 0, WALL_LOW, COLORS.wall);
    b.box(0.035, 0.58, board.length, -w / 2 + WALL_T + 0.0175, FLOOR_Y + 1.07, board.z, COLORS.board);
    for (const pod of pods) addPlanter(b, pod.x, frontZ, pod.n * DESK.w);
    addHeadDesk(b, head.desk.x, head.desk.z, head.desk.yaw, FLOOR_Y);
    for (const m of head.monitors) addMonitor(b, m.x, m.z, m.yaw, FLOOR_Y);
    addSofa(b, sofa.x, sofa.z, sofa.yaw, FLOOR_Y);
    addTable(b, table.x, table.z, FLOOR_Y);
    return b.build();
  }

  private allocProps(): void {
    for (const prop of this.props) prop.batch.release(prop.index);
    for (const index of [...this.seatScreens, ...this.headScreens]) this.kit.screens.release(index);
    this.props = [];
    this.seatScreens = [];
    this.headScreens = [];
    const { kit, plan } = this;
    const tint = hashString(this.dept.id);
    const add = (batch: InstancedBatch, x: number, z: number, yaw: number, scale = 1): number => {
      const index = batch.alloc();
      this.props.push({ batch, index, x, y: FLOOR_Y, z, yaw, scale });
      return index;
    };
    plan.seats.forEach((seat, i) => {
      add(kit.desks, seat.desk.x, seat.desk.z, seat.desk.yaw);
      add(kit.monitors, seat.monitor.x, seat.monitor.z, seat.monitor.yaw);
      const chair = add(kit.chairs, seat.x, seat.z, seat.yaw);
      kit.chairs.setColor(chair, _c.set(CHAIR_COLORS[(i + tint) % CHAIR_COLORS.length]));
      const screen = kit.screens.alloc();
      this.props.push({ batch: kit.screens, index: screen, x: seat.monitor.x, y: FLOOR_Y, z: seat.monitor.z, yaw: seat.monitor.yaw, scale: 1 });
      this.seatScreens.push(screen);
    });
    const headChair = add(kit.chairs, plan.head.seat.x, plan.head.seat.z, plan.head.seat.yaw);
    kit.chairs.setColor(headChair, _c.set('#4a4d57'));
    for (const m of plan.head.monitors) {
      const screen = kit.screens.alloc();
      this.props.push({ batch: kit.screens, index: screen, x: m.x, y: FLOOR_Y, z: m.z, yaw: m.yaw, scale: 1 });
      this.headScreens.push(screen);
    }
    for (const spot of roomPlants(this.id, plan, this.place?.side ?? 1)) {
      const { batch, index } = allocPlant(kit.plants, spot, _c);
      this.props.push({ batch, index, x: spot.x, y: FLOOR_Y + spot.y, z: spot.z, yaw: spot.yaw, scale: spot.scale });
    }
    // A seat whose screen was lit stays lit across a rebuild; the seat may be out of range now.
    for (const key of [...this.screenOn]) {
      if (key.startsWith('d') && Number(key.slice(1)) >= plan.seats.length) this.screenOn.delete(key);
    }
    this.paintScreens();
    this.writeProps();
  }

  private paintScreens(): void {
    this.seatScreens.forEach((index, i) => this.kit.screens.setColor(index, this.screenOn.has(`d${i}`) ? SCREEN_ON : SCREEN_OFF));
    for (const index of this.headScreens) this.kit.screens.setColor(index, this.screenOn.has('head') ? SCREEN_ON : SCREEN_OFF);
  }

  private writeProps(): void {
    if (!this.place) return;
    for (const prop of this.props) {
      const w = toWorld(this.place, prop);
      _m.compose(
        _p.set(w.x, this.riseY + prop.y, w.z),
        _q.setFromAxisAngle(_up, yawToWorld(this.place, prop.yaw)),
        _s.set(prop.scale, prop.scale, prop.scale),
      );
      prop.batch.setMatrix(prop.index, _m);
    }
  }

  dispose(): void {
    for (const prop of this.props) prop.batch.release(prop.index);
    this.props = [];
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
    this.group.remove(this.label, this.board);
    this.kit.root.remove(this.group);
  }
}

/** The lobby, the corridor and the low walls between rooms. Rebuilt when the layout changes. */
export class Shell {
  readonly group = new THREE.Group();
  private mesh: THREE.Mesh | null = null;
  private plants: { batch: InstancedBatch; index: number }[] = [];
  private readonly sign: CSS3DObject;
  private readonly signText: HTMLDivElement;

  constructor(private readonly kit: Kit) {
    this.group.name = 'shell';
    kit.root.add(this.group);
    const el = document.createElement('div');
    el.className = 'office-sign';
    this.signText = document.createElement('div');
    el.append(this.signText);
    el.style.pointerEvents = 'none';
    this.sign = new CSS3DObject(el);
    this.sign.scale.setScalar(CSS_SCALE);
    this.sign.position.set(-LOBBY_W / 2, FLOOR_Y + 1.02, -LOBBY_D / 2 + WALL_T + 0.012);
    this.group.add(this.sign);
  }

  setCompany(name: string): void {
    if (this.signText.textContent !== name) this.signText.textContent = name;
  }

  build(layout: BuildingLayout): void {
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
    }
    const b = new GeoBuilder();
    const LW = LOBBY_W;
    const LD = LOBBY_D;
    const CW = CORRIDOR_W;
    const end = layout.corridorEnd;

    // Lobby: floor, rug, walls (the entrance in the south wall, the corridor through the east wall).
    b.slab(-LW, -LD / 2, 0, LD / 2, 0, FLOOR_Y, COLORS.corridor);
    b.slab(-LW / 2 - 2.0, -0.9, -LW / 2 + 2.0, 1.9, FLOOR_Y, FLOOR_Y + 0.01, COLORS.rug);
    b.slab(-LW, -LD / 2, 0, -LD / 2 + WALL_T, 0, WALL_TALL, COLORS.wall);
    b.slab(-LW, -LD / 2 + WALL_T, -LW + WALL_T, LD / 2, 0, WALL_TALL, COLORS.wall);
    b.slab(-LW + WALL_T, LD / 2 - WALL_T, -LW / 2 - 0.85, LD / 2, 0, WALL_LOW, COLORS.wall);
    b.slab(-LW / 2 + 0.85, LD / 2 - WALL_T, 0, LD / 2, 0, WALL_LOW, COLORS.wall);
    b.slab(-WALL_T, -LD / 2 + WALL_T, 0, -CW / 2, 0, WALL_LOW, COLORS.wall);
    b.slab(-WALL_T, CW / 2, 0, LD / 2 - WALL_T, 0, WALL_LOW, COLORS.wall);
    // Reception counter under the sign, a mat at the entrance, a sofa corner by the west wall.
    const desk = RECEPTION;
    b.box(desk.w, desk.h, desk.d, desk.x, FLOOR_Y + desk.h / 2, desk.z, COLORS.wood);
    b.box(desk.w + 0.14, 0.04, desk.d + 0.1, desk.x, FLOOR_Y + desk.h + 0.02, desk.z, COLORS.tabletop);
    b.slab(-LW / 2 - 0.8, LD / 2 - 1.15, -LW / 2 + 0.8, LD / 2 - 0.3, FLOOR_Y, FLOOR_Y + 0.012, COLORS.mat);
    addSofa(b, -LW + 0.55, 0.5, Math.PI / 2, FLOOR_Y);
    addTable(b, -LW + 1.5, 0.5, FLOOR_Y);

    // Corridor floor and its end wall.
    b.slab(0, -CW / 2, end, CW / 2, 0, FLOOR_Y, COLORS.corridor);
    b.slab(end - WALL_T, -CW / 2 - WALL_T, end, CW / 2 + WALL_T, 0, WALL_LOW, COLORS.wall);

    // Low walls along the corridor wherever no room borders it.
    for (const side of [-1, 1] as const) {
      const covered = [...layout.rooms.values()]
        .filter((p) => p.side === side)
        .map((p) => [p.x - p.plan.w / 2, p.x + p.plan.w / 2] as const)
        .sort((a, b2) => a[0] - b2[0]);
      let x = 0;
      const z0 = side === -1 ? -CW / 2 - WALL_T : CW / 2;
      for (const [a, c] of [...covered, [end - WALL_T, end] as const]) {
        if (a > x) b.slab(x, z0, a, z0 + WALL_T, 0, WALL_LOW, COLORS.wall);
        x = Math.max(x, c);
      }
    }

    this.mesh = new THREE.Mesh(b.build(), this.kit.shellMaterial);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.group.add(this.mesh);

    this.placePlants(layout);
  }

  /** The lobby's and the corridor's plants (the rooms bring their own). Placed again whenever the layout changes. */
  private placePlants(layout: BuildingLayout): void {
    this.releasePlants();
    const spots: PlantSpot[] = [...lobbyPlants(), ...corridorPlants(layout)];
    for (const spot of spots) {
      const plant = allocPlant(this.kit.plants, spot, _c);
      _m.compose(
        _p.set(spot.x, FLOOR_Y + spot.y, spot.z),
        _q.setFromAxisAngle(_up, spot.yaw),
        _s.set(spot.scale, spot.scale, spot.scale),
      );
      plant.batch.setMatrix(plant.index, _m);
      this.plants.push(plant);
    }
  }

  private releasePlants(): void {
    for (const plant of this.plants) plant.batch.release(plant.index);
    this.plants = [];
  }

  dispose(): void {
    this.releasePlants();
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
    }
    this.group.remove(this.sign);
    this.kit.root.remove(this.group);
  }
}
