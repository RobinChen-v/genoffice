/**
 * 系统「打开方式」/「用 GenOffice 打开」传入的文件 URI 中转。
 *
 * 时序问题：EntryAbility 的 onCreate/onNewWant 拿不到页面实例，而 Index 页面又可能
 * 早于（冷启动：page 先建、want 随后？不，want 先到）或晚于 want 存在，因此用模块级
 * 单例做一次性投递：
 *   - 页面尚未就绪 → 暂存 pendingUri，等 onReady 时立刻回调；
 *   - 页面已就绪（热启动 onNewWant）→ 直接回调已注册的 handler。
 *
 * 只存 URI 不读字节：读取交给既有文件桥（fs.openSync + taskpool），
 * want 分发时系统已授予该 URI 的临时读权限。
 */
export class IncomingOpen {
  private static pendingUri: string = '';
  private static handler: ((uri: string) => void) | null = null;

  /** EntryAbility 收到带 uri 的 want 时调用（冷/热启动共用）。 */
  static post(uri: string): void {
    const u: string = uri === undefined || uri === null ? '' : uri.trim();
    if (u.length === 0) {
      return;
    }
    if (IncomingOpen.handler !== null) {
      IncomingOpen.handler(u);
      return;
    }
    IncomingOpen.pendingUri = u;
  }

  /** Index 页面 Web 组件就绪后注册 handler；已有暂存 URI 时立即投递一次。 */
  static onReady(handler: (uri: string) => void): void {
    IncomingOpen.handler = handler;
    const u: string = IncomingOpen.pendingUri;
    if (u.length > 0) {
      IncomingOpen.pendingUri = '';
      handler(u);
    }
  }
}