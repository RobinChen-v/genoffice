/**
 * PPT 鸿蒙壳桥 —— 浏览器可运行的 pptx 打开/渲染/编辑/保存入口。
 *
 * 复用桌面端纯 TS 引擎 @genoffice/pptx-engine（解析/编辑/落盘）+ @genoffice/pptx-render
 * （构建渲染树）。壳内持有 OpenedPptx 会话（进程内 Map，不经 IPC——与 sheets 的
 * sidecar 会话语义一致），renderer 的编辑/保存经 Index.ets slidesMock 转调这里。
 *
 * 打包：harmony/scripts/build-pptx-bridge.mjs
 * 消费：Index.ets slidesMock.openPptx / consumePendingOpen / editText / save / saveAs
 *
 * 范围：
 *  M1 打开 + 渲染（文本/图片/形状/背景/版式，媒体 → dataUrl）
 *  M2 文本编辑（applyTextEdit 写回模型）+ 保存（savePptx 字节 → 壳写盘）
 *      + 新建空白（createBlankPptx → 真实会话，保存路径同打开文件）
 */
import {
  openPptx,
  parseTheme,
  savePptx,
  commitSaved,
  createBlankPptx,
  duplicateSlide,
  insertBlankSlide,
  insertSlideWithLayout,
  setSlideLayout,
  deleteSlide,
  moveSlide,
  setSlideSize,
  listSlideLayouts,
  getSections,
  reparseDeck,
  getSlideTransition,
  getSlideNotes,
  setSlideNotes,
  getSlideAnimations,
  listMasterParts,
  parseMasterPart,
  copyElementData,
  type ElementClipboardItem,
  type SlideElement,
} from '@genoffice/pptx-engine'
import { mapScriptOps } from '../../../packages/pptx-ops/src/ops/script-map'
import type { ApplyEditScriptOp } from '../../../apps/slides/src/shared/ipc'
import {
  BUILTIN_LAYOUT_PREFIX,
  builtinLayoutInfos,
  ensureBuiltinLayout,
  shouldOfferBuiltinLayouts,
} from '../../../packages/pptx-engine/src/builtin-layouts'
import type { OpenedPptx, Slide, SlideSize } from '@genoffice/pptx-engine'
import { buildRenderSlide, HeuristicMetrics } from '@genoffice/pptx-render'
// 桌面端 slides:edit-text 同款（上游已迁入 packages/pptx-ops）：renderer 的
// EditParagraph[] → 引擎 Paragraph[]（srcPara/srcRun 回溯保留未编辑格式）。
// 纯函数，只依赖 pptx-engine + 类型。
import { applyEditParagraphs } from '../../../packages/pptx-ops/src/edit-text'
import type { EditParagraph } from '../../../apps/slides/src/shared/ipc'
import { DEFAULT_BODY_INSETS } from '@genoffice/pptx-engine'
// ===== 桌面同款事务执行器 + op 注册（Electron-free，可整体 bundle）=====
// runTxn：plan→execute，atomic 快照回滚，全部 edit/structure op 走它 →
// 撤销粒度统一（一次编辑/一次拖动 = 一个 undo 步），与桌面行为一致。
import { runTxn, type TxnRequest } from '../../../packages/pptx-ops/src/ops/executor'
import { opUsage } from '../../../packages/pptx-ops/src/op-docs'
import type { Op } from '../../../packages/pptx-ops/src/ops/registry'
// 触发全部 op 注册（core/text/element/insert/table/slide/...）
import '../../../packages/pptx-ops/src/ops/index'

// 最小 Buffer polyfill —— 浏览器无 Node Buffer，而 pptx-engine 读写路径
// （zip.readText 读、entries.set 写等）会用到 Buffer.from/toString('utf8')。
//   读路径：Buffer.from(bytes).toString('utf8') —— 输入是已解析字节，需可 decode
//   写路径：archive.entries.set(path, Buffer.from(xml, 'utf8')) —— 返回值会被存进
//           entries 再被 readBytes 原样取出，因此**必须是真字节数组**（带 toString），
//           与 Node Buffer（Uint8Array 子类）同构；否则后续解析读空 → spTree 缺失报错。
const g = globalThis as unknown as Record<string, unknown>
if (!g.Buffer) {
  const textDecoder = new TextDecoder()
  type BufferLike = Uint8Array & { toString(enc?: string): string }
  function bufferBytes(value: unknown, enc?: string): Uint8Array {
    if (value instanceof Uint8Array) return value
    if (typeof value === 'string') {
      if (enc === 'base64') {
        const bin = atob(value as string)
        const u = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
        return u
      }
      return new TextEncoder().encode(value as string)
    }
    const ab = value as ArrayBuffer
    return new Uint8Array(ab && ab.byteLength ? ab : 0)
  }
  function bufferFrom(value: unknown, enc?: string): BufferLike {
    const src = bufferBytes(value, enc)
    const out = new Uint8Array(src.byteLength) as BufferLike
    out.set(src)
    out.toString = (outEnc?: string): string =>
      outEnc === 'base64' ? bytesToBase64(out) : textDecoder.decode(out)
    return out
  }
  g.Buffer = {
    from: bufferFrom,
    // 极小面：jszip/ppt 写入路径才会用到，意外触达时兜住
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
  } as unknown as Record<string, unknown>
}

/** Uint8Array → base64（浏览器无 Buffer；ArkWeb btoa 可用）。 */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(bin)
}

/** PowerPoint 常用图片 MIME（按扩展名，与桌面 media-mime 主路径一致）。 */
function mimeForMediaRef(mediaRef: string): string | undefined {
  const ext = mediaRef.toLowerCase().split('.').pop() ?? ''
  switch (ext) {
    case 'png': return 'image/png'
    case 'jpg': case 'jpeg': return 'image/jpeg'
    case 'gif': return 'image/gif'
    case 'webp': return 'image/webp'
    case 'svg': return 'image/svg+xml'
    default: return undefined
  }
}

/** Uint8Array → dataUrl（浏览器无 Buffer；ArkWeb fetch image 支持 data: 直载）。 */
function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return `data:${mime};base64,${btoa(bin)}`
}

/** 媒体 resolver（M1/M2 共用）：图片字节 → dataUrl；TIFF/未知 mime 降级 undefined。 */
function makeMediaResolver(
  archive: { readBytes(path: string): Uint8Array | null },
): (mediaRef: string) => string | undefined {
  const cache = new Map<string, string | undefined>()
  return (mediaRef: string): string | undefined => {
    if (cache.has(mediaRef)) return cache.get(mediaRef)
    const bytes = archive.readBytes(mediaRef)
    const mime = mimeForMediaRef(mediaRef)
    const url = bytes && mime ? bytesToDataUrl(bytes, mime) : undefined
    cache.set(mediaRef, url)
    return url
  }
}

export interface OpenResult {
  path: string
  slides: Array<Record<string, unknown>>
  size: { cx: number; cy: number }
  defaultFont?: string
  /** 壳内会话句柄：编辑/保存经它走引擎模型（renderer 忽略未知字段）。 */
  sessionId?: string
}

// ===== 壳内会话：OpenedPptx + undo/redo 栈（进程内 Map，不经 IPC）=====
// 快照语义与桌面 executor 一致：slides 深拷贝 + entries 浅拷贝（条目整体替换，
// 从不原地改动），undo/redo 互换快照即可安全回滚任意编辑/结构操作。
interface DeckSnapshot {
  slides: OpenedPptx['deck']['slides']
  entries: Map<string, unknown>
  size: OpenedPptx['deck']['size']
}
interface DeckSession {
  opened: OpenedPptx
  undoStack: DeckSnapshot[]
  redoStack: DeckSnapshot[]
  /** 拖动预览进行中：一次手势只压一次 undo 快照（桌面 transformPreview 语义）。 */
  transformPreview?: boolean
  /** 主视图（master/layout part）当前编辑目标。 */
  masterEdit?: { partPath: string; slide: Slide }
}
const MAX_HISTORY = 50
const sessions = new Map<string, DeckSession>()
let sessionSeq = 0
function nextSessionId(prefix = 's'): string {
  return `${prefix}-${++sessionSeq}-${Date.now().toString(36)}`
}
function takeDeckSnapshot(opened: OpenedPptx): DeckSnapshot {
  return {
    slides: structuredClone(opened.deck.slides),
    entries: new Map(opened.archive.entries as Map<string, unknown>),
    size: { ...opened.deck.size },
  }
}
function restoreDeckSnapshot(opened: OpenedPptx, snap: DeckSnapshot): void {
  opened.deck.slides = snap.slides
  opened.deck.size = snap.size
  const entries = opened.archive.entries as Map<string, unknown>
  entries.clear()
  for (const [k, v] of snap.entries) entries.set(k, v)
}
function trimHistory(stack: DeckSnapshot[]): void {
  while (stack.length > MAX_HISTORY) stack.shift()
}
function openDeckSession(opened: OpenedPptx): DeckSession {
  const session: DeckSession = { opened, undoStack: [], redoStack: [] }
  return session
}
function sessionOf(sessionId: string): DeckSession | null {
  return sessions.get(sessionId) ?? null
}
/** 编辑前调用：压入当前状态、清空 redo 栈（一次编辑 = 一个 undo 步）。 */
function pushDeckHistory(session: DeckSession): void {
  session.undoStack.push(takeDeckSnapshot(session.opened))
  trimHistory(session.undoStack)
  session.redoStack = []
}

