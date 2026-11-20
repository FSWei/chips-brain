#!/usr/bin/env bash
# 冒烟测试：在临时目录里从零装一遍，验证"能装、能写、能拦"。
# 用法: ./tests/smoke.sh [repo-root]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BRAIN="$(mktemp -d)"
trap 'rm -rf "$BRAIN"' EXIT

mkdir -p "$BRAIN/.brain/bin" "$BRAIN/memories" "$BRAIN/skills/demo"
cp "$ROOT/kernel/bin/brain.js" "$ROOT/kernel/bin/policy.js" "$BRAIN/.brain/bin/"
cp "$ROOT/kernel/rules.example.yaml" "$BRAIN/.brain/rules.yaml"
printf -- '---\nname: demo\ndescription: smoke\n---\n' > "$BRAIN/skills/demo/SKILL.md"
: > "$BRAIN/memories/MEMORY.md"
: > "$BRAIN/memories/USER.md"

export BRAIN_ROOT="$BRAIN" BRAIN_AGENT=smoke
B="$BRAIN/.brain/bin/brain.js"
pass=0; fail=0
ok()   { echo "  PASS  $1"; pass=$((pass+1)); }
bad()  { echo "  FAIL  $1"; fail=$((fail+1)); }

echo "== 1. 合法写入 =="
out=$(node "$B" append --file MEMORY --text "冒烟条目：demo 说明见 skill demo")
echo "$out" | grep -q '"ok": true' && ok "append valid" || bad "append valid: $out"

echo "== 2. 结构化批量被拒 =="
if node "$B" append --file MEMORY --text $'- 第一行\n- 第二行\n- 第三行' >/tmp/smoke_bad.json 2>&1; then
  bad "structured should be rejected"
else
  grep -q 'structured_content' /tmp/smoke_bad.json && ok "structured rejected" || bad "wrong reason"
fi

echo "== 3. 死引用被拒 =="
if node "$B" check --file MEMORY --text "说明见 skill no-such-skill" | grep -q 'dead_reference'; then
  ok "dead reference rejected"
else
  bad "dead reference not rejected"
fi

echo "== 4. 预算与条数 =="
node "$B" status --file MEMORY | grep -q '"entries": 1' && ok "status entries=1" || bad "status mismatch"

echo "== 5. pending 落盘 =="
node "$B" pending | grep -q '"count": 1' && ok "pending recorded" || bad "pending missing"

echo "== 6. 归档路径（压满预算后写入）=="
python3 - "$BRAIN" <<'PY' 2>/dev/null || true
import sys
p = sys.argv[1] + "/memories/MEMORY.md"
filler = ("填充" * 80 + "，见 skill demo")
open(p, "w", encoding="utf-8").write("\n§\n".join([filler] * 20) + "\n")
PY
node "$B" append --file MEMORY --text "超限写入：应触发归档，见 skill demo" | grep -q '"ok": true' \
  && test -f "$BRAIN/memories/archive/MEMORY-archive.md" \
  && ok "archive on overflow" || bad "archive not triggered"

echo
echo "结果: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
