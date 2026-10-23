#!/usr/bin/env node
// 桥覆盖门禁（批次 B）的负向自检：用**合成源码**构造正反例，断言门禁「该红的必红、该绿的必绿」。
//
// 为什么必须自检：本门禁判定依赖三类正则/区间（mock 标记区间、native case/方法名、调用点正则），
// 任何一处写错都不会崩，而是**静默变绿** —— 比如把 apps 扫描路径写错、把 native 别名逻辑删掉，
// verify-all 依旧全绿，而「点了没反应」的缺口就再也拦不住。故逐点破坏后断言必红。
//   node scripts/self-test-bridge-coverage.mjs
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import {
  parseMockKeys, parseNativeMethods, extractWindowCalls, computeGaps,
  judgeAllowlist, summarize, RISK_RE, RISK_WINDOW, MOCK_MARKERS,
  nsCounts, formatCoverageMarker, parseCoverageMarker, judgeLimitsDocs, NS_DOC_GROUP,
} from './lib/bridge-coverage.mjs';
import { collectGaps, runBridgeCoverageCheck, runLimitsDocsCheck, DEFAULT_ALLOWLIST } from './check-bridge-coverage.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HARMONY = resolve(HERE, '..');
const ROOT = resolve(HARMONY, '..');

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (extra ? '  → ' + String(extra).split('\n')[0].slice(0, 200) : ''));
  if (!ok) failures++;
};

// ---- 合成源码：9 个 mock 标记齐备（缺一个必须抛错，见用例 11）+ 行首 `; 结束标记 ----
function fakeIndex({ mock = ['getLanguage'], pdfMock = ['readFile'], extra = '' } = {}) {
  const block = (keys) => keys.map((k) => '    ' + k + ': function () { return 1; },').join('\n');
  return [
    "const INJECT = `",
    '  var mock = {',
    block(mock),
    '  }',
    '  var projectMock = {',
    block(['resolveChat']),
    '  }',
    '  var pdfMock = Object.assign({}, mock, {',
    block(pdfMock),
    '  });',
    '  var markdownMock = Object.assign({}, mock, {',
    block(['readImage']),
    '  });',
    '  var slidesMock = Object.assign({}, mock, {',
    block(['insertImage']),
    '  });',
    '  var sheetsMock = Object.assign({}, mock, {',
    block(['exportPdf']),
    '  });',
    '  var aiOffice = {',
    block(['listTabs']),
    '  }',
    '  window.aiOfficeProject = {',
    block(['resolveChat']),
    '  }',
    '  window.aiOfficeTabs = {',
    block(['list']),
    '  }',
    extra,
    '`;',
  ].join('\n');
}

const fakeApp = (lines, path = 'apps/docs/src/renderer/App.tsx') => [{ path, text: lines.join('\n') }];
const analyze = ({ indexSrc, bridgeTexts = [], appFiles }) => {
  const gaps = computeGaps({
    mockKeys: parseMockKeys(indexSrc),
    native: parseNativeMethods(bridgeTexts),
    calls: extractWindowCalls(appFiles),
  });
  return gaps;
};

const idxOk = fakeIndex();

// 1) 对照：真实仓库 + 真实白名单必须零报错（否则门禁误报，会逼人去改白名单）
try {
  const r = runBridgeCoverageCheck({ repoRoot: ROOT, allowlistPath: DEFAULT_ALLOWLIST });
  check('对照：真实仓库 + 真实白名单通过', r.errors.length === 0, r.errors.join(' | '));
  // 下限只防「白名单塌成空表」，**不是**冻结数量：修好缺口会让它变小（批次 E 把 113 修到 83）。
  // 原来写的是 > 100，于是「真的把缺口修掉了」反而被自测判成失败 —— 惩罚改进的门禁必须改。
  check('对照：缺口数 == 白名单条目数（baseline 未腐化）', r.judge.count === r.gaps.length && r.gaps.length > 20,
    'gaps=' + r.gaps.length + ' allow=' + r.judge.count);
} catch (e) {
  check('对照：真实仓库 + 真实白名单通过', false, e.message);
}

// 2) 渲染层调了、壳侧没实现、白名单也没有 → 必须报「新增缺口」
{
  const gaps = analyze({ indexSrc: idxOk, appFiles: fakeApp(['window.desktop.brandNewThing();']) });
  check('新增缺口可被捕获', gaps.length === 1 && gaps[0].method === 'brandNewThing', JSON.stringify(gaps.map((g) => g.method)));
  const j = judgeAllowlist(gaps, { budget: 0, entries: [] });
  check('新增缺口在空白名单下判红', j.newGaps.length === 1 && j.stale.length === 0);
}

// 3) 同一缺口进了白名单 → 必须放行（否则门禁无法用于「已知缺口」基线）
{
  const gaps = analyze({ indexSrc: idxOk, appFiles: fakeApp(['window.desktop.brandNewThing();']) });
  const j = judgeAllowlist(gaps, { budget: 1, entries: [{ ns: 'desktop', method: 'brandNewThing' }] });
  check('白名单命中放行', j.newGaps.length === 0 && j.stale.length === 0 && !j.overBudget, JSON.stringify(j));
}

// 4) 壳侧 mock 里补上实现 → 白名单条目必须判「过期」（只减不增的核心约束）
{
  const gaps = analyze({ indexSrc: fakeIndex({ mock: ['brandNewThing'] }), appFiles: fakeApp(['window.desktop.brandNewThing();']) });
  const j = judgeAllowlist(gaps, { budget: 1, entries: [{ ns: 'desktop', method: 'brandNewThing' }] });
  check('实现面补上后白名单过期可被捕获', gaps.length === 0 && j.stale.length === 1, JSON.stringify({ gaps: gaps.length, stale: j.stale }));
}

// 5) 调用点消失（渲染层不再调用）→ 白名单条目同样必须判过期
{
  const gaps = analyze({ indexSrc: idxOk, appFiles: fakeApp(['// 这行不再调用桥']) });
  const j = judgeAllowlist(gaps, { budget: 1, entries: [{ ns: 'desktop', method: 'brandNewThing' }] });
  check('调用点消失后白名单过期可被捕获:', j.stale.length === 1 && gaps.length === 0);
}

// 6) native 桥类 case 分支被识别（壳侧走 ArkTS 而非 mock 的通道）
{
  const gaps = analyze({
    indexSrc: idxOk,
    bridgeTexts: ["export class DesktopBridge {\n  bridgeCall(m: string) {\n    switch (m) {\n      case 'nativeThing':\n        return 1;\n    }\n  }\n}"],
    appFiles: fakeApp(['window.desktop.nativeThing();']),
  });
  check('native case 分支被识别为实现', gaps.length === 0, JSON.stringify(gaps.map((g) => g.method)));
}

// 7) native 侧 …Json 别名通道（历史 42 处中文全角/别名差异都靠它）
{
  const gaps = analyze({
    indexSrc: idxOk,
    bridgeTexts: ["      case 'thingJson':\n", '  thing(a: string) {}\n'],
    appFiles: fakeApp(['window.desktop.thing();']),
  });
  check('native …Json 别名被识别为实现', gaps.length === 0, JSON.stringify(gaps.map((g) => g.method)));
}

// 8) on* 订阅未实现必须计入（Proxy 返回 NOOP → 事件永不触发，是「数据不刷新」类 bug 的根因）
{
  const gaps = analyze({ indexSrc: idxOk, appFiles: fakeApp(['window.desktop.onSomethingChanged(function () {});']) });
  check('on* 订阅缺口被捕获且归类为 subscribe', gaps.length === 1 && gaps[0].kind === 'subscribe', JSON.stringify(gaps));
}

// 9) Electron-only（src/main）调用点不计入 UI 缺口
{
  const gaps = analyze({ indexSrc: idxOk, appFiles: fakeApp(['window.desktop.mainOnlyThing();'], 'apps/docs/src/main/main.ts') });
  check('src/main 调用点不计入 UI 缺口', gaps.length === 0, JSON.stringify(gaps.map((g) => g.sites)));
}

// 10) 白名单条目数超 budget → 报红（防「顺手加一条绕过门禁」）
{
  const j = judgeAllowlist([], { budget: 1, entries: [{ ns: 'a', method: 'b' }, { ns: 'a', method: 'c' }] });
  check('超预算可被捕获', j.overBudget === true && j.stale.length === 2);
}

// 11) mock 标记缺失必须抛错（少了 slidesMock 就会把 97 个缺口算成「已实现」）
{
  const broken = fakeIndex().replace('  var slidesMock = Object.assign({}, mock, {', '  var slidesMocks = Object.assign({}, mock, {');
  let msg = '';
  try { parseMockKeys(broken) } catch (e) { msg = e.message }
  check('mock 标记缺失时抛错（不静默漏命名空间）', /未找到 mock 标记/.test(msg), msg);
}

// 12) 注入模板串结束标记缺失必须抛错
{
  const broken = fakeIndex().replace('\n`;', '\n;');
  let msg = '';
  try { parseMockKeys(broken) } catch (e) { msg = e.message }
  check('模板串结束标记缺失时抛错', /结束标记/.test(msg), msg);
}