/** 由 OpenedPptx 构建 OpenResult（渲染树 + 默认字体），共用一份媒体缓存。 */
function buildOpenResult(
  opened: OpenedPptx,
  fitWidthPx: number,
  path: string,
  sessionId?: string,
): OpenResult {
  const metrics = new HeuristicMetrics()
  const media = makeMediaResolver(opened.archive)
  const slides = opened.deck.slides.map((slide, index) =>
    buildRenderSlide(slide, opened.deck.size, {
      fitWidthPx,
      metrics,
      media,
      slideNo: index + 1,
    }) as unknown as Record<string, unknown>,
  )
  let defaultFont: string | undefined
  try {
    const slidePath = opened.archive.readPresentation().slidePaths[0]
    if (slidePath) {
      const themePath = opened.archive.resolveSlideChain(slidePath).themePath
      const xml = themePath ? opened.archive.readText(themePath) : undefined
      if (xml) defaultFont = parseTheme(xml).minorFont
    }
  } catch {
    defaultFont = undefined
  }
  return {
    path,
    slides,
    size: { cx: opened.deck.size.cx, cy: opened.deck.size.cy },
    defaultFont,
    ...(sessionId ? { sessionId } : {}),
  }
}

/** 打开 .pptx 文件字节 → OpenResult（renderer applyOpen 直接消费）；会话保留在壳内。 */
export async function openPptxFile(bytes: Uint8Array, fitWidthPx: number, path = ''): Promise<OpenResult> {
  const opened = await openPptx(bytes)
  const sessionId = nextSessionId()
  sessions.set(sessionId, openDeckSession(opened))
  return buildOpenResult(opened, fitWidthPx, path, sessionId)
}

/** 新建空白演示文稿（桌面 newBlank 同款：createBlankPptx → 真实会话）。 */
export async function newBlankDeck(fitWidthPx: number): Promise<OpenResult> {
  const bytes = await createBlankPptx()
  const opened = await openPptx(bytes)
  const sessionId = nextSessionId('new')
  sessions.set(sessionId, openDeckSession(opened))
  return buildOpenResult(opened, fitWidthPx, '', sessionId)
}

/**
 * 文本编辑写回引擎模型（M2）：sessionId → slide 内 sourceId 元素（TextElement）。
 * 用桌面同款 applyEditParagraphs 把 renderer 的 EditParagraph[] 写进 text.paragraphs，
 * 置 dirty 后重建该页渲染树返回（renderer commitEdit 用返回值替换那一页）。
 * 返回 null：会话缺失/元素找不到/不是文本元素。
 */
export function applyTextEdit(
  sessionId: string,
  slideIndex: number,
  sourceId: string,
  paragraphs: EditParagraph[],
  fitWidthPx: number,
): Record<string, unknown> | null {
  const opened = sessionOf(sessionId)?.opened ?? null
  if (!opened) return null
  const slide = opened.deck.slides[slideIndex]
  if (!slide) return null
  const el = slide.elements.find((e) => e.id === sourceId)
  if (!el) return null
  if (el.type !== 'text' && el.type !== 'shape') return null
  const te = el as unknown as {
    text?: TextBody | undefined
    dirty?: boolean
  }
  if (!te.text) {
    te.text = { paragraphs: [], insets: { ...DEFAULT_BODY_INSETS } }
  }
  const body = te.text
  body.paragraphs = applyEditParagraphs(body.paragraphs ?? [], paragraphs ?? [])
  te.dirty = true
  const metrics = new HeuristicMetrics()
  const media = makeMediaResolver(opened.archive)
  return buildRenderSlide(slide, opened.deck.size, {
    fitWidthPx,
    metrics,
    media,
    slideNo: slideIndex + 1,
  }) as unknown as Record<string, unknown>
}

/** 保存会话 → pptx 字节（壳侧写盘）；成功后调用 commitDeck 清除 dirty 对齐磁盘。 */
export async function saveDeck(sessionId: string): Promise<Uint8Array | null> {
  const opened = sessionOf(sessionId)?.opened ?? null
  if (!opened) return null
  return await savePptx(opened)
}

/** 保存成功后的状态烘焙：把已落盘的补丁 bake 回内存模型（对齐桌面 commitSaved）。 */
export function commitDeck(sessionId: string): boolean {
  const opened = sessionOf(sessionId)?.opened ?? null
  if (!opened) return false
  commitSaved(opened)
  return true
}

// ===== M2 结构化操作：全部在引擎模型上执行，保存时一并落盘 =====

/** 重建整份渲染树（返回给 renderer applyHistoryResult/setSlides 系）。 */
function rebuildAll(sessionId: string, fitWidthPx: number): Array<Record<string, unknown>> | null {
  const opened = sessionOf(sessionId)?.opened ?? null
  if (!opened) return null
  const metrics = new HeuristicMetrics()
  const media = makeMediaResolver(opened.archive)
  return opened.deck.slides.map((slide, index) =>
    buildRenderSlide(slide, opened.deck.size, {
      fitWidthPx,
      metrics,
      media,
      slideNo: index + 1,
    }) as unknown as Record<string, unknown>,
  )
}

/** 重建单页渲染树（renderer 单页替换用）。 */
function rebuildOne(
  sessionId: string,
  slideIndex: number,
  fitWidthPx: number,
): Record<string, unknown> | null {
  const opened = sessionOf(sessionId)?.opened ?? null
  const slide = opened?.deck.slides[slideIndex]
  if (!opened || !slide) return null
  const metrics = new HeuristicMetrics()
  const media = makeMediaResolver(opened.archive)
  return buildRenderSlide(slide, opened.deck.size, {
    fitWidthPx,
    metrics,
    media,
    slideNo: slideIndex + 1,
  }) as unknown as Record<string, unknown>
}

/** 解析 'builtin:<key>' 虚拟版式（未注入则先把标准版式 part 物化进包，与桌面一致）。 */
function resolveLayoutPath(opened: OpenedPptx, layoutPath?: string): string | undefined {
  if (!layoutPath?.startsWith(BUILTIN_LAYOUT_PREFIX)) return layoutPath
  return (
    ensureBuiltinLayout(opened.archive, opened.deck.size, layoutPath.slice(BUILTIN_LAYOUT_PREFIX.length)) ??
    undefined
  )
}

/** 复制 sourceIndex 页 → sourceIndex+1（renderer addSlide — duplicateSlide 语义）。 */
export function insertSlide(
  sessionId: string,
  sourceIndex: number,
  fitWidthPx: number,
  clearText = false,
): { slides: Array<Record<string, unknown>>; index: number } | null {
  const opened = sessionOf(sessionId)?.opened ?? null
  if (!opened) return null
  const slide = duplicateSlide(opened, sourceIndex, clearText ? { clearText: true } : undefined)
  if (!slide) return null
  const index = sourceIndex + 1
  return { slides: rebuildAll(sessionId, fitWidthPx) ?? [], index }
}

/** 插入一张空白页（renderer addBlankSlide）。 */
export function insertBlankSlideOp(
  sessionId: string,
  sourceIndex: number,
  fitWidthPx: number,
): { slides: Array<Record<string, unknown>>; index: number } | null {
  const opened = sessionOf(sessionId)?.opened ?? null
  if (!opened) return null
  const slide = insertBlankSlide(opened, sourceIndex)
  if (!slide) return null
  return { slides: rebuildAll(sessionId, fitWidthPx) ?? [], index: sourceIndex + 1 }
}

/** 按版式插入新页（renderer addSlideWithLayout；builtin 版式自动物化）。 */
export function insertSlideWithLayoutOp(
  sessionId: string,
  sourceIndex: number,
  layoutPath: string,
  fitWidthPx: number,
): { slides: Array<Record<string, unknown>>; index: number } | null {
  const opened = sessionOf(sessionId)?.opened ?? null
  if (!opened) return null
  const resolved = resolveLayoutPath(opened, layoutPath)
  if (!resolved) return null
  const slide = insertSlideWithLayout(opened, sourceIndex, resolved)
  if (!slide) return null
  return { slides: rebuildAll(sessionId, fitWidthPx) ?? [], index: sourceIndex + 1 }
}

/** 切换某页版式（renderer setSlideLayout；返回该页重建）。 */
export function setLayoutOp(
  sessionId: string,
  slideIndex: number,
  layoutPath: string | undefined,
  fitWidthPx: number,
): Record<string, unknown> | null {
  const opened = sessionOf(sessionId)?.opened ?? null
  if (!opened) return null
  const resolved = layoutPath ? resolveLayoutPath(opened, layoutPath) : undefined
  if (layoutPath && !resolved) return null
  const slide = setSlideLayout(opened, slideIndex, resolved ?? '')
  if (!slide) return null
  return rebuildOne(sessionId, slideIndex, fitWidthPx)
}

/** 删除某页（renderer deleteSlide；单页时拒绝，与桌面一致）。 */
export function deleteSlideOp(
  sessionId: string,
  slideIndex: number,
  fitWidthPx: number,
): Array<Record<string, unknown>> | null {
  const opened = sessionOf(sessionId)?.opened ?? null
  if (!opened) return null
  if (!deleteSlide(opened, slideIndex)) return null
  return rebuildAll(sessionId, fitWidthPx)
}

/** 移动某页（renderer moveSlide；返回新渲染树 + sections）。 */
export function moveSlideOp(
  sessionId: string,
  fromIndex: number,
  toIndex: number,
  fitWidthPx: number,
): { slides: Array<Record<string, unknown>>; sections: unknown[] } | null {
  const opened = sessionOf(sessionId)?.opened ?? null
  if (!opened) return null
  if (!moveSlide(opened, fromIndex, toIndex)) return null
  return { slides: rebuildAll(sessionId, fitWidthPx) ?? [], sections: getSections(opened) }
}

