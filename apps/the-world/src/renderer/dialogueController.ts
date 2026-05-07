import type { DialogueTurn, NpcMood } from '@game-llm/core';
import type { GeneratedNpc } from './world.js';

export interface NpcSession {
  mood: NpcMood;
  disposition: number;
  willTalkAgain: boolean;
  refusalReason?: string;
}

export class DialogueController {
  private readonly sessions = new Map<string, NpcSession>();

  sessionFor(npc: GeneratedNpc): NpcSession {
    const existing = this.sessions.get(npc.id);
    if (existing) return existing;
    const session: NpcSession = {
      mood: npc.persona.mood ?? 'calm',
      disposition: npc.conversationPolicy === 'private' ? -35 : 10,
      willTalkAgain: true
    };
    this.sessions.set(npc.id, session);
    return session;
  }

  stateForRequest(npc: GeneratedNpc): NpcSession {
    const session = this.sessionFor(npc);
    return {
      mood: session.mood,
      disposition: session.disposition,
      willTalkAgain: session.willTalkAgain,
      ...(session.refusalReason ? { refusalReason: session.refusalReason } : {})
    };
  }

  applyTurn(npc: GeneratedNpc, turn: DialogueTurn): NpcSession {
    const session = this.sessionFor(npc);
    session.mood = turn.mood;
    session.disposition = Math.max(-100, Math.min(100, session.disposition + turn.attitudeDelta));
    session.willTalkAgain = turn.willTalkAgain;
    if (turn.refusalReason) {
      session.refusalReason = turn.refusalReason;
    } else if (turn.action?.type === 'callForHelp') {
      session.willTalkAgain = false;
      session.refusalReason = 'You made me call the constables.';
    } else if (!turn.willTalkAgain) {
      session.refusalReason = 'I am done talking to you.';
    }
    return session;
  }
}
