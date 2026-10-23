// 批次 E-6 新门禁的**反例自测**：证明 checkSlidesUnsupportedWiring / checkMockDuplicateKeys
// 真的会红，而不是恒绿的装饰门禁（门禁恒绿 = 下一次漂移照样溜过去，等于没做）。
//
// 手法沿用 self-test-m7-negatives.mjs：从 verify-all.mjs 里**抽出函数源码**，用 new Function
// 注入一个「会篡改某个文件内容」的 readFileSync，其余依赖（resolve/readdirSync/existsSync）
// 全用真的 —— 只替换被测文件这一层，其余走真实仓库，断言点因此是真的在生产路径上。
//
// 用例：
//   E6-1 注册表列了「非恒空桩」的方法（已是真实现）        → SlidesUnsupportedWiring 必须红
//   E6-2 登记表漏登记一个桥覆盖缺口（copyElements）        → SlidesUnsupportedWiring 必须红
//   E6-3 某个方法没有 unsupported() 调用点（guard 被删）    → SlidesUnsupportedWiring 必须红
//   E6-4 真实现被后面同名的空桩遮蔽（moveSlides 事故形态）  → MockDuplicateKeys 必须红
//   E6-0 正例：不改任何文件，两个门禁都必须绿（否则自测本身没意义）
//
// 用法: node scripts/self-test-e6-gates.mjs
import { readFileSync as realRead, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERIFY = resolve(__dirname, 'verify-all.mjs');

// 抽函数：起于 `function NAME() {`，止于其后第一个「列 0 的 }」——函数体整体缩进 ≥2 空格，
// 故第一个行首 `}` 就是函数结束（不能靠大括号计数：函数里有 /\}/ 这类正则和字符串）。
function extractFn(name) {
  const src = realRead(VERIFY, 'utf8');
  const start = src.indexOf('function ' + name + '() {');
  if (start < 0) throw new Error('verify-all.mjs 里找不到 ' + name + '（被改名/删了？）');
  const end = src.indexOf('\n}', start);
  if (end < 0) throw new Error(name + ' 源码里找不到结束行首 }');
  return src.slice(start, end + 2);
}

const FN_SLIDES = extractFn('checkSlidesUnsupportedWiring');
const FN_DUP = extractFn('checkMockDuplicateKeys');

function fnWith(overrides) {
  // overrides: Map<绝对路径后缀, 替换后的内容>
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

const REG = 'scripts/slides-stub-registry.json';
const TABLE = 'renderer/unsupported-features.ts';
const RENDERER_FILE = 'renderer/table-actions.ts';
const INDEX = 'pages/Index.ets';

const cases = [
  {
    id: 'E6-0',
    what: '正例：不改文件，两个门禁都应绿',
    overrides: new Map(),
    expect: null,
  },
  {
    id: 'E6-1',
    what: '注册表多一条非恒空桩方法（emptyOk 里塞 printSlides）',
    overrides: new Map([[REG, JSON.stringify({
      ...JSON.parse(realRead(resolve(__dirname, 'slides-stub-registry.json'), 'utf8')),
      emptyOk: ['getChartColorSchemes', 'getShapeKeys', 'listStyleTemplates', 'printSlides'],
    }, null, 2)]]),
    expect: '注册表列了非恒空桩的方法',
    fn: 'slides',
  },
  {
    id: 'E6-2',
    what: '登记表漏登记一个桥覆盖缺口（ACTIONS 里删掉 copyElements）',
    overrides: new Map([[TABLE, realRead(resolve(__dirname, '..', '..', 'apps/slides/src/renderer/unsupported-features.ts'), 'utf8')
      .replace("  'copyElements',", '  // copyElements 被模拟删掉')]]),
    expect: '桥覆盖缺口未登记',
    fn: 'slides',
  },
  {
    id: 'E6-3',
    what: '某方法没有 unsupported() 调用点（tableMerge 的 guard 被删）',
    overrides: new Map([[RENDERER_FILE, realRead(resolve(__dirname, '..', '..', 'apps/slides/src/renderer/table-actions.ts'), 'utf8')
      .replace("unsupported('tableMerge')", 'false')]]),
    expect: '登记了却没有 unsupported() 调用点',
    fn: 'slides',
  },
  {
    id: 'E6-4',
    what: '真实现被后面同名空桩遮蔽（slidesMock 里再补一个 printSlides 空桩，同名后者胜）',
    overrides: new Map([[INDEX, realRead(resolve(__dirname, '..', 'entry/src/main/ets/pages/Index.ets'), 'utf8')
      .replace('    pickExportDir: function () {',
        '    printSlides: function () { return Promise.resolve(null); },\n    pickExportDir: function () {')]]),
    expect: '后者胜使真实现整条失效',
    fn: 'dup',
  },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const call = fnWith(c.overrides);
  const results = [];
  if (!c.fn || c.fn === 'slides') {
    try { results.push(['SlidesUnsupportedWiring', 'ok', call(FN_SLIDES)()]); }
    catch (e) { results.push(['SlidesUnsupportedWiring', 'throw', e.message]); }
  }
  if (!c.fn || c.fn === 'dup') {
    try { results.push(['MockDuplicateKeys', 'ok', call(FN_DUP)()]); }
    catch (e) { results.push(['MockDuplicateKeys', 'throw', e.message]); }
  }
  for (const [name, kind, detail] of results) {
    const shouldThrow = c.expect && (c.fn === 'slides' ? name === 'SlidesUnsupportedWiring' : name === 'MockDuplicateKeys');
    let ok;
    if (c.expect === null) ok = kind === 'ok';
    else if (shouldThrow) ok = kind === 'throw' && detail.includes(c.expect);
    else ok = kind === 'ok';
    ok ? pass++ : fail++;
    console.log((ok ? '[PASS] ' : '[FAIL] ') + c.id + ' ' + name + ' → ' + kind
      + (kind === 'throw' ? '（' + detail.slice(0, 160) + '）' : '')
      + (c.expect && shouldThrow && kind === 'throw' && !detail.includes(c.expect) ? '  ← 期望含「' + c.expect + '」' : ''));
  }
}
console.log('\nself-test-e6-gates: PASS ' + pass + ' / FAIL ' + fail);
process.exit(fail ? 1 : 0);