/** 版式目录（renderer getLayouts）：包内版式 + 缺失时的 builtin 六件套，与桌面一致。 */
export function getLayoutsOp(sessionId: string): { layouts: unknown[]; size: SlideSize } | null {
  const opened = sessionOf(sessionId)?.opened ?? null
  if (!opened) return null
  const layouts = listSlideLayouts(opened.archive)
  if (shouldOfferBuiltinLayouts(layouts)) {
    layouts.push(
      ...builtinLayoutInfos(opened.deck.size, new Set(layouts.map((l) => l.name))),
    )
  }
  return { layouts: layouts as unknown[], size: { ...opened.deck.size } }
}

/** 页面尺寸（renderer setSlideSize → 返回整副渲染树）。 */
export function setSlideSizeOp(
  sessionId: string,
  cx: number,
  cy: number,
  fitWidthPx: number,
): Array<Record<string, unknown>> | null {
  const opened = sessionOf(sessionId)?.opened ?? null
  if (!opened) return null
  if (!setSlideSize(opened, cx, cy)) return null
  return rebuildAll(sessionId, fitWidthPx)
}

/** 当前页面尺寸（renderer getSlideSize）。 */
export function getSlideSizeOp(sessionId: string): { cx: number; cy: number } | null {
  const opened = sessionOf(sessionId)?.opened ?? null
  return opened ? { ...opened.deck.size } : null
}

// ===== M4：事务执行器 + undo/redo（桌面同款 op 语义，一次编辑 = 一个 undo 步）=====

/**
 * 执行一个 op 事务（编辑/结构统一入口）：期望全部成功（atomic）。
 * 成功时若 `history` 为 true 则编辑前已压 undo 栈（调用方先 pushDeckHistory，
 * 或本函数按 preview 语义处理）。返回重建的渲染树（整副或单页由调用方指定）。
 */
export function execTxn(
  sessionId: string,
  ops: Op[],
  fitWidthPx: number,
  history = true,
): { slides: Array<Record<string, unknown>> | null; records?: unknown[] } | null {
  const session = sessionOf(sessionId)
  if (!session) return null
  if (history) pushDeckHistory(session)
  const req: TxnRequest = { ops, isolation: 'atomic' }
  const r = runTxn(session.opened, req)
  if (!r.applied) {
    // atomic 失败已回滚；撤销刚压的快照，保持 undo 栈与模型一致
    if (history) session.undoStack.pop()
    return null
  }
  return { slides: rebuildAll(sessionId, fitWidthPx), records: r.records }
}

/** undo：把当前状态压 redo 栈，恢复 undo 栈顶快照，返回新渲染树。 */
export function undoDeck(sessionId: string, fitWidthPx: number): Array<Record<string, unknown>> | null {
  const session = sessionOf(sessionId)
  if (!session || session.undoStack.length === 0) return null
  session.redoStack.push(takeDeckSnapshot(session.opened))
  trimHistory(session.redoStack)
  restoreDeckSnapshot(session.opened, session.undoStack.pop()!)
  return rebuildAll(sessionId, fitWidthPx)
}

/** redo：把当前状态压 undo 栈，恢复 redo 栈顶快照，返回新渲染树。 */
export function redoDeck(sessionId: string, fitWidthPx: number): Array<Record<string, unknown>> | null {
  const session = sessionOf(sessionId)
  if (!session || session.redoStack.length === 0) return null
  session.undoStack.push(takeDeckSnapshot(session.opened))
  trimHistory(session.undoStack)
  restoreDeckSnapshot(session.opened, session.redoStack.pop()!)
  return rebuildAll(sessionId, fitWidthPx)
}

/** 撤销/重做可用状态（renderer isDirty/undo 按钮灰态驱动）。 */
export function historyState(sessionId: string): { canUndo: boolean; canRedo: boolean } | null {
  const session = sessionOf(sessionId)
  return session ? { canUndo: session.undoStack.length > 0, canRedo: session.redoStack.length > 0 } : null
}

/**
 * 形状变换（renderer editTransform）：px → EMU（反viewport scale 与桌面一致），
 * preview 语义：一次拖动第一帧压 undo 快照，后续帧与最终 commit 不重复压栈。
 */
export function setTransformOp(
  sessionId: string,
  slideIndex: number,
  sourceId: string,
  xPx: number,
  yPx: number,
  wPx: number,
  hPx: number,
  rotationDeg: number,
  fitWidthPx: number,
  preview = false,
): Record<string, unknown> | null {
  const session = sessionOf(sessionId)
  if (!session) return null
  const opened = session.opened
  const slide = opened.deck.slides[slideIndex]
  if (!slide) return null
  const baseWidthPx = opened.deck.size.cx / 9525
  const scale = fitWidthPx / baseWidthPx
  const toEmu = (px: number) => Math.round((px / scale) * 9525)
  const box = { x: toEmu(xPx), y: toEmu(yPx), cx: toEmu(wPx), cy: toEmu(hPx) }
  const op: Op = {
    op: 'setTransform',
    target: { slide: slideIndex, el: sourceId },
    box,
    rotDeg: rotationDeg,
    resizeTableGrid: true,
  }
  // 校验先行：失败的 preview 不压 undo 栈（对齐桌面 dryRun 语义）
  if (runTxn(opened, { dryRun: true, ops: [op] }).failures?.length) return null
  if (preview) {
    // 一次拖动只压第一帧
    if (!session.transformPreview) {
      pushDeckHistory(session)
      session.transformPreview = true
    }
  } else if (!session.transformPreview) {
    pushDeckHistory(session)
  } else {
    session.transformPreview = false
  }
  const r = runTxn(opened, { ops: [op] })
  if (!r.applied) {
    session.undoStack.pop()
    if (preview) session.transformPreview = false
    return null
  }
  const metrics = new HeuristicMetrics()
  const media = makeMediaResolver(opened.archive)
  return buildRenderSlide(slide, opened.deck.size, {
    fitWidthPx,
    metrics,
    media,
    slideNo: slideIndex + 1,
  }) as unknown as Record<string, unknown>
}

// ===== M5：元素格式 op（font / paragraph / stroke / fill）=====
// per_op 语义与桌面一致：同一批 sourceIds 逐个独立执行，成功的留下、失败的跳过
// （非文本元素（图片等）的 setFont 自身失败被 skip，而不是整批回滚）。

/** renderer setElementFont：对整批 sourceIds 改字体（setFont op，per_op）。 */
export function setElementFontOp(
  sessionId: string,
  slideIndex: number,
  sourceIds: string[],
  font: Record<string, unknown>,
  fitWidthPx: number,
  groupId?: string,
): Record<string, unknown> | null {
  const session = sessionOf(sessionId)
  if (!session || !Array.isArray(sourceIds) || sourceIds.length === 0) return null
  pushDeckHistory(session)
  const ops: Op[] = sourceIds.map((id) => ({
    op: 'setFont',
    target: { slide: slideIndex, el: id },
    font,
    ...(groupId ? { group: groupId } : {}),
  }))
  const r = runTxn(session.opened, { ops, isolation: 'per_op' })
  if (!r.applied) {
    session.undoStack.pop()
    return null
  }
  return rebuildOne(sessionId, slideIndex, fitWidthPx)
}

/** renderer setElementParagraphFormat：整批 sourceIds 改段落格式（setParagraphFormat，per_op）。 */
export function setParagraphFormatOp(
  sessionId: string,
  slideIndex: number,
  sourceIds: string[],
  format: Record<string, unknown>,
  fitWidthPx: number,
  groupId?: string,
): Record<string, unknown> | null {
  const session = sessionOf(sessionId)
  if (!session || !Array.isArray(sourceIds) || sourceIds.length === 0) return null
  pushDeckHistory(session)
  const ops: Op[] = sourceIds.map((id) => ({
    op: 'setParagraphFormat',
    target: { slide: slideIndex, el: id },
    format,
    ...(groupId ? { group: groupId } : {}),
  }))
  const r = runTxn(session.opened, { ops, isolation: 'per_op' })
  if (!r.applied) {
    session.undoStack.pop()
    return null
  }
  return rebuildOne(sessionId, slideIndex, fitWidthPx)
}

/** renderer editStroke：设置描边（null = 无描边；widthPt→EMU）。 */
export function setStrokeOp(
  sessionId: string,
  slideIndex: number,
  sourceId: string,
  stroke: Record<string, unknown> | null,
  fitWidthPx: number,
  groupId?: string,
): Record<string, unknown> | null {
  const session = sessionOf(sessionId)
  if (!session || !sourceId) return null
  const patch = stroke
    ? {
        color: stroke.color,
        widthEmu: Math.round(Number(stroke.widthPt ?? 1) * 12700),
        ...(stroke.dash !== undefined ? { dash: stroke.dash } : {}),
        ...(stroke.cap !== undefined ? { cap: stroke.cap } : {}),
        ...(stroke.join !== undefined ? { join: stroke.join } : {}),
        ...(stroke.compound !== undefined ? { compound: stroke.compound } : {}),
        ...(stroke.gradient
          ? {
              gradient: {
                stops: (stroke.gradient as { stops?: unknown[] }).stops,
                angle: Math.round(Number((stroke.gradient as { angleDeg?: number }).angleDeg ?? 0) * 60000),
              },
            }
          : {}),
      }
    : null
  pushDeckHistory(session)
  const op: Op = {
    op: 'setStroke',
    target: { slide: slideIndex, el: sourceId },
    stroke: patch,
    ...(groupId ? { group: groupId } : {}),
  }
  const r = runTxn(session.opened, { ops: [op] })
  if (!r.applied) {
    session.undoStack.pop()
    return null
  }
  return rebuildOne(sessionId, slideIndex, fitWidthPx)
}

