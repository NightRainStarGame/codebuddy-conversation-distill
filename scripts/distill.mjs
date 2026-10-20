#!/usr/bin/env node
/**
 * conversation-distill — 对话蒸馏包的导出 / 导入工具（零依赖，Node >= 18）
 *
 *   node distill.mjs sout  [--out <dir>] [--session <id>] [--list-sessions] [--no-facts]
 *   node distill.mjs sin   <pack.md | --latest> [--strict]
 *   node distill.mjs list
 *   node distill.mjs finalize <pack.md>
 *
 * 设计原则：
 *   1. 能从磁盘拿到的「硬事实」（会话标题、用户原话、待办、计划、git、内存索引）由本脚本采集，不靠模型回忆；
 *   2. 助手侧的结论（决策、原因、下一步）只能由当前会话的 Agent 写，脚本只负责留好坑位；
 *   3. 产物是**单个 Markdown**，可直接发微信 / 拖进任何机器，不依赖仓库。
 *
 * 读取 CodeBuddy 本地数据时若 Node >= 22 会用内置 node:sqlite；不可用则自动降级（只少了会话元数据）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const PACK_FORMAT = 'cb-distill/v1';
const SKILL_VERSION = '1.0.0';
const PLACEHOLDER = '_（待蒸馏）_';
const PLACEHOLDER_LINE = /^[ \t]*_（待蒸馏）_[ \t]*$/m; // 哨兵必须独占一行；正文里引用这个串不算
const countPlaceholders = (text) => (String(text).match(/^[ \t]*_（待蒸馏）_[ \t]*$/gm) || []).length;
const MAX_TURN_CHARS = 4000;
const MAX_TURNS_TOTAL = 60000;

/* ------------------------------------------------------------------ args */

const argv = process.argv.slice(2);
const cmd = (argv.shift() || 'sout').toLowerCase();
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const eq = a.indexOf('=');
    if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[a.slice(2)] = argv[++i];
    else flags[a.slice(2)] = true;
  } else {
    positional.push(a);
  }
}

/* --------------------------------------------------------------- helpers */

const isWin = process.platform === 'win32';
const norm = (p) => (p ? path.resolve(p) : '').replace(/\\/g, '/').toLowerCase();
const toPosix = (p) => (p ? path.resolve(p) : '').replace(/\\/g, '/');
const exists = (p) => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
};
const safeRead = (p, max = 2_000_000) => {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return '';
    const buf = fs.readFileSync(p);
    return buf.subarray(0, max).toString('utf8');
  } catch {
    return '';
  }
};
const oneLine = (s, max = 160) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);

function isoLocal(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const oh = pad(Math.floor(Math.abs(off) / 60));
  const om = pad(Math.abs(off) % 60);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${oh}:${om}`;
}
const stampCompact = (d = new Date()) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
};

function run(cmdName, args, cwd) {
  try {
    return execFileSync(cmdName, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 20000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    }).trim();
  } catch {
    return '';
  }
}

/* ------------------------------------------------------- redaction pass */

const SECRET_RULES = [
  [/\bssio_live_[A-Za-z0-9_-]{6,}/g, '[REDACTED:SSIO_KEY]'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,})/g, '[REDACTED:GH_TOKEN]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED:GH_TOKEN]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[REDACTED:SK_KEY]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED:AWS_KEY]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED:SLACK_TOKEN]'],
  [/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g, '$1…[REDACTED]…$2'],
  [
    /\b((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)[A-Za-z0-9_]*\s*[:=：]\s*)["'`]?([^\s"'`,;，。]{6,})["'`]?/gi,
    '$1[REDACTED]',
  ],
];

function redact(text) {
  let out = String(text ?? '');
  let hits = 0;
  for (const [re, rep] of SECRET_RULES) {
    out = out.replace(re, (...m) => {
      hits++;
      return typeof rep === 'string' ? rep.replace(/\$(\d)/g, (_, d) => m[Number(d)] ?? '') : rep;
    });
  }
  return { text: out, hits };
}

/* ------------------------------------------------- CodeBuddy data lookup */

