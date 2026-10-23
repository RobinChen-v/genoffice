// gen-catalogs.mjs — 从上游源码自动生成鸿蒙壳侧目录 JSON
//
// 核心思路：
//   1. 从上游源码提取 provider id 列表（正则，可靠）
//   2. 其余所有字段（label/keyPlaceholder/defaultModel/baseUrl 等）由鸿蒙差异映射表驱动
//   3. 上游新增 provider → 映射表中找不到 → 警告（新鲜度门禁捕获）
//   4. 上游删除 provider → id 列表变化 → --check 模式检测到 JSON 过期
//
// 生成产物：
//   ai-catalog.json           — AI 聊天提供方目录
//   ai-search-catalog.json    — AI 搜索提供方目录
//   ai-media-catalog.json     — AI 媒体提供方目录（生图/解析）
//   ai-media-base-defaults.json — 媒体端点默认 baseUrl 表
//   sheet-ops-ok.json         — Sheet 操作白名单
//
// 用法：
//   node scripts/gen-catalogs.mjs          → 写入 5 个 JSON 文件
//   node scripts/gen-catalogs.mjs --check   → 只比对不写盘（新鲜度门禁）
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const SCRIPTS_DIR = __dirname;

// ─── 上游源码路径 ───
const PROVIDERS_TS = resolve(ROOT, 'packages/ai-provider/src/providers.ts');
const SEARCH_SETTINGS_TS = resolve(ROOT, 'packages/ai-provider/src/search-settings.ts');
const MEDIA_TS = resolve(ROOT, 'packages/ai-provider/src/media.ts');
const SHEET_OPS_RS = resolve(ROOT, 'apps/sheets/native/xlsx-engine/src/sheet_ops.rs');

// ─── 输出路径 ───
const OUTPUTS = {
  aiCatalog: resolve(SCRIPTS_DIR, 'ai-catalog.json'),
  aiSearchCatalog: resolve(SCRIPTS_DIR, 'ai-search-catalog.json'),
  aiMediaCatalog: resolve(SCRIPTS_DIR, 'ai-media-catalog.json'),
  aiMediaBaseDefaults: resolve(SCRIPTS_DIR, 'ai-media-base-defaults.json'),
  sheetOpsOk: resolve(SCRIPTS_DIR, 'sheet-ops-ok.json'),
};

// ─── 鸿蒙差异配置 ───

// 鸿蒙未接的 chat provider（从目录中删除）
const EXCLUDED_CHAT_PROVIDERS = new Set(['genspark', 'codex', 'requesty', 'opper']);
// 鸿蒙未接的 search provider
const EXCLUDED_SEARCH_PROVIDERS = new Set(['genspark']);
// 鸿蒙未接的 media provider（genspark 无权用；minimax 生图协议未接）
const EXCLUDED_MEDIA_PROVIDERS = new Set(['genspark', 'minimax']);

