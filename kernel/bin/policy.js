// brain-policy.js — 记忆写入策略（brain.js 与 DSH provider 共用，唯一实现）
//
// 2026-11-24 重构：从「形状过滤」改为「三种合法写入形状」。
//   ① 短自包含事实：≤ short_fact_max，单行，无指针
//   ② 索引行：单行、≤ entry_max、含且仅含一个可解析指针（skill:xxx 或 file:path）
//   ③ 画像：USER.md，用 short_fact_max=200 放行
// 其余一律拒（unindexed_detail）。凭据 / IP / 端口仍无条件硬拦，索引行也不放行。
//
// 保留的旧机制：硬规则、相似度查重、项目堆积（防止「一条条短事实」把记忆塞满）、死引用。
'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------- 硬规则（无条件拦）
// 凭据 / IP / 端口：MEMORY.md 每轮全量注入给模型供应商，短行里的密码同样出网。
const HARD_DOMAIN_PATTERNS = [
  [/(?<![\w.-])(?:\d{1,3}\.){3}\d{1,3}(?![\w.-])/, 'IP 地址'],
  [/(?:密码|口令|password|passwd|pwd|token|secret|api[\s_-]?key|私钥|凭据|credentials?)\s*[：:=]\s*\S+/i, '凭据'],
  [/(?:端口|port)\s*[：:=]?\s*\d{2,5}(?!\d)/i, '端口号'],
];

// 项目细节堆积：一条条短事实也能把 MEMORY 塞满。同一个大写项目代号已 ≥5 条 → 拒。
const PILEUP_THRESHOLD = 5;
const PILEUP_DENY = new Set([
  'USB', 'GPIO', 'PID', 'API', 'JSON', 'UTF', 'GBK', 'HTML', 'PDF', 'IP', 'CPU', 'RAM', 'GPU', 'OK', 'AI', 'LLM',
  'STM32', 'CH340', 'PWM', 'TXT', 'CSV', 'MQTT', 'CLI', 'GUI', 'SDK', 'FPS', 'CDN', 'DNS', 'TLS', 'SSL',
  'HTTP', 'HTTPS', 'URL', 'URI', 'SQL', 'JWT', 'WSL', 'NDA', 'FAQ', 'TODO', 'TBD', 'EOF', 'UTF8', 'UTF16',
]);

// ---------------------------------------------------------------- 指针
// 索引行必须能把读者带到正文。两种目标：
//   skill:<name>                       → skills/**/<name>/SKILL.md
//   file:<path> / → <path>             → 相对 brain 根，必须落在 pointer.roots 之下且存在
const SKILL_REF_RE = /(?:详见|参见|见|see)\s+skill\s*[:：]?\s*([\p{L}\p{N}_-]+)/giu;
const FILE_REF_RE = /(?:详见|参见|见|see|→|->)\s*(?:file\s*[:：]\s*)?((?:memories|skills)[/\\][^\s，。；、,;()（）「」]+?\.md)/giu;

function findPointers(text) {
  const out = [];
  const push = (kind, target) => {
    if (!out.some((p) => p.kind === kind && p.target === target)) out.push({ kind, target });
  };
  let m;
  SKILL_REF_RE.lastIndex = 0;
  while ((m = SKILL_REF_RE.exec(text)) !== null) push('skill', m[1]);
  FILE_REF_RE.lastIndex = 0;
  while ((m = FILE_REF_RE.exec(text)) !== null) push('file', m[1].replace(/\\/g, '/'));
  return out;
}

function pointerRoots(opts = {}) {
  const roots = Array.isArray(opts.pointerRoots) && opts.pointerRoots.length
    ? opts.pointerRoots
    : ['memories/records', 'skills'];
  return roots.map((r) => String(r).replace(/\\/g, '/').replace(/\/+$/, ''));
}

