#!/usr/bin/env node
// agent-brain CLI — Hermes 与 DSH 共用的唯一写入路径
// 用法: node brain.js <status|check|append|applyOps|replace|remove|list|search|pending|resolve|audit|doctor> [...]
// 依赖: 仅 node 内置模块（不装任何包，两个宿主都能直接跑）
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = process.env.BRAIN_ROOT || path.resolve(__dirname, '..', '..');
// 2026-11-24：未显式指定 agent 时记 cli，不再写 unknown（unknown 无法追溯是谁改的）
const AGENT = () => process.env.BRAIN_AGENT || 'cli';

// ---------------------------------------------------------------- YAML 子集
function parseYaml(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  let i = 0;

  const scalar = (v) => {
    v = v.trim();
    if (v === '') return '';
    const quoted = (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"));
    if (!quoted) v = v.replace(/\s+#.*$/, '');
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      return v.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"');
    }
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (/^-?\d+$/.test(v)) return Number(v);
    return v;
  };

  function parseBlock(indent) {
    const obj = {};
    while (i < lines.length) {
      const raw = lines[i];
      const ind = raw.match(/^ */)[0].length;
      if (ind < indent) break;
      const line = raw.trim();
      if (line.startsWith('- ')) break;
      const m = line.match(/^([A-Za-z0-9_.\-]+):\s*(.*)$/);
      if (!m) throw new Error('brain: 无法解析 yaml 行: ' + line);
      const [, key, rest] = m;
      i++;
      if (rest === '') {
        const next = lines[i];
        const nind = next ? next.match(/^ */)[0].length : -1;
        if (next && nind > ind && next.trim().startsWith('- ')) {
          const arr = [];
          while (i < lines.length) {
            const r = lines[i];
            const ni = r.match(/^ */)[0].length;
            if (ni <= ind || !r.trim().startsWith('- ')) break;
            arr.push(scalar(r.trim().slice(2)));
            i++;
          }
          obj[key] = arr;
        } else {
          obj[key] = parseBlock(nind > ind ? nind : ind);
        }
      } else {
        obj[key] = scalar(rest);
      }
    }
    return obj;
  }

  return parseBlock(0);
}

// ---------------------------------------------------------------- 基础
const RULES = (() => {
  const p = path.join(ROOT, '.brain', 'rules.yaml');
  return parseYaml(fs.readFileSync(p, 'utf8'));
})();

const SEP = RULES.separator;
const SEP_RE = /\r?\n\u00a7\r?\n/;          // 兼容 CRLF 的条目分隔
const LOCK_DIR = path.join(ROOT, RULES.lock.dir);
const AUDIT = path.join(ROOT, RULES.audit);
const FORBID = (RULES.forbid_patterns || []).map((s) => new RegExp(s));

const cpLen = (s) => Array.from(s).length;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
class BrainError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; this.extra = extra; }
}
const die = (code, message, extra = {}) => { throw new BrainError(code, message, extra); };

function resolveFile(alias) {
  const key = alias.endsWith('.md') ? alias : alias.toUpperCase() + '.md';
  const cfg = RULES.files[key];
  if (!cfg) die('unknown_file', `未知文件 ${key}，可选: ${Object.keys(RULES.files).join(', ')}`);
  return { key, cfg, abs: path.join(ROOT, cfg.path) };
}

function readEntries(abs) {
  const raw = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
  const entries = raw.split(SEP_RE).map((s) => s.trim()).filter(Boolean);
  return { raw, entries };
}

// 权威口径：配额 = 条目 join 长度，不含文件末尾换行（2026-11-24 统一，与 validate 同源）
function usage(abs, cfg) {
  const { entries } = readEntries(abs);
  const len = cpLen(entries.join(SEP));
  return { chars: len, limit: cfg.char_limit, remaining: cfg.char_limit - len, entries: entries.length };
}

