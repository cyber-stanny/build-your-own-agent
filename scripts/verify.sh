#!/usr/bin/env bash
# scripts/verify.sh —— 教学产物的离线验收（mock 模式，无需 API key）
#
# 用法：bash scripts/verify.sh
# 覆盖：mini-agent 10 阶段、patterns 10 个 Demo，以及历史上发现过问题的回归场景。
# case-study/runtime 自身的测试不在本脚本范围（见 case-study/README.md）。
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0; FAIL=0

ok()  { echo "PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }
check() { if [ "$1" -eq 0 ]; then ok "$2"; else bad "$2"; fi; }

# ── 1. mini-agent 全部 10 阶段默认运行 ──
for d in "$ROOT"/mini-agent/0*/ "$ROOT"/mini-agent/10*/; do
  name="mini-agent/$(basename "$d")"
  if (cd "$d" && node agent.mjs demo >/dev/null 2>&1) || (cd "$d" && node agent.mjs >/dev/null 2>&1) \
     || (cd "$d" && node agent.mjs "冒烟测试任务" >/dev/null 2>&1); then ok "$name"; else bad "$name"; fi
done

# ── 2. patterns 全部 10 个默认运行 ──
for d in "$ROOT"/patterns/*/; do
  [ -f "$d/agent.mjs" ] || continue
  name="patterns/$(basename "$d")"
  if (cd "$d" && node agent.mjs >/dev/null 2>&1); then ok "$name"; else bad "$name"; fi
done

# ── 3. 回归场景──
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# R1: 10-complete-agent mock 分支：3 轮 + /compact 不崩溃且完成压缩
OUT=$(printf '第一轮\n第二轮\n第三轮\n/compact\n/exit\n' \
  | env -u MINI_AGENT_API_KEY -u OPENAI_API_KEY node "$ROOT/mini-agent/10-complete-agent/agent.mjs" 2>&1)
CODE=$?
if [ $CODE -eq 0 ] && ! echo "$OUT" | grep -q "TypeError" && echo "$OUT" | grep -q "压缩完成"; then
  ok "R1 compact(mock): 三轮历史压缩成功且无 TypeError"
else
  bad "R1 compact(mock): exit=$CODE $(echo "$OUT" | tail -2)"
fi

# R2: 10-complete-agent 真实 API 分支：本地 stub 服务器，不联网
node -e 'require("http").createServer((req,res)=>{let b="";req.on("data",c=>b+=c);req.on("end",()=>{res.setHeader("content-type","application/json");res.end(JSON.stringify({choices:[{message:{content:"(stub)",tool_calls:[]}}]}))})}).listen(8123)' & STUB=$!
sleep 0.6
OUT=$(printf '第一轮\n第二轮\n第三轮\n/compact\n/exit\n' \
  | env MINI_AGENT_API_KEY=fake-key MINI_AGENT_BASE_URL=http://127.0.0.1:8123 \
    node "$ROOT/mini-agent/10-complete-agent/agent.mjs" 2>&1)
CODE=$?
kill $STUB 2>/dev/null
wait $STUB 2>/dev/null # 吞掉 job 被 SIGTERM 的提示，保持输出干净
if [ $CODE -eq 0 ] && ! echo "$OUT" | grep -q "TypeError" && echo "$OUT" | grep -q "压缩完成"; then
  ok "R2 compact(API 分支): stub 服务器下压缩成功"
else
  bad "R2 compact(API 分支): exit=$CODE $(echo "$OUT" | tail -2)"
fi

# R3: 05-session resume 在 stdin EOF 时干净退出（不带 exit 命令）
( cd "$ROOT/mini-agent/05-session" && node agent.mjs demo >/dev/null 2>&1 )
SID=$(ls "$ROOT/mini-agent/05-session/sessions" 2>/dev/null | sed 's/\.json//' | head -1)
if [ -n "${SID:-}" ]; then
  printf '我叫什么？\n' | node "$ROOT/mini-agent/05-session/agent.mjs" resume "$SID" >/dev/null 2>&1
  check $? "R3 session resume: stdin EOF 干净退出（exit 0）"
else
  bad "R3 session resume: 没有可用的测试会话"
fi

# R4: file-organizer 三轮压力测试：用户同名新文件内容不丢、每份文件唯一（临时副本）
cp -r "$ROOT/patterns/file-organizer-agent" "$TMP/fo"
(cd "$TMP/fo" && node agent.mjs >/dev/null 2>&1)
echo "新清单必须保留" > "$TMP/fo/messy-files/买菜清单.txt"
(cd "$TMP/fo" && node agent.mjs >/dev/null 2>&1)
(cd "$TMP/fo" && node agent.mjs >/dev/null 2>&1)
USER_OK=$(grep -rl "新清单必须保留" "$TMP/fo/messy-files" 2>/dev/null | wc -l | tr -d ' ')
DUP=$(find "$TMP/fo/messy-files" -name "买菜清单.txt" 2>/dev/null | wc -l | tr -d ' ')
if [ "$USER_OK" -ge 1 ] && [ "$DUP" -eq 1 ]; then
  ok "R4 file-organizer: 用户新文件内容保留且全树无重复副本"
else
  bad "R4 file-organizer: 用户内容丢失($USER_OK)或出现重复副本($DUP)"
fi

# R5: data-analysis 报告跟随真实工具输出（变异 CSV：单条华北 100）
cp -r "$ROOT/patterns/data-analysis-agent" "$TMP/da"
printf 'date,region,amount\n2026-01,华北,100\n' > "$TMP/da/workspace/data.csv"
(cd "$TMP/da" && rm -f workspace/report.md && node agent.mjs >/dev/null 2>&1)
if grep -q "华北：100 元，占 100.0%" "$TMP/da/workspace/report.md" 2>/dev/null \
   && grep -q "共 1 条销售记录" "$TMP/da/workspace/report.md" 2>/dev/null; then
  ok "R5 data-analysis: 变异数据下报告跟随真实计算结果"
else
  bad "R5 data-analysis: 报告数字未跟随变异数据"
fi

# R6: plan-execute 连续两次运行都触发重规划（自动重置演示文件）
(cd "$ROOT/patterns/plan-execute-agent" && node agent.mjs >/dev/null 2>&1)
N1=$(cd "$ROOT/patterns/plan-execute-agent" && node agent.mjs 2>&1 | grep -c "重规划")
(cd "$ROOT/patterns/plan-execute-agent" && node agent.mjs >/dev/null 2>&1)
N2=$(cd "$ROOT/patterns/plan-execute-agent" && node agent.mjs 2>&1 | grep -c "重规划")
if [ "${N1:-0}" -ge 2 ] && [ "${N2:-0}" -ge 2 ]; then
  ok "R6 plan-execute: 连续运行均完整演示失败→重规划"
else
  bad "R6 plan-execute: 第二次运行未触发重规划（n1=$N1 n2=$N2）"
fi

# R7: 07-skills 按任务关键词路由技能
P1=$(cd "$ROOT/mini-agent/07-skills" && node agent.mjs "两周后考试，帮我做复习计划" 2>&1 | grep -c "exam-prep")
P2=$(cd "$ROOT/mini-agent/07-skills" && node agent.mjs "我想撤销最近一次 git commit" 2>&1 | grep -c "git-help")
if [ "${P1:-0}" -ge 1 ] && [ "${P2:-0}" -ge 1 ]; then
  ok "R7 skills: 不同任务输入路由到不同技能"
else
  bad "R7 skills: 关键词路由失效（exam=$P1 git=$P2）"
fi

# R8: research-agent 对不同问题读对应文档
P3=$(cd "$ROOT/patterns/research-agent" && node agent.mjs "tool calling 的三次握手是什么？" 2>&1 | grep -c "tool-calling.md")
if [ "${P3:-0}" -ge 1 ]; then
  ok "R8 research: 提问变化时检索词与文档跟随变化"
else
  bad "R8 research: 仍固定检索 RAG"
fi

# R9: resume-agent 依次演示解析失败→Schema 元素失败→成功
OUT=$(cd "$ROOT/patterns/resume-agent" && node agent.mjs 2>&1)
if echo "$OUT" | grep -q "不是合法 JSON" && echo "$OUT" | grep -q "experiences 必须是字符串数组" && echo "$OUT" | grep -q "合法结构化结果"; then
  ok "R9 resume: 三类故障与校验重试路径完整可见"
else
  bad "R9 resume: 校验重试路径不符合预期"
fi

echo "──────────────────────────────"
echo "验收结果: $PASS 通过, $FAIL 失败"
[ "$FAIL" -eq 0 ]
