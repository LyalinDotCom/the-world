import { app, BrowserWindow, ipcMain } from 'electron';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DiagnosticsSampler, registerDiagnosticsIpc } from './diagnostics.js';
import { PerfLogger } from './perfLog.js';
import { createRuntime } from './runtime.js';
import { createWindow } from './window.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let cleanupGameAI: (() => void) | undefined;
let cleanupDiagnostics: (() => void) | undefined;
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

function installRuntime(): void {
  cleanupGameAI?.();
  cleanupDiagnostics?.();
  const diagnostics = new DiagnosticsSampler();
  const perfLogger = new PerfLogger(app.getPath('userData'));
  cleanupGameAI = createRuntime(ipcMain, reportMainProcessError);
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
      installRuntime();
    }
    openMainWindow();
  }
});

app.whenReady()
  .then(() => {
    installRuntime();
    openMainWindow();
  })
  .catch((error) => {
    reportMainProcessError('app ready failed', error);
    app.quit();
  });
