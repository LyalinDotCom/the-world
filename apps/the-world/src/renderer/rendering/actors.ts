import { distance, type GeneratedNpc, type Vec2 } from '../world.js';

export interface BubbleRenderState {
  npcId: string;
  x: number;
  y: number;
  text: string;
  startsAt: number;
  expiresAt: number;
}

export interface FootstepRenderState {
  x: number;
  y: number;
  side: number;
  heading: number;
  createdAt: number;
  expiresAt: number;
}

export interface ConstableRenderState extends Vec2 {
  name: string;
  patrolSeed: number;
}

export interface PlayerRenderState extends Vec2 {
  heading: number;
  moving: boolean;
}

export interface ActorRenderInput {
  ctx: CanvasRenderingContext2D;
  camera: Vec2;
  now: number;
  player: PlayerRenderState;
  npcs: GeneratedNpc[];
  clickableNpcIds: Set<string>;
  activeNpcId?: string;
  constables: ConstableRenderState[];
  footsteps: FootstepRenderState[];
  bubbles: BubbleRenderState[];
  npcPosition(npc: GeneratedNpc): Vec2;
}

export function drawActors(input: ActorRenderInput): void {
  drawFootsteps(input);
  drawNpcs(input);
  drawConstables(input);
  drawPlayer(input);
  drawBubbles(input);
}

