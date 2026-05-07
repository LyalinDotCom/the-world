import { app, BrowserWindow, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { appendFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import { createGameAI } from '@game-llm/core';
import { registerGameAIIpc } from '@game-llm/electron';
import { ollamaProvider } from '@game-llm/ollama';
import type { DiagnosticsSample, PerfLogSample, PerfLogStatus } from '../shared/bridge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
let cleanupIpc: (() => void) | undefined;
let mainWindow: BrowserWindow | undefined;
let lastGpuSample: DiagnosticsSample['gpu'] | undefined;
let lastGpuSampleAt = 0;
let lastCpuSample: {
  timestamp: number;
  total: number;
  idle: number;
  process: NodeJS.CpuUsage;
} | undefined;
let perfLogPath: string | undefined;
let perfLogSamples = 0;

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
  cleanupIpc?.();
  cleanupIpc = undefined;
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
        'The Abandoned Castle above Cindervale has no lord, but its watchfires appear in storms.',
        'The Sunken Chapel bell can be heard under wet ground, though the chapel doors are half buried.',
        'Black Bell Tower has no rope and no bell ringer, but travelers count its tolls before choosing a road.',
        'Everyone knows these landmarks by rumor, but nobody knows the true cause behind them.',
        'NPCs know local rumors but should not reveal hidden causes or quest twists before the player earns trust.'
      ]
    },
    runtime: {
      mode: provider.id === 'ollama' ? 'local-first' : 'mock',
      quality: 'balanced',
      cache: 'session',
      maxLatencyMs: 24_000,
      debug: true,
      pregeneration: {
        enabled: true,
        cacheOnlyRuntimeRecipes: ['npc.bark', 'npc.overhear'],
        maxConcurrency: 1
      }
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
  ipcMain.removeHandler('the-world:diagnostics');
  ipcMain.removeHandler('the-world:perf-log:start');
  ipcMain.removeHandler('the-world:perf-log:append');
  ipcMain.removeHandler('the-world:perf-log:stop');
  ipcMain.removeHandler('the-world:perf-log:status');
  ipcMain.handle('the-world:diagnostics', async () => await getDiagnosticsSample());
  ipcMain.handle('the-world:perf-log:start', async () => await startPerfLog());
  ipcMain.handle('the-world:perf-log:append', async (_event, sample: PerfLogSample) => await appendPerfLogSample(sample));
  ipcMain.handle('the-world:perf-log:stop', async () => stopPerfLog());
  ipcMain.handle('the-world:perf-log:status', async () => perfLogStatus());
  void ai.provider.warmup?.({
    prompt: 'Warm up for The World. Prepare for short schema-bound NPC dialogue and ambient barks.',
    timeoutMs: 45_000
  }).then((health) => {
    console.log(`The World: warmup ${health.ok ? 'ready' : 'degraded'} (${health.provider}${health.model ? ` ${health.model}` : ''})`);
  }).catch((error) => {
    reportMainProcessError('warmup failed', error);
  });
}

async function getDiagnosticsSample(): Promise<DiagnosticsSample> {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const processMemory = process.memoryUsage();
  return {
    timestamp: Date.now(),
    systemMemory: {
      totalBytes,
      freeBytes,
      usedBytes: Math.max(0, totalBytes - freeBytes)
    },
    processMemory: {
      rssBytes: processMemory.rss,
      heapUsedBytes: processMemory.heapUsed,
      heapTotalBytes: processMemory.heapTotal
    },
    cpu: sampleCpu(),
    gpu: await sampleGpu(totalBytes)
  };
}

