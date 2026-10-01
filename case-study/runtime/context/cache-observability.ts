import { createHash } from "node:crypto";
import type { Message, ToolSchema } from "../model/types";

export interface PromptFingerprint {
  promptHash: string;
  prefixHash: string;
  toolsHash: string;
  memoryHash?: string;
}

export interface PromptCacheObservation extends PromptFingerprint {
  sharedPrefixMessages?: number;
  sharedPrefixTokenEstimate?: number;
}

export function fingerprintPrompt(
  messages: Message[],
  tools: ToolSchema[],
  memoryText?: string,
): PromptFingerprint {
  const systemMessages = messages.filter((message) => message.role === "system");
  const toolsHash = hashValue(tools);
  return {
    promptHash: hashValue({ messages, tools }),
    prefixHash: hashValue({ systemMessages, tools }),
    toolsHash,
    memoryHash: memoryText?.trim() ? hashValue(memoryText.trim()) : undefined,
  };
}

export function countSharedPrefixMessages(previous: Message[], current: Message[]): number {
  const max = Math.min(previous.length, current.length);
  let count = 0;
  while (count < max && JSON.stringify(previous[count]) === JSON.stringify(current[count])) count++;
  return count;
}

function hashValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}
