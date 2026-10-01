import { zodToJsonSchema } from "zod-to-json-schema";
import type { Tool } from "./types";
import type { ToolSchema } from "../model/types";

// 工具注册表：把所有工具集中管理。
// loop 通过它来：列出有哪些工具 / 按名字找工具 / 生成给模型的「工具说明书」。
export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private schemaCache?: ToolSchema[];

  register(tool: Tool): this {
    this.tools.set(tool.name, tool);
    this.schemaCache = undefined;
    return this; // 支持链式 .register().register()
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  // 把每个工具的 zod schema 转成 JSON Schema —— 这就是模型 tool calling 时看到的「参数格式说明」。
  toSchemas(): ToolSchema[] {
    if (this.schemaCache) return this.schemaCache;

    this.schemaCache = this.list().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.schema, { target: "openApi3" }) as Record<string, unknown>,
    }));
    return this.schemaCache;
  }
}
