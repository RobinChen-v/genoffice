// Harmony 专用文本插入：搬桌面 applyTextInserts 的 PDFium 主路径，但跳过字体子集化/系统
// 字体查找（font-subset/font-locate 都依赖 node:fs / harfbuzz wasm，浏览器不可用），改走
// PDFium 自带的 14 种标准字体（_FPDFText_LoadStandardFont）。能覆盖拉丁字母 + 拉丁-1 补
// 充 + 数学符号（Symbol/ZapfDingbats），CJK 不支持 —— 插入时 canDrawTextHarmony 提前拒。
//
// 与桌面 applyTextInserts 的差异：
//   * 字体选取：桌面按 renderer's font/bold/italic 提示在系统字体里挑，这里只能命中 PDFium
//     标准 14 种；其他字体名一律回退 Helvetica（视觉上一致，不是用户视觉预期）。
//   * 字体子集化：标准 14 字体本身就是 PDF 规范内置字体，不需要嵌入（Type1 / 通用 PostScript
//     命名），省去 harfbuzz 子集化路径。
//   * 颜色：保留 0-255 RGB 输入（与桌面契约一致；_FPDFPageObj_SetFillColor 接 0-255）。
//   * 旋转：textInsertAxes 同款（用 input.rotate，默认 0）。
//
// 与 pdf-convert 复用同一个 PDFium 实例：壳侧在 Index.ets 已经 init 过一个 PDFium（缓存于
// pdfiumPromise），applyTextInserts 直接吃 m（Pdfium 模块）参数。Verifier 沙箱里 initPdfium
// 是 mock 的最小函数式桩，能调通 applyTextInserts 即可，不需要真正 4.4MB wasm。

import type { TextInsertFailure, TextInsertInput } from '../../../../apps/pdf/src/shared/ipc'

/** PDFium 内置 14 种标准字体（PDF 规范强制保留；不嵌入也能渲染 —— 接收端可识别）。 */
const STANDARD_FONT_BOLD: Record<string, string> = {
  '': 'Helvetica-Bold',
  Helvetica: 'Helvetica-Bold',
  HelveticaOblique: 'Helvetica-BoldOblique',
  Times: 'Times-Bold',
  TimesItalic: 'Times-BoldItalic',
  Courier: 'Courier-Bold',
  CourierOblique: 'Courier-BoldOblique',
  Symbol: 'Symbol',
  ZapfDingbats: 'ZapfDingbats',
}
const STANDARD_FONT_ITALIC: Record<string, string> = {
  '': 'Helvetica-Oblique',
  Helvetica: 'Helvetica-Oblique',
  HelveticaBold: 'Helvetica-BoldOblique',
  Times: 'Times-Italic',
  TimesBold: 'Times-BoldItalic',
  Courier: 'Courier-Oblique',
  CourierBold: 'Courier-BoldOblique',
  Symbol: 'Symbol',
  ZapfDingbats: 'ZapfDingbats',
}
const STANDARD_FONT_BOLDITALIC: Record<string, string> = {
  '': 'Helvetica-BoldOblique',
  Helvetica: 'Helvetica-BoldOblique',
  HelveticaBold: 'Helvetica-BoldOblique',
  HelveticaOblique: 'Helvetica-BoldOblique',
  Times: 'Times-BoldItalic',
  TimesBold: 'Times-BoldItalic',
  TimesItalic: 'Times-BoldItalic',
  Courier: 'Courier-BoldOblique',
  CourierBold: 'Courier-BoldOblique',
  CourierOblique: 'Courier-BoldOblique',
  Symbol: 'Symbol',
  ZapfDingbats: 'ZapfDingbats',
}
const STANDARD_FONT_REGULAR: Record<string, string> = {
  '': 'Helvetica',
  Helvetica: 'Helvetica',
  HelveticaBold: 'Helvetica-Bold',
  HelveticaOblique: 'Helvetica-Oblique',
  HelveticaBoldOblique: 'Helvetica-BoldOblique',
  Times: 'Times-Roman',
  TimesBold: 'Times-Bold',
  TimesItalic: 'Times-Italic',
  TimesBoldItalic: 'Times-BoldItalic',
  Courier: 'Courier',
  CourierBold: 'Courier-Bold',
  CourierOblique: 'Courier-Oblique',
  CourierBoldOblique: 'Courier-BoldOblique',
  Symbol: 'Symbol',
  ZapfDingbats: 'ZapfDingbats',
}

