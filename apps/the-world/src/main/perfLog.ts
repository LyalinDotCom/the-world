import path from 'node:path';
import { appendFile, mkdir } from 'node:fs/promises';
import type { PerfLogSample, PerfLogStatus } from '../shared/bridge.js';

export class PerfLogger {
  private path: string | undefined;
  private samples = 0;

  constructor(private readonly userDataPath: string) {}

  async start(): Promise<PerfLogStatus> {
    const directory = path.join(this.userDataPath, 'perf');
    await mkdir(directory, { recursive: true });
    this.path = path.join(directory, `the-world-perf-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
    this.samples = 0;
    await appendFile(this.path, JSON.stringify({ type: 'session.start', timestamp: Date.now(), app: 'The World' }) + '\n', 'utf-8');
    return this.status();
  }

  async append(sample: PerfLogSample): Promise<PerfLogStatus> {
    if (!this.path) {
      return this.status();
    }
    this.samples += 1;
    await appendFile(this.path, JSON.stringify({ type: 'sample', ...sample }) + '\n', 'utf-8');
    return this.status();
  }

  stop(): PerfLogStatus {
    const stoppedPath = this.path;
    this.path = undefined;
    return {
      active: false,
      ...(stoppedPath ? { path: stoppedPath } : {}),
      samples: this.samples
    };
  }

  status(): PerfLogStatus {
    return {
      active: Boolean(this.path),
      ...(this.path ? { path: this.path } : {}),
      samples: this.samples
    };
  }
}
