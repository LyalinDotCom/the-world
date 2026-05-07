const emotions = new Set(['neutral', 'warm', 'angry', 'afraid', 'suspicious', 'curious', 'amused', 'sad']);
const animations = new Set(['idle', 'point', 'laugh', 'lookAway', 'shrug', 'wave', 'thinking']);
const scopes = new Set(['npc', 'player', 'world', 'scene']);
const safetyLevels = new Set(['info', 'warn', 'block']);

export function repairRecipeValue(recipeId: string, value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  if (recipeId === 'npc.dialogue') {
    return repairDialogue(value);
  }
  if (recipeId === 'npc.bark') {
    return repairBark(value);
  }
  if (recipeId === 'npc.overhear') {
    return repairOverhear(value);
  }
  return value;
}

function repairDialogue(value: Record<string, unknown>): Record<string, unknown> {
  return {
    text: stringOr(value.text, '...'),
    emotion: enumOr(value.emotion, emotions, 'neutral'),
    ...(animations.has(String(value.animationHint)) ? { animationHint: value.animationHint } : {}),
    events: repairEvents(value.events),
    memoryWrites: repairMemoryWrites(value.memoryWrites),
    safetyFlags: repairSafetyFlags(value.safetyFlags),
    ...(typeof value.shouldEndConversation === 'boolean' ? { shouldEndConversation: value.shouldEndConversation } : {})
  };
}

function repairBark(value: Record<string, unknown>): Record<string, unknown> {
  return {
    text: stringOr(value.text, '...'),
    emotion: enumOr(value.emotion, emotions, 'neutral'),
    safetyFlags: repairSafetyFlags(value.safetyFlags)
  };
}

function repairOverhear(value: Record<string, unknown>): Record<string, unknown> {
  const lines = Array.isArray(value.lines)
    ? value.lines.filter(isRecord).map((line) => ({
      npcId: stringOr(line.npcId, 'npc.unknown'),
      text: stringOr(line.text, '...'),
      emotion: enumOr(line.emotion, emotions, 'neutral')
    })).slice(0, 4)
    : [];

  return {
    lines,
    safetyFlags: repairSafetyFlags(value.safetyFlags)
  };
}

function repairEvents(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const repaired: unknown[] = [];
  for (const event of value.filter(isRecord)) {
    switch (event.type) {
      case 'dialogue.say':
        if (typeof event.npcId === 'string' && typeof event.text === 'string') {
          repaired.push({ type: 'dialogue.say', npcId: event.npcId, text: event.text });
        }
        break;
      case 'npc.emotion':
        if (typeof event.npcId === 'string' && emotions.has(String(event.emotion))) {
          repaired.push({ type: 'npc.emotion', npcId: event.npcId, emotion: event.emotion });
        }
        break;
      case 'quest.propose':
        if (typeof event.questId === 'string' && typeof event.reason === 'string') {
          repaired.push({ type: 'quest.propose', questId: event.questId, reason: event.reason });
        }
        break;
      case 'memory.write':
        if (scopes.has(String(event.scope)) && typeof event.text === 'string' && typeof event.importance === 'number') {
          repaired.push({ type: 'memory.write', scope: event.scope, text: event.text, importance: clamp(event.importance) });
        }
        break;
      case 'ui.hint':
        if (typeof event.text === 'string') {
          repaired.push({ type: 'ui.hint', text: event.text });
        }
        break;
      case 'debug.warning':
        if (typeof event.message === 'string') {
          repaired.push({ type: 'debug.warning', message: event.message });
        }
        break;
      default:
        break;
    }
  }
  return repaired;
}

function repairMemoryWrites(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isRecord).flatMap((write) => {
    if (!scopes.has(String(write.scope)) || typeof write.text !== 'string') {
      return [];
    }
    return [{
      scope: write.scope,
      ...(typeof write.id === 'string' ? { id: write.id } : {}),
      text: write.text.slice(0, 240),
      importance: clamp(typeof write.importance === 'number' ? write.importance : 0.3)
    }];
  });
}

function repairSafetyFlags(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isRecord).flatMap((flag) => {
    if (!safetyLevels.has(String(flag.level)) || typeof flag.code !== 'string' || typeof flag.message !== 'string') {
      return [];
    }
    return [{
      level: flag.level,
      code: flag.code,
      message: flag.message.slice(0, 240)
    }];
  });
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 420) : fallback;
}

function enumOr(value: unknown, allowed: Set<string>, fallback: string): string {
  const text = String(value);
  return allowed.has(text) ? text : fallback;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
