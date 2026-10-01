import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import OpenAI from "openai";
import type { Tool } from "./types";
import { appConfig } from "../config";

// 根据文件扩展名推断 MIME 类型
function mimeFromExt(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".tiff": "image/tiff",
    ".tif": "image/tiff",
  };
  return mimeMap[ext] ?? "image/png";
}

// 把相对路径锁在 workingDir 内（与 fileOps.ts 中一致）
function resolveInside(ctx: { workingDir: string }, p: string): string {
  const root = path.resolve(ctx.workingDir);
  const abs = path.resolve(root, p);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`path escapes workingDir: ${p}`);
  }
  return abs;
}

export const analyzeImage: Tool<{ path: string }> = {
  name: "analyzeImage",
  description:
    "读取一张图片（PNG/JPG/WEBP 等），调用多模态大模型理解其内容，返回详细的文字描述。" +
    "当你需要知道图片里有什么（物体、文字、图表、代码、UI 界面等）时调用这个工具。",
  schema: z.object({
    path: z
      .string()
      .describe("图片路径，相对工作目录。例如 uploads/screenshot.png"),
  }),
  async run({ path: p }, ctx) {
    // 1) 构建完整路径并读取图片
    const absPath = resolveInside(ctx, p);
    const mime = mimeFromExt(absPath);

    let imageBase64: string;
    try {
      const buffer = readFileSync(absPath);
      imageBase64 = buffer.toString("base64");
    } catch (err) {
      return `error: 无法读取图片文件 "${p}"：${(err as Error).message}`;
    }

    // 2) 检查 API Key 是否已配置
    const { apiKey, baseUrl, model } = appConfig.siliconflow;
    if (!apiKey) {
      return "error: 硅基流动 API Key 未配置，请在 .env 中设置 SILICONFLOW_API_KEY";
    }

    // 3) 调用硅基流动的多模态模型（兼容 OpenAI SDK 格式）
    const client = new OpenAI({
      apiKey,
      baseURL: baseUrl,
    });

    try {
      const res = await client.chat.completions.create({
        model,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "请详细描述这张图片中的内容，包括：物体、人物、文字、颜色、布局、图表数据等一切可见信息。如果图片中有代码或文字，请完整转录。",
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:${mime};base64,${imageBase64}`,
                },
              },
            ],
          },
        ],
        max_tokens: 2048,
      });

      const description = res.choices?.[0]?.message?.content ?? "";
      if (!description) {
        return "（多模态模型返回了空描述）";
      }

      return description;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `error: 调用硅基流动多模态模型失败：${msg}`;
    }
  },
};
