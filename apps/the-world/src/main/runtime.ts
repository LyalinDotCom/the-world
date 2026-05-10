import type { IpcMain } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createGameAI } from '@game-llm/core';
import { registerGameAIIpc } from '@game-llm/electron';
import { litertLmProvider } from '@game-llm/litert-lm';
import { ollamaProvider } from '@game-llm/ollama';
import { omlxProvider } from '@game-llm/omlx';

export type RuntimeStack = 'ollama-gemma4-e4b' | 'litert-lm-gemma4-e4b' | 'omlx-gemma4-e4b-mlx-8bit';

export interface CreateRuntimeOptions {
  stack?: RuntimeStack;
}

export function createRuntime(ipcMain: IpcMain, reportError: (kind: string, error: unknown) => void, options: CreateRuntimeOptions = {}): () => void {
  const stack = options.stack ?? parseRuntimeStack(process.env.THE_WORLD_AI_STACK) ?? 'ollama-gemma4-e4b';
  const provider = stack === 'litert-lm-gemma4-e4b'
    ? createLiteRtProvider()
    : stack === 'omlx-gemma4-e4b-mlx-8bit'
      ? createOmlxProvider()
      : createOllamaProvider();
  const ai = createGameAI({
    provider,
    world: {
      id: 'the-world',
      name: 'The World',
      allowedInvention: 'minor-flavor',
      styleGuide: 'low-fantasy frontier, short practical speech, strange but grounded wilderness, no modern slang',
      lore: [
        'Paths in The World are older than the settlements and sometimes bend around hills that were not there yesterday.',
        'Travelers trust smoke, bells, and carved waystones more than maps.',
        'The old mill west of the road is avoided because its wheel turns on windless nights.',
        'The Abandoned Castle above Cindervale has no lord, but its watchfires appear in storms.',
        'The Sunken Chapel bell can be heard under wet ground, though the chapel doors are half buried.',
        'Black Bell Tower has no rope and no bell ringer, but travelers count its tolls before choosing a road.',
        'Everyone knows these landmarks by rumor, but nobody knows the true cause behind them.',
        'NPCs know local rumors but should not reveal hidden causes or quest twists before the player earns trust.'
      ]
    },
    runtime: {
      mode: provider.id === 'ollama' || provider.id === 'litert-lm' || provider.id === 'omlx' ? 'local-first' : 'mock',
      quality: 'balanced',
      cache: 'session',
      maxLatencyMs: 24_000,
      debug: true,
      pregeneration: {
        enabled: true,
        cacheOnlyRuntimeRecipes: ['npc.bark', 'npc.overhear'],
        maxConcurrency: 1
      }
    },
    policies: {
      canonOnly: true,
      allowMinorFlavorInvention: true,
      noQuestMutationWithoutTool: true,
      noRewardCreation: true,
      contentRating: 'T'
    }
  });

  void ai.provider.warmup?.({
    prompt: 'Warm up for The World. Prepare for short schema-bound NPC dialogue and ambient barks.',
    timeoutMs: 45_000
  }).then((health) => {
    console.log(`The World: ${stack} warmup ${health.ok ? 'ready' : 'degraded'} (${health.provider}${health.model ? ` ${health.model}` : ''})`);
  }).catch((error) => {
    reportError('warmup failed', error);
  });

  const unregisterIpc = registerGameAIIpc(ipcMain, ai);
  return () => {
    unregisterIpc();
    closeProvider(provider);
  };
}

function createOllamaProvider() {
  return ollamaProvider({
    model: process.env.THE_WORLD_MODEL ?? 'gemma4:e4b',
    quality: 'balanced',
    keepAlive: process.env.THE_WORLD_KEEP_ALIVE ?? '30m',
    temperature: Number(process.env.THE_WORLD_TEMPERATURE ?? 0.55),
    topP: Number(process.env.THE_WORLD_TOP_P ?? 0.9),
    think: parseThink(process.env.THE_WORLD_THINK),
    timeoutMs: Number(process.env.THE_WORLD_TIMEOUT_MS ?? 24_000),
    runtimeOptions: {
      numCtx: Number(process.env.THE_WORLD_NUM_CTX ?? 4096),
      numBatch: Number(process.env.THE_WORLD_NUM_BATCH ?? 128),
      numGpu: optionalNumber(process.env.THE_WORLD_NUM_GPU),
      numThread: optionalNumber(process.env.THE_WORLD_NUM_THREAD)
    }
  });
}

function createLiteRtProvider() {
  return litertLmProvider({
    command: process.env.THE_WORLD_LITERT_LM_BIN ?? findLiteRtLmCommand(),
    model: process.env.THE_WORLD_LITERT_MODEL ?? 'gemma4-e4b-litert',
    backend: process.env.THE_WORLD_LITERT_BACKEND === 'cpu' ? 'cpu' : 'gpu',
    maxNumTokens: Number(process.env.THE_WORLD_LITERT_MAX_TOKENS ?? 4096),
    temperature: Number(process.env.THE_WORLD_TEMPERATURE ?? 0.55),
    topP: Number(process.env.THE_WORLD_TOP_P ?? 0.9),
    seed: optionalNumber(process.env.THE_WORLD_LITERT_SEED),
    timeoutMs: Number(process.env.THE_WORLD_TIMEOUT_MS ?? 30_000)
  });
}

function createOmlxProvider() {
  return omlxProvider({
    baseUrl: process.env.THE_WORLD_OMLX_BASE_URL ?? 'http://127.0.0.1:8000/v1',
    apiKey: process.env.THE_WORLD_OMLX_API_KEY ?? '1234',
    model: process.env.THE_WORLD_OMLX_MODEL ?? 'gemma-4-E4B-it-MLX-8bit',
    temperature: Number(process.env.THE_WORLD_TEMPERATURE ?? 0.55),
    topP: Number(process.env.THE_WORLD_TOP_P ?? 0.9),
    timeoutMs: Number(process.env.THE_WORLD_TIMEOUT_MS ?? 30_000),
    structuredOutput: parseOmlxStructuredOutput(process.env.THE_WORLD_OMLX_STRUCTURED_OUTPUT)
  });
}

function findLiteRtLmCommand(): string {
  const candidates = [
    path.resolve(process.cwd(), '.venv/litert-lm/bin/litert-lm'),
    path.resolve(process.cwd(), '../../.venv/litert-lm/bin/litert-lm')
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

function optionalNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function parseThink(value: string | undefined): boolean | 'low' | 'medium' | 'high' {
  if (value === 'true') return true;
  if (value === 'low' || value === 'medium' || value === 'high') return value;
  return false;
}

export function parseRuntimeStack(value: string | undefined): RuntimeStack | undefined {
  if (value === 'ollama' || value === 'ollama-gemma4-e4b') return 'ollama-gemma4-e4b';
  if (value === 'litert' || value === 'litert-lm' || value === 'litert-lm-gemma4-e4b') return 'litert-lm-gemma4-e4b';
  if (value === 'omlx' || value === 'omlx-gemma4-e4b' || value === 'omlx-gemma4-e4b-mlx-8bit') return 'omlx-gemma4-e4b-mlx-8bit';
  return undefined;
}

function parseOmlxStructuredOutput(value: string | undefined): 'json_schema' | 'json_object' | 'none' | undefined {
  if (value === 'json_schema' || value === 'json_object' || value === 'none') return value;
  return undefined;
}

function closeProvider(provider: unknown): void {
  if (typeof provider === 'object' && provider !== null && 'close' in provider && typeof provider.close === 'function') {
    provider.close();
  }
}
