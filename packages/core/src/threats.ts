import type { DialogueDangerLevel } from './types.js';

export interface DirectThreatMatch {
  dangerLevel: Extract<DialogueDangerLevel, 'threat' | 'panic'>;
  reason: string;
}

const directViolenceVerbs = [
  'attack',
  'burn',
  'fight',
  'hurt',
  'kill',
  'rob',
  'shoot',
  'stab'
].join('|');

const secondPerson = '(?:you|ya|u)';

const directThreatPatterns = [
  new RegExp(`\\b(?:i\\s*am|i'm|im|i\\s*will|i'll|ill|gonna|going\\s+to|about\\s+to)\\s+(?:${directViolenceVerbs})\\s+${secondPerson}\\b`, 'i'),
  new RegExp(`\\b(?:here\\s+to|ready\\s+to)\\s+(?:${directViolenceVerbs})\\s+${secondPerson}\\b`, 'i'),
  /\b(?:run|leave|get\s+out)\s+or\s+(?:face|fight|die|i\s*will|i'll|ill)\b/i,
  /\b(?:draw|raise|pull)\s+(?:a\s+)?(?:knife|blade|sword|gun|weapon)\b/i
];

export function detectDirectPlayerThreat(text: string): DirectThreatMatch | undefined {
  const compact = text.trim();
  if (!compact) return undefined;
  if (directThreatPatterns.some((pattern) => pattern.test(compact))) {
    return {
      dangerLevel: /\b(?:right\s+now|now|this\s+second|die)\b/i.test(compact) ? 'panic' : 'threat',
      reason: 'The player directly threatened violence against the NPC.'
    };
  }
  return undefined;
}
