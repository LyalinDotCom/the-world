import type { AreaEvent, AreaEventKind, AreaEventRequest, NpcDefinition, SceneContext } from '@game-llm/core';
import type { GameAIPreGenerateJob } from '@game-llm/electron';
import type { GeneratedNpc, Landmark, Vec2 } from './world.js';

export interface AreaEventState {
  event?: AreaEvent;
  triggered: boolean;
  inFlight: boolean;
  inFlightStartedAt?: number;
  failed?: string;
  failureNotified?: boolean;
  retryAfter?: number;
}

export interface AreaEventActor extends GeneratedNpc {
  eventId: string;
  expiresAt: number;
  target?: Vec2;
  health?: number;
}

export function areaEventCacheKey(landmark: Landmark): string {
  return `area-event:${landmark.id}:default`;
}

export function createAreaEventRequest(
  landmark: Landmark,
  scene: SceneContext,
  recentEvents: string[] = [],
  allowedKinds: AreaEventKind[] = [areaEventKindForLandmark(landmark)]
): AreaEventRequest {
  return {
    area: {
      id: landmark.id,
      name: landmark.name,
      kind: landmark.kind,
      lore: landmark.lore,
      rumor: landmark.rumor
    },
    scene,
    player: {
      id: 'player',
      knownFacts: [landmark.rumor],
      visibleEquipment: ['travel cloak', 'worn boots']
    },
    allowedKinds,
    recentEvents
  };
}

export function areaEventKindForLandmark(landmark: Landmark): AreaEventKind {
  if (landmark.kind === 'mill') return 'banditAmbush';
  if (landmark.kind === 'castle') return 'mysteriousBeing';
  if (landmark.kind === 'chapel') return 'strangeSounds';
  return 'banditAmbush';
}

export function createAreaEventJobs(
  landmarks: Landmark[],
  sceneForLandmark: (landmark: Landmark) => SceneContext
): GameAIPreGenerateJob[] {
  return landmarks.map((landmark) => ({
    type: 'areaEvent',
    request: createAreaEventRequest(landmark, sceneForLandmark(landmark)),
    options: {
      cacheKey: areaEventCacheKey(landmark),
      timeoutMs: 30_000
    }
  }));
}

export function areaEventNpcFromBeing(event: AreaEvent, origin: Vec2): AreaEventActor | undefined {
  if (event.kind !== 'mysteriousBeing' || !event.being) return undefined;
  return {
    id: `area.being.${event.locationId}`,
    eventId: event.locationId,
    expiresAt: Number.POSITIVE_INFINITY,
    x: origin.x,
    y: origin.y,
    color: '#92b8bd',
    lastBarkAt: 0,
    lastOverheardAt: 0,
    wanderSeed: 0,
    wanderRadius: 0,
    wanderSpeed: 0,
    conversationPolicy: 'open',
    persona: {
      name: event.being.name,
      role: `mysterious being of ${event.locationName}`,
      traits: ['ancient', 'watchful', 'bound to place'],
      mood: event.being.mood,
      speechStyle: event.being.speechStyle,
      knows: [
        event.being.description,
        `${event.locationName}: ${event.introText}`
      ],
      rules: [
        'Stay tied to this building and its local sensory details.',
        'Do not grant rewards, powers, quest completion, or major canon revelations.'
      ]
    },
    memory: {
      scope: 'npc',
      maxEntries: 12
    }
  };
}

export function areaEventNpcsFromBandits(event: AreaEvent, origin: Vec2, player: Vec2, now: number): AreaEventActor[] {
  if (event.kind !== 'banditAmbush' || !event.bandits?.length) return [];
  return event.bandits.map((bandit, index) => {
    const angle = Math.atan2(player.y - origin.y, player.x - origin.x) + (index - 1) * 0.34;
    const spawn = {
      x: origin.x - Math.cos(angle) * (72 + index * 18),
      y: origin.y - Math.sin(angle) * (72 + index * 18)
    };
    return {
      id: `area.bandit.${event.locationId}.${index}`,
      eventId: event.locationId,
      expiresAt: now + 55_000,
      health: 3,
      target: player,
      x: spawn.x,
      y: spawn.y,
      color: '#9f4636',
      lastBarkAt: 0,
      lastOverheardAt: 0,
      wanderSeed: index + 1,
      wanderRadius: 0,
      wanderSpeed: 0,
      conversationPolicy: 'private',
      persona: {
        name: bandit.name,
        role: bandit.title,
        traits: ['aggressive', 'opportunistic'],
        mood: 'hostile',
        speechStyle: 'Short rough threats. Context-specific to the building.',
        knows: [
          `${event.locationName}: ${event.introText}`,
          ...bandit.threatLines
        ],
        rules: [
          'Threaten the player in character, but do not decide damage, death, rewards, or inventory.'
        ]
      } satisfies NpcDefinition['persona']
    };
  });
}
