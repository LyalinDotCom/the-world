import { describe, expect, it } from 'vitest';
import { cleanLiteRtLmOutput, defaultBridgeScript, litertLmProvider, promptForRequest } from '../src/index.js';

describe('litertLmProvider', () => {
  it('runs the LiteRT-LM CLI with GPU backend and schema prompt', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const provider = litertLmProvider({
      command: '/bin/litert-lm',
      model: 'gemma4-e4b-litert',
      backend: 'gpu',
      maxNumTokens: 4096,
      seed: 7,
      runCommand: async (command, args) => {
        calls.push({ command, args });
        return { stdout: '```json\n{"text":"ready"}\n```', stderr: '' };
      }
    });

    const result = await provider.generate({
      messages: [{ role: 'user', content: 'hi' }],
      schema: { type: 'object' },
      temperature: 0.2,
      maxTokens: 20
    });

    expect(result.text).toBe('{"text":"ready"}');
    expect(calls[0]).toMatchObject({
      command: '/bin/litert-lm',
      args: expect.arrayContaining([
        'run',
        'gemma4-e4b-litert',
        '--backend',
        'gpu',
        '--max-num-tokens',
        '4096',
        '--temperature',
        '0.2',
        '--seed',
        '7'
      ])
    });
    expect(calls[0]?.args.at(-1)).toContain('Return only one JSON object.');
  });

  it('reports imported model health from litert-lm list', async () => {
    const provider = litertLmProvider({
      command: '/bin/litert-lm',
      model: 'gemma4-e4b-litert',
      runCommand: async (_command, args) => {
        expect(args).toEqual(['list']);
        return {
          stdout: [
            'Listing models in: /Users/example/.litert-lm/models',
            'ID                          SIZE            MODIFIED',
            'gemma4-e4b-litert           3.66 GB         today'
          ].join('\n'),
          stderr: ''
        };
      }
    });

    await expect(provider.health?.()).resolves.toMatchObject({
      ok: true,
      provider: 'litert-lm',
      model: 'gemma4-e4b-litert',
      mode: 'ready'
    });
  });

  it('ignores app-specific THE_WORLD env in reusable provider defaults', async () => {
    const previousModel = process.env.THE_WORLD_LITERT_MODEL;
    const previousBackend = process.env.THE_WORLD_LITERT_BACKEND;
    process.env.THE_WORLD_LITERT_MODEL = 'demo-only-model';
    process.env.THE_WORLD_LITERT_BACKEND = 'cpu';
    const calls: Array<{ command: string; args: string[] }> = [];
    try {
      const provider = litertLmProvider({
        command: '/bin/litert-lm',
        runCommand: async (command, args) => {
          calls.push({ command, args });
          return { stdout: '{"text":"ready"}', stderr: '' };
        }
      });

      await provider.generate({ messages: [{ role: 'user', content: 'hi' }] });

      expect(calls[0]?.args).toEqual(expect.arrayContaining([
        'gemma4-e4b-litert',
        '--backend',
        'gpu'
      ]));
    } finally {
      if (previousModel === undefined) delete process.env.THE_WORLD_LITERT_MODEL;
      else process.env.THE_WORLD_LITERT_MODEL = previousModel;
      if (previousBackend === undefined) delete process.env.THE_WORLD_LITERT_BACKEND;
      else process.env.THE_WORLD_LITERT_BACKEND = previousBackend;
    }
  });
});

describe('LiteRT-LM prompt helpers', () => {
  it('formats chat messages into one CLI prompt', () => {
    expect(promptForRequest({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hello' }
      ]
    })).toContain('SYSTEM\nsys\n\nUSER\nhello');
  });

  it('strips JSON markdown fences', () => {
    expect(cleanLiteRtLmOutput('```json\n{"ok":true}\n```')).toBe('{"ok":true}');
  });

  it('resolves the bundled bridge script next to the built package', () => {
    expect(defaultBridgeScript()).toContain('bridge/litert_bridge.py');
  });
});
