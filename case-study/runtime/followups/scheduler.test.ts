import { describe, expect, it, vi } from "vitest";
import { PrReviewFollowupScheduler } from "./scheduler";

describe("PrReviewFollowupScheduler", () => {
  it("does not process a wake request before the scheduler is enabled with start", async () => {
    const store = {
      listDue: vi.fn(() => [{ id: "prf_1" }]),
    };
    const service = {
      process: vi.fn(async () => undefined),
    };
    const scheduler = new PrReviewFollowupScheduler(store as never, service as never, 60_000);

    scheduler.wake();
    await Promise.resolve();

    expect(store.listDue).not.toHaveBeenCalled();
    expect(service.process).not.toHaveBeenCalled();
  });
});
