import type { BarkTurn, DialogueTurn, OverheardExchange } from '@game-llm/core';
import type { GameAIBarkPayload, GameAIDialoguePayload, GameAIOverhearPayload, RendererGameAIApi } from '@game-llm/electron';
import '../shared/bridge.js';

export function getGameAI(): RendererGameAIApi {
  return window.gameAI ?? rendererMockApi;
}

const rendererMockApi: RendererGameAIApi = {
  async health() {
    return {
      ok: true,
      provider: 'renderer-mock',
      model: 'browser-fallback',
      mode: 'ready',
      message: 'Renderer mock is active because the Electron preload bridge is unavailable.'
    };
  },
  async warmup() {
    return await this.health();
  },
  async dialogue(payload: GameAIDialoguePayload): Promise<DialogueTurn> {
    const goodbye = /bye|goodbye|farewell|later/i.test(payload.request.playerText);
    const text = goodbye
      ? `${payload.npc.persona.name} lifts a hand. "Safe roads."`
      : `${payload.npc.persona.name} says, "Ask softly. The hills carry words farther than feet."`;
    return {
      text,
      emotion: goodbye ? 'warm' : 'curious',
      animationHint: goodbye ? 'wave' : 'thinking',
      events: [
        { type: 'dialogue.say', npcId: payload.npc.id, text }
      ],
      memoryWrites: [],
      safetyFlags: [],
      shouldEndConversation: goodbye,
      trace: {
        recipeId: 'npc.dialogue',
        providerId: 'renderer-mock',
        model: 'browser-fallback',
        latencyMs: 1,
        cache: 'bypass',
        prompt: 'Renderer fallback prompt.',
        rawText: text,
        repaired: false,
        retrievedMemory: [],
        fallback: true
      }
    };
  },
  async bark(payload: GameAIBarkPayload): Promise<BarkTurn> {
    return {
      text: `${payload.npc.persona.name} checks the road dust and frowns.`,
      emotion: 'neutral',
      safetyFlags: []
    };
  },
  async overhear(payload: GameAIOverhearPayload): Promise<OverheardExchange> {
    return {
      lines: [
        { npcId: payload.npc.id, text: 'That path was straighter yesterday.', emotion: 'suspicious' },
        { npcId: payload.request.otherNpc.id, text: 'Then yesterday can come carry our packs.', emotion: 'amused' }
      ],
      safetyFlags: []
    };
  }
};