/** renderer editFill：设置填充（字符串或 gradient 对象，与桌面 EditFillOp 同构）。 */
export function setFillOp(
  sessionId: string,
  slideIndex: number,
  sourceId: string,
  fill: unknown,
  fitWidthPx: number,
  groupId?: string,
): Record<string, unknown> | null {
  const session = sessionOf(sessionId)
  if (!session || !sourceId) return null
  let normalized: unknown = fill
  if (fill && typeof fill === 'object') {
    const f = fill as { gradient?: { stops?: unknown[]; angleDeg?: number; path?: string; fillTo?: string } }
    if (f.gradient) {
      normalized = {
        stops: f.gradient.stops ?? [],
        ...(f.gradient.path
          ? {
              path: f.gradient.path,
              ...(f.gradient.fillTo ? { fillTo: f.gradient.fillTo } : {}),
            }
          : { angle: Math.round((f.gradient.angleDeg ?? 0) * 60000) }),
      }
    }
  }
  pushDeckHistory(session)
  const op: Op = {
    op: 'setFill',
    target: { slide: slideIndex, el: sourceId },
    fill: normalized,
    ...(groupId ? { group: groupId } : {}),
  }
  const r = runTxn(session.opened, { ops: [op] })
  if (!r.applied) {
    session.undoStack.pop()
    return null
  }
  return rebuildOne(sessionId, slideIndex, fitWidthPx)
}

// ===== M6：图片系 op + 幻灯片背景 =====

/** renderer flipElements：水平/垂直翻转（一次编辑 = 一个 undo 步）。 */
export function flipElementsOp(
  sessionId: string,
  slideIndex: number,
  sourceIds: string[],
  axis: 'h' | 'v',
  fitWidthPx: number,
  groupId?: string,
): Record<string, unknown> | null {
  const session = sessionOf(sessionId)
  if (!session || !Array.isArray(sourceIds) || sourceIds.length === 0) return null
  pushDeckHistory(session)
  const op: Op = {
    op: 'flipElements',
    target: { slide: slideIndex },
    els: sourceIds,
    axis,
    ...(groupId ? { group: groupId } : {}),
  }
  const r = runTxn(session.opened, { ops: [op] })
  if (!r.applied) {
    session.undoStack.pop()
    return null
  }
  return rebuildOne(sessionId, slideIndex, fitWidthPx)
}

/** renderer editPictureSrcRect：图片裁剪（srcRect 各边比例 0..1；null = 取消裁剪）。 */
export function setPictureSrcRectOp(
  sessionId: string,
  slideIndex: number,
  sourceId: string,
  srcRect: { l: number; t: number; r: number; b: number } | null,
  fitWidthPx: number,
  boxPx?: { x: number; y: number; w: number; h: number },
): Record<string, unknown> | null {
  const session = sessionOf(sessionId)
  if (!session || !sourceId) return null
  const opened = session.opened
  let box: { x: number; y: number; cx: number; cy: number } | undefined
  if (boxPx && fitWidthPx) {
    const baseWidthPx = opened.deck.size.cx / 9525
    const scale = fitWidthPx / baseWidthPx
    const toEmu = (px: number) => Math.round((px / scale) * 9525)
    box = { x: toEmu(boxPx.x), y: toEmu(boxPx.y), cx: toEmu(boxPx.w), cy: toEmu(boxPx.h) }
  }
  pushDeckHistory(session)
  const op: Op = {
    op: 'setPictureSrcRect',
    target: { slide: slideIndex, el: sourceId },
    srcRect,
    ...(box ? { box } : {}),
  }
  const r = runTxn(session.opened, { ops: [op] })
  if (!r.applied) {
    session.undoStack.pop()
    return null
  }
  return rebuildOne(sessionId, slideIndex, fitWidthPx)
}

/** renderer editPictureOpacity：图片透明度（0..1；1 = 不透明）。 */
export function setPictureOpacityOp(
  sessionId: string,
  slideIndex: number,
  sourceId: string,
  opacity: number,
  fitWidthPx: number,
): Record<string, unknown> | null {
  const session = sessionOf(sessionId)
  if (!session || !sourceId) return null
  pushDeckHistory(session)
  const op: Op = {
    op: 'setPictureOpacity',
    target: { slide: slideIndex, el: sourceId },
    opacity,
  }
  const r = runTxn(session.opened, { ops: [op] })
  if (!r.applied) {
    session.undoStack.pop()
    return null
  }
  return rebuildOne(sessionId, slideIndex, fitWidthPx)
}

/** base64 → 字节（renderer 内联图片 source用）。 */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const u = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
  return u
}

/**
 * renderer editImageFill：图片填充（内联 base64 source 或复用已落地的媒体 part）。
 * 字节落地为一个媒体 part，同一批 target 后续只加 rel（与桌面 landed 语义一致）。
 */
export function setImageFillOp(
  sessionId: string,
  slideIndex: number,
  targets: Array<{ sourceId: string; groupId?: string }>,
  mode: 'stretch' | 'tile',
  source: { base64: string; ext: string },
  fitWidthPx: number,
): Record<string, unknown> | null {
  const session = sessionOf(sessionId)
  if (!session || !Array.isArray(targets) || targets.length === 0) return null
  pushDeckHistory(session)
  const opened = session.opened
  let landed: string | null = null
  let applied = 0
  for (const target of targets) {
    const payload: Op =
      landed
        ? { op: 'setImageFill', target: { slide: slideIndex, el: target.sourceId }, source: { mediaPath: landed }, tile: mode === 'tile', ...(target.groupId ? { group: target.groupId } : {}) }
        : { op: 'setImageFill', target: { slide: slideIndex, el: target.sourceId }, source: { bytes: base64ToBytes(source.base64), ext: source.ext.toLowerCase() }, tile: mode === 'tile', ...(target.groupId ? { group: target.groupId } : {}) }
    const r = runTxn(opened, { ops: [payload] })
    if (r.applied) {
      applied += 1
      const used = (r.records?.[0]?.after as { mediaPath?: string } | undefined)?.mediaPath
      if (used) landed = used
    }
  }
  if (!applied) {
    session.undoStack.pop()
    return null
  }
  return rebuildOne(sessionId, slideIndex, fitWidthPx)
}

/**
 * renderer editBackground：幻灯片背景。
 * - solid/gradient：填充
 * - reset：去掉本页 <p:bg>
 * - hideGraphics：显隐母版装饰
 * - image：内联 base64 source（壳内无系统选择器 → renderer 传字节）
 * slideIndex=-1 作用于全部页（与桌面一致）。
 */
export function setBackgroundOp(
  sessionId: string,
  slideIndex: number,
  fitWidthPx: number,
  kind:
    | { solid: string }
    | { gradient: { from: string; to: string; angleDeg?: number; radial?: boolean } }
    | { reset: true }
    | { hideGraphics: boolean }
    | { image: { source: { base64: string; ext: string }; tile?: boolean } },
): Array<Record<string, unknown>> | null {
  const session = sessionOf(sessionId)
  if (!session) return null
  const opened = session.opened
  const slides = opened.deck.slides
  const indexes = slideIndex === -1 ? slides.map((_, i) => i) : [slideIndex]
  const list = indexes.filter((i) => slides[i])
  if (list.length === 0) return null
  const IS_BG_IMAGE = kind && typeof kind === 'object' && 'image' in kind && kind.image
  pushDeckHistory(session)
  if (IS_BG_IMAGE) {
    let landed: string | null = null
    let applied = 0
    for (const i of list) {
      const payload: Op = landed
        ? { op: 'setBackground', target: { slide: i }, kind: 'image', source: { mediaPath: landed }, tile: !!(kind.image as { tile?: boolean }).tile }
        : { op: 'setBackground', target: { slide: i }, kind: 'image', source: { bytes: base64ToBytes((kind.image as { source: { base64: string } }).source.base64), ext: (kind.image as { source: { ext: string } }).source.ext.toLowerCase() }, tile: !!(kind.image as { tile?: boolean }).tile }
      const r = runTxn(opened, { ops: [payload] })
      if (r.applied) {
        applied += 1
        const used = (r.records?.[0]?.after as { mediaPath?: string } | undefined)?.mediaPath
        if (used) landed = used
      }
    }
    if (!applied) {
      session.undoStack.pop()
      return null
    }
  } else {
    const common: Record<string, unknown> =
      kind && typeof kind === 'object' && 'solid' in kind && kind.solid
        ? { kind: 'solid', color: (kind as { solid: string }).solid }
        : kind && typeof kind === 'object' && 'gradient' in kind && kind.gradient
          ? {
              kind: 'gradient',
              from: (kind as { gradient: { from: string } }).gradient.from,
              to: (kind as { gradient: { to: string } }).gradient.to,
              ...(((kind as { gradient: { angleDeg?: number } }).gradient.angleDeg !== undefined)
                ? { angleDeg: (kind as { gradient: { angleDeg?: number } }).gradient.angleDeg }
                : {}),
              ...(((kind as { gradient: { radial?: boolean } }).gradient.radial)
                ? { radial: true }
                : {}),
            }
          : kind && typeof kind === 'object' && 'reset' in kind
            ? { kind: 'reset' }
            : { kind: 'graphics', hidden: !!(kind && typeof kind === 'object' && 'hideGraphics' in kind && (kind as { hideGraphics: boolean }).hideGraphics) }
    const ops: Op[] = list.map((i) => ({ op: 'setBackground', target: { slide: i }, ...common }))
    const r = runTxn(opened, { ops })
    if (!r.applied) {
      session.undoStack.pop()
      return null
    }
  }
  return rebuildAll(sessionId, fitWidthPx)
}

// ===== M7：主题 / 组合 / 形状效果 =====

