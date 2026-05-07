import {
  crossPathX,
  landmarks,
  mainPathY,
  mapBounds,
  towns,
  woods,
  type GeneratedNpc,
  type MapBounds,
  type Vec2
} from './world.js';

export interface ViewportSize {
  width: number;
  height: number;
}

export interface MinimapRenderInput {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  dpr: number;
  player: Vec2;
  npcs: GeneratedNpc[];
  constables: Vec2[];
  npcPosition(npc: GeneratedNpc): Vec2;
}

export function cameraForPoint(point: Vec2, viewport: ViewportSize, bounds: MapBounds = mapBounds): Vec2 {
  return {
    x: clampCameraAxis(point.x - viewport.width / 2, bounds.minX, bounds.maxX, viewport.width),
    y: clampCameraAxis(point.y - viewport.height / 2, bounds.minY, bounds.maxY, viewport.height)
  };
}

export function clampCameraAxis(value: number, min: number, max: number, viewport: number): number {
  const size = max - min;
  if (size <= viewport) return min - (viewport - size) / 2;
  return Math.max(min, Math.min(max - viewport, value));
}

export function drawMinimap(input: MinimapRenderInput): void {
  const { canvas, context, dpr, player, npcs, constables, npcPosition } = input;
  const width = canvas.width / dpr;
  const height = canvas.height / dpr;
  const pad = 12;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  context.fillStyle = 'rgba(19, 24, 18, 0.96)';
  context.fillRect(0, 0, width, height);

  const mapWidth = mapBounds.maxX - mapBounds.minX;
  const mapHeight = mapBounds.maxY - mapBounds.minY;
  const scale = Math.min((width - pad * 2) / mapWidth, (height - pad * 2) / mapHeight);
  const offsetX = (width - mapWidth * scale) / 2;
  const offsetY = (height - mapHeight * scale) / 2;
  const toMini = (point: Vec2) => ({
    x: offsetX + (point.x - mapBounds.minX) * scale,
    y: offsetY + (point.y - mapBounds.minY) * scale
  });

  context.strokeStyle = 'rgba(238, 211, 149, 0.24)';
  context.lineWidth = 1;
  context.strokeRect(offsetX, offsetY, mapWidth * scale, mapHeight * scale);

  for (const wood of woods) {
    const point = toMini(wood);
    context.fillStyle = 'rgba(44, 105, 67, 0.45)';
    context.beginPath();
    context.ellipse(point.x, point.y, wood.radiusX * scale, wood.radiusY * scale, -0.12, 0, Math.PI * 2);
    context.fill();
  }

  context.save();
  context.lineCap = 'round';
  context.strokeStyle = 'rgba(190, 151, 87, 0.72)';
  context.lineWidth = 4;
  context.beginPath();
  for (let wx = mapBounds.minX; wx <= mapBounds.maxX; wx += 120) {
    const point = toMini({ x: wx, y: mainPathY(wx) });
    if (wx === mapBounds.minX) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  }
  context.stroke();
  context.beginPath();
  for (let wy = mapBounds.minY; wy <= mapBounds.maxY; wy += 120) {
    const point = toMini({ x: crossPathX(wy), y: wy });
    if (wy === mapBounds.minY) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  }
  context.stroke();
  context.restore();

  context.font = '10px Georgia, serif';
  context.textAlign = 'center';
  for (const town of towns) {
    const point = toMini(town);
    context.fillStyle = town.accent;
    context.beginPath();
    context.arc(point.x, point.y, Math.max(4, town.radius * scale * 0.34), 0, Math.PI * 2);
    context.fill();
    context.fillStyle = '#f1e5c7';
    context.fillText(town.name, point.x, point.y - 9);
  }

  for (const landmark of landmarks) {
    const point = toMini(landmark);
    context.fillStyle = landmark.marker;
    context.strokeStyle = '#10120f';
    context.lineWidth = 1.5;
    context.beginPath();
    context.moveTo(point.x, point.y - 6);
    context.lineTo(point.x + 6, point.y);
    context.lineTo(point.x, point.y + 6);
    context.lineTo(point.x - 6, point.y);
    context.closePath();
    context.fill();
    context.stroke();
  }

  for (const npc of npcs.slice(0, 24)) {
    const point = toMini(npcPosition(npc));
    context.fillStyle = npc.conversationPolicy === 'private' ? '#e3bd65' : '#cdd8b3';
    context.fillRect(point.x - 1.5, point.y - 1.5, 3, 3);
  }

  for (const constable of constables) {
    const point = toMini(constable);
    context.fillStyle = '#6fa7d8';
    context.fillRect(point.x - 2, point.y - 2, 4, 4);
  }

  const playerPoint = toMini(player);
  context.fillStyle = '#7fc7df';
  context.beginPath();
  context.arc(playerPoint.x, playerPoint.y, 4.5, 0, Math.PI * 2);
  context.fill();
  context.strokeStyle = '#10120f';
  context.lineWidth = 1.5;
  context.stroke();
  context.textAlign = 'left';
}