// AI 聊天目录映射表：id → { label, defaultModel, keyPlaceholder }
// models 始终为 []（鸿蒙侧改为自由输入框），needsBaseUrl 始终为 true，defaultBaseUrl 始终为 ''
const CHAT_CATALOG_MAP = {
  glm: { label: 'GLM（智谱）', defaultModel: 'glm-5.3', keyPlaceholder: 'sk-...' },
  deepseek: { label: 'DeepSeek', defaultModel: 'deepseek-v4-pro', keyPlaceholder: 'sk-...' },
  qwen: { label: 'Qwen（阿里云百炼）', defaultModel: 'qwen3.8-max', keyPlaceholder: 'sk-...' },
  doubao: { label: '豆包（火山方舟）', defaultModel: 'doubao-seed-2-1-pro-260628', keyPlaceholder: 'sk-...' },
  kimi: { label: 'Kimi（月之暗面）', defaultModel: 'kimi-k3', keyPlaceholder: 'sk-...' },
  minimax: { label: 'MiniMax', defaultModel: 'MiniMax-M3', keyPlaceholder: 'sk-...' },
  custom: { label: '自定义端点（OpenAI 兼容）', defaultModel: '', keyPlaceholder: 'sk-...' },
  anthropic: { label: 'Claude（Anthropic 协议 /v1/messages）', defaultModel: 'claude-sonnet-5', keyPlaceholder: 'sk-ant-...' },
  openrouter: { label: 'OpenRouter（聚合网关）', defaultModel: 'openrouter/auto', keyPlaceholder: 'sk-or-...' },
  openai: { label: 'OpenAI', defaultModel: 'gpt-5.6-terra', keyPlaceholder: 'sk-...' },
  gemini: { label: 'Gemini（OpenAI 兼容路径）', defaultModel: 'gemini-3.7-flash', keyPlaceholder: 'AIza...' },
  xai: { label: 'Grok', defaultModel: 'grok-4.6', keyPlaceholder: 'xai-...' },
  mistral: { label: 'Mistral', defaultModel: 'mistral-medium-latest', keyPlaceholder: 'sk-...' },
  'opencode-zen': { label: 'OpenCode Zen', defaultModel: 'claude-sonnet-5', keyPlaceholder: '' },
  'opencode-go': { label: 'OpenCode Go', defaultModel: 'kimi-k2.7-code', keyPlaceholder: '' },
};

// AI 搜索目录映射表：id → { label, keyPlaceholder, imageSearch }
const SEARCH_CATALOG_MAP = {
  serper: { label: 'Serper（Google 结果，含图片搜索）', keyPlaceholder: '申请 serper.dev 免费 Key', imageSearch: true },
  tavily: { label: 'Tavily（面向 LLM 的搜索 API，仅网页结果）', keyPlaceholder: '申请 tavily.com 免费 Key（tvly-...）', imageSearch: false },
  parallel: { label: 'Parallel（v1 search，仅网页结果）', keyPlaceholder: '申请 parallel.ai API Key', imageSearch: false },
};

