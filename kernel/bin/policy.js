// brain-policy.js — MIS 语义的 JS 端口（brain.js 与 DSH provider 共用）
//
// 来源：Hermes 插件 plugins/mis/__init__.py 的 _check_mis_policy_v2 /
// _find_duplicate / _find_dead_references / _extract_topic / _similarity_ratio。
// 目的：让 DSH（evolution + chips-memory provider）与 Hermes（MIS）执行同一套
// 「记忆只存一行索引、细节进 skill」的规则，而不是各写一套。
//
// 注意：MIS 原实现里部分正则把 \s 误写成了 \\s（字面反斜杠），这里按「意图」
// 实现为 \s；两者的差异只影响"结构化内容"的识别范围，行为更接近设计文档。
'use strict';

const fs = require('fs');
const path = require('path');

const INDEX_LINE_RE = /^\s*§\s*.+\S\s*[：:]?\s*(?:详见|see)\s*(?:skill|gbrain\s+page)\s+\S+/i;

const REFERENCE_PATTERNS = [
  [/(?:^|\n)\s*[-•·]\s+/m, 'bullet list'],
  [/(?:^|\n)\s*\d+[.)、]\s+/m, 'numbered list'],
  [/→|=>|：.*→/, 'arrow/chain notation'],
  [/(?:步骤|step)\s*\d/i, 'step-by-step'],
  [/(?:首先|然后|接着|最后|其次)/, 'sequential flow'],
  [/(?:第[一二三四五六七八九十]+步)/, 'numbered steps'],
  [/\|.*\|.*\|/, 'table structure'],
  [/(?:详见|参考|see)\s+(?!skill\s|gbrain\s+page)/, 'references non-skill'],
];

const DOMAIN_PATTERNS = [
  [/(?:服务器|server)\s*(?:IP)?\s*[：:]?\s*\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/i, 'server IP'],
  [/(?:技术栈|tech\s*stack)\s*[：:]/i, 'tech stack'],
  [/(?:架构|architecture)\s*[：:]\s*\S/i, 'architecture'],
  [/(?:数据库|database|DB)\s*[：:]\s*\S/i, 'database'],
  [/(?:部署|deploy)\s*[：:]\s*\S/i, 'deployment'],
  [/(?:API|端点|endpoint)\s*[：:]\s*\S/i, 'API endpoint'],
  [/(?:端口|port)\s*[：:]?\s*\d{2,5}/i, 'port number'],
  [/(?:密码|password|token|secret|api.?key)\s*[：:]\s*\S/i, 'credential'],
  [/(?:表结构|schema|字段|column)\s*[：:]/i, 'database schema'],
  [/(?:路由|route)\s*[：:]\s*\/\S/i, 'API route'],
  [/(?:组件|component)\s*[：:]\s*\S{10,}/i, 'component details'],
  [/(?:脚本|口播|文案|剧本|解说词)[^：:\n]*[：:]/i, 'content creation'],
  [/(?:封面|排版|设计风格|配色|色调)[^：:\n]*[：:]/i, 'design spec'],
  [/(?:视频|剪辑|字幕|配音|特效)[^：:\n]*[：:]/i, 'video production'],
  [/(?:推广|营销|获客|转化|漏斗)[^：:\n]*[：:]/i, 'marketing'],
  [/(?:简历|resume|工作经历|教育背景)[^：:\n]*[：:]/i, 'resume'],
];

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

// 递归找 skills 下名为 name 且含 SKILL.md 的目录（对应 MIS 的 rglob 版本）
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

function deadRefs(content, skillsRoot) {
  const dead = [];
  // Python 的 \w 匹配 Unicode；JS 默认只匹配 ASCII，这里显式带上中日韩字符
  const re = /(?:详见|参见|见|see)\s+skill\s+[`]?([\p{L}\p{N}_-]+)/giu;
  let m;
  while ((m = re.exec(content)) !== null) {
    const name = m[1];
    if (!skillExists(skillsRoot, name)) dead.push(name);
  }
  return dead;
}

function buildSuggestions(content, reason) {
  const out = [];
  const preview = content.slice(0, 40).replace(/'/g, '');
  out.push({ action: 'shorten', hint: `压到一行索引（≤150 字），细节写进 skill；原文开头：${preview}` });
  if (reason === 'dead_reference') {
    out.push({ action: 'create_skill', hint: '先建 skill，再写「见 skill <名字>」' });
  } else {
    out.push({ action: 'create_skill', hint: '用 skill_manage(action=create) 建 skill 放细节' });
  }
  out.push({ action: 'force', hint: '确认这是必须留在记忆里的事实→强写（不推荐）' });
  return out;
}

// 返回 { ok:true } 或 { ok:false, reason, detail, suggestions }
function checkPolicy(content, opts = {}) {
  const maxLen = Number(opts.maxLen || 150);
  const skillsRoot = opts.skillsRoot;
  const text = String(content || '').trim();
  if (!text) return { ok: false, reason: 'empty', detail: '内容为空' };

  // 死引用优先于"短条目放行"：引用了不存在的 skill，多短都不该过
  const deadAny = skillsRoot ? deadRefs(text, skillsRoot) : [];
  if (deadAny.length) {
    return { ok: false, reason: 'dead_reference', detail: `引用了不存在的 skill: ${deadAny.join(', ')}`, suggestions: buildSuggestions(text, 'dead_reference') };
  }

  if (INDEX_LINE_RE.test(text)) {
    return { ok: true };
  }

  // 结构化内容不设长度豁免：3 行 bullet 再短也是"细节"，MIS 的 <50 放行是漏网
  for (const [re, label] of REFERENCE_PATTERNS) {
    if (re.test(text)) {
      return { ok: false, reason: 'structured_content', detail: `结构化内容（${label}）应写进 skill`, suggestions: buildSuggestions(text, 'structured') };
    }
  }

  if (text.length < 50) return { ok: true };

  const segments = text.split(/[、，,；;]\s*/).filter((s) => s.length > 2);
  if (segments.length >= 3 && text.length > 100) {
    return { ok: false, reason: 'too_many_points', detail: `${segments.length} 个细节点 / ${text.length} 字，应进 skill`, suggestions: buildSuggestions(text, 'too_many_points') };
  }

  const hits = [];
  for (const [re, label] of DOMAIN_PATTERNS) if (re.test(text)) hits.push(label);
  if (hits.length && text.length > 100) {
    return { ok: false, reason: 'domain_details', detail: `含项目细节（${hits.slice(0, 3).join(', ')}），应进 skill`, suggestions: buildSuggestions(text, 'domain_details') };
  }

  if (text.length > 200) {
    return { ok: false, reason: 'too_long', detail: `过长（${text.length} 字 > 200）`, suggestions: buildSuggestions(text, 'too_long') };
  }
  if (text.length > maxLen) {
    for (const [re, label] of REFERENCE_PATTERNS) {
      if (re.test(text)) {
        return { ok: false, reason: 'long_and_structured', detail: `既长（${text.length}）又结构化（${label}）`, suggestions: buildSuggestions(text, 'long_structured') };
      }
    }
  }
  return { ok: true };
}

// 跨 MEMORY/USER 查重：主题相同，或（双方 >60 字且相似度 >0.6）
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

module.exports = { checkPolicy, findDuplicate, similarity, extractTopic, deadRefs, skillExists, INDEX_LINE_RE };
