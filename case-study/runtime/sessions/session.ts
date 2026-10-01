import type { Message } from "../model/types";

// ┌─ Session：一条持续的对话线 ───────────────────────────────────────────┐
// 它持有 transcript（完整历史），跨多个 run 不断累积——这就是「多轮」的本质：
// 用户第二次提问时，之前的历史还在 session.messages 里，会被一起带上。
//
// 三层：session（持有 transcript，跨 run）> run（一条用户消息→loop 跑完）> turn（一次模型调用）。
// Session 本身仍是 loop 使用的内存对象；web server 通过 sessions/store.ts
// 在每次 transcript 变化后 checkpoint 到 SQLite，从而支持重启恢复。

export interface Session {
  id: string;
  messages: Message[]; // 持久 transcript，跨 run 累积
}

export function createSession(id: string, systemPrompt?: string): Session {
  const messages: Message[] = [];
  // system 只在建会话时放一次（不是每个 run 放一次）
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  return { id, messages };
}
