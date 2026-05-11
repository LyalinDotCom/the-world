import { describe, expect, it } from 'vitest';
import { listOmlxModels, omlxProvider } from '../src/index.js';

describe('omlxProvider', () => {
  it('uses AI SDK OpenAI-compatible chat requests with schema guidance', async () => {
    const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const provider = omlxProvider({
      baseUrl: 'http://omlx.local/v1/',
      apiKey: '1234',
      model: 'gemma-4-E4B-it-MLX-8bit',
      fetchImpl: (async (url, init) => {
        calls.push({
          url: String(url),
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>
        });
        return new Response(JSON.stringify({
          model: 'gemma-4-E4B-it-MLX-8bit',
          choices: [
            { message: { role: 'assistant', content: '{"text":"hello"}' } }
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 3,
            total_tokens: 13
          }
        }));
      }) as typeof fetch
    });

    const result = await provider.generate({
      messages: [{ role: 'user', content: 'hi' }],
      schema: { type: 'object' },
      maxTokens: 20
    });

    expect(calls[0]?.url).toBe('http://omlx.local/v1/chat/completions');
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer 1234');
    expect(calls[0]?.body).toMatchObject({
      model: 'gemma-4-E4B-it-MLX-8bit',
      max_tokens: 20
    });
    expect(JSON.stringify(calls[0]?.body.messages)).toContain('The JSON object must match this schema');
    expect(result.metrics?.totalTokens).toBe(13);
  });

  it('can disable additional schema guidance for compatibility', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const provider = omlxProvider({
      baseUrl: 'http://omlx.local/v1',
      structuredOutput: 'none',
      fetchImpl: (async (_url, init) => {
        calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({
          choices: [
            { message: { content: '{"ok":true}' } }
          ]
        }));
      }) as typeof fetch
    });

    await provider.generate({
      messages: [{ role: 'user', content: 'hi' }],
      schema: { type: 'object' }
    });

    expect(JSON.stringify(calls[0]?.messages)).not.toContain('The JSON object must match this schema');
  });

  it('ignores app-specific THE_WORLD env in reusable provider defaults', async () => {
    const previousModel = process.env.THE_WORLD_OMLX_MODEL;
    const previousBaseUrl = process.env.THE_WORLD_OMLX_BASE_URL;
    process.env.THE_WORLD_OMLX_MODEL = 'demo-only-model';
    process.env.THE_WORLD_OMLX_BASE_URL = 'http://demo-only.local/v1';
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    try {
      const provider = omlxProvider({
        baseUrl: 'http://omlx.local/v1',
        fetchImpl: (async (url, init) => {
          calls.push({
            url: String(url),
            body: JSON.parse(String(init?.body)) as Record<string, unknown>
          });
          return new Response(JSON.stringify({
            choices: [
              { message: { content: '{"ok":true}' } }
            ]
          }));
        }) as typeof fetch
      });

      await provider.generate({ messages: [{ role: 'user', content: 'hi' }] });

      expect(calls[0]?.url).toBe('http://omlx.local/v1/chat/completions');
      expect(calls[0]?.body.model).toBe('gemma-4-E4B-it-MLX-8bit');
    } finally {
      if (previousModel === undefined) delete process.env.THE_WORLD_OMLX_MODEL;
      else process.env.THE_WORLD_OMLX_MODEL = previousModel;
      if (previousBaseUrl === undefined) delete process.env.THE_WORLD_OMLX_BASE_URL;
      else process.env.THE_WORLD_OMLX_BASE_URL = previousBaseUrl;
    }
  });
});

describe('listOmlxModels', () => {
  it('normalizes OpenAI model responses', async () => {
    const models = await listOmlxModels({
      baseUrl: 'http://omlx.local/v1',
      apiKey: '1234',
      fetchImpl: (async () => new Response(JSON.stringify({
        data: [
          { id: 'z-model', object: 'model', owned_by: 'local' },
          { id: 'a-model', object: 'model', owned_by: 'local' }
        ]
      }))) as typeof fetch
    });

    expect(models.map((model) => model.id)).toEqual(['a-model', 'z-model']);
  });
});
