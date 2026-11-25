#!/usr/bin/env node
// skill-split.js — 把技能 SKILL.md 的 H2 章节按计划搬进 references/，正文留指针。
//
// 为什么需要它：DSH 的 skill_manage 只扫技能根下一层（55 个），
// software-development/<name> 这类嵌套技能它报「不存在」，restructure 用不了。
// 这个脚本做同一件事，但带「快照 + 标题保真检查 + dry-run」。
//
// 用法：
//   node skill-split.js --plan plan.json [--dry-run]
// plan.json:
//   {
//     "skill": "<brain>/skills/<category>/<name>",
//     "sections": [{"match": "开发 Pitfalls", "to": "references/pitfalls.md", "title": "开发踩坑记录"}],
//     "keepInSkill": ["参考文件", "当前状态"],
//     "newHeader": {"whenToUse": "...", "pointerNote": "..."}
//   }
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const planPath = args.includes('--plan') ? args[args.indexOf('--plan') + 1] : '';
const dryRun = args.includes('--dry-run');
if (!planPath) {
  console.error('用法: node skill-split.js --plan plan.json [--dry-run]');
  process.exit(2);
}
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
const SKILL_DIR = path.resolve(plan.skill);
const SRC = path.join(SKILL_DIR, 'SKILL.md');
const raw = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
const fmMatch = raw.match(/^---\n[\s\S]*?\n---\n/);
const fm = fmMatch ? fmMatch[0] : '';
const body = raw.slice(fm.length);
const lines = body.split('\n');

// 1. 切 H2
const h2At = [];
lines.forEach((l, i) => { if (/^## /.test(l)) h2At.push({ i, title: l.replace(/^## /, '').trim() }); });
if (!h2At.length) { console.error('没有 H2 章节，拒绝执行'); process.exit(3); }

const blocks = h2At.map((h, k) => ({
  title: h.title,
  start: h.i,
  end: k + 1 < h2At.length ? h2At[k + 1].i : lines.length,
}));

const preamble = lines.slice(0, h2At[0].i);
const keep = new Set(plan.keepInSkill || []);
const moves = [];
for (const spec of plan.sections || []) {
  const hit = blocks.find((b) => b.title.startsWith(spec.match));
  if (!hit) { console.error('ABORT: 找不到章节「' + spec.match + '」'); process.exit(4); }
  if (keep.has(hit.title)) { console.error('ABORT: 章节「' + hit.title + '」在 keepInSkill 里'); process.exit(5); }
  moves.push({ block: hit, to: spec.to, label: spec.title || hit.title });
}
// 同一个目标文件可以接多个章节，顺序按原文件顺序
const byFile = new Map();
for (const m of moves) {
  if (!byFile.has(m.to)) byFile.set(m.to, []);
  byFile.get(m.to).push(m);
}

// 2. 生成目标文件内容
const written = [];
for (const [to, list] of byFile) {
  const abs = path.join(SKILL_DIR, to);
  const header = `# ${list[0].label}（${path.basename(SKILL_DIR)}）\n\n> 由 SKILL.md 拆分于 ${new Date().toISOString().slice(0, 10)}，原文逐节保留。\n\n`;
  const chunks = list
    .sort((a, b) => a.block.start - b.block.start)
    .map((m) => lines.slice(m.block.start, m.block.end).join('\n').replace(/^\n+|\n+$/g, ''));
  const existed = fs.existsSync(abs);
  const text = (existed ? '' : header) + chunks.join('\n\n') + '\n';
  written.push({ to, abs, text, existed, sections: list.map((m) => m.block.title) });
}

// 3. 重建 SKILL.md：保留未被搬走的章节，被搬走的用指针替换
const movedTitles = new Set(moves.map((m) => m.block.title));
const out = [];
out.push(...preamble);
// 指针区：放在 preamble 之后
const pointerLines = [];
for (const w of written) {
  pointerLines.push(`- ${w.sections.join('、')} → ${w.to}`);
}
if (pointerLines.length) {
  out.push('## 正文位置（拆分后）');
  out.push('');
  out.push('本技能只留红线与索引；正文按类型在 `references/` 下：');
  out.push('');
  out.push(...pointerLines);
  out.push('');
  for (const w of written) out.push(`> 详见 ${w.to}`);
  out.push('');
}
for (const b of blocks) {
  if (movedTitles.has(b.title)) continue;
  out.push(...lines.slice(b.start, b.end));
}
const newBody = out.join('\n').replace(/\n{3,}/g, '\n\n');
const newFull = fm + newBody;

// 4. 保真检查：每个原始 H2 标题都要在某个产物里出现
const allOut = [newFull].concat(written.map((w) => w.text)).join('\n');
const missing = h2At.map((h) => h.title).filter((t) => !allOut.includes(t));
if (missing.length) {
  console.error('ABORT: 拆分后找不到这些章节标题：' + missing.join(' | '));
  process.exit(6);
}

if (dryRun) {
  console.log('DRY RUN —— 不写盘');
  console.log(`原 SKILL.md ${raw.length} 字符 → 预计 ${newFull.length} 字符`);
  for (const w of written) console.log(`  ${w.existed ? '追加' : '新建'} ${w.to}  ${w.text.length} 字符  ← ${w.sections.join('、')}`);
  console.log('保留在 SKILL.md：', blocks.filter((b) => !movedTitles.has(b.title)).map((b) => b.title).join('、'));
  process.exit(0);
}

// 5. 快照 + 写入
const stamp = new Date().toISOString().slice(0, 10);
const snap = path.join(path.resolve(__dirname, '..', 'migrations', `${stamp}-split-${path.basename(SKILL_DIR)}`));
fs.mkdirSync(snap, { recursive: true });
fs.cpSync(SKILL_DIR, snap, { recursive: true });
for (const w of written) {
  fs.mkdirSync(path.dirname(w.abs), { recursive: true });
  if (w.existed) fs.appendFileSync(w.abs, '\n' + w.text, 'utf8');
  else fs.writeFileSync(w.abs, w.text, 'utf8');
}
fs.writeFileSync(SRC, newFull, 'utf8');
console.log(`OK  ${path.basename(SKILL_DIR)}: SKILL.md ${raw.length} → ${newFull.length} 字符；快照 ${snap}`);
for (const w of written) console.log(`  ${w.to}  ${fs.statSync(w.abs).size} 字节  ← ${w.sections.join('、')}`);
