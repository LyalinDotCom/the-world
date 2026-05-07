import type { MemoryScope, MemoryWrite } from './types.js';

export interface StoredMemory extends MemoryWrite {
  createdAt: number;
}

export class MemoryStore {
  private readonly entries: StoredMemory[] = [];

  write(write: MemoryWrite): StoredMemory {
    const stored = {
      ...write,
      importance: clamp(write.importance, 0, 1),
      createdAt: Date.now()
    };
    this.entries.push(stored);
    return stored;
  }

  writeMany(writes: MemoryWrite[]): StoredMemory[] {
    return writes.map((write) => this.write(write));
  }

  recent(scope: MemoryScope, id?: string, limit = 8): StoredMemory[] {
    return this.entries
      .filter((entry) => entry.scope === scope && (id === undefined || entry.id === id || entry.id === undefined))
      .sort((a, b) => b.importance - a.importance || b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  describe(scope: MemoryScope, id?: string, limit = 8): string[] {
    return this.recent(scope, id, limit).map((entry) => entry.text);
  }

  all(): StoredMemory[] {
    return [...this.entries];
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
