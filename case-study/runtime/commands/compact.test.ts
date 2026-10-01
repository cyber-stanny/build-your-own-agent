import { describe, expect, it } from "vitest";
import { compactMessages } from "./compact";
import type { Message, ModelClient, ModelResponse, ToolSchema } from "../model/types";

class CapturingModel implements ModelClient {
  name = "capture";
  requests: Message[][] = [];

  async complete(messages: Message[], _tools: ToolSchema[]): Promise<ModelResponse> {
    this.requests.push(messages);
    return { text: "## 目标\n旧历史摘要", toolCalls: [] };
  }
}

describe("compactMessages", () => {
  it("summarizes only old history and keeps recent user turns raw", async () => {
    const model = new CapturingModel();
    const messages: Message[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "user 1" },
      { role: "assistant", content: "assistant 1", toolCalls: [] },
      { role: "tool", toolCallId: "tool_1", content: "tool 1" },
      { role: "user", content: "user 2" },
      { role: "assistant", content: "assistant 2", toolCalls: [] },
      { role: "user", content: "user 3" },
      { role: "assistant", content: "assistant 3", toolCalls: [] },
      { role: "tool", toolCallId: "tool_3", content: "tool 3" },
      { role: "user", content: "user 4" },
    ];

    await compactMessages(messages, model, { keepRecentUserTurns: 2 });

    const transcriptForSummary = model.requests[0]?.[1]?.content ?? "";
    expect(transcriptForSummary).toContain("user 1");
    expect(transcriptForSummary).toContain("assistant 2");
    expect(transcriptForSummary).not.toContain("user 3");
    expect(transcriptForSummary).not.toContain("tool 3");
    expect(transcriptForSummary).not.toContain("user 4");

    expect(messages.map((m) => m.content)).toEqual([
      "system prompt",
      "以下是此前对话的压缩摘要，用于继续执行当前任务：\n\n## 目标\n旧历史摘要",
      "user 3",
      "assistant 3",
      "tool 3",
      "user 4",
    ]);
  });

  it("keeps the final unanswered user message as a recent user turn", async () => {
    const model = new CapturingModel();
    const messages: Message[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "old user" },
      { role: "assistant", content: "old assistant", toolCalls: [] },
      { role: "user", content: "recent user" },
    ];

    await compactMessages(messages, model, { keepRecentUserTurns: 1 });

    expect(messages.map((m) => m.content)).toEqual([
      "system prompt",
      "以下是此前对话的压缩摘要，用于继续执行当前任务：\n\n## 目标\n旧历史摘要",
      "recent user",
    ]);
  });
});
