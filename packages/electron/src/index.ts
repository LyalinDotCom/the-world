import type { ContextBridge, IpcMain, IpcRenderer } from 'electron';
import type { BarkRequest, BarkTurn, DialogueRequest, DialogueTurn, GameAI, NpcDefinition, OverheardExchange, OverhearRequest, ProviderHealth } from '@game-llm/core';

export const defaultGameAiIpcChannel = 'game-ai';

export interface GameAIIpcHandlers {
  health(): Promise<ProviderHealth>;
  warmup(): Promise<ProviderHealth>;
  dialogue(payload: GameAIDialoguePayload): Promise<DialogueTurn>;
  bark(payload: GameAIBarkPayload): Promise<BarkTurn>;
  overhear(payload: GameAIOverhearPayload): Promise<OverheardExchange>;
}

export interface GameAIDialoguePayload {
  npc: NpcDefinition;
  request: DialogueRequest;
}

export interface GameAIBarkPayload {
  npc: NpcDefinition;
  request: BarkRequest;
}

export interface GameAIOverhearPayload {
  npc: NpcDefinition;
  request: OverhearRequest;
}

export interface RegisterGameAIIpcOptions {
  channel?: string;
}

export interface RendererGameAIApi extends GameAIIpcHandlers {}

export function registerGameAIIpc(ipcMain: IpcMain, ai: GameAI, options: RegisterGameAIIpcOptions = {}): () => void {
  const channel = options.channel ?? defaultGameAiIpcChannel;
  const handlers: Record<keyof GameAIIpcHandlers, (...args: unknown[]) => Promise<unknown>> = {
    health: async () => {
      return await ai.provider.health?.() ?? {
        ok: true,
        provider: ai.provider.id,
        model: ai.provider.model,
        mode: 'ready' as const
      };
    },
    warmup: async () => {
      return await ai.provider.warmup?.({
        prompt: 'Warm up for The World. Expect short schema-bound NPC dialogue requests.',
        timeoutMs: 45_000
      }) ?? await ai.provider.health?.() ?? {
        ok: true,
        provider: ai.provider.id,
        model: ai.provider.model,
        mode: 'ready' as const
      };
    },
    dialogue: async (payload) => {
      const typed = payload as GameAIDialoguePayload;
      return await ai.npc(typed.npc).respond(typed.request);
    },
    bark: async (payload) => {
      const typed = payload as GameAIBarkPayload;
      return await ai.npc(typed.npc).bark(typed.request);
    },
    overhear: async (payload) => {
      const typed = payload as GameAIOverhearPayload;
      return await ai.npc(typed.npc).overhear(typed.request);
    }
  };

  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle(`${channel}:${name}`, (_event, ...args) => handler(...args));
  }

  return () => {
    for (const name of Object.keys(handlers)) {
      ipcMain.removeHandler(`${channel}:${name}`);
    }
  };
}

export function createGameAIPreloadApi(ipcRenderer: IpcRenderer, channel = defaultGameAiIpcChannel): RendererGameAIApi {
  return {
    health: async () => await ipcRenderer.invoke(`${channel}:health`) as ProviderHealth,
    warmup: async () => await ipcRenderer.invoke(`${channel}:warmup`) as ProviderHealth,
    dialogue: async (payload) => await ipcRenderer.invoke(`${channel}:dialogue`, payload) as DialogueTurn,
    bark: async (payload) => await ipcRenderer.invoke(`${channel}:bark`, payload) as BarkTurn,
    overhear: async (payload) => await ipcRenderer.invoke(`${channel}:overhear`, payload) as OverheardExchange
  };
}

export function exposeGameAIBridge(contextBridge: ContextBridge, ipcRenderer: IpcRenderer, key = 'gameAI', channel = defaultGameAiIpcChannel): void {
  contextBridge.exposeInMainWorld(key, createGameAIPreloadApi(ipcRenderer, channel));
}
