import { describe, expect, it } from 'vitest';
import { chooseInstalledOllamaModel, listOllamaModels, ollamaProvider } from '../src/index.js';

describe('ollamaProvider', () => {
  it('posts native Ollama chat requests with JSON schema format', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const provider = ollamaProvider({
      host: 'http://ollama.local',
      model: 'gemma4:e4b',
      fetchImpl: (async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return new Response(JSON.stringify({
          model: 'gemma4:e4b',
          message: { role: 'assistant', content: '{"text":"hello","emotion":"neutral","events":[],"memoryWrites":[],"safetyFlags":[]}' },
          prompt_eval_count: 10,
          eval_count: 8
        }));
      }) as typeof fetch
    });

    const result = await provider.generate({
      messages: [{ role: 'user', content: 'hi' }],
      schema: { type: 'object' }
    });

    expect(calls[0]?.url).toBe('http://ollama.local/api/chat');
    expect(calls[0]?.body).toMatchObject({
      model: 'gemma4:e4b',
      stream: false,
      think: false,
      format: { type: 'object' }
    });
    expect(result.metrics?.totalTokens).toBe(18);
  });

  it('passes configured runtime options through to Ollama', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const provider = ollamaProvider({
      host: 'http://ollama.local',
      model: 'gemma4:e4b',
      think: 'low',
      runtimeOptions: {
        numCtx: 1024,
        numBatch: 64,
        numGpu: 999,
        numThread: 6,
        seed: 7,
        repeatPenalty: 1.05
      },
      fetchImpl: (async (_url, init) => {
        calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({
          model: 'gemma4:e4b',
          message: { role: 'assistant', content: '{"ok":true}' }
        }));
      }) as typeof fetch
    });

    await provider.generate({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 16
    });

    expect(calls[0]?.options).toMatchObject({
      num_ctx: 1024,
      num_batch: 64,
      num_gpu: 999,
      num_thread: 6,
      seed: 7,
      repeat_penalty: 1.05,
      num_predict: 16
    });
    expect(calls[0]?.think).toBe('low');
  });

  it('ignores app-specific THE_WORLD model env in reusable provider defaults', async () => {
    const previous = process.env.THE_WORLD_MODEL;
    process.env.THE_WORLD_MODEL = 'demo-only-model';
    const calls: Array<Record<string, unknown>> = [];
    try {
      const provider = ollamaProvider({
        host: 'http://ollama.local',
        fetchImpl: (async (_url, init) => {
          calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return new Response(JSON.stringify({
            model: 'gemma4:e4b',
            message: { role: 'assistant', content: '{"ok":true}' }
          }));
        }) as typeof fetch
      });

      await provider.generate({ messages: [{ role: 'user', content: 'hi' }] });

      expect(calls[0]?.model).toBe('gemma4:e4b');
    } finally {
      if (previous === undefined) delete process.env.THE_WORLD_MODEL;
      else process.env.THE_WORLD_MODEL = previous;
    }
  });
});

describe('listOllamaModels', () => {
  it('normalizes tag responses', async () => {
    const models = await listOllamaModels({
      host: 'http://ollama.local/',
      fetchImpl: (async () => new Response(JSON.stringify({
        models: [
          { name: 'gemma4:e4b', size: 9 },
          { name: 'gemma4:e2b', size: 7 }
        ]
      }))) as typeof fetch
    });

    expect(models.map((model) => model.name)).toEqual(['gemma4:e2b', 'gemma4:e4b']);
  });

  it('chooses the second-smallest Gemma model for balanced fallback', async () => {
    const model = await chooseInstalledOllamaModel({
      quality: 'balanced',
      fetchImpl: (async () => new Response(JSON.stringify({
        models: [
          { name: 'gemma4:e2b', size: 7 },
          { name: 'gemma4:e4b', size: 9 },
          { name: 'qwen:big', size: 99 }
        ]
      }))) as typeof fetch
    });

    expect(model).toBe('gemma4:e4b');
  });
});
