import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { TimestampedEvent } from "../core/events";
import type { Message, ToolCall } from "../model/types";
import { SessionStore, type StoredSession } from "./store";

// 兼容修复前已经写下来的 runs/sess_*.jsonl。
// 只导入 SQLite 中不存在的 id，因此每次启动调用也是幂等的。
export function importLegacyJsonlSessions(store: SessionStore, runsDir: string, systemPrompt: string): number {
  if (!existsSync(runsDir)) return 0;
  let imported = 0;

  for (const fileName of readdirSync(runsDir)) {
    if (!/^sess_.+\.jsonl$/.test(fileName)) continue;
    const id = fileName.slice(0, -".jsonl".length);
    if (store.has(id)) continue;
    const events = readEvents(path.join(runsDir, fileName));
    if (events.length === 0) continue;
    store.create(toStoredSession(id, events, systemPrompt));
    imported++;
  }

  return imported;
}

function readEvents(filePath: string): TimestampedEvent[] {
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as TimestampedEvent];
      } catch {
        return []; // 宕机时最后一行可能只写了一半，不影响此前完整事件
      }
    });
}

function toStoredSession(id: string, timeline: TimestampedEvent[], systemPrompt: string): StoredSession {
  const userEvents = timeline.filter((event) => event.type === "user_message");
  const firstInput = userEvents[0]?.type === "user_message" ? userEvents[0].content : "";
  return {
    meta: {
      id,
      title: firstInput.replace(/\s+/g, " ").trim().slice(0, 24) || "历史对话",
      createdAt: timeline[0].ts,
      updatedAt: timeline.at(-1)?.ts ?? timeline[0].ts,
      messageCount: userEvents.length,
    },
    messages: rebuildTranscript(timeline, systemPrompt),
    timeline,
  };
}

function rebuildTranscript(events: TimestampedEvent[], systemPrompt: string): Message[] {
  const messages: Message[] = systemPrompt ? [{ role: "system", content: systemPrompt }] : [];
  let toolCallingAssistant: Extract<Message, { role: "assistant" }> | undefined;

  for (const event of events) {
    switch (event.type) {
      case "user_message":
        messages.push({ role: "user", content: event.content });
        toolCallingAssistant = undefined;
        break;
      case "model_response":
        toolCallingAssistant = { role: "assistant", content: event.text, toolCalls: [] };
        messages.push(toolCallingAssistant);
        break;
      case "tool_call": {
        if (!toolCallingAssistant) {
          toolCallingAssistant = { role: "assistant", content: "", toolCalls: [] };
          messages.push(toolCallingAssistant);
        }
        const call: ToolCall = { id: event.id, name: event.name, input: asToolInput(event.input) };
        toolCallingAssistant.toolCalls?.push(call);
        break;
      }
      case "tool_result":
        messages.push({ role: "tool", toolCallId: event.id, content: event.content });
        break;
      case "final_answer": {
        const last = messages.at(-1);
        if (last?.role !== "assistant" || last.content !== event.content || last.toolCalls?.length) {
          messages.push({ role: "assistant", content: event.content, toolCalls: [] });
        }
        toolCallingAssistant = undefined;
        break;
      }
    }
  }

  return messages;
}

function asToolInput(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}
