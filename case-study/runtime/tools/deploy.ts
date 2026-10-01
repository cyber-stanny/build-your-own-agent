import { z } from "zod";
import type { Tool } from "./types";
import { runCommand } from "./exec";

const deployMainSchema = z.object({
  mode: z
    .enum(["prepare", "reload-only"])
    .describe("prepare=拉取 GitHub main、检查、构建并停在 reload 前；reload-only=只执行 PM2 reload"),
});

export type DeployMainInput = z.infer<typeof deployMainSchema>;

export type DeployCommandRunner = (command: string, cwd: string, timeoutMs: number) => Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

export function createDeployMainTool(
  runner: DeployCommandRunner = (command, cwd, timeoutMs) => runCommand(command, cwd, timeoutMs),
): Tool<DeployMainInput> {
  return {
    name: "deployMain",
    description:
      "受控部署工具。仅在用户明确要求部署已合并到 GitHub main 的代码时使用。prepare 会执行固定部署脚本并停在 PM2 reload 前；reload-only 只在用户确认 reload 后使用。不要用 runShell 部署生产目录。",
    schema: deployMainSchema,
    async run(input) {
      const appDir = "/srv/agent-runtime";
      const command =
        input.mode === "reload-only"
          ? [
              "bash",
              "-lc",
              JSON.stringify(
                [
                  "nohup",
                  "bash",
                  "-lc",
                  "'sleep 1; cd /srv/agent-runtime && scripts/deploy-server.sh --reload-only >/tmp/agent-runtime-reload.log 2>&1'",
                  ">/dev/null",
                  "2>&1",
                  "&",
                  'echo "PM2 reload 已在后台排队执行；日志见 /tmp/agent-runtime-reload.log"',
                ].join(" "),
              ),
            ].join(" ")
          : "scripts/deploy-server.sh";
      const result = await runner(command, appDir, input.mode === "reload-only" ? 60_000 : 10 * 60_000);
      return [
        `mode: ${input.mode}`,
        `exit_code: ${result.exitCode}`,
        result.stdout && `stdout:\n${truncate(result.stdout)}`,
        result.stderr && `stderr:\n${truncate(result.stderr)}`,
      ]
        .filter(Boolean)
        .join("\n");
    },
  };
}

function truncate(text: string, maxChars = 20_000): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n...<truncated>` : text;
}
