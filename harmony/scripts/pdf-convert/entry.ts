// pdf-convert 入口：把 packages/pdf2docx 的三种本地转换（PDF → DOCX/XLSX/PPTX）连同
// PDFium wasm 初始化打成自包含浏览器 ESM（见 harmony/scripts/build-pdf-convert.mjs），
// 供 Index.ets pdfMock 经 readRawFileJson 直读 rawfile/web/pdf-convert.mjs + data: URL
// import 懒加载（与 pdf-bridge / pptx-bridge 同一架构）。
//
// 与 pdf-bridge 的差别：pdf2docx 需要 PDFium 模块（ConvertOptions.pdfium 必填），而
// 浏览器里没有 require.resolve —— wasm 字节由壳侧从 rawfile 读入后交给 initPdfium。
//
// OCR 不进打包：ocr-vision 依赖原生 helper 二进制（鸿蒙不可用），扫描页由引擎自身降级
// 为整页图片，pageResults / scannedDocument 会如实上报（壳侧据此提示用户核对）。
import { init as pdfiumInit } from '@embedpdf/pdfium'
import { convertPdfToDocx } from '../../../packages/pdf2docx/src'
import { PdfLoadError } from '../../../packages/pdf2docx/src/extract/pdfium'
import { convertPdfToPptx } from '../../../packages/pdf2docx/src/rebuild-pptx'
import { convertPdfToXlsx } from '../../../packages/pdf2docx/src/rebuild-xlsx'

export { convertPdfToDocx, convertPdfToPptx, convertPdfToXlsx, PdfLoadError }

// ===== 浏览器缺失的两个 Node 全局（模块体先于任何转换调用执行）=====
const g = globalThis as unknown as Record<string, unknown>

// process：font-metrics 的 fontDirs() 按 process.platform 挑系统字体目录。鸿蒙 webview
// 没有这个全局，不补会在转换时抛 ReferenceError —— 补成 ohos（真平台），目录随后由
// fs shim 的 readdirSync 挡掉，字体索引保持为空（见 shims/fs.ts 的说明）。
if (!g.process) {
  g.process = { platform: 'ohos', env: {}, versions: {}, argv: [] }
}

// Buffer：PDF→PPTX 走 pptx-engine 的写包路径（archive.entries.set(path, Buffer.from(xml,
// 'utf8'))），必须与 slides 桥同构 —— 这里复用 harmony/scripts/pptx-bridge/entry.ts 里
// 已在真机验证过的最小实现（真字节数组 + toString，缺了就解析读空）。
if (!g.Buffer) {
  const textDecoder = new TextDecoder()
  type BufferLike = Uint8Array & { toString(enc?: string): string }
  function bufferBytes(value: unknown, enc?: string): Uint8Array {
    if (value instanceof Uint8Array) return value
    if (typeof value === 'string') {
      if (enc === 'base64') {
        const bin = atob(value)
        const u = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
        return u
      }
      return new TextEncoder().encode(value)
    }
    const ab = value as ArrayBuffer
    return new Uint8Array(ab && ab.byteLength ? ab : 0)
  }
  function bytesToBase64(bytes: Uint8Array): string {
    let bin = ''
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    }
    return btoa(bin)
  }
  g.Buffer = {
    from(value: unknown, enc?: string): BufferLike {
      const src = bufferBytes(value, enc)
      const out = new Uint8Array(src.byteLength) as BufferLike
      out.set(src)
      out.toString = (outEnc?: string): string =>
        outEnc === 'base64' ? bytesToBase64(out) : textDecoder.decode(out)
      return out
    },
    alloc(size: number): Uint8Array {
      return new Uint8Array(size)
    },
    concat(list: Uint8Array[]): Uint8Array {
      let total = 0
      for (const p of list) total += p.length
      const out = new Uint8Array(total)
      let at = 0
      for (const p of list) {
        out.set(p, at)
        at += p.length
      }
      return out
    },
    isBuffer(v: unknown): boolean {
      return v instanceof Uint8Array
    },
  }
}

let pdfiumModule: unknown = null

/**
 * 用 rawfile 读到的 wasm 字节初始化 PDFium（幂等：同一实例供后续多次转换复用）。
 * 对齐 packages/pdf2docx 测试助手与桌面 pdf2docx-local 的初始化序列：
 * init({ wasmBinary }) → _PDFiumExt_Init()。
 */
export async function initPdfium(wasmBytes: ArrayBuffer | Uint8Array): Promise<unknown> {
  if (pdfiumModule) {
    return pdfiumModule
  }
  // 精确切片：Uint8Array 可能来自更大的共享 buffer
  const wasmBinary =
    wasmBytes instanceof Uint8Array
      ? wasmBytes.buffer.slice(wasmBytes.byteOffset, wasmBytes.byteOffset + wasmBytes.byteLength)
      : wasmBytes
  // locateFile 必须给：本模块经 data: URL 动态 import（壳侧 pdfMock.loadPdfConvert），
  // Emscripten 的 findWasmBinary() 在 Module['locateFile'] 为空时会执行
  // new URL('pdfium.wasm', import.meta.url) —— base 为 data: URL 时直接抛
  // "Failed to construct 'URL': Invalid URL"，且该调用在实例化时无条件执行，
  // 即使已传 wasmBinary 也躲不开。给了 locateFile 就走 locateFile('pdfium.wasm')，
  // 返回普通字符串；随后 getBinarySync 命中 file == wasmBinaryFile && wasmBinary，
  // 直接返回内存字节，不会发起任何 fetch（rawfile 的 resource:// 也无法 fetch）。
  const wrapped = (await pdfiumInit({
    wasmBinary,
    locateFile: (path: string) => path,
  })) as { pdfium?: unknown }
  const m = (wrapped && wrapped.pdfium ? wrapped.pdfium : wrapped) as { _PDFiumExt_Init(): void }
  m._PDFiumExt_Init()
  pdfiumModule = m
  return m
}

export function pdfiumReady(): boolean {
  return pdfiumModule !== null
}