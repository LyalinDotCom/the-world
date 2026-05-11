import type { ChatMessage, GameAIProvider, GenerateRequest, GenerateResult, JsonSchema, ProviderHealth } from '@game-llm/core';

export interface OllamaProviderOptions {
  host?: string;
  model?: string;
  quality?: 'fast' | 'balanced' | 'best';
  keepAlive?: string;
  temperature?: number;
  topP?: number;
  timeoutMs?: number;
  think?: boolean | 'low' | 'medium' | 'high';
  runtimeOptions?: OllamaRuntimeOptions;
  fetchImpl?: typeof fetch;
}

export interface OllamaRuntimeOptions {
  numCtx?: number;
  numBatch?: number;
  numGpu?: number;
  numThread?: number;
  seed?: number;
  repeatPenalty?: number;
}

export interface OllamaModelInfo {
  name: string;
  model?: string;
  modifiedAt?: string;
  sizeBytes?: number;
  digest?: string;
  details?: Record<string, unknown>;
}

interface OllamaTagsResponse {
  models?: Array<{
    name?: string;
    model?: string;
    modified_at?: string;
    size?: number;
    digest?: string;
    details?: Record<string, unknown>;
  }>;
}

interface OllamaChatResponse {
  model?: string;
  message?: {
    role?: string;
    content?: string;
  };
  response?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

const defaultHost = 'http://127.0.0.1:11434';
const defaultModel = 'gemma4:e4b';
const qualityDefaults = {
  fast: 'gemma4:e2b',
  balanced: 'gemma4:e4b',
  best: 'gemma4:26b'
} as const;

export function ollamaProvider(options: OllamaProviderOptions = {}): GameAIProvider {
  return new OllamaGameAIProvider(options);
}

export class OllamaGameAIProvider implements GameAIProvider {
  readonly id = 'ollama';
  readonly model: string;
  private readonly host: string;
  private readonly keepAlive: string;
  private readonly temperature: number;
  private readonly topP: number;
  private readonly timeoutMs: number;
  private readonly think: boolean | 'low' | 'medium' | 'high';
  private readonly runtimeOptions: OllamaRuntimeOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OllamaProviderOptions = {}) {
    this.host = normalizeHost(options.host ?? process.env.OLLAMA_HOST ?? defaultHost);
    this.model = options.model ?? process.env.GAME_LLM_MODEL ?? qualityDefaults[options.quality ?? 'balanced'] ?? defaultModel;
    this.keepAlive = options.keepAlive ?? '10m';
    this.temperature = options.temperature ?? 0.75;
    this.topP = options.topP ?? 0.9;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.think = options.think ?? false;
    this.runtimeOptions = options.runtimeOptions ?? {};
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async health(): Promise<ProviderHealth> {
    try {
      const models = await listOllamaModels({ host: this.host, fetchImpl: this.fetchImpl, timeoutMs: 4_000 });
      const names = models.map((model) => model.name);
      const selected = names.includes(this.model);
      return {
        ok: selected,
        provider: this.id,
        model: this.model,
        mode: selected ? 'ready' : 'degraded',
        message: selected
          ? `Ollama model ${this.model} is available.`
          : `Ollama is running, but ${this.model} is not installed.`,
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
      const response = await fetchWithTimeout(this.fetchImpl, `${this.host}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: 'user',
              content: options.prompt ?? 'Warm up for short in-game NPC dialogue. Reply with exactly: ready'
            }
          ],
          stream: false,
          think: this.think,
          keep_alive: this.keepAlive,
          options: {
            ...toOllamaRuntimeOptions(this.runtimeOptions),
            temperature: 0,
            num_predict: 8
          }
        })
      }, options.timeoutMs ?? Math.max(this.timeoutMs, 30_000));
      if (!response.ok) {
        return {
          ...health,
          ok: false,
          mode: 'degraded',
          message: `Ollama warmup failed with ${response.status}: ${await response.text()}`
        };
      }
      await response.json();
      return {
        ...health,
        ok: true,
        mode: 'ready',
        message: `Ollama model ${this.model} is warm.`
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
    const response = await fetchWithTimeout(this.fetchImpl, `${this.host}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: toOllamaMessages(request.messages),
        stream: false,
        think: this.think,
        format: request.schema,
        keep_alive: this.keepAlive,
        options: {
          ...toOllamaRuntimeOptions(this.runtimeOptions),
          temperature: request.temperature ?? this.temperature,
          top_p: this.topP,
          num_predict: request.maxTokens
        }
      }),
      signal: request.signal
    }, request.timeoutMs ?? this.timeoutMs);

    if (!response.ok) {
      throw new Error(`Ollama chat failed with ${response.status}: ${await response.text()}`);
    }

    const body = await response.json() as OllamaChatResponse;
    const text = body.message?.content ?? body.response ?? '';
    if (!text.trim()) {
      throw new Error('Ollama returned an empty chat response.');
    }

    return {
      text,
      model: body.model ?? this.model,
      raw: body,
      metrics: {
        latencyMs: Date.now() - startedAt,
        promptTokens: body.prompt_eval_count,
        outputTokens: body.eval_count,
        totalTokens: sumNumbers(body.prompt_eval_count, body.eval_count)
      }
    };
  }
}

