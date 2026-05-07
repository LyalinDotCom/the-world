import type { DialogueTurn, NpcMood, OverheardExchange } from '@game-llm/core';
import type { GameAIPreGenerateJob } from '@game-llm/electron';
import { getGameAI } from './aiClient.js';
import type { DiagnosticsSample, PerfLogStatus } from '../shared/bridge.js';
import {
  ProceduralWorld,
  clampToMap,
  crossPathX,
  distance,
  isInsideMap,
  landmarkLoreLines,
  landmarks,
  mainPathY,
  mapBounds,
  nearestLandmarks,
  randomTownSpawn,
  regionName,
  towns,
  wanderedNpcPosition,
  woods,
  type GeneratedNpc,
  type House,
  type Landmark,
  type Tree,
  type Vec2
} from './world.js';
import './style.css';

interface Bubble {
  id: string;
  npcId: string;
  x: number;
  y: number;
  text: string;
  startsAt: number;
  expiresAt: number;
}

interface Footstep {
  x: number;
  y: number;
  side: number;
  heading: number;
  createdAt: number;
  expiresAt: number;
}

interface LogLine {
  speaker: string;
  text: string;
  kind: 'player' | 'npc' | 'system';
}

interface RendererMemoryInfo {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

interface NpcSession {
  mood: NpcMood;
  disposition: number;
  willTalkAgain: boolean;
  refusalReason?: string;
  lastBumpedAt: number;
  bumpInFlight: boolean;
}

const canvasElement = document.querySelector<HTMLCanvasElement>('#world');
const hudElement = document.querySelector<HTMLDivElement>('#hud');
if (!canvasElement || !hudElement) {
  throw new Error('The World canvas or HUD root is missing.');
}

const canvas: HTMLCanvasElement = canvasElement;
const hud: HTMLDivElement = hudElement;
const canvasContext = canvas.getContext('2d');
if (!canvasContext) {
  throw new Error('Canvas 2D context is unavailable.');
}
const ctx: CanvasRenderingContext2D = canvasContext;

const ai = createRequiredGameAI();
const world = new ProceduralWorld('the-world-v1');
const playerRadius = 15;
const spawn = findSafeSpawn(randomTownSpawn());
const keys = new Set<string>();
const player = {
  x: spawn.x,
  y: spawn.y,
  radius: playerRadius,
  speed: 330,
  heading: 0,
  moving: false
};

let cssWidth = 1;
let cssHeight = 1;
let dpr = 1;
let lastFrame = performance.now();
let nearestNpc: GeneratedNpc | undefined;
let activeNpc: GeneratedNpc | undefined;
let busy = false;
let ended = false;
let ambientInFlight = false;
let overhearInFlight = false;
let groupRefusalInFlight = false;
let ambientCacheReady = false;
let ambientCacheInFlight = false;
let providerLine = 'AI runtime connecting...';
let providerBaseLine = providerLine;
let warmupLine = 'warmup pending';
let traceLine = 'No generation yet.';
let traceDetail = '';
let conversation: LogLine[] = [];
let bubbles: Bubble[] = [];
let footsteps: Footstep[] = [];
let lastFootstepAt = 0;
let wallPulseUntil = 0;
let interactionKey = '';
let activeNpcPosition: Vec2 | undefined;
let traceOpen = false;
let clickableNpcs: GeneratedNpc[] = [];
const npcSessions = new Map<string, NpcSession>();
let diagnosticsHistory: number[] = [];
let cpuHistory: number[] = [];
let fpsHistory: number[] = [];
let latestDiagnostics: DiagnosticsSample | undefined;
let fps = 0;
let fpsFrames = 0;
let fpsWindowStartedAt = performance.now();
let perfLogStatus: PerfLogStatus = { active: false, samples: 0 };
let perfLogLastSampleAt = 0;
let perfLogWriteInFlight = false;

hud.innerHTML = `
  <div class="topbar">
    <div class="brand">
      <strong>The World</strong>
      <span id="provider-line"></span>
    </div>
    <div class="meters">
      <span id="region-line"></span>
      <span id="coord-line"></span>
    </div>
  </div>
  <div id="interaction" class="interaction"></div>
  <aside class="minimap-panel">
    <header>Map</header>
    <canvas id="minimap" aria-label="Mini map"></canvas>
    <button id="trace-toggle" class="trace-toggle" type="button">Runtime Trace</button>
  </aside>
  <aside id="devtools" class="devtools collapsed">
    <header>Runtime Trace</header>
    <div id="warmup-line" class="devrow"></div>
    <div id="trace-line" class="devrow"></div>
    <pre id="trace-detail"></pre>
    <header>Machine Diagnostics</header>
    <div class="diagnostics-grid">
      <div><span>Frame Rate</span><strong id="diag-fps">pending</strong></div>
      <div><span>CPU Load</span><strong id="diag-cpu">pending</strong></div>
      <div><span>GPU Load</span><strong id="diag-gpu">pending</strong></div>
      <div><span>GPU Memory</span><strong id="diag-gpu-memory">pending</strong></div>
      <div><span>Machine Memory</span><strong id="diag-system-memory">pending</strong></div>
      <div><span>App Memory</span><strong id="diag-app-memory">pending</strong></div>
    </div>
    <button id="perf-log-toggle" class="perf-log-toggle" type="button">Record Perf</button>
    <div id="perf-log-line" class="devrow perf-log-line">Perf log idle</div>
    <div class="diag-graph-wrap">
      <canvas id="diag-graph" aria-label="FPS CPU GPU graph"></canvas>
      <div id="diag-graph-label" class="diag-graph-label">Perf trend pending</div>
    </div>
  </aside>
  <section id="dialogue" class="dialogue hidden">
    <header>
      <div>
        <strong id="dialogue-name"></strong>
        <span id="dialogue-role"></span>
      </div>
      <button id="dialogue-close" type="button">Close</button>
    </header>
    <div id="dialogue-log" class="dialogue-log"></div>
    <form id="dialogue-form">
      <input id="dialogue-input" autocomplete="off" maxlength="240" />
      <button id="dialogue-send" type="submit">Send</button>
      <button id="dialogue-goodbye" type="button">Goodbye</button>
    </form>
  </section>
`;

const providerEl = document.querySelector<HTMLSpanElement>('#provider-line')!;
const warmupEl = document.querySelector<HTMLDivElement>('#warmup-line')!;
const traceEl = document.querySelector<HTMLDivElement>('#trace-line')!;
const traceDetailEl = document.querySelector<HTMLPreElement>('#trace-detail')!;
const diagFpsEl = document.querySelector<HTMLElement>('#diag-fps')!;
const diagCpuEl = document.querySelector<HTMLElement>('#diag-cpu')!;
const diagGpuEl = document.querySelector<HTMLElement>('#diag-gpu')!;
const diagGpuMemoryEl = document.querySelector<HTMLElement>('#diag-gpu-memory')!;
const diagSystemMemoryEl = document.querySelector<HTMLElement>('#diag-system-memory')!;
const diagAppMemoryEl = document.querySelector<HTMLElement>('#diag-app-memory')!;
const diagGraphCanvas = document.querySelector<HTMLCanvasElement>('#diag-graph')!;
const diagGraphLabelEl = document.querySelector<HTMLElement>('#diag-graph-label')!;
const perfLogToggle = document.querySelector<HTMLButtonElement>('#perf-log-toggle')!;
const perfLogLineEl = document.querySelector<HTMLElement>('#perf-log-line')!;
const diagGraphContext = diagGraphCanvas.getContext('2d');
if (!diagGraphContext) {
  throw new Error('Diagnostics graph canvas context is unavailable.');
}
const diagGraphCtx: CanvasRenderingContext2D = diagGraphContext;
const regionEl = document.querySelector<HTMLSpanElement>('#region-line')!;
const coordEl = document.querySelector<HTMLSpanElement>('#coord-line')!;
const interactionEl = document.querySelector<HTMLDivElement>('#interaction')!;
const minimapCanvas = document.querySelector<HTMLCanvasElement>('#minimap')!;
const minimapContext = minimapCanvas.getContext('2d');
if (!minimapContext) {
  throw new Error('Mini map canvas context is unavailable.');
}
const minimapCtx: CanvasRenderingContext2D = minimapContext;
const traceToggle = document.querySelector<HTMLButtonElement>('#trace-toggle')!;
const devtoolsEl = document.querySelector<HTMLElement>('#devtools')!;
const dialogueEl = document.querySelector<HTMLElement>('#dialogue')!;
const dialogueNameEl = document.querySelector<HTMLElement>('#dialogue-name')!;
const dialogueRoleEl = document.querySelector<HTMLElement>('#dialogue-role')!;
const dialogueLogEl = document.querySelector<HTMLDivElement>('#dialogue-log')!;
const dialogueForm = document.querySelector<HTMLFormElement>('#dialogue-form')!;
const dialogueInput = document.querySelector<HTMLInputElement>('#dialogue-input')!;
const dialogueSend = document.querySelector<HTMLButtonElement>('#dialogue-send')!;
const dialogueGoodbye = document.querySelector<HTMLButtonElement>('#dialogue-goodbye')!;
const dialogueClose = document.querySelector<HTMLButtonElement>('#dialogue-close')!;

window.addEventListener('resize', resize);
canvas.addEventListener('click', (event) => {
  if (activeNpc) return;
  const rect = canvas.getBoundingClientRect();
  const camera = cameraForPlayer();
  const point = {
    x: camera.x + event.clientX - rect.left,
    y: camera.y + event.clientY - rect.top
  };
  const now = performance.now();
  const clicked = clickableNpcs
    .map((npc) => ({ npc, distance: distance(npcPosition(npc, now, clickableNpcs), point) }))
    .filter((entry) => entry.distance < 42)
    .sort((a, b) => a.distance - b.distance)[0]?.npc;
  if (clicked) {
    void startConversation(clicked);
  }
});
window.addEventListener('keydown', (event) => {
  if (event.repeat) return;
  if (event.key.toLowerCase() === 'e' && nearestNpc && !activeNpc) {
    void startConversation(nearestNpc);
    return;
  }
  keys.add(event.key.toLowerCase());
});
window.addEventListener('keyup', (event) => keys.delete(event.key.toLowerCase()));

dialogueForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = dialogueInput.value.trim();
  if (!text || busy || ended) return;
  dialogueInput.value = '';
  void sendToNpc(text);
});
dialogueGoodbye.addEventListener('click', () => {
  if (!activeNpc || busy) return;
  if (ended) {
    closeConversation();
    return;
  }
  void sendToNpc('Goodbye.');
});
dialogueClose.addEventListener('click', closeConversation);
traceToggle.addEventListener('click', () => {
  traceOpen = !traceOpen;
  renderHud();
});
perfLogToggle.addEventListener('click', () => {
  void togglePerfLog();
});

