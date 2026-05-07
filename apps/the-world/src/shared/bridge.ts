import type { RendererGameAIApi } from '@game-llm/electron';

export interface DiagnosticsSample {
  timestamp: number;
  systemMemory: {
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
  };
  processMemory: {
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
  };
  cpu: {
    available: boolean;
    systemPercent?: number;
    processPercent?: number;
    cores: number;
    loadAverage: number[];
    source: string;
    error?: string;
  };
  gpu: {
    available: boolean;
    utilizationPercent?: number;
    rendererUtilizationPercent?: number;
    tilerUtilizationPercent?: number;
    memoryUsedBytes?: number;
    memoryAllocatedBytes?: number;
    unifiedMemoryCapacityBytes?: number;
    model?: string;
    cores?: number;
    source: string;
    error?: string;
  };
}

export interface PerfLogSample {
  timestamp: number;
  fps: number;
  position: {
    x: number;
    y: number;
  };
  region: string;
  moving: boolean;
  activeNpcId?: string;
  nearbyNpcCount: number;
  ambientCacheReady: boolean;
  providerLine: string;
  warmupLine: string;
  traceLine: string;
  diagnostics?: DiagnosticsSample;
}

export interface PerfLogStatus {
  active: boolean;
  path?: string;
  samples: number;
}

export interface TheWorldDiagnosticsApi {
  sample(): Promise<DiagnosticsSample>;
  startPerfLog(): Promise<PerfLogStatus>;
  appendPerfSample(sample: PerfLogSample): Promise<PerfLogStatus>;
  stopPerfLog(): Promise<PerfLogStatus>;
  perfLogStatus(): Promise<PerfLogStatus>;
}

declare global {
  interface Window {
    gameAI?: RendererGameAIApi;
    theWorldDiagnostics?: TheWorldDiagnosticsApi;
  }
}

export type { RendererGameAIApi };
