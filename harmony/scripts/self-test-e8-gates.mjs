// 批次 E-8 新门禁 checkSettingsSections 的**反例自测**：证明它会红，而不是恒绿的装饰门禁。
//
// 手法沿用 self-test-e6/e7-gates.mjs：从 verify-all.mjs 抽函数源码，用 new Function 注入一个
// 「只篡改被测文件」的 readFileSync（readdirSync/resolve/existsSync 用真的），断言点因此落在生产路径上。
//
// 用例（都是删除独立分区后真实会发生的形态）：
//   E8-0 正例：不改文件 → 必须绿
//   E8-1 深链指向已删除的分区（首页 Jev 按钮没跟着改）→ **打开设置白屏** → 红
//   E8-2 独立分区复活（SECTIONS 里加回 aiMedia）→ 红
//   E8-3 联合类型与 SECTIONS 不一致（删分区时只删了 nav 项）→ 红
//   E8-4 SectionIcon 留下死分支（删分区但没删图标）→ 红
//   E8-5 内嵌面板漏传 onFileSearchChange（改 Jev 重排后首页不重判序）→ 红
//   E8-6 内嵌面板漏传 focusBlock（首页 Jev 深链不定位）→ 红
//   E8-7 AiMediaPane 出现第二个渲染点（又变成两个入口）→ 红
//   E8-8 AiModelPane 不接收两个入参（没法透传）→ 红
//
// 用法: node scripts/self-test-e8-gates.mjs
import { readFileSync as realRead, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERIFY = resolve(__dirname, 'verify-all.mjs');
const REPO = resolve(__dirname, '..', '..');

function extractFn(name) {
  const src = realRead(VERIFY, 'utf8');
  const start = src.indexOf('function ' + name + '() {');
  if (start < 0) throw new Error('verify-all.mjs 里找不到 ' + name + '（被改名/删了？）');
  const end = src.indexOf('\n}', start);
  if (end < 0) throw new Error(name + ' 源码里找不到结束行首 }');
  return src.slice(start, end + 2);
}

const FN = extractFn('checkSettingsSections');

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

const MODAL = 'renderer/src/SettingsModal.tsx';
const HOME = 'renderer/src/Home.tsx';
const MODAL_REL = 'apps/shell/src/renderer/src/SettingsModal.tsx';
const HOME_REL = 'apps/shell/src/renderer/src/Home.tsx';
const read = (rel) => realRead(resolve(REPO, rel), 'utf8');

// 篡改源：只做一次 replace，命中数必须为 1（否则锚点过期 → 用例静默失效，那种自测是假的）
const patch = (rel, from, to) => {
  const src = read(rel);
  const hits = src.split(from).length - 1;
  if (hits !== 1) throw new Error('锚点「' + from.slice(0, 60) + '」在 ' + rel + ' 命中 ' + hits + ' 次（应为 1）');
  return src.replace(from, to);
};

const cases = [
  { id: 'E8-0', what: '正例：不改文件 → 应绿', overrides: new Map(), expect: null },
  {
    id: 'E8-1',
    what: '深链指向已删除的分区（首页 Jev 按钮打 aiMedia）',
    overrides: new Map([[HOME, patch(HOME_REL,
      "onClick={() => setSettingsRequest({ section: 'aiModel', block: 'rerank' })}",
      "onClick={() => setSettingsRequest({ section: 'aiMedia', block: 'rerank' })}")]]),
    expect: '不在 SECTIONS 内（打开设置会白屏）',
  },
  {
    id: 'E8-2',
    what: '独立分区复活',
    overrides: new Map([[MODAL, patch(MODAL_REL,
      "  { id: 'general', labelKey: 'setSecGeneral' },",
      "  { id: 'aiMedia', labelKey: 'setSecAiMedia' },\n  { id: 'general', labelKey: 'setSecGeneral' },")]]),
    expect: '又有 aiMedia 独立分区',
  },
  {
    id: 'E8-3',
    what: '联合类型与 SECTIONS 不一致',
    overrides: new Map([[MODAL, patch(MODAL_REL,
      "export type SectionId = 'aiModel' | 'general' | 'integrations' | 'about'",
      "export type SectionId = 'aiModel' | 'aiMedia' | 'general' | 'integrations' | 'about'")]]),
    expect: 'SectionId 与 SECTIONS 不一致',
  },
  {
    id: 'E8-4',
    what: 'SectionIcon 留下死分支（分区删了、图标没删）',
    overrides: new Map([[MODAL, patch(MODAL_REL,
      "  if (id === 'integrations') {",
      "  if (id === 'aiMedia') {\n    return null\n  }\n  if (id === 'integrations') {")]]),
    expect: 'SectionIcon 有死分支 id=aiMedia',
  },
  {
    id: 'E8-5',
    what: '内嵌面板漏传 onFileSearchChange',
    overrides: new Map([[MODAL, patch(MODAL_REL,
      '<AiMediaPane t={t} onFileSearchChange={onFileSearchChange} focusBlock={focusBlock} />',
      '<AiMediaPane t={t} focusBlock={focusBlock} />')]]),
    expect: '没透传 onFileSearchChange',
  },
  {
    id: 'E8-6',
    what: '内嵌面板漏传 focusBlock',
    overrides: new Map([[MODAL, patch(MODAL_REL,
      '<AiMediaPane t={t} onFileSearchChange={onFileSearchChange} focusBlock={focusBlock} />',
      '<AiMediaPane t={t} onFileSearchChange={onFileSearchChange} />')]]),
    expect: '没透传 focusBlock',
  },
  {
    id: 'E8-7',
    what: 'AiMediaPane 出现第二个渲染点（又变成两个入口）',
    overrides: new Map([[MODAL, patch(MODAL_REL,
      "            {section === 'general' && (",
      "            {section === 'aiModel' && <AiMediaPane t={t} focusBlock={focusBlock} />}\n            {section === 'general' && (")]]),
    expect: '个渲染点（应为 1',
  },
  {
    id: 'E8-8',
    what: 'AiModelPane 不接收两个入参',
    overrides: new Map([[MODAL, patch(MODAL_REL,
      'function AiModelPane({\n  t,\n  onFileSearchChange,\n  focusBlock,\n}: {\n  t: TFunc\n  onFileSearchChange?: () => void\n  focusBlock?: TestedBlock\n}) {',
      'function AiModelPane({ t }: { t: TFunc }) {')]]),
    expect: 'AiModelPane 没有接收 onFileSearchChange',
  },
];

let pass = 0, fail = 0;
for (const c of cases) {
  let results;
  try {
    results = [['SettingsSections', 'ok', fnWith(c.overrides)(FN)()]];
  } catch (e) {
    results = [['SettingsSections', 'throw', e.message]];
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
console.log('\nself-test-e8-gates: PASS ' + pass + ' / FAIL ' + fail);
process.exit(fail ? 1 : 0);