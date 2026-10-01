import { describe, expect, it } from "vitest";
import { toDeepseekMessages, toDeepseekModelUsage } from "./deepseek";

describe("DeepSeek V4 adapter", () => {
  it("returns reasoning_content with assistant tool calls", () => {
    const messages = toDeepseekMessages([
      {
        role: "assistant",
        content: "",
        reasoningContent: "I should inspect the file first.",
        toolCalls: [{ id: "call_1", name: "readFile", input: { path: "src/app.ts" } }],
      },
      { role: "tool", toolCallId: "call_1", content: "file contents" },
    ]) as unknown as Array<Record<string, unknown>>;

    expect(messages[0]).toMatchObject({
      role: "assistant",
      reasoning_content: "I should inspect the file first.",
      tool_calls: [
        {
          id: "call_1",
          function: { name: "readFile", arguments: JSON.stringify({ path: "src/app.ts" }) },
        },
      ],
    });
  });

  it("maps cache counters and request metadata", () => {
    const usage = toDeepseekModelUsage(
      {
        prompt_tokens: 1_000,
        completion_tokens: 20,
        total_tokens: 1_020,
        prompt_cache_hit_tokens: 800,
        prompt_cache_miss_tokens: 200,
      } as never,
      { id: "req_123", model: "deepseek-v4-flash", system_fingerprint: "fp_123" },
    );

    expect(usage).toMatchObject({
      requestId: "req_123",
      model: "deepseek-v4-flash",
      systemFingerprint: "fp_123",
      inputTokens: 1_000,
      cachedInputTokens: 800,
      cacheMissInputTokens: 200,
    });
  });
});
