// inline-catalogs.mjs — 将 gen-catalogs.mjs 生成的 JSON 内联到 Index.ets
//
// 工作原理：
//   Index.ets 中的目录变量用标记注释包裹，例如：
//     var AI_CATALOG = /*gen:ai-catalog*/[...]/*gen:ai-catalog*/;
//   本脚本读取 JSON 文件，将标记之间的内容替换为 JSON.stringify 输出。
//
// 用法：
//   node scripts/inline-catalogs.mjs          → 更新 Index.ets 中的目录数据
//   node scripts/inline-catalogs.mjs --check   → 只比对不写盘（新鲜度门禁）
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const SCRIPTS_DIR = __dirname;

// ─── JSON 文件路径（gen-catalogs.mjs 的输出） ───
const JSON_FILES = {
  'ai-catalog': resolve(SCRIPTS_DIR, 'ai-catalog.json'),
  'ai-search-catalog': resolve(SCRIPTS_DIR, 'ai-search-catalog.json'),
  'ai-media-catalog': resolve(SCRIPTS_DIR, 'ai-media-catalog.json'),
  'ai-media-base-defaults': resolve(SCRIPTS_DIR, 'ai-media-base-defaults.json'),
  'sheet-ops-ok': resolve(SCRIPTS_DIR, 'sheet-ops-ok.json'),
};

// ─── Index.ets 路径 ───
const INDEX_ETS = resolve(ROOT, 'harmony/entry/src/main/ets/pages/Index.ets');

// ─── 标记格式：/*gen:<name>*/<content>/*gen:<name>*/ ───
function makeMarker(name) {
  return `/*gen:${name}*/`;
}

/** 在源码中找到标记之间的内容，替换为新内容 */
function replaceBetweenMarkers(src, name, newContent) {
  const open = makeMarker(name);
  const close = makeMarker(name);
  const openIdx = src.indexOf(open);
  if (openIdx < 0) return { src, found: false };
  const closeIdx = src.indexOf(close, openIdx + open.length);
  if (closeIdx < 0) return { src, found: false };
  const before = src.slice(0, openIdx + open.length);
  const after = src.slice(closeIdx);
  return { src: before + newContent + after, found: true };

}

/** 提取标记之间的当前内容 */
function extractBetweenMarkers(src, name) {
  const open = makeMarker(name);
  const close = makeMarker(name);
  const openIdx = src.indexOf(open);
  if (openIdx < 0) return null;
  const closeIdx = src.indexOf(close, openIdx + open.length);
  if (closeIdx < 0) return null;
  return src.slice(openIdx + open.length, closeIdx);
}

// ─── 主入口 ───

function main() {
  const checkOnly = process.argv.includes('--check');

  // 读取所有 JSON 文件
  const catalogData = {};
  for (const [name, path] of Object.entries(JSON_FILES)) {
    catalogData[name] = JSON.parse(readFileSync(path, 'utf-8'));
  }

  // 读取 Index.ets
  const indexSrc = readFileSync(INDEX_ETS, 'utf-8');

  if (checkOnly) {
    let stale = false;
    for (const [name, data] of Object.entries(catalogData)) {
      const current = extractBetweenMarkers(indexSrc, name);
      if (current === null) {
        console.error(`✗ ${name}: Index.ets 中未找到标记 /*gen:${name}*/`);
        stale = true;
        continue;
      }
      const expected = JSON.stringify(data);
      if (current.trim() !== expected) {
        console.error(`✗ ${name}: Index.ets 中的目录数据与 JSON 文件不一致`);
        stale = true;
      } else {
        console.log(`✓ ${name}: 一致`);
      }
    }
    if (stale) {
      console.error('\nIndex.ets 目录数据已过期。请运行 `node scripts/inline-catalogs.mjs` 更新。');
      process.exit(1);
    }
    console.log('\n所有目录数据新鲜。');
    return;
  }

  // 更新 Index.ets
  let updated = indexSrc;
  for (const [name, data] of Object.entries(catalogData)) {
    const jsonStr = JSON.stringify(data);
    const result = replaceBetweenMarkers(updated, name, jsonStr);
    if (!result.found) {
      console.error(`✗ ${name}: Index.ets 中未找到标记 /*gen:${name}*/`);
      continue;
    }
    updated = result.src;
    console.log(`✓ ${name}: 已更新`);
  }

  if (updated !== indexSrc) {
    writeFileSync(INDEX_ETS, updated, 'utf-8');
    console.log('\nIndex.ets 已更新。');
  } else {
    console.log('\nIndex.ets 无需更新。');
  }
}

main();