resize();
void initializeRuntime();
void updateDiagnostics();
window.setInterval(() => void updateDiagnostics(), 1_500);
requestAnimationFrame(frame);

async function initializeRuntime(): Promise<void> {
  try {
    const health = await ai.health();
    providerLine = `${health.provider}${health.model ? ` / ${health.model}` : ''} / ${health.mode}`;
    providerBaseLine = providerLine;
    renderHud();
  } catch (error) {
    providerLine = `runtime unavailable / ${errorMessage(error)}`;
  }

  try {
    warmupLine = 'warming local model...';
    renderHud();
    const health = await ai.warmup();
    warmupLine = health.ok ? `warm / ${health.model ?? health.provider}` : `warmup degraded / ${health.message ?? health.mode}`;
    renderHud();
    if (health.ok) {
      await pregenerateAmbientCache(health.model ?? health.provider);
    }
  } catch (error) {
    warmupLine = `warmup failed / ${errorMessage(error)}`;
  }
  renderHud();
}

async function pregenerateAmbientCache(modelLabel: string): Promise<void> {
  if (ambientCacheInFlight || ambientCacheReady) return;
  ambientCacheInFlight = true;
  const jobs = buildPregenerationJobs();
  let generated = 0;
  let failed = 0;
  try {
    if (jobs.length === 0) {
      ambientCacheReady = true;
      warmupLine = `warm / ${modelLabel} / no ambient cache jobs`;
      providerLine = `${providerBaseLine} / ambient cache empty`;
      return;
    }
    warmupLine = `warm / ${modelLabel} / preparing ambient cache 0/${jobs.length}`;
    providerLine = `${providerBaseLine} / caching ambient 0/${jobs.length}`;
    traceLine = 'pregeneration / ambient cache starting';
    renderHud();
    const chunkSize = 2;
    for (let index = 0; index < jobs.length; index += chunkSize) {
      const chunk = jobs.slice(index, index + chunkSize);
      const result = await ai.preGenerate({ jobs: chunk, maxConcurrency: 1 });
      generated += result.generated;
      failed += result.failed;
      warmupLine = `warm / ${modelLabel} / ambient cache ${Math.min(index + chunk.length, jobs.length)}/${jobs.length}`;
      providerLine = `${providerBaseLine} / caching ambient ${Math.min(index + chunk.length, jobs.length)}/${jobs.length}`;
      traceLine = `pregeneration / generated ${generated}, failed ${failed}`;
      renderHud();
    }
    ambientCacheReady = generated > 0;
    warmupLine = `warm / ${modelLabel} / ambient cache ${generated}/${jobs.length}`;
    providerLine = `${providerBaseLine} / ambient cached ${generated}/${jobs.length}`;
    traceLine = `pregeneration ready / ${generated}/${jobs.length} cached`;
  } catch (error) {
    warmupLine = `warm / ${modelLabel} / ambient cache degraded`;
    providerLine = `${providerBaseLine} / ambient cache degraded`;
    traceLine = `pregeneration failed / ${errorMessage(error)}`;
  } finally {
    ambientCacheInFlight = false;
    renderHud();
  }
}

function buildPregenerationJobs(): GameAIPreGenerateJob[] {
  const npcs = pregenerationNpcPool();
  const open = npcs.filter((npc) => npc.conversationPolicy === 'open');
  const jobs: GameAIPreGenerateJob[] = [];

  for (const npc of open.slice(0, 10)) {
    jobs.push({
      type: 'bark',
      npc: stripRuntimeNpc(npc),
      request: ambientBarkRequest(npc)
    });
  }

  for (const npc of open.slice(0, 6)) {
    jobs.push({
      type: 'dialogue',
      npc: stripRuntimeNpc(npc),
      request: bumpDialogueRequest(npc),
      options: {
        cacheKey: bumpCacheKey(npc),
        writeMemory: false
      }
    });
  }

  for (const [a, b] of privatePairsFrom(npcs).slice(0, 4)) {
    jobs.push({
      type: 'overhear',
      npc: stripRuntimeNpc(a),
      request: overhearRequest(a, b, 'private')
    });
  }

  for (const [a, b] of openPairsFrom(open).slice(0, 3)) {
    jobs.push({
      type: 'overhear',
      npc: stripRuntimeNpc(a),
      request: overhearRequest(a, b, 'open')
    });
  }

  return jobs.slice(0, 24);
}

function pregenerationNpcPool(): GeneratedNpc[] {
  const byId = new Map<string, GeneratedNpc>();
  const add = (npc: GeneratedNpc) => byId.set(npc.id, npc);
  for (const town of towns) {
    for (const npc of world.npcsNear(town.x, town.y, town.radius + 560)) {
      add(npc);
    }
  }
  for (const landmark of landmarks) {
    for (const npc of world.npcsNear(landmark.x, landmark.y, 920)) {
      add(npc);
    }
  }
  for (const npc of world.npcsNear(player.x, player.y, 920)) {
    add(npc);
  }
  return [...byId.values()]
    .sort((a, b) => distance(a, player) - distance(b, player))
    .slice(0, 34);
}

function privatePairsFrom(npcs: GeneratedNpc[]): Array<[GeneratedNpc, GeneratedNpc]> {
  const groups = new Map<string, GeneratedNpc[]>();
  for (const npc of npcs) {
    if (!npc.groupId || npc.conversationPolicy !== 'private') continue;
    const group = groups.get(npc.groupId) ?? [];
    group.push(npc);
    groups.set(npc.groupId, group);
  }
  return [...groups.values()]
    .filter((group) => group.length >= 2)
    .map((group) => [group[0]!, group[1]!] as [GeneratedNpc, GeneratedNpc]);
}

function openPairsFrom(npcs: GeneratedNpc[]): Array<[GeneratedNpc, GeneratedNpc]> {
  const pairs: Array<[GeneratedNpc, GeneratedNpc]> = [];
  for (let index = 0; index < npcs.length; index += 1) {
    const a = npcs[index];
    const b = npcs.slice(index + 1)
      .filter((candidate) => distance(a!, candidate) < 480)
      .sort((left, right) => distance(a!, left) - distance(a!, right))[0];
    if (a && b) {
      pairs.push([a, b]);
    }
  }
  return pairs;
}

function frame(now: number): void {
  recordFrameRate(now);
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  update(dt, now);
  draw(now);
  void maybeWritePerfLogSample(now);
  requestAnimationFrame(frame);
}

function recordFrameRate(now: number): void {
  fpsFrames += 1;
  const elapsed = now - fpsWindowStartedAt;
  if (elapsed >= 500) {
    fps = Math.round((fpsFrames * 1000) / elapsed);
    fpsFrames = 0;
    fpsWindowStartedAt = now;
  }
}

