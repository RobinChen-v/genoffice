// strip-brand.mjs — 构建时品牌中性化：对 dist 产物做 Genspark → AI 替换
//
// 设计原则（R4）：
//   1. 源码保持上游原样（消除 sync 冲突面）
//   2. 构建产物（dist JS）中 Genspark 品牌值由本脚本统一替换
//   3. 替换规则是确定性的文本映射（不是正则猜测）
//   4. --check 模式验证 dist 产物已无残留 Genspark 品牌值
//
// 用法：
//   node scripts/strip-brand.mjs <web-root>        → 执行替换
//   node scripts/strip-brand.mjs <web-root> --check → 只验证不替换
//
// <web-root> 是 rawfile/web/ 目录（含各 app 的 dist 产物）

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── 品牌替换规则 ───
// 每条规则是 [搜索字符串, 替换字符串] 的精确映射
// 顺序敏感：长字符串先替换（避免短字符串吃掉长字符串的子串）
const BRAND_RULES = [
  // ── 精确长字符串优先（避免短规则吃掉长规则的子串） ──
  // 英文：登录/状态/积分文案
  ['"Sign in to Genspark"', '"Configure AI"'],
  ["'Sign in to Genspark'", '"Configure AI"'],
  ['"Not signed in (AI features require a Genspark account)"', '"Not configured (AI features need your own API key)"'],
  ["'Not signed in (AI features require a Genspark account)'", '"Not configured (AI features need your own API key)"'],
  ['"Your Genspark credits have run out. Visit genspark.ai/pricing to top up, then try again"',
   '"Your AI provider rejected the request (quota or key problem) - check the vendor console, then try again"'],
  ["'Your Genspark credits have run out. Visit genspark.ai/pricing to top up, then try again'",
   "'Your AI provider rejected the request (quota or key problem) - check the vendor console, then try again'"],
  // 中文
  ['"登录 Genspark"', '"配置 AI"'],
  ["'登录 Genspark'", "'配置 AI'"],
  ['"未登录（AI 功能需要登录 Genspark 账号）"', '"未配置（AI 功能需要填写你自己的 API Key）"'],
  ["'未登录（AI 功能需要登录 Genspark 账号）'", "'未配置（AI 功能需要填写你自己的 API Key）'"],
  ['"Genspark 积分已用完，请前往 genspark.ai/pricing 充值后重试"',
   '"你所选的 AI 服务商拒绝了本次请求（额度或 Key 问题），请到服务商控制台确认后再试"'],
  ["'Genspark 积分已用完，请前往 genspark.ai/pricing 充值后重试'",
   "'你所选的 AI 服务商拒绝了本次请求（额度或 Key 问题），请到服务商控制台确认后再试'"],
  // 账号/服务商
  ['"Genspark account"', '"AI provider"'],
  ["'Genspark account'", "'AI provider'"],
  ['"Genspark Account"', '"AI Account"'],
  ["'Genspark Account'", "'AI Account'"],
  ['"Genspark 账号"', '"AI 服务商"'],
  ["'Genspark 账号'", "'AI 服务商'"],
  // 云项目
  ['"Genspark Projects"', '"AI Projects"'],
  ["'Genspark Projects'", "'AI Projects'"],
  // ── genspark.ai 链接（在 Genspark 兜底之前替换） ──
  ['genspark.ai/pricing', 'your AI provider console'],
  ['genspark.ai', 'ai-provider.example.com'],
  // ── 裸品牌值（面板标题、Ribbon 分组名） ──
  ['"Genspark"', '"AI"'],
  ["'Genspark'", "'AI'"],
  // ── "Genspark AI" → "AI Assistant" ──
  ['"Genspark AI"', '"AI Assistant"'],
  ["'Genspark AI'", "'AI Assistant'"],
  ['Genspark AI', 'AI Assistant'],
  // ── 兜底：任何剩余的 Genspark 标识 → AI ──
  ['Genspark', 'AI'],
];

// ─── 递归扫描目录中的 JS/CSS 文件 ───
function walkDir(dir, files = []) {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(fullPath, files);
    } else {
      const ext = extname(entry.name);
      // .html 必须扫：内联模式（shell/docs/markdown 等）的 JS 被内联进 index.html，
      // 只扫 .js 会漏掉内联产物（slides 功能区 "Genspark AI" 漏到真机就是这个问题）。
      if (ext === '.js' || ext === '.css' || ext === '.mjs' || ext === '.html') {
        files.push(fullPath);
      }
    }
  }
  return files;
}

// ─── 对单个文件执行品牌替换 ───
function stripFile(filePath, checkOnly = false) {
  const src = readFileSync(filePath, 'utf8');
  let result = src;
  let replacements = 0;

  for (const [search, replace] of BRAND_RULES) {
    // 跳过注释中的 Genspark 引用（如版权声明、许可链接）
    // 但 JS bundle 中注释已被 minifier 删除，所以这里不需要特殊处理
    const count = result.split(search).length - 1;
    if (count > 0) {
      result = result.split(search).join(replace);
      replacements += count;
    }
  }

  if (replacements > 0 && !checkOnly) {
    writeFileSync(filePath, result, 'utf8');
  }

  // --check 检测**原始内容**（src）而非替换后（result）：兜底规则 ['Genspark','AI'] 会替换
  // 一切，模拟替换后永远无残留 → --check 永远通过，检测不出「忘了跑 strip」。
  // 用 src 才能发现「产物里还有未 strip 的 Genspark」（真机 "Genspark AI" 漏出就是这个坑）。
  return { file: filePath, replacements, hasResidual: checkOnly ? countResidual(src) : 0 };
}

// ─── 检查残留 Genspark 品牌值 ───
function countResidual(src) {
  // 检查是否还有 Genspark 品牌残留（排除许可链接等合法引用）
  const lines = src.split('\n');
  let residual = 0;
  for (const line of lines) {
    if (line.includes('Genspark') && !line.includes('genspark-ai/genoffice')) {
      residual++;
    }
  }
  return residual;
}

// ─── 主入口 ───
function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('用法: node strip-brand.mjs <web-root> [--check]');
    process.exit(1);
  }
  const webRoot = resolve(args[0]);
  const checkOnly = args.includes('--check');

  if (!existsSync(webRoot)) {
    console.error('Web root 不存在: ' + webRoot);
    process.exit(1);
  }

  const files = walkDir(webRoot);
  console.log(`扫描 ${files.length} 个 JS/CSS 文件`);

  let totalReplacements = 0;
  let totalResidual = 0;
  const residualFiles = [];

  for (const file of files) {
    const { replacements, hasResidual } = stripFile(file, checkOnly);
    totalReplacements += replacements;
    if (hasResidual > 0) {
      totalResidual += hasResidual;
      residualFiles.push({ file, count: hasResidual });
    }
  }

  if (checkOnly) {
    if (totalResidual > 0) {
      console.error(`✗ 发现 ${totalResidual} 处 Genspark 品牌残留：`);
      for (const { file, count } of residualFiles.slice(0, 10)) {
        console.error(`  ${file}: ${count} 处`);
      }
      process.exit(1);
    }
    console.log('✓ 无 Genspark 品牌残留');
  } else {
    console.log(`✓ 替换 ${totalReplacements} 处品牌值`);
  }
}

main();