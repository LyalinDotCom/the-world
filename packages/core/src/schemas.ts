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

export const SceneContextSchema = z.object({
  location: z.string().min(1).max(160),
  biome: z.string().min(1).max(80).optional(),
  timeOfDay: z.string().min(1).max(80).optional(),
  weather: z.string().min(1).max(120).optional(),
  nearbyCharacters: z.array(z.string().min(1).max(120)).max(64).optional(),
  coordinates: z.object({
    x: z.number().finite(),
    y: z.number().finite()
  }).optional(),
  visibleFeatures: z.array(z.string().min(1).max(160)).max(64).optional(),
  contextualFacts: z.array(z.string().min(1).max(320)).max(64).optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export const PlayerContextSchema = z.object({
  id: z.string().min(1).max(120).optional(),
  name: z.string().min(1).max(120).optional(),
  knownFacts: z.array(z.string().min(1).max(240)).max(64).optional(),
  visibleEquipment: z.array(z.string().min(1).max(120)).max(64).optional(),
  reputation: z.record(z.string(), z.number().finite()).optional()
});

export const NpcPersonaSchema = z.object({
  name: z.string().min(1).max(120),
  role: z.string().min(1).max(120),
  traits: z.array(z.string().min(1).max(80)).max(24).optional(),
  speechStyle: z.string().min(1).max(300).optional(),
  mood: NpcMoodSchema.optional(),
  goals: z.array(z.string().min(1).max(180)).max(24).optional(),
  secrets: z.array(z.string().min(1).max(240)).max(24).optional(),
  knows: z.array(z.string().min(1).max(240)).max(64).optional(),
  doesNotKnow: z.array(z.string().min(1).max(240)).max(64).optional(),
  rules: z.array(z.string().min(1).max(260)).max(32).optional()
});

export const NpcDefinitionSchema = z.object({
  id: z.string().min(1).max(160),
  persona: NpcPersonaSchema,
  memory: z.object({
    scope: z.enum(['npc', 'scene', 'world']).optional(),
    maxEntries: z.number().int().min(1).max(1_000).optional()
  }).optional()
});

export const NpcGenerationOptionsSchema = z.object({
  timeoutMs: z.number().finite().min(1).max(120_000).optional(),
  cacheKey: z.string().min(1).max(500).optional(),
  cacheOnly: z.boolean().optional(),
  refresh: z.boolean().optional(),
  writeMemory: z.boolean().optional(),
  assess: z.boolean().optional()
});

const DialogueLineSchema = z.object({
  speaker: z.string().min(1).max(120),
  text: z.string().min(1).max(1_000)
});

const NpcSessionStateSchema = z.object({
  mood: NpcMoodSchema,
  disposition: z.number().finite().min(-100).max(100),
  willTalkAgain: z.boolean(),
  refusalReason: z.string().min(1).max(180).optional()
});

export const DialogueRequestSchema = z.object({
  playerText: z.string().min(1).max(1_000),
  scene: SceneContextSchema,
  player: PlayerContextSchema.optional(),
  relationship: z.string().min(1).max(120).optional(),
  conversationId: z.string().min(1).max(160).optional(),
  npcState: NpcSessionStateSchema.optional(),
  recentDialogue: z.array(DialogueLineSchema).max(24).optional()
});

export const BarkRequestSchema = z.object({
  scene: SceneContextSchema,
  player: PlayerContextSchema.optional(),
  reason: z.string().min(1).max(240).optional()
});

export const OverhearRequestSchema = z.object({
  otherNpc: NpcDefinitionSchema,
  scene: SceneContextSchema,
  topic: z.string().min(1).max(320).optional()
});

export const AreaEventKindSchema = z.enum(['banditAmbush', 'mysteriousBeing', 'strangeSounds']);

export const AreaEventRequestSchema = z.object({
  area: z.object({
    id: z.string().min(1).max(120),
    name: z.string().min(1).max(160),
    kind: z.string().min(1).max(80),
    lore: z.string().min(1).max(420),
    rumor: z.string().min(1).max(240).optional()
  }),
  scene: SceneContextSchema,
  player: PlayerContextSchema.optional(),
  allowedKinds: z.array(AreaEventKindSchema).min(1).max(3).optional(),
  recentEvents: z.array(z.string().min(1).max(180)).max(16).optional()
});

export const AreaEventGenerationOptionsSchema = z.object({
  timeoutMs: z.number().finite().min(1).max(120_000).optional(),
  cacheKey: z.string().min(1).max(500).optional(),
  cacheOnly: z.boolean().optional(),
  refresh: z.boolean().optional()
});

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
    type: z.literal('npc.callForHelp'),
    npcId: z.string(),
    reason: z.string(),
    dangerLevel: z.enum(['none', 'uneasy', 'threat', 'panic'])
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

export const DialogueMoodAssessmentSchema = z.object({
  mood: NpcMoodSchema,
  attitudeDelta: z.number().min(-30).max(30),
  dangerLevel: z.enum(['none', 'uneasy', 'threat', 'panic']),
  reason: z.string().min(1).max(220)
});

export const DialogueActionDecisionSchema = z.object({
  type: z.enum(['none', 'endConversation', 'callForHelp']),
  reason: z.string().min(1).max(220),
  shouldEndConversation: z.boolean()
});

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

export const AreaEventSchema = z.object({
  kind: AreaEventKindSchema,
  title: z.string().min(1).max(120),
  locationId: z.string().min(1).max(120),
  locationName: z.string().min(1).max(160),
  triggerRadius: z.number().finite().min(160).max(520),
  introText: z.string().min(1).max(300),
  bandits: z.array(z.object({
    id: z.string().min(1).max(120),
    name: z.string().min(1).max(80),
    title: z.string().min(1).max(100),
    entryLine: z.string().min(1).max(220),
    threatLines: z.array(z.string().min(1).max(180)).min(1).max(3),
    emotion: DialogueEmotionSchema
  })).min(1).max(3).optional(),
  being: z.object({
    id: z.string().min(1).max(120),
    name: z.string().min(1).max(100),
    description: z.string().min(1).max(260),
    greeting: z.string().min(1).max(260),
    speechStyle: z.string().min(1).max(220),
    mood: NpcMoodSchema
  }).optional(),
  sounds: z.array(z.object({
    text: z.string().min(1).max(180),
    emotion: DialogueEmotionSchema
  })).min(1).max(4).optional(),
  memoryWrites: z.array(MemoryWriteSchema).default([]),
  safetyFlags: z.array(SafetyFlagSchema).default([])
}).superRefine((value, ctx) => {
  if (value.kind === 'banditAmbush' && !value.bandits?.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['bandits'], message: 'banditAmbush requires bandits' });
  }
  if (value.kind === 'mysteriousBeing' && !value.being) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['being'], message: 'mysteriousBeing requires being' });
  }
  if (value.kind === 'strangeSounds' && !value.sounds?.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sounds'], message: 'strangeSounds requires sounds' });
  }
});

