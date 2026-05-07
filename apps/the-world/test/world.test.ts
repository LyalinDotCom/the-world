import { describe, expect, it } from 'vitest';
import { ProceduralWorld, mainPathY } from '../src/renderer/world.js';

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
});
