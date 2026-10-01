import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Tool, ToolContext } from "./types";

// 把相对路径锁在 workingDir 内，防止工具读写到工作目录外面。
// 这是权限/安全的最小雏形——第 2 周会把它扩展成正经的 permission 层。
function resolveInside(ctx: ToolContext, p: string): string {
  const root = path.resolve(ctx.workingDir);
  const abs = path.resolve(root, p);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`path escapes workingDir: ${p}`);
  }
  return abs;
}

export const readFile: Tool<{ path: string }> = {
  name: "readFile",
  description: "读取工作目录下某个文件的文本内容。",
  schema: z.object({ path: z.string().describe("相对工作目录的文件路径") }),
  async run({ path: p }, ctx) {
    return await fs.readFile(resolveInside(ctx, p), "utf8");
  },
};

export const writeFile: Tool<{ path: string; content: string }> = {
  name: "writeFile",
  description: "把文本内容写入工作目录下的文件（覆盖写；目录会自动创建）。",
  schema: z.object({ path: z.string(), content: z.string() }),
  async run({ path: p, content }, ctx) {
    const abs = resolveInside(ctx, p);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
    return `wrote ${content.length} chars to ${p}`;
  },
};

export const editFile: Tool<{ path: string; oldText: string; newText: string; replaceAll?: boolean }> = {
  name: "editFile",
  description:
    "对文件做局部替换：把 oldText（必须在文件中精确出现，含缩进/换行）替换成 newText。" +
    "改代码用这个，不要用 writeFile 整文件覆盖。默认要求 oldText 唯一；要批量替换（如重命名）才设 replaceAll=true。",
  schema: z.object({
    path: z.string(),
    oldText: z.string().min(1).describe("文件中要被替换的片段，逐字精确匹配；默认要求唯一"),
    newText: z.string().describe("用来替换的新内容"),
    replaceAll: z.boolean().optional().describe("默认 false=要求唯一；true=替换所有出现"),
  }),
  async run({ path: p, oldText, newText, replaceAll }, ctx) {
    const abs = resolveInside(ctx, p);
    const origin = await fs.readFile(abs, "utf8");

    // split+join：既能数匹配次数，又避开 String.replace 对 $ 的特殊解析
    const parts = origin.split(oldText);
    const count = parts.length - 1;
    if (count === 0) {
      return `error: 在 ${p} 没找到要替换的文本（请先 readFile 逐字确认原文）`;
    }
    if (count > 1 && !replaceAll) {
      return `error: 该文本在 ${p} 出现了 ${count} 次，无法确定改哪处（请给更长、唯一的片段，或设 replaceAll=true 全部替换）`;
    }
    await fs.writeFile(abs, parts.join(newText), "utf8");
    return `已替换 ${p} 中的 ${count} 处`;
  },
};

export const listDir: Tool<{ path?: string }> = {
  name: "listDir",
  description: "列出工作目录下某个目录的条目（目录名带尾随 /）。",
  schema: z.object({ path: z.string().optional() }),
  async run({ path: p }, ctx) {
    const entries = await fs.readdir(resolveInside(ctx, p ?? "."), { withFileTypes: true });
    return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n") || "(empty)";
  },
};
