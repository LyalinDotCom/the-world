import type { RendererGameAIApi } from '@game-llm/electron';
import '../shared/bridge.js';

export function getGameAI(): RendererGameAIApi {
  if (!window.gameAI) {
    throw new Error('The World must run in the Electron shell. The Gemma IPC bridge is missing.');
  }
  return window.gameAI;
}
