#!/usr/bin/env node
/**
 * 桥方法「返回值形状」扫描器（批次 E 系统性排查的常驻版）
 *
 * 为什么需要它：本仓所有桥都套了 Proxy 兜底（app 侧 makeBridge / 壳侧 wrapShellBridge），
 * 未实现的方法**不会**抛「is not a function」，而是返回 Promise.resolve(undefined)。
 * 渲染层只要写成下面任一种，就从「点了没反应」升级成真机崩溃：
 *   ns.m?.().then(v => v.ok)        // reading 'ok' of undefined
 *   const v = await ns.m?.()        // 之后 v.settings / v.length
 *   ns.m?.().then(({ a }) => ...)   // 解构 undefined 直接抛
 *
 * 三轮真机崩溃（getAutoSaveDefault / getCustomModels / getMcpStatus）都是这一个形态。
 *
 * 三个必须记住的口径（每一个都是踩出来的）：
 *  1) 调用点抽取必须吃**可选链**：旧正则要求「方法名紧跟左括号」，`m?.()` 整类漏掉（实测 48 个
 *     ns.method 组合不可见）→ 统一由 lib/bridge-coverage.mjs 负责，本脚本复用，不另造解析器。
 *  2) 实现形状必须认 **__goBoot**：deck 引导层的键会被 Object.keys(...).forEach 并进 base mock，
 *     少这个 marker 会把 PPT 已实现的操作报成未实现（假债）。
 *  3) `method: fnName,` 的**简写委托**要跟到目标函数体再判形状，否则 generateImage 这类被误报。
 *
 * 用法：
 *   node scripts/scan-bridge-shapes.mjs            # 人读报告
 *   node scripts/scan-bridge-shapes.mjs --json     # 机器读
 *   node scripts/scan-bridge-shapes.mjs --check    # 门禁模式（verify-all 调这个）
 *   node scripts/scan-bridge-shapes.mjs --rebase   # 把当前条目数写进白名单 risk-budget
 *
 * ⚠️ 顺序：check-bridge-coverage.mjs --update 会整体重写白名单并**丢掉 risk-budget** →
 *    跑完 --update 必须再跑一次 --rebase（否则预算退回 0，已登记的债会全报红）。
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractWindowCalls, parseMockKeys, NS_IMPL } from './lib/bridge-coverage.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HARMONY = dirname(HERE);
const ROOT = dirname(HARMONY);
const ALLOWLIST = join(HERE, 'bridge-coverage-allowlist.json');
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const checkMode = argv.includes('--check');
const rebase = argv.includes('--rebase');

/**
 * 「resolved 值被解引用」的语法形态。刻意按**形态**判、不按属性名枚举：
 * 上游那份列字段名的启发式没列到 `.running`，于是 getMcpStatus 从它眼皮底下崩了出去。
 */
