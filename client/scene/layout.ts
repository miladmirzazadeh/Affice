// The floor plan of the office, as plain numbers: room sizes by class, desks and seats inside a
// room, and the building layout (lobby at the west end, rooms on both sides of one corridor).
//
// Room-local frame: x runs along the corridor (world +X), z runs from the corridor wall (z = 0)
// into the room (z = d). A room north of the corridor has side -1, south of it side +1, and
// world = (origin.x + x, origin.z + side * z). One unit is about a meter.

export type RoomClass = 'small' | 'medium' | 'large';

/** Desks per room class. */
export const DESK_CAPACITY: Record<RoomClass, number> = { small: 4, medium: 8, large: 12 };

export const FLOOR_Y = 0.06;
export const WALL_T = 0.12;
export const WALL_TALL = 1.5;
export const WALL_LOW = 0.3;
export const CORRIDOR_W = 2.6;
export const ROOM_GAP = 1.4;
export const LOBBY_W = 7.2;
export const LOBBY_D = 7.6;
/** The reception counter in the lobby, under the company sign. The general manager sits behind it. */
export const RECEPTION = { x: -LOBBY_W / 2, z: -LOBBY_D / 2 + 1.75, w: 2.6, d: 0.58, h: 0.6 };
/** Space in front of the south rooms for their name labels. */
export const LABEL_SPACE = 1.4;

export const DESK = { w: 1.0, d: 0.66, h: 0.55 };
const CHAIR_OFFSET = 0.92; // chair center from the pod's center line
const LANE_OFFSET = 1.42; // walking lane from the pod's center line
const FRONT_Z = 1.5; // the pods start here
const WALK_Z = 1.02; // the walkway between the door and the pods

export interface Pt {
  x: number;
  z: number;
}

export interface Spot extends Pt {
  /** Facing angle: 0 looks along +z, PI / 2 along +x. */
  yaw: number;
}

export interface Seat extends Spot {
  desk: Spot;
  monitor: Spot;
  laneX: number;
}

export interface RoomPlan {
  cls: RoomClass;
  w: number;
  d: number;
  door: { x: number; width: number };
  pods: { x: number; n: number }[];
  /** Desk seats in the order they fill. */
  seats: Seat[];
  head: { seat: Spot; desk: Spot; monitors: Spot[] };
  /** Spots by the corridor wall for subagents beyond the free desks. */
  stands: Spot[];
  plants: Pt[];
  sofa: Spot;
  table: Pt;
  board: { z: number; length: number };
  frontZ: number;
}

/** The reception's plan, in world coordinates (see Reception): the seat behind the counter, facing
 *  the entrance, and a few spots in front of the counter for anyone else the general manager has. */
export function planReception(): RoomPlan {
  const seat: Spot = { x: RECEPTION.x, z: RECEPTION.z - RECEPTION.d / 2 - 0.62, yaw: 0 };
  const stands: Spot[] = [-1.2, -0.4, 0.4, 1.2].map((dx) => ({ x: RECEPTION.x + dx, z: RECEPTION.z + RECEPTION.d / 2 + 1.0, yaw: Math.PI }));
  return {
    cls: 'small',
    w: LOBBY_W,
    d: LOBBY_D,
    door: { x: RECEPTION.x, width: 1.7 },
    pods: [],
    seats: [],
    head: { seat, desk: seat, monitors: [] },
    stands,
    plants: [],
    sofa: seat,
    table: seat,
    board: { z: 0, length: 0 },
    frontZ: 0,
  };
}

const RANK: Record<RoomClass, number> = { small: 0, medium: 1, large: 2 };

/** The class a room is built at: the larger of the slot's default and the peak number of subagents seen. */
export function roomClassFor(slot: number, peak: number): RoomClass {
  const bySlot: RoomClass = slot === 0 ? 'large' : slot <= 2 ? 'medium' : 'small';
  const byPeak: RoomClass = peak > DESK_CAPACITY.medium ? 'large' : peak > DESK_CAPACITY.small ? 'medium' : 'small';
  return RANK[byPeak] > RANK[bySlot] ? byPeak : bySlot;
}

