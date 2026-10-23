// 打包 PPT 鸿蒙壳桥：esbuild 把 pptx-engine（纯 TS 解析）+ pptx-render（纯 TS 渲染）
// 打成浏览器可用的单文件 ESM（自包含、无顶层 import），供 Index.ets slidesMock 的
// openPptx/consumePendingOpen 经 window.__goImport 懒加载（inline-renderer 会把
// slides dist/assets 下的 .mjs 以 base64 注册进 __goChunks，blob import 执行）。
//
// 用法：
//   node harmony/scripts/build-pptx-bridge.mjs                  # 输出 rawfile/web/pptx-bridge.mjs
//   node harmony/scripts/build-pptx-bridge.mjs --dist <slidesDist>  # 另输出到 dist/assets/
// sync-web.sh 的 slides 分支在 vite build 之后、inline-renderer 之前调用（--dist）。
//
// 浏览器打不了 node 内置模块，这四个都只在 M2+（保存/媒体插入）才被真正调用，
// 用 shim 顶住只读路径（openPptx/buildRenderSlide 不触达它们）。
import { build } from 'esbuild'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const rawOut = path.join(root, 'harmony', 'entry', 'src', 'main', 'resources', 'rawfile', 'web', 'pptx-bridge.mjs')
const shims = path.join(root, 'harmony', 'scripts', 'pptx-bridge', 'shims')
const distArg = process.argv.indexOf('--dist')
const distOut = distArg >= 0 && process.argv[distArg + 1]
  ? path.join(process.argv[distArg + 1], 'assets', 'pptx-bridge.mjs')
  : null

const out = await build({
  entryPoints: [path.join(root, 'harmony', 'scripts', 'pptx-bridge', 'entry.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  outfile: rawOut,
  // node 内置 shim（只读路径不触达；用了也只会抛明确错误而非挂白屏）
  alias: {
    'node:crypto': path.join(shims, 'crypto.ts'),
    'node:zlib': path.join(shims, 'zlib.ts'),
    'node:fs': path.join(shims, 'fs.ts'),
    'node:stream/promises': path.join(shims, 'stream-promises.ts'),
  },
  // op-docs 用 `?raw` 内联 markdown（vite 语法）：读取 .md 原文作为默认导出，
  // 供 opUsage（executor 的错误提示）在壳内照常工作。
  plugins: [{
    name: 'md-raw',
    setup(build) {
      const pathCb = build.resolve
      build.onResolve({ filter: /\.md\?raw$/ }, (args) => {
        // importer 是 op-docs.ts：相对路径按 importer 目录解析成绝对路径
        const abs = path.resolve(path.dirname(args.importer), args.path.replace(/\?raw$/, ''))
        return { path: abs, namespace: 'md-raw' }
      })
      build.onLoad({ filter: /.*/, namespace: 'md-raw' }, (args) => ({
        // text loader 的默认导出 = 文件原文，与 vite 的 `?raw` import 语义一致
        contents: fs.readFileSync(args.path, 'utf8'),
        loader: 'text',
      }))
    },
  }],
  logLevel: 'warning',
})

const kb = (fs.statSync(rawOut).size / 1024).toFixed(0)
console.log(`[pptx-bridge] bundled → ${rawOut} (${kb} KB)`)
if (distOut) {
  fs.mkdirSync(path.dirname(distOut), { recursive: true })
  fs.copyFileSync(rawOut, distOut)
  console.log(`[pptx-bridge] copied → ${distOut}（inline-renderer 将注册进 __goChunks）`)
}
console.log(`[pptx-bridge] DONE. Index.ets slidesMock.openPptx 经 __goImport('pptx-bridge.mjs') 懒加载。`)