function sampleCpu(): DiagnosticsSample['cpu'] {
  try {
    const now = Date.now();
    const snapshot = cpuSnapshot();
    const processUsage = process.cpuUsage();
    const cores = os.cpus().length || 1;
    if (!lastCpuSample) {
      lastCpuSample = {
        timestamp: now,
        total: snapshot.total,
        idle: snapshot.idle,
        process: processUsage
      };
      return {
        available: true,
        cores,
        loadAverage: os.loadavg(),
        source: 'node os.cpus/process.cpuUsage',
        systemPercent: 0,
        processPercent: 0
      };
    }

    const elapsedMs = Math.max(1, now - lastCpuSample.timestamp);
    const totalDelta = Math.max(1, snapshot.total - lastCpuSample.total);
    const idleDelta = Math.max(0, snapshot.idle - lastCpuSample.idle);
    const processDeltaMicros = Math.max(0, processUsage.user - lastCpuSample.process.user + processUsage.system - lastCpuSample.process.system);
    const cpu: DiagnosticsSample['cpu'] = {
      available: true,
      cores,
      loadAverage: os.loadavg(),
      source: 'node os.cpus/process.cpuUsage',
      systemPercent: Math.round(((totalDelta - idleDelta) / totalDelta) * 100),
      processPercent: Math.round((processDeltaMicros / 1000 / (elapsedMs * cores)) * 100)
    };
    lastCpuSample = {
      timestamp: now,
      total: snapshot.total,
      idle: snapshot.idle,
      process: processUsage
    };
    return cpu;
  } catch (error) {
    return {
      available: false,
      cores: os.cpus().length || 1,
      loadAverage: os.loadavg(),
      source: 'node os.cpus/process.cpuUsage',
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function cpuSnapshot(): { total: number; idle: number } {
  return os.cpus().reduce((acc, cpu) => {
    const total = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
    return {
      total: acc.total + total,
      idle: acc.idle + cpu.times.idle
    };
  }, { total: 0, idle: 0 });
}

async function startPerfLog(): Promise<PerfLogStatus> {
  const directory = path.join(app.getPath('userData'), 'perf');
  await mkdir(directory, { recursive: true });
  perfLogPath = path.join(directory, `the-world-perf-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  perfLogSamples = 0;
  await appendFile(perfLogPath, JSON.stringify({ type: 'session.start', timestamp: Date.now(), app: 'The World' }) + '\n', 'utf-8');
  return perfLogStatus();
}

async function appendPerfLogSample(sample: PerfLogSample): Promise<PerfLogStatus> {
  if (!perfLogPath) {
    return perfLogStatus();
  }
  perfLogSamples += 1;
  await appendFile(perfLogPath, JSON.stringify({ type: 'sample', ...sample }) + '\n', 'utf-8');
  return perfLogStatus();
}

function stopPerfLog(): PerfLogStatus {
  const path = perfLogPath;
  perfLogPath = undefined;
  return {
    active: false,
    ...(path ? { path } : {}),
    samples: perfLogSamples
  };
}

function perfLogStatus(): PerfLogStatus {
  return {
    active: Boolean(perfLogPath),
    ...(perfLogPath ? { path: perfLogPath } : {}),
    samples: perfLogSamples
  };
}

async function sampleGpu(unifiedMemoryCapacityBytes: number): Promise<DiagnosticsSample['gpu']> {
  const now = Date.now();
  if (lastGpuSample && now - lastGpuSampleAt < 1_250) {
    return lastGpuSample;
  }
  try {
    const { stdout } = await execFileAsync('/usr/sbin/ioreg', ['-r', '-c', 'IOAccelerator', '-d', '1'], {
      timeout: 1_000,
      maxBuffer: 512_000
    });
    const gpu: DiagnosticsSample['gpu'] = {
      available: true,
      source: 'ioreg IOAccelerator',
      utilizationPercent: numberMatch(stdout, /"Device Utilization %"\s*=\s*(\d+)/),
      rendererUtilizationPercent: numberMatch(stdout, /"Renderer Utilization %"\s*=\s*(\d+)/),
      tilerUtilizationPercent: numberMatch(stdout, /"Tiler Utilization %"\s*=\s*(\d+)/),
      memoryUsedBytes: numberMatch(stdout, /"In use system memory"\s*=\s*(\d+)/),
      memoryAllocatedBytes: numberMatch(stdout, /"Alloc system memory"\s*=\s*(\d+)/),
      unifiedMemoryCapacityBytes,
      model: stringMatch(stdout, /"model"\s*=\s*"([^"]+)"/),
      cores: numberMatch(stdout, /"gpu-core-count"\s*=\s*(\d+)/)
    };
    lastGpuSample = gpu;
    lastGpuSampleAt = now;
    return gpu;
  } catch (error) {
    const gpu: DiagnosticsSample['gpu'] = {
      available: false,
      source: 'ioreg IOAccelerator',
      unifiedMemoryCapacityBytes,
      error: error instanceof Error ? error.message : String(error)
    };
    lastGpuSample = gpu;
    lastGpuSampleAt = now;
    return gpu;
  }
}

function numberMatch(text: string, pattern: RegExp): number | undefined {
  const value = text.match(pattern)?.[1];
  return value ? Number(value) : undefined;
}

function stringMatch(text: string, pattern: RegExp): string | undefined {
  return text.match(pattern)?.[1];
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
      nodeIntegration: false,
      sandbox: false
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
    void mainWindow?.webContents.executeJavaScript('Boolean(window.gameAI)', true)
      .then((hasBridge) => {
        console.log(`The World: Gemma IPC bridge ${hasBridge ? 'ready' : 'missing'}.`);
      })
      .catch((error) => reportMainProcessError('bridge verification failed', error));
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
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  cleanupIpc?.();
  cleanupIpc = undefined;
  ipcMain.removeHandler('the-world:diagnostics');
  ipcMain.removeHandler('the-world:perf-log:start');
  ipcMain.removeHandler('the-world:perf-log:append');
  ipcMain.removeHandler('the-world:perf-log:stop');
  ipcMain.removeHandler('the-world:perf-log:status');
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    if (!cleanupIpc) {
      createRuntime();
    }
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