// AI 媒体目录映射表：完整条目定义（鸿蒙侧只有 openai-images 生图 + openai-chat 解析两种协议）
// gemini：不给 imageProtocol（生图需原生协议，鸿蒙未接），解析走 OpenAI 兼容路径
// qwen：baseUrl 用 /compatible-mode/v1（上游是根路径）
const MEDIA_CATALOG_MAP = {
  openai: {
    label: 'OpenAI 兼容生图（/images/generations）',
    description: '任何提供 /images/generations 的端点都能用；填 Key 后可改端点与模型 id。',
    keyPlaceholder: 'sk-...', defaultBaseUrl: 'https://api.openai.com/v1',
    imageProtocol: 'openai-images',
    imageModels: ['gpt-image-2', 'gpt-image-1.5', 'gpt-image-1', 'gpt-image-1-mini', 'dall-e-3'],
    defaultImageModel: 'gpt-image-1',
    analysisProtocol: 'openai-chat',
    analysisModels: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4-mini'],
    defaultAnalysisModel: 'gpt-5.6-terra',
    videoAnalysis: false,
  },
  glm: {
    label: 'GLM（智谱）',
    description: 'CogView 生图走 /images/generations；GLM-V 解析图片。在「AI 模型」里配过智谱的话，这里不填 Key 也会自动复用。',
    keyPlaceholder: 'xxxxxxxx.xxxxxxxx', defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    imageProtocol: 'openai-images',
    imageModels: ['cogview-4-250304', 'cogview-3-flash'],
    defaultImageModel: 'cogview-4-250304',
    analysisProtocol: 'openai-chat',
    analysisModels: ['glm-4.6v', 'glm-4.6v-flash'],
    defaultAnalysisModel: 'glm-4.6v',
    videoAnalysis: true,
  },
  qwen: {
    label: 'Qwen（阿里云百炼）',
    description: 'qwen-image 生图与 qwen3-vl 解析都走百炼的 OpenAI 兼容端点；视频解析可用。',
    keyPlaceholder: 'sk-...', defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    imageProtocol: 'openai-images',
    imageModels: ['qwen-image-plus', 'qwen-image'],
    defaultImageModel: 'qwen-image-plus',
    analysisProtocol: 'openai-chat',
    analysisModels: ['qwen3-vl-plus', 'qwen3-vl-flash', 'qwen3.8-max', 'qwen3.7-plus'],
    defaultAnalysisModel: 'qwen3-vl-plus',
    videoAnalysis: true,
  },
  doubao: {
    label: '豆包（火山方舟）',
    description: 'Seedream 生图、Seed 解析（图片与视频）都在方舟的 /api/v3 上。',
    keyPlaceholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    imageProtocol: 'openai-images',
    imageModels: ['doubao-seedream-5-0-260128', 'doubao-seedream-4-5-251128', 'doubao-seedream-4-0-250828'],
    defaultImageModel: 'doubao-seedream-5-0-260128',
    analysisProtocol: 'openai-chat',
    analysisModels: ['doubao-seed-2-1-pro-260628', 'doubao-seed-2-1-turbo-260628'],
    defaultAnalysisModel: 'doubao-seed-2-1-pro-260628',
    videoAnalysis: true,
  },
  xai: {
    label: 'Grok（xAI）',
    description: 'Grok Imagine 生图；Grok 只解析图片（视频不支持）。',
    keyPlaceholder: 'xai-...', defaultBaseUrl: 'https://api.x.ai/v1',
    imageProtocol: 'openai-images',
    imageModels: ['grok-imagine-image-2.0', 'grok-2-image-1212'],
    defaultImageModel: 'grok-imagine-image-2.0',
    analysisProtocol: 'openai-chat',
    analysisModels: ['grok-4.6', 'grok-4.5'],
    defaultAnalysisModel: 'grok-4.6',
    videoAnalysis: false,
  },
  gemini: {
    label: 'Gemini（OpenAI 兼容路径，仅解析）',
    description: '解析走 Gemini 的 OpenAI 兼容路径（/v1beta/openai），图片与视频都行；生图需原生协议，鸿蒙侧未接 → 只用于解析。',
    keyPlaceholder: 'AIza...', defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    // 无 imageProtocol：鸿蒙侧不接 gemini 原生生图协议
    analysisProtocol: 'openai-chat',
    analysisModels: ['gemini-3.7-flash', 'gemini-3.1-pro-preview', 'gemini-3.6-flash'],
    defaultAnalysisModel: 'gemini-3.7-flash',
    videoAnalysis: true,
  },
  custom: {
    label: '自定义端点（生图 + 图片 / 视频理解）',
    description: '填你自己的网关：生图走 /images/generations，理解走聊天端点的多模态输入（OpenAI 兼容或 Anthropic 协议均可）。视频理解取决于所选模型是否支持。',
    keyPlaceholder: 'sk-...', defaultBaseUrl: '', needsBaseUrl: true,
    imageProtocol: 'openai-images',
    imageModels: [], defaultImageModel: '',
    analysisProtocol: 'openai-chat',
    analysisModels: [], defaultAnalysisModel: '',
    videoAnalysis: true,
  },
};

// 媒体端点默认 baseUrl 表（比 AI_MEDIA_CATALOG 多一个 minimax）
// 用于「测试连接」在用户没填 baseUrl 时的回落
const MEDIA_BASE_DEFAULTS_MAP = {
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  doubao: 'https://ark.cn-beijing.volces.com/api/v3',
  glm: 'https://open.bigmodel.cn/api/paas/v4',
  xai: 'https://api.x.ai/v1',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  minimax: 'https://api.minimaxi.com/v1',
  custom: '',
};

// ─── 解析工具 ───

/**
 * 从 TypeScript 源码中提取导出数组内的所有 `id: 'xxx'` 值。
 * 只提取 id 字段——其余字段由鸿蒙差异映射表驱动。
 */
