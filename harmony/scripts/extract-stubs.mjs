#!/usr/bin/env node
/**
 * R5-2: 恒空桩全量提取 → stub-registry.json
 *
 * 从 Index.ets 中提取所有 `function () { return Promise.resolve(null); }` 恒空桩，
 * 自动推断所属命名空间（mock 对象），生成 stub-registry.json 供门禁对账。
 *
 *   node scripts/extract-stubs.mjs          生成/更新 stub-registry.json
 *   node scripts/extract-stubs.mjs --check   只校验，不写盘（verify-all 调用）
 *
 * 分类规则：
 *   - truly-unsupported: 功能本应做事但壳侧无法实现（addElement, openDocxDecrypt 等）
 *   - legitimate-null:   返回 null 是正确语义（consumePendingOpenDocx 无待打开 → null）
 *   - ambient:           高频/自动路径，null 是预期（cloudProjectsSync 等）
 *
 * 分类来源：Index.ets 注释 + UNSUPPORTED_STUBS/ACTIONS/AMBIENT 交叉比对。
 * 新增恒空桩时，脚本会报红提示归类（默认 legitimate-null，需人工确认）。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = resolve(__dirname, '..', 'entry/src/main/ets/pages/Index.ets');
const REGISTRY_PATH = resolve(__dirname, 'stub-registry.json');

// ── 命名空间推断：mock 对象 → window 桥命名空间映射 ──
const MOCK_TO_NS = {
  'mock': 'desktop',       // base mock → desktop（docs/pdf/markdown 共用 base）
  'projectMock': 'projectApi',
  'pdfMock': 'pdfApi',
  'markdownMock': 'markdownApi',
  'slidesMock': 'slidesApi',
  'sheetsMock': 'desktopApi',
  'aiOffice': 'aiOffice',
  'aiOfficeProject': 'aiOfficeProject',
};

// ── 已知分类（人工标注 + slides unsupported-features.ts 交叉比对） ──
// truly-unsupported: 功能缺失，用户可能触发且期望结果
// legitimate-null:   null 是正确语义（无待处理数据、功能不存在但 UI 有 null 分支）
// ambient:           自动/高频路径，null 是预期，提示只会变噪音

const TRULY_UNSUPPORTED = new Set([
  // slides — 元素工厂缺失（UNSUPPORTED_STUBS 已登记）
  'addElement', 'addTable', 'addChart', 'addSmartArt',
  'insertImage', 'insertMedia', 'insertModel3d',
  'duplicateElements', 'pasteElements',
  'batchEditTransform',
  'tableMerge', 'tableStructure',
  'editChart',
  'repasteSlide',
  'replacePictureBytes',
  'addComment', 'deleteComment',
  'setSections', 'addSection', 'renameSection', 'removeSection',
  'removeSectionSlides', 'moveSection',

  // docs — 加密文档
  'openDocxDecrypt',
  // pdf — 合并 PDF
  'saveMergedPdf',
  // docs — 附件
  'addPastedImage', 'readAttachmentImage',
  // 多 Tab
  'openNewTab',
  // pdf — OCR
  'ocrPage',
  // shell — 文件夹管理
  'addFolderRoot',
]);

const AMBIENT = new Set([
  // shell — 云项目（自动同步路径）
  'cloudProjectsCached', 'cloudProjectsSync',
  // shell — GitHub stars（自动拉取）
  'githubStars',
  // shell — 搜索重排（null = 关闭/不可用，UI 已有 null 分支）
  'rerankSearch',
  // shell — 项目创建（null = 创建失败/取消，UI 有 null 分支）
  'createProject',
  // slides — AI 内部调用点（无直接 UI 入口，模型自行按 null 降级）
  'applyTxn', 'applyEditScript', 'aiSnapshotRestore',
  'insertImageUrl', 'replacePictureUrl',
]);

// 其余默认 legitimate-null：
// consumePendingOpenDocx, consumeNewBlankDoc, consumeAiDocContent,
// consumeHeadlessExport, consumePendingOpen, getTransition, endHistoryBatch

// ── 提取逻辑 ──

function extractStubs(indexSrc) {
  const lines = indexSrc.split('\n');
  const stubs = [];

  // 正则匹配恒空桩：`methodName: function (...) { return Promise.resolve(null); }`
  // 支持有参数和无参数两种形式
  const STUB_RE = /(\w+):\s*function\s*\([^)]*\)\s*\{\s*return\s*Promise\.resolve\(null\)\s*;\s*\}/;

  for (let i = 0; i < lines.length; i++) {
    const m = STUB_RE.exec(lines[i]);
    if (!m) continue;

    const method = m[1];
    const lineno = i + 1;

    // 推断命名空间：向前搜索最近的 mock 对象定义
    const ns = inferNamespace(lines, i);

    // 分类
    let category;
    if (TRULY_UNSUPPORTED.has(method)) category = 'truly-unsupported';
    else if (AMBIENT.has(method)) category = 'ambient';
    else category = 'legitimate-null';

    stubs.push({ ns, method, category, line: lineno });
  }

  return stubs;
}

function inferNamespace(lines, stubLineIdx) {
  // 向前搜索最近的 mock 对象定义
  for (let j = stubLineIdx - 1; j >= Math.max(0, stubLineIdx - 1200); j--) {
    const l = lines[j];

    // var xxxMock = Object.assign(...)
    let m = /var\s+(\w+Mock)\s*=\s*Object\.assign/.exec(l);
    if (m) return MOCK_TO_NS[m[1]] || m[1];

    // var xxxMock = {  (直接定义，如 projectMock)
    m = /var\s+(\w+Mock)\s*=\s*\{/.exec(l);
    if (m) return MOCK_TO_NS[m[1]] || m[1];

    // var mock = {
    m = /var\s+(mock)\s*=\s*\{/.exec(l);
    if (m) return MOCK_TO_NS[m[1]] || 'desktop';

    // window.aiOffice = wrapShellBridge('aiOffice', aiOffice);
    m = /window\.(aiOffice\w*)\s*=/.exec(l);
    if (m) return m[1];

    // var aiOffice = {
    m = /var\s+(aiOffice\w*)\s*=\s*\{/.exec(l);
    if (m) return m[1];
  }
  return 'unknown';
}

// ── 与 slides unsupported-features.ts 交叉验证 ──

function crossCheckSlides(stubs) {
  const slidesStubs = stubs.filter(s => s.ns === 'slidesApi');
  const unsupportedPath = resolve(__dirname, '..', '..', 'apps/slides/src/renderer/unsupported-features.ts');
  if (!existsSync(unsupportedPath)) return { errors: [] };

  const src = readFileSync(unsupportedPath, 'utf8');
  const errors = [];

  // 提取 UNSUPPORTED_STUBS 列表（用 = [ 定位，避免 readonly string[] 的方括号干扰）
  const stubsMatch = src.match(/UNSUPPORTED_STUBS[\s\S]*?=\s*\[([\s\S]*?)\]/);
  if (stubsMatch) {
    const declared = [...stubsMatch[1].matchAll(/'(\w+)'/g)].map(m => m[1]);
    const registrySlidesStubs = slidesStubs.filter(s => s.category === 'truly-unsupported').map(s => s.method);

    // 注册表中有但 UNSUPPORTED_STUBS 没登记 → 漏报
    for (const m of registrySlidesStubs) {
      if (!declared.includes(m)) {
        errors.push(`slidesApi.${m} 在 stub-registry 中是 truly-unsupported 但未登记进 UNSUPPORTED_STUBS`);
      }
    }
    // UNSUPPORTED_STUBS 中有但注册表没有 → 过期
    for (const m of declared) {
      if (!slidesStubs.find(s => s.method === m)) {
        errors.push(`UNSUPPORTED_STUBS 登记了 ${m} 但 stub-registry 中不存在（可能已实现或桩已移除）`);
      }
    }
  }

  return { errors };
}

// ── 主流程 ──

function main() {
  const isCheck = process.argv.includes('--check');

  if (!existsSync(INDEX_PATH)) {
    console.error('[FAIL] 未找到 Index.ets：' + INDEX_PATH);
    process.exit(2);
  }

  const indexSrc = readFileSync(INDEX_PATH, 'utf8');
  const stubs = extractStubs(indexSrc);

  // 按命名空间分组统计
  const byNs = {};
  for (const s of stubs) {
    if (!byNs[s.ns]) byNs[s.ns] = [];
    byNs[s.ns].push(s);
  }

  // 交叉验证
  const cross = crossCheckSlides(stubs);

  if (isCheck) {
    // 校验模式：与 stub-registry.json 对账
    if (!existsSync(REGISTRY_PATH)) {
      console.error('[FAIL] 缺 stub-registry.json（运行 node scripts/extract-stubs.mjs 生成）');
      process.exit(1);
    }
    const committed = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
    const committedKey = (s) => `${s.ns}.${s.method}`;
    const freshKeys = new Set(stubs.map(committedKey));
    const committedKeys = new Set(committed.stubs.map(committedKey));

    const newStubs = [...freshKeys].filter(k => !committedKeys.has(k));
    const removedStubs = [...committedKeys].filter(k => !freshKeys.has(k));
    const categoryChanged = committed.stubs.filter(s => {
      const fresh = stubs.find(x => x.ns === s.ns && x.method === s.method);
      return fresh && fresh.category !== s.category;
    });

    const errs = [];
    if (newStubs.length > 0) {
      errs.push('新增恒空桩未登记：' + newStubs.join(', ') + ' → 运行 node scripts/extract-stubs.mjs 更新');
    }
    if (removedStubs.length > 0) {
      errs.push('已消失的恒空桩仍在注册表：' + removedStubs.join(', ') + ' → 运行 node scripts/extract-stubs.mjs 更新');
    }
    if (categoryChanged.length > 0) {
      errs.push('分类变更：' + categoryChanged.map(s => `${s.ns}.${s.method} ${s.category}→${stubs.find(x => x.ns === s.ns && x.method === s.method).category}`).join(', '));
    }
    errs.push(...cross.errors);

    if (errs.length > 0) {
      console.error('[FAIL] ' + errs.join('; '));
      process.exit(1);
    }

    // 统计输出
    const cats = { 'truly-unsupported': 0, 'legitimate-null': 0, 'ambient': 0 };
    for (const s of stubs) cats[s.category]++;
    console.log(`[OK] stub-registry.json 与 Index.ets 一致（${stubs.length} 个恒空桩：${cats['truly-unsupported']} truly-unsupported / ${cats['legitimate-null']} legitimate-null / ${cats['ambient']} ambient）`);
    process.exit(0);
  }

  // 生成模式：写 stub-registry.json
  const cats = { 'truly-unsupported': 0, 'legitimate-null': 0, 'ambient': 0 };
  for (const s of stubs) cats[s.category]++;

  const output = {
    _comment: [
      '恒空桩注册表：Index.ets 中所有 `function () { return Promise.resolve(null); }` 的桩。',
      '分类：truly-unsupported（功能缺失，需 UI guard）/ legitimate-null（null 是正确语义）/ ambient（自动路径，null 预期）。',
      '生成命令：node scripts/extract-stubs.mjs',
      '门禁：verify-all 的 checkStubRegistryFresh 校验此文件与 Index.ets 一致。',
    ],
    generated: new Date().toISOString(),
    total: stubs.length,
    byCategory: cats,
    byNamespace: Object.fromEntries(
      Object.entries(byNs).map(([ns, list]) => [ns, list.length])
    ),
    stubs,
  };

  writeFileSync(REGISTRY_PATH, JSON.stringify(output, null, 2) + '\n');

  // 报告
  console.log(`[OK] 已生成 stub-registry.json：${stubs.length} 个恒空桩`);
  console.log(`     truly-unsupported: ${cats['truly-unsupported']} / legitimate-null: ${cats['legitimate-null']} / ambient: ${cats['ambient']}`);
  for (const [ns, list] of Object.entries(byNs)) {
    console.log(`     ${ns}: ${list.length} 个`);
  }
  if (cross.errors.length > 0) {
    console.warn('[WARN] 交叉验证发现 ' + cross.errors.length + ' 个问题：');
    for (const e of cross.errors) console.warn('  - ' + e);
  }
}

main();