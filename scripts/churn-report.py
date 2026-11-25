#!/usr/bin/env python3
"""技能改动体检（护栏配套）：统计近 N 小时每个技能的写入次数与"整篇重写"迹象。

口径：
  - 数据源 skills/.mutations.json（DSH + Hermes 共写）
  - 只看 origin 为 background_review / hermes / foreground 的记录，按 skillName 计数
  - "整篇重写"迹象：相邻两版 chars 变化 >40%，或索引里出现 chars < 原 40% 的深谷
  - 阈值：24h 内同一技能后台写入 >= 6 次 → WARN；>= 15 次 → ALERT

用法：
  python3 churn-report.py [--hours 24] [--root <brain>/skills] [--json]
退出码：0 正常，1 有 ALERT（便于 cron 直接看状态）
"""
import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone

DEFAULT_ROOT = os.path.join(os.environ.get("BRAIN_ROOT") or os.path.expanduser("~/agent-brain"), "skills")
WARN = 6
ALERT = 15


def load(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return {}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=int, default=24)
    ap.add_argument("--root", default=os.environ.get("BRAIN_SKILLS", DEFAULT_ROOT))
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    root = args.root
    data = load(os.path.join(root, ".mutations.json"))
    records = data.get("records", []) if isinstance(data, dict) else []
    cutoff = datetime.now(timezone.utc) - timedelta(hours=args.hours)

    def ts(rec):
        try:
            return datetime.fromisoformat(rec["at"].replace("Z", "+00:00"))
        except Exception:
            return None

    recent = [r for r in records if (ts(r) or cutoff) >= cutoff]

    per_skill = {}
    origins = {}
    for r in recent:
        name = r.get("skillName", "?")
        per_skill.setdefault(name, []).append(r)
        origins[r.get("origin") or "unknown"] = origins.get(r.get("origin") or "unknown", 0) + 1

    rows = []
    alerts = 0
    for name, recs in sorted(per_skill.items(), key=lambda kv: -len(kv[1])):
        bg = [r for r in recs if r.get("origin") == "background_review"]
        index = load(os.path.join(root, ".history", "skills", name, "index.json"))
        versions = index.get("versions", []) if isinstance(index, dict) else []
        chars = [(v.get("v"), v.get("chars")) for v in versions if v.get("v") and v.get("chars")]
        rewrite = 0
        for (v1, c1), (v2, c2) in zip(chars, chars[1:]):
            if c1 and c2 and abs(c2 - c1) / max(c1, c2) > 0.4:
                rewrite += 1
        level = "ALERT" if len(bg) >= ALERT else ("WARN" if len(bg) >= WARN else "ok")
        if level != "ok":
            alerts += 1
        rows.append({
            "skill": name,
            "writes": len(recs),
            "background": len(bg),
            "versions_kept": len(versions),
            "big_swings": rewrite,
            "level": level,
        })

    if args.json:
        print(json.dumps({"hours": args.hours, "origins": origins, "rows": rows}, ensure_ascii=False, indent=2))
    else:
        print(f"技能改动体检 · 近 {args.hours} 小时 · root={root}")
        print(f"记录数 {len(recent)} | origin 分布 {origins}")
        print(f"{'技能':40s} {'写入':>4} {'后台':>4} {'留版':>4} {'大幅波动':>6}  状态")
        for r in rows:
            print(f"{r['skill']:40s} {r['writes']:4d} {r['background']:4d} {r['versions_kept']:4d} {r['big_swings']:6d}  {r['level']}")
        if alerts:
            print(f"\n⚠ {alerts} 个技能超过阈值（WARN>={WARN}/24h，ALERT>={ALERT}/24h）——建议上护栏或人工复核")
        else:
            print("\n✓ 无异常")
    return 1 if alerts else 0


if __name__ == "__main__":
    sys.exit(main())
