import { describe, expect, it } from 'vitest';
import { AmbientDirector, ambientPairKey } from '../src/renderer/ambientDirector.js';
import { canNpcStand, findSafeSpawn, resolvePlayerMove, staticCollisionAt } from '../src/renderer/collision.js';
import { diagnosticTrend, formatBytes } from '../src/renderer/diagnosticsHud.js';
import { DialogueController } from '../src/renderer/dialogueController.js';
import { FpsCounter } from '../src/renderer/gameLoop.js';
import { cameraForPoint } from '../src/renderer/worldView.js';
import { ProceduralWorld, mainPathY, type GeneratedNpc } from '../src/renderer/world.js';

function npc(id: string, seed: number): GeneratedNpc {
  return {
    id,
    x: 0,
    y: 0,
    color: '#fff',
    lastBarkAt: 0,
    lastOverheardAt: 0,
    wanderSeed: seed,
    wanderRadius: 120,
    wanderSpeed: 1,
    conversationPolicy: 'open',
    persona: {
      name: id,
      role: 'guard'
    }
  };
}

describe('ProceduralWorld', () => {
  it('generates deterministic terrain and NPCs', () => {
    const a = new ProceduralWorld('seed');
    const b = new ProceduralWorld('seed');

    expect(a.terrainAt(100, 200)).toEqual(b.terrainAt(100, 200));
    expect(a.npcsNear(0, mainPathY(0), 1500).map((npc) => npc.id)).toEqual(
      b.npcsNear(0, mainPathY(0), 1500).map((npc) => npc.id)
    );
  });

  it('places NPCs in explorable space around the starting route', () => {
    const world = new ProceduralWorld('the-world-v1');
    const npcs = world.npcsNear(120, mainPathY(120), 2200);

    expect(npcs.length).toBeGreaterThan(0);
    expect(npcs.some((npc) => npc.persona.role.length > 0)).toBe(true);
  });

  it('keeps movement blockers limited to structures and map bounds', () => {
    const world = new ProceduralWorld('the-world-v1');
    const [house] = world.housesInRect(-2200, -1400, -900, 300);
    expect(house).toBeDefined();
    expect(staticCollisionAt({ x: house!.x, y: house!.y }, 15, world)).toBe(true);

    const openRoad = { x: -1500, y: mainPathY(-1500) };
    expect(staticCollisionAt(openRoad, 15, world)).toBe(false);
    expect(canNpcStand(openRoad, world)).toBe(true);
  });

  it('resolves player movement by sliding around structures', () => {
    const world = new ProceduralWorld('the-world-v1');
    const [house] = world.housesInRect(-2200, -1400, -900, 300);
    expect(house).toBeDefined();
    const previous = { x: house!.x - house!.width / 2 - 28, y: house!.y };
    const desired = { x: house!.x, y: house!.y };

    expect(resolvePlayerMove(previous, desired, 15, world)).toEqual(previous);
  });

  it('finds safe spawns outside building blockers', () => {
    const world = new ProceduralWorld('the-world-v1');
    const [house] = world.housesInRect(-2200, -1400, -900, 300);
    expect(house).toBeDefined();
    const spawn = findSafeSpawn({ x: house!.x, y: house!.y }, world, 15);

    expect(staticCollisionAt(spawn, 18, world)).toBe(false);
  });

  it('caps ambient speakers and rotates pair cooldowns', () => {
    const director = new AmbientDirector({ maxSpeakers: 2 });
    const a = npc('a', 1);
    const b = npc('b', 2);
    const c = npc('c', 3);
    const now = 1_000;

    expect(director.canStartFor([a, b], [], now)).toBe(true);
    expect(director.canStartFor([a, b, c], [], now)).toBe(false);

    director.registerSpeech([a, b], now, 5_000, { pairKey: ambientPairKey(a, b), topicKey: 'mill' });
    expect(director.canStartFor([a], [], now + 1_000)).toBe(false);
    expect(director.pairReady(a, b, 'mill', now + 10_000)).toBe(false);
    expect(director.flowLine([{ npcId: a.id, kind: 'ambient', startsAt: now, expiresAt: now + 3_000 }], [], now + 500))
      .toContain('1/2 speakers');
  });

  it('formats diagnostic summaries consistently', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(diagnosticTrend([10, 12, 28])).toBe('rising +18%');
    expect(diagnosticTrend([40, 39, 38])).toBe('steady');
  });

  it('clamps the camera to map bounds', () => {
    expect(cameraForPoint({ x: -9999, y: -9999 }, { width: 1200, height: 800 })).toEqual({
      x: -2600,
      y: -2100
    });
    expect(cameraForPoint({ x: 9999, y: 9999 }, { width: 1200, height: 800 })).toEqual({
      x: 2700,
      y: 1700
    });
  });

  it('tracks FPS over a short rolling window', () => {
    const counter = new FpsCounter(500);
    expect(counter.recordFrame(0)).toBe(0);
    expect(counter.recordFrame(250)).toBe(0);
    expect(counter.recordFrame(500)).toBe(6);
  });

  it('tracks NPC refusal state from action decisions', () => {
    const controller = new DialogueController();
    const guard = npc('guard', 11);
    controller.applyTurn(guard, {
      text: 'Constables!',
      emotion: 'angry',
      mood: 'angry',
      attitudeDelta: -30,
      willTalkAgain: true,
      events: [],
      memoryWrites: [],
      safetyFlags: [],
      action: {
        type: 'callForHelp',
        reason: 'The player made a credible threat.',
        shouldEndConversation: true
      }
    });

    expect(controller.sessionFor(guard)).toMatchObject({
      mood: 'angry',
      willTalkAgain: false,
      refusalReason: 'You made me call the constables.'
    });
  });
});
