// Colors of the office. The department colors are the same hex values as the --dept-* tokens
// in client/styles/base.css, so a room, its shirts and its panel all read as one color.

import type { DepartmentColor } from '../../shared/types';

export const DEPARTMENT_HEX: Record<DepartmentColor, string> = {
  stone: '#b7b1a6',
  amber: '#e6b455',
  moss: '#7fb069',
  sky: '#6cb4e4',
  indigo: '#8b8cff',
  plum: '#b784d8',
  rose: '#e58a9a',
};

export const COLORS = {
  ground: '#15171e',
  grid: '#2b2f3b',
  floor: '#ebe2d0',
  corridor: '#e6dcc7',
  wall: '#f7f5f0',
  wood: '#dfc59d',
  woodDark: '#cdb085',
  tabletop: '#f4f0e8',
  dark: '#2b2e37',
  board: '#23262e',
  screenOff: '#3a3e49',
  screenOn: '#d4ecff',
  sofa: '#d1a27a',
  cushion: '#ddb591',
  pot: '#f0ece5',
  leaf: '#62a05a',
  leafDeep: '#4b8a49',
  pants: '#2d3039',
  mat: '#33363f',
  rug: '#ddd6ca',
  eye: '#1b1c20',
  waiting: '#f0b35a',
  failed: '#ef7c7c',
  highlight: '#ffffff',
} as const;

export const CHAIR_COLORS = ['#f4f1eb', '#e9b68e', '#bdcbb0', '#dcd6cb'];
export const SKIN_TONES = ['#f2cba8', '#e0ab80', '#c68b5f', '#97633f', '#f6d8bd', '#70492f'];
export const HAIR_COLORS = ['#2b211b', '#4b3426', '#19191c', '#7a4f2e', '#a5713d', '#3b2c25'];

function parse(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Mixes two sRGB hex colors; t = 0 gives a, t = 1 gives b. */
export function mix(a: string, b: string, t: number): string {
  const pa = parse(a);
  const pb = parse(b);
  const out = pa.map((v, i) => Math.round(v + (pb[i] - v) * t));
  return `#${out.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** The room floor tint: the department color, softened. */
export function floorTint(color: DepartmentColor): string {
  return mix(DEPARTMENT_HEX[color], '#ffffff', 0.32);
}

/** The manager's shirt: the department color, darkened. */
export function managerShirt(color: DepartmentColor): string {
  return mix(DEPARTMENT_HEX[color], '#1d2029', 0.5);
}

/** A stable small hash, so an agent keeps its look across reloads. */
export function hashString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
