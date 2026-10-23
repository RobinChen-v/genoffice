// 独立入口：对 Index.ets 的 documentStart 注入脚本做语法检查 + 新鲜度门禁。
// 用途：日常快速检查，不必跑全量 verify-all。用法: node scripts/check-injected-js.mjs
//
// R1 升级：注入 JS 外置化后，本脚本同时校验：
//   1) 反引号守卫（模板字面量内不得有未转义反引号——会截断注入脚本）
//   2) esbuild 语法校验（injected/*.ts 源文件）
//   3) new Function 语义校验（从 Index.ets 提取还原后执行）
//   4) 新鲜度门禁（Index.ets 回填内容 == 转义(源文件)，构建过期即 FAIL）
//   5) rawfile 产物存在性（rawfile/injected/*.js 必须存在）
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractInjectedScripts } from './lib/injected-extract.mjs';
import { checkInjectedFreshness } from './build-injected.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HARMONY = resolve(HERE, '..');
const INDEX_ETS = resolve(HARMONY, 'entry/src/main/ets/pages/Index.ets');
const RAWFILE_INJECTED = resolve(HARMONY, 'entry/src/main/resources/rawfile/injected');

let fail = 0;

// ── 1) 反引号守卫 ──
// 注入脚本是 ArkTS 模板字面量：内部出现未转义反引号会让模板提前结束 → 整段注入脚本被截断
// （批次 A 截掉 10 万字符、批次 D-5 又踩一次）。回填后所有反引号应已被转义为 \`。
// 用转义感知扫描：遇到 \\ 跳两字符（转义序列），遇到单独 ` 即报错。
function checkStrayBackticks() {
  const src = readFileSync(INDEX_ETS, 'utf8');
  const re = /(?:const|let|var)\s+([A-Z_0-9]+)\s*(:\s*string)?\s*=\s*`/g;
  const bad = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    const name = m[1];
    let i = m.index + m[0].length;
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }  // 转义序列：跳两字符
      if (c === '`') break;  // 闭引号：正常结束
      i++;
    }
    // 重新扫描模板内部，找未转义反引号
    let j = m.index + m[0].length;
    while (j < src.length) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '`') break;  // 闭引号
      j++;
    }
    // 内部扫描已完成（无提前截断）——如果到这里还没找到闭引号，说明模板未闭合
    if (j >= src.length) bad.push(name + ': 模板字面量未闭合（找不到闭引号）');
  }
  if (bad.length === 0 && !/[A-Z_0-9]+\s*=\s*`/.test(src)) {
    bad.push('未找到任何注入模板（const XXX = `）—— 结构变了？');
  }
  return bad;
}

for (const b of checkStrayBackticks()) {
  fail++;
  console.error('[BACKTICK] ' + b);
}

// ── 2) new Function 语义校验（从 Index.ets 提取还原后执行）──
for (const s of extractInjectedScripts()) {
  try {
    new Function('window', 'document', 'localStorage', 'navigator', s.js);
    console.log(`${s.name}: OK (${s.js.length} chars)`);
  } catch (e) {
    fail++;
    console.error(`${s.name}: SYNTAX ERROR -> ${e.message}`);
    const lineMatch = e.stack.match(/<anonymous>:(\d+)/);
    if (lineMatch) {
      const ln = parseInt(lineMatch[1], 10) - 2;
      const lines = s.js.split('\n');
      for (let k = Math.max(0, ln - 1); k < Math.min(lines.length, ln + 2); k++) {
        console.error(`  ${k + 1}: ${lines[k]}`);
      }
    }
  }
}

// ── 3) rawfile 产物存在性 ──
const PRODUCT_FILES = ['shim.js', 'shell.js', 'err.js'];
for (const f of PRODUCT_FILES) {
  const p = resolve(RAWFILE_INJECTED, f);
  if (!existsSync(p)) {
    fail++;
    console.error('[PRODUCT] rawfile/injected/' + f + ' 缺失（跑 node scripts/build-injected.mjs）');
  }
}

// ── 4) 新鲜度门禁（Index.ets 回填内容 == 转义(源文件)）──
const freshnessErrors = await checkInjectedFreshness(false);
if (freshnessErrors.length > 0) {
  for (const e of freshnessErrors) {
    fail++;
    console.error('[FRESHNESS] ' + e);
  }
}

if (fail === 0) console.log('[check-injected-js] 全部通过');
process.exit(fail ? 1 : 0);