function acquireLock() {
  const staleMs = (RULES.lock.stale_seconds || 60) * 1000;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(LOCK_DIR, { recursive: false });
      fs.writeFileSync(path.join(LOCK_DIR, 'owner'), JSON.stringify({ pid: process.pid, agent: AGENT(), ts: Date.now() }));
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = fs.statSync(LOCK_DIR);
        if (Date.now() - st.mtimeMs > staleMs) { fs.rmSync(LOCK_DIR, { recursive: true, force: true }); continue; }
      } catch { /* 锁刚被别人释放 */ }
      sleep(50);
    }
  }
  throw new Error('brain: 锁超时（5s），可能有另一个 agent 正在写');
}

function releaseLock() {
  try { fs.rmSync(LOCK_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

function atomicWrite(abs, content) {
  const tmp = abs + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, abs);
}

function audit(action, detail) {
  try {
    fs.mkdirSync(path.dirname(AUDIT), { recursive: true });
    fs.appendFileSync(AUDIT, JSON.stringify({ ts: new Date().toISOString(), agent: AGENT(), action, ...detail }) + '\n');
  } catch { /* 审计失败不能影响主流程 */ }
}

function normalize(s) {
  return s.replace(/[\s，。、；：！？,.;:!?（）()\[\]"'“”‘’]/g, '').toLowerCase();
}

const policy = require(path.join(__dirname, 'policy.js'));

function policyOpts(cfg, existing) {
  const shapes = RULES.shapes || {};
  const ptr = RULES.pointer || {};
  return {
    maxLen: cfg.entry_max,
    shortFactMax: Number(cfg.short_fact_max != null ? cfg.short_fact_max : (shapes.short_fact_max || 80)),
    skillsRoot: path.join(ROOT, 'skills'),
    brainRoot: ROOT,
    pointerRoots: Array.isArray(ptr.roots) && ptr.roots.length ? ptr.roots : undefined,
    existingEntries: existing,
  };
}

function validate(text, cfg, existing, opts = {}) {
  if (!text || !text.trim()) die('empty', '内容为空');
  const t = text.trim();
  if (cpLen(t) > cfg.entry_max) {
    die('too_long', `单条 ${cpLen(t)} 字符，上限 ${cfg.entry_max}。正文请写进技能或正文文件，记忆只留索引`, { chars: cpLen(t), max: cfg.entry_max });
  }
  for (const re of FORBID) {
    if (re.test(t)) die('forbidden', `命中禁写模式 ${re}：疑似密钥，拒绝写入`);
  }
  // 三种合法形状（--force 可绕过策略，但绕不过密钥与预算）
  if (!opts.force) {
    const r = policy.checkPolicy(t, policyOpts(cfg, existing));
    if (!r.ok) {
      const hint = (r.suggestions || []).map((s) => s.action).join('/');
      die(r.reason, `${r.detail}${hint ? `｜可选：${hint}` : ''}`, { suggestions: r.suggestions || [] });
    }
  }
  const n = normalize(t);
  for (const e of existing) {
    const ne = normalize(e);
    if (ne === n || (Math.min(ne.length, n.length) >= 20 && (ne.startsWith(n) || n.startsWith(ne)))) {
      die('duplicate', '已存在相同或包含关系的条目，请用 replace', { existing: e.slice(0, 80) });
    }
  }
  const used = existing.join(SEP).length;
  const after = used + (existing.length ? cpLen(SEP) : 0) + cpLen(t);
  if (after > cfg.char_limit && !opts.allowOverflow) {
    die('budget', `写入后 ${after} 字符，超过上限 ${cfg.char_limit}。先删旧条目或把细节搬到正文文件`, { after, limit: cfg.char_limit });
  }
  return t;
}

// ---------------------------------------------------------------- 命令（返回对象，不打印）
function cmdStatus() {
  const out = { ok: true, root: ROOT, agent: AGENT(), rulesVersion: RULES.version, files: {}, lock: fs.existsSync(LOCK_DIR) };
  for (const [key, cfg] of Object.entries(RULES.files)) {
    const abs = path.join(ROOT, cfg.path);
    if (fs.existsSync(abs)) out.files[key] = usage(abs, cfg);
  }
  const skillsDir = path.join(ROOT, 'skills');
  if (fs.existsSync(skillsDir)) out.skills = { dir: skillsDir };
  const recordsDir = path.join(ROOT, (RULES.records && RULES.records.dir) || 'memories/records');
  out.records = { dir: recordsDir, exists: fs.existsSync(recordsDir) };
  return out;
}

function cmdAppend(args) {
  const { key, cfg, abs } = resolveFile(args.file || 'MEMORY');
  if (cfg.writable === false) die('readonly', `${key} 是只读文件`);
  acquireLock();
  try {
    const { entries } = readEntries(abs);
    // 跨 MEMORY/USER 查重
    if (!args.force && args.text) {
      const otherKey = key === 'USER.md' ? 'MEMORY.md' : 'USER.md';
      const otherCfg = RULES.files[otherKey];
      let otherEntries = [];
      if (otherCfg) otherEntries = readEntries(path.join(ROOT, otherCfg.path)).entries;
      const dup = policy.findDuplicate(args.text, { [key]: entries, [otherKey]: otherEntries });
      if (dup) {
        const hint = (dup.suggestions || []).map((s) => s.action).join('/');
        die(dup.reason, `${dup.detail}${hint ? `｜可选：${hint}` : ''}`, { suggestions: dup.suggestions || [] });
      }
    }
    let t;
    try {
      t = validate(args.text, cfg, entries, { force: !!args.force, allowOverflow: true });
    } catch (e) {
      const policyCodes = ['structured_content', 'too_many_points', 'domain_details', 'long_and_structured', 'dead_reference', 'dead_pointer', 'unindexed_detail', 'project_pileup', 'too_long'];
      if (policyCodes.includes(e.code)) {
        const pid = recordPending(key, args.text || '', e);
        e.extra = { ...(e.extra || {}), pending_id: pid, hints: ['force', 'drop'] };
      }
      throw e;
    }
    let kept = entries.concat([t]);
    let archived = [];
    if (kept.join(SEP).length > cfg.char_limit) {
      const r = archiveOldest(abs, cfg, entries, cpLen(t));
      kept = r.kept.concat([t]);
      archived = r.archived;
    }
    atomicWrite(abs, kept.join(SEP) + '\n');
    const u = usage(abs, cfg);
    audit('append', { file: key, chars: cpLen(t), total: u.chars, archived: archived.length });
    return { ok: true, file: key, appended: cpLen(t), archived: archived.length, ...u };
  } finally { releaseLock(); }
}

// 超预算时把最老的条目移进 archive（头进先出），腾出空间而不是直接拒绝
function archiveOldest(abs, cfg, entries, needChars) {
  const dir = path.join(path.dirname(abs), 'archive');
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(abs, '.md');
  const archiveFile = path.join(dir, `${base}-archive.md`);
  const rest = entries.slice();
  const archived = [];
  const room = () => cfg.char_limit - needChars - (rest.length ? cpLen(SEP) : 0);
  while (rest.length > 1 && rest.join(SEP).length > room()) {
    archived.push(rest.shift());
  }
  if (!archived.length) {
    die('budget', `写入后超过上限 ${cfg.char_limit}，且单条新内容已占满预算。先删旧条目或把细节搬到正文文件`, { limit: cfg.char_limit });
  }
  const stamp = new Date().toISOString().slice(0, 10);
  const lines = archived.map((e) => `[${stamp}] ${e}`).join('\n');
  const header = fs.existsSync(archiveFile) ? '' : `# ${base} 归档\n\n从记忆主文件移出的旧条目，按时间倒序可查。\n\n`;
  fs.appendFileSync(archiveFile, header + lines + '\n', 'utf8');
  audit('archive', { file: base, moved: archived.length });
  return { kept: rest, archived };
}

// 把一组条目裁到预算内（头进先出）；用于 replace / applyOps
function archiveToFit(abs, cfg, entries) {
  const rest = entries.slice();
  const archived = [];
  if (rest.join(SEP).length <= cfg.char_limit) return { kept: rest, archived };
  const dir = path.join(path.dirname(abs), 'archive');
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(abs, '.md');
  const archiveFile = path.join(dir, `${base}-archive.md`);
  while (rest.length > 1 && rest.join(SEP).length > cfg.char_limit) archived.push(rest.shift());
  if (rest.join(SEP).length > cfg.char_limit) {
    die('budget', `单条内容已超过上限 ${cfg.char_limit}，无法通过归档腾出空间`, { limit: cfg.char_limit });
  }
  if (archived.length) {
    const stamp = new Date().toISOString().slice(0, 10);
    const lines = archived.map((e) => `[${stamp}] ${e}`).join('\n');
    const header = fs.existsSync(archiveFile) ? '' : `# ${base} 归档\n\n从记忆主文件移出的旧条目，按时间倒序可查。\n\n`;
    fs.appendFileSync(archiveFile, header + lines + '\n', 'utf8');
    audit('archive', { file: base, moved: archived.length });
  }
  return { kept: rest, archived };
}

// ------------------------------------------------------------------ check (查询式)
function cmdCheck(args) {
  const text = String(args.text || '').trim();
  const { key, cfg, abs } = resolveFile(args.file || 'MEMORY');
  if (!text) return { ok: false, reason: 'empty', detail: '内容为空' };
  for (const re of FORBID) {
    if (re.test(text)) return { ok: false, reason: 'forbidden', detail: '命中禁写模式：疑似密钥' };
  }
  const otherKey = key === 'USER.md' ? 'MEMORY.md' : 'USER.md';
  const otherCfg = RULES.files[otherKey];
  const entries = readEntries(abs).entries;
  const otherEntries = otherCfg ? readEntries(path.join(ROOT, otherCfg.path)).entries : [];
  // 精确/前缀重复（与 append 同口径）
  const n = normalize(text);
  for (const e of [...entries, ...otherEntries]) {
    const ne = normalize(e);
    if (!ne) continue;
    if (ne === n || (Math.min(ne.length, n.length) >= 20 && (ne.startsWith(n) || n.startsWith(ne)))) {
      return { ok: false, reason: 'duplicate', detail: `已有相同或包含关系的条目：${e.slice(0, 80)}`, suggestions: [{ action: 'merge', hint: '用 replace 更新原条目' }] };
    }
  }
  const dup = policy.findDuplicate(text, { [key]: entries, [otherKey]: otherEntries });
  if (dup) return dup;
  const pol = policy.checkPolicy(text, policyOpts(cfg, entries));
  if (!pol.ok) return pol;
  return { ok: true, shape: pol.shape, chars: cpLen(text), limit: cfg.char_limit, entries: entries.length };
}

// ---------------------------------------------------------------- 原子批量（2026-11-24 新增）
// 一次调用内完成「读 → 逐条在内存里校验 → 全部通过才落盘」，任何一条失败则整批不改。
function cmdApplyOps(args) {
  const { key, cfg, abs } = resolveFile(args.file || 'MEMORY');
  if (cfg.writable === false) die('readonly', `${key} 是只读文件`);
  let ops = [];
  try {
    const raw = args.ops_file ? fs.readFileSync(String(args.ops_file), 'utf8') : (args.ops_json || '[]');
    ops = Array.isArray(args.ops) ? args.ops : JSON.parse(raw);
  } catch {
    die('bad_ops', 'ops 不是合法 JSON 数组（--ops_json 或 --ops_file）');
  }
  if (!Array.isArray(ops) || ops.length === 0) die('bad_ops', 'ops 为空');
  const otherKey = key === 'USER.md' ? 'MEMORY.md' : 'USER.md';
  const otherCfg = RULES.files[otherKey];
  const otherEntries = otherCfg ? readEntries(path.join(ROOT, otherCfg.path)).entries : [];

  acquireLock();
  try {
    let working = readEntries(abs).entries;
    const plan = [];
    for (let idx = 0; idx < ops.length; idx++) {
      const op = ops[idx] || {};
      const action = String(op.action || '').toLowerCase();
      const text = String(op.facts != null ? op.facts : op.content != null ? op.content : '').trim();
      const oldText = String(op.old_text || '');
      const at = `第 ${idx + 1} 个操作（${action || '?'}）`;
      try {
        if (action === 'add') {
          if (!text) die('empty', `${at}：缺 facts`);
          if (!op.force && !args.force) {
            const dup = policy.findDuplicate(text, { [key]: working, [otherKey]: otherEntries });
            if (dup) die(dup.reason, `${at}：${dup.detail}`, { suggestions: dup.suggestions || [] });
          }
          working = working.concat([validate(text, cfg, working, { force: !!(op.force || args.force) })]);
          plan.push(action);
        } else if (action === 'remove') {
          if (!oldText) die('missing_match', `${at}：缺 old_text`);
          const next = working.filter((e) => !e.includes(oldText));
          if (next.length === working.length) die('not_found', `${at}：没有包含「${oldText}」的条目`);
          working = next;
          plan.push(action);
        } else if (action === 'replace') {
          if (!oldText) die('missing_match', `${at}：缺 old_text`);
          if (!text) die('empty', `${at}：缺 facts`);
          const pos = working.findIndex((e) => e.includes(oldText));
          if (pos < 0) die('not_found', `${at}：没有包含「${oldText}」的条目`);
          const rest = working.filter((_, i) => i !== pos);
          working = rest.slice(0, pos).concat([validate(text, cfg, rest, { force: !!(op.force || args.force) })], rest.slice(pos));
          plan.push(action);
        } else {
          die('unknown_action', `${at}：未知动作「${action}」（应为 add/replace/remove）`);
        }
      } catch (e) {
        const policyCodes = ['structured_content', 'domain_details', 'dead_reference', 'dead_pointer', 'unindexed_detail', 'project_pileup', 'too_long'];
        if (policyCodes.includes(e.code)) {
          const pid = recordPending(key, text || oldText || '', e);
          e.extra = { ...(e.extra || {}), pending_id: pid, hints: ['force', 'drop'] };
        }
        e.message = `整批未写入（0/${ops.length}）— ${e.message}`;
        throw e;
      }
    }
    const fitted = archiveToFit(abs, cfg, working);
    atomicWrite(abs, fitted.kept.join(SEP) + '\n');
    const u = usage(abs, cfg);
    audit('apply_ops', { file: key, ops: plan.length, total: u.chars, archived: fitted.archived.length });
    return { ok: true, file: key, applied: plan.length, archived: fitted.archived.length, ...u };
  } finally { releaseLock(); }
}

// ---------------------------------------------------------------- pending violations
function pendingPath() { return path.join(ROOT, '.brain', 'pending.json'); }

function readPending() {
  try { return JSON.parse(fs.readFileSync(pendingPath(), 'utf8')); } catch { return []; }
}

function writePending(arr) {
  fs.mkdirSync(path.dirname(pendingPath()), { recursive: true });
  fs.writeFileSync(pendingPath(), JSON.stringify(arr, null, 2), 'utf8');
}

function recordPending(key, text, err) {
  const arr = readPending();
  const id = arr.reduce((m, x) => Math.max(m, x.id || 0), 0) + 1;
  arr.push({ id, ts: new Date().toISOString(), file: key, text, reason: err.code || 'policy', detail: (err.message || '').slice(0, 300), status: 'pending' });
  writePending(arr);
  return id;
}

function cmdPending() {
  const arr = readPending().filter((x) => x.status === 'pending');
  return { ok: true, count: arr.length, pending: arr.map((x) => ({ id: x.id, file: x.file, reason: x.reason, text: (x.text || '').slice(0, 80), detail: (x.detail || '').slice(0, 120) })) };
}

function cmdResolve(args) {
  const id = Number(args.id);
  if (!id) die('missing_id', '要 --id 指定 pending 编号');
  const choice = (args.choice || '').toLowerCase();
  if (!['force', 'drop'].includes(choice)) die('bad_choice', '--choice 只能是 force 或 drop');
  const arr = readPending();
  const item = arr.find((x) => x.id === id && x.status === 'pending');
  if (!item) die('not_found', `没有编号 ${id} 的待处理违规`);
  if (choice === 'drop') {
    item.status = 'dropped';
    writePending(arr);
    audit('resolve_drop', { file: item.file, id });
    return { ok: true, id, resolved: 'dropped' };
  }
  acquireLock();
  try {
    const { key, cfg, abs } = resolveFile(item.file.replace('.md', ''));
    const { entries } = readEntries(abs);
    const t = validate(item.text, cfg, entries, { force: true, allowOverflow: true });
    const r = archiveToFit(abs, cfg, entries.concat([t]));
    atomicWrite(abs, r.kept.join(SEP) + '\n');
    item.status = 'resolved';
    writePending(arr);
    audit('resolve_force', { file: key, id, archived: r.archived.length });
    return { ok: true, id, resolved: 'forced', archived: r.archived.length, ...usage(abs, cfg) };
  } finally { releaseLock(); }
}

function cmdReplace(args) {
  const { key, cfg, abs } = resolveFile(args.file || 'MEMORY');
  if (cfg.writable === false) die('readonly', `${key} 是只读文件`);
  if (!args.match) die('missing_match', '要 --match 指定被替换的条目');
  acquireLock();
  try {
    const { entries } = readEntries(abs);
    const idx = entries.findIndex((e) => e.includes(args.match));
    if (idx < 0) die('not_found', `没有包含「${args.match}」的条目`);
    const rest = entries.filter((_, i) => i !== idx);
    // 2026-11-24：replace 也要跨文件查重（排除被替换的旧条），与 append 同口径
    if (!args.force && args.text) {
      const otherKey = key === 'USER.md' ? 'MEMORY.md' : 'USER.md';
      const otherCfg = RULES.files[otherKey];
      const otherEntries = otherCfg ? readEntries(path.join(ROOT, otherCfg.path)).entries : [];
      const dup = policy.findDuplicate(args.text, { [key]: rest, [otherKey]: otherEntries }, args.match);
      if (dup) die(dup.reason, dup.detail, { suggestions: dup.suggestions || [] });
    }
    const t = validate(args.text, cfg, rest, { force: !!args.force, allowOverflow: true });
    const replaced = entries.slice(0, idx).concat([t], entries.slice(idx + 1));
    const fitted = archiveToFit(abs, cfg, replaced);
    atomicWrite(abs, fitted.kept.join(SEP) + '\n');
    const u = usage(abs, cfg);
    audit('replace', { file: key, match: args.match.slice(0, 40), total: u.chars, archived: fitted.archived.length });
    return { ok: true, file: key, replaced: idx, archived: fitted.archived.length, ...u };
  } finally { releaseLock(); }
}

function cmdRemove(args) {
  const { key, cfg, abs } = resolveFile(args.file || 'MEMORY');
  if (cfg.writable === false) die('readonly', `${key} 是只读文件`);
  if (!args.match) die('missing_match', '要 --match 指定要删除的条目');
  acquireLock();
  try {
    const { entries } = readEntries(abs);
    const kept = entries.filter((e) => !e.includes(args.match));
    if (kept.length === entries.length) die('not_found', `没有包含「${args.match}」的条目`);
    atomicWrite(abs, kept.join(SEP) + '\n');
    const u = usage(abs, cfg);
    audit('remove', { file: key, match: args.match.slice(0, 40), removed: entries.length - kept.length, total: u.chars });
    return { ok: true, file: key, removed: entries.length - kept.length, ...u };
  } finally { releaseLock(); }
}

function cmdList(args) {
  const { key, abs } = resolveFile(args.file || 'MEMORY');
  return { ok: true, file: key, entries: readEntries(abs).entries };
}

function walk(dir, out = [], depth = 0) {
  if (depth > 6) return out;
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    const p = path.join(dir, name);
    let st;
    try { st = fs.lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(p, out, depth + 1);
    else if (st.isFile() && /\.(md|yaml|yml|json|txt)$/.test(name)) out.push(p);
  }
  return out;
}

function cmdSearch(args) {
  if (!args.query) die('missing_query', '要 --query 指定关键词');
  const limit = Number(args.limit || 10);
  const q = args.query.toLowerCase();
  const files = [];
  for (const cfg of Object.values(RULES.files)) {
    const abs = path.join(ROOT, cfg.path);
    if (fs.existsSync(abs)) files.push(abs);
  }
  walk(path.join(ROOT, 'skills'), files);
  const recordsDir = path.join(ROOT, (RULES.records && RULES.records.dir) || 'memories/records');
  if (fs.existsSync(recordsDir)) walk(recordsDir, files);
  const hits = [];
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (!text.toLowerCase().includes(q)) continue;
    text.split(/\r?\n/).forEach((line, i) => {
      if (line.toLowerCase().includes(q)) {
        hits.push({ file: path.relative(ROOT, f), line: i + 1, text: line.trim().slice(0, 300) });
      }
    });
    if (hits.length >= limit * 4) break;
  }
  return { ok: true, query: args.query, total: hits.length, hits: hits.slice(0, limit) };
}

// ---------------------------------------------------------------- 审计补记（只追加）
function cmdAudit(args) {
  const action = String(args.action || 'note');
  const file = args.file ? resolveFile(args.file).key : undefined;
  const detail = { file, chars: Number(args.chars || 0) };
  if (args.total !== undefined) detail.total = Number(args.total);
  if (args.note) detail.note = String(args.note).slice(0, 200);
  audit(action, detail);
  return { ok: true, action, file, agent: AGENT(), total: detail.total };
}

// ---------------------------------------------------------------- doctor（体检，只读）
function lastAuditTotal(fileKey) {
  try {
    const lines = fs.readFileSync(AUDIT, 'utf8').split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      let r; try { r = JSON.parse(lines[i]); } catch { continue; }
      if (r.file === fileKey && typeof r.total === 'number') return r.total;
    }
  } catch {}
  return null;
}

function cmdDoctor() {
  const issues = [];
  const add = (level, check, detail) => issues.push({ level, check, detail });
  const recordsDir = path.join(ROOT, (RULES.records && RULES.records.dir) || 'memories/records');
  const soft = Number((RULES.limits && RULES.limits.skill_soft_chars) || 15000);
  const hard = Number((RULES.limits && RULES.limits.skill_hard_chars) || 20000);

  // 1) 未记账改写：文件当前长度 vs 最后一条带 total 的审计
  for (const [key, cfg] of Object.entries(RULES.files)) {
    const abs = path.join(ROOT, cfg.path);
    if (!fs.existsSync(abs)) continue;
    const u = usage(abs, cfg);
    const last = lastAuditTotal(key);
    if (last !== null && last !== u.chars) {
      add('warn', 'unaudited_write', `${key} 当前 ${u.chars} 字符，最后一条审计记录是 ${last} — 期间有未经 brain.js 的修改`);
    }
  }

  // 2) 索引形状：逐条按现行规则判定
  for (const [key, cfg] of Object.entries(RULES.files)) {
    if (cfg.writable === false) continue;
    const abs = path.join(ROOT, cfg.path);
    if (!fs.existsSync(abs)) continue;
    const { entries } = readEntries(abs);
    const otherKey = key === 'USER.md' ? 'MEMORY.md' : 'USER.md';
    const otherCfg = RULES.files[otherKey];
    const otherEntries = otherCfg && fs.existsSync(path.join(ROOT, otherCfg.path)) ? readEntries(path.join(ROOT, otherCfg.path)).entries : [];
    entries.forEach((e, i) => {
      const r = policy.checkPolicy(e, policyOpts(cfg, entries.filter((_, j) => j !== i).concat(otherEntries)));
      if (!r.ok && !['duplicate', 'duplicate_topic', 'similar_entry'].includes(r.reason)) {
        add('warn', 'index_shape', `${key} 第 ${i + 1} 条 ${r.reason}：${e.slice(0, 60)}`);
      }
    });
  }

  // 3) 孤儿正文：records 下的文件没有任何记忆条目/技能引用
  if (fs.existsSync(recordsDir)) {
    const corpus = [];
    for (const cfg of Object.values(RULES.files)) {
      const abs = path.join(ROOT, cfg.path);
      if (fs.existsSync(abs)) corpus.push(fs.readFileSync(abs, 'utf8'));
    }
    for (const f of walk(recordsDir)) {
      const rel = path.relative(ROOT, f).replace(/\\/g, '/');
      // README / 下划线开头的文件是目录说明，不是正文，不参与孤儿检查
      if (/^(README|readme)\.md$/.test(path.basename(f)) || path.basename(f).startsWith('_')) continue;
      if (!corpus.some((c) => c.includes(rel))) add('warn', 'orphan_body', `没有索引指向：${rel}`);
    }
  }

  // 4) 技能体量
  const skillsRoot = path.join(ROOT, 'skills');
  if (fs.existsSync(skillsRoot)) {
    for (const f of walk(skillsRoot)) {
      if (path.basename(f) !== 'SKILL.md') continue;
      const size = cpLen(fs.readFileSync(f, 'utf8'));
      if (size > hard) add('error', 'skill_size', `${path.relative(ROOT, f)} ${size} 字符，超过硬线 ${hard}`);
      else if (size > soft) add('warn', 'skill_size', `${path.relative(ROOT, f)} ${size} 字符，超过软线 ${soft}`);
    }
  }

  return {
    ok: !issues.some((i) => i.level === 'error'),
    counts: { error: issues.filter((i) => i.level === 'error').length, warn: issues.filter((i) => i.level === 'warn').length },
    issues,
  };
}

// ---------------------------------------------------------------- 入口
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      out[k] = v;
    } else out._.push(a);
  }
  return out;
}

const API = {
  status: cmdStatus,
  check: cmdCheck,
  append: cmdAppend,
  applyOps: cmdApplyOps,
  replace: cmdReplace,
  remove: cmdRemove,
  list: cmdList,
  search: cmdSearch,
  pending: cmdPending,
  resolve: cmdResolve,
  audit: cmdAudit,
  doctor: cmdDoctor,
  root: ROOT,
  rules: RULES,
};

module.exports = API;

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args.agent) process.env.BRAIN_AGENT = String(args.agent);
  const cmd = args._[0] || 'status';
  try {
    if (!API[cmd]) die('unknown_command', `未知命令 ${cmd}`);
    const result = API[cmd](args);
    console.log(JSON.stringify(result, null, 2));
    if (cmd === 'doctor' && result && result.ok === false) process.exitCode = 2;
  } catch (e) {
    const payload = { ok: false, error: e.code || 'exception', message: e.message, ...(e.extra || {}) };
    console.log(JSON.stringify(payload, null, 2));
    process.exit(1);
  }
}
