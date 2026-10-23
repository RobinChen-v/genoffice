#!/usr/bin/env node
// 桥覆盖门禁（批次 B）：渲染层调用面 ↔ 壳侧实现面，**白名单只减不增**。
//
// 为什么需要它：makeBridge 的 Proxy 对未实现方法静默 resolve(undefined)，
// 「点了没反应 / 白屏 / 报 undefined」的绝大多数根因都在这里；verify-all 的
// checkBridgeRegistration 只覆盖反方向（native→壳侧注册），这一侧是盲区。
//
//   node scripts/check-bridge-coverage.mjs            体检（有新增缺口/白名单过期 → exit 1）
//   node scripts/check-bridge-coverage.mjs --update    重写白名单（= 现状快照，git diff 里能看见预算变化）
//   node scripts/check-bridge-coverage.mjs --json      机器可读输出
//   node scripts/check-bridge-coverage.mjs --list      列出全部缺口明细
//
// 白名单（scripts/bridge-coverage-allowlist.json）里的每条 = 一个已知缺口，
// 修掉一个就必须删一条（否则 verify-all 报「白名单过期」）；budget 只能改小。
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseMockKeys, parseNativeMethods, extractWindowCalls, computeGaps,
  judgeAllowlist, summarize, toAllowlistEntries, gapKey,
  nsCounts, formatCoverageMarker, parseCoverageMarker, judgeLimitsDocs,
  parseContractMethods, computeContractGaps, computeUncontractedImpls,
  NS_IMPL, nativeCovers,
} from './lib/bridge-coverage.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPO_ROOT = resolve(__dirname, '..', '..');
export const DEFAULT_ALLOWLIST = resolve(__dirname, 'bridge-coverage-allowlist.json');
export const DEFAULT_CONTRACT = resolve(__dirname, 'bridge-contract.json');
// 两份用户可见文档（批次 C：已知限制必须与实际缺口数一致，防「文档说支持、点了没反应」）
export const BETA_CHECKLIST = resolve(__dirname, '..', 'BETA-CHECKLIST.md');
export const BETA_NOTES = resolve(__dirname, '..', 'BETA-RELEASE-NOTES.md');

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.tmp', 'out', 'coverage']);

function walk(dir, exts, out) {
  let names;
  try { names = readdirSync(dir) } catch { return out }
  for (const n of names) {
    if (SKIP_DIRS.has(n)) continue;
    const p = join(dir, n);
    let st;
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) walk(p, exts, out);
    else if (exts.some((e) => n.endsWith(e))) out.push(p);
  }
  return out;
}

/** 读盘 → 调用面/实现面 → 缺口。读空即抛（防「路径写错 → 门禁永远绿」）。 */
export function collectGaps({ repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const indexPath = join(repoRoot, 'harmony/entry/src/main/ets/pages/Index.ets');
  if (!existsSync(indexPath)) throw new Error('未找到 Index.ets：' + indexPath);
  const indexSrc = readFileSync(indexPath, 'utf8');
  if (indexSrc.length < 100000) {
    throw new Error('Index.ets 读到的内容过短（' + indexSrc.length + ' 字节）—— 构建产物被裁剪？门禁拒绝假绿');
  }

  const bridgeDir = join(repoRoot, 'harmony/entry/src/main/ets/bridge');
  const bridgeFiles = existsSync(bridgeDir) ? walk(bridgeDir, ['.ets'], []) : [];
  if (bridgeFiles.length === 0) throw new Error('未找到桥类源码：' + bridgeDir);
  const bridgeTexts = bridgeFiles.map((p) => readFileSync(p, 'utf8'));

  const appsDir = join(repoRoot, 'apps');
  if (!existsSync(appsDir)) throw new Error('未找到 apps 目录：' + appsDir);
  const appPaths = walk(appsDir, ['.ts', '.tsx'], []);
  if (appPaths.length < 50) throw new Error('apps 下只扫到 ' + appPaths.length + ' 个 ts/tsx —— 路径或忽略规则写错了');
  const appFiles = appPaths.map((p) => ({ path: relative(repoRoot, p), text: readFileSync(p, 'utf8') }));

  const mockKeys = parseMockKeys(indexSrc);
  const native = parseNativeMethods(bridgeTexts);
  const calls = extractWindowCalls(appFiles);
  const gaps = computeGaps({ mockKeys, native, calls });
  return { gaps, stats: { indexBytes: indexSrc.length, bridgeFiles: bridgeFiles.length, appFiles: appFiles.length, nativeMethods: native.size } };
}

export function readAllowlist(allowlistPath = DEFAULT_ALLOWLIST) {
  if (!existsSync(allowlistPath)) return { budget: 0, entries: [] };
  return JSON.parse(readFileSync(allowlistPath, 'utf8'));
}

/**
 * 门禁主体：verify-all 与 CLI 共用。
 * @returns {{gaps:any[], judge:ReturnType<typeof judgeAllowlist>, stats:any, contractErrors:string[]}}
 * @throws 当存在新增缺口 / 白名单过期 / 超出预算 / 契约不一致
 */
export function runBridgeCoverageCheck({ repoRoot = DEFAULT_REPO_ROOT, allowlistPath = DEFAULT_ALLOWLIST, contractPath = DEFAULT_CONTRACT } = {}) {
  const { gaps, stats } = collectGaps({ repoRoot });
  const allowlist = readAllowlist(allowlistPath);
  const judge = judgeAllowlist(gaps, allowlist);
  const sum = summarize(gaps);
  const errs = [];
  for (const g of judge.newGaps) {
    errs.push('新增桥缺口（渲染层调了、壳侧没实现）: ' + gapKey(g) + ' ×' + g.ui + ' 处起于 ' + g.sites[0].site +
      (g.risk ? ' [风险:' + g.risk + ']' : '') + ' —— 要么补实现，要么明写进白名单（budget 需同步 +1，review 可见）');
  }
  for (const e of judge.stale) {
    errs.push('白名单过期（该缺口已消失，请从 allowlist 删除）: ' + e.ns + '.' + e.method);
  }
  if (judge.overBudget) {
    errs.push('白名单条目数 ' + judge.count + ' > budget ' + judge.budget + ' —— 只减不增；确需扩容请用 --update 并说明理由');
  }

  // ── R2-5: 契约 ↔ 调用面 ↔ 实现面 三方对账 ──
  const contractErrors = [];
  if (existsSync(contractPath)) {
    const contractJson = JSON.parse(readFileSync(contractPath, 'utf8'));
    const contractMethods = parseContractMethods(contractJson);

    // 1. 调用面有、契约中没有 → 契约过期或渲染层 bug
    // 排除在实现面（mock + native）中已有方法——那些是鸿蒙侧特有的方法
    const { mockKeys, calls, native } = _extractForContract({ repoRoot });

    // 构建实现面方法集（与 computeGaps 的 impls 逻辑一致）
    const impls = {};
    for (const [ns, keys] of Object.entries(NS_IMPL)) {
      const set = new Set();
      for (const k of keys) for (const v of mockKeys[k] || []) set.add(v);
      impls[ns] = set;
    }

    const contractGaps = computeContractGaps({ contract: contractMethods, calls, impls, native });
    for (const g of contractGaps) {
      const reason = g.reason === 'namespace_not_in_contract'
        ? '命名空间不在契约中（新桥？契约过期？）'
        : '方法不在契约中（preload 加了新方法但契约没重新生成？）';
      contractErrors.push('契约缺口（渲染层调了、契约中没有）: ' + g.ns + '.' + g.method +
        ' ×' + g.sites.length + ' 处起于 ' + g.sites[0].site + ' —— ' + reason);
    }

    // 2. 实现面有、契约中没有 → 实现超出契约范围
    // R2 阶段：Index.ets 中的手工 mock 还没有被契约驱动的 mock.js 替代（R3 工作），
    // 所以「超契约实现」会产生大量噪音。暂时只统计不报红，等 R3 完成后启用。
    const uncontracted = computeUncontractedImpls({ contract: contractMethods, mockKeys });
    for (const u of uncontracted) {
      // 暂时不报红，只记录（R3 完成后改为报红）
      contractErrors.push('提示: 超契约实现（mock 中有、契约中没有）: ' + u.ns + '.' + u.method +
        ' —— R3 替代手工 mock 后将启用此检查');
    }
  } else {
    // 契约不存在时不报红（可能还没生成），但给出提示
    contractErrors.push('提示: bridge-contract.json 不存在，契约对账跳过（运行 gen-bridge-contract.mjs 生成）');
  }

  return { gaps, judge, stats, sum, errors: errs, contractErrors };
}

// 内部辅助：从 collectGaps 中提取 mockKeys、calls 和 native 供契约对账使用
function _extractForContract({ repoRoot }) {
  const indexPath = join(repoRoot, 'harmony/entry/src/main/ets/pages/Index.ets');
  const indexSrc = readFileSync(indexPath, 'utf8');
  const mockKeys = parseMockKeys(indexSrc);

  const bridgeDir = join(repoRoot, 'harmony/entry/src/main/ets/bridge');
  const bridgeFiles = existsSync(bridgeDir) ? walk(bridgeDir, ['.ets'], []) : [];
  const bridgeTexts = bridgeFiles.map((p) => readFileSync(p, 'utf8'));
  const native = parseNativeMethods(bridgeTexts);

  const appsDir = join(repoRoot, 'apps');
  const appPaths = walk(appsDir, ['.ts', '.tsx'], []);
  const appFiles = appPaths.map((p) => ({ path: relative(repoRoot, p), text: readFileSync(p, 'utf8') }));
  const calls = extractWindowCalls(appFiles);

  return { mockKeys, calls, native };
}


/**
 * 文档-实现一致性门禁（批次 C）：BETA-CHECKLIST.md 的机器可读标记 + BETA-RELEASE-NOTES.md
 * 的「## 5. 已知限制」小节必须与实际缺口对得上。数字只有一处机器可读来源（标记），
 * 由 --update 重写；文案里的分组名逐个校验（有缺口的 app 必须在限制里被点名）。
 * @returns {{errors: string[], counts: {total:number, byNs:Record<string,number>}}}
 */
export function runLimitsDocsCheck({ gaps, checklistPath = BETA_CHECKLIST, notesPath = BETA_NOTES } = {}) {
  const g = gaps || collectGaps({}).gaps;
  const counts = nsCounts(g);
  const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
  return { counts, errors: judgeLimitsDocs({ checklist: read(checklistPath), notes: read(notesPath), counts }) };
}

/** 把机器可读标记写进 BETA-CHECKLIST.md（已有则原位替换，没有则插到 §4.1 标题下）。 */
export function writeCoverageMarker(checklistPath, counts) {
  if (!existsSync(checklistPath)) throw new Error('未找到 BETA-CHECKLIST.md：' + checklistPath);
  const src = readFileSync(checklistPath, 'utf8');
  const marker = formatCoverageMarker(counts);
  const next = parseCoverageMarker(src)
    ? src.replace(/<!--\s*BRIDGE-COVERAGE:[^>]*?-->/, marker)
    : src.replace(/(###\s*4\.1[^\n]*\n)/, '$1\n' + marker + '\n');
  if (next === src && !parseCoverageMarker(src)) {
    throw new Error('BETA-CHECKLIST.md 里既没有 BRIDGE-COVERAGE 标记、也没有「### 4.1」锚点可插入');
  }
  writeFileSync(checklistPath, next);
  return marker;
}

function formatReport(r) {
  const { judge, sum, stats, gaps } = r;
  const lines = [];
  lines.push('桥覆盖：实现面 ' + stats.bridgeFiles + ' 个桥类 / native 方法 ' + stats.nativeMethods +
    '，调用面 ' + stats.appFiles + ' 个 ts(x)');
  lines.push('白名单 ' + judge.count + ' / budget ' + judge.budget + '；当前缺口 ' + sum.methods +
    ' 个方法（' + sum.sites + ' 个 UI 调用点，其中 ' + sum.riskMethods + ' 个解引用风险）');
  const byNs = new Map();
  for (const g of gaps) byNs.set(g.ns, (byNs.get(g.ns) || 0) + 1);
  lines.push('分命名空间缺口数：' + [...byNs].sort().map(([k, v]) => k + '=' + v).join(' '));
  return lines.join('\n');
}

const argv = process.argv.slice(2);
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const asJson = argv.includes('--json');
  const listAll = argv.includes('--list');
  const doUpdate = argv.includes('--update');
  let r;
  try {
    r = runBridgeCoverageCheck({});
  } catch (e) {
    console.error('[FAIL] 门禁自身执行失败：' + e.message);
    process.exit(2);
  }
  if (doUpdate) {
    const entries = toAllowlistEntries(r.gaps);
    const body = {
      _comment: [
        '桥覆盖白名单：渲染层有调用、壳侧（Index.ets mock / bridge/*.ets）未实现的方法。',
        'makeBridge 的 Proxy 对未实现方法静默 resolve(undefined) → 用户侧症状是「点了没反应」。',
        '规则：修掉一个就删一条（只减不增）；确需扩容用 node scripts/check-bridge-coverage.mjs --update，',
        '这会把 budget 写成当前条目数，git diff 里能看见预算变化，review 时才不会被顺手绕过。',
        '每轮 verify-all 都会校验：新增缺口报红 + 白名单过期报红 + 超预算报红。',
      ],
      budget: entries.length,
      entries,
    };
    writeFileSync(DEFAULT_ALLOWLIST, JSON.stringify(body, null, 2) + '\n');
    console.log('[OK] 已重写白名单：' + entries.length + ' 条 → ' + relative(DEFAULT_REPO_ROOT, DEFAULT_ALLOWLIST));
    const marker = writeCoverageMarker(BETA_CHECKLIST, nsCounts(r.gaps));
    console.log('[OK] 已同步文档标记 → ' + relative(DEFAULT_REPO_ROOT, BETA_CHECKLIST));
    console.log('     ' + marker);
    console.log('     （文案里的分组说明需人工核对：数字变了，「已知限制」的措辞可能也要跟着改）');
    console.log(formatReport(r));
    process.exit(0);
  }
  const docs = runLimitsDocsCheck({ gaps: r.gaps });
  const allErrors = r.errors.concat(docs.errors);
  // R2-5: 契约对账错误也纳入门禁判定（但「提示」级别的不算红）
  const contractFails = (r.contractErrors || []).filter((e) => !e.startsWith('提示:'));
  const allErrorsWithContract = allErrors.concat(contractFails);
  if (asJson) {
    console.log(JSON.stringify({
      stats: r.stats, summary: r.sum, judge: { count: r.judge.count, budget: r.judge.budget, overBudget: r.judge.overBudget },
      counts: docs.counts,
      newGaps: r.judge.newGaps.map((g) => ({ ...g, context: undefined })),
      stale: r.judge.stale,
      gaps: r.gaps.map((g) => ({ ns: g.ns, method: g.method, kind: g.kind, ui: g.ui, risk: g.risk, first: g.sites[0].site })),
      contractErrors: r.contractErrors || [],
      errors: allErrorsWithContract,
    }, null, 2));
    process.exit(allErrorsWithContract.length === 0 ? 0 : 1);
  }
  console.log(formatReport(r));
  if (listAll) {
    for (const g of r.gaps.sort((a, b) => (gapKey(a) < gapKey(b) ? -1 : 1))) {
      console.log('  - ' + gapKey(g) + ' [' + g.kind + '] ×' + g.ui + (g.risk ? ' 风险 ' + g.risk : '') + ' @ ' + g.sites[0].site);
    }
  }
  if (allErrorsWithContract.length === 0) {
    console.log('[OK] 无新增缺口、无白名单过期、预算未超、已知限制文档与实现一致、契约对账通过');
    process.exit(0);
  }
  console.error('[FAIL] ' + allErrorsWithContract.length + ' 项：');
  for (const e of allErrorsWithContract.slice(0, 40)) console.error('  - ' + e);
  if (allErrorsWithContract.length > 40) console.error('  … 其余 ' + (allErrorsWithContract.length - 40) + ' 项见 --json');
  process.exit(1);
}