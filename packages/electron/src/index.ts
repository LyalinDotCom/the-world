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
      const typed = validateDialoguePayload(payload);
      return await ai.npc(typed.npc).respond(typed.request, typed.options);
    },
    bark: async (payload) => {
      const typed = validateBarkPayload(payload);
      return await ai.npc(typed.npc).bark(typed.request, typed.options);
    },
    overhear: async (payload) => {
      const typed = validateOverhearPayload(payload);
      return await ai.npc(typed.npc).overhear(typed.request, typed.options);
    },
    preGenerate: async (payload) => {
      const typed = validatePreGeneratePayload(payload);
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

function validateDialoguePayload(payload: unknown): GameAIDialoguePayload {
  const value = requireObject(payload, 'dialogue payload');
  validateNpcDefinition(value.npc, 'dialogue payload.npc');
  validateDialogueRequest(value.request, 'dialogue payload.request');
  validateGenerationOptions(value.options, 'dialogue payload.options');
  return value as unknown as GameAIDialoguePayload;
}

function validateBarkPayload(payload: unknown): GameAIBarkPayload {
  const value = requireObject(payload, 'bark payload');
  validateNpcDefinition(value.npc, 'bark payload.npc');
  validateSceneRequest(value.request, 'bark payload.request');
  validateGenerationOptions(value.options, 'bark payload.options');
  return value as unknown as GameAIBarkPayload;
}

function validateOverhearPayload(payload: unknown): GameAIOverhearPayload {
  const value = requireObject(payload, 'overhear payload');
  validateNpcDefinition(value.npc, 'overhear payload.npc');
  const request = requireObject(value.request, 'overhear payload.request');
  validateNpcDefinition(request.otherNpc, 'overhear payload.request.otherNpc');
  validateSceneRequest(request, 'overhear payload.request');
  if (request.topic !== undefined) requireString(request.topic, 'overhear payload.request.topic');
  validateGenerationOptions(value.options, 'overhear payload.options');
  return value as unknown as GameAIOverhearPayload;
}

function validatePreGeneratePayload(payload: unknown): GameAIPreGeneratePayload {
  const value = requireObject(payload, 'preGenerate payload');
  if (!Array.isArray(value.jobs)) {
    throw new TypeError('preGenerate payload.jobs must be an array.');
  }
  if (value.jobs.length > 80) {
    throw new TypeError('preGenerate payload.jobs must contain 80 jobs or fewer.');
  }
  for (const [index, jobValue] of value.jobs.entries()) {
    const job = requireObject(jobValue, `preGenerate payload.jobs[${index}]`);
    if (job.type === 'dialogue') validateDialoguePayload(job);
    else if (job.type === 'bark') validateBarkPayload(job);
    else if (job.type === 'overhear') validateOverhearPayload(job);
    else throw new TypeError(`preGenerate payload.jobs[${index}].type must be dialogue, bark, or overhear.`);
  }
  const maxConcurrency = value.maxConcurrency;
  if (maxConcurrency !== undefined && (typeof maxConcurrency !== 'number' || !Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 3)) {
    throw new TypeError('preGenerate payload.maxConcurrency must be an integer from 1 to 3.');
  }
  return value as unknown as GameAIPreGeneratePayload;
}

function validateNpcDefinition(value: unknown, label: string): void {
  const npc = requireObject(value, label);
  requireString(npc.id, `${label}.id`);
  const persona = requireObject(npc.persona, `${label}.persona`);
  requireString(persona.name, `${label}.persona.name`);
  requireString(persona.role, `${label}.persona.role`);
  validateStringArray(persona.traits, `${label}.persona.traits`);
  validateStringArray(persona.goals, `${label}.persona.goals`);
  validateStringArray(persona.secrets, `${label}.persona.secrets`);
  validateStringArray(persona.knows, `${label}.persona.knows`);
  validateStringArray(persona.doesNotKnow, `${label}.persona.doesNotKnow`);
  validateStringArray(persona.rules, `${label}.persona.rules`);
}

function validateDialogueRequest(value: unknown, label: string): void {
  const request = validateSceneRequest(value, label);
  const playerText = requireString(request.playerText, `${label}.playerText`);
  if (playerText.length > 1_000) {
    throw new TypeError(`${label}.playerText must be 1,000 characters or fewer.`);
  }
  if (request.recentDialogue !== undefined) {
    if (!Array.isArray(request.recentDialogue)) {
      throw new TypeError(`${label}.recentDialogue must be an array.`);
    }
    if (request.recentDialogue.length > 24) {
      throw new TypeError(`${label}.recentDialogue must contain 24 entries or fewer.`);
    }
    for (const [index, lineValue] of request.recentDialogue.entries()) {
      const line = requireObject(lineValue, `${label}.recentDialogue[${index}]`);
      requireString(line.speaker, `${label}.recentDialogue[${index}].speaker`);
      requireString(line.text, `${label}.recentDialogue[${index}].text`);
    }
  }
}

function validateSceneRequest(value: unknown, label: string): Record<string, unknown> {
  const request = requireObject(value, label);
  const scene = requireObject(request.scene, `${label}.scene`);
  requireString(scene.location, `${label}.scene.location`);
  validateStringArray(scene.nearbyCharacters, `${label}.scene.nearbyCharacters`);
  validateStringArray(scene.visibleLandmarks, `${label}.scene.visibleLandmarks`);
  return request;
}

function validateGenerationOptions(value: unknown, label: string): void {
  if (value === undefined) return;
  const options = requireObject(value, label);
  const timeoutMs = options.timeoutMs;
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)) {
    throw new TypeError(`${label}.timeoutMs must be between 1 and 120000.`);
  }
  if (options.cacheKey !== undefined) requireString(options.cacheKey, `${label}.cacheKey`);
  for (const key of ['cacheOnly', 'refresh', 'writeMemory', 'assess']) {
    if (options[key] !== undefined && typeof options[key] !== 'boolean') {
      throw new TypeError(`${label}.${key} must be a boolean.`);
    }
  }
}

function validateStringArray(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array.`);
  }
  for (const [index, item] of value.entries()) {
    requireString(item, `${label}[${index}]`);
  }
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}
