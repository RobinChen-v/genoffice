import { picker, fileIo as fs, fileShare } from '@kit.CoreFileKit';
import { pasteboard, BusinessError } from '@kit.BasicServicesKit';
import { util } from '@kit.ArkTS';
import { taskpool } from '@kit.ArkTS';
import { common, Want, abilityAccessCtrl } from '@kit.AbilityKit';
import { http } from '@kit.NetworkKit';
import { photoAccessHelper } from '@kit.MediaLibraryKit';
import { screenshot } from '@kit.ArkUI';
import { image } from '@kit.ImageKit';
import { XlsxSidecarBridge } from './XlsxSidecarBridge';
import { BridgeRegistry } from './BridgeRegistry';

/**
 * 打开文件选择器的可选后缀。桌面版 docs:open 只允许 docx，鸿蒙壳按需求放宽为
 * 全部 office 文件（docs/sheets/slides/pdf/markdown 各 shell 入口共用同一选择器，
 * 具体渲染能力由 JS 侧按扩展名分发）。
 */
const OFFICE_SUFFIX_FILTERS: string[] =
  ['.docx', '.xlsx', '.xlsm', '.xls', '.csv', '.pptx', '.pdf', '.md'];

/**
 * PDF 签名库（M7）：语义对齐桌面版 apps/pdf/src/main/signature-store.ts —— 渲染层传的是
 * SignatureData（无 id），由「主进程侧」补 id/createdAt、同图去重、newest-first、上限 10 条；
 * 渲染层只认 SavedSignature[]。鸿蒙壳把这份存储落在 filesDir/genoffice-pdf-signatures.json。
 */
interface PdfSignatureData {
  kind: string;
  width: number;
  height: number;
  /** kind==='image'：base64 PNG（无 data: 前缀） */
  image?: string;
  /** kind==='strokes'：手写笔画折线点（每条至少 2 个点） */
  paths?: Array<Array<number>>;
}

interface PdfSavedSignature {
  id: string;
  createdAt: number;
  data: PdfSignatureData;
}

/**
 * M7-3 AI 图像/搜索链。桌面语义：apps/sheets/src/main/sheets-main.ts（readLocalImage / ai:fetch-image）
 * 与 packages/ai-search/src/index.ts（webSearch / imageSearch 的 DuckDuckGo 无 key 兜底路径）。
 * 渲染层直接消费这些形状（r.results.forEach / r.images.map / image.mediaType），形状错会当场
 * TypeError —— 旧的 `webSearch: () => Promise.resolve([])` 就是这个坑。Genspark 账号类能力
 * （生图 / 带 key 的网搜）在鸿蒙没有登录态也没有 Node 子进程，按「形状正确的显式降级」处理。
 */
const MAX_AI_IMAGE_BYTES: number = 20 * 1024 * 1024;

/**
 * 聊天附件（AI 面板）：对齐 apps/sheets/src/main/sheets-main.ts 的
 * ATTACHMENT_MAX_BYTES / ATTACHMENT_TEXT_EXTS / ATTACHMENT_IMAGE_MIME 三组常量。
 * 这里的白名单必须与桌面版逐项一致：宽了会放过桌面会拒的文件，窄了会让用户的
 * 合法附件被标红。
 */
const ATTACHMENT_MAX_BYTES: number = 50 * 1024 * 1024;
const ATTACHMENT_IMAGE_MAX_BYTES: number = 5 * 1024 * 1024;
const ATTACHMENT_TEXT_EXTS: Array<string> = [
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'yaml', 'yml', 'xml', 'html', 'htm',
  'log', 'js', 'ts', 'tsx', 'jsx', 'py', 'java', 'c', 'h', 'cpp', 'go', 'rs', 'rb',
  'sh', 'sql', 'css'
];
const ATTACHMENT_IMAGE_EXTS: Array<string> = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
const ATTACHMENT_OFFICE_EXTS: Array<string> = [
  'doc', 'docx', 'pdf', 'pptx', 'ppt', 'xlsx', 'xlsm', 'xls'
];

/**
 * 应用版本号：必须与 AppScope/app.json5 的 versionName 一致（verify-all 的
 * checkAppVersionConsistency 会比对；Index.ets 的 aiOffice.getAppVersion 同源）。
 * 市场内测/正式发布时改这里 + app.json5（versionCode 同步 +1）。
 */
export const APP_VERSION: string = '2.0.1';

/** DuckDuckGo 请求头（对齐 ai-search 的 BROWSER_HEADERS：不带 UA 会被拒）*/
const AI_BROWSER_UA: string =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** 图库域名黑名单：桌面 ai-search 同样跳过（版权图不作为可插入素材）*/
const AI_COPYRIGHT_HOSTS: Array<string> = ['gettyimages', 'istockphoto', 'shutterstock', 'corbis'];

/** 网搜单条结果（对齐 sheets desktop-api 的 WebSearchResult.results[]）*/
interface AiWebSearchItem {
  title: string;
  url: string;
  snippet: string;
}

/** 图搜单条结果（对齐 sheets desktop-api 的 ImageSearchResponse.images[]）*/
interface AiImageSearchItem {
  title: string;
  imageUrl: string;
  sourceUrl: string;
  source: string;
  width?: number;
  height?: number;
}

/** 图片 GET 的中间结果：bytes 非空即成功，status 用于判定能否重试 */
interface AiHttpBytesReply {
  status: number;
  bytes: ArrayBuffer | null;
}

/** 魔术字节嗅探（对齐 sheets-main.ts 的 sniffImageType）：只认 PNG/JPEG/GIF，'' = 不支持 */
function sniffImageMediaType(bytes: Uint8Array): string {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50
    && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49
    && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return 'image/gif';
  }
  return '';
}

/**
 * 静态 SSRF 守卫（桌面 packages/electron-utils/src/safe-remote-url.ts 的本地子集）：
 * 仅放行 http(s) 且主机带点的公网字面量，私网 / 链路本地 / localhost / 短主机名一律拒。
 * 桌面版逐跳校验重定向后的 DNS 解析结果，ArkTS http 不给重定向回调 —— 差异已在交付说明标注。
 */
function isPublicHttpTarget(raw: string): boolean {
  const url = String(raw ?? '').trim();
  let rest: string = '';
  if (url.startsWith('https://')) {
    rest = url.substring(8);
  } else if (url.startsWith('http://')) {
    rest = url.substring(7);
  } else {
    return false;
  }
  const host: string = rest.split('/')[0].split(':')[0].toLowerCase();
  if (host.length === 0 || host.indexOf('.') < 0) {
    return false;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.startsWith('[')
    || host.startsWith('127.') || host.startsWith('10.') || host.startsWith('192.168.')
    || host.startsWith('169.254.') || host.startsWith('0.')) {
    return false;
  }
  if (host.startsWith('172.')) {
    const segs: Array<string> = host.split('.');
    const second: number = segs.length > 1 ? Number(segs[1]) : 0;
    if (second >= 16 && second <= 31) {
      return false;
    }
  }
  return true;
}

/** 搜索提供方参数：Key 存在 WebView 的 localStorage（ArkTS 读不到）→ 渲染层每次带下来 */
interface AiSearchOpts {
  provider: string;
  apiKey: string;
}

/** POST 回包：status=0 表示请求本身失败（DNS/超时/网络），text 只在 2xx 时有意义 */
interface AiHttpReply {
  status: number;
  text: string;
}

function parseAiSearchOpts(raw: string): AiSearchOpts {
  const text: string = String(raw ?? '').trim();
  if (text.length === 0) {
    return { provider: '', apiKey: '' };
  }
  const root = jsonRootRecord(text);
  if (root === null) {
    return { provider: '', apiKey: '' };
  }
  return { provider: jsonStrField(root, 'provider'), apiKey: jsonStrField(root, 'apiKey') };
}

/** 同一份响应里不同提供方的字段名不一致（Serper 用 link/imageUrl，Tavily 用 url/content）*/
function jsonFirstStr(rec: Record<string, Object>, keys: Array<string>): string {
  for (let i = 0; i < keys.length; i++) {
    const v: Object = rec[keys[i]];
    if (typeof v === 'string' && (v as string).length > 0) {
      return v as string;
    }
  }
  return '';
}

function jsonFirstNum(rec: Record<string, Object>, keys: Array<string>): number {
  for (let i = 0; i < keys.length; i++) {
    const v: Object = rec[keys[i]];
    if (typeof v === 'number' && (v as number) > 0) {
      return v as number;
    }
  }
  return 0;
}

/** Serper /search → organic[]（Google 自然结果）*/
function parseSerperWebResults(root: Record<string, Object>, limit: number): Array<AiWebSearchItem> {
  const out: Array<AiWebSearchItem> = [];
  const items: Array<Object> = jsonListField(root, 'organic');
  for (let i = 0; i < items.length && out.length < limit; i++) {
    const rec = items[i] as Record<string, Object>;
    const url: string = jsonFirstStr(rec, ['link', 'url']);
    const title: string = jsonFirstStr(rec, ['title']);
    if (url.length === 0 || title.length === 0) {
      continue;
    }
    out.push({ title: title, url: url, snippet: jsonFirstStr(rec, ['snippet', 'content']) });
  }
  return out;
}

/** Tavily /search → results[] */
function parseTavilyWebResults(root: Record<string, Object>, limit: number): Array<AiWebSearchItem> {
  const out: Array<AiWebSearchItem> = [];
  const items: Array<Object> = jsonListField(root, 'results');
  for (let i = 0; i < items.length && out.length < limit; i++) {
    const rec = items[i] as Record<string, Object>;
    const url: string = jsonFirstStr(rec, ['url', 'link']);
    const title: string = jsonFirstStr(rec, ['title']);
    if (url.length === 0 || title.length === 0) {
      continue;
    }
    out.push({ title: title, url: url, snippet: jsonFirstStr(rec, ['content', 'snippet']) });
  }
  return out;
}

/** Serper /images → images[]；沿用 DDG 时代的版权域名黑名单（图搜结果直接插文档）*/
function parseSerperImageResults(root: Record<string, Object>, limit: number): Array<AiImageSearchItem> {
  const out: Array<AiImageSearchItem> = [];
  const items: Array<Object> = jsonListField(root, 'images');
  for (let i = 0; i < items.length && out.length < limit; i++) {
    const rec = items[i] as Record<string, Object>;
    const imageUrl: string = jsonFirstStr(rec, ['imageUrl', 'image', 'thumbnailUrl']);
    if (imageUrl.length === 0) {
      continue;
    }
    const lower: string = imageUrl.toLowerCase();
    let copyrighted: boolean = false;
    for (let k = 0; k < AI_COPYRIGHT_HOSTS.length; k++) {
      if (lower.indexOf(AI_COPYRIGHT_HOSTS[k]) >= 0) {
        copyrighted = true;
      }
    }
    if (copyrighted) {
      continue;
    }
    const sourceUrl: string = jsonFirstStr(rec, ['link', 'sourceUrl', 'url']);
    const entry: AiImageSearchItem = {
      title: jsonFirstStr(rec, ['title']),
      imageUrl: imageUrl,
      sourceUrl: sourceUrl,
      source: hostOfUrl(sourceUrl)
    };
    const w: number = jsonFirstNum(rec, ['imageWidth', 'width']);
    const h: number = jsonFirstNum(rec, ['imageHeight', 'height']);
    if (w > 0) {
      entry.width = w;
    }
    if (h > 0) {
      entry.height = h;
    }
    out.push(entry);
  }
  return out;
}

/** 从 JSON 文本取根对象（ArkTS 无 any/unknown，统一按 Record<string, Object> 逐层取）*/
function jsonRootRecord(jsonText: string): Record<string, Object> | null {
  try {
    return JSON.parse(jsonText) as Record<string, Object>;
  } catch (e) {
    return null;
  }
}

/** 取对象里的数组字段；非数组/缺失都返回空数组 */
function jsonListField(root: Record<string, Object>, key: string): Array<Object> {
  const v: Object = root[key];
  if (v !== undefined && Array.isArray(v)) {
    return v as Array<Object>;
  }
  return [];
}

function jsonStrField(rec: Record<string, Object>, key: string): string {
  const v: Object = rec[key];
  return typeof v === 'string' ? v as string : '';
}

function jsonNumField(rec: Record<string, Object>, key: string): number {
  const v: Object = rec[key];
  return typeof v === 'number' ? v as number : 0;
}

/** 取 URL 主机名（对齐 ai-search 的 safeHost，用于图搜结果的 source 字段）*/
function hostOfUrl(raw: string): string {
  const url: string = String(raw ?? '');
  let rest: string = '';
  if (url.startsWith('https://')) {
    rest = url.substring(8);
  } else if (url.startsWith('http://')) {
    rest = url.substring(7);
  } else {
    return '';
  }
  return rest.split('/')[0].toLowerCase();
}

/**
 * M7-4 恢复副本文件名 = 原文件 URI 的稳定指纹（桌面用 `sha1(path).slice(0,16)`）。
 * ArkTS 侧对「路径字符串」求 sha1 没有廉价路径，这里用同构的 FNV-1a 十六进制替代 ——
 * 只当文件名用，不参与任何校验（校验靠 mtime 比对）。
 */
function sheetsRecoveryKey(uri: string): string {
  let h: number = 2166136261;
  for (let i = 0; i < uri.length; i++) {
    h = (h ^ uri.charCodeAt(i)) * 16777619;
    h = h >>> 0;
  }
  return h.toString(16);
}

/**

 * 子线程读文件 + base64 + FNV 指纹。
 * 关键：ArkTS 桥方法全部在主线程执行 —— 之前同步 readSync + encodeToStringSync
 * 处理大文件会把主线程卡死几十秒（watchdog THREAD_BLOCK_6S + LIFECYCLE_TIMEOUT）。
 * 必须 TaskPool 化；@Concurrent 函数体只能用入参与 import 变量，不能调模块级函数，
 * 因此 body 必须内联（不能抽公共函数复用）。
 */
@Concurrent
function readFilePayload(uri: string): Record<string, string> {
  const maxReadBytes: number = 512 * 1024 * 1024;
  let file: fs.File | null = null;
  try {
    file = fs.openSync(uri, fs.OpenMode.READ_ONLY);
    const st = fs.statSync(file.fd);
    if (st.size > maxReadBytes) {
      return { 'error': '文件过大（' + Math.round(st.size / 1024 / 1024) + 'MB），上限 512MB' };
    }
    const buf = new ArrayBuffer(st.size);
    fs.readSync(file.fd, buf);
    const bytes = new Uint8Array(buf);
    const b64 = new util.Base64Helper().encodeToStringSync(bytes);
    let h: number = 2166136261;
    for (let i = 0; i < bytes.length; i++) {
      h = (h ^ bytes[i]) * 16777619;
      h = h >>> 0;
    }
    return { 'b64': b64, 'hash': 'ohos-' + st.size + '-' + h.toString(16) };
  } catch (e) {
    // ⚠️ 这里**不能**复用下面的模块级 readFailText()：本函数跑在 taskpool 的 @Concurrent 上下文，
    // es2abc 只允许它引用 import 进来的或本地的变量，引用同文件的模块级函数会直接让构建炸在
    // 「Concurrent function should only use import variable or local variable」。
    // 所以这段文案是**有意的重复**，与 readFailText() 保持同语义（改一处要改两处）。
    const msg: string = e instanceof Error ? (e as Error).message : String(e);
    const lower: string = msg.toLowerCase();
    if (lower.indexOf('not permitted') >= 0 || lower.indexOf('eperm') >= 0 || msg.indexOf('13900001') >= 0) {
      return { 'error': '读取失败：该文件的跨启动访问授权已失效（重装应用或更换签名后，系统会重置授权）。'
        + '请在文件管理器中重新打开它，或用「打开本地文件」重新选择一次。原始错误：' + msg };
    }
    return { 'error': '读取失败：' + msg };
  } finally {
    if (file) {
      try { fs.closeSync(file); } catch (e) { /* 忽略关闭失败 */ }
    }
  }
}

/**
 * 读取失败的可见文案。EPERM / Operation not permitted 基本都是**跨启动授权失效**：
 * 每次重装或更换签名，系统会重置 fileShare 的持久化授权，「最近打开」里的旧条目就读不了了。
 * 直接把系统原文（Operation not permitted）抛给用户，会被读成"我的文档坏了"——
 * 实际出路是重新选一次该文件，所以这里说明原因并给出动作。
 */
function readFailText(e: Object): string {
  const msg: string = e instanceof Error ? (e as Error).message : String(e);
  const lower: string = msg.toLowerCase();
  if (lower.indexOf('not permitted') >= 0 || lower.indexOf('eperm') >= 0 || msg.indexOf('13900001') >= 0) {
    return '读取失败：该文件的跨启动访问授权已失效（重装应用或更换签名后，系统会重置授权）。'
      + '请在文件管理器中重新打开它，或用「打开本地文件」重新选择一次。原始错误：' + msg;
  }
  return '读取失败：' + msg;
}

/**
 * 主线程读 URI 全部字节 + base64 + FNV 指纹。与 @Concurrent readFilePayload 同语义，
 * 但运行在主线程，可安全调用模块级函数 —— 用于 taskpool 对 picker URI 读取权限受限
 * 时的 fallback（M3 真机踩过的坑：openFileJson 有 fallback，readDocxUri 此前漏了）。
 */
function readUriOnMainThread(uri: string): Record<string, string> {
  const maxBytes: number = 512 * 1024 * 1024;
  const f = fs.openSync(uri, fs.OpenMode.READ_ONLY);
  try {
    const st = fs.statSync(f.fd);
    if (st.size > maxBytes) {
      return { 'error': '文件过大（' + Math.round(st.size / 1024 / 1024) + 'MB），上限 512MB' };
    }
    const buf = new ArrayBuffer(st.size);
    fs.readSync(f.fd, buf);
    const bytes = new Uint8Array(buf);
    const b64 = new util.Base64Helper().encodeToStringSync(bytes);
    let h: number = 2166136261;
    for (let i = 0; i < bytes.length; i++) {
      h = (h ^ bytes[i]) * 16777619;
      h = h >>> 0;
    }
    return { 'b64': b64, 'hash': 'ohos-' + st.size + '-' + h.toString(16) };
  } catch (e) {
    return { 'error': readFailText(e) };
  } finally {
    try { fs.closeSync(f); } catch (e) { /* 忽略关闭失败 */ }
  }
}

