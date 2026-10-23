// node:fs shim —— 鸿蒙 webview 里没有可扫的系统字体目录，@genoffice/font-metrics 的
// getFontIndex() 是本桥转换路径上唯一触达 fs 的地方：它遍历 fontDirs() → fontFiles()
// → readdirSync（该调用已经在 try/catch 里）→ 抛错即得**空索引**，于是
// isFamilyInstalled=false / findSystemFont=null / familyVerticalMetrics=null，
// 引擎照常走自己的字形回退（字体命名退化为度量兼容的替代族），转换不中断。
//
// 其余读操作在空索引下不可达：故意抛明确错误而不是返回假数据 —— 一旦上游将来把
// 真实字体读取挪进转换路径，这里会立刻炸出来，而不是静默产出错误的度量。
export function readdirSync(): never {
  throw new Error('node:fs unavailable: harmony webview exposes no system font directories')
}
export function openSync(): never {
  throw new Error('node:fs unavailable')
}
export function readSync(): never {
  throw new Error('node:fs unavailable')
}
export function readFileSync(): never {
  throw new Error('node:fs unavailable')
}
export function statSync(): never {
  throw new Error('node:fs unavailable')
}
// close/write 侧：空索引下不可达；不抛（metrics 的 saveCache 在 finally/缓存路径上，
// 抛错没有诊断价值，且 configureMetricsCache 在壳内从不调用 → cacheFile 恒为 null）
export function closeSync(): void {}
export function mkdirSync(): void {}
export function writeFileSync(): void {}
export const promises = {} as Record<string, unknown>
export const createWriteStream = undefined as unknown
export const createReadStream = undefined as unknown