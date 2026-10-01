import { describe, expect, it } from "vitest";
import { fingerprintPrompt } from "./cache-observability";
import type { Message, ToolSchema } from "../model/types";

const tools: ToolSchema[] = [
  {
    name: "readFile",
    description: "Read a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
];

describe("fingerprintPrompt", () => {
  it("keeps prefix and tool hashes stable while append-only history grows", () => {
    const previous: Message[] = [
      { role: "system", content: "system" },
      { role: "system", content: "memory" },
      { role: "user", content: "first" },
    ];
    const current: Message[] = [...previous, { role: "assistant", content: "done" }, { role: "user", content: "next" }];

    const before = fingerprintPrompt(previous, tools, "memory");
    const after = fingerprintPrompt(current, tools, "memory");

    expect(after.promptHash).not.toBe(before.promptHash);
    expect(after.prefixHash).toBe(before.prefixHash);
    expect(after.toolsHash).toBe(before.toolsHash);
    expect(after.memoryHash).toBe(before.memoryHash);
  });

  it("changes the early-prefix hashes when memory changes", () => {
    const first = fingerprintPrompt([{ role: "system", content: "system" }, { role: "system", content: "memory 1" }], tools, "memory 1");
    const second = fingerprintPrompt([{ role: "system", content: "system" }, { role: "system", content: "memory 2" }], tools, "memory 2");

    expect(second.prefixHash).not.toBe(first.prefixHash);
    expect(second.memoryHash).not.toBe(first.memoryHash);
  });
});