function resolvePointer(ptr, opts = {}) {
  if (ptr.kind === 'skill') {
    if (!opts.skillsRoot) return { ok: true };
    return skillExists(opts.skillsRoot, ptr.target)
      ? { ok: true }
      : { ok: false, reason: 'dead_reference', detail: `引用了不存在的 skill：${ptr.target}` };
  }
  if (!opts.brainRoot) return { ok: true };
  const rel = ptr.target;
  if (rel.startsWith('/') || rel.includes('..')) {
    return { ok: false, reason: 'dead_pointer', detail: `指针路径不合法：${rel}` };
  }
  const roots = pointerRoots(opts);
  if (!roots.some((r) => rel === r || rel.startsWith(r + '/'))) {
    return { ok: false, reason: 'dead_pointer', detail: `指针必须指向 ${roots.join(' 或 ')} 之下：${rel}` };
  }
  if (!fs.existsSync(path.join(opts.brainRoot, rel))) {
    return { ok: false, reason: 'dead_pointer', detail: `指针指向的文件不存在：${rel}` };
  }
  return { ok: true };
}

function hardDomainHits(text) {
  const hits = [];
  for (const [re, label] of HARD_DOMAIN_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    if (label === 'IP 地址') {
      const octets = m[0].split('.').map(Number);
      if (octets.some((o) => o > 255)) continue;   // 不是合法 IPv4（如版本号 1.2.3.400）
    }
    hits.push(label);
  }
  return hits;
}

function projectPileupHits(text, entries) {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const tokens = new Set(String(text || '').match(/\b[A-Z][A-Z0-9]{2,9}\b/g) || []);
  const hits = [];
  for (const tok of tokens) {
    if (PILEUP_DENY.has(tok)) continue;
    const count = entries.filter((e) => String(e).includes(tok)).length;
    if (count >= PILEUP_THRESHOLD) hits.push(`${tok}×${count}`);
  }
  return hits;
}

// ---------------------------------------------------------------- 相似度 / 查重
function bigrams(s) {
  const t = String(s).toLowerCase().replace(/\s+/g, '');
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}

function similarity(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

function extractTopic(content) {
  const cleaned = String(content).replace(/^§\s*/, '');
  const m = cleaned.match(/^([^：:]+)/);
  return (m ? m[1] : cleaned.slice(0, 20)).trim();
}

// 递归找 skills 下名为 name 且有 SKILL.md 的目录
function skillExists(skillsRoot, name) {
  const direct = path.join(skillsRoot, name);
  try { if (fs.existsSync(path.join(direct, 'SKILL.md'))) return true; } catch {}
  const stack = [skillsRoot];
  let guard = 0;
  while (stack.length && guard < 4000) {
    guard++;
    const dir = stack.pop();
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const it of items) {
      if (!it.isDirectory()) continue;
      const p = path.join(dir, it.name);
      if (it.name === name && fs.existsSync(path.join(p, 'SKILL.md'))) return true;
      stack.push(p);
    }
  }
  return false;
}

// 兼容旧调用：返回文本里所有指向不存在技能的引用
function deadRefs(content, skillsRoot) {
  if (!skillsRoot) return [];
  return findPointers(content).filter((p) => p.kind === 'skill' && !skillExists(skillsRoot, p.target)).map((p) => p.target);
}

