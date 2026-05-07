import { clampToMap, isInsideMap, towns, type ProceduralWorld, type Vec2 } from './world.js';

export function findSafeSpawn(initial: Vec2, world: ProceduralWorld, radius: number): Vec2 {
  const candidates: Vec2[] = [initial];
  for (const town of towns) {
    for (const searchRadius of [150, 220, 300, 380, 470]) {
      for (let step = 0; step < 12; step += 1) {
        const angle = (Math.PI * 2 * step) / 12 + searchRadius * 0.017;
        candidates.push(clampToMap({
          x: town.x + Math.cos(angle) * searchRadius,
          y: town.y + Math.sin(angle) * searchRadius * 0.62
        }, 80));
      }
    }
  }

  return candidates.find((candidate) => (
    isInsideMap(candidate, 80) &&
    !staticCollisionAt(candidate, radius + 3, world)
  )) ?? initial;
}

export function resolvePlayerMove(previous: Vec2, desired: Vec2, radius: number, world: ProceduralWorld): Vec2 {
  const candidates = [
    desired,
    { x: desired.x, y: previous.y },
    { x: previous.x, y: desired.y }
  ];
  for (const candidate of candidates) {
    if (!playerCollisionAt(candidate, radius, world)) return candidate;
  }
  return previous;
}

export function playerCollisionAt(point: Vec2, radius: number, world: ProceduralWorld): boolean {
  if (!isInsideMap(point, radius)) return true;
  return staticCollisionAt(point, radius, world);
}

export function canNpcStand(point: Vec2, world: ProceduralWorld): boolean {
  if (!isInsideMap(point, 18)) return false;
  return !staticCollisionAt(point, 16, world);
}

export function staticCollisionAt(point: Vec2, radius: number, world: ProceduralWorld): boolean {
  const houses = world.housesInRect(point.x - 96, point.y - 96, point.x + 96, point.y + 96);
  if (houses.some((house) => circleRectIntersects(
    point,
    radius,
    { x: house.x - house.width / 2, y: house.y - house.height / 2, width: house.width, height: house.height }
  ))) return true;

  const nearbyLandmarks = world.landmarksInRect(point.x - 160, point.y - 160, point.x + 160, point.y + 160);
  if (nearbyLandmarks.some((landmark) => circleRectIntersects(
    point,
    radius,
    { x: landmark.x - landmark.width / 2, y: landmark.y - landmark.height / 2, width: landmark.width, height: landmark.height }
  ))) return true;

  return false;
}

export function circleRectIntersects(
  circle: Vec2,
  radius: number,
  rect: { x: number; y: number; width: number; height: number }
): boolean {
  const closestX = Math.max(rect.x, Math.min(circle.x, rect.x + rect.width));
  const closestY = Math.max(rect.y, Math.min(circle.y, rect.y + rect.height));
  return Math.hypot(circle.x - closestX, circle.y - closestY) < radius;
}
