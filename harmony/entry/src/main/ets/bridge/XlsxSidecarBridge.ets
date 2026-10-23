import xlsxSidecar from 'libxlsx_sidecar.so';
import { taskpool } from '@kit.ArkTS';

/**
 * R5-1: @Concurrent 函数 — 在 TaskPool 子线程执行 NAPI handle 调用。
 *
 * ArkTS @Concurrent 限制：只能用 import 变量和入参，不能调模块级函数或 this。
 * xlsxSidecar 是模块级 import，因此可以在此函数中直接使用。
 *
 * NAPI 模块线程安全：libxlsx_sidecar.so 的 handle(requestJson) 是无状态的单次调用
 * （每次请求带唯一 requestId，引擎内部按 sessionId 隔离会话），多线程并发调用安全。
 */
@Concurrent
function xlsxSidecarHandle(requestJson: string): string {
  return xlsxSidecar.handle(requestJson);
}

/**
 * sheets xlsx 引擎的进程内 NAPI 桥（M4 §4 方案 A 落地，R5-1 TaskPool 化）。
 *
 * 背景：商业 HarmonyOS NEXT SDK 没有 @ohos.process.childprocess，无法 childProcess.fork
 * 拉起 M4 编译的独立 ELF；唯一原生子进程入口 startNativeChildProcess 也要求 .so + 入参:fd，
 * 工程更重。改为把 xlsx-engine 的 main.rs 协议（stdin/stdout JSON 行）降维成 NAPI 模块
 * `libxlsx_sidecar.so` 的单一同步函数 handle(requestJson): string —— 每次调用 = 一行协议，
 * 与桌面 sidecar 的 {version, requestId, command, result|error} 完全一致。
 *
 * R5-1 改进：所有 NAPI handle 调用通过 TaskPool 子线程执行，避免大文件 open/save
 * 阻塞主线程（数百 ms → watchdog THREAD_BLOCK_6S）。TaskPool 失败时 fallback 主线程。
 */
export class XlsxSidecarBridge {
  /** 单例（Index.ets 持有绑定实例，与 DesktopBridge 共用 ctx）。 */
  private static instance: XlsxSidecarBridge | null = null;
  private seq: number = 0;

  static getInstance(): XlsxSidecarBridge {
    if (XlsxSidecarBridge.instance === null) {
      XlsxSidecarBridge.instance = new XlsxSidecarBridge();
    }
    return XlsxSidecarBridge.instance;
  }

  /**
   * 启动自检：模块已加载 + handle FFI 可调用（不 unwrap，未知命令返回 ok:false JSON
   * 即为链路正常）。只用于 DesktopBridge 构造时的 hilog 面包屑，不参与业务。
   * 保持同步：构造函数调用，不能 async。
   */
  probe(): string {
    const request: string = JSON.stringify({ 'version': 1, 'requestId': 'probe', 'command': '__probe__' });
    return xlsxSidecar.handle(request);
  }

  /**
   * 低层命令通道：构造请求6请求 JSON → TaskPool 子线程调 NAPI handle → 返回 sidecar 响应 JSON。
   * TaskPool 失败时 fallback 主线程同步调用（与 readFilePayload 同模式）。
   */
  private async run(command: string, fields: Record<string, Object>): Promise<string> {
    this.seq += 1;
    const request: Record<string, Object> = {
      'version': 1,
      'requestId': 'ohos-' + this.seq,
      'command': command,
    };
    const keys = Object.keys(fields);
    for (let i = 0; i < keys.length; i++) {
      request[keys[i]] = fields[keys[i]];
    }
    const requestJson: string = JSON.stringify(request);
    try {
      return await taskpool.execute(xlsxSidecarHandle, requestJson) as string;
    } catch (e) {
      console.warn('[GenOffice] xlsxSidecar TaskPool fail, fallback to main thread: '
        + (e instanceof Error ? e.message : String(e)));
      return xlsxSidecar.handle(requestJson);
    }
  }

  /** 解析 sidecar 响应 JSON；ok=false 时抛 Error(code: message)。 */
  private unwrap(responseJson: string): Record<string, Object> {
    let parsed: Record<string, Object>;
    try {
      parsed = JSON.parse(responseJson) as Record<string, Object>;
    } catch (e) {
      throw new Error('xlsx sidecar: 非 JSON 响应 ' + String(e));
    }
    if (parsed['ok'] !== true) {
      const err = parsed['error'] as Record<string, Object> | undefined;
      const code = err === undefined ? 'unknown' : String(err['code']);
      const message = err === undefined ? 'sidecar 返回失败' : String(err['message']);
      throw new Error(code + ': ' + message);
    }
    return parsed;
  }

  /** sidecar open 命令：path 必须是真实文件系统路径（快照落盘后调用）。 */
  async open(path: string, locale: string, shortDateFormat: string): Promise<Record<string, Object>> {
    const fields: Record<string, Object> = { 'path': path, 'locale': locale };
    if (shortDateFormat.length > 0) {
      fields['shortDateFormat'] = shortDateFormat;
    }
    const response = this.unwrap(await this.run('open', fields));
    const result = response['result'] as Record<string, Object> | undefined;
    if (result === undefined) {
      throw new Error('xlsx sidecar: open 缺 result');
    }
    return result;
  }

  /** sidecar create_blank：生成真实空 xlsx 并开引擎会话（新建空白表格与打开文件同链路）。 */
  async createBlank(path: string, sheetName: string): Promise<Record<string, Object>> {
    const fields: Record<string, Object> = { 'path': path };
    if (sheetName.length > 0) {
      fields['sheetName'] = sheetName;
    }
    const response = this.unwrap(await this.run('create_blank', fields));
    const result = response['result'] as Record<string, Object> | undefined;
    if (result === undefined) {
      throw new Error('xlsx sidecar: create_blank 缺 result');
    }
    return result;
  }

  /** sidecar close 命令（会话释放）。失败仅告警，不中断。 */
  async close(sessionId: string): Promise<void> {
    try {
      await this.run('close', { 'sessionId': sessionId });
    } catch (e) {
      console.error('[GenOffice] xlsClose 失败: ' + String(e));
    }
  }


  /** 透传 read_range：range 对象（startRow/endRow/startColumn/endColumn）原样下发。 */
  async readRange(sessionId: string, sheetId: string, range: Record<string, Object>): Promise<string> {
    const fields: Record<string, Object> = { 'sessionId': sessionId, 'sheetId': sheetId, 'range': range };
    return await this.run('read_range', fields);
  }

  /** 透传 read_formula_cells。 */
  async readFormulaCells(sessionId: string, sheetId: string): Promise<string> {
    return await this.run('read_formula_cells', { 'sessionId': sessionId, 'sheetId': sheetId });
  }

  /** 透传 read_media（图片/图表资源）。 */
  async readMedia(sessionId: string, visualId: string): Promise<string> {
    return await this.run('read_media', { 'sessionId': sessionId, 'visualId': visualId });
  }

  /**
   * M5 v1 保存：把单元格值编辑应用到会话快照，生成新快照并重开（返回新
   * sessionId 的 metadata JSON）。命令失败（含不支持类型）返回 ok:false。
   * structuralOps（可选）：insert/remove rows/cols + merge/unmerge cells。
   */
  async saveCells(sessionId: string, targetPath: string, edits: Array<Object>, structuralOps?: Array<Object>): Promise<string> {
    const req: Record<string, Object> = {
      'sessionId': sessionId, 'targetPath': targetPath, 'edits': edits
    };
    if (structuralOps !== undefined && structuralOps.length > 0) {
      req['structuralOps'] = structuralOps;
    }
    return await this.run('save_cells', req);
  }

  /**
   * M5 保存（原子交换版）：与 saveCells 同语义，但**不关闭源会话**——调用方
   * 在写回用户 URI 成功后再自行 close(sessionId)。另存为被取消或写回失败时，
   * 源会话保持可用，渲染层重试不会撞上 "Unknown workbook session"。
   */
  async saveCellsKeepOld(sessionId: string, targetPath: string, edits: Array<Object>, structuralOps?: Array<Object>): Promise<string> {
    const req: Record<string, Object> = {
      'sessionId': sessionId, 'targetPath': targetPath, 'edits': edits
    };
    if (structuralOps !== undefined && structuralOps.length > 0) {
      req['structuralOps'] = structuralOps;
    }
    return await this.run('save_cells_keep_old', req);
  }

  /**
   * M11 多 sheet 操作保存：sheetOps[{kind,sheetId,name,sourceSheetId,newName,hidden}]
   * + sheetOrder[] + 可选 edits/structuralOps → 引擎 save_sheet_ops。keepOld=true
   * （写回用户 URI 成功后才由桥 close 源会话）。
   */
  async saveSheetOpsKeepOld(
    sessionId: string,
    targetPath: string,
    edits: Array<Object>,
    structuralOps: Array<Object>,
    sheetOps: Array<Object>,
    sheetOrder: Array<string>,
  ): Promise<string> {
    const req: Record<string, Object> = {
      'sessionId': sessionId, 'targetPath': targetPath, 'edits': edits,
      'structuralOps': structuralOps, 'sheetOps': sheetOps,
      'sheetOrder': sheetOrder, 'keepOld': true,
    };
    return await this.run('save_sheet_ops', req);
  }

  /** 透传 recalc_cells：edits[{sheetId,row,column,input}] + reads[{sheetId,range}] → 重算结果。 */
  async recalcCells(sessionId: string, edits: Array<Object>, reads: Array<Object>): Promise<string> {
    return await this.run('recalc_cells', { 'sessionId': sessionId, 'edits': edits, 'reads': reads });
  }

  /** 透传 archive_manifest / read_entries / scan_entries / save_archive（保存链路用）。 */
  async archiveManifest(path: string): Promise<string> {
    return await this.run('archive_manifest', { 'path': path });
  }

  async readEntries(path: string, entries: Array<string>, outputDir: string): Promise<string> {
    return await this.run('read_entries', { 'path': path, 'entries': entries, 'outputDir': outputDir });
  }

  async scanEntries(path: string, entries: Array<string>, needle: string): Promise<string> {
    return await this.run('scan_entries', { 'path': path, 'entries': entries, 'needle': needle });
  }

  async saveArchive(sourcePath: string, targetPath: string,
    replacements: Array<Object>, removals: Array<string>, additions: Array<Object>): Promise<string> {
    return await this.run('save_archive', {
      'sourcePath': sourcePath,
      'targetPath': targetPath,
      'replacements': replacements,
      'removals': removals,
      'additions': additions,
    });
  }
}