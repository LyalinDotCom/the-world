import { app, BrowserWindow, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { appendFile, mkdir } from 'node:fs/promises';
import { createGameAI } from '@game-llm/core';
import { registerGameAIIpc } from '@game-llm/electron';
import { ollamaProvider } from '@game-llm/ollama';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let cleanupIpc: (() => void) | undefined;
let mainWindow: BrowserWindow | undefined;

app.setName('The World');

function formatUnknownError(error: unknown): string {
  return error instanceof Error
    ? error.stack ?? error.message
    : String(error);
}

async function logMainProcessError(kind: string, error: unknown): Promise<void> {
  const logDirectory = path.join(app.getPath('userData'), 'logs');
  await mkdir(logDirectory, { recursive: true });
  await appendFile(
    path.join(logDirectory, 'main-process-errors.log'),
    `[${new Date().toISOString()}] ${kind}\n${formatUnknownError(error)}\n\n`,
    'utf-8'
  );
}

function reportMainProcessError(kind: string, error: unknown): void {
  console.error(`[the-world] ${kind}:`, error);
  void logMainProcessError(kind, error).catch((logError) => {
    console.error('[the-world] Failed to write main-process error log:', logError);
  });
}

process.on('uncaughtException', (error) => {
  reportMainProcessError('uncaughtException', error);
});

process.on('unhandledRejection', (reason) => {
  reportMainProcessError('unhandledRejection', reason);
});

function createRuntime(): void {
  const provider = ollamaProvider({
    quality: 'balanced',
    timeoutMs: Number(process.env.THE_WORLD_TIMEOUT_MS ?? 24_000)
  });
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
    reportMainProcessError('warmup failed', error);
  });
}

function createWindow(): void {
  const preloadPath = path.join(__dirname, '../preload/preload.js');
  mainWindow = new BrowserWindow({
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

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    reportMainProcessError('renderer did-fail-load', {
      errorCode,
      errorDescription,
      validatedURL,
      isMainFrame
    });
  });
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('The World: renderer loaded.');
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    reportMainProcessError('renderer process gone', details);
  });
  mainWindow.on('unresponsive', () => {
    reportMainProcessError('window unresponsive', new Error('The World renderer became unresponsive.'));
  });
  mainWindow.on('closed', () => {
    mainWindow = undefined;
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl).catch((error) => reportMainProcessError('load dev renderer failed', error));
    if (process.env.THE_WORLD_OPEN_DEVTOOLS === '1') {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
    return;
  }

  void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
    .catch((error) => reportMainProcessError('load renderer failed', error));
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

app.whenReady()
  .then(() => {
    createRuntime();
    createWindow();
  })
  .catch((error) => {
    reportMainProcessError('app ready failed', error);
    app.quit();
  });
