import { describe, expect, it } from "vitest";
import { EventBus, type TimestampedEvent } from "./events";
import { repairInterruptedToolCalls, runTurn } from "./loop";
import type { ModelClient, Message, ModelResponse, ToolSchema } from "../model/types";
import { ToolRegistry } from "../tools/registry";
import { createSession } from "../sessions/session";

class CapturingModel implements ModelClient {
  name = "capture";
  seen: Message[][] = [];

  async complete(messages: Message[], _tools: ToolSchema[]): Promise<ModelResponse> {
    this.seen.push(messages);
    return { text: "可以继续。", toolCalls: [] };
  }
}

class ReasoningToolModel implements ModelClient {
  name = "reasoning-tool";
  seen: Message[][] = [];

  async complete(messages: Message[], _tools: ToolSchema[]): Promise<ModelResponse> {
    this.seen.push(messages);
    if (this.seen.length === 1) {
      return {
        text: "",
        reasoningContent: "Need to inspect the repository first.",
        toolCalls: [{ id: "call_reasoning", name: "missingTool", input: {} }],
      };
    }
    return { text: "done", toolCalls: [] };
  }
}

class CapturingSink {
  events: TimestampedEvent[] = [];
  handle(ev: TimestampedEvent): void {
    this.events.push(ev);
  }
}

describe("repairInterruptedToolCalls", () => {
  it("adds missing tool messages immediately after an assistant tool call", () => {
    const messages: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "reload" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "deployMain", input: { mode: "reload-only" } }],
      },
      { role: "user", content: "确认执行" },
    ];

    const repaired = repairInterruptedToolCalls(messages);

    expect(repaired).toEqual([
      expect.objectContaining({
        toolCallId: "call_1",
        content: expect.stringContaining("上次运行在工具 deployMain 执行期间中断"),
      }),
    ]);
    expect(messages[3]).toMatchObject({ role: "tool", toolCallId: "call_1" });
    expect(messages[4]).toMatchObject({ role: "user", content: "确认执行" });
  });

  it("does not duplicate existing tool messages", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "readFile", input: { path: "a.ts" } }],
      },
      { role: "tool", toolCallId: "call_1", content: "ok" },
    ];

    expect(repairInterruptedToolCalls(messages)).toEqual([]);
    expect(messages).toHaveLength(2);
  });
});

describe("runTurn interrupted tool-call recovery", () => {
  it("repairs a persisted orphan tool call before sending context to the model", async () => {
    const session = createSession("sess_test", "sys");
    session.messages.push(
      { role: "user", content: "reload" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "deployMain", input: { mode: "reload-only" } }],
      },
    );
    const model = new CapturingModel();
    const sink = new CapturingSink();
    let checkpointCount = 0;

    await runTurn(session, "确认执行", {
      model,
      registry: new ToolRegistry(),
      events: new EventBus().use(sink),
      config: {
        maxTurns: 1,
        workingDir: "/tmp",
        context: { recentTurns: 20, maxToolResultChars: 1000, maxContextTokens: 4000 },
      },
      checkpoint: () => {
        checkpointCount++;
      },
    });

    expect(checkpointCount).toBeGreaterThan(0);
    expect(sink.events.some((ev) => ev.type === "error" && ev.content.includes("已补齐 1 个未完成工具结果"))).toBe(true);
    expect(sink.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool_result",
          id: "call_1",
          content: expect.stringContaining("上次运行在工具 deployMain 执行期间中断"),
        }),
      ]),
    );
    expect(model.seen[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "tool", toolCallId: "call_1" }),
        expect.objectContaining({ role: "user", content: "确认执行" }),
      ]),
    );
  });
});

describe("runTurn reasoning continuity", () => {
  it("includes provider reasoning content in the next tool-loop request", async () => {
    const session = createSession("sess_reasoning", "sys");
    const model = new ReasoningToolModel();

    await runTurn(session, "inspect", {
      model,
      registry: new ToolRegistry(),
      events: new EventBus(),
      config: {
        maxTurns: 2,
        workingDir: "/tmp",
        context: { strategy: "cache-first", recentTurns: 32, maxToolResultChars: 1000 },
      },
    });

    expect(model.seen[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          reasoningContent: "Need to inspect the repository first.",
        }),
      ]),
    );
  });
});
