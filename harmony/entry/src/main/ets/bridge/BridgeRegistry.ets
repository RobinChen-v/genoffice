/**
 * BridgeRegistry — 桥方法注册表，替代 DesktopBridge.bridgeCall 的 44 case switch。
 *
 * 设计目标：
 *   1. 注册表是所有已注册方法的单一事实来源（keys() 可用于门禁对账）
 *   2. 新增方法 = 添加一行 register() 调用，不修改 bridgeCall 主体
 *   3. 参数处理逻辑封装在每个 handler 闭包内（与原 switch case 语义完全一致）
 *
 * 使用方式：
 *   const registry = new BridgeRegistry();
 *   registry.register('openFileJson', (args) => bridge.openFileJson(args[0] || ''));
 *   const result = await registry.call('openFileJson', ['path']);
 */
export class BridgeRegistry {
  private handlers: Map<string, (args: string[]) => Promise<string>> = new Map();

  /** 注册一个桥方法处理函数 */
  register(name: string, handler: (args: string[]) => Promise<string>): void {
    this.handlers.set(name, handler);
  }

  /** 调用已注册的桥方法；未注册则返回 unknown method 错误 */
  call(name: string, args: string[]): Promise<string> {
    const handler = this.handlers.get(name);
    if (handler) {
      return handler(args);
    }
    return Promise.resolve(JSON.stringify({ ok: false, error: 'unknown method: ' + name }));
  }

  /** 检查方法是否已注册 */
  has(name: string): boolean {
    return this.handlers.has(name);
  }

  /** 返回所有已注册方法名（用于门禁对账） */
  keys(): string[] {
    const result: string[] = [];
    this.handlers.forEach((_v: (args: string[]) => Promise<string>, k: string) => {
      result.push(k);
    });
    return result;
  }
}