// 13) 调用行解引用风险启发式（.map( / .length / !r. 命中；纯调用不命中）
{
  const risky = analyze({ indexSrc: idxOk, appFiles: fakeApp(['  var list = window.desktop.getRows();', '  list.map(function (r) { return r; });']) });
  const safe = analyze({ indexSrc: idxOk, appFiles: fakeApp(['  window.desktop.doThing();']) });
  check('解引用风险可被识别', risky.length === 1 && risky[0].risk === '.map(', JSON.stringify(risky.map((g) => g.risk)));
  check('纯调用不计入风险', safe.length === 1 && safe[0].risk === '', JSON.stringify(safe.map((g) => g.risk)));
  check('RISK_RE 不误伤普通调用行', !RISK_RE.test('  window.desktop.doThing();'));
}

// 14) 读盘守卫：目录布局不对时必须抛错，不得「扫到 0 个文件 → 0 缺口 → 假绿」
{
  const tmp = join(HARMONY, '.tmp-selftest-bridge-coverage');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(join(tmp, 'harmony/entry/src/main/ets/bridge'), { recursive: true });
  mkdirSync(join(tmp, 'apps/docs/src'), { recursive: true });
  let msg = '';
  try { collectGaps({ repoRoot: tmp }) } catch (e) { msg = e.message }
  check('无 Index.ets 时抛错', /未找到 Index\.ets/.test(msg), msg);

  mkdirSync(join(tmp, 'harmony/entry/src/main/ets/pages'), { recursive: true });
  writeFileSync(join(tmp, 'harmony/entry/src/main/ets/pages/Index.ets'), fakeIndex({ mock: ['a'] }));
  writeFileSync(join(tmp, 'harmony/entry/src/main/ets/bridge/B.ets'), 'export class B {}\n');
  msg = '';
  try { collectGaps({ repoRoot: tmp }) } catch (e) { msg = e.message }
  check('Index.ets 过短时抛错（构建产物被裁剪/路径写错）', /过短/.test(msg), msg);

  writeFileSync(join(tmp, 'harmony/entry/src/main/ets/pages/Index.ets'), fakeIndex({ mock: ['a'], extra: '  // ' + 'x'.repeat(100001) }));
  msg = '';
  try { collectGaps({ repoRoot: tmp }) } catch (e) { msg = e.message }
  check('apps 下扫到文件过少时抛错', /只扫到/.test(msg), msg);

  rmSync(tmp, { recursive: true, force: true });
}

// 15) 摘要口径：方法数 / UI 调用点 / 风险数三者独立统计
//（风险判定的上下文窗口是「调用行 + 后 RISK_WINDOW-1 行」，所以两个方法的调用行要隔开，否则会互相污染）
{
  const gaps = analyze({
    indexSrc: idxOk,
    appFiles: fakeApp([
      '  var r = window.desktop.b();',
      '  r.map(function (x) { return x; });',
      '  window.desktop.a();',
      '  window.desktop.a();',
    ]),
  });
  const s = summarize(gaps);
  check('摘要口径正确', s.methods === 2 && s.sites === 3 && s.riskMethods === 1, JSON.stringify(s));
}

// 16) 风险窗口必须能抓到「await 结果隔几行才解引用」的真崩溃，且边界准确
//（批次 C 实测：+4 行漏判 markdownApi.exportDocx —— if (!result.ok) 在第 6 行）
{
  const at = (offset) => analyze({
    indexSrc: idxOk,
    appFiles: fakeApp([
      '  const result = await window.markdownApi.exportDocx({',
      ...Array.from({ length: offset - 1 }, () => '    filler: 1,'),
      '  if (!result.ok) console.error(result.error)',
    ], 'apps/markdown/src/renderer/App.tsx'),
  });
  const inside = at(RISK_WINDOW - 1); // 解引用落在窗口最后一行
  const outside = at(RISK_WINDOW); // 再往后一行就出窗
  check('跨行解引用能被风险窗口抓到', inside.length === 1 && inside[0].risk !== '', JSON.stringify(inside.map((g) => g.risk)));
  check('窗口边界准确（出窗即不计风险）', outside.length === 1 && outside[0].risk === '', JSON.stringify(outside.map((g) => g.risk)));
  check('RISK_WINDOW 为 9 行（窗口口径写进文档，改动必须自测同步）', RISK_WINDOW === 9, String(RISK_WINDOW));
}

