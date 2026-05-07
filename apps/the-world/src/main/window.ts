import { BrowserWindow } from 'electron';
import path from 'node:path';

export interface CreateWindowOptions {
  dirname: string;
  reportError(kind: string, error: unknown): void;
}

export function createWindow(options: CreateWindowOptions): BrowserWindow {
  const preloadPath = path.join(options.dirname, '../preload/preload.js');
  const mainWindow = new BrowserWindow({
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
    options.reportError('renderer did-fail-load', {
      errorCode,
      errorDescription,
      validatedURL,
      isMainFrame
    });
  });
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('The World: renderer loaded.');
    void mainWindow.webContents.executeJavaScript('Boolean(window.gameAI)', true)
      .then((hasBridge) => {
        console.log(`The World: Gemma IPC bridge ${hasBridge ? 'ready' : 'missing'}.`);
      })
      .catch((error) => options.reportError('bridge verification failed', error));
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    options.reportError('renderer process gone', details);
  });
  mainWindow.on('unresponsive', () => {
    options.reportError('window unresponsive', new Error('The World renderer became unresponsive.'));
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl).catch((error) => options.reportError('load dev renderer failed', error));
    if (process.env.THE_WORLD_OPEN_DEVTOOLS === '1') {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
    return mainWindow;
  }

  void mainWindow.loadFile(path.join(options.dirname, '../renderer/index.html'))
    .catch((error) => options.reportError('load renderer failed', error));
  return mainWindow;
}