function candidateCbRoots() {
  const list = [];
  if (flags['cb-root']) list.push(flags['cb-root']);
  const names = ['CodeBuddy CN', 'CodeBuddy', 'WorkBuddy'];
  const bases = [];
  if (isWin) bases.push(process.env.APPDATA || '', path.join(os.homedir(), 'AppData', 'Roaming'));
  else if (process.platform === 'darwin') bases.push(path.join(os.homedir(), 'Library', 'Application Support'));
  else bases.push(path.join(os.homedir(), '.config'));
  for (const b of bases.filter(Boolean)) for (const n of names) list.push(path.join(b, n));
  return list.filter((p, i) => list.indexOf(p) === i);
}

function findCbRoot() {
  for (const p of candidateCbRoots()) if (exists(path.join(p, 'User'))) return p;
  return null;
}

const cbRoot = findCbRoot();
const extData = cbRoot ? path.join(cbRoot, 'User', 'globalStorage', 'tencent-cloud.coding-copilot') : null;
const inbox = flags.inbox || path.join(os.homedir(), '.codebuddy', 'distill');

/** 会话元数据（conversationId / cwd / title / status / createdAt） */
function readSessions() {
  if (!cbRoot) return [];
  const dbFile = path.join(cbRoot, 'codebuddy-sessions.vscdb');
  if (!exists(dbFile)) return [];
  const tmp = path.join(os.tmpdir(), `cb-sessions-${process.pid}-${Date.now()}.db`);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.copyFileSync(dbFile, tmp);
        for (const ext of ['-wal', '-shm']) {
          try {
            fs.copyFileSync(dbFile + ext, tmp + ext);
          } catch {}
        }
        break;
      } catch {
        if (attempt === 2) throw new Error('copy failed');
      }
    }
    // 动态加载内置 sqlite（Node >= 22.5；旧版本自动降级）
    let DatabaseSync = null;
    try {
      DatabaseSync = require('node:sqlite').DatabaseSync;
    } catch {}
    if (!DatabaseSync) return [];
    const db = new DatabaseSync(tmp, { readOnly: true });
    const rows = db.prepare("select key, value from ItemTable where key like 'session:%'").all();
    const out = [];
    for (const r of rows) {
      try {
        const v = JSON.parse(typeof r.value === 'string' ? r.value : Buffer.from(r.value).toString('utf8'));
        if (v && v.conversationId) out.push(v);
      } catch {}
    }
    try {
      db.close();
    } catch {}
    return out;
  } catch {
    return [];
  } finally {
    for (const f of [tmp, tmp + '-wal', tmp + '-shm']) {
      try {
        fs.unlinkSync(f);
      } catch {}
    }
  }
}

/** 用户原话（本机 message-queue 里按会话聚合的真实入队消息） */
function readMessageQueue() {
  const dir = extData ? path.join(extData, 'message-queue') : null;
  const byConv = new Map(); // cid -> Map(itemId -> item)
  if (!dir || !exists(dir)) return byConv;
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return byConv;
  }
  for (const f of files) {
    const raw = safeRead(path.join(dir, f));
    if (!raw) continue;
    let j;
    try {
      j = JSON.parse(raw);
    } catch {
      continue;
    }
    for (const [cid, conv] of Object.entries(j.conversations || {})) {
      if (!byConv.has(cid)) byConv.set(cid, new Map());
      const bucket = byConv.get(cid);
      for (const it of conv.items || []) {
        const key = it.id || `${it.order}-${it.createdAt}`;
        if (!bucket.has(key)) bucket.set(key, it);
      }
    }
  }
  return byConv;
}

function turnsOf(itemMap) {
  const turns = [];
  for (const it of itemMap?.values?.() || []) {
    if (it.status === 'failed' || it.status === 'cancelled') continue;
    for (const b of it.contentBlocks || []) {
      if (b.type !== 'text' || !b.text) continue;
      if (b._meta && b._meta.displayAsContext) continue;
      const text = b.text.trim();
      if (!text) continue;
      turns.push({ at: it.createdAt || 0, mode: it.modeId || '', model: it.modelId || '', text });
    }
  }
  turns.sort((a, b) => a.at - b.at);
  // 去掉连续重复（人工重发/重试会留多条）
  return turns.filter((t, i) => i === 0 || t.text !== turns[i - 1].text);
}

