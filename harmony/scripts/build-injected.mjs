#!/usr/bin/env node
/**
 * R1 注入 JS 外置化构建脚本：injected/*.ts → esbuild 语法校验 → 转义回填 Index.ets
 * + 产出 rawfile/injected/*.js（门禁校验对象与未来运行时加载路径的产物）。
 *
 * 背景（HARMONYOS-REBUILD-PLAN.md §批次 R1）：
 *   Index.ets 的 PROMISE_SHIM / SHELL_BRIDGE / ERR_COLLECTOR 曾是 6,400 行人肉维护的
 *   模板字面量——反引号截断事故两次、转义错误直接导致真机白屏（extract-bridge 头注释）。
 *   外置后：唯一维护处是 harmony/injected/*.ts（真实 JS），本脚本负责「转义回填」，
 *   Index.ets 里的常量降级为构建产物。
 *
 * 转义往返契约（与 scripts/lib/injected-extract.mjs 的 unescapeTemplate 精确互逆）：
 *   回填：\  → \\    `  → \`    ${ → \${
 *   提取：\\ → \    \` → `    \$ → $（其余按 TS 模板字面量转义表）
 *   验证：回填后再提取，必须与源文件逐字节一致（本脚本自检 + verify-all 新鲜度门禁）。
 *
 * 用法：node scripts/build-injected.mjs [--check]
 *   --check  只校验（esbuild 语法 + Index.ets 与源文件一致性），不改写 Index.ets
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARMONY = resolve(__dirname, '..');
const INJECTED = resolve(HARMONY, 'injected');
const INDEX_ETS = resolve(HARMONY, 'entry', 'src', 'main', 'ets', 'pages', 'Index.ets');
const RAWFILE_OUT = resolve(HARMONY, 'entry', 'src', 'main', 'resources', 'rawfile', 'injected');
const CHECK_ONLY = process.argv.includes('--check');

/** 注入块：Index.ets 常量名 ↔ injected/ 源文件 ↔ rawfile 产物名 */
const BLOCKS = [
  { name: 'ERR_COLLECTOR', src: 'err.ts', out: 'err.js', first: true },
  { name: 'PROMISE_SHIM', src: 'shim.ts', out: 'shim.js' },
  { name: 'SHELL_BRIDGE', src: 'shell.ts', out: 'shell.js' },
];

/** 与 unescapeTemplate 精确互逆的转义。顺序关键：先 \ 再 ` 再 ${。 */
function escapeTemplate(js) {
  return js
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
}

/** 剥离源文件顶部的头注释（连续 // 行 + 空行），到第一个代码行止。
 *  只处理文件开头——IIFE 内部注释在首行代码之后，不受影响。
 *  末尾换行保留（回填→提取往返一致：Index.ets 模板字面量含结尾 \n）。 */
function stripHeaderComment(js) {
  const lines = js.split('\n');
  let i = 0;
  while (i < lines.length && (lines[i].startsWith('//') || lines[i].trim() === '')) i++;
  return lines.slice(i).join('\n');
}

/** 在 Index.ets 源码中定位 `const NAME = \`...\`` 块，返回 [start, end]（含开闭反引号）。 */
function locateBlock(src, name) {
  const re = new RegExp('(?:const|let|var)\\s+' + name + '\\s*(:\\s*string)?\\s*=\\s*`');
  const m = re.exec(src);
  if (!m) throw new Error('Index.ets 中未找到 ' + name + ' 模板字面量');
  const start = m.index;
  let i = m.index + m[0].length;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') { return [start, i]; }
    i++;
  }
  throw new Error('模板字面量 ' + name + ' 未闭合');
}

/** 核心校验/回填（供 check-injected-js.mjs 复用）：
 *  返回 errors 数组（空 = 全部通过）。writeBack=false 时只校验不改写。 */
export async function checkInjectedFreshness(writeBack = false) {
  const errors = [];
  const indexSrc = readFileSync(INDEX_ETS, 'utf8');
  let outSrc = indexSrc;
  let wrote = false;

  for (const b of BLOCKS) {
    const srcPath = resolve(INJECTED, b.src);
    let js;
    try {
      js = readFileSync(srcPath, 'utf8');
    } catch (e) {
      errors.push(b.name + ': 源文件缺失 ' + b.src + '（' + e.message + '）');
      continue;
    }
    js = stripHeaderComment(js);

    try {
      await esbuild.transform(js, { loader: 'ts', format: 'iife' });
    } catch (e) {
      errors.push(b.name + ': esbuild 语法错误（' + (e.errors ? e.errors.map(x => x.text).join('; ') : e.message) + '）');
      continue;
    }

    try {
      mkdirSync(RAWFILE_OUT, { recursive: true });
      writeFileSync(resolve(RAWFILE_OUT, b.out), js, 'utf8');
    } catch (e) {
      errors.push(b.name + ': rawfile 产物写入失败（' + e.message + '）');
    }

    const want = escapeTemplate(js);
    const [start, end] = locateBlock(outSrc, b.name);
    const openTick = outSrc.indexOf('`', start);
    const current = outSrc.slice(openTick + 1, end);
    if (current !== want) {
      if (!writeBack) {
        errors.push(b.name + ': Index.ets 回填内容与 injected/' + b.src + ' 不一致（构建过期，跑 node scripts/build-injected.mjs）');
        continue;
      }
      outSrc = outSrc.slice(0, openTick + 1) + want + outSrc.slice(end);
      wrote = true;
      console.log('[backfill] ' + b.name + ' ← injected/' + b.src + ' (' + js.length + ' chars)');
    } else {
      console.log('[ok] ' + b.name + ' Index.ets 与源文件一致 (' + js.length + ' chars)');
    }
  }

  if (writeBack && errors.length === 0 && wrote) {
    writeFileSync(INDEX_ETS, outSrc, 'utf8');
    console.log('[done] Index.ets 已回填，DevEco 重 Build Hap(s) 生效');
  }
  return errors;
}

async function main() {
  const errors = await checkInjectedFreshness(!CHECK_ONLY);
  if (errors.length > 0) {
    for (const e of errors) console.error('[FAIL] ' + e);
    process.exit(1);
  }
  console.log('[check] 全部通过：esbuild 语法 OK · rawfile 产物齐 · Index.ets 新鲜');
}

// 仅直接运行时执行（被 import 时不跑）
const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) main();