function extractIds(src, varName) {
  // 定位数组起始：`export const VAR_NAME: Type[] = [` 或 `export const VAR_NAME = [`
  const startRe = new RegExp(`export\\s+const\\s+${varName}\\s*(?::[^=]+)?\\s*=\\s*\\[`);
  const startMatch = startRe.exec(src);
  if (!startMatch) return null;

  // 找到匹配的闭合 `]`（考虑嵌套和字符串）
  let depth = 1;
  let i = startMatch.index + startMatch[0].length;
  let inString = false;
  let stringChar = '';
  let inLineComment = false;
  let inBlockComment = false;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    const next = src[i + 1];
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      i++;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') { inBlockComment = false; i += 2; continue; }
      i++;
      continue;
    }
    if (inString) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === stringChar) { inString = false; }
      i++;
      continue;
    }
    if (ch === '/' && next === '/') { inLineComment = true; i += 2; continue; }
    if (ch === '/' && next === '*') { inBlockComment = true; i += 2; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { inString = true; stringChar = ch; i++; continue; }
    if (ch === '[' || ch === '{') depth++;
    if (ch === ']' || ch === '}') depth--;
    i++;
  }

  const arrText = src.slice(startMatch.index + startMatch[0].length, i - 1);

  // 提取所有 `id: 'xxx'` 或 `id: "xxx"` 值
  const ids = [];
  const idRe = /id\s*:\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = idRe.exec(arrText)) !== null) {
    ids.push(m[1]);
  }
  return ids;
}

// ─── 生成函数 ───

function generateAiCatalog() {
  const src = readFileSync(PROVIDERS_TS, 'utf-8');
  const upstreamIds = extractIds(src, 'AI_PROVIDERS');
  if (!upstreamIds) throw new Error('无法从 providers.ts 提取 AI_PROVIDERS id 列表');

  // 检测上游新增的 provider（在映射表中找不到的）
  for (const id of upstreamIds) {
    if (!EXCLUDED_CHAT_PROVIDERS.has(id) && !CHAT_CATALOG_MAP[id]) {
      console.warn(`⚠ 上游新增 chat provider "${id}"：映射表中无对应条目，请更新 CHAT_CATALOG_MAP`);
    }
  }

  // 按映射表顺序生成（映射表顺序 = Index.ets 中的展示顺序）
  const catalog = [];
  for (const id of Object.keys(CHAT_CATALOG_MAP)) {
    // 确认上游仍有此 provider
    if (!upstreamIds.includes(id)) {
      console.warn(`⚠ 映射表中的 chat provider "${id}" 已从上游删除`);
      continue;
    }
    const entry = CHAT_CATALOG_MAP[id];
    catalog.push({
      id,
      label: entry.label,
      models: [],
      defaultModel: entry.defaultModel,
      keyPlaceholder: entry.keyPlaceholder,
      needsBaseUrl: true,
      defaultBaseUrl: '',
    });
  }
  return catalog;
}

function generateAiSearchCatalog() {
  const src = readFileSync(SEARCH_SETTINGS_TS, 'utf-8');
  const upstreamIds = extractIds(src, 'AI_SEARCH_PROVIDERS');
  if (!upstreamIds) throw new Error('无法从 search-settings.ts 提取 AI_SEARCH_PROVIDERS id 列表');

  for (const id of upstreamIds) {
    if (!EXCLUDED_SEARCH_PROVIDERS.has(id) && !SEARCH_CATALOG_MAP[id]) {
      console.warn(`⚠ 上游新增 search provider "${id}"：映射表中无对应条目，请更新 SEARCH_CATALOG_MAP`);
    }
  }

  const catalog = [];
  for (const id of Object.keys(SEARCH_CATALOG_MAP)) {
    if (!upstreamIds.includes(id)) {
      console.warn(`⚠ 映射表中的 search provider "${id}" 已从上游删除`);
      continue;
    }
    const entry = SEARCH_CATALOG_MAP[id];
    catalog.push({
      id,
      label: entry.label,
      keyPlaceholder: entry.keyPlaceholder,
      imageSearch: entry.imageSearch,
    });
  }
  return catalog;
}