function readTodos(cid) {
  const f = extData ? path.join(extData, 'todos', `${cid}.json`) : null;
  const raw = f ? safeRead(f) : '';
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readPlan(cid) {
  const dir = extData ? path.join(extData, 'plans', cid) : null;
  if (!dir || !exists(dir)) return '';
  for (const name of ['plan.md', '.plan-original.md', 'plan.json']) {
    const p = path.join(dir, name);
    if (exists(p)) return safeRead(p, 40000);
  }
  return '';
}

/* ------------------------------------------------------------ repo facts */

function gitFacts(cwd) {
  const inRepo = run('git', ['rev-parse', '--is-inside-work-tree'], cwd) === 'true';
  if (!inRepo) return null;
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const head = run('git', ['rev-parse', '--short', 'HEAD'], cwd);
  const status = run('git', ['status', '--porcelain'], cwd);
  const log = run('git', ['log', '-8', '--pretty=format:%h %ad %s', '--date=short'], cwd);
  const diffstat = run('git', ['diff', '--stat', 'HEAD'], cwd);
  const dirty = status ? status.split(/\r?\n/).filter(Boolean) : [];
  return { branch, head, dirty, log: log ? log.split(/\r?\n/) : [], diffstat };
}

function memoryIndex(cwd) {
  if (!cbRoot) return { dir: '', index: '' };
  const projects = path.join(cbRoot, 'projects');
  if (!exists(projects)) return { dir: '', index: '' };
  const drive = cwd.match(/^([a-zA-Z]):[\\/]/);
  const parts = path.resolve(cwd).split(/[\\/]+/).filter(Boolean);
  const segs = drive ? [drive[1].toLowerCase(), ...parts.slice(1)] : parts;
  const guess = segs.join('-');
  let dir = path.join(projects, guess);
  if (!exists(dir)) {
    const base = path.basename(path.resolve(cwd)).toLowerCase();
    try {
      const hit = fs.readdirSync(projects).find((n) => n.toLowerCase().endsWith(base));
      if (hit) dir = path.join(projects, hit);
    } catch {}
  }
  if (!exists(dir)) return { dir: '', index: '' };
  const mem = path.join(dir, 'memory');
  const idx = path.join(mem, 'MEMORY.md');
  return { dir: mem, index: exists(idx) ? safeRead(idx, 20000) : '' };
}

function projectDocs(cwd) {
  const names = ['AGENTS.md', 'CODEBUDDY.md', 'CLAUDE.md', 'README.md'];
  return names.filter((n) => exists(path.join(cwd, n)));
}

function ruleFiles(cwd) {
  const root = path.join(cwd, '.codebuddy', 'rules');
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let items = [];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const p = path.join(dir, it.name);
      if (it.isDirectory()) walk(p, depth + 1);
      else if (/\.(md|mdc)$/i.test(it.name)) out.push(path.relative(cwd, p).replace(/\\/g, '/'));
    }
  };
  walk(root, 0);
  return out;
}

/* ------------------------------------------------------------- composing */

function pickSession(sessions, cwd) {
  const mine = sessions.filter((s) => s.cwd && norm(s.cwd) === norm(cwd));
  const pool = (mine.length ? mine : sessions).slice();
  pool.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return pool[0] || null;
}

function fmtTurns(turns) {
  if (!turns.length) {
    return '（本机未采集到用户原话：当前会话消息未落盘，属正常情况。§7 由 Agent 依上下文手写。）\n';
  }
  let total = 0;
  const blocks = [];
  turns.forEach((t, i) => {
    let text = t.text;
    if (text.length > MAX_TURN_CHARS) text = text.slice(0, MAX_TURN_CHARS) + '\n…（本条过长，已截断）';
    if (total + text.length > MAX_TURNS_TOTAL) return;
    total += text.length;
    const when = t.at ? new Date(t.at).toLocaleString('zh-CN', { hour12: false }) : '';
    const meta = [when, t.mode, t.model].filter(Boolean).join(' · ');
    const quoted = text
      .split(/\r?\n/)
      .map((l) => (l ? `> ${l}` : '>'))
      .join('\n');
    blocks.push(`#### 第 ${i + 1} 轮${meta ? `　<sub>${meta}</sub>` : ''}\n\n${quoted}`);
  });
  return blocks.join('\n\n') + '\n';
}

function buildPack(ctx) {
  const { title, project, cwd, cid, turns, git, todos, plan, mem, docs, rules, redactions } = ctx;
  const now = new Date();
  const id = `${stampCompact(now)}-${crypto.randomBytes(2).toString('hex')}`;
  const openTodos = (todos?.todos || []).filter((t) => t.status !== 'completed' && t.status !== 'cancelled');
  const doneTodos = (todos?.todos || []).filter((t) => t.status === 'completed');

  const fm = [
    '---',
    `pack: ${PACK_FORMAT}`,
    `id: ${id}`,
    `title: ${oneLine(title, 300)}`,
    `project: ${oneLine(project, 80)}`,
    `cwd: ${toPosix(cwd)}`,
    `created_at: ${isoLocal(now)}`,
    `source_session: ${cid || 'unknown'}`,
    `git_branch: ${git?.branch || ''}`,
    `git_head: ${git?.head || ''}`,
    `git_dirty: ${git ? git.dirty.length : 0}`,
    `user_turns: ${turns.length}`,
    `status: draft`,
    `skill_version: ${SKILL_VERSION}`,
    '---',
    '',
  ].join('\n');

  const factsJson = {
    format: PACK_FORMAT,
    skill_version: SKILL_VERSION,
    collected_at: isoLocal(now),
    cb_root: cbRoot || null,
    session: { conversationId: cid, title: oneLine(title, 300), cwd: toPosix(cwd) },
    git: git
      ? {
          branch: git.branch,
          head: git.head,
          dirty: git.dirty.slice(0, 60),
          recent_commits: git.log,
          diffstat: git.diffstat,
        }
      : null,
    todos: todos
      ? {
          open: openTodos.map((t) => ({ id: t.id, content: t.content, status: t.status })),
          done: doneTodos.map((t) => ({ id: t.id, content: t.content })),
        }
      : null,
    plan_excerpt: plan ? plan.slice(0, 3000) : '',
    docs,
    rules,
    memory_index: mem.index ? mem.index.split(/\r?\n/).filter((l) => l.trim().startsWith('- ')) : [],
    redactions,
  };

  const body = `
# 对话蒸馏包 · ${oneLine(title, 120)}

> 生成方式：Agent 蒸馏（结论）+ \`distill.mjs sout\`（硬事实）。\n> 接收方式：在新会话里 \`/Sin <本文件路径>\`，或直接把本文件拖进对话。

## 0. 一句话现状

${PLACEHOLDER}

## 1. 用户真正要什么

${PLACEHOLDER}

## 2. 决策记录

${PLACEHOLDER}

## 3. 已完成（附证据）

${PLACEHOLDER}

## 4. 未完成 / 下一步

${PLACEHOLDER}

## 5. 关键事实、约束与红线

${PLACEHOLDER}

## 6. 文件地图

${PLACEHOLDER}

## 7. 对话脉络与关键原话

${PLACEHOLDER}

## 8. 待澄清 / 风险 / 我判断不了的地方

${PLACEHOLDER}

## 附录 A · 环境快照（自动采集，可忽略）

\`\`\`json
${JSON.stringify(factsJson, null, 2)}
\`\`\`

## 附录 B · 本机采集的用户原话（自动，可能为空）

${fmtTurns(turns)}`;

  return { id, markdown: fm + body, factsJson };
}

/* ------------------------------------------------------------ frontmatter */