function update(dt: number, now: number): void {
  player.moving = false;
  const nearby = world.npcsNear(player.x, player.y, 760);
  if (!activeNpc && !dialogueInput.matches(':focus')) {
    let dx = 0;
    let dy = 0;
    if (keys.has('arrowleft') || keys.has('a')) dx -= 1;
    if (keys.has('arrowright') || keys.has('d')) dx += 1;
    if (keys.has('arrowup') || keys.has('w')) dy -= 1;
    if (keys.has('arrowdown') || keys.has('s')) dy += 1;
    if (dx !== 0 || dy !== 0) {
      const length = Math.hypot(dx, dy);
      const nx = dx / length;
      const ny = dy / length;
      const desired = clampToMap({
        x: player.x + nx * player.speed * dt,
        y: player.y + ny * player.speed * dt
      }, player.radius);
      const previous = { x: player.x, y: player.y };
      const resolved = resolvePlayerMove(previous, desired, now, nearby);
      if (Math.abs(resolved.x - desired.x) > 0.1 || Math.abs(resolved.y - desired.y) > 0.1) {
        wallPulseUntil = now + 420;
      }
      player.x = resolved.x;
      player.y = resolved.y;
      player.heading = Math.atan2(ny, nx);
      player.moving = distance(resolved, previous) > 0.01;
      if (player.moving) {
        maybeAddFootstep(now);
      }
    }
  }

  bubbles = bubbles.filter((bubble) => bubble.expiresAt > now);
  footsteps = footsteps.filter((footstep) => footstep.expiresAt > now);
  if (activeNpc && activeNpcPosition && distance(activeNpcPosition, player) > 260) {
    closeConversation();
  }
  clickableNpcs = nearby
    .filter((npc) => distance(npcPosition(npc, now, nearby), player) < 170)
    .sort((a, b) => distance(npcPosition(a, now, nearby), player) - distance(npcPosition(b, now, nearby), player));
  nearestNpc = nearby
    .filter((npc) => distance(npcPosition(npc, now, nearby), player) < 165)
    .sort((a, b) => distance(npcPosition(a, now, nearby), player) - distance(npcPosition(b, now, nearby), player))[0];
  maybeRequestAmbient(now, nearby);
  renderHud();
}

function draw(now: number): void {
  const camera = cameraForPlayer();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  drawTerrain(camera);
  drawWoods(camera);
  drawTownGrounds(camera);
  drawPaths(camera);
  drawLandmarks(camera);
  drawHouses(camera);
  drawHills(camera);
  drawTrees(camera);
  const npcs = world.npcsNear(player.x, player.y, Math.max(cssWidth, cssHeight));
  drawFootsteps(camera, now);
  drawNpcs(camera, npcs, now);
  drawPlayer(camera, now);
  drawBubbles(camera, now, npcs);
  drawMapBorder(camera, now);
  drawMinimap(now, npcs);
}

function drawTerrain(camera: { x: number; y: number }): void {
  const tile = 86;
  const minX = Math.floor(camera.x / tile) * tile;
  const minY = Math.floor(camera.y / tile) * tile;
  for (let x = minX; x < camera.x + cssWidth + tile; x += tile) {
    for (let y = minY; y < camera.y + cssHeight + tile; y += tile) {
      if (!isInsideMap({ x: x + tile / 2, y: y + tile / 2 })) {
        ctx.fillStyle = '#11150f';
        ctx.fillRect(Math.floor(x - camera.x), Math.floor(y - camera.y), tile + 1, tile + 1);
        continue;
      }
      const sample = world.terrainAt(x + tile / 2, y + tile / 2);
      ctx.fillStyle = terrainColor(sample.biome, sample.height, sample.moisture, sample.path);
      ctx.fillRect(Math.floor(x - camera.x), Math.floor(y - camera.y), tile + 1, tile + 1);
      if (sample.hill > 0.08) {
        ctx.fillStyle = `rgba(59, 73, 60, ${Math.min(0.22, sample.hill * 0.18)})`;
        ctx.fillRect(Math.floor(x - camera.x), Math.floor(y - camera.y), tile + 1, tile + 1);
      }
    }
  }
}

function cameraForPlayer(): Vec2 {
  return {
    x: clampCameraAxis(player.x - cssWidth / 2, mapBounds.minX, mapBounds.maxX, cssWidth),
    y: clampCameraAxis(player.y - cssHeight / 2, mapBounds.minY, mapBounds.maxY, cssHeight)
  };
}

function clampCameraAxis(value: number, min: number, max: number, viewport: number): number {
  const size = max - min;
  if (size <= viewport) return min - (viewport - size) / 2;
  return Math.max(min, Math.min(max - viewport, value));
}

function maybeAddFootstep(now: number): void {
  if (now - lastFootstepAt < 145) return;
  const side = footsteps.length % 2 === 0 ? -1 : 1;
  const perpendicular = player.heading + Math.PI / 2;
  footsteps.push({
    x: player.x - Math.cos(player.heading) * 8 + Math.cos(perpendicular) * side * 7,
    y: player.y - Math.sin(player.heading) * 8 + Math.sin(perpendicular) * side * 7,
    side,
    heading: player.heading,
    createdAt: now,
    expiresAt: now + 950
  });
  lastFootstepAt = now;
}

function findSafeSpawn(initial: Vec2): Vec2 {
  const candidates: Vec2[] = [initial];
  for (const town of towns) {
    for (const radius of [150, 220, 300, 380, 470]) {
      for (let step = 0; step < 12; step += 1) {
        const angle = (Math.PI * 2 * step) / 12 + radius * 0.017;
        candidates.push(clampToMap({
          x: town.x + Math.cos(angle) * radius,
          y: town.y + Math.sin(angle) * radius * 0.62
        }, 80));
      }
    }
  }

  return candidates.find((candidate) => (
    isInsideMap(candidate, 80) &&
    !staticCollisionAt(candidate, playerRadius + 3)
  )) ?? initial;
}

function resolvePlayerMove(previous: Vec2, desired: Vec2, now: number, npcs: GeneratedNpc[]): Vec2 {
  const candidates = [
    desired,
    { x: desired.x, y: previous.y },
    { x: previous.x, y: desired.y }
  ];
  for (const candidate of candidates) {
    const collision = playerCollisionAt(candidate, now, npcs);
    if (!collision.blocked) return candidate;
    if (collision.npc) {
      void triggerBumpReaction(collision.npc, now);
    }
  }
  return previous;
}

function playerCollisionAt(point: Vec2, now: number, npcs: GeneratedNpc[]): { blocked: boolean; npc?: GeneratedNpc } {
  if (!isInsideMap(point, player.radius)) return { blocked: true };
  if (staticCollisionAt(point, player.radius)) return { blocked: true };
  for (const npc of npcs) {
    const npcPos = npcPosition(npc, now, npcs);
    if (distance(point, npcPos) < player.radius + 16) {
      return { blocked: true, npc };
    }
  }
  return { blocked: false };
}

function staticCollisionAt(point: Vec2, radius: number): boolean {
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

  const trees = world.treesInRect(point.x - 70, point.y - 70, point.x + 70, point.y + 70);
  return trees.some((tree) => distance(point, treeCollisionCenter(tree)) < radius + treeCollisionRadius(tree));
}

function npcPosition(npc: GeneratedNpc, now: number, crowd: GeneratedNpc[] = []): Vec2 {
  if (activeNpc?.id === npc.id && activeNpcPosition) {
    return activeNpcPosition;
  }
  const raw = wanderedNpcPosition(npc, now);
  if (!canNpcStand(raw, npc, now, crowd)) {
    return npcFallbackPosition(npc, now, crowd);
  }
  return raw;
}

function npcFallbackPosition(npc: GeneratedNpc, now: number, crowd: GeneratedNpc[]): Vec2 {
  const offsets: Vec2[] = [
    { x: 0, y: 0 },
    { x: 34, y: 0 },
    { x: -34, y: 0 },
    { x: 0, y: 34 },
    { x: 0, y: -34 },
    { x: 48, y: 28 },
    { x: -48, y: -28 }
  ];
  for (const offset of offsets) {
    const candidate = { x: npc.x + offset.x, y: npc.y + offset.y };
    if (canNpcStand(candidate, npc, now, crowd.filter((other) => other.id !== npc.id))) {
      return candidate;
    }
  }
  return { x: npc.x, y: npc.y };
}

function canNpcStand(point: Vec2, npc: GeneratedNpc, now: number, crowd: GeneratedNpc[]): boolean {
  if (!isInsideMap(point, 18)) return false;
  if (staticCollisionAt(point, 16)) return false;
  for (const other of crowd) {
    if (other.id === npc.id) continue;
    const otherRaw = activeNpc?.id === other.id && activeNpcPosition ? activeNpcPosition : wanderedNpcPosition(other, now);
    if (distance(point, otherRaw) < 34 && npc.id > other.id) {
      return false;
    }
  }
  return true;
}