function buildSuggestions(content, reason) {
  const preview = String(content).slice(0, 40).replace(/'/g, '');
  const out = [{
    action: 'shorten',
    hint: `压成一行索引（≤150 字）+ 一个指针，原文开头：${preview}`,
  }];
  if (reason === 'dead_reference') {
    out.push({ action: 'create_skill', hint: '先建技能，再写「见 skill <名字>」' });
  } else if (reason === 'dead_pointer') {
    out.push({ action: 'create_record', hint: '先把正文写成 memories/records/<域>/<主题>.md，再写「→ 该路径」' });
  } else {
    out.push({ action: 'create_record', hint: '正文写进技能的 references/<类型>.md 或 memories/records/<域>/<主题>.md' });
  }
  out.push({ action: 'force', hint: '确认这是必须留在记忆里的事实 → 强写（不推荐）' });
  return out;
}

// ---------------------------------------------------------------- 主判定
// 返回 { ok:true } 或 { ok:false, reason, detail, suggestions }
function checkPolicy(content, opts = {}) {
  const shortMax = Number(opts.shortFactMax || 80);
  const indexMax = Number(opts.maxLen || 150);
  const text = String(content || '').trim();
  if (!text) return { ok: false, reason: 'empty', detail: '内容为空' };

  // 硬规则先行：凭据 / IP / 端口无条件拒，索引行也不放行
  const hard = hardDomainHits(text);
  if (hard.length) {
    return {
      ok: false, reason: 'domain_details',
      detail: `含敏感内容（${hard.join('、')}）：凭据 / IP / 端口必须进正文文件，记忆里一行都不留`,
      suggestions: buildSuggestions(text, 'domain_details'),
    };
  }

  const pointers = findPointers(text);

  // ② 索引行：单行、一个指针、可解析
  if (pointers.length === 1) {
    if (/\r?\n/.test(text)) {
      return { ok: false, reason: 'structured_content', detail: '索引行必须是单行：多行内容属于正文', suggestions: buildSuggestions(text, 'structured') };
    }
    const cp = Array.from(text).length;
    if (cp > indexMax) {
      return { ok: false, reason: 'too_long', detail: `索引行 ${cp} 字符，上限 ${indexMax}`, suggestions: buildSuggestions(text, 'too_long') };
    }
    const res = resolvePointer(pointers[0], opts);
    if (!res.ok) {
      return { ok: false, reason: res.reason, detail: res.detail, suggestions: buildSuggestions(text, res.reason) };
    }
    return { ok: true, shape: 'index', pointer: pointers[0] };
  }

  if (pointers.length > 1) {
    return { ok: false, reason: 'structured_content', detail: `一条索引最多一个指针，当前 ${pointers.length} 个`, suggestions: buildSuggestions(text, 'structured') };
  }

  // ① 短自包含事实：单行、够短
  if (/\r?\n/.test(text)) {
    return { ok: false, reason: 'unindexed_detail', detail: '多行内容没有指针：正文应进 references/ 或 memories/records/，记忆只留一行', suggestions: buildSuggestions(text, 'unindexed_detail') };
  }
  const cp = Array.from(text).length;
  if (cp > shortMax) {
    return {
      ok: false, reason: 'unindexed_detail',
      detail: `${cp} 字符且无指针：超过短事实上限 ${shortMax}，请拆成「一行索引 + 正文文件」`,
      suggestions: buildSuggestions(text, 'unindexed_detail'),
    };
  }

  const pile = projectPileupHits(text, opts.existingEntries);
  if (pile.length) {
    return {
      ok: false, reason: 'project_pileup',
      detail: `项目细节堆积（${pile.join(', ')}）——该项目在记忆里已有 ≥${PILEUP_THRESHOLD} 条，细节应进正文文件，记忆只留一行索引`,
      suggestions: buildSuggestions(text, 'project_pileup'),
    };
  }

  return { ok: true, shape: 'short_fact' };
}

// 跨文件查重：主题相同，或（双方 >60 字且相似度 >0.6）
function findDuplicate(content, entriesByTarget, excludeOld = '') {
  const text = String(content || '').trim();
  if (!text) return null;
  let topic = extractTopic(text);
  if (topic.length < 2) topic = text.slice(0, 20);
  for (const [target, entries] of Object.entries(entriesByTarget)) {
    for (const raw of entries) {
      const e = String(raw).trim();
      if (!e || e === text) continue;
      if (excludeOld && e.includes(excludeOld)) continue;
      const eTopic = extractTopic(e);
      if (topic && eTopic === topic) {
        return {
          ok: false, reason: 'duplicate_topic',
          detail: `主题「${topic}」已存在于 ${target}：${e.slice(0, 80)}`,
          suggestions: [
            { action: 'force', hint: '确实不同内容→强写' },
            { action: 'merge', hint: `合并到已有条目：replace old_text='${e.slice(0, 40)}'` },
          ],
        };
      }
      if (text.length > 60 && e.length > 60) {
        const r = similarity(text, e);
        if (r > 0.6) {
          return {
            ok: false, reason: 'similar_entry',
            detail: `与 ${target} 条目相似度 ${Math.round(r * 100)}%：${e.slice(0, 80)}`,
            suggestions: [
              { action: 'force', hint: '信息不同→强写' },
              { action: 'merge', hint: `合并/替换：replace old_text='${e.slice(0, 40)}'` },
            ],
          };
        }
      }
    }
  }
  return null;
}

module.exports = {
  checkPolicy,
  findDuplicate,
  findPointers,
  resolvePointer,
  pointerRoots,
  similarity,
  extractTopic,
  deadRefs,
  skillExists,
  hardDomainHits,
  projectPileupHits,
};
