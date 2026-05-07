import {
  crossPathX,
  isInsideMap,
  landmarks,
  mainPathY,
  mapBounds,
  towns,
  woods,
  type House,
  type Landmark,
  type ProceduralWorld,
  type Tree,
  type Vec2
} from '../world.js';
import { circleRectIntersects } from '../collision.js';

export interface StaticWorldRenderInput {
  ctx: CanvasRenderingContext2D;
  world: ProceduralWorld;
  camera: Vec2;
  width: number;
  height: number;
}

export function drawStaticWorld(input: StaticWorldRenderInput): void {
  drawTerrain(input);
  drawWoods(input);
  drawTownGrounds(input);
  drawPaths(input);
  drawLandmarks(input);
  drawHouses(input);
  drawTrees(input);
}

export function drawMapBorder(input: StaticWorldRenderInput & { now: number; wallPulseUntil: number }): void {
  const { ctx, camera, now, wallPulseUntil } = input;
  const x = mapBounds.minX - camera.x;
  const y = mapBounds.minY - camera.y;
  const width = mapBounds.maxX - mapBounds.minX;
  const height = mapBounds.maxY - mapBounds.minY;
  const pulse = Math.max(0, Math.min(1, (wallPulseUntil - now) / 420));
  ctx.save();
  ctx.strokeStyle = 'rgba(12, 14, 11, 0.55)';
  ctx.lineWidth = 22;
  ctx.strokeRect(x - 11, y - 11, width + 22, height + 22);
  ctx.strokeStyle = `rgba(245, 211, 109, ${0.18 + pulse * 0.44})`;
  ctx.lineWidth = 5 + pulse * 5;
  ctx.strokeRect(x, y, width, height);
  ctx.restore();
}

function drawTerrain({ ctx, world, camera, width, height }: StaticWorldRenderInput): void {
  const tile = 86;
  const minX = Math.floor(camera.x / tile) * tile;
  const minY = Math.floor(camera.y / tile) * tile;
  for (let x = minX; x < camera.x + width + tile; x += tile) {
    for (let y = minY; y < camera.y + height + tile; y += tile) {
      if (!isInsideMap({ x: x + tile / 2, y: y + tile / 2 })) {
        ctx.fillStyle = '#11150f';
        ctx.fillRect(Math.floor(x - camera.x), Math.floor(y - camera.y), tile + 1, tile + 1);
        continue;
      }
      const sample = world.terrainAt(x + tile / 2, y + tile / 2);
      ctx.fillStyle = terrainColor(sample.biome, sample.height, sample.moisture, sample.path);
      ctx.fillRect(Math.floor(x - camera.x), Math.floor(y - camera.y), tile + 1, tile + 1);
    }
  }
}

