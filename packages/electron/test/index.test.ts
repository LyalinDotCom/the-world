import { describe, expect, it } from 'vitest';
import type { IpcMain } from 'electron';
import { createGameAI, MockGameAIProvider, type GameAIProvider } from '@game-llm/core';
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
    })).rejects.toThrow(/Invalid dialogue payload: .*npc\.persona/);
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

  it('can cancel an in-flight dialogue request by request id', async () => {
    let receivedSignal: AbortSignal | undefined;
    const provider: GameAIProvider = {
      id: 'slow-provider',
      async generate(request) {
        receivedSignal = request.signal;
        return await new Promise((_, reject) => {
          request.signal?.addEventListener('abort', () => reject(abortError()), { once: true });
        });
      }
    };
    const ai = createGameAI({
      provider,
      world: { id: 'test-world' },
      runtime: { cache: 'none' }
    });
    const { ipcMain, handlers } = createFakeIpcMain();
    registerGameAIIpc(ipcMain, ai);

    const dialogue = handlers.get('game-ai:dialogue')!({}, {
      requestId: 'dialogue-1',
      npc: {
        id: 'npc.guard.elda',
        persona: { name: 'Elda', role: 'guard' }
      },
      request: {
        playerText: 'Hello.',
        scene: { location: 'Road' }
      }
    });

    await expect(handlers.get('game-ai:cancel')!({}, {
      requestId: 'dialogue-1'
    })).resolves.toEqual({ canceled: true });
    await expect(dialogue).rejects.toThrow('Aborted');
    expect(receivedSignal?.aborted).toBe(true);
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
    })).rejects.toThrow(/Invalid preGenerate payload: .*jobs/);
  });
});

function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}
