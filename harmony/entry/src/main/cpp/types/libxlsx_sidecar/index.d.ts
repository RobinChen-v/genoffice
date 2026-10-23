/**
 * xlsx-sidecar NAPI 模块(HarmonyOS in-process bridge)。
 *
 * 与 M4 ELF sidecar 的 stdin/stdout JSON 行协议完全一致:每次调用传入一个
 * 请求 JSON 字符串 `{version, requestId, command, ...}`,返回响应 JSON 字符串
 * `{version, requestId, ok, result|error}`。ArkTS 侧(DesktopBridge)负责把
 * sheets renderer 的 IPC 请求(selectWorkbook/openWorkbookSession/readWorkbookRange
 * 等)翻译成这些命令,与桌面主进程 sheets-main.ts 的职责对齐。
 */
export const handle: (requestJson: string) => string;