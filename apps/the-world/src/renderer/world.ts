import type { NpcDefinition, NpcMood } from '@game-llm/core';

export interface Vec2 {
  x: number;
  y: number;
}

export interface TerrainSample {
  height: number;
  moisture: number;
  path: number;
  hill: number;
  biome: 'meadow' | 'pine' | 'heath' | 'stone' | 'wetland';
}

export interface Tree {
  x: number;
  y: number;
  size: number;
  kind: 'oak' | 'pine' | 'birch';
}

export interface Hill {
  x: number;
  y: number;
  radius: number;
  height: number;
}

export interface GeneratedNpc extends NpcDefinition {
  x: number;
  y: number;
  color: string;
  lastBarkAt: number;
  lastOverheardAt: number;
}

const chunkSize = 896;
const names = ['Orin', 'Elda', 'Mara', 'Bren', 'Tamsin', 'Vale', 'Nessa', 'Corvin', 'Iri', 'Holt', 'Sable', 'Rowan', 'Dain', 'Lysa', 'Perrin'];
const roles = ['wayfinder', 'charcoal burner', 'road guard', 'mender', 'forager', 'bell keeper', 'miller', 'peddler', 'stone cutter', 'herbalist'];
const traits = ['watchful', 'dry-humored', 'superstitious', 'kind', 'tired', 'blunt', 'patient', 'secretive', 'restless'];
const moods: NpcMood[] = ['calm', 'curious', 'wary', 'busy', 'lonely', 'cheerful', 'afraid'];
const colors = ['#c56c45', '#d5a34e', '#6f9d7a', '#7b8fc6', '#b86f8d', '#86a0a8', '#b9a36a'];

export class ProceduralWorld {
  readonly seed: number;
  private readonly npcChunks = new Map<string, GeneratedNpc[]>();

  constructor(seedText = 'the-world') {
    this.seed = hashString(seedText);
  }

  terrainAt(x: number, y: number): TerrainSample {
    const height = layeredNoise(x * 0.0015, y * 0.0015, this.seed);
    const moisture = layeredNoise(x * 0.0012 + 20, y * 0.0012 - 10, this.seed ^ 0x75a5);
    const path = pathStrength(x, y);
    const hill = Math.max(0, height - 0.58) * 2;
    let biome: TerrainSample['biome'] = 'meadow';
    if (height > 0.72) biome = 'stone';
    else if (moisture > 0.68) biome = 'wetland';
    else if (height > 0.56) biome = 'heath';
    else if (moisture < 0.42) biome = 'pine';
    return { height, moisture, path, hill, biome };
  }

  treesInRect(minX: number, minY: number, maxX: number, maxY: number): Tree[] {
    const trees: Tree[] = [];
    const cell = 96;
    const startX = Math.floor(minX / cell) - 1;
    const endX = Math.floor(maxX / cell) + 1;
    const startY = Math.floor(minY / cell) - 1;
    const endY = Math.floor(maxY / cell) + 1;

    for (let gx = startX; gx <= endX; gx += 1) {
      for (let gy = startY; gy <= endY; gy += 1) {
        const rnd = hash2(gx, gy, this.seed);
        if (rnd % 100 > 47) continue;
        const x = gx * cell + 18 + (rnd % 61);
        const y = gy * cell + 18 + ((rnd >>> 8) % 61);
        const terrain = this.terrainAt(x, y);
        if (terrain.path > 0.32 || terrain.biome === 'stone' || terrain.biome === 'wetland') continue;
        trees.push({
          x,
          y,
          size: 11 + (rnd % 13),
          kind: terrain.biome === 'pine' ? 'pine' : rnd % 5 === 0 ? 'birch' : 'oak'
        });
      }
    }
    return trees;
  }

  hillsInRect(minX: number, minY: number, maxX: number, maxY: number): Hill[] {
    const hills: Hill[] = [];
    const cell = 420;
    const startX = Math.floor(minX / cell) - 1;
    const endX = Math.floor(maxX / cell) + 1;
    const startY = Math.floor(minY / cell) - 1;
    const endY = Math.floor(maxY / cell) + 1;

    for (let gx = startX; gx <= endX; gx += 1) {
      for (let gy = startY; gy <= endY; gy += 1) {
        const rnd = hash2(gx, gy, this.seed ^ 0x9e37);
        if (rnd % 100 > 33) continue;
        const x = gx * cell + 80 + (rnd % 250);
        const y = gy * cell + 80 + ((rnd >>> 8) % 250);
        const terrain = this.terrainAt(x, y);
        if (terrain.path > 0.45) continue;
        hills.push({
          x,
          y,
          radius: 100 + (rnd % 130),
          height: terrain.height
        });
      }
    }
    return hills;
  }

  npcsNear(x: number, y: number, radius: number): GeneratedNpc[] {
    const minCx = Math.floor((x - radius) / chunkSize);
    const maxCx = Math.floor((x + radius) / chunkSize);
    const minCy = Math.floor((y - radius) / chunkSize);
    const maxCy = Math.floor((y + radius) / chunkSize);
    const npcs: GeneratedNpc[] = [];
    for (let cx = minCx; cx <= maxCx; cx += 1) {
      for (let cy = minCy; cy <= maxCy; cy += 1) {
        npcs.push(...this.npcsForChunk(cx, cy));
      }
    }
    return npcs.filter((npc) => distance(npc, { x, y }) <= radius);
  }

  private npcsForChunk(cx: number, cy: number): GeneratedNpc[] {
    const key = `${cx},${cy}`;
    const cached = this.npcChunks.get(key);
    if (cached) return cached;

    const rnd = hash2(cx, cy, this.seed ^ 0x533d);
    const count = rnd % 100 < 26 ? 2 : rnd % 100 < 78 ? 1 : 0;
    const npcs: GeneratedNpc[] = [];
    for (let i = 0; i < count; i += 1) {
      const localSeed = hash2(cx * 7 + i, cy * 11 - i, this.seed);
      let x = cx * chunkSize + 120 + (localSeed % (chunkSize - 240));
      let y = cy * chunkSize + 120 + ((localSeed >>> 9) % (chunkSize - 240));
      const routeY = mainPathY(x);
      if (Math.abs(y - routeY) < 280 || localSeed % 100 < 38) {
        y = routeY + ((localSeed >>> 12) % 320) - 160;
      }
      const name = names[localSeed % names.length]!;
      const role = roles[(localSeed >>> 4) % roles.length]!;
      const mood = moods[(localSeed >>> 7) % moods.length]!;
      const id = `npc.${slug(name)}.${Math.abs(cx)}.${Math.abs(cy)}.${i}`;
      npcs.push({
        id,
        x,
        y,
        color: colors[(localSeed >>> 10) % colors.length]!,
        lastBarkAt: 0,
        lastOverheardAt: 0,
        persona: {
          name,
          role,
          mood,
          traits: [
            traits[(localSeed >>> 13) % traits.length]!,
            traits[(localSeed >>> 16) % traits.length]!
          ],
          speechStyle: speechStyleFor(role, mood),
          goals: [`keep moving through ${regionName(x, y)}`, 'learn which paths are safe tonight'],
          knows: ['old roads move after storms', 'the old mill is avoided after dark'],
          doesNotKnow: ['the true cause of the old mill turning at night'],
          rules: ['Do not reveal hidden causes behind local mysteries.', 'Keep replies short enough for in-game dialogue.']
        },
        memory: {
          scope: 'npc',
          maxEntries: 8
        }
      });
    }
    this.npcChunks.set(key, npcs);
    return npcs;
  }
}

export function pathStrength(x: number, y: number): number {
  const main = 1 - Math.min(1, Math.abs(y - mainPathY(x)) / 64);
  const cross = 1 - Math.min(1, Math.abs(x - crossPathX(y)) / 52);
  return Math.max(0, main, cross * 0.88);
}

export function mainPathY(x: number): number {
  return Math.sin(x * 0.00085) * 520 + Math.sin(x * 0.0021 + 1.4) * 130;
}

export function crossPathX(y: number): number {
  return 950 + Math.sin(y * 0.0012) * 360;
}

export function regionName(x: number, y: number): string {
  const bands = ['Low Bell Road', 'Mosswake', 'The West Rise', 'Cinderfen', 'Waystone Vale', 'Hollow Pines'];
  return bands[Math.abs(hash2(Math.floor(x / 1800), Math.floor(y / 1800), 91)) % bands.length]!;
}

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function speechStyleFor(role: string, mood: string): string {
  if (role.includes('guard')) return 'watchful, clipped, practical, suspicious of easy answers';
  if (role.includes('peddler')) return 'quick, colorful, bargaining even when afraid';
  if (mood === 'afraid') return 'hushed, brief, avoids naming dangers directly';
  return 'plainspoken, local, slightly strange, no modern slang';
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function layeredNoise(x: number, y: number, seed: number): number {
  return (
    valueNoise(x, y, seed) * 0.55 +
    valueNoise(x * 2.1 + 11, y * 2.1 - 7, seed ^ 0x40) * 0.3 +
    valueNoise(x * 4.3 - 5, y * 4.3 + 3, seed ^ 0x99) * 0.15
  );
}

function valueNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smooth(x - x0);
  const ty = smooth(y - y0);
  const a = unitHash(x0, y0, seed);
  const b = unitHash(x0 + 1, y0, seed);
  const c = unitHash(x0, y0 + 1, seed);
  const d = unitHash(x0 + 1, y0 + 1, seed);
  return lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function unitHash(x: number, y: number, seed: number): number {
  return (hash2(x, y, seed) >>> 0) / 0xffffffff;
}

function hashString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function hash2(x: number, y: number, seed: number): number {
  let h = seed ^ 0x9e3779b9;
  h = Math.imul(h ^ x, 0x85ebca6b);
  h = Math.imul(h ^ y, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
