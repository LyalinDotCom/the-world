import { access } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
  bridgeScript?: string;
  pythonCommand?: string;
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
  private readonly bridgeScript: string;
  private readonly pythonCommand: string;
  private readonly runCommand: LiteRtLmCommandRunner;
  private readonly validateCommand: boolean;
  private bridge: LiteRtLmBridge | undefined;

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
    this.bridgeScript = options.bridgeScript ?? defaultBridgeScript();
    this.pythonCommand = options.pythonCommand ?? pythonCommandForLiteRtCommand(this.command);
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

  close(): void {
    this.bridge?.close();
    this.bridge = undefined;
  }

  private async runLiteRtLm(prompt: string, options: {
    temperature: number;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<string> {
    if (this.validateCommand) {
      const bridge = await this.getBridge(options.timeoutMs);
      const text = await bridge.generate({
        prompt,
        temperature: options.temperature,
        topP: this.topP,
        seed: this.seed,
        timeoutMs: options.timeoutMs,
        signal: options.signal
      });
      return cleanLiteRtLmOutput(text);
    }

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

  private async getBridge(timeoutMs: number): Promise<LiteRtLmBridge> {
    if (!this.bridge) {
      this.bridge = new LiteRtLmBridge({
        pythonCommand: this.pythonCommand,
        bridgeScript: this.bridgeScript,
        model: this.model,
        backend: this.backend,
        maxNumTokens: this.maxNumTokens,
        cwd: this.cwd,
        env: this.env
      });
    }
    await this.bridge.ready(timeoutMs);
    return this.bridge;
  }
}

export function defaultLiteRtLmCommand(): string {
  return path.resolve(process.cwd(), '.venv/litert-lm/bin/litert-lm');
}

export function defaultBridgeScript(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bridge/litert_bridge.py');
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

function pythonCommandForLiteRtCommand(command: string): string {
  const binDirectory = path.dirname(command);
  const candidate = path.join(binDirectory, 'python');
  return candidate;
}

interface LiteRtLmBridgeOptions {
  pythonCommand: string;
  bridgeScript: string;
  model: string;
  backend: LiteRtLmBackend;
  maxNumTokens: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

interface LiteRtLmBridgeGenerateOptions {
  prompt: string;
  temperature: number;
  topP: number;
  seed?: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

class LiteRtLmBridge {
  private readonly child;
  private readyPromise: Promise<void>;
  private nextId = 1;
  private buffer = '';
  private pending = new Map<number, {
    resolve(text: string): void;
    reject(error: Error): void;
    timeout: NodeJS.Timeout;
  }>();

  constructor(private readonly options: LiteRtLmBridgeOptions) {
    this.child = spawn(options.pythonCommand, [options.bridgeScript], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.onStdout(chunk));
    this.child.stderr.on('data', (chunk) => {
      if (process.env.THE_WORLD_LITERT_DEBUG === '1') {
        process.stderr.write(String(chunk));
      }
    });
    this.child.on('error', (error) => this.rejectAll(error));
    this.child.on('close', (code, signal) => {
      this.rejectAll(new Error(`LiteRT-LM bridge exited with ${code ?? signal}.`));
    });

    this.readyPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('LiteRT-LM bridge startup timed out.'));
      }, 60_000);
      this.pending.set(0, {
        resolve: () => {
          clearTimeout(timeout);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
        timeout
      });
    });
    this.child.stdin.write(`${JSON.stringify({
      model: options.model,
      backend: options.backend,
      maxNumTokens: options.maxNumTokens
    })}\n`);
  }

  async ready(_timeoutMs: number): Promise<void> {
    await this.readyPromise;
  }

  async generate(options: LiteRtLmBridgeGenerateOptions): Promise<string> {
    await this.ready(options.timeoutMs);
    const id = this.nextId++;
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LiteRT-LM bridge request timed out after ${Math.round(options.timeoutMs / 1000)}s.`));
      }, options.timeoutMs);
      const abort = () => {
        clearTimeout(timeout);
        this.pending.delete(id);
        const error = new Error('Operation aborted.');
        error.name = 'AbortError';
        reject(error);
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, {
        resolve: (text) => {
          clearTimeout(timeout);
          options.signal?.removeEventListener('abort', abort);
          resolve(text);
        },
        reject: (error) => {
          clearTimeout(timeout);
          options.signal?.removeEventListener('abort', abort);
          reject(error);
        },
        timeout
      });
      this.child.stdin.write(`${JSON.stringify({
        id,
        prompt: options.prompt,
        temperature: options.temperature,
        topP: options.topP,
        seed: options.seed
      })}\n`);
    });
  }

  close(): void {
    this.rejectAll(new Error('LiteRT-LM bridge closed.'));
    this.child.kill('SIGTERM');
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline === -1) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      this.onMessage(JSON.parse(line) as Record<string, unknown>);
    }
  }

  private onMessage(message: Record<string, unknown>): void {
    if (message.type === 'ready') {
      const pending = this.pending.get(0);
      this.pending.delete(0);
      pending?.resolve('');
      return;
    }
    if (message.type === 'fatal') {
      const error = new Error(String(message.error ?? 'LiteRT-LM bridge failed.'));
      const pending = this.pending.get(0);
      this.pending.delete(0);
      pending?.reject(error);
      this.rejectAll(error);
      return;
    }
    const id = Number(message.id);
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (message.type === 'error') {
      pending.reject(new Error(String(message.error ?? 'LiteRT-LM bridge request failed.')));
      return;
    }
    pending.resolve(String(message.text ?? ''));
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
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
