# Case Study · 读一个真实的 Coding Agent

`mini-agent/` 教你从零写一个 agent；这里反过来——拿一个**真实在用的** agent 拆开读，看生产代码比教学版多了哪些工程层。

研究对象是 `my-agent-runtime`：一个个人自用的网页编码助手。浏览器通过 WebSocket 连到服务器上的 agent 进程，agent 在服务器本地读写文件、跑命令、提交 PR。

## 目录

| 路径 | 内容 |
|---|---|
| [guide/](guide/) | 13 篇源码阅读指南，从总览、loop、context、工具一路到完整调用链。**从 [00-overview](guide/00-overview.md) 开始，或按 [12-reading-roadmap](guide/12-reading-roadmap.md) 安排时间** |
| [runtime/](runtime/) | agent 后端（TypeScript/Node）：loop、模型适配、工具、权限、session、memory、后台 followup agent |
| [web/](web/) | 网页终端前端（Vite + React）。指南只在讲协议时提到它 |
| [AGENTS.md](AGENTS.md) | 给 agent 看的仓库规则（PR 工作流、Review 结束条件），指南 07/08/10 会引用 |
| [docs/plans/](docs/plans/) | PR Review 自动跟进功能的设计文档 |

指南里写的 `core/loop.ts:147`、`runtime/tools/shell.ts` 这类路径，都相对于本目录下的 `runtime/`。

## 这是一份冻结快照

- 代码固定在原项目 commit `e6714dd`（2026-08-02），**指南里的每个行号都以这份快照为准**。原项目之后的改动不会同步过来，所以行号不会漂移。
- 快照只做了脱敏，没改任何逻辑：删除了服务器部署记录；`tools/deploy.ts` 及其测试里的真实服务器路径换成了 `/srv/agent-runtime`（行数不变）；`AGENTS.md` 去掉了与原作者个人学习流程有关的段落。
- 部署相关的工具（`deployMain`）在这份快照里只适合阅读，不要直接运行。

## 运行

需要 Node 20+。

```bash
cd case-study/runtime
npm ci
npm test                                   # 73 个测试
npm run typecheck
npm run agent -- --mock "写一个 hello.js 并运行"   # mock 模型，不需要 API key
```

mock 模型按固定剧本走完「写文件 → 运行 → 给最终答案」三轮，用来观察 loop 和事件流，不会理解你输入的任务。

接真实模型、启动 web 服务的配置见 [runtime/README.md](runtime/README.md) 和 `runtime/.env.example`。
