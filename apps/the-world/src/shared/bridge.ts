import type { RendererGameAIApi } from '@game-llm/electron';

declare global {
  interface Window {
    gameAI?: RendererGameAIApi;
  }
}

export type { RendererGameAIApi };