/** renderer groupElements：合并多个元素为组（返回新 slide + 新组 id）。 */
export function groupElementsOp(
  sessionId: string,
  slideIndex: number,
  sourceIds: string[],
  fitWidthPx: number,
): { slide: Record<string, unknown>; groupId: string } | null {
  const session = sessionOf(sessionId)
  if (!session || !Array.isArray(sourceIds) || sourceIds.length < 2) return null
  pushDeckHistory(session)
  const op: Op = { op: 'groupElements', target: { slide: slideIndex }, els: sourceIds }
  const r = runTxn(session.opened, { ops: [op] })
  if (!r.applied) {
    session.undoStack.pop()
    return null
  }
  const groupId = r.records?.[0]?.created?.[0]
  if (!groupId) {
    session.undoStack.pop()
    return null
  }
  return { slide: rebuildOne(sessionId, slideIndex, fitWidthPx), groupId }
}

/** renderer ungroupElement：拆分已有组。 */
export function ungroupElementOp(
  sessionId: string,
  slideIndex: number,
  sourceId: string,
  fitWidthPx: number,
): Record<string, unknown> | null {
  const session = sessionOf(sessionId)
  if (!session || !sourceId) return null
  pushDeckHistory(session)
  const op: Op = { op: 'ungroupElement', target: { slide: slideIndex, el: sourceId } }
  const r = runTxn(session.opened, { ops: [op] })
  if (!r.applied) {
    session.undoStack.pop()
    return null
  }
  return rebuildOne(sessionId, slideIndex, fitWidthPx)
}

/** renderer setEffects：形状效果（阴影/发光/映像/柔化边缘，null 移除）。 */
export function setEffectsOp(
  sessionId: string,
  slideIndex: number,
  sourceId: string,
  effects: Record<string, unknown>,
  fitWidthPx: number,
): Record<string, unknown> | null {
  const session = sessionOf(sessionId)
  if (!session || !sourceId) return null
  pushDeckHistory(session)
  const op: Op = {
    op: 'setEffects',
    target: { slide: slideIndex, el: sourceId },
    effects,
  }
  const r = runTxn(session.opened, { ops: [op] })
  if (!r.applied) {
    session.undoStack.pop()
    return null
  }
  return rebuildOne(sessionId, slideIndex, fitWidthPx)
}

/**
 * renderer applyTheme：应用主题（colors/majorFont/minorFont 重写 theme part →
 * reparseDeck 换会话模型 → 全部页面重新渲染树）。reparse 后需把会话 opened 替换
 * 为新对象：undo 快照在旧对象上取，reparse 后新模型用于后续编辑/保存，两者不冲突
 * （快照 deep-clone 独立）。
 */
export function applyThemeOp(
  sessionId: string,
  name: string,
  colors: Record<string, string>,
  majorFont: string | undefined,
  minorFont: string | undefined,
  fitWidthPx: number,
): Array<Record<string, unknown>> | { error: string } | null {
  const session = sessionOf(sessionId)
  if (!session) return null
  const payload: Op = {
    op: 'applyTheme',
    name,
    colors,
    ...(majorFont ? { majorFont } : {}),
    ...(minorFont ? { minorFont } : {}),
  }
  const plan = runTxn(session.opened, { ops: [payload], dryRun: true })
  if (plan.failures?.length) return { error: plan.failures[0]!.error }
  pushDeckHistory(session)
  const r = runTxn(session.opened, { ops: [payload] })
  if (!r.applied) {
    session.undoStack.pop()
    return { error: r.failures?.[0]?.error ?? 'applyTheme failed' }
  }
  const after = r.records?.[0]?.after as { patched?: number; remapped?: number } | undefined
  if (!after?.patched && !after?.remapped) {
    session.undoStack.pop()
    return null
  }
  // reparse 换会话模型（对齐桌面：theme 颜色/字体 refresh 需重新解析）
  session.opened = reparseDeck(session.opened)
  return rebuildAll(sessionId, fitWidthPx)
}

// ===== M8：备注 / 切换 / 动画 / 主视图 / AI 编辑脚本 =====

/** renderer getNotes：读某页演讲者备注（archive 读 notesSlides part）。 */
export function getNotesOp(sessionId: string, slideIndex: number): string {
  const session = sessionOf(sessionId)
  const slide = session?.opened?.deck.slides[slideIndex]
  if (!session || !slide) return ''
  try {
    return getSlideNotes(session.opened.archive, slide.path)
  } catch {
    return ''
  }
}

/** renderer setNotes：写某页备注（setNotes op，带 undo 步）。 */
export function setNotesOp(
  sessionId: string,
  slideIndex: number,
  text: string,
): boolean {
  const session = sessionOf(sessionId)
  if (!session) return false
  pushDeckHistory(session)
  const op: Op = { op: 'setNotes', target: { slide: slideIndex }, text }
  const r = runTxn(session.opened, { ops: [op] })
  if (!r.applied) {
    session.undoStack.pop()
    return false
  }
  return true
}

/** renderer getTransition：读某页切换效果。 */
export function getTransitionOp(sessionId: string, slideIndex: number): string {
  const session = sessionOf(sessionId)
  const slide = session?.opened?.deck.slides[slideIndex]
  if (!slide) return 'none'
  return getSlideTransition(slide)
}

/** renderer setTransition：写切换效果（slideIndex=-1 全部页；带 undo 步）。 */
export function setTransitionOp(
  sessionId: string,
  slideIndex: number,
  kind: string,
): boolean {
  const session = sessionOf(sessionId)
  if (!session) return false
  const slides = session.opened.deck.slides
  const idxs =
    slideIndex === -1 ? slides.map((_, i) => i) : slides[slideIndex] ? [slideIndex] : []
  if (idxs.length === 0) return false
  pushDeckHistory(session)
  const ops: Op[] = idxs.map((i) => ({ op: 'setTransition', target: { slide: i }, kind }))
  const r = runTxn(session.opened, { ops })
  if (!r.applied) {
    session.undoStack.pop()
    return false
  }
  return true
}

/** renderer getAnimations：读某页动画列表（引擎 getSlideAnimations）。 */
export function getAnimationsOp(sessionId: string, slideIndex: number): unknown[] {
  const session = sessionOf(sessionId)
  const slide = session?.opened?.deck.slides[slideIndex]
  if (!slide) return []
  return getSlideAnimations(slide)
}

/** renderer setAnimations：写动画（setAnimations op，带 undo 步）。 */
export function setAnimationsOp(
  sessionId: string,
  slideIndex: number,
  items: unknown[],
): boolean {
  const session = sessionOf(sessionId)
  if (!session) return false
  pushDeckHistory(session)
  const op: Op = { op: 'setAnimations', target: { slide: slideIndex }, items }
  const r = runTxn(session.opened, { ops: [op] })
  if (!r.applied) {
    session.undoStack.pop()
    return false
  }
  return true
}

// ── 主视图编辑（master/layout part 级编辑；快照/undo 与 deck 编辑一致）──

interface MasterItem {
  partPath: string
  kind: 'master' | 'layout'
  name: string
  slide: Record<string, unknown> | null
}

/** renderer masterEnter：枚举 all master+layout parts，返回渲染树 + 首项设为编辑目标。 */
export function masterEnterOp(
  sessionId: string,
  fitWidthPx: number,
): { items: MasterItem[] } | null {
  const session = sessionOf(sessionId)
  if (!session) return null
  const items: MasterItem[] = []
  for (const p of listMasterParts(session.opened.archive)) {
    const slide = parseMasterPart(session.opened.archive, p.partPath)
    const rendered = slide
      ? buildRenderSlide(slide, session.opened.deck.size, {
          fitWidthPx,
          media: makeMediaResolver(session.opened.archive),
          metrics: new HeuristicMetrics(),
        }) as unknown as Record<string, unknown>
      : null
    items.push({ partPath: p.partPath, kind: p.kind, name: p.name, slide: rendered })
    if (!session.masterEdit) session.masterEdit = { partPath: p.partPath, slide }
  }
  return items.length ? { items } : null
}

/** renderer masterOpen：切换编辑目标 part。 */
export function masterOpenOp(
  sessionId: string,
  partPath: string,
  fitWidthPx: number,
): Record<string, unknown> | null {
  const session = sessionOf(sessionId)
  if (!session) return null
  const slide = parseMasterPart(session.opened.archive, partPath)
  if (!slide) return null
  session.masterEdit = { partPath, slide }
  return buildRenderSlide(slide, session.opened.deck.size, {
    fitWidthPx,
    media: makeMediaResolver(session.opened.archive),
    metrics: new HeuristicMetrics(),
  }) as unknown as Record<string, unknown>
}

/** renderer masterClose：退出主视图，返回整副渲染树。 */
export function masterCloseOp(sessionId: string, fitWidthPx: number): Array<Record<string, unknown>> | null {
  const session = sessionOf(sessionId)
  if (!session) return null
  session.masterEdit = undefined
  return rebuildAll(sessionId, fitWidthPx)
}

/**
 * renderer masterEditText/masterEditTransform/masterEditFill/masterEditStroke：
 * 主视图编辑统一入口 —— 对当前 masterEdit part 执行 setText/setTransform/等 op，
 * 然后 flush 该 part 到 archive（parts 机制），重建 part 渲染树。
 * 一次编辑 = 一个 undo 步。
 */
export function masterEditOp(
  sessionId: string,
  opName: string,
  sourceId: string,
  payload: Record<string, unknown>,
  fitWidthPx: number,
): Record<string, unknown> | null {
  const session = sessionOf(sessionId)
  const me = session?.masterEdit
  if (!session || !me) return null
  pushDeckHistory(session)
  const op: Op = {
    op: opName as Op['op'],
    target: { part: me.partPath, el: sourceId },
    ...payload,
  }
  const parts = new Map([[me.partPath, me.slide]])
  const r = runTxn(session.opened, { ops: [op], parts })
  if (!r.applied) {
    session.undoStack.pop()
    return null
  }
  // flushTouchedParts 会把 part 序列化回 archive——但 executor 只在 txn 内 flush，
  // part 对象同一引用，这里直接取 me.slide 重建
  return buildRenderSlide(me.slide, session.opened.deck.size, {
    fitWidthPx,
    media: makeMediaResolver(session.opened.archive),
    metrics: new HeuristicMetrics(),
  }) as unknown as Record<string, unknown>
}

