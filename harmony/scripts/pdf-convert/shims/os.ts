// node:os shim —— sfnt.ts 的 fontDirs() 用它拼用户字体目录；鸿蒙 webview 无家目录，
// 返回空串即可（该目录随后由 fs shim 的 readdirSync 抛错挡掉，索引保持为空）。
export function homedir(): string {
  return ''
}