const FAMILY_HINTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/courier/i, 'Courier'],
  [/mono|consolas|menlo/i, 'Courier'],
  [/times|georgia|serif/i, 'Times'],
  [/symbol/i, 'Symbol'],
  [/dingbat/i, 'ZapfDingbats'],
  [/arial|helvetica|sans|noto sans cjk sc|pingfang|hiragino|microsoft yahei|segoe ui|liberation sans|dejavu sans/i, 'Helvetica'],
]

function standardFontName(font: string | undefined, bold: boolean, italic: boolean): string {
  const family = (() => {
    if (!font) return ''
    for (const [re, fam] of FAMILY_HINTS) if (re.test(font)) return fam
    return ''
  })()
  if (bold && italic) return STANDARD_FONT_BOLDITALIC[family] ?? 'Helvetica-BoldOblique'
  if (bold) return STANDARD_FONT_BOLD[family] ?? 'Helvetica-Bold'
  if (italic) return STANDARD_FONT_ITALIC[family] ?? 'Helvetica-Oblique'
  return STANDARD_FONT_REGULAR[family] ?? 'Helvetica'
}

/** Harmony 端文本插入能力预检：当前只能画标准 14 字体覆盖范围（拉丁为主）。
    这与桌面 canDrawText 行为有偏差 —— 桌面是『本机有没有覆盖字体的字体文件』，Harmony 是
    『这个文本是不是能用 14 种内置字体画』。Latin-1 补充分数（¡£¥© 等）也命中。中文/日文/
    韩文/罕见符号 一定返回 false，渲染层走 `textInsertNoFont` 提示。 */
export function canDrawTextHarmony(text: string): boolean {
  if (!text) return false
  // 每个码点都必须在下列范围内：
  //   * 0x20-0x7E  ASCII 可见
  //   * 0xA0-0xFF  Latin-1 Supplement（¡¢£¤¥¦§ 等都在 PDF 标准字体字符集里）
  //   * 0x2010-0x205F 通用标点（含连接号、引号、破折号）—— Latin 排版常用
  //   * 0x2190-0x21FF 箭头（Symbol 字体覆盖）
  //   * 0x2500-0x257F 框线（Box Drawing；某些标准字体支持）
  // 注：Symbol/ZapfDingbats 覆盖更窄，这里只检测 Helvetica/Times/Courier 通用字符 + 通用标点。
  //    中文（0x4E00-0x9FFF）一律返回 false。
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!
    if (cp < 0x80) {
      // 0x20-0x7E 都行；0x00-0x1F 控制字符不行（字体可能画但语义是错的）
      if (cp < 0x20) return false
    } else if (cp >= 0xa0 && cp <= 0xff) {
      // Latin-1 Supplement：都在 PDF 字体 Latin-1 编码里
    } else if (cp >= 0x2010 && cp <= 0x205f) {
      // 通用标点
    } else {
      return false
    }
    i += cp > 0xffff ? 2 : 1
  }
  return true
}

export interface TextInsertsHarmonyResult {
  bytes: Uint8Array
  skipped: TextInsertFailure[]
}

