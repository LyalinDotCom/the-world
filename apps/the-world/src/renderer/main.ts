import type { AreaEvent, DialogueTurn, OverheardExchange } from '@game-llm/core';
import type { GameAIPreGenerateJob } from '@game-llm/electron';
import { AmbientDirector, ambientPairKey } from './ambientDirector.js';
import { getGameAI } from './aiClient.js';
import { areaEventCacheKey, areaEventNpcFromBeing, areaEventNpcsFromBandits, createAreaEventRequest, type AreaEventActor, type AreaEventState } from './areaEvents.js';
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
  pathStrength,
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
  health: number;
  reason: string;
}

interface Projectile {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  damage: number;
  createdAt: number;
  expiresAt: number;
}

interface SlashArc {
  id: string;
  x: number;
  y: number;
  heading: number;
  createdAt: number;
  expiresAt: number;
}

interface Corpse {
  id: string;
  x: number;
  y: number;
  name: string;
  color: string;
  heading: number;
  createdAt: number;
}

type WeaponMode = 'bow' | 'sword';
type VillagerReactionKind = 'panic' | 'flee' | 'scream' | 'charge';

interface VillagerCombatState {
  npc?: GeneratedNpc;
  health: number;
  reaction?: VillagerReactionKind;
  reactedTo?: string;
  x?: number;
  y?: number;
  target?: Vec2;
  startedAt?: number;
  expiresAt?: number;
  nextAttackAt?: number;
  inFlight?: boolean;
}

interface PlayerCharacterSheet {
  karma: number;
  villagerKills: number;
  constableDefeats: number;
  hostileDefeats: number;
  violentActs: number;
}

type DiagnosticsTab = 'trace' | 'machine' | 'perf';
type BootPhaseStatus = 'pending' | 'active' | 'ready' | 'degraded' | 'failed';
type BootPhaseId = 'runtime' | 'model' | 'ambient';