function generateAiMediaCatalog() {
  const src = readFileSync(MEDIA_TS, 'utf-8');
  const upstreamIds = extractIds(src, 'AI_MEDIA_PROVIDERS');
  if (!upstreamIds) throw new Error('无法从 media.ts 提取 AI_MEDIA_PROVIDERS id 列表');

  for (const id of upstreamIds) {
    if (!EXCLUDED_MEDIA_PROVIDERS.has(id) && !MEDIA_CATALOG_MAP[id]) {
      console.warn(`⚠ 上游新增 media provider "${id}"：映射表中无对应条目，请更新 MEDIA_CATALOG_MAP`);
    }
  }

  const catalog = [];
  for (const id of Object.keys(MEDIA_CATALOG_MAP)) {
    if (!upstreamIds.includes(id)) {
      console.warn(`⚠ 映射表中的 media provider "${id}" 已从上游删除`);
      continue;
    }
    catalog.push({ id, ...MEDIA_CATALOG_MAP[id] });
  }
  return catalog;
}

function generateAiMediaBaseDefaults() {
  const src = readFileSync(MEDIA_TS, 'utf-8');
  const upstreamIds = extractIds(src, 'AI_MEDIA_PROVIDERS');
  if (!upstreamIds) throw new Error('无法从 media.ts 提取 AI_MEDIA_PROVIDERS id 列表');

  // 排除 genspark（鸿蒙无权用），保留其余所有 provider（含 minimax）
  const result = {};
  for (const id of Object.keys(MEDIA_BASE_DEFAULTS_MAP)) {
    if (!upstreamIds.includes(id)) {
      console.warn(`⚠ 映射表中的 media base default "${id}" 已从上游删除`);
      continue;
    }
    result[id] = MEDIA_BASE_DEFAULTS_MAP[id];
  }
  return result;
}

function generateSheetOpsOk() {
  const src = readFileSync(SHEET_OPS_RS, 'utf-8');
  // 从 SheetOp struct 的注释中提取 kind 列表
  // 注释格式: /// add-sheet | duplicate-sheet | remove-sheet | rename-sheet | set-sheet-hidden | reorder-sheets
  const commentMatch = /\/\/\/\s*(add-sheet[^]*?)(?:\n\s*\/\/\/|\n\s*pub)/.exec(src);
  if (commentMatch) {
    const kinds = commentMatch[1].split('|').map(s => s.trim()).filter(s => s);
    if (kinds.length > 0) return kinds;
  }
  // 备选：搜索所有匹配 (add|duplicate|remove|rename|set|reorder)-xxx 的字符串
  const allKinds = [];
  const re = /"((?:add|duplicate|remove|rename|set|reorder)-[^"]+)"/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (!allKinds.includes(m[1])) allKinds.push(m[1]);
  }
  if (allKinds.length > 0) return allKinds;
  // 最终回退：硬编码（与上游保持一致）
  console.warn('⚠ 无法从 sheet_ops.rs 自动提取 SheetOp.kind，使用回退值');
  return ['add-sheet', 'duplicate-sheet', 'remove-sheet', 'rename-sheet', 'set-sheet-hidden', 'reorder-sheets'];
}

// ─── 上游 id 列表与映射表对账 ───

/** 检查上游 id 列表与预期集合（映射表键 + 排除集）是否一致 */
function checkIdSync(upstreamIds, mapKeys, excludedSet, label) {
  const expected = new Set([...mapKeys, ...excludedSet]);
  const upstreamSet = new Set(upstreamIds);
  let mismatch = false;
  for (const id of upstreamIds) {
    if (!expected.has(id)) {
      console.error(`✗ ${label}: 上游新增 provider "${id}" 不在映射表或排除集中`);
      mismatch = true;
    }
  }
  for (const id of mapKeys) {
    if (!upstreamSet.has(id)) {
      console.error(`✗ ${label}: 映射表中的 provider "${id}" 已从上游删除`);
      mismatch = true;
    }
  }
  return !mismatch;
}

