#!/usr/bin/env node
// agent-brain CLI — Hermes 与 DSH 共用的唯一写入路径
// 用法: node brain.js <status|check|append|replace|remove|list|search> [...]
// 依赖: 仅 node 内置模块（不装任何包，两个宿主都能直接跑）
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = process.env.BRAIN_ROOT || path.resolve(__dirname, '..', '..');
const AGENT = process.env.BRAIN_AGENT || 'unknown';

// ---------------------------------------------------------------- YAML 子集
// 只支持本项目 rules.yaml 用到的形态：注释、嵌套 map、字符串数组、标量。
function parseYaml(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  let i = 0;

  const scalar = (v) => {
    v = v.trim();
    if (v === '') return '';
    const quoted = (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"));
    if (!quoted) v = v.replace(/\s+#.*$/, '');   // 行尾注释
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
  const raw = fs.readFileSync(abs, 'utf8');
  const entries = raw.split(SEP_RE).map((s) => s.trim()).filter(Boolean);
  return { raw, entries };
}

function usage(abs, cfg) {
  const raw = fs.readFileSync(abs, 'utf8');
  const len = cpLen(raw);
  const entries = raw.split(SEP_RE).map((s) => s.trim()).filter(Boolean).length;
  return { chars: len, limit: cfg.char_limit, remaining: cfg.char_limit - len, entries };
}

function acquireLock() {
  const staleMs = (RULES.lock.stale_seconds || 60) * 1000;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(LOCK_DIR, { recursive: false });
      fs.writeFileSync(path.join(LOCK_DIR, 'owner'), JSON.stringify({ pid: process.pid, agent: AGENT, ts: Date.now() }));
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
    fs.appendFileSync(AUDIT, JSON.stringify({ ts: new Date().toISOString(), agent: AGENT, action, ...detail }) + '\n');
  } catch { /* 审计失败不能影响主流程 */ }
}

function normalize(s) {
  return s.replace(/[\s，。、；：！？,.;:!?（）()\[\]"'“”‘’]/g, '').toLowerCase();
}

const policy = require(path.join(__dirname, 'policy.js'));

function validate(text, cfg, existing, opts = {}) {
  if (!text || !text.trim()) die('empty', '内容为空');
  const t = text.trim();
  if (cpLen(t) > cfg.entry_max) {
    die('too_long', `单条 ${cpLen(t)} 字符，上限 ${cfg.entry_max}。正文请写进 skill，记忆只留索引`, { chars: cpLen(t), max: cfg.entry_max });
  }
  for (const re of FORBID) {
    if (re.test(t)) die('forbidden', `命中禁写模式 ${re}：疑似密钥，拒绝写入`);
  }
  // MIS 语义：索引级 / 结构化 / 项目细节 / 相似度（--force 可绕过策略，但绕不过密钥与预算）
  if (!opts.force) {
    const r = policy.checkPolicy(t, { maxLen: cfg.entry_max, skillsRoot: path.join(ROOT, 'skills') });
    if (!r.ok) {
      const hint = (r.suggestions || []).map((s) => s.action).join('/');
      die(r.reason, `${r.detail}${hint ? `｜可选：${hint}` : ''}`, { suggestions: r.suggestions || [] });
    }
  }
  const n = normalize(t);
  for (const e of existing) {
    const ne = normalize(e);
    // 包含关系只在较长（≥20 字）时才算重复：否则 "js-1" 会被 "js-10" 误判
    if (ne === n || (Math.min(ne.length, n.length) >= 20 && (ne.startsWith(n) || n.startsWith(ne)))) {
      die('duplicate', '已存在相同或包含关系的条目，请用 replace', { existing: e.slice(0, 80) });
    }
  }
  const used = existing.join(SEP).length;
  const after = used + (existing.length ? cpLen(SEP) : 0) + cpLen(t);
  if (after > cfg.char_limit && !opts.allowOverflow) {
    die('budget', `写入后 ${after} 字符，超过上限 ${cfg.char_limit}。先删旧条目或把细节搬到 skill`, { after, limit: cfg.char_limit });
  }
  return t;
}

// ---------------------------------------------------------------- 命令（返回对象，不打印）
function cmdStatus() {
  const out = { ok: true, root: ROOT, agent: AGENT, files: {}, lock: fs.existsSync(LOCK_DIR) };
  for (const [key, cfg] of Object.entries(RULES.files)) {
    const abs = path.join(ROOT, cfg.path);
    if (fs.existsSync(abs)) out.files[key] = usage(abs, cfg);
  }
  const skillsDir = path.join(ROOT, 'skills');
  if (fs.existsSync(skillsDir)) out.skills = { dir: skillsDir };
  return out;
}

function cmdCheck(args) {
  const { cfg, abs } = resolveFile(args.file || 'MEMORY');
  const { entries } = readEntries(abs);
  const t = validate(args.text, cfg, entries);
  return { ok: true, dry_run: true, chars: cpLen(t), max: cfg.entry_max };
}

function cmdAppend(args) {
  const { key, cfg, abs } = resolveFile(args.file || 'MEMORY');
  if (cfg.writable === false) die('readonly', `${key} 是只读文件`);
  acquireLock();
  try {
    const { entries } = readEntries(abs);
    // 跨 MEMORY/USER 查重（MIS 的 _find_duplicate 同时看两个库）
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
      const policyCodes = ['structured_content', 'too_many_points', 'domain_details', 'long_and_structured', 'dead_reference'];
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
    die('budget', `写入后超过上限 ${cfg.char_limit}，且单条新内容已占满预算。先删旧条目或把细节搬到 skill`, { limit: cfg.char_limit });
  }
  const stamp = new Date().toISOString().slice(0, 10);
  const lines = archived.map((e) => `[${stamp}] ${e}`).join('\n');
  const header = fs.existsSync(archiveFile) ? '' : `# ${base} 归档\n\n从记忆主文件移出的旧条目，按时间倒序可查。\n\n`;
  fs.appendFileSync(archiveFile, header + lines + '\n', 'utf8');
  audit('archive', { file: base, moved: archived.length });
  return { kept: rest, archived };
}

// ------------------------------------------------------------------ check (查询式)
// 只判断不写入：给 MIS / provider / 人做“这条能不能写”的预检，返回 JSON 而不是抛错
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
  const pol = policy.checkPolicy(text, { maxLen: cfg.entry_max, skillsRoot: path.join(ROOT, 'skills') });
  if (!pol.ok) return pol;
  if (cpLen(text) > cfg.char_limit) return { ok: false, reason: 'budget', detail: `单条超过 ${cfg.char_limit}` };
  return { ok: true, chars: cpLen(text), limit: cfg.char_limit, entries: entries.length };
}

// ---------------------------------------------------------------- pending violations
// MIS 的 resolve 通道：策略拒绝的写入不丢弃，落进 .brain/pending.json，可 force / drop
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
    let kept = entries.concat([t]);
    let archived = 0;
    if (kept.join(SEP).length > cfg.char_limit) {
      const r = archiveOldest(abs, cfg, entries, cpLen(t));
      kept = r.kept.concat([t]); archived = r.archived.length;
    }
    atomicWrite(abs, kept.join(SEP) + '\n');
    item.status = 'resolved';
    writePending(arr);
    audit('resolve_force', { file: key, id, archived });
    return { ok: true, id, resolved: 'forced', archived, ...usage(abs, cfg) };
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
    const t = validate(args.text, cfg, rest, { force: !!args.force });
    atomicWrite(abs, entries.slice(0, idx).concat([t], entries.slice(idx + 1)).join(SEP) + '\n');
    const u = usage(abs, cfg);
    audit('replace', { file: key, match: args.match.slice(0, 40), total: u.chars });
    return { ok: true, file: key, replaced: idx, ...u };
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
  replace: cmdReplace,
  remove: cmdRemove,
  list: cmdList,
  search: cmdSearch,
  check: cmdCheck,
  pending: cmdPending,
  resolve: cmdResolve,
  root: ROOT,
  rules: RULES,
};

module.exports = API;

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'status';
  try {
    if (!API[cmd]) die('unknown_command', `未知命令 ${cmd}`);
    console.log(JSON.stringify(API[cmd](args), null, 2));
  } catch (e) {
    const payload = { ok: false, error: e.code || 'exception', message: e.message, ...(e.extra || {}) };
    console.log(JSON.stringify(payload, null, 2));
    process.exit(1);
  }
}