interface BootPhase {
  id: BootPhaseId;
  label: string;
  status: BootPhaseStatus;
  detail: string;
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
let projectiles: Projectile[] = [];
let slashes: SlashArc[] = [];
let corpses: Corpse[] = [];
const villagerCombat = new Map<string, VillagerCombatState>();
const deadNpcIds = new Set<string>();
let areaEventActors: AreaEventActor[] = [];
const areaEventStates = new Map<string, AreaEventState>(landmarks.map((landmark) => [landmark.id, {
  triggered: false,
  inFlight: false
}]));
const ambientDirector = new AmbientDirector({ maxSpeakers: 2 });
let footsteps: Footstep[] = [];
let lastFootstepAt = 0;
let wallPulseUntil = 0;
let interactionKey = '';
let activeNpcPosition: Vec2 | undefined;
let activeDialogueRequestId: string | undefined;
let dialogueStatus: { text: string; kind: 'info' | 'error'; expiresAt: number } | undefined;
let traceOpen = false;
let clickableNpcs: GeneratedNpc[] = [];
let diagnosticsHistory: number[] = [];
let cpuHistory: number[] = [];
let fpsHistory: number[] = [];
let latestDiagnostics: DiagnosticsSample | undefined;
let fps = 0;
const fpsCounter = new FpsCounter();
const dialogueTimeoutMs = 60_000;
const ambientStartupJobLimit = 6;
const areaEventRetryDelayMs = 60_000;
const playerMaxHealth = 10;
let playerHealth = playerMaxHealth;
let arrowCount = 10;
let weaponMode: WeaponMode = 'bow';
let bowAimActive = false;
let nextAttackAt = 0;
let mouseWorld: Vec2 = { x: player.x + 80, y: player.y };
const playerSheet: PlayerCharacterSheet = {
  karma: 2,
  villagerKills: 0,
  constableDefeats: 0,
  hostileDefeats: 0,
  violentActs: 0
};
let perfLogStatus: PerfLogStatus = { active: false, samples: 0 };
let perfLogLastSampleAt = 0;
let perfLogWriteInFlight = false;
let diagnosticsTab: DiagnosticsTab = 'machine';
let diagnosticsGraphOpen = true;
let bootVisible = true;
let bootCanEnter = false;
let bootTitle = 'Loading The World';
let bootDetail = 'Preparing local Gemma runtime.';
let pendingAmbientCacheModelLabel: string | undefined;
let bootPhases: BootPhase[] = [
  { id: 'runtime', label: 'Checking runtime', status: 'active', detail: 'Connecting to the selected local AI stack.' },
  { id: 'model', label: 'Loading Gemma model', status: 'pending', detail: 'Waiting for runtime health.' },
  { id: 'ambient', label: 'Preparing ambient town chatter', status: 'pending', detail: 'Waiting for model warmup.' }
];

hud.innerHTML = `
  <div class="location-chip">
    <div class="location-title">
      <strong>The World</strong>
      <span id="region-line"></span>
      <span id="coord-line"></span>
    </div>
    <span id="provider-line" class="provider-line"></span>
  </div>
  <div id="interaction" class="interaction"></div>
  <div id="combat" class="combat-panel">
    <button id="bow-toggle" class="combat-button" type="button" aria-pressed="false">Bow</button>
    <div><span>Health</span><strong id="combat-health">10/10</strong></div>
    <div><span>Arrows</span><strong id="combat-arrows">10</strong></div>
    <div><span>Karma</span><strong id="combat-karma">+2</strong></div>
  </div>
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
    <header class="dialogue-header">
      <strong>Conversation</strong>
      <button id="dialogue-close" type="button" aria-label="Close conversation">Close</button>
    </header>
    <div class="dialogue-portraits">
      <div class="speaker-card npc-speaker">
        <div id="dialogue-npc-avatar" class="speaker-avatar"></div>
        <div>
          <strong id="dialogue-name"></strong>
          <span id="dialogue-role"></span>
        </div>
      </div>
      <div class="speaker-card player-speaker">
        <div class="speaker-avatar">You</div>
        <div>
          <strong>You</strong>
          <span>traveler</span>
        </div>
      </div>
    </div>
    <div id="dialogue-log" class="dialogue-log"></div>
    <div id="dialogue-thinking" class="dialogue-thinking hidden" aria-live="polite">
      <div>
        <span></span>
        <span></span>
        <span></span>
      </div>
      <p>Thinking</p>
    </div>
    <form id="dialogue-form">
      <input id="dialogue-input" autocomplete="off" maxlength="240" />
      <button id="dialogue-send" type="submit">Send</button>
      <button id="dialogue-goodbye" type="button">Goodbye</button>
    </form>
  </section>
  <section id="boot-screen" class="boot-screen" aria-live="polite">
    <div class="boot-copy">
      <span class="boot-kicker">Local AI Runtime</span>
      <h1 id="boot-title">Loading The World</h1>
      <p id="boot-detail">Preparing local Gemma runtime.</p>
      <div id="boot-phases" class="boot-phases"></div>
      <div class="boot-actions">
        <button id="boot-enter" type="button" disabled>Enter World</button>
        <button id="boot-diagnostics" type="button">Diagnostics</button>
      </div>
    </div>
  </section>
`;

const providerEl = document.querySelector<HTMLSpanElement>('#provider-line')!;
const warmupEl = document.querySelector<HTMLDivElement>('#warmup-line')!;
const traceEl = document.querySelector<HTMLDivElement>('#trace-line')!;
const traceDetailEl = document.querySelector<HTMLPreElement>('#trace-detail')!;
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
const bowToggle = document.querySelector<HTMLButtonElement>('#bow-toggle')!;
const combatHealthEl = document.querySelector<HTMLElement>('#combat-health')!;
const combatArrowsEl = document.querySelector<HTMLElement>('#combat-arrows')!;
const combatKarmaEl = document.querySelector<HTMLElement>('#combat-karma')!;
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
const dialogueNpcAvatarEl = document.querySelector<HTMLElement>('#dialogue-npc-avatar')!;
const dialogueNameEl = document.querySelector<HTMLElement>('#dialogue-name')!;
const dialogueRoleEl = document.querySelector<HTMLElement>('#dialogue-role')!;
const dialogueLogEl = document.querySelector<HTMLDivElement>('#dialogue-log')!;
const dialogueThinkingEl = document.querySelector<HTMLElement>('#dialogue-thinking')!;
const dialogueForm = document.querySelector<HTMLFormElement>('#dialogue-form')!;
const dialogueInput = document.querySelector<HTMLInputElement>('#dialogue-input')!;
const dialogueSend = document.querySelector<HTMLButtonElement>('#dialogue-send')!;
const dialogueGoodbye = document.querySelector<HTMLButtonElement>('#dialogue-goodbye')!;
const dialogueClose = document.querySelector<HTMLButtonElement>('#dialogue-close')!;
const bootScreenEl = document.querySelector<HTMLElement>('#boot-screen')!;
const bootTitleEl = document.querySelector<HTMLElement>('#boot-title')!;
const bootDetailEl = document.querySelector<HTMLElement>('#boot-detail')!;
const bootPhasesEl = document.querySelector<HTMLElement>('#boot-phases')!;
const bootEnterButton = document.querySelector<HTMLButtonElement>('#boot-enter')!;
const bootDiagnosticsButton = document.querySelector<HTMLButtonElement>('#boot-diagnostics')!;

window.addEventListener('resize', resize);
canvas.addEventListener('mousemove', (event) => {
  mouseWorld = screenToWorld(event);
});
canvas.addEventListener('click', (event) => {
  if (bootVisible) return;
  if (activeNpc) return;
  const point = screenToWorld(event);
  mouseWorld = point;
  const now = performance.now();
  if (bowAimActive) {
    shootBow(now);
    return;
  }
  const clicked = clickableNpcs
    .map((npc) => ({ npc, distance: distance(npcPosition(npc, now, clickableNpcs), point) }))
    .filter((entry) => entry.distance < 42)
    .sort((a, b) => a.distance - b.distance)[0]?.npc;
  if (clicked) {
    void startConversation(clicked);
    return;
  }
});
bowToggle.addEventListener('click', () => {
  bowAimActive = !bowAimActive;
  weaponMode = 'bow';
  interactionKey = '';
  renderHud();
});
window.addEventListener('keydown', (event) => {
  if (event.repeat) return;
  if (bootVisible) {
    if (event.key === 'Enter' && bootCanEnter) {
      dismissBootScreen();
    }
    return;
  }
  if (event.key === 'Escape' && activeNpc) {
    event.preventDefault();
    closeConversation();
    return;
  }
  const key = event.key.toLowerCase();
  if (!activeNpc && !dialogueInput.matches(':focus')) {
    if (key === ' ' || key === '/') {
      event.preventDefault();
      weaponMode = 'sword';
      bowAimActive = false;
      swingSword(performance.now());
      return;
    }
  }
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
  if (isGoodbyeText(text)) {
    conversation.push({ speaker: 'You', text, kind: 'player' });
    renderDialogue();
    window.setTimeout(closeConversation, 220);
    return;
  }
  void sendToNpc(text);
});
dialogueGoodbye.addEventListener('click', () => {
  if (!activeNpc || busy) return;
  closeConversation();
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
bootEnterButton.addEventListener('click', dismissBootScreen);
bootDiagnosticsButton.addEventListener('click', () => {
  traceOpen = true;
  diagnosticsTab = 'trace';
  renderHud();
});

resize();
void initializeRuntime();
void updateDiagnostics();
window.setInterval(() => void updateDiagnostics(), 1_500);
startGameLoop(frame);

async function initializeRuntime(): Promise<void> {
  try {
    updateBootPhase('runtime', 'active', 'Checking selected provider and model availability.');
    const health = await ai.health();
    providerLine = `${health.provider}${health.model ? ` / ${health.model}` : ''} / ${health.mode}`;
    providerBaseLine = providerLine;
    updateBootPhase(
      'runtime',
      health.ok ? 'ready' : 'degraded',
      health.ok ? `${health.provider} ${health.model ?? ''} is available.`.trim() : health.message ?? health.mode
    );
    renderHud();
  } catch (error) {
    providerLine = `runtime unavailable / ${errorMessage(error)}`;
    updateBootPhase('runtime', 'failed', errorMessage(error));
    bootTitle = 'Runtime Unavailable';
    bootDetail = 'The selected local AI stack could not be reached. Conversations will show failures rather than fake dialogue.';
    bootCanEnter = true;
  }

  try {
    updateBootPhase('model', 'active', 'Loading and warming Gemma for schema-bound NPC dialogue.');
    warmupLine = 'warming local model...';
    renderHud();
    const health = await ai.warmup();
    warmupLine = health.ok ? `warm / ${health.model ?? health.provider}` : `warmup degraded / ${health.message ?? health.mode}`;
    updateBootPhase(
      'model',
      health.ok ? 'ready' : 'degraded',
      health.ok ? `${health.model ?? health.provider} is warm.` : health.message ?? health.mode
    );
    renderHud();
    if (health.ok) {
      bootTitle = 'The World Is Ready';
      bootDetail = 'Gemma is warm. Ambient town chatter will continue preparing in the background.';
      bootCanEnter = true;
      pendingAmbientCacheModelLabel = health.model ?? health.provider;
      updateBootPhase('ambient', 'pending', 'A small nearby ambient cache will prepare after you enter.');
    } else {
      bootTitle = 'Warmup Degraded';
      bootDetail = 'The model did not fully warm up. You can enter, but NPC responses may fail or be slow.';
      bootCanEnter = true;
    }
  } catch (error) {
    warmupLine = `warmup failed / ${errorMessage(error)}`;
    updateBootPhase('model', 'failed', errorMessage(error));
    bootTitle = 'Warmup Failed';
    bootDetail = 'The model failed during warmup. You can enter to inspect diagnostics, but dialogue may fail.';
    bootCanEnter = true;
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
      updateBootPhase('ambient', 'ready', 'No ambient cache jobs were needed.');
      return;
    }
    updateBootPhase('ambient', 'active', `Preparing ambient cache 0/${jobs.length}.`);
    warmupLine = `warm / ${modelLabel} / preparing ambient cache 0/${jobs.length}`;
    providerLine = `${providerBaseLine} / caching ambient 0/${jobs.length}`;
    traceLine = 'pregeneration / ambient cache starting';
    renderHud();
    const chunkSize = 1;
    for (let index = 0; index < jobs.length; index += chunkSize) {
      const chunk = jobs.slice(index, index + chunkSize);
      const result = await ai.preGenerate({ jobs: chunk, maxConcurrency: 1 });
      generated += result.generated;
      failed += result.failed;
      warmupLine = `warm / ${modelLabel} / ambient cache ${Math.min(index + chunk.length, jobs.length)}/${jobs.length}`;
      providerLine = `${providerBaseLine} / caching ambient ${Math.min(index + chunk.length, jobs.length)}/${jobs.length}`;
      traceLine = `pregeneration / generated ${generated}, failed ${failed}`;
      updateBootPhase('ambient', 'active', `Generated ${generated}; failed ${failed}; ${Math.min(index + chunk.length, jobs.length)}/${jobs.length} jobs attempted.`);
      renderHud();
    }
    ambientCacheReady = generated > 0;
    warmupLine = `warm / ${modelLabel} / ambient cache ${generated}/${jobs.length}`;
    providerLine = `${providerBaseLine} / ambient cached ${generated}/${jobs.length}`;
    traceLine = `pregeneration ready / ${generated}/${jobs.length} cached`;
    updateBootPhase(
      'ambient',
      ambientCacheReady ? 'ready' : 'degraded',
      `Generated ${generated}/${jobs.length}; failed ${failed}.`
    );
  } catch (error) {
    warmupLine = `warm / ${modelLabel} / ambient cache degraded`;
    providerLine = `${providerBaseLine} / ambient cache degraded`;
    traceLine = `pregeneration failed / ${errorMessage(error)}`;
    updateBootPhase('ambient', 'degraded', errorMessage(error));
  } finally {
    ambientCacheInFlight = false;
    renderHud();
  }
}

async function preloadAreaEvents(modelLabel: string): Promise<void> {
  traceLine = `area events / preparing ${landmarks.length} landmark triggers`;
  providerLine = `${providerBaseLine} / preparing area events`;
  renderHud();
  let generated = 0;
  let failed = 0;
  for (const landmark of landmarks) {
    const event = await generateAreaEvent(landmark, true);
    if (event) {
      generated += 1;
    } else {
      failed += 1;
    }
    traceLine = `area events / ${generated} ready, ${failed} failed`;
    providerLine = `${providerBaseLine} / area events ${generated}/${landmarks.length}`;
    renderHud();
  }
  providerLine = `${providerBaseLine} / area events ${generated}/${landmarks.length}`;
  warmupLine = `warm / ${modelLabel} / area events ${generated}/${landmarks.length}`;
  renderHud();
}

async function generateAreaEvent(landmark: typeof landmarks[number], refresh: boolean): Promise<AreaEvent | undefined> {
  const state = areaEventStates.get(landmark.id);
  if (state?.inFlight) return state.event;
  const startedAt = performance.now();
  areaEventStates.set(landmark.id, {
    triggered: state?.triggered ?? false,
    inFlight: true,
    inFlightStartedAt: startedAt,
    event: state?.event,
    failed: undefined,
    failureNotified: false
  });
  try {
    const event = await ai.areaEvent({
      request: createAreaEventRequest(landmark, sceneAt(landmark), triggeredAreaEventTitles(), undefined, playerContext()),
      options: {
        cacheKey: areaEventCacheKey(landmark),
        refresh,
        timeoutMs: 30_000
      }
    });
    if (event.trace?.fallback) {
      areaEventStates.set(landmark.id, {
        triggered: state?.triggered ?? false,
        inFlight: false,
        event: state?.event,
        failed: event.safetyFlags[0]?.message ?? 'Gemma area event fallback',
        failureNotified: false,
        retryAfter: performance.now() + areaEventRetryDelayMs
      });
      return undefined;
    }
    areaEventStates.set(landmark.id, {
      triggered: state?.triggered ?? false,
      inFlight: false,
      event,
      failed: undefined,
      failureNotified: false,
      retryAfter: undefined
    });
    traceLine = `${event.trace?.recipeId ?? 'world.areaEvent'} / ${event.trace?.providerId ?? 'unknown'} / ${landmark.name}`;
    traceDetail = event.trace?.rawText.slice(0, 420) ?? '';
    return event;
  } catch (error) {
    areaEventStates.set(landmark.id, {
      triggered: state?.triggered ?? false,
      inFlight: false,
      event: state?.event,
      failed: errorMessage(error),
      failureNotified: false,
      retryAfter: performance.now() + areaEventRetryDelayMs
    });
    traceLine = `area event failed / ${landmark.name} / ${errorMessage(error)}`;
    traceDetail = '';
    return undefined;
  }
}

function buildPregenerationJobs(): GameAIPreGenerateJob[] {
  const npcs = pregenerationNpcPool();
  const open = npcs.filter((npc) => npc.conversationPolicy === 'open');
  const jobs: GameAIPreGenerateJob[] = [];

  for (const npc of open.slice(0, 3)) {
    jobs.push({
      type: 'bark',
      npc: stripRuntimeNpc(npc),
      request: ambientBarkRequest(npc)
    });
  }

  for (const [a, b] of privatePairsFrom(npcs).slice(0, 1)) {
    jobs.push({
      type: 'overhear',
      npc: stripRuntimeNpc(a),
      request: overhearRequest(a, b, 'private')
    });
  }

  for (const [a, b] of openPairsFrom(open).slice(0, 2)) {
    jobs.push({
      type: 'overhear',
      npc: stripRuntimeNpc(a),
      request: overhearRequest(a, b, 'open')
    });
  }

  return jobs.slice(0, ambientStartupJobLimit);
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
  if (bootVisible) {
    clickableNpcs = [];
    nearestNpc = undefined;
    renderHud();
    return;
  }
  player.moving = false;
  const nearby = aliveNpcsNear(player.x, player.y, 760);
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
  updateCombat(dt, now);
  updateVillagerReactions(dt, now, nearby);
  updateAreaEventActors(dt, now);
  updateConstables(dt, now);
  if (activeNpc && activeNpcPosition && distance(activeNpcPosition, player) > 260) {
    closeConversation();
  }
  const nearbyActors = [...nearby, ...areaEventActors.filter((actor) => distance(actor, player) < 760)];
  clickableNpcs = nearbyActors
    .filter((npc) => npc.conversationPolicy === 'open' && distance(npcPosition(npc, now, nearby), player) < 170)
    .sort((a, b) => distance(npcPosition(a, now, nearby), player) - distance(npcPosition(b, now, nearby), player));
  nearestNpc = nearbyActors
    .filter((npc) => npc.conversationPolicy === 'open' && distance(npcPosition(npc, now, nearby), player) < 165)
    .sort((a, b) => distance(npcPosition(a, now, nearby), player) - distance(npcPosition(b, now, nearby), player))[0];
  maybeTriggerAreaEvent(now);
  maybeRequestAmbient(now, nearby);
  renderHud();
}

function draw(now: number): void {
  const camera = cameraForPlayer();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  drawStaticWorld({ ctx, world, camera, width: cssWidth, height: cssHeight });
  const npcs = [
    ...aliveNpcsNear(player.x, player.y, Math.max(cssWidth, cssHeight)),
    ...areaEventActors.filter((actor) => distance(actor, player) < Math.max(cssWidth, cssHeight))
  ];
  drawCorpses(camera);
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
  drawCombat(now, camera);
  drawMapBoundary({ ctx, world, camera, width: cssWidth, height: cssHeight, now, wallPulseUntil });
  drawMinimap(now, npcs);
}

function screenToWorld(event: MouseEvent): Vec2 {
  const rect = canvas.getBoundingClientRect();
  const camera = cameraForPlayer();
  return {
    x: camera.x + event.clientX - rect.left,
    y: camera.y + event.clientY - rect.top
  };
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
  const villagerState = villagerCombat.get(npc.id);
  if (villagerState?.x !== undefined && villagerState.y !== undefined) {
    return { x: villagerState.x, y: villagerState.y };
  }
  if (npc.id.startsWith('area.')) {
    return { x: npc.x, y: npc.y };
  }
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

function updateAreaEventActors(dt: number, now: number): void {
  areaEventActors = areaEventActors.filter((actor) => actor.expiresAt > now);
  for (const actor of areaEventActors) {
    if (!actor.target) continue;
    const target = { x: player.x, y: player.y };
    actor.target = target;
    const gap = distance(actor, target);
    if (gap > 74) {
      const speed = actor.persona.mood === 'hostile' ? 118 : 52;
      const nx = (target.x - actor.x) / Math.max(1, gap);
      const ny = (target.y - actor.y) / Math.max(1, gap);
      const next = clampToMap({
        x: actor.x + nx * speed * dt,
        y: actor.y + ny * speed * dt
      }, 24);
      if (!staticCollisionAtInWorld(next, 16, world)) {
        actor.x = next.x;
        actor.y = next.y;
      }
    }
    if (gap < 180 && now - actor.lastBarkAt > 8_000) {
      actor.lastBarkAt = now;
      const lines = actor.persona.knows ?? [];
      const line = lines[(Math.floor(now / 1000) + actor.wanderSeed) % Math.max(1, lines.length)] ?? 'Back away.';
      bubbles.push({
        id: `${actor.id}:threat:${now}`,
        npcId: actor.id,
        x: actor.x,
        y: actor.y,
        text: line,
        startsAt: now,
        expiresAt: now + 4_400,
        kind: 'reaction'
      });
    }
  }
}

function maybeTriggerAreaEvent(now: number): void {
  if (activeNpc) return;
  for (const landmark of landmarks) {
    const state = areaEventStates.get(landmark.id);
    if (!state || state.triggered) continue;
    const radius = state.event?.triggerRadius ?? Math.max(240, Math.min(390, Math.max(landmark.width, landmark.height) + 170));
    if (distance(player, landmark) > radius) continue;
    if (state.event) {
      executeAreaEvent(landmark, state.event, now);
      return;
    }
    if (state.failed && (!state.retryAfter || now < state.retryAfter)) {
      if (!state.failureNotified) {
        areaEventStates.set(landmark.id, {
          ...state,
          failureNotified: true
        });
        bubbles.push({
          id: `area:${landmark.id}:failed:${now}`,
          npcId: `area:${landmark.id}`,
          x: landmark.x,
          y: landmark.y,
          text: `${landmark.name} falls quiet. Nothing answers.`,
          startsAt: now,
          expiresAt: now + 5_800,
          kind: 'ambient'
        });
        traceLine = `area event unavailable / ${landmark.name}`;
        traceDetail = state.failed;
      }
      return;
    }
    if (!state.inFlight) {
      bubbles.push({
        id: `area:${landmark.id}:loading:${now}`,
        npcId: `area:${landmark.id}`,
        x: landmark.x,
        y: landmark.y,
        text: `${landmark.name} stirs. Something is gathering...`,
        startsAt: now,
        expiresAt: now + 5_200,
        kind: 'ambient'
      });
      void generateAreaEvent(landmark, true).then((event) => {
        if (event && !areaEventStates.get(landmark.id)?.triggered && distance(player, landmark) <= event.triggerRadius + 40) {
          executeAreaEvent(landmark, event, performance.now());
        }
      });
    }
    return;
  }
}

function executeAreaEvent(landmark: typeof landmarks[number], event: AreaEvent, now: number): void {
  const state = areaEventStates.get(landmark.id);
  areaEventStates.set(landmark.id, {
    triggered: true,
    inFlight: false,
    event,
    failed: state?.failed
  });
  traceLine = `area event / ${event.kind} / ${event.locationName}`;
  traceDetail = event.trace?.rawText.slice(0, 420) ?? '';
  if (event.kind === 'banditAmbush') {
    bubbles.push({
      id: `area:${landmark.id}:intro:${now}`,
      npcId: `area:${landmark.id}`,
      x: landmark.x,
      y: landmark.y,
      text: event.introText,
      startsAt: now,
      expiresAt: now + 3_400,
      kind: 'ambient'
    });
    const bandits = areaEventNpcsFromBandits(event, landmark, player, now);
    areaEventActors.push(...bandits);
    for (const [index, bandit] of bandits.entries()) {
      const text = event.bandits?.[index]?.entryLine ?? bandit.persona.knows?.[0] ?? `You should not have come to ${event.locationName}.`;
      bubbles.push({
        id: `${bandit.id}:entry:${now}`,
        npcId: bandit.id,
        x: bandit.x,
        y: bandit.y,
        text,
        startsAt: now + 850 + index * 700,
        expiresAt: now + 5_800 + index * 700,
        kind: 'reaction'
      });
    }
    return;
  }
  if (event.kind === 'mysteriousBeing') {
    const being = areaEventNpcFromBeing(event, {
      x: landmark.x,
      y: landmark.y + Math.max(landmark.height * 0.5, 72)
    });
    if (!being) return;
    areaEventActors.push(being);
    activeNpc = being;
    activeNpcPosition = { x: being.x, y: being.y };
    busy = false;
    ended = false;
    conversation = [
      { speaker: being.persona.name, text: event.being?.greeting ?? event.introText, kind: 'npc' }
    ];
    interactionKey = '';
    renderDialogue();
    return;
  }
  if (event.kind === 'strangeSounds') {
    bubbles.push({
      id: `area:${landmark.id}:intro:${now}`,
      npcId: `area:${landmark.id}`,
      x: landmark.x,
      y: landmark.y,
      text: event.introText,
      startsAt: now,
      expiresAt: now + 2_700,
      kind: 'ambient'
    });
    for (const [index, sound] of (event.sounds ?? []).entries()) {
      const startsAt = now + 3_000 + index * 2_800;
      bubbles.push({
        id: `area:${landmark.id}:sound:${index}:${now}`,
        npcId: `area:${landmark.id}`,
        x: landmark.x,
        y: landmark.y,
        text: sound.text,
        startsAt,
        expiresAt: startsAt + 2_600,
        kind: 'ambient'
      });
    }
  }
}

function triggeredAreaEventTitles(): string[] {
  return [...areaEventStates.values()]
    .filter((state) => state.triggered && state.event)
    .map((state) => `${state.event!.locationName}: ${state.event!.title}`);
}

function updateCombat(dt: number, now: number): void {
  playerHealth = Math.min(playerMaxHealth, playerHealth + dt * 0.32);
  projectiles = projectiles.filter((projectile) => projectile.expiresAt > now);
  slashes = slashes.filter((slash) => slash.expiresAt > now);

  for (const projectile of [...projectiles]) {
    const previous = { x: projectile.x, y: projectile.y };
    const next = {
      x: projectile.x + projectile.vx * dt,
      y: projectile.y + projectile.vy * dt
    };
    if (!isInsideMap(next, 8) || staticCollisionAtInWorld(next, 4, world)) {
      projectiles = projectiles.filter((candidate) => candidate.id !== projectile.id);
      continue;
    }
    projectile.x = next.x;
    projectile.y = next.y;
    if (damageFirstHit(projectile, previous, next, now)) {
      projectiles = projectiles.filter((candidate) => candidate.id !== projectile.id);
    }
  }

  let takingDamage = false;
  for (const constable of constables) {
    if (distance(constable, player) < 44) {
      takingDamage = true;
      playerHealth -= dt * 1.6;
    }
  }
  for (const actor of areaEventActors) {
    if (actor.persona.mood === 'hostile' && distance(actor, player) < 48) {
      takingDamage = true;
      playerHealth -= dt * 1.9;
    }
  }
  if (takingDamage && now % 650 < 18) {
    traceLine = 'combat / taking damage';
  }
  if (playerHealth <= 0) {
    playerHealth = playerMaxHealth * 0.45;
    constables = [];
    areaEventActors = areaEventActors.filter((actor) => actor.persona.mood !== 'hostile');
    bubbles.push({
      id: `player:winded:${now}`,
      npcId: 'player',
      x: player.x,
      y: player.y,
      text: 'You are driven back and catch your breath.',
      startsAt: now,
      expiresAt: now + 4_200,
      kind: 'reaction'
    });
  }
}

function shootBow(now: number): void {
  if (now < nextAttackAt || bootVisible || activeNpc) return;
  const aim = aimVector();
  player.heading = Math.atan2(aim.y, aim.x);
  if (arrowCount <= 0) {
    bubbles.push({
      id: `player:no-arrows:${now}`,
      npcId: 'player',
      x: player.x,
      y: player.y,
      text: 'Quiver empty.',
      startsAt: now,
      expiresAt: now + 1_600,
      kind: 'reaction'
    });
    nextAttackAt = now + 280;
    return;
  }
  arrowCount -= 1;
  nextAttackAt = now + 420;
  projectiles.push({
    id: `arrow:${now}`,
    x: player.x + aim.x * 20,
    y: player.y + aim.y * 20,
    vx: aim.x * 860,
    vy: aim.y * 860,
    damage: 3,
    createdAt: now,
    expiresAt: now + 1_150
  });
}

function swingSword(now: number): void {
  if (now < nextAttackAt || bootVisible || activeNpc) return;
  const target = nearestSwordTarget();
  if (target) {
    player.heading = Math.atan2(target.y - player.y, target.x - player.x);
    mouseWorld = target;
  }
  nextAttackAt = now + 560;
  slashes.push({
    id: `slash:${now}`,
    x: player.x,
    y: player.y,
    heading: player.heading,
    createdAt: now,
    expiresAt: now + 190
  });
  damageMelee(now);
}

function aimVector(): Vec2 {
  const dx = mouseWorld.x - player.x;
  const dy = mouseWorld.y - player.y;
  const length = Math.max(1, Math.hypot(dx, dy));
  return { x: dx / length, y: dy / length };
}

function damageFirstHit(projectile: Projectile, previous: Vec2, next: Vec2, now: number): boolean {
  const constable = constables.find((candidate) => distanceToSegment(candidate, previous, next) < 28);
  if (constable) {
    damageConstable(constable.id, projectile.damage, now);
    return true;
  }
  const actor = areaEventActors.find((candidate) => candidate.persona.mood === 'hostile' && distanceToSegment(candidate, previous, next) < 28);
  if (actor) {
    damageAreaActor(actor.id, projectile.damage, now);
    return true;
  }
  const villager = arrowVillagerCandidates(projectile)
    .map((npc) => ({ npc, position: npcPosition(npc, now) }))
    .filter((entry) => distanceToSegment(entry.position, previous, next) < 30)
    .sort((a, b) => distanceToSegment(a.position, previous, next) - distanceToSegment(b.position, previous, next))[0]?.npc;
  if (villager) {
    damageVillager(villager, projectile.damage, now);
    return true;
  }
  return false;
}

function arrowVillagerCandidates(projectile: Projectile): GeneratedNpc[] {
  const byId = new Map<string, GeneratedNpc>();
  for (const npc of aliveNpcsNear(projectile.x, projectile.y, 260)) byId.set(npc.id, npc);
  for (const npc of aliveNpcsNear(player.x, player.y, Math.max(cssWidth, cssHeight) + 260)) byId.set(npc.id, npc);
  for (const state of villagerCombat.values()) {
    if (state.npc && !deadNpcIds.has(state.npc.id)) byId.set(state.npc.id, state.npc);
  }
  return [...byId.values()];
}

function damageMelee(now: number): void {
  const aim = aimVector();
  const target = nearestSwordTarget();
  if (!target || !isMeleeHit(target, aim)) return;
  if (target.kind === 'constable') damageConstable(target.id, 1, now);
  else if (target.kind === 'area') damageAreaActor(target.id, 1, now);
  else damageVillager(target.npc, 1, now);
}

type SwordTarget =
  | ({ kind: 'constable'; id: string } & Vec2)
  | ({ kind: 'area'; id: string } & Vec2)
  | ({ kind: 'villager'; npc: GeneratedNpc } & Vec2);

function nearestSwordTarget(): SwordTarget | undefined {
  const targets: SwordTarget[] = [
    ...constables.map((constable) => ({ kind: 'constable' as const, id: constable.id, x: constable.x, y: constable.y })),
    ...areaEventActors
      .filter((actor) => actor.persona.mood === 'hostile')
      .map((actor) => ({ kind: 'area' as const, id: actor.id, x: actor.x, y: actor.y })),
    ...attackingVillagers().map((npc) => ({ kind: 'villager' as const, npc, ...npcPosition(npc, performance.now()) }))
  ];
  return targets
    .filter((target) => distance(target, player) <= 90)
    .sort((a, b) => distance(a, player) - distance(b, player))[0];
}

function isMeleeHit(target: Vec2, aim: Vec2): boolean {
  const dx = target.x - player.x;
  const dy = target.y - player.y;
  const range = Math.hypot(dx, dy);
  if (range > 74 || range < 1) return false;
  return (dx / range) * aim.x + (dy / range) * aim.y > 0.42;
}

function damageConstable(id: string, amount: number, now: number): void {
  const constable = constables.find((candidate) => candidate.id === id);
  if (!constable) return;
  constable.health -= amount;
  recordViolence('constable');
  if (constable.health <= 0) {
    playerSheet.constableDefeats += 1;
    addCorpse({
      id,
      x: constable.x,
      y: constable.y,
      name: constable.name,
      color: '#263a52'
    }, now);
    constables = constables.filter((candidate) => candidate.id !== id);
    bubbles.push({
      id: `${id}:down:${now}`,
      npcId: id,
      x: constable.x,
      y: constable.y,
      text: `${constable.name} falls back.`,
      startsAt: now,
      expiresAt: now + 2_700,
      kind: 'reaction'
    });
  }
}

function damageAreaActor(id: string, amount: number, now: number): void {
  const actor = areaEventActors.find((candidate) => candidate.id === id);
  if (!actor) return;
  actor.health = (actor.health ?? 3) - amount;
  recordViolence('hostile');
  if (actor.health <= 0) {
    playerSheet.hostileDefeats += 1;
    addCorpse({
      id,
      x: actor.x,
      y: actor.y,
      name: actor.persona.name,
      color: actor.color
    }, now);
    areaEventActors = areaEventActors.filter((candidate) => candidate.id !== id);
    bubbles.push({
      id: `${id}:down:${now}`,
      npcId: id,
      x: actor.x,
      y: actor.y,
      text: `${actor.persona.name} drops.`,
      startsAt: now,
      expiresAt: now + 2_700,
      kind: 'reaction'
    });
  }
}

function damageVillager(npc: GeneratedNpc, amount: number, now: number): void {
  if (deadNpcIds.has(npc.id)) return;
  const state = villagerState(npc);
  state.health -= amount;
  recordViolence('villager');
  const pos = npcPosition(npc, now);
  state.x = pos.x;
  state.y = pos.y;
  if (state.health <= 0) {
    playerSheet.villagerKills += 1;
    addCorpse({
      id: npc.id,
      x: pos.x,
      y: pos.y,
      name: npc.persona.name,
      color: npc.color
    }, now);
    deadNpcIds.add(npc.id);
    villagerCombat.delete(npc.id);
    bubbles.push({
      id: `${npc.id}:down:${now}`,
      npcId: npc.id,
      x: pos.x,
      y: pos.y,
      text: `${npc.persona.name} falls.`,
      startsAt: now,
      expiresAt: now + 2_900,
      kind: 'reaction'
    });
    notifyVillagersOfViolence(npc, pos, now);
  } else {
    startVillagerReaction(npc, 'charge', npc.id, now, pos);
  }
}

function notifyVillagersOfViolence(victim: GeneratedNpc, origin: Vec2, now: number): void {
  const witnesses = aliveNpcsNear(origin.x, origin.y, 430)
    .filter((npc) => npc.id !== victim.id)
    .map((npc) => ({ npc, pos: npcPosition(npc, now) }))
    .filter((entry) => distance(entry.pos, origin) < 430)
    .sort((a, b) => distance(a.pos, origin) - distance(b.pos, origin))
    .slice(0, 5);
  for (const [index, witness] of witnesses.entries()) {
    const reaction = villagerReactionFor(witness.npc, victim, index);
    startVillagerReaction(witness.npc, reaction, victim.id, now, witness.pos);
    void requestVillagerReactionBark(witness.npc, victim, reaction, now + index * 120);
  }
}

function startVillagerReaction(npc: GeneratedNpc, reaction: VillagerReactionKind, eventId: string, now: number, pos = npcPosition(npc, now)): void {
  const state = villagerState(npc);
  const away = normalized({ x: pos.x - player.x, y: pos.y - player.y });
  state.reaction = reaction;
  state.reactedTo = eventId;
  state.x = pos.x;
  state.y = pos.y;
  state.startedAt = now;
  state.expiresAt = now + (reaction === 'charge' ? 32_000 : 13_000);
  state.nextAttackAt = reaction === 'charge' ? now + 850 : undefined;
  state.target = reaction === 'charge'
    ? { x: player.x, y: player.y }
    : reaction === 'flee'
      ? clampToMap({ x: pos.x + away.x * 520, y: pos.y + away.y * 520 }, 60)
      : pos;
}

async function requestVillagerReactionBark(npc: GeneratedNpc, victim: GeneratedNpc, reaction: VillagerReactionKind, startsAt: number): Promise<void> {
  const state = villagerState(npc);
  if (state.inFlight) return;
  state.inFlight = true;
  try {
    const turn = await ai.dialogue({
      npc: stripRuntimeNpc(npc),
      request: {
        playerText: `The player just shot ${victim.persona.name} with a bow. React immediately by ${reaction}.`,
        scene: sceneAt(npc),
        player: playerContext(['drawn bow', 'travel cloak', 'worn boots']),
        relationship: 'witness to sudden violence',
        npcState: dialogueController.stateForRequest(npc),
        recentDialogue: [
          { speaker: 'System', text: `Reaction lane: ${reaction}. Stay in character. One short line only.` }
        ]
      },
      options: {
        timeoutMs: 18_000
      }
    });
    const pos = npcPosition(npc, performance.now());
    const failed = turn.trace?.fallback;
    if (failed) {
      traceLine = `villager reaction fallback / ${npc.persona.name}`;
      traceDetail = turn.trace?.rawText.slice(0, 420) ?? '';
      return;
    }
    bubbles.push({
      id: `${npc.id}:violence-reaction:${startsAt}`,
      npcId: npc.id,
      x: pos.x,
      y: pos.y,
      text: turn.text,
      startsAt,
      expiresAt: startsAt + 4_800,
      kind: 'reaction'
    });
  } catch (error) {
    traceLine = `villager reaction failed / ${errorMessage(error)}`;
  } finally {
    state.inFlight = false;
  }
}

function updateVillagerReactions(dt: number, now: number, nearby: GeneratedNpc[]): void {
  for (const [id, state] of [...villagerCombat.entries()]) {
    if (state.expiresAt && now > state.expiresAt && state.reaction !== 'charge') {
      state.reaction = undefined;
      state.target = undefined;
      continue;
    }
    if (!state.reaction || state.x === undefined || state.y === undefined) continue;
    const npc = nearby.find((candidate) => candidate.id === id) ?? aliveNpcsNear(state.x, state.y, 80).find((candidate) => candidate.id === id);
    if (!npc) continue;
    if (state.reaction === 'charge') {
      state.target = { x: player.x, y: player.y };
    }
    if (state.reaction === 'flee' || state.reaction === 'charge') {
      const target = state.target ?? { x: state.x, y: state.y };
      const dx = target.x - state.x;
      const dy = target.y - state.y;
      const length = Math.max(1, Math.hypot(dx, dy));
      const speed = state.reaction === 'charge' ? 120 : 150;
      const next = clampToMap({
        x: state.x + (dx / length) * speed * dt,
        y: state.y + (dy / length) * speed * dt
      }, 28);
      if (!staticCollisionAtInWorld(next, 14, world)) {
        state.x = next.x;
        state.y = next.y;
      }
    }
    if (state.reaction === 'charge' && distance({ x: state.x, y: state.y }, player) < 42 && now > (state.nextAttackAt ?? 0)) {
      playerHealth -= 0.7;
      state.nextAttackAt = now + 950;
      bubbles.push({
        id: `${id}:hit:${now}`,
        npcId: id,
        x: state.x,
        y: state.y,
        text: `${npc.persona.name} strikes at you.`,
        startsAt: now,
        expiresAt: now + 1_500,
        kind: 'reaction'
      });
    }
  }
}

function villagerReactionFor(npc: GeneratedNpc, victim: GeneratedNpc, index: number): VillagerReactionKind {
  const roll = Math.abs(simpleHash(`${npc.id}:${victim.id}:${index}`)) % 100;
  if (roll < 24) return 'panic';
  if (roll < 54) return 'flee';
  if (roll < 78) return 'scream';
  return 'charge';
}

function attackingVillagers(): GeneratedNpc[] {
  return aliveNpcsNear(player.x, player.y, 180)
    .filter((npc) => villagerCombat.get(npc.id)?.reaction === 'charge');
}

function villagerState(npc: GeneratedNpc): VillagerCombatState {
  let state = villagerCombat.get(npc.id);
  if (!state) {
    state = { npc, health: 3 };
    villagerCombat.set(npc.id, state);
  } else {
    state.npc = npc;
  }
  return state;
}

function addCorpse(dead: { id: string; x: number; y: number; name: string; color: string }, now: number): void {
  if (corpses.some((corpse) => corpse.id === dead.id)) return;
  corpses.push({
    ...dead,
    heading: (Math.abs(simpleHash(dead.id)) % 628) / 100,
    createdAt: now
  });
}

function aliveNpcsNear(x: number, y: number, radius: number): GeneratedNpc[] {
  return world.npcsNear(x, y, radius).filter((npc) => !deadNpcIds.has(npc.id));
}

function normalized(vector: Vec2): Vec2 {
  const length = Math.max(1, Math.hypot(vector.x, vector.y));
  return { x: vector.x / length, y: vector.y / length };
}

function simpleHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return hash;
}

function recordViolence(kind: 'villager' | 'constable' | 'hostile'): void {
  playerSheet.violentActs += 1;
  if (kind === 'villager') playerSheet.karma -= 4;
  else if (kind === 'constable') playerSheet.karma -= 3;
  else playerSheet.karma = Math.max(-12, playerSheet.karma - 1);
  playerSheet.karma = Math.max(-30, Math.min(10, playerSheet.karma));
}

function playerReputationLabel(): string {
  if (playerSheet.karma <= -16) return 'feared killer';
  if (playerSheet.karma <= -8) return 'dangerous troublemaker';
  if (playerSheet.karma <= -1) return 'unsettling stranger';
  if (playerSheet.karma <= 3) return 'unknown traveler';
  return 'trusted traveler';
}

function playerCharacterFacts(): string[] {
  return [
    `Player character sheet: karma ${playerSheet.karma} (${playerReputationLabel()}).`,
    `Recorded violence: ${playerSheet.violentActs} violent acts, ${playerSheet.villagerKills} villager deaths, ${playerSheet.constableDefeats} constables defeated, ${playerSheet.hostileDefeats} hostile attackers defeated.`,
    playerSheet.karma < 0
      ? 'Locals have reason to be colder, warier, or afraid of the player, but each NPC should decide how to express that in character.'
      : 'Locals have no strong reason yet to treat the player as dangerous.'
  ];
}

function playerContext(visibleEquipment: string[] = ['travel cloak', 'worn boots']) {
  return {
    id: 'player',
    knownFacts: playerKnownFacts(),
    visibleEquipment,
    reputation: {
      karma: playerSheet.karma,
      villagerKills: playerSheet.villagerKills,
      constableDefeats: playerSheet.constableDefeats,
      hostileDefeats: playerSheet.hostileDefeats,
      violentActs: playerSheet.violentActs
    }
  };
}

function playerRelationshipTo(npc: GeneratedNpc): string {
  if (playerSheet.villagerKills > 0 || playerSheet.karma <= -16) {
    return npc.persona.role.includes('guard')
      ? 'suspected killer facing a duty-bound local guard'
      : 'feared stranger suspected of killing locals';
  }
  if (playerSheet.karma <= -8) return 'dangerous stranger locals warn each other about';
  if (playerSheet.karma < 0) return 'unsettling stranger with a poor local reputation';
  return 'new acquaintance';
}

function distanceToSegment(point: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq <= 0) return distance(point, a);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq));
  return distance(point, {
    x: a.x + dx * t,
    y: a.y + dy * t
  });
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
    } else {
      constable.target = constablePatrolTarget(constable.target, constable.patrolSeed + now * 0.001);
    }
  }
}

