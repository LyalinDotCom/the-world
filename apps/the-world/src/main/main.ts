import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DiagnosticsSampler, registerDiagnosticsIpc } from './diagnostics.js';
import { PerfLogger } from './perfLog.js';
import { createRuntime, parseRuntimeStack, type RuntimeStack } from './runtime.js';
import { createWindow } from './window.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let cleanupGameAI: (() => void) | undefined;
let cleanupDiagnostics: (() => void) | undefined;
let mainWindow: BrowserWindow | undefined;
let selectedRuntimeStack: RuntimeStack | undefined;

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

function installRuntime(stack: RuntimeStack): void {
  cleanupGameAI?.();
  cleanupDiagnostics?.();
  const diagnostics = new DiagnosticsSampler();
  const perfLogger = new PerfLogger(app.getPath('userData'));
  cleanupGameAI = createRuntime(ipcMain, reportMainProcessError, { stack });
  cleanupDiagnostics = registerDiagnosticsIpc(ipcMain, diagnostics, perfLogger);
}

function openMainWindow(): void {
  mainWindow = createWindow({
    dirname: __dirname,
    reportError: reportMainProcessError
  });
  mainWindow.on('closed', () => {
    mainWindow = undefined;
  });
}

process.on('uncaughtException', (error) => {
  reportMainProcessError('uncaughtException', error);
});

process.on('unhandledRejection', (reason) => {
  reportMainProcessError('unhandledRejection', reason);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  cleanupGameAI?.();
  cleanupDiagnostics?.();
  cleanupGameAI = undefined;
  cleanupDiagnostics = undefined;
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    if (!cleanupGameAI) {
      installRuntime(selectedRuntimeStack ?? 'ollama-gemma4-e4b');
    }
    openMainWindow();
  }
});

app.whenReady()
  .then(async () => {
    selectedRuntimeStack = await chooseRuntimeStack();
    installRuntime(selectedRuntimeStack);
    openMainWindow();
  })
  .catch((error) => {
    reportMainProcessError('app ready failed', error);
    app.quit();
  });

async function chooseRuntimeStack(): Promise<RuntimeStack> {
  const envStack = parseRuntimeStack(process.env.THE_WORLD_AI_STACK);
  if (envStack) return envStack;

  const result = await dialog.showMessageBox({
    type: 'question',
    title: 'Choose AI Runtime',
    message: 'Choose the local AI stack for this play session.',
    detail: [
      'Ollama Gemma 4 E4B GGUF Q4 is the stable schema-bound path.',
      'LiteRT-LM Gemma 4 E4B is experimental GPU CLI support for comparison.',
      'oMLX Gemma 4 E4B MLX 8-bit uses the local OpenAI-compatible oMLX server through AI SDK.'
    ].join('\n'),
    buttons: [
      'Ollama Gemma4 E4B',
      'LiteRT-LM Gemma4 E4B',
      'oMLX Gemma4 E4B MLX 8-bit'
    ],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  });
  if (result.response === 1) return 'litert-lm-gemma4-e4b';
  if (result.response === 2) return 'omlx-gemma4-e4b-mlx-8bit';
  return 'ollama-gemma4-e4b';
}