/** 子线程解码 + 全量写文件（保存链路：大文档 decodeSync/writeSync 同样会卡死主线程） */
@Concurrent
function writeFilePayload(path: string, b64: string): Record<string, string> {
  let file: fs.File | null = null;
  try {
    const bytes: Uint8Array = new util.Base64Helper().decodeSync(b64 ?? '');
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    // CREATE 必须带上：openSync 对不存在的路径（新建场景是常态）无 CREATE 会抛 ENOENT
    file = fs.openSync(path, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
    fs.writeSync(file.fd, ab);
    return { 'ok': '1' };
  } catch (e) {
    return { 'error': '写入失败：' + (e instanceof Error ? e.message : String(e)) };
  } finally {
    if (file) {
      try { fs.closeSync(file); } catch (e) { /* 忽略关闭失败 */ }
    }
  }
}

/**
 * window.desktop 桥的鸿蒙实现。
 *
 * 与 Electron preload（apps/docs/src/preload/index.ts）保持同名方法（M3：文件打开/保存全链路）。
 * 数据传输约定：二进制一律 base64、复合结构一律 JSON 字符串（xxxJson 后缀），
 * PROMISE_SHIM 侧负责 unwrap（避开 ArkTS↔JS 对象序列化的类型坑）。
 *
 * 路径虚拟化：renderer 看到的 path 直接用 picker 返回的 URI
 * （file://docs/storage/.../xx.docx），本类维护 URI 写授权表 + 最近文件列表。
 *
 * 方法名列表需与 Index.ets javaScriptProxy 的 methodList/asyncMethodList 一致：
 * sync 方法（getLanguage/getTheme/platform/version/recentFilesJson/writeClipboardText）
 * 进 methodList，async（返回 Promise）方法必须进 asyncMethodList —— 只塞 methodList
 * 时 ArkWeb 不注入，JS 调用报 "non-injected object"。
 */
export class DesktopBridge {
  private ctx: common.Context | undefined = undefined;
  /** 已授权可覆盖写的目标（等价 Electron allowDocWrite：打开或另存过的文件） */
  private writable: Set<string> = new Set<string>();
  /**
   * 已授权可写目录（picker FOLDER 选择结果）。导出图片/拆分成多文件时目标 URI 是
   * 「目录 + 新文件名」，从未进 writable → 旧实现直接报 "save target is not an opened
   * document"（真机 BUG）。逐个文件重新弹保存框体验太差，改为按目录授权派生文件 URI。
   */
  private grantedDirs: Set<string> = new Set<string>();
  /** 最近文件（URI 列表，等价 Electron docs:recent 的 pushRecent） */
  private recents: Array<string> = [];
  private static readonly RECENTS_MAX: number = 20;
  /** 收藏集合（URI 列表，等价桌面 readStarredFiles/toggleStarredFile） */
  private starred: Array<string> = [];
  /** 签名库上限（对齐桌面 MAX_SAVED_SIGNATURES：超出的最旧条目被淘汰） */
  private static readonly MAX_SAVED_SIGNATURES: number = 10;
  /** sheets xlsx 引擎的进程内 NAPI 桥（M4 §4 方案 A：无 @ohos.process.childprocess） */
  private xlsxSidecar: XlsxSidecarBridge = XlsxSidecarBridge.getInstance();
  /** 会话 → 打开时的原始 picker URI（保存写回目标；open 时登记、close 时移除） */
  private sheetsSessionUris: Map<string, string> = new Map<string, string>();
  /** 会话 → 快照文件路径（sidecar open 时落盘的临时 xlsx；readPivotDefinition 读包内条目用） */
  private sheetsSessionSnapshots: Map<string, string> = new Map<string, string>();
  /**
   * M7-4 崩溃恢复：由恢复副本打开的会话 → 原文件 URI（桌面 session.restoreTarget）。
   * 保存要写回原文件（恢复提问本身就是覆盖确认），后台恢复副本对它 stand down。
   */
  private sheetsRestoreTargets: Map<string, string> = new Map<string, string>();
  /** 会话 → 原文件「打开时」的 {size,mtime} 戳（保存前磁盘改动守卫，对齐桌面 restoreTargetSha） */
  private sheetsRestoreStamps: Map<string, string> = new Map<string, string>();
  /**
   * 仍带「自动生成名」的会话（桌面 untitledWorkbookPaths）：新建空白表格另存为时若用户
   * 直接沿用了默认名（未命名表格.xlsx），说明文件名没有承载用户意图 → AI 生成内容后
   * autoRenameWorkbook 才允许改名。用户自己起的名字一律不改。
   */
  private sheetsAutoNamedSessions: Set<string> = new Set<string>();
  /** 桥方法注册表（替代 44 case switch） */
  private bridgeRegistry: BridgeRegistry = new BridgeRegistry();

  /** 启动自检：sidecar 模块加载 + FFI 可调用性面包屑（失败只记录，不阻断启动）。 */
  constructor() {
    try {
      const probe: string = this.xlsxSidecar.probe();
      console.error('[GenOffice] xlsx sidecar probe: ' + probe);
    } catch (e) {
      console.error('[GenOffice] xlsx sidecar probe FAILED: ' + (e instanceof Error ? e.message : String(e)));
    }
    this.initBridgeRegistry();
  }

  /** Index.aboutToAppear 在拿到 UIAbility context 后调用（recents 持久化依赖 filesDir） */
  setContext(ctx: common.Context): void {
    this.ctx = ctx;
    this.loadRecents();
    this.loadStarred();
    // 冷启动就把「最近打开」的持久化授权激活一遍，不等列表查询：
    // 未激活的持久化授权读文件会 EPERM，用户看到的是"上次还能开，现在打不开"。
    // 真机每次 DevEco 重装/换签名都会重置这些授权 → 越晚激活，越多条目被误判成不可用。
    void this.activatePersistedGrants();
  }

  /**
   * 统一 async 桥调度入口。JS 侧 goJson/goNative 全部走此方法，gin 桥只注册一个 async 方法，
   * 避免部分 ArkWeb 版本对多个 async 方法的暴露问题（saveNewDocxJson 等返回 undefined）。
   * @param method 目标方法名（如 'openFileJson', 'saveNewDocxJson'）
   * @param argsJson 参数的 JSON 数组字符串（如 '["path","b64data"]'）
   * @returns 目标方法的 JSON 字符串返回值
   */
  async bridgeCall(method: string, argsJson: string): Promise<string> {
    let args: string[] = [];
    try { args = JSON.parse(argsJson || '[]'); } catch (e) { args = []; }
    return this.bridgeRegistry.call(method, args);
  }

  /**
   * 初始化桥方法注册表。每个 register() 调用封装了原 switch case 的参数处理逻辑，
   * 语义与原 bridgeCall 完全一致。新增方法只需添加一行 register() 调用。
   */
  private initBridgeRegistry(): void {
    const r = this.bridgeRegistry;

    // 文件操作
    r.register('openFileJson', (args: string[]) =>
      this.openFileJson(args.length > 0 ? String(args[0]) : ''));
    r.register('pickAttachmentsJson', (_args: string[]) =>
      this.pickAttachmentsJson());
    r.register('captureScreenJson', (_args: string[]) =>
      this.captureScreenJson());
    r.register('openDocxJson', (args: string[]) =>
      this.openDocxJson(args.length > 0 ? String(args[0]) : ''));
    r.register('openDocxPathJson', (args: string[]) =>
      this.openDocxPathJson(args[0]));
    r.register('saveDocxJson', (args: string[]) =>
      this.saveDocxJson(args[0] as string, args[1] as string));
    r.register('saveAsDocxJson', (args: string[]) =>
      this.saveAsDocxJson(args[0] as string, args[1] as string, args[2] as string));
    r.register('saveNewDocxJson', (args: string[]) =>
      this.saveNewDocxJson(args[0], args[1]));
    r.register('saveAsAnyJson', (args: string[]) =>
      this.saveAsAnyJson(args[0], args[1]));
    r.register('saveAnyJson', (args: string[]) =>
      this.saveAnyJson(args[0], args[1]));
    r.register('saveInDirJson', (args: string[]) =>
      this.saveInDirJson(args[0], args[1], args[2]));
    r.register('pickDirectory', (_args: string[]) =>
      this.pickDirectory().then(rr => JSON.stringify({ ok: !!rr, uri: rr || '' })));
    r.register('readClipboardText', (_args: string[]) =>
      this.readClipboardText());
    r.register('readRawFileJson', (args: string[]) =>
      this.readRawFileJson(args[0] as string));
    r.register('pickImageJson', (_args: string[]) =>
      this.pickImageJson());
    r.register('createDocumentJson', (args: string[]) =>
      this.createDocumentJson(args[0], args[1], args[2]));

    // 起始页「最近打开」（Home 列表 + 项目视图 statPaths + 移除条目）
    r.register('recentPageJson', (args: string[]) =>
      this.recentPageJson(String(args[0] ?? '{}')));
    r.register('statPathsJson', (args: string[]) =>
      this.statPathsJson(String(args[0] ?? '[]')));
    r.register('removeRecentJson', (args: string[]) =>
      this.removeRecentJson(String(args[0] ?? '[]')));
    r.register('toggleStarJson', (args: string[]) =>
      this.toggleStarJson(String(args[0] ?? '')));
    r.register('searchFilesJson', (args: string[]) =>
      this.searchFilesJson(String(args[0] ?? '{}')));
    r.register('renameFileJson', (args: string[]) =>
      this.renameFileJson(String(args[0] ?? ''), String(args[1] ?? '')));
    r.register('duplicateFileJson', (args: string[]) =>
      this.duplicateFileJson(String(args[0] ?? '')));
    r.register('deleteFilesJson', (args: string[]) =>
      this.deleteFilesJson(String(args[0] ?? '[]')));
    r.register('revealPathJson', (args: string[]) =>
      this.revealPathJson(String(args[0] ?? '')));

    // AI 连接测试
    r.register('testAiConnection', (args: string[]) =>
      this.testAiConnection(args[0], args[1], args.length > 2 ? String(args[2]) : 'openai'));

    // sheets xlsx（走 napi in-process sidecar bridge）
    r.register('xlsOpenJson', (args: string[]) =>
      this.xlsOpenJson(args.length > 0 ? String(args[0]) : ''));

    // M7-4 sheets 崩溃恢复（恢复副本落盘 / 恢复提问的回答）
    // 注意：注册名必须与桥方法同名（checkBridgeRegistration 按名比对）
    r.register('xlsRecoveryWriteJson', (args: string[]) =>
      this.xlsRecoveryWriteJson(String(args[0] ?? '{}')));
    r.register('xlsRecoveryResolveJson', (args: string[]) =>
      this.xlsRecoveryResolveJson(String(args[0] ?? ''), String(args[1] ?? 'dismissed')));
    r.register('xlsOpenBlankJson', (_args: string[]) =>
      this.xlsOpenBlankJson());
    r.register('xlsReadRangeJson', (args: string[]) =>
      this.xlsReadRangeJson(String(args[0])));
    r.register('xlsReadFormulaCellsJson', (args: string[]) =>
      this.xlsReadFormulaCellsJson(String(args[0])));
    r.register('xlsReadMediaJson', (args: string[]) =>
      this.xlsReadMediaJson(String(args[0])));
    r.register('xlsCloseJson', (args: string[]) =>
      this.xlsCloseJson(String(args[0])));
    r.register('autoRenameWorkbookJson', (args: string[]) =>
      this.autoRenameWorkbookJson(String(args[0]), String(args[1])));
    r.register('xlsSaveEditsJson', (args: string[]) =>
      this.xlsSaveEditsJson(String(args[0])));
    r.register('xlsSaveAsEditsJson', (args: string[]) =>
      this.xlsSaveAsEditsJson(String(args[0])));
    r.register('xlsRecalcJson', (args: string[]) =>
      this.xlsRecalcJson(String(args[0])));
    r.register('xlsArchiveManifestJson', (args: string[]) =>
      this.xlsArchiveManifestJson(String(args[0])));
    r.register('xlsReadEntriesJson', (args: string[]) =>
      this.xlsReadEntriesJson(String(args[0])));
    r.register('xlsScanEntriesJson', (args: string[]) =>
      this.xlsScanEntriesJson(String(args[0])));
    r.register('xlsSaveArchiveJson', (args: string[]) =>
      this.xlsSaveArchiveJson(String(args[0])));
    r.register('xlsReadArchiveEntryTextJson', (args: string[]) =>
      this.xlsReadArchiveEntryTextJson(String(args[0] ?? '{}')));

    // M6 Excel 二级功能（exportCsv / selectWorkbooksForMerge / openExternal）
    r.register('xlsExportCsvJson', (args: string[]) =>
      this.xlsExportCsvJson(String(args[0] ?? '{}')));
    r.register('xlsOpenMergeJson', (args: string[]) =>
      this.xlsOpenMergeJson(String(args[0] ?? '[]')));
    r.register('openExternalJson', (args: string[]) =>
      this.openExternalJson(String(args[0] ?? '')));

    // M7 PDF 签名库（磁盘持久化，跨会话复用）
    r.register('listSavedSignaturesJson', (_args: string[]) =>
      this.listSavedSignaturesJson());
    r.register('addSavedSignatureJson', (args: string[]) =>
      this.addSavedSignatureJson(String(args[0] ?? '{}')));
    r.register('removeSavedSignatureJson', (args: string[]) =>
      this.removeSavedSignatureJson(String(args[0] ?? '')));

    // M7-3 AI 图像/搜索链（本地图片 / 网图下载 / 网搜 / 图搜）
    r.register('readLocalImageJson', (args: string[]) =>
      this.readLocalImageJson(String(args[0] ?? '')));
    r.register('attachmentAddJson', (args: string[]) =>
      this.attachmentAddJson(String(args[0] ?? '[]')));
    r.register('attachmentReadImageJson', (args: string[]) =>
      this.attachmentReadImageJson(String(args[0] ?? '')));
    r.register('attachmentAddPastedJson', (args: string[]) =>
      this.attachmentAddPastedJson(String(args[0] ?? ''), String(args[1] ?? 'png')));
    r.register('attachmentReadJson', (args: string[]) =>
      this.attachmentReadJson(String(args[0] ?? ''), String(args[1] ?? '0'), String(args[2] ?? '8000')));
    r.register('fetchImageJson', (args: string[]) =>
      this.fetchImageJson(String(args[0] ?? '')));
    r.register('webSearchJson', (args: string[]) =>
      this.webSearchJson(String(args[0] ?? ''), Number(String(args[1] ?? '0')),
        String(args.length > 2 ? args[2] : '')));
    r.register('imageSearchJson', (args: string[]) =>
      this.imageSearchJson(String(args[0] ?? ''), Number(String(args[1] ?? '0')),
        String(args.length > 2 ? args[2] : '')));

    // AI 兜底通道（注入脚本 fetch 被 CORS 拦时走这里；URL 白名单在方法内）
    r.register('aiPostJson', (args: string[]) =>
      this.aiPostJson(String(args[0] ?? ''), String(args[1] ?? '{}'), String(args[2] ?? '{}')));
  }

  getLanguage(): string {
    // renderer 侧 setUiLang(normalizeLang(...)) 以桥返回值为准
    return 'zh';
  }

  getTheme(): string {
    // TODO: 跟随系统深浅色（@ohos.app.ability.Configuration constant）
    return 'light';
  }

  platform(): string {
    return 'ohos';
  }

  version(): string {
    return APP_VERSION;
  }

  /**
   * slides PPT M1：以 base64 读取 rawfile 下的 JS 模块（pptx-bridge.mjs）。
   * renderer 侧 __goImport('pptx-bridge.mjs') 依赖构建期 __goChunks 注册表，一旦
   * 注册缺失就退回 fetch/XHR → 裸 specifier import 报 "Failed to resolve module
   * specifier"（真机复现）。这里用 resourceManager 直读 rawfile 字节，JS 侧以
   * data: URL import —— 不经网络、不依赖注册表，与文件经没经 inline 无关。
   * 返回 {"ok":true,"b64":"..."} / {"ok":false,"error":"..."}。
   */
  async readRawFileJson(rawPath: string): Promise<string> {
    try {
      const rm = this.ctx?.resourceManager;
      if (!rm) {
        return JSON.stringify({ ok: false, error: 'resourceManager unavailable' });
      }
      const bytes: Uint8Array = rm.getRawFileContentSync(rawPath);
      const b64 = new util.Base64Helper().encodeToStringSync(bytes);
      return JSON.stringify({ ok: true, b64 });
    } catch (e) {
      console.error('[GenOffice] readRawFileJson 失败 ' + rawPath + ': ' + (e instanceof Error ? e.message : String(e)));
      return JSON.stringify({ ok: false, error: 'readRawFileJson failed: ' + rawPath });
    }
  }

  /**
   * AI 测试连接（SettingsModal "测试连接"）：对 openai-compatible 端点的
   * {baseUrl}/models 发 GET + Bearer 鉴权，验证 API Key 是否有效。
   * 返回 {"ok":true} 或 {"ok":false,"error":"...","status":<code>}。
   * 走原生网络栈，不受 webview CORS 限制。
   */
  /**
   * 「测试连接」：GET <baseUrl>/models。protocol='anthropic' 时换成 x-api-key + anthropic-version
   * （Claude 的 models 端点认这两个头，不认 Authorization: Bearer）。
   */
  async testAiConnection(baseUrl: string, apiKey: string, protocol: string): Promise<string> {
    const url = String(baseUrl || '').replace(/\/+$/, '') + '/models';
    let headers: Record<string, string>;
    if (protocol === 'anthropic') {
      headers = {
        'x-api-key': (apiKey || ''),
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      };
    } else {
      headers = {
        'Authorization': 'Bearer ' + (apiKey || ''),
        'Content-Type': 'application/json'
      };
    }
    try {
      const httpRequest = http.createHttp();
      try {
        const resp = await httpRequest.request(url, {
          method: http.RequestMethod.GET,
          header: headers,
          connectTimeout: 10000,
          readTimeout: 15000,
        });
        const code = resp.responseCode;
        if (code === 200) {
          return JSON.stringify({ ok: true });
        }
        let msg = 'HTTP ' + code;
        try {
          const raw: object = JSON.parse(resp.result as string) as object;
          const errObj = raw as Record<string, object>;
          const err = errObj['error'] as Record<string, string> | undefined;
          if (err && typeof err['message'] === 'string') {
            msg = err['message'];
          }
        } catch (e) { /* 非 JSON 响应，用状态码 */ }
        return JSON.stringify({ ok: false, error: msg, status: code });
      } finally {
        httpRequest.destroy();
      }
    } catch (e) {
      return JSON.stringify({ ok: false, error: String(e) });
    }
  }

  /** 系统目录选择器（shell 的"默认保存位置"）。取消/失败返回 null，JS 侧兜底自绘输入框 */
  async pickDirectory(): Promise<string | null> {
    try {
      const docPicker = new picker.DocumentViewPicker(this.ctx as common.Context);
      const uris: string[] = await docPicker.select({
        maxSelectNumber: 1,
        selectMode: picker.DocumentSelectMode.FOLDER,
      });
      if (uris.length === 0) {
        return null;
      }
      // 目录授权登记：saveInDirJson 只认这里登记过的目录（导出图片/拆分 PDF 的落盘目标）
      await this.persistPickerGrant(uris[0]);
      this.grantedDirs.add(uris[0]);
      console.error('[GenOffice] pickDirectory granted: ' + uris[0]);
      return uris[0];
    } catch (e) {
      return null;
    }
  }

  // ================= M3：文档打开/保存 =================

  /**
   * 解析渲染层传入的后缀过滤参数（JSON 数组字符串，如 '[\".pdf\"]'）。
   * 空串 / 空数组 / '*' 都表示「不限制后缀」（起始页磁贴的通用打开）；否则统一补前导点。
   */
  private parseSuffixFilters(filtersJson: string): Array<string> {
    const out: Array<string> = [];
    if (typeof filtersJson !== 'string' || filtersJson.length === 0) {
      return out;
    }
    let list: Array<string>;
    try {
      list = JSON.parse(filtersJson || '[]') as Array<string>;
    } catch (e) {
      return out;
    }
    for (const item of list) {
      const s: string = String(item).trim();
      if (s.length === 0 || s === '*') {
        return [];
      }
      out.push(s.startsWith('.') ? s : '.' + s);
    }
    return out;
  }

  /**
   * 起始页"打开本地文件"（browse）通用选择器：支持多后缀，读字节返回 JSON。
   * filtersJson 为空时（起始页磁贴 / 通用打开）不限制后缀，office 之外（txt/压缩包等）也能选，
   * 由 browse 按 ext 判定可开哪个 app（未知类型提示不支持而非选择器直接拦掉）；
   * app 内「打开」传入本 app 后缀（如 '.pdf'）时，选择器默认只列该类型。
   * 返回 ''（取消/失败）或 {"ok":true,"path","name","ext","b64","hash"}。
   */
  async openFileJson(filtersJson: string = ''): Promise<string> {
    try {
      const suffixes: Array<string> = this.parseSuffixFilters(filtersJson);
      console.error('[GenOffice] openFileJson: before picker.select ctx=' + (this.ctx ? 'ok' : 'missing'));
      // 必须传 context 构造（无参构造在部分 API 版本会概率性拉起失败）
      const docPicker = new picker.DocumentViewPicker(this.ctx as common.Context);
      let uris: string[] = [];
      if (suffixes.length > 0) {
        uris = await docPicker.select({
          maxSelectNumber: 1,
          fileSuffixFilters: suffixes,
        });
      } else {
        uris = await docPicker.select({
          maxSelectNumber: 1,
        });
      }
      console.error('[GenOffice] openFileJson: picker returned uris.len=' + uris.length + (uris[0] ? ' uri=' + uris[0] : ''));
      if (uris.length === 0) {
        console.error('[GenOffice] openFileJson: uris empty (user cancelled or picker failed)');
        return '';
      }
      const uri = uris[0];
      // 临时授权此刻仍有效：立即持久化，之后「最近打开」跨启动才读得到（见文件头注释）
      await this.persistPickerGrant(uri);
      const name = uri.split('/').pop() ?? 'file';
      const dot = name.lastIndexOf('.');
      const ext = dot >= 0 ? name.substring(dot + 1).toLowerCase() : '';
      // 读文件 + base64 + 指纹：优先 TaskPool 子线程（大文件不卡主线程）；
      // 子线程失败时 fallback 主线程同步读（鸿蒙真机 taskpool 对 picker URI 权限受限）
      let payload: Record<string, string>;
      try {
        payload = await taskpool.execute(readFilePayload, uri) as Record<string, string>;
      } catch (e) {
        console.warn('[GenOffice] openFileJson: taskpool fail, fallback to main thread: ' + (e && e.message ? e.message : String(e)));
        payload = readUriOnMainThread(uri);
      }
      const r = payload;
      if (r.error) {
        return JSON.stringify({ ok: false, error: String(r.error) });
      }
      this.writable.add(uri);
      this.pushRecent(uri);
      return JSON.stringify({ ok: true, path: uri, name: name, ext: ext, b64: String(r.b64), hash: String(r.hash) });
    } catch (e) {
      // 失败时返回 ok:false+error 让 ERR_COLLECTOR 显示真机具体原因（之前 return '' 被误诊为"用户取消"）
      return JSON.stringify({ ok: false, error: 'openFileJson failed: ' + (e && e.message ? e.message : String(e)) });
    }
  }

  /**
   * 截屏（等价桌面 desktopCapturer.captureScreenSource）。
   * 鸿蒙 `@ohos.screenshot.capture()` 只能截整屏，不能枚举窗口 → sources 恒为单一「全屏」项。
   * 返回 {"ok":true,"mediaType":"image/png","base64":"...","width":W,"height":H}；
   * 用户拒绝权限 / 能力不支持 → {"ok":false,"denied":true,"error":"..."}。
   */
  async captureScreenJson(): Promise<string> {
    const fail = (reason: string, denied: boolean): string => {
      console.warn('[GenOffice] captureScreenJson: ' + reason);
      return JSON.stringify({ ok: false, denied: denied, error: reason });
    };
    try {
      if (!(await this.ensureScreenCapturePermission())) {
        return fail('未授予截屏权限', true);
      }
      const pixelMap: image.PixelMap = await screenshot.capture();
      let width: number = 0;
      let height: number = 0;
      try {
        const info: image.ImageInfo = await pixelMap.getImageInfo();
        width = info.size.width;
        height = info.size.height;
      } catch (e) { /* 尺寸可选 */ }
      const packer: image.ImagePacker = image.createImagePacker();
      let buf: ArrayBuffer;
      try {
        buf = await packer.packing(pixelMap, { format: 'image/png', quality: 100 });
      } finally {
        try { await packer.release(); } catch (e) { /* 忽略 */ }
        try { pixelMap.release(); } catch (e) { /* 忽略 */ }
      }
      const b64: string = new util.Base64Helper().encodeToStringSync(new Uint8Array(buf));
      return JSON.stringify({ ok: true, mediaType: 'image/png', base64: b64, width: width, height: height });
    } catch (e) {
      return fail('截屏失败：' + (e instanceof Error ? e.message : String(e)), false);
    }
  }

  /** CUSTOM_SCREEN_CAPTURE 是 user_grant：首次调用弹系统授权框。已授权直接返回 true。 */
  private async ensureScreenCapturePermission(): Promise<boolean> {
    if (!this.ctx) { return false; }
    try {
      const atManager = abilityAccessCtrl.createAtManager();
      const ctx: common.UIAbilityContext = this.ctx as common.UIAbilityContext;
      const check: abilityAccessCtrl.GrantStatus =
        await atManager.checkAccessToken(ctx.applicationInfo.accessTokenId, 'ohos.permission.CUSTOM_SCREEN_CAPTURE');
      if (check === abilityAccessCtrl.GrantStatus.PERMISSION_GRANTED) { return true; }
      const result = await atManager.requestPermissionsFromUser(ctx, ['ohos.permission.CUSTOM_SCREEN_CAPTURE']);
      return result.authResults.length > 0 && result.authResults[0] === 0;
    } catch (e) {
      console.warn('[GenOffice] ensureScreenCapturePermission: ' + (e instanceof Error ? e.message : String(e)));
      return false;
    }
  }

  /**
   * 附件选择（等价桌面 IPC files:pick → AttachmentAddResult）。
   * 系统文件选择器多选 → 只 stat 拿 sizeBytes，不读内容（附件按需再读）。
   * 返回 'null'（用户取消）或 {"ok":true,"accepted":[...],"rejected":[...]}。
   * AttachmentMeta 契约见 apps/sheets/src/shared/desktop-api.ts:2493。
   */
  async pickAttachmentsJson(): Promise<string> {
    try {
      const docPicker = new picker.DocumentViewPicker(this.ctx as common.Context);
      const uris: string[] = await docPicker.select({ maxSelectNumber: 20 });
      if (uris.length === 0) { return 'null'; }
      const accepted: Array<Record<string, Object>> = [];
      const rejected: Array<string> = [];
      for (let i = 0; i < uris.length; i++) {
        const uri: string = uris[i];
        const rawName: string = uri.split('/').pop() ?? 'file';
        try {
          const st = fs.statSync(uri);
          const dot: number = rawName.lastIndexOf('.');
          const ext: string = dot >= 0 ? rawName.substring(dot + 1).toLowerCase() : '';
          await this.persistPickerGrant(uri);
          this.writable.add(uri);
          const meta: Record<string, Object> = {
            'path': uri, 'name': rawName, 'ext': ext, 'sizeBytes': st.size
          };
          accepted.push(meta);
        } catch (e) {
          rejected.push(rawName);
        }
      }
      return JSON.stringify({ ok: true, accepted: accepted, rejected: rejected });
    } catch (e) {
      return JSON.stringify({ ok: false, error: 'pickAttachments failed: ' + (e instanceof Error ? e.message : String(e)) });
    }
  }

  /**
   * docs:open —— 系统文件选择器 → 读字节 → base64 JSON。
   * filtersJson 是渲染层传来的后缀过滤（docs 菜单「打开…」= ['.docx','.doc']）；空则不限后缀。
   * 返回 ''（取消/失败，等价 Electron 返回 null）或
   * {"ok":true,"path":"<uri>","name":"x.docx","b64":"...","hash":"ohos-..."}。
   */
  async openDocxJson(filtersJson: string = ''): Promise<string> {
    try {
      const suffixes: Array<string> = this.parseSuffixFilters(filtersJson);
      const docPicker = new picker.DocumentViewPicker(this.ctx as common.Context);
      let uris: string[] = [];
      if (suffixes.length > 0) {
        uris = await docPicker.select({
          maxSelectNumber: 1,
          fileSuffixFilters: suffixes,
        });
      } else {
        uris = await docPicker.select({
          maxSelectNumber: 1,
        });
      }
      if (uris.length === 0) {
        return '';
      }
      await this.persistPickerGrant(uris[0]);
      return await this.readDocxUri(uris[0]);
    } catch (e) {
      return '';
    }
  }

  /** docs:open-path —— 从最近文件/逻辑路径重开（无选择器） */
  async openDocxPathJson(path: string): Promise<string> {
    if (typeof path !== 'string' || path.length === 0) {
      return '';
    }
    return await this.readDocxUri(path);
  }

  /**
   * docs:save —— 覆盖保存（path 必须是打开/另存授权过的 URI）。
   * 返回 {"ok":true} / {"ok":false,"error":"..."}（对齐 SaveResult）。
   */
  async saveDocxJson(path: string, b64: string): Promise<string> {
    try {
      if (typeof path !== 'string' || !this.writable.has(path)) {
        return JSON.stringify({ ok: false, error: 'save target is not an opened document' });
      }
      // 解码 + 写盘在 TaskPool 子线程执行（大文档同步写会卡死主线程）
      await taskpool.execute(writeFilePayload, path, b64 ?? '');
      this.pushRecent(path);
      return JSON.stringify({ ok: true });
    } catch (e) {
      return JSON.stringify({ ok: false, error: String(e) });
    }
  }

  /**
   * docs:save-as —— 另存为（系统保存选择器，默认名 defaultName）。
   * 返回 {"ok":true,"path":"<uri>"} / {"ok":false}（取消）/ {"ok":false,"error":"..."}。
   */
  async saveAsDocxJson(defaultName: string, b64: string, sourcePath: string): Promise<string> {
    try {
      let name: string = (typeof defaultName === 'string' && defaultName.length > 0)
        ? defaultName : 'Untitled.docx';
      if (!name.toLowerCase().endsWith('.docx')) {
        name += '.docx';
      }
      const docPicker = new picker.DocumentViewPicker(this.ctx as common.Context);
      const uris: string[] = await docPicker.save({ newFileNames: [name] });
      if (uris.length === 0) {
        return JSON.stringify({ ok: false });
      }
      const uri = uris[0];
      // 另存目标同样要持久化，否则下次启动从「最近打开」重开该文件会 EPERM
      await this.persistPickerGrant(uri);
      // 解码 + 写盘在 TaskPool 子线程执行
      await taskpool.execute(writeFilePayload, uri, b64 ?? '');
      this.writable.add(uri);
      this.pushRecent(uri);
      return JSON.stringify({ ok: true, path: uri });
    } catch (e) {
      return JSON.stringify({ ok: false, error: String(e) });
    }
  }

  /**
   * docs:save-new —— 无路径文档的首次保存。
   * 桌面版静默落 defaultSaveDir；鸿蒙壳无"用户默认目录"概念（filesDir 是应用私有
   * 空间，用户不可见）——首次保存同样弹系统保存选择器，让用户选可见位置。
   * 后续覆盖保存（saveDocxJson）仍走已授权 path 静默写盘。取消/失败返回 {ok:false}。
   */
  async saveNewDocxJson(defaultName: string, b64: string): Promise<string> {
    return this.saveAsDocxJson(defaultName, b64, '');
  }

  /**
   * 下一个不存在的文件路径。fs.accessSync 在目标不存在时抛异常（13900002 ENOENT）
   * 而不是返回 false —— 存在性检查必须 try/catch，否则首次新建必然落入 catch 失败。
   */
  private nextFreePath(dir: string, fileName: string): string {
    const dot: number = fileName.lastIndexOf('.');
    const stem: string = dot > 0 ? fileName.substring(0, dot) : fileName;
    const ext: string = dot > 0 ? fileName.substring(dot) : '';
    let path: string = dir + '/' + fileName;
    let n: number = 1;
    while (n < 1000) {
      try {
        fs.accessSync(path);
        path = dir + '/' + stem + ' (' + n + ')' + ext;
        n++;
      } catch (e) {
        return path;
      }
    }
    return path;
  }

  // ================= 授权持久化（「最近打开」跨启动可重开的前提）=================
  // HarmonyOS 的 Picker 授权是**临时**的：应用退出或设备重启即清除。不持久化时，
  // 起始页「最近打开」里的条目在下次启动就读不到 —— 真机实证（同一应用会话内）：
  //   · 刚通过 Picker 选中的同一个文件：openDocxPathJson 读到 255996B（ok=true）；
  //   · 从最近列表点开的旧条目：file_api `OpenByFileDataUri Failed to open file for
  //     libuv error -1`（EPERM）→ 渲染层「读取失败：Operation not permitted」，
  //     Home 列表的 stat 也失败 → 条目按“不可用”灰显。
  // 官方对这一场景（文档编辑类应用希望历史记录里直接打开、无需再拉起 Picker）给的解法
  // 就是本链路：Picker 拿到临时授权后立即 persistPermission 持久化，应用启动后再
  // activatePermission 使能（未激活的持久化授权不可用）。
  // 需要 ohos.permission.FILE_ACCESS_PERSIST —— 受限开放权限（开放范围普通应用，
  // 需 ACL 跨级别申请），与本项目 READ_PASTEBOARD 走的是同一条 ACL 路径。
  private activateTried: boolean = false;
  private persistCapable: boolean | undefined = undefined;

  /** 设备能力判定（缓存）：无 FolderAuthorization 能力时整条链路降级为不持久化 */
  private canPersistUri(): boolean {
    if (this.persistCapable === undefined) {
      let ok: boolean = false;
      try {
        ok = canIUse('SystemCapability.FileManagement.AppFileService.FolderAuthorization');
      } catch (e) {
        ok = false;
      }
      this.persistCapable = ok;
      if (!ok) {
        console.warn('[GenOffice] 本机无 FolderAuthorization：最近打开跨启动重开将不可用（需重新选择文件）');
      }
    }
    return this.persistCapable === true;
  }

  /** 读+写组合授权（PolicyInfo.operationMode 是枚举，需显式转换） */
  private rwMode(): fileShare.OperationMode {
    return (fileShare.OperationMode.READ_MODE
      | fileShare.OperationMode.WRITE_MODE) as fileShare.OperationMode;
  }

  /**
   * Picker 刚返回、临时授权仍有效时立即持久化。只能对已获得的临时权限操作，
   * 晚于此刻（授权失效后）会报 PERMISSION_NOT_PERSISTED；失败只记录不阻断打开。
   */
  private async persistPickerGrant(uri: string): Promise<void> {
    if (typeof uri !== 'string' || uri.indexOf('file://') !== 0 || !this.canPersistUri()) {
      return;
    }
    const policies: Array<fileShare.PolicyInfo> = [{ uri: uri, operationMode: this.rwMode() }];
    try {
      await fileShare.persistPermission(policies);
      console.error('[GenOffice] persistPermission ok: ' + uri);
    } catch (e) {
      const err: BusinessError = e as BusinessError;
      console.warn('[GenOffice] persistPermission failed: code=' + err.code + ', msg=' + err.message + ', uri=' + uri);
    }
  }

  /**
   * 释放持久化授权（条目从「最近打开」移除时调用）。不撤销只涨不落的持久化记录会累积
   * 占用系统策略额度；未持久化过的条目会报 PERMISSION_NOT_PERSISTED（13900001），
   * 属于正常情况（该条目本来就没跨启动授权），只记 warn 不影响移除结果。
   */
  private async revokePickerGrants(uris: Array<string>): Promise<void> {
    if (!this.canPersistUri()) {
      return;
    }
    const policies: Array<fileShare.PolicyInfo> = [];
    for (let i = 0; i < uris.length; i++) {
      const uri: string = uris[i];
      if (typeof uri === 'string' && uri.indexOf('file://') === 0) {
        policies.push({ uri: uri, operationMode: this.rwMode() });
      }
    }
    if (policies.length === 0) {
      return;
    }
    try {
      await fileShare.revokePermission(policies);
      console.error('[GenOffice] revokePermission ok: ' + policies.length + ' 条');
    } catch (e) {
      const err: BusinessError = e as BusinessError;
      console.warn('[GenOffice] revokePermission failed: code=' + err.code + ', msg=' + err.message);
    }
  }

  /**
   * 使能已持久化的授权（幂等）。启动后首次接触最近文件/读文件时执行一次：
   * 已持久化但未激活的授权读不了文件，必须 activatePermission 后才可用。
   * 列表为空时不置位，等 recents 加载完成后下次再试。
   */
  private async activatePersistedGrants(): Promise<void> {
    if (this.activateTried || !this.canPersistUri()) {
      return;
    }
    const policies: Array<fileShare.PolicyInfo> = [];
    for (let i = 0; i < this.recents.length; i++) {
      const uri: string = this.recents[i];
      if (uri.indexOf('file://') === 0) {
        policies.push({ uri: uri, operationMode: this.rwMode() });
      }
    }
    if (policies.length === 0) {
      return;
    }
    this.activateTried = true;
    try {
      await fileShare.activatePermission(policies);
      console.error('[GenOffice] activatePermission ok: ' + policies.length + ' 条');
    } catch (e) {
      const err: BusinessError = e as BusinessError;
      console.warn('[GenOffice] activatePermission failed: code=' + err.code + ', msg=' + err.message);
    }
  }

  /** 权限类失败判定（EPERM 的文案各层不一：libuv / file_api / 1390xxxx 错误码） */
  private isPermissionFailure(raw: string): boolean {
    return /Operation not permitted|permission denied|EPERM|13900012|13900001/i.test(raw);
  }

  /** 权限类失败 → 可操作中文提示（渲染层会原样展示，不能只丢系统 errno 文本） */
  private readFailureText(raw: string): string {
    if (this.isPermissionFailure(raw)) {
      return '无法读取该文件：系统对它的临时授权已失效（应用重启后失效）。'
        + '请用「打开」重新选择该文件；该条目也可在最近列表里移除。';
    }
    return raw;
  }

  /** docs:recent —— 最近文件列表（同步方法，JSON 数组字符串） */
  recentFilesJson(): string {
    return JSON.stringify(this.recents);
  }

  // ================= 起始页「最近打开」=================
  // 字段与语义对齐桌面版 apps/shell/src/main/recent-files.ts 的 RecentEntry/RecentPage：
  // { path, name, ext, mtimeMs, sizeBytes, starred, missing? }。

  /** URI → 文件名（去查询串 + 解码 + 丢目录成分；picker URI 形如 file://docs/storage/.../xx.pdf） */
  private baseNameOf(path: string): string {
    const clean: string = path.indexOf('?') >= 0 ? path.substring(0, path.indexOf('?')) : path;
    let n: string = clean;
    try {
      n = decodeURIComponent(clean);
    } catch (e) { /* 保留原样 */ }
    // 先解码再丢目录成分：反过来会被 %2e%2e%2f（即 ../）绕过下面的 .. 拦截
    const cut: number = Math.max(n.lastIndexOf('/'), n.lastIndexOf('\\'));
    const base: string = cut >= 0 ? n.substring(cut + 1) : n;
    if (base.length === 0 || base === '.' || base === '..') {
      return '';
    }
    return base;
  }

  /** URI → 小写扩展名（不含点） */
  private extOf(path: string): string {
    const clean: string = path.indexOf('?') >= 0 ? path.substring(0, path.indexOf('?')) : path;
    const dot: number = clean.lastIndexOf('.');
    if (dot < 0) {
      return '';
    }
    return clean.substring(dot + 1).toLowerCase();
  }

  /**
   * 单条最近文件记录。stat 失败（picker URI 重启后授权失效 / 文件被移走）不丢条目，
   * 置 missing:true —— 与桌面版 r158 行为一致（列表里灰显而非静默消失）。
   */
  private recentEntryOf(path: string): Record<string, Object> {
    const entry: Record<string, Object> = {
      'path': path, 'name': this.baseNameOf(path), 'ext': this.extOf(path),
      'starred': this.starred.indexOf(path) >= 0
    };
    try {
      const st = fs.statSync(path);
      entry['mtimeMs'] = st.mtime * 1000;
      entry['sizeBytes'] = st.size;
    } catch (e) {
      entry['mtimeMs'] = 0;
      entry['sizeBytes'] = 0;
      entry['missing'] = true;
    }
    return entry;
  }

  /**
   * home:recents —— 分页查询最近文件（等价 Electron ipcMain.handle(HOME_CHANNELS.recents)）。
   * queryJson: {"offset":0,"limit":50,"ext":"pdf"}（ext 省略/空 = 全部；'xlsx' 含 xlsm 同族）。
   * 返回 {"entries":[...],"total":n,"totalAll":n}。
   */
  async recentPageJson(queryJson: string): Promise<string> {
    let offset: number = 0;
    let limit: number = 50;
    let ext: string = '';
    let starOnly: boolean = false;
    try {
      const q: Record<string, Object> = JSON.parse(queryJson || '{}') as Record<string, Object>;
      const off: Object = q['offset'];
      const lim: Object = q['limit'];
      const e0: Object = q['ext'];
      const st: Object = q['starred'];
      offset = typeof off === 'number' ? Math.max(0, Math.floor(off)) : 0;
      limit = typeof lim === 'number' ? Math.min(200, Math.max(0, Math.floor(lim))) : 50;
      ext = typeof e0 === 'string' ? (e0 as string).toLowerCase() : '';
      starOnly = st === true;
    } catch (e) { /* 用默认分页 */ }
    // 列表要在 stat 前使能持久化授权，否则跨启动的条目会被误判成 missing（灰显"不可用"）
    await this.activatePersistedGrants();
    const family: Array<string> = ext.length === 0 ? [] : (ext === 'xlsx' ? ['xlsx', 'xlsm'] : [ext]);
    const source: Array<string> = starOnly ? this.starred : this.recents;
    const all: Array<Record<string, Object>> = [];
    const filtered: Array<Record<string, Object>> = [];
    for (let i = 0; i < source.length; i++) {
      const entry: Record<string, Object> = this.recentEntryOf(source[i]);
      all.push(entry);
      const e: string = String(entry['ext'] ?? '');
      if (family.length === 0 || family.includes(e)) {
        filtered.push(entry);
      }
    }
    const page: Array<Record<string, Object>> = limit === 0 ? [] : filtered.slice(offset, offset + limit);
    return JSON.stringify({ entries: page, total: filtered.length, totalAll: all.length });
  }

  /** 批量 stat（项目视图 statPaths）：返回 RecentEntry[]，无法 stat 的项标 missing。 */
  async statPathsJson(pathsJson: string): Promise<string> {
    const out: Array<Record<string, Object>> = [];
    let paths: Array<string> = [];
    try {
      paths = JSON.parse(pathsJson || '[]') as Array<string>;
    } catch (e) {
      paths = [];
    }
    await this.activatePersistedGrants();
    for (let i = 0; i < paths.length; i++) {
      if (typeof paths[i] === 'string' && paths[i].length > 0) {
        out.push(this.recentEntryOf(paths[i]));
      }
    }
    return JSON.stringify(out);
  }

  /** 从最近列表移除（只改列表，不删文件）并落盘。 */
  async removeRecentJson(pathsJson: string): Promise<string> {
    let paths: Array<string> = [];
    try {
      paths = JSON.parse(pathsJson || '[]') as Array<string>;
    } catch (e) {
      paths = [];
    }
    const removed: Array<string> = [];
    for (let i = 0; i < paths.length; i++) {
      const p: string = paths[i];
      const idx: number = this.recents.indexOf(p);
      if (idx >= 0) {
        this.recents.splice(idx, 1);
      }
      // 确实已不在列表（含参数里重复出现的同一条）才计入待撤销；去重避免重复策略
      if (this.recents.indexOf(p) < 0 && removed.indexOf(p) < 0) {
        removed.push(p);
      }
    }
    this.saveRecents();
    // 条目已不在列表 → 释放系统侧持久化授权，别让持久化记录只增不减（系统对策略数量有上限）
    await this.revokePickerGrants(removed);
    return JSON.stringify({ ok: true });
  }

  // ================= 收藏 / 搜索 / 文件操作（起始页「更多」菜单）=================

  private starredFile(): string {
    return this.ctx ? this.ctx.filesDir + '/genoffice-starred.json' : '';
  }

  private loadStarred(): void {
    try {
      const f: string = this.starredFile();
      if (f.length === 0) { return; }
      try { fs.accessSync(f); } catch (e) { return; }
      const file = fs.openSync(f, fs.OpenMode.READ_ONLY);
      try {
        const st = fs.statSync(file.fd);
        const buf = new ArrayBuffer(st.size);
        fs.readSync(file.fd, buf);
        const text = util.TextDecoder.create('utf-8').decodeToString(new Uint8Array(buf));
        const parsed: Array<string> = JSON.parse(text) as Array<string>;
        const arr: Array<string> = [];
        for (let i = 0; i < parsed.length; i++) {
          if (typeof parsed[i] === 'string' && parsed[i].length > 0) { arr.push(parsed[i]); }
        }
        this.starred = arr;
      } finally {
        try { fs.closeSync(file); } catch (e) { /* 忽略关闭失败 */ }
      }
    } catch (e) {
      this.starred = [];
    }
  }

  private saveStarred(): void {
    try {
      const f: string = this.starredFile();
      if (f.length === 0) { return; }
      const data = util.TextEncoder.create('utf-8').encodeInto(JSON.stringify(this.starred));
      const ab = new ArrayBuffer(data.byteLength);
      new Uint8Array(ab).set(data);
      const file = fs.openSync(f, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
      try {
        fs.writeSync(file.fd, ab);
      } finally {
        try { fs.closeSync(file); } catch (e) { /* 忽略关闭失败 */ }
      }
    } catch (e) {
      // 收藏落盘失败不阻断操作，本次会话内仍生效
    }
  }

  /** 收藏 / 取消收藏（等价桌面 toggleStarredFile）。返回 {ok, starred}。 */
  async toggleStarJson(pathArg: string): Promise<string> {
    const p: string = String(pathArg ?? '');
    if (p.length === 0) { return JSON.stringify({ ok: false, error: '路径为空' }); }
    const i: number = this.starred.indexOf(p);
    if (i >= 0) { this.starred.splice(i, 1); } else { this.starred.unshift(p); }
    this.saveStarred();
    return JSON.stringify({ ok: true, starred: i < 0 });
  }

  /** 目录部分（保留 URI 形如 file://docs/storage/... 的原样前缀） */
  private dirNameOf(path: string): string {
    const p: string = String(path ?? '');
    const cut: number = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return cut > 0 ? p.substring(0, cut) : '';
  }

  /**
   * 起始页关键词搜索（FileSearchPage）。鸿蒙版没有桌面 Jev 全文索引，这里给可兑现的
   * 最小实现：最近列表 + 收藏 + 本应用文档目录（filesDir/GenOffice）里的文件名匹配。
   * 命中字段与桌面一致（name/path/needles/snippet），snippet 恒 null（无内容摘录）。
   */
  async searchFilesJson(reqJson: string): Promise<string> {
    let q: string = '';
    let ext: string = '';
    let limit: number = 100;
    try {
      const r: Record<string, Object> = JSON.parse(reqJson || '{}') as Record<string, Object>;
      q = typeof r['q'] === 'string' ? (r['q'] as string) : '';
      ext = typeof r['ext'] === 'string' ? (r['ext'] as string).toLowerCase() : '';
      limit = typeof r['limit'] === 'number' ? Math.min(200, Math.max(1, Math.floor(r['limit'] as number))) : 100;
    } catch (e) { /* 用默认参数 */ }
    const needle: string = q.trim().toLowerCase();
    if (needle.length === 0) {
      const emptyIdx: Record<string, Object> = { 'indexed': 0, 'pending': 0, 'scanning': false };
      const emptyOut: Record<string, Object> = { 'hits': [], 'total': 0, 'index': emptyIdx };
      return JSON.stringify(emptyOut);
    }
    await this.activatePersistedGrants();
    const paths: Array<string> = [];
    const push = (p: string): void => {
      if (typeof p === 'string' && p.length > 0 && paths.indexOf(p) < 0) { paths.push(p); }
    };
    for (let i = 0; i < this.recents.length; i++) { push(this.recents[i]); }
    for (let i = 0; i < this.starred.length; i++) { push(this.starred[i]); }
    // 本应用落盘目录（新建文档都在这里，从未进过 recents 的也要能搜到）
    try {
      if (this.ctx) {
        const dir: string = this.ctx.filesDir + '/GenOffice';
        const names: Array<string> = fs.listFileSync(dir);
        for (let i = 0; i < names.length; i++) { push(dir + '/' + names[i]); }
      }
    } catch (e) { /* 目录不存在 */ }
    const family: Array<string> = ext.length === 0 ? [] : (ext === 'xlsx' ? ['xlsx', 'xlsm'] : [ext]);
    const hits: Array<Record<string, Object>> = [];
    for (let i = 0; i < paths.length; i++) {
      const p: string = paths[i];
      const name: string = this.baseNameOf(p);
      const e: string = this.extOf(p);
      if (family.length > 0 && family.indexOf(e) < 0) { continue; }
      const dirName: string = this.baseNameOf(this.dirNameOf(p));
      if (name.toLowerCase().indexOf(needle) < 0 && dirName.toLowerCase().indexOf(needle) < 0) { continue; }
      const entry: Record<string, Object> = this.recentEntryOf(p);
      entry['needles'] = [q.trim()];
      // 契约允许 snippet: null，但 Record<string, Object> 不能存 null；省略该字段
      // 时渲染层 if (hit.snippet) 同样走「仅名称命中」分支。
      hits.push(entry);
    }
    // 名称前缀命中优先，其次最近修改
    hits.sort((a: Record<string, Object>, b: Record<string, Object>): number => {
      const an: string = String(a['name'] ?? '').toLowerCase();
      const bn: string = String(b['name'] ?? '').toLowerCase();
      const ap: number = an.indexOf(needle) === 0 ? 0 : 1;
      const bp: number = bn.indexOf(needle) === 0 ? 0 : 1;
      if (ap !== bp) { return ap - bp; }
      return Number(b['mtimeMs'] ?? 0) - Number(a['mtimeMs'] ?? 0);
    });
    const total: number = hits.length;
    const page: Array<Record<string, Object>> = hits.slice(0, limit);
    const pageIdx: Record<string, Object> = {
      'indexed': paths.length, 'pending': 0, 'scanning': false
    };
    const pageOut: Record<string, Object> = {
      'hits': page, 'total': total, 'index': pageIdx
    };
    return JSON.stringify(pageOut);
  }

  /** 重命名（等价桌面 HOME_CHANNELS.renameFile → {ok,path}|{ok:false,error}） */
  async renameFileJson(pathArg: string, newNameArg: string): Promise<string> {
    const p: string = String(pathArg ?? '');
    const raw: string = String(newNameArg ?? '');
    if (p.length === 0 || raw.length === 0) { return JSON.stringify({ ok: false, error: '参数不完整' }); }
    if (/[\\/:*?"<>|]/.test(raw)) { return JSON.stringify({ ok: false, error: '文件名包含非法字符' }); }
    const name: string = raw.trim();
    if (name.length === 0 || name === '.' || name === '..') {
      return JSON.stringify({ ok: false, error: '文件名无效' });
    }
    const dir: string = this.dirNameOf(p);
    if (dir.length === 0) { return JSON.stringify({ ok: false, error: '无法确定文件所在目录' }); }
    const target: string = dir + '/' + name;
    if (target === p) { return JSON.stringify({ ok: true, path: p }); }
    try {
      fs.renameSync(p, target);
    } catch (e) {
      return JSON.stringify({ ok: false, error: '重命名失败：' + (e instanceof Error ? e.message : String(e)) });
    }
    const at: number = this.recents.indexOf(p);
    if (at >= 0) { this.recents[at] = target; this.saveRecents(); }
    const si: number = this.starred.indexOf(p);
    if (si >= 0) { this.starred[si] = target; this.saveStarred(); }
    return JSON.stringify({ ok: true, path: target });
  }

  /** 创建副本（等价桌面「名字 副本.ext / 名字 副本 2.ext」命名） */
  async duplicateFileJson(pathArg: string): Promise<string> {
    const p: string = String(pathArg ?? '');
    if (p.length === 0) { return JSON.stringify({ ok: false, error: '路径为空' }); }
    const dir: string = this.dirNameOf(p);
    const name: string = this.baseNameOf(p);
    const dot: number = name.lastIndexOf('.');
    const base: string = dot > 0 ? name.substring(0, dot) : name;
    const ext: string = dot > 0 ? name.substring(dot) : '';
    try {
      let target: string = '';
      for (let i = 1; i < 1000; i++) {
        target = dir + '/' + base + ' 副本' + (i === 1 ? '' : ' ' + i.toString()) + ext;
        try { fs.accessSync(target); } catch (e) { break; } // 不存在 → 可用
      }
      if (target.length === 0) { return JSON.stringify({ ok: false, error: '找不到可用的副本文件名' }); }
      fs.copyFileSync(p, target);
      this.pushRecent(target);
      return JSON.stringify({ ok: true, path: target });
    } catch (e) {
      return JSON.stringify({ ok: false, error: '创建副本失败：' + (e instanceof Error ? e.message : String(e)) });
    }
  }

  /** 删除文件（鸿蒙无回收站 API → 直接 unlink；失败项原样返回错误） */
  async deleteFilesJson(pathsJson: string): Promise<string> {
    let paths: Array<string> = [];
    try { paths = JSON.parse(pathsJson || '[]') as Array<string>; } catch (e) { paths = []; }
    const failed: Array<Record<string, Object>> = [];
    for (let i = 0; i < paths.length; i++) {
      const p: string = String(paths[i] ?? '');
      if (p.length === 0) { continue; }
      try {
        fs.unlinkSync(p);
      } catch (e) {
        const item: Record<string, Object> = {
          'path': p, 'error': e instanceof Error ? e.message : String(e)
        };
        failed.push(item);
        continue;
      }
      const at: number = this.recents.indexOf(p);
      if (at >= 0) { this.recents.splice(at, 1); }
      const si: number = this.starred.indexOf(p);
      if (si >= 0) { this.starred.splice(si, 1); }
    }
    this.saveRecents();
    this.saveStarred();
    return JSON.stringify({ ok: failed.length === 0, failed: failed });
  }

  /** 「打开所在文件夹」：鸿蒙没有文件管理器定位 API，退化为用系统能力打开所在目录 */
  async revealPathJson(pathArg: string): Promise<string> {
    const p: string = String(pathArg ?? '');
    const dir: string = this.dirNameOf(p);
    if (dir.length === 0) { return JSON.stringify({ ok: false, error: '无法确定所在目录' }); }
    try {
      if (!this.ctx) { return JSON.stringify({ ok: false, error: 'ctx unavailable' }); }
      const want: Want = {
        action: 'ohos.want.action.viewData',
        entities: ['entity.system.browsable'],
        uri: dir
      };
      const uiCtx = this.ctx as common.UIAbilityContext;
      await uiCtx.startAbility(want);
      return JSON.stringify({ ok: true });
    } catch (e) {
      return JSON.stringify({ ok: false, error: '打开所在文件夹失败：' + (e instanceof Error ? e.message : String(e)) });
    }
  }

  /**
   * pdf:create —— 新建空白 PDF（等价 Electron newPdfTab：blankPdfBuffer 落盘再打开）。
   * 落 filesDir/GenOffice/<title>.pdf，同名自动加 " (n)"。返回 {"ok":true,"path"}。
   */
  async createDocumentJson(type: string, title: string, content: string): Promise<string> {
    try {
      if (type !== 'pdf') {
        return JSON.stringify({ ok: false, error: 'unsupported type: ' + type });
      }
      if (!this.ctx) {
        return JSON.stringify({ ok: false, error: 'no context' });
      }
      const dir: string = this.ctx.filesDir + '/GenOffice';
      try {
        fs.mkdirSync(dir, true);
      } catch (e) {
        // 已存在
      }
      let name: string = (typeof title === 'string' && title.trim().length > 0)
        ? title.trim() : 'Untitled';
      // new RegExp 形式：正则字面量 /[...]/ 的裸 "[" 会干扰 scripts/arkts-balance.mjs 的括号扫描
      name = name.replace(new RegExp('[\\\\/:*?"<>|]', 'g'), '_');
      const path: string = this.nextFreePath(dir, name + '.pdf');
      this.writeBytes(path, this.blankPdfBytes());
      this.writable.add(path);
      this.pushRecent(path);
      return JSON.stringify({ ok: true, path: path });
    } catch (e) {
      return JSON.stringify({ ok: false, error: String(e) });
    }
  }

  /**
   * 签名库列表（渲染层 SignatureDialog 启动时拉取）。返回 SavedSignature[] 的 JSON 串；
   * 文件缺失/损坏/手工改坏条目 → 丢坏条目不整表失败（与桌面 sanitizeSignatures 一致）。
   */
  async listSavedSignaturesJson(): Promise<string> {
    return JSON.stringify(this.loadSignatures());
  }

  /**
   * 持久化一条签名供复用（渲染层「保存签名以便复用」）：入参是 SignatureData，
   * 这里补 id/createdAt → 同图去重（新的排最前）→ 截断到 10 条，返回更新后的列表。
   */
  async addSavedSignatureJson(dataJson: string): Promise<string> {
    let data: PdfSignatureData | undefined = undefined;
    try {
      data = JSON.parse(dataJson || '{}') as PdfSignatureData;
    } catch (e) {
      data = undefined;
    }
    if (!data || !this.isSignatureData(data)) {
      return JSON.stringify(this.loadSignatures());
    }
    const key: string = JSON.stringify(data);
    const kept: Array<PdfSavedSignature> = [];
    const list: Array<PdfSavedSignature> = this.loadSignatures();
    for (let i = 0; i < list.length; i++) {
      // 同一张图重复保存 → 刷新位置而不是新增（桌面 sameData 语义）
      if (JSON.stringify(list[i].data) !== key) {
        kept.push(list[i]);
      }
    }
    const next: Array<PdfSavedSignature> = [{ id: util.generateRandomUUID(true), createdAt: Date.now(), data: data }];
    for (let i = 0; i < kept.length && next.length < DesktopBridge.MAX_SAVED_SIGNATURES; i++) {
      next.push(kept[i]);
    }
    this.saveSignatures(next);
    return JSON.stringify(next);
  }

  /** 删除一条签名（渲染层按 id 删），返回更新后的列表 */
  async removeSavedSignatureJson(id: string): Promise<string> {
    const list: Array<PdfSavedSignature> = this.loadSignatures();
    const next: Array<PdfSavedSignature> = [];
    for (let i = 0; i < list.length; i++) {
      if (list[i].id !== id) {
        next.push(list[i]);
      }
    }
    this.saveSignatures(next);
    return JSON.stringify(next);
  }

  private signaturesFile(): string {
    return this.ctx ? this.ctx.filesDir + '/genoffice-pdf-signatures.json' : '';
  }

  /** 入参校验（对齐桌面 isSignatureData：尺寸为正、image 非空或 strokes 有至少一条折线） */
  private isSignatureData(d: PdfSignatureData): boolean {
    if (typeof d.width !== 'number' || typeof d.height !== 'number' || d.width <= 0 || d.height <= 0) {
      return false;
    }
    if (d.kind === 'image') {
      return typeof d.image === 'string' && d.image.length > 0;
    }
    if (d.kind === 'strokes') {
      if (!Array.isArray(d.paths) || d.paths.length === 0) {
        return false;
      }
      for (let i = 0; i < d.paths.length; i++) {
        const p: Array<number> = d.paths[i];
        if (!Array.isArray(p) || p.length < 4) {
          return false;
        }
      }
      return true;
    }
    return false;
  }

  private loadSignatures(): Array<PdfSavedSignature> {
    const out: Array<PdfSavedSignature> = [];
    try {
      const f: string = this.signaturesFile();
      if (f.length === 0) {
        return out;
      }
      try { fs.accessSync(f); } catch (e) { return out; } // 不存在 → 空列表
      const file = fs.openSync(f, fs.OpenMode.READ_ONLY);
      try {
        const st = fs.statSync(file.fd);
        const buf = new ArrayBuffer(st.size);
        fs.readSync(file.fd, buf);
        const text = util.TextDecoder.create('utf-8').decodeToString(new Uint8Array(buf));
        const raw = JSON.parse(text) as Array<PdfSavedSignature>;
        if (!Array.isArray(raw)) {
          return out;
        }
        for (let i = 0; i < raw.length; i++) {
          const e: PdfSavedSignature = raw[i];
          if (!e || typeof e.id !== 'string' || e.id.length === 0) {
            continue;
          }
          const d: PdfSignatureData = e.data;
          if (!d || !this.isSignatureData(d)) {
            continue;
          }
          let dup: boolean = false;
          for (let j = 0; j < out.length; j++) {
            if (out[j].id === e.id) { dup = true; break; }
          }
          if (dup) {
            continue;
          }
          const createdAt: number = (typeof e.createdAt === 'number' && isFinite(e.createdAt)) ? e.createdAt : 0;
          out.push({ id: e.id, createdAt: createdAt, data: d });
        }
      } finally {
        try { fs.closeSync(file); } catch (e) { /* 忽略关闭失败 */ }
      }
    } catch (e) {
      return [];
    }
    return out;
  }

  /** 原子写（tmp + rename）：写盘中途崩溃不会把已存签名整表写坏（对齐桌面 saveSignatures） */
  private saveSignatures(list: Array<PdfSavedSignature>): void {
    try {
      const f: string = this.signaturesFile();
      if (f.length === 0) {
        return;
      }
      const tmp: string = f + '.tmp';
      this.writeJsonBytes(tmp, JSON.stringify(list));
      fs.renameSync(tmp, f);
    } catch (e) {
      console.error('[GenOffice] saveSignatures failed: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  /** 写 UTF-8 JSON 字节（覆盖写）；签名图是 base64，单选写盘不占主线程 */
  private writeJsonBytes(path: string, json: string): void {
    const data = util.TextEncoder.create('utf-8').encodeInto(json);
    const ab = new ArrayBuffer(data.byteLength);
    new Uint8Array(ab).set(data);
    const file = fs.openSync(path, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
    try {
      fs.writeSync(file.fd, ab);
    } finally {
      try { fs.closeSync(file); } catch (e) { /* 忽略关闭失败 */ }
    }
  }

  /** 最小合法空白 PDF（1 页 Letter）。xref 偏移按构造逐段累计，纯 ASCII。 */
  private blankPdfBytes(): Uint8Array {
    const parts: string[] = [];
    const offsets: number[] = [];
    let len = 0;
    const push = (s: string): void => {
      parts.push(s);
      len += s.length;
    };
    push('%PDF-1.4\n');
    offsets.push(len);
    push('1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n');
    offsets.push(len);
    push('2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n');
    offsets.push(len);
    push('3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<<>>>>endobj\n');
    const xrefAt = len;
    let xref = 'xref\n0 4\n0000000000 65535 f \n';
    for (const off of offsets) {
      xref += String(off).padStart(10, '0') + ' 00000 n \n';
    }
    xref += 'trailer<</Size 4/Root 1 0 R>>\nstartxref\n' + xrefAt + '\n%%EOF\n';
    push(xref);
    const out = new Uint8Array(len);
    let i = 0;
    for (const s of parts) {
      for (let j = 0; j < s.length; j++) {
        out[i++] = s.charCodeAt(j) & 0xff;
      }
    }
    return out;
  }

  /**
   * 通用另存为（markdown/slides 共用；与 saveAsDocxJson 不同，不强制补 .docx 后缀，
   * 由调用方传完整文件名）。系统保存选择器 → 写盘 → 授权。
   * 取消返回 {"ok":true,"canceled":true}，失败 {"ok":false,"error"}。
   */
  async saveAsAnyJson(defaultName: string, b64: string): Promise<string> {
    try {
      const name: string = (typeof defaultName === 'string' && defaultName.length > 0)
        ? defaultName : 'Untitled';
      const docPicker = new picker.DocumentViewPicker(this.ctx as common.Context);
      const uris: string[] = await docPicker.save({ newFileNames: [name] });
      if (uris.length === 0) {
        return JSON.stringify({ ok: true, canceled: true });
      }
      const uri = uris[0];
      await this.persistPickerGrant(uri);
      await taskpool.execute(writeFilePayload, uri, b64 ?? '');
      this.writable.add(uri);
      this.pushRecent(uri);
      return JSON.stringify({ ok: true, path: uri });
    } catch (e) {
      return JSON.stringify({ ok: false, error: String(e) });
    }
  }

  /** 通用覆盖保存（path 必须是此前保存/另存授权过的 URI，等价 saveDocxJson 的泛化） */
  async saveAnyJson(path: string, b64: string): Promise<string> {
    try {
      if (typeof path !== 'string' || !this.writable.has(path)) {
        return JSON.stringify({ ok: false, error: 'save target is not an opened document' });
      }
      await taskpool.execute(writeFilePayload, path, b64 ?? '');
      this.pushRecent(path);
      return JSON.stringify({ ok: true, path: path });
    } catch (e) {
      return JSON.stringify({ ok: false, error: String(e) });
    }
  }

  /**
   * 写入已授权目录下的新文件（PDF 导出图片 / 拆分 PDF 多文件共用的落盘口）。
   * dirUri 必须是 pickDirectory() 返回并登记过的目录；fileName 只取 basename，
   * 写入成功后新 URI 进 writable（后续覆盖保存无需再选目录）。
   */
  async saveInDirJson(dirUri: string, fileName: string, b64: string): Promise<string> {
    try {
      if (typeof dirUri !== 'string' || !this.grantedDirs.has(dirUri)) {
        return JSON.stringify({ ok: false, error: 'save target directory is not granted' });
      }
      const base: string = this.baseNameOf(fileName);
      if (base.length === 0) {
        return JSON.stringify({ ok: false, error: 'invalid file name' });
      }
      const uri: string = dirUri.endsWith('/') ? dirUri + base : dirUri + '/' + base;
      await taskpool.execute(writeFilePayload, uri, b64 ?? '');
      this.writable.add(uri);
      return JSON.stringify({ ok: true, path: uri });
    } catch (e) {
      return JSON.stringify({ ok: false, error: String(e) });
    }
  }

  // ================= sheets xlsx（M4 §4 napi in-process sidecar bridge）================
  // 背景：商业 HarmonyOS NEXT SDK 无 @ohos.process.childprocess，独立 ELF 无法被拉起。
  // M4 §4 预案改走 napi cdylib：ArkTS import 'libxlsx_sidecar.so' 直调 handle()，
  // 每次调用 = 桌面 sidecar 的一行 JSON 协议。本批方法负责把 sheets renderer 的
  // Electron IPC 请求翻译成这些命令（等价 sheets-main.ts 的职责），返回值一律
  // JSON 字符串（PROMISE_SHIM 侧 unwrap）。
  //
  // 关键差异：sidecar.open 需要真实文件系统路径，而 picker 返回的是 file:// URI ——
  // 打开前先把 URI 字节落盘到 filesDir 快照，sidecar open 快照；保存链路后续
  // save_archive 以快照为源、写回 URI（writable 授权表约定与 docs 一致）。

  /** 快照目录（sidecar 会话的保存基准，与桌面 snapshotWorkbook 同语义） */
  private sheetsSessionsDir(): string {
    if (!this.ctx) {
      return '';
    }
    const dir: string = this.ctx.filesDir + '/genoffice-sheets-sessions';
    try {
      fs.mkdirSync(dir, true);
    } catch (e) { /* 已存在 */ }
    return dir;
  }

  /** 崩溃恢复副本目录（桌面 userData/sheets-autosave 的鸿蒙等价）*/
  private sheetsRecoveryDir(): string {
    if (!this.ctx) {
      return '';
    }
    const dir: string = this.ctx.filesDir + '/genoffice-sheets-recovery';
    try {
      fs.mkdirSync(dir, true);
    } catch (e) { /* 已存在 */ }
    return dir;
  }

  /** 原文件 URI → 恢复副本路径（'' = filesDir 不可用）*/
  private sheetsRecoveryPath(uri: string): string {
    const dir: string = this.sheetsRecoveryDir();
    if (dir.length === 0 || uri.length === 0) {
      return '';
    }
    return dir + '/r-' + sheetsRecoveryKey(uri) + '.xlsx';
  }

  /**
   * 目标 URI 的「size:mtime」戳（读不到返回 ''）。用 openSync + statSync(fd)：
   * picker URI 直接 statSync(uri) 在鸿蒙上不稳，而 openSync(uri) 是本文件已验证的路径。
   */
  private statUriStamp(uri: string): string {
    let file: fs.File | null = null;
    try {
      file = fs.openSync(uri, fs.OpenMode.READ_ONLY);
      const st = fs.statSync(file.fd);
      return st.size.toString() + ':' + st.mtime.toString();
    } catch (e) {
      return '';
    } finally {
      if (file !== null) {
        try { fs.closeSync(file); } catch (e) { /* 忽略关闭失败 */ }
      }
    }
  }

  /** 删除某原文件的恢复副本（用户放弃恢复 / 保存成功后）*/
  private clearSheetsRecovery(uri: string): void {
    const copy: string = this.sheetsRecoveryPath(uri);
    if (copy.length === 0) {
      return;
    }
    try {
      fs.unlinkSync(copy);
    } catch (e) { /* 没有副本就是已清理 */ }
  }

  /**
   * 打开前查「比原文件新的恢复副本」：副本存在且其 mtime >= 原文件 mtime → 返回副本路径；
   * 陈旧副本（原文件更新过 = 用户已正常保存）当场删除 —— 对齐桌面 pendingRecoveryFor。
   * 原文件戳取不到时保守提问（副本存在即可能有未保存内容）。
   */
  private pendingSheetsRecovery(uri: string): string {
    const copy: string = this.sheetsRecoveryPath(uri);
    if (copy.length === 0) {
      return '';
    }
    let copyMtime: number = -1;
    try {
      copyMtime = fs.statSync(copy).mtime;
    } catch (e) {
      return ''; // 没有副本（或不可读）
    }
    const stamp: string = this.statUriStamp(uri);
    if (stamp.length > 0) {
      const originalMtime: number = Number(stamp.split(':')[1]);
      if (originalMtime >= copyMtime) {
        this.clearSheetsRecovery(uri);
        return '';
      }
    }
    return copy;
  }

  /**
   * sheets:select-workbook（打开 xlsx）。pathArg 传 '' 时弹系统选择器。
   * 成功返回 WorkbookFile（camelCase，兼容 workbookFileSchema），取消/失败返回 'null'。
   * M7-4：该文件存在更新的恢复副本时先返回 {ok:false,needsRecovery:true,prompt}，帧侧据此
   * 弹「恢复/放弃」对话框，回答经 xlsRecoveryResolveJson 再走真正的打开。
   */
  async xlsOpenJson(pathArg: string): Promise<string> {
    // 内部失败一律返回 {"ok":false,"error":"<原因>"}（渲染层 selectWorkbook 抛错上屏），
    // 仅用户取消选择器返回 'null'（渲染层按 appOpenCanceled 处理）。
    const fail = (reason: string): string => {
      console.error('[GenOffice] xlsOpenJson: ' + reason);
      return JSON.stringify({ ok: false, error: reason });
    };
    let uri: string = '';
    if (typeof pathArg === 'string' && pathArg.length > 0) {
      uri = pathArg;
    } else {
      try {
        const docPicker = new picker.DocumentViewPicker(this.ctx as common.Context);
        const uris: string[] = await docPicker.select({
          maxSelectNumber: 1,
          fileSuffixFilters: ['.xlsx', '.xlsm', '.xls', '.csv'],
        });
        if (uris.length === 0) {
          return 'null';
        }
        uri = uris[0];
        // 新选的 workbook 也要持久化授权（另存目标路径同理），否则下次启动重开会 EPERM
        await this.persistPickerGrant(uri);
      } catch (e) {
        return fail('picker 异常: ' + (e instanceof Error ? e.message : String(e)));
      }
    }
    // 重开（pathArg 来自最近列表）时先使能持久化授权
    await this.activatePersistedGrants();
    // M7-4 崩溃恢复：提问优先于读字节（大文件不必白读一遍再发现要恢复）
    const pending: string = this.pendingSheetsRecovery(uri);
    if (pending.length > 0) {
      let savedAtMs: number = Date.now();
      try {
        savedAtMs = Math.floor(fs.statSync(pending).mtime * 1000);
      } catch (e) { /* 取不到副本 mtime：用当前时间，只影响对话框上的时间文案 */ }
      const fileName: string = uri.split('/').pop() ?? '';
      // ArkTS 禁无类型对象字面量（arkts-no-untyped-obj-literals）：嵌套结构必须落到
      // 已声明的类型上，按本文件惯例用 Record<string, Object>（对齐 sheets preload 的
      // 7 字段校验；渲染层 RecoveryDialog 直接读这些 key）。
      const prompt: Record<string, Object> = {
        'title': '发现自动恢复版本',
        'body': '上次会话有未保存的更改。要恢复自动保存的版本吗?恢复后,保存将直接覆盖原文件。',
        'restoreLabel': '恢复',
        'discardLabel': '放弃',
        'fileName': fileName,
        'savedAtMs': savedAtMs
      };
      return JSON.stringify({
        ok: false,
        needsRecovery: true,
        path: uri,
        prompt: prompt
      });
    }
    return this.openSheetFromUri(uri, '', '');
  }

  /**
   * M7-4：恢复提问的回答（choice = 'restore' | 'discard' | 'dismissed'）。
   * restore → 以恢复副本为底开会话、保存写回原文件；discard → 删副本后打开原文件；
   * dismissed（渲染层没回答，例如提问途中被关掉）→ 打开原文件但保留副本，下次再问。
   */
  async xlsRecoveryResolveJson(uri: string, choice: string): Promise<string> {
    const target: string = String(uri ?? '');
    if (target.length === 0) {
      return JSON.stringify({ ok: false, error: '恢复副本缺少原文件路径' });
    }
    if (choice === 'restore') {
      const copy: string = this.sheetsRecoveryPath(target);
      if (copy.length === 0) {
        return JSON.stringify({ ok: false, error: 'filesDir 不可用' });
      }
      // 记下「打开时刻」的原文件戳：保存写回前比对该戳，防止覆盖别处对原文件的改动
      // （桌面用 restoreTargetSha 内容哈希，这里用 size:mtime，差异已在交付说明标注）
      return this.openSheetFromUri(copy, target, this.statUriStamp(target));
    }
    if (choice === 'discard') {
      this.clearSheetsRecovery(target);
    }
    return this.openSheetFromUri(target, '', '');
  }

  /**
   * sheets 崩溃恢复副本（桌面 writeWorkbookRecovery）：把当前未保存的编辑写一份真实的
   * .xlsx 到 filesDir/genoffice-sheets-recovery（桌面写 userData/sheets-autosave）。
   * best-effort：失败只回 {ok:false}（渲染层静默跳过本轮，桌面同语义）。绝不替换渲染层
   * 持有的会话（桌面「no session swap」）——保存出来的新会话读完字节立刻关掉。
   */
  async xlsRecoveryWriteJson(reqJson: string): Promise<string> {
    try {
      const req: Record<string, Object> = JSON.parse(reqJson || '{}') as Record<string, Object>;
      const sessionId: string = String(req['sessionId'] ?? '');
      const edits: Array<Object> = (req['normalizedEdits'] as Array<Object>) ?? [];
      const structuralOps: Array<Object> = (req['structuralOps'] as Array<Object>) ?? [];
      const sheetOps: Array<Object> = (req['sheetOps'] as Array<Object>) ?? [];
      const sheetOrder: Array<string> = (req['sheetOrder'] as Array<string>) ?? [];
      if (sessionId.length === 0) {
        return JSON.stringify({ ok: false });
      }
      if (edits.length === 0 && structuralOps.length === 0 && sheetOps.length === 0) {
        return JSON.stringify({ ok: false });
      }
      // 无原文件（未命名/导入副本）或本身就是恢复会话 → 不写副本（桌面同样 stand down）
      const uri: string | undefined = this.sheetsSessionUris.get(sessionId);
      if (uri === undefined || this.sheetsRestoreTargets.has(sessionId)) {
        return JSON.stringify({ ok: false });
      }
      const target: string = this.sheetsRecoveryPath(uri);
      const dir: string = this.sheetsSessionsDir();
      if (target.length === 0 || dir.length === 0) {
        return JSON.stringify({ ok: false });
      }
      const snap: string = dir + '/r-' + Date.now().toString() + '.xlsx';
      const raw: string = sheetOps.length > 0
        ? await this.xlsxSidecar.saveSheetOpsKeepOld(sessionId, snap, edits, structuralOps, sheetOps, sheetOrder)
        : await this.xlsxSidecar.saveCellsKeepOld(sessionId, snap, edits, structuralOps);
      const parsed: Record<string, Object> = JSON.parse(raw) as Record<string, Object>;
      if (parsed['ok'] !== true) {
        console.warn('[GenOffice] xlsRecovery: engine ' + raw.substring(0, 160));
        return JSON.stringify({ ok: false });
      }
      const result: Record<string, Object> = (parsed['result'] as Record<string, Object>) ?? {};
      const newSessionId: string = String(result['sessionId'] ?? '');
      const payload: Record<string, string> = await taskpool.execute(readFilePayload, snap) as Record<string, string>;
      if (payload.error) {
        console.warn('[GenOffice] xlsRecovery: read snap failed ' + String(payload.error));
        return JSON.stringify({ ok: false });
      }
      await taskpool.execute(writeFilePayload, target, String(payload.b64));
      // 副本已落盘：临时快照会话与临时快照都立刻释放（源会话与渲染层 sessionId 不变）
      if (newSessionId.length > 0) {
        await this.xlsxSidecar.close(newSessionId);
      }
      try { fs.unlinkSync(snap); } catch (e) { /* 临时快照清理失败可忽略 */ }
      return JSON.stringify({ ok: true });
    } catch (e) {
      console.warn('[GenOffice] xlsRecovery failed: ' + (e instanceof Error ? e.message : String(e)));
      return JSON.stringify({ ok: false });
    }
  }

  /**
   * 真正打开：读 URI 字节 → 快照落盘 → sidecar open → 装配 WorkbookFile。
   * restoreTarget 非空 = 本次打开的是恢复副本，保存要写回 restoreTarget（桌面同语义：
   * 渲染层看到的 path 仍是原文件，并带 restoredFromRecovery=true）。
   */
  private async openSheetFromUri(openUri: string, restoreTarget: string, restoreStamp: string): Promise<string> {
    const fail = (reason: string): string => {
      console.error('[GenOffice] xlsOpenJson: ' + reason);
      return JSON.stringify({ ok: false, error: reason });
    };
    const writeBack: string = restoreTarget.length > 0 ? restoreTarget : openUri;
    // 1) 读 URI 字节（TaskPool 优先，失败回退主线程）
    let payload: Record<string, string>;
    try {
      payload = await taskpool.execute(readFilePayload, openUri) as Record<string, string>;
    } catch (e) {
      console.warn('[GenOffice] xlsOpen taskpool fail, fallback: ' + String(e));
      try {
        payload = readUriOnMainThread(openUri);
      } catch (e2) {
        return fail('读文件失败(主线程): ' + (e2 instanceof Error ? e2.message : String(e2)));
      }
    }
    // taskpool 软失败且为权限错 → 主线程重试一次（同 readDocxUri 的 M3 兜底）
    if (payload.error && this.isPermissionFailure(String(payload.error))) {
      console.warn('[GenOffice] xlsOpen: taskpool EPERM, retry on main thread: ' + openUri);
      try {
        const retry: Record<string, string> = readUriOnMainThread(openUri);
        if (!retry.error) {
          payload = retry;
        }
      } catch (e) { /* 保持原错误，由下方统一上屏 */ }
    }
    if (payload.error) {
      return fail('读文件失败: ' + this.readFailureText(String(payload.error)));
    }
    const b64: string = String(payload.b64);
    // 2) 快照落盘（sidecar 只认真实路径）
    const dir: string = this.sheetsSessionsDir();
    if (dir.length === 0) {
      return fail('filesDir 不可用');
    }
    const snap: string = dir + '/w-' + Date.now().toString() + '.xlsx';
    try {
      await taskpool.execute(writeFilePayload, snap, b64);
    } catch (e) {
      return fail('快照落盘失败: ' + (e instanceof Error ? e.message : String(e)));
    }
    // 3) sidecar open（locale 与桌面 getUiLang 对齐；短日期格式固定 yyyy/m/d）
    let opened: Record<string, Object>;
    try {
      opened = await this.xlsxSidecar.open(snap, 'zh', 'yyyy/m/d');
    } catch (e) {
      console.error('[GenOffice] snap=' + snap);
      return fail('sidecar open 失败: ' + (e instanceof Error ? e.message : String(e)));
    }
    // 4) 补 renderer 需要但 sidecar 不返回的字段
    const book: Record<string, Object> = {};
    const keys: string[] = Object.keys(opened);
    for (let i = 0; i < keys.length; i++) {
      book[keys[i]] = opened[keys[i]];
    }
    book['path'] = writeBack;
    book['sha256'] = String(payload.hash).padEnd(64, '0');
    try {
      const st = fs.statSync(snap);
      book['fileBytes'] = st.size;
    } catch (e) { /* 可选字段，缺省可接受 */ }
    book['readOnly'] = false;
    book['restoredFromRecovery'] = restoreTarget.length > 0;
    // 保存链路登记：会话 → 写回目标（xlsSaveEditsJson）；恢复会话另记原文件戳
    const sid: string = String(opened['sessionId'] ?? '');
    if (sid.length > 0) {
      this.sheetsSessionUris.set(sid, writeBack);
      this.sheetsSessionSnapshots.set(sid, snap);
      if (restoreTarget.length > 0) {
        this.sheetsRestoreTargets.set(sid, restoreTarget);
        this.sheetsRestoreStamps.set(sid, restoreStamp);
      }
    }
    this.writable.add(writeBack);
    this.pushRecent(writeBack);
    return JSON.stringify(book);
  }

  /**
   * sheets:新建空白表格。生成真实空 xlsx 快照并开引擎会话（与打开文件同链路）：
   * 编辑 → 保存/另存为走真实 save_cells；读范围由引擎返回空网格。
   * 无 URI（未命名），save-as 时才由系统保存框定位置；普通保存由 mock 统一转另存为。
   */
  async xlsOpenBlankJson(): Promise<string> {
    const fail = (reason: string): string => {
      console.error('[GenOffice] xlsOpenBlankJson: ' + reason);
      return JSON.stringify({ ok: false, error: reason });
    };
    try {
      const dir: string = this.sheetsSessionsDir();
      if (dir.length === 0) {
        return fail('filesDir 不可用');
      }
      const snap: string = dir + '/blank-' + Date.now().toString() + '.xlsx';
      const opened: Record<string, Object> = await this.xlsxSidecar.createBlank(snap, 'Sheet1');
      const book: Record<string, Object> = {};
      const keys: string[] = Object.keys(opened);
      for (let i = 0; i < keys.length; i++) {
        book[keys[i]] = opened[keys[i]];
      }
      book['path'] = ''; // 未命名：另存为才定 URI
      book['name'] = '未命名表格.xlsx';
      book['readOnly'] = false;
      try {
        const payload: Record<string, string> = await taskpool.execute(readFilePayload, snap) as Record<string, string>;
        book['sha256'] = String(payload['hash'] ?? '').padEnd(64, '0');
        const st = fs.statSync(snap);
        book['fileBytes'] = st.size;
      } catch (e) { /* 可选字段 */ }
      // 不登记 sheetsSessionUris（无写入目标）：保存/另存为由 mock 统一走另存为对话框。
      // 但登记快照路径（readPivotDefinition 需要，虽然空白表格通常没有 pivot）。
      const blankSid: string = String(opened['sessionId'] ?? '');
      if (blankSid.length > 0) {
        this.sheetsSessionSnapshots.set(blankSid, snap);
      }
      return JSON.stringify(book);
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  }

  /** sheets:read-range（渲染层按需分块拉单元格）。reqJson = JSON.stringify(request) */
  async xlsReadRangeJson(reqJson: string): Promise<string> {
    try {
      const req: Record<string, Object> = JSON.parse(reqJson || '{}') as Record<string, Object>;
      const sessionId: string = String(req['sessionId'] ?? '');
      const sheetId: string = String(req['sheetId'] ?? '');
      const range: Record<string, Object> = (req['range'] as Record<string, Object>) ?? {};
      if (sessionId.length === 0 || sheetId.length === 0) {
        return JSON.stringify({ cells: [], rows: [] });
      }
      const raw: string = await this.xlsxSidecar.readRange(sessionId, sheetId, range);
      return this.extractResult(raw);
    } catch (e) {
      console.error('[GenOffice] xlsReadRange failed: ' + String(e));
      return JSON.stringify({ cells: [], rows: [] });
    }
  }

  /** sheets:read-formula-cells */
  async xlsReadFormulaCellsJson(reqJson: string): Promise<string> {
    try {
      const req: Record<string, Object> = JSON.parse(reqJson || '{}') as Record<string, Object>;
      const sessionId: string = String(req['sessionId'] ?? '');
      const sheetId: string = String(req['sheetId'] ?? '');
      const raw: string = await this.xlsxSidecar.readFormulaCells(sessionId, sheetId);
      return this.extractResult(raw);
    } catch (e) {
      return JSON.stringify({ cells: [], indexingComplete: false });
    }
  }

  /** sheets:read-media（图表/图片资源） */
  async xlsReadMediaJson(reqJson: string): Promise<string> {
    try {
      const req: Record<string, Object> = JSON.parse(reqJson || '{}') as Record<string, Object>;
      const raw: string = await this.xlsxSidecar.readMedia(
        String(req['sessionId'] ?? ''), String(req['visualId'] ?? ''));
      return this.extractResult(raw);
    } catch (e) {
      return 'null';
    }
  }

  /** sheets:close-workbook（释放会话；失败仅告警） */
  async xlsCloseJson(sessionId: string): Promise<string> {
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      await this.xlsxSidecar.close(sessionId);
      this.sheetsSessionUris.delete(sessionId);
      this.sheetsSessionSnapshots.delete(sessionId);
      // 恢复会话的登记随会话一起释放（恢复副本本身保留：下次打开仍可恢复）
      this.sheetsRestoreTargets.delete(sessionId);
      this.sheetsRestoreStamps.delete(sessionId);
      this.sheetsAutoNamedSessions.delete(sessionId);
    }
    return JSON.stringify({});
  }

  /**
   * sheets:autoRenameWorkbook（对齐桌面 sheets-main.ts:3128 的同名 handler）。
   * AI 生成内容落盘后，渲染层提议用「第一个非默认 sheet 名」当文件名；主进程只在这个
   * 文件**仍带自动生成名**时才实际改名（用户自己起的名字绝不覆盖）。桌面靠
   * untitledWorkbookPaths 判断，壳内等价物是 sheetsAutoNamedSessions（见另存为段）。
   *
   * 桌面从临时 untitled 文件改名；壳内空白表格没有落盘路径，只有用户「另存为」并
   * 直接沿用默认名后才有可改名的目标 —— 这正是 sheetsAutoNamedSessions 标记的时机。
   * 返回 {renamed, name}；任何不满足条件/失败都回 {renamed:false}（best-effort）。
   */
  async autoRenameWorkbookJson(sessionIdArg: string, baseNameArg: string): Promise<string> {
    const no: string = JSON.stringify({ renamed: false });
    const sessionId: string = String(sessionIdArg ?? '');
    if (sessionId.length === 0 || !this.sheetsAutoNamedSessions.has(sessionId)) { return no; }
    const uri: string | undefined = this.sheetsSessionUris.get(sessionId);
    if (uri === undefined) { return no; }
    let base: string = String(baseNameArg ?? '').trim();
    if (base.length === 0) { return no; }
    if (base.length > 100) { base = base.substring(0, 100); }
    // 去掉扩展名与路径/非法字符：渲染层给的是 sheet 名，可能带 "/" 或 ".xlsx"
    base = base.replace(/\.xlsx$/i, '').replace(/[\\/:*?"<>|]/g, '_').trim();
    if (base.length === 0 || base === '.' || base === '..') { return no; }
    const dir: string = this.dirNameOf(uri);
    if (dir.length === 0) { return no; }
    let target: string = dir + '/' + base + '.xlsx';
    for (let i = 2; i < 100; i++) {
      let exists: boolean = false;
      try { fs.accessSync(target); exists = true; } catch (e) { exists = false; }
      if (!exists) { break; }
      target = dir + '/' + base + '-' + i.toString() + '.xlsx';
    }
    if (target === uri) { return no; }
    try {
      fs.renameSync(uri, target);
    } catch (e) {
      console.warn('[GenOffice] autoRenameWorkbook failed: ' + (e instanceof Error ? e.message : String(e)));
      return no;
    }
    this.sheetsSessionUris.set(sessionId, target);
    // 改完就没有「自动名」了：对齐桌面 untitledWorkbookPaths.delete，避免二次改名。
    this.sheetsAutoNamedSessions.delete(sessionId);
    // 最近列表/收藏里若挂着旧路径，跟着改名（否则点最近记录会打开不存在的文件）。
    const at: number = this.recents.indexOf(uri);
    if (at >= 0) { this.recents[at] = target; this.saveRecents(); }
    const si: number = this.starred.indexOf(uri);
    if (si >= 0) { this.starred[si] = target; this.saveStarred(); }
    return JSON.stringify({ renamed: true, name: target.split('/').pop() ?? (base + '.xlsx') });
  }

  /**
   * sheets:export-csv。M6：导出当前活动 sheet 为 CSV。
   * 桌面版本流程：hasFormulas 弹公式丢失警告（用户选 0=转 xlsx 另存 / 1=继续 CSV / 2=取消）→
   *   弹 CSV 保存对话框 → UTF-8 BOM + 内容 atomic write → 返回 {ok, path} / {canceled, saveAsXlsxInstead?}。
   * 鸿蒙壳实现：hasFormulas 走 ArkUI 原生 promptAction.showDialog（暂不支持回调式三按钮：直接做
   *   与桌面同语义的三按钮对话框；未配置 i18n key 时硬编码中文兜底）→ 通过 picker.save 让用户选位置
   *   → TaskPool 写盘（带 BOM）→ 返回 {ok,path} 或 {canceled}。xlsx 跳转的"先另存为"由
   *   renderer 侧 ctx.requestSaveAs() 触发，无需桥介入。
   * 参数：`{fileName, content, hasFormulas, activeSheetName?, targetPath?}` —— 桌面 targetPath
   *   来自「之前 Save As 对话框选了 CSV」，shell 一律弹自己的保存框，targetPath 仅作为 hint。
   */
  async xlsExportCsvJson(reqJson: string): Promise<string> {
    const fail = (reason: string): string => {
      console.error('[GenOffice] xlsExportCsvJson: ' + reason);
      return JSON.stringify({ ok: false, error: reason });
    };
    let req: Record<string, string | boolean> = {};
    try {
      req = JSON.parse(reqJson || '{}') as Record<string, string | boolean>;
    } catch (e) { return fail('parse request failed'); }
    const fileName: string = String(req['fileName'] ?? 'export.csv');
    const content: string = String(req['content'] ?? '');
    const hasFormulas: boolean = req['hasFormulas'] === true;
    // hasFormulas 分支由 renderer 侧提前弹原生对话框处理（csv-export.ts 的 requestSaveAs 路径）
    // —— shell 这里不再二次弹，避免重复打扰。公式丢失提醒已通过 toast 上屏。
    let chosen: string = fileName;
    if (!/\.csv$/i.test(chosen)) { chosen = chosen + '.csv'; }
    try {
      if (!this.ctx) { return fail('ctx unavailable'); }
      const docPicker = new picker.DocumentViewPicker(this.ctx);
      const uris: string[] = await docPicker.save({ newFileNames: [chosen] });
      if (uris.length === 0) {
        return JSON.stringify({ canceled: true });
      }
      const uri: string = uris[0];
      await this.persistPickerGrant(uri);
      // BOM + UTF-8 内容 → 编码 base64
      const bom: Uint8Array = new Uint8Array([0xef, 0xbb, 0xbf]);
      const body: Uint8Array = new util.TextEncoder().encodeInto(content);
      const merged: Uint8Array = new Uint8Array(bom.length + body.length);
      merged.set(bom, 0);
      merged.set(body, bom.length);
      const b64: string = new util.Base64Helper().encodeToStringSync(merged);
      await taskpool.execute(writeFilePayload, uri, b64);
      this.writable.add(uri);
      this.pushRecent(uri);
      return JSON.stringify({ ok: true, path: uri });
    } catch (e) {
      return fail('export csv failed: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  /**
   * sheets:selectWorkbooksForMerge / openWorkbooksForMerge —— 多选 xlsx 选择器，逐个走与
   * xlsOpenJson 同样的快照 + sidecar.open 流程，返回 WorkbookFile[]（renderer 随后以 sessionId
   * 流式 read_range 拉单元格）。
   * 入参 JSON：`{"uris": [...]}` 或 JSON 字符串数组（selectWorkbooksForMerge 不传路径时 uris 为空，
   *   弹系统选择器并接收多选）。
   */
  async xlsOpenMergeJson(reqJson: string): Promise<string> {
    const fail = (reason: string): string => {
      console.error('[GenOffice] xlsOpenMergeJson: ' + reason);
      return JSON.stringify({ ok: false, error: reason });
    };
    let uris: string[] = [];
    try {
      const parsed: Object = JSON.parse(reqJson || '[]') as Object;
      if (Array.isArray(parsed)) {
        const arr = parsed as Array<Object>;
        const filtered: string[] = [];
        for (let i = 0; i < arr.length; i++) {
          const x = arr[i];
          if (typeof x === 'string' && x.length > 0) {
            filtered.push(x);
          }
        }
        uris = filtered;
      }
    } catch (e) { /* 非数组 → 当作空，弹选择器 */ }
    try {
      if (!this.ctx) { return fail('ctx unavailable'); }
      if (uris.length === 0) {
        const docPicker = new picker.DocumentViewPicker(this.ctx);
        const picked: string[] = await docPicker.select({
          maxSelectNumber: 20,
          fileSuffixFilters: ['.xlsx', '.xlsm', '.xls', '.csv'],
        });
        if (picked.length === 0) {
          return 'null';
        }
        uris = picked;
      }
      await this.activatePersistedGrants();
      const books: Array<Record<string, Object>> = [];
      const opened: Array<string> = [];
      for (let i = 0; i < uris.length; i++) {
        const uri: string = uris[i];
        try {
          await this.persistPickerGrant(uri);
        } catch (e) { /* 已存在 */ }
        let payload: Record<string, string>;
        try {
          payload = await taskpool.execute(readFilePayload, uri) as Record<string, string>;
        } catch (e) {
          try { payload = readUriOnMainThread(uri); }
          catch (e2) {
            // 单个文件失败 → 关闭已开会话并整体上屏错误
            for (let j = 0; j < opened.length; j++) { await this.xlsxSidecar.close(opened[j]); }
            return fail('读文件失败: ' + uri + ': ' + (e2 instanceof Error ? e2.message : String(e2)));
          }
        }
        if (payload.error) {
          for (let j = 0; j < opened.length; j++) { await this.xlsxSidecar.close(opened[j]); }
          return fail('读文件失败: ' + uri + ': ' + this.readFailureText(String(payload.error)));
        }
        const dir: string = this.sheetsSessionsDir();
        if (dir.length === 0) {
          for (let j = 0; j < opened.length; j++) { await this.xlsxSidecar.close(opened[j]); }
          return fail('filesDir 不可用');
        }
        const snap: string = dir + '/wm-' + Date.now().toString() + '-' + i + '.xlsx';
        try {
          await taskpool.execute(writeFilePayload, snap, String(payload.b64));
        } catch (e) {
          for (let j = 0; j < opened.length; j++) { await this.xlsxSidecar.close(opened[j]); }
          return fail('快照落盘失败: ' + uri);
        }
        let openedRec: Record<string, Object>;
        try {
          openedRec = await this.xlsxSidecar.open(snap, 'zh', 'yyyy/m/d');
        } catch (e) {
          for (let j = 0; j < opened.length; j++) { await this.xlsxSidecar.close(opened[j]); }
          return fail('sidecar open 失败: ' + uri);
        }
        const sid: string = String(openedRec['sessionId'] ?? '');
        if (sid.length === 0) {
          for (let j = 0; j < opened.length; j++) { await this.xlsxSidecar.close(opened[j]); }
          return fail('sidecar 未返回 sessionId: ' + uri);
        }
        opened.push(sid);
        const book: Record<string, Object> = {};
        const keys: string[] = Object.keys(openedRec);
        for (let k = 0; k < keys.length; k++) { book[keys[k]] = openedRec[keys[k]]; }
        book['path'] = uri;
        book['sha256'] = String(payload.hash).padEnd(64, '0');
        try {
          const st = fs.statSync(snap);
          book['fileBytes'] = st.size;
        } catch (e) { /* 可选字段 */ }
        book['readOnly'] = false;
        // 合并源会话也登记 URI（合并完成后的释放由 renderer 显式 closeWorkbook 触发）
        this.sheetsSessionUris.set(sid, uri);
        this.sheetsSessionSnapshots.set(sid, snap);
        this.writable.add(uri);
        books.push(book);
      }
      return JSON.stringify(books);
    } catch (e) {
      return fail('selectWorkbooksForMerge 失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  /**
   * sheets:openExternal —— 打开外部链接（renderer 侧 cell click 处理 http(s) hyperlink）。
   * 桌面版走 Electron `shell.openExternal(url)`；鸿蒙壳通过 `Want` + `startAbility` 让系统浏览器/默认
   * 应用接管。限制 http(s) + mailto（防 file:// / javascript: 等危险 scheme）。
   * 返回 JSON 字符串 `{ok:true}` 或 `{ok:false,error:"..."}`。
   */
  async openExternalJson(url: string): Promise<string> {
    const fail = (reason: string): string => {
      console.error('[GenOffice] openExternalJson: ' + reason);
      return JSON.stringify({ ok: false, error: reason });
    };
    const s: string = String(url ?? '').trim();
    if (s.length === 0) {
      return fail('empty url');
    }
    // 允许 scheme 白名单（与桌面 safeExternalUrl 对齐）
    if (!/^(https?:\/\/|mailto:)/i.test(s)) {
      return fail('Only http(s)/mailto links can be opened.');
    }
    try {
      if (!this.ctx) { return fail('ctx unavailable'); }
      const want: Want = {
        action: 'ohos.want.action.viewData',
        entities: ['entity.system.browsable'],
        uri: s,
      };
      // startAbility 在 UIAbilityContext 上可用；common.Context 基类无此方法
      const uiCtx = this.ctx as common.UIAbilityContext;
      await uiCtx.startAbility(want);
      return JSON.stringify({ ok: true });
    } catch (e) {
      return fail('startAbility 失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  /**
   * sheets M5 保存：值编辑 → sidecar save_cells_keep_old 生成新快照并重开（新会话，
   * **源会话不关**）→ 新快照字节写回打开时的原始 URI → 写回成功后才关源会话。
   * req = { sessionId, normalizedEdits:[{sheetId,row,column,kind,value?,formula?,style?,styleReset?}] }
   * 成功返回 {ok:true, file:{新 metadata + path=URI + sha256/fileBytes/readOnly/name}}。
   *
   * 为什么 keep_old：换会话不是原子的——若在引擎关掉源会话之后、写回 URI 之前失败
   * （或另存为被取消），渲染层仍持有旧 sessionId，下次保存/读取就撞上
   * "Unknown workbook session"。推迟到写回成功再关，取消/失败时旧会话保持可用，
   * 用户重试即成功。
   */
  async xlsSaveEditsJson(reqJson: string): Promise<string> {
    const fail = (reason: string): string => {
      console.error('[GenOffice] xlsSaveEdits: ' + reason);
      return JSON.stringify({ ok: false, error: reason });
    };
    try {
      const req: Record<string, Object> = JSON.parse(reqJson || '{}') as Record<string, Object>;
      const sessionId: string = String(req['sessionId'] ?? '');
      const edits: Array<Object> = (req['normalizedEdits'] as Array<Object>) ?? [];
      const structuralOps: Array<Object> = (req['structuralOps'] as Array<Object>) ?? [];
      const sheetOps: Array<Object> = (req['sheetOps'] as Array<Object>) ?? [];
      const sheetOrder: Array<string> = (req['sheetOrder'] as Array<string>) ?? [];
      if (sessionId.length === 0) {
        return fail('保存需要会话');
      }
      if (edits.length === 0 && structuralOps.length === 0 && sheetOps.length === 0) {
        return fail('没有可保存的编辑');
      }
      const uri: string | undefined = this.sheetsSessionUris.get(sessionId);
      if (uri === undefined) {
        return fail('找不到该文件的写入目标');
      }
      // M7-4：恢复会话的原文件守卫——打开恢复副本后原文件若被别处改动，写回会覆盖那些改动。
      // 桌面比对原文件 sha256（restoreTargetSha）；壳用 size:mtime 近似（交付说明已标注差异）。
      // 取不到戳（statUriStamp 返回 ''）时跳过校验，避免误拦正常保存。
      const restoreStamp: string | undefined = this.sheetsRestoreStamps.get(sessionId);
      if (restoreStamp !== undefined && restoreStamp.length > 0) {
        const nowStamp: string = this.statUriStamp(uri);
        if (nowStamp.length > 0 && nowStamp !== restoreStamp) {
          return fail('工作簿在打开后被磁盘上的改动覆盖——请改用另存为。');
        }
      }
      const dir: string = this.sheetsSessionsDir();
      if (dir.length === 0) {
        return fail('filesDir 不可用');
      }
      const snap: string = dir + '/w2-' + Date.now().toString() + '.xlsx';
      const raw: string = sheetOps.length > 0
        ? await this.xlsxSidecar.saveSheetOpsKeepOld(sessionId, snap, edits, structuralOps, sheetOps, sheetOrder)
        : await this.xlsxSidecar.saveCellsKeepOld(sessionId, snap, edits, structuralOps);
      const parsed: Record<string, Object> = JSON.parse(raw) as Record<string, Object>;
      if (parsed['ok'] !== true) {
        const errorBody: Record<string, Object> = (parsed['error'] as Record<string, Object>) ?? {};
        return fail('保存引擎: ' + String(errorBody['message'] ?? raw));
      }
      const result: Record<string, Object> = (parsed['result'] as Record<string, Object>) ?? {};
      const newSessionId: string = String(result['sessionId'] ?? '');
      if (newSessionId.length === 0) {
        return fail('保存后会话无效');
      }
      // 读新快照字节 → 写回原始 URI（writable 授权表已在打开时登记该 URI）。
      // 任一失败都【不关源会话】——渲染层仍是旧 sessionId，重试可继续。
      const payload: Record<string, string> = await taskpool.execute(readFilePayload, snap) as Record<string, string>;
      if (payload.error) {
        return fail('读新快照失败: ' + String(payload.error));
      }
      await taskpool.execute(writeFilePayload, uri, String(payload.b64));
      // 写回成功：新快照已落在目标 URI，此刻才释放源会话（best-effort）。
      await this.xlsxSidecar.close(sessionId);
      this.pushRecent(uri);
      this.sheetsSessionUris.delete(sessionId);
      this.sheetsSessionSnapshots.delete(sessionId);
      this.sheetsSessionUris.set(newSessionId, uri);
      this.sheetsSessionSnapshots.set(newSessionId, snap);
      // 普通保存不改文件名 → 自动命名标记跟着会话一起迁移（否则 AI 改名能力在
      // 第一次自动保存后就失效了）。
      if (this.sheetsAutoNamedSessions.has(sessionId)) {
        this.sheetsAutoNamedSessions.add(newSessionId);
      }
      this.sheetsAutoNamedSessions.delete(sessionId);
      // M7-4：恢复副本的使命结束（内容已写回原文件）→ 删副本；同时撤销守卫登记，
      // 否则下一次保存会因「文件被我们自己改过」而误报磁盘冲突。
      this.clearSheetsRecovery(uri);
      this.sheetsRestoreTargets.delete(sessionId);
      this.sheetsRestoreStamps.delete(sessionId);
      this.sheetsRestoreTargets.delete(newSessionId);
      this.sheetsRestoreStamps.delete(newSessionId);
      const book: Record<string, Object> = {};
      const keys: string[] = Object.keys(result);
      for (let i = 0; i < keys.length; i++) {
        book[keys[i]] = result[keys[i]];
      }
      book['path'] = uri;
      book['sha256'] = String(payload.hash).padEnd(64, '0');
      try {
        const st = fs.statSync(snap);
        book['fileBytes'] = st.size;
      } catch (e) { /* 可选字段 */ }
      book['readOnly'] = false;
      book['name'] = uri.split('/').pop() ?? 'workbook.xlsx';
      return JSON.stringify({ ok: true, file: book });
    } catch (e) {
      return fail('保存异常: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  /**
   * sheets M5.2 另存为：值编辑 → sidecar save_cells 生成新快照 → 系统保存对话框
   * 选择新位置 → 写盘。返回 {ok:true,file}；用户取消 {ok:true,canceled:true}。
   */
  async xlsSaveAsEditsJson(reqJson: string): Promise<string> {
    const fail = (reason: string): string => {
      console.error('[GenOffice] xlsSaveAsEdits: ' + reason);
      return JSON.stringify({ ok: false, error: reason });
    };
    try {
      const req: Record<string, Object> = JSON.parse(reqJson || '{}') as Record<string, Object>;
      const sessionId: string = String(req['sessionId'] ?? '');
      const edits: Array<Object> = (req['normalizedEdits'] as Array<Object>) ?? [];
      const structuralOps: Array<Object> = (req['structuralOps'] as Array<Object>) ?? [];
      const sheetOps: Array<Object> = (req['sheetOps'] as Array<Object>) ?? [];
      const sheetOrder: Array<string> = (req['sheetOrder'] as Array<string>) ?? [];
      if (sessionId.length === 0) {
        return fail('另存为需要会话');
      }
      if (edits.length === 0 && structuralOps.length === 0 && sheetOps.length === 0) {
        return fail('没有可保存的编辑');
      }
      const dir: string = this.sheetsSessionsDir();
      if (dir.length === 0) {
        return fail('filesDir 不可用');
      }
      const snap: string = dir + '/w3-' + Date.now().toString() + '.xlsx';
      // keep_old：引擎重开新快照但【不关源会话】。取消/失败都不会让渲染层持有的
      // 旧 sessionId 变成孤儿（否则下次保存报 Unknown workbook session）。
      const raw: string = sheetOps.length > 0
        ? await this.xlsxSidecar.saveSheetOpsKeepOld(sessionId, snap, edits, structuralOps, sheetOps, sheetOrder)
        : await this.xlsxSidecar.saveCellsKeepOld(sessionId, snap, edits, structuralOps);
      const parsed: Record<string, Object> = JSON.parse(raw) as Record<string, Object>;
      if (parsed['ok'] !== true) {
        const errorBody: Record<string, Object> = (parsed['error'] as Record<string, Object>) ?? {};
        return fail('保存引擎: ' + String(errorBody['message'] ?? raw));
      }
      const result: Record<string, Object> = (parsed['result'] as Record<string, Object>) ?? {};
      const newSessionId: string = String(result['sessionId'] ?? '');
      if (newSessionId.length === 0) {
        return fail('保存后会话无效');
      }
      const payload: Record<string, string> = await taskpool.execute(readFilePayload, snap) as Record<string, string>;
      if (payload.error) {
        return fail('读新快照失败: ' + String(payload.error));
      }
      // 默认文件名沿用打开时的原文件名（取自会话登记的原 URI），落盘由
      // saveAsAnyJson 的系统保存框决定。
      let suggested: string = '未命名表格.xlsx';
      const originUri: string | undefined = this.sheetsSessionUris.get(sessionId);
      if (originUri !== undefined) {
        const base: string = originUri.split('/').pop() ?? '';
        if (/\.xlsx$/i.test(base)) {
          suggested = base;
        } else {
          suggested = base.replace(/[^.\w\u4e00-\u9fa5-]/g, '_') + '.xlsx';
        }
      }
      const saveResp: string = await this.saveAsAnyJson(suggested, String(payload.b64));
      const saved: Record<string, Object> = JSON.parse(saveResp) as Record<string, Object>;
      if (saved['canceled'] === true) {
        // 用户取消：源会话保持打开（keep_old 已保证），下次保存/另存为直接在
        // 原会话上继续，不会报 Unknown workbook session。
        return JSON.stringify({ ok: true, canceled: true });
      }
      if (saved['ok'] !== true || typeof saved['path'] !== 'string') {
        return fail('另存为对话框: ' + String(saved['error'] ?? 'unknown'));
      }
      // 新位置已写盘成功：此刻才释放源会话（best-effort）。
      await this.xlsxSidecar.close(sessionId);
      const newUri: string = String(saved['path']);
      this.sheetsSessionUris.delete(sessionId);
      this.sheetsSessionSnapshots.delete(sessionId);
      this.sheetsSessionUris.set(newSessionId, newUri);
      this.sheetsSessionSnapshots.set(newSessionId, snap);
      // 桌面 untitledWorkbookPaths 的等价物：原本没有目标文件（新建空白表格），且用户
      // 直接接受了对话框里的默认名 → 这个名字没有承载用户意图，AI 生成内容后可自动改名。
      // 用户自己输入的名字（或原本就有原文件的另存为）一律不登记。
      this.sheetsAutoNamedSessions.delete(sessionId);
      const savedBase: string = newUri.split('/').pop() ?? '';
      if (originUri === undefined && savedBase === suggested) {
        this.sheetsAutoNamedSessions.add(newSessionId);
      } else {
        this.sheetsAutoNamedSessions.delete(newSessionId);
      }
      // M7-4：新目标若留有旧副本，现在已被本次内容取代 → 删掉；旧会话的守卫登记随会话释放。
      // 原文件的恢复副本【保留】：本次是另存到别的文件，原文件并未被更新，副本仍是有效救援。
      this.clearSheetsRecovery(newUri);
      this.sheetsRestoreTargets.delete(sessionId);
      this.sheetsRestoreStamps.delete(sessionId);
      const book: Record<string, Object> = {};
      const keys: string[] = Object.keys(result);
      for (let i = 0; i < keys.length; i++) {
        book[keys[i]] = result[keys[i]];
      }
      book['path'] = newUri;
      book['sha256'] = String(payload.hash).padEnd(64, '0');
      try {
        const st = fs.statSync(snap);
        book['fileBytes'] = st.size;
      } catch (e) { /* 可选字段 */ }
      book['readOnly'] = false;
      book['name'] = newUri.split('/').pop() ?? 'workbook.xlsx';
      return JSON.stringify({ ok: true, file: book });
    } catch (e) {
      return fail('另存为异常: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  /**
   * recalcWorkbook：编辑后重算公式单元格。请求 {sessionId, edits[], reads[]} 原样
   * 透传给侧车 recalc_cells（edits/reads 的 sheetId 由引擎映射为工作表名）。
   * 返回 {ok:true, result} / {ok:false, error}。
   */
  async xlsRecalcJson(reqJson: string): Promise<string> {
    try {
      let req: Record<string, Object> = {};
      try {
        req = JSON.parse(reqJson || '{}') as Record<string, Object>;
      } catch (e) {
        return JSON.stringify({ ok: false, error: 'recalc 请求无效' });
      }
      const sessionId: string = String(req['sessionId'] ?? '');
      if (sessionId.length === 0) {
        return JSON.stringify({ ok: false, error: 'recalc 需要会话' });
      }
      const edits: Array<Object> = (req['edits'] as Array<Object>) ?? [];
      const reads: Array<Object> = (req['reads'] as Array<Object>) ?? [];
      const raw: string = await this.xlsxSidecar.recalcCells(sessionId, edits, reads);
      const parsed: Record<string, Object> = JSON.parse(raw) as Record<string, Object>;
      if (parsed['ok'] !== true) {
        const errorBody: Record<string, Object> = (parsed['error'] as Record<string, Object>) ?? {};
        return JSON.stringify({ ok: false, error: '重算引擎: ' + String(errorBody['message'] ?? raw) });
      }
      return JSON.stringify({ ok: true, result: parsed['result'] });
    } catch (e) {
      return JSON.stringify({ ok: false, error: '重算异常: ' + (e instanceof Error ? e.message : String(e)) });
    }
  }

  /** sheets:archive-manifest（保存链路：包内条目清单） */
  async xlsArchiveManifestJson(path: string): Promise<string> {
    try {
      return this.extractResult(await this.xlsxSidecar.archiveManifest(path));
    } catch (e) {
      return JSON.stringify({ error: String(e) });
    }
  }

  /** sheets:read-entries（保存链路：解出待改写条目到目录） */
  async xlsReadEntriesJson(reqJson: string): Promise<string> {
    try {
      const req: Record<string, Object> = JSON.parse(reqJson || '{}') as Record<string, Object>;
      const entries: Array<string> = [];
      const items = req['entries'] as Array<Object> | undefined;
      if (items !== undefined) {
        for (let i = 0; i < items.length; i++) {
          entries.push(String(items[i]));
        }
      }
      const raw: string = await this.xlsxSidecar.readEntries(
        String(req['path'] ?? ''), entries, String(req['outputDir'] ?? ''));
      return this.extractResult(raw);
    } catch (e) {
      return JSON.stringify({ error: String(e) });
    }
  }

  /** sheets:scan-entries（保存链路：定位引用被编辑 sheet 的条目） */
  async xlsScanEntriesJson(reqJson: string): Promise<string> {
    try {
      const req: Record<string, Object> = JSON.parse(reqJson || '{}') as Record<string, Object>;
      const entries: Array<string> = [];
      const items = req['entries'] as Array<Object> | undefined;
      if (items !== undefined) {
        for (let i = 0; i < items.length; i++) {
          entries.push(String(items[i]));
        }
      }
      const raw: string = await this.xlsxSidecar.scanEntries(
        String(req['path'] ?? ''), entries, String(req['needle'] ?? ''));
      return this.extractResult(raw);
    } catch (e) {
      return JSON.stringify({ error: String(e) });
    }
  }

  /** sheets:save-archive（保存链路：重打包 xlsx） */
  async xlsSaveArchiveJson(reqJson: string): Promise<string> {
    try {
      const req: Record<string, Object> = JSON.parse(reqJson || '{}') as Record<string, Object>;
      const replacements: Array<Object> = [];
      const additions: Array<Object> = [];
      const rItems = req['replacements'] as Array<Object> | undefined;
      if (rItems !== undefined) {
        for (let i = 0; i < rItems.length; i++) {
          replacements.push(rItems[i]);
        }
      }
      const aItems = req['additions'] as Array<Object> | undefined;
      if (aItems !== undefined) {
        for (let i = 0; i < aItems.length; i++) {
          additions.push(aItems[i]);
        }
      }
      const removals: Array<string> = [];
      const rmItems = req['removals'] as Array<Object> | undefined;
      if (rmItems !== undefined) {
        for (let i = 0; i < rmItems.length; i++) {
          removals.push(String(rmItems[i]));
        }
      }
      const raw: string = await this.xlsxSidecar.saveArchive(
        String(req['sourcePath'] ?? ''), String(req['targetPath'] ?? ''),
        replacements, removals, additions);
      return this.extractResult(raw);
    } catch (e) {
      return JSON.stringify({ error: String(e) });
    }
  }

  /**
   * sheets:read-archive-entry-text — 解压 xlsx 包内指定条目到临时目录，读取文本内容后返回。
   * 对齐桌面版 readArchiveEntryText（xlsx-package-io.ts:119）。
   * 通过 sessionId 从 sheetsSessionSnapshots 查找快照路径，然后调用 sidecar readEntries 解压。
   * 用于 readPivotDefinition：需要读取 pivotTable XML + pivotCacheDefinition XML。
   */
  async xlsReadArchiveEntryTextJson(reqJson: string): Promise<string> {
    let tempDir: string = '';
    try {
      const req: Record<string, Object> = JSON.parse(reqJson || '{}') as Record<string, Object>;
      const sessionId: string = String(req['sessionId'] ?? '');
      const entryName: string = String(req['entryName'] ?? '');
      if (sessionId.length === 0 || entryName.length === 0) {
        return JSON.stringify({ error: 'sessionId and entryName required' });
      }
      const archivePath: string | undefined = this.sheetsSessionSnapshots.get(sessionId);
      if (archivePath === undefined) {
        return JSON.stringify({ error: 'snapshot not found for session: ' + sessionId });
      }
      const filesDir: string = this.ctx ? this.ctx.filesDir : '';
      if (filesDir.length === 0) {
        return JSON.stringify({ error: 'filesDir unavailable' });
      }
      tempDir = filesDir + '/pivot-read-' + Date.now().toString() + '-' + Math.floor(Math.random() * 100000).toString();
      const raw: string = await this.xlsxSidecar.readEntries(archivePath, [entryName], tempDir);
      const result: Record<string, Object> = JSON.parse(raw) as Record<string, Object>;
      if (result['ok'] !== true) {
        const err = result['error'] as Record<string, Object> | undefined;
        return JSON.stringify({ error: err === undefined ? 'sidecar error' : String(err['message']) });
      }
      const entriesObj = result['result'] as Record<string, Object> | undefined;
      const entryList = entriesObj === undefined ? [] : (entriesObj['entries'] as Array<Object> | undefined);
      if (entryList === undefined || entryList.length === 0) {
        return JSON.stringify({ error: 'entry not found: ' + entryName });
      }
      const firstEntry: Record<string, Object> = entryList[0] as Record<string, Object>;
      const filePath = String(firstEntry['path'] ?? '');
      if (filePath.length === 0) {
        return JSON.stringify({ error: 'extracted file path empty' });
      }
      let file: fs.File | null = null;
      try {
        file = fs.openSync(filePath, fs.OpenMode.READ_ONLY);
        const st = fs.statSync(file.fd);
        const buf = new ArrayBuffer(st.size);
        fs.readSync(file.fd, buf);
        const text = new util.TextDecoder('utf-8').decode(new Uint8Array(buf));
        return JSON.stringify({ ok: true, text: text });
      } finally {
        if (file !== null) {
          try { fs.closeSync(file); } catch (e) { /* ignore */ }
        }
      }
    } catch (e) {
      return JSON.stringify({ error: String(e) });
    } finally {
      if (tempDir.length > 0) {
        // best-effort cleanup: rmdirSync 只删空目录，sidecar 解压的文件可能还在里面。
        // 临时目录在 filesDir 下，不会无限增长（每次用唯一时间戳命名，下次启动可清理）。
        try { fs.rmdirSync(tempDir); } catch (e) { /* 忽略清理失败 */ }
      }
    }
  }

  /** 从 sidecar 响应 JSON 里取 result 字段并序列化（对齐桌面 IPC 返回 result 本体） */
  private extractResult(responseJson: string): string {
    const parsed: Record<string, Object> = JSON.parse(responseJson) as Record<string, Object>;
    if (parsed['ok'] !== true) {
      const err = parsed['error'] as Record<string, Object> | undefined;
      return JSON.stringify({ error: err === undefined ? 'sidecar error' : String(err['message']) });
    }
    const result = parsed['result'];
    if (result === undefined) {
      return 'null';
    }
    if (typeof result === 'string') {
      return result;
    }
    return JSON.stringify(result);
  }

  // ================= M3 内部工具 =================

  /** 读 URI 全部字节并登记写授权/最近文件（优先 TaskPool 子线程，失败回退主线程同步读） */
  private async readDocxUri(uri: string): Promise<string> {
    try {
      // 重开最近文件前先使能已持久化授权（首次调用一次性执行；否则 EPERM）
      await this.activatePersistedGrants();
      let payload: Record<string, string>;
      try {
        payload = await taskpool.execute(readFilePayload, uri) as Record<string, string>;
      } catch (e) {
        console.warn('[GenOffice] readDocxUri: taskpool fail, fallback to main thread: ' + (e && e.message ? e.message : String(e)));
        payload = readUriOnMainThread(uri);
      }
      // 子线程读到权限错时是"软失败"（返回 error 而非抛出），不会走上面的 catch ——
      // M3 已知坑：taskpool 对 Picker URI 的读权限可能受限，授权其实有效却报 EPERM。
      // 这里按软失败内容再回退主线程读一次，避免把可读文件误判成不可读。
      if (payload.error && this.isPermissionFailure(String(payload.error))) {
        console.warn('[GenOffice] readDocxUri: taskpool EPERM, retry on main thread: ' + uri);
        try {
          const retry: Record<string, string> = readUriOnMainThread(uri);
          if (!retry.error) {
            payload = retry;
          }
        } catch (e) {
          console.warn('[GenOffice] readDocxUri: main-thread retry failed: ' + (e && e.message ? e.message : String(e)));
        }
      }
      const r = payload;
      if (r.error) {
        return JSON.stringify({ ok: false, error: this.readFailureText(String(r.error)) });
      }
      const name = uri.split('/').pop() ?? 'document.docx';
      this.writable.add(uri);
      this.pushRecent(uri);
      return JSON.stringify({ ok: true, path: uri, name: name, b64: String(r.b64), hash: String(r.hash) });
    } catch (e) {
      return '';
    }
  }

  /** 全量覆盖写（TRUNC） */
  private writeBytes(path: string, bytes: Uint8Array): void {
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    // CREATE 必须带上：openSync 对不存在的路径（新建场景是常态）无 CREATE 会抛 ENOENT
    let file: fs.File | null = null;
    try {
      file = fs.openSync(path, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
      fs.writeSync(file.fd, ab);
    } catch (e) {
      throw new Error('writeBytes 失败：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      if (file) {
        try { fs.closeSync(file); } catch (e) { /* 忽略关闭失败 */ }
      }
    }
  }

  /** FNV-1a 32bit（原始文件指纹的轻量替身，renderer 只做身份比较） */
  private fnv(bytes: Uint8Array): string {
    let h: number = 2166136261;
    for (let i = 0; i < bytes.length; i++) {
      h = (h ^ bytes[i]) * 16777619;
      h = h >>> 0;
    }
    return h.toString(16);
  }

  private recentsFile(): string {
    return this.ctx ? this.ctx.filesDir + '/genoffice-recents.json' : '';
  }

  private loadRecents(): void {
    try {
      const f = this.recentsFile();
      if (f.length === 0) {
        return;
      }
      try { fs.accessSync(f); } catch (e) { return; } // 不存在 → 无最近文件
      const file = fs.openSync(f, fs.OpenMode.READ_ONLY);
      try {
        const st = fs.statSync(file.fd);
        const buf = new ArrayBuffer(st.size);
        fs.readSync(file.fd, buf);
        const text = util.TextDecoder.create('utf-8').decodeToString(new Uint8Array(buf));
        const parsed: Array<string> = JSON.parse(text) as Array<string>;
        const arr: Array<string> = [];
        for (let i = 0; i < parsed.length; i++) {
          const v = parsed[i];
          if (typeof v === 'string' && v.length > 0) {
            arr.push(v);
          }
        }
        this.recents = arr;
      } finally {
        try { fs.closeSync(file); } catch (e) { /* 忽略关闭失败 */ }
      }
    } catch (e) {
      this.recents = [];
    }
  }

  private saveRecents(): void {
    try {
      const f = this.recentsFile();
      if (f.length === 0) {
        return;
      }
      const data = util.TextEncoder.create('utf-8').encodeInto(JSON.stringify(this.recents));
      const ab = new ArrayBuffer(data.byteLength);
      new Uint8Array(ab).set(data);
      const file = fs.openSync(f, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
      try {
        fs.writeSync(file.fd, ab);
      } finally {
        try { fs.closeSync(file); } catch (e) { /* 忽略关闭失败 */ }
      }
    } catch (e) {
      // 最近文件是锦上添花，失败静默
    }
  }

  private pushRecent(path: string): void {
    const i = this.recents.indexOf(path);
    if (i >= 0) {
      this.recents.splice(i, 1);
    }
    this.recents.unshift(path);
    if (this.recents.length > DesktopBridge.RECENTS_MAX) {
      this.recents = this.recents.slice(0, DesktopBridge.RECENTS_MAX);
    }
    this.saveRecents();
  }

  // ================= M2.11：剪贴板 / 选图 =================

  /**
   * 读系统剪贴板文本。此 SDK 的 getData() 返回 Promise<PasteData>，故 async。
   * ArkWeb 的 navigator.clipboard.readText 会因剪贴板权限被拒（NotAllowedError），
   * PROMISE_SHIM 在 JS 侧以本方法兜底（对 Promise 返回值兼容）。无文本返回 ''。
   */
  async readClipboardText(): Promise<string> {
    try {
      const data: pasteboard.PasteData = await pasteboard.getSystemPasteboard().getData();
      const html: string = data.getPrimaryHtml();
      if (html !== undefined && html.length > 0) {
        return html;
      }
      const text: string = data.getPrimaryText();
      return text ?? '';
    } catch (e) {
      return '';
    }
  }

  /** 写系统剪贴板文本（Word 复制等）。 */
  writeClipboardText(text: string): void {
    try {
      const data = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, text ?? '');
      pasteboard.getSystemPasteboard().setData(data);
    } catch (e) {
      // 忽略：剪贴板不可用时上层走 navigator.clipboard 原生路径
    }
  }

  /**
   * 选图并读为 base64（Word/Excel 的"插入图片"，Electron docs:pick-image 等价实现）。
   * 返回 JSON 字符串（PROMISE_SHIM 侧 JSON.parse 成 {base64, mime, name}），取消/失败返回 ''。
   */
  async pickImageJson(): Promise<string> {
    try {
      const photoSelectOptions = new photoAccessHelper.PhotoSelectOptions();
      photoSelectOptions.MIMEType = photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE;
      photoSelectOptions.maxSelectNumber = 1;
      const photoPicker = new photoAccessHelper.PhotoViewPicker();
      const result = await photoPicker.select(photoSelectOptions);
      if (result.photoUris.length === 0) {
        return '';
      }
      const uri = result.photoUris[0];
      const name = uri.split('/').pop() ?? 'image';
      const dot = name.lastIndexOf('.');
      const ext = dot >= 0 ? name.substring(dot + 1).toLowerCase() : '';
      let mime = 'image/png';
      if (ext === 'jpg' || ext === 'jpeg') {
        mime = 'image/jpeg';
      } else if (ext === 'gif') {
        mime = 'image/gif';
      } else if (ext === 'webp') {
        mime = 'image/webp';
      } else if (ext === 'bmp') {
        mime = 'image/bmp';
      }
      const file = fs.openSync(uri, fs.OpenMode.READ_ONLY);
      try {
        const stat = fs.statSync(file.fd);
        const buf = new ArrayBuffer(stat.size);
        fs.readSync(file.fd, buf);
        const b64 = new util.Base64Helper().encodeToStringSync(new Uint8Array(buf));
        return JSON.stringify({ base64: b64, mime: mime, name: name });
      } finally {
        try { fs.closeSync(file); } catch (e) { /* 忽略关闭失败 */ }
      }
    } catch (e) {
      // 用户取消（错误码 14000011）或其他失败一律视为"未选图"
      return '';
    }
  }

  // ================= M7-3：AI 图像 / 搜索链 =================

  /**
   * 桌面 sheets-main.ts 的 readLocalImage：本地绝对路径 → {mediaType, base64}，失败抛错（渲染层 catch）。
   * 鸿蒙同语义，但失败以 {"error": ...} 返回，由 frame mock 转成 Promise.reject。
   * 20MB 上限与魔术字节嗅探与桌面一致（webp/svg 一律拒）。
   */
  async readLocalImageJson(uri: string): Promise<string> {
    const target: string = String(uri ?? '').trim();
    if (target.length === 0) {
      return JSON.stringify({ error: '图片路径为空' });
    }
    let file: fs.File | null = null;
    try {
      file = fs.openSync(target, fs.OpenMode.READ_ONLY);
      const st = fs.statSync(file.fd);
      if (st.size <= 0) {
        return JSON.stringify({ error: '图片文件为空' });
      }
      if (st.size > MAX_AI_IMAGE_BYTES) {
        return JSON.stringify({ error: '图片超过 20MB 上限（' + Math.round(st.size / 1024 / 1024) + 'MB）' });
      }
      const buf = new ArrayBuffer(st.size);
      fs.readSync(file.fd, buf);
      const bytes = new Uint8Array(buf);
      const mediaType: string = sniffImageMediaType(bytes);
      if (mediaType.length === 0) {
        return JSON.stringify({ error: '仅支持 PNG/JPEG/GIF 图片' });
      }
      const b64 = new util.Base64Helper().encodeToStringSync(bytes);
      return JSON.stringify({ mediaType: mediaType, base64: b64 });
    } catch (e) {
      return JSON.stringify({ error: '读取图片失败：' + (e instanceof Error ? e.message : String(e)) });
    } finally {
      if (file !== null) {
        try { fs.closeSync(file); } catch (e) { /* 忽略关闭失败 */ }
      }
    }
  }

  /** 附件扩展名 → 图片 MIME（对齐桌面 ATTACHMENT_IMAGE_MIME）；非图片返回空串 */
  private attachmentImageMimeOf(ext: string): string {
    if (ext === 'png') { return 'image/png'; }
    if (ext === 'jpg' || ext === 'jpeg') { return 'image/jpeg'; }
    if (ext === 'gif') { return 'image/gif'; }
    if (ext === 'webp') { return 'image/webp'; }
    return '';
  }

  /** 文件名字取小写扩展名（无点）；无扩展名返回空串 */
  private attachmentExtOf(name: string): string {
    const cut: number = name.lastIndexOf('.');
    if (cut < 0 || cut === name.length - 1) { return ''; }
    return name.substring(cut + 1).toLowerCase();
  }

  private isAttachmentTextExt(ext: string): boolean {
    return ATTACHMENT_TEXT_EXTS.indexOf(ext) >= 0;
  }

  private isAttachmentImageExt(ext: string): boolean {
    return ATTACHMENT_IMAGE_EXTS.indexOf(ext) >= 0;
  }

  private isSupportedAttachmentExt(ext: string): boolean {
    return this.isAttachmentTextExt(ext) || this.isAttachmentImageExt(ext)
      || ATTACHMENT_OFFICE_EXTS.indexOf(ext) >= 0;
  }

  /**
   * 附件批量登记（桌面 files:add → collectAttachments）。
   * 拖拽进窗口的文件路径可能是 picker URI（file://docs/...）或沙箱路径，fs.statSync
   * 对两者都能用。返回 {accepted:[{path,name,ext,sizeBytes}], rejected:["名字: 原因"]}；
   * 单个文件失败不影响其余（与桌面一致）。
   */
  async attachmentAddJson(pathsJson: string): Promise<string> {
    let paths: Array<string> = [];
    try {
      const raw = JSON.parse(pathsJson || '[]') as Array<Object>;
      if (raw instanceof Array) {
        for (let i = 0; i < raw.length && i < 50; i++) {
          paths.push(String(raw[i] ?? ''));
        }
      }
    } catch (e) {
      return JSON.stringify({ accepted: [], rejected: ['附件路径无效'] });
    }
    const accepted: Array<Record<string, Object>> = [];
    const rejected: Array<string> = [];
    for (let i = 0; i < paths.length; i++) {
      const p: string = paths[i];
      if (p.length === 0) { continue; }
      const parts: Array<string> = p.split('/');
      const name: string = parts.length > 0 ? parts[parts.length - 1] : p;
      const ext: string = this.attachmentExtOf(name);
      if (!this.isSupportedAttachmentExt(ext)) {
        rejected.push(name + '：不支持的文件类型（' + ext + '）');
        continue;
      }
      try {
        const st = fs.statSync(p);
        if (!st.isFile()) {
          rejected.push(name + '：不是文件');
          continue;
        }
        const limit: number = this.isAttachmentImageExt(ext) ? ATTACHMENT_IMAGE_MAX_BYTES : ATTACHMENT_MAX_BYTES;
        if (st.size > limit) {
          rejected.push(name + '：文件过大（上限 ' + Math.round(limit / 1024 / 1024).toString() + 'MB）');
          continue;
        }
        const meta: Record<string, Object> = {};
        meta['path'] = p;
        meta['name'] = name;
        meta['ext'] = ext;
        meta['sizeBytes'] = st.size;
        accepted.push(meta);
      } catch (e) {
        rejected.push(name + '：无法读取');
      }
    }
    return JSON.stringify({ accepted: accepted, rejected: rejected });
  }

  /**
   * 图片附件 → {ok, base64, mime}（桌面 files:read-image，多模态输入）。
   * 与 readLocalImageJson 的区别：上限按附件规则 5MB、MIME 按扩展名映射（含 webp），
   * 且失败形状是 {ok:false,error} 而不是 {error} —— 渲染层按 ok 分支。
   */
  async attachmentReadImageJson(pathArg: string): Promise<string> {
    const target: string = String(pathArg ?? '').trim();
    if (target.length === 0) { return JSON.stringify({ ok: false, error: '图片路径为空' }); }
    const parts: Array<string> = target.split('/');
    const name: string = parts.length > 0 ? parts[parts.length - 1] : target;
    const mime: string = this.attachmentImageMimeOf(this.attachmentExtOf(name));
    if (mime.length === 0) { return JSON.stringify({ ok: false, error: name + '：不是支持的图片格式' }); }
    let file: fs.File | null = null;
    try {
      file = fs.openSync(target, fs.OpenMode.READ_ONLY);
      const st = fs.statSync(file.fd);
      if (st.size <= 0) { return JSON.stringify({ ok: false, error: name + '：图片文件为空' }); }
      if (st.size > ATTACHMENT_IMAGE_MAX_BYTES) {
        return JSON.stringify({ ok: false, error: name + '：图片超过 5MB 上限' });
      }
      const buf = new ArrayBuffer(st.size);
      fs.readSync(file.fd, buf);
      const b64: string = new util.Base64Helper().encodeToStringSync(new Uint8Array(buf));
      return JSON.stringify({ ok: true, base64: b64, mime: mime });
    } catch (e) {
      return JSON.stringify({ ok: false, error: name + '：读取失败' });
    } finally {
      if (file !== null) {
        try { fs.closeSync(file); } catch (e) { /* 忽略关闭失败 */ }
      }
    }
  }

  /**
   * 粘贴图片（桌面 files:add-pasted-image）：剪贴板里的位图没有本地路径，先落到
   * cacheDir/genoffice-pasted 再用常规附件流程登记。返回 AttachmentAddResult。
   */
  async attachmentAddPastedJson(b64Arg: string, extArg: string): Promise<string> {
    const cleanExt: string = String(extArg ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!this.isAttachmentImageExt(cleanExt)) {
      return JSON.stringify({ accepted: [], rejected: ['不是支持的图片格式'] });
    }
    const cacheDir: string = this.ctx ? this.ctx.cacheDir : '';
    if (cacheDir.length === 0) {
      return JSON.stringify({ accepted: [], rejected: ['缓存目录不可用'] });
    }
    try {
      const dir: string = cacheDir + '/genoffice-pasted';
      try { fs.mkdirSync(dir, true); } catch (e) { /* 已存在 */ }
      const stamp: string = Date.now().toString();
      const seq: string = Math.floor(Math.random() * 100000).toString();
      const path: string = dir + '/pasted-' + stamp + '-' + seq + '.' + cleanExt;
      const bytes: Uint8Array = new util.Base64Helper().decodeSync(String(b64Arg ?? ''));
      if (bytes.length === 0) {
        return JSON.stringify({ accepted: [], rejected: ['粘贴的图片为空'] });
      }
      const file: fs.File = fs.openSync(path, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
      try {
        fs.writeSync(file.fd, bytes.buffer as ArrayBuffer);
      } finally {
        try { fs.closeSync(file); } catch (e) { /* 忽略关闭失败 */ }
      }
      const name: string = path.split('/').pop() ?? ('pasted.' + cleanExt);
      const meta: Record<string, Object> = {};
      meta['path'] = path;
      meta['name'] = name;
      meta['ext'] = cleanExt;
      meta['sizeBytes'] = bytes.length;
      const accepted: Array<Object> = [meta];
      return JSON.stringify({ accepted: accepted, rejected: [] });
    } catch (e) {
      return JSON.stringify({
        accepted: [],
        rejected: ['粘贴图片失败：' + (e instanceof Error ? e.message : String(e))]
      });
    }
  }

  /**
   * 附件文本分块读取（桌面 files:read → extractAttachmentText）。
   * 契约：{ok, name?, totalChars?, offset?, text?} | {ok:false,error}。
   *
   * 纯文本类走 UTF-8 直读；office/pdf 需要 @genoffice/file-parse 的解析器（桌面在
   * 主进程用 Node 跑），鸿蒙壳内没有对应实现 → 返回明确的 ok:false，而不是像旧桩
   * 那样回 {text:'',done:true}（渲染层会把「空文件」原样喂给 AI，属于误导）。
   * 渲染层拿到 ok:false 会把原因作为工具结果呈现给用户。
   */
  async attachmentReadJson(pathArg: string, offsetArg: string, maxCharsArg: string): Promise<string> {
    const target: string = String(pathArg ?? '').trim();
    if (target.length === 0) { return JSON.stringify({ ok: false, error: '附件路径为空' }); }
    const parts: Array<string> = target.split('/');
    const name: string = parts.length > 0 ? parts[parts.length - 1] : target;
    const ext: string = this.attachmentExtOf(name);
    if (!this.isSupportedAttachmentExt(ext)) {
      return JSON.stringify({ ok: false, error: name + '：不支持的文件类型（' + ext + '）' });
    }
    if (this.isAttachmentImageExt(ext)) {
      return JSON.stringify({ ok: false, error: name + '：图片附件不支持文本读取' });
    }
    const offset: number = Math.max(0, Math.floor(Number(offsetArg) || 0));
    const maxChars: number = Math.min(Math.max(1, Math.floor(Number(maxCharsArg) || 1)), 48000);
    if (!this.isAttachmentTextExt(ext)) {
      return JSON.stringify({
        ok: false,
        error: name + '：鸿蒙版暂不支持从 ' + ext.toUpperCase()
          + ' 附件提取文本（可把内容复制到对话里，或改用文本/CSV 附件）'
      });
    }
    let file: fs.File | null = null;
    try {
      file = fs.openSync(target, fs.OpenMode.READ_ONLY);
      const st = fs.statSync(file.fd);
      if (st.size > ATTACHMENT_MAX_BYTES) {
        return JSON.stringify({ ok: false, error: name + '：文件过大（上限 50MB）' });
      }
      const buf = new ArrayBuffer(st.size);
      fs.readSync(file.fd, buf);
      const text: string = util.TextDecoder.create('utf-8').decodeToString(new Uint8Array(buf));
      return JSON.stringify({
        ok: true,
        name: name,
        totalChars: text.length,
        offset: offset,
        text: text.substring(offset, offset + maxChars)
      });
    } catch (e) {
      return JSON.stringify({ ok: false, error: name + '：读取失败' });
    } finally {
      if (file !== null) {
        try { fs.closeSync(file); } catch (e) { /* 忽略关闭失败 */ }
      }
    }
  }

  /** DDG/图搜请求头（每次新建，避免调用方互相污染）*/
  private aiBrowserHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': AI_BROWSER_UA,
      'Accept-Language': 'en-US,en;q=0.9'
    };
    return headers;
  }

  /** HTTP GET → 文本（搜索用）。失败返回 null，语义对齐桌面 ai-search：调用方转成 method:'error' */
  private async aiGetText(url: string, headers: Record<string, string>): Promise<string | null> {
    const httpRequest = http.createHttp();
    try {
      const resp = await httpRequest.request(url, {
        method: http.RequestMethod.GET,
        header: headers,
        connectTimeout: 8000,
        readTimeout: 12000,
      });
      const code: number = resp.responseCode;
      if (code < 200 || code >= 300) {
        console.error('[GenOffice] aiGetText http ' + code + ' ' + url);
        return null;
      }
      return resp.result as string;
    } catch (e) {
      console.error('[GenOffice] aiGetText fail: ' + (e instanceof Error ? e.message : String(e)));
      return null;
    } finally {
      httpRequest.destroy();
    }
  }

  /** HTTP GET → 二进制（图片下载用）：bytes=null 时看 status 决定能否重试 */
  private async aiGetBytes(url: string, headers: Record<string, string>): Promise<AiHttpBytesReply> {
    const httpRequest = http.createHttp();
    try {
      const resp = await httpRequest.request(url, {
        method: http.RequestMethod.GET,
        header: headers,
        expectDataType: http.HttpDataType.ARRAY_BUFFER,
        connectTimeout: 10000,
        readTimeout: 20000,
      });
      const code: number = resp.responseCode;
      if (code < 200 || code >= 300) {
        return { status: code, bytes: null };
      }
      return { status: code, bytes: resp.result as ArrayBuffer };
    } catch (e) {
      console.error('[GenOffice] aiGetBytes fail: ' + (e instanceof Error ? e.message : String(e)));
      return { status: 0, bytes: null };
    } finally {
      httpRequest.destroy();
    }
  }

  /**
   * 桌面 ai:fetch-image（docs/sheets/slides 共用 handler）→ {base64, mime} | null。
   * 渲染层只认这两个字段：sheets 自行嗅探字节，pdf 再 canvas 重编码成 png 并量尺寸。
   * mime 由魔术字节判定（比桌面的 content-type 映射更准）；非图片字节回落 image/jpeg，
   * 由渲染层的 sniffImageMime 再拒一次。差异：无退避等待（ArkTS 侧不引 setTimeout），
   * 瞬时失败只立即重试。
   */
  async fetchImageJson(url: string): Promise<string> {
    const target: string = String(url ?? '').trim();
    if (!isPublicHttpTarget(target)) {
      console.error('[GenOffice] fetchImageJson refused url: ' + target);
      return 'null';
    }
    const headers: Record<string, string> = this.aiBrowserHeaders();
    headers['Accept'] = 'image/*,*/*;q=0.8';
    // Genspark CDN 需要 Referer（对齐 remote-image.ts 的 CDN 头）
    if (target.indexOf('genspark.') >= 0) {
      headers['Referer'] = 'https://www.genspark.ai/';
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const reply = await this.aiGetBytes(target, headers);
      if (reply.bytes !== null) {
        const size: number = reply.bytes.byteLength;
        if (size <= 0 || size > MAX_AI_IMAGE_BYTES) {
          console.error('[GenOffice] fetchImageJson bad size ' + size + ' ' + target);
          return 'null';
        }
        const bytes = new Uint8Array(reply.bytes);
        const sniffed: string = sniffImageMediaType(bytes);
        const b64 = new util.Base64Helper().encodeToStringSync(bytes);
        return JSON.stringify({ base64: b64, mime: sniffed.length > 0 ? sniffed : 'image/jpeg' });
      }
      // 瞬时失败（网络异常 status=0、403/408/429/5xx）重试；对齐 remote-image.ts 的 transient 判定
      const transient: boolean = reply.status === 0 || reply.status === 403 || reply.status === 408
        || reply.status === 429 || reply.status >= 500;
      if (!transient) {
        return 'null';
      }
    }
    return 'null';
  }

  /** POST → 文本（搜索 / AI 兜底通道用）。status=0 表示请求本身失败 */
  private async aiPostText(url: string, headers: Record<string, string>, body: string): Promise<AiHttpReply> {
    const httpRequest = http.createHttp();
    try {
      const resp = await httpRequest.request(url, {
        method: http.RequestMethod.POST,
        header: headers,
        extraData: body,
        connectTimeout: 8000,
        readTimeout: 30000,
      });
      const text: string = typeof resp.result === 'string' ? resp.result as string : '';
      return { status: resp.responseCode, text: text };
    } catch (e) {
      console.error('[GenOffice] aiPostText fail: ' + (e instanceof Error ? e.message : String(e)));
      return { status: 0, text: '' };
    } finally {
      httpRequest.destroy();
    }
  }

  /**
   * AI 通道的第二条路：注入脚本的 fetch 被 CORS 拦（rawfile 的 origin 是 null，各家网关不一定
   * 放开跨域）时，改由原生 HTTP 发一次非流式请求。
   * 只放 https 与本机 http —— 这是个"任意 URL + 任意请求头"的原语，收紧到 AI 端点的实际形态，
   * 免得哪天渲染层被注入后拿它当出网跳板。
   */
  async aiPostJson(url: string, headersJson: string, bodyJson: string): Promise<string> {
    const target: string = String(url ?? '').trim();
    const okTarget: boolean = target.startsWith('https://')
      || target.startsWith('http://127.0.0.1') || target.startsWith('http://localhost');
    if (!okTarget) {
      console.error('[GenOffice] aiPostJson refused url: ' + target);
      return JSON.stringify({ status: 0, text: '' });
    }
    let headers: Record<string, string> = {};
    try {
      const parsed = JSON.parse(String(headersJson ?? '{}')) as Record<string, string>;
      headers = parsed;
    } catch (e) { /* 头解析失败 → 只带 Content-Type */ }
    const body: string = String(bodyJson ?? '{}');
    const reply = await this.aiPostText(target, headers, body);
    return JSON.stringify({ status: reply.status, text: reply.text });
  }

  /** 未配 Key 的固定提示（不再退化成空结果 —— 空数组会让渲染层显示"没有结果"，像搜索坏了）*/
  private searchKeyMissing(kind: string): string {
    const msg: string = '未配置搜索 API Key：请在 设置 - AI 媒体与搜索 - 网页搜索 选择提供方并填写 Key（'
      + kind + ' 均有免费额度）';
    return msg;
  }

  private searchHttpError(provider: string, reply: AiHttpReply): string {
    if (reply.status === 401 || reply.status === 403) {
      return provider + ' 拒绝了 Key（HTTP ' + reply.status + '）：请检查 Key 是否填对、额度是否用完';
    }
    if (reply.status === 0) {
      return provider + ': 网络请求失败（DNS/超时）';
    }
    return provider + ': HTTP ' + reply.status;
  }

  /**
   * 网搜：Serper（Google 结果）或 Tavily，Key 由用户在设置里自填、渲染层每次带下来。
   * 形状 {results, method, error?}
   * 历史：这里过去抓 DDG 的 html 搜索页与 i.js 图片接口（先刮 HTML 抠一次性 token 再打 JSON）——
   * 那是非官方端点，与 DDG 服务条款冲突，且随反爬随时静默失效，不适合商用分发依赖 → 批次 E 换掉。
   */
  async webSearchJson(query: string, maxResults: number, optsJson: string): Promise<string> {
    const q: string = String(query ?? '').trim();
    if (q.length === 0) {
      return JSON.stringify({ results: [], method: 'error', error: 'query must not be empty' });
    }
    const limit: number = maxResults > 0 && maxResults <= 20 ? Math.floor(maxResults) : 6;
    const opts: AiSearchOpts = parseAiSearchOpts(optsJson);
    if (opts.apiKey.length === 0) {
      return JSON.stringify({ results: [], method: 'error', error: this.searchKeyMissing('Serper / Tavily') });
    }
    if (opts.provider === 'tavily') {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + opts.apiKey
      };
      const body: string = JSON.stringify({ query: q, max_results: limit, include_answer: false });
      const reply = await this.aiPostText('https://api.tavily.com/search', headers, body);
      if (reply.status < 200 || reply.status >= 300) {
        return JSON.stringify({ results: [], method: 'error', error: this.searchHttpError('tavily', reply) });
      }
      const root = jsonRootRecord(reply.text);
      if (root === null) {
        return JSON.stringify({ results: [], method: 'error', error: 'tavily: bad json' });
      }
      return JSON.stringify({ results: parseTavilyWebResults(root, limit), method: 'tavily' });
    }
    if (opts.provider === 'parallel') {
      // Parallel v1 search：POST {search_queries:[q], mode:'fast'}，x-api-key 鉴权；
      // results[].excerpts[] 拼接为 snippet（v1 无条数参数，本地截断）
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-api-key': opts.apiKey
      };
      const body: string = JSON.stringify({ search_queries: [q], mode: 'fast' });
      const reply = await this.aiPostText('https://api.parallel.ai/v1/search', headers, body);
      if (reply.status < 200 || reply.status >= 300) {
        return JSON.stringify({ results: [], method: 'error', error: this.searchHttpError('parallel', reply) });
      }
      const proot = jsonRootRecord(reply.text);
      if (proot === null) {
        return JSON.stringify({ results: [], method: 'error', error: 'parallel: bad json' });
      }
      const items: Array<Object> = jsonListField(proot, 'results');
      const out: Array<AiWebSearchItem> = [];
      for (let i = 0; i < items.length && out.length < limit; i++) {
        const rec = items[i] as Record<string, Object>;
        const url: string = jsonFirstStr(rec, ['url']);
        const title: string = jsonFirstStr(rec, ['title']);
        if (url.length === 0 || url.indexOf('http') !== 0) { continue; }
        let snippet: string = '';
        const excerpts: Array<Object> = jsonListField(rec, 'excerpts');
        for (let e = 0; e < excerpts.length; e++) {
          if (typeof excerpts[e] === 'string') { snippet += (snippet ? ' ' : '') + excerpts[e] as string; }
        }
        out.push({ title: title || url, url: url, snippet: snippet });
      }
      return JSON.stringify({ results: out, method: 'parallel' });
    }
    const serperHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-API-KEY': opts.apiKey
    };
    const serperBody: string = JSON.stringify({ q: q, num: limit });
    const serperReply = await this.aiPostText('https://google.serper.dev/search', serperHeaders, serperBody);
    if (serperReply.status < 200 || serperReply.status >= 300) {
      return JSON.stringify({ results: [], method: 'error', error: this.searchHttpError('serper', serperReply) });
    }
    const serperRoot = jsonRootRecord(serperReply.text);
    if (serperRoot === null) {
      return JSON.stringify({ results: [], method: 'error', error: 'serper: bad json' });
    }
    return JSON.stringify({ results: parseSerperWebResults(serperRoot, limit), method: 'serper' });
  }

  /** 图搜：只有 Serper 提供图片端点（Tavily 无）→ 选了 Tavily 时明确说明，而不是静默空结果 */
  async imageSearchJson(query: string, maxResults: number, optsJson: string): Promise<string> {
    const q: string = String(query ?? '').trim();
    if (q.length === 0) {
      return JSON.stringify({ images: [], method: 'error', error: 'query must not be empty' });
    }
    const limit: number = maxResults > 0 && maxResults <= 20 ? Math.floor(maxResults) : 8;
    const opts: AiSearchOpts = parseAiSearchOpts(optsJson);
    const fail = (reason: string): string => {
      console.error('[GenOffice] imageSearchJson: ' + reason);
      return JSON.stringify({ images: [], method: 'error', error: reason });
    };
    if (opts.apiKey.length === 0) {
      return fail(this.searchKeyMissing('Serper'));
    }
    if (opts.provider !== 'serper') {
      return fail('图片搜索目前只支持 Serper（Tavily 没有图片端点）：请在 设置 - AI 媒体与搜索 改选 Serper');
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-API-KEY': opts.apiKey
    };
    const body: string = JSON.stringify({ q: q, num: limit });
    const reply = await this.aiPostText('https://google.serper.dev/images', headers, body);
    if (reply.status < 200 || reply.status >= 300) {
      return fail(this.searchHttpError('serper', reply));
    }
    const root = jsonRootRecord(reply.text);
    if (root === null) {
      return fail('serper: bad json');
    }
    return JSON.stringify({ images: parseSerperImageResults(root, limit), method: 'serper' });
  }
}

/** window.projectApi 骨架（project:* 通道，M5 落 relationalStore） */
export class ProjectApi {
  list(): string {
    return '[]';
  }
}
