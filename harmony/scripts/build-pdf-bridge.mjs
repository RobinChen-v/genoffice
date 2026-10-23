// 打包 PDF 鸿蒙壳桥：esbuild 把 pdf-bridge 入口（pdf-lib 纯逻辑：保存降级版
// applySaveEdits + 结构操作 split/merge/extract/replace/insert/crop/setPageSize +
// readStaticFormFills）打成浏览器可用的单文件 ESM（自包含、无顶层 import，无 node 依赖），
// 供 Index.ets pdfMock 经 window.__goImport 懒加载（inline-renderer 会把 pdf dist/assets
// 下的 .mjs 以 base64 注册进 __goChunks，blob import 执行）。
//
// 用法：
//   node harmony/scripts/build-pdf-bridge.mjs                       # 输出 rawfile/web/pdf-bridge.mjs
//   node harmony/scripts/build-pdf-bridge.mjs --dist <pdfDist>      # 另输出到 dist/assets/
// sync-web.sh 的 pdf 分支在 vite build 之后、inline-renderer 之前调用（--dist）。
import { build } from 'esbuild'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const rawOut = path.join(root, 'harmony', 'entry', 'src', 'main', 'resources', 'rawfile', 'web', 'pdf-bridge.mjs')
const distArg = process.argv.indexOf('--dist')
const distOut = distArg >= 0 && process.argv[distArg + 1]
  ? path.join(process.argv[distArg + 1], 'assets', 'pdf-bridge.mjs')
  : null

const out = await build({
  entryPoints: [path.join(root, 'harmony', 'scripts', 'pdf-bridge', 'entry.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  outfile: rawOut,
  // 派生桥源剥离了 node:fs/PDFium/electron 依赖，理论无 node 内置模块需要 shim；
  // 若上游 save-pdf.ts 增量同步带回 node import，构建会在此失败（显性提醒）。
  logLevel: 'warning',
})

const kb = (fs.statSync(rawOut).size / 1024).toFixed(0)
console.log(`[pdf-bridge] bundled → ${rawOut} (${kb} KB)`)
if (distOut) {
  fs.mkdirSync(path.dirname(distOut), { recursive: true })
  fs.copyFileSync(rawOut, distOut)
  console.log(`[pdf-bridge] copied → ${distOut}（inline-renderer 将注册进 __goChunks）`)
}
console.log(`[pdf-bridge] DONE. Index.ets pdfMock 经 __goImport('pdf-bridge.mjs') 懒加载。`)