/** renderer applyEditScript：AI 编辑脚本 → mapScriptOps 展开为多 op 事务。 */
export function applyEditScriptOp(
  sessionId: string,
  req: ApplyEditScriptOp,
  fitWidthPx: number,
): { slide: Record<string, unknown> } | { error: string } | null {
  const session = sessionOf(sessionId)
  if (!session) return null
  const reqWithFit = { ...req, fitWidthPx: fitWidthPx ?? req.fitWidthPx }
  const ops = mapScriptOps(session.opened, reqWithFit)
  if (ops.length === 0) return null
  const plan = runTxn(session.opened, { ops, dryRun: true })
  if (plan.failures?.length) return { error: plan.failures[0]!.error }
  pushDeckHistory(session)
  const r = runTxn(session.opened, { ops })
  if (!r.applied) {
    session.undoStack.pop()
    return { error: r.failures?.[0]?.error ?? 'the transaction could not be applied' }
  }
  return { slide: rebuildOne(sessionId, req.slideIndex, fitWidthPx) }
}
// ===== M9：元素工厂（addElement / addTable / addChart / addSmartArt / addPicture / addMedia / addModel3d）=====
// 与桌面 slides-main.ts 同款 px→EMU 转换 + op 构造；返回 { slide, sourceId } 供 renderer 替换页面。

const EMU_PER_PX_96 = 9525
const EMU_PER_PT = 12700

/** px → EMU 转换器（与桌面同款：baseWidthPx = cx / 9525, scale = fitWidthPx / baseWidthPx）。 */
function makeToEmu(deckCx: number, fitWidthPx: number): (px: number) => number {
  const baseWidthPx = deckCx / EMU_PER_PX_96
  const scale = fitWidthPx / baseWidthPx
  return (px: number) => Math.round((px / scale) * EMU_PER_PX_96)
}

/** renderer addElement：插入文本框/形状/艺术字/日期/页码/公式。 */
export function addElementOp(
  sessionId: string,
  slideIndex: number,
  kind: string,
  xPx: number, yPx: number, wPx: number, hPx: number,
  fitWidthPx: number,
  paragraphs?: unknown[],
  fillColor?: string,
  stroke?: { color: string; widthPt: number },
  bodyPr?: { wrap?: 'square' | 'none'; autoFit?: 'shrink' | 'resize' },
): { slide: Record<string, unknown>; sourceId: string } | null {
  const session = sessionOf(sessionId)
  if (!session) return null
  const opened = session.opened
  const slide = opened.deck.slides[slideIndex]
  if (!slide) return null
  const toEmu = makeToEmu(opened.deck.size.cx, fitWidthPx)
  pushDeckHistory(session)
  const op: Op = {
    op: 'addElement',
    target: { slide: slideIndex },
    kind,
    offset: { x: toEmu(xPx), y: toEmu(yPx), cx: toEmu(wPx), cy: toEmu(hPx) },
    ...(paragraphs && Array.isArray(paragraphs) && paragraphs.length ? { paragraphs } : {}),
    ...(fillColor ? { fill: fillColor } : {}),
    ...(stroke ? { stroke: { color: stroke.color, widthEmu: Math.round(stroke.widthPt * EMU_PER_PT) } } : {}),
    ...(bodyPr ? { bodyPr } : {}),
  }
  const r = runTxn(opened, { ops: [op] })
  if (!r.applied) {
    session.undoStack.pop()
    return null
  }
  const sourceId = r.records?.[0]?.created?.[0]
  if (!sourceId) {
    session.undoStack.pop()
    return null
  }
  return { slide: rebuildOne(sessionId, slideIndex, fitWidthPx)!, sourceId }
}

/** renderer addTable：插入表格。 */
export function addTableOp(
  sessionId: string,
  slideIndex: number,
  rows: number, cols: number,
  xPx: number, yPx: number, wPx: number, hPx: number,
  fitWidthPx: number,
  rowHeightEmu?: number,
): { slide: Record<string, unknown>; sourceId: string } | null {
  const session = sessionOf(sessionId)
  if (!session) return null
  const opened = session.opened
  if (!opened.deck.slides[slideIndex]) return null
  const toEmu = makeToEmu(opened.deck.size.cx, fitWidthPx)
  const rowH = rowHeightEmu && rowHeightEmu > 0 ? Math.round(rowHeightEmu) : null
  pushDeckHistory(session)
  const op: Op = {
    op: 'addTable',
    target: { slide: slideIndex },
    rows, cols,
    offset: {
      x: toEmu(xPx), y: toEmu(yPx),
      cx: toEmu(wPx),
      cy: rowH ? rowH * rows : toEmu(hPx),
    },
    ...(rowH ? { rowHeightsEmu: Array.from({ length: rows }, () => rowH) } : {}),
  }
  const r = runTxn(opened, { ops: [op] })
  if (!r.applied) {
    session.undoStack.pop()
    return null
  }
  const sourceId = r.records?.[0]?.created?.[0]
  if (!sourceId) {
    session.undoStack.pop()
    return null
  }
  return { slide: rebuildOne(sessionId, slideIndex, fitWidthPx)!, sourceId }
}

/** renderer addChart：插入图表。 */
export function addChartOp(
  sessionId: string,
  slideIndex: number,
  kind: string,
  categories: string[],
  series: Array<{ name: string; values: number[] }>,
  xPx: number, yPx: number, wPx: number, hPx: number,
  fitWidthPx: number,
  title?: string,
): { slide: Record<string, unknown>; sourceId: string } | null {
  const session = sessionOf(sessionId)
  if (!session) return null
  const opened = session.opened
  if (!opened.deck.slides[slideIndex]) return null
  const toEmu = makeToEmu(opened.deck.size.cx, fitWidthPx)
  pushDeckHistory(session)
  const op: Op = {
    op: 'addChart',
    target: { slide: slideIndex },
    kind: kind === 'barH' ? 'bar' : kind,
    ...(kind === 'barH' ? { barDir: 'bar' as const } : {}),
    ...(title ? { title } : {}),
    categories,
    series,
    offset: { x: toEmu(xPx), y: toEmu(yPx), cx: toEmu(wPx), cy: toEmu(hPx) },
  }
  const r = runTxn(opened, { ops: [op] })
  if (!r.applied) {
    session.undoStack.pop()
    return null
  }
  const sourceId = r.records?.[0]?.created?.[0]
  if (!sourceId) {
    session.undoStack.pop()
    return null
  }
  return { slide: rebuildOne(sessionId, slideIndex, fitWidthPx)!, sourceId }
}

/** renderer addSmartArt：插入 SmartArt。 */
export function addSmartArtOp(
  sessionId: string,
  slideIndex: number,
  layout: string,
  items: string[],
  xPx: number, yPx: number, wPx: number, hPx: number,
  fitWidthPx: number,
): { slide: Record<string, unknown>; sourceId: string } | null {
  const session = sessionOf(sessionId)
  if (!session) return null
  const opened = session.opened
  if (!opened.deck.slides[slideIndex]) return null
  const toEmu = makeToEmu(opened.deck.size.cx, fitWidthPx)
  pushDeckHistory(session)
  const op: Op = {
    op: 'addSmartArt',
    target: { slide: slideIndex },
    layout,
    items,
    offset: { x: toEmu(xPx), y: toEmu(yPx), cx: toEmu(wPx), cy: toEmu(hPx) },
  }
  const r = runTxn(opened, { ops: [op] })
  if (!r.applied) {
    session.undoStack.pop()
    return null
  }
  const sourceId = r.records?.[0]?.created?.[0]
  if (!sourceId) {
    session.undoStack.pop()
    return null
  }
  return { slide: rebuildOne(sessionId, slideIndex, fitWidthPx)!, sourceId }
}

/** renderer addPicture / addImageBytes / addInk：插入图片（base64 → bytes → addPicture op）。 */
export function addPictureOp(
  sessionId: string,
  slideIndex: number,
  base64: string,
  ext: string,
  xPx: number, yPx: number, wPx: number, hPx: number,
  fitWidthPx: number,
  name?: string,
  descr?: string,
): { slide: Record<string, unknown>; sourceId: string } | { error: 'unsupported'; ext: string } | null {
  const session = sessionOf(sessionId)
  if (!session) return null
  const opened = session.opened
  if (!opened.deck.slides[slideIndex]) return null
  const toEmu = makeToEmu(opened.deck.size.cx, fitWidthPx)
  pushDeckHistory(session)
  const op: Op = {
    op: 'addPicture',
    target: { slide: slideIndex },
    bytes: base64ToBytes(base64),
    ext: ext.toLowerCase(),
    offset: { x: toEmu(xPx), y: toEmu(yPx), cx: toEmu(wPx), cy: toEmu(hPx) },
    ...(name ? { name } : {}),
    ...(descr ? { descr } : {}),
  }
  const r = runTxn(opened, { ops: [op] })
  if (!r.applied) {
    session.undoStack.pop()
    return { error: 'unsupported', ext }
  }
  const sourceId = r.records?.[0]?.created?.[0]
  if (!sourceId) {
    session.undoStack.pop()
    return null
  }
  return { slide: rebuildOne(sessionId, slideIndex, fitWidthPx)!, sourceId }
}

