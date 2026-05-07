import type { DiagnosticsSample } from '../shared/bridge.js';

export interface RendererMemoryInfo {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

export interface DiagnosticsGraphInput {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  dpr: number;
  fpsHistory: number[];
  cpuHistory: number[];
  gpuHistory: number[];
}

export function diagnosticGpuUsage(gpu: DiagnosticsSample['gpu']): number | undefined {
  return gpu.utilizationPercent ?? gpu.rendererUtilizationPercent ?? gpu.tilerUtilizationPercent;
}

export function diagnosticTrend(history: number[]): string {
  if (history.length < 3) return 'warming';
  const current = history[history.length - 1]!;
  const previous = history[history.length - 3]!;
  const delta = current - previous;
  if (Math.abs(delta) < 3) return 'steady';
  return delta > 0 ? `rising +${Math.round(delta)}%` : `falling ${Math.round(delta)}%`;
}

export function rendererMemoryInfo(): RendererMemoryInfo | undefined {
  return (performance as Performance & { memory?: RendererMemoryInfo }).memory;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return 'n/a';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export function drawDiagnosticsGraph(input: DiagnosticsGraphInput): void {
  const { canvas, context, dpr, fpsHistory, cpuHistory, gpuHistory } = input;
  const width = canvas.width / dpr;
  const height = canvas.height / dpr;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  context.fillStyle = 'rgba(10, 12, 10, 0.72)';
  context.fillRect(0, 0, width, height);
  context.strokeStyle = 'rgba(238, 211, 149, 0.12)';
  context.lineWidth = 1;
  for (let y = 0; y <= 4; y += 1) {
    const yy = (height / 4) * y;
    context.beginPath();
    context.moveTo(0, yy);
    context.lineTo(width, yy);
    context.stroke();
  }
  if (gpuHistory.length < 2 && cpuHistory.length < 2 && fpsHistory.length < 2) {
    context.fillStyle = 'rgba(234, 219, 184, 0.42)';
    context.font = '11px Georgia, serif';
    context.fillText('waiting for performance samples', 12, height / 2 + 4);
    return;
  }
  drawDiagnosticSeries(context, fpsHistory, '#f1e5c7', width, height);
  drawDiagnosticSeries(context, cpuHistory, '#e3bd65', width, height);
  drawDiagnosticSeries(context, gpuHistory, '#8fcf7a', width, height);
  context.font = '10px Georgia, serif';
  context.fillStyle = '#f1e5c7';
  context.fillText('FPS', 10, 14);
  context.fillStyle = '#e3bd65';
  context.fillText('CPU', 46, 14);
  context.fillStyle = '#8fcf7a';
  context.fillText('GPU', 84, 14);
}

function drawDiagnosticSeries(
  context: CanvasRenderingContext2D,
  history: number[],
  color: string,
  width: number,
  height: number
): void {
  if (history.length < 2) return;
  context.strokeStyle = color;
  context.lineWidth = 2;
  context.beginPath();
  history.forEach((value, index) => {
    const x = (index / Math.max(1, history.length - 1)) * width;
    const y = height - (value / 100) * height;
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.stroke();
}
