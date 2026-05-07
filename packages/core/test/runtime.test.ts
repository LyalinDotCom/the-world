import { describe, expect, it } from 'vitest';
import { createGameAI, MockGameAIProvider, type GameAIProvider } from '../src/index.js';

describe('GameAI runtime', () => {
  it('returns schema-bound dialogue and writes NPC memory', async () => {
    const ai = createGameAI({
      provider: new MockGameAIProvider(),
      world: { id: 'test-world', lore: ['Old roads shift when nobody watches.'] },
      runtime: { mode: 'mock', cache: 'none' }
    });
    const npc = ai.npc({
      id: 'npc.guard.elda',
      persona: {
        name: 'Elda',
        role: 'road guard',
        traits: ['watchful'],
        mood: 'wary'
      }
    });

    const turn = await npc.respond({
      playerText: 'Why is everyone scared of the old mill?',
      scene: { location: 'West road', timeOfDay: 'dusk' }
    });

    expect(turn.text).toContain('Elda');
    expect(turn.events.some((event) => event.type === 'dialogue.say')).toBe(true);
    expect(ai.memory.recent('npc', 'npc.guard.elda').length).toBeGreaterThan(0);
  });

  it('lets NPCs end conversations through schema output', async () => {
    const ai = createGameAI({
      provider: new MockGameAIProvider(),
      world: { id: 'test-world' },
      runtime: { mode: 'mock' }
    });
    const npc = ai.npc({
      id: 'npc.innkeeper.mara',
      persona: { name: 'Mara', role: 'innkeeper' }
    });

    const turn = await npc.respond({
      playerText: 'Goodbye for now.',
      scene: { location: 'Tavern' }
    });

    expect(turn.shouldEndConversation).toBe(true);
    expect(turn.animationHint).toBe('wave');
  });

  it('repairs malformed non-authoritative event arrays before falling back', async () => {
    const provider: GameAIProvider = {
      id: 'test-provider',
      async generate() {
        return {
          text: JSON.stringify({
            text: 'The mill is trouble after dark.',
            emotion: 'suspicious',
            events: [{ type: 'made.up', description: 'invalid event' }],
            memoryWrites: [{ scope: 'npc', text: 'Player asked about the mill.', importance: 0.5 }],
            safetyFlags: []
          })
        };
      }
    };
    const ai = createGameAI({
      provider,
      world: { id: 'test-world' },
      runtime: { cache: 'none' }
    });
    const npc = ai.npc({
      id: 'npc.guard.elda',
      persona: { name: 'Elda', role: 'road guard' }
    });

    const turn = await npc.respond({
      playerText: 'Why the mill?',
      scene: { location: 'Road' }
    });

    expect(turn.text).toBe('The mill is trouble after dark.');
    expect(turn.events).toEqual([]);
    expect(turn.trace?.fallback).not.toBe(true);
    expect(turn.trace?.repaired).toBe(true);
  });
});
