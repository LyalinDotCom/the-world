import { app, BrowserWindow, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createGameAI, MockGameAIProvider, type GameAIProvider } from '@game-llm/core';
import { registerGameAIIpc } from '@game-llm/electron';
import { ollamaProvider } from '@game-llm/ollama';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let cleanupIpc: (() => void) | undefined;

async function createProvider(): Promise<GameAIProvider> {
  const localProvider = ollamaProvider({
    quality: 'balanced',
    timeoutMs: Number(process.env.THE_WORLD_TIMEOUT_MS ?? 24_000)
  });
  const health = await localProvider.health?.();
  if (health?.ok) {
    return localProvider;
  }

  console.warn(`The World: Ollama unavailable, using mock provider. ${health?.message ?? ''}`);
  return new MockGameAIProvider();
}

async function createRuntime(): Promise<void> {
  const provider = await createProvider();
  const ai = createGameAI({
    provider,
    world: {
      id: 'the-world',
      name: 'The World',
      allowedInvention: 'minor-flavor',
      styleGuide: 'low-fantasy frontier, short practical speech, strange but grounded wilderness, no modern slang',
      lore: [
        'Paths in The World are older than the settlements and sometimes bend around hills that were not there yesterday.',
        'Travelers trust smoke, bells, and carved waystones more than maps.',
        'The old mill west of the road is avoided because its wheel turns on windless nights.',
        'NPCs know local rumors but should not reveal hidden causes or quest twists before the player earns trust.'
      ]
    },
    runtime: {
      mode: provider.id === 'ollama' ? 'local-first' : 'mock',
      quality: 'balanced',
      cache: 'session',
      maxLatencyMs: 24_000,
      debug: true
    },
    policies: {
      canonOnly: true,
      allowMinorFlavorInvention: true,
      noQuestMutationWithoutTool: true,
      noRewardCreation: true,
      contentRating: 'T'
    }
  });
  cleanupIpc = registerGameAIIpc(ipcMain, ai);
  void ai.provider.warmup?.({
    prompt: 'Warm up for The World. Prepare for short schema-bound NPC dialogue and ambient barks.',
    timeoutMs: 45_000
  }).then((health) => {
    console.log(`The World: warmup ${health.ok ? 'ready' : 'degraded'} (${health.provider}${health.model ? ` ${health.model}` : ''})`);
  }).catch((error) => {
    console.warn(`The World: warmup failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

function createWindow(): void {
  const preloadPath = path.join(__dirname, '../preload/preload.js');
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 980,
    minHeight: 680,
    title: 'The World',
    backgroundColor: '#161914',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void window.loadURL(devUrl);
    window.webContents.openDevTools({ mode: 'detach' });
    return;
  }

  void window.loadFile(path.join(__dirname, '../renderer/index.html'));
}

app.on('window-all-closed', () => {
  cleanupIpc?.();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

await app.whenReady();
await createRuntime();
createWindow();
