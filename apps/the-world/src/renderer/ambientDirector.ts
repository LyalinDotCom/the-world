import type { GeneratedNpc } from './world.js';

export interface AmbientSpeechBubbleRef {
  npcId: string;
  startsAt: number;
  expiresAt: number;
  kind: 'ambient' | 'dialogue' | 'reaction';
}

export interface AmbientMeetupRef {
  expiresAt: number;
}

export class AmbientDirector {
  readonly maxSpeakers: number;
  nextAmbientAt = 0;
  lastAnnouncementAt = 0;
  private readonly speakerCooldowns = new Map<string, number>();
  private readonly pairCooldowns = new Map<string, number>();
  private readonly topicCooldowns = new Map<string, number>();

  constructor(options: { maxSpeakers: number }) {
    this.maxSpeakers = options.maxSpeakers;
  }

  visibleSpeakers(bubbles: AmbientSpeechBubbleRef[], now: number): Set<string> {
    const speakers = new Set<string>();
    for (const bubble of bubbles) {
      if (bubble.kind !== 'ambient') continue;
      if (bubble.expiresAt <= now || bubble.startsAt > now + 2_200) continue;
      speakers.add(bubble.npcId);
    }
    return speakers;
  }

  canStartFor(npcs: GeneratedNpc[], bubbles: AmbientSpeechBubbleRef[], now: number): boolean {
    const speakers = this.visibleSpeakers(bubbles, now);
    for (const npc of npcs) {
      speakers.add(npc.id);
    }
    return speakers.size <= this.maxSpeakers && npcs.every((npc) => this.speakerReady(npc, bubbles, now));
  }

  speakerReady(npc: GeneratedNpc, bubbles: AmbientSpeechBubbleRef[], now: number): boolean {
    if ((this.speakerCooldowns.get(npc.id) ?? 0) > now) return false;
    if (this.visibleSpeakers(bubbles, now).has(npc.id)) return false;
    return true;
  }

  pairReady(a: GeneratedNpc, b: GeneratedNpc, topicKey: string, now: number): boolean {
    return (this.pairCooldowns.get(ambientPairKey(a, b)) ?? 0) <= now &&
      (this.topicCooldowns.get(topicKey) ?? 0) <= now;
  }

  topicReady(topicKey: string, now: number): boolean {
    return (this.topicCooldowns.get(topicKey) ?? 0) <= now;
  }

  registerSpeech(npcs: GeneratedNpc[], now: number, durationMs: number, options: { pairKey?: string; topicKey?: string } = {}): void {
    for (const npc of npcs) {
      npc.lastBarkAt = now;
      npc.lastOverheardAt = now;
      this.speakerCooldowns.set(npc.id, now + durationMs + 22_000 + (npc.wanderSeed % 7) * 1_200);
    }
    if (options.pairKey) {
      this.pairCooldowns.set(options.pairKey, now + 70_000);
    }
    if (options.topicKey) {
      this.topicCooldowns.set(options.topicKey, now + 46_000);
    }
  }

  scheduleNext(now: number, minMs: number, maxMs: number): void {
    const spread = Math.max(0, maxMs - minMs);
    this.nextAmbientAt = now + minMs + Math.random() * spread;
  }

  prune(now: number): void {
    pruneCooldownMap(this.speakerCooldowns, now);
    pruneCooldownMap(this.pairCooldowns, now);
    pruneCooldownMap(this.topicCooldowns, now);
  }

  flowLine(bubbles: AmbientSpeechBubbleRef[], meetups: AmbientMeetupRef[], now: number): string {
    const visible = this.visibleSpeakers(bubbles, now).size;
    const next = Math.max(0, Math.round((this.nextAmbientAt - now) / 1000));
    const queuedMeetups = meetups.filter((meetup) => meetup.expiresAt > now).length;
    return `${visible}/${this.maxSpeakers} speakers / next ${next}s / ${queuedMeetups} meetups`;
  }
}

export function ambientPairKey(a: GeneratedNpc, b: GeneratedNpc): string {
  return [a.id, b.id].sort().join('|');
}

function pruneCooldownMap(map: Map<string, number>, now: number): void {
  for (const [key, expiresAt] of map.entries()) {
    if (expiresAt < now - 30_000) {
      map.delete(key);
    }
  }
}
