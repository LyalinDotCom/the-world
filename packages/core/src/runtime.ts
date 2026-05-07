import type { z } from 'zod';
import { ResponseCache } from './cache.js';
import { parseModelJson } from './json.js';
import { MemoryStore } from './memory.js';
import { MockGameAIProvider } from './mockProvider.js';
import { repairRecipeValue } from './repair.js';
import { defaultRecipes, npcBarkRecipe, npcDialogueRecipe, npcOverhearRecipe, type NpcBarkRecipeInput, type NpcDialogueRecipeInput, type NpcOverhearRecipeInput } from './recipes.js';
import type { BarkRequest, BarkTurn, DebugTrace, DialogueRequest, DialogueTurn, GameAIConfig, GameAIProvider, NpcDefinition, NpcGenerationOptions, OverheardExchange, OverhearRequest, PromptCompileContext, RecipeDefinition, RunRecipeOptions } from './types.js';

type AnyRecipe = RecipeDefinition<unknown, unknown>;

export class GameAI {
  readonly provider: GameAIProvider;
  readonly memory = new MemoryStore();
  private readonly cache = new ResponseCache<unknown>();
  private readonly recipes = new Map<string, AnyRecipe>();

  constructor(private readonly config: GameAIConfig) {
    this.provider = config.provider ?? new MockGameAIProvider();
    for (const recipe of defaultRecipes) {
      this.recipes.set(recipe.id, recipe as AnyRecipe);
    }
  }

  npc(definition: NpcDefinition): GameAINpc {
    return new GameAINpc(this, definition);
  }

  registerRecipe<TInput, TOutput>(recipe: RecipeDefinition<TInput, TOutput>): void {
    this.recipes.set(recipe.id, recipe as AnyRecipe);
  }

  async run<TInput, TOutput>(recipeId: string, input: TInput, options: RunRecipeOptions = {}): Promise<TOutput> {
    const recipe = this.recipes.get(recipeId) as RecipeDefinition<TInput, TOutput> | undefined;
    if (!recipe) {
      throw new Error(`Unknown GameAI recipe: ${recipeId}`);
    }

    const configuredCacheOnly = this.config.runtime?.pregeneration?.cacheOnlyRuntimeRecipes?.includes(recipeId) ?? false;
    const cacheMode = options.cacheMode ?? (configuredCacheOnly ? 'cache-only' : options.bypassCache ? 'refresh' : 'read-through');
    const cacheEnabled = this.config.runtime?.cache !== 'none';
    const canReadCache = cacheEnabled && cacheMode !== 'refresh';
    const canWriteCache = cacheEnabled && cacheMode !== 'cache-only';
    const cached = canReadCache ? this.cache.get(options.cacheKey) as TOutput | undefined : undefined;
    if (cached) {
      return markCacheHit(cached);
    }

    const context = this.contextForInput(input);
    const messages = recipe.compile(input, context);
    const prompt = messages.map((message) => `${message.role.toUpperCase()}\n${message.content}`).join('\n\n');
    const startedAt = Date.now();
    let rawText = '';
    let repaired = false;
    let fallback = false;
    let schemaErrors: string[] | undefined;

    try {
      if (cacheMode === 'cache-only') {
        throw new Error(`Cache miss for pre-generated recipe: ${recipeId}`);
      }
      const response = await this.provider.generate({
        messages,
        schema: recipe.jsonSchema,
        temperature: recipe.temperature,
        maxTokens: recipe.maxTokens,
        timeoutMs: options.timeoutMs ?? this.config.runtime?.maxLatencyMs,
        metadata: metadataForRecipe(recipeId, input)
      });
      rawText = response.text;
      const parsed = parseModelJson(rawText);
      repaired = parsed.repaired;
      let validation = recipe.schema.safeParse(parsed.value);
      if (!validation.success) {
        const repairedValue = repairRecipeValue(recipeId, parsed.value);
        const repairValidation = recipe.schema.safeParse(repairedValue);
        if (repairValidation.success) {
          repaired = true;
          validation = repairValidation;
        }
      }
      if (!validation.success) {
        schemaErrors = validation.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
        throw new Error(`Schema validation failed: ${schemaErrors.join('; ')}`);
      }
      const result = attachTrace(validation.data, {
        recipeId,
        providerId: this.provider.id,
        model: response.model ?? this.provider.model,
        latencyMs: response.metrics?.latencyMs ?? Date.now() - startedAt,
        cache: options.cacheKey && cacheEnabled ? 'miss' : 'bypass',
        prompt,
        rawText,
        repaired,
        retrievedMemory: context.memory,
        schemaErrors
      });
      if (canWriteCache) {
        this.cache.set(options.cacheKey, result);
      }
      return result;
    } catch (error) {
      fallback = true;
      const reason = error instanceof Error ? error.message : String(error);
      const result = attachTrace(recipe.fallback(input, context, reason), {
        recipeId,
        providerId: this.provider.id,
        model: this.provider.model,
        latencyMs: Date.now() - startedAt,
        cache: options.cacheKey && cacheEnabled ? 'miss' : 'bypass',
        prompt,
        rawText,
        repaired,
        retrievedMemory: context.memory,
        schemaErrors,
        fallback
      });
      return result;
    }
  }

