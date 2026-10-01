import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "./registry";
import type { Tool } from "./types";

describe("ToolRegistry schema stability", () => {
  it("reuses one ordered schema snapshot until registration changes", () => {
    const registry = new ToolRegistry().register(makeTool("first"));

    const first = registry.toSchemas();
    expect(registry.toSchemas()).toBe(first);

    registry.register(makeTool("second"));
    const second = registry.toSchemas();
    expect(second).not.toBe(first);
    expect(second.map((tool) => tool.name)).toEqual(["first", "second"]);
    expect(registry.toSchemas()).toBe(second);
  });
});

function makeTool(name: string): Tool {
  return {
    name,
    description: `${name} tool`,
    schema: z.object({ value: z.string().optional() }),
    async run() {
      return "ok";
    },
  };
}
