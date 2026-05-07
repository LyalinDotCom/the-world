import { describe, expect, it } from 'vitest';
import type { IpcMain } from 'electron';
import { createGameAI, MockGameAIProvider } from '@game-llm/core';
import { registerGameAIIpc } from '../src/index.js';

function createFakeIpcMain() {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const ipcMain = {
    handle(channel: string, listener: (...args: unknown[]) => Promise<unknown>) {
      handlers.set(channel, listener);
    },
    removeHandler(channel: string) {
      handlers.delete(channel);
    }
  } as unknown as IpcMain;
  return { ipcMain, handlers };
}

describe('GameAI Electron IPC bridge', () => {
  it('rejects malformed dialogue payloads before reaching the runtime', async () => {
    const ai = createGameAI({
      provider: new MockGameAIProvider(),
      world: { id: 'test-world' },
      runtime: { mode: 'mock', cache: 'none' }
    });
    const { ipcMain, handlers } = createFakeIpcMain();
    registerGameAIIpc(ipcMain, ai);

    const handler = handlers.get('game-ai:dialogue');
    expect(handler).toBeDefined();
    await expect(handler!({}, {
      npc: { id: 'npc.bad' },
      request: {
        playerText: 'Hello.',
        scene: { location: 'Road' }
      }
    })).rejects.toThrow('dialogue payload.npc.persona must be an object');
  });

  it('accepts valid dialogue payloads', async () => {
    const ai = createGameAI({
      provider: new MockGameAIProvider(),
      world: { id: 'test-world' },
      runtime: { mode: 'mock', cache: 'none' }
    });
    const { ipcMain, handlers } = createFakeIpcMain();
    registerGameAIIpc(ipcMain, ai);

    const result = await handlers.get('game-ai:dialogue')!({}, {
      npc: {
        id: 'npc.guard.elda',
        persona: { name: 'Elda', role: 'guard' }
      },
      request: {
        playerText: 'Hello.',
        scene: { location: 'Road' }
      }
    });

    expect(result).toMatchObject({
      emotion: expect.any(String),
      text: expect.any(String)
    });
  });

  it('caps pregeneration jobs at the bridge boundary', async () => {
    const ai = createGameAI({
      provider: new MockGameAIProvider(),
      world: { id: 'test-world' },
      runtime: { mode: 'mock', cache: 'none' }
    });
    const { ipcMain, handlers } = createFakeIpcMain();
    registerGameAIIpc(ipcMain, ai);

    await expect(handlers.get('game-ai:preGenerate')!({}, {
      jobs: Array.from({ length: 81 }, () => ({
        type: 'bark',
        npc: {
          id: 'npc.guard.elda',
          persona: { name: 'Elda', role: 'guard' }
        },
        request: {
          scene: { location: 'Road' }
        }
      }))
    })).rejects.toThrow('preGenerate payload.jobs must contain 80 jobs or fewer');
  });
});
