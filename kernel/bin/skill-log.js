#!/usr/bin/env node
/**
 * skill-log.js — 给「非 DSH 宿主」（Hermes）的技能写入补一条 DSH 兼容记录。
 *
 * 为什么：DSH 的技能写入会同时落 .history/blobs + index.json + .mutations.json，
 * 而 Hermes 的 skill_manage 直接写文件、不记账，导致版本历史一半隐形（2026-11-22 实测）。
 *
 * 用法：
 *   node skill-log.js --name <skill> --action <create|update|patch|write_file|remove_file> \
 *        [--summary "一句话"] [--origin hermes] [--path references/x.md] [--root <skills 根>]
 *
 * 语义（与 @lmzhen/dsh-evolution-core 对齐）：
 *   - hash = sha256(content with CRLF→LF)，用于去重与链式 beforeHash
 *   - v = max(v)+1，不看时钟
 *   - 幂等：当前内容 hash 已在索引里 → 直接退出 0（不重复记）
 *   - .mutations.json 上限 500，超出从头裁
 *   - 不裁剪 index（DSH 自己写入时按它的 keep 裁；我们只追加）
 * 退出码：0 已记录/无需记录；1 参数错误；2 IO 错误
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i += 1; }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const root = args.root || process.env.BRAIN_SKILLS
  || path.join(process.env.BRAIN_ROOT || path.join(process.env.HOME || '', 'agent-brain'), 'skills');
const name = typeof args.name === 'string' ? args.name : '';
const action = typeof args.action === 'string' ? args.action : 'patch';
const origin = typeof args.origin === 'string' ? args.origin : 'hermes';
const relPath = typeof args.path === 'string' ? args.path : 'SKILL.md';
const summary = (typeof args.summary === 'string' ? args.summary : `hermes ${action}`).replace(/\s+/g, ' ').trim().slice(0, 50);

if (!name) { console.error('skill-log: --name is required'); process.exit(1); }

const MUTATIONS_CAP = 500;

function hashOf(content) {
  return crypto.createHash('sha256').update(content.replaceAll('\r\n', '\n')).digest('hex');
}
function readIf(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function writeAtomic(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, p);
}
/** 跨进程互斥：与 DSH 的 .locks 不同名（我们不抢它的锁），只保证自己的读改写不交错。 */
function withLock(lockPath, fn) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + 5000;
  for (;;) {
    try { fs.mkdirSync(lockPath); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() > deadline) { try { fs.rmdirSync(lockPath); } catch {} }
      else { const t = Date.now() + 25; while (Date.now() < t); }
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(lockPath); } catch {} }
}

function findSkillDir(skillName) {
  if (!fs.existsSync(root)) return null;
  const walk = (dir, depth) => {
    if (depth > 3) return null;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      if (e.name === skillName && fs.existsSync(path.join(dir, skillName, 'SKILL.md'))) return path.join(dir, skillName);
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const hit = walk(path.join(dir, e.name), depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  return walk(root, 0);
}

const dir = findSkillDir(name);
if (!dir) { console.error(`skill-log: skill not found: ${name}`); process.exit(1); }

const target = path.join(dir, relPath);
const content = readIf(target);
if (content === null) {
  // 支持文件被删除：记一条 remove_file，无内容可存
  if (action !== 'remove_file') { console.error(`skill-log: file not found: ${target}`); process.exit(1); }
}

const hash = content === null ? '' : hashOf(content);
const historyDir = path.join(root, '.history');
const indexPath = path.join(historyDir, 'skills', name, 'index.json');
const blobPath = hash ? path.join(historyDir, 'blobs', hash) : null;

let result = 'skipped';
withLock(path.join(historyDir, '.skill-log.lock'), () => {
  let index = { version: 1, versions: [] };
  const raw = readIf(indexPath);
  if (raw) { try { const p = JSON.parse(raw); if (Array.isArray(p.versions)) index = p; } catch {} }
  const versions = index.versions.filter((v) => v && typeof v.v === 'number' && typeof v.hash === 'string');

  const last = versions.length ? versions[versions.length - 1] : null;
  if (hash && versions.some((v) => v.hash === hash)) { result = 'already-recorded'; return; }

  if (hash && blobPath && !fs.existsSync(blobPath)) {
    fs.mkdirSync(path.dirname(blobPath), { recursive: true });
    fs.writeFileSync(blobPath, content);
  }

  let maxV = 0;
  for (const v of versions) if (v.v > maxV) maxV = v.v;
  const entry = {
    v: maxV + 1,
    at: new Date().toISOString(),
    action,
    hash,
    chars: content === null ? 0 : content.length,
    summary,
    origin,
  };
  if (last && last.hash) entry.beforeHash = last.hash;
  if (relPath !== 'SKILL.md') entry.path = relPath;

  versions.push(entry);
  writeAtomic(indexPath, JSON.stringify({ version: index.version || 1, versions }, null, '\t'));

  const mutPath = path.join(root, '.mutations.json');
  let mut = { version: 1, records: [] };
  const mutRaw = readIf(mutPath);
  if (mutRaw) { try { const p = JSON.parse(mutRaw); if (Array.isArray(p.records)) mut = p; } catch {} }
  const records = mut.records.slice();
  records.push({
    skillName: name,
    action,
    beforeHash: last && last.hash ? last.hash : null,
    afterHash: hash,
    beforeVersion: last ? last.v : null,
    afterVersion: entry.v,
    summary,
    at: entry.at,
    origin,
  });
  while (records.length > MUTATIONS_CAP) records.shift();
  writeAtomic(mutPath, JSON.stringify({ version: mut.version || 1, records }, null, '\t'));
  result = `recorded v${entry.v}`;
});

console.log(`skill-log: ${name} ${action} → ${result}`);