/** renderer addMediaBytes / insertMedia：插入音视频。 */
export function addMediaOp(
  sessionId: string,
  slideIndex: number,
  kind: 'video' | 'audio',
  base64: string,
  ext: string,
  xPx: number, yPx: number, wPx: number, hPx: number,
  fitWidthPx: number,
  name?: string,
  poster?: { base64: string; ext: string },
): { slide: Record<string, unknown>; sourceId: string } | null {
  const session = sessionOf(sessionId)
  if (!session) return null
  const opened = session.opened
  if (!opened.deck.slides[slideIndex]) return null
  const toEmu = makeToEmu(opened.deck.size.cx, fitWidthPx)
  pushDeckHistory(session)
  const op: Op = {
    op: 'addMedia',
    target: { slide: slideIndex },
    kind,
    bytes: base64ToBytes(base64),
    ext: ext.toLowerCase(),
    offset: { x: toEmu(xPx), y: toEmu(yPx), cx: toEmu(wPx), cy: toEmu(hPx) },
    ...(name ? { name } : {}),
    ...(poster ? { poster: { bytes: base64ToBytes(poster.base64), ext: poster.ext.toLowerCase() } } : {}),
  }
  const r = runTxn(opened, { ops: [op] })
  if (!r.applied) {
    session.undoStack.pop()
    return null
  }
  const sourceId = r.records?.[0]?.created?.[0]
  if (!sourceId) {
    session.undoStack.pop()
    return null
  }
  return { slide: rebuildOne(sessionId, slideIndex, fitWidthPx)!, sourceId }
}

/** renderer addModel3d / insertModel3d：插入 3D 模型。 */
export function addModel3dOp(
  sessionId: string,
  slideIndex: number,
  base64: string,
  ext: string,
  xPx: number, yPx: number, wPx: number, hPx: number,
  fitWidthPx: number,
  name?: string,
  poster?: { base64: string; ext: string },
): { slide: Record<string, unknown>; sourceId: string } | null {
  const session = sessionOf(sessionId)
  if (!session) return null
  const opened = session.opened
  if (!opened.deck.slides[slideIndex]) return null
  const toEmu = makeToEmu(opened.deck.size.cx, fitWidthPx)
  pushDeckHistory(session)
  const op: Op = {
    op: 'addModel3d',
    target: { slide: slideIndex },
    bytes: base64ToBytes(base64),
    ext: ext.toLowerCase(),
    offset: { x: toEmu(xPx), y: toEmu(yPx), cx: toEmu(wPx), cy: toEmu(hPx) },
    ...(name ? { name } : {}),
    ...(poster ? { poster: { bytes: base64ToBytes(poster.base64), ext: poster.ext.toLowerCase() } } : {}),
  }
  const r = runTxn(opened, { ops: [op] })
  if (!r.applied) {
    session.undoStack.pop()
    return null
  }
  const sourceId = r.records?.[0]?.created?.[0]
  if (!sourceId) {
    session.undoStack.pop()
    return null
  }
  return { slide: rebuildOne(sessionId, slideIndex, fitWidthPx)!, sourceId }
}

/** renderer replacePictureBytes：更换图片（保持框/z-order/效果）。 */
export function replacePictureOp(
  sessionId: string,
  slideIndex: number,
  sourceId: string,
  base64: string,
  ext: string,
  fitWidthPx: number,
  keepSrcRect?: boolean,
): Record<string, unknown> | { error: 'unsupported'; ext: string } | null {
  const session = sessionOf(sessionId)
  if (!session || !sourceId) return null
  pushDeckHistory(session)
  const op: Op = {
    op: 'replacePicture',
    target: { slide: slideIndex, el: sourceId },
    bytes: base64ToBytes(base64),
    ext: ext.toLowerCase(),
    ...(keepSrcRect ? { keepSrcRect: true } : {}),
  }
  const r = runTxn(session.opened, { ops: [op] })
  if (!r.applied) {
    session.undoStack.pop()
    return { error: 'unsupported', ext }
  }
  return rebuildOne(sessionId, slideIndex, fitWidthPx)
}

// ===== M9b：元素编辑 op（reorder / batchEditTransform / setLink / table / chart）=====

/** renderer reorderElement：层级调整（上移/下移/置顶/置底）。 */
export function reorderElementOp(
  sessionId: string,
  slideIndex: number,
  sourceId: string,
  dir: 'front' | 'back' | 'forward' | 'backward',
  fitWidthPx: number,
): Record<string, unknown> | null {
  const session = sessionOf(sessionId)
  if (!session || !sourceId) return null
  pushDeckHistory(session)
  const op: Op = {
    op: 'reorderElement',
    target: { slide: slideIndex, el: sourceId },
    dir,
  }
  const r = runTxn(session.opened, { ops: [op] })
  if (!r.applied) {
    session.undoStack.pop()
    return null
  }
  return rebuildOne(sessionId, slideIndex, fitWidthPx)
}

/**
 * renderer batchEditTransform：批量 setTransform（对齐/分布/多选旋转的几何都在渲染层
 * 算好，这里只负责整批落模型，与桌面 'slides:batch-edit-transform' 同语义：
 * 一次 txn 多个 setTransform，整批一个 undo 步；不重分配表格网格（legacy parity）。
 */
export function batchEditTransformOp(
  sessionId: string,
  slideIndex: number,
  items: Array<{
    sourceId: string
    xPx: number
    yPx: number
    wPx: number
    hPx: number
    rotationDeg: number
  }>,
  fitWidthPx: number,
): Record<string, unknown> | null {
  const session = sessionOf(sessionId)
  if (!session || !Array.isArray(items) || items.length === 0) return null
  const opened = session.opened
  if (!opened.deck.slides[slideIndex]) return null
  const baseWidthPx = opened.deck.size.cx / EMU_PER_PX_96
  const scale = fitWidthPx / baseWidthPx
  const toEmu = (px: number) => Math.round((px / scale) * EMU_PER_PX_96)
  pushDeckHistory(session)
  const ops: Op[] = items.map((it) => ({
    op: 'setTransform',
    target: { slide: slideIndex, el: it.sourceId },
    box: { x: toEmu(it.xPx), y: toEmu(it.yPx), cx: toEmu(it.wPx), cy: toEmu(it.hPx) },
    rotDeg: it.rotationDeg,
  }))
  const r = runTxn(opened, { ops })
  if (!r.applied) {
    session.undoStack.pop()
    return null
  }
  return rebuildOne(sessionId, slideIndex, fitWidthPx)
}

/** renderer setLink：设置/清除超链接。 */
export function setLinkOp(
  sessionId: string,
  slideIndex: number,
  sourceId: string,
  link: Record<string, unknown> | null,
  fitWidthPx: number,
): Record<string, unknown> | null {
  const session = sessionOf(sessionId)
  if (!session || !sourceId) return null
  pushDeckHistory(session)
  const op: Op = {
    op: 'setLink',
    target: { slide: slideIndex, el: sourceId },
    ...(link ? { link } : { link: null }),
  }
  const r = runTxn(session.opened, { ops: [op] })
  if (!r.applied) {
    session.undoStack.pop()
    return null
  }
  return rebuildOne(sessionId, slideIndex, fitWidthPx)
}

/** renderer editTableCell：表格单元格编辑。 */
export function editTableCellOp(
  sessionId: string,
  slideIndex: number,
  sourceId: string,
  row: number,
  col: number,
  paragraphs: unknown[],
  fitWidthPx: number,
): Record<string, unknown> | null {
  const session = sessionOf(sessionId)
  if (!session || !sourceId) return null
  pushDeckHistory(session)
  const op: Op = {
    op: 'setTableCell',
    target: { slide: slideIndex, el: sourceId },
    row, col, paragraphs,
  }
  const r = runTxn(session.opened, { ops: [op] })
  if (!r.applied) {
    session.undoStack.pop()
    return null
  }
  return rebuildOne(sessionId, slideIndex, fitWidthPx)
}

/** renderer tableStructure：行列增删（kind 与桌面 TableStructureIpcOp 一致）。 */
export function tableStructureOp(
  sessionId: string,
  slideIndex: number,
  sourceId: string,
  kind: 'insert-row' | 'delete-row' | 'insert-col' | 'delete-col',
  index: number,
  fitWidthPx: number,
  before?: boolean,
): { slide: Record<string, unknown>; sourceId: string } | null {
  const session = sessionOf(sessionId)
  if (!session || !sourceId) return null
  pushDeckHistory(session)
  const op: Op = {
    op: 'tableStructure',
    target: { slide: slideIndex, el: sourceId },
    kind,
    index,
    ...(before ? { before: true } : {}),
  }
  const r = runTxn(session.opened, { ops: [op] })
  if (!r.applied) {
    session.undoStack.pop()
    return null
  }
  // tableStructure changes element ids → return new sourceId from records
  const newId = r.records?.[0]?.created?.[0] ?? sourceId
  return { slide: rebuildOne(sessionId, slideIndex, fitWidthPx)!, sourceId: newId }
}

/** renderer tableMerge：合并/拆分单元格（kind/row/col 与桌面 TableMergeIpcOp 一致）。 */
export function tableMergeOp(
  sessionId: string,
  slideIndex: number,
  sourceId: string,
  kind: 'merge-right' | 'merge-down' | 'split',
  row: number,
  col: number,
  fitWidthPx: number,
): { slide: Record<string, unknown>; sourceId: string } | null {
  const session = sessionOf(sessionId)
  if (!session || !sourceId) return null
  pushDeckHistory(session)
  const op: Op = {
    op: 'tableMerge',
    target: { slide: slideIndex, el: sourceId },
    kind,
    row,
    col,
  }
  const r = runTxn(session.opened, { ops: [op] })
  if (!r.applied) {
    session.undoStack.pop()
    return null
  }
  const newId = r.records?.[0]?.created?.[0] ?? sourceId
  return { slide: rebuildOne(sessionId, slideIndex, fitWidthPx)!, sourceId: newId }
}