export function planRoom(cls: RoomClass): RoomPlan {
  const n = cls === 'large' ? 3 : 2;
  const w = cls === 'small' ? 7.0 : 8.6;
  const d = FRONT_Z + n * DESK.w + 2.5;
  const pods = cls === 'small' ? [{ x: -1.5, n }] : [{ x: -2.25, n }, { x: 2.25, n }];

  const all: Seat[] = [];
  for (const side of [-1, 1]) {
    for (let row = 0; row < n; row += 1) {
      for (const pod of pods) {
        const z = FRONT_Z + (row + 0.5) * DESK.w;
        all.push({
          x: pod.x + side * CHAIR_OFFSET,
          z,
          yaw: Math.atan2(-side, 0),
          desk: { x: pod.x + (side * DESK.d) / 2, z, yaw: (side * Math.PI) / 2 },
          monitor: { x: pod.x + side * 0.15, z, yaw: (side * Math.PI) / 2 },
          laneX: pod.x + side * LANE_OFFSET,
        });
      }
    }
  }
  const seats = spreadOut(all);

  const door = { x: w / 2 - 1.5, width: 1.2 };
  const stands: Spot[] = [];
  for (const [z, offset] of [
    [0.5, 0],
    [0.98, 0.31],
  ]) {
    for (let x = -w / 2 + 1.0 + offset; x <= w / 2 - 0.5; x += 0.62) {
      if (Math.abs(x - door.x) < 0.95) continue;
      stands.push({ x, z, yaw: 0 });
    }
  }

  return {
    cls,
    w,
    d,
    door,
    pods,
    seats,
    head: {
      seat: { x: 0, z: d - 0.72, yaw: Math.PI },
      desk: { x: 0, z: d - 1.35, yaw: 0 },
      monitors: [
        { x: -0.3, z: d - 1.55, yaw: 0 },
        { x: 0.3, z: d - 1.55, yaw: 0 },
      ],
    },
    stands,
    plants: [
      { x: -w / 2 + 0.42, z: 0.45 },
      { x: w / 2 - 0.42, z: 0.45 },
      { x: -w / 2 + 0.42, z: d - 0.42 },
      { x: w / 2 - 0.42, z: d - 0.42 },
    ],
    sofa: { x: w / 2 - 1.45, z: d - 0.47, yaw: Math.PI },
    table: { x: w / 2 - 1.45, z: d - 1.3 },
    board: { z: FRONT_Z + n / 2, length: 2.2 },
    frontZ: FRONT_Z,
  };
}

/** Orders seats so each next one is as far as possible from those before it: a few agents
 *  spread over the room, and their bubbles overlap less. */
function spreadOut<T extends Pt>(seats: T[]): T[] {
  const order = seats.slice(0, 1);
  const rest = seats.slice(1);
  while (rest.length > 0) {
    let best = 0;
    let bestDistance = -1;
    rest.forEach((seat, i) => {
      const distance = Math.min(...order.map((o) => Math.hypot(o.x - seat.x, o.z - seat.z)));
      if (distance > bestDistance + 1e-6) {
        bestDistance = distance;
        best = i;
      }
    });
    order.push(rest.splice(best, 1)[0]);
  }
  return order;
}

export type SeatRef = { kind: 'desk' | 'stand'; index: number } | { kind: 'head' };

export function spotOf(plan: RoomPlan, ref: SeatRef): Spot {
  if (ref.kind === 'head') return plan.head.seat;
  if (ref.kind === 'desk') return plan.seats[ref.index];
  return plan.stands[ref.index % plan.stands.length];
}

/** Where an avatar stands up to when it leaves its chair (behind the chair, away from the desk). */
export function standingSpot(plan: RoomPlan, ref: SeatRef): Pt {
  const s = spotOf(plan, ref);
  if (ref.kind === 'stand') return s;
  return { x: s.x - Math.sin(s.yaw) * 0.36, z: s.z - Math.cos(s.yaw) * 0.36 };
}

