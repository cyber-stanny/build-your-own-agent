import { describe, expect, it } from "vitest";
import { SerialTaskQueue } from "./serial-queue";

describe("SerialTaskQueue", () => {
  it("does not start the next workspace run until the current run settles", async () => {
    const queue = new SerialTaskQueue();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.run(async () => {
      order.push("first:start");
      await firstGate;
      order.push("first:end");
    });
    const second = queue.run(async () => {
      order.push("second:start");
    });

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("continues after a failed run", async () => {
    const queue = new SerialTaskQueue();
    await expect(queue.run(async () => Promise.reject(new Error("failed")))).rejects.toThrow("failed");
    await expect(queue.run(async () => "next")).resolves.toBe("next");
  });
});