/** renderer setTableColWidth：拖列宽（引擎字段名 wEmu，与桌面一致）。 */
export function setTableColWidthOp(
  sessionId: string,
  slideIndex: number,
  sourceId: string,
  col: number,
  wEmu: number,
  fitWidthPx: number,
): Record<string, unknown> | null {
  const session = sessionOf(sessionId)
  if (!session || !sourceId) return null
  pushDeckHistory(session)
  const op: Op = {
    op: 'setTableColWidth',
    target: { slide: slideIndex, el: sourceId },
    col, wEmu,
  }
  const r = runTxn(session.opened, { ops: [op] })
  if (!r.applied) {
    session.undoStack.pop()
    return null
  }
  return rebuildOne(sessionId, slideIndex, fitWidthPx)
}

/** renderer setTableRowHeight：拖行高（引擎字段名 hEmu，与桌面一致）。 */
export function setTableRowHeightOp(
  sessionId: string,
  slideIndex: number,
  sourceId: string,
  row: number,
  hEmu: number,
  fitWidthPx: number,
): Record<string, unknown> | null {
  const session = sessionOf(sessionId)
  if (!session || !sourceId) return null
  pushDeckHistory(session)
  const op: Op = {
    op: 'setTableRowHeight',
    target: { slide: slideIndex, el: sourceId },
    row, hEmu,
  }
  const r = runTxn(session.opened, { ops: [op] })
  if (!r.applied) {
    session.undoStack.pop()
    return null
  }
  return rebuildOne(sessionId, slideIndex, fitWidthPx)
}

/** renderer editTableStyle：表格样式（styleName 预设 / firstRow/bandRow 等开关透传给 setTableStyle）。 */
export function setTableStyleOp(
  sessionId: string,
  slideIndex: number,
  sourceId: string,
  style: Record<string, unknown>,
  fitWidthPx: number,
): Record<string, unknown> | null {
  const session = sessionOf(sessionId)
  if (!session || !sourceId || !style || typeof style !== 'object') return null
  pushDeckHistory(session)
  const op: Op = {
    op: 'setTableStyle',
    target: { slide: slideIndex, el: sourceId },
    ...style,
  }
  const r = runTxn(session.opened, { ops: [op] })
  if (!r.applied) {
    session.undoStack.pop()
    return null
  }
  return rebuildOne(sessionId, slideIndex, fitWidthPx)
}

/** renderer editChart / setChart：图表编辑（引擎要求 patch 包装对象）。 */
export function editChartOp(
  sessionId: string,
  slideIndex: number,
  sourceId: string,
  patch: Record<string, unknown>,
  fitWidthPx: number,
): Record<string, unknown> | null {
  const session = sessionOf(sessionId)
  if (!session || !sourceId) return null
  pushDeckHistory(session)
  const op: Op = {
    op: 'setChart',
    target: { slide: slideIndex, el: sourceId },
    ...(patch && typeof patch === 'object' ? { patch } : { patch: {} }),
  }
  const r = runTxn(session.opened, { ops: [op] })
  if (!r.applied) {
    session.undoStack.pop()
    return null
  }
  return rebuildOne(sessionId, slideIndex, fitWidthPx)
}

// ===== M9c：元素剪贴板（copy / paste / duplicate）=====
// 壳内进程内剪贴板（与桌面 elementClipboard 同语义，不经 OS 剪贴板）。

interface ElementClipboard {
  items: ElementClipboardItem[]
  /** 源 slideIndex（用于 cascade 偏移计算；null = cut 模式） */
  sourceSlideIndex: number | null
}

let elementClipboard: ElementClipboard | null = null

/** renderer copyElements：复制元素到壳内剪贴板。返回复制的数量。 */
export function copyElementsOp(
  sessionId: string,
  slideIndex: number,
  sourceIds: string[],
  cut?: boolean,
): number {
  const session = sessionOf(sessionId)
  if (!session || !Array.isArray(sourceIds) || sourceIds.length === 0) return 0
  const opened = session.opened
  const slide = opened.deck.slides[slideIndex]
  if (!slide) return 0
  const items: ElementClipboardItem[] = []
  for (const id of sourceIds) {
    const el = slide.elements.find((e) => e.id === id)
    if (el) {
      items.push(copyElementData(opened, slide, el as unknown as SlideElement))
    }
  }
  if (items.length === 0) return 0
  elementClipboard = {
    items,
    sourceSlideIndex: cut ? null : slideIndex,
  }
  // cut 模式：复制后删除原元素
  if (cut) {
    pushDeckHistory(session)
    const ops: Op[] = sourceIds.map((id) => ({
      op: 'deleteElement' as const,
      target: { slide: slideIndex, el: id },
    }))
    const r = runTxn(opened, { ops, isolation: 'per_op' })
    if (!r.applied) {
      session.undoStack.pop()
    }
  }
  return items.length
}

/** renderer pasteElements：粘贴元素（壳内剪贴板 → pasteElements op）。 */
export function pasteElementsOp(
  sessionId: string,
  slideIndex: number,
  fitWidthPx: number,
  dxPx?: number,
  dyPx?: number,
): { slide: Record<string, unknown>; sourceIds: string[] } | null {
  const session = sessionOf(sessionId)
  if (!session || !elementClipboard?.items.length) return null
  const opened = session.opened
  if (!opened.deck.slides[slideIndex]) return null
  const toEmu = makeToEmu(opened.deck.size.cx, fitWidthPx)
  // cascade 偏移：同页粘贴偏移 0，跨页粘贴偏移 16px（与桌面 pasteShiftPx 语义一致）
  const samePage = elementClipboard.sourceSlideIndex === slideIndex
  const shiftPx = samePage ? 0 : 16
  const dx = dxPx !== undefined ? toEmu(dxPx) : toEmu(shiftPx)
  const dy = dyPx !== undefined ? toEmu(dyPx) : toEmu(shiftPx)
  pushDeckHistory(session)
  const op: Op = {
    op: 'pasteElements',
    target: { slide: slideIndex },
    items: elementClipboard.items,
    dx, dy,
  }
  const r = runTxn(opened, { ops: [op] })
  if (!r.applied) {
    session.undoStack.pop()
    return null
  }
  const sourceIds = r.records?.[0]?.created ?? []
  if (!sourceIds.length) {
    session.undoStack.pop()
    return null
  }
  return { slide: rebuildOne(sessionId, slideIndex, fitWidthPx)!, sourceIds }
}

/** renderer duplicateElements：原地复制（⌘D / 拖拽复制）。 */
export function duplicateElementsOp(
  sessionId: string,
  slideIndex: number,
  sourceIds: string[],
  dxPx: number,
  dyPx: number,
  fitWidthPx: number,
): { slide: Record<string, unknown>; sourceIds: string[] } | null {
  const session = sessionOf(sessionId)
  if (!session || !Array.isArray(sourceIds) || sourceIds.length === 0) return null
  const opened = session.opened
  const slide = opened.deck.slides[slideIndex]
  if (!slide) return null
  // 与桌面同款：copyElementData → pasteElements op（不触碰剪贴板）
  const items: ElementClipboardItem[] = []
  for (const id of sourceIds) {
    const el = slide.elements.find((e) => e.id === id)
    if (el) {
      items.push(copyElementData(opened, slide, el as unknown as SlideElement))
    }
  }
  if (items.length === 0) return null
  const toEmu = makeToEmu(opened.deck.size.cx, fitWidthPx)
  pushDeckHistory(session)
  const op: Op = {
    op: 'pasteElements',
    target: { slide: slideIndex },
    items,
    dx: toEmu(dxPx),
    dy: toEmu(dyPx),
  }
  const r = runTxn(opened, { ops: [op] })
  if (!r.applied) {
    session.undoStack.pop()
    return null
  }
  const newIds = r.records?.[0]?.created ?? []
  if (!newIds.length) {
    session.undoStack.pop()
    return null
  }
  return { slide: rebuildOne(sessionId, slideIndex, fitWidthPx)!, sourceIds: newIds }
}

/** renderer addInk：手绘墨迹提交（一张透明 PNG picture 元素）。 */
export function addInkOp(
  sessionId: string,
  slideIndex: number,
  base64: string,
  xPx: number, yPx: number, wPx: number, hPx: number,
  fitWidthPx: number,
  payload?: string,
): { slide: Record<string, unknown>; sourceId: string } | null {
  const session = sessionOf(sessionId)
  if (!session) return null
  const opened = session.opened
  const slide = opened.deck.slides[slideIndex]
  if (!slide) return null
  const toEmu = makeToEmu(opened.deck.size.cx, fitWidthPx)
  pushDeckHistory(session)
  const op: Op = {
    op: 'addPicture',
    target: { slide: slideIndex },
    bytes: base64ToBytes(base64),
    ext: 'png',
    offset: {
      x: toEmu(xPx), y: toEmu(yPx),
      cx: Math.max(1, toEmu(wPx)),
      cy: Math.max(1, toEmu(hPx)),
    },
    name: `aislides-ink ${Date.now().toString(36)}`,
    ...(payload ? { descr: payload } : {}),
  }
  const r = runTxn(opened, { ops: [op] })
  if (!r.applied) {
    session.undoStack.pop()
    return null
  }
  const sourceId = r.records?.[0]?.created?.[0]
  if (!sourceId) {
    session.undoStack.pop()
    return null
  }
  return { slide: rebuildOne(sessionId, slideIndex, fitWidthPx)!, sourceId }
}