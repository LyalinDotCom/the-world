import { contextBridge, ipcRenderer } from 'electron';
import { exposeGameAIBridge } from '@game-llm/electron';

exposeGameAIBridge(contextBridge, ipcRenderer);
