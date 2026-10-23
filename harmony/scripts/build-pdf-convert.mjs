// 打包 PDF 转换鸿蒙壳桥：esbuild 把 pdf-convert 入口（pdf2docx 的 PDF→DOCX/XLSX/PPTX
// 三种转换 + @embedpdf/pdfium 浏览器版 init）打成浏览器可用的单文件 ESM，并把 PDFium
// wasm 实体拷进 rawfile —— 供 Index.ets pdfMock 经 readRawFileJson 懒加载（inline-renderer
// 不参与：与 pdf-bridge 一致，避免 2MB+ base64 注册表拖慢 PDF 打开）。
//
// 产物：
//   harmony/entry/src/main/resources/rawfile/web/pdf-convert.mjs   （转换逻辑）
//   harmony/entry/src/main/resources/rawfile/web/pdfium.wasm       （PDFium wasm，4.6MB）
//
// 用法：
//   node harmony/scripts/build-pdf-convert.mjs
// sync-web.sh 的 pdf 分支在 build-pdf-bridge 之后调用。
import { build } from 'esbuild'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const webDir = path.join(root, 'harmony', 'entry', 'src', 'main', 'resources', 'rawfile', 'web')
const rawOut = path.join(webDir, 'pdf-convert.mjs')
const wasmSrc = path.join(root, 'node_modules', '@embedpdf', 'pdfium', 'dist', 'pdfium.wasm')
const wasmOut = path.join(webDir, 'pdfium.wasm')

if (!fs.existsSync(wasmSrc)) {
  console.error(`[pdf-convert] 缺少 ${wasmSrc}（npm install 未装 @embedpdf/pdfium？）`)
  process.exit(1)
}

const out = await build({
  entryPoints: [path.join(root, 'harmony', 'scripts', 'pdf-convert', 'entry.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  outfile: rawOut,
  // node 内置 shim：只有 @genoffice/font-metrics 的**系统字体**定位/度量路径 import 它们
  // （advance/font-locate/metrics/sfnt）。鸿蒙 webview 无系统字体目录可扫 → 空索引即是
  // 正确答案，转换照常走引擎自身的字形回退（见 shims/fs.ts）。与 pptx-bridge 的 node
  // 内置 shim 同一思路，但这里刻意不做「静默返回空数据」的兜底。
  alias: {
    'node:fs': path.join(root, 'harmony', 'scripts', 'pdf-convert', 'shims', 'fs.ts'),
    'node:os': path.join(root, 'harmony', 'scripts', 'pdf-convert', 'shims', 'os.ts'),
    'node:path': path.join(root, 'harmony', 'scripts', 'pdf-convert', 'shims', 'path.ts'),
    // PDF→PPTX 反过来要走 pptx-engine 的写包路径（zip/sections/media-insert 三个 node
    // 内置）。这三个 shim 与 pptx-bridge 是**同一份文件**：crypto 的 createHash 只喂
    // originalHash（壳内没人读，与 slides 桥一致），zlib 的 deflateSync 只被「3D/视频
    // 海报 PNG」用到（不在 PDF→PPTX 路径上，真触达时抛明确错误而不是产出坏包）。
    'node:crypto': path.join(root, 'harmony', 'scripts', 'pptx-bridge', 'shims', 'crypto.ts'),
    'node:zlib': path.join(root, 'harmony', 'scripts', 'pptx-bridge', 'shims', 'zlib.ts'),
    'node:stream/promises': path.join(root, 'harmony', 'scripts', 'pptx-bridge', 'shims', 'stream-promises.ts'),
  },
  metafile: true,
  // pdf2docx 是纯字节包（不碰 Electron/fs）；若上游带回其它 node: import，构建会在此失败
  // （显性提醒：那就是鸿蒙跑不了的部分，需要派生剥离或补 shim，而不是静默放行）。
  logLevel: 'warning',
})

const kb = (fs.statSync(rawOut).size / 1024).toFixed(0)
console.log(`[pdf-convert] bundled → ${rawOut} (${kb} KB)`)
// 体积归因：pdf2docx 的转换链一旦被上游带回重依赖（如整套 pdfium JS 或 OCR helper），
// 这里会立刻可见（真机首屏与 hap 体积都受影响）。
// metafile 的 key 是「相对构建 cwd 的路径」，这里 outfile 给的是绝对路径，所以不能按 rawOut
// 直接取，按后缀匹配唯一产物（esbuild 只写一个 outfile）。
const outKey = Object.keys(out.metafile.outputs).find((k) => k.endsWith('pdf-convert.mjs'))
const top = Object.entries(out.metafile.outputs[outKey]?.inputs ?? {})
  .map(([k, v]) => [k, v.bytesInOutput])
  .sort((a, b) => b[1] - a[1])
  .slice(0, 5)
for (const [name, bytes] of top) {
  console.log(`[pdf-convert]   top: ${(bytes / 1024).toFixed(0)} KB  ${name}`)
}

fs.copyFileSync(wasmSrc, wasmOut)
console.log(`[pdf-convert] wasm → ${wasmOut} (${(fs.statSync(wasmOut).size / 1048576).toFixed(1)} MB)`)

if (out.errors.length > 0) {
  console.error('[pdf-convert] esbuild errors:', out.errors)
  process.exit(1)
}
console.log(`[pdf-convert] DONE. Index.ets pdfMock 经 readRawFileJson + data: URL 懒加载。`)