// ─── 主入口 ───

function main() {
  const checkOnly = process.argv.includes('--check');

  const generated = {
    aiCatalog: generateAiCatalog(),
    aiSearchCatalog: generateAiSearchCatalog(),
    aiMediaCatalog: generateAiMediaCatalog(),
    aiMediaBaseDefaults: generateAiMediaBaseDefaults(),
    sheetOpsOk: generateSheetOpsOk(),
  };

  if (checkOnly) {
    let stale = false;

    // 1. JSON 内容新鲜度检查
    for (const [key, path] of Object.entries(OUTPUTS)) {
      if (!existsSync(path)) {
        console.error(`✗ ${key}: 文件不存在 ${path}`);
        stale = true;
        continue;
      }
      const existing = JSON.parse(readFileSync(path, 'utf-8'));
      const fresh = generated[key];
      if (JSON.stringify(existing) !== JSON.stringify(fresh)) {
        console.error(`✗ ${key}: 目录已过期（上游源码变更后未重新生成）`);
        stale = true;
      } else {
        console.log(`✓ ${key}: 新鲜`);
      }
    }

    // 2. 上游 id 列表与映射表对账（检测新增/删除 provider）
    const providersSrc = readFileSync(PROVIDERS_TS, 'utf-8');
    const searchSrc = readFileSync(SEARCH_SETTINGS_TS, 'utf-8');
    const mediaSrc = readFileSync(MEDIA_TS, 'utf-8');
    const chatIds = extractIds(providersSrc, 'AI_PROVIDERS');
    const searchIds = extractIds(searchSrc, 'AI_SEARCH_PROVIDERS');
    const mediaIds = extractIds(mediaSrc, 'AI_MEDIA_PROVIDERS');

    if (!checkIdSync(chatIds, Object.keys(CHAT_CATALOG_MAP), EXCLUDED_CHAT_PROVIDERS, 'aiCatalog')) {
      stale = true;
    } else {
      console.log('✓ aiCatalog: 上游 id 列表与映射表一致');
    }
    if (!checkIdSync(searchIds, Object.keys(SEARCH_CATALOG_MAP), EXCLUDED_SEARCH_PROVIDERS, 'aiSearchCatalog')) {
      stale = true;
    } else {
      console.log('✓ aiSearchCatalog: 上游 id 列表与映射表一致');
    }
    // media catalog: 排除集 = EXCLUDED_MEDIA_PROVIDERS（genspark + minimax）
    if (!checkIdSync(mediaIds, Object.keys(MEDIA_CATALOG_MAP), EXCLUDED_MEDIA_PROVIDERS, 'aiMediaCatalog')) {
      stale = true;
    } else {
      console.log('✓ aiMediaCatalog: 上游 id 列表与映射表一致');
    }
    // media base defaults: 排除集 = 只排除 genspark（minimax 保留在 base defaults 中）
    const MEDIA_BASE_EXCLUDED = new Set(['genspark']);
    if (!checkIdSync(mediaIds, Object.keys(MEDIA_BASE_DEFAULTS_MAP), MEDIA_BASE_EXCLUDED, 'aiMediaBaseDefaults')) {
      stale = true;
    } else {
      console.log('✓ aiMediaBaseDefaults: 上游 id 列表与映射表一致');
    }

    if (stale) {
      console.error('\n目录已过期。请运行 `node scripts/gen-catalogs.mjs` 重新生成。');
      process.exit(1);
    }
    console.log('\n所有目录新鲜。');
    return;
  }

  for (const [key, path] of Object.entries(OUTPUTS)) {
    writeFileSync(path, JSON.stringify(generated[key], null, 2) + '\n', 'utf-8');
    const count = Array.isArray(generated[key]) ? generated[key].length : Object.keys(generated[key]).length;
    console.log(`✓ ${key}: ${count} 条 → ${path}`);
  }
  console.log('\n所有目录已生成。');
}

main();