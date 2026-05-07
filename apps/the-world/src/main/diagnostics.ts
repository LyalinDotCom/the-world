import type { IpcMain } from 'electron';
import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import type { DiagnosticsSample } from '../shared/bridge.js';
import type { PerfLogger } from './perfLog.js';

const execFileAsync = promisify(execFile);

export class DiagnosticsSampler {
  private lastGpuSample: DiagnosticsSample['gpu'] | undefined;
  private lastGpuSampleAt = 0;
  private lastCpuSample: {
    timestamp: number;
    total: number;
    idle: number;
    process: NodeJS.CpuUsage;
  } | undefined;

  async sample(): Promise<DiagnosticsSample> {
    const totalBytes = os.totalmem();
    const freeBytes = os.freemem();
    const processMemory = process.memoryUsage();
    return {
      timestamp: Date.now(),
      systemMemory: {
        totalBytes,
        freeBytes,
        usedBytes: Math.max(0, totalBytes - freeBytes)
      },
      processMemory: {
        rssBytes: processMemory.rss,
        heapUsedBytes: processMemory.heapUsed,
        heapTotalBytes: processMemory.heapTotal
      },
      cpu: this.sampleCpu(),
      gpu: await this.sampleGpu(totalBytes)
    };
  }

  private sampleCpu(): DiagnosticsSample['cpu'] {
    try {
      const now = Date.now();
      const snapshot = cpuSnapshot();
      const processUsage = process.cpuUsage();
      const cores = os.cpus().length || 1;
      if (!this.lastCpuSample) {
        this.lastCpuSample = {
          timestamp: now,
          total: snapshot.total,
          idle: snapshot.idle,
          process: processUsage
        };
        return {
          available: true,
          cores,
          loadAverage: os.loadavg(),
          source: 'node os.cpus/process.cpuUsage',
          systemPercent: 0,
          processPercent: 0
        };
      }

      const elapsedMs = Math.max(1, now - this.lastCpuSample.timestamp);
      const totalDelta = Math.max(1, snapshot.total - this.lastCpuSample.total);
      const idleDelta = Math.max(0, snapshot.idle - this.lastCpuSample.idle);
      const processDeltaMicros = Math.max(0, processUsage.user - this.lastCpuSample.process.user + processUsage.system - this.lastCpuSample.process.system);
      const cpu: DiagnosticsSample['cpu'] = {
        available: true,
        cores,
        loadAverage: os.loadavg(),
        source: 'node os.cpus/process.cpuUsage',
        systemPercent: Math.round(((totalDelta - idleDelta) / totalDelta) * 100),
        processPercent: Math.round((processDeltaMicros / 1000 / (elapsedMs * cores)) * 100)
      };
      this.lastCpuSample = {
        timestamp: now,
        total: snapshot.total,
        idle: snapshot.idle,
        process: processUsage
      };
      return cpu;
    } catch (error) {
      return {
        available: false,
        cores: os.cpus().length || 1,
        loadAverage: os.loadavg(),
        source: 'node os.cpus/process.cpuUsage',
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async sampleGpu(unifiedMemoryCapacityBytes: number): Promise<DiagnosticsSample['gpu']> {
    const now = Date.now();
    if (this.lastGpuSample && now - this.lastGpuSampleAt < 1_250) {
      return this.lastGpuSample;
    }
    try {
      const { stdout } = await execFileAsync('/usr/sbin/ioreg', ['-r', '-c', 'IOAccelerator', '-d', '1'], {
        timeout: 1_000,
        maxBuffer: 512_000
      });
      const gpu: DiagnosticsSample['gpu'] = {
        available: true,
        source: 'ioreg IOAccelerator',
        utilizationPercent: numberMatch(stdout, /"Device Utilization %"\s*=\s*(\d+)/),
        rendererUtilizationPercent: numberMatch(stdout, /"Renderer Utilization %"\s*=\s*(\d+)/),
        tilerUtilizationPercent: numberMatch(stdout, /"Tiler Utilization %"\s*=\s*(\d+)/),
        memoryUsedBytes: numberMatch(stdout, /"In use system memory"\s*=\s*(\d+)/),
        memoryAllocatedBytes: numberMatch(stdout, /"Alloc system memory"\s*=\s*(\d+)/),
        unifiedMemoryCapacityBytes,
        model: stringMatch(stdout, /"model"\s*=\s*"([^"]+)"/),
        cores: numberMatch(stdout, /"gpu-core-count"\s*=\s*(\d+)/)
      };
      this.lastGpuSample = gpu;
      this.lastGpuSampleAt = now;
      return gpu;
    } catch (error) {
      const gpu: DiagnosticsSample['gpu'] = {
        available: false,
        source: 'ioreg IOAccelerator',
        unifiedMemoryCapacityBytes,
        error: error instanceof Error ? error.message : String(error)
      };
      this.lastGpuSample = gpu;
      this.lastGpuSampleAt = now;
      return gpu;
    }
  }
}

export function registerDiagnosticsIpc(
  ipcMain: IpcMain,
  diagnostics: DiagnosticsSampler,
  perfLogger: PerfLogger
): () => void {
  unregisterDiagnosticsIpc(ipcMain);
  ipcMain.handle('the-world:diagnostics', async () => await diagnostics.sample());
  ipcMain.handle('the-world:perf-log:start', async () => await perfLogger.start());
  ipcMain.handle('the-world:perf-log:append', async (_event, sample) => await perfLogger.append(sample));
  ipcMain.handle('the-world:perf-log:stop', async () => perfLogger.stop());
  ipcMain.handle('the-world:perf-log:status', async () => perfLogger.status());
  return () => unregisterDiagnosticsIpc(ipcMain);
}

export function unregisterDiagnosticsIpc(ipcMain: IpcMain): void {
  ipcMain.removeHandler('the-world:diagnostics');
  ipcMain.removeHandler('the-world:perf-log:start');
  ipcMain.removeHandler('the-world:perf-log:append');
  ipcMain.removeHandler('the-world:perf-log:stop');
  ipcMain.removeHandler('the-world:perf-log:status');
}

function cpuSnapshot(): { total: number; idle: number } {
  return os.cpus().reduce((acc, cpu) => {
    const total = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
    return {
      total: acc.total + total,
      idle: acc.idle + cpu.times.idle
    };
  }, { total: 0, idle: 0 });
}

function numberMatch(text: string, pattern: RegExp): number | undefined {
  const value = text.match(pattern)?.[1];
  return value ? Number(value) : undefined;
}

function stringMatch(text: string, pattern: RegExp): string | undefined {
  return text.match(pattern)?.[1];
}
