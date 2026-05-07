import type { ContextBridge, IpcMain, IpcRenderer } from 'electron';
import {
  BarkRequestSchema,
  DialogueRequestSchema,
  NpcDefinitionSchema,
  NpcGenerationOptionsSchema,
  OverhearRequestSchema,
  z,
  type BarkRequest,
  type BarkTurn,
  type DialogueRequest,
  type DialogueTurn,
  type GameAI,
  type NpcDefinition,
  type NpcGenerationOptions,
  type OverheardExchange,
  type OverhearRequest,
  type ProviderHealth
} from '@game-llm/core';

export const defaultGameAiIpcChannel = 'game-ai';

export interface GameAIIpcHandlers {
  health(): Promise<ProviderHealth>;
  warmup(): Promise<ProviderHealth>;
  dialogue(payload: GameAIDialoguePayload): Promise<DialogueTurn>;
  bark(payload: GameAIBarkPayload): Promise<BarkTurn>;
  overhear(payload: GameAIOverhearPayload): Promise<OverheardExchange>;
  cancel(payload: GameAICancelPayload): Promise<GameAICancelResult>;
  preGenerate(payload: GameAIPreGeneratePayload): Promise<GameAIPreGenerateResult>;
}

export interface GameAIDialoguePayload {
  requestId?: string;
  npc: NpcDefinition;
  request: DialogueRequest;
  options?: NpcGenerationOptions;
}

export interface GameAIBarkPayload {
  requestId?: string;
  npc: NpcDefinition;
  request: BarkRequest;
  options?: NpcGenerationOptions;
}

export interface GameAIOverhearPayload {
  requestId?: string;
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

export interface GameAICancelPayload {
  requestId: string;
}

export interface GameAICancelResult {
  canceled: boolean;
}

export interface RegisterGameAIIpcOptions {
  channel?: string;
}

export interface RendererGameAIApi extends GameAIIpcHandlers {}

const GameAIDialoguePayloadSchema = z.object({
  requestId: z.string().min(1).max(160).optional(),
  npc: NpcDefinitionSchema,
  request: DialogueRequestSchema,
  options: NpcGenerationOptionsSchema.optional()
});

const GameAIBarkPayloadSchema = z.object({
  requestId: z.string().min(1).max(160).optional(),
  npc: NpcDefinitionSchema,
  request: BarkRequestSchema,
  options: NpcGenerationOptionsSchema.optional()
});

const GameAIOverhearPayloadSchema = z.object({
  requestId: z.string().min(1).max(160).optional(),
  npc: NpcDefinitionSchema,
  request: OverhearRequestSchema,
  options: NpcGenerationOptionsSchema.optional()
});

const GameAIPreGenerateJobSchema = z.discriminatedUnion('type', [
  GameAIDialoguePayloadSchema.extend({ type: z.literal('dialogue') }),
  GameAIBarkPayloadSchema.extend({ type: z.literal('bark') }),
  GameAIOverhearPayloadSchema.extend({ type: z.literal('overhear') })
]);

const GameAIPreGeneratePayloadSchema = z.object({
  jobs: z.array(GameAIPreGenerateJobSchema).max(80),
  maxConcurrency: z.number().int().min(1).max(3).optional()
});

const GameAICancelPayloadSchema = z.object({
  requestId: z.string().min(1).max(160)
});

export function registerGameAIIpc(ipcMain: IpcMain, ai: GameAI, options: RegisterGameAIIpcOptions = {}): () => void {
  const channel = options.channel ?? defaultGameAiIpcChannel;
  const requestControllers = new Map<string, AbortController>();
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
      const typed = parsePayload(GameAIDialoguePayloadSchema, payload, 'dialogue payload');
      return await runCancelable(requestControllers, typed, (options) => ai.npc(typed.npc).respond(typed.request, options));
    },
    bark: async (payload) => {
      const typed = parsePayload(GameAIBarkPayloadSchema, payload, 'bark payload');
      return await runCancelable(requestControllers, typed, (options) => ai.npc(typed.npc).bark(typed.request, options));
    },
    overhear: async (payload) => {
      const typed = parsePayload(GameAIOverhearPayloadSchema, payload, 'overhear payload');
      return await runCancelable(requestControllers, typed, (options) => ai.npc(typed.npc).overhear(typed.request, options));
    },
    cancel: async (payload) => {
      const typed = parsePayload(GameAICancelPayloadSchema, payload, 'cancel payload');
      const controller = requestControllers.get(typed.requestId);
      if (!controller) {
        return { canceled: false };
      }
      controller.abort();
      requestControllers.delete(typed.requestId);
      return { canceled: true };
    },
    preGenerate: async (payload) => {
      const typed = parsePayload(GameAIPreGeneratePayloadSchema, payload, 'preGenerate payload');
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
    for (const controller of requestControllers.values()) {
      controller.abort();
    }
    requestControllers.clear();
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
    cancel: async (payload) => await ipcRenderer.invoke(`${channel}:cancel`, payload) as GameAICancelResult,
    preGenerate: async (payload) => await ipcRenderer.invoke(`${channel}:preGenerate`, payload) as GameAIPreGenerateResult
  };
}

export function exposeGameAIBridge(contextBridge: ContextBridge, ipcRenderer: IpcRenderer, key = 'gameAI', channel = defaultGameAiIpcChannel): void {
  contextBridge.exposeInMainWorld(key, createGameAIPreloadApi(ipcRenderer, channel));
}

function parsePayload<T>(schema: z.ZodType<T>, payload: unknown, label: string): T {
  const result = schema.safeParse(payload);
  if (result.success) return result.data;
  const details = result.error.issues.map((issue) => {
    const path = issue.path.length ? issue.path.join('.') : 'payload';
    return `${path}: ${issue.message}`;
  }).join('; ');
  throw new TypeError(`Invalid ${label}: ${details}`);
}

async function runCancelable<T>(
  requestControllers: Map<string, AbortController>,
  payload: { requestId?: string; options?: NpcGenerationOptions },
  run: (options: NpcGenerationOptions | undefined) => Promise<T>
): Promise<T> {
  const requestId = payload.requestId;
  if (!requestId) {
    return await run(payload.options);
  }

  requestControllers.get(requestId)?.abort();
  const controller = new AbortController();
  requestControllers.set(requestId, controller);
  try {
    return await run({
      ...payload.options,
      signal: controller.signal
    });
  } finally {
    if (requestControllers.get(requestId) === controller) {
      requestControllers.delete(requestId);
    }
  }
}
