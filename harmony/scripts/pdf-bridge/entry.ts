// pdf-bridge 入口：导出鸿蒙壳 pdfMock overlay 需要的全部字节能力。
// 结构操作（split/merge/extract/replace/insert/crop/setPageSize 等）与
// readStaticFormFills 原样复用桌面 save-pdf.ts（纯 pdf-lib 字节函数）；
// 保存用 applySaveEdits（派生版，PDFium 依赖的 text/image/annot 编辑降级 skipped）。
export {
  applySaveEdits,
  cropPagesBytes,
  extractPagesBytes,
  insertBlankPageBytes,
  insertPdfBytes,
  mergePagesBytes,
  mergePdfBytes,
  pngsToPdf,
  readStaticFormFills,
  replacePagesBytes,
  setPageSizeBytes,
  splitPagesBytes,
  splitPdfBytes,
} from './src/save-pdf'
export type { MergePagesOptions } from './src/save-pdf'
// 文本插入：PDFium 标准 14 字体（Harmony 唯一可用字体源）。导出供 sandbox / 渲染层预检；
// 壳侧正常调用通过 applySaveEdits 的 getPdfium 回调注入同一个 PDFium 实例，不直接调它。
export { applyTextInsertsHarmony, canDrawTextHarmony } from './src/text-insert'