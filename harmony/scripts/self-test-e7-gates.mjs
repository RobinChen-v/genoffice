// 批次 E-7 新门禁 checkAiMediaReuse 的**反例自测**：证明它会红，而不是恒绿的装饰门禁。
//
// 手法沿用 self-test-e6-gates.mjs：从 verify-all.mjs 抽出函数源码，用 new Function 注入一个
// 「只篡改被测文件」的 readFileSync，其余依赖走真实仓库 —— 断言点因此真的在生产路径上。
//
// 用例（对应 8 个真实会发生的漂移形态）：
//   E7-0 正例：不改文件 → 必须绿
//   E7-1 「同供应商复用」被删（改成空串）→ 用户配在通义上的 Key 在生图里用不上 → 红
//   E7-2 生图跨厂商继承聊天模型（去掉 cap !== 'image' 守卫）→ 拿 chat 模型 id 打 /images/generations → 红
//   E7-3 默认生图模型两处漂移（表 vs 目录）→ 红
//   E7-4 端点两处漂移（PROMISE_SHIM vs 目录）→ 红
//   E7-5 目录里塞回内置品牌条目 → 红
//   E7-6 i18n 值错位（reuse 文案挂到了 shared 名下，本轮真踩过）→ 红
//   E7-7 i18n 漏一个语块（少一段 = 该语言用户看到裸键名）→ 红
//   E7-8 空目录裸解引用回潮（删掉 if (!meta) return null）→ 红
//   E7-9 下拉不做「目录 + 已配置」并集 → 用户配的模型在生图里选不到 → 红
//
// 用法: node scripts/self-test-e7-gates.mjs
import { readFileSync as realRead, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERIFY = resolve(__dirname, 'verify-all.mjs');
const REPO = resolve(__dirname, '..', '..');

// 抽函数：起于 `function NAME() {`，止于其后第一个「列 0 的 }」（函数体整体缩进 ≥2 空格）。
function extractFn(name) {
  const src = realRead(VERIFY, 'utf8');
  const start = src.indexOf('function ' + name + '() {');
  if (start < 0) throw new Error('verify-all.mjs 里找不到 ' + name + '（被改名/删了？）');
  const end = src.indexOf('\n}', start);
  if (end < 0) throw new Error(name + ' 源码里找不到结束行首 }');
  return src.slice(start, end + 2);
}

const FN = extractFn('checkAiMediaReuse');

function fnWith(overrides) {
  const fakeRead = (p, enc) => {
    const s = String(p);
    for (const [suffix, content] of overrides) {
      if (s.endsWith(suffix)) return content;
    }
    return realRead(p, enc);
  };
  return (src) => new Function(
    'readFileSync', 'existsSync', 'readdirSync', 'resolve', '__dirname',
    'return (' + src + ')',
  )(fakeRead, existsSync, readdirSync, resolve, __dirname);
}

// overrides 用的**路径后缀**（fake readFileSync 按后缀匹配）
const INDEX = 'pages/Index.ets';
const MODAL = 'renderer/src/SettingsModal.tsx';
const STRINGS = 'renderer/src/strings.ts';
// 篡改源（真实仓库相对路径）
const IDX_REL = 'harmony/entry/src/main/ets/pages/Index.ets';
const MODAL_REL = 'apps/shell/src/renderer/src/SettingsModal.tsx';
const STRINGS_REL = 'apps/shell/src/renderer/src/strings.ts';
const read = (rel) => realRead(resolve(REPO, rel), 'utf8');

// 篡改源：只做一次 replace，命中数必须为 1（否则锚点过期，用例会静默失效 —— 那种自测是假的）
const patch = (rel, from, to) => {
  const src = read(rel);
  const hits = src.split(from).length - 1;
  if (hits !== 1) throw new Error('锚点「' + from.slice(0, 60) + '」在 ' + rel + ' 命中 ' + hits + ' 次（应为 1）');
  return src.replace(from, to);
};

const cases = [
  { id: 'E7-0', what: '正例：不改文件 → 应绿', overrides: new Map(), expect: null },
  {
    id: 'E7-1',
    what: '「同供应商 Key/端点」复用被删',
    overrides: new Map([[INDEX, patch(IDX_REL, 'if (!key) { key = own.key; }', "if (!key) { key = ''; }")]]),
    expect: '缺: if (!key) { key = own.key; }',
  },
  {
    id: 'E7-2',
    what: '生图跨厂商继承聊天模型（去掉 cap !== image 守卫）',
    overrides: new Map([[INDEX, patch(IDX_REL, "if (cap !== 'image' && (!model || !key || !base)) {", 'if (!model || !key || !base) {')]]),
    expect: "缺: if (cap !== 'image' && (!model || !key || !base)) {",
  },
  {
    id: 'E7-3',
    what: '默认生图模型两处漂移（PROMISE_SHIM 表 vs 目录）',
    overrides: new Map([[INDEX, patch(IDX_REL, "qwen: 'qwen-image-plus'", "qwen: 'qwen-image-plus-x'")]]),
    expect: '生图默认模型两处不一致',
  },
  {
    id: 'E7-4',
    what: '端点两处漂移（PROMISE_SHIM 的 AI_MEDIA_BASE vs 目录 defaultBaseUrl）',
    overrides: new Map([[INDEX, patch(IDX_REL,
      "  var AI_MEDIA_BASE = {\n    openai: 'https://api.openai.com/v1',\n    gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',\n    doubao: 'https://ark.cn-beijing.volces.com/api/v3',\n    glm: 'https://open.bigmodel.cn/api/paas/v4',",
      "  var AI_MEDIA_BASE = {\n    openai: 'https://api.openai.com/v1',\n    gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',\n    doubao: 'https://ark.cn-beijing.volces.com/api/v3',\n    glm: 'https://open.bigmodel.cn/api/paas/v9',")]]),
    expect: '端点两处不一致',
  },
  {
    id: 'E7-5',
    what: '目录里塞回内置品牌条目',
    overrides: new Map([[INDEX, patch(IDX_REL, 'var AI_MEDIA_CATALOG = [',
      "var AI_MEDIA_CATALOG = [\n    { id: 'genspark', label: 'G', defaultBaseUrl: 'https://x.local',"
      + " analysisProtocol: 'anthropic', analysisModels: ['m'], defaultAnalysisModel: 'm' },")]]),
    expect: '还有 genspark',
  },
  {
    id: 'E7-6',
    what: 'i18n 值错位：某语块的 reuse 文案不含 /images/generations（挂到了 shared 名下）',
    overrides: new Map([[STRINGS, (() => {
      const src = read(STRINGS_REL);
      const re = /setAiReuseModelHint:\n(\s+)'([^']*\/images\/generations[^']*)'/;
      if (!re.test(src)) throw new Error('strings.ts 里找不到含 /images/generations 的 setAiReuseModelHint 首块（锚点过期）');
      return src.replace(re, "setAiReuseModelHint:\n$1'错位文案'");
    })()]]),
    expect: '文案错位',
  },
  {
    id: 'E7-7',
    what: 'i18n 漏一个语块（首个 reuse 键被改名）',
    overrides: new Map([[STRINGS, (() => {
      const src = read(STRINGS_REL);
      const key = 'setAiReuseModelHint:';
      const i = src.indexOf(key);
      if (i < 0) throw new Error('strings.ts 里找不到 ' + key + '（锚点过期）');
      return src.slice(0, i) + 'setAiReuseModelHintX:' + src.slice(i + key.length);
    })()]]),
    expect: '只配了 19 个语块',
  },
  {
    id: 'E7-8',
    what: '空目录裸解引用回潮（mediaBlock 删掉 if (!meta) return null）',
    overrides: new Map([[MODAL, patch(MODAL_REL, '    if (!meta) return null\n', '')]]),
    expect: '缺: if (!meta) return null',
  },
  {
    id: 'E7-9',
    what: '下拉不做「目录 + 已配置」并集（生图池只剩目录）',
    overrides: new Map([[MODAL, patch(MODAL_REL,
      '? [...pool, ...chat.models.filter((m) => !pool.includes(m))]', '? pool')]]),
    expect: '缺: ? [...pool',
  },
];

let pass = 0, fail = 0;
for (const c of cases) {
  let results;
  try {
    results = [['AiMediaReuse', 'ok', fnWith(c.overrides)(FN)()]];
  } catch (e) {
    results = [['AiMediaReuse', 'throw', e.message]];
  }
  for (const [name, kind, detail] of results) {
    let ok;
    if (c.expect === null) ok = kind === 'ok';
    else ok = kind === 'throw' && detail.includes(c.expect);
    ok ? pass++ : fail++;
    console.log((ok ? '[PASS] ' : '[FAIL] ') + c.id + ' ' + name + ' → ' + kind
      + (kind === 'throw' ? '（' + detail.slice(0, 150) + '）' : '')
      + (c.expect && kind === 'throw' && !detail.includes(c.expect) ? '  ← 期望含「' + c.expect + '」' : '')
      + (c.expect && kind === 'ok' ? '  ← 期望红，实际绿' : ''));
  }
}
console.log('\nself-test-e7-gates: PASS ' + pass + ' / FAIL ' + fail);
process.exit(fail ? 1 : 0);