/** 和桌面 textInsertAxes 同形态：把 /Rotate 下要画的方向纠正回字面朝上。 */
export function textInsertAxesHarmony(rotate = 0): readonly [number, number, number, number] {
  switch (((rotate % 360) + 360) % 360) {
    case 90:
      return [0, 1, -1, 0]
    case 180:
      return [-1, 0, 0, -1]
    case 270:
      return [0, -1, 1, 0]
    default:
      return [1, 0, 0, 1]
  }
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** C 字符串 UTF-16LE（PDFium FPDFText_SetText 接这个）+ null 终止符，分配到 wasm 堆里。 */
function setTextUtf16(m: PdfiumModule, text: string): number {
  // +1 留 null terminator
  const bytes = (text.length + 1) * 2
  const ptr = m._malloc(bytes)
  // 写到 wasm heap：JS 字符串 → UTF-16LE
  const view = new Uint16Array(m.HEAPU8.buffer, ptr, text.length + 1)
  for (let i = 0; i < text.length; i++) view[i] = text.charCodeAt(i)
  view[text.length] = 0
  return ptr
}

/** PDFium 模块的子集（避免引入 pdfium.d.ts；本文件只用到 save/insert/font/text 相关 API）。 */
interface PdfiumModule {
  _malloc(size: number): number
  _free(ptr: number): void
  HEAPU8: Uint8Array
  _FPDF_LoadMemDocument(data: number, size: number, flags: number): number
  _FPDF_CloseDocument(doc: number): void
  _FPDF_GetPageCount(doc: number): number
  _FPDF_LoadPage(doc: number, pageIndex: number): number
  _FPDF_ClosePage(page: number): void
  _FPDFText_LoadStandardFont(doc: number, fontNamePtr: number): number
  _FPDFPageObj_CreateTextObj(doc: number, font: number, fontSize: number): number
  _FPDFText_SetText(obj: number, textPtr: number): boolean
  _FPDFPageObj_Destroy(obj: number): void
  _FPDFPageObj_SetMatrix(obj: number, matrixPtr: number): void
  _FPDFPageObj_SetFillColor(obj: number, r: number, g: number, b: number, a: number): void
  _FPDFPage_InsertObject(page: number, obj: number): void
  _FPDFPage_GenerateContent(page: number): boolean
  _PDFiumExt_OpenFileWriter(): number
  _PDFiumExt_SaveAsCopy(doc: number, writer: number): boolean
  _PDFiumExt_GetFileWriterSize(writer: number): number
  _PDFiumExt_GetFileWriterData(writer: number, buf: number, size: number): void
  _PDFiumExt_CloseFileWriter(writer: number): void
  lengthBytesUTF16(str: string): number
  stringToUTF16(str: string, outPtr: number, maxBytes: number): number
}

/** Apply text inserts via PDFium standard fonts (Harmony fallback).
    与桌面 applyTextInserts 不同：font 必走 _FPDFText_LoadStandardFont，不做 harfbuzz
    子集化，不调 font-cmap/font-locate。 */
export async function applyTextInsertsHarmony(
  m: PdfiumModule,
  bytes: Uint8Array,
  inserts: TextInsertInput[],
): Promise<TextInsertsHarmonyResult> {
  const skipped: TextInsertFailure[] = []
  if (!inserts || inserts.length === 0) return { bytes, skipped }

  // 复制字节到 wasm 堆（_FPDF_LoadMemDocument 接 ptr + size）
  const docPtr = m._malloc(bytes.length)
  m.HEAPU8.set(bytes, docPtr)
  const doc = m._FPDF_LoadMemDocument(docPtr, bytes.length, 0)
  if (!doc) {
    m._free(docPtr)
    throw new Error('PDFium could not load the document')
  }

  try {
    const pageCount = m._FPDF_GetPageCount(doc)
    let appliedTotal = 0
    for (let i = 0; i < inserts.length; i++) {
      const input = inserts[i]!
      if (input.pageIndex < 0 || input.pageIndex >= pageCount) {
        skipped.push({ editIndex: i, pageIndex: input.pageIndex, reason: 'page does not exist' })
        continue
      }
      const text = input.text.replace(/\n/g, '')
      if (!text) {
        skipped.push({ editIndex: i, pageIndex: input.pageIndex, reason: 'empty inserted text' })
        continue
      }
      // canDrawTextHarmony 提前拒；不通过直接走 skipped（与桌面 font-covers 失败语义对齐）。
      if (!canDrawTextHarmony(input.text)) {
        skipped.push({
          editIndex: i,
          pageIndex: input.pageIndex,
          reason: 'harmony: text insert supports Latin only (no CJK / symbol font in 14 standard fonts)',
        })
        continue
      }
      const page = m._FPDF_LoadPage(doc, input.pageIndex)
      if (!page) {
        skipped.push({
          editIndex: i,
          pageIndex: input.pageIndex,
          reason: `could not load page ${input.pageIndex + 1}`,
        })
        continue
      }
      try {
        const fontName = standardFontName(input.font, input.bold === true, input.italic === true)
        // 字体名走 UTF-8 + null 终止（PDFium 这层接 C 字符串）
        const fontNameBytes = new TextEncoder().encode(fontName + '\0')
        const fontNamePtr = m._malloc(fontNameBytes.length)
        m.HEAPU8.set(fontNameBytes, fontNamePtr)
        const font = m._FPDFText_LoadStandardFont(doc, fontNamePtr)
        m._free(fontNamePtr)
        if (!font) {
          skipped.push({
            editIndex: i,
            pageIndex: input.pageIndex,
            reason: `LoadStandardFont failed: ${fontName}`,
          })
          continue
        }
        const lines = input.text.split('\n')
        const leading = input.lineLeading ?? input.fontSize * 1.2
        const [a, b, c, d] = textInsertAxesHarmony(input.rotate ?? 0)
        const matrixPtr = m._malloc(24)
        try {
          const created: number[] = []
          for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
            const line = lines[lineIndex]!
            if (!line) continue
            const obj = m._FPDFPageObj_CreateTextObj(doc, font, input.fontSize)
            const textPtr = setTextUtf16(m, line)
            const ok = m._FPDFText_SetText(obj, textPtr)
            m._free(textPtr)
            if (!ok) {
              m._FPDFPageObj_Destroy(obj)
              throw new Error('FPDFText_SetText failed on inserted object')
            }
            const offset = input.lineXOffsets?.[lineIndex] ?? 0
            const drop = lineIndex * leading
            m.HEAPF32.set(
              [
                a,
                b,
                c,
                d,
                input.origin[0] + a * offset - c * drop,
                input.origin[1] + b * offset - d * drop,
              ],
              matrixPtr >> 2,
            )
            m._FPDFPageObj_SetMatrix(obj, matrixPtr)
            m._FPDFPageObj_SetFillColor(
              obj,
              input.color[0],
              input.color[1],
              input.color[2],
              255,
            )
            created.push(obj)
          }
          for (const obj of created) m._FPDFPage_InsertObject(page, obj)
          if (!m._FPDFPage_GenerateContent(page)) {
            throw new Error(`could not regenerate page ${input.pageIndex + 1}`)
          }
          appliedTotal += created.length
        } finally {
          m._free(matrixPtr)
        }
      } catch (err) {
        skipped.push({
          editIndex: i,
          pageIndex: input.pageIndex,
          reason: errMsg(err),
        })
      } finally {
        m._FPDF_ClosePage(page)
      }
    }
    if (appliedTotal === 0) return { bytes, skipped }
    // _PDFiumExt_SaveAsCopy → FileWriter → heap → Uint8Array
    const writer = m._PDFiumExt_OpenFileWriter()
    try {
      if (!m._PDFiumExt_SaveAsCopy(doc, writer)) throw new Error('PDFium SaveAsCopy failed')
      const size = m._PDFiumExt_GetFileWriterSize(writer)
      const buf = m._malloc(size)
      m._PDFiumExt_GetFileWriterData(writer, buf, size)
      const out = Uint8Array.from(m.HEAPU8.subarray(buf, buf + size))
      m._free(buf)
      return { bytes: out, skipped }
    } finally {
      m._PDFiumExt_CloseFileWriter(writer)
    }
  } finally {
    m._FPDF_CloseDocument(doc)
    m._free(docPtr)
  }
}