async function triggerBumpReaction(npc: GeneratedNpc, now: number): Promise<void> {
  if (!ambientCacheReady) return;
  const session = npcSession(npc);
  if (session.bumpInFlight || now - session.lastBumpedAt < 6_000) return;
  session.lastBumpedAt = now;
  session.bumpInFlight = true;
  try {
    const turn = await ai.dialogue({
      npc: stripRuntimeNpc(npc),
      request: bumpDialogueRequest(npc),
      options: {
        cacheOnly: true,
        cacheKey: bumpCacheKey(npc),
        writeMemory: false
      }
    });
    if (turn.trace?.fallback) {
      traceLine = 'bump cache miss / waiting for pregeneration';
      traceDetail = '';
      return;
    }
    applyNpcSessionTurn(npc, turn);
    const createdAt = performance.now();
    const pos = npcPosition(npc, createdAt, world.npcsNear(npc.x, npc.y, 360));
    bubbles.push({
      id: `${npc.id}:bump:${createdAt}`,
      npcId: npc.id,
      x: pos.x,
      y: pos.y,
      text: turn.text,
      startsAt: createdAt,
      expiresAt: createdAt + 4_200
    });
    traceLine = `${turn.trace?.recipeId ?? 'npc.dialogue'} / ${turn.trace?.providerId ?? 'unknown'} / bump reaction`;
    traceDetail = turn.trace?.rawText.slice(0, 420) ?? '';
  } catch (error) {
    traceLine = `bump reaction failed / ${errorMessage(error)}`;
  } finally {
    session.bumpInFlight = false;
  }
}

function drawWoods(camera: Vec2): void {
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

function drawTownGrounds(camera: Vec2): void {
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
    label(town.name, x, y - town.radius * 0.43, '#f6df9a');
    ctx.restore();
  }
}

function drawPaths(camera: { x: number; y: number }): void {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(96, 71, 45, 0.32)';
  ctx.lineWidth = 112;
  strokeMainPath(camera);
  strokeCrossPath(camera);
  ctx.strokeStyle = 'rgba(178, 139, 82, 0.82)';
  ctx.lineWidth = 62;
  strokeMainPath(camera);
  strokeCrossPath(camera);
  ctx.strokeStyle = 'rgba(238, 203, 127, 0.16)';
  ctx.lineWidth = 7;
  strokeMainPath(camera);
  strokeCrossPath(camera);
  ctx.restore();
}

function strokeMainPath(camera: { x: number; y: number }): void {
  ctx.beginPath();
  for (let sx = -120; sx <= cssWidth + 120; sx += 64) {
    const wx = camera.x + sx;
    const sy = mainPathY(wx) - camera.y;
    if (sx === -120) ctx.moveTo(sx, sy);
    else ctx.lineTo(sx, sy);
  }
  ctx.stroke();
}

function strokeCrossPath(camera: { x: number; y: number }): void {
  ctx.beginPath();
  for (let sy = -120; sy <= cssHeight + 120; sy += 64) {
    const wy = camera.y + sy;
    const sx = crossPathX(wy) - camera.x;
    if (sy === -120) ctx.moveTo(sx, sy);
    else ctx.lineTo(sx, sy);
  }
  ctx.stroke();
}

