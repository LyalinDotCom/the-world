import type { DialogueTurn, OverheardExchange } from '@game-llm/core';
import type { GameAIPreGenerateJob } from '@game-llm/electron';
import { AmbientDirector, ambientPairKey } from './ambientDirector.js';
import { getGameAI } from './aiClient.js';
import { canNpcStand as canNpcStandInWorld, findSafeSpawn as findSafeSpawnInWorld, resolvePlayerMove as resolvePlayerMoveInWorld, staticCollisionAt as staticCollisionAtInWorld } from './collision.js';
import { DialogueController } from './dialogueController.js';
import { diagnosticGpuUsage, diagnosticTrend, drawDiagnosticsGraph as drawDiagnosticsGraphCanvas, formatBytes, rendererMemoryInfo } from './diagnosticsHud.js';
import { FpsCounter, startGameLoop } from './gameLoop.js';
import { drawActors } from './rendering/actors.js';
import { drawMapBorder as drawMapBoundary, drawStaticWorld } from './rendering/staticWorld.js';
import { cameraForPoint, drawMinimap as drawMinimapView } from './worldView.js';
import type { DiagnosticsSample, PerfLogStatus } from '../shared/bridge.js';
import {
  ProceduralWorld,
  clampToMap,
  distance,
  isInsideMap,
  landmarkLoreLines,
  landmarks,
  nearestLandmarks,
  randomTownSpawn,
  regionName,
  towns,
  wanderedNpcPosition,
  type GeneratedNpc,
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
  kind: 'ambient' | 'dialogue' | 'reaction';
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

interface AmbientMeetup {
  npcIds: [string, string];
  center: Vec2;
  startedAt: number;
  expiresAt: number;
}

interface Constable {
  id: string;
  name: string;
  x: number;
  y: number;
  target: Vec2;
  patrolSeed: number;
  spawnedAt: number;
  expiresAt: number;
  reason: string;
}

type DiagnosticsTab = 'trace' | 'machine' | 'perf';

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
const dialogueController = new DialogueController();
const playerRadius = 15;
const spawn = findSafeSpawnInWorld(randomTownSpawn(), world, playerRadius);
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
let ambientMeetups: AmbientMeetup[] = [];
let constables: Constable[] = [];
const ambientDirector = new AmbientDirector({ maxSpeakers: 2 });
let footsteps: Footstep[] = [];
let lastFootstepAt = 0;
let wallPulseUntil = 0;
let interactionKey = '';
let activeNpcPosition: Vec2 | undefined;
let activeDialogueRequestId: string | undefined;
let traceOpen = false;
let clickableNpcs: GeneratedNpc[] = [];
let diagnosticsHistory: number[] = [];
let cpuHistory: number[] = [];
let fpsHistory: number[] = [];
let latestDiagnostics: DiagnosticsSample | undefined;
let fps = 0;
const fpsCounter = new FpsCounter();
let perfLogStatus: PerfLogStatus = { active: false, samples: 0 };
let perfLogLastSampleAt = 0;
let perfLogWriteInFlight = false;
let diagnosticsTab: DiagnosticsTab = 'machine';
let diagnosticsGraphOpen = true;

hud.innerHTML = `
  <div class="topbar">
    <div class="brand">
      <strong>The World</strong>
      <span id="provider-line"></span>
    </div>
    <div class="meters">
      <span id="fps-pill" class="fps-pill">-- fps</span>
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
  <aside id="devtools" class="devtools collapsed" aria-label="Runtime diagnostics">
    <div class="devtools-chrome">
      <div class="devtools-title">
        <strong>Diagnostics</strong>
        <span id="devtools-status">collapsed</span>
      </div>
      <button id="devtools-toggle" class="devtools-toggle" type="button" aria-expanded="false">Expand</button>
    </div>
    <div id="devtools-body" class="devtools-body">
      <div class="devtools-tabs" role="tablist" aria-label="Runtime diagnostics">
        <button id="tab-machine" class="devtools-tab active" type="button">Machine</button>
        <button id="tab-trace" class="devtools-tab" type="button">Trace</button>
        <button id="tab-perf" class="devtools-tab" type="button">Perf</button>
      </div>
      <div id="panel-machine" class="devtools-panel">
        <header>Machine Diagnostics</header>
        <div class="diagnostics-grid">
          <div><span>Model</span><strong id="diag-model">pending</strong></div>
          <div><span>CPU Load</span><strong id="diag-cpu">pending</strong></div>
          <div><span>GPU Load</span><strong id="diag-gpu">pending</strong></div>
          <div><span>GPU Memory</span><strong id="diag-gpu-memory">pending</strong></div>
          <div><span>Machine Memory</span><strong id="diag-system-memory">pending</strong></div>
          <div><span>App Memory</span><strong id="diag-app-memory">pending</strong></div>
          <div><span>Ambient Flow</span><strong id="diag-flow">pending</strong></div>
        </div>
      </div>
      <div id="panel-trace" class="devtools-panel hidden">
        <header>Runtime Trace</header>
        <div id="warmup-line" class="devrow"></div>
        <div id="trace-line" class="devrow"></div>
        <pre id="trace-detail"></pre>
      </div>
      <div id="panel-perf" class="devtools-panel hidden">
        <header>Performance Capture</header>
        <button id="perf-log-toggle" class="perf-log-toggle" type="button">Record Perf</button>
        <div id="perf-log-line" class="devrow perf-log-line">Perf log idle</div>
        <button id="graph-toggle" class="graph-toggle" type="button">Hide Graph</button>
        <div id="diag-graph-wrap" class="diag-graph-wrap">
          <canvas id="diag-graph" aria-label="FPS CPU GPU graph"></canvas>
          <div id="diag-graph-label" class="diag-graph-label">Perf trend pending</div>
        </div>
      </div>
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
const fpsPillEl = document.querySelector<HTMLElement>('#fps-pill')!;
const diagModelEl = document.querySelector<HTMLElement>('#diag-model')!;
const diagCpuEl = document.querySelector<HTMLElement>('#diag-cpu')!;
const diagGpuEl = document.querySelector<HTMLElement>('#diag-gpu')!;
const diagGpuMemoryEl = document.querySelector<HTMLElement>('#diag-gpu-memory')!;
const diagSystemMemoryEl = document.querySelector<HTMLElement>('#diag-system-memory')!;
const diagAppMemoryEl = document.querySelector<HTMLElement>('#diag-app-memory')!;
const diagFlowEl = document.querySelector<HTMLElement>('#diag-flow')!;
const diagGraphCanvas = document.querySelector<HTMLCanvasElement>('#diag-graph')!;
const diagGraphLabelEl = document.querySelector<HTMLElement>('#diag-graph-label')!;
const diagGraphWrapEl = document.querySelector<HTMLElement>('#diag-graph-wrap')!;
const perfLogToggle = document.querySelector<HTMLButtonElement>('#perf-log-toggle')!;
const perfLogLineEl = document.querySelector<HTMLElement>('#perf-log-line')!;
const graphToggle = document.querySelector<HTMLButtonElement>('#graph-toggle')!;
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
const devtoolsToggle = document.querySelector<HTMLButtonElement>('#devtools-toggle')!;
const devtoolsStatusEl = document.querySelector<HTMLElement>('#devtools-status')!;
const tabMachine = document.querySelector<HTMLButtonElement>('#tab-machine')!;
const tabTrace = document.querySelector<HTMLButtonElement>('#tab-trace')!;
const tabPerf = document.querySelector<HTMLButtonElement>('#tab-perf')!;
const panelMachine = document.querySelector<HTMLElement>('#panel-machine')!;
const panelTrace = document.querySelector<HTMLElement>('#panel-trace')!;
const panelPerf = document.querySelector<HTMLElement>('#panel-perf')!;
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
devtoolsToggle.addEventListener('click', () => {
  traceOpen = !traceOpen;
  renderHud();
});
tabMachine.addEventListener('click', () => {
  diagnosticsTab = 'machine';
  renderHud();
});
tabTrace.addEventListener('click', () => {
  diagnosticsTab = 'trace';
  renderHud();
});
tabPerf.addEventListener('click', () => {
  diagnosticsTab = 'perf';
  renderHud();
});
graphToggle.addEventListener('click', () => {
  diagnosticsGraphOpen = !diagnosticsGraphOpen;
  renderHud();
});
perfLogToggle.addEventListener('click', () => {
  void togglePerfLog();
});

resize();
void initializeRuntime();
void updateDiagnostics();
window.setInterval(() => void updateDiagnostics(), 1_500);
startGameLoop(frame);

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
  fps = fpsCounter.recordFrame(now);
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  update(dt, now);
  draw(now);
  void maybeWritePerfLogSample(now);
}

function update(dt: number, now: number): void {
  player.moving = false;
  const nearby = world.npcsNear(player.x, player.y, 760);
  ambientMeetups = ambientMeetups.filter((meetup) => meetup.expiresAt > now);
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
      const resolved = resolvePlayerMoveInWorld(previous, desired, player.radius, world);
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
  updateConstables(dt, now);
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
  drawStaticWorld({ ctx, world, camera, width: cssWidth, height: cssHeight });
  const npcs = world.npcsNear(player.x, player.y, Math.max(cssWidth, cssHeight));
  drawActors({
    ctx,
    camera,
    now,
    player,
    npcs,
    clickableNpcIds: new Set(clickableNpcs.map((npc) => npc.id)),
    activeNpcId: activeNpc?.id,
    constables,
    footsteps,
    bubbles,
    npcPosition: (npc) => npcPosition(npc, now, npcs)
  });
  drawMapBoundary({ ctx, world, camera, width: cssWidth, height: cssHeight, now, wallPulseUntil });
  drawMinimap(now, npcs);
}

function cameraForPlayer(): Vec2 {
  return cameraForPoint(player, { width: cssWidth, height: cssHeight });
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

function npcPosition(npc: GeneratedNpc, now: number, crowd: GeneratedNpc[] = []): Vec2 {
  if (activeNpc?.id === npc.id && activeNpcPosition) {
    return activeNpcPosition;
  }
  const meetup = ambientMeetupForNpc(npc.id, now);
  if (meetup) {
    const raw = wanderedNpcPosition(npc, now);
    const index = meetup.npcIds[0] === npc.id ? 0 : 1;
    const side = index === 0 ? -1 : 1;
    const target = clampToMap({
      x: meetup.center.x + side * 30,
      y: meetup.center.y + (index === 0 ? -8 : 8)
    }, 42);
    const progress = Math.max(0, Math.min(1, (now - meetup.startedAt) / 1_500));
    const eased = 1 - Math.pow(1 - progress, 3);
    const point = {
      x: raw.x + (target.x - raw.x) * eased,
      y: raw.y + (target.y - raw.y) * eased
    };
    if (canNpcStand(point)) {
      return point;
    }
  }
  const raw = wanderedNpcPosition(npc, now);
  if (!canNpcStand(raw)) {
    return npcFallbackPosition(npc);
  }
  return raw;
}

function ambientMeetupForNpc(npcId: string, now: number): AmbientMeetup | undefined {
  return ambientMeetups.find((meetup) => meetup.expiresAt > now && meetup.npcIds.includes(npcId));
}

function npcFallbackPosition(npc: GeneratedNpc): Vec2 {
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
    if (canNpcStand(candidate)) {
      return candidate;
    }
  }
  return { x: npc.x, y: npc.y };
}

function canNpcStand(point: Vec2): boolean {
  return canNpcStandInWorld(point, world);
}

function updateConstables(dt: number, now: number): void {
  constables = constables.filter((constable) => constable.expiresAt > now);
  for (const constable of constables) {
    const arrived = now - constable.spawnedAt > 2_800 || distance(constable, constable.target) < 10;
    const patrolTarget = arrived
      ? {
        x: constable.target.x + Math.cos(now * 0.0011 + constable.patrolSeed) * 82,
        y: constable.target.y + Math.sin(now * 0.0014 + constable.patrolSeed) * 54
      }
      : constable.target;
    const dx = patrolTarget.x - constable.x;
    const dy = patrolTarget.y - constable.y;
    const length = Math.hypot(dx, dy);
    if (length < 1) continue;
    const speed = arrived ? 92 : 250;
    const step = Math.min(length, speed * dt);
    const next = clampToMap({
      x: constable.x + (dx / length) * step,
      y: constable.y + (dy / length) * step
    }, 32);
    if (!staticCollisionAtInWorld(next, 14, world)) {
      constable.x = next.x;
      constable.y = next.y;
    }
  }
}

function drawMinimap(now: number, npcs: GeneratedNpc[]): void {
  drawMinimapView({
    canvas: minimapCanvas,
    context: minimapCtx,
    dpr,
    player,
    npcs,
    constables,
    npcPosition: (npc) => npcPosition(npc, now, npcs)
  });
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
  updateAmbientFlowLine();

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
  drawDiagnosticsGraphCanvas({
    canvas: diagGraphCanvas,
    context: diagGraphCtx,
    dpr,
    fpsHistory,
    cpuHistory,
    gpuHistory: diagnosticsHistory
  });
}

function renderHud(): void {
  providerEl.textContent = providerLine;
  diagModelEl.textContent = modelDiagnosticLine();
  warmupEl.textContent = warmupLine;
  traceEl.textContent = traceLine;
  traceDetailEl.textContent = traceDetail;
  fpsPillEl.textContent = fps > 0 ? `${fps} fps` : '-- fps';
  traceToggle.textContent = traceOpen ? 'Diagnostics open' : 'Diagnostics';
  traceToggle.setAttribute('aria-expanded', String(traceOpen));
  devtoolsToggle.textContent = traceOpen ? 'Collapse' : 'Expand';
  devtoolsToggle.setAttribute('aria-expanded', String(traceOpen));
  devtoolsStatusEl.textContent = diagnosticsStatusLine();
  perfLogToggle.textContent = perfLogStatus.active ? 'Stop Perf Log' : 'Record Perf';
  perfLogLineEl.textContent = perfLogStatus.active
    ? `Recording ${perfLogStatus.samples} samples${perfLogStatus.path ? ` / ${perfLogStatus.path}` : ''}`
    : perfLogStatus.path
      ? `Stopped ${perfLogStatus.samples} samples / ${perfLogStatus.path}`
      : 'Perf log idle';
  devtoolsEl.classList.toggle('collapsed', !traceOpen);
  tabMachine.classList.toggle('active', diagnosticsTab === 'machine');
  tabTrace.classList.toggle('active', diagnosticsTab === 'trace');
  tabPerf.classList.toggle('active', diagnosticsTab === 'perf');
  panelMachine.classList.toggle('hidden', diagnosticsTab !== 'machine');
  panelTrace.classList.toggle('hidden', diagnosticsTab !== 'trace');
  panelPerf.classList.toggle('hidden', diagnosticsTab !== 'perf');
  graphToggle.textContent = diagnosticsGraphOpen ? 'Graph ^' : 'Graph v';
  graphToggle.setAttribute('aria-expanded', String(diagnosticsGraphOpen));
  diagGraphWrapEl.classList.toggle('hidden', !diagnosticsGraphOpen);
  updateAmbientFlowLine();
  regionEl.textContent = regionName(player.x, player.y);
  coordEl.textContent = `${Math.round(player.x)}, ${Math.round(player.y)}${performance.now() < wallPulseUntil ? ' / map edge' : ''}`;

  const key = activeNpc ? 'active' : clickableNpcs.map((npc) => {
    const session = dialogueController.sessionFor(npc);
    return `${npc.id}:${session.mood}:${session.willTalkAgain}`;
  }).join('|') || 'none';
  if (key !== interactionKey) {
    interactionKey = key;
    if (clickableNpcs.length && !activeNpc) {
      interactionEl.classList.remove('empty');
      const primary = clickableNpcs[0]!;
      const isPrivate = primary.conversationPolicy === 'private';
      const session = dialogueController.sessionFor(primary);
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

function modelDiagnosticLine(): string {
  const model = providerBaseLine.match(/\/\s*([^/]+)\s*\/\s*(ready|degraded|unavailable|mock)/)?.[1]?.trim();
  return model ? `${model} / ${providerBaseLine.split('/')[0]?.trim() ?? 'provider'}` : providerBaseLine;
}

function diagnosticsStatusLine(): string {
  const parts = [
    diagnosticsTab,
    fps > 0 ? `${fps} fps` : 'fps pending'
  ];
  const gpuUsage = latestDiagnostics ? diagnosticGpuUsage(latestDiagnostics.gpu) : undefined;
  if (typeof gpuUsage === 'number') {
    parts.push(`gpu ${gpuUsage}%`);
  }
  return parts.join(' / ');
}

function renderDialogue(): void {
  if (!activeNpc) {
    dialogueEl.classList.add('hidden');
    return;
  }
  dialogueEl.classList.remove('hidden');
  const session = dialogueController.sessionFor(activeNpc);
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
  const session = dialogueController.sessionFor(npc);
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
      expiresAt: createdAt + 4_800,
      kind: 'reaction'
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
        npcState: dialogueController.stateForRequest(npc),
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
      expiresAt: createdAt + 5_500,
      kind: 'reaction'
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
  const requestId = nextAiRequestId('dialogue', npc.id);
  activeDialogueRequestId = requestId;
  busy = true;
  const thinkingBubbleId = showThinkingBubble(npc);
  conversation.push({ speaker: 'You', text, kind: 'player' });
  renderDialogue();
  try {
    const turn = await ai.dialogue({
      requestId,
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
        npcState: dialogueController.stateForRequest(npc),
        recentDialogue: conversation.slice(-8).map((line) => ({
          speaker: line.speaker,
          text: line.text
        }))
      },
      options: {
        assess: true
      }
    });
    if (turn.trace?.fallback) {
      const reason = turn.safetyFlags[0]?.message ?? 'Gemma returned invalid or empty output.';
      throw new Error(`Gemma dialogue failed: ${reason}`);
    }
    if (activeNpc?.id !== npc.id) return;
    clearBubble(thinkingBubbleId);
    applyDialogueTurn(npc, turn);
  } catch (error) {
    if (activeNpc?.id !== npc.id) return;
    clearBubble(thinkingBubbleId);
    const message = errorMessage(error);
    conversation.push({ speaker: 'System', text: message, kind: 'system' });
    traceLine = `dialogue failed / ${message}`;
    traceDetail = '';
  } finally {
    if (activeDialogueRequestId === requestId) {
      activeDialogueRequestId = undefined;
    }
    clearBubble(thinkingBubbleId);
    busy = false;
    renderDialogue();
  }
}

function applyDialogueTurn(npc: GeneratedNpc, turn: DialogueTurn): void {
  dialogueController.applyTurn(npc, turn);
  interactionKey = '';
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
    expiresAt: createdAt + 6_000,
    kind: 'dialogue'
  });
  if (turn.action?.type === 'callForHelp') {
    spawnConstables(npc, turn.action.reason);
  }
  ended = Boolean(turn.shouldEndConversation || !turn.willTalkAgain || turn.action?.type === 'callForHelp');
  if (turn.trace) {
    traceLine = `${turn.trace.recipeId} / ${turn.trace.providerId}${turn.trace.model ? ` / ${turn.trace.model}` : ''} / ${Math.round(turn.trace.latencyMs)}ms / ${turn.trace.cache}`;
    traceDetail = [
      turn.trace.fallback ? 'fallback: true' : 'fallback: false',
      `memory: ${turn.trace.retrievedMemory.length ? turn.trace.retrievedMemory.join(' | ') : 'none'}`,
      turn.assessment ? `assessment: ${turn.assessment.mood} / ${turn.assessment.dangerLevel} / ${turn.assessment.reason}` : '',
      turn.action ? `action: ${turn.action.type} / ${turn.action.reason}` : '',
      turn.analysisTraces?.length ? `analysis: ${turn.analysisTraces.map((trace) => `${trace.recipeId} ${Math.round(trace.latencyMs)}ms`).join(' | ')}` : '',
      `raw: ${turn.trace.rawText.slice(0, 360)}`
    ].filter(Boolean).join('\n');
  }
}

function showThinkingBubble(npc: GeneratedNpc): string {
  const createdAt = performance.now();
  const pos = npcPosition(npc, createdAt);
  const id = `${npc.id}:thinking:${createdAt}`;
  bubbles.push({
    id,
    npcId: npc.id,
    x: pos.x,
    y: pos.y,
    text: `${npc.persona.name} thinks...`,
    startsAt: createdAt + 200,
    expiresAt: createdAt + 30_000,
    kind: 'reaction'
  });
  return id;
}

function clearBubble(id: string): void {
  bubbles = bubbles.filter((bubble) => bubble.id !== id);
}

function spawnConstables(npc: GeneratedNpc, reason: string): void {
  const now = performance.now();
  if (constables.some((constable) => constable.expiresAt > now && distance(constable.target, player) < 340)) {
    return;
  }
  const origin = activeNpcPosition ?? npcPosition(npc, now);
  const names = ['Constable Rusk', 'Constable Vale'];
  for (let index = 0; index < 2; index += 1) {
    const angle = player.heading + Math.PI + (index === 0 ? -0.55 : 0.55);
    const spawnPoint = clampToMap({
      x: player.x + Math.cos(angle) * 520,
      y: player.y + Math.sin(angle) * 360
    }, 70);
    const target = clampToMap({
      x: origin.x + (index === 0 ? -62 : 62),
      y: origin.y + (index === 0 ? 34 : -34)
    }, 70);
    constables.push({
      id: `constable.${Math.round(now)}.${index}`,
      name: names[index]!,
      x: spawnPoint.x,
      y: spawnPoint.y,
      target,
      patrolSeed: now * 0.001 + index * 2.4,
      spawnedAt: now,
      expiresAt: now + 95_000,
      reason
    });
  }
  const pos = npcPosition(npc, now);
  bubbles.push({
    id: `${npc.id}:help:${now}`,
    npcId: npc.id,
    x: pos.x,
    y: pos.y,
    text: 'Constables! Over here!',
    startsAt: now,
    expiresAt: now + 5_200,
    kind: 'dialogue'
  });
}

function closeConversation(): void {
  cancelActiveDialogueRequest();
  activeNpc = undefined;
  activeNpcPosition = undefined;
  busy = false;
  ended = false;
  conversation = [];
  interactionKey = '';
  renderDialogue();
}

function nextAiRequestId(kind: string, ownerId: string): string {
  return `${kind}:${ownerId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function cancelActiveDialogueRequest(): void {
  if (!activeDialogueRequestId) return;
  const requestId = activeDialogueRequestId;
  activeDialogueRequestId = undefined;
  void ai.cancel({ requestId }).catch(() => undefined);
}

function maybeRequestAmbient(now: number, nearby: GeneratedNpc[]): void {
  if (activeNpc || busy || !ambientCacheReady) return;
  ambientDirector.prune(now);
  if (now < ambientDirector.nextAmbientAt) return;
  if (ambientInFlight || overhearInFlight) return;
  if (ambientDirector.visibleSpeakers(bubbles, now).size >= ambientDirector.maxSpeakers) {
    ambientDirector.scheduleNext(now, 2_800, 5_200);
    return;
  }

  const close = nearby
    .filter((npc) => distance(npcPosition(npc, now, nearby), player) < 520)
    .sort((left, right) => distance(npcPosition(left, now, nearby), player) - distance(npcPosition(right, now, nearby), player));

  const privateGroup = firstReadyPrivateGroup(close, now);
  if (privateGroup) {
    const [a, b] = privateGroup;
    if (a && b && tryStartOverheard(a, b, 'private', now, close)) return;
  }

  const openPair = firstReadyOpenPair(close, now);
  if (openPair && tryStartOverheard(openPair[0], openPair[1], 'open', now, close)) return;

  if (now - ambientDirector.lastAnnouncementAt > 42_000) {
    const announcer = firstReadyAnnouncer(close, now);
    if (announcer && tryStartAnnouncement(announcer, now, nearby)) return;
  }

  ambientDirector.scheduleNext(now, 4_000, 7_000);
}

function firstReadyPrivateGroup(close: GeneratedNpc[], now: number): GeneratedNpc[] | undefined {
  const groups = new Map<string, GeneratedNpc[]>();
  for (const npc of close) {
    if (npc.conversationPolicy !== 'private' || !npc.groupId) continue;
    if (!ambientDirector.speakerReady(npc, bubbles, now)) continue;
    const members = groups.get(npc.groupId) ?? [];
    members.push(npc);
    groups.set(npc.groupId, members);
  }

  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const pair = members
      .sort((left, right) => distance(npcPosition(left, now, members), player) - distance(npcPosition(right, now, members), player))
      .slice(0, 2);
    const [a, b] = pair;
    if (!a || !b) continue;
    if (!ambientDirector.pairReady(a, b, privateTopicKey(a), now)) continue;
    if (ambientDirector.canStartFor(pair, bubbles, now)) return pair;
  }
  return undefined;
}

function firstReadyOpenPair(close: GeneratedNpc[], now: number): [GeneratedNpc, GeneratedNpc] | undefined {
  const eligible = close
    .filter((npc) => npc.conversationPolicy === 'open' && ambientDirector.speakerReady(npc, bubbles, now))
    .sort((left, right) => distance(npcPosition(left, now, close), player) - distance(npcPosition(right, now, close), player));

  for (let index = 0; index < eligible.length; index += 1) {
    const a = eligible[index];
    if (!a) continue;
    const aPos = npcPosition(a, now, close);
    const candidates = eligible
      .slice(index + 1)
      .filter((candidate) => distance(aPos, npcPosition(candidate, now, close)) < 560)
      .sort((left, right) => distance(aPos, npcPosition(left, now, close)) - distance(aPos, npcPosition(right, now, close)));
    for (const b of candidates) {
      if (!ambientDirector.pairReady(a, b, landmarkTopicKey(a), now)) continue;
      if (ambientDirector.canStartFor([a, b], bubbles, now)) return [a, b];
    }
  }
  return undefined;
}

function firstReadyAnnouncer(close: GeneratedNpc[], now: number): GeneratedNpc | undefined {
  return close
    .filter((npc) => npc.conversationPolicy === 'open' && ambientDirector.speakerReady(npc, bubbles, now))
    .sort((left, right) => announcementPriority(right) - announcementPriority(left) || distance(npcPosition(left, now, close), player) - distance(npcPosition(right, now, close), player))[0];
}

function announcementPriority(npc: GeneratedNpc): number {
  if (npc.persona.role.includes('guard')) return 4;
  if (npc.persona.role.includes('bell keeper')) return 3;
  if (npc.persona.role.includes('peddler')) return 2;
  return npc.wanderSeed % 3 === 0 ? 1 : 0;
}

function tryStartOverheard(a: GeneratedNpc, b: GeneratedNpc, mode: 'private' | 'open', now: number, crowd: GeneratedNpc[]): boolean {
  if (overhearInFlight || !ambientDirector.canStartFor([a, b], bubbles, now)) return false;
  const topicKey = mode === 'private' ? privateTopicKey(a) : landmarkTopicKey(a);
  if (!ambientDirector.pairReady(a, b, topicKey, now)) return false;

  overhearInFlight = true;
  const speechMs = mode === 'private' ? 8_800 : 7_800;
  ambientDirector.registerSpeech([a, b], now, speechMs, { pairKey: ambientPairKey(a, b), topicKey });
  startAmbientMeetup(a, b, now, speechMs + 1_800, crowd);
  ambientDirector.scheduleNext(now, mode === 'private' ? 13_000 : 14_000, mode === 'private' ? 20_000 : 22_000);

  void ai.overhear({
    npc: stripRuntimeNpc(a),
    request: overhearRequest(a, b, mode),
    options: {
      cacheOnly: true
    }
  }).then((exchange) => {
    if (exchange.trace?.fallback) {
      traceLine = `${mode} overhear cache miss / waiting for pregeneration`;
      traceDetail = '';
      return;
    }
    applyOverheard(exchange, [a, b], {
      startsAt: performance.now() + 850,
      kind: 'ambient'
    });
  })
    .catch((error) => {
      traceLine = `${mode} overhear failed / ${errorMessage(error)}`;
    })
    .finally(() => {
      overhearInFlight = false;
    });

  return true;
}

function tryStartAnnouncement(npc: GeneratedNpc, now: number, crowd: GeneratedNpc[]): boolean {
  if (ambientInFlight || !ambientDirector.canStartFor([npc], bubbles, now)) return false;
  const topicKey = `announcement:${landmarkTopicKey(npc)}`;
  if (!ambientDirector.topicReady(topicKey, now)) return false;

  ambientInFlight = true;
  ambientDirector.lastAnnouncementAt = now;
  ambientDirector.registerSpeech([npc], now, 6_400, { topicKey });
  ambientDirector.scheduleNext(now, 22_000, 36_000);

  void ai.bark({
    npc: stripRuntimeNpc(npc),
    request: ambientBarkRequest(npc),
    options: {
      cacheOnly: true
    }
  }).then((bark) => {
    if (bark.trace?.fallback) {
      traceLine = 'announcement cache miss / waiting for pregeneration';
      traceDetail = '';
      return;
    }
    const createdAt = performance.now();
    const pos = npcPosition(npc, createdAt, crowd);
    bubbles.push({
      id: `${npc.id}:announcement:${createdAt}`,
      npcId: npc.id,
      x: pos.x,
      y: pos.y,
      text: bark.text,
      startsAt: createdAt,
      expiresAt: createdAt + 5_400,
      kind: 'ambient'
    });
    traceLine = `${bark.trace?.recipeId ?? 'npc.bark'} / ${bark.trace?.providerId ?? 'unknown'} / announcement`;
    traceDetail = bark.trace?.rawText.slice(0, 420) ?? '';
  }).catch((error) => {
    traceLine = `announcement failed / ${errorMessage(error)}`;
  }).finally(() => {
    ambientInFlight = false;
  });

  return true;
}

function startAmbientMeetup(a: GeneratedNpc, b: GeneratedNpc, now: number, durationMs: number, crowd: GeneratedNpc[]): void {
  const center = ambientConversationCenter(a, b, now, crowd);
  ambientMeetups = ambientMeetups.filter((meetup) => !meetup.npcIds.includes(a.id) && !meetup.npcIds.includes(b.id));
  ambientMeetups.push({
    npcIds: [a.id, b.id],
    center,
    startedAt: now,
    expiresAt: now + durationMs
  });
}

function ambientConversationCenter(a: GeneratedNpc, b: GeneratedNpc, now: number, crowd: GeneratedNpc[]): Vec2 {
  const aPos = npcPosition(a, now, crowd);
  const bPos = npcPosition(b, now, crowd);
  const midpoint = clampToMap({
    x: (aPos.x + bPos.x) / 2,
    y: (aPos.y + bPos.y) / 2
  }, 70);
  const candidates = [
    midpoint,
    { x: midpoint.x + 52, y: midpoint.y },
    { x: midpoint.x - 52, y: midpoint.y },
    { x: midpoint.x, y: midpoint.y + 46 },
    { x: midpoint.x, y: midpoint.y - 46 }
  ].map((candidate) => clampToMap(candidate, 70));
  return candidates.find((candidate) => isInsideMap(candidate, 60) && !staticCollisionAtInWorld(candidate, 30, world)) ?? midpoint;
}

function privateTopicKey(npc: GeneratedNpc): string {
  return `private:${npc.groupId ?? npc.id}:${npc.wanderSeed % 4}`;
}

function landmarkTopicKey(npc: GeneratedNpc): string {
  const landmark = nearestLandmarks(npc, 1800)[0] ?? landmarks[npc.wanderSeed % landmarks.length];
  return landmark?.id ?? 'road';
}

function updateAmbientFlowLine(now = performance.now()): void {
  diagFlowEl.textContent = ambientDirector.flowLine(bubbles, ambientMeetups, now);
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

function applyOverheard(
  exchange: OverheardExchange,
  npcs: GeneratedNpc[],
  options: { startsAt?: number; kind?: Bubble['kind'] } = {}
): void {
  const byId = new Map(npcs.map((npc) => [npc.id, npc]));
  const base = options.startsAt ?? performance.now();
  for (let index = 0; index < exchange.lines.slice(0, ambientDirector.maxSpeakers).length; index += 1) {
    const line = exchange.lines[index];
    if (!line) continue;
    const npc = byId.get(line.npcId) ?? npcs[0];
    if (!npc) continue;
    const startsAt = base + index * 1_350;
    const pos = npcPosition(npc, startsAt, npcs);
    bubbles.push({
      id: `${line.npcId}:overheard:${startsAt}`,
      npcId: line.npcId,
      x: pos.x,
      y: pos.y,
      text: line.text,
      startsAt,
      expiresAt: startsAt + 4_700,
      kind: options.kind ?? 'ambient'
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
    visibleFeatures: visibleFeatures(point),
    contextualFacts: nearbyLandmarks.map((landmark) => `${landmark.name}: ${landmark.lore}`)
  };
}

function visibleFeatures(point: Vec2 = player): string[] {
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
  const session = dialogueController.sessionFor(npc);
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
