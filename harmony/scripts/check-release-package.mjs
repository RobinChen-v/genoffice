#!/usr/bin/env node
// 上架前自检：检查**已构建产物** .app 是否满足 AGC 发布要求。
// 不进门禁四连（依赖 build/ 产物，CI 上没有），是上传 AGC 前的手动一步：
//   node scripts/check-release-package.mjs [path/to/x.app]   # 省略则取 build/outputs/default 下最新的
//   node scripts/check-release-package.mjs --profile [x.p7b] # 只核发布 Profile（默认 key_csr/GenOfficeRelease.p7b）
//
// 检查项：
//   1. 容器签名块是**发布**签名（`"type":"release"`，且不含 development-certificate）
//   2. hap 内 `module.json` 无调试信息（`app.debug` 不为 true、`app.buildMode` 为 release）
//   3. `bundleName` / `versionCode` / `versionName` 与 AppScope/app.json5 一致
//   4. 受限 ACL 权限在软件包内声明了、但发布 Profile 的 `allowed-acls` 没授权（AGC 另一条提示）
//
// 背景（2026-09-23 事故）：AGC 上传报
//   “当前软件包存在有调试信息，不允许上架发布（请删除软件包中 module.json 文件中包含 debug:true 字段后重新上传）”
// 成因不是签名 —— 签名是 release（AGC 的签名校验过了），而是**构建模式仍是 debug**：
// hvigor 在 debug 模式下会把 `"debug":true` / `"buildMode":"debug"` 写进 hap 内的 module.json。
// 该字段由构建模式派生，不能手改产物 → 必须用 `-p buildMode=release`（或 DevEco 的 Build Mode = release）重打。
// AGC「规范性」报告里的对应条目：问题点「应用包体中存在调试信息」、检测详情「App is debuggable」
// （中度，《审核指南》3.5）。另一条「ACL权限声明一致性」= 本脚本第 ④ 项。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

// 受限 ACL 权限（system_basic 受限清单内、且本工程实际声明的两项）；新增受限权限要同步这里
const ACL_PERMISSIONS = new Set([
  'ohos.permission.READ_PASTEBOARD',     // 桥侧读系统剪贴板（粘贴图片/富文本）
  'ohos.permission.FILE_ACCESS_PERSIST', // 最近打开文件的 URI 授权持久化
])
// 普通权限（不需要 Profile 授权，AGC 不会标）
const NORMAL_PERMISSIONS = new Set([
  'ohos.permission.INTERNET',
  'ohos.permission.GET_NETWORK_INFO',
  'ohos.permission.PRINT',
  'ohos.permission.KEEP_BACKGROUND_RUNNING',
])

// ---------- 极简 zip 读取（只够取小文件：module.json / pack.info） ----------
function findEocd(buf) {
  const floor = Math.max(0, buf.length - 66000)
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i
  }
  return -1
}
function openZip(buf) {
  const eocd = findEocd(buf)
  if (eocd < 0) throw new Error('不是 zip 结构（未找到 EOCD）')
  let count = buf.readUInt16LE(eocd + 10)
  let cdOff = buf.readUInt32LE(eocd + 16)
  if (cdOff === 0xffffffff || count === 0xffff) { // ZIP64 兜底
    for (let i = eocd - 20; i >= Math.max(0, eocd - 256); i--) {
      if (buf.readUInt32LE(i) === 0x07064b50) {
        const z64 = Number(buf.readBigUInt64LE(i + 8))
        count = Number(buf.readBigUInt64LE(z64 + 32))
        cdOff = Number(buf.readBigUInt64LE(z64 + 48))
        break
      }
    }
  }
  const entries = new Map()
  let p = cdOff
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break
    const method = buf.readUInt16LE(p + 10)
    let csize = buf.readUInt32LE(p + 20)
    let usize = buf.readUInt32LE(p + 24)
    const nlen = buf.readUInt16LE(p + 28)
    const elen = buf.readUInt16LE(p + 30)
    const clen = buf.readUInt16LE(p + 32)
    let lho = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nlen)
    if (csize === 0xffffffff || usize === 0xffffffff || lho === 0xffffffff) {
      let e = p + 46 + nlen
      const eEnd = e + elen
      while (e < eEnd) {
        const id = buf.readUInt16LE(e)
        const sz = buf.readUInt16LE(e + 2)
        if (id === 0x0001) {
          let q = e + 4
          if (usize === 0xffffffff) { usize = Number(buf.readBigUInt64LE(q)); q += 8 }
          if (csize === 0xffffffff) { csize = Number(buf.readBigUInt64LE(q)); q += 8 }
          if (lho === 0xffffffff) { lho = Number(buf.readBigUInt64LE(q)); q += 8 }
          break
        }
        e += 4 + sz
      }
    }
    entries.set(name, { method, csize, lho })
    p += 46 + nlen + elen + clen
  }
  return { buf, entries }
}
function readEntry(zip, name) {
  const e = zip.entries.get(name)
  if (!e) return null
  if (zip.buf.readUInt32LE(e.lho) !== 0x04034b50) throw new Error('local header 异常：' + name)
  const nlen = zip.buf.readUInt16LE(e.lho + 26)
  const elen = zip.buf.readUInt16LE(e.lho + 28)
  const start = e.lho + 30 + nlen + elen
  const data = zip.buf.subarray(start, start + e.csize)
  return e.method === 0 ? data : inflateRawSync(data)
}

