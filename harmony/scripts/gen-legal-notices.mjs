#!/usr/bin/env node
/**
 * 生成鸿蒙发布包的许可合规材料 → entry/src/main/resources/rawfile/web/legal/
 *
 * 为什么不用上游的 tools/gen-third-party-notices.mjs：它 require apps/shell/electron-builder.cjs
 * 去拿 extraResources，而那份配置要求本机装了 Electron（node_modules/electron/dist/
 * LICENSES.chromium.html）—— 鸿蒙移植工程不装 Electron，跑起来直接抛错。
 * 这里沿用同一条思路（「清单来自源码实际 import，再沿依赖图闭包」），但只看 workspace 源码树：
 *   1) 扫 apps 与 packages 各自的 src 目录里的裸模块说明符（from / import / require 的字面量）
 *   2) 解析成包名（含 @scope/name，砍掉子路径），沿各包 package.json 的 dependencies 求闭包
 *   3) 每个包输出 name / version / SPDX license / LICENSE 里找到的版权行
 * 取舍：**宁可多列不可漏列** —— 多列不违反任何许可，漏列会违反 Apache-2.0 第 4(d) 条与 MIT 的署名要求。
 *
 * 用法：cd harmony && node scripts/gen-legal-notices.mjs
 * 退出码非 0 = 材料没生成齐（门禁 checkLegalNotices 也会红）。
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync, copyFileSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const HARMONY = dirname(HERE)
const ROOT = dirname(HARMONY)
const LEGAL_DIR = join(HARMONY, 'entry/src/main/resources/rawfile/web/legal')

/** 源码扫描范围：真正会被打进 rawfile 的那些树（配置/脚本/测试里引的是构建工具链，不分发）*/
const SRC_ROOTS = []
for (const sub of ['apps', 'packages']) {
  const dir = join(ROOT, sub)
  if (!existsSync(dir)) { continue }
  for (const name of readdirSync(dir)) {
    const src = join(dir, name, 'src')
    if (existsSync(src) && statSync(src).isDirectory()) { SRC_ROOTS.push(src) }
  }
}

const BUILTIN = new Set([
  'fs', 'path', 'os', 'url', 'util', 'http', 'https', 'crypto', 'stream', 'buffer', 'events',
  'child_process', 'worker_threads', 'module', 'assert', 'zlib', 'net', 'dns', 'tty', 'v8',
  'node:fs', 'node:path', 'node:os', 'node:url', 'node:util', 'node:http', 'node:https',
  'node:crypto', 'node:stream', 'node:buffer', 'node:events', 'node:worker_threads',
  'node:module', 'node:assert', 'node:zlib', 'node:net', 'node:test',
])

const IMPORT_RE = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"]([^'"]+)['"]/g

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build') { continue }
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(p, out)
    } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name) && !/\.test\.[jt]sx?$/.test(entry.name)) {
      out.push(p)
    }
  }
  return out
}

/** 裸说明符 → 包名（'@scope/pkg/sub' 取 '@scope/pkg'；'lodash/debounce' 取 'lodash'）*/
function pkgOf(spec) {
  if (!spec || spec.startsWith('.') || spec.startsWith('/') || BUILTIN.has(spec)) { return null }
  if (spec.startsWith('@')) {
    const parts = spec.split('/')
    return parts.length >= 2 ? parts[0] + '/' + parts[1] : null
  }
  return spec.split('/')[0]
}

const files = []
for (const src of SRC_ROOTS) { walk(src, files) }

const direct = new Set()
for (const f of files) {
  let text = ''
  try { text = readFileSync(f, 'utf8') } catch (e) { continue }
  let m
  IMPORT_RE.lastIndex = 0
  while ((m = IMPORT_RE.exec(text)) !== null) {
    const pkg = pkgOf(m[1])
    if (pkg && !pkg.startsWith('@genoffice/')) { direct.add(pkg) }
  }
}

/** workspace 包：本仓库自己的组件，随源码一起是 Apache-2.0，不算第三方 */
function workspaceNames() {
  const set = new Set()
  for (const sub of ['apps', 'packages']) {
    const dir = join(ROOT, sub)
    if (!existsSync(dir)) { continue }
    for (const name of readdirSync(dir)) {
      const pj = join(dir, name, 'package.json')
      if (!existsSync(pj)) { continue }
      try {
        const j = JSON.parse(readFileSync(pj, 'utf8'))
        if (j.name) { set.add(j.name) }
      } catch (e) { /* 坏 package.json 跳过 */ }
    }
  }
  return set
}
const WORKSPACE = workspaceNames()

const LICENSE_FILES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md']

function licenseSpdx(meta) {
  if (typeof meta.license === 'string' && meta.license.length > 0) { return meta.license }
  if (meta.license && typeof meta.license === 'object' && meta.license.type) { return String(meta.license.type) }
  if (Array.isArray(meta.licenses)) {
    return meta.licenses.map((l) => (typeof l === 'string' ? l : l.type)).filter(Boolean).join(' OR ')
  }
  for (const f of LICENSE_FILES) {
    const p = join(meta.__dir, f)
    if (!existsSync(p)) { continue }
    const head = readFileSync(p, 'utf8').slice(0, 400)
    if (/^MIT License|^MIT$/i.test(head)) { return 'MIT' }
    if (/Apache License/i.test(head)) { return 'Apache-2.0' }
    if (/BSD 3-Clause|BSD-3-Clause/i.test(head)) { return 'BSD-3-Clause' }
    if (/ISC License|^ISC$/im.test(head)) { return 'ISC' }
    if (/GNU GENERAL PUBLIC/i.test(head)) { return 'GPL(需人工确认范围)' }
    return 'SEE LICENSE FILE'
  }
  return 'UNKNOWN'
}

function copyrightLines(meta) {
  const out = []
  const names = LICENSE_FILES.concat(['NOTICE', 'NOTICE.txt'])
  for (const f of names) {
    const p = join(meta.__dir, f)
    if (!existsSync(p)) { continue }
    const lines = readFileSync(p, 'utf8').split('\n')
    for (const l of lines) {
      if (/copyright/i.test(l) && l.trim().length > 12 && l.length < 160) {
        out.push(l.trim())
        if (out.length >= 2) { return out }
      }
    }
  }
  return out
}

const seen = new Map()
const queue = []
for (const name of direct) { queue.push({ name, why: 'direct' }) }
while (queue.length > 0) {
  const item = queue.shift()
  if (seen.has(item.name) || WORKSPACE.has(item.name)) { continue }
  const dir = join(ROOT, 'node_modules', ...item.name.split('/'))
  if (!existsSync(dir)) { continue }
  const pj = join(dir, 'package.json')
  if (!existsSync(pj)) { continue }
  let meta = null
  try { meta = JSON.parse(readFileSync(pj, 'utf8')) } catch (e) { continue }
  meta.__dir = dir
  seen.set(item.name, {
    name: item.name,
    version: meta.version || '',
    spdx: licenseSpdx(meta),
    copyrights: copyrightLines(meta),
  })
  for (const dep of Object.keys(meta.dependencies || {})) {
    if (!seen.has(dep) && !WORKSPACE.has(dep)) { queue.push({ name: dep, why: 'transitive' }) }
  }
}

const rows = [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
if (rows.length === 0) {
  console.error('[legal] 一个第三方包都没解析出来 —— node_modules 未安装？拒绝生成空清单')
  process.exit(1)
}

const header = [
  'GenOffice 鸿蒙版 —— 许可与第三方组件声明',
  '='.repeat(60),
  '',
  '一、本应用与本仓库源码',
  '',
  '本应用是基于 GenOffice（Copyright 2026 Mainfunc, Inc.）的鸿蒙 PC 移植版，源码按',
  'Apache License 2.0 授权；完整条款见同目录 LICENSE.txt，上游的 NOTICE 声明见 NOTICE.txt，',
  '衍生作品的修改范围见 CHANGELOG-NOTICE.txt。',
  '',
  '需要特别说明：Apache-2.0 不授予任何商标使用权。GenOffice 与 Genspark 均为',
  'Mainfunc, Inc. 的商标；本应用与 Mainfunc, Inc. / Genspark 无关联、无授权、不背书。',
  '',
  '本移植版已移除 Genspark 账号登录与其 LLM 代理通道（该通道按 Genspark 侧记在',
  '「GenOffice」账上的身份计费，不属于衍生作品可使用的范围）；AI 能力完全由用户',
  '自备的 API Key 直连各模型厂商。',
  '',
  '二、随包分发的其它材料',
  '',
  '- Unicode Character Database 数据（Unicode License v3）：见 LICENSE-UNICODE.txt',
  '- pdf.js 的 cmap / 标准字体 / wasm 解码器许可：随各目录原样保留',
  '  （web/pdf/pdfjs/cmaps/LICENSE、web/pdf/pdfjs/standard_fonts/LICENSE_*、',
  '   web/pdf/pdfjs/wasm/LICENSE_*）',
  '- 打包字体（Carlito / Liberation 等，SIL OFL）：见上游 NOTICE 指向的字体说明',
  '- WebView（ArkWeb / Chromium 内核）由 HarmonyOS 系统提供，不随本包分发',
  '',
  '三、网络与数据',
  '',
  '本应用是离线文档编辑器：打开、编辑、保存文档都在本机完成，不上传文档内容。',
  '只有两类动作会出网，且都需要用户主动配置或主动触发：',
  '  1) AI 对话 / 补全：用户在 设置 - AI 模型 自行填写厂商 API Key 后，对话上下文',
  '     （含被选中的文档片段）会发送给用户所选模型的服务端；未配置则完全不出网。',
  '  2) 联网搜索 / 图片搜索：用户在 设置 - AI 媒体与搜索 填写 Serper 或 Tavily 的',
  '     API Key 后，搜索词会发送给该服务；未配置则功能给出明确提示，不静默出网。',
  'API Key 只保存在本机应用存储中，不上传到任何第三方。',
  '',
  '四、第三方 npm 组件清单（共 ' + rows.length + ' 项，按包名排序）',
  '',
  '清单由 harmony/scripts/gen-legal-notices.mjs 从源码 import 图推导后沿依赖闭包生成；',
  '按「宁可多列不可漏列」的原则，可能包含实际未进入产物的条目。',
  '',
  '-'.repeat(60),
  '',
].join('\n')

const body = rows.map((r) => {
  const lines = [r.name + '@' + r.version + '  -  ' + r.spdx]
  for (const c of r.copyrights) { lines.push('    ' + c) }
  return lines.join('\n')
}).join('\n')

mkdirSync(LEGAL_DIR, { recursive: true })
writeFileSync(join(LEGAL_DIR, 'THIRD-PARTY-NOTICES.txt'), header + body + '\n', 'utf8')

// 上游要求的三份文本 + 本衍生作品的修改声明，全部随包（Apache-2.0 第 4 条）
const copies = [
  ['LICENSE', 'LICENSE.txt'],
  ['NOTICE', 'NOTICE.txt'],
  ['LICENSE-UNICODE.txt', 'LICENSE-UNICODE.txt'],
]
for (const [from, to] of copies) {
  const src = join(ROOT, from)
  if (!existsSync(src)) {
    console.error('[legal] 缺少 ' + from + ' —— 不能生成不完整的许可包')
    process.exit(1)
  }
  copyFileSync(src, join(LEGAL_DIR, to))
}

const changelog = [
  '衍生作品修改声明（Apache-2.0 第 4(b) 条：需说明对原始版本做了哪些修改）',
  '='.repeat(60),
  '',
  '本鸿蒙 PC 移植版在上游 GenOffice 源码基础上的修改类别（逐批次详细记录见仓库内',
  'harmony/M8-BATCH-*.md 与 harmony/M5-PDF-PORT.md）：',
  '',
  '1. 新增：HarmonyOS 壳工程（ArkUI Web 容器 + ArkTS 原生桥 DesktopBridge.ets 与',
  '   Index.ets 注入脚本），替代 Electron 主进程与 Node sidecar 的大部分职责。',
  '2. 替换：文件读写、保存框、目录授权、最近打开、剪贴板、打印等改走 HarmonyOS',
  '   原生能力（picker / fileIo 等）。',
  '3. 替换：PDF 的 wasm / cmap / 标准字体加载改道 rawfile 读取（ArkWeb 的 resource://',
  '   协议不支持 fetch wasm）。',
  '4. 移除：Genspark 账号登录（device-code）、Genspark LLM 代理与云工具、生图与',
  '   媒体分析（依赖 gsk 账号），以及起始页与设置页的「账户」分区。',
  '5. 替换：AI 通道改为壳内实现的 OpenAI 兼容 + Anthropic 双协议直连（BYO Key，',
  '   支持自定义端点与任意模型 id）；网页/图片搜索从抓取 DuckDuckGo 非官方端点',
  '   改为 Serper / Tavily 正式 API。',
  '6. 补齐：xlsx 引擎的公式重算、富文本、结构性操作、多工作表等能力。',
  '7. 平台差异：部分桌面专属能力（文件夹树、全文索引、Codex CLI、插件联动）在',
  '   鸿蒙版按「明确降级」处理（显示为空或给出原因，不静默失败）。',
  '',
].join('\n')
writeFileSync(join(LEGAL_DIR, 'CHANGELOG-NOTICE.txt'), changelog, 'utf8')

console.log('[legal] 生成 ' + rows.length + ' 个第三方条目 → ' + basename(LEGAL_DIR) + '/')
console.log('[legal] 同时复制 LICENSE.txt / NOTICE.txt / LICENSE-UNICODE.txt / CHANGELOG-NOTICE.txt')
