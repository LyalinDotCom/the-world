export class FpsCounter {
  value = 0;
  private frames = 0;
  private windowStartedAt: number | undefined;

  constructor(private readonly windowMs = 500) {}

  recordFrame(now: number): number {
    this.windowStartedAt ??= now;
    this.frames += 1;
    const elapsed = now - this.windowStartedAt;
    if (elapsed >= this.windowMs) {
      this.value = Math.round((this.frames * 1000) / elapsed);
      this.frames = 0;
      this.windowStartedAt = now;
    }
    return this.value;
  }
}

export function startGameLoop(callback: (now: number) => void): () => void {
  let frameId = 0;
  const tick = (now: number) => {
    callback(now);
    frameId = requestAnimationFrame(tick);
  };
  frameId = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(frameId);
}
