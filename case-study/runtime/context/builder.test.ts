import { describe, expect, it } from "vitest";
import { buildContext, estimateTokens } from "./builder";
import { countSharedPrefixMessages } from "./cache-observability";
import type { Message } from "../model/types";

const baseConfig = {
  recentTurns: 32,
  pruneBatchUserTurns: 2,
  maxToolResultChars: 10_000,
};

describe("buildContext cache behavior", () => {
  it("keeps the prior request as an exact message prefix after 32 completed turns", () => {
    const previousTranscript = makeInvocationTranscript(32);
    const currentTranscript: Message[] = [
      ...previousTranscript,
      makeAssistant(33),
      { role: "user", content: "user 34" },
    ];

    const previous = buildContext(previousTranscript, {
      ...baseConfig,
      strategy: "cache-first",
      maxContextTokens: 100_000,
    });
    const current = buildContext(currentTranscript, {
      ...baseConfig,
      strategy: "cache-first",
      maxContextTokens: 100_000,
    });

    expect(current.messages.slice(0, previous.messages.length)).toEqual(previous.messages);
    expect(countSharedPrefixMessages(previous.messages, current.messages)).toBe(previous.messages.length);
    expect(current.omitted).toEqual([]);
  });

  it("retains the old sliding-window behavior only behind legacy-window", () => {
    const previousTranscript = makeInvocationTranscript(32);
    const currentTranscript: Message[] = [
      ...previousTranscript,
      makeAssistant(33),
      { role: "user", content: "user 34" },
    ];

    const previous = buildContext(previousTranscript, { ...baseConfig, strategy: "legacy-window" });
    const current = buildContext(currentTranscript, { ...baseConfig, strategy: "legacy-window" });

    expect(countSharedPrefixMessages(previous.messages, current.messages)).toBeLessThan(previous.messages.length);
    expect(current.messages).toContainEqual({ role: "user", content: "user 1" });
    expect(current.messages.some((message) => message.role === "assistant" && message.content === "assistant 1")).toBe(false);
  });

  it("moves the cache-first boundary in complete user-turn batches", () => {
    const firstTranscript = makeInvocationTranscript(8);
    const full = buildContext(firstTranscript, { ...baseConfig, strategy: "cache-first" });
    const maxContextTokens = full.tokenEstimate - 1;
    const secondTranscript: Message[] = [
      ...firstTranscript,
      makeAssistant(9),
      { role: "user", content: "user 10" },
    ];

    const first = buildContext(firstTranscript, {
      ...baseConfig,
      strategy: "cache-first",
      maxContextTokens,
    });
    const second = buildContext(secondTranscript, {
      ...baseConfig,
      strategy: "cache-first",
      maxContextTokens,
    });

    expect(first.omitted.some((line) => line.includes("最旧的 2 个完整 user turn"))).toBe(true);
    expect(first.messages.find((message) => message.role === "user")?.content).toBe("user 3");
    expect(second.messages.find((message) => message.role === "user")?.content).toBe("user 3");
    expect(countSharedPrefixMessages(first.messages, second.messages)).toBe(first.messages.length);
  });

  it("counts persisted reasoning content in the context estimate", () => {
    const message: Message = { role: "assistant", content: "", reasoningContent: "r".repeat(80) };
    expect(estimateTokens([message])).toBe(20);
  });
});

function makeInvocationTranscript(completedTurns: number): Message[] {
  const messages: Message[] = [
    { role: "system", content: "base system" },
    { role: "system", content: "memory context" },
  ];
  for (let i = 1; i <= completedTurns; i++) {
    messages.push({ role: "user", content: `user ${i}` }, makeAssistant(i));
  }
  messages.push({ role: "user", content: `user ${completedTurns + 1}` });
  return messages;
}

function makeAssistant(turn: number): Message {
  return {
    role: "assistant",
    content: `assistant ${turn}`,
    reasoningContent: `reasoning ${turn}`,
  };
}
