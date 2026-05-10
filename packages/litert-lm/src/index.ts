import { access } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChatMessage, GameAIProvider, GenerateRequest, GenerateResult, ProviderHealth } from '@game-llm/core';

export type LiteRtLmBackend = 'cpu' | 'gpu';

export interface LiteRtLmProviderOptions {
  command?: string;
  model?: string;
  backend?: LiteRtLmBackend;
  maxNumTokens?: number;
  temperature?: number;
  topP?: number;
  seed?: number;
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  runCommand?: LiteRtLmCommandRunner;
}

export interface LiteRtLmCommandResult {
  stdout: string;
  stderr: string;
}

export type LiteRtLmCommandRunner = (command: string, args: string[], options: {
  timeoutMs: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}) => Promise<LiteRtLmCommandResult>;

const defaultModel = 'gemma4-e4b-litert';
const defaultTimeoutMs = 30_000;

export function litertLmProvider(options: LiteRtLmProviderOptions = {}): GameAIProvider {
  return new LiteRtLmGameAIProvider(options);
}

export class LiteRtLmGameAIProvider implements GameAIProvider {
  readonly id = 'litert-lm';
  readonly model: string;
  private readonly command: string;
  private readonly backend: LiteRtLmBackend;
  private readonly maxNumTokens: number;
  private readonly temperature: number;
  private readonly topP: number;
  private readonly seed: number | undefined;
  private readonly timeoutMs: number;
  private readonly cwd: string | undefined;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly runCommand: LiteRtLmCommandRunner;
  private readonly validateCommand: boolean;

  constructor(options: LiteRtLmProviderOptions = {}) {
    this.command = options.command ?? process.env.THE_WORLD_LITERT_LM_BIN ?? defaultLiteRtLmCommand();
    this.model = options.model ?? process.env.THE_WORLD_LITERT_MODEL ?? defaultModel;
    this.backend = options.backend ?? parseBackend(process.env.THE_WORLD_LITERT_BACKEND) ?? 'gpu';
    this.maxNumTokens = options.maxNumTokens ?? Number(process.env.THE_WORLD_LITERT_MAX_TOKENS ?? 4096);
    this.temperature = options.temperature ?? Number(process.env.THE_WORLD_TEMPERATURE ?? 0.55);
    this.topP = options.topP ?? Number(process.env.THE_WORLD_TOP_P ?? 0.9);
    this.seed = options.seed ?? optionalNumber(process.env.THE_WORLD_LITERT_SEED);
    this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    this.cwd = options.cwd;
    this.env = options.env;
    this.runCommand = options.runCommand ?? runProcess;
    this.validateCommand = !options.runCommand;
  }

  async health(): Promise<ProviderHealth> {
    const commandReady = !this.validateCommand || await canAccess(this.command);
    if (!commandReady) {
      return {
        ok: false,
        provider: this.id,
        model: this.model,
        mode: 'unavailable',
        message: `LiteRT-LM command not found: ${this.command}`
      };
    }

    try {
      const result = await this.runCommand(this.command, ['list'], {
        timeoutMs: Math.min(this.timeoutMs, 8_000),
        cwd: this.cwd,
        env: this.env
      });
      const models = parseModelList(result.stdout);
      const selected = models.includes(this.model) || await canAccess(this.model);
      return {
        ok: selected,
        provider: this.id,
        model: this.model,
        mode: selected ? 'ready' : 'degraded',
        message: selected
          ? `LiteRT-LM model ${this.model} is available.`
          : `LiteRT-LM is installed, but ${this.model} has not been imported.`,
        models
      };
    } catch (error) {
      return {
        ok: false,
        provider: this.id,
        model: this.model,
        mode: 'degraded',
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async warmup(options: { prompt?: string; timeoutMs?: number } = {}): Promise<ProviderHealth> {
    const health = await this.health();
    if (!health.ok) return health;

    try {
      await this.runLiteRtLm(options.prompt ?? 'Reply with exactly: ready', {
        temperature: 0,
        timeoutMs: options.timeoutMs ?? Math.max(this.timeoutMs, 45_000)
      });
      return {
        ...health,
        ok: true,
        mode: 'ready',
        message: `LiteRT-LM model ${this.model} is warm.`
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
    const text = await this.runLiteRtLm(promptForRequest(request), {
      temperature: request.temperature ?? this.temperature,
      timeoutMs: request.timeoutMs ?? this.timeoutMs,
      signal: request.signal
    });
    return {
      text,
      model: this.model,
      raw: text,
      metrics: {
        latencyMs: Date.now() - startedAt
      }
    };
  }

  private async runLiteRtLm(prompt: string, options: {
    temperature: number;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<string> {
    const args = [
      'run',
      this.model,
      '--backend',
      this.backend,
      '--max-num-tokens',
      String(this.maxNumTokens),
      '--temperature',
      String(options.temperature),
      '--top-p',
      String(this.topP),
      '--prompt',
      prompt
    ];
    if (typeof this.seed === 'number') {
      args.splice(args.length - 2, 0, '--seed', String(this.seed));
    }

    const result = await this.runCommand(this.command, args, {
      timeoutMs: options.timeoutMs,
      cwd: this.cwd,
      env: this.env,
      signal: options.signal
    });
    const text = cleanLiteRtLmOutput(result.stdout);
    if (!text.trim()) {
      throw new Error(`LiteRT-LM returned an empty response.${result.stderr ? ` stderr: ${result.stderr}` : ''}`);
    }
    return text;
  }
}

export function defaultLiteRtLmCommand(): string {
  return path.resolve(process.cwd(), '.venv/litert-lm/bin/litert-lm');
}

export function promptForRequest(request: GenerateRequest): string {
  const prompt = [
    ...request.messages.map(formatMessage),
    request.schema ? [
      'SCHEMA',
      'Return only one JSON object. No Markdown fences, no prose outside JSON.',
      JSON.stringify(request.schema)
    ].join('\n') : '',
    typeof request.maxTokens === 'number' ? `Keep the answer within about ${request.maxTokens} output tokens.` : ''
  ].filter(Boolean).join('\n\n');
  return prompt;
}

export function cleanLiteRtLmOutput(stdout: string): string {
  const withoutAnsi = stdout.replace(/\u001b\[[0-9;]*m/g, '').trim();
  const fenced = withoutAnsi.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced ? fenced[1]!.trim() : withoutAnsi).trim();
}

function formatMessage(message: ChatMessage): string {
  if (message.role === 'system') {
    return `SYSTEM\n${message.content}`;
  }
  if (message.role === 'assistant') {
    return `ASSISTANT\n${message.content}`;
  }
  return `USER\n${message.content}`;
}

function parseModelList(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((value) => value && value !== 'ID' && value !== 'Listing');
}

async function canAccess(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function parseBackend(value: string | undefined): LiteRtLmBackend | undefined {
  return value === 'cpu' || value === 'gpu' ? value : undefined;
}

function optionalNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

async function runProcess(command: string, args: string[], options: {
  timeoutMs: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<LiteRtLmCommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, options.timeoutMs);
    const abort = () => child.kill('SIGTERM');

    options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
      if (timedOut) {
        reject(new Error(`LiteRT-LM request timed out after ${Math.round(options.timeoutMs / 1000)}s.`));
        return;
      }
      if (options.signal?.aborted) {
        const error = new Error('Operation aborted.');
        error.name = 'AbortError';
        reject(error);
        return;
      }
      if (code !== 0) {
        reject(new Error(`LiteRT-LM exited with ${code ?? signal}: ${stderr || stdout}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}
