# Build Your Own Agent

从零理解 AI Agent：先亲手写一个，再用它讲清常见设计模式，最后拆开一个真实的 coding agent 看它多了什么。

- **不需要 API Key**：所有示例都内置 Mock LLM，克隆下来就能跑；想看真实模型行为时再配一个 OpenAI 兼容的 key。
- **零依赖起步**：`mini-agent/` 和 `patterns/` 都是单文件 `.mjs`，只用 Node 内置模块，打开就能读完。
- **有真实对照**：每个教学实现都标注了它在真实项目里对应的源码位置。

## 三条线

| 目录 | 回答的问题 | 内容 |
|---|---|---|
| [mini-agent/](mini-agent/) | Agent 内部**是怎么运转的**？ | 10 个阶段从零实现：对话 → loop → 工具 → context → session → memory → skills → sub-agent → compaction → 总装 |
| [patterns/](patterns/) | 用 agent 做事有哪些**常见模式**？ | 10 个场景 Demo，每个突出 1～2 个模式：意图路由、结构化输出、流水线、测试驱动修复、检索引用、代码即工具、反思、规划、多 agent 协作 |
| [case-study/](case-study/) | 真实的 agent **比教学版多了什么**？ | 一个在用的网页编码助手的源码快照 + 13 篇对着行号读的源码指南 |

三条线怎么穿插着学，见 **[COURSE_MAP.md](COURSE_MAP.md)**：一条从简单到综合的 18 步路线，附课堂流程和备课速查表。

## 快速开始

需要 Node 20.11+。

```bash
git clone <this-repo> && cd build-your-own-agent

# 最小的 agent loop
cd mini-agent/02-agent-loop && node agent.mjs

# 一个会自己跑测试、看报错、修代码的 coding agent
cd ../../patterns/coding-agent && node agent.mjs
```

切换真实模型（任意 OpenAI 兼容服务，默认 DeepSeek）：

```bash
export MINI_AGENT_API_KEY=sk-...
export MINI_AGENT_BASE_URL=https://api.deepseek.com   # 可选
export MINI_AGENT_MODEL=deepseek-chat                 # 可选
```

## 怎么学

- **只想弄懂原理**：按顺序读 `mini-agent/01` → `10`，每个阶段的 README 都说明了比上一阶段多了什么。
- **想做出能用的东西**：先学 mini-agent 01～03，再挑 `patterns/` 里和你场景接近的 Demo 动手改，每个 Demo 的 README 末尾都有扩展作业。
- **想看工业级实现**：学完 mini-agent 后读 `case-study/guide/`，对比教学版省掉了哪些工程细节。

注意：`mini-agent/` 的 01～09 是**机制切片**，每个阶段只保留讲清该机制所需的最少代码，不是同一个程序逐层叠加；真正的组合在 `10-complete-agent`。

## 自检

```bash
bash scripts/verify.sh   # 离线跑全部示例和回归场景（mock 模式）
```

## 规划中

- **知识库 / RAG**：切块、embedding、向量检索，以及「检索后注入」和「检索作为工具」的对比
- **框架篇**：用主流 agent 框架重写同一个 agent，和手写版逐行对照，看框架替你做了什么

## License

[MIT](LICENSE)
