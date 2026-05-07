import type { ContextBridge, IpcMain, IpcRenderer } from 'electron';
import type { BarkRequest, BarkTurn, DialogueRequest, DialogueTurn, GameAI, NpcDefinition, NpcGenerationOptions, OverheardExchange, OverhearRequest, ProviderHealth } from '@game-llm/core';

export const defaultGameAiIpcChannel = 'game-ai';

export interface GameAIIpcHandlers {
  health(): Promise<ProviderHealth>;
  warmup(): Promise<ProviderHealth>;
  dialogue(payload: GameAIDialoguePayload): Promise<DialogueTurn>;
  bark(payload: GameAIBarkPayload): Promise<BarkTurn>;
  overhear(payload: GameAIOverhearPayload): Promise<OverheardExchange>;
  preGenerate(payload: GameAIPreGeneratePayload): Promise<GameAIPreGenerateResult>;
}

export interface GameAIDialoguePayload {
  npc: NpcDefinition;
  request: DialogueRequest;
  options?: NpcGenerationOptions;
}

export interface GameAIBarkPayload {
  npc: NpcDefinition;
  request: BarkRequest;
  options?: NpcGenerationOptions;
}

export interface GameAIOverhearPayload {
  npc: NpcDefinition;
  request: OverhearRequest;
  options?: NpcGenerationOptions;
}

export type GameAIPreGenerateJob =
  | ({ type: 'dialogue' } & GameAIDialoguePayload)
  | ({ type: 'bark' } & GameAIBarkPayload)
  | ({ type: 'overhear' } & GameAIOverhearPayload);

export interface GameAIPreGeneratePayload {
  jobs: GameAIPreGenerateJob[];
  maxConcurrency?: number;
}

export interface GameAIPreGenerateResult {
  requested: number;
  generated: number;
  failed: number;
  durationMs: number;
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
      return await ai.npc(typed.npc).respond(typed.request, typed.options);
    },
    bark: async (payload) => {
      const typed = payload as GameAIBarkPayload;
      return await ai.npc(typed.npc).bark(typed.request, typed.options);
    },
    overhear: async (payload) => {
      const typed = payload as GameAIOverhearPayload;
      return await ai.npc(typed.npc).overhear(typed.request, typed.options);
    },
    preGenerate: async (payload) => {
      const typed = payload as GameAIPreGeneratePayload;
      const startedAt = Date.now();
      const jobs = typed.jobs.slice();
      const maxConcurrency = Math.max(1, Math.min(3, typed.maxConcurrency ?? 1));
      let generated = 0;
      let failed = 0;
      let cursor = 0;
      const runJob = async (job: GameAIPreGenerateJob) => {
        const options = {
          ...job.options,
          refresh: true,
          cacheOnly: false,
          writeMemory: false
        };
        if (job.type === 'dialogue') {
          return await ai.npc(job.npc).respond(job.request, options);
        }
        if (job.type === 'bark') {
          return await ai.npc(job.npc).bark(job.request, options);
        }
        return await ai.npc(job.npc).overhear(job.request, options);
      };
      const workers = Array.from({ length: maxConcurrency }, async () => {
        while (cursor < jobs.length) {
          const job = jobs[cursor];
          cursor += 1;
          if (!job) continue;
          try {
            const result = await runJob(job);
            if (result.trace?.fallback) {
              failed += 1;
            } else {
              generated += 1;
            }
          } catch {
            failed += 1;
          }
        }
      });
      await Promise.all(workers);
      return {
        requested: jobs.length,
        generated,
        failed,
        durationMs: Date.now() - startedAt
      };
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
    overhear: async (payload) => await ipcRenderer.invoke(`${channel}:overhear`, payload) as OverheardExchange,
    preGenerate: async (payload) => await ipcRenderer.invoke(`${channel}:preGenerate`, payload) as GameAIPreGenerateResult
  };
}

export function exposeGameAIBridge(contextBridge: ContextBridge, ipcRenderer: IpcRenderer, key = 'gameAI', channel = defaultGameAiIpcChannel): void {
  contextBridge.exposeInMainWorld(key, createGameAIPreloadApi(ipcRenderer, channel));
}