export async function listOllamaModels(options: Pick<OllamaProviderOptions, 'host' | 'fetchImpl' | 'timeoutMs'> = {}): Promise<OllamaModelInfo[]> {
  const host = normalizeHost(options.host ?? process.env.OLLAMA_HOST ?? defaultHost);
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchWithTimeout(fetchImpl, `${host}/api/tags`, {
    method: 'GET'
  }, options.timeoutMs ?? 6_000);

  if (!response.ok) {
    throw new Error(`Ollama model list failed with ${response.status}: ${await response.text()}`);
  }

  const body = await response.json() as OllamaTagsResponse;
  return (body.models ?? [])
    .filter((model) => model.name)
    .map((model) => ({
      name: model.name!,
      model: model.model,
      modifiedAt: model.modified_at,
      sizeBytes: model.size,
      digest: model.digest,
      details: model.details
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function chooseInstalledOllamaModel(options: Pick<OllamaProviderOptions, 'host' | 'fetchImpl' | 'timeoutMs'> & {
  quality?: 'fast' | 'balanced' | 'best';
  preferGemma?: boolean;
} = {}): Promise<string | undefined> {
  const models = await listOllamaModels(options);
  if (models.length === 0) {
    return undefined;
  }

  const preferred = qualityDefaults[options.quality ?? 'balanced'];
  if (models.some((model) => model.name === preferred)) {
    return preferred;
  }

  const candidates = options.preferGemma === false ? models : models.filter((model) => /^gemma/i.test(model.name));
  const sorted = (candidates.length ? candidates : models)
    .filter((model) => typeof model.sizeBytes === 'number')
    .sort((a, b) => (a.sizeBytes ?? Number.MAX_SAFE_INTEGER) - (b.sizeBytes ?? Number.MAX_SAFE_INTEGER));
  if (sorted.length >= 2) {
    return sorted[1]!.name;
  }
  return sorted[0]?.name ?? (candidates[0] ?? models[0])?.name;
}

export function structuredJsonInstruction(schema: JsonSchema): string {
  return [
    'Return a single JSON object that matches this schema. No prose outside JSON.',
    JSON.stringify(schema)
  ].join('\n');
}

function normalizeHost(host: string): string {
  return host.replace(/\/+$/, '');
}

function toOllamaRuntimeOptions(options: OllamaRuntimeOptions): Record<string, number> {
  return Object.fromEntries(Object.entries({
    num_ctx: options.numCtx,
    num_batch: options.numBatch,
    num_gpu: options.numGpu,
    num_thread: options.numThread,
    seed: options.seed,
    repeat_penalty: options.repeatPenalty
  }).filter((entry): entry is [string, number] => typeof entry[1] === 'number'));
}

function toOllamaMessages(messages: ChatMessage[]): Array<{ role: string; content: string }> {
  return messages.map((message) => ({
    role: message.role,
    content: message.content
  }));
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
      throw new Error(`Ollama request timed out after ${Math.round(timeoutMs / 1000)}s.`);
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

function sumNumbers(...values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => typeof value === 'number');
  return present.length ? present.reduce((sum, value) => sum + value, 0) : undefined;
}
