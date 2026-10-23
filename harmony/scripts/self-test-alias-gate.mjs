// verify-all.mjs 里 checkPdfjsWasmWiring() 的「https 别名通道」断言自测（不动真实文件：注入伪 readFileSync）。
//
// 为什么需要自测：别名通道是三条独立交付点串起来的 —— 壳侧 ASSET_ORIGIN 常量、
// 注入给渲染层的 window.__goAssetBase、渲染层 ASSET_BASE_CANDIDATES/docOpts() 动态取根。
// 任何一环被改回静态根，资源就会悄悄退回 base64 桥（慢，且 CJK cmap / wasm 取不到），
// 但页面还能开 → 只有门禁能拦住。断言写错则会假红/假绿，故用自测锁定行为。
//   node scripts/self-test-alias-gate.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { getScript } from './lib/injected-extract.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const HARMONY = resolve(HERE, '..')
const ROOT = resolve(HARMONY, '..')
const src = readFileSync(resolve(HERE, 'verify-all.mjs'), 'utf8')

/** 取顶层函数：从 `\nfunction name(` 到下一个行首 `}`。本函数体里有 '{' / '}' 字面量，不能数括号。 */
function grab(name) {
  const i = src.indexOf('\nfunction ' + name + '(')
  if (i < 0) throw new Error('没找到 ' + name)
  const end = src.indexOf('\n}\n', i)
  if (end < 0) throw new Error('没找到 ' + name + ' 的结尾')
  return src.slice(i + 1, end + 2)
}

// 被检函数还依赖模块级 helper/常量（shim/shell/getScript），一并注入沙箱
const factory = new Function(
  'readFileSync', 'resolve', 'existsSync', 'getScript', 'shim', 'shell', '__dirname',
  grab('checkPdfjsWasmWiring') + '\nreturn checkPdfjsWasmWiring'
)

const idx = readFileSync(resolve(HARMONY, 'entry/src/main/ets/pages/Index.ets'), 'utf8')
const view = readFileSync(resolve(ROOT, 'apps/pdf/src/renderer/view-config.ts'), 'utf8')
const probe = readFileSync(resolve(ROOT, 'apps/pdf/src/renderer/pdfjs-wasm.ts'), 'utf8')
const app = readFileSync(resolve(ROOT, 'apps/pdf/src/renderer/App.tsx'), 'utf8')

const make = (files) => (p) => {
  if (p.endsWith('Index.ets')) return files.idx ?? idx
  if (p.endsWith('view-config.ts')) return files.view ?? view
  if (p.endsWith('pdfjs-wasm.ts')) return files.probe ?? probe
  if (p.endsWith('App.tsx')) return files.app ?? app
  return readFileSync(p, 'utf8') // 其余（同步产物 index.html 等）读真盘，避免沙箱假失败
}
let failures = 0
const check = (label, ok, extra = '') => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (extra ? '  → ' + extra : ''))
  if (!ok) failures++
}
const run = (files = {}) => {
  // 注意：factory(...) 只负责取出被检函数，必须再调一次才会真正执行
  try { factory(make(files), resolve, () => true, getScript, getScript('PROMISE_SHIM'), getScript('SHELL_BRIDGE'), HERE)(); return '' } catch (e) { return e.message }
}

// 1) 真实文件零报错
check('真实 Index.ets / view-config / pdfjs-wasm 通过', run() === '', run())

// 2) 壳侧三个交付点
const noConst = idx.replace("const ASSET_ORIGIN: string = 'https://goasset.local/';", 'const X: string = "";')
if (noConst === idx) throw new Error('注入失败：ASSET_ORIGIN 锚点未命中')
check('缺 ASSET_ORIGIN 常量可被捕获', /ASSET_ORIGIN 常量/.test(run({ idx: noConst })), run({ idx: noConst }))

const noGlobal = idx.replace("window.__goAssetBase = 'https://goasset.local/';", '')
if (noGlobal === idx) throw new Error('注入失败：__goAssetBase 锚点未命中')
check('未注入 window.__goAssetBase 可被捕获', /__goAssetBase/.test(run({ idx: noGlobal })), run({ idx: noGlobal }))

const noAliasSkip = idx.replace('if (!aliased && !RAWFILE_MODULE_RE.test(path)) {', 'if (!RAWFILE_MODULE_RE.test(path)) {')
if (noAliasSkip === idx) throw new Error('注入失败：aliased 锚点未命中')
check('别名通道误套模块清单（cmap 仍走桥）可被捕获', /RAWFILE_MODULE_RE/.test(run({ idx: noAliasSkip })), run({ idx: noAliasSkip }))

const noAliasFetch = idx.replace('var GO_ASSET_FETCH = ', 'var GO_ASSET_FETCH_X = ')
if (noAliasFetch === idx) throw new Error('注入失败：GO_ASSET_FETCH 锚点未命中')
check('fetch 兜底未覆盖别名根可被捕获', /fetch 兜底未覆盖别名根/.test(run({ idx: noAliasFetch })), run({ idx: noAliasFetch }))

// 3) 渲染层：静态根回退与探测能力
const staticRoot = view.replace('export const docOpts = (): Record<string, string | boolean> => ({', 'export const DOC_OPTS = ({')
if (staticRoot === view) throw new Error('注入失败：docOpts 锚点未命中')
check('资产 URL 退回静态 DOC_OPTS 可被捕获', /DOC_OPTS/.test(run({ view: staticRoot })), run({ view: staticRoot }))

const noCandidates = probe.replaceAll('ASSET_BASE_CANDIDATES', 'X')
check('探针未遍历候选根可被捕获', /候选根探测/.test(run({ probe: noCandidates })), run({ probe: noCandidates }))

const noTimeout = probe.replaceAll('AbortController', 'X')
check('探针无超时（别名不通会卡首次打开）可被捕获', /无超时/.test(run({ probe: noTimeout })), run({ probe: noTimeout }))

const noWriteBack = probe.replaceAll('setAssetBase', 'X')
check('探针未把选中根写回 view-config 可被捕获', /未把选中的资源根写回/.test(run({ probe: noWriteBack })), run({ probe: noWriteBack }))

console.log(failures === 0 ? '\nALIAS GATE SELF-TEST: ALL PASS' : '\nALIAS GATE SELF-TEST: ' + failures + ' FAIL')
process.exit(failures === 0 ? 0 : 1)