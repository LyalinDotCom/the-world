import type { BarkRequest, BarkTurn, DialogueRequest, DialogueTurn, NpcDefinition, OverheardExchange, OverhearRequest, RecipeDefinition } from './types.js';
import { BarkTurnSchema, DialogueTurnSchema, OverheardExchangeSchema, barkTurnJsonSchema, dialogueTurnJsonSchema, overheardExchangeJsonSchema } from './schemas.js';
import { compileBarkPrompt, compileDialoguePrompt, compileOverhearPrompt } from './promptCompiler.js';

export interface NpcDialogueRecipeInput {
  npc: NpcDefinition;
  request: DialogueRequest;
}

export interface NpcBarkRecipeInput {
  npc: NpcDefinition;
  request: BarkRequest;
}

export interface NpcOverhearRecipeInput {
  npc: NpcDefinition;
  request: OverhearRequest;
}

export const npcDialogueRecipe: RecipeDefinition<NpcDialogueRecipeInput, DialogueTurn> = {
  id: 'npc.dialogue',
  description: 'Generate a schema-bound player-facing NPC dialogue turn.',
  schema: DialogueTurnSchema,
  jsonSchema: dialogueTurnJsonSchema,
  temperature: 0.75,
  maxTokens: 220,
  compile(input, ctx) {
    return compileDialoguePrompt(input.npc, input.request, ctx);
  },
  fallback(input, _ctx, reason) {
    const isGoodbye = /bye|goodbye|later|see you|farewell/i.test(input.request.playerText);
    const name = input.npc.persona.name;
    return {
      text: isGoodbye ? `${name} nods. "Safe roads."` : `"I need a moment to gather my thoughts," ${name} says.`,
      emotion: isGoodbye ? 'warm' : 'neutral',
      mood: isGoodbye ? 'calm' : input.npc.persona.mood ?? 'calm',
      attitudeDelta: isGoodbye ? 0 : -2,
      willTalkAgain: true,
      animationHint: isGoodbye ? 'wave' : 'thinking',
      events: [
        { type: 'debug.warning', message: `Fallback dialogue used: ${reason}` }
      ],
      memoryWrites: isGoodbye ? [] : [
        {
          scope: 'npc',
          id: input.npc.id,
          text: `The player tried to talk, but ${name} could not answer clearly.`,
          importance: 0.2
        }
      ],
      safetyFlags: [
        { level: 'warn', code: 'fallback.dialogue', message: reason }
      ],
      shouldEndConversation: isGoodbye
    };
  }
};

export const npcBarkRecipe: RecipeDefinition<NpcBarkRecipeInput, BarkTurn> = {
  id: 'npc.bark',
  description: 'Generate a short ambient NPC bark.',
  schema: BarkTurnSchema,
  jsonSchema: barkTurnJsonSchema,
  temperature: 0.45,
  maxTokens: 70,
  compile(input, ctx) {
    return compileBarkPrompt(input.npc, ctx, JSON.stringify(input.request.scene), input.request.reason);
  },
  fallback(input, _ctx, reason) {
    return {
      text: `${input.npc.persona.name} watches the road and says nothing more.`,
      emotion: 'neutral',
      safetyFlags: [
        { level: 'warn', code: 'fallback.bark', message: reason }
      ]
    };
  }
};

export const npcOverhearRecipe: RecipeDefinition<NpcOverhearRecipeInput, OverheardExchange> = {
  id: 'npc.overhear',
  description: 'Generate a short NPC-to-NPC overheard exchange.',
  schema: OverheardExchangeSchema,
  jsonSchema: overheardExchangeJsonSchema,
  temperature: 0.6,
  maxTokens: 260,
  compile(input, ctx) {
    return compileOverhearPrompt(input.npc, input.request, ctx);
  },
  fallback(input, _ctx, reason) {
    return {
      lines: [
        {
          npcId: input.npc.id,
          text: 'Road feels longer every season.',
          emotion: 'neutral'
        },
        {
          npcId: input.request.otherNpc.id,
          text: 'Then walk slower and complain less.',
          emotion: 'amused'
        }
      ],
      safetyFlags: [
        { level: 'warn', code: 'fallback.overhear', message: reason }
      ]
    };
  }
};

export const defaultRecipes = [
  npcDialogueRecipe,
  npcBarkRecipe,
  npcOverhearRecipe
] as const;
