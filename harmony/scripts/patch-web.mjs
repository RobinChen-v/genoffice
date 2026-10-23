// patch-web.mjs — 构建时 ArkWeb 特定补丁：对 dist 产物追加鸿蒙特有 CSS/JS
//
// 设计原则（R4）：
//   1. 源码保持上游原样（消除 sync 冲突面）
//   2. ArkWeb 特定补丁由本脚本在构建时对 dist 产物追加
//   3. 补丁内容是确定性的文本追加/替换（不是正则猜测）
//   4. --check 模式验证 dist 产物已包含 ArkWeb 补丁
//
// 用法：
//   node scripts/patch-web.mjs <web-root>        → 执行补丁
//   node scripts/patch-web.mjs <web-root> --check → 只验证不补丁
//
// <web-root> 是 rawfile/web/ 目录（含各 app 的 dist 产物）

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── ArkWeb 补丁内容 ───

// PDF 空态卡片样式（鸿蒙特有 UI：Home 磁贴点击后 PDF tab 无文件时的空态）
const PDF_EMPTY_CSS = `
/* ================= empty tab: no file queued (Harmony tab-host launches without a path) ================= */
.pdf-empty{flex:1;display:flex;align-items:center;justify-content:center;background:var(--bg-app,#f6f7f9);padding:24px}
.pdf-empty-card{display:flex;flex-direction:column;align-items:center;gap:20px;max-width:360px;padding:36px 28px;background:var(--bg-elev,#ffffff);border:1px solid var(--border,#e3e6eb);border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.04);text-align:center}
.pdf-empty-title{font-size:15px;color:var(--text-dim,#5f6368);line-height:1.4}
.pdf-empty-actions{display:flex;flex-direction:column;gap:10px;width:100%}
.pdf-empty-btn{appearance:none;border:1px solid var(--border,#d0d4da);background:var(--bg-elev,#ffffff);color:var(--text,#202124);font:14px/1.2 system-ui,-apple-system,sans-serif;padding:10px 16px;border-radius:8px;cursor:pointer;transition:background 120ms,border-color 120ms}
.pdf-empty-btn:hover{background:var(--hover,#eef1f5);border-color:var(--border-strong,#b8bdc6)}
.pdf-empty-btn:active{background:var(--active,#e3e6eb)}
`;

// @media print 隐藏 tab bar（ArkWeb W3C print 会渲染整个 shell 文档）
const TABBAR_PRINT_CSS = `
@media print{.tab-bar{display:none!important}}
`;

// ─── 补丁标记（用于 --check 检测是否已应用） ───
const PATCH_MARKERS = {
  pdfEmpty: '/*patch:pdf-empty*/',
  tabbarPrint: '/*patch:tabbar-print*/',
};

// ─── 递归扫描目录中的 CSS 文件 ───
function walkCssFiles(dir, files = []) {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkCssFiles(fullPath, files);
    } else if (extname(entry.name) === '.css') {
      files.push(fullPath);
    }
  }
  return files;
}

// ─── 对 CSS 文件应用补丁 ───
function patchCssFile(filePath, checkOnly = false) {
  const src = readFileSync(filePath, 'utf8');
  let result = src;
  let applied = [];

  // PDF 空态卡片样式：追加到 pdf app 的 CSS 中
  if (filePath.includes(join('pdf', 'assets')) || filePath.includes(join('pdf', ''))) {
    if (!src.includes(PATCH_MARKERS.pdfEmpty)) {
      if (!checkOnly) {
        result += `\n${PATCH_MARKERS.pdfEmpty}\n${PDF_EMPTY_CSS}`;
      }
      applied.push('pdf-empty');
    }
  }

  // tabbar print 隐藏：追加到 shell app 的 CSS 中
  if (filePath.includes(join('shell', 'assets')) || filePath.includes(join('shell', ''))) {
    if (!src.includes(PATCH_MARKERS.tabbarPrint)) {
      if (!checkOnly) {
        result += `\n${PATCH_MARKERS.tabbarPrint}\n${TABBAR_PRINT_CSS}`;
      }
      applied.push('tabbar-print');
    }
  }

  if (applied.length > 0 && !checkOnly) {
    writeFileSync(filePath, result, 'utf8');
  }

  return { file: filePath, applied };
}

// ─── 主入口 ───
function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('用法: node patch-web.mjs <web-root> [--check]');
    process.exit(1);
  }
  const webRoot = resolve(args[0]);
  const checkOnly = args.includes('--check');

  if (!existsSync(webRoot)) {
    console.error('Web root 不存在: ' + webRoot);
    process.exit(1);
  }

  // 扫描所有 CSS 文件
  const cssFiles = walkCssFiles(webRoot);
  console.log(`扫描 ${cssFiles.length} 个 CSS 文件`);

  let totalApplied = 0;
  const allApplied = [];

  for (const file of cssFiles) {
    const { applied } = patchCssFile(file, checkOnly);
    if (applied.length > 0) {
      totalApplied += applied.length;
      allApplied.push({ file, patches: applied });
    }
  }

  if (checkOnly) {
    // 检查所有需要的补丁是否已应用
    const missing = [];
    const pdfCssFiles = cssFiles.filter(f => f.includes(join('pdf', '')));
    const shellCssFiles = cssFiles.filter(f => f.includes(join('shell', '')));

    // 检查 pdf-empty 补丁
    const hasPdfEmpty = pdfCssFiles.some(f => readFileSync(f, 'utf8').includes(PATCH_MARKERS.pdfEmpty));
    if (!hasPdfEmpty && pdfCssFiles.length > 0) {
      missing.push('pdf-empty');
    }

    // 检查 tabbar-print 补丁
    const hasTabbarPrint = shellCssFiles.some(f => readFileSync(f, 'utf8').includes(PATCH_MARKERS.tabbarPrint));
    if (!hasTabbarPrint && shellCssFiles.length > 0) {
      missing.push('tabbar-print');
    }

    if (missing.length > 0) {
      console.error(`✗ 缺少 ArkWeb 补丁: ${missing.join(', ')}`);
      process.exit(1);
    }
    console.log('✓ 所有 ArkWeb 补丁已应用');
  } else {
    console.log(`✓ 应用 ${totalApplied} 个 ArkWeb 补丁`);
    for (const { file, patches } of allApplied) {
      console.log(`  ${file}: ${patches.join(', ')}`);
    }
  }
}

main();