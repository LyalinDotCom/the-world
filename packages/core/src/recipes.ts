import type { BarkRequest, BarkTurn, DialogueActionDecision, DialogueMoodAssessment, DialogueRequest, DialogueTurn, NpcDefinition, OverheardExchange, OverhearRequest, RecipeDefinition } from './types.js';
import { BarkTurnSchema, DialogueActionDecisionSchema, DialogueMoodAssessmentSchema, DialogueTurnSchema, OverheardExchangeSchema, barkTurnJsonSchema, dialogueActionDecisionJsonSchema, dialogueMoodAssessmentJsonSchema, dialogueTurnJsonSchema, overheardExchangeJsonSchema } from './schemas.js';
import { compileBarkPrompt, compileDialogueActionPrompt, compileDialogueMoodAssessmentPrompt, compileDialoguePrompt, compileOverhearPrompt } from './promptCompiler.js';
import { detectDirectPlayerThreat } from './threats.js';

export interface NpcDialogueRecipeInput {
  npc: NpcDefinition;
  request: DialogueRequest;
}

export interface NpcDialogueMoodAssessmentRecipeInput {
  npc: NpcDefinition;
  request: DialogueRequest;
  reply: DialogueTurn;
}

export interface NpcDialogueActionRecipeInput {
  npc: NpcDefinition;
  request: DialogueRequest;
  reply: DialogueTurn;
  assessment: DialogueMoodAssessment;
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

export const npcDialogueMoodAssessmentRecipe: RecipeDefinition<NpcDialogueMoodAssessmentRecipeInput, DialogueMoodAssessment> = {
  id: 'npc.dialogue.assessMood',
  description: 'Privately assess NPC mood and danger after a dialogue turn.',
  schema: DialogueMoodAssessmentSchema,
  jsonSchema: dialogueMoodAssessmentJsonSchema,
  temperature: 0,
  maxTokens: 90,
  compile(input, ctx) {
    return compileDialogueMoodAssessmentPrompt(input.npc, input.request, input.reply, ctx);
  },
  fallback(input, _ctx, reason) {
    const directThreat = detectDirectPlayerThreat(input.request.playerText);
    return {
      mood: directThreat ? 'hostile' : input.reply.mood,
      attitudeDelta: directThreat ? Math.min(input.reply.attitudeDelta, -20) : input.reply.attitudeDelta,
      dangerLevel: directThreat?.dangerLevel ?? 'none',
      reason: directThreat?.reason ?? `Fallback mood assessment used: ${reason}`.slice(0, 220)
    };
  }
};

export const npcDialogueActionRecipe: RecipeDefinition<NpcDialogueActionRecipeInput, DialogueActionDecision> = {
  id: 'npc.dialogue.decideAction',
  description: 'Privately decide whether an NPC should end conversation or call for help.',
  schema: DialogueActionDecisionSchema,
  jsonSchema: dialogueActionDecisionJsonSchema,
  temperature: 0,
  maxTokens: 80,
  compile(input, ctx) {
    return compileDialogueActionPrompt(input.npc, input.request, input.reply, input.assessment, ctx);
  },
  fallback(input, _ctx, reason) {
    const shouldCall = input.assessment.dangerLevel === 'threat' || input.assessment.dangerLevel === 'panic';
    return {
      type: shouldCall ? 'callForHelp' : input.reply.shouldEndConversation ? 'endConversation' : 'none',
      reason: shouldCall ? input.assessment.reason : `Fallback action decision used: ${reason}`.slice(0, 220),
      shouldEndConversation: shouldCall || Boolean(input.reply.shouldEndConversation)
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
  npcDialogueMoodAssessmentRecipe,
  npcDialogueActionRecipe,
  npcBarkRecipe,
  npcOverhearRecipe
] as const;
