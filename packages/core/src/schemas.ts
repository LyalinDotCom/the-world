import { z } from 'zod';

export const NpcMoodSchema = z.enum([
  'calm',
  'curious',
  'wary',
  'busy',
  'lonely',
  'cheerful',
  'afraid',
  'angry',
  'offended',
  'hostile'
]);

export const DialogueEmotionSchema = z.enum([
  'neutral',
  'warm',
  'angry',
  'afraid',
  'suspicious',
  'curious',
  'amused',
  'sad'
]);

export const AnimationHintSchema = z.enum([
  'idle',
  'point',
  'laugh',
  'lookAway',
  'shrug',
  'wave',
  'thinking'
]);

export const MemoryWriteSchema = z.object({
  scope: z.enum(['npc', 'player', 'world', 'scene']),
  id: z.string().optional(),
  text: z.string().min(1).max(240),
  importance: z.number().min(0).max(1)
});

export const SafetyFlagSchema = z.object({
  level: z.enum(['info', 'warn', 'block']),
  code: z.string().min(1),
  message: z.string().min(1).max(240)
});

export const GameAIEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('dialogue.say'),
    npcId: z.string(),
    text: z.string()
  }),
  z.object({
    type: z.literal('npc.emotion'),
    npcId: z.string(),
    emotion: DialogueEmotionSchema
  }),
  z.object({
    type: z.literal('quest.propose'),
    questId: z.string(),
    reason: z.string()
  }),
  z.object({
    type: z.literal('memory.write'),
    scope: z.enum(['npc', 'player', 'world', 'scene']),
    text: z.string(),
    importance: z.number().min(0).max(1)
  }),
  z.object({
    type: z.literal('ui.hint'),
    text: z.string()
  }),
  z.object({
    type: z.literal('debug.warning'),
    message: z.string()
  })
]);

export const DialogueTurnSchema = z.object({
  text: z.string().min(1).max(420),
  emotion: DialogueEmotionSchema,
  mood: NpcMoodSchema,
  attitudeDelta: z.number().min(-30).max(30),
  willTalkAgain: z.boolean(),
  refusalReason: z.string().min(1).max(180).optional(),
  animationHint: AnimationHintSchema.optional(),
  events: z.array(GameAIEventSchema).default([]),
  memoryWrites: z.array(MemoryWriteSchema).default([]),
  safetyFlags: z.array(SafetyFlagSchema).default([]),
  shouldEndConversation: z.boolean().optional()
});

export const BarkTurnSchema = z.object({
  text: z.string().min(1).max(180),
  emotion: DialogueEmotionSchema,
  safetyFlags: z.array(SafetyFlagSchema).default([])
});

export const OverheardExchangeSchema = z.object({
  lines: z.array(z.object({
    npcId: z.string(),
    text: z.string().min(1).max(180),
    emotion: DialogueEmotionSchema
  })).min(2).max(4),
  safetyFlags: z.array(SafetyFlagSchema).default([])
});

const moodEnum = ['calm', 'curious', 'wary', 'busy', 'lonely', 'cheerful', 'afraid', 'angry', 'offended', 'hostile'];
const emotionEnum = ['neutral', 'warm', 'angry', 'afraid', 'suspicious', 'curious', 'amused', 'sad'];
const animationEnum = ['idle', 'point', 'laugh', 'lookAway', 'shrug', 'wave', 'thinking'];

export const dialogueTurnJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['text', 'emotion', 'mood', 'attitudeDelta', 'willTalkAgain', 'events', 'memoryWrites', 'safetyFlags'],
  properties: {
    text: { type: 'string', minLength: 1, maxLength: 420 },
    emotion: { type: 'string', enum: emotionEnum },
    mood: { type: 'string', enum: moodEnum },
    attitudeDelta: { type: 'number', minimum: -30, maximum: 30 },
    willTalkAgain: { type: 'boolean' },
    refusalReason: { type: 'string', minLength: 1, maxLength: 180 },
    animationHint: { type: 'string', enum: animationEnum },
    shouldEndConversation: { type: 'boolean' },
    events: {
      type: 'array',
      items: { type: 'object' }
    },
    memoryWrites: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['scope', 'text', 'importance'],
        properties: {
          scope: { type: 'string', enum: ['npc', 'player', 'world', 'scene'] },
          id: { type: 'string' },
          text: { type: 'string', minLength: 1, maxLength: 240 },
          importance: { type: 'number', minimum: 0, maximum: 1 }
        }
      }
    },
    safetyFlags: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['level', 'code', 'message'],
        properties: {
          level: { type: 'string', enum: ['info', 'warn', 'block'] },
          code: { type: 'string' },
          message: { type: 'string' }
        }
      }
    }
  }
};

export const barkTurnJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['text', 'emotion', 'safetyFlags'],
  properties: {
    text: { type: 'string', minLength: 1, maxLength: 180 },
    emotion: { type: 'string', enum: emotionEnum },
    safetyFlags: {
      type: 'array',
      items: { type: 'object' }
    }
  }
};

export const overheardExchangeJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['lines', 'safetyFlags'],
  properties: {
    lines: {
      type: 'array',
      minItems: 2,
      maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['npcId', 'text', 'emotion'],
        properties: {
          npcId: { type: 'string' },
          text: { type: 'string', minLength: 1, maxLength: 180 },
          emotion: { type: 'string', enum: emotionEnum }
        }
      }
    },
    safetyFlags: {
      type: 'array',
      items: { type: 'object' }
    }
  }
};
