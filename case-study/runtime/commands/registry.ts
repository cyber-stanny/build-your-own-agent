export type ParsedCommand = {
  name: string;
  args: string[];
  raw: string;
};

export type CommandMeta = {
  command: string;
  label: string;
  usage?: string;
};

export const COMMANDS: CommandMeta[] = [
  { command: "/new", label: "开启新对话" },
  { command: "/sessions", label: "查看/切换历史对话" },
  { command: "/session", label: "切换到指定会话", usage: "/session <sessionId>" },
  { command: "/compact", label: "压缩当前对话历史" },
  { command: "/stop", label: "终止当前任务" },
];

export function parseCommand(raw: string): ParsedCommand {
  const trimmed = raw.trim();
  const [name = "", ...args] = trimmed.split(/\s+/);
  return { name, args, raw: trimmed };
}
