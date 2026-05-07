import { contextBridge, ipcRenderer } from 'electron';
import { exposeGameAIBridge } from '@game-llm/electron';
import type { PerfLogSample } from '../shared/bridge.js';

exposeGameAIBridge(contextBridge, ipcRenderer);

contextBridge.exposeInMainWorld('theWorldDiagnostics', {
  sample: async () => await ipcRenderer.invoke('the-world:diagnostics'),
  startPerfLog: async () => await ipcRenderer.invoke('the-world:perf-log:start'),
  appendPerfSample: async (sample: PerfLogSample) => await ipcRenderer.invoke('the-world:perf-log:append', sample),
  stopPerfLog: async () => await ipcRenderer.invoke('the-world:perf-log:stop'),
  perfLogStatus: async () => await ipcRenderer.invoke('the-world:perf-log:status')
});
