# 07 · Skills —— 按需加载的「操作手册」

## 这个阶段是什么

Skill = 一个带 frontmatter（name + description）的 markdown 手册。**两级渐进式披露**：system 里只放「目录」（名字+一句话），模型判断任务匹配后才用 `load_skill` 工具把全文读进上下文。

## 相比上一阶段增加了什么

| 增加 | 为什么 |
|---|---|
| `skills/*.md` 目录约定 | 知识即文件：加技能不改代码 |
| frontmatter 解析 | name/description 是「目录页」，供模型决定要不要读 |
| 两级注入（目录 → 全文） | 解决「知识全塞 system 撑爆上下文」的问题 |
| `load_skill` 工具 | 知识加载从「人配置」变成「模型按需自取」 |

## 运行

```bash
cd mini-agent/07-skills
node agent.mjs "我想撤销最近一次 git commit"     # 匹配 git-help 技能
node agent.mjs "两周后考试，帮我做复习计划"        # 匹配 exam-prep 技能
```

（mock 模式下按关键词路由：`考试|复习|备考|期末` → exam-prep，其余 → git-help；真实模型靠语义匹配 description。）

## 示例输出（mock 模式）

```
已发现的技能:
  - exam-prep（手册 167 字符，但 system 里只放了一句话）
  - git-help（手册 426 字符，但 system 里只放了一句话）

── 运行（"两周后考试，帮我做复习计划"）──
  [工具] load_skill("exam-prep") → 注入 167 字符手册
助手: (mock) 已按《exam-prep》手册回答。要点：# 考前复习计划模板；## 三轮复习法；- 第 1 轮（剩余天数的 50%）：通读全部知识点…

── 运行（"我想撤销最近一次 git commit"）──
  [工具] load_skill("git-help") → 注入 426 字符手册
助手: (mock) 已按《git-help》手册回答。要点：# Git 日常操作手册；## 撤销最近一次 commit（保留改动）…
```

注意 system prompt 全程只多两行目录——手册正文只在被需要的那一轮进入上下文。

## 对应原项目 / 真实系统

| 本文件 | 参照 |
|---|---|
| SKILL.md 文件结构 | Claude Code 的 skill 格式（frontmatter + markdown 正文） |
| 两级披露 | 原项目工具越加越多、说明全塞 system prompt 的痛点，正是 skill 要解决的问题 |
| 为什么原项目还没有它 | 原作者规划为 v0.2 方向，v0.1 刻意不做，知识先放仓库文档里让 agent 现场读 |
| 原项目的替代形态 | 工具 description 即技能提示（`tools/fileOps.ts:40-42`）+ followup 的守则式 system prompt（`followups/agent.ts:32-40`） |

## 思考题

1. 为什么不把两个手册全文都塞进 system？（现在只有 1KB 感觉不出；50 个技能 × 2KB = 100KB，每轮都要烧钱）
2. description 写得模糊会发生什么？（模型选错技能或不敢选——和工具 description 一样，这是写给模型的「检索索引」）
3. 怎么给技能加「可执行脚本」？（真实系统里 skill 目录还可以带脚本文件，手册里指示模型用 shell 工具执行）
