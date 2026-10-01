import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "./store";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("SessionStore", () => {
  it("restores metadata, transcript and timeline after reopening", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agent-sessions-"));
    tempDirs.push(dir);
    const file = path.join(dir, "sessions.db");
    const createdAt = "2026-07-27T12:00:00.000Z";
    const store = new SessionStore(file);

    store.create({
      meta: { id: "sess_1", title: "历史问题", createdAt, updatedAt: createdAt, messageCount: 0 },
      messages: [{ role: "system", content: "system" }],
      timeline: [],
    });
    store.updateMeta({
      id: "sess_1",
      title: "历史问题",
      createdAt,
      updatedAt: "2026-07-27T12:01:00.000Z",
      messageCount: 1,
    });
    store.saveMessages("sess_1", [
      { role: "system", content: "system" },
      { role: "user", content: "还能接着聊吗？" },
      { role: "assistant", content: "可以。", toolCalls: [] },
    ]);
    store.appendEvent("sess_1", { ts: createdAt, type: "user_message", content: "还能接着聊吗？" });
    store.appendEvent("sess_1", { ts: createdAt, type: "final_answer", content: "可以。" });
    store.close();

    const reopened = new SessionStore(file);
    const [restored] = reopened.list();
    expect(restored.meta.messageCount).toBe(1);
    expect(restored.messages.at(-1)).toMatchObject({ role: "assistant", content: "可以。" });
    expect(restored.timeline.map((event) => event.type)).toEqual(["user_message", "final_answer"]);
    reopened.close();
  });
});