const DEREF_PATTERNS = [
  { re: /\.then\(\s*\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>[\s\S]{0,200}?\1\s*(?:\?\.[A-Za-z_$]|\.\w|\[\s*\d|\(\s*\))/, why: 'then 回调解引用参数' },
  { re: /\.then\(\s*\(\s*\{/, why: 'then 回调对参数解构' },
];

/** 回调里先做了真值/类型守卫的不会崩 —— 必须排除，否则清单被噪声淹没（61 → 25 就是这么来的）。 */
function guarded(window, varName) {
  if (!varName) { return false; }
  const re = new RegExp(
    '(if\\s*\\(\\s*!?' + varName + '\\b|' + varName + '\\s*(?:&&|\\?)|\\b(?:typeof|Array\\.isArray)\\s*\\(\\s*' +
      varName + '\\b|' + varName + '\\s*\\?\\.)',
  );
  return re.test(window);
}

function derefHits(lines, at, code, site) {
  const hits = [];
  for (const p of DEREF_PATTERNS) {
    const m = p.re.exec(code);
    if (!m) { continue; }
    if (guarded(code.slice(m.index), m[1])) { continue; }
    hits.push({ site, why: p.why });
    return hits;
  }
  const aw = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\b/.exec(lines[at] || '');
  if (aw) {
    const after = lines.slice(at + 1, at + 10).join('\n');
    const re = new RegExp('(^|[^\\w$.])' + aw[1] + '\\s*(?:\\?\\.|\\.|\\[\\s*\\d|\\|\\||&&)');
    const m2 = re.exec(after);
    if (m2 && !guarded(after.slice(m2.index), aw[1])) {
      hits.push({ site, why: 'await 结果未判空即解引用' });
    }
  }
  return hits;
}

/** 实现体：从方法键起，到**下一个兄弟键**或本对象收尾。按固定字符数切会吃进相邻方法。 */
function bodyOf(src, from) {
  const rest = src.slice(from);
  const nextKey = rest.slice(1).search(/\n\s{2,6}[A-Za-z_$][\w$]*\s*:\s*(?:function|async|[A-Za-z_$][\w$]*\s*,)/);
  const close = rest.slice(1).search(/\n\s{4}\},?\s*$/m);
  const cuts = [nextKey > 0 ? nextKey + 1 : -1, close > 0 ? close + 1 : -1].filter((x) => x > 0);
  const end = cuts.length ? Math.min.apply(null, cuts) : 900;
  return rest.slice(0, Math.min(end, 1400));
}

const indexSrc = readFileSync(join(HARMONY, 'entry/src/main/ets/pages/Index.ets'), 'utf8');
const mockKeys = parseMockKeys(indexSrc);

/** 该方法在壳侧「看起来返回什么」：object / array / computed / async / primitive / noop / unknown / missing */
function shapeOf(ns, method) {
  const esc = method.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const marker of NS_IMPL[ns] || []) {
    const keys = mockKeys[marker];
    if (!keys || !keys.has(method)) { continue; }
    // 正规写法 `method: function` / 简写委托 `method: fnName,`（跟到目标函数体再判形状）
    let at = indexSrc.search(new RegExp('^\\s*' + esc + '\\s*:\\s*(?:async\\s+)?function', 'm'));
    if (at < 0) {
      const short = new RegExp('^\\s*' + esc + '\\s*:\\s*([A-Za-z_$][A-Za-z0-9_$]*)\\s*,', 'm').exec(indexSrc);
      if (short) {
        const fn = new RegExp('\\n\\s*(?:async\\s+)?function\\s+' + short[1] + '\\s*\\(').exec(indexSrc);
        if (fn) { at = fn.index; }
      }
    }
    if (at < 0) { return 'declared-only'; }
    const body = bodyOf(indexSrc, at);
    if (/Promise\.resolve\(\s*\{/.test(body)) { return 'object'; }
    if (/Promise\.resolve\(\s*\[/.test(body)) { return 'array'; }
    if (/Promise\.resolve\(\s*(?:load|get|default|[A-Za-z_$][\w$]*\s*[;,)])/.test(body)) { return 'computed'; }
    if (/goJson|goNative|\.then\(/.test(body)) { return 'async'; }
    // pptxOp：M9 起 slidesMock 引擎 op 的统一异步包装（同 goJson 的桥调用性质，
    // 无会话时自身 resolve(null)，返回值由调用点守卫）
    if (/pptxOp\(/.test(body)) { return 'async'; }
    if (/Promise\.resolve\(/.test(body)) { return 'primitive'; }
    if (/return\s+(?:null|false|0|'')\s*[;,]/.test(body)) { return 'primitive'; }
    if (/Promise\.resolve\(\s*\)/.test(body)) { return 'noop'; }
    return 'unknown';
  }
  return 'missing';
}

function walk(dir, out) {
  if (!existsSync(dir)) { return out; }
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name === 'build') { continue; }
    const p = join(dir, ent.name);
    if (ent.isDirectory()) { walk(p, out); }
    else if (/\.(ts|tsx)$/.test(ent.name)) { out.push(p); }
  }
  return out;
}

const files = [];
for (const sub of ['apps', 'packages']) { walk(resolve(ROOT, sub), files); }
const appFiles = files.map((p) => ({ path: p.slice(ROOT.length + 1), text: readFileSync(p, 'utf8') }));
const calls = extractWindowCalls(appFiles);
const lineCache = new Map();
function linesOf(rel) {
  if (!lineCache.has(rel)) { lineCache.set(rel, readFileSync(resolve(ROOT, rel), 'utf8').split('\n')); }
  return lineCache.get(rel);
}

const NO_SHAPE = { missing: 1, noop: 1, unknown: 1, 'declared-only': 1 };
const rows = [];
for (const [ns, per] of calls) {
  for (const [method, sites] of per) {
    const shape = shapeOf(ns, method);
    if (!NO_SHAPE[shape]) { continue; }
    const hits = [];
    for (const s of sites) {
      const rel = s.site.split(':')[0];
      const at = parseInt(s.site.split(':')[1], 10) - 1;
      if (!existsSync(resolve(ROOT, rel))) { continue; }
      const lines = linesOf(rel);
      hits.push.apply(hits, derefHits(lines, at, lines.slice(at, at + 10).join('\n'), s.site));
    }
    if (hits.length) { rows.push({ ns, method, shape, ui: sites.length, sites: hits.slice(0, 3) }); }
  }
}
rows.sort((a, b) => ((a.ns + '.' + a.method) < (b.ns + '.' + b.method) ? -1 : 1));

const al = existsSync(ALLOWLIST) ? JSON.parse(readFileSync(ALLOWLIST, 'utf8')) : {};
const riskBudget = typeof al['risk-budget'] === 'number' ? al['risk-budget'] : 0;

if (rebase) {
  al['risk-budget'] = rows.length;
  al['_risk_comment'] = 'scan-bridge-shapes.mjs --rebase 写入：被解引用且壳侧无形状的条目数，只减不增';
  writeFileSync(ALLOWLIST, JSON.stringify(al, null, 2) + '\n');
  console.log('[scan] risk-budget = ' + rows.length + ' 已写入白名单');
  process.exit(0);
}

if (asJson) {
  console.log(JSON.stringify({ total: rows.length, riskBudget, rows }, null, 2));
} else if (!checkMode) {
  console.log('桥方法形状扫描：解引用风险条目 ' + rows.length + '（白名单 risk-budget=' + riskBudget + '）');
  for (const r of rows) {
    console.log('  ' + r.ns + '.' + r.method + '  壳侧=' + r.shape + '  UI 调用点 ' + r.ui);
    for (const h of r.sites) { console.log('      - ' + h.site + '  ' + h.why); }
  }
  if (!rows.length) { console.log('  （无：所有被解引用的桥方法都有真实返回形状）'); }
}

if (checkMode) {
  if (rows.length > riskBudget) {
    console.error('[FAIL] 解引用风险条目 ' + rows.length + ' > risk-budget ' + riskBudget + '：');
    for (const r of rows.slice(0, 12)) {
      console.error('  - ' + r.ns + '.' + r.method + ' 壳侧只给 ' + r.shape + '，调用点却解引用 → ' + r.sites[0].site);
    }
    console.error('处置：给真实形状（参照 getMcpStatus）；确实做不了就 --rebase，让评审在 git diff 里看见预算变化。');
    process.exit(1);
  }
  console.log('[OK] 解引用风险条目 ' + rows.length + ' ≤ risk-budget ' + riskBudget);
}
