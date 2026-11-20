// chips-brain memory provider for @lmzhen/dsh-memory
//
// 为什么要有这一层：evolution 自带的 memory-files 只复制了 Hermes 的「格式」
// （MEMORY.md/USER.md + § 分隔 + 2200/1375），没有 MIS 的「语义」：
// 索引级校验、skill 引用校验、相似度查重、跨宿主目录锁、统一审计。
// 这个 provider 把四个方法全部委托给 brain.js —— 与 Hermes 的 MIS 共用
// 同一份实现、同一把锁、同一本 audit.jsonl。
//
// 装载：cordis.patch.yml 里把 memory 行指向本 provider
//   - id: memory
//     config:
//       provider: chips-brain
// 并把本插件插进 profile 的 bundles/insert 列表。
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);

const ROOT = process.env.BRAIN_ROOT
  || (process.platform === 'win32' ? 'D:\\agent-brain' : require('os').homedir() + '/agent-brain');
process.env.BRAIN_AGENT = process.env.BRAIN_AGENT || 'dsh';
const brain = require(path.join(ROOT, '.brain', 'bin', 'brain.js'));

const FILE_KEY = { memory: 'MEMORY', user: 'USER' };
const FILE_PATH = { memory: 'memories/MEMORY.md', user: 'memories/USER.md' };
const LABEL = { memory: '共享记忆（索引）', user: '用户画像' };
const SEP_RE = /\r?\n\u00a7\r?\n/;
const BUDGET = Number(process.env.BRAIN_CONTEXT_BUDGET || 4000);

export const name = 'chips-brain-memory';
export const inject = ['memory'];

function limits(target) {
  const rules = brain.rules;
  const f = rules.files[FILE_KEY[target] === 'MEMORY' ? 'MEMORY.md' : 'USER.md'] || {};
  return { chars: Number(f.char_limit) || 2200, entries: Number(f.entry_max) || 150 };
}

function list(target) {
  const r = brain.list({ file: FILE_KEY[target] });
  return Array.isArray(r.entries) ? r.entries : [];
}

// 按条目边界截断：宁可少注入几条，也不把一条切成半截
function clipAtEntry(text, room) {
  if (text.length <= room) return { body: text, dropped: 0 };
  const entries = text.split(SEP_RE);
  const out = [];
  let used = 0;
  let dropped = 0;
  for (const e of entries) {
    const need = (out.length ? 3 : 0) + e.length;
    if (used + need > room) { dropped += 1; continue; }
    out.push(e); used += need;
  }
  return { body: out.join('\n§\n'), dropped };
}

function applyOne(target, op) {
  const file = FILE_KEY[target];
  const text = op.facts ?? op.content ?? '';
  switch (op.action) {
    case 'add':
      return brain.append({ file, text });
    case 'replace':
      if (!op.old_text) throw Object.assign(new Error('replace 需要 old_text'), { code: 'missing_old_text' });
      return brain.replace({ file, match: op.old_text, text });
    case 'remove':
      if (!op.old_text) throw Object.assign(new Error('remove 需要 old_text'), { code: 'missing_old_text' });
      return brain.remove({ file, match: op.old_text });
    default:
      throw Object.assign(new Error(`未知操作 ${op.action}`), { code: 'unknown_action' });
  }
}

const provider = {
  name: 'chips-brain',

  async read(target) {
    return list(target);
  },

  async applyBatch(target, operations) {
    const ops = Array.isArray(operations) ? operations : [];
    const messages = [];
    for (const op of ops) {
      try {
        const r = applyOne(target, op);
        messages.push(r.message || `${op.action} ok`);
      } catch (e) {
        const entries = list(target);
        const lim = limits(target);
        const extra = e.extra || {};
        const pending = extra.pending_id ? `（已登记 pending #${extra.pending_id}；可选 force 强写，或精简后重试）` : '';
        return {
          ok: false,
          message: `[chips-brain] ${e.code || 'error'}: ${e.message}${pending}（已应用 ${messages.length}/${ops.length} 条；整批非原子）`,
          entries,
          chars: entries.join('\n§\n').length,
          limit: lim.chars,
        };
      }
    }
    const entries = list(target);
    const lim = limits(target);
    return {
      ok: true,
      message: messages.join('；') || 'no-op',
      entries,
      chars: entries.join('\n§\n').length,
      limit: lim.chars,
    };
  },

  async snapshot() {
    const memory = list('memory');
    const user = list('user');
    const h = crypto.createHash('sha256');
    h.update(memory.join('\n§\n')); h.update('\u0000'); h.update(user.join('\n§\n'));
    return { version: 1, sha256: h.digest('hex'), memory, user };
  },

  async renderContext() {
    const parts = [];
    let used = 0;
    const push = (target) => {
      let text = '';
      try { text = fs.readFileSync(path.join(ROOT, FILE_PATH[target]), 'utf8').trim(); } catch { return; }
      if (!text) return;
      const room = BUDGET - used;
      if (room <= 80) return;
      const { body, dropped } = clipAtEntry(text, room);
      if (!body) return;
      const note = dropped ? `\n…（还有 ${dropped} 条未注入，用 memory/search 检索）` : '';
      parts.push(`### ${LABEL[target]}\n${body}${note}`);
      used += body.length;
    };
    // 画像先注入：它比索引短，但缺了它整个注入就失去意义
    push('user');
    push('memory');
    if (!parts.length) return '';
    return [
      `[chips-brain] 共享记忆（Chips 的大脑，根目录 ${ROOT}）。` +
        '索引 memories\\MEMORY.md、画像 memories\\USER.md、技能 skills\\<name>\\SKILL.md。' +
        '写入只写索引级一行（≤150 字），细节进 skill；不要用 write/edit 直接改 memories/ 或 skills/。',
      ...parts,
    ].join('\n\n');
  },
};

export function apply(ctx) {
  ctx.effect(() => ctx.memory.registerProvider(provider), 'chips-brain.memory-provider');
}
