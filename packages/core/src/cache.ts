export class ResponseCache<T = unknown> {
  private readonly values = new Map<string, T>();

  get(key: string | undefined): T | undefined {
    return key ? this.values.get(key) : undefined;
  }

  set(key: string | undefined, value: T): void {
    if (key) {
      this.values.set(key, value);
    }
  }

  clear(): void {
    this.values.clear();
  }
}