export function doorOutside(plan: RoomPlan): Pt {
  return { x: plan.door.x, z: -0.6 };
}

export function doorInside(plan: RoomPlan): Pt {
  return { x: plan.door.x, z: 0.55 };
}

/** The walk from the door to a seat, door excluded. */
export function pathToSeat(plan: RoomPlan, ref: SeatRef): Pt[] {
  const inside = doorInside(plan);
  if (ref.kind === 'stand') return [inside, spotOf(plan, ref)];
  if (ref.kind === 'head') {
    const seat = plan.head.seat;
    const back = plan.d - 2.1;
    return [inside, { x: 0, z: WALK_Z }, { x: 0, z: back }, { x: 1.05, z: back }, { x: 1.05, z: seat.z }, seat];
  }
  const seat = plan.seats[ref.index];
  return [inside, { x: seat.laneX, z: WALK_Z }, { x: seat.laneX, z: seat.z }, seat];
}

/** The walk from a seat out through the door. */
export function pathToDoor(plan: RoomPlan, ref: SeatRef): Pt[] {
  const reversed = pathToSeat(plan, ref).reverse();
  reversed.shift(); // the seat itself
  reversed.push(doorOutside(plan));
  return reversed;
}

export interface Placement {
  side: 1 | -1;
  /** Origin: the middle of the room's corridor wall. */
  x: number;
  z: number;
  plan: RoomPlan;
}

export interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface BuildingLayout {
  rooms: Map<string, Placement>;
  corridorEnd: number;
  bounds: Bounds;
}

export interface RoomEntry {
  id: string;
  slot: number;
  cls: RoomClass;
}

/** Even slots go north of the corridor, odd slots south; each side fills from the lobby outwards. */
export function layoutBuilding(entries: RoomEntry[]): BuildingLayout {
  const sorted = [...entries].sort((a, b) => a.slot - b.slot || a.id.localeCompare(b.id));
  const rooms = new Map<string, Placement>();
  let northX = ROOM_GAP;
  let southX = ROOM_GAP;
  let northD = 0;
  let southD = 0;
  for (const entry of sorted) {
    const plan = planRoom(entry.cls);
    const side: 1 | -1 = entry.slot % 2 === 0 ? -1 : 1;
    if (side === -1) {
      rooms.set(entry.id, { side, x: northX + plan.w / 2, z: -CORRIDOR_W / 2, plan });
      northX += plan.w + ROOM_GAP;
      northD = Math.max(northD, plan.d);
    } else {
      rooms.set(entry.id, { side, x: southX + plan.w / 2, z: CORRIDOR_W / 2, plan });
      southX += plan.w + ROOM_GAP;
      southD = Math.max(southD, plan.d);
    }
  }
  const corridorEnd = Math.max(northX, southX, ROOM_GAP * 2 + 1) - ROOM_GAP + 0.8;
  return {
    rooms,
    corridorEnd,
    bounds: {
      minX: -LOBBY_W,
      maxX: corridorEnd,
      minZ: Math.min(-LOBBY_D / 2, -CORRIDOR_W / 2 - northD),
      maxZ: Math.max(LOBBY_D / 2, CORRIDOR_W / 2 + southD + (southD > 0 ? LABEL_SPACE : 0)),
    },
  };
}

export function footprint(p: Placement): Bounds {
  const { w, d } = p.plan;
  const z0 = p.z;
  const z1 = p.z + p.side * d;
  return { minX: p.x - w / 2, maxX: p.x + w / 2, minZ: Math.min(z0, z1), maxZ: Math.max(z0, z1) };
}

export function toWorld(p: Placement, local: Pt): Pt {
  return { x: p.x + local.x, z: p.z + p.side * local.z };
}

export function yawToWorld(p: Placement, yaw: number): number {
  return Math.atan2(Math.sin(yaw), p.side * Math.cos(yaw));
}
