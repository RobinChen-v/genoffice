// node:path shim —— font-metrics 只用到 join（拼字体路径）与 dirname（拼缓存文件路径），
// 两者都只在「能读到系统字体」的路径上被真正消费；空索引下不会产生可见影响。
// 这里给出等价语义的最小子集，避免为两行拼接引入整套 polyfill。
export function join(...parts: string[]): string {
  return parts.filter((p) => p !== undefined && p !== null && p !== '').join('/')
}
export function dirname(p: string): string {
  const s = String(p ?? '')
  const i = s.lastIndexOf('/')
  return i <= 0 ? (i === 0 ? '/' : '.') : s.slice(0, i)
}
export const sep = '/'
export function resolve(...parts: string[]): string {
  return join(...parts)
}
export function basename(p: string): string {
  const s = String(p ?? '')
  const i = s.lastIndexOf('/')
  return i < 0 ? s : s.slice(i + 1)
}