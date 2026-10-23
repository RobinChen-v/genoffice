// 共享模块：从 Index.ets 提取 documentStart 注入的模板字符串脚本，
// 并按 TS 模板字面量转义规则还原为真实注入的 JS。
//
// 为什么必须转义还原：Index.ets 里 SHELL_BRIDGE/PROMISE_SHIM 是 TS 模板字面量。
// 源码里写 /\/+$/ 时，TS 编译把 \/ 转成 /，注入后变 replace(//... 行注释 →
// 整个脚本 SyntaxError → window.aiOffice 装不上 → shell 白屏（getLanguage 报错）。
// verify-all 若直接用 raw 文本执行，就测不出这类问题 —— 必须先还原再检查/执行。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_ETS = resolve(__dirname, '..', '..', 'entry', 'src', 'main', 'ets', 'pages', 'Index.ets');

// TS 模板字面量转义表（与 JS String 转义一致）
const ESC = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' };

function unescapeTemplate(raw) {
  let i = 0, out = '';
  while (i < raw.length) {
    const c = raw[i];
    if (c === '\\') {
      const n = raw[i + 1];
      if (n === '`' || n === '$' || n === '\\' || n === "'" || n === '"') { out += n; i += 2; continue; }
      if (n in ESC) { out += ESC[n]; i += 2; continue; }
      if (n === 'u' && raw[i + 2] === '{') {
        const end = raw.indexOf('}', i + 3);
        out += String.fromCodePoint(parseInt(raw.slice(i + 3, end), 16)); i = end + 1; continue;
      }
      if (n === 'u') { out += String.fromCharCode(parseInt(raw.slice(i + 2, i + 6), 16)); i += 6; continue; }
      if (n === 'x') { out += String.fromCharCode(parseInt(raw.slice(i + 2, i + 4), 16)); i += 4; continue; }
      // 无效转义（如 \/）：TS/JS 保留后一字符（\/ → /）
      out += n; i += 2; continue;
    }
    if (c === '$' && raw[i + 1] === '{') {
      // 注入脚本不允许 ${} 插值；如出现则保留原文并标记
      out += '${'; i += 2; continue;
    }
    out += c; i++;
  }
  return out;
}

// 提取所有 `const NAME = \`...\`` 大写常量模板字面量（含转义还原）
export function extractInjectedScripts(indexPath = INDEX_ETS) {
  const src = readFileSync(indexPath, 'utf8');
  const re = /(?:const|let|var)\s+([A-Z_0-9]+)\s*(:\s*string)?\s*=\s*`/g;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    const name = m[1];
    const start = m.index + m[0].length;
    let i = start, raw = '', closed = false;
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { raw += c + (src[i + 1] || ''); i += 2; continue; }
      if (c === '`') { closed = true; break; }
      raw += c; i++;
    }
    if (!closed) { throw new Error(`模板字面量 ${name} 未闭合`); }
    out.push({ name, js: unescapeTemplate(raw) });
  }
  return out;
}

export function getScript(name) {
  const all = extractInjectedScripts();
  const hit = all.find(s => s.name === name);
  if (!hit) { throw new Error(`Index.ets 中未找到 ${name}`); }
  return hit.js;
}
