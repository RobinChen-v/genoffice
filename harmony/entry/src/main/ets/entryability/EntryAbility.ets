import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';
import { IncomingOpen } from '../common/IncomingOpen';

const TAG = 'GenOffice';

/**
 * 从 want 里取出被打开文件的 URI。
 * 常规路径是 want.uri（ohos.want.action.viewData 分发带 uri）；部分分发链把 uri
 * 放在 want.parameters 里（key 不固定），兜底扫一遍参数取 file:// 值。
 */
function uriFromWant(want: Want): string {
  const direct: string = want.uri ?? '';
  if (direct.length > 0) {
    return direct;
  }
  const params: Record<string, Object> = want.parameters ?? {};
  const keys: string[] = Object.keys(params);
  for (let i = 0; i < keys.length; i++) {
    const v: Object = params[keys[i]];
    if (typeof v === 'string') {
      const s: string = v as string;
      if (s.startsWith('file://')) {
        return s;
      }
    }
  }
  return '';
}

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    hilog.info(0x0000, TAG, 'ability onCreate');
    // 冷启动（含从文件管理器「打开方式」拉起）：先暂存 URI，页面就绪后投递
    const uri: string = uriFromWant(want);
    if (uri.length > 0) {
      hilog.info(0x0000, TAG, 'onCreate want uri: %{public}s', uri);
      IncomingOpen.post(uri);
    }
  }

  onNewWant(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    // 应用已在运行（热启动）：页面 handler 已注册 → 直接开对应 app tab
    const uri: string = uriFromWant(want);
    if (uri.length > 0) {
      hilog.info(0x0000, TAG, 'onNewWant want uri: %{public}s', uri);
      IncomingOpen.post(uri);
    }
  }

  onDestroy(): void {
    hilog.info(0x0000, TAG, 'ability onDestroy');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(0x0000, TAG, 'loadContent failed: %{public}s', JSON.stringify(err));
        return;
      }
      hilog.info(0x0000, TAG, 'loadContent succeed');
    });
  }
}