import type { IpcMain } from 'electron';
import { createGameAI } from '@game-llm/core';
import { registerGameAIIpc } from '@game-llm/electron';
import { ollamaProvider } from '@game-llm/ollama';

export function createRuntime(ipcMain: IpcMain, reportError: (kind: string, error: unknown) => void): () => void {
  const provider = ollamaProvider({
    quality: 'balanced',
    timeoutMs: Number(process.env.THE_WORLD_TIMEOUT_MS ?? 24_000)
  });
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
      mode: provider.id === 'ollama' ? 'local-first' : 'mock',
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
    console.log(`The World: warmup ${health.ok ? 'ready' : 'degraded'} (${health.provider}${health.model ? ` ${health.model}` : ''})`);
  }).catch((error) => {
    reportError('warmup failed', error);
  });

  return registerGameAIIpc(ipcMain, ai);
}
