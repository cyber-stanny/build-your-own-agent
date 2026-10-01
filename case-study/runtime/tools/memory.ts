import { z } from "zod";
import type { MemoryStore } from "../memory/store";
import type { Tool } from "./types";

const memoryCategorySchema = z.enum(["project", "environment", "command", "preference", "lesson"]);

export function createRememberTool(store: MemoryStore): Tool<{
  key: string;
  value: string;
  category: z.infer<typeof memoryCategorySchema>;
}> {
  return {
    name: "remember",
    description:
      "把对后续任务有复用价值的事实写入持久状态，例如项目技术栈、常用命令、服务器环境、用户偏好或一次踩坑结论。" +
      "不要记录临时流水账；同一个 key 会覆盖旧值。",
    schema: z.object({
      key: z.string().trim().min(1).describe("简短稳定的记忆名，例如 project.testCommand"),
      value: z.string().trim().min(1).describe("要记住的事实，要求具体、可复用"),
      category: memoryCategorySchema.describe("记忆类型"),
    }),
    async run(input) {
      const entry = store.remember(input);
      return `remembered [${entry.category}] ${entry.key}: ${entry.value}`;
    },
  };
}
