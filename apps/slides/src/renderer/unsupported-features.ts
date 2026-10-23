/**
 * 鸿蒙版「入口可见但不可用」登记表（批次 E-6）。
 *
 * 背景：makeBridge 的 Proxy 对壳侧未实现的方法静默 resolve(undefined)，渲染层拿到 undefined
 * 后走 `if (r)` / `if (n > 0)` 的空分支直接结束 —— 用户观感是「点了没反应」，比报错更糟。
 * 本表把这类入口收口：命中即 toast「此功能在鸿蒙版暂未实现」，调用方随后 return / 置灰。
 *
 * 清单与 harmony/scripts/bridge-coverage-allowlist.json 里 slidesApi 的缺口**逐一对应**
 * （verify-all 的 checkSlidesUnsupportedWiring 断言，防漂移）：
 *   - UNSUPPORTED_ACTIONS  单发用户动作 → 每次调用都提示（同方法 1.5s 去重）
 *   - UNSUPPORTED_AMBIENT  自动/高频/订阅路径 → 不提示（提示只会变成噪音）
 * 已补实现、从缺口消失的三个方法（exportImages / pickExportDir / savePicture）不在表内。
 */
import { t } from './i18n/locale'
import { showToast } from './components/toast-bus'

/** 单发用户动作：首环缺口方法名。命中即提示 + 调用方 return。 */
export const UNSUPPORTED_ACTIONS: readonly string[] = [
  'clipboardExternal', // Ctrl+V 读系统剪贴板（内部也没有可粘贴内容时提示）
  'editTransformMulti', // 组内元素的拖动/旋转（顶层走 batchEditTransform，已实现）
  'getLink', // 插入→链接：元素的既有链接读不出来（setLink 已实现，getLink 从渲染树读）
  'applyHeaderFooter', // 插入→页眉和页脚 → 确定（对话框可开，应用写不进模型）
  'setAdvanceTimes', // 排练计时对话框「保存」
  'addMediaBytes', // 拖入音频/视频（按钮走 insertMedia，另见 UNSUPPORTED_STUBS 登记）
  'masterDeleteElement', // 母版视图删除元素
  'getChartData', // 图表数据面板
  'getMediaData', // 媒体预览
  'editConnectorEndpoints', // 编辑连接线端点

]

/** ACTIONS 之外、被同一处 guard 顺带覆盖的方法（同一函数顶部即返回，不再单独插 guard）。 */
export const UNSUPPORTED_ACTION_COVERS: Readonly<Record<string, readonly string[]>> = {
  // copyElements 已实现，copyElementsImage 不再被覆盖
}

/**
 * 第二层：壳侧**键存在**但恒 `Promise.resolve(null)` 的桩（比缺口更隐蔽 —— 覆盖门禁看不见它）。
 * 这些方法在 ppt-bridge 里没有对应的引擎 op（元素工厂/表格/图表/批注/节），功能同样不可用。
 * 本轮只给「用户点得到的入口」插 guard；AI 内部调用点（slides-skill / AiPanel）保持静默，
 * 由模型自己按 null 降级（见 slides-stub-registry.json 的 aiOnly）。
 */
export const UNSUPPORTED_STUBS: readonly string[] = [
  'insertMedia', // 壳内无系统文件选择器
  'insertModel3d', // 壳内无系统文件选择器
  'repasteSlide', // 粘贴选项浮动条
  'addComment',
  'deleteComment',
  'setSections', // 节管理
  'addSection',
  'renameSection',
  'removeSection',
  'removeSectionSlides',
  'moveSection',
]

/**
 * 环境/自动路径：壳侧同样未实现，但用户不期待可见结果，或调用频率极高（每次都提示会变噪音）。
 * 保留登记是为了让门禁能算出「41 个缺口 = 18 guard + 1 covers + 18 ambient」这笔账。
 */
export const UNSUPPORTED_AMBIENT: readonly string[] = [
  'clipboardProbe', // focus 事件自动探测剪贴板
  'nativeClipboard', // 编辑文本时的原生剪贴板（Base64 通道；高频）
  'privateFontFaces', // 文档内嵌字体自动同步
  'privateFontData',
  'presenterEnd', // 放映者视图：壳侧 presenterStart 返回 {audience:false}（无观众窗口）
  'presenterSync',
  'presenterInk',
  'presenterSwap',
  'audienceReady', // 观众视图：观众窗口不打开 → 整条链路不可达
  'audienceNav',
  'onAudienceNav', // 8 个订阅：壳侧无派发方（属 T-3 订阅治理）
  'onDeckChanged',
  'onFontsChanged',
  'onHistoryChanged',
  'onOpened',
  'onRenamed',
  'onShowInk',
  'onShowSync',
]

const ACTIONS = new Set<string>([...UNSUPPORTED_ACTIONS, ...UNSUPPORTED_STUBS])

/**
 * R4-4：真缺口（UNSUPORTED_ACTIONS）优先运行时桥探测 —— 壳侧补实现后 guard 自动放行，
 * 不再依赖手写清单更新。恒空桩（STUBS）`__has` 探测不到（键存在且是 function），
 * 保持手写硬守卫（恒空桩治理见重构计划 R5）。
 *
 * `__has` 由壳侧 mock/桥基座提供（同步幂等查询，无时序依赖）：真缺失返回 false → guard 生效；
 * 壳侧补实现后返回 true → guard 自动失效。桥未就绪（`__has` 不存在）时回落手写清单判定。
 */
function runtimeImplemented(method: string): boolean {
  const has = (globalThis as Record<string, unknown>).slidesApi as
    | { __has?: (m: string) => boolean }
    | undefined
  if (!has || typeof has.__has !== 'function') { return false }
  try { return has.__has(method) === true } catch { return false }
}

/** 是否登记为「鸿蒙版未实现」（不做提示，供置灰/标签用）。 */
export function isUnsupported(method: string): boolean {
  if (!ACTIONS.has(method)) return false
  // 恒空桩：__has 探测不到，永远按登记表判定
  if (UNSUPPORTED_STUBS.includes(method)) return true
  // 真缺口：壳侧补实现后自动放行
  return !runtimeImplemented(method)
}

/** 同一方法的提示去重窗口：guard 可能同时被点击与快捷键触发。 */
const TOAST_DEDUP_MS = 1500
const notified = new Map<string, number>()

/**
 * 命中登记表 → 提示一次并返回 true（调用方应当 return / 中止本动作）。
 * 未登记的方法返回 false，调用方继续走原逻辑。
 * R4-4：真缺口方法在壳侧补实现后，运行时探测放行 —— guard 不再挡住已实现的功能。
 */
export function unsupported(method: string): boolean {
  if (!isUnsupported(method)) return false
  const now = Date.now()
  const last = notified.get(method) ?? 0
  if (now - last > TOAST_DEDUP_MS) {
    notified.set(method, now)
    showToast(t('appStatusUnsupported'), 'error')
  }
  return true
}

/** 置灰项的标签：`剪贴板（暂不支持）`（复用 ribbonNotSupported，无需新增 i18n）。 */
export function unsupportedLabel(label: string, method: string): string {
  return isUnsupported(method) ? t('ribbonNotSupported', { name: label }) : label
}