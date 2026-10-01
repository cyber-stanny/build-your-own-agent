import { readFileSync } from "node:fs";
import { printEvent, type AgentEvent } from "../core/events";

// replay：把一次 run 的 JSONL 事件按顺序重新打印出来。
// 第 1 周它只是「重放日志」；但这就是以后做调试 / eval 的入口——
// 因为事件里完整记着每一次 model 请求、每一次 tool 结果，你能精确复现「当时发生了什么」。
const file = process.argv[2];
if (!file) {
  console.error("用法: npm run replay -- runs/<某次>.jsonl");
  process.exit(1);
}

const lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
console.log(`\n回放 ${file} （共 ${lines.length} 个事件）\n`);
for (const raw of lines) {
  const ev = JSON.parse(raw) as AgentEvent;
  printEvent(ev);
}