function drawCombat(now: number, camera: Vec2): void {
  const aim = aimVector();
  ctx.save();
  if (bowAimActive) {
    const rx = mouseWorld.x - camera.x;
    const ry = mouseWorld.y - camera.y;
    ctx.strokeStyle = 'rgba(244, 211, 109, 0.86)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(rx, ry, 13, 0, Math.PI * 2);
    ctx.moveTo(rx - 20, ry);
    ctx.lineTo(rx - 7, ry);
    ctx.moveTo(rx + 7, ry);
    ctx.lineTo(rx + 20, ry);
    ctx.moveTo(rx, ry - 20);
    ctx.lineTo(rx, ry - 7);
    ctx.moveTo(rx, ry + 7);
    ctx.lineTo(rx, ry + 20);
    ctx.stroke();
  }

  for (const projectile of projectiles) {
    ctx.strokeStyle = '#f1d590';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(projectile.x - camera.x, projectile.y - camera.y);
    ctx.lineTo(projectile.x - projectile.vx * 0.026 - camera.x, projectile.y - projectile.vy * 0.026 - camera.y);
    ctx.stroke();
  }

  for (const slash of slashes) {
    const age = (now - slash.createdAt) / Math.max(1, slash.expiresAt - slash.createdAt);
    ctx.strokeStyle = `rgba(232, 238, 220, ${Math.max(0, 1 - age) * 0.72})`;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(player.x - camera.x, player.y - camera.y, 58, slash.heading - 0.85, slash.heading + 0.85);
    ctx.stroke();
  }
  ctx.restore();
}