  contextForNpc(npc: NpcDefinition): PromptCompileContext {
    const memoryLimit = npc.memory?.maxEntries ?? 8;
    return {
      world: this.config.world,
      policies: this.config.policies ?? {},
      memory: [
        ...this.memory.describe('npc', npc.id, memoryLimit),
        ...this.memory.describe('world', undefined, 4)
      ]
    };
  }

  private contextForInput(input: unknown): PromptCompileContext {
    if (isNpcInput(input)) {
      return this.contextForNpc(input.npc);
    }
    return {
      world: this.config.world,
      policies: this.config.policies ?? {},
      memory: this.memory.describe('world', undefined, 8)
    };
  }
}

export class GameAINpc {
  constructor(private readonly ai: GameAI, readonly definition: NpcDefinition) {}

  async respond(request: DialogueRequest, options: NpcGenerationOptions = {}): Promise<DialogueTurn> {
    const cacheBacked = Boolean(options.cacheKey || options.cacheOnly || options.refresh);
    const result = await this.ai.run<NpcDialogueRecipeInput, DialogueTurn>(npcDialogueRecipe.id, {
      npc: this.definition,
      request
    }, {
      cacheKey: options.cacheKey,
      bypassCache: !cacheBacked,
      cacheMode: cacheModeFromOptions(options),
      timeoutMs: options.timeoutMs ?? 20_000
    });

    if (options.writeMemory !== false && !result.trace?.fallback) {
      this.ai.memory.write({
        scope: 'npc',
        id: this.definition.id,
        text: `Player said: ${request.playerText.slice(0, 180)}`,
        importance: 0.35
      });
      this.ai.memory.writeMany(result.memoryWrites.map((write) => ({
        ...write,
        id: write.id ?? this.definition.id
      })));
    }
    return result;
  }

  async bark(request: BarkRequest, options: NpcGenerationOptions = {}): Promise<BarkTurn> {
    return await this.ai.run<NpcBarkRecipeInput, BarkTurn>(npcBarkRecipe.id, {
      npc: this.definition,
      request
    }, {
      cacheKey: options.cacheKey ?? `bark:${this.definition.id}:${request.scene.location}:${request.reason ?? ''}:${request.scene.timeOfDay ?? ''}`,
      cacheMode: cacheModeFromOptions(options),
      timeoutMs: options.timeoutMs ?? 8_000
    });
  }

  async overhear(request: OverhearRequest, options: NpcGenerationOptions = {}): Promise<OverheardExchange> {
    return await this.ai.run<NpcOverhearRecipeInput, OverheardExchange>(npcOverhearRecipe.id, {
      npc: this.definition,
      request
    }, {
      cacheKey: options.cacheKey ?? `overhear:${this.definition.id}:${request.otherNpc.id}:${request.scene.location}:${request.topic ?? ''}`,
      cacheMode: cacheModeFromOptions(options),
      timeoutMs: options.timeoutMs ?? 12_000
    });
  }
}

export function createGameAI(config: GameAIConfig): GameAI {
  return new GameAI(config);
}

function attachTrace<TOutput>(output: TOutput, trace: DebugTrace): TOutput {
  if (typeof output === 'object' && output !== null) {
    return {
      ...output,
      trace
    };
  }
  return output;
}

function markCacheHit<TOutput>(output: TOutput): TOutput {
  if (typeof output === 'object' && output !== null && 'trace' in output) {
    const traced = output as TOutput & { trace?: DebugTrace };
    if (traced.trace) {
      return {
        ...traced,
        trace: {
          ...traced.trace,
          cache: 'hit',
          latencyMs: 0
        }
      };
    }
  }
  return output;
}

function cacheModeFromOptions(options: NpcGenerationOptions): RunRecipeOptions['cacheMode'] {
  if (options.cacheOnly) return 'cache-only';
  if (options.refresh) return 'refresh';
  return undefined;
}

function isNpcInput(input: unknown): input is { npc: NpcDefinition } {
  return typeof input === 'object' && input !== null && 'npc' in input;
}

function metadataForRecipe(recipeId: string, input: unknown): Record<string, unknown> {
  const metadata: Record<string, unknown> = { recipeId };
  if (isNpcInput(input)) {
    metadata.npcId = input.npc.id;
    metadata.npcName = input.npc.persona.name;
  }
  return metadata;
}

export type InferRecipeOutput<T extends RecipeDefinition<unknown, unknown>> = T extends RecipeDefinition<unknown, infer TOutput> ? TOutput : never;
export type InferRecipeInput<T extends RecipeDefinition<unknown, unknown>> = T extends RecipeDefinition<infer TInput, unknown> ? TInput : never;
export type RecipeSchema<T> = z.ZodType<T>;
