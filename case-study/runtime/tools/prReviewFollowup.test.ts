import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PrReviewFollowupStore } from "../followups/store";
import { createSchedulePrReviewFollowupTool } from "./prReviewFollowup";
import { ToolRegistry } from "./registry";

describe("PR review follow-up tools", () => {
  it("emits a DeepSeek-compatible PR number schema", () => {
    const store = new PrReviewFollowupStore(path.join(tmpdir(), `pr-followup-${randomUUID()}.json`));
    const registry = new ToolRegistry().register(createSchedulePrReviewFollowupTool(store));
    const schema = registry.toSchemas().find((item) => item.name === "schedulePrReviewFollowup")?.inputSchema;
    const prNumber = (schema?.properties as Record<string, Record<string, unknown>> | undefined)?.prNumber;

    expect(prNumber).toMatchObject({ type: "integer", minimum: 1 });
    expect(prNumber).not.toHaveProperty("exclusiveMinimum");
  });
});