// ---------- 源码侧基准值 ----------
function srcAppJson() {
  const raw = readFileSync(join(root, 'AppScope', 'app.json5'), 'utf8')
  const clean = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  return JSON.parse(clean).app
}

// 源码侧声明的权限：--profile 模式靠它判定"需要哪些 ACL"，不必先打包
function declaredPermissions() {
  const raw = readFileSync(join(root, 'entry', 'src', 'main', 'module.json5'), 'utf8')
  const out = []
  const re = /"(ohos\.permission\.[A-Z_]+)"/g
  let m
  while ((m = re.exec(raw))) if (!out.includes(m[1])) out.push(m[1])
  return out
}

function newestApp() {
  const dir = join(root, 'build', 'outputs', 'default')
  const cands = readdirSync(dir).filter((f) => f.endsWith('-signed.app'))
  if (!cands.length) throw new Error('build/outputs/default 下没有 *-signed.app（先打 release 包）')
  return cands
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
}

// Profile 体检：既用于产物签名块里的内嵌 Profile，也用于 --profile 直接核 key_csr/*.p7b
function profileChecks(text, srcApp, opts) {
  const out = []
  const add = (pass, name, detail) => out.push({ pass, name, detail })
  if (opts && opts.withType) {
    const mt = /"type"\s*:\s*"(debug|release)"/.exec(text)
    const dev = /development-certificate/.test(text)
    add(!!mt && mt[1] === 'release' && !dev, 'Profile 为发布类型',
      (mt ? 'type=' + mt[1] : '未识别 type') + (dev ? ' + 含 development-certificate（调试卷）' : ''))
  }
  const mb = /"bundle-name"\s*:\s*"([^"]+)"/.exec(text)
  add(!!mb && mb[1] === srcApp.bundleName, 'Profile bundle-name 与 app.json5 一致',
    mb ? mb[1] + (mb[1] === srcApp.bundleName ? '' : ' ≠ ' + srcApp.bundleName) : '未找到 bundle-name')
  const mv = /"validity"\s*:\s*\{[^}]*"not-after"\s*:\s*(\d+)/.exec(text)
  const now = Math.floor(Date.now() / 1000)
  add(!!mv && Number(mv[1]) > now, 'Profile 在有效期内', mv
    ? 'not-after=' + new Date(Number(mv[1]) * 1000).toISOString().slice(0, 10)
      + (Number(mv[1]) > now ? '' : '（已过期）')
    : '未找到 validity.not-after')
  const declared = (opts && opts.declared) || []
  const mAcl = /"acls"\s*:\s*\{\s*"allowed-acls"\s*:\s*\[([^\]]*)\]/.exec(text)
  if (!mAcl) {
    add(false, '受限 ACL 权限已在发布 Profile 中授权', 'Profile 里没有 acls.allowed-acls 字段（无法判定）')
  } else {
    const granted = mAcl[1].split(',').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean)
    const need = declared.filter((p) => ACL_PERMISSIONS.has(p))
    const missing = need.filter((p) => !granted.includes(p))
    add(missing.length === 0, '受限 ACL 权限已在发布 Profile 中授权', missing.length
      ? missing.join(' / ') + ' 软件包内已声明、Profile allowed-acls=' + JSON.stringify(granted)
        + ' → AGC「ACL权限声明一致性」标红，装机可能报 grant request permissions failed(9568289)。'
        + 'AGC 重发 Profile 时勾选这两项（申请理由文案见 BETA-RELEASE-NOTES.md §3 第 5 条）'
      : (need.length ? need.join(' / ') + ' 已在 allowed-acls' : '未声明受限权限（无需 Profile 授权）'))
    const unknown = declared.filter((p) => !ACL_PERMISSIONS.has(p) && !NORMAL_PERMISSIONS.has(p))
    if (unknown.length) {
      add(null, '在册权限清单需扩充', unknown.join(' / ')
        + ' 不在脚本的受限/普通权限清单里，请人工确认是否属受限 ACL（是则加进 ACL_PERMISSIONS）')
    }
  }
  return out
}

