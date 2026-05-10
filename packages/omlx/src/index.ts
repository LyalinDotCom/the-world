import type { ChatMessage, GameAIProvider, GenerateRequest, GenerateResult, JsonSchema, ProviderHealth } from '@game-llm/core';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, jsonSchema, Output, type ModelMessage } from 'ai';

export type OmlxStructuredOutputMode = 'json_schema' | 'json_object' | 'none';

export interface OmlxProviderOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  temperature?: number;
  topP?: number;
  timeoutMs?: number;
  structuredOutput?: OmlxStructuredOutputMode;
  fetchImpl?: typeof fetch;
}

export interface OmlxModelInfo {
  id: string;
  object?: string;
  ownedBy?: string;
}

interface OpenAIModelsResponse {
  data?: Array<{
    id?: string;
    object?: string;
    owned_by?: string;
  }>;
}

const defaultBaseUrl = 'http://127.0.0.1:8000/v1';
const defaultModel = 'gemma-4-E4B-it-MLX-8bit';

export function omlxProvider(options: OmlxProviderOptions = {}): GameAIProvider {
  return new OmlxGameAIProvider(options);
}

export class OmlxGameAIProvider implements GameAIProvider {
  readonly id = 'omlx';
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly temperature: number;
  private readonly topP: number;
  private readonly timeoutMs: number;
  private readonly structuredOutput: OmlxStructuredOutputMode;
  private readonly fetchImpl: typeof fetch;
  private readonly openaiCompatible: ReturnType<typeof createOpenAICompatible>;

