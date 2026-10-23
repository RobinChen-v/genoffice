// Post-build 脚本：将 docs/markdown/pdf/slides 等 renderer 产物全部内联进 index.html，
// 解决 ArkWeb rawfile 协议下 <script type="module" crossorigin> 无法加载、import.meta.url 失效的问题。
//
// 用法：node inline-renderer.mjs <dist_dir> [more_dist_dir ...] [--external] [--app <name>]
//   例如：node inline-renderer.mjs apps/docs/src/renderer/dist
//         node inline-renderer.mjs apps/sheets/src/renderer/dist --external --app sheets
//
// 两种模式：
//   内联（默认）：
//   - 修改 <dist>/index.html：所有 <script src=...> 内联为 <script>...</script>，
//     所有 <link rel=stylesheet href=...> 内联为 <style>...</style>
//   - CSP 增加 'unsafe-inline' 给 script-src（允许内联脚本执行）
//   - 将 `new URL("X", import.meta.url).href` 替换为 "./assets/X"（相对路径）
//   - 把 assets/*.js 以 base64 写进 window.__goChunks（动态 import 的 blob: 中转表）
//   - 保留 assets/ 目录（字体/PNG 仍走相对 URL，由 rawfile 解析）
//
//   外链（--external，D-4）：JS **不内联**，module script 改指
//   `https://goasset.local/web/<app>/assets/index-*.js` —— 壳侧 onInterceptRequest 已有
//   该别名的原生直读通道（text/javascript MIME + CORS + 二进制不按 UTF-8 解码）。收益：
//     · index.html 从 36 MB（sheets）降到 <1 KB → 不再每次打开都解析/编译巨型单行 HTML
//     · 脚本以真 module 身份加载 → import.meta.url、静态/动态 import 全部原生解析，
//       不再需要 __goChunks base64 注册表与 __goImport 改写（那份注册表本身就是页面体积大头）
//     · 资源可被引擎缓存/流式编译（内联模式两者都拿不到）
//   ⚠️ 限制：**依赖 __goChunks 懒加载的 app 不能外链**（slides 的 pptx-bridge.mjs、
//   pdf 的 pdfjs/wasm/*_nowasm_fallback.js —— 外链模式不生成注册表，__goImport 会退回
//   fetch/XHR，而 ArkWeb 下 resource:// 的三条网络通道全被拦 → 懒加载必失败）。
//   本脚本对此有硬守卫：dist 里出现这类文件时 --external 直接报错退出。
//
// 不依赖任何 npm 模块，用 node 原生 fs/path 跑。

import fs from 'node:fs'
import path from 'node:path'

// 与 Index.ets 的 ASSET_ORIGIN 常量保持一致（改动必须两边同步，门禁 checkAssetExternalization 会核）
const ASSET_ORIGIN = 'https://goasset.local/'

// 外链模式禁用名单：这些文件靠构建期 __goChunks 注册表 + __goImport(blob:) 懒加载，
// 外链模式不生成注册表 → 一旦外链，壳侧懒加载会退回被 ArkWeb 拦掉的 fetch/XHR。
const CHUNK_REGISTRY_DEPS = [
  { re: /(^|\/)pptx-bridge\.mjs$/i, who: 'slides 的 pptx-bridge（slidesMock.openPptx 经 __goImport 懒加载）' },
  { re: /_nowasm_fallback\.js$/i, who: 'pdf.js 的纯 JS 解码器（扫描件 JBIG2/CCITT/JPEG2000 兜底）' },
]

/** 从 dist 路径推 app 名：apps/<app>/src/renderer/dist → <app> */
function deriveApp(distDir) {
  const norm = distDir.split(path.sep).join('/')
  const m = /\/apps\/([^/]+)\/src\/renderer\/dist\/?$/.exec('/' + norm.replace(/^\/+/, ''))
  return m ? m[1] : ''
}

/** CSP：给 script-src 追加来源（已存在则跳过）。返回改写后的 html。 */
function cspAddScriptSrc(html, adds) {
  return html.replace(/content="([^"]*)"/, (m, csp) => {
    const fixed = csp.replace(/script-src\s+([^;]+)/, (mm, srcs) => {
      let out = srcs
      for (const a of adds) {
        if (!out.split(/\s+/).includes(a)) out += ' ' + a
      }
      return `script-src ${out}`
    })
    if (fixed === csp) return m
    return `content="${fixed}"`
  })
}

/**
 * 内联所有 <link rel="stylesheet" href="..."> → <style>...</style>（两种模式共用）。
 * CSS 相对 url() 的解析基准会从 assets/ 变成 index.html 所在目录，故必须重写为 ./assets/<file>，
 * 否则字体/图片全部 404（真机症状：@font-face 的 url(./Carlito-*.ttf) 全部 rawfile serve miss
 * → fallback 字体 → 文档内容空白）。
 */
function inlineCssInto(html, distDir) {
  let cssCount = 0
  const out = html.replace(
    /<link\s+rel=["']?stylesheet["']?\s+(?:crossorigin\s+)?href=["']([^"']+)["']\s*\/?>/g,
    (_, href) => {
      const file = path.join(distDir, href.replace(/^\.?\/+/, ''))
      if (!fs.existsSync(file)) return ''
      let css = fs.readFileSync(file, 'utf8')
      css = css.replace(/url\(\s*(['"]?)\.\/(?!assets\/)([^'")\s]+)\1\s*\)/g, (m, q, f) => {
        return `url(${q}./assets/${f}${q})`
      })
      css = css.replace(/url\(\s*(['"]?)([A-Za-z0-9_][^'")\s]*\.[A-Za-z0-9]+)\1\s*\)/g, (m, q, f) => {
        if (/^(https?:|data:|blob:|#|\/)/.test(f)) return m
        if (f.startsWith('assets/')) return m
        return `url(${q}./assets/${f}${q})`
      })
      cssCount++
      return `<style>${css}</style>`
    }
  )
  return { html: out, cssCount }
}

/**
 * 外链模式（D-4）：JS 不内联，改指 goasset 别名；CSS 仍内联（体积小、且 url() 重写已验证）。
 * @returns {boolean} 是否成功写出
 */
function externalDir(distDir, app) {
  const indexPath = path.join(distDir, 'index.html')
  if (!fs.existsSync(indexPath)) {
    console.error(`[skip] ${distDir}: no index.html`)
    return false
  }
  const assetsDir = path.join(distDir, 'assets')
  if (!fs.existsSync(assetsDir)) {
    console.error(`[skip] ${distDir}: no assets/`)
    return false
  }
  if (!app) {
    console.error(`[external] ${distDir}: 无法确定 app 名（用 --app <name>，或让 dist 位于 apps/<app>/src/renderer/dist）`)
    process.exit(1)
  }

  // 硬守卫：依赖 __goChunks 的产物不许外链（见文件头「限制」）
  const offenders = []
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name)
      const st = fs.statSync(p)
      if (st.isDirectory()) { walk(p); continue }
      for (const d of CHUNK_REGISTRY_DEPS) {
        if (d.re.test(p.split(path.sep).join('/'))) offenders.push(d.who + ' → ' + name)
      }
    }
  }
  walk(distDir)
  if (offenders.length > 0) {
    console.error(`[external] 拒绝外链 ${app}：dist 内存在依赖 __goChunks 注册表的产物\n  - ` + offenders.join('\n  - '))
    process.exit(1)
  }

  let html = fs.readFileSync(indexPath, 'utf8')
  const before = html.length
  const prefix = ASSET_ORIGIN + 'web/' + app + '/'

  // module script / modulepreload 的相对 src → goasset 绝对 URL（保留 type=module 与 crossorigin：
  // 页面 origin 是 null，跨源 module 必须走 CORS 匿名模式，而 serveRawfile 会补 ACAO:*）
  const referenced = []
  let jsCount = 0
  html = html.replace(
    /<(script|link)\b([^>]*?)(?:src|href)=(["'])((?:\.\/)?assets\/[^"']+\.js)\3([^>]*)>/g,
    (m0, tag, pre, q, src, post) => {
      const rel = src.replace(/^\.\/+/, '')
      const file = path.join(distDir, rel)
      if (!fs.existsSync(file)) {
        console.error(`[external] ${app}: 引用的产物不存在 → ${rel}`)
        process.exit(1)
      }
      referenced.push(rel)
      jsCount++
      return `<${tag}${pre}src=${q}${prefix}${rel}${q}${post}>`
    }
  )
  // link 用的是 href=，上面那条只覆盖了 src= 的写法，这里补 href 形态
  html = html.replace(
    /<link\b([^>]*?)href=(["'])((?:\.\/)?assets\/[^"']+\.js)\2([^>]*)>/g,
    (m0, pre, q, src, post) => {
      const rel = src.replace(/^\.\/+/, '')
      const file = path.join(distDir, rel)
      if (!fs.existsSync(file)) {
        console.error(`[external] ${app}: modulepreload 指向的产物不存在 → ${rel}`)
        process.exit(1)
      }
      if (!referenced.includes(rel)) referenced.push(rel)
      return `<link${pre}href=${q}${prefix}${rel}${q}${post}>`
    }
  )
  if (jsCount === 0 && referenced.length === 0) {
    console.error(`[external] ${app}: index.html 里没有找到 assets/*.js 引用（产物结构变了？）`)
    process.exit(1)
  }

  const css = inlineCssInto(html, distDir)
  html = css.html

  // CSP：script-src 放行 goasset 源；data:/blob: 仍要留（注入的 PROMISE_SHIM 用 __goImport
  // 经 data:/blob: 懒加载 pdf-bridge/pptx-bridge 等），'unsafe-inline' 保留兜底。
  html = cspAddScriptSrc(html, [ASSET_ORIGIN.replace(/\/$/, ''), "'unsafe-inline'", 'data:', 'blob:'])

  fs.writeFileSync(indexPath, html, 'utf8')
  console.log(`[ok] ${distDir}: EXTERNAL ${referenced.length} JS（CSS 内联 ${css.cssCount}）→ index.html ${before} → ${html.length} bytes`)
  console.log(`     脚本根：${prefix}assets/…（由 Index.ets onInterceptRequest 供字节）`)
  return true
}

function inlineDir(distDir) {
  const indexPath = path.join(distDir, 'index.html')
  if (!fs.existsSync(indexPath)) {
    console.error(`[skip] ${distDir}: no index.html`)
    return
  }
  let html = fs.readFileSync(indexPath, 'utf8')

  const assetsDir = path.join(distDir, 'assets')
  if (!fs.existsSync(assetsDir)) {
    console.error(`[skip] ${distDir}: no assets/`)
    return
  }

  // 1) 内联所有 <link rel="stylesheet" href="..."> → <style>...</style>（与外链模式共用实现）
  const cssInlined = inlineCssInto(html, distDir)
  html = cssInlined.html
  const cssCount = cssInlined.cssCount

  // 2) 内联所有 <script type="module" src="..." crossorigin>...</script> → <script>...</script>
  //    同时去掉 module/crossorigin 属性，避开 rawfile + CORS 双重坑
  //    收集内联脚本，最后统一移到 </body> 前 —— 原 module 脚本是 deferred（等 DOM 解析完才执行），
  //    内联成普通同步脚本后若留在 <head> 会在 <div id="root"> 存在前执行 → React error #299
  let jsCount = 0
  const inlineScripts = []
  html = html.replace(
    /<script\s+([^>]*?)src=["']([^"']+\.js)["']([^>]*)><\/script>/g,
    (_, preAttrs, src) => {
      const file = path.join(distDir, src.replace(/^\.?\/+/, ''))
      if (!fs.existsSync(file)) return ''
      let js = fs.readFileSync(file, 'utf8')
      // 替换 import.meta.url 引用（Vite 用它解析子资源 URL；非模块上下文 import.meta 未定义）
      js = js.replace(
        /new\s+URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)\.href/g,
        (_, f) => '"./assets/' + f + '"'
      )
      // import.meta 兜底修复（经典脚本里 import.meta 是【解析期】语法错误，try/catch 救不了）：
      // a) 残留 import.meta.url → document.baseURI（如 sheets 的动态 import 基准、pdf 的 createRequire）
      // b) 动态 import("./x.js") → import("./assets/x.js")：chunk 在 assets/ 下，内联后模块
      //    基准从 assets/index.js 变成 index.html 所在目录，相对 specifier 必须重写
      //    （动态 import() 在经典脚本中合法，chunk 仍以 ES module 身份加载）
      js = js.replace(/import\.meta\.url/g, 'document.baseURI')
      js = js.replace(/import\((["'])\.\/(?!assets\/)/g, (m, q) => `import(${q}./assets/`)
      // 动态 import 中转：rawfile 通道对 module/crossorigin 请求缺 CORS 头与 JS MIME，
      // import("./assets/x.js") 恒 "Failed to fetch dynamically imported module"。
      // 改写为 __goImport("./assets/x.js")（documentStart 注入）：fetch/XHR 同源拿源码
      // （无 JS MIME 检查）→ data: URL 按 module import。CSP 侧同步放开 data: blob:。
      js = js.replace(
        /(?<![A-Za-z0-9_$])import\(\s*(?:\/\*[^*]*\*\/\s*)?(["'])(\.\/[^"']+)\1\)/g,
        (m, q, spec) => `__goImport(${q}${spec}${q})`
      )
      // 运行时变量形态的动态 import（pdf.js worker、sheets 语言包…把路径编译进变量，
      // bundle 内是 import(VAR)）：静态字面量改写覆盖不到 → __goImportDynamic(VAR)
      // 按文档基准解析成 resource:// 相对路径后走同一中转。
      js = js.replace(
        /(?<![A-Za-z0-9_$])import\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\)/g,
        (m, v) => `__goImportDynamic(${v})`
      )
      // 属性链形态（pdf.js: import(this.workerSrc)）与引号包裹的 ${} 模板形态
      // （vite/webpack 动态 chunk: import("./assets/"+id+".js") 编译产物）一样抓不住
      // —— 统一转发 __goImportDynamic，运行时解析后走 fetch/data: 中转。
      js = js.replace(
        /(?<![A-Za-z0-9_$])import\(\s*([A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+)\s*\)/g,
        (m, expr) => `__goImportDynamic(${expr})`
      )
      js = js.replace(
        /import\(\s*(['"`])\$\{([^}]+)\}\1\s*\)/g,
        (m, q, expr) => `__goImportDynamic(${expr})`
      )
      // Vite ESM 输出末尾的 `export{xxx as y};` —— 经典脚本里 export 是解析期语法错误。
      // 但语言包 chunk（assets/zh-CN-*.js 等）顶层 `import{m as t}from"./index-*.js"`
      // 依赖主 chunk 的命名导出：内联执行后没有模块命名空间，blob 化语言包里的相对
      // import 又无法解析（blob: 无 hierarchical base）。所以不剥离，改为把导出绑定
      // 挂到 window.__goChunkReexports[basename]，运行时改写语言包 import 为经它取值。
      js = js.replace(
        /\bexport\s*\{([^}]*)\}\s*;?/g,
        (m0, list) => {
          const pairs = list.split(',').map((s) => s.trim()).filter(Boolean)
            .map((spec) => {
              const mm = spec.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/) || spec.match(/^([A-Za-z_$][\w$]*)$/)
              if (!mm) return null
              const local = mm[1]
              const as = mm[2] || mm[1]
              return `"${as}":${local}`
            }).filter(Boolean).join(',')
          const key = path.basename(src.replace(/^\.[/\\]/, ''))
          return `(window.__goChunkReexports=window.__goChunkReexports||{})[${JSON.stringify(key)}]={${pairs}};`
        }
      )
      if (/window\.__goChunkReexports/.test(js) === false && /\bexport\s*\{/.test(js)) {
        console.warn(`[warn] ${src}: 内联后仍有 export{ 残留`)
      }
      if (/import\.meta/.test(js)) {
        console.warn(`[warn] ${src}: 内联后仍有 import.meta 残留（字符串字面量则无害）`)
      }
      if (/\bexport\s*\{/.test(js)) {
        console.warn(`[warn] ${src}: 内联后仍有 export{ 残留`)
      }
      jsCount++
      inlineScripts.push(js)
      return '' // 从原位置移除
    }
  )

  // 3) 把内联脚本插到 </body> 前（等价于原 module 脚本的 deferred 执行时机）
  //    ⚠️ 必须用函数形式 replacer：字符串 replacement 中 $&、$`、$' 是特殊替换模式，
  //    bundle 里大量 $ 序列会被展开改写 → SyntaxError: Unexpected identifier '$'
  if (inlineScripts.length > 0) {
    const scriptsTag = inlineScripts.map(js => `<script>${js}</script>`).join('\n')
    if (/<\/body>/i.test(html)) {
      html = html.replace(/<\/body>/i, () => `${scriptsTag}\n</body>`)
    } else {
      html += `\n${scriptsTag}`
    }
  }

  // 4) CSP：script-src 增加 'unsafe-inline'（允许内联脚本）+ data: blob:（__goImport 的 data URL 模块）
  html = html.replace(
    /content="([^"]*)"/,
    (m, csp) => {
      const fixed = csp.replace(
        /script-src\s+([^;]+)/,
        (mm, srcs) => {
          let out = /unsafe-inline/.test(srcs) ? srcs : `${srcs} 'unsafe-inline'`
          if (!/(^|\s)data:/.test(out)) out += ' data:'
          if (!/(^|\s)blob:/.test(out)) out += ' blob:'
          return `script-src ${out}`
        }
      )
      if (fixed === csp) return m
      return `content="${fixed}"`
    }
  )

  // 5) 动态 chunk 注册表：ArkWeb 的 fetch/XHR 对 resource:// scheme 一律拒绝
  //    （CORS 只放行 arkweb/chrome/data/http/https…），__goImport 无法经网络取
  //    源码。这里把 assets/ 下所有 .js/.mjs 源码以 base64 内联进页面，运行时
  //    __goImport 按文件名找到后直接 import(blob:)——data:/blob: 都在允许列表。
  //    文件名带 vite hash，全局唯一，天然适合做 key。
  //
  //    构建期改写（替代运行时正则，消除模板转义/引擎差异导致的脆弱性）：
  //    语言包 chunk 形如 `import{m as t}from"./index-C3ewLAtJ.js";const e={...}...`
  //    —— blob: 模块内相对 import 无 base 无法解析；且主 chunk 内联执行时其导出已
  //    挂到 window.__goChunkReexports（见步骤 2 的 export{} 改写）。这里把顶层静态
  //    import 改写为 `const t=(window.__goChunkReexports||{})["index-xxx.js"]["m"];`。
  //    被加载 chunk 的主 chunk 名需已知 —— 从文件自身 import spec 提取即可。
  //
  //    另有 pdf.js 的纯 JS 解码器（pdfjs/wasm/*_nowasm_fallback.js）必须一起注册：
  //    pdf.worker 里 WasmImage.#getJsModule 只有一条 `import(`${wasmUrl}${file}`)`，
  //    而 ArkWeb 下 resource:// 的原文 import/fetch/XHR 全被拦（页面 origin 是 null）
  //    → 扫描件（JBIG2 / CCITT G4 传真、JPEG2000）拿不到解码器，只剩空白页。这两支
  //    是自包含的 wasm2js 产物（不依赖 wasm、无相对 import、default 导出工厂函数），
  //    blob: 通道可直接用。
  const chunkFiles = []
  try {
    for (const name of fs.readdirSync(assetsDir)) {
      if (!/\.(mjs|js)$/i.test(name)) continue
      const p = path.join(assetsDir, name)
      if (!fs.statSync(p).isFile()) continue
      chunkFiles.push({ name, file: p })
    }
  } catch (e) { /* assets 目录不可读时跳过注册表 */ }
  try {
    const wasmDir = path.join(distDir, 'pdfjs', 'wasm')
    for (const name of fs.readdirSync(wasmDir)) {
      if (!/_nowasm_fallback\.js$/i.test(name)) continue
      chunkFiles.push({ name, file: path.join(wasmDir, name) })
    }
  } catch (e) { /* 无 pdfjs/wasm 的 app（其他 renderer）跳过 */ }

  const chunkEntries = []
  for (const { name, file } of chunkFiles) {
    let code = fs.readFileSync(file, 'utf8')
    // 模板形态的动态 import：pdf.worker 的 WasmImage.#getJsModule 写作
    //   import(/*webpackIgnore: true*/ /*@vite-ignore*/ `${wasmUrl}${file}`)
    // 既不是字面量也不是单变量/属性链，前面几条规则都抓不到（注释块 + 双插值模板）。
    // 参数整体就是一个模板字面量时原样保留、只换成 __goImportDynamic —— 求值语义不变。
    code = code.replace(
      /(?<![A-Za-z0-9_$])import\(\s*((?:\/\*[^*]*\*\/\s*)*)(`[^`]+`)\s*\)/g,
      (m, comments, tpl) => `__goImportDynamic(${comments}${tpl})`
    )
    // 顶层静态 import{...}from"./xxx.js" → 经 reexports 取值（自包含 chunk 不匹配）
    const impRe = /^import\{([^}]*)\}from\s*"\.\/(index-[^"]+\.js)"\s*;([\s\S]*)$/
    const impM = code.match(impRe)
    if (impM) {
      const parts = impM[1].split(',').map((b) => b.trim()).filter(Boolean).map((b) => {
        const mm = b.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/)
        if (!mm) return null
        const from = mm[1]
        const to = mm[2] || mm[1]
        return `const ${to}=(window.__goChunkReexports||{})["${impM[2]}"]["${from}"];`
      })
      if (!parts.includes(null)) {
        code = parts.join(' ') + impM[3]
      }
    }
    chunkEntries.push(`"${name}":"${Buffer.from(code, 'utf8').toString('base64')}"`)
  }
  if (chunkEntries.length > 0) {
    const table = `<script>window.__goChunks={${chunkEntries.join(',')}};</script>`
    if (/<head>/i.test(html)) {
      html = html.replace(/<head>/i, () => `<head>\n${table}`)
    } else {
      html = `${table}\n${html}`
    }
    console.log(`[chunks] ${distDir}: ${chunkEntries.length} 个动态 chunk 已内联注册表`)
  }

  fs.writeFileSync(indexPath, html, 'utf8')
  console.log(`[ok] ${distDir}: inlined ${jsCount} JS + ${cssCount} CSS → ${html.length} bytes`)
}

const argv = process.argv.slice(2)
const external = argv.includes('--external')
const appIdx = argv.indexOf('--app')
const cliApp = appIdx >= 0 ? String(argv[appIdx + 1] || '') : ''
const dirs = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--app')
if (dirs.length === 0) {
  console.error('usage: node inline-renderer.mjs <dist_dir> [...] [--external] [--app <name>]')
  process.exit(1)
}
for (const d of dirs) {
  const abs = path.resolve(d)
  if (external) externalDir(abs, cliApp || deriveApp(abs))
  else inlineDir(abs)
}