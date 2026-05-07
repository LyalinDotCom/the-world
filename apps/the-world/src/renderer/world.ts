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

export interface House {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  wall: string;
  roof: string;
  kind: 'cottage' | 'shed' | 'wayhouse';
}

export interface MapBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Town {
  id: string;
  name: string;
  x: number;
  y: number;
  radius: number;
  accent: string;
}

export interface Wood {
  id: string;
  name: string;
  x: number;
  y: number;
  radiusX: number;
  radiusY: number;
}

export interface GeneratedNpc extends NpcDefinition {
  x: number;
  y: number;
  color: string;
  lastBarkAt: number;
  lastOverheardAt: number;
  wanderSeed: number;
  wanderRadius: number;
  wanderSpeed: number;
  groupId?: string;
  conversationPolicy: 'open' | 'private';
}

const chunkSize = 896;
const names = ['Orin', 'Elda', 'Mara', 'Bren', 'Tamsin', 'Vale', 'Nessa', 'Corvin', 'Iri', 'Holt', 'Sable', 'Rowan', 'Dain', 'Lysa', 'Perrin'];
const roles = ['wayfinder', 'charcoal burner', 'road guard', 'mender', 'forager', 'bell keeper', 'miller', 'peddler', 'stone cutter', 'herbalist'];
const traits = ['watchful', 'dry-humored', 'superstitious', 'kind', 'tired', 'blunt', 'patient', 'secretive', 'restless'];
const moods: NpcMood[] = ['calm', 'curious', 'wary', 'busy', 'lonely', 'cheerful', 'afraid'];
const colors = ['#c56c45', '#d5a34e', '#6f9d7a', '#7b8fc6', '#b86f8d', '#86a0a8', '#b9a36a'];

export const mapBounds: MapBounds = {
  minX: -2600,
  minY: -2100,
  maxX: 3900,
  maxY: 2500
};

export const towns: Town[] = [
  { id: 'rivergate', name: 'Rivergate', x: -1480, y: mainPathY(-1480) - 80, radius: 440, accent: '#c47a45' },
  { id: 'mosswake', name: 'Mosswake', x: 760, y: mainPathY(760) + 250, radius: 390, accent: '#7fa56b' },
  { id: 'cindervale', name: 'Cindervale', x: 2860, y: mainPathY(2860) - 120, radius: 420, accent: '#b95f46' }
];