function drawWoods({ ctx, camera }: StaticWorldRenderInput): void {
  for (const wood of woods) {
    const x = wood.x - camera.x;
    const y = wood.y - camera.y;
    ctx.save();
    ctx.fillStyle = 'rgba(24, 64, 43, 0.22)';
    ctx.beginPath();
    ctx.ellipse(x, y, wood.radiusX, wood.radiusY, -0.12, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(21, 46, 32, 0.32)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }
}

function drawTownGrounds({ ctx, camera }: StaticWorldRenderInput): void {
  for (const town of towns) {
    const x = town.x - camera.x;
    const y = town.y - camera.y;
    ctx.save();
    ctx.fillStyle = 'rgba(173, 132, 73, 0.18)';
    ctx.beginPath();
    ctx.ellipse(x, y, town.radius * 0.92, town.radius * 0.54, -0.06, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(235, 196, 116, 0.18)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(x, y, town.radius * 0.55, town.radius * 0.32, 0.04, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(239, 207, 139, 0.2)';
    ctx.beginPath();
    ctx.arc(x, y, 34, 0, Math.PI * 2);
    ctx.fill();
    label(ctx, town.name, x, y - town.radius * 0.43, '#f6df9a');
    ctx.restore();
  }
}

function drawPaths({ ctx, camera, width, height }: StaticWorldRenderInput): void {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(96, 71, 45, 0.32)';
  ctx.lineWidth = 112;
  strokeMainPath(ctx, camera, width);
  strokeCrossPath(ctx, camera, height);
  ctx.strokeStyle = 'rgba(178, 139, 82, 0.82)';
  ctx.lineWidth = 62;
  strokeMainPath(ctx, camera, width);
  strokeCrossPath(ctx, camera, height);
  ctx.strokeStyle = 'rgba(238, 203, 127, 0.16)';
  ctx.lineWidth = 7;
  strokeMainPath(ctx, camera, width);
  strokeCrossPath(ctx, camera, height);
  ctx.restore();
}

function strokeMainPath(ctx: CanvasRenderingContext2D, camera: Vec2, width: number): void {
  ctx.beginPath();
  for (let sx = -120; sx <= width + 120; sx += 64) {
    const wx = camera.x + sx;
    const sy = mainPathY(wx) - camera.y;
    if (sx === -120) ctx.moveTo(sx, sy);
    else ctx.lineTo(sx, sy);
  }
  ctx.stroke();
}

function strokeCrossPath(ctx: CanvasRenderingContext2D, camera: Vec2, height: number): void {
  ctx.beginPath();
  for (let sy = -120; sy <= height + 120; sy += 64) {
    const wy = camera.y + sy;
    const sx = crossPathX(wy) - camera.x;
    if (sy === -120) ctx.moveTo(sx, sy);
    else ctx.lineTo(sx, sy);
  }
  ctx.stroke();
}

function drawHouses({ ctx, world, camera, width, height }: StaticWorldRenderInput): void {
  const houses = world.housesInRect(camera.x - 120, camera.y - 120, camera.x + width + 120, camera.y + height + 120);
  for (const house of houses.sort((a, b) => a.y - b.y)) {
    drawHouse(ctx, camera, house);
  }
}

function drawLandmarks({ ctx, world, camera, width, height }: StaticWorldRenderInput): void {
  const visible = world.landmarksInRect(camera.x - 160, camera.y - 160, camera.x + width + 160, camera.y + height + 160);
  for (const landmark of visible.sort((a, b) => a.y - b.y)) {
    drawLandmark(ctx, camera, landmark);
  }
}

function drawLandmark(ctx: CanvasRenderingContext2D, camera: Vec2, landmark: Landmark): void {
  const x = landmark.x - camera.x;
  const y = landmark.y - camera.y;
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = 'rgba(12, 14, 12, 0.32)';
  ctx.beginPath();
  ctx.ellipse(8, landmark.height * 0.34, landmark.width * 0.58, landmark.height * 0.2, 0, 0, Math.PI * 2);
  ctx.fill();

  if (landmark.kind === 'castle') {
    ctx.fillStyle = '#74766d';
    roundedRect(ctx, -landmark.width / 2, -landmark.height / 2 + 28, landmark.width, landmark.height - 30, 5);
    ctx.fill();
    ctx.strokeStyle = '#3c3d37';
    ctx.lineWidth = 3;
    ctx.stroke();
    for (const tx of [-landmark.width / 2 + 18, landmark.width / 2 - 42]) {
      roundedRect(ctx, tx, -landmark.height / 2 - 4, 34, 62, 4);
      ctx.fill();
      ctx.stroke();
    }
    ctx.fillStyle = '#b7a678';
    ctx.fillRect(-13, 28, 26, 34);
  } else if (landmark.kind === 'mill') {
    ctx.fillStyle = '#7f694c';
    roundedRect(ctx, -42, -34, 84, 74, 5);
    ctx.fill();
    ctx.strokeStyle = '#463828';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = '#5b4733';
    triangle(ctx, 0, -78, 108, 58);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = '#d9b15f';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(53, -18, 28, 0, Math.PI * 2);
    ctx.moveTo(53, -46);
    ctx.lineTo(53, 10);
    ctx.moveTo(25, -18);
    ctx.lineTo(81, -18);
    ctx.stroke();
  } else if (landmark.kind === 'chapel') {
    ctx.fillStyle = '#6d7f78';
    roundedRect(ctx, -48, -24, 96, 70, 5);
    ctx.fill();
    ctx.strokeStyle = '#354642';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = '#4d5b57';
    triangle(ctx, 0, -68, 118, 52);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#d3c38b';
    ctx.fillRect(-8, 10, 16, 34);
    ctx.fillRect(-4, -55, 8, 32);
    ctx.fillRect(-16, -45, 32, 7);
  } else {
    ctx.fillStyle = '#6b574f';
    roundedRect(ctx, -36, -landmark.height / 2, 72, landmark.height, 5);
    ctx.fill();
    ctx.strokeStyle = '#342b28';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = '#c06a50';
    triangle(ctx, 0, -landmark.height / 2 - 42, 88, 58);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#171a15';
    ctx.fillRect(-10, landmark.height / 2 - 42, 20, 42);
  }

  ctx.fillStyle = landmark.marker;
  ctx.beginPath();
  ctx.arc(landmark.width / 2 - 8, -landmark.height / 2 - 12, 7, 0, Math.PI * 2);
  ctx.fill();
  label(ctx, landmark.name, 0, -landmark.height / 2 - 30, '#f7d88f');
  ctx.restore();
}

function drawHouse(ctx: CanvasRenderingContext2D, camera: Vec2, house: House): void {
  const x = house.x - camera.x;
  const y = house.y - camera.y;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(house.rotation);
  ctx.fillStyle = 'rgba(18, 20, 17, 0.24)';
  ctx.beginPath();
  ctx.ellipse(5, house.height * 0.46, house.width * 0.65, house.height * 0.24, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = house.wall;
  roundedRect(ctx, -house.width / 2, -house.height / 2, house.width, house.height, 4);
  ctx.fill();
  ctx.strokeStyle = 'rgba(47, 36, 24, 0.55)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = house.roof;
  ctx.beginPath();
  ctx.moveTo(-house.width / 2 - 8, -house.height / 2 + 4);
  ctx.lineTo(0, -house.height / 2 - 25);
  ctx.lineTo(house.width / 2 + 8, -house.height / 2 + 4);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#3f3024';
  ctx.fillRect(-7, house.height / 2 - 24, 14, 24);
  ctx.fillStyle = 'rgba(240, 199, 122, 0.75)';
  ctx.fillRect(-house.width / 2 + 12, -6, 12, 10);
  if (house.kind !== 'shed') {
    ctx.fillRect(house.width / 2 - 24, -6, 12, 10);
  }
  ctx.restore();
}

function drawTrees({ ctx, world, camera, width, height }: StaticWorldRenderInput): void {
  const houses = world.housesInRect(camera.x - 120, camera.y - 120, camera.x + width + 120, camera.y + height + 120);
  const landmarksInView = world.landmarksInRect(camera.x - 180, camera.y - 180, camera.x + width + 180, camera.y + height + 180);
  const trees = world.treesInRect(camera.x - 80, camera.y - 80, camera.x + width + 80, camera.y + height + 80);
  for (const tree of trees) {
    if (treeOverlapsStructures(tree, houses, landmarksInView)) continue;
    const x = tree.x - camera.x;
    const y = tree.y - camera.y;
    ctx.fillStyle = 'rgba(18, 24, 18, 0.22)';
    ctx.beginPath();
    ctx.ellipse(x + 5, y + tree.size * 0.72, tree.size * 0.72, tree.size * 0.28, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#5a3f2a';
    ctx.fillRect(x - 2, y, 4, tree.size * 0.95);
    if (tree.kind === 'pine') {
      ctx.fillStyle = '#214d3a';
      triangle(ctx, x, y - tree.size * 0.85, tree.size * 0.88, tree.size * 1.55);
      ctx.fillStyle = '#2d684c';
      triangle(ctx, x, y - tree.size * 1.18, tree.size * 0.62, tree.size * 1.18);
    } else {
      ctx.fillStyle = tree.kind === 'birch' ? '#779b65' : '#376a42';
      ctx.beginPath();
      ctx.arc(x, y - tree.size * 0.35, tree.size * 0.82, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(195, 205, 146, 0.2)';
      ctx.beginPath();
      ctx.arc(x - tree.size * 0.25, y - tree.size * 0.62, tree.size * 0.28, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function terrainColor(biome: string, height: number, moisture: number, path: number): string {
  if (path > 0.45) return '#a98253';
  if (biome === 'stone') return blend('#7d8578', '#555d55', height);
  if (biome === 'wetland') return blend('#496f64', '#6d815f', moisture);
  if (biome === 'pine') return blend('#3e6a47', '#244d39', moisture);
  if (biome === 'heath') return blend('#756f4c', '#6a7d52', height);
  return blend('#6f8f54', '#8b995c', moisture);
}

function blend(a: string, b: string, t: number): string {
  const left = parseHex(a);
  const right = parseHex(b);
  const mix = Math.max(0, Math.min(1, t));
  return `rgb(${Math.round(left[0] + (right[0] - left[0]) * mix)}, ${Math.round(left[1] + (right[1] - left[1]) * mix)}, ${Math.round(left[2] + (right[2] - left[2]) * mix)})`;
}

function parseHex(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16)
  ];
}

function triangle(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number): void {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + width / 2, y + height);
  ctx.lineTo(x - width / 2, y + height);
  ctx.closePath();
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string): void {
  ctx.save();
  ctx.font = '700 15px Georgia, serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(24, 27, 20, 0.75)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function treeCollisionCenter(tree: Tree): Vec2 {
  return { x: tree.x, y: tree.y - tree.size * 0.28 };
}

function treeCollisionRadius(tree: Tree): number {
  return Math.max(10, tree.size * 0.62);
}

function treeOverlapsStructures(tree: Tree, houses: House[], landmarksInView: Landmark[]): boolean {
  const center = treeCollisionCenter(tree);
  const radius = treeCollisionRadius(tree) + 10;
  return houses.some((house) => circleRectIntersects(
    center,
    radius,
    { x: house.x - house.width / 2 - 10, y: house.y - house.height / 2 - 10, width: house.width + 20, height: house.height + 20 }
  )) || landmarksInView.some((landmark) => circleRectIntersects(
    center,
    radius,
    { x: landmark.x - landmark.width / 2 - 18, y: landmark.y - landmark.height / 2 - 18, width: landmark.width + 36, height: landmark.height + 36 }
  ));
}
