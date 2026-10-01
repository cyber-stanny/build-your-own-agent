import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface MemoryEntry {
  key: string;
  value: string;
  category: "project" | "environment" | "command" | "preference" | "lesson";
  updatedAt: string;
}

interface MemoryFile {
  entries: MemoryEntry[];
}

const DEFAULT_LIMIT = 50;

export class MemoryStore {
  constructor(
    private filePath: string,
    private limit = DEFAULT_LIMIT,
  ) {}

  list(): MemoryEntry[] {
    return this.read().entries;
  }

  remember(input: { key: string; value: string; category: MemoryEntry["category"] }): MemoryEntry {
    const file = this.read();
    const next: MemoryEntry = {
      key: input.key.trim(),
      value: input.value.trim(),
      category: input.category,
      updatedAt: new Date().toISOString(),
    };

    const existing = file.entries.findIndex((entry) => entry.key === next.key);
    if (existing >= 0) {
      file.entries[existing] = next;
    } else {
      file.entries.push(next);
    }

    file.entries = file.entries
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, this.limit);
    this.write(file);
    return next;
  }

  formatForContext(): string {
    const entries = this.list();
    if (entries.length === 0) return "";

    const lines = entries.map((entry) => `- [${entry.category}] ${entry.key}: ${entry.value}`);
    return [
      "以下是这个 agent 已持久记住的状态。它们可能帮助你理解当前项目、环境和常用命令；如果事实已经过时，请用 remember 更新。",
      ...lines,
    ].join("\n");
  }

  private read(): MemoryFile {
    if (!existsSync(this.filePath)) return { entries: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<MemoryFile>;
      return {
        entries: Array.isArray(parsed.entries) ? parsed.entries.filter(isMemoryEntry) : [],
      };
    } catch {
      return { entries: [] };
    }
  }

  private write(file: MemoryFile): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(file, null, 2) + "\n", "utf8");
  }
}

function isMemoryEntry(value: unknown): value is MemoryEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.key === "string" &&
    typeof entry.value === "string" &&
    typeof entry.category === "string" &&
    typeof entry.updatedAt === "string"
  );
}
