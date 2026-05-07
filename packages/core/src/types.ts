import type { z } from 'zod';

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export type JsonSchema = Record<string, unknown>;

export interface GenerateRequest {
  messages: ChatMessage[];
  schema?: JsonSchema;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}

export interface GenerateMetrics {
  latencyMs?: number;
  promptTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface GenerateResult {
  text: string;
  model?: string;
  raw?: unknown;
  metrics?: GenerateMetrics;
}

export interface ProviderHealth {
  ok: boolean;
  provider: string;
  model?: string;
  mode: 'ready' | 'degraded' | 'unavailable';
  message?: string;
  models?: string[];
}

export interface WarmupOptions {
  prompt?: string;
  timeoutMs?: number;
}

export interface GameAIProvider {
  id: string;
  model?: string;
  health?(): Promise<ProviderHealth>;
  warmup?(options?: WarmupOptions): Promise<ProviderHealth>;
  generate(request: GenerateRequest): Promise<GenerateResult>;
}

export type RuntimeMode = 'local-only' | 'local-first' | 'authoring' | 'runtime' | 'mock';
export type RuntimeQuality = 'fast' | 'balanced' | 'best';

export interface GameAIWorldConfig {
  id: string;
  name?: string;
  lore?: string[];
  styleGuide?: string;
  allowedInvention?: 'none' | 'minor-flavor' | 'broad';
}

export interface GameAIRuntimeConfig {
  mode?: RuntimeMode;
  quality?: RuntimeQuality;
  maxLatencyMs?: number;
  cache?: 'none' | 'session';
  debug?: boolean;
  pregeneration?: {
    enabled?: boolean;
    cacheOnlyRuntimeRecipes?: string[];
    maxConcurrency?: number;
  };
}

export interface GameAIPolicies {
  canonOnly?: boolean;
  allowMinorFlavorInvention?: boolean;
  noQuestMutationWithoutTool?: boolean;
  noRewardCreation?: boolean;
  escalateDirectThreats?: boolean;
  contentRating?: 'E' | 'E10' | 'T' | 'M';
}

export interface GameAIConfig {
  provider?: GameAIProvider;
  world: GameAIWorldConfig;
  runtime?: GameAIRuntimeConfig;
  policies?: GameAIPolicies;
}

export type NpcMood = 'calm' | 'curious' | 'wary' | 'busy' | 'lonely' | 'cheerful' | 'afraid' | 'angry' | 'offended' | 'hostile';
export type DialogueEmotion = 'neutral' | 'warm' | 'angry' | 'afraid' | 'suspicious' | 'curious' | 'amused' | 'sad';
export type AnimationHint = 'idle' | 'point' | 'laugh' | 'lookAway' | 'shrug' | 'wave' | 'thinking';

export interface NpcPersona {
  name: string;
  role: string;
  traits?: string[];
  speechStyle?: string;
  mood?: NpcMood;
  goals?: string[];
  secrets?: string[];
  knows?: string[];
  doesNotKnow?: string[];
  rules?: string[];
}

export interface NpcDefinition {
  id: string;
  persona: NpcPersona;
  memory?: {
    scope?: 'npc' | 'scene' | 'world';
    maxEntries?: number;
  };
}

export interface SceneContext {
  location: string;
  biome?: string;
  timeOfDay?: string;
  weather?: string;
  nearbyCharacters?: string[];
  coordinates?: {
    x: number;
    y: number;
  };
  visibleFeatures?: string[];
  contextualFacts?: string[];
  metadata?: Record<string, unknown>;
}

export interface PlayerContext {
  id?: string;
  name?: string;
  knownFacts?: string[];
  visibleEquipment?: string[];
  reputation?: Record<string, number>;
}

export interface DialogueRequest {
  playerText: string;
  scene: SceneContext;
  player?: PlayerContext;
  relationship?: string;
  conversationId?: string;
  npcState?: {
    mood: NpcMood;
    disposition: number;
    willTalkAgain: boolean;
    refusalReason?: string;
  };
  recentDialogue?: Array<{
    speaker: string;
    text: string;
  }>;
}

export type DialogueDangerLevel = 'none' | 'uneasy' | 'threat' | 'panic';
export type DialogueActionType = 'none' | 'endConversation' | 'callForHelp';

export interface DialogueMoodAssessment {
  mood: NpcMood;
  attitudeDelta: number;
  dangerLevel: DialogueDangerLevel;
  reason: string;
  trace?: DebugTrace;
}

export interface DialogueActionDecision {
  type: DialogueActionType;
  reason: string;
  shouldEndConversation: boolean;
  trace?: DebugTrace;
}

export interface BarkRequest {
  scene: SceneContext;
  player?: PlayerContext;
  reason?: string;
}

export interface OverhearRequest {
  otherNpc: NpcDefinition;
  scene: SceneContext;
  topic?: string;
}

export type MemoryScope = 'npc' | 'player' | 'world' | 'scene';

export interface MemoryWrite {
  scope: MemoryScope;
  id?: string;
  text: string;
  importance: number;
}

export type GameAIEvent =
  | { type: 'dialogue.say'; npcId: string; text: string }
  | { type: 'npc.emotion'; npcId: string; emotion: DialogueEmotion }
  | { type: 'npc.callForHelp'; npcId: string; reason: string; dangerLevel: DialogueDangerLevel }
  | { type: 'quest.propose'; questId: string; reason: string }
  | { type: 'memory.write'; scope: MemoryScope; text: string; importance: number }
  | { type: 'ui.hint'; text: string }
  | { type: 'debug.warning'; message: string };

export interface SafetyFlag {
  level: 'info' | 'warn' | 'block';
  code: string;
  message: string;
}

export interface DebugTrace {
  recipeId: string;
  providerId: string;
  model?: string;
  latencyMs: number;
  cache: 'hit' | 'miss' | 'bypass';
  prompt: string;
  rawText: string;
  repaired: boolean;
  retrievedMemory: string[];
  schemaErrors?: string[];
  fallback?: boolean;
}

export interface DialogueTurn {
  text: string;
  emotion: DialogueEmotion;
  mood: NpcMood;
  attitudeDelta: number;
  willTalkAgain: boolean;
  refusalReason?: string;
  animationHint?: AnimationHint;
  events: GameAIEvent[];
  memoryWrites: MemoryWrite[];
  safetyFlags: SafetyFlag[];
  shouldEndConversation?: boolean;
  assessment?: DialogueMoodAssessment;
  action?: DialogueActionDecision;
  analysisTraces?: DebugTrace[];
  trace?: DebugTrace;
}

export interface BarkTurn {
  text: string;
  emotion: DialogueEmotion;
  safetyFlags: SafetyFlag[];
  trace?: DebugTrace;
}

export interface OverheardLine {
  npcId: string;
  text: string;
  emotion: DialogueEmotion;
}

export interface OverheardExchange {
  lines: OverheardLine[];
  safetyFlags: SafetyFlag[];
  trace?: DebugTrace;
}

export interface RecipeDefinition<TInput, TOutput> {
  id: string;
  description: string;
  schema: z.ZodType<TOutput>;
  jsonSchema: JsonSchema;
  temperature?: number;
  maxTokens?: number;
  compile(input: TInput, ctx: PromptCompileContext): ChatMessage[];
  fallback(input: TInput, ctx: PromptCompileContext, reason: string): TOutput;
}

export interface PromptCompileContext {
  world: GameAIWorldConfig;
  policies: GameAIPolicies;
  memory: string[];
}

export interface RunRecipeOptions {
  timeoutMs?: number;
  cacheKey?: string;
  bypassCache?: boolean;
  cacheMode?: 'read-through' | 'cache-only' | 'refresh';
  signal?: AbortSignal;
}

export interface NpcGenerationOptions {
  timeoutMs?: number;
  cacheKey?: string;
  cacheOnly?: boolean;
  refresh?: boolean;
  writeMemory?: boolean;
  assess?: boolean;
  signal?: AbortSignal;
}