function splitFrontmatter(md) {
  if (!md.startsWith('---')) return { fm: {}, raw: md, bodyStart: 0 };
  const end = md.indexOf('\n---', 3);
  if (end < 0) return { fm: {}, raw: md, bodyStart: 0 };
  const rawFm = md.slice(4, end);
  const after = md.indexOf('\n', end + 4);
  const fm = {};
  for (const line of rawFm.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) fm[m[1]] = m[2].trim();
  }
  return { fm, raw: rawFm, bodyStart: after < 0 ? md.length : after + 1, body: md.slice(after < 0 ? md.length : after + 1) };
}

function setFrontmatterKey(md, key, value) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return md;
  let raw = m[1];
  const re = new RegExp(`^${key}:.*$`, 'm');
  if (re.test(raw)) raw = raw.replace(re, `${key}: ${value}`);
  else raw += `\n${key}: ${value}`;
  return `---\n${raw}\n---\n` + md.slice(m[0].length);
}

/* ------------------------------------------------------------------ sout */

function cmdSout() {
  const cwd = process.cwd();
  const sessions = readSessions();

  if (flags['list-sessions']) {
    if (!sessions.length) {
      console.log('[Sout] 读不到本地会话元数据（Node < 22 或无 sqlite）。可用 --session 手动指定。');
      return;
    }
    const mine = sessions
      .filter((s) => !s.cwd || norm(s.cwd) === norm(cwd))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    console.log(`[Sout] ${path.resolve(cwd)} 下的会话（新→旧）：`);
    for (const s of mine.slice(0, 20)) {
      console.log(`  ${s.conversationId}  ${new Date(s.createdAt || 0).toLocaleString('zh-CN', { hour12: false })}  ${oneLine(s.title, 60)}`);
    }
    return;
  }

  let session = null;
  if (flags.session) session = sessions.find((s) => s.conversationId === String(flags.session)) || { conversationId: String(flags.session), cwd, title: '' };
  else session = pickSession(sessions, cwd);

  const queue = readMessageQueue();
  let cid = session?.conversationId || '';
  let title = session?.title || '';

  if (!cid) {
    // 退化路径：取本地队列里最近活跃的会话
    let best = '';
    let bestAt = 0;
    for (const [k, items] of queue) {
      for (const it of items.values()) if ((it.createdAt || 0) > bestAt) ((bestAt = it.createdAt || 0), (best = k));
    }
    cid = best;
  }

  let turns = cid ? turnsOf(queue.get(cid)) : [];
  if (!title && turns.length) title = turns[0].text;

  const git = gitFacts(cwd);
  const todos = cid ? readTodos(cid) : null;
  const plan = cid ? readPlan(cid) : '';
  const mem = memoryIndex(cwd);
  const docs = projectDocs(cwd);
  const rules = ruleFiles(cwd).slice(0, 40);
  const project = path.basename(path.resolve(cwd));

  let redactions = 0;
  const redactTurns = turns.map((t) => {
    const r = redact(t.text);
    redactions += r.hits;
    return { ...t, text: r.text };
  });

  const ctx = {
    title: title || `${project} 会话`,
    project,
    cwd,
    cid,
    turns: flags['no-facts'] ? [] : redactTurns,
    git,
    todos,
    plan: plan ? redact(plan).text : '',
    mem,
    docs,
    rules,
    redactions,
  };
  const { id, markdown, factsJson } = buildPack(ctx);

  const outDir = flags.out ? path.resolve(String(flags.out)) : inbox;
  fs.mkdirSync(outDir, { recursive: true });
  const fileName = `distill-${project}-${stampCompact()}.md`;
  const file = path.join(outDir, fileName);
  let finalPath = file;
  for (let i = 2; exists(finalPath); i++) finalPath = file.replace(/\.md$/, `-${i}.md`);
  fs.writeFileSync(finalPath, redact(markdown).text, 'utf8');

  // 索引
  try {
    const idxFile = path.join(inbox, 'index.json');
    let idx = { version: 1, packs: [] };
    if (exists(idxFile)) {
      try {
        idx = JSON.parse(safeRead(idxFile)) || idx;
      } catch {}
    }
    idx.packs = (idx.packs || []).filter((p) => p.id !== id);
    idx.packs.unshift({
      id,
      file: finalPath.replace(/\\/g, '/'),
      title: ctx.title,
      project,
      cwd: toPosix(cwd),
      session: cid || '',
      created_at: factsJson.collected_at,
      status: 'draft',
    });
    idx.packs = idx.packs.slice(0, 200);
    fs.writeFileSync(idxFile, JSON.stringify(idx, null, 2), 'utf8');
  } catch {}

  // 给 Agent 的简报（简洁、可判定）
  const openCount = (factsJson.todos?.open || []).length;
  const doneCount = (factsJson.todos?.done || []).length;
  const placeholders = countPlaceholders(markdown);
  console.log(`[Sout] 已生成骨架：${finalPath.replace(/\\/g, '/')}`);
  console.log(`  会话   ${cid || '(未识别)'}  「${oneLine(ctx.title, 60)}」`);
  console.log(`  用户原话 ${redactTurns.length} 条（附录 B；空则 §7 全靠 Agent 手写）`);
  console.log(`  待办   ${openCount} 未完成 / ${doneCount} 已完成`);
  console.log(`  Git    ${git ? `${git.branch}@${git.head}，脏文件 ${git.dirty.length}` : '非 git 仓库'}`);
  console.log(`  脱敏   ${redactions} 处`);
  if (ctx.turns.length === 0 && flags.session) {
    console.log('  [!] 该会话在本机没有原话缓存，确认 --session 是否选错（--list-sessions 可列出候选）。');
  }
  const self = (process.argv[1] || 'distill.mjs').replace(/\\/g, '/');
  console.log(`\n下一步：读取 ${finalPath.replace(/\\/g, '/')}，把 ${placeholders} 处 ${PLACEHOLDER} 写成蒸馏正文，然后运行：`);
  console.log(`  node "${self}" finalize "${finalPath.replace(/\\/g, '/')}"`);
}