function drawFootsteps({ ctx, camera, now, footsteps }: ActorRenderInput): void {
  for (const footstep of footsteps) {
    const age = (now - footstep.createdAt) / Math.max(1, footstep.expiresAt - footstep.createdAt);
    const alpha = Math.max(0, 1 - age);
    const sx = footstep.x - camera.x;
    const sy = footstep.y - camera.y;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(footstep.heading + footstep.side * 0.24);
    ctx.fillStyle = `rgba(45, 35, 24, ${0.22 * alpha})`;
    ctx.beginPath();
    ctx.ellipse(0, 0, 4.5, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(232, 200, 130, ${0.16 * alpha})`;
    ctx.beginPath();
    ctx.arc(-footstep.side * 5, -7, 2.5 + age * 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function drawNpcs({ ctx, camera, now, player, npcs, clickableNpcIds, activeNpcId, npcPosition }: ActorRenderInput): void {
  for (const npc of npcs.sort((a, b) => npcPosition(a).y - npcPosition(b).y)) {
    const pos = npcPosition(npc);
    const sx = pos.x - camera.x;
    const sy = pos.y - camera.y;
    const bob = activeNpcId === npc.id ? 0 : Math.sin(now * 0.004 + npc.x * 0.01) * 1.5;
    ctx.fillStyle = 'rgba(18, 20, 17, 0.28)';
    ctx.beginPath();
    ctx.ellipse(sx + 2, sy + 17, 13, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = npc.color;
    roundedRect(ctx, sx - 8, sy - 10 + bob, 16, 24, 6);
    ctx.fill();
    ctx.fillStyle = '#f0c78d';
    ctx.beginPath();
    ctx.arc(sx, sy - 17 + bob, 7, 0, Math.PI * 2);
    ctx.fill();
    if (npc.conversationPolicy === 'private') {
      ctx.fillStyle = 'rgba(244, 211, 109, 0.9)';
      ctx.beginPath();
      ctx.arc(sx + 8, sy - 28 + bob, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    if (clickableNpcIds.has(npc.id)) {
      ctx.strokeStyle = '#f4d36d';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx, sy + 1, 25, 0, Math.PI * 2);
      ctx.stroke();
      label(ctx, npc.persona.name, sx, sy - 36, '#f6ecd2');
    } else if (distance(pos, player) < 280) {
      label(ctx, npc.persona.name, sx, sy - 35, 'rgba(246, 236, 210, 0.82)');
    }
  }
}

function drawConstables({ ctx, camera, now, player, constables }: ActorRenderInput): void {
  for (const constable of constables.sort((a, b) => a.y - b.y)) {
    const sx = constable.x - camera.x;
    const sy = constable.y - camera.y;
    const bob = Math.sin(now * 0.01 + constable.patrolSeed) * 1.2;
    ctx.fillStyle = 'rgba(7, 10, 15, 0.36)';
    ctx.beginPath();
    ctx.ellipse(sx + 2, sy + 17, 14, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#263a52';
    roundedRect(ctx, sx - 9, sy - 12 + bob, 18, 27, 5);
    ctx.fill();
    ctx.fillStyle = '#d5b15d';
    ctx.fillRect(sx - 7, sy - 5 + bob, 14, 3);
    ctx.fillStyle = '#f0c78d';
    ctx.beginPath();
    ctx.arc(sx, sy - 19 + bob, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1d2d43';
    roundedRect(ctx, sx - 10, sy - 30 + bob, 20, 8, 3);
    ctx.fill();
    ctx.fillStyle = '#d5b15d';
    ctx.beginPath();
    ctx.arc(sx, sy - 26 + bob, 2.5, 0, Math.PI * 2);
    ctx.fill();
    if (distance(constable, player) < 280) {
      label(ctx, constable.name, sx, sy - 40, '#dce8f1');
    }
  }
}

function drawPlayer({ ctx, camera, now, player }: ActorRenderInput): void {
  const sx = player.x - camera.x;
  const sy = player.y - camera.y;
  const motion = player.moving ? 1 : 0;
  const bob = Math.sin(now * 0.012) * 2.2 * motion;
  const stride = Math.sin(now * 0.018) * 7 * motion;
  ctx.fillStyle = 'rgba(15, 17, 14, 0.35)';
  ctx.beginPath();
  ctx.ellipse(sx + 3, sy + 20, 16, 6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#1b2734';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(sx - 6, sy + 12);
  ctx.lineTo(sx - 6 - stride * 0.3, sy + 23 + Math.abs(stride) * 0.18);
  ctx.moveTo(sx + 6, sy + 12);
  ctx.lineTo(sx + 6 + stride * 0.3, sy + 23 + Math.abs(stride) * 0.18);
  ctx.stroke();
  ctx.fillStyle = '#243342';
  roundedRect(ctx, sx - 10, sy - 12 + bob, 20, 28, 7);
  ctx.fill();
  ctx.strokeStyle = '#d0a76d';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(sx - 10, sy - 2 + bob);
  ctx.lineTo(sx - 17, sy + 8 + bob + stride * 0.16);
  ctx.moveTo(sx + 10, sy - 2 + bob);
  ctx.lineTo(sx + 17, sy + 8 + bob - stride * 0.16);
  ctx.stroke();
  ctx.fillStyle = '#e7bb82';
  ctx.beginPath();
  ctx.arc(sx, sy - 20 + bob, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#e7d093';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(sx - 18, sy + 20);
  ctx.lineTo(sx + 18, sy + 20);
  ctx.stroke();
}

function drawBubbles({ ctx, camera, now, npcs, bubbles, npcPosition }: ActorRenderInput): void {
  const anchors = new Map(npcs.map((npc) => [npc.id, npcPosition(npc)]));
  for (const bubble of bubbles) {
    if (bubble.startsAt > now) continue;
    const fadeIn = Math.min(1, (now - bubble.startsAt) / 550);
    const fadeOut = Math.min(1, (bubble.expiresAt - now) / 1_050);
    const alpha = Math.max(0, Math.min(0.94, fadeIn, fadeOut));
    const anchor = anchors.get(bubble.npcId) ?? { x: bubble.x, y: bubble.y };
    const sx = anchor.x - camera.x;
    const sy = anchor.y - camera.y - 58 + (1 - fadeIn) * 7 - (1 - fadeOut) * 5;
    ctx.save();
    ctx.font = '13px Georgia, serif';
    const lines = wrapText(bubble.text, 28).slice(0, 3);
    const width = Math.min(260, Math.max(120, ...lines.map((line) => ctx.measureText(line).width + 28)));
    const height = 24 + lines.length * 18;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(29, 31, 26, 0.88)';
    roundedRect(ctx, sx - width / 2, sy - height, width, height, 8);
    ctx.fill();
    ctx.strokeStyle = 'rgba(239, 205, 135, 0.42)';
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(sx - 8, sy - 1);
    ctx.lineTo(sx + 7, sy - 1);
    ctx.lineTo(sx, sy + 12);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#f4e4bf';
    ctx.textAlign = 'left';
    lines.forEach((line, index) => ctx.fillText(line, sx - width / 2 + 14, sy - height + 20 + index * 18));
    ctx.restore();
  }
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string): void {
  ctx.font = '12px Georgia, serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(18, 20, 17, 0.55)';
  ctx.fillText(text, x + 1, y + 1);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.textAlign = 'left';
}

function wrapText(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (`${current} ${word}`.trim().length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = `${current} ${word}`.trim();
    }
  }
  if (current) lines.push(current);
  return lines;
}
