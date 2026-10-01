import type { BuiltContext } from "./builder";

// context debugger：把 buildContext 的「隐形决策」打印出来。
// context 的 bug 是隐形的——模型答错了，你分不清是「没把那段放进去」还是「模型蠢」。
// 这个把"这轮放了什么/省了什么/为什么/token 多少"变可见。
export function formatContextDebug(built: BuiltContext): string {
  const lines: string[] = [];
  lines.push("┌─ context debug ─────────────");
  lines.push(`│ 发出 ${built.messages.length} 条消息 ｜ 粗估 ~${built.tokenEstimate} tokens`);
  lines.push("│ included:");
  for (const i of built.included) lines.push(`│   + ${i}`);
  if (built.omitted.length) {
    lines.push("│ omitted / 截断:");
    for (const o of built.omitted) lines.push(`│   - ${o}`);
  }
  lines.push("└─────────────────────────────");
  return lines.join("\n");
}
