// 抽取每个 app preload 暴露的全部方法（更精确：只匹配 api/projectApi 对象字面量里的 method: function）
// 输出：JSON 写入 scripts/bridge-methods.json
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

// 人工维护的"对外暴露对象" 名称（按 preload 文件）
const APPS = {
  shell:    { path: 'apps/shell/src/preload/index.ts', objects: ['homeApi', 'projectApi', 'tabsApi'] },
  docs:     { path: 'apps/docs/src/preload/index.ts', objects: ['api', 'projectApi'] },
  sheets:   { path: 'apps/sheets/src/preload/index.ts', objects: ['desktopApi', 'projectApi'] },
  slides:   { path: 'apps/slides/src/preload/index.ts', objects: ['api', 'filesApi', 'projectApi'] },
  markdown: { path: 'apps/markdown/src/preload/index.ts', objects: ['api', 'projectApi'] },
  pdf:      { path: 'apps/pdf/src/preload/index.ts', objects: ['api', 'projectApi'] },
};

function extractBetween(src, objectName) {
  // 找 `const <name>: T = {` 然后逐行读缩进 4-space 的方法名
  const start = src.indexOf('const ' + objectName);
  if (start < 0) return [];
  const eqIdx = src.indexOf('=', start);
  const braceStart = src.indexOf('{', eqIdx);
  if (braceStart < 0) return [];
  // 计算括号匹配
  let depth = 1;
  let i = braceStart + 1;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  const body = src.slice(braceStart, i);
  // 提取方法名（适配 2-space / 4-space 缩进 + 方法简写与 key:value 两种语法）
  const methods = [];
  const re = /^[ \t]{2,8}(?:async\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\(|:)/gm;
  let m;
  while ((m = re.exec(body)) !== null) {
    const name = m[1];
    // 排除 JS 关键字 / 内置
    if (/^(if|for|while|switch|return|throw|catch|try|else|do|new|in|of|typeof|await|async|function|const|let|var)$/.test(name)) continue;
    methods.push(name);
  }
  return [...new Set(methods)];
}

const result = {};
/**
 * 重新抽取全部 app 的 preload 契约方法（供 CLI 写盘与门禁比对共用）。
 * 返回值与 bridge-methods.json 同构：{ app: { obj: [method…], _all: […] } }
 */
export function extractBridgeMethods() {
  const out = {};
  for (const [app, { path, objects }] of Object.entries(APPS)) {
    const src = readFileSync(resolve(ROOT, path), 'utf8');
    out[app] = {};
    for (const obj of objects) {
      out[app][obj] = extractBetween(src, obj);
    }
    // 按文件去重
    out[app]._all = [...new Set(Object.values(out[app]).flat())].sort();
  }
  return out;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const fresh = extractBridgeMethods();
  const outPath = resolve(__dirname, 'bridge-methods.json');
  writeFileSync(outPath, JSON.stringify(fresh, null, 2));

  let total = 0;
  for (const app of Object.keys(fresh)) {
    const n = fresh[app]._all.length;
    total += n;
    console.error(`${app}: ${n} methods (across ${Object.keys(fresh[app]).length - 1} objects)`);
  }
  console.error(`TOTAL: ${total} methods → ${outPath}`);
}
