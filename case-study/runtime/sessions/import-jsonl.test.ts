import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { importLegacyJsonlSessions } from "./import-jsonl";
import { SessionStore } from "./store";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("importLegacyJsonlSessions", () => {
  it("rebuilds a resumable transcript and only imports once", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agent-jsonl-import-"));
    tempDirs.push(dir);
    const runsDir = path.join(dir, "runs");
    const store = new SessionStore(path.join(dir, "sessions.db"));
    const events = [
      { ts: "2026-07-27T12:00:00.000Z", type: "user_message", content: "修复登录问题" },
      { ts: "2026-07-27T12:00:01.000Z", type: "model_response", turn: 1, text: "先读文件", toolCalls: [{ name: "readFile" }] },
      { ts: "2026-07-27T12:00:02.000Z", type: "tool_call", id: "call_1", name: "readFile", input: { path: "a.ts" } },
      { ts: "2026-07-27T12:00:03.000Z", type: "tool_result", id: "call_1", content: "source" },
      { ts: "2026-07-27T12:00:04.000Z", type: "final_answer", content: "已修复" },
    ];
    mkdirSync(runsDir);
    writeFileSync(path.join(runsDir, "sess_old.jsonl"), events.map((event) => JSON.stringify(event)).join("\n"));

    expect(importLegacyJsonlSessions(store, runsDir, "system")).toBe(1);
    expect(importLegacyJsonlSessions(store, runsDir, "system")).toBe(0);
    const [restored] = store.list();
    expect(restored.meta).toMatchObject({ id: "sess_old", title: "修复登录问题", messageCount: 1 });
    expect(restored.messages).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "修复登录问题" },
      {
        role: "assistant",
        content: "先读文件",
        toolCalls: [{ id: "call_1", name: "readFile", input: { path: "a.ts" } }],
      },
      { role: "tool", toolCallId: "call_1", content: "source" },
      { role: "assistant", content: "已修复", toolCalls: [] },
    ]);
    store.close();
  });
});
