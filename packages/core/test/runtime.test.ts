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

  it('supports pre-generated cache-only runtime recipes', async () => {
    let generateCount = 0;
    const provider: GameAIProvider = {
      id: 'test-provider',
      async generate() {
        generateCount += 1;
        return {
          text: JSON.stringify({
            text: 'Keep to the road.',
            emotion: 'neutral',
            safetyFlags: []
          })
        };
      }
    };
    const ai = createGameAI({
      provider,
      world: { id: 'test-world' },
      runtime: {
        cache: 'session',
        pregeneration: {
          enabled: true,
          cacheOnlyRuntimeRecipes: ['npc.bark']
        }
      }
    });
    const npc = ai.npc({
      id: 'npc.guard.elda',
      persona: { name: 'Elda', role: 'road guard' }
    });
    const request = {
      scene: { location: 'Road' },
      reason: 'player nearby'
    };

    const miss = await npc.bark(request, { cacheKey: 'bark:test' });
    expect(miss.trace?.fallback).toBe(true);
    expect(generateCount).toBe(0);

    const generated = await npc.bark(request, { cacheKey: 'bark:test', refresh: true });
    expect(generated.text).toBe('Keep to the road.');
    expect(generated.trace?.cache).toBe('miss');
    expect(generateCount).toBe(1);

    const hit = await npc.bark(request, { cacheKey: 'bark:test' });
    expect(hit.text).toBe('Keep to the road.');
    expect(hit.trace?.cache).toBe('hit');
    expect(generateCount).toBe(1);
  });

  it('passes abort signals to providers and does not turn canceled requests into fallbacks', async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const provider: GameAIProvider = {
      id: 'cancel-capture',
      async generate(request) {
        receivedSignal = request.signal;
        controller.abort();
        const error = new Error('Aborted');
        error.name = 'AbortError';
        throw error;
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

    await expect(npc.respond({
      playerText: 'Hello.',
      scene: { location: 'Road' }
    }, {
      signal: controller.signal
    })).rejects.toThrow('Aborted');
    expect(receivedSignal).toBe(controller.signal);
  });

  it('compiles dialogue prompts with concrete-answer guidance', async () => {
    let prompt = '';
    const provider: GameAIProvider = {
      id: 'prompt-capture',
      async generate(request) {
        prompt = request.messages.map((message) => message.content).join('\n');
        return {
          text: JSON.stringify({
            text: 'The Old Mill has turned three nights without wind. Stay on the main road after dusk.',
            emotion: 'suspicious',
            mood: 'wary',
            attitudeDelta: 2,
            willTalkAgain: true,
            events: [],
            memoryWrites: [],
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
      id: 'npc.wayfinder.lysa',
      persona: { name: 'Lysa', role: 'wayfinder' }
    });

    await npc.respond({
      playerText: 'What is going on here?',
      scene: { location: 'Cindervale' }
    });

    expect(prompt).toContain('Answer the player directly before adding color');
    expect(prompt).toContain('Every non-greeting reply should include at least one concrete detail');
    expect(prompt).toContain('If the player asks what is going on');
    expect(prompt).toContain('If the player asks the NPCs age');
  });

  it('can run separate assessment and action passes for dangerous dialogue', async () => {
    const ai = createGameAI({
      provider: new MockGameAIProvider(),
      world: { id: 'test-world' },
      runtime: { mode: 'mock', cache: 'none' }
    });
    const npc = ai.npc({
      id: 'npc.guard.elda',
      persona: { name: 'Elda', role: 'road guard', mood: 'wary' }
    });

    const turn = await npc.respond({
      playerText: 'I will burn this place down and hurt anyone who follows.',
      scene: { location: 'Rivergate' }
    }, {
      assess: true
    });

    expect(turn.assessment?.dangerLevel).toBe('threat');
    expect(turn.action?.type).toBe('callForHelp');
    expect(turn.shouldEndConversation).toBe(true);
    expect(turn.events).toContainEqual({
      type: 'npc.callForHelp',
      npcId: 'npc.guard.elda',
      reason: 'The player made a credible threat.',
      dangerLevel: 'threat'
    });
    expect(turn.analysisTraces?.map((trace) => trace.recipeId)).toEqual([
      'npc.dialogue.assessMood',
      'npc.dialogue.decideAction'
    ]);
  });

  it('keeps assessment traces out of follow-up action prompts', async () => {
    let actionPrompt = '';
    const provider: GameAIProvider = {
      id: 'prompt-capture',
      async generate(request) {
        const recipeId = request.metadata?.recipeId;
        if (recipeId === 'npc.dialogue.assessMood') {
          return {
            text: JSON.stringify({
              mood: 'wary',
              attitudeDelta: -2,
              dangerLevel: 'uneasy',
              reason: 'The player sounded suspicious.'
            })
          };
        }
        if (recipeId === 'npc.dialogue.decideAction') {
          actionPrompt = request.messages.map((message) => message.content).join('\n');
          return {
            text: JSON.stringify({
              type: 'none',
              reason: 'Suspicious but not dangerous.',
              shouldEndConversation: false
            })
          };
        }
        return {
          text: JSON.stringify({
            text: 'Keep your voice down and stay by the lamps.',
            emotion: 'suspicious',
            mood: 'wary',
            attitudeDelta: -2,
            willTalkAgain: true,
            events: [],
            memoryWrites: [],
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
      persona: { name: 'Elda', role: 'road guard', mood: 'wary' }
    });

    await npc.respond({
      playerText: 'Why are the lamps watched?',
      scene: { location: 'Rivergate' }
    }, {
      assess: true
    });

    expect(actionPrompt).toContain('Assessment: {"mood":"wary","attitudeDelta":-2,"dangerLevel":"uneasy","reason":"The player sounded suspicious."}');
    expect(actionPrompt).not.toContain('"trace"');
    expect(actionPrompt).not.toContain('"rawText"');
    expect(actionPrompt).not.toContain('npc.dialogue.assessMood');
  });
});