export const woods: Wood[] = [
  { id: 'hollow-pines', name: 'Hollow Pines', x: -2100, y: 860, radiusX: 560, radiusY: 390 },
  { id: 'mothwood', name: 'Mothwood', x: 60, y: -1320, radiusX: 700, radiusY: 430 },
  { id: 'wolfmoon-wood', name: 'Wolfmoon Wood', x: 2500, y: 980, radiusX: 650, radiusY: 460 }
];

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
    const namedWood = woodAt({ x, y });
    let biome: TerrainSample['biome'] = 'meadow';
    if (height > 0.72) biome = 'stone';
    else if (moisture > 0.68) biome = 'wetland';
    else if (namedWood) biome = 'pine';
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
        const x = gx * cell + 18 + (rnd % 61);
        const y = gy * cell + 18 + ((rnd >>> 8) % 61);
        const namedWood = woodAt({ x, y });
        if (rnd % 100 > (namedWood ? 82 : 47)) continue;
        if (!isInsideMap({ x, y }, 24)) continue;
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

  housesInRect(minX: number, minY: number, maxX: number, maxY: number): House[] {
    const houses: House[] = [];
    for (const town of towns) {
      for (let i = 0; i < 24; i += 1) {
        const rnd = hash2(i, Math.floor(town.x), this.seed ^ town.id.length);
        const angle = (i / 24) * Math.PI * 2 + ((rnd % 80) - 40) * 0.005;
        const ring = i % 5 === 0 ? 0.28 : i % 3 === 0 ? 0.48 : 0.66;
        const x = town.x + Math.cos(angle) * town.radius * ring + ((rnd >>> 8) % 56) - 28;
        const y = town.y + Math.sin(angle) * town.radius * ring * 0.58 + ((rnd >>> 14) % 46) - 23;
        if (!rectContains(minX, minY, maxX, maxY, x, y)) continue;
        const kind: House['kind'] = i % 7 === 0 ? 'wayhouse' : i % 4 === 0 ? 'shed' : 'cottage';
        houses.push({
          x,
          y,
          width: kind === 'wayhouse' ? 86 : kind === 'shed' ? 48 : 62,
          height: kind === 'wayhouse' ? 58 : kind === 'shed' ? 38 : 46,
          rotation: angle + Math.PI / 2 + (((rnd >>> 20) % 14) - 7) * 0.025,
          wall: kind === 'shed' ? '#67553f' : '#907a58',
          roof: kind === 'wayhouse' ? town.accent : '#604936',
          kind
        });
      }
    }

    const cell = 720;
    const startX = Math.floor(minX / cell) - 1;
    const endX = Math.floor(maxX / cell) + 1;
    const startY = Math.floor(minY / cell) - 1;
    const endY = Math.floor(maxY / cell) + 1;

    for (let gx = startX; gx <= endX; gx += 1) {
      for (let gy = startY; gy <= endY; gy += 1) {
        const rnd = hash2(gx, gy, this.seed ^ 0x4451);
        if (rnd % 100 > 36) continue;
        let x = gx * cell + 130 + (rnd % (cell - 260));
        let y = gy * cell + 130 + ((rnd >>> 8) % (cell - 260));
        if (!isInsideMap({ x, y })) continue;
        if (nearestTown({ x, y }).distance < 540) continue;
        const nearPath = rnd % 2 === 0;
        if (nearPath) {
          const routeY = mainPathY(x);
          y = routeY + (((rnd >>> 15) % 2 === 0 ? -1 : 1) * (110 + ((rnd >>> 17) % 90)));
        }
        if (!isInsideMap({ x, y }, 58)) continue;
        const terrain = this.terrainAt(x, y);
        if (terrain.biome === 'wetland' || terrain.biome === 'stone') continue;
        const kind: House['kind'] = rnd % 7 === 0 ? 'wayhouse' : rnd % 3 === 0 ? 'shed' : 'cottage';
        houses.push({
          x,
          y,
          width: kind === 'wayhouse' ? 82 : kind === 'shed' ? 48 : 62,
          height: kind === 'wayhouse' ? 60 : kind === 'shed' ? 38 : 46,
          rotation: (((rnd >>> 21) % 15) - 7) * 0.018,
          wall: kind === 'shed' ? '#6d5840' : '#8a7656',
          roof: kind === 'wayhouse' ? '#8f4638' : '#5f4936',
          kind
        });
      }
    }
    return houses;
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
    const chunkCenter = {
      x: cx * chunkSize + chunkSize / 2,
      y: cy * chunkSize + chunkSize / 2
    };
    if (!rectContains(mapBounds.minX - chunkSize, mapBounds.minY - chunkSize, mapBounds.maxX + chunkSize, mapBounds.maxY + chunkSize, chunkCenter.x, chunkCenter.y)) {
      this.npcChunks.set(key, []);
      return [];
    }
    const townHit = nearestTown(chunkCenter);
    const count = townHit.distance < townHit.town.radius + 260
      ? 3 + (rnd % 2)
      : rnd % 100 < 26 ? 2 : rnd % 100 < 72 ? 1 : 0;
    const privateGroupId = count > 1 && rnd % 100 < 62 ? `group.${Math.abs(cx)}.${Math.abs(cy)}.${rnd % 97}` : undefined;
    const npcs: GeneratedNpc[] = [];
    for (let i = 0; i < count; i += 1) {
      const localSeed = hash2(cx * 7 + i, cy * 11 - i, this.seed);
      let x = cx * chunkSize + 120 + (localSeed % (chunkSize - 240));
      let y = cy * chunkSize + 120 + ((localSeed >>> 9) % (chunkSize - 240));
      const placedNearTown = townHit.distance < townHit.town.radius + 260;
      if (placedNearTown) {
        const angle = ((localSeed % 628) / 100) + i * 1.7;
        const radius = 90 + ((localSeed >>> 12) % Math.max(160, Math.floor(townHit.town.radius * 0.72)));
        x = townHit.town.x + Math.cos(angle) * radius;
        y = townHit.town.y + Math.sin(angle) * radius * 0.58;
      }
      const routeY = mainPathY(x);
      if (!placedNearTown && (Math.abs(y - routeY) < 280 || localSeed % 100 < 38)) {
        y = routeY + ((localSeed >>> 12) % 320) - 160;
      }
      const conversationPolicy: GeneratedNpc['conversationPolicy'] = privateGroupId && i < 2 ? 'private' : 'open';
      if (privateGroupId && conversationPolicy === 'private' && i > 0 && npcs[0]) {
        x = npcs[0].x + 58 + ((localSeed >>> 14) % 72);
        y = npcs[0].y - 42 + ((localSeed >>> 17) % 84);
      }
      const clamped = clampToMap({ x, y }, 92);
      x = clamped.x;
      y = clamped.y;
      if (!isInsideMap({ x, y }, 60)) continue;
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
        wanderSeed: localSeed,
        wanderRadius: conversationPolicy === 'private' ? 18 + ((localSeed >>> 18) % 24) : 28 + ((localSeed >>> 18) % 58),
        wanderSpeed: 0.00016 + ((localSeed >>> 22) % 6) * 0.000025,
        groupId: conversationPolicy === 'private' ? privateGroupId : undefined,
        conversationPolicy,
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
          rules: [
            'Do not reveal hidden causes behind local mysteries.',
            'Keep replies short enough for in-game dialogue.',
            ...(conversationPolicy === 'private'
              ? ['You are in a private conversation. If the player interrupts, refuse briefly and return to your group.']
              : [])
          ]
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

export function wanderedNpcPosition(npc: GeneratedNpc, nowMs: number): Vec2 {
  const t = nowMs * npc.wanderSpeed;
  const phaseA = (npc.wanderSeed % 628) / 100;
  const phaseB = ((npc.wanderSeed >>> 8) % 628) / 100;
  const radius = npc.wanderRadius;
  return {
    x: npc.x + Math.cos(t + phaseA) * radius * 0.72 + Math.sin(t * 0.37 + phaseB) * radius * 0.28,
    y: npc.y + Math.sin(t * 0.84 + phaseB) * radius * 0.5
  };
}

export function randomTownSpawn(): Vec2 {
  const town = towns[Math.floor(Math.random() * towns.length)] ?? towns[0]!;
  const angle = Math.random() * Math.PI * 2;
  const radius = 130 + Math.random() * 180;
  return clampToMap({
    x: town.x + Math.cos(angle) * radius,
    y: town.y + Math.sin(angle) * radius * 0.62
  }, 80);
}

export function clampToMap(point: Vec2, margin = 0): Vec2 {
  return {
    x: Math.max(mapBounds.minX + margin, Math.min(mapBounds.maxX - margin, point.x)),
    y: Math.max(mapBounds.minY + margin, Math.min(mapBounds.maxY - margin, point.y))
  };
}

export function isInsideMap(point: Vec2, margin = 0): boolean {
  return point.x >= mapBounds.minX + margin &&
    point.x <= mapBounds.maxX - margin &&
    point.y >= mapBounds.minY + margin &&
    point.y <= mapBounds.maxY - margin;
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
  const town = townAt({ x, y });
  if (town) return town.name;
  const wood = woodAt({ x, y });
  if (wood) return wood.name;
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

function townAt(point: Vec2): Town | undefined {
  return towns.find((town) => distance(point, town) < town.radius);
}

export function nearestTown(point: Vec2): { town: Town; distance: number } {
  let best = towns[0]!;
  let bestDistance = distance(point, best);
  for (const town of towns.slice(1)) {
    const current = distance(point, town);
    if (current < bestDistance) {
      best = town;
      bestDistance = current;
    }
  }
  return { town: best, distance: bestDistance };
}

function woodAt(point: Vec2): Wood | undefined {
  return woods.find((wood) => {
    const dx = (point.x - wood.x) / wood.radiusX;
    const dy = (point.y - wood.y) / wood.radiusY;
    return dx * dx + dy * dy < 1;
  });
}

function rectContains(minX: number, minY: number, maxX: number, maxY: number, x: number, y: number): boolean {
  return x >= minX && x <= maxX && y >= minY && y <= maxY;
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