/* ----------------------------------------------------------- finalize */

function cmdFinalize() {
  const target = positional[0] || flags.pack;
  if (!target) fail('用法：distill.mjs finalize <pack.md>');
  const file = path.resolve(String(target));
  if (!exists(file)) fail(`找不到文件：${file}`);
  let md = safeRead(file);
  const { fm } = splitFrontmatter(md);
  if (fm.pack !== PACK_FORMAT) fail(`不是 ${PACK_FORMAT} 包（frontmatter.pack=${fm.pack || '缺失'}）`);

  const bodyStart = splitFrontmatter(md).bodyStart;
  const body = md.slice(bodyStart);
  const remaining = countPlaceholders(body);
  const chars = body.replace(/\s/g, '').length;
  const sha = crypto.createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 16);

  md = setFrontmatterKey(md, 'status', remaining ? 'draft' : 'final');
  md = setFrontmatterKey(md, 'chars', String(chars));
  md = setFrontmatterKey(md, 'body_sha256_16', sha);
  md = setFrontmatterKey(md, 'finalized_at', isoLocal());
  fs.writeFileSync(file, md, 'utf8');

  const id = fm.id;
  try {
    const idxFile = path.join(inbox, 'index.json');
    if (exists(idxFile)) {
      const idx = JSON.parse(safeRead(idxFile));
      const hit = (idx.packs || []).find((p) => p.id === id || norm(p.file) === norm(file));
      if (hit) {
        hit.status = remaining ? 'draft' : 'final';
        hit.chars = chars;
        fs.writeFileSync(idxFile, JSON.stringify(idx, null, 2), 'utf8');
      }
    }
  } catch {}

  console.log(`[Finalize] ${remaining ? `仍有 ${remaining} 处占位未填` : '全部填满'}｜正文 ${chars} 字｜sha256:${sha}`);
  if (remaining) {
    console.log('  提醒：占位没填完的包导入后会出现空洞，逐条补齐再 finalize。');
    process.exitCode = 2;
  } else {
    console.log('  可以交接了：把该 .md 发给对方 / 换机后 /Sin。');
  }
}

/* ------------------------------------------------------------------- sin */