  constructor(options: OmlxProviderOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? process.env.THE_WORLD_OMLX_BASE_URL ?? process.env.OMLX_BASE_URL ?? defaultBaseUrl);
    this.apiKey = options.apiKey ?? process.env.THE_WORLD_OMLX_API_KEY ?? process.env.OMLX_API_KEY ?? '1234';
    this.model = options.model ?? process.env.THE_WORLD_OMLX_MODEL ?? process.env.THE_WORLD_MODEL ?? defaultModel;
    this.temperature = options.temperature ?? Number(process.env.THE_WORLD_TEMPERATURE ?? 0.55);
    this.topP = options.topP ?? Number(process.env.THE_WORLD_TOP_P ?? 0.9);
    this.timeoutMs = options.timeoutMs ?? Number(process.env.THE_WORLD_TIMEOUT_MS ?? 30_000);
    this.structuredOutput = options.structuredOutput ?? parseStructuredOutput(process.env.THE_WORLD_OMLX_STRUCTURED_OUTPUT) ?? 'json_schema';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.openaiCompatible = createOpenAICompatible({
      name: 'omlx',
      baseURL: this.baseUrl,
      apiKey: this.apiKey,
      fetch: this.fetchImpl,
      supportsStructuredOutputs: this.structuredOutput === 'json_schema'
    });
  }

  async health(): Promise<ProviderHealth> {
    try {
      const models = await listOmlxModels({
        baseUrl: this.baseUrl,
        apiKey: this.apiKey,
        fetchImpl: this.fetchImpl,
        timeoutMs: 4_000
      });
      const names = models.map((model) => model.id);
      const selected = names.includes(this.model);
      return {
        ok: selected,
        provider: this.id,
        model: this.model,
        mode: selected ? 'ready' : 'degraded',
        message: selected
          ? `oMLX model ${this.model} is available.`
          : `oMLX is running, but ${this.model} was not listed by /models.`,
        models: names
      };
    } catch (error) {
      return {
        ok: false,
        provider: this.id,
        model: this.model,
        mode: 'unavailable',
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async warmup(options: { prompt?: string; timeoutMs?: number } = {}): Promise<ProviderHealth> {
    const health = await this.health();
    if (!health.ok) {
      return health;
    }
    try {
      await this.chat({
        messages: [
          {
            role: 'user',
            content: options.prompt ?? 'Warm up for short schema-bound in-game NPC dialogue. Reply with exactly: ready'
          }
        ],
        temperature: 0,
        maxTokens: 8
      }, options.timeoutMs ?? Math.max(this.timeoutMs, 30_000));
      return {
        ...health,
        ok: true,
        mode: 'ready',
        message: `oMLX model ${this.model} is warm.`
      };
    } catch (error) {
      return {
        ...health,
        ok: false,
        mode: 'degraded',
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const startedAt = Date.now();
    const result = await this.chat(request, request.timeoutMs ?? this.timeoutMs);
    const text = result.text;
    if (!text.trim()) {
      throw new Error('oMLX returned an empty chat response.');
    }
    return {
      text,
      model: result.response.modelId ?? this.model,
      raw: {
        finishReason: result.finishReason,
        warnings: result.warnings,
        response: result.response,
        providerMetadata: result.providerMetadata
      },
      metrics: {
        latencyMs: Date.now() - startedAt,
        promptTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        totalTokens: result.usage.totalTokens
      }
    };
  }

  private async chat(request: Pick<GenerateRequest, 'messages' | 'schema' | 'temperature' | 'maxTokens' | 'signal'>, timeoutMs: number) {
    const output = request.schema && this.structuredOutput !== 'none'
      ? Output.object({ schema: jsonSchema(request.schema) })
      : undefined;
    return await generateText({
      model: this.openaiCompatible.chatModel(this.model),
      messages: toAiSdkMessages(request.messages, request.schema, this.structuredOutput),
      temperature: request.temperature ?? this.temperature,
      topP: this.topP,
      maxOutputTokens: request.maxTokens,
      abortSignal: request.signal,
      timeout: timeoutMs,
      maxRetries: 0,
      allowSystemInMessages: true,
      ...(output ? { output } : {})
    });
  }
}

export async function listOmlxModels(options: Pick<OmlxProviderOptions, 'baseUrl' | 'apiKey' | 'fetchImpl' | 'timeoutMs'> = {}): Promise<OmlxModelInfo[]> {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? process.env.THE_WORLD_OMLX_BASE_URL ?? process.env.OMLX_BASE_URL ?? defaultBaseUrl);
  const apiKey = options.apiKey ?? process.env.THE_WORLD_OMLX_API_KEY ?? process.env.OMLX_API_KEY ?? '1234';
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchWithTimeout(fetchImpl, `${baseUrl}/models`, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${apiKey}`
    }
  }, options.timeoutMs ?? 6_000);
  if (!response.ok) {
    throw new Error(`oMLX model list failed with ${response.status}: ${await response.text()}`);
  }
  const body = await response.json() as OpenAIModelsResponse;
  return (body.data ?? [])
    .filter((model) => model.id)
    .map((model) => ({
      id: model.id!,
      object: model.object,
      ownedBy: model.owned_by
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function toAiSdkMessages(messages: ChatMessage[], schema: JsonSchema | undefined, structuredOutput: OmlxStructuredOutputMode): ModelMessage[] {
  const mapped = messages.map((message) => ({
    role: message.role,
    content: message.content
  })) as ModelMessage[];
  if (!schema || structuredOutput === 'none') return mapped;
  return [
    ...mapped,
    {
      role: 'system',
      content: [
        'Return only a single JSON object. Do not wrap it in Markdown.',
        'The JSON object must match this schema:',
        JSON.stringify(schema)
      ].join('\n')
    }
  ];
}

function parseStructuredOutput(value: string | undefined): OmlxStructuredOutputMode | undefined {
  if (value === 'json_schema' || value === 'json_object' || value === 'none') return value;
  return undefined;
}

async function fetchWithTimeout(fetchImpl: typeof fetch, input: RequestInfo | URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  let didTimeout = false;
  const timeout = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);
  const upstreamSignal = init.signal;
  const abortFromUpstream = () => controller.abort(upstreamSignal?.reason);
  try {
    if (upstreamSignal?.aborted) {
      controller.abort(upstreamSignal.reason);
    } else {
      upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true });
    }
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (didTimeout && isAbortError(error)) {
      throw new Error(`oMLX request timed out after ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    upstreamSignal?.removeEventListener('abort', abortFromUpstream);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