// ── 文档-实现一致性门禁（批次 C）──
const fakeCounts = { total: 3, byNs: { slidesApi: 1, desktop: 1, markdownApi: 1, pdfApi: 0, desktopApi: 0, aiOffice: 0, aiOfficeTabs: 0 } };
const fakeChecklist = ('# CHECKLIST\n\n### 4.1 桥缺口基线\n\n' + formatCoverageMarker(fakeCounts) + '\n\n' + 'x'.repeat(260));
const fakeNotes = '# NOTES\n\n' + 'y'.repeat(200) + '\n\n## 5. 已知限制（给测试者的精简版）\n\n' +
  '- **PPT（演示）**：插入图片不可用\n- **Word（文档）**：导出 PDF 降级\n- **Markdown**：导出 DOCX 静默失败\n' +
  '\n## 6. 反馈与日志\n';

// 17) 对照：合成文档与缺口数一致 → 通过
check('文档一致性对照通过', judgeLimitsDocs({ checklist: fakeChecklist, notes: fakeNotes, counts: fakeCounts }).length === 0,
  judgeLimitsDocs({ checklist: fakeChecklist, notes: fakeNotes, counts: fakeCounts }).join(' | '));

// 18) 标记数字过期（total 或某个 ns 对不上）→ 必红
{
  const bad = fakeChecklist.replace('total=3', 'total=9');
  const errs = judgeLimitsDocs({ checklist: bad, notes: fakeNotes, counts: fakeCounts });
  check('标记 total 过期可被捕获', errs.some((e) => /total=9/.test(e)), errs.join(' | '));
  const bad2 = fakeChecklist.replace('slidesApi=1', 'slidesApi=5');
  check('标记单项 ns 过期可被捕获', judgeLimitsDocs({ checklist: bad2, notes: fakeNotes, counts: fakeCounts })
    .some((e) => /slidesApi=5/.test(e)));
}

// 19) 标记整行被删 → 必红（否则门禁静默失效）
check('标记缺失可被捕获', judgeLimitsDocs({ checklist: fakeChecklist.replace(/<!--[^>]*-->/, ''), notes: fakeNotes, counts: fakeCounts })
  .some((e) => /缺 BRIDGE-COVERAGE 标记/.test(e)));

// 20) 「已知限制」小节漏点名某个有缺口的 app → 必红
{
  const errs = judgeLimitsDocs({ checklist: fakeChecklist, notes: fakeNotes.replace('**PPT（演示）**', '**演示文稿**'), counts: fakeCounts });
  check('限制小节漏 PPT 分组可被捕获', errs.some((e) => /缺 PPT 分组/.test(e)), errs.join(' | '));
  check('限制小节整段被删可被捕获', judgeLimitsDocs({ checklist: fakeChecklist, notes: fakeNotes.replace(/##\s*5\.\s*已知限制[\s\S]*?(?=\n##\s)/, ''), counts: fakeCounts })
    .some((e) => /缺「## 5\. 已知限制」小节/.test(e)));
}

// 21) 文档读空 → 必红（守卫：路径写错不能变成「没有缺口需要说明」）
{
  const errs = judgeLimitsDocs({ checklist: '', notes: fakeNotes, counts: fakeCounts });
  check('CHECKLIST 读空可被捕获', errs.some((e) => /读空或过短/.test(e)), errs.join(' | '));
  check('RELEASE-NOTES 读空可被捕获', judgeLimitsDocs({ checklist: fakeChecklist, notes: '', counts: fakeCounts })
    .some((e) => /RELEASE-NOTES.*读空或过短/.test(e)));
}

// 22) 标记往返 + 零缺口命名空间也要出现在标记里（「已清零」必须可见，不能悄悄消失）
{
  const rt = parseCoverageMarker(formatCoverageMarker(fakeCounts));
  check('标记往返一致', rt.total === 3 && rt.byNs.slidesApi === 1 && rt.byNs.desktopApi === 0, JSON.stringify(rt));
  check('nsCounts 覆盖全部命名空间（含 0）', Object.keys(nsCounts([]).byNs).length === Object.keys(NS_DOC_GROUP).length,
    JSON.stringify(nsCounts([])));
}

// 23) 对照：真实两份 BETA 文档 + 实时缺口 → 0 错误
{
  const d = runLimitsDocsCheck({});
  check('对照：真实 BETA 文档与实现一致', d.errors.length === 0, d.errors.join(' | '));
}

check('MOCK_MARKERS 覆盖 10 个 mock 对象（含 __goBoot deck 引导层）', MOCK_MARKERS.length === 10, String(MOCK_MARKERS.length));

console.log(failures === 0 ? '\nBRIDGE COVERAGE GATE SELF-TEST: ALL PASS' : '\nBRIDGE COVERAGE GATE SELF-TEST: ' + failures + ' FAIL');
process.exit(failures === 0 ? 0 : 1);