function printResults(title, rows) {
  console.log(title)
  let fail = 0
  for (const r of rows) {
    const tag = r.pass === true ? '[OK]   ' : r.pass === false ? '[FAIL] ' : '[WARN] '
    console.log(tag + r.name + '：' + r.detail)
    if (r.pass === false) fail++
  }
  console.log(fail ? '\n结论：' + fail + ' 项不通过 → 不要上传 AGC' : '\n结论：可以上传 AGC')
  process.exit(fail ? 1 : 0)
}

// ---------- 主流程 ----------
const src = srcAppJson()
const argv = process.argv

// 只核发布 Profile（AGC 重发 .p7b 后的第一步）：node scripts/check-release-package.mjs --profile [x.p7b]
const pIdx = argv.indexOf('--profile')
if (pIdx >= 0) {
  const next = argv[pIdx + 1]
  const pfile = next && !next.startsWith('-') ? resolve(next) : join(root, 'key_csr', 'GenOfficeRelease.p7b')
  printResults('Profile 体检：' + pfile,
    profileChecks(readFileSync(pfile).toString('latin1'), src,
      { withType: true, declared: declaredPermissions() }))
}

const target = argv[2] && !argv[2].startsWith('-') ? resolve(argv[2]) : newestApp()
const results = []
const ok = (name, detail) => results.push({ pass: true, name, detail })
const bad = (name, detail) => results.push({ pass: false, name, detail })

const buf = readFileSync(target)

// 1) 签名块（在 zip 数据之后，取尾部 64KB 扫即可）
const tail = buf.subarray(Math.max(0, buf.length - 65536)).toString('latin1')
const mType = /"type"\s*:\s*"(debug|release)"/.exec(tail)
const hasDevCert = /development-certificate/.test(tail)
const hasDistCert = /distribution-certificate/.test(tail)
if (mType && mType[1] === 'release' && !hasDevCert) {
  ok('容器签名为发布签名', 'type=release' + (hasDistCert ? ' + distribution-certificate' : ''))
} else {
  bad('容器签名为发布签名', 'type=' + (mType ? mType[1] : '未识别')
    + (hasDevCert ? ' + 含 development-certificate（DevEco 调试签名）' : '')
    + ' → 换 release 签名材料重打')
}

// 2) hap 内 module.json 的调试信息（AGC 拒收点）
const appZip = openZip(buf)
const hapName = [...appZip.entries.keys()].find((n) => n.endsWith('.hap'))
if (!hapName) {
  bad('hap 内 module.json 无调试信息', '容器内没找到 .hap')
} else {
  const hapZip = openZip(readEntry(appZip, hapName))
  const mjRaw = readEntry(hapZip, 'module.json')
  if (!mjRaw) {
    bad('hap 内 module.json 无调试信息', hapName + ' 内没找到 module.json')
  } else {
    const mj = JSON.parse(mjRaw.toString('utf8'))
    const a = mj.app || {}
    const dirty = []
    if (a.debug === true) dirty.push('debug:true')
    if (String(a.buildMode || '').toLowerCase() === 'debug') dirty.push('buildMode:"debug"')
    if (dirty.length) {
      bad('hap 内 module.json 无调试信息', '发现 ' + dirty.join(' + ')
        + ' → AGC 会拒收（用 -p buildMode=release 重打，字段由构建模式派生、不能手改产物）')
    } else {
      ok('hap 内 module.json 无调试信息', appZip.entries.size + ' 个容器条目；buildMode='
        + (a.buildMode || '未写') + '，debug=' + String(a.debug))
    }

    // 3) 包名 / 版本对齐源码
    const diffs = []
    if (a.bundleName !== src.bundleName) diffs.push('bundleName ' + a.bundleName + ' ≠ ' + src.bundleName)
    if (a.versionCode !== src.versionCode) diffs.push('versionCode ' + a.versionCode + ' ≠ ' + src.versionCode)
    if (a.versionName !== src.versionName) diffs.push('versionName ' + a.versionName + ' ≠ ' + src.versionName)
    if (diffs.length) bad('包名/版本与 AppScope/app.json5 一致', diffs.join('; '))
    else ok('包名/版本与 AppScope/app.json5 一致', a.bundleName + ' / ' + a.versionCode + ' / ' + a.versionName)

    // 4) 内嵌 Profile：bundle-name / 有效期 / 受限 ACL（复现 AGC「ACL权限声明一致性」提示）
    const declared = (mj.module && Array.isArray(mj.module.requestPermissions))
      ? mj.module.requestPermissions.map((p) => p.name).filter(Boolean) : []
    for (const r of profileChecks(tail, src, { declared })) results.push(r)
  }
}

printResults('检查对象：' + target + '\n（大小 ' + (buf.length / 1048576).toFixed(1) + ' MB）', results)