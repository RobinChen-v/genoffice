// gen-bridge-contract.mjs — 从 7 app preload 源码自动抽取桥契约
//
// 契约格式 bridge-contract.json：
// {
//   "shell": {
//     "aiOffice": {
//       "recents": { "kind": "invoke", "params": ["query"], "channel": "home:recents" },
//       "onFolderChanged": { "kind": "event", "params": ["handler"], "channel": "home:folder-changed" },
//       ...
//     },
//     ...
//   },
//   ...
// }
//
// 三种方法 kind：
//   invoke  — ipcRenderer.invoke(channel, ...args) → Promise
//   send    — ipcRenderer.send(channel, ...args) → void
//   event   — ipcRenderer.on(channel, listener) → unsubscribe function
//   sync    — 非 IPC 的同步返回（如 AI_PROVIDERS）
//
// 用法：
//   node scripts/gen-bridge-contract.mjs          → 写入 bridge-contract.json
//   node scripts/gen-bridge-contract.mjs --check   → 只比对不写盘（新鲜度门禁）
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const OUTPUT = resolve(__dirname, 'bridge-contract.json');

const PRELOADS = [
  { app: 'shell',    path: 'apps/shell/src/preload/index.ts' },
  { app: 'docs',     path: 'apps/docs/src/preload/index.ts' },
  { app: 'sheets',   path: 'apps/sheets/src/preload/index.ts' },
  { app: 'slides',   path: 'apps/slides/src/preload/index.ts' },
  { app: 'markdown', path: 'apps/markdown/src/preload/index.ts' },
  { app: 'pdf',      path: 'apps/pdf/src/preload/index.ts' },
  { app: 'html',     path: 'apps/html/src/preload/index.ts' },
];

// ─── 解析 contextBridge.exposeInMainWorld 调用 ───
function parseExposeCalls(src) {
  const calls = [];
  const re = /contextBridge\.exposeInMainWorld\(\s*['"]([^'"]+)['"]\s*,\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    calls.push({ name: m[1], objVar: m[2] });
  }
  return calls;
}

// ─── 找到对象字面量的范围 ───
function findObjectRange(src, varName) {
  const re = new RegExp('(?:const|let|var)\\s+' + varName + '\\s*(?::[^=]+)?\\s*=\\s*\\{');
  const m = re.exec(src);
  if (!m) return null;

  const braceStart = m.index + m[0].length - 1;
  let depth = 1;
  let i = braceStart + 1;
  while (i < src.length && depth > 0) {
    const c = src[i];

    // 先跳过注释（注释里的引号/括号不能触发字符串/深度逻辑）
    if (c === '/' && src[i + 1] === '/') {
      // 行注释：跳到换行
      i += 2;
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      // 块注释：跳到 */
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    // 跳过正则表达式字面量 /.../（避免正则中的 // 被误认为行注释）
    if (c === '/' && src[i + 1] !== '/' && src[i + 1] !== '*') {
      // 启发式：检查前一个非空白字符是否表明这是正则表达式而非除法
      let j = i - 1;
      while (j >= 0 && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n' || src[j] === '\r')) j--;
      const prev = src[j];
      if (prev === '(' || prev === ',' || prev === '=' || prev === '!' ||
          prev === '&' || prev === '|' || prev === ':' || prev === '[' ||
          prev === ';' || prev === '{' || prev === '}' || prev === '\n' ||
          prev === undefined ||
          // 关键字 return/typeof/in/of 后面
          (j >= 5 && src.slice(j - 5, j + 1) === 'return') ||
          (j >= 5 && src.slice(j - 5, j + 1) === 'typeof')) {
        // 跳过正则表达式：从 / 到下一个未转义的 /
        i++; // 跳过开 /
        while (i < src.length && src[i] !== '/') {
          if (src[i] === '\\') i++; // 跳过转义
          if (src[i] === '[') {
            // 字符类 [...]：里面的 / 不需要转义
            i++;
            while (i < src.length && src[i] !== ']') {
              if (src[i] === '\\') i++;
              i++;
            }
          }
          i++;
        }
        i++; // 跳过闭 /
        // 跳过正则标志（g, i, m, s, u, y, d）
        while (i < src.length && /[gimsuyd]/.test(src[i])) i++;
        continue;
      }
    }

    // 跳过字符串字面量
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i++;
        i++;
      }
      i++; // 跳过闭引号
      continue;
    }

    if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  if (depth !== 0) return null;

  return { start: m.index, end: i, body: src.slice(braceStart + 1, i - 1) };
}

// ─── 从参数字符串提取参数名 ───
function parseParamNames(paramsStr) {
  if (!paramsStr.trim()) return [];
  const params = [];
  let depth = 0;
  let current = '';
  for (const c of paramsStr) {
    if (c === '(' || c === '[' || c === '<') depth++;
    else if (c === ')' || c === ']' || c === '>') depth--;
    if (c === ',' && depth === 0) {
      params.push(current.trim());
      current = '';
      continue;
    }
    current += c;
  }
  if (current.trim()) params.push(current.trim());

  return params
    .map(p => {
      const colonIdx = p.indexOf(':');
      if (colonIdx > 0) return p.slice(0, colonIdx).trim();
      const qIdx = p.indexOf('?');
      if (qIdx > 0) return p.slice(0, qIdx).trim();
      if (p.startsWith('...')) return p.slice(3).trim();
      return p;
    })
    .filter(p => p && p !== '_' && !p.startsWith('//'));
}

// ─── 从方法体确定 kind + channel ───
function classifyMethodBody(methodBody) {
  // ipcRenderer.invoke('channel', ...) — 字符串字面量通道
  let invokeMatch = /ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/.exec(methodBody);
  if (invokeMatch) {
    return { kind: 'invoke', channel: invokeMatch[1] };
  }
  // ipcRenderer.invoke(VARIABLE.channel, ...) — 变量引用通道
  let invokeVarMatch = /ipcRenderer\.invoke\(\s*([A-Za-z_$][A-Za-z_$0-9]*\.[a-zA-Z_][a-zA-Z0-9_]*)/.exec(methodBody);
  if (invokeVarMatch) {
    return { kind: 'invoke', channel: invokeVarMatch[1] };
  }

  // ipcRenderer.send('channel', ...)
  let sendMatch = /ipcRenderer\.send\(\s*['"]([^'"]+)['"]/.exec(methodBody);
  if (sendMatch) {
    return { kind: 'send', channel: sendMatch[1] };
  }
  let sendVarMatch = /ipcRenderer\.send\(\s*([A-Za-z_$][A-Za-z_$0-9]*\.[a-zA-Z_][a-zA-Z0-9_]*)/.exec(methodBody);
  if (sendVarMatch) {
    return { kind: 'send', channel: sendVarMatch[1] };
  }

  // ipcRenderer.on('channel', ...)
  let onMatch = /ipcRenderer\.on\(\s*['"]([^'"]+)['"]/.exec(methodBody);
  if (onMatch) {
    return { kind: 'event', channel: onMatch[1] };
  }
  let onVarMatch = /ipcRenderer\.on\(\s*([A-Za-z_$][A-Za-z_$0-9]*\.[a-zA-Z_][a-zA-Z0-9_]*)/.exec(methodBody);
  if (onVarMatch) {
    return { kind: 'event', channel: onVarMatch[1] };
  }

  if (/webUtils\.getPathForFile/.test(methodBody)) {
    return { kind: 'invoke', channel: 'webUtils.getPathForFile' };
  }

  if (/AI_PROVIDERS|AI_MEDIA_PROVIDERS|AI_SEARCH_PROVIDERS/.test(methodBody)) {
    return { kind: 'sync', channel: null };
  }

  return { kind: 'unknown', channel: null };
}

// ─── 从对象字面量体中解析方法（基于大括号深度跟踪） ───
function parseMethods(body) {
  const methods = [];
  let i = 0;
  const len = body.length;

  // 辅助函数
  function skipWs() {
    while (i < len) {
      const c = body[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
      if (c === '/' && body[i + 1] === '/') {
        while (i < len && body[i] !== '\n') i++;
        continue;
      }
      if (c === '/' && body[i + 1] === '*') {
        i += 2;
        while (i < len && !(body[i] === '*' && body[i + 1] === '/')) i++;
        i += 2;
        continue;
      }
      break;
    }
  }

  function extractBraceBody() {
    if (body[i] !== '{') return '';
    const start = i + 1;
    let depth = 1;
    i++;
    while (i < len && depth > 0) {
      const c = body[i];
      // 跳过注释
      if (c === '/' && body[i + 1] === '/') { i += 2; while (i < len && body[i] !== '\n') i++; continue; }
      if (c === '/' && body[i + 1] === '*') { i += 2; while (i < len && !(body[i] === '*' && body[i + 1] === '/')) i++; i += 2; continue; }
      // 跳过正则表达式字面量（避免正则中的 // 被误认为行注释）
      if (c === '/' && body[i + 1] !== '/' && body[i + 1] !== '*') {
        let j = i - 1;
        while (j >= 0 && (body[j] === ' ' || body[j] === '\t' || body[j] === '\n' || body[j] === '\r')) j--;
        const prev = body[j];
        if (prev === '(' || prev === ',' || prev === '=' || prev === '!' ||
            prev === '&' || prev === '|' || prev === ':' || prev === '[' ||
            prev === ';' || prev === '{' || prev === '}' || prev === '\n' ||
            prev === undefined) {
          i++;
          while (i < len && body[i] !== '/') {
            if (body[i] === '\\') i++;
            if (body[i] === '[') {
              i++;
              while (i < len && body[i] !== ']') {
                if (body[i] === '\\') i++;
                i++;
              }
            }
            i++;
          }
          i++;
          while (i < len && /[gimsuyd]/.test(body[i])) i++;
          continue;
        }
      }
      // 跳过字符串
      if (c === "'" || c === '"' || c === '`') {
        const quote = c;
        i++;
        while (i < len && body[i] !== quote) {
          if (body[i] === '\\') i++;
          i++;
        }
        i++;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') depth--;
      i++;
    }
    return body.slice(start, i - 1);
  }

  function extractParenBody() {
    if (body[i] !== '(') return '';
    const start = i + 1;
    let depth = 1;
    i++;
    while (i < len && depth > 0) {
      const c = body[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      i++;
    }
    return body.slice(start, i - 1);
  }

  function skipToNextMember() {
    // 跳过 `,` 和空白，准备读下一个成员
    skipWs();
    if (i < len && body[i] === ',') {
      i++;
      skipWs();
    }
  }

  // 主循环
  while (i < len) {
    skipWs();
    if (i >= len) break;

    // 尝试匹配方法签名
    // 模式1: `async methodName(params) {`
    // 模式2: `methodName(params) {`
    // 模式3: `methodName: (params) => {` 或 `methodName: (params) => expr`
    // 模式4: `methodName: function(params) {`
    // 模式5: `methodName: async (params) => {`

    // 先试 `async methodName(` 或 `methodName(`
    const simpleRe = /(?:async\s+)?([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/y;
    simpleRe.lastIndex = i;
    const simpleMatch = simpleRe.exec(body);

    // 再试 `methodName:` (key:value 模式)
    const kvRe = /([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:\s*/y;
    kvRe.lastIndex = i;
    const kvMatch = kvRe.exec(body);

    let methodName = null;
    let paramsStr = '';
    let isArrow = false;

    if (simpleMatch && (!kvMatch || simpleMatch.index <= kvMatch.index)) {
      // `methodName(` 模式
      methodName = simpleMatch[1];
      i = simpleRe.lastIndex;
      // i 现在指向 `(` 之后；回退读参数
      i = simpleMatch.index + simpleMatch[0].length - 1; // 指向 `(`
      paramsStr = extractParenBody();
      // 后面可能有 `{` 或 `=>` 或类型注解
      skipWs();
      // 跳过可能的返回类型注解 `: Type`
      if (body[i] === ':' && body[i + 1] !== ':') {
        // 读到 `{` 或 `=>` 或行尾
        while (i < len && body[i] !== '{' && !(body[i] === '=' && body[i + 1] === '>')) {
          i++;
        }
        skipWs();
      }
    } else if (kvMatch) {
      // `methodName:` 模式
      methodName = kvMatch[1];
      i = kvRe.lastIndex;
      skipWs();

      // 可能是 `async (params) =>` 或 `(params) =>` 或 `function(params) {`
      if (body.slice(i, i + 5) === 'async') {
        i += 5;
        skipWs();
      }
      if (body.slice(i, i + 8) === 'function') {
        i += 8;
        skipWs();
      }
      if (body[i] === '(') {
        paramsStr = extractParenBody();
        skipWs();
      }
      // 跳过 `=>`
      if (body[i] === '=' && body[i + 1] === '>') {
        i += 2;
        isArrow = true;
        skipWs();
      }
      // 跳过可能的返回类型注解
      if (body[i] === ':' && body[i + 1] !== ':') {
        while (i < len && body[i] !== '{' && !(body[i] === '=' && body[i + 1] === '>')) {
          i++;
        }
        skipWs();
      }
    } else {
      // 无法识别，跳过一个字符
      i++;
      continue;
    }

    if (!methodName || methodName === 'installDropOpenBridge') {
      // 跳过这个方法体
      if (body[i] === '{') {
        extractBraceBody();
      }
      skipToNextMember();
      continue;
    }

    // 现在读方法体
    let methodBody = '';
    if (body[i] === '{') {
      methodBody = extractBraceBody();
    } else {
      // 表达式体（arrow function without braces）
      let exprEnd = i;
      let d = 0;
      while (exprEnd < len) {
        const c = body[exprEnd];
        if (c === '(' || c === '[' || c === '{') d++;
        else if (c === ')' || c === ']' || c === '}') {
          if (d === 0) break;
          d--;
        }
        else if (c === ',' && d === 0) break;
        exprEnd++;
      }
      methodBody = body.slice(i, exprEnd);
      i = exprEnd;
    }

    const parsed = classifyMethodBody(methodBody);
    methods.push({
      name: methodName,
      kind: parsed.kind,
      params: parseParamNames(paramsStr),
      channel: parsed.channel,
    });

    skipToNextMember();
  }

  return methods;
}

// ─── 从 preload 源码抽取完整契约 ───
function extractContract(preloadPath) {
  const src = readFileSync(preloadPath, 'utf8');
  const exposes = parseExposeCalls(src);

  const contract = {};
  for (const { name, objVar } of exposes) {
    const range = findObjectRange(src, objVar);
    if (!range) {
      contract[name] = { _error: `未找到对象 ${objVar}` };
      continue;
    }
    const methods = parseMethods(range.body);
    const methodMap = {};
    for (const m of methods) {
      if (m.name === 'installDropOpenBridge') continue;
      methodMap[m.name] = {
        kind: m.kind,
        params: m.params,
        channel: m.channel,
      };
    }
    contract[name] = methodMap;
  }

  return contract;
}

// ─── 主入口 ───
export function generateBridgeContract() {
  const fullContract = {};
  for (const { app, path } of PRELOADS) {
    const absPath = resolve(ROOT, path);
    if (!existsSync(absPath)) {
      fullContract[app] = { _error: `preload 不存在: ${path}` };
      continue;
    }
    fullContract[app] = extractContract(absPath);
  }
  return fullContract;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const fresh = generateBridgeContract();

  if (process.argv.includes('--check')) {
    if (!existsSync(OUTPUT)) {
      console.error('FAIL: bridge-contract.json 不存在，需要先运行 gen-bridge-contract');
      process.exit(1);
    }
    const existing = JSON.parse(readFileSync(OUTPUT, 'utf8'));
    const freshStr = JSON.stringify(fresh, null, 2);
    const existingStr = JSON.stringify(existing, null, 2);
    if (freshStr !== existingStr) {
      console.error('FAIL: bridge-contract.json 与 preload 源码不一致（契约过期）');
      console.error('  运行 `node scripts/gen-bridge-contract.mjs` 重新生成');
      const freshKeys = new Set();
      const existingKeys = new Set();
      for (const [app, bridges] of Object.entries(fresh)) {
        for (const [ns, methods] of Object.entries(bridges)) {
          if (typeof methods === 'object' && !methods._error) {
            for (const m of Object.keys(methods)) {
              freshKeys.add(`${app}.${ns}.${m}`);
            }
          }
        }
      }
      for (const [app, bridges] of Object.entries(existing)) {
        for (const [ns, methods] of Object.entries(bridges)) {
          if (typeof methods === 'object' && !methods._error) {
            for (const m of Object.keys(methods)) {
              existingKeys.add(`${app}.${ns}.${m}`);
            }
          }
        }
      }
      const added = [...freshKeys].filter(k => !existingKeys.has(k));
      const removed = [...existingKeys].filter(k => !freshKeys.has(k));
      if (added.length) console.error(`  新增: ${added.join(', ')}`);
      if (removed.length) console.error(`  移除: ${removed.join(', ')}`);
      process.exit(1);
    }
    console.error('OK: bridge-contract.json 与 preload 源码一致');
    process.exit(0);
  }

  writeFileSync(OUTPUT, JSON.stringify(fresh, null, 2));

  let totalInvoke = 0;
  let totalEvents = 0;
  let totalSends = 0;
  let totalSync = 0;
  let totalUnknown = 0;
  for (const [app, bridges] of Object.entries(fresh)) {
    let appMethods = 0;
    for (const [ns, methods] of Object.entries(bridges)) {
      if (typeof methods !== 'object' || methods._error) continue;
      for (const m of Object.values(methods)) {
        appMethods++;
        if (m.kind === 'event') totalEvents++;
        else if (m.kind === 'send') totalSends++;
        else if (m.kind === 'invoke') totalInvoke++;
        else if (m.kind === 'sync') totalSync++;
        else totalUnknown++;
      }
    }
    console.error(`${app}: ${appMethods} methods across ${Object.keys(bridges).length} bridges`);
  }
  console.error(`TOTAL: ${totalInvoke} invoke + ${totalSends} send + ${totalEvents} event + ${totalSync} sync + ${totalUnknown} unknown → ${OUTPUT}`);
}