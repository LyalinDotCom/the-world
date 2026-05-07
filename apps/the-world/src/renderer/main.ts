import type { DialogueTurn, OverheardExchange } from '@game-llm/core';
import { getGameAI } from './aiClient.js';
import { ProceduralWorld, crossPathX, distance, mainPathY, regionName, type GeneratedNpc } from './world.js';
import './style.css';

interface Bubble {
  id: string;
  npcId: string;
  x: number;
  y: number;
  text: string;
  expiresAt: number;
}

interface LogLine {
  speaker: string;
  text: string;
  kind: 'player' | 'npc' | 'system';
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

const ai = getGameAI();
const world = new ProceduralWorld('the-world-v1');
const keys = new Set<string>();
const player = {
  x: 120,
  y: mainPathY(120),
  radius: 15,
  speed: 330
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
let providerLine = 'AI runtime connecting...';
let warmupLine = 'warmup pending';
let traceLine = 'No generation yet.';
let traceDetail = '';
let conversation: LogLine[] = [];
let bubbles: Bubble[] = [];
let interactionKey = '';

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
  <aside class="devtools">
    <header>Runtime Trace</header>
    <div id="warmup-line" class="devrow"></div>
    <div id="trace-line" class="devrow"></div>
    <pre id="trace-detail"></pre>
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
const regionEl = document.querySelector<HTMLSpanElement>('#region-line')!;
const coordEl = document.querySelector<HTMLSpanElement>('#coord-line')!;
const interactionEl = document.querySelector<HTMLDivElement>('#interaction')!;
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

resize();
void initializeRuntime();
requestAnimationFrame(frame);

async function initializeRuntime(): Promise<void> {
  try {
    const health = await ai.health();
    providerLine = `${health.provider}${health.model ? ` / ${health.model}` : ''} / ${health.mode}`;
    renderHud();
  } catch (error) {
    providerLine = `runtime unavailable / ${errorMessage(error)}`;
  }

  try {
    warmupLine = 'warming local model...';
    renderHud();
    const health = await ai.warmup();
    warmupLine = health.ok ? `warm / ${health.model ?? health.provider}` : `warmup degraded / ${health.message ?? health.mode}`;
  } catch (error) {
    warmupLine = `warmup failed / ${errorMessage(error)}`;
  }
  renderHud();
}

function frame(now: number): void {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  update(dt, now);
  draw(now);
  requestAnimationFrame(frame);
}

function update(dt: number, now: number): void {
  if (!dialogueInput.matches(':focus')) {
    let dx = 0;
    let dy = 0;
    if (keys.has('arrowleft') || keys.has('a')) dx -= 1;
    if (keys.has('arrowright') || keys.has('d')) dx += 1;
    if (keys.has('arrowup') || keys.has('w')) dy -= 1;
    if (keys.has('arrowdown') || keys.has('s')) dy += 1;
    if (dx !== 0 || dy !== 0) {
      const length = Math.hypot(dx, dy);
      player.x += (dx / length) * player.speed * dt;
      player.y += (dy / length) * player.speed * dt;
    }
  }

  bubbles = bubbles.filter((bubble) => bubble.expiresAt > now);
  const nearby = world.npcsNear(player.x, player.y, 720);
  nearestNpc = nearby
    .filter((npc) => distance(npc, player) < 165)
    .sort((a, b) => distance(a, player) - distance(b, player))[0];
  maybeRequestAmbient(now, nearby);
  renderHud();
}

function draw(now: number): void {
  const camera = {
    x: player.x - cssWidth / 2,
    y: player.y - cssHeight / 2
  };
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  drawTerrain(camera);
  drawPaths(camera);
  drawHills(camera);
  drawTrees(camera);
  const npcs = world.npcsNear(player.x, player.y, Math.max(cssWidth, cssHeight));
  drawNpcs(camera, npcs, now);
  drawPlayer(camera, now);
  drawBubbles(camera, now);
}

function drawTerrain(camera: { x: number; y: number }): void {
  const tile = 86;
  const minX = Math.floor(camera.x / tile) * tile;
  const minY = Math.floor(camera.y / tile) * tile;
  for (let x = minX; x < camera.x + cssWidth + tile; x += tile) {
    for (let y = minY; y < camera.y + cssHeight + tile; y += tile) {
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

function drawTrees(camera: { x: number; y: number }): void {
  const trees = world.treesInRect(camera.x - 80, camera.y - 80, camera.x + cssWidth + 80, camera.y + cssHeight + 80);
  for (const tree of trees) {
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

function drawNpcs(camera: { x: number; y: number }, npcs: GeneratedNpc[], now: number): void {
  for (const npc of npcs.sort((a, b) => a.y - b.y)) {
    const sx = npc.x - camera.x;
    const sy = npc.y - camera.y;
    const bob = Math.sin(now * 0.004 + npc.x * 0.01) * 1.5;
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
    if (npc === nearestNpc) {
      ctx.strokeStyle = '#f4d36d';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx, sy + 1, 25, 0, Math.PI * 2);
      ctx.stroke();
      label(npc.persona.name, sx, sy - 36, '#f6ecd2');
    } else if (distance(npc, player) < 280) {
      label(npc.persona.name, sx, sy - 35, 'rgba(246, 236, 210, 0.82)');
    }
  }
}

function drawPlayer(camera: { x: number; y: number }, now: number): void {
  const sx = player.x - camera.x;
  const sy = player.y - camera.y;
  const bob = Math.sin(now * 0.008) * 1.4;
  ctx.fillStyle = 'rgba(15, 17, 14, 0.35)';
  ctx.beginPath();
  ctx.ellipse(sx + 3, sy + 20, 16, 6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#243342';
  roundedRect(sx - 10, sy - 12 + bob, 20, 28, 7);
  ctx.fill();
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

function drawBubbles(camera: { x: number; y: number }, now: number): void {
  for (const bubble of bubbles) {
    const alpha = Math.min(1, (bubble.expiresAt - now) / 650);
    const sx = bubble.x - camera.x;
    const sy = bubble.y - camera.y - 54;
    const lines = wrapText(bubble.text, 28).slice(0, 3);
    const width = Math.min(260, Math.max(120, ...lines.map((line) => ctx.measureText(line).width + 28)));
    const height = 24 + lines.length * 18;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(29, 31, 26, 0.88)';
    roundedRect(sx - width / 2, sy - height, width, height, 8);
    ctx.fill();
    ctx.strokeStyle = 'rgba(239, 205, 135, 0.42)';
    ctx.stroke();
    ctx.fillStyle = '#f4e4bf';
    ctx.font = '13px Georgia, serif';
    lines.forEach((line, index) => ctx.fillText(line, sx - width / 2 + 14, sy - height + 20 + index * 18));
    ctx.globalAlpha = 1;
  }
}

function renderHud(): void {
  providerEl.textContent = providerLine;
  warmupEl.textContent = warmupLine;
  traceEl.textContent = traceLine;
  traceDetailEl.textContent = traceDetail;
  regionEl.textContent = regionName(player.x, player.y);
  coordEl.textContent = `${Math.round(player.x)}, ${Math.round(player.y)}`;

  const key = nearestNpc ? nearestNpc.id : 'none';
  if (key !== interactionKey) {
    interactionKey = key;
    if (nearestNpc && !activeNpc) {
      interactionEl.classList.remove('empty');
      interactionEl.innerHTML = `
        <div>
          <strong>${escapeHtml(nearestNpc.persona.name)}</strong>
          <span>${escapeHtml(nearestNpc.persona.role)} / ${escapeHtml(nearestNpc.persona.mood ?? 'calm')}</span>
        </div>
        <button id="talk-button" type="button">Talk</button>
      `;
      document.querySelector<HTMLButtonElement>('#talk-button')?.addEventListener('click', () => {
        if (nearestNpc) void startConversation(nearestNpc);
      });
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
  dialogueNameEl.textContent = activeNpc.persona.name;
  dialogueRoleEl.textContent = `${activeNpc.persona.role} / ${activeNpc.persona.mood ?? 'calm'}`;
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
  activeNpc = npc;
  busy = false;
  ended = false;
  conversation = [];
  interactionKey = '';
  renderDialogue();
  await sendToNpc('Hello.');
  dialogueInput.focus();
}

async function sendToNpc(text: string): Promise<void> {
  if (!activeNpc) return;
  busy = true;
  conversation.push({ speaker: 'You', text, kind: 'player' });
  renderDialogue();
  try {
    const turn = await ai.dialogue({
      npc: stripRuntimeNpc(activeNpc),
      request: {
        playerText: text,
        scene: currentScene(),
        player: {
          id: 'player',
          knownFacts: ['The old mill is avoided after dark.'],
          visibleEquipment: ['travel cloak', 'worn boots']
        },
        relationship: 'new acquaintance'
      }
    });
    applyDialogueTurn(activeNpc, turn);
  } catch (error) {
    const message = errorMessage(error);
    conversation.push({ speaker: activeNpc.persona.name, text: 'The words catch in the air and fail to arrive.', kind: 'npc' });
    traceLine = `dialogue failed / ${message}`;
    traceDetail = '';
  } finally {
    busy = false;
    renderDialogue();
  }
}

function applyDialogueTurn(npc: GeneratedNpc, turn: DialogueTurn): void {
  conversation.push({ speaker: npc.persona.name, text: turn.text, kind: 'npc' });
  bubbles.push({
    id: `${npc.id}:${performance.now()}`,
    npcId: npc.id,
    x: npc.x,
    y: npc.y,
    text: turn.text,
    expiresAt: performance.now() + 6_000
  });
  ended = Boolean(turn.shouldEndConversation);
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
  busy = false;
  ended = false;
  conversation = [];
  interactionKey = '';
  renderDialogue();
}

function maybeRequestAmbient(now: number, nearby: GeneratedNpc[]): void {
  if (activeNpc || busy) return;
  const close = nearby.filter((npc) => distance(npc, player) < 390);
  if (!ambientInFlight) {
    const npc = close.find((candidate) => now - candidate.lastBarkAt > 18_000 + (candidate.x % 11) * 1_000);
    if (npc) {
      ambientInFlight = true;
      npc.lastBarkAt = now;
      void ai.bark({
        npc: stripRuntimeNpc(npc),
        request: {
          scene: currentScene(),
          reason: 'player nearby'
        }
      }).then((bark) => {
        bubbles.push({
          id: `${npc.id}:bark:${now}`,
          npcId: npc.id,
          x: npc.x,
          y: npc.y,
          text: bark.text,
          expiresAt: performance.now() + 4_800
        });
      }).catch((error) => {
        traceLine = `bark failed / ${errorMessage(error)}`;
      }).finally(() => {
        ambientInFlight = false;
      });
    }
  }

  if (!overhearInFlight && close.length >= 2) {
    const [a, b] = close.sort((left, right) => distance(left, player) - distance(right, player));
    if (a && b && distance(a, b) < 430 && now - a.lastOverheardAt > 32_000 && now - b.lastOverheardAt > 32_000) {
      overhearInFlight = true;
      a.lastOverheardAt = now;
      b.lastOverheardAt = now;
      void ai.overhear({
        npc: stripRuntimeNpc(a),
        request: {
          otherNpc: stripRuntimeNpc(b),
          scene: currentScene(),
          topic: 'road rumors near the old mill'
        }
      }).then((exchange) => applyOverheard(exchange, [a, b]))
        .catch((error) => {
          traceLine = `overhear failed / ${errorMessage(error)}`;
        })
        .finally(() => {
          overhearInFlight = false;
        });
    }
  }
}

function applyOverheard(exchange: OverheardExchange, npcs: GeneratedNpc[]): void {
  const byId = new Map(npcs.map((npc) => [npc.id, npc]));
  for (const line of exchange.lines) {
    const npc = byId.get(line.npcId) ?? npcs[0];
    if (!npc) continue;
    bubbles.push({
      id: `${line.npcId}:overheard:${performance.now()}`,
      npcId: line.npcId,
      x: npc.x,
      y: npc.y,
      text: line.text,
      expiresAt: performance.now() + 6_200
    });
  }
  if (exchange.trace) {
    traceLine = `${exchange.trace.recipeId} / ${exchange.trace.providerId} / ${Math.round(exchange.trace.latencyMs)}ms`;
    traceDetail = exchange.trace.rawText.slice(0, 420);
  }
}

function currentScene() {
  return {
    location: regionName(player.x, player.y),
    biome: world.terrainAt(player.x, player.y).biome,
    timeOfDay: 'late afternoon',
    weather: 'thin cloud',
    nearbyCharacters: world.npcsNear(player.x, player.y, 320).map((npc) => npc.id),
    coordinates: {
      x: Math.round(player.x),
      y: Math.round(player.y)
    },
    visibleLandmarks: visibleLandmarks()
  };
}

function visibleLandmarks(): string[] {
  const landmarks = ['waystone', 'old mill smoke', 'split pine', 'low ridge'];
  return landmarks.filter((_, index) => Math.abs(Math.round(player.x / 700) + Math.round(player.y / 700) + index) % 3 === 0);
}

function stripRuntimeNpc(npc: GeneratedNpc) {
  return {
    id: npc.id,
    persona: npc.persona,
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

function resize(): void {
  dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  cssWidth = window.innerWidth;
  cssHeight = window.innerHeight;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  canvas.width = Math.floor(cssWidth * dpr);
  canvas.height = Math.floor(cssHeight * dpr);
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