const moodEnum = ['calm', 'curious', 'wary', 'busy', 'lonely', 'cheerful', 'afraid', 'angry', 'offended', 'hostile'];
const emotionEnum = ['neutral', 'warm', 'angry', 'afraid', 'suspicious', 'curious', 'amused', 'sad'];
const animationEnum = ['idle', 'point', 'laugh', 'lookAway', 'shrug', 'wave', 'thinking'];
const dangerEnum = ['none', 'uneasy', 'threat', 'panic'];
const actionEnum = ['none', 'endConversation', 'callForHelp'];
const areaEventKindEnum = ['banditAmbush', 'mysteriousBeing', 'strangeSounds'];

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

export const dialogueMoodAssessmentJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['mood', 'attitudeDelta', 'dangerLevel', 'reason'],
  properties: {
    mood: { type: 'string', enum: moodEnum },
    attitudeDelta: { type: 'number', minimum: -30, maximum: 30 },
    dangerLevel: { type: 'string', enum: dangerEnum },
    reason: { type: 'string', minLength: 1, maxLength: 220 }
  }
};

export const dialogueActionDecisionJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'reason', 'shouldEndConversation'],
  properties: {
    type: { type: 'string', enum: actionEnum },
    reason: { type: 'string', minLength: 1, maxLength: 220 },
    shouldEndConversation: { type: 'boolean' }
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

export const areaEventJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'title', 'locationId', 'locationName', 'triggerRadius', 'introText', 'memoryWrites', 'safetyFlags'],
  properties: {
    kind: { type: 'string', enum: areaEventKindEnum },
    title: { type: 'string', minLength: 1, maxLength: 120 },
    locationId: { type: 'string', minLength: 1, maxLength: 120 },
    locationName: { type: 'string', minLength: 1, maxLength: 160 },
    triggerRadius: { type: 'number', minimum: 160, maximum: 520 },
    introText: { type: 'string', minLength: 1, maxLength: 300 },
    bandits: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'name', 'title', 'entryLine', 'threatLines', 'emotion'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 120 },
          name: { type: 'string', minLength: 1, maxLength: 80 },
          title: { type: 'string', minLength: 1, maxLength: 100 },
          entryLine: { type: 'string', minLength: 1, maxLength: 220 },
          threatLines: {
            type: 'array',
            minItems: 1,
            maxItems: 3,
            items: { type: 'string', minLength: 1, maxLength: 180 }
          },
          emotion: { type: 'string', enum: emotionEnum }
        }
      }
    },
    being: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'name', 'description', 'greeting', 'speechStyle', 'mood'],
      properties: {
        id: { type: 'string', minLength: 1, maxLength: 120 },
        name: { type: 'string', minLength: 1, maxLength: 100 },
        description: { type: 'string', minLength: 1, maxLength: 260 },
        greeting: { type: 'string', minLength: 1, maxLength: 260 },
        speechStyle: { type: 'string', minLength: 1, maxLength: 220 },
        mood: { type: 'string', enum: moodEnum }
      }
    },
    sounds: {
      type: 'array',
      minItems: 1,
      maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'emotion'],
        properties: {
          text: { type: 'string', minLength: 1, maxLength: 180 },
          emotion: { type: 'string', enum: emotionEnum }
        }
      }
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
