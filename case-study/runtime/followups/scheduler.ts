import type { PrReviewFollowupService } from "./service";
import type { PrReviewFollowupStore } from "./store";

export class PrReviewFollowupScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private active = new Set<string>();
  private ticking = false;

  constructor(
    private store: PrReviewFollowupStore,
    private service: PrReviewFollowupService,
    private intervalMs: number,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  wake(): void {
    if (!this.timer) return;
    queueMicrotask(() => void this.tick());
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const task of this.store.listDue()) {
        if (this.active.has(task.id)) continue;
        this.active.add(task.id);
        try {
          await this.service.process(task.id);
        } finally {
          this.active.delete(task.id);
        }
      }
    } finally {
      this.ticking = false;
    }
  }
}