function extractSection(body, n) {
  // 不用 m 标志：否则 $ 会匹配行尾，导致只截到标题行
  const re = new RegExp(`(?:^|\\n)##\\s*${n}\\.[\\s\\S]*?(?=\\n##\\s|(?![\\s\\S]))`);
  const m = body.match(re);
  return m ? m[0].trim() : '';
}

function looksLikePath(s) {
  if (/[<>*?]/.test(s)) return false; // 模板占位（distill-<项目>-<时间>.md）无法判定
  if (/^(https?:|mailto:)/i.test(s)) return false;
  if (/^\/[^/]+$/.test(s)) return false; // /Sout、/Sin 这类命令
  return /[\\/]/.test(s) && /\.[a-z0-9]{1,8}$/i.test(s);
}

function cmdSin() {
  let file = positional[0] || flags.pack;
  if (!file || flags.latest) {
    const idxFile = path.join(inbox, 'index.json');
    if (exists(idxFile)) {
      const idx = JSON.parse(safeRead(idxFile));
      const newest = (idx.packs || []).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
      if (newest && exists(newest.file)) file = newest.file;
    }
    if (!file && exists(inbox)) {
      const cands = fs
        .readdirSync(inbox)
        .filter((f) => f.endsWith('.md'))
        .map((f) => path.join(inbox, f))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      if (cands.length) file = cands[0];
    }
  }
  if (!file) fail('用法：distill.mjs sin <pack.md | --latest>');

  const abs = path.resolve(String(file));
  if (!exists(abs)) fail(`找不到蒸馏包：${abs}`);
  const md = safeRead(abs, 5_000_000);
  const { fm, body } = splitFrontmatter(md);
  if (fm.pack !== PACK_FORMAT) fail(`格式不匹配：期望 ${PACK_FORMAT}，实际 ${fm.pack || '（无 frontmatter）'}`);
  if (!body) fail('包内容为空');

  const packCwd = fm.cwd && fm.cwd !== 'undefined' ? fm.cwd : '';
  const curCwdNorm = norm(process.cwd());
  const curCwd = toPosix(process.cwd());
  const curGit = gitFacts(process.cwd());

  const sections = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((n) => {
    const s = extractSection(body, n);
    const filled = s && !PLACEHOLDER_LINE.test(s);
    return { n, filled, chars: s.replace(/^##.*$/m, '').replace(/\s/g, '').length };
  });
  const placeholders = countPlaceholders(body);

  // 路径漂移检查（§6 文件地图里出现的工作区相对路径）
  const sec6 = extractSection(body, 6);
  const referenced = [...sec6.matchAll(/`([^`\n]{2,160})`/g)].map((m) => m[1].trim()).filter(looksLikePath);
  const missing = [];
  for (const p of [...new Set(referenced)].slice(0, 60)) {
    if (/^(https?:|mailto:|[A-Za-z]:)/i.test(p) && !/^[A-Za-z]:[\\/]/.test(p)) continue;
    const abs2 = /^[A-Za-z]:[\\/]/.test(p) ? p : path.resolve(packCwd || process.cwd(), p);
    if (!exists(abs2)) missing.push(p);
  }

  const ageMs = fm.created_at ? Date.now() - Date.parse(fm.created_at) : 0;
  const ageLabel = !Number.isFinite(ageMs) || ageMs <= 0
    ? ''
    : ageMs < 3600000
      ? `（${Math.max(1, Math.round(ageMs / 60000))} 分钟前）`
      : `（${Math.round((ageMs / 3600000) * 10) / 10} 小时前）`;
  const gitDrift = (() => {
    if (!fm.git_head || !curGit) return null;
    if (fm.git_head === curGit.head) return '一致';
    const ahead = run('git', ['rev-list', '--count', `${fm.git_head}..HEAD`], process.cwd());
    const behind = run('git', ['rev-list', '--count', `HEAD..${fm.git_head}`], process.cwd());
    return `导出时 ${fm.git_head}@${fm.git_branch} → 现在 ${curGit.head}@${curGit.branch}（领先 ${ahead || '?'} / 落后 ${behind || '?'}）`;
  })();

  const say = [];
  say.push(`[Sin] ✅ 格式 ${fm.pack} ｜ 包「${fm.title || '(无标题)'}」`);
  say.push(`  导出   ${fm.created_at}${ageLabel}｜ ${fm.chars || '?'} 字 ｜ ${fm.status || 'draft'}`);
  say.push(`  项目   ${fm.project || '?'} ｜ 包内 cwd: ${packCwd || '?'}`);
  say.push(`  当前   ${curCwd}${packCwd && norm(packCwd) === curCwdNorm ? '（一致）' : '（⚠ 不一致：包可能是别的项目/机器导出的，路径需重新对照）'}`);
  if (gitDrift) say.push(`  Git    ${gitDrift}`);
  if (fm.git_dirty && curGit) say.push(`  脏文件 导出时 ${fm.git_dirty} 个 → 现在 ${curGit.dirty.length} 个`);
  say.push(`  源会话 ${fm.source_session || '?'} ｜ 用户原话 ${fm.user_turns || 0} 条`);
  say.push(`  章节   ${sections.map((s) => `${s.n}${s.filled ? '✅' : '⬜'}`).join(' ')}`);
  if (placeholders) say.push(`  ⚠ 还有 ${placeholders} 处「${PLACEHOLDER}」未填，这部分信息缺失`);
  if (missing.length) say.push(`  ⚠ §6 中 ${missing.length} 个路径当前不存在：${missing.slice(0, 6).join('、')}${missing.length > 6 ? ' …' : ''}`);
  if (curGit && curGit.dirty.length) say.push(`  当前脏文件：${curGit.dirty.slice(0, 5).join('、')}${curGit.dirty.length > 5 ? ' …' : ''}`);

  const next = extractSection(body, 4);
  if (next) {
    const lines = next.split(/\r?\n/).filter((l) => /^\s*(?:[-*]|\d+\.)\s+/.test(l)).slice(0, 8);
    if (lines.length) {
      say.push('  下一步（摘自 §4）：');
      for (const l of lines) say.push(`    ${l.trim()}`);
    }
  }
  say.push(`\n  包路径 ${abs.replace(/\\/g, '/')}`);
  say.push('  提示：现在请完整读取该文件，按 §0→§4 向用户复述接管结论，再继续干活。');

  try {
    fs.mkdirSync(inbox, { recursive: true });
    fs.writeFileSync(
      path.join(inbox, '.last-import.json'),
      JSON.stringify({ file: abs.replace(/\\/g, '/'), id: fm.id, imported_at: isoLocal(), cwd: curCwd, placeholders }, null, 2),
      'utf8'
    );
  } catch {}

  console.log(say.join('\n'));

  if (flags.strict && (placeholders || missing.length || (gitDrift && gitDrift !== '一致'))) {
    process.exitCode = 3;
  }
}

/* ------------------------------------------------------------------ list */

function cmdList() {
  const idxFile = path.join(inbox, 'index.json');
  if (!exists(idxFile)) {
    console.log(`[List] 收件箱为空：${inbox.replace(/\\/g, '/')}`);
    return;
  }
  const idx = JSON.parse(safeRead(idxFile));
  const packs = idx.packs || [];
  if (!packs.length) return console.log(`[List] 收件箱为空：${inbox.replace(/\\/g, '/')}`);
  console.log(`[List] ${packs.length} 个蒸馏包｜${inbox.replace(/\\/g, '/')}`);
  for (const p of packs.slice(0, 30)) {
    const mark = p.status === 'final' ? '✅' : '📝';
    console.log(`  ${mark} ${p.created_at}  ${oneLine(p.title, 46)}  [${p.project}]`);
    console.log(`     ${p.file}`);
  }
}

/* ------------------------------------------------------------------ main */

function fail(msg) {
  console.error(`[distill] ${msg}`);
  process.exit(1);
}

if (!['sout', 'sin', 'list', 'finalize'].includes(cmd)) {
  fail(`未知子命令 "${cmd}"。可用：sout | sin | list | finalize`);
}

if (cmd === 'sout') cmdSout();
else if (cmd === 'sin') cmdSin();
else if (cmd === 'list') cmdList();
else cmdFinalize();
