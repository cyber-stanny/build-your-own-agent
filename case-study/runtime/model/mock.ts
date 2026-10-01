import type { ModelClient, ModelResponse, Message, ToolSchema } from "./types";

// MockModelClient：不真正调用大模型，而是按「剧本」返回固定的工具调用序列。
// 为什么第 1 周就要它？
//   1) 没有 API key 也能把 loop 跑起来、亲眼看清机制；
//   2) 以后做 replay / 测试时，必须能用确定、可重复的「假模型」，否则每次结果都不一样，没法回归。
// 下面这个剧本演示了一个最小多步流程：写文件 → 运行它 → 给最终答案。
export class MockModelClient implements ModelClient {
  name = "mock";
  private turn = 0;

  async complete(_messages: Message[], _tools: ToolSchema[], _signal?: AbortSignal): Promise<ModelResponse> {
    this.turn++;

    if (this.turn === 1) {
      // 第 1 轮：决定写一个 hello.js
      return {
        text: "我先写一个 hello.js。",
        toolCalls: [
          {
            id: "call_1",
            name: "writeFile",
            input: { path: "hello.js", content: "console.log('hello from the agent loop')" },
          },
        ],
      };
    }

    if (this.turn === 2) {
      // 第 2 轮：看到「写好了」的 observation 后，决定运行它
      return {
        text: "写好了，运行看看。",
        toolCalls: [{ id: "call_2", name: "runShell", input: { command: "node hello.js" } }],
      };
    }

    // 第 3 轮：没有 toolCalls = 收尾，给最终答案
    return {
      text: "完成：已创建 hello.js 并成功运行，输出 hello from the agent loop。",
      toolCalls: [],
    };
  }
}