function drawHills(camera: { x: number; y: number }): void {
  const hills = world.hillsInRect(camera.x - 240, camera.y - 240, camera.x + cssWidth + 240, camera.y + cssHeight + 240);
  for (const hill of hills) {
    const x = hill.x - camera.x;
    const y = hill.y - camera.y;
    const gradient = ctx.createRadialGradient(x, y, hill.radius * 0.1, x, y, hill.radius);
    gradient.addColorStop(0, 'rgba(84, 100, 74, 0.34)');
    gradient.addColorStop(0.62, 'rgba(84, 100, 74, 0.16)');
    gradient.addColorStop(1, 'rgba(84, 100, 74, 0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.ellipse(x, y, hill.radius * 1.2, hill.radius * 0.72, -0.28, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(47, 57, 49, 0.22)';
    ctx.lineWidth = 2;
    for (let i = 0.45; i <= 0.85; i += 0.2) {
      ctx.beginPath();
      ctx.ellipse(x, y, hill.radius * 1.2 * i, hill.radius * 0.72 * i, -0.28, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

function drawHouses(camera: { x: number; y: number }): void {
  const houses = world.housesInRect(camera.x - 120, camera.y - 120, camera.x + cssWidth + 120, camera.y + cssHeight + 120);
  for (const house of houses.sort((a, b) => a.y - b.y)) {
    drawHouse(camera, house);
  }
}

function drawLandmarks(camera: Vec2): void {
  const visible = world.landmarksInRect(camera.x - 160, camera.y - 160, camera.x + cssWidth + 160, camera.y + cssHeight + 160);
  for (const landmark of visible.sort((a, b) => a.y - b.y)) {
    drawLandmark(camera, landmark);
  }
}

function drawLandmark(camera: Vec2, landmark: Landmark): void {
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
    roundedRect(-landmark.width / 2, -landmark.height / 2 + 28, landmark.width, landmark.height - 30, 5);
    ctx.fill();
    ctx.strokeStyle = '#3c3d37';
    ctx.lineWidth = 3;
    ctx.stroke();
    for (const tx of [-landmark.width / 2 + 18, landmark.width / 2 - 42]) {
      roundedRect(tx, -landmark.height / 2 - 4, 34, 62, 4);
      ctx.fill();
      ctx.stroke();
    }
    ctx.fillStyle = '#b7a678';
    ctx.fillRect(-13, 28, 26, 34);
  } else if (landmark.kind === 'mill') {
    ctx.fillStyle = '#7f694c';
    roundedRect(-42, -34, 84, 74, 5);
    ctx.fill();
    ctx.strokeStyle = '#463828';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = '#5b4733';
    triangle(0, -78, 108, 58);
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
    roundedRect(-48, -24, 96, 70, 5);
    ctx.fill();
    ctx.strokeStyle = '#354642';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = '#4d5b57';
    triangle(0, -68, 118, 52);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#d3c38b';
    ctx.fillRect(-8, 10, 16, 34);
    ctx.fillRect(-4, -55, 8, 32);
    ctx.fillRect(-16, -45, 32, 7);
  } else {
    ctx.fillStyle = '#6b574f';
    roundedRect(-36, -landmark.height / 2, 72, landmark.height, 5);
    ctx.fill();
    ctx.strokeStyle = '#342b28';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = '#c06a50';
    triangle(0, -landmark.height / 2 - 42, 88, 58);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#171a15';
    ctx.fillRect(-10, landmark.height / 2 - 42, 20, 42);
  }

  ctx.fillStyle = landmark.marker;
  ctx.beginPath();
  ctx.arc(landmark.width / 2 - 8, -landmark.height / 2 - 12, 7, 0, Math.PI * 2);
  ctx.fill();
  label(landmark.name, 0, -landmark.height / 2 - 30, '#f7d88f');
  ctx.restore();
}

function drawHouse(camera: { x: number; y: number }, house: House): void {
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
  roundedRect(-house.width / 2, -house.height / 2, house.width, house.height, 4);
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

function drawTrees(camera: { x: number; y: number }): void {
  const houses = world.housesInRect(camera.x - 120, camera.y - 120, camera.x + cssWidth + 120, camera.y + cssHeight + 120);
  const landmarksInView = world.landmarksInRect(camera.x - 180, camera.y - 180, camera.x + cssWidth + 180, camera.y + cssHeight + 180);
  const trees = world.treesInRect(camera.x - 80, camera.y - 80, camera.x + cssWidth + 80, camera.y + cssHeight + 80);
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
      triangle(x, y - tree.size * 0.85, tree.size * 0.88, tree.size * 1.55);
      ctx.fillStyle = '#2d684c';
      triangle(x, y - tree.size * 1.18, tree.size * 0.62, tree.size * 1.18);
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

function drawFootsteps(camera: Vec2, now: number): void {
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

function drawNpcs(camera: { x: number; y: number }, npcs: GeneratedNpc[], now: number): void {
  for (const npc of npcs.sort((a, b) => npcPosition(a, now, npcs).y - npcPosition(b, now, npcs).y)) {
    const pos = npcPosition(npc, now, npcs);
    const sx = pos.x - camera.x;
    const sy = pos.y - camera.y;
    const bob = activeNpc?.id === npc.id ? 0 : Math.sin(now * 0.004 + npc.x * 0.01) * 1.5;
    ctx.fillStyle = 'rgba(18, 20, 17, 0.28)';
    ctx.beginPath();
    ctx.ellipse(sx + 2, sy + 17, 13, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = npc.color;
    roundedRect(sx - 8, sy - 10 + bob, 16, 24, 6);
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
    if (clickableNpcs.some((candidate) => candidate.id === npc.id)) {
      ctx.strokeStyle = '#f4d36d';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx, sy + 1, 25, 0, Math.PI * 2);
      ctx.stroke();
      label(npc.persona.name, sx, sy - 36, '#f6ecd2');
    } else if (distance(pos, player) < 280) {
      label(npc.persona.name, sx, sy - 35, 'rgba(246, 236, 210, 0.82)');
    }
  }
}

function drawPlayer(camera: { x: number; y: number }, now: number): void {
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
  roundedRect(sx - 10, sy - 12 + bob, 20, 28, 7);
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

function drawBubbles(camera: { x: number; y: number }, now: number, npcs: GeneratedNpc[]): void {
  const anchors = new Map(npcs.map((npc) => [npc.id, npcPosition(npc, now, npcs)]));
  for (const bubble of bubbles) {
    if (bubble.startsAt > now) continue;
    const alpha = Math.min(1, (bubble.expiresAt - now) / 650);
    const anchor = anchors.get(bubble.npcId) ?? { x: bubble.x, y: bubble.y };
    const sx = anchor.x - camera.x;
    const sy = anchor.y - camera.y - 58;
    const lines = wrapText(bubble.text, 28).slice(0, 3);
    const width = Math.min(260, Math.max(120, ...lines.map((line) => ctx.measureText(line).width + 28)));
    const height = 24 + lines.length * 18;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(29, 31, 26, 0.88)';
    roundedRect(sx - width / 2, sy - height, width, height, 8);
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
    ctx.font = '13px Georgia, serif';
    lines.forEach((line, index) => ctx.fillText(line, sx - width / 2 + 14, sy - height + 20 + index * 18));
    ctx.globalAlpha = 1;
  }
}

function drawMapBorder(camera: Vec2, now: number): void {
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

function drawMinimap(now: number, npcs: GeneratedNpc[]): void {
  const width = minimapCanvas.width / dpr;
  const height = minimapCanvas.height / dpr;
  const pad = 12;
  minimapCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  minimapCtx.clearRect(0, 0, width, height);
  minimapCtx.fillStyle = 'rgba(19, 24, 18, 0.96)';
  minimapCtx.fillRect(0, 0, width, height);

  const mapWidth = mapBounds.maxX - mapBounds.minX;
  const mapHeight = mapBounds.maxY - mapBounds.minY;
  const scale = Math.min((width - pad * 2) / mapWidth, (height - pad * 2) / mapHeight);
  const offsetX = (width - mapWidth * scale) / 2;
  const offsetY = (height - mapHeight * scale) / 2;
  const toMini = (point: Vec2) => ({
    x: offsetX + (point.x - mapBounds.minX) * scale,
    y: offsetY + (point.y - mapBounds.minY) * scale
  });

  minimapCtx.strokeStyle = 'rgba(238, 211, 149, 0.24)';
  minimapCtx.lineWidth = 1;
  minimapCtx.strokeRect(offsetX, offsetY, mapWidth * scale, mapHeight * scale);

  for (const wood of woods) {
    const point = toMini(wood);
    minimapCtx.fillStyle = 'rgba(44, 105, 67, 0.45)';
    minimapCtx.beginPath();
    minimapCtx.ellipse(point.x, point.y, wood.radiusX * scale, wood.radiusY * scale, -0.12, 0, Math.PI * 2);
    minimapCtx.fill();
  }

  minimapCtx.save();
  minimapCtx.lineCap = 'round';
  minimapCtx.strokeStyle = 'rgba(190, 151, 87, 0.72)';
  minimapCtx.lineWidth = 4;
  minimapCtx.beginPath();
  for (let wx = mapBounds.minX; wx <= mapBounds.maxX; wx += 120) {
    const point = toMini({ x: wx, y: mainPathY(wx) });
    if (wx === mapBounds.minX) minimapCtx.moveTo(point.x, point.y);
    else minimapCtx.lineTo(point.x, point.y);
  }
  minimapCtx.stroke();
  minimapCtx.beginPath();
  for (let wy = mapBounds.minY; wy <= mapBounds.maxY; wy += 120) {
    const point = toMini({ x: crossPathX(wy), y: wy });
    if (wy === mapBounds.minY) minimapCtx.moveTo(point.x, point.y);
    else minimapCtx.lineTo(point.x, point.y);
  }
  minimapCtx.stroke();
  minimapCtx.restore();

  minimapCtx.font = '10px Georgia, serif';
  minimapCtx.textAlign = 'center';
  for (const town of towns) {
    const point = toMini(town);
    minimapCtx.fillStyle = town.accent;
    minimapCtx.beginPath();
    minimapCtx.arc(point.x, point.y, Math.max(4, town.radius * scale * 0.34), 0, Math.PI * 2);
    minimapCtx.fill();
    minimapCtx.fillStyle = '#f1e5c7';
    minimapCtx.fillText(town.name, point.x, point.y - 9);
  }

  for (const landmark of landmarks) {
    const point = toMini(landmark);
    minimapCtx.fillStyle = landmark.marker;
    minimapCtx.strokeStyle = '#10120f';
    minimapCtx.lineWidth = 1.5;
    minimapCtx.beginPath();
    minimapCtx.moveTo(point.x, point.y - 6);
    minimapCtx.lineTo(point.x + 6, point.y);
    minimapCtx.lineTo(point.x, point.y + 6);
    minimapCtx.lineTo(point.x - 6, point.y);
    minimapCtx.closePath();
    minimapCtx.fill();
    minimapCtx.stroke();
  }

  for (const npc of npcs.slice(0, 24)) {
    const point = toMini(npcPosition(npc, now, npcs));
    minimapCtx.fillStyle = npc.conversationPolicy === 'private' ? '#e3bd65' : '#cdd8b3';
    minimapCtx.fillRect(point.x - 1.5, point.y - 1.5, 3, 3);
  }

  const playerPoint = toMini(player);
  minimapCtx.fillStyle = '#7fc7df';
  minimapCtx.beginPath();
  minimapCtx.arc(playerPoint.x, playerPoint.y, 4.5, 0, Math.PI * 2);
  minimapCtx.fill();
  minimapCtx.strokeStyle = '#10120f';
  minimapCtx.lineWidth = 1.5;
  minimapCtx.stroke();
  minimapCtx.textAlign = 'left';
}

async function updateDiagnostics(): Promise<void> {
  try {
    latestDiagnostics = await window.theWorldDiagnostics?.sample();
  } catch {
    latestDiagnostics = undefined;
  }
  const rendererMemory = rendererMemoryInfo();
  const gpuUsage = latestDiagnostics ? diagnosticGpuUsage(latestDiagnostics.gpu) : undefined;
  const cpuUsage = latestDiagnostics?.cpu.systemPercent;
  if (typeof gpuUsage === 'number') {
    diagnosticsHistory = [...diagnosticsHistory, Math.max(0, Math.min(100, gpuUsage))].slice(-72);
  }
  if (typeof cpuUsage === 'number') {
    cpuHistory = [...cpuHistory, Math.max(0, Math.min(100, cpuUsage))].slice(-72);
  }
  if (fps > 0) {
    fpsHistory = [...fpsHistory, Math.max(0, Math.min(100, (fps / 60) * 100))].slice(-72);
  }
  diagFpsEl.textContent = fps > 0 ? `${fps} fps` : 'measuring';

  if (!latestDiagnostics) {
    diagCpuEl.textContent = 'unavailable';
    diagGpuEl.textContent = 'unavailable';
    diagGpuMemoryEl.textContent = 'unavailable';
    diagSystemMemoryEl.textContent = 'unavailable';
    diagAppMemoryEl.textContent = rendererMemory
      ? `${formatBytes(rendererMemory.usedJSHeapSize)} renderer heap`
      : 'renderer heap unavailable';
    diagGraphLabelEl.textContent = 'GPU trend unavailable';
    drawDiagnosticsGraph();
    return;
  }

  const cpu = latestDiagnostics.cpu;
  diagCpuEl.textContent = cpu.available
    ? `${cpu.systemPercent ?? 0}% system / ${cpu.processPercent ?? 0}% main / ${cpu.cores} cores / load ${cpu.loadAverage[0]?.toFixed(2) ?? 'n/a'}`
    : `unavailable / ${cpu.error ?? cpu.source}`;
  const gpu = latestDiagnostics.gpu;
  const gpuParts = [
    typeof gpuUsage === 'number' ? `${gpuUsage}% device` : 'device n/a',
    typeof gpu.rendererUtilizationPercent === 'number' ? `${gpu.rendererUtilizationPercent}% render` : '',
    typeof gpu.tilerUtilizationPercent === 'number' ? `${gpu.tilerUtilizationPercent}% tiler` : ''
  ].filter(Boolean);
  diagGpuEl.textContent = gpu.available
    ? `${gpuParts.join(' / ')}${gpu.model ? ` / ${gpu.model}` : ''}${gpu.cores ? ` / ${gpu.cores} cores` : ''}`
    : `unavailable / ${gpu.error ?? gpu.source}`;
  const unifiedCapacity = gpu.unifiedMemoryCapacityBytes ?? latestDiagnostics.systemMemory.totalBytes;
  diagGpuMemoryEl.textContent = gpu.memoryUsedBytes
    ? `${formatBytes(gpu.memoryUsedBytes)} used${gpu.memoryAllocatedBytes ? ` / ${formatBytes(gpu.memoryAllocatedBytes)} alloc` : ''} / ${formatBytes(unifiedCapacity)} unified`
    : 'not reported';
  diagSystemMemoryEl.textContent = `${formatBytes(latestDiagnostics.systemMemory.usedBytes)} used / ${formatBytes(latestDiagnostics.systemMemory.totalBytes)} total / ${formatBytes(latestDiagnostics.systemMemory.freeBytes)} free`;
  diagAppMemoryEl.textContent = [
    `main ${formatBytes(latestDiagnostics.processMemory.rssBytes)} RSS`,
    rendererMemory ? `renderer ${formatBytes(rendererMemory.usedJSHeapSize)} heap` : ''
  ].filter(Boolean).join(' / ');
  diagGraphLabelEl.textContent = [
    fps > 0 ? `${fps} fps` : 'fps measuring',
    typeof cpuUsage === 'number' ? `CPU ${cpuUsage}% ${diagnosticTrend(cpuHistory)}` : 'CPU n/a',
    typeof gpuUsage === 'number' ? `GPU ${gpuUsage}% ${diagnosticTrend(diagnosticsHistory)}` : 'GPU n/a'
  ].join(' / ');
  drawDiagnosticsGraph();
}

async function togglePerfLog(): Promise<void> {
  if (!window.theWorldDiagnostics) return;
  try {
    perfLogStatus = perfLogStatus.active
      ? await window.theWorldDiagnostics.stopPerfLog()
      : await window.theWorldDiagnostics.startPerfLog();
    perfLogLastSampleAt = 0;
    interactionKey = '';
    renderHud();
  } catch (error) {
    perfLogLineEl.textContent = `Perf log failed / ${errorMessage(error)}`;
  }
}

async function maybeWritePerfLogSample(now: number): Promise<void> {
  if (!perfLogStatus.active || !window.theWorldDiagnostics) return;
  if (perfLogWriteInFlight) return;
  if (now - perfLogLastSampleAt < 1_500) return;
  perfLogLastSampleAt = now;
  perfLogWriteInFlight = true;
  try {
    perfLogStatus = await window.theWorldDiagnostics.appendPerfSample({
      timestamp: Date.now(),
      fps,
      position: {
        x: Math.round(player.x),
        y: Math.round(player.y)
      },
      region: regionName(player.x, player.y),
      moving: player.moving,
      ...(activeNpc ? { activeNpcId: activeNpc.id } : {}),
      nearbyNpcCount: world.npcsNear(player.x, player.y, 430).length,
      ambientCacheReady,
      providerLine,
      warmupLine,
      traceLine,
      ...(latestDiagnostics ? { diagnostics: latestDiagnostics } : {})
    });
    renderHud();
  } catch (error) {
    perfLogStatus = { active: false, samples: perfLogStatus.samples };
    perfLogLineEl.textContent = `Perf log failed / ${errorMessage(error)}`;
  } finally {
    perfLogWriteInFlight = false;
  }
}

function drawDiagnosticsGraph(): void {
  const width = diagGraphCanvas.width / dpr;
  const height = diagGraphCanvas.height / dpr;
  diagGraphCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  diagGraphCtx.clearRect(0, 0, width, height);
  diagGraphCtx.fillStyle = 'rgba(10, 12, 10, 0.72)';
  diagGraphCtx.fillRect(0, 0, width, height);
  diagGraphCtx.strokeStyle = 'rgba(238, 211, 149, 0.12)';
  diagGraphCtx.lineWidth = 1;
  for (let y = 0; y <= 4; y += 1) {
    const yy = (height / 4) * y;
    diagGraphCtx.beginPath();
    diagGraphCtx.moveTo(0, yy);
    diagGraphCtx.lineTo(width, yy);
    diagGraphCtx.stroke();
  }
  if (diagnosticsHistory.length < 2 && cpuHistory.length < 2 && fpsHistory.length < 2) {
    diagGraphCtx.fillStyle = 'rgba(234, 219, 184, 0.42)';
    diagGraphCtx.font = '11px Georgia, serif';
    diagGraphCtx.fillText('waiting for performance samples', 12, height / 2 + 4);
    return;
  }
  drawDiagnosticSeries(fpsHistory, '#f1e5c7', width, height);
  drawDiagnosticSeries(cpuHistory, '#e3bd65', width, height);
  drawDiagnosticSeries(diagnosticsHistory, '#8fcf7a', width, height);
  diagGraphCtx.font = '10px Georgia, serif';
  diagGraphCtx.fillStyle = '#f1e5c7';
  diagGraphCtx.fillText('FPS', 10, 14);
  diagGraphCtx.fillStyle = '#e3bd65';
  diagGraphCtx.fillText('CPU', 46, 14);
  diagGraphCtx.fillStyle = '#8fcf7a';
  diagGraphCtx.fillText('GPU', 84, 14);
}

function drawDiagnosticSeries(history: number[], color: string, width: number, height: number): void {
  if (history.length < 2) return;
  diagGraphCtx.strokeStyle = color;
  diagGraphCtx.lineWidth = 2;
  diagGraphCtx.beginPath();
  history.forEach((value, index) => {
    const x = (index / Math.max(1, history.length - 1)) * width;
    const y = height - (value / 100) * height;
    if (index === 0) diagGraphCtx.moveTo(x, y);
    else diagGraphCtx.lineTo(x, y);
  });
  diagGraphCtx.stroke();
}

function diagnosticGpuUsage(gpu: DiagnosticsSample['gpu']): number | undefined {
  return gpu.utilizationPercent ?? gpu.rendererUtilizationPercent ?? gpu.tilerUtilizationPercent;
}

function diagnosticTrend(history: number[]): string {
  if (history.length < 3) return 'warming';
  const current = history[history.length - 1]!;
  const previous = history[history.length - 3]!;
  const delta = current - previous;
  if (Math.abs(delta) < 3) return 'steady';
  return delta > 0 ? `rising +${Math.round(delta)}%` : `falling ${Math.round(delta)}%`;
}

function rendererMemoryInfo(): RendererMemoryInfo | undefined {
  return (performance as Performance & { memory?: RendererMemoryInfo }).memory;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return 'n/a';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function renderHud(): void {
  providerEl.textContent = providerLine;
  warmupEl.textContent = warmupLine;
  traceEl.textContent = traceLine;
  traceDetailEl.textContent = traceDetail;
  traceToggle.textContent = traceOpen ? 'Hide Runtime Trace' : 'Runtime Trace';
  perfLogToggle.textContent = perfLogStatus.active ? 'Stop Perf Log' : 'Record Perf';
  perfLogLineEl.textContent = perfLogStatus.active
    ? `Recording ${perfLogStatus.samples} samples${perfLogStatus.path ? ` / ${perfLogStatus.path}` : ''}`
    : perfLogStatus.path
      ? `Stopped ${perfLogStatus.samples} samples / ${perfLogStatus.path}`
      : 'Perf log idle';
  devtoolsEl.classList.toggle('collapsed', !traceOpen);
  regionEl.textContent = regionName(player.x, player.y);
  coordEl.textContent = `${Math.round(player.x)}, ${Math.round(player.y)}${performance.now() < wallPulseUntil ? ' / map edge' : ''}`;

  const key = activeNpc ? 'active' : clickableNpcs.map((npc) => `${npc.id}:${npcSession(npc).mood}:${npcSession(npc).willTalkAgain}`).join('|') || 'none';
  if (key !== interactionKey) {
    interactionKey = key;
    if (clickableNpcs.length && !activeNpc) {
      interactionEl.classList.remove('empty');
      const primary = clickableNpcs[0]!;
      const isPrivate = primary.conversationPolicy === 'private';
      const session = npcSession(primary);
      const names = clickableNpcs.slice(0, 3).map((npc) => npc.persona.name).join(', ');
      interactionEl.innerHTML = `
        <div>
          <strong>${escapeHtml(names)}</strong>
          <span>${isPrivate ? 'private conversation' : `click a highlighted person / ${escapeHtml(session.mood)}`}</span>
        </div>
      `;
    } else {
      interactionEl.classList.add('empty');
      interactionEl.innerHTML = `<div><strong>${escapeHtml(regionName(player.x, player.y))}</strong><span>open road</span></div>`;
    }
  }
}

function renderDialogue(): void {
  if (!activeNpc) {
    dialogueEl.classList.add('hidden');
    return;
  }
  dialogueEl.classList.remove('hidden');
  const session = npcSession(activeNpc);
  dialogueNameEl.textContent = activeNpc.persona.name;
  dialogueRoleEl.textContent = `${activeNpc.persona.role} / ${session.mood} / attitude ${session.disposition}`;
  dialogueLogEl.innerHTML = conversation.map((line) => `
    <div class="line ${line.kind}">
      <span>${escapeHtml(line.speaker)}</span>
      <p>${escapeHtml(line.text)}</p>
    </div>
  `).join('');
  dialogueLogEl.scrollTop = dialogueLogEl.scrollHeight;
  dialogueInput.disabled = busy || ended;
  dialogueSend.disabled = busy || ended;
  dialogueGoodbye.disabled = busy;
  dialogueGoodbye.textContent = ended ? 'Leave' : 'Goodbye';
  dialogueInput.placeholder = busy ? 'Waiting for reply...' : ended ? 'Conversation ended' : 'Message';
}

async function startConversation(npc: GeneratedNpc): Promise<void> {
  if (npc.conversationPolicy === 'private') {
    await interruptPrivateConversation(npc);
    return;
  }
  const session = npcSession(npc);
  if (!session.willTalkAgain) {
    const createdAt = performance.now();
    const pos = npcPosition(npc, createdAt, world.npcsNear(npc.x, npc.y, 360));
    bubbles.push({
      id: `${npc.id}:refuses:${createdAt}`,
      npcId: npc.id,
      x: pos.x,
      y: pos.y,
      text: session.refusalReason ?? 'I said enough.',
      startsAt: createdAt,
      expiresAt: createdAt + 4_800
    });
    return;
  }
  activeNpc = npc;
  activeNpcPosition = npcPosition(npc, performance.now());
  busy = false;
  ended = false;
  conversation = [];
  interactionKey = '';
  renderDialogue();
  await sendToNpc('Hello.');
  dialogueInput.focus();
}

async function interruptPrivateConversation(npc: GeneratedNpc): Promise<void> {
  if (groupRefusalInFlight) return;
  groupRefusalInFlight = true;
  try {
    const turn = await ai.dialogue({
      npc: stripRuntimeNpc(npc),
      request: {
        playerText: 'The player tries to interrupt your private conversation. Refuse briefly.',
        scene: currentScene(),
        player: {
          id: 'player',
          knownFacts: playerKnownFacts(),
          visibleEquipment: ['travel cloak', 'worn boots']
        },
        relationship: 'uninvited interruption',
        npcState: sessionForRequest(npc),
        recentDialogue: [
          { speaker: 'System', text: `${npc.persona.name} is already speaking privately with companions.` },
          { speaker: 'You', text: 'Can I ask you something?' }
        ]
      }
    });
    if (turn.trace?.fallback) {
      throw new Error(turn.safetyFlags[0]?.message ?? 'Gemma refusal failed.');
    }
    const pos = wanderedNpcPosition(npc, performance.now());
    const createdAt = performance.now();
    bubbles.push({
      id: `${npc.id}:refusal:${createdAt}`,
      npcId: npc.id,
      x: pos.x,
      y: pos.y,
      text: turn.text,
      startsAt: createdAt,
      expiresAt: createdAt + 5_500
    });
    traceLine = `${turn.trace?.recipeId ?? 'npc.dialogue'} / ${turn.trace?.providerId ?? 'unknown'} / private refusal`;
    traceDetail = turn.trace?.rawText.slice(0, 420) ?? '';
  } catch (error) {
    traceLine = `private refusal failed / ${errorMessage(error)}`;
    traceDetail = '';
  } finally {
    groupRefusalInFlight = false;
  }
}

async function sendToNpc(text: string): Promise<void> {
  if (!activeNpc) return;
  const npc = activeNpc;
  busy = true;
  conversation.push({ speaker: 'You', text, kind: 'player' });
  renderDialogue();
  try {
    const turn = await ai.dialogue({
      npc: stripRuntimeNpc(npc),
      request: {
        playerText: text,
        scene: currentScene(),
        player: {
          id: 'player',
          knownFacts: playerKnownFacts(),
          visibleEquipment: ['travel cloak', 'worn boots']
        },
        relationship: 'new acquaintance',
        npcState: sessionForRequest(npc),
        recentDialogue: conversation.slice(-8).map((line) => ({
          speaker: line.speaker,
          text: line.text
        }))
      }
    });
    if (turn.trace?.fallback) {
      const reason = turn.safetyFlags[0]?.message ?? 'Gemma returned invalid or empty output.';
      throw new Error(`Gemma dialogue failed: ${reason}`);
    }
    if (activeNpc?.id !== npc.id) return;
    applyDialogueTurn(npc, turn);
  } catch (error) {
    if (activeNpc?.id !== npc.id) return;
    const message = errorMessage(error);
    conversation.push({ speaker: 'System', text: message, kind: 'system' });
    traceLine = `dialogue failed / ${message}`;
    traceDetail = '';
  } finally {
    busy = false;
    renderDialogue();
  }
}

function applyDialogueTurn(npc: GeneratedNpc, turn: DialogueTurn): void {
  applyNpcSessionTurn(npc, turn);
  conversation.push({ speaker: npc.persona.name, text: turn.text, kind: 'npc' });
  const createdAt = performance.now();
  const pos = npcPosition(npc, createdAt);
  bubbles.push({
    id: `${npc.id}:${createdAt}`,
    npcId: npc.id,
    x: pos.x,
    y: pos.y,
    text: turn.text,
    startsAt: createdAt,
    expiresAt: createdAt + 6_000
  });
  ended = Boolean(turn.shouldEndConversation || !turn.willTalkAgain);
  if (turn.trace) {
    traceLine = `${turn.trace.recipeId} / ${turn.trace.providerId}${turn.trace.model ? ` / ${turn.trace.model}` : ''} / ${Math.round(turn.trace.latencyMs)}ms / ${turn.trace.cache}`;
    traceDetail = [
      turn.trace.fallback ? 'fallback: true' : 'fallback: false',
      `memory: ${turn.trace.retrievedMemory.length ? turn.trace.retrievedMemory.join(' | ') : 'none'}`,
      `raw: ${turn.trace.rawText.slice(0, 360)}`
    ].join('\n');
  }
}

function closeConversation(): void {
  activeNpc = undefined;
  activeNpcPosition = undefined;
  busy = false;
  ended = false;
  conversation = [];
  interactionKey = '';
  renderDialogue();
}

function npcSession(npc: GeneratedNpc): NpcSession {
  const existing = npcSessions.get(npc.id);
  if (existing) return existing;
  const created: NpcSession = {
    mood: npc.persona.mood ?? 'calm',
    disposition: 0,
    willTalkAgain: true,
    lastBumpedAt: 0,
    bumpInFlight: false
  };
  npcSessions.set(npc.id, created);
  return created;
}

function sessionForRequest(npc: GeneratedNpc): NpcSession {
  const session = npcSession(npc);
  return {
    mood: session.mood,
    disposition: session.disposition,
    willTalkAgain: session.willTalkAgain,
    ...(session.refusalReason ? { refusalReason: session.refusalReason } : {}),
    lastBumpedAt: session.lastBumpedAt,
    bumpInFlight: session.bumpInFlight
  };
}

function applyNpcSessionTurn(npc: GeneratedNpc, turn: DialogueTurn): void {
  const session = npcSession(npc);
  session.mood = turn.mood;
  session.disposition = Math.max(-100, Math.min(100, session.disposition + turn.attitudeDelta));
  session.willTalkAgain = turn.willTalkAgain;
  if (turn.refusalReason) {
    session.refusalReason = turn.refusalReason;
  } else if (!turn.willTalkAgain) {
    session.refusalReason = 'I am done talking to you.';
  }
  interactionKey = '';
}

function maybeRequestAmbient(now: number, nearby: GeneratedNpc[]): void {
  if (activeNpc || busy) return;
  if (!ambientCacheReady) return;
  const close = nearby.filter((npc) => distance(wanderedNpcPosition(npc, now), player) < 390);
  const privateGroup = firstReadyPrivateGroup(close, now);
  if (privateGroup && !overhearInFlight) {
    overhearInFlight = true;
    for (const member of privateGroup) {
      member.lastOverheardAt = now;
    }
    const [a, b] = privateGroup;
    if (a && b) {
      void ai.overhear({
        npc: stripRuntimeNpc(a),
        request: overhearRequest(a, b, 'private'),
        options: {
          cacheOnly: true
        }
      }).then((exchange) => {
        if (exchange.trace?.fallback) {
          traceLine = 'group overhear cache miss / waiting for pregeneration';
          traceDetail = '';
          return;
        }
        applyOverheard(exchange, [a, b]);
      })
        .catch((error) => {
          traceLine = `group overhear failed / ${errorMessage(error)}`;
        })
        .finally(() => {
          overhearInFlight = false;
        });
      return;
    }
  }

  if (!ambientInFlight) {
    const npc = close.find((candidate) => candidate.conversationPolicy === 'open' && now - candidate.lastBarkAt > 18_000 + (candidate.x % 11) * 1_000);
    if (npc) {
      ambientInFlight = true;
      npc.lastBarkAt = now;
      void ai.bark({
        npc: stripRuntimeNpc(npc),
        request: ambientBarkRequest(npc),
        options: {
          cacheOnly: true
        }
      }).then((bark) => {
        if (bark.trace?.fallback) {
          traceLine = 'bark cache miss / waiting for pregeneration';
          traceDetail = '';
          return;
        }
        const pos = wanderedNpcPosition(npc, performance.now());
        const createdAt = performance.now();
        bubbles.push({
          id: `${npc.id}:bark:${now}`,
          npcId: npc.id,
          x: pos.x,
          y: pos.y,
          text: bark.text,
          startsAt: createdAt,
          expiresAt: createdAt + 4_800
        });
      }).catch((error) => {
        traceLine = `bark failed / ${errorMessage(error)}`;
      }).finally(() => {
        ambientInFlight = false;
      });
    }
  }

  if (!overhearInFlight && close.length >= 2) {
    const [a, b] = close
      .filter((npc) => npc.conversationPolicy === 'open')
      .sort((left, right) => distance(wanderedNpcPosition(left, now), player) - distance(wanderedNpcPosition(right, now), player));
    if (a && b && distance(wanderedNpcPosition(a, now), wanderedNpcPosition(b, now)) < 430 && now - a.lastOverheardAt > 32_000 && now - b.lastOverheardAt > 32_000) {
      overhearInFlight = true;
      a.lastOverheardAt = now;
      b.lastOverheardAt = now;
      void ai.overhear({
        npc: stripRuntimeNpc(a),
        request: overhearRequest(a, b, 'open'),
        options: {
          cacheOnly: true
        }
      }).then((exchange) => {
        if (exchange.trace?.fallback) {
          traceLine = 'overhear cache miss / waiting for pregeneration';
          traceDetail = '';
          return;
        }
        applyOverheard(exchange, [a, b]);
      })
        .catch((error) => {
          traceLine = `overhear failed / ${errorMessage(error)}`;
        })
        .finally(() => {
          overhearInFlight = false;
        });
    }
  }
}

function firstReadyPrivateGroup(close: GeneratedNpc[], now: number): GeneratedNpc[] | undefined {
  const groups = new Map<string, GeneratedNpc[]>();
  for (const npc of close) {
    if (npc.conversationPolicy !== 'private' || !npc.groupId) continue;
    const members = groups.get(npc.groupId) ?? [];
    members.push(npc);
    groups.set(npc.groupId, members);
  }

  for (const members of groups.values()) {
    if (members.length < 2) continue;
    if (members.every((member) => now - member.lastOverheardAt > 12_000 + (member.wanderSeed % 5) * 1_000)) {
      return members
        .sort((left, right) => distance(wanderedNpcPosition(left, now), player) - distance(wanderedNpcPosition(right, now), player))
        .slice(0, 2);
    }
  }
  return undefined;
}

function privateTopicForGroup(npc: GeneratedNpc): string {
  const landmark = landmarks[npc.wanderSeed % landmarks.length];
  const topics = [
    'a private argument about whether the road moved overnight',
    landmark ? `quiet worry that ${landmark.rumor}` : 'quiet worry about smoke near the old mill',
    'whether to trust the next traveler who asks too many questions',
    'a disagreement over which waystone is lying'
  ];
  return topics[npc.wanderSeed % topics.length]!;
}

function landmarkRumorTopic(npc: GeneratedNpc): string {
  const nearby = nearestLandmarks(npc, 1800);
  const landmark = nearby[0] ?? landmarks[npc.wanderSeed % landmarks.length];
  return landmark
    ? `${landmark.name}: ${landmark.rumor}. Speak as locals who fear it but do not know the true cause.`
    : 'road rumors near the old mill';
}

function ambientBarkRequest(npc: GeneratedNpc) {
  return {
    scene: sceneAt(npc),
    player: {
      id: 'player',
      knownFacts: playerKnownFacts(),
      visibleEquipment: ['travel cloak', 'worn boots']
    },
    reason: `ambient local rumor: ${landmarkRumorTopic(npc)}`
  };
}

function overhearRequest(a: GeneratedNpc, b: GeneratedNpc, mode: 'private' | 'open') {
  return {
    otherNpc: stripRuntimeNpc(b),
    scene: sceneAt(a),
    topic: mode === 'private' ? privateTopicForGroup(a) : landmarkRumorTopic(a)
  };
}

function bumpDialogueRequest(npc: GeneratedNpc) {
  return {
    playerText: 'The player just bumped into you while walking. React briefly as if they were rude.',
    scene: sceneAt(npc),
    player: {
      id: 'player',
      knownFacts: playerKnownFacts(),
      visibleEquipment: ['travel cloak', 'worn boots']
    },
    relationship: 'the player just collided with you rudely',
    npcState: sessionForRequest(npc),
    recentDialogue: [
      { speaker: 'System', text: 'The player physically bumped into this NPC.' }
    ]
  };
}

function bumpCacheKey(npc: GeneratedNpc): string {
  return `dialogue:bump:${npc.id}`;
}

function applyOverheard(exchange: OverheardExchange, npcs: GeneratedNpc[]): void {
  const byId = new Map(npcs.map((npc) => [npc.id, npc]));
  const base = performance.now();
  for (let index = 0; index < exchange.lines.length; index += 1) {
    const line = exchange.lines[index];
    if (!line) continue;
    const npc = byId.get(line.npcId) ?? npcs[0];
    if (!npc) continue;
    const startsAt = base + index * 1_350;
    const pos = wanderedNpcPosition(npc, startsAt);
    bubbles.push({
      id: `${line.npcId}:overheard:${startsAt}`,
      npcId: line.npcId,
      x: pos.x,
      y: pos.y,
      text: line.text,
      startsAt,
      expiresAt: startsAt + 5_600
    });
  }
  if (exchange.trace) {
    traceLine = `${exchange.trace.recipeId} / ${exchange.trace.providerId} / ${Math.round(exchange.trace.latencyMs)}ms`;
    traceDetail = exchange.trace.rawText.slice(0, 420);
  }
}

function currentScene() {
  return sceneAt(player);
}

function sceneAt(point: Vec2) {
  const nearbyLandmarks = nearestLandmarks(point, 1350);
  return {
    location: regionName(point.x, point.y),
    biome: world.terrainAt(point.x, point.y).biome,
    timeOfDay: 'late afternoon',
    weather: 'thin cloud',
    nearbyCharacters: world.npcsNear(point.x, point.y, 320).map((npc) => npc.id),
    coordinates: {
      x: Math.round(point.x),
      y: Math.round(point.y)
    },
    visibleLandmarks: visibleLandmarks(point),
    landmarkLore: nearbyLandmarks.map((landmark) => `${landmark.name}: ${landmark.lore}`)
  };
}

function visibleLandmarks(point: Vec2 = player): string[] {
  const nearby = nearestLandmarks(point, 1350).map((landmark) => landmark.name);
  const ambient = ['waystone', 'split pine', 'low ridge']
    .filter((_, index) => Math.abs(Math.round(point.x / 700) + Math.round(point.y / 700) + index) % 3 === 0);
  return [...nearby, ...ambient].slice(0, 5);
}

function playerKnownFacts(): string[] {
  return [
    'The old mill is avoided after dark.',
    ...landmarkLoreLines()
  ];
}

function stripRuntimeNpc(npc: GeneratedNpc) {
  const session = npcSession(npc);
  return {
    id: npc.id,
    persona: {
      ...npc.persona,
      mood: session.mood,
      knows: [
        ...(npc.persona.knows ?? []),
        ...landmarkLoreLines()
      ]
    },
    memory: npc.memory
  };
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

function triangle(x: number, y: number, width: number, height: number): void {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - width / 2, y + height);
  ctx.lineTo(x + width / 2, y + height);
  ctx.closePath();
  ctx.fill();
}

function roundedRect(x: number, y: number, width: number, height: number, radius: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
}

function label(text: string, x: number, y: number, color: string): void {
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

function treeCollisionCenter(tree: Tree): Vec2 {
  return { x: tree.x, y: tree.y + tree.size * 0.26 };
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

function circleRectIntersects(circle: Vec2, radius: number, rect: { x: number; y: number; width: number; height: number }): boolean {
  const nearestX = Math.max(rect.x, Math.min(circle.x, rect.x + rect.width));
  const nearestY = Math.max(rect.y, Math.min(circle.y, rect.y + rect.height));
  return distance(circle, { x: nearestX, y: nearestY }) < radius;
}

function resize(): void {
  dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  cssWidth = window.innerWidth;
  cssHeight = window.innerHeight;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  canvas.width = Math.floor(cssWidth * dpr);
  canvas.height = Math.floor(cssHeight * dpr);
  const minimapRect = minimapCanvas.getBoundingClientRect();
  const minimapWidth = Math.max(180, minimapRect.width || 218);
  const minimapHeight = Math.max(132, minimapRect.height || 152);
  minimapCanvas.width = Math.floor(minimapWidth * dpr);
  minimapCanvas.height = Math.floor(minimapHeight * dpr);
  const graphRect = diagGraphCanvas.getBoundingClientRect();
  const graphWidth = Math.max(260, graphRect.width || 340);
  const graphHeight = Math.max(82, graphRect.height || 96);
  diagGraphCanvas.width = Math.floor(graphWidth * dpr);
  diagGraphCanvas.height = Math.floor(graphHeight * dpr);
  drawDiagnosticsGraph();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createRequiredGameAI() {
  try {
    return getGameAI();
  } catch (error) {
    hud.innerHTML = `
      <div class="fatal">
        <strong>Gemma bridge unavailable</strong>
        <p>${escapeHtml(errorMessage(error))}</p>
        <p>Start this demo with <code>npm start</code> or <code>npm run dev</code> and use the Electron window, not the Vite browser URL.</p>
      </div>
    `;
    throw error;
  }
}
