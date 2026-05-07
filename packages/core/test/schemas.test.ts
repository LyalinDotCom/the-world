import { describe, expect, it } from 'vitest';
import {
  DialogueActionDecisionSchema,
  DialogueMoodAssessmentSchema,
  DialogueTurnSchema,
  GameAIEventSchema,
  dialogueActionDecisionJsonSchema,
  dialogueMoodAssessmentJsonSchema,
  dialogueTurnJsonSchema
} from '../src/index.js';

function enumValues(schema: unknown, property: string): string[] {
  const properties = (schema as { properties?: Record<string, { enum?: string[] }> }).properties;
  const values = properties?.[property]?.enum;
  if (!values) throw new Error(`Missing JSON enum for ${property}.`);
  return values;
}

describe('schema parity', () => {
  it('keeps mood and emotion enums aligned between JSON schema and Zod schemas', () => {
    const moods = ['calm', 'curious', 'wary', 'busy', 'lonely', 'cheerful', 'afraid', 'angry', 'offended', 'hostile'];
    const emotions = ['neutral', 'warm', 'angry', 'afraid', 'suspicious', 'curious', 'amused', 'sad'];

    expect(enumValues(dialogueTurnJsonSchema, 'mood')).toEqual(moods);
    expect(enumValues(dialogueTurnJsonSchema, 'emotion')).toEqual(emotions);
    for (const mood of moods) {
      expect(DialogueTurnSchema.safeParse(validDialogueTurn({ mood })).success).toBe(true);
    }
    for (const emotion of emotions) {
      expect(DialogueTurnSchema.safeParse(validDialogueTurn({ emotion })).success).toBe(true);
    }
  });

  it('keeps mood assessment enums aligned between JSON schema and Zod schemas', () => {
    const dangerLevels = ['none', 'uneasy', 'threat', 'panic'];
    expect(enumValues(dialogueMoodAssessmentJsonSchema, 'dangerLevel')).toEqual(dangerLevels);
    expect(enumValues(dialogueMoodAssessmentJsonSchema, 'mood')).toEqual(enumValues(dialogueTurnJsonSchema, 'mood'));

    for (const dangerLevel of dangerLevels) {
      expect(DialogueMoodAssessmentSchema.safeParse({
        mood: 'wary',
        attitudeDelta: -2,
        dangerLevel,
        reason: 'The player sounded suspicious.'
      }).success).toBe(true);
    }
    expect(DialogueMoodAssessmentSchema.safeParse({
      mood: 'wary',
      attitudeDelta: -2,
      dangerLevel: 'critical',
      reason: 'Invalid.'
    }).success).toBe(false);
  });

  it('keeps action-decision enums aligned between JSON schema and Zod schemas', () => {
    const actions = ['none', 'endConversation', 'callForHelp'];
    expect(enumValues(dialogueActionDecisionJsonSchema, 'type')).toEqual(actions);

    for (const type of actions) {
      expect(DialogueActionDecisionSchema.safeParse({
        type,
        reason: 'Decision made.',
        shouldEndConversation: type !== 'none'
      }).success).toBe(true);
    }
    expect(DialogueActionDecisionSchema.safeParse({
      type: 'giveReward',
      reason: 'Invalid.',
      shouldEndConversation: false
    }).success).toBe(false);
  });

  it('accepts call-for-help events with every SDK danger level', () => {
    for (const dangerLevel of enumValues(dialogueMoodAssessmentJsonSchema, 'dangerLevel')) {
      expect(GameAIEventSchema.safeParse({
        type: 'npc.callForHelp',
        npcId: 'npc.guard.elda',
        reason: 'The player made a credible threat.',
        dangerLevel
      }).success).toBe(true);
    }
  });
});

function validDialogueTurn(overrides: Record<string, unknown> = {}) {
  return {
    text: 'Keep to the road.',
    emotion: 'neutral',
    mood: 'wary',
    attitudeDelta: 0,
    willTalkAgain: true,
    events: [],
    memoryWrites: [],
    safetyFlags: [],
    ...overrides
  };
}
