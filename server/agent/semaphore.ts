/** Pembatas jumlah agen yang boleh menjalankan satu turn bersamaan. */
export class Semaphore {
  private available: number;
  private waiters: Array<() => void> = [];

  constructor(private readonly size: number) {
    this.available = size;
  }

  get inUse(): number {
    return this.size - this.available;
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
      return this.releaseOnce();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    return this.releaseOnce();
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.available += 1;
    };
  }
}