function drawCorpses(camera: Vec2): void {
  ctx.save();
  for (const corpse of [...corpses].sort((a, b) => a.y - b.y)) {
    const sx = corpse.x - camera.x;
    const sy = corpse.y - camera.y;
    if (sx < -80 || sy < -80 || sx > cssWidth + 80 || sy > cssHeight + 80) continue;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(corpse.heading);
    ctx.fillStyle = 'rgba(24, 18, 14, 0.34)';
    ctx.beginPath();
    ctx.ellipse(0, 7, 20, 7, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(83, 20, 18, 0.56)';
    ctx.beginPath();
    ctx.ellipse(11, 7, 11, 5, -0.24, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = corpse.color;
    ctx.strokeStyle = 'rgba(18, 12, 10, 0.62)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(-15, -5, 30, 11, 5);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#1e1715';
    ctx.beginPath();
    ctx.arc(-19, 0, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
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
  renderBootScreen();
  updateAmbientFlowLine();
  regionEl.textContent = regionName(player.x, player.y);
  coordEl.textContent = `${Math.round(player.x)}, ${Math.round(player.y)}${performance.now() < wallPulseUntil ? ' / map edge' : ''}`;
  bowToggle.classList.toggle('active', bowAimActive);
  bowToggle.setAttribute('aria-pressed', String(bowAimActive));
  bowToggle.textContent = bowAimActive ? 'Bow Aiming' : 'Bow';
  combatHealthEl.textContent = `${Math.max(0, Math.ceil(playerHealth))}/${playerMaxHealth}`;
  combatArrowsEl.textContent = `${arrowCount}`;
  combatKarmaEl.textContent = `${playerSheet.karma > 0 ? '+' : ''}${playerSheet.karma} ${playerReputationLabel()}`;

  const key = activeNpc ? 'active' : clickableNpcs.map((npc) => {
    const session = dialogueController.sessionFor(npc);
    return `${npc.id}:${session.mood}:${session.willTalkAgain}`;
  }).join('|') || 'none';
  if (key !== interactionKey) {
    interactionKey = key;
    if (clickableNpcs.length && !activeNpc) {
      interactionEl.classList.remove('hidden');
      interactionEl.classList.remove('empty');
      const primary = clickableNpcs[0]!;
      const session = dialogueController.sessionFor(primary);
      const names = clickableNpcs.slice(0, 3).map((npc) => npc.persona.name).join(', ');
      interactionEl.innerHTML = `
        <div>
          <strong>${escapeHtml(names)}</strong>
          <span>click a highlighted person / ${escapeHtml(session.mood)}</span>
        </div>
      `;
    } else {
      interactionEl.classList.add('hidden');
      interactionEl.classList.add('empty');
      interactionEl.innerHTML = '';
    }
  }
}

function updateBootPhase(id: BootPhaseId, status: BootPhaseStatus, detail: string): void {
  bootPhases = bootPhases.map((phase) => phase.id === id ? { ...phase, status, detail } : phase);
  renderBootScreen();
}

function dismissBootScreen(): void {
  if (!bootCanEnter) return;
  bootVisible = false;
  bootScreenEl.classList.add('hidden');
  const modelLabel = pendingAmbientCacheModelLabel;
  pendingAmbientCacheModelLabel = undefined;
  if (modelLabel) {
    window.setTimeout(() => {
      void preloadAreaEvents(modelLabel);
      void pregenerateAmbientCache(modelLabel);
    }, 2_000);
  }
  renderHud();
}

function renderBootScreen(): void {
  bootScreenEl.classList.toggle('hidden', !bootVisible);
  bootTitleEl.textContent = bootTitle;
  bootDetailEl.textContent = bootDetail;
  bootEnterButton.disabled = !bootCanEnter;
  bootEnterButton.textContent = bootCanEnter ? 'Enter World' : 'Loading';
  bootPhasesEl.innerHTML = bootPhases.map((phase) => `
    <div class="boot-phase ${phase.status}">
      <span>${escapeHtml(phase.label)}</span>
      <strong>${escapeHtml(phase.status)}</strong>
      <p>${escapeHtml(phase.detail)}</p>
    </div>
  `).join('');
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
  dialogueNpcAvatarEl.textContent = initials(activeNpc.persona.name);
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
  if (dialogueStatus && performance.now() > dialogueStatus.expiresAt) {
    dialogueStatus = undefined;
  }
  dialogueThinkingEl.classList.toggle('hidden', !busy && !dialogueStatus);
  dialogueThinkingEl.classList.toggle('error', dialogueStatus?.kind === 'error');
  const dialogueThinkingText = dialogueThinkingEl.querySelector('p');
  if (dialogueThinkingText) {
    dialogueThinkingText.textContent = busy ? 'Thinking' : dialogueStatus?.text ?? '';
  }
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
        player: playerContext(),
        relationship: 'uninvited interruption',
        npcState: dialogueController.stateForRequest(npc),
        recentDialogue: [
          { speaker: 'System', text: `${npc.persona.name} is already speaking privately with companions.` },
          { speaker: 'You', text: 'Can I ask you something?' }
        ]
      },
      options: {
        timeoutMs: dialogueTimeoutMs
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
  dialogueStatus = undefined;
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
        player: playerContext(),
        relationship: playerRelationshipTo(npc),
        npcState: dialogueController.stateForRequest(npc),
        recentDialogue: conversation.slice(-8).map((line) => ({
          speaker: line.speaker,
          text: line.text
        }))
      },
      options: {
        assess: shouldRunDialogueAssessment(text),
        timeoutMs: dialogueTimeoutMs
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
    traceLine = `dialogue failed / ${message}`;
    traceDetail = '';
    dialogueStatus = {
      text: 'No reply. See diagnostics.',
      kind: 'error',
      expiresAt: performance.now() + 4_500
    };
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
  if (ended) {
    const closingNpcId = npc.id;
    window.setTimeout(() => {
      if (activeNpc?.id === closingNpcId && ended && !busy) {
        closeConversation();
      }
    }, 2_400);
  }
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

function shouldRunDialogueAssessment(text: string): boolean {
  return playerSheet.karma <= -8 ||
    /\b(attack|burn|fight|hurt|kill|murder|rob|stab|threat|force|weapon|knife|sword|torch|die)\b/i.test(text);
}

function isGoodbyeText(text: string): boolean {
  return /^(bye|goodbye|farewell|later|see you|i should go|i have to go)[.! ]*$/i.test(text.trim());
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
    const spawnPoint = constableRoadSpawn(origin, index);
    const target = constablePatrolTarget(origin, index * 1.9 + now * 0.001);
    constables.push({
      id: `constable.${Math.round(now)}.${index}`,
      name: names[index]!,
      x: spawnPoint.x,
      y: spawnPoint.y,
      target,
      patrolSeed: now * 0.001 + index * 2.4,
      spawnedAt: now,
      expiresAt: now + 95_000,
      health: 3,
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

function constableRoadSpawn(origin: Vec2, index: number): Vec2 {
  const candidates: Vec2[] = [];
  for (const radius of [360, 460, 560, 680, 820, 980]) {
    for (let step = 0; step < 20; step += 1) {
      const angle = (Math.PI * 2 * step) / 20 + index * 0.76 + radius * 0.006;
      candidates.push(clampToMap({
        x: origin.x + Math.cos(angle) * radius,
        y: origin.y + Math.sin(angle) * radius * 0.78
      }, 70));
    }
  }
  return candidates
    .filter((candidate) => isSafeRoadPoint(candidate))
    .sort((a, b) => {
      const da = distance(a, origin) + distance(a, player) * 0.18;
      const db = distance(b, origin) + distance(b, player) * 0.18;
      return da - db;
    })[0] ?? findSafeSpawnInWorld(origin, world, 18);
}

function constablePatrolTarget(origin: Vec2, seed: number): Vec2 {
  const candidates: Vec2[] = [];
  for (const radius of [54, 82, 116, 158, 220]) {
    for (let step = 0; step < 14; step += 1) {
      const angle = (Math.PI * 2 * step) / 14 + seed;
      candidates.push(clampToMap({
        x: origin.x + Math.cos(angle) * radius,
        y: origin.y + Math.sin(angle) * radius * 0.72
      }, 50));
    }
  }
  return candidates
    .filter((candidate) => isSafeRoadPoint(candidate))
    .sort((a, b) => distance(a, origin) - distance(b, origin))[0] ?? findSafeSpawnInWorld(origin, world, 18);
}

function isSafeRoadPoint(point: Vec2): boolean {
  return isInsideMap(point, 48) &&
    pathStrength(point.x, point.y) > 0.26 &&
    !staticCollisionAtInWorld(point, 18, world);
}

function closeConversation(): void {
  activeNpc = undefined;
  activeNpcPosition = undefined;
  busy = false;
  ended = false;
  conversation = [];
  dialogueStatus = undefined;
  interactionKey = '';
  renderDialogue();
}

function nextAiRequestId(kind: string, ownerId: string): string {
  return `${kind}:${ownerId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
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
    player: playerContext(),
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
    ...playerCharacterFacts(),
    ...landmarkLoreLines()
  ];
}

function stripRuntimeNpc(npc: GeneratedNpc) {
  const session = dialogueController.sessionFor(npc);
  const scene = sceneAt(npc);
  return {
    id: npc.id,
    persona: {
      ...npc.persona,
      mood: session.mood,
      knows: [
        ...(npc.persona.knows ?? []),
        ...(scene.contextualFacts ?? [])
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

function initials(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || '?';
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
