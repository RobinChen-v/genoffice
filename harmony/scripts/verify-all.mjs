// M4 全量仿真：shell + docs + sheets + slides + markdown + pdf + project + tabs
// 两阶段：
//   (A) 烟雾测试：对每个桥的每个公开方法都调一次（参数 placeholder），断言"不抛"
//   (B) 关键场景：用户报告的 4 个 bug 都重新跑一遍，断言"返回有效载荷"
// 用法: node scripts/verify-all.mjs
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { spawnSync } from 'node:child_process';
const __dirname = dirname(fileURLToPath(import.meta.url));

// 2 页最小测试 PDF：pdf-bridge 的 applySaveEdits/结构操作需要可解析的真实字节
//（openDocxPathJson 对 .pdf 路径返回它；.md 等保持原 'X' 假字节）。
const pdfTestB64 = await (async () => {
  const d = await PDFDocument.create();
  for (let i = 0; i < 2; i++) {
    const p = d.addPage([200, 260]);
    p.drawText('P' + (i + 1), { x: 30, y: 120 });
  }
  return Buffer.from(await d.save({ useObjectStreams: false })).toString('base64');
})();

// 必须用"TS 模板字面量转义还原"后的脚本 —— Index.ets 里 \/ 会被 TS 编译成 /，
// raw 文本执行不出真机上的 SyntaxError（详见 lib/injected-extract.mjs 头注释）。
import { getScript } from './lib/injected-extract.mjs';
// 桥覆盖门禁（批次 B）：渲染层调用面 ↔ 壳侧实现面，白名单只减不增
// + 文档-实现一致性门禁（批次 C）：BETA 文档里的「已知限制」必须与实际缺口对得上
import { runBridgeCoverageCheck, runLimitsDocsCheck } from './check-bridge-coverage.mjs';
const shim = getScript('PROMISE_SHIM');
const shell = getScript('SHELL_BRIDGE');
const errCollector = getScript('ERR_COLLECTOR');

const BRIDGES = JSON.parse(readFileSync(resolve(__dirname, 'bridge-methods.json'), 'utf8'));

// ---- 沙箱 ----
function makeWin() {
  const w = {};
  w.window = w; w.self = w; w.top = w; w.parent = w;
  w.navigator = { clipboard: { readText: () => Promise.reject(new Error('NotAllowed')), writeText: () => Promise.resolve() } };
  w.localStorage = { _: {}, getItem(k){return this._[k]||null}, setItem(k,v){this._[k]=v}, removeItem(k){delete this._[k]} };
  w.console = { info(){}, warn(){}, error(){} };
  installMessaging(w);
  // rawfile fetch 兜底 shim 需要这些构造器（生产期在 ArkWeb 真机有；沙箱里从 Node 借）
  // shim 用 typeof Response === 'function' 做存在判定，缺一个就不挂 shim。
  if (typeof fetch !== 'undefined') w.fetch = fetch;
  if (typeof Response !== 'undefined') w.Response = Response;
  if (typeof Uint8Array !== 'undefined') w.Uint8Array = Uint8Array;
  if (typeof Blob !== 'undefined') w.Blob = Blob;
  return w;
}

// iframe 仿真：同源子 frame。真实场景里 gin 桥只注入主 frame —— child 无
// desktopNative，native 调用必须经 parent 的 __goNativeCall 转发。
function makeFrameWin(parent) {
  const w = {};
  w.window = w; w.self = w; w.parent = parent; w.top = parent.top;
  w.navigator = parent.navigator;
  w.localStorage = parent.localStorage; // 同源 iframe 共享 localStorage
  w.console = { info(){}, warn(){}, error(){} };
  installMessaging(w);
  w.btoa = parent.btoa; w.atob = parent.atob;
  w.TextEncoder = TextEncoder;
  w.fetch = () => Promise.reject(new Error('no net'));
  w.XMLHttpRequest = class { open(){} };
  w.AbortController = class { constructor(){ this.signal = { aborted:false }; } abort(){ this.signal.aborted = true; } };
  return w;
}

// ---- postMessage 仿真 ----
// 真机 ArkWeb 里 resource://rawfile 文档 origin=null（opaque）：父子 frame 互读属性抛
// SecurityError，只有 postMessage 可用，「关 tab 不弹保存」的守卫因此必须走这条通道。
// 沙箱按真机语义实现：投递异步（宏任务）、监听器拿到 ev.source = 发送方的 window 代理。
function installMessaging(w) {
  const listeners = Object.create(null);
  w.__listeners = listeners;
  w.addEventListener = (t, fn) => {
    if (typeof fn !== 'function') { return; }
    (listeners[t] = listeners[t] || []).push(fn);
  };
  w.removeEventListener = (t, fn) => {
    const l = listeners[t] || [];
    const i = l.indexOf(fn);
    if (i >= 0) { l.splice(i, 1); }
  };
  w.__dispatchMessage = (ev) => {
    (listeners['message'] || []).slice().forEach((fn) => {
      try { fn(ev); } catch (e) { /* 监听器自身异常不阻断其它监听器 */ }
    });
  };
  // 投递给「本 window」；ev.source 由 _postSource 指定（默认 = 本 window）
  w.postMessage = (data) => {
    const src = w._postSource || w;
    setTimeout(() => w.__dispatchMessage({ type: 'message', data, source: src, origin: '*' }), 0);
  };
}

// 壳看到的子 frame window 代理：真机 opaque origin 下任何属性读都抛，只有 postMessage 可用
function makeOpaqueChild(realChild, shellWin) {
  const proxy = new Proxy(realChild, {
    get(t, k) {
      if (k === 'postMessage') { return t.postMessage; }
      if (typeof k === 'symbol') { return undefined; }
      throw new Error('SecurityError: blocked a frame with origin "null" from accessing a cross-origin frame');
    },
    set() {
      throw new Error('SecurityError: blocked a frame with origin "null" from accessing a cross-origin frame');
    },
    has() { return false; },
  });
  realChild._postSource = shellWin;      // 壳 → 子：source = 壳
  realChild.postMessage = (data) => {
    setTimeout(() => realChild.__dispatchMessage({ type: 'message', data, source: shellWin, origin: '*' }), 0);
  };
  // 子 → 壳：window.parent.postMessage 的 source 必须是「本子的代理」，壳才能按身份反查 tab
  const facade = new Proxy(shellWin, {
    get(t, k) {
      if (k === 'postMessage') {
        return (data) => {
          setTimeout(() => t.__dispatchMessage({ type: 'message', data, source: proxy, origin: '*' }), 0);
        };
      }
      const v = t[k];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  realChild.parent = facade;
  return proxy;
}
const doc = {
  createElement: () => ({ style: {}, appendChild(){}, remove(){}, set textContent(v){}, set onclick(v){}, set onkeydown(v){} }),
  getElementById: () => null,
  addEventListener(){},
  removeEventListener(){},
  body: { appendChild(){} },
  documentElement: {},
};

function runShim(win) {
  win.btoa = (s) => Buffer.from(s,'binary').toString('base64');
  win.atob = (s) => Buffer.from(s,'base64').toString('binary');
  win.TextEncoder = TextEncoder;
  win.fetch = () => Promise.reject(new Error('no net'));
  win.XMLHttpRequest = class { open(){} };
  win.AbortController = class { constructor(){ this.signal = { aborted:false }; } abort(){ this.signal.aborted = true; } };
  runShimOn(win);
  runShellOn(win);
}

// PROMISE_SHIM 单独执行（iframe 仿真用 —— SHELL_BRIDGE 有 top guard 不会在子 frame 跑）
function runShimOn(win) {
  if (!win.btoa) win.btoa = (s) => Buffer.from(s,'binary').toString('base64');
  if (!win.atob) win.atob = (s) => Buffer.from(s,'base64').toString('binary');
  if (!win.TextEncoder) win.TextEncoder = TextEncoder;
  new Function('window','document','localStorage','navigator','TextEncoder','btoa','atob','XMLHttpRequest','fetch', shim).call(
    {}, win, doc, win.localStorage, win.navigator, TextEncoder, win.btoa, win.atob, win.XMLHttpRequest, win.fetch);
}

function runShellOn(win) {
  new Function('window','document','localStorage','navigator','TextEncoder','btoa','atob','XMLHttpRequest','fetch', shell).call(
    {}, win, doc, win.localStorage, win.navigator, TextEncoder, win.btoa, win.atob, win.XMLHttpRequest, win.fetch);
}

// ---- 模拟 ArkTS native bridge ----
function makeNative() {
  const b64 = (s) => Buffer.from(s,'utf8').toString('base64');
  const validateSavePayload = async (arg, mode) => {
    try {
      const payload = typeof arg === 'string' ? JSON.parse(arg) : (arg || {});
      const edits = Array.isArray(payload.normalizedEdits) ? payload.normalizedEdits : [];
      const structuralOps = Array.isArray(payload.structuralOps) ? payload.structuralOps : [];
      const sheetOps = Array.isArray(payload.sheetOps) ? payload.sheetOps : [];
      const sheetOrder = Array.isArray(payload.sheetOrder) ? payload.sheetOrder : [];
      return JSON.stringify({
        ok: true,
        file: {
          sessionId: payload.sessionId || 'harness-saved',
          count: edits.length,
          structuralCount: structuralOps.length,
          structuralOps,
          sheetOps,
          sheetOrder,
          mode,
        },
      });
    } catch (e) {
      return JSON.stringify({ ok: false, error: 'bad save payload ' + e.message });
    }
  };
  const api = {
    // PDF 保存/结构操作断言的「内存落盘」记录（path → Buffer bytes）
    _saved: new Map(),
    // pickDirectory 登记过的可写目录（saveInDirJson 的授权表，等价 DesktopBridge.grantedDirs）
    _grantedDirs: new Set(),
    // PDF 签名库（M7）：真实落盘语义在 ArkTS（DesktopBridge + 静态门禁 checkPdfSignaturePersist
    // 覆盖）。这里只做「通道名 + 入参形状 + 返回值归一」的可观测桩，用来抓帧侧接错方法名、
    // 又把渲染层的 SignatureData 挡在门外（旧实现要求 sig.id → 真机恒空转）这类回归。
    _sigCalls: [],
    _sigList: [],
    // M7-4 sheets 崩溃恢复：恢复副本落盘记录 + 打开时恢复提问的回答记录
    // （_needsRecovery 让 xlsOpenJson 走桥的 needsRecovery 分支；_recoveryFail 模拟落盘失败）
    _recoveryWrites: [],
    _recoveryResolves: [],
    _needsRecovery: false,
    _recoveryFail: false,
    // 恢复分支不带回原文件路径（模拟桥的拒绝分支：resolve 阶段必须上屏真实原因）
    _recoveryPathEmpty: false,
    listSavedSignaturesJson: async () => JSON.stringify(api._sigList),
    addSavedSignatureJson: async (dataJson) => {
      api._sigCalls.push({ m: 'add', raw: dataJson });
      let data = null;
      try { data = JSON.parse(dataJson); } catch (e) { data = null; }
      if (!data || typeof data !== 'object') return JSON.stringify(api._sigList);
      api._sigList = [{ id: 'sig-h1', createdAt: 1, data }].concat(api._sigList).slice(0, 10);
      return JSON.stringify(api._sigList);
    },
    removeSavedSignatureJson: async (id) => {
      api._sigCalls.push({ m: 'remove', id });
      api._sigList = api._sigList.filter((s) => s.id !== id);
      return JSON.stringify(api._sigList);
    },
    openDocxJson: async () => JSON.stringify({ok:true,path:'file://docs/x.docx',name:'x.docx',b64:b64('DOCX'),hash:'h1'}),
    // .pdf 路径返回真 PDF 字节（pdf-bridge applySaveEdits 需要可解析文档）；
    // .md 等保持 'X'（Bug5f markdownApi.readFile === 'X' 依赖）。
    openDocxPathJson: async (p) => {
      const isPdf = typeof p === 'string' && /\.pdf$/i.test(p);
      return JSON.stringify({ ok: true, path: p, name: 'x', b64: isPdf ? pdfTestB64 : b64('X'), hash: 'h1' });
    },
    saveDocxJson: async (path) => JSON.stringify({ok:true,path}),
    saveAsDocxJson: async (name) => JSON.stringify({ok:true,path:'file://'+name}),
    saveNewDocxJson: async (name) => JSON.stringify({ok:true,path:'/data/app/'+name}),
    // pdf/pptx 壳桥懒加载：rawfile 目录真读（pdf-bridge.mjs / pptx-bridge.mjs）
    readRawFileJson: async (name) => {
      const f = resolve(__dirname, '..', 'entry/src/main/resources/rawfile/web', String(name || '').replace(/^web\//, ''));
      if (!existsSync(f)) return JSON.stringify({ ok: false, error: 'rawfile missing: ' + name });
      return JSON.stringify({ ok: true, name: String(name), b64: readFileSync(f).toString('base64') });
    },
    saveAsAnyJson: async (name, b64s) => {
      // 批次 D：markdown exportDocx 的「用户在系统保存框点取消」分支需要 {ok:true,canceled:true}
      // （真机由 DocumentViewPicker.save 返回空数组触发）。用文件名哨兵驱动，避免为一条断言
      // 再开一个全局开关（哨兵名以 __cancel__ 开头，真实渲染层不可能生成）。
      if (String(name || '').indexOf('__cancel__') === 0) return JSON.stringify({ ok: true, canceled: true });
      const p = 'file://docs/out/' + (name || 'file');
      if (typeof b64s === 'string') api._saved.set(p, Buffer.from(b64s, 'base64'));
      return JSON.stringify({ ok: true, path: p });
    },
    saveAnyJson: async (path, b64s) => {
      if (typeof b64s === 'string') api._saved.set(path, Buffer.from(b64s, 'base64'));
      return JSON.stringify({ ok: true, path });
    },
    // 导出到已授权目录（DesktopBridge.saveInDirJson 等价物）：只认 pickDirectory 登记过的目录，
    // 未授权目录按真机同款错误返回 —— 真机 BUG「导出图片失败 save target is not an opened
    // document」就是导出走 saveAnyJson 拼新路径导致的。
    saveInDirJson: async (dir, name, b64s) => {
      if (!api._grantedDirs.has(dir)) {
        return JSON.stringify({ ok: false, error: 'save target directory is not granted' });
      }
      const p = String(dir).replace(/\/$/, '') + '/' + String(name).replace(/^.*[\\/]/, '');
      if (typeof b64s === 'string') api._saved.set(p, Buffer.from(b64s, 'base64'));
      return JSON.stringify({ ok: true, path: p });
    },
    recentFilesJson: () => JSON.stringify(['file://docs/r.docx']),
    readClipboardText: async () => 'native-clip',
    writeClipboardText: () => {},
    pickImageJson: async () => JSON.stringify({base64:'AA',mime:'image/png',name:'a.png'}),
    // M7-3 AI 图像/搜索链：形状严格对齐 DesktopBridge（readLocalImageJson 成功 = {mediaType, base64}，
    // 失败 = {error} 并由帧 mock 转成 reject；空路径必须走失败分支，桌面 readLocalImage 无「空图」语义）
    readLocalImageJson: async (uri) => (uri
      ? JSON.stringify({ mediaType: 'image/png', base64: 'iVBORw0KGgo=' })
      : JSON.stringify({ error: '图片路径为空' })),
    fetchImageJson: async () => 'null',
    webSearchJson: async () => JSON.stringify({
      results: [{ title: 'HarmonyOS', url: 'https://example.com/a', snippet: 'snippet' }],
      method: 'duckduckgo',
    }),
    imageSearchJson: async () => JSON.stringify({
      images: [{ title: 'pic', imageUrl: 'https://example.com/a.png', sourceUrl: 'https://example.com', source: 'example.com' }],
      method: 'duckduckgo',
    }),
    // bridgeCall('pickDirectory') 契约返回 {ok,uri} JSON；纯字符串会让 goJson 的 JSON.parse 失败
    pickDirectory: async () => {
      const uri = 'file://docs/storage/Users/x/Documents';
      api._grantedDirs.add(uri);
      return JSON.stringify({ ok: true, uri });
    },
    testAiConnection: async () => JSON.stringify({ok:true}),
    openFileJson: async () => JSON.stringify({ok:true,path:'file://z.pptx',name:'z.pptx',ext:'pptx',b64:b64('Z'),hash:'h2'}),
    createDocumentJson: async (type, title) => {
      if (type !== 'pdf') return JSON.stringify({ok:false,error:'unsupported type: '+type});
      return JSON.stringify({ok:true,path:'/data/app/'+(title||'Untitled')+'.pdf'});
    },
    // sheets xlsx sidecar 链路：selectWorkbook mock 对 {ok:false} 会抛错上屏（M4.5 诊断升级），
    // 这里必须返回真值 WorkbookFile（形状对齐 DesktopBridge.xlsOpenJson 的 book 装配，无 ok 字段），
    // 否则 Stage A 的 selectWorkbook([]) 会因"mock not impl"被判定失败。
    // api._needsRecovery = true 时模拟桥的 M7-4 恢复分支：{ok:false,needsRecovery:true,prompt}
    xlsOpenJson: async () => JSON.stringify(api._needsRecovery ? {
      ok: false, needsRecovery: true,
      path: api._recoveryPathEmpty ? '' : 'file://verify.xlsx',
      prompt: {
        title: '发现自动恢复版本',
        body: '上次会话有未保存的更改。要恢复自动保存的版本吗?恢复后,保存将直接覆盖原文件。',
        restoreLabel: '恢复', discardLabel: '放弃',
        fileName: 'verify.xlsx', savedAtMs: 1700000000000,
      },
    } : {
      sessionId: 'harness-s1', name: 'verify.xlsx', path: 'file://verify.xlsx',
      entryCount: 5, activeTab: 0, styles: [], dxfStyles: [], definedNames: [],
      sheets: [{
        id: 'sheet1', name: 'Sheet1', rowCount: 10, columnCount: 5,
        columnWidths: [], rowHeights: [], merges: [], pivotTables: [],
      }],
      visuals: [], fileBytes: 123, readOnly: false,
    }),
    // 新建空白表格（pendingBlankSheet → selectWorkbook 走 xlsOpenBlankJson）：返回
    // 真实空白 WorkbookFile（无 ok 字段，形状对齐 DesktopBridge.xlsOpenBlankJson）。
    // 之前的 sandbox 没有 removeItem，openBlankSheet 写入的标记从未被消费，selectWorkbook
    // 一路 fallback 到 openFileJson 掩盖了本分支缺失；补 removeItem 后真实路径浮现。
    xlsOpenBlankJson: async () => JSON.stringify({
      sessionId: 'harness-blank', name: '未命名表格.xlsx', path: '',
      entryCount: 1, activeTab: 0, styles: [], dxfStyles: [], definedNames: [],
      sheets: [{
        id: 'sheet1', name: 'Sheet1', rowCount: 200, columnCount: 100,
        columnWidths: [], rowHeights: [], merges: [], pivotTables: [],
      }],
      visuals: [], fileBytes: 0, readOnly: false,
    }),
    xlsReadRangeJson: async () => JSON.stringify({ cells: [], rows: [], merges: [], hyperlinks: [] }),
    xlsReadFormulaCellsJson: async () => JSON.stringify({ cells: [], indexingComplete: true }),
    xlsReadMediaJson: async () => JSON.stringify({ error: 'media unavailable' }),
    xlsCloseJson: async () => JSON.stringify({ ok: true }),
    xlsArchiveManifestJson: async () => JSON.stringify({ entries: [] }),
    xlsReadEntriesJson: async () => JSON.stringify({ entries: [] }),
    xlsScanEntriesJson: async () => JSON.stringify({ matches: [] }),
    xlsSaveArchiveJson: async () => JSON.stringify({ ok: true }),
    // M6-Excel 二级功能：exportCsv 桥 mock（带 BOM 路径记录）
    xlsExportCsvJson: async (reqJson) => {
      try {
        const req = typeof reqJson === 'string' ? JSON.parse(reqJson || '{}') : (reqJson || {});
        const name = String(req.fileName || 'export.csv');
        const path = 'file://docs/out/' + name;
        // 模拟落盘字节：BOM + UTF-8（用户重打开字符不乱码）
        const bom = Buffer.from([0xef, 0xbb, 0xbf]);
        const body = Buffer.from(String(req.content || ''), 'utf8');
        api._saved.set(path, Buffer.concat([bom, body]));
        return JSON.stringify({ ok: true, path });
      } catch (e) {
        return JSON.stringify({ ok: false, error: 'exportCsv mock failed: ' + e.message });
      }
    },
    // M6-Excel：selectWorkbooksForMerge / openWorkbooksForMerge 桥 mock
    // 返回 WorkbookFile[]（与桌面 openMergeSources 同形状：[{sessionId, name, ...}]）
    xlsOpenMergeJson: async (reqJson) => {
      try {
        const req = typeof reqJson === 'string' ? JSON.parse(reqJson || '[]') : (reqJson || []);
        if (!Array.isArray(req) || req.length === 0) {
          // 弹系统选择器路径 → 模拟"用户取消"，返回 null
          return 'null';
        }
        const books = req.map((uri, i) => ({
          sessionId: 'harness-m' + i,
          name: String(uri).split('/').pop() || ('Session' + (i + 1)),
          path: uri,
          sha256: 'h' + (i + 1) + '_'.repeat(60),
          entryCount: 1, activeTab: 0, styles: [], dxfStyles: [], definedNames: [],
          sheets: [{ id: 'sheet1', name: 'Sheet1', rowCount: 5, columnCount: 3,
                     columnWidths: [], rowHeights: [], merges: [], pivotTables: [] }],
          visuals: [], fileBytes: 100, readOnly: false,
        }));
        return JSON.stringify(books);
      } catch (e) {
        return JSON.stringify({ ok: false, error: 'openMerge mock failed: ' + e.message });
      }
    },
    // M6-Excel：openExternal 桥 mock（不真 startAbility，只校验 scheme 白名单）
    openExternalJson: async (url) => {
      const s = String(url || '');
      if (!/^(https?:\/\/|mailto:)/i.test(s)) {
        return JSON.stringify({ ok: false, error: 'Only http(s)/mailto links can be opened.' });
      }
      return JSON.stringify({ ok: true });
    },
    // M7-4 sheets 崩溃恢复：恢复副本落盘 mock（记录 payload，便于断言"转发的是同一份归一化"）
    xlsRecoveryWriteJson: async (arg) => {
      try {
        const payload = typeof arg === 'string' ? JSON.parse(arg || '{}') : (arg || {});
        api._recoveryWrites.push(payload);
        return JSON.stringify({ ok: api._recoveryFail ? false : true });
      } catch (e) {
        return JSON.stringify({ ok: false, error: 'bad recovery payload ' + e.message });
      }
    },
    // M7-4：恢复提问的回答 → 真正打开（记录 choice；空 path 模拟桥的拒绝分支）
    xlsRecoveryResolveJson: async (uri, choice) => {
      api._recoveryResolves.push({ uri, choice });
      if (!uri) return JSON.stringify({ ok: false, error: '恢复副本缺少原文件路径' });
      return JSON.stringify({
        sessionId: choice === 'restore' ? 'harness-restored' : 'harness-s1',
        name: 'verify.xlsx', path: uri,
        restoredFromRecovery: choice === 'restore',
        entryCount: 5, activeTab: 0, styles: [], dxfStyles: [], definedNames: [],
        sheets: [{
          id: 'sheet1', name: 'Sheet1', rowCount: 10, columnCount: 5,
          columnWidths: [], rowHeights: [], merges: [], pivotTables: [],
        }],
        visuals: [], fileBytes: 123, readOnly: false,
      });
    },
    // Excel 保存/另存为（大编辑集分块 → save(transferId) 归一化落盘 mock）
    xlsSaveEditsJson: async (arg) => validateSavePayload(arg, 'save'),
    xlsSaveAsEditsJson: async (arg) => validateSavePayload(arg, 'save-as'),
    // Excel 公式重算：mock 返回 {ok:true,result:{cells:[]}}（透传验证用；重算语义由引擎单测覆盖）
    xlsRecalcJson: async (arg) => {
      try {
        const payload = typeof arg === 'string' ? JSON.parse(arg) : (arg || {});
        return JSON.stringify({ ok: true, result: { cells: [], cached: false } });
      } catch (e) {
        return JSON.stringify({ ok: false, error: 'bad recalc payload ' + e.message });
      }
    },
    setContext(){}, getLanguage(){return 'zh'}, getTheme(){return 'light'},
    platform(){return 'ohos'}, version(){return '0.1.0'},
  };

  // ← 真实契约（曾经缺失的根因）：Index.ets:143 的 shim 用
  //   typeof window.desktopNative.bridgeCall === 'function' 作为唯一入站判定，
  //   DesktopBridge.ets 把 bridgeCall(method, argsJson) 注册进同步 methodList。
  //   这里不提供 bridgeCall，shim 的 findNativeCaller() 就解析到 null 并永久缓存，
  //   于是所有 goJson/goNative 都返回 undefined —— 之前 Stage B 的 FAIL 全是这个假象。
  api.bridgeCall = async (method, argsJson) => {
    let args = [];
    if (argsJson !== undefined && argsJson !== null && argsJson !== '') {
      try {
        const parsed = typeof argsJson === 'string' ? JSON.parse(argsJson) : argsJson;
        args = Array.isArray(parsed) ? parsed : [parsed];
      } catch (e) {
        return JSON.stringify({ ok: false, error: 'bad args json: ' + method });
      }
    }
    const fn = api[method];
    if (typeof fn !== 'function') {
      return JSON.stringify({ ok: false, error: 'mock not impl: ' + method });
    }
    try {
      const out = await fn(...args);
      if (typeof out === 'string') return out;
      return JSON.stringify(out === undefined ? { ok: true } : out);
    } catch (e) {
      return JSON.stringify({ ok: false, error: 'mock threw: ' + method + ' :: ' + (e && e.message ? e.message : String(e)) });
    }
  };
  return api;
}

// ========== 桥注册静态门禁 ==========
// 解析 Index.ets 的 .javaScriptProxy({...}) 注册块与 DesktopBridge.ets 的方法签名，
// 校验：async（返回 Promise）方法必须进 asyncMethodList、同步方法必须进 methodList、
// 校验四条（对齐真机已验证的"单入口调度"契约，见 DesktopBridge.bridgeCall 与
// Index.onControllerAttached 的注释）：
//   1) 同步方法必须进 methodList，async 方法默认必须进 asyncMethodList，两表不交集；
//   2) 本版本 ArkWeb 的 asyncMethodList 有 bug（回传 number 而非 Promise），注册块固定传 []，
//      async 方法改经 methodList 中的单入口 bridgeCall 分发，Promise 由 PROMISE_SHIM 承接。
//      这是显式豁免：方法名必须登记在 ALLOW_ASYNC_IN_SYNC_LIST，且 Index.ets 有 Promise.resolve( 包装；
//   3) bridgeCall 的 switch 分支即 JS 可达清单：分支必须命中真实 async 方法（防方法名漂移），
//      且必须有注册块暴露 'bridgeCall' + JS 侧 .bridgeCall( 转发；
//   4) public 方法必须"被注册"或在分发表中 —— 否则 JS 兜底路径拿到 undefined，真机报
//      "Javascript bridge method can't be invoked on a non-injected object"。
const NOT_EXPOSED = new Set(['setContext']); // ArkTS 内部注入（aboutToAppear 调用），不对 JS 暴露
// async 方法进 methodList 的显式豁免（每条写清理由；条目失效会报错，防止豁免过期或被滥用）
const ALLOW_ASYNC_IN_SYNC_LIST = new Map([
  ['bridgeCall', '单入口调度器：JS 统一 nb.bridgeCall(name, argsJson)，规避 gin 桥多 async 方法缺陷'],
]);
const ROUTED_ENTRY = new Set(['bridgeCall']); // 承载单入口分发的注册名

// 解析 entry 方法体（async entry(...) {...}）内的 switch 分支名 = "经单入口可达"的方法集合。
// 用大括号配平定位方法体，避免误收类内其它 switch 的 case。
function parseDispatchTable(src, entry) {
  const out = new Set();
  // 旧模式：switch case（向后兼容）
  const m = new RegExp(`\\basync\\s+${entry}\\s*\\(`).exec(src);
  if (m) {
    let depth = 0, started = false, end = src.length;
    for (let i = m.index; i < src.length; i++) {
      const ch = src[i];
      if (ch === '{') { depth++; started = true; }
      else if (ch === '}') { depth--; if (started && depth === 0) { end = i; break; } }
    }
    for (const c of src.slice(m.index, end).matchAll(/case\s+'([A-Za-z0-9_]+)'\s*:/g)) out.add(c[1]);
  }
  // 新模式：BridgeRegistry.register('methodName', ...)（全文件搜索，register 只在 initBridgeRegistry 中出现）
  for (const c of src.matchAll(/\.register\(\s*'([A-Za-z0-9_]+)'\s*,/g)) out.add(c[1]);
  return out;
}

function parseArkMethods(classSrc) {
  const methods = {};
  // 方法签名：可选 private/async 前缀 + 名字 + (…) + 返回类型标注
  const re = /^\s*(private\s+)?(async\s+)?([a-zA-Z_$][\w$]*)\s*\([^)]*\)\s*:/gm;
  let m;
  while ((m = re.exec(classSrc)) !== null) {
    const [, isPrivate, isAsync, name] = m;
    if (['if', 'for', 'while', 'switch', 'catch', 'constructor'].includes(name)) continue;
    methods[name] = { isAsync: !!isAsync, isPrivate: !!isPrivate };
  }
  return methods;
}

function stripComments(src) {
  // 仅用于结构解析：先删块注释，再删行注释（避免误伤 'file://' 这类字符串）
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}

function parseProxyBlocks(indexSrc) {
  const blocks = [];
  // 形式 1：声明式 .javaScriptProxy({ object, name, methodList, asyncMethodList })
  const re = /\.javaScriptProxy\(\s*\{/g;
  let m;
  while ((m = re.exec(indexSrc)) !== null) {
    let depth = 1, i = m.index + m[0].length;
    while (i < indexSrc.length && depth > 0) {
      if (indexSrc[i] === '{') depth++;
      else if (indexSrc[i] === '}') depth--;
      i++;
    }
    const body = indexSrc.slice(m.index + m[0].length, i - 1);
    const list = (key) => {
      const mm = body.match(new RegExp(key + ':\\s*\\[([^\\]]*)\\]'));
      if (!mm) return [];
      return [...mm[1].matchAll(/'(\w+)'/g)].map(x => x[1]);
    };
    const nameM = body.match(/name:\s*'(\w+)'/);
    blocks.push({ name: nameM ? nameM[1] : '?', sync: list('methodList'), async: list('asyncMethodList') });
  }
  // 形式 2：registerJavaScriptProxy(this.X, 'name', [sync], [async])（onControllerAttached 内）
  // 修复：真实代码在参数之间夹了注释/换行（Index.ets 附近 1334-1339），
  // 原先 [^\]]* 硬匹配会整个失配 → 静默丢掉 4 个块。这里先剥注释再做括号配对。
  const stripped = stripComments(indexSrc);
  const re2 = /registerJavaScriptProxy\(\s*this\.\w+\s*,\s*'(\w+)'\s*,/g;
  while ((m = re2.exec(stripped)) !== null) {
    const name = m[1];
    let i = m.index + m[0].length;
    const arrays = [];
    while (arrays.length < 2 && i < stripped.length) {
      const ch = stripped[i];
      if (ch === '[') {
        let depth = 1, j = i + 1;
        while (j < stripped.length && depth > 0) {
          if (stripped[j] === '[') depth++;
          else if (stripped[j] === ']') depth--;
          j++;
        }
        arrays.push(stripped.slice(i + 1, j - 1));
        i = j;
      } else if (ch === ')') {
        break;
      } else {
        i++;
      }
    }
    const names = (s) => [...s.matchAll(/'(\w+)'/g)].map(x => x[1]);
    blocks.push({ name, sync: names(arrays[0] || ''), async: arrays[1] === undefined ? [] : names(arrays[1]) });
  }
  return blocks;
}

function checkBridgeRegistration() {
  const bridgeSrc = readFileSync(resolve(__dirname, '..', 'entry/src/main/ets/bridge/DesktopBridge.ets'), 'utf8');
  const indexSrc = readFileSync(resolve(__dirname, '..', 'entry/src/main/ets/pages/Index.ets'), 'utf8');

  // 两个类的类体（DesktopBridge / ProjectApi）
  const methods = {};
  const classRe = /export\s+class\s+(\w+)\s*\{/g;
  let cm;
  while ((cm = classRe.exec(bridgeSrc)) !== null) {
    const bodyStart = cm.index + cm[0].length;
    let depth = 1, i = bodyStart;
    while (i < bridgeSrc.length && depth > 0) {
      if (bridgeSrc[i] === '{') depth++;
      else if (bridgeSrc[i] === '}') depth--;
      i++;
    }
    for (const [n, meta] of Object.entries(parseArkMethods(bridgeSrc.slice(bodyStart, i)))) {
      methods[n] = meta;
    }
  }

  const blocks = parseProxyBlocks(indexSrc);
  if (blocks.length === 0) throw new Error('Index.ets 未找到桥注册调用（javaScriptProxy/registerJavaScriptProxy）');
  // registerJavaScriptProxy 必须紧跟 controller.refresh()（文档明确：refresh 后注册生效）
  if (/registerJavaScriptProxy\(/.test(indexSrc) && !/\.refresh\(\)/.test(indexSrc)) {
    throw new Error('registerJavaScriptProxy 后缺少 controller.refresh() —— 不 refresh 注入不生效');
  }
  const errs = [];
  const covered = new Set();
  // 单入口分发表：bridgeCall 的 switch 分支即 JS 可达的 async 方法清单
  const routed = parseDispatchTable(bridgeSrc, 'bridgeCall');
  const promiseShimOk = /Promise\.resolve\(/.test(indexSrc);
  if (routed.size && !/\.bridgeCall\s*\(/.test(indexSrc)) {
    errs.push(`bridgeCall 有 ${routed.size} 个分发分支，但 Index.ets 未找到 .bridgeCall( 转发（JS 无法进入）`);
  }
  for (const n of routed) {
    if (!methods[n]) { errs.push(`bridgeCall 分支 '${n}' 在 DesktopBridge 中不存在（方法名漂移/拼写错误）`); continue; }
    if (!methods[n].isAsync) errs.push(`bridgeCall 分支 '${n}' 不是 async 方法（单入口只承接返回 Promise 的 async）`);
    // 分发表分支 = JS 唯一可达路径（PROMISE_SHIM 把 window.desktop 全量转发到 bridgeCall），
    // 故计入"已注册"，对应规则 4 的"或在分发表中"。分支合法性已由上面两条校验兜住。
    covered.add(n);
  }
  const asyncInSyncList = new Set();
  for (const b of blocks) {
    const seen = new Set();
    for (const n of b.sync) {
      if (!methods[n]) { errs.push(`${b.name}: methodList 方法 '${n}' 在 bridge 类中不存在`); continue; }
      if (methods[n].isAsync) {
        asyncInSyncList.add(n);
        if (!ALLOW_ASYNC_IN_SYNC_LIST.has(n)) {
          errs.push(`${b.name}: async 方法 '${n}' 被注册进 methodList（默认必须进 asyncMethodList；确需单入口调度则登记 ALLOW_ASYNC_IN_SYNC_LIST）`);
        } else if (!promiseShimOk) {
          errs.push(`${b.name}: '${n}' 依赖 JS 侧承接 Promise，但 Index.ets 未找到 Promise.resolve( 包装`);
        }
      }
      if (seen.has(n)) errs.push(`${b.name}: '${n}' 重复注册`);
      seen.add(n); covered.add(n);
    }
    for (const n of b.async) {
      if (!methods[n]) { errs.push(`${b.name}: asyncMethodList 方法 '${n}' 在 bridge 类中不存在`); continue; }
      if (!methods[n].isAsync) errs.push(`${b.name}: 同步方法 '${n}' 被注册进 asyncMethodList（必须进 methodList）`);
      if (seen.has(n)) errs.push(`${b.name}: '${n}' 重复注册`);
      seen.add(n); covered.add(n);
    }
  }
  // 单入口本身必须真的注册进 methodList —— 只进 asyncMethodList 是已知缺陷路径（ArkWeb 不注入）。
  // 否则上面计入 covered 的分发表分支在真机上会全部不可达。
  if (routed.size) {
    for (const entry of ROUTED_ENTRY) {
      if (!asyncInSyncList.has(entry)) {
        errs.push(`分发表 '${entry}' 未注册进 methodList（${routed.size} 个分支将不可达）`);
      }
    }
  }
  // 豁免条目失效即报错，防止豁免过期或被滥用成"万能放行"
  for (const n of ALLOW_ASYNC_IN_SYNC_LIST.keys()) {
    if (!asyncInSyncList.has(n)) {
      errs.push(`ALLOW_ASYNC_IN_SYNC_LIST 中的 '${n}' 已不再注册进 methodList（豁免过期，请清理）`);
    }
  }
  for (const [n, meta] of Object.entries(methods)) {
    if (!meta.isPrivate && !NOT_EXPOSED.has(n) && !covered.has(n)) {
      errs.push(`bridge public 方法 '${n}' 未注册到任何 javaScriptProxy`);
    }
  }
  // 注册名必须与 mock 分离（desktopNative）：同名注入时 ArkWeb gin 宿主对象会被
  // PROMISE_SHIM 的 defineProperty accessor 吞掉（gin 方法不可枚举，merge 搬不动）。
  const desktopBlock = blocks.find(b => ['desktop', 'desktopNative'].includes(b.name));
  if (!desktopBlock) errs.push('未找到 desktop/desktopNative 注册块');
  else if (desktopBlock.name !== 'desktopNative') errs.push(`desktop 注册名必须是 'desktopNative'（实际 '${desktopBlock.name}'）`);
  const projBlock = blocks.find(b => ['projectApi', 'projectApiNative'].includes(b.name));
  if (projBlock && projBlock.name !== 'projectApiNative') errs.push(`projectApi 注册名必须是 'projectApiNative'（实际 '${projBlock.name}'）`);
  if (errs.length) throw new Error(errs.join('; '));
}

// PDF 渲染层 bootBlank 静态检查：磁贴直开（consumePending null）时必须自动新建空白 PDF，
// 失败才回退空态卡片（对齐 Word/Excel 行为）。
function checkPdfBootBlank() {
  const app = readFileSync(resolve(__dirname, '..', '..', 'apps/pdf/src/renderer/App.tsx'), 'utf8');
  const errs = [];
  if (!/consumePending\(\)/.test(app)) errs.push('未找到 consumePending 启动调用');
  if (!/bootBlank/.test(app)) errs.push('启动 effect 缺少 bootBlank 自动新建分支');
  if (!/desktopNative/.test(app)) errs.push('openFileDialog 未优先走 desktopNative（真实注入对象）');
  if (errs.length) throw new Error(errs.join('; '));
}

// M6-Excel 二级功能门禁：exportCsv / selectWorkbooksForMerge / openExternal 三项必修接线。
// 共性根因：bridge-methods.json 注册了方法名 → makeBridge Proxy 兜底返回 Promise<undefined>
// → 渲染层拿到 undefined 后 cell click / 多选 / 导出 CSV 全部静默失败。本门禁确保
// 桥 + Mock 两处都实现（非 Proxy 兜底），并校验 BOM 与 scheme 白名单等关键安全点。
function checkSheetsSecondTier() {
  const root = resolve(__dirname, '..', '..');
  const errs = [];
  // 1) bridge-methods.json 已注册（不能漏，否则 Stage A 烟雾测会照过）
  const bridges = JSON.parse(readFileSync(resolve(root, 'harmony/scripts/bridge-methods.json'), 'utf8'));
  const apiList = (bridges.sheets && bridges.sheets.desktopApi) || [];
  for (const m of ['exportCsv', 'selectWorkbooksForMerge', 'openWorkbooksForMerge', 'openExternal']) {
    if (!apiList.includes(m)) errs.push('bridge-methods.json sheets.desktopApi 未注册 ' + m);
  }
  // 2) Index.ets mock 实现（非 Proxy 兜底 = 排除只走 Promise.resolve(undefined)）
  const idx = readFileSync(resolve(root, 'harmony/entry/src/main/ets/pages/Index.ets'), 'utf8');
  for (const m of ['selectWorkbooksForMerge', 'openWorkbooksForMerge', 'exportCsv', 'openExternal']) {
    const re = new RegExp(m + ':\\s*function\\s*\\(');
    if (!re.test(idx)) errs.push('Index.ets mock 未实现 desktopApi.' + m);
  }
  // 3) DesktopBridge.ets 桥方法实现 + dispatch case
  const br = readFileSync(resolve(root, 'harmony/entry/src/main/ets/bridge/DesktopBridge.ets'), 'utf8');
  for (const m of ['xlsExportCsvJson', 'xlsOpenMergeJson', 'openExternalJson']) {
    if (!br.includes("register('" + m + "'")) errs.push('DesktopBridge.ets 缺 register: ' + m);
    const re = new RegExp('async\\s+' + m + '\\s*\\(');
    if (!re.test(br)) errs.push('DesktopBridge.ets 未实现 ' + m);
  }
  // 4) exportCsv 必须写 BOM（否则 Excel 重打开乱码）
  if (!br.includes('0xef, 0xbb, 0xbf')) {
    errs.push('xlsExportCsvJson 未写 UTF-8 BOM（Excel 重打开乱码）');
  }
  // 5) openExternal 必须限制 scheme 白名单（防 file:// / javascript: 误开）
  if (!/Only http\(s\)\/mailto/i.test(br)) {
    errs.push('openExternalJson 未限制 scheme 白名单（安全风险）');
  }
  // 6) confirmCsvSave（同一批二级功能收尾）：CSV 会话首存的「保持格式？」三按钮确认。
  //    缺实现时 makeBridge Proxy 兜底 Promise<undefined> → 渲染层 save-actions.ts 的
  //    `choice === 'cancel' / 'xlsx'` 都不成立 → 静默按「继续 CSV」走，用户既看不到提示、
  //    也没有转 .xlsx 的出口。断言三处：mock 有实现、弹层函数存在、三个返回值字面量齐全。
  if (!/confirmCsvSave:\s*function\s*\(/.test(idx)) {
    errs.push('Index.ets mock 未实现 desktopApi.confirmCsvSave（Proxy 兜底会静默降级为「继续 CSV」）');
  }
  if (!idx.includes('return showCsvKeepFormatChoice();')) {
    errs.push('confirmCsvSave 未走 showCsvKeepFormatChoice（弹层缺失 = 无提示）');
  }
  // 从弹层函数起点起 3000 字符窗口内验证文案与三个返回值（弹层约 1.9KB）
  const choiceStart = idx.indexOf('function showCsvKeepFormatChoice()');
  if (choiceStart < 0) {
    errs.push('Index.ets 缺 showCsvKeepFormatChoice()');
  } else {
    const choiceSeg = idx.slice(choiceStart, choiceStart + 3000);
    if (!choiceSeg.includes('function showCsvKeepFormatChoice()')) {
      errs.push('showCsvKeepFormatChoice 取样异常（改名/移动后需同步本门禁）');
    }
    for (const v of ['cancel', 'xlsx', 'csv']) {
      if (!choiceSeg.includes("'" + v + "'")) {
        errs.push('showCsvKeepFormatChoice 未产出 ' + v + '（渲染层只认 csv/xlsx/cancel）');
      }
    }
    // 文案必须与桌面 i18n 的 csvKeepFormatMsg / csvKeepFormatDetail 对齐
    if (!choiceSeg.includes('继续以 CSV 格式保存吗?')) {
      errs.push('showCsvKeepFormatChoice 标题未对齐桌面 csvKeepFormatMsg');
    }
    if (!choiceSeg.includes('公式、格式和其他工作表不会存入 .csv 文件')) {
      errs.push('showCsvKeepFormatChoice 明细未对齐桌面 csvKeepFormatDetail');
    }
    // 必须落在 PROMISE_SHIM（每 frame 注入）：调用方是 sheets app frame，而 SHELL_BRIDGE
    // 有 top guard 只在主 frame 执行 —— 放错区就是 "showCsvKeepFormatChoice is not defined"
    if (!shim.includes('function showCsvKeepFormatChoice()')) {
      errs.push('showCsvKeepFormatChoice 不在 PROMISE_SHIM（子 frame 里会 undefined）');
    }
  }
  if (errs.length) throw new Error(errs.join('; '));
}

// 产物新鲜度必须**模式感知**：内联模式 grep index.html；外链模式（D-4）bundle 在 assets/*.js 里，
// 只 grep HTML 会把「已同步的外链产物」误判成「未同步」（D-4 实测踩过）。
// 注意：本函数被 self-test-m7-negatives 以「单函数体抽取 + 注入 readFileSync/resolve/existsSync」
// 的方式跑，**不能调用其它顶层 helper**（会 ReferenceError），故新鲜度逻辑内联在函数体里。
//
// Sheets「文件」功能区门禁：桌面版把 Open/Save/Save As 放在 Electron 原生菜单
// （apps/sheets/src/main/sheets-main.ts installApplicationMenu），鸿蒙壳里没有原生菜单，
// 所以渲染层必须自带 File tab 才能触达这些命令。真机回归点：tab 存在、命令路由存在、
// 19 个 locale 齐全（缺键会静默回落英文）、rawfile 已同步（只改 apps 不跑 sync-web.sh
// 时真机看不到这个 tab）。
function checkSheetsFileTab() {
  const root = resolve(__dirname, '..', '..');
  const errs = [];
  const shell = readFileSync(resolve(root, 'apps/sheets/src/renderer/ExcelShell.tsx'), 'utf8');
  if (!/const ribbonTabs = \[\s*\n?\s*'File'/.test(shell)) {
    errs.push("ExcelShell.ribbonTabs 未包含 'File'（文件 tab 缺失）");
  }
  if (!shell.includes("File: 'appTabFile'")) errs.push('ExcelShell.TAB_LABEL 缺 File → appTabFile');
  if (!shell.includes("onCommand('export-csv')")) errs.push('File tab 缺 export-csv 命令');
  if (!shell.includes("onCommand('export-pdf')")) errs.push('File tab 缺 export-pdf 命令');
  const app = readFileSync(resolve(root, 'apps/sheets/src/renderer/App.tsx'), 'utf8');
  if (!/command === 'export-csv'/.test(app)) {
    errs.push('App.handleRibbonCommand 未路由 export-csv（文件 tab 的导出 CSV 会静默无效）');
  }
  const i18nDir = resolve(root, 'apps/sheets/src/renderer/i18n/app');
  const keys = [
    'appTabFile',
    'appFileOpen',
    'appFileSave',
    'appFileSaveAs',
    'appFileExportPdf',
    'appFileExportCsv',
  ];
  for (const f of readdirSync(i18nDir).filter((name) => name.endsWith('.ts'))) {
    const src = readFileSync(resolve(i18nDir, f), 'utf8');
    for (const key of keys) {
      if (!src.includes(key + ':')) errs.push('i18n/app/' + f + ' 缺 ' + key);
    }
  }
  // 产物新鲜度（模式感知，逻辑内联 —— 见函数上方注释）：内联模式命中 index.html；
  // 外链模式（D-4）bundle 在 assets/*.js，需顺着 index.html 的 script/link 引用去找。
  const sheetsWebDir = resolve(root, 'harmony/entry/src/main/resources/rawfile/web/sheets');
  const sheetsHtmlPath = resolve(sheetsWebDir, 'index.html');
  let sheetsFresh = false;
  let sheetsFreshWhere = 'index.html 不存在';
  if (existsSync(sheetsHtmlPath)) {
    const sheetsHtml = readFileSync(sheetsHtmlPath, 'utf8');
    if (sheetsHtml.includes('appTabFile')) {
      sheetsFresh = true;
      sheetsFreshWhere = 'index.html（内联模式）';
    } else {
      sheetsFreshWhere = 'index.html 与其外链 assets/*.js 均未命中 appTabFile';
      for (const m of sheetsHtml.matchAll(/(?:src|href)="[^"]*\/assets\/([^"]+\.js)"/g)) {
        const p = resolve(sheetsWebDir, 'assets', m[1]);
        if (existsSync(p) && readFileSync(p, 'utf8').includes('appTabFile')) {
          sheetsFresh = true;
          sheetsFreshWhere = 'assets/' + m[1] + '（外链模式）';
          break;
        }
      }
    }
  }
  if (!sheetsFresh) {
    errs.push('rawfile/web/sheets 未同步（' + sheetsFreshWhere + '）→ 先跑 sh harmony/scripts/sync-web.sh sheets');
  }
  // File tab 的三个大按钮复用 QAT 的图标组件（OpenIcon/SaveIcon/SaveAsIcon）。它们必须包在
  // .tool-symbol 里：ribbon 的图标尺寸/描边规则只挂在 .tool-symbol 上
  // （`.ribbon-tool.large .tool-symbol svg { width:28px; height:28px }` + stroke-width:1.3），
  // 裸放进 .tool-icon-row 会退回 svg 默认尺寸（无 width/height 属性）→ 比同排图标明显偏大。
  const iconRows = shell.split('className="tool-icon-row"').slice(1);
  for (const row of iconRows) {
    if (/^\s*>\s*\n?\s*<[A-Z][A-Za-z]*\s*\/>/.test(row.slice(0, 200))) {
      errs.push('ExcelShell .tool-icon-row 内是裸图标组件（未包 .tool-symbol → 尺寸失控）');
      break;
    }
  }
  for (const ic of ['OpenIcon', 'SaveIcon', 'SaveAsIcon']) {
    if (!new RegExp('className="tool-symbol"[^>]*>\\s*<' + ic + '\\s*/>').test(shell)) {
      errs.push('文件 tab 的 ' + ic + ' 未包在 .tool-symbol 内（图标尺寸规则不生效）');
    }
  }
  const sheetsCss = readFileSync(resolve(root, 'apps/sheets/src/renderer/styles.css'), 'utf8');
  if (!/\.ribbon-tool\.large \.tool-symbol svg\s*\{[^}]*width:\s*28px/.test(sheetsCss)) {
    errs.push('styles.css 缺 .ribbon-tool.large .tool-symbol svg{width:28px}（图标尺寸基准被删）');
  }
  if (errs.length) throw new Error(errs.join('; '));
}

// PDF 插入图章门禁：对话框 → 落章（复用图片签名通道）→ i18n 三语 → rawfile 产物 必须齐全。
// 图章落盘走 DrawingInput kind:'image'（pdf-bridge addImageStamp），一旦换成自定义结构就会
// 静默丢失；只改 apps 而没跑 sync-web.sh 时 rawfile 产物不含新键 → 真机按钮无反应。
function checkPdfInsertStamp() {
  const root = resolve(__dirname, '..', '..');
  const errs = [];
  const app = readFileSync(resolve(root, 'apps/pdf/src/renderer/App.tsx'), 'utf8');
  for (const s of [
    'InsertStampDialog',
    'placeStampOnPages',
    'applyInsertStamp',
    'pendingStampAll',
    'IconStamp',
  ]) {
    if (!app.includes(s)) errs.push('App.tsx 缺: ' + s);
  }
  if (!app.includes("input: { kind: 'image', pageIndex: p")) {
    errs.push("placeStampOnPages 未走 kind:'image' 图片落章通道");
  }
  const dialog = readFileSync(resolve(root, 'apps/pdf/src/renderer/InsertStampDialog.tsx'), 'utf8');
  for (const s of ['StampPlacement', 'renderStampPreset', 'fileToCanvas', 'insertStampAllPages']) {
    if (!dialog.includes(s)) errs.push('InsertStampDialog.tsx 缺: ' + s);
  }
  const stampImg = readFileSync(resolve(root, 'apps/pdf/src/renderer/stamp-image.ts'), 'utf8');
  for (const s of ['STAMP_PRESETS', 'renderStampPreset', 'stampPresetApproved']) {
    if (!stampImg.includes(s)) errs.push('stamp-image.ts 缺: ' + s);
  }
  const icons = readFileSync(resolve(root, 'apps/pdf/src/renderer/icons.tsx'), 'utf8');
  if (!icons.includes('IconStamp')) errs.push('icons.tsx 缺 IconStamp');
  // i18n：英文基线 + zh + zh-TW 三处都要有，缺语言时回退基线（图章按钮无文字）
  const strings = readFileSync(resolve(root, 'apps/pdf/src/renderer/i18n/strings.ts'), 'utf8');
  for (const k of ['insertStamp:', 'insertStampTitle:', 'insertStampAllPages:', 'stampPresetApproved:']) {
    const n = strings.split(k).length - 1;
    if (n < 3) errs.push(`strings.ts 键 ${k} 只出现 ${n} 次（需 en/zh/zh-TW 三处）`);
  }
  // rawfile 产物必须已同步（同步后 index.html 内联 JS 含新键）
  const html = readFileSync(
    resolve(root, 'harmony/entry/src/main/resources/rawfile/web/pdf/index.html'),
    'utf8',
  );
  if (!html.includes('insertStampTitle')) errs.push('rawfile/web/pdf/index.html 未同步（先跑 sync-web.sh pdf）');
  if (errs.length) throw new Error(errs.join('; '));
}

// PDF 壳桥接线静态门禁：pdfMock 必须挂载保存/结构/签名/AI 方法并接 pdf-bridge；
// 任何改名/断线都会让真机功能静默失效（保存失败/结构操作无响应）。
function checkPdfBridgeWiring() {
  const idx = readFileSync(resolve(__dirname, '..', 'entry/src/main/ets/pages/Index.ets'), 'utf8');
  const errs = [];
  const helpers = [
    'loadPdfBridge', 'pickPdfFile', 'pdfPickCheck', 'PDF_BRIDGE_RAW',
    'readStaticFormFills', 'applySaveEdits',
    'insertBlankPageBytes', 'setPageSizeBytes', 'cropPagesBytes', 'insertPdfBytes',
    'replacePagesBytes', 'extractPagesBytes', 'mergePagesBytes', 'splitPagesBytes',
    'splitPdfBytes', 'mergePdfBytes', 'savePdfAsBytes', 'writePdfBytesAt', 'readPdfPathBytes',
  ];
  for (const s of helpers) {
    if (!idx.includes(s)) errs.push('Index.ets 缺: ' + s);
  }
  const methods = [
    'save', 'listStaticFormFills', 'insertBlankPage', 'setPageSize', 'cropPages',
    'insertPdf', 'replacePages', 'extractPages', 'mergePages', 'splitPages', 'splitPdf', 'mergePdf',
    'exportImages', 'convertOffice',
    'listSavedSignatures', 'addSavedSignature', 'removeSavedSignature',
    'onAiStream', 'aiStream', 'aiStreamCancel', 'getTheme', 'getLanguage', 'getUsername',
    'isUntitled', 'autoRename', 'canDrawText', 'validateTextEdits', 'listPageImages',
  ];
  for (const m of methods) {
    if (!new RegExp('\\b' + m + '\\s*:\\s*function').test(idx)) errs.push('pdfMock 缺方法: ' + m);
  }
  if (errs.length) throw new Error(errs.join('; '));
}

// PDF 「插入文字」门禁：BUG「点击插入文字提示 text insert engine (PDFium) not available」防线。
// 三处必须齐：text-insert.ts 实现存在、entry.ts 再导出、save-pdf.ts 不再走 skipped 字面量。
// 任何一处断线（删锚点/退回 skipped 路径/漏打包）都会重现「点了没反应」。
function checkPdfInsertWiring() {
  const root = resolve(__dirname, '..', '..');
  const errs = [];
  const insertSrc = readFileSync(resolve(root, 'harmony/scripts/pdf-bridge/src/text-insert.ts'), 'utf8');
  for (const s of [
    'export function canDrawTextHarmony',
    'export async function applyTextInsertsHarmony',
    '_FPDFText_LoadStandardFont',
    '_FPDFPageObj_CreateTextObj',
    '_FPDFText_SetText',
    '_FPDFPageObj_SetMatrix',
    '_FPDFPageObj_SetFillColor',
    '_FPDFPage_InsertObject',
    '_FPDFPage_GenerateContent',
    '_PDFiumExt_SaveAsCopy',
    'Latin only',
  ]) {
    if (!insertSrc.includes(s)) errs.push('text-insert.ts 缺锚点: ' + s);
  }
  const entrySrc = readFileSync(resolve(root, 'harmony/scripts/pdf-bridge/entry.ts'), 'utf8');
  for (const s of ['applyTextInsertsHarmony', 'canDrawTextHarmony']) {
    if (!entrySrc.includes(s)) errs.push('pdf-bridge/entry.ts 未再导出: ' + s);
  }
  const saveSrc = readFileSync(resolve(root, 'harmony/scripts/pdf-bridge/src/save-pdf.ts'), 'utf8');
  if (!/getPdfium\??\s*:/.test(saveSrc)) {
    errs.push('save-pdf.ts applySaveEdits 缺 getPdfium 形参（无法透传 PDFium）');
  }
  if (saveSrc.includes("import('./text-insert')")) {
    // 「text insert engine (PDFium) not available」只是 save-pdf.ts 在 PDFium 不可用时的兜底
    // 原因（与 text edit/image edit 共用同一句兜底语义）；只有当「调用 applyTextInsertsHarmony
    // 失败」也走这个 reason 才算真降级。此处只校验调用链存在 + 占位 fallback 路径收紧到一处。
    const called = /applyTextInsertsHarmony\(/.test(saveSrc);
    if (!called) errs.push('save-pdf.ts 未调用 applyTextInsertsHarmony（PDFium 主路径断线）');
  } else {
    errs.push('save-pdf.ts 未动态 import text-insert（applyTextInsertsHarmony 调用丢失）');
  }
  // 桥产物（esbuild bundle）必须包含新符号 —— 否则 sync-web.sh 没跑、产物过期，真机再退到 skipped
  const bridgePath = resolve(root, 'harmony/entry/src/main/resources/rawfile/web/pdf-bridge.mjs');
  if (!existsSync(bridgePath)) {
    errs.push('缺 rawfile 产物 web/pdf-bridge.mjs（先跑 sh harmony/scripts/sync-web.sh pdf）');
  } else {
    const buf = readFileSync(bridgePath, 'utf8');
    for (const s of ['applyTextInsertsHarmony', 'canDrawTextHarmony', '_FPDFText_LoadStandardFont', 'Latin only']) {
      if (!buf.includes(s)) errs.push('web/pdf-bridge.mjs 产物缺符号: ' + s);
    }
  }
  // Index.ets 注入的 pdfMock.save 必须把 PDFium 透给 pdf-bridge（getPdfium 闭包）
  const idx = readFileSync(resolve(root, 'harmony/entry/src/main/ets/pages/Index.ets'), 'utf8');
  if (!idx.includes('loadPdfConvert().then(loadPdfium)')) {
    errs.push('Index.ets pdfMock.save 未把 PDFium 透给 applySaveEdits（getPdfium 闭包断线）');
  }
  if (errs.length) throw new Error(errs.join('; '));
}

// PDF→Office 转换门禁（BUG#3「转换无效」的回归防线）：转换桥产物 + 壳侧接线 + 渲染层
// 结果上报三处必须齐全。当时的根因是渲染层调 pdfApi.convertOffice 而壳侧**没有该方法**
// → makeBridge Proxy 兜底 resolve(undefined) + 渲染层空 catch 吞错 → 点击完全静默。
// 任何一处断线（改名/漏跑 sync-web.sh/退回静默）都会重现「点了没反应」。
function checkPdfConvertWiring() {
  const root = resolve(__dirname, '..', '..');
  const errs = [];
  // 1) 桥产物：pdf2docx + PDFium wasm（sync-web.sh pdf 分支产出，未跑 → 真机 404 静默失败）
  const webDir = resolve(root, 'harmony/entry/src/main/resources/rawfile/web');
  for (const [f, minBytes] of [['pdf-convert.mjs', 512 * 1024], ['pdfium.wasm', 1024 * 1024]]) {
    const p = resolve(webDir, f);
    if (!existsSync(p)) {
      errs.push(`缺 rawfile 产物 web/${f}（先跑 sh harmony/scripts/sync-web.sh pdf）`);
      continue;
    }
    const size = statSync(p).size;
    if (size < minBytes) errs.push(`web/${f} 体积异常（${size}B < ${minBytes}B）`);
    const buf = readFileSync(p);
    if (f === 'pdf-convert.mjs') {
      // entry.ts 的再导出/init 漂移 → 壳侧 loadPdfium/convertPdfTo* 取到 undefined
      for (const s of ['initPdfium', 'pdfiumReady', 'convertPdfToDocx', 'convertPdfToXlsx', 'convertPdfToPptx', 'PdfLoadError']) {
        if (!buf.includes(s)) errs.push(`web/pdf-convert.mjs 缺符号 ${s}（entry.ts 再导出漂移？）`);
      }
    }
  }
  if (!existsSync(resolve(root, 'harmony/scripts/build-pdf-convert.mjs'))) {
    errs.push('缺 harmony/scripts/build-pdf-convert.mjs（转换桥打包脚本）');
  }
  const sync = readFileSync(resolve(root, 'harmony/scripts/sync-web.sh'), 'utf8');
  if (!sync.includes('build-pdf-convert.mjs')) errs.push('sync-web.sh 未调用 build-pdf-convert.mjs（apps/pdf 变了但桥没重建）');

  // 1b) locateFile 回归防线（真机 100% 转换失败：Failed to construct 'URL': Invalid URL）
  // 壳侧用 data: URL 动态 import pdf-convert.mjs（pdfMock.loadPdfConvert），此时
  // import.meta.url 是 data: URL；@embedpdf/pdfium 的 Emscripten findWasmBinary() 在
  // Module['locateFile'] 为空时执行 new URL('pdfium.wasm', import.meta.url) → 抛错，
  // 且该调用在实例化时无条件执行（传了 wasmBinary 也躲不开）→ pdfium init 永远不成功。
  // entry.ts 必须给 locateFile，产物里必须留痕（否则是没重建桥的旧产物）。
  const entryTs = readFileSync(resolve(root, 'harmony/scripts/pdf-convert/entry.ts'), 'utf8');
  if (!/pdfiumInit\(\{[\s\S]{0,300}?locateFile/.test(entryTs)) {
    errs.push('pdf-convert/entry.ts 的 pdfiumInit 未传 locateFile（data: URL 下 findWasmBinary 必抛 Invalid URL）');
  }
  const convPath = resolve(webDir, 'pdf-convert.mjs');
  if (existsSync(convPath) && !readFileSync(convPath, 'utf8').includes('locateFile:')) {
    errs.push('web/pdf-convert.mjs 产物缺 locateFile:（桥未重建，转换仍会失败）');
  }

  // 2) 壳侧：pdfMock.convertOffice 与它依赖的四条通道
  const idx = readFileSync(resolve(__dirname, '..', 'entry/src/main/ets/pages/Index.ets'), 'utf8');
  const start = idx.indexOf('convertOffice: function');
  if (start < 0) errs.push('pdfMock 缺 convertOffice 方法（渲染层调用将静默 resolve(undefined)）');
  else {
    const end = idx.indexOf('\n    },\n', start);
    const seg = idx.slice(start, end < 0 ? start + 4000 : end);
    // 方法体：读盘 → 加载转换桥 → 加载 wasm → 转换 → 另存为 → 新标签页打开 → 结构化返回
    for (const s of ['readPdfPathBytes(', 'loadPdfConvert(', 'loadPdfium(', 'convertPdfTo', 'saveAsBytesExt(', 'openConvertedInShell(', 'ok: true']) {
      if (!seg.includes(s)) errs.push(`convertOffice 缺: ${s}`);
    }
  }
  // 方法体只调用助手，落盘与「交给 shell 打开」的原语在助手内：全文件级断言
  for (const s of ['saveAsAnyJson', '__goOpenExternalPath', 'convertSuggestedName', 'pdfConvertErrorMsg']) {
    if (!idx.includes(s)) errs.push(`Index.ets 缺 PDF 转换助手: ${s}`);
  }
  if (!/PDF_CONVERT_RAW/.test(idx) || !/PDFIUM_WASM_RAW/.test(idx)) errs.push('Index.ets 缺 pdf-convert/pdfium 的 rawfile 常量');

  // 3) 渲染层：必须传源路径 + 每种结局都要上报（静默返回就是本 BUG 的原始形态）
  const app = readFileSync(resolve(root, 'apps/pdf/src/renderer/App.tsx'), 'utf8');
  if (!/pdfApi\.convertOffice\(\s*format\s*,\s*filePath\s*\)/.test(app)) {
    errs.push('App.tsx 未把源文件路径传给 pdfApi.convertOffice（鸿蒙侧需要它读盘）');
  }
  for (const k of ['convertRunning', 'convertDone', 'convertDegraded', 'convertScanned', 'convertFailed']) {
    if (!app.includes(`t('${k}'`)) errs.push(`App.tsx 未上报转换结局: ${k}`);
  }
  const ipc = readFileSync(resolve(root, 'apps/pdf/src/shared/ipc.ts'), 'utf8');
  if (!/convertOffice\(format: PdfConvertFormat, sourcePath\?: string\)/.test(ipc)) {
    errs.push('ipc.ts convertOffice 签名缺 sourcePath?');
  }

  // 4) i18n 提示键（en/zh/zh-TW 至少三处，对齐图章门禁）+ rawfile 已同步
  const strings = readFileSync(resolve(root, 'apps/pdf/src/renderer/i18n/strings.ts'), 'utf8');
  for (const k of ['convertRunning:', 'convertDone:', 'convertDegraded:', 'convertScanned:', 'convertFailed:']) {
    const n = strings.split(k).length - 1;
    if (n < 3) errs.push(`strings.ts 键 ${k} 只出现 ${n} 次（需 en/zh/zh-TW 三处）`);
  }
  const html = resolve(root, 'harmony/entry/src/main/resources/rawfile/web/pdf/index.html');
  if (!existsSync(html)) errs.push('缺 rawfile/web/pdf/index.html');
  else if (!readFileSync(html, 'utf8').includes('convertDegraded')) {
    errs.push('rawfile/web/pdf/index.html 未同步（先跑 sh harmony/scripts/sync-web.sh pdf）');
  }
  if (errs.length) throw new Error(errs.join('; '));
}

// pdf.js wasm 门禁：扫描件（CCITT G4 / JBIG2 瓦片）全靠 jbig2.wasm 解码，失败时 pdf.js
// 只 warn 一句就丢弃瓦片 → 页面几乎全白（真机症状：同一文件在 WPS 显示正常）。两条真机
// 踩过的静默失效路径：
//   1) 自建 rawfile 响应给二进制体设 utf-8 编码 → 字节被替换成 U+FFFD → instantiate 抛错；
//   2) wasm 取不到时，pdf.js 的纯 JS 回退文件（*_nowasm_fallback.js）不在包里 → 无路可退。
function checkPdfjsWasmWiring() {
  const root = resolve(__dirname, '..', '..');
  const errs = [];
  const idx = readFileSync(resolve(__dirname, '..', 'entry/src/main/ets/pages/Index.ets'), 'utf8');
  const start = idx.indexOf('private serveRawfile');
  if (start < 0) {
    errs.push('未找到 serveRawfile（rawfile 自建响应）');
  } else {
    const seg = idx.slice(start, idx.indexOf('aboutToAppear', start));
    if (!seg.includes('RAWFILE_TEXT_RE')) {
      errs.push('serveRawfile 未按文本白名单分流：图片/wasm/cmap 会被按 UTF-8 投递（字节损坏）');
    }
    // setResponseEncoding 必须只出现在 if (!binary) 块里（块体无嵌套花括号，可整块摘除后再查）
    const guarded = /if\s*\(!binary\)\s*\{[^{}]*\}/;
    const block = guarded.exec(seg);
    if (!block) {
      errs.push('serveRawfile 未把 setResponseEncoding 限制在文本资源上（二进制体必坏）');
    } else if (block[0].includes("setResponseEncoding('utf-8')")) {
      if (seg.replace(guarded, '').includes("setResponseEncoding('utf-8')")) {
        errs.push('serveRawfile 另有无条件 setResponseEncoding(utf-8)（二进制体必坏）');
      }
    } else {
      errs.push('serveRawfile 的 if (!binary) 块里没有 setResponseEncoding(utf-8)（文本资源会缺编码）');
    }
    if (!/binary \? mime :/.test(seg)) {
      errs.push('serveRawfile 的 Content-Type 未按 binary 分流（二进制体带 charset=utf-8）');
    }
    // https 别名通道：渲染层 fetch 走原生自建响应（绕开 base64 桥）。别名必须与 rawfile 同源同读法，
    // 且别名下不受 RAWFILE_MODULE_RE 限制 —— cmaps/*.bcmap 不在模块清单里，但同样是 fetch 取字节。
    if (!seg.includes('ASSET_ORIGIN')) {
      errs.push('serveRawfile 未处理 ASSET_ORIGIN（https 别名）通道');
    }
    if (!/!aliased && !RAWFILE_MODULE_RE\.test\(path\)/.test(seg)) {
      errs.push('serveRawfile 对别名通道也套了 RAWFILE_MODULE_RE：cmaps/*.bcmap 会被交回默认通道（fetch 仍失败）');
    }
  }
  // 文本白名单（批次 D-6）：把「二进制白名单」改成「文本白名单」，因为前者漏一个扩展名
  // 就是**静默字节损坏**（真机：sheets 的 send-enter-off.png 被按 UTF-8 解码 → 破图；同类机制
  // 早先毁过 pdf.js 的 jbig2.wasm）。门禁两侧都断言：文本类必须在名单里，二进制类必须不在。
  const textRe = /RAWFILE_TEXT_RE: RegExp = \/\\\.\(([^)]*)\)/i.exec(idx);
  if (!textRe) {
    errs.push('Index.ets 缺 RAWFILE_TEXT_RE（只有文本类资源才声明 UTF-8）');
  } else {
    const list = textRe[1].split('|').map((s) => s.toLowerCase());
    for (const t of ['js', 'mjs', 'css', 'json']) {
      if (!list.includes(t)) errs.push(`RAWFILE_TEXT_RE 未覆盖 .${t}（脚本/样式会缺 charset）`);
    }
    for (const t of ['png', 'jpg', 'gif', 'webp', 'ico', 'wasm', 'ttf', 'otf', 'woff', 'woff2', 'bcmap']) {
      if (list.includes(t)) errs.push(`RAWFILE_TEXT_RE 误收 .${t}（二进制按 UTF-8 投递 = 字节被替换成 U+FFFD）`);
    }
  }
  // 别名根的三个交付点：壳侧常量、注入给渲染层的全局、渲染层候选顺序（缺一则资源继续走 base64 桥）
  if (!/ASSET_ORIGIN: string = 'https:\/\/goasset\.local\/'/.test(idx)) {
    errs.push('Index.ets 缺 ASSET_ORIGIN 常量（https 别名根未定义）');
  }
  if (!idx.includes("window.__goAssetBase = 'https://goasset.local/'")) {
    errs.push('Index.ets 未注入 window.__goAssetBase：渲染层拿不到别名根');
  }
  if (!idx.includes('var GO_ASSET_FETCH = ')) {
    errs.push('Index.ets 的 fetch 兜底未覆盖别名根：拦截失效时会落到真实网络（域名不解析 → 资源全丢）');
  }
  // 随 wasm 一起发布的纯 JS 解码器：wasm 不可用时是扫描件的唯一出路
  for (const rel of [
    'harmony/entry/src/main/resources/rawfile/web/pdf/pdfjs/wasm/jbig2.wasm',
    'harmony/entry/src/main/resources/rawfile/web/pdf/pdfjs/wasm/jbig2_nowasm_fallback.js',
    'harmony/entry/src/main/resources/rawfile/web/pdf/pdfjs/wasm/openjpeg.wasm',
  ]) {
    if (!existsSync(resolve(root, rel))) errs.push(`rawfile 缺 ${rel}（sync-web.sh pdf 未同步）`);
  }
  // 渲染层：探针必须先于 getDocument 定下 useWasm，且所有 getDocument 都走 pdfDocOpts()
  const app = readFileSync(resolve(root, 'apps/pdf/src/renderer/App.tsx'), 'utf8');
  if (!app.includes('ensurePdfjsWasm()')) errs.push('App.tsx 未在载入文档前跑 wasm 探针');
  if (!app.includes('...pdfDocOpts()')) errs.push('App.tsx 未把 useWasm 决策传给 getDocument');
  if (/getDocument\(\{[^}]*\.\.\.DOC_OPTS/.test(app)) {
    errs.push('App.tsx 仍有 getDocument 直接展开 DOC_OPTS（漏掉 useWasm 决策）');
  }
  const probe = resolve(root, 'apps/pdf/src/renderer/pdfjs-wasm.ts');
  if (!existsSync(probe)) errs.push('缺 apps/pdf/src/renderer/pdfjs-wasm.ts');
  else {
    const src = readFileSync(probe, 'utf8');
    for (const s of ['runPdfjsWasmProbe', 'ensurePdfjsWasm', 'isWasmBinary', 'nowasm_fallback']) {
      if (!src.includes(s)) errs.push(`pdfjs-wasm.ts 缺: ${s}`);
    }
  }
  const view = readFileSync(resolve(root, 'apps/pdf/src/renderer/view-config.ts'), 'utf8');
  if (!/useWasm: false/.test(view)) errs.push('view-config.ts pdfDocOpts 未实现 useWasm:false 回退');
  // 探测切根：候选顺序缺失或资产 URL 仍从静态常量生成 → 切根后 cMapUrl/wasmUrl 还指旧根
  if (!view.includes('ASSET_BASE_CANDIDATES')) {
    errs.push('view-config.ts 缺 ASSET_BASE_CANDIDATES：别名根无从优先');
  }
  if (!/export const docOpts = \(\)/.test(view)) {
    errs.push('view-config.ts 的资产 URL 未改成按当前根生成的 docOpts()：切根后失效');
  }
  if (/DOC_OPTS/.test(view)) {
    errs.push('view-config.ts 仍有静态 DOC_OPTS 常量（切根后失效）');
  }
  const probeSrc = existsSync(resolve(root, 'apps/pdf/src/renderer/pdfjs-wasm.ts'))
    ? readFileSync(resolve(root, 'apps/pdf/src/renderer/pdfjs-wasm.ts'), 'utf8')
    : '';
  if (probeSrc && !probeSrc.includes('ASSET_BASE_CANDIDATES')) {
    errs.push('pdfjs-wasm.ts 未按候选根探测：别名通不过时不会回落 rawfile');
  }
  if (probeSrc && !probeSrc.includes('setAssetBase')) {
    errs.push('pdfjs-wasm.ts 未把选中的资源根写回 view-config：后续 getDocument 仍用首选项');
  }
  if (probeSrc && !probeSrc.includes('AbortController')) {
    errs.push('pdfjs-wasm.ts 探测无超时：别名域名不解析时会卡住首次打开');
  }

  // __goImport 对 resource:// 的分支：ArkWeb 下页面 origin 是 null，三条网络通道全废 ——
  // fetch 报 "URL scheme resource is not supported"，XHR 与原生动态 import 都被 CORS 拦。
  // 所以未注册进 __goChunks 的 rawfile JS 本来就没有网络出路，叠 fetch/XHR 只是刷两行
  // error 日志（真机：goImport fetch miss → data-route failed）。断言该分支只试原生 import。
  const shimStart = idx.indexOf('window.__goImport = function');
  if (shimStart < 0) {
    errs.push('Index.ets 缺 window.__goImport（动态 import 中转已断）');
  } else {
    const open = idx.indexOf('{', shimStart);
    let depth = 0;
    let end = -1;
    for (let i = open; i < idx.length; i++) {
      if (idx[i] === '{') depth++;
      else if (idx[i] === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    const body = idx.slice(shimStart, end < 0 ? shimStart + 6000 : end);
    // 锚定 String(spec)：表内命中的分支用的是 key.indexOf(...)，不能混为一谈
    const br = body.indexOf("String(spec).indexOf('resource://rawfile/')");
    if (br < 0) {
      errs.push('__goImport 未对 resource://rawfile/ 分流（该 scheme 的 fetch/XHR 必然失败）');
    } else {
      const branchEnd = body.indexOf('} else {', br);
      const branch = body.slice(br, branchEnd < 0 ? body.length : branchEnd);
      if (!branch.includes('import(spec)')) {
        errs.push('__goImport 的 resource:// 分支未尝试原生 import（Electron/dev 与自定义 scheme 下会误判失败）');
      }
      if (branch.includes('fetchText(spec)') || branch.includes('xhrText(spec)')) {
        errs.push('__goImport 的 resource:// 分支仍在试 fetch/XHR：ArkWeb 下必失败，只是多刷 error 日志');
      }
    }
  }
  const html = resolve(root, 'harmony/entry/src/main/resources/rawfile/web/pdf/index.html');
  if (existsSync(html) && !readFileSync(html, 'utf8').includes('wasm probe')) {
    errs.push('rawfile/web/pdf/index.html 未同步（先跑 sh harmony/scripts/sync-web.sh pdf）');
  }
  // 扫描件解码链（真机实测）：resource:// 下 pdf.js 的纯 JS 解码器取不到 → JBIG2/CCITT G4
  // 传真与 JPEG2000 页面几乎空白。两处必须成立：
  //   a) 解码器已进 __goChunks 注册表（blob: 通道是页面唯一能动态加载模块的路）；
  //   b) pdf.worker 里那条 import(`${wasmUrl}${file}`) 已改写成 __goImportDynamic
  //      —— 模板+注释块形态，只靠字面量/变量规则抓不到。
  if (existsSync(html)) {
    const page = readFileSync(html, 'utf8');
    const table = /window\.__goChunks=\{([\s\S]*?)\};<\/script>/.exec(page);
    if (!table) {
      errs.push('rawfile/web/pdf/index.html 缺 __goChunks 注册表（inline-renderer 未跑）');
    } else {
      const byName = new Map([...table[1].matchAll(/"([^"]+\.(?:js|mjs))":"([A-Za-z0-9+/=]+)"/g)].map(([, k, b]) => [k, b]));
      const needed = ['jbig2_nowasm_fallback.js', 'openjpeg_nowasm_fallback.js'];
      const declared = existsSync(probe) ? /const REQUIRED_FALLBACKS\s*=\s*\[([^\]]*)\]/.exec(readFileSync(probe, 'utf8')) : null;
      if (!declared) errs.push('pdfjs-wasm.ts 读不到 REQUIRED_FALLBACKS（探针契约变了）');
      else {
        for (const name of declared[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)) {
          needed.push(name);
        }
      }
      for (const name of new Set(needed)) {
        if (!byName.has(name)) {
          errs.push(`__goChunks 未注册 ${name}：ArkWeb 下扫描件拿不到纯 JS 解码器（页面空白）`);
        }
      }
      const workerKey = [...byName.keys()].find((k) => /^pdf\.worker.*\.mjs$/.test(k));
      if (!workerKey) errs.push('__goChunks 未注册 pdf.worker（PDF 无法解析）');
      else {
        const code = Buffer.from(byName.get(workerKey), 'base64').toString('utf8');
        if (!code.includes('__goImportDynamic(')) {
          errs.push('pdf.worker 的 wasm fallback 动态 import 未改写为 __goImportDynamic（模板形态漏改写）');
        } else if (/(?<![A-Za-z0-9_$])import\(/.test(code)) {
          errs.push('pdf.worker 仍有未改写的动态 import：resource:// 下会被 CORS 拦');
        }
      }
    }
  }

  // rawfile fetch 兜底（PROMISE_SHIM）：ArkWeb 下 origin=null，fetch/XHR/原生 import 三条
  // 全废。PROMISE_SHIM 必须用 window.fetch 包装把 resource://rawfile/* 改道走 readRawFileJson，
  // 把 cmap / 标准字体数据 / wasm 字节打通。缺少这条 shim → jbig2/openjpeg 解码静默失败 +
  // CJK cmap 缺失 + 扫描件几乎全白。锚点：挂 window.fetch、命中 rawfile 前缀、命中
  // readRawFileJson、构造 Response。
  const shimText = shim;
  if (!/window\.fetch\s*=\s*function/.test(shimText)) {
    errs.push('PROMISE_SHIM 未挂 window.fetch 兜底（ArkWeb 下 pdf.js 无法取 wasm/cmap/字体）');
  }
  if (!/resource:\/\/rawfile\//.test(shimText)) {
    errs.push('PROMISE_SHIM 的 fetch 兜底未拦截 resource://rawfile/（不命中就走了原生 fail 分支）');
  }
  if (!/readRawFileJson/.test(shimText)) {
    errs.push('PROMISE_SHIM 的 fetch 兜底未走 readRawFileJson 桥（应是 rawfile → 桥 → 真字节）');
  }
  if (!/new Response\(/.test(shimText)) {
    errs.push('PROMISE_SHIM 的 fetch 兜底未构造 Response（pdf.js 的 fetch caller 拿不到字节）');
  }

  if (errs.length) throw new Error(errs.join('; '));
}

// PDF/全 app 打印与「导出图片」门禁：三条真机踩过的静默失效路径 ——
//   1) ArkWeb 的 W3C window.print() 必须先声明 ohos.permission.PRINT，缺权限是静默失败
//      （点击「打印」毫无反应，无异常、无日志）；
//   2) 渲染层调 window.pdfApi.exportImages 但壳侧没有该方法 → Proxy 兜底 resolve(undefined)
//      → result.ok 抛 TypeError 或被吞 → 同样表现为「无反应」；
//   3) print.ts 若 await afterprint，而 ArkWeb 由系统打印框架接管不派发该事件，打印按钮会
//      永久停在「正在准备打印」禁用态。
function walkCssForPrint(dir, files = []) {
  if (!existsSync(dir)) return files;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, ent.name);
    if (ent.isDirectory()) { walkCssForPrint(p, files); continue; }
    if (ent.name.endsWith('.css')) { files.push(p); }
  }
  return files;
}
function checkPrintExportWiring() {
  const root = resolve(__dirname, '..', '..');
  const errs = [];
  const mod = readFileSync(resolve(__dirname, '..', 'entry/src/main/module.json5'), 'utf8');
  if (!mod.includes('ohos.permission.PRINT')) {
    errs.push('module.json5 未声明 ohos.permission.PRINT：ArkWeb window.print() 静默失败（打印点了没反应）');
  }
  const idx = readFileSync(resolve(__dirname, '..', 'entry/src/main/ets/pages/Index.ets'), 'utf8');
  const m = /exportImages\s*:\s*function/.exec(idx);
  if (!m) {
    errs.push('pdfMock 缺 exportImages 实现：window.pdfApi.exportImages 只会拿到 undefined');
  } else {
    const seg = idx.slice(m.index, m.index + 2400);
    if (!seg.includes("'pickDirectory'")) errs.push('exportImages 未走 pickDirectory：无法让用户选输出目录');
    // 导出目标是「已授权目录 + 新文件名」，从未进 writable → 必须走 saveInDirJson；
    // 用 saveAnyJson 拼新路径在真机恒报 "save target is not an opened document"（已踩）。
    if (!seg.includes("'saveInDirJson'")) errs.push('exportImages 未走 saveInDirJson：目录外新建文件未授权，真机落盘失败');
    if (!/ok:\s*true/.test(seg)) errs.push('exportImages 未返回 {ok:true,...}：渲染层按 ok 判成败');
  }
  const app = readFileSync(resolve(root, 'apps/pdf/src/renderer/App.tsx'), 'utf8');
  if (!app.includes('pdfApi.exportImages(')) errs.push('App.tsx 未调用 pdfApi.exportImages');
  const print = readFileSync(resolve(root, 'apps/pdf/src/renderer/print.ts'), 'utf8');
  if (!print.includes('afterprint')) errs.push('print.ts 缺少 afterprint 清理');
  if (/addEventListener\(\s*'afterprint'\s*,\s*done\s*\)/.test(print)) {
    errs.push('print.ts 仍在 await afterprint：ArkWeb 不派发该事件时打印按钮会永久禁用');
  }
  if (!/setTimeout\(\s*cleanup\s*,\s*\d+\s*\)/.test(print)) {
    errs.push('print.ts 缺少兜底清理超时（afterprint 不派发时打印根会一直留在 DOM）');
  }
  // R4：tabbar.css 和 pdf styles.css 已恢复上游，@media print 规则由 patch-web.mjs 在构建时追加。
  // 检查 dist 产物中是否包含这些补丁（而非源码）。
  const webRoot = resolve(__dirname, '..', 'entry/src/main/resources/rawfile/web');
  if (existsSync(webRoot)) {
    // 扫描 shell CSS 产物中是否有 @media print 隐藏 .tab-bar
    const shellCssFiles = walkCssForPrint(resolve(webRoot, 'shell'));
    const hasTabbarPrint = shellCssFiles.some(f => readFileSync(f, 'utf8').includes('/*patch:tabbar-print*/'));
    if (!hasTabbarPrint) {
      errs.push('shell dist CSS 缺 @media print 隐藏 .tab-bar（patch-web.mjs 未应用）：打印输出会带一条 40px 标签栏');
    }
    // 扫描 pdf CSS 产物中是否有 @media print 规则
    const pdfCssFiles = walkCssForPrint(resolve(webRoot, 'pdf'));
    const hasPdfPrint = pdfCssFiles.some(f => {
      const css = readFileSync(f, 'utf8');
      return /@media\s+print/.test(css);
    });
    if (!hasPdfPrint) {
      errs.push('pdf dist CSS 缺 @media print 打印容器规则（patch-web.mjs 未应用）：打印会输出整个应用界面');
    }
  }
  // print.ts 源码检查保留（print.ts 保留了源码改动，不走构建时 patch）
  if (errs.length) throw new Error(errs.join('; '));
}

// ArkTS 成员重复声明门禁：同一个 class/struct 里出现两个同名方法时 DevEco 直接
// 「10505001 ArkTS Compiler Error: Duplicate function implementation」构建失败。
// arkts-balance 只查模板串括号平衡、看不到这个，本门禁专治「verify-all 全绿但真机构建红」。
// 必须先屏蔽模板字面量/字符串/注释里的内容：Index.ets 的 PROMISE_SHIM/SHELL_BRIDGE 是
// 注入 JS，2 空格缩进的 mock 调用会被朴素正则误判成方法声明（已踩）。
function maskNonCode(src) {
  let out = '';
  let state = 'code';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const d = src[i + 1];
    if (state === 'code') {
      if (c === '/' && d === '/') { state = 'line'; out += '  '; i++; continue; }
      if (c === '/' && d === '*') { state = 'block'; out += '  '; i++; continue; }
      if (c === '`') { state = 'tpl'; out += ' '; continue; }
      if (c === "'") { state = 'sq'; out += ' '; continue; }
      if (c === '"') { state = 'dq'; out += ' '; continue; }
      out += c; continue;
    }
    if (state === 'line') { out += c === '\n' ? '\n' : ' '; if (c === '\n') state = 'code'; continue; }
    if (state === 'block') {
      if (c === '*' && d === '/') { state = 'code'; out += '  '; i++; continue; }
      out += c === '\n' ? '\n' : ' ';
      continue;
    }
    if (state === 'tpl') {
      if (c === '\\') { out += '  '; i++; continue; }
      if (c === '`') { state = 'code'; out += ' '; continue; }
      out += c === '\n' ? '\n' : ' ';
      continue;
    }
    // sq / dq
    if (c === '\\') { out += '  '; i++; continue; }
    if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"')) { state = 'code'; out += ' '; continue; }
    out += c === '\n' ? '\n' : ' ';
  }
  return out;
}

function checkArkTsDuplicateMembers() {
  const errs = [];
  const files = ['entry/src/main/ets/pages/Index.ets', 'entry/src/main/ets/bridge/DesktopBridge.ets'];
  const typeRe = /^(?:export\s+)?(?:@\w+\s*)*(?:class|struct)\s+([A-Za-z_$][\w$]*)/;
  const kwRe = /^(if|for|while|switch|catch|return|function|constructor|else|new|typeof|await)$/;
  for (const rel of files) {
    const lines = maskNonCode(readFileSync(resolve(__dirname, '..', rel), 'utf8')).split('\n');
    // 逐个 class/struct 独立统计：不同类里的同名方法合法，不能跨类比较
    const bodies = [];
    let cur = null;
    lines.forEach((line, idx) => {
      const t = typeRe.exec(line);
      if (t) {
        cur = { name: t[1], from: idx, members: new Map() };
        bodies.push(cur);
        return;
      }
      if (!cur) return;
      const m = /^ {2}(?:(?:private|public|protected|static|async)\s+)*([A-Za-z_$][\w$]*)\s*\(/.exec(line);
      if (!m || kwRe.test(m[1])) return;
      if (!cur.members.has(m[1])) cur.members.set(m[1], []);
      cur.members.get(m[1]).push(idx + 1);
    });
    for (const b of bodies) {
      for (const [name, at] of b.members) {
        if (at.length > 1) {
          errs.push(`${rel} 的 ${b.name} 中 ${name}() 重复声明（第 ${at.join(' / ')} 行）：ArkTS 报 10505001 Duplicate function implementation，DevEco 构建必失败`);
        }
      }
    }
  }
  if (errs.length) throw new Error(errs.join('; '));
}

// 「最近打开」跨启动重开门禁：Picker 授权是**临时**的（应用退出/设备重启即清除），不持久化
// 就只能在本应用会话内重开 —— 真机症状两种：起始页条目 stat 失败被标 missing 灰显，或强行
// 打开时报 EPERM（file_api `OpenByFileDataUri Failed to open file for libuv error -1` →
// 渲染层「读取失败：Operation not permitted」）。官方给该场景的解法即 persist + activate 链路，
// 任一环断了症状会原样复现，故逐点设防：
//   1) 权限声明（缺权限 → persistPermission 报 PERMISSION_NOT_PERSISTED，静默降级）；
//   2) Picker 站点全部立即持久化（只在"刚拿到临时授权"这一刻能成功，漏一处 = 该入口失效）；
//   3) 启动后 activatePermission（未激活的持久化授权读不了文件）；
//   4) taskpool 软失败（返回 error 而非抛出）的 EPERM 必须有主线程回退，否则可读文件被误判。
function checkRecentPersistWiring() {
  const root = resolve(__dirname, '..', '..');
  const errs = [];
  const mod = readFileSync(resolve(__dirname, '..', 'entry/src/main/module.json5'), 'utf8');
  if (!mod.includes('ohos.permission.FILE_ACCESS_PERSIST')) {
    errs.push('module.json5 未声明 ohos.permission.FILE_ACCESS_PERSIST：最近打开跨启动必 EPERM（需 ACL，DevEco 重新自动签名）');
  }
  // 桥侧接线（批次 E）：冷启动就激活持久化授权，EPERM 翻成可行动文案而不是系统原文
  const bridgeSrc = readFileSync(resolve(__dirname, '..', 'entry/src/main/ets/bridge/DesktopBridge.ets'), 'utf8');
  const sc = bridgeSrc.indexOf('setContext(ctx: common.Context): void {');
  if (sc < 0) {
    errs.push('找不到 setContext（recents 与授权激活的入口）');
  } else if (!bridgeSrc.slice(sc, sc + 700).includes('void this.activatePersistedGrants();')) {
    errs.push('setContext 未冷启动激活持久化授权（只在列表查询时激活 → 期间点开条目必 EPERM）');
  }
  if (!bridgeSrc.includes('function readFailText(e: Object): string')) {
    errs.push('缺 readFailText（EPERM 必须翻成「授权已失效，请重新选择」，而不是 Operation not permitted）');
  }
  // 主线程那份调 readFailText；**@Concurrent 那份必须内联同语义文案** —— es2abc 不允许并发函数
  // 引用同文件的模块级函数（真机构建炸过：Concurrent function should only use import variable
  // or local variable，整包 CompileArkTS FAIL）。所以这里的"重复"是故意的，必须锁住方向。
  const readFailCalls = (bridgeSrc.match(/return \{ 'error': readFailText\(e\) \};/g) || []).length;
  if (readFailCalls !== 1) {
    errs.push('主线程读路径调用 readFailText 应为 1 处，实际 ' + readFailCalls + ' 处');
  }
  const cp = bridgeSrc.indexOf('function readFilePayload(');
  if (cp < 0) {
    errs.push('找不到 readFilePayload（@Concurrent 读字节路径）');
  }
  // 「并发函数体内不得调用模块级函数」由 checkArktsSemantics 通用拦（那份会剥注释，
  // 所以不会被这里「不能复用 readFailText()」这类说明文字误伤）。本处只锁调用点数量。
  const strings = readFileSync(resolve(__dirname, '..', 'entry/src/main/resources/base/element/string.json'), 'utf8');
  if (!strings.includes('file_access_persist_reason')) {
    errs.push('string.json 缺 file_access_persist_reason（module.json5 的 $string 引用会构建失败）');
  }
  const bridgePath = resolve(__dirname, '..', 'entry/src/main/ets/bridge/DesktopBridge.ets');
  const src = readFileSync(bridgePath, 'utf8');
  if (!/fileShare/.test(src)) errs.push('DesktopBridge 未引入 fileShare（@kit.CoreFileKit）');
  for (const s of ['persistPermission', 'activatePermission']) {
    if (!src.includes(s)) errs.push(`DesktopBridge 缺 fileShare.${s}`);
  }
  if (!/canIUse\('SystemCapability\.FileManagement\.AppFileService\.FolderAuthorization'\)/.test(src)) {
    errs.push('DesktopBridge 未做 FolderAuthorization 能力校验（无能力设备上会抛异常）');
  }
  // 2) 每个 picker 站点（open/save/save-as/sheets-open）取到 URI 后必须立刻持久化
  // 定义锚定 + 花括号配平取方法体：call site（this.openFileJson(...) / switch 分支）不能当
  // 实现（曾误报全 FAIL）；也不能用固定字符窗口 —— 相邻方法体里的同名调用会串味（漏报）。
  // 本文件无模板字面量/花括号字符字面量（${、'}'、'{' 均为 0 处），配平是安全近似。
  const bodyOf = (name) => {
    const re = new RegExp(`^[ \\t]*((?:private|public|protected|static|async)[ \\t]+)*${name}[ \\t]*\\(`, 'm');
    const m = re.exec(src);
    if (!m) return '';
    const open = src.indexOf('{', m.index);
    if (open < 0) return '';
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) return src.slice(m.index, i + 1);
      }
    }
    return '';
  };
  const sites = ['openFileJson', 'openDocxJson', 'saveAsDocxJson', 'saveAsAnyJson', 'xlsOpenJson'];
  for (const fn of sites) {
    const body = bodyOf(fn);
    if (!body) {
      errs.push(`DesktopBridge 未找到方法定义 ${fn}（改名则本门禁失效）`);
      continue;
    }
    if (!body.includes('persistPickerGrant(')) {
      errs.push(`${fn} 拿到 picker URI 后未调用 persistPickerGrant（该入口的最近文件跨启动仍 EPERM）`);
    }
  }
  // 3) 启动后使能：最近列表与三条读盘入口都要先激活
  if (!/private async activatePersistedGrants\(\)/.test(src)) {
    errs.push('DesktopBridge 缺 activatePersistedGrants 实现');
  }
  for (const s of ['recentPageJson', 'statPathsJson', 'readDocxUri', 'xlsOpenJson']) {
    const body = bodyOf(s);
    if (!body) {
      errs.push(`DesktopBridge 未找到方法定义 ${s}（改名则本门禁失效）`);
      continue;
    }
    if (!body.includes('activatePersistedGrants()')) {
      errs.push(`${s} 未在 stat/读盘前 activatePersistedGrants()（跨启动条目会被误判不可读）`);
    }
  }
  // 4) EPERM 兜底：taskpool 返回 error（软失败）时也必须回退主线程 + 给可操作文案
  if (!/isPermissionFailure\(/.test(src)) errs.push('DesktopBridge 缺 isPermissionFailure（EPERM 判定）');
  if (!/readFailureText\(/.test(src)) {
    errs.push('DesktopBridge 缺 readFailureText：EPERM 会把 "Operation not permitted" 原样丢给用户');
  }
  // 5) 移除条目要释放持久化授权（只增不减会累积占用系统策略额度）
  if (!src.includes('revokePermission')) {
    errs.push('DesktopBridge 未调用 fileShare.revokePermission（移除条目后持久化授权只增不减）');
  }
  if (!bodyOf('removeRecentJson').includes('revokePickerGrants(')) {
    errs.push('removeRecentJson 未释放授权（条目移除后系统里仍留着可访问授权）');
  }
  // readDocxUri / 工作簿打开入口的软失败分支各需一次主线程重试（payload.error 命中后 readUriOnMainThread）
  // M7-4 后 xls 的读字节从 xlsOpenJson 拆到了 openSheetFromUri（xlsOpenJson 现在只做
  // picker/授权/恢复提问握手，不再读盘），所以这里锚定真正读盘的那个方法。
  let retries = 0;
  for (const s of ['readDocxUri', 'openSheetFromUri']) {
    if (/payload\.error\s*&&\s*this\.isPermissionFailure\(/.test(bodyOf(s))) retries++;
  }
  if (retries < 2) {
    errs.push(`taskpool 软失败 EPERM 的主线程重试只接在 ${retries}/2 个入口上（readDocxUri/openSheetFromUri 都要）`);
  }
  if (errs.length) throw new Error(errs.join('; '));
}

// 未保存守卫门禁：关闭 tabs 时壳必须能读到各 app 的「有未保存更改」状态，且「保存并关闭」
// 必须走 app 自己的 onCloseSaveRequest 协议。任一通道被删/被覆盖成 noop → 真机直接关 tab
// 丢内容且无提示（PDF setDirty 曾被覆盖成 noop，正是此门禁要拦的回归）。
function checkCloseGuard() {
  const root = resolve(__dirname, '..', '..');
  const idx = readFileSync(resolve(__dirname, '..', 'entry/src/main/ets/pages/Index.ets'), 'utf8');
  const errs = [];
  // 壳侧：三条未保存通道 + 保存协议触发点
  for (const s of [
    '__goFrameDirty',
    '__goCloseCheckHandler',
    '__goCloseCheck',
    '__goCloseSaveHandler',
    '__goCloseSaveResult',
    'function frameDirtyOf',
    'function saveFrameBeforeClose',
    'function showDirtyConfirm',
  ]) {
    if (!idx.includes(s)) errs.push('Index.ets 缺: ' + s);
  }
  // 事件上报类方法的 base 实现不能是裸 NOOP（否则状态永远收不到）
  for (const m of ['reportCloseCheck', 'reportCloseSaveResult', 'sendCloseSaveResult', 'notifyPendingEdits']) {
    if (!new RegExp('\\b' + m + '\\s*:\\s*function').test(idx)) {
      errs.push('mock 缺实现: ' + m + '（裸 NOOP 会让未保存状态丢失）');
    }
  }
  // pdfMock 不得再覆盖 setDirty 成 noop（PDF 未保存状态唯一通道）
  if (/setDirty\s*:\s*function\s*\(\s*\)/.test(idx)) {
    errs.push('存在无参 setDirty 覆盖（如 pdfMock）：会把未保存状态固定为 false');
  }
  // 各 app 必须仍然推送/回填未保存状态
  const apps = [
    ['apps/markdown/src/renderer/App.tsx', ['markdownApi.setDirty(true)', 'onCloseSaveRequest']],
    ['apps/pdf/src/renderer/App.tsx', ['pdfApi.setDirty(dirty)', 'onCloseSaveRequest']],
    ['apps/sheets/src/renderer/App.tsx', ['notifyPendingEdits', 'onCloseSaveRequest']],
    ['apps/slides/src/renderer/App.tsx', ['setDirty?.(dirty)', 'onCloseSaveRequest']],
    ['apps/docs/src/renderer/App.tsx', ['reportCloseCheck', 'onCloseSaveRequest']],
  ];
  for (const [rel, needles] of apps) {
    const src = readFileSync(resolve(root, rel), 'utf8');
    for (const n of needles) {
      if (!src.includes(n)) errs.push(rel + ' 缺: ' + n);
    }
  }
  // base mock 对象字面量内守卫方法不得重复定义：同名键后者胜出，会把前面的实现静默覆盖成
  // no-op（Excel 的 notifyPendingEdits 曾这样被覆盖 → 真机永远不脏、关 tab 不弹保存提示）。
  const mockStart = idx.indexOf('var mock = {');
  const mockEnd = idx.indexOf('\n  };', mockStart);
  const guardKeys = ['setDirty', 'notifyPendingEdits', 'onCloseCheck', 'reportCloseCheck',
    'onCloseSaveRequest', 'reportCloseSaveResult', 'sendCloseSaveResult'];
  if (mockStart < 0 || mockEnd <= mockStart) {
    errs.push('未定位 base mock 对象字面量（门禁失效，请核对 Index.ets 结构）');
  } else {
    const mockBody = idx.slice(mockStart, mockEnd);
    for (const k of guardKeys) {
      const hits = mockBody.match(new RegExp('\\n    ' + k + '\\s*:', 'g')) || [];
      if (hits.length === 0) errs.push('base mock 缺守卫方法: ' + k);
      if (hits.length > 1) {
        errs.push('base mock 重复定义守卫方法 ' + k + ' ×' + hits.length + '（后者覆盖前者 → 未保存状态装不进去）');
      }
    }
    // app mock（Object.assign 第二参数）不得覆盖守卫方法；pdfMock 显式链回 base 属白名单
    for (const name of ['pdfMock', 'markdownMock', 'slidesMock']) {
      const s = idx.indexOf('var ' + name + ' = Object.assign(');
      if (s < 0) { errs.push('未找到 ' + name); continue; }
      const e2 = idx.indexOf('\n  });', s);
      const body = e2 > s ? idx.slice(s, e2) : '';
      for (const k of guardKeys) {
        if (new RegExp('\\n    ' + k + '\\s*:').test(body) && !body.includes('mock.' + k + '(')) {
          errs.push(name + ' 覆盖了 ' + k + ' 且未链回 mock.' + k + '()：未保存守卫会失效');
        }
      }
    }
  }
  if (errs.length) throw new Error(errs.join('; '));
}

// 壳 chrome 菜单门禁（M7）：Tab 列表菜单顶部的「另存为…/打印…」必须真的派发到那条通道。
// 三类失败模式在真机上都表现为「点了没反应」，所以逐条静态锚定：
//  ① 壳按 tab.kind 取动作（未支持的 app 不显示 → 不留死按钮）
//  ② 壳 postMessage 键名 ↔ frame 侧 listener 分支 ↔ 派发函数三者一致
//  ③ APP_FILE_ACTIONS 声称的通道在上游 app 渲染层真的登记了（上游改名 → 断言红，而不是静默失灵）
function checkAppFileMenu() {
  const root = resolve(__dirname, '..', '..');
  const idx = readFileSync(resolve(__dirname, '..', 'entry/src/main/ets/pages/Index.ets'), 'utf8');
  const errs = [];
  // ① 壳侧动作表：kind → 该 app 真实存在的通道
  const shellMap = [
    ['pdf', ['__goSaveAsRequest', '__goPrintRequest']],
    ['markdown', ['__goPrintRequest', "__goExportRequest: 'docx'", "__goExportRequest: 'docs'",
      "__goSaveRequest: 'save'", "__goSaveRequest: 'saveAs'"]],
    ['docs', ["__goMenuCommand: 'save-as'"]],
    ['slides', ["__goMenuCommand: 'save-as'", "__goMenuCommand: 'print'"]],
    ['sheets', ["__goMenuAction: 'save-as'"]],
  ];
  const mapStart = idx.indexOf('var APP_FILE_ACTIONS = {');
  const mapEnd = mapStart >= 0 ? idx.indexOf('\n  };', mapStart) : -1;
  if (mapStart < 0 || mapEnd <= mapStart) {
    errs.push('未定位 APP_FILE_ACTIONS（壳菜单动作表，门禁失效，请核对 Index.ets 结构）');
  } else {
    const body = idx.slice(mapStart, mapEnd);
    for (const [kind, needles] of shellMap) {
      const ks = body.indexOf('\n    ' + kind + ': [');
      if (ks < 0) { errs.push('APP_FILE_ACTIONS 缺 app 类型: ' + kind); continue; }
      const seg = body.slice(ks, body.indexOf(']', ks));
      for (const n of needles) {
        if (!seg.includes(n)) errs.push(kind + ' 菜单动作缺 ' + n);
      }
    }
  }
  // ② 菜单构建与派发
  const st = idx.indexOf('function showTabsMenu(x, y) {');
  const stBody = st >= 0 ? idx.slice(st, idx.indexOf('\n  }', st)) : '';
  if (st < 0) { errs.push('未找到 showTabsMenu（壳菜单入口）'); }
  for (const n of ['APP_FILE_ACTIONS', 'postToTab(t.id', 'activateTab(tt.id)']) {
    if (!stBody.includes(n)) errs.push('showTabsMenu 缺: ' + n);
  }
  const pt = idx.indexOf('function postToTab(id, msg) {');
  const ptBody = pt >= 0 ? idx.slice(pt, idx.indexOf('\n  }', pt)) : '';
  if (pt < 0) { errs.push('未找到 postToTab（壳 → app frame 派发）'); }
  for (const n of ['frameWinOf(id)', 'postMessage(Object.assign({ tabId: id }']) {
    if (!ptBody.includes(n)) errs.push('postToTab 缺: ' + n);
  }
  // ③ frame 侧注册表 + 触发函数 + listener 分支
  for (const n of ['var frameSaveAsFns = [];', 'var framePrintFns = [];',
    'var frameExportFns = [];', 'var frameSaveRequestFns = [];',
    'var frameMenuCommandFns = [];', 'var frameMenuActionFns = [];',
    'function registerFrameFn(list, fn)', 'function triggerSaveAsRequest(targetPath)',
    'function triggerFramePrint()', 'function triggerFrameExport(format)',
    'function triggerFrameSaveRequest(mode)',
    'function triggerMenuCommand(cmd, payload)',
    'function triggerMenuAction(action)']) {
    if (!idx.includes(n)) errs.push('Index.ets 缺: ' + n);
  }
  for (const n of ['if (d.__goSaveAsRequest) {', 'triggerSaveAsRequest(typeof d.targetPath',
    'if (d.__goPrintRequest) { triggerFramePrint(); return; }',
    "if (typeof d.__goExportRequest === 'string') { triggerFrameExport(d.__goExportRequest); return; }",
    "if (typeof d.__goSaveRequest === 'string') { triggerFrameSaveRequest(d.__goSaveRequest); return; }",
    "if (typeof d.__goMenuCommand === 'string') { triggerMenuCommand(d.__goMenuCommand, d.payload); return; }",
    "if (typeof d.__goMenuAction === 'string') { triggerMenuAction(d.__goMenuAction); }"]) {
    if (!idx.includes(n)) errs.push('frame 消息 listener 缺派发分支: ' + n);
  }
  // 导出派发必须收窄 ExportFormat：桌面格式有 'pdf' | 'docx' | 'docs' | 'png'，其中
  // pdf/png 在壳内没有 HTML→PDF 管线，渲染层拿到失败只写 console（导出 PDF 连状态栏文案都没有）
  // → 放行等于亲手造「点了没反应」的死按钮（本仓明确不留死按钮，见 APP_FILE_ACTIONS 注释）。
  if (!idx.includes("if (format !== 'docx' && format !== 'docs') { return false; }")) {
    errs.push('triggerFrameExport 未收窄 ExportFormat（只允许 docx/docs，其余会变死按钮）');
  }
  // 保存派发必须收窄 mode：渲染层把它直接透传给 markdownApi.save({mode})，而壳侧 save 只认
  // 'saveAs'（其余一律按覆盖保存）→ 字面量写错会让「另存为」静默覆盖原文件（数据丢失风险）。
  if (!idx.includes("if (mode !== 'save' && mode !== 'saveAs') { return false; }")) {
    errs.push('triggerFrameSaveRequest 未收窄 mode（只允许 save/saveAs，写错会让另存为静默覆盖原文件）');
  }
  // base mock 必须真实实现六条通道（裸 NOOP → 登记丢失，菜单点了没反应）
  const mockStart = idx.indexOf('var mock = {');
  const mockEnd = idx.indexOf('\n  };', mockStart);
  const chanKeys = ['onSaveAsRequest', 'onPrintRequest', 'onExportRequest', 'onSaveRequest',
    'onMenuCommand', 'onMenuAction'];
  if (mockStart < 0 || mockEnd <= mockStart) {
    errs.push('未定位 base mock 对象字面量（门禁失效）');
  } else {
    const mockBody = idx.slice(mockStart, mockEnd);
    for (const k of chanKeys) {
      const hits = mockBody.match(new RegExp('\\n    ' + k + '\\s*:', 'g')) || [];
      if (hits.length === 0) errs.push('base mock 缺通道实现: ' + k + '（Proxy 兜底会静默丢登记）');
      if (hits.length > 1) errs.push('base mock 重复定义通道 ' + k + ' ×' + hits.length);
      if (new RegExp(k + '\\s*:\\s*function\\s*\\(\\s*\\)').test(mockBody)) {
        errs.push('base mock 的 ' + k + ' 是无参 no-op（登记会被吞掉）');
      }
    }
    // app mock 不得覆盖这四条通道：pdfMock/markdownMock/slidesMock 一律继承 base
    for (const name of ['pdfMock', 'markdownMock', 'slidesMock']) {
      const s = idx.indexOf('var ' + name + ' = Object.assign(');
      if (s < 0) { errs.push('未找到 ' + name); continue; }
      const e2 = idx.indexOf('\n  });', s);
      const body = e2 > s ? idx.slice(s, e2) : '';
      for (const k of chanKeys) {
        if (new RegExp('\\n    ' + k + '\\s*:').test(body)) {
          errs.push(name + ' 覆盖了 ' + k + '：会静默替换 base 实现（应继承）');
        }
      }
    }
  }
  // 旧名残留（本轮把 PDF 专用通道泛化）：半迁移会让菜单派发到空表
  for (const dead of ['triggerPdfSaveAs', 'pdfSaveAsRequestFns', 'pdfPrintRequestFns']) {
    if (idx.includes(dead)) errs.push('Index.ets 仍残留旧名: ' + dead + '（已泛化为 frame*Fns/trigger*）');
  }
  // ④ 上游 app 渲染层真的登记/处理了菜单声称的通道（上游改名 → 死按钮）
  const upstream = [
    ['apps/pdf/src/renderer/App.tsx', ['pdfApi.onSaveAsRequest(', 'pdfApi.onPrintRequest(']],
    ['apps/markdown/src/renderer/App.tsx', ['markdownApi.onPrintRequest(', 'markdownApi.onExportRequest(',
      'markdownApi.onSaveRequest(', 'markdownApi.sendSaveRequestAck(', 'markdownApi.readImage(']],
    ['apps/docs/src/renderer/App.tsx', ["case 'save-as'"]],
    ['apps/slides/src/renderer/App.tsx', ["cmd === 'save-as'", "cmd === 'print'"]],
    ['apps/sheets/src/renderer/App.tsx', ["handleSave(action)"]],
  ];
  for (const [rel, needles] of upstream) {
    const src = readFileSync(resolve(root, rel), 'utf8');
    for (const n of needles) {
      if (!src.includes(n)) errs.push(rel + ' 缺: ' + n + '（壳菜单该项会变成死按钮）');
    }
  }
  // sheets 的 MenuAction 联合类型必须仍含 'save-as'（整文件里该串出现多次，必须锚在类型定义上；
  // 上游把联合类型改成多行排版，因此匹配跨行但限定紧随类型名之后的一小段，避免命中别处的字面量）
  const sheetsApi = readFileSync(resolve(root, 'apps/sheets/src/shared/desktop-api.ts'), 'utf8');
  if (!/export type MenuAction =[\s\S]{0,400}?'save-as'/.test(sheetsApi)) {
    errs.push("apps/sheets/src/shared/desktop-api.ts 缺: MenuAction 含 'save-as'（壳菜单该项会变成死按钮）");
  }
  if (errs.length) throw new Error(errs.join('; '));
}

// PDF 签名库门禁（M7）：签名「保存以便复用」必须真的落盘、跨会话可见，且返回结构对齐
// 渲染层（SavedSignature{id,createdAt,data}）。历史坑：旧实现以 localStorage 为存储、且要求
// 入参带 sig.id —— 渲染层传的是 SignatureData（无 id），于是 addSavedSignature 静默空转，
// 「保存以便复用」在真机上恒为空表且关掉应用即丢。
function checkPdfSignaturePersist() {
  const root = resolve(__dirname, '..', '..');
  const idx = readFileSync(resolve(__dirname, '..', 'entry/src/main/ets/pages/Index.ets'), 'utf8');
  const bridge = readFileSync(resolve(__dirname, '..', 'entry/src/main/ets/bridge/DesktopBridge.ets'), 'utf8');
  const errs = [];
  // ① 帧侧：三条通道走 goJson（ArkTS 磁盘），不再碰 localStorage
  const frame = [
    "goJson('listSavedSignaturesJson', [])",
    "goJson('addSavedSignatureJson', [JSON.stringify(sig",
    "goJson('removeSavedSignatureJson', [String(id",
    'listSavedSignatures: function () { return listSavedSignatures(); },',
    'addSavedSignature: function (sig) { return addSavedSignature(sig); },',
    'removeSavedSignature: function (id) { return removeSavedSignature(id); },',
  ];
  for (const n of frame) {
    if (!idx.includes(n)) errs.push('Index.ets 缺: ' + n);
  }
  for (const dead of ['SIGNATURES_KEY', 'loadSavedSignatures', 'storeSavedSignatures',
    "localStorage.getItem('genoffice.pdf.savedSignatures')"]) {
    if (idx.includes(dead)) errs.push('Index.ets 仍残留 localStorage 签名库实现: ' + dead);
  }
  // ② 桥侧：三个 case + 三个方法 + 落盘语义（上限 / 原子写 / id 生成 / 逐条校验）
  const bridgeNeed = [
    "register('listSavedSignaturesJson'",
    "register('addSavedSignatureJson'",
    "register('removeSavedSignatureJson'",
    'async listSavedSignaturesJson(',
    'async addSavedSignatureJson(',
    'async removeSavedSignatureJson(',
    'interface PdfSignatureData {',
    'interface PdfSavedSignature {',
    'MAX_SAVED_SIGNATURES: number = 10',
    'genoffice-pdf-signatures.json',
    'util.generateRandomUUID(true)',
    'private isSignatureData(',
    "const tmp: string = f + '.tmp';",
    'fs.renameSync(tmp, f)',
  ];
  for (const n of bridgeNeed) {
    if (!bridge.includes(n)) errs.push('DesktopBridge.ets 缺: ' + n);
  }
  // 渲染层契约：传 SignatureData、读 SavedSignature.data（桥侧返回结构必须一致）
  const dlg = readFileSync(resolve(root, 'apps/pdf/src/renderer/SignatureDialog.tsx'), 'utf8');
  for (const n of ['addSavedSignature(sig)', 's.data.kind', 's.id']) {
    if (!dlg.includes(n)) errs.push('SignatureDialog.tsx 缺: ' + n);
  }
  if (errs.length) throw new Error(errs.join('; '));
}
// fs 语义门禁：accessSync 在目标不存在时抛异常（不是返回 false）、openSync 无 CREATE
// 时新路径必抛 ENOENT —— 这两类错误会让首次新建/保存必然失败（真机已踩过）。
function checkFsSemantics() {
  const src = readFileSync(resolve(__dirname, '..', 'entry/src/main/ets/bridge/DesktopBridge.ets'), 'utf8');
  const errs = [];
  if (/while\s*\(\s*fs\.accessSync/.test(src)) {
    errs.push('禁止 while(fs.accessSync(...))：目标不存在时抛异常而非返回 false（用 nextFreePath）');
  }
  if (/openSync\([^)]*READ_WRITE(?![^)]*CREATE)[^)]*\)/.test(src)) {
    errs.push('openSync(READ_WRITE...) 必须带 CREATE：新建场景路径不存在会抛 ENOENT');
  }
  if (errs.length) throw new Error(errs.join('; '));
}

// M7-3 AI 图像/搜索链门禁：本地图片（sheets add_image）/ 网图下载 / 网搜 / 图搜。
// 真机症状：AI 面板一调 web_search/image_search 就 TypeError —— 旧 mock 返回 []，而渲染层消费
// {results|images, method}（r.results.forEach 当场崩）。这里把「形状 + 通道 + 降级」全部钉住。
function checkAiImageSearchChain() {
  const root = resolve(__dirname, '..', '..');
  const idx = readFileSync(resolve(__dirname, '..', 'entry/src/main/ets/pages/Index.ets'), 'utf8');
  const bridge = readFileSync(resolve(__dirname, '..', 'entry/src/main/ets/bridge/DesktopBridge.ets'), 'utf8');
  const errs = [];

  // ① 帧侧：四条通道都走 goJson（形状在 mock 层归一，渲染层无需 try/catch）
  for (const n of [
    "goJson('webSearchJson'",
    "goJson('imageSearchJson'",
    "goJson('fetchImageJson'",
    "goJson('readLocalImageJson'",
  ]) {
    if (!idx.includes(n)) errs.push('Index.ets 缺: ' + n);
  }
  // 旧坏形状（resolve([])）必须消失：渲染层 r.results.forEach / result.images.map 会 TypeError
  for (const dead of [
    'webSearch: function () { return Promise.resolve([]); }',
    'imageSearch: function () { return Promise.resolve([]); }',
  ]) {
    if (idx.includes(dead)) errs.push('Index.ets 仍是坏形状（必须是 {results|images, method}）: ' + dead);
  }
  // 桥不可用 → method:'error'（空形状会被读成"没有结果"，只有错误分支才提示可重试）
  for (const n of [
    "method: 'error', error: 'harmony: web search bridge unavailable'",
    "method: 'error', error: 'harmony: image search bridge unavailable'",
  ]) {
    if (!idx.includes(n)) errs.push('Index.ets 缺错误兜底形状: ' + n);
  }
  // readLocalImage：桌面失败是 reject（渲染层 catch 后提示），不能 resolve(undefined)
  if (!/readLocalImage: function \(req\)[\s\S]{0,400}Promise\.reject\(new Error\(/.test(idx)) {
    errs.push('Index.ets 的 readLocalImage 未把 {error} 转成 Promise.reject（渲染层靠 reject 提示失败）');
  }
  // 生图：批次 E 起是**真实现**（用户自备 Key 的 OpenAI 兼容 /images/generations），
  // 不再是 Genspark 云工具的降级桩 —— 锚点跟着换成实现侧，别退回断言"桩还在"。
  for (const n of [
    'function aiGenerateImage(op)',
    'function aiMediaEndpoint(cap)',
    "var url = ep.base + '/images/generations';",
    'function aiPickImagePayload(j)',
    'b64_json',
    'generateImage: aiGenerateImage,',
    'aiGenerateImage: aiGenerateImage,',
    'function aiAnalyzeMedia(op)',
    'analyzeMedia: aiAnalyzeMedia,',
  ]) {
    if (!idx.includes(n)) errs.push('Index.ets 缺生图/理解实现: ' + n);
  }
  if (idx.includes('aiGenerateImageUnavailable')) {
    errs.push('降级桩 aiGenerateImageUnavailable 未删净（生图已是真实现，留着会掩盖回归）');
  }
  // 生图入口靠「gskLoggedInRef 保持 false」隐藏（App.tsx:881 / docs AiPanel:483 都是
  // .then 赋值 + .catch(()=>{})，useRef 初值 false）。鸿蒙没有 Genspark 账号通道（AI 走 BYO Key），
  // aiGskStatus 按「通道不存在」reject：ref 同样保持 false，且不会再给 AI 失败回合挂一个
  // 点了没反应的「登录 Genspark」按钮 —— 旧的 resolve({loggedIn:false}) 正是让那个按钮出现的写法。
  const gskNoChannel = /aiGskStatus: function \(\) \{\s*return Promise\.reject\(new Error\('鸿蒙版没有 Genspark 账号通道/
  if (!gskNoChannel.test(idx)) {
    errs.push('Index.ets 的 aiGskStatus 必须按「无 Genspark 通道」reject（保持 gskLoggedInRef=false，且不给 AI 失败回合挂无效登录按钮）')
  }
  if (!/aiGskLogin: function \(\) \{\s*return Promise\.reject\(new Error\('鸿蒙版没有 Genspark 账号通道/.test(idx)) {
    errs.push('Index.ets 的 aiGskLogin 必须按「无 Genspark 通道」reject（留空 resolve 会让按钮点了静默无反应）')
  }

  // ② 桥侧：四个 case + 四个 async 方法（分发表方法必须 async，否则 checkBridgeRegistration 判红）
  for (const n of [
    "register('readLocalImageJson'",
    "register('fetchImageJson'",
    "register('webSearchJson'",
    "register('imageSearchJson'",
    'async readLocalImageJson(',
    'async fetchImageJson(',
    'async webSearchJson(',
    'async imageSearchJson(',
  ]) {
    if (!bridge.includes(n)) errs.push('DesktopBridge.ets 缺: ' + n);
  }
  // 本地图片：20MB 上限 + 魔术字节嗅探（只认 PNG/JPEG/GIF）+ 返回 {mediaType, base64}
  for (const n of [
    'const MAX_AI_IMAGE_BYTES: number = 20 * 1024 * 1024',
    'function sniffImageMediaType(',
    "return 'image/png';",
    "return 'image/jpeg';",
    "return 'image/gif';",
    'return JSON.stringify({ mediaType: mediaType, base64: b64 });',
    "'仅支持 PNG/JPEG/GIF 图片'",
    'interface AiWebSearchItem {',
    'interface AiImageSearchItem {',
    'interface AiHttpBytesReply {',
    'expectDataType: http.HttpDataType.ARRAY_BUFFER',
    'function parseSerperWebResults(',
    'function parseTavilyWebResults(',
    'function parseSerperImageResults(',
    'function parseAiSearchOpts(',
    'function hostOfUrl(',
    'gettyimages',
  ]) {
    if (!bridge.includes(n)) errs.push('DesktopBridge.ets 缺: ' + n);
  }
  // SSRF 静态守卫（桌面 safe-remote-url.ts 的本地子集）
  const guardStart = bridge.indexOf('function isPublicHttpTarget(');
  const guardBody = guardStart < 0 ? '' : bridge.slice(guardStart, guardStart + 1600);
  for (const n of ["'localhost'", "'127.'", "'192.168.'", "'169.254.'", "startsWith('10.')", '172.']) {
    if (!guardBody.includes(n)) errs.push('isPublicHttpTarget 缺拦截规则: ' + n);
  }
  // 网图下载：ARRAY_BUFFER 取字节 + 20MB 上限 + {base64, mime} | 'null'（渲染层自己嗅探 mime）
  const fetchStart = bridge.indexOf('async fetchImageJson(');
  const fetchEnd = bridge.indexOf('async webSearchJson(');
  const fetchBody = fetchStart < 0 || fetchEnd <= fetchStart ? '' : bridge.slice(fetchStart, fetchEnd);
  for (const n of [
    'if (!isPublicHttpTarget(target))',
    "mime: sniffed.length > 0 ? sniffed : 'image/jpeg'",
    "return 'null';",
    'size > MAX_AI_IMAGE_BYTES',
  ]) {
    if (!fetchBody.includes(n)) errs.push('fetchImageJson 缺: ' + n);
  }
  // 网搜/图搜：批次 E 起改成用户自填 Key 的正式 API（Serper 网搜+图搜 / Tavily 仅网搜）。
  // 旧的 DDG html/i.js 抓取属非官方端点（条款冲突 + 随反爬静默失效），不得回退。
  const searchStart = bridge.indexOf('async webSearchJson(');
  const searchBody = searchStart < 0 ? '' : bridge.slice(searchStart);
  for (const n of [
    "'https://api.tavily.com/search'",
    "'https://google.serper.dev/search'",
    "'https://google.serper.dev/images'",
    "'X-API-KEY'",
    "'Bearer '",
    "method: 'serper'",
    "method: 'tavily'",
    // Tavily 没有图片端点 → 图搜必须挡住（放了就会打不存在的 URL，表现为一直失败）
    "opts.provider !== 'serper'",
  ]) {
    if (!searchBody.includes(n)) errs.push('webSearchJson/imageSearchJson 缺: ' + n);
  }
  // 未配 Key 必须给 method:'error'（空结果会被读成"没有结果"，用户以为搜索坏了）。
  // 按**调用点数量**核对：方法定义自身也叫 searchKeyMissing(，全文 includes 判定会让
  // 「删掉网搜或图搜其中一处」逃过门禁（反例实测：断言没红）。
  const keyCalls = (searchBody.match(/this\.searchKeyMissing\(/g) || []).length;
  if (keyCalls < 2) {
    errs.push('searchKeyMissing 只被调用 ' + keyCalls + ' 次（网搜与图搜各一处，缺一处就静默空结果）');
  }
  // 图搜结果的版权域名黑名单（会直接插进文档）—— 判定在 parseSerperImageResults 里，
  // 不在 webSearchJson 段内，所以单独按函数体核对（挪到 searchBody 里查会变成假红）。
  const imgParseStart = bridge.indexOf('function parseSerperImageResults(');
  const imgParseBody = imgParseStart < 0 ? '' : bridge.slice(imgParseStart, imgParseStart + 1600);
  for (const n of ['AI_COPYRIGHT_HOSTS', 'copyrighted']) {
    if (!imgParseBody.includes(n)) errs.push('parseSerperImageResults 缺版权黑名单: ' + n);
  }
  if (imgParseStart < 0) errs.push('找不到 parseSerperImageResults（图搜黑名单过滤必须在解析侧）');

  // ③ 渲染层契约：上游消费点在，形状就必须是 {results|images, method} / {mediaType, base64} / {url?, error?}
  const api = readFileSync(resolve(root, 'apps/sheets/src/shared/desktop-api.ts'), 'utf8');
  for (const n of [
    'readLocalImage(request: LocalImageRequest): Promise<LocalImageResult>',
    'webSearch(query: string, maxResults?: number): Promise<WebSearchResult>',
    'imageSearch(query: string, maxResults?: number): Promise<ImageSearchResponse>',
    'generateImage(op: { prompt: string; aspectRatio?: string }): Promise<GenerateImageResult>',
    "mediaType: z.enum(['image/png', 'image/jpeg', 'image/gif'])",
  ]) {
    if (!api.includes(n)) errs.push('sheets desktop-api.ts 契约漂移: ' + n);
  }
  // 上游把 add_image 的本地/远端分支从 App.tsx 抽到 op-executor.ts（同一处理逻辑，
  // 变量名 structural.op → op）。锚点跟随新位置，能力仍必须接线。
  const sheetsOpExecutor = readFileSync(resolve(root, 'apps/sheets/src/renderer/op-executor.ts'), 'utf8');
  for (const n of ['window.desktopApi.readLocalImage({ path: op.path })',
    'window.desktopApi.fetchImage(op.path)']) {
    if (!sheetsOpExecutor.includes(n)) errs.push('sheets op-executor.ts 消费点漂移: ' + n);
  }
  const imgSkill = readFileSync(resolve(root, 'apps/sheets/src/renderer/ai/image-skill.ts'), 'utf8');
  for (const n of ['window.desktopApi.imageSearch(', 'window.desktopApi.generateImage(', 'result.images.map(',
    "result.method === 'error'"]) {
    if (!imgSkill.includes(n)) errs.push('sheets image-skill.ts 消费点漂移: ' + n);
  }
  const searchSkill = readFileSync(resolve(root, 'apps/sheets/src/renderer/ai/search-skill.ts'), 'utf8');
  for (const n of ['window.desktopApi.webSearch(', 'r.results.forEach', "r.method === 'error'"]) {
    if (!searchSkill.includes(n)) errs.push('sheets search-skill.ts 消费点漂移: ' + n);
  }
  const pdfApp = readFileSync(resolve(root, 'apps/pdf/src/renderer/App.tsx'), 'utf8');
  for (const n of ['window.pdfApi.fetchImage(url)', 'window.pdfApi.imageSearch(query, maxResults)',
    'window.pdfApi.generateImage(op)']) {
    if (!pdfApp.includes(n)) errs.push('pdf App.tsx 消费点漂移: ' + n);
  }
  const pdfTools = readFileSync(resolve(root, 'apps/pdf/src/renderer/ai/tools.ts'), 'utf8');
  for (const n of ['fetchImage(url: string): Promise<{ png: string; width: number; height: number } | null>',
    'const fetched = await deps.fetchImage(url)']) {
    if (!pdfTools.includes(n)) errs.push('pdf tools.ts 消费点漂移: ' + n);
  }
  const slidesPreload = readFileSync(resolve(root, 'apps/slides/src/preload/index.ts'), 'utf8');
  if (!slidesPreload.includes('imageSearch: (query: string, maxResults?: number)')) {
    errs.push('slides preload 的 imageSearch 桥名漂移（mock 的 imageSearch 键会失效）');
  }
  const mdPreload = readFileSync(resolve(root, 'apps/markdown/src/preload/index.ts'), 'utf8');
  for (const n of ['webSearch: (query, maxResults)', 'fetchImage: (url)', 'aiGenerateImage: (op']) {
    if (!mdPreload.includes(n)) errs.push('markdown preload 桥名漂移: ' + n);
  }
  const docsPreload = readFileSync(resolve(root, 'apps/docs/src/preload/index.ts'), 'utf8');
  for (const n of ['aiGenerateImage: (op', 'fetchImage: (url: string)', 'webSearch: (query: string']) {
    if (!docsPreload.includes(n)) errs.push('docs preload 桥名漂移: ' + n);
  }
  if (errs.length) throw new Error(errs.join('; '));
}

// M7-4 sheets 崩溃恢复门禁：恢复副本落盘（writeWorkbookRecovery 不再是桩）+ 打开时的
// 「发现自动恢复版本」提问链（桥 needsRecovery → 渲染层对话框 → reply 回答 → 真正打开）。
// 真机症状对照：桌面每 30s 写 userData/sheets-autosave，壳里 writeWorkbookRecovery 曾长期是
// `Promise.resolve({ ok: true })` 桩 —— 看着"成功"，实际从不产生副本，强杀后必丢未保存编辑。
function checkSheetsRecoveryPrompt() {
  const root = resolve(__dirname, '..', '..');
  const idx = readFileSync(resolve(__dirname, '..', 'entry/src/main/ets/pages/Index.ets'), 'utf8');
  const bridge = readFileSync(resolve(__dirname, '..', 'entry/src/main/ets/bridge/DesktopBridge.ets'), 'utf8');
  const errs = [];

  // ① 帧侧：恢复副本必须真走桥（旧的 {ok:true} 桩消失）
  if (idx.includes('writeWorkbookRecovery: function () { return Promise.resolve({ ok: true }); }')) {
    errs.push('Index.ets 的 writeWorkbookRecovery 仍是 {ok:true} 桩：恢复副本从不产生，强杀必丢编辑');
  }
  for (const n of [
    "goJson('xlsRecoveryWriteJson', [JSON.stringify(built.payload)])",
    'function buildSheetsSavePayload(request)',
    // 保存与恢复副本共用同一份归一化：两条路各自漂移会「保存能过、副本静默失败」
    'var built = buildSheetsSavePayload(request);',
    'saveWorkbookEdits: function (request) {',
  ]) {
    if (!idx.includes(n)) errs.push('Index.ets 缺: ' + n);
  }
  // 调用点计数：函数定义 1 + 保存/恢复副本各 1 = 3（漏掉任何一个 = 归一化不再共用）
  const buildCalls = idx.split('buildSheetsSavePayload(request)').length - 1;
  if (buildCalls !== 3) {
    errs.push(`buildSheetsSavePayload 调用点应为 3 处（定义 + 保存 + 恢复副本），实际 ${buildCalls}`);
  }
  // 恢复副本失败必须静默（绝不打断编辑），也不能 reject（renderer 只 .catch 一次）
  const wwrStart = idx.indexOf('writeWorkbookRecovery: function (request) {');
  const wwrEnd = idx.indexOf('autoRenameWorkbook: function');
  const wwrBody = wwrStart < 0 || wwrEnd <= wwrStart ? '' : idx.slice(wwrStart, wwrEnd);
  for (const n of ["return { ok: !!(r && r.ok === true) };", 'catch(function () { return { ok: false }; })']) {
    if (!wwrBody.includes(n)) errs.push('writeWorkbookRecovery 缺: ' + n);
  }

  // ② 帧侧：提问链的三件套（转发 / 回答 / 单飞），且必须是真实现
  for (const n of [
    'var frameRecoveryPromptFns = [];',
    'function askRecoveryPrompt(prompt) {',
    "onRecoveryPrompt: function (fn) { return registerFrameFn(frameRecoveryPromptFns, fn); },",
    'replyRecoveryPrompt: function (restore) {',
    "settleRecoveryPrompt(restore === true ? 'restore' : 'discard');",
    'function openSheetWithRecovery(p)',
    "goJson('xlsRecoveryResolveJson', [String(target || ''), String(choice)])",
  ]) {
    if (!idx.includes(n)) errs.push('Index.ets 缺: ' + n);
  }
  // replyRecoveryPrompt 写成 no-op → 提问永远挂起（打开卡住不报错）；一条 grep 拦住
  if (/replyRecoveryPrompt: function \(\) \{ return TOGGLE;\s*\}/.test(idx) ||
      /replyRecoveryPrompt: function \(restore\) \{ return NOOP; \}/.test(idx)) {
    errs.push('Index.ets 的 replyRecoveryPrompt 是 no-op：恢复提问会永远挂起');
  }
  // selectWorkbook 的打开分支必须经过提问包装（直接 goJson('xlsOpenJson') 会绕过恢复提问）
  const selStart = idx.indexOf('selectWorkbook: function () {');
  const selEnd = idx.indexOf('hasQueuedWorkbook: function ()');
  const selBody = selStart < 0 || selEnd <= selStart ? '' : idx.slice(selStart, selEnd);
  if (!selBody.includes('return openSheetWithRecovery(p);')) {
    errs.push('selectWorkbook 未走 openSheetWithRecovery：恢复提问被绕过');
  }
  // 没有渲染层订阅时必须立刻 'dismissed'（不能挂起；桌面此时走原生 messagebox 兜底）
  const askStart = idx.indexOf('function askRecoveryPrompt(prompt) {');
  const askBody = askStart < 0 ? '' : idx.slice(askStart, askStart + 1200);
  if (!askBody.includes("if (frameRecoveryPromptFns.length === 0 || !isRecoveryPromptPayload(prompt)) {\n        resolve('dismissed');")) {
    errs.push('askRecoveryPrompt 未在"无订阅/载荷非法"时立即 dismissed（会挂起打开）');
  }
  // payload 7 字段校验（与桌面 preload onRecoveryPrompt 一致：缺字段会让 RecoveryDialog 渲染 undefined）
  for (const n of ['function isRecoveryPromptPayload(p) {', "typeof p.restoreLabel !== 'string'",
    "typeof p.fileName !== 'string'", 'return Number.isFinite(p.savedAtMs);']) {
    if (!idx.includes(n)) errs.push('Index.ets 缺 payload 校验: ' + n);
  }

  // ③ 桥侧：两个 case + 四个方法 + 恢复副本落盘语义
  for (const n of [
    "register('xlsRecoveryWriteJson'",
    "register('xlsRecoveryResolveJson'",
    'async xlsRecoveryWriteJson(reqJson: string)',
    'async xlsRecoveryResolveJson(uri: string, choice: string)',
    'private async openSheetFromUri(openUri: string, restoreTarget: string, restoreStamp: string)',
    'private sheetsRecoveryDir(): string',
    'private sheetsRecoveryPath(uri: string): string',
    'private statUriStamp(uri: string): string',
    'private clearSheetsRecovery(uri: string): void',
    'private pendingSheetsRecovery(uri: string): string',
    "function sheetsRecoveryKey(uri: string): string",
    "this.ctx.filesDir + '/genoffice-sheets-recovery'",
    // 提问早于读字节：大文件不该白读一遍再发现要恢复
    'const pending: string = this.pendingSheetsRecovery(uri);',
    'needsRecovery: true,',
    // 恢复会话的写回目标 = 原文件（渲染层看到的 path 也是原文件）
    'restoredFromRecovery',
  ]) {
    if (!bridge.includes(n)) errs.push('DesktopBridge.ets 缺: ' + n);
  }
  // 恢复会话的磁盘守卫（桌面 restoreTargetSha 的内容哈希等价物）+ 保存后清副本
  for (const n of [
    'private sheetsRestoreTargets: Map<string, string>',
    'private sheetsRestoreStamps: Map<string, string>',
    'this.sheetsRestoreTargets.set(sid, restoreTarget);',
    'this.sheetsRestoreStamps.set(sid, restoreStamp);',
    "'工作簿在打开后被磁盘上的改动覆盖——请改用另存为。'",
    // 清副本必须接在"写回成功"这条路上：pendingSheetsRecovery 里也有一处
    // clearSheetsRecovery（清理陈旧副本），只 grep 名字会把这两种语义混起来
    'this.clearSheetsRecovery(newUri);',
  ]) {
    if (!bridge.includes(n)) errs.push('DesktopBridge.ets 缺守卫/清理: ' + n);
  }
  if (!/this\.clearSheetsRecovery\(uri\);[\s\S]{0,200}this\.sheetsRestoreTargets\.delete\(sessionId\);/.test(bridge)) {
    errs.push('xlsSaveEditsJson 写回成功后未清恢复副本（副本残留 → 每次打开都问"要恢复吗"）');
  }
  // 恢复会话不写自己的恢复副本（会写坏正在流的源文件 —— 桌面同样 stand down）
  const recWriteStart = bridge.indexOf('async xlsRecoveryWriteJson(reqJson: string)');
  const recWriteEnd = bridge.indexOf('private async openSheetFromUri(');
  const recWriteBody = recWriteStart < 0 || recWriteEnd <= recWriteStart ? '' : bridge.slice(recWriteStart, recWriteEnd);
  if (!recWriteBody.includes('this.sheetsRestoreTargets.has(sessionId)')) {
    errs.push('xlsRecoveryWriteJson 未对恢复会话 stand down（会覆盖 sidecar 正在流的源文件）');
  }
  if (!recWriteBody.includes('this.xlsxSidecar.close(newSessionId)')) {
    errs.push('xlsRecoveryWriteJson 未释放临时快照会话（每 30s 泄漏一个引擎会话）');
  }
  // 桥侧也要认 'dismissed'（保留副本 + 打开原文件），不能只认 restore/discard
  if (!/xlsRecoveryResolveJson[\s\S]{0,900}this\.clearSheetsRecovery\(target\);/.test(bridge)) {
    errs.push('xlsRecoveryResolveJson 未实现 discard 分支');
  }

  // ④ 渲染层契约：消费点漂移会让这条链静默断（dialog 不出现 = 用户直接进原文件）
  const appTsx = readFileSync(resolve(root, 'apps/sheets/src/renderer/App.tsx'), 'utf8');
  for (const n of ['onRecoveryPrompt?.(', 'window.desktopApi?.replyRecoveryPrompt?.(restore)',
    '<RecoveryDialog']) {
    if (!appTsx.includes(n)) errs.push('sheets App.tsx 消费点漂移: ' + n);
  }
  const preload = readFileSync(resolve(root, 'apps/sheets/src/preload/index.ts'), 'utf8');
  for (const n of ['onRecoveryPrompt(callback)', 'replyRecoveryPrompt(restore)',
    'typeof payload.savedAtMs === \'number\'']) {
    if (!preload.includes(n)) errs.push('sheets preload 契约漂移: ' + n);
  }
  const main = readFileSync(resolve(root, 'apps/sheets/src/main/sheets-main.ts'), 'utf8');
  for (const n of ['function pendingRecoveryFor(filePath: string): string | null',
    "settle('dismissed')", '? await promptRecoveryRestore(contents, path, recovery)',
    "if (choice === 'discard') clearWorkbookRecovery(path)"]) {
    if (!main.includes(n)) errs.push('sheets sheets-main.ts 恢复链漂移: ' + n);
  }
  if (errs.length) throw new Error(errs.join('; '));
}

// 上架元数据门禁（BETA/市场内测前置）：版本三处一致 + 图标已换成真实素材 + 市场可见文案/权限理由就位。
// 症状对照：versionName 与 app 内显示不一致（用户报版本号对不上）、图标是 258B 占位图
// （DevEco 模板默认 → 桌面/市场显示空图）、versionCode 缺失会被市场直接拒。
function checkReleaseMetadata() {
  const appDir = resolve(__dirname, '..');
  const errs = [];

  // ① 版本三处一致：AppScope/app.json5 ↔ DesktopBridge.APP_VERSION ↔ Index.ets SHELL_APP_VERSION
  const appJson = readFileSync(resolve(appDir, 'AppScope/app.json5'), 'utf8');
  const vn = (appJson.match(/"versionName"\s*:\s*"([^"]+)"/) || [])[1];
  const vc = (appJson.match(/"versionCode"\s*:\s*(\d+)/) || [])[1];
  if (!vn) errs.push('AppScope/app.json5 缺 versionName');
  if (!vc || Number(vc) < 1) errs.push('AppScope/app.json5 缺 versionCode（或 < 1，市场会拒）');
  const bridge = readFileSync(resolve(appDir, 'entry/src/main/ets/bridge/DesktopBridge.ets'), 'utf8');
  const bv = (bridge.match(/export const APP_VERSION: string = '([^']+)'/) || [])[1];
  const idx = readFileSync(resolve(appDir, 'entry/src/main/ets/pages/Index.ets'), 'utf8');
  const sv = (idx.match(/var SHELL_APP_VERSION = '([^']+)'/) || [])[1];
  if (!bv) errs.push('DesktopBridge.ets 缺 export const APP_VERSION');
  if (!sv) errs.push('Index.ets 缺 var SHELL_APP_VERSION');
  if (vn && bv && vn !== bv) errs.push(`版本号不一致: app.json5=${vn} vs APP_VERSION=${bv}`);
  if (vn && sv && vn !== sv) errs.push(`版本号不一致: app.json5=${vn} vs SHELL_APP_VERSION=${sv}`);
  if (!bridge.includes('return APP_VERSION;')) errs.push('DesktopBridge.version() 未返回 APP_VERSION');
  if (!idx.includes('getAppVersion: function () { return Promise.resolve(SHELL_APP_VERSION); }')) {
    errs.push('aiOffice.getAppVersion 未用 SHELL_APP_VERSION（设置页版本与市场不一致）');
  }
  // 旧硬编码版本禁止复活（'0.1.0-m3' 曾长期挂在桥、'1.0.0-harmony' 在设置页）
  if (bridge.includes("'0.1.0-m3'")) errs.push("DesktopBridge.ets 残留旧版本字面量 '0.1.0-m3'");
  if (idx.includes("'1.0.0-harmony'")) errs.push("Index.ets 残留旧版本字面量 '1.0.0-harmony'");

  // ② 图标：必须是真实素材（模板占位图 258B），尺寸够桌面/市场用
  const pngDims = (p) => {
    const head = readFileSync(p);
    if (head.length < 24 || head[0] !== 0x89 || head.toString('latin1', 1, 4) !== 'PNG') return null;
    return { w: head.readUInt32BE(16), h: head.readUInt32BE(20), bytes: head.length };
  };
  for (const rel of ['AppScope/resources/base/media/app_icon.png',
    'entry/src/main/resources/base/media/app_icon.png',
    'entry/src/main/resources/base/media/start_icon.png']) {
    const dim = pngDims(resolve(appDir, rel));
    if (!dim) { errs.push(rel + ' 不是 PNG（或缺失）'); continue; }
    if (dim.bytes < 2048) errs.push(rel + ' 还是 DevEco 占位图（' + dim.bytes + 'B）');
    if (dim.w < 216 || dim.h < 216) errs.push(rel + ' 尺寸过小（' + dim.w + 'x' + dim.h + '，建议 ≥216）');
  }

  // ③ 市场可见信息：应用名 + ability 图标/启动图引用 + 权限理由（审核会看）
  const appStr = readFileSync(resolve(appDir, 'AppScope/resources/base/element/string.json'), 'utf8');
  if (!appStr.includes('"name": "app_name"') || !appStr.includes('"value": "GenOffice"')) {
    errs.push('AppScope string.json 缺 app_name=GenOffice（市场显示名）');
  }
  const modJson = readFileSync(resolve(appDir, 'entry/src/main/module.json5'), 'utf8');
  for (const n of ['"icon": "$media:app_icon"', '"startWindowIcon": "$media:start_icon"']) {
    if (!modJson.includes(n)) errs.push('module.json5 缺 ' + n);
  }
  const modStr = readFileSync(resolve(appDir, 'entry/src/main/resources/base/element/string.json'), 'utf8');
  for (const n of ['read_pasteboard_reason', 'file_access_persist_reason']) {
    if (!modStr.includes(n)) errs.push('权限理由字符串缺 ' + n + '（市场审核要求）');
  }
  if (errs.length) throw new Error(errs.join('; '));
}

// 壳菜单处理函数门禁：菜单项 onClick 里直接调用的函数必须有定义。
// 历史事故：「反馈 / 报告 Bug」引用从未实现的 dialogFeedback → 点击抛 ReferenceError，
// 界面表现为"点了没反应"（同类死菜单反复出现：PDF 打印/导出图片/属性）。同时锁住反馈框
// 必须提供的三件套（版本号 + 反馈路径 + 日志命令），否则内测反馈收不回来。
function checkShellMenuHandlers() {
  const root = resolve(__dirname, '..', '..');
  const idx = readFileSync(resolve(root, 'harmony/entry/src/main/ets/pages/Index.ets'), 'utf8');
  const errs = [];
  const calls = new Set();
  const re = /onClick: function \(\) \{\s*([A-Za-z_$][A-Za-z0-9_$]*)\(/g;
  let m;
  while ((m = re.exec(idx))) calls.add(m[1]);
  if (calls.size === 0) errs.push('未解析到菜单 onClick 处理函数（正则失效？门禁会假绿）');
  for (const name of calls) {
    if (!idx.includes('function ' + name + '(')) {
      errs.push('菜单 onClick 调用了未定义函数 ' + name + '()（点击必抛 ReferenceError）');
    }
  }
  if (!idx.includes("{ label: '关于 / 反馈', onClick: function () { dialogFeedback(); } }")) {
    errs.push('起始页菜单缺「关于 / 反馈」项');
  }
  for (const n of ['function dialogFeedback()', 'function shellDiagnosticText()',
    "'GenOffice 版本: ' + SHELL_APP_VERSION", "'平台: HarmonyOS (ArkWeb 壳)'",
    '内测应用', 'hdc hilog']) {
    if (!idx.includes(n)) errs.push('反馈对话框缺: ' + n);
  }
  // 复制兜底三件必须**在 dialogFeedback 体内**核对：「开源许可」框（批次 E）也有一份同样的
  // 兜底代码，全文 includes 判定会让「只删反馈框那份」逃过门禁（同 wrapShellBridge 的教训）。
  const dfStart = idx.indexOf('function dialogFeedback() {');
  if (dfStart < 0) {
    errs.push('找不到 function dialogFeedback() {');
  } else {
    const dfBody = idx.slice(dfStart, idx.indexOf('\n  }', dfStart));
    for (const n of ['navigator.clipboard', 'nb.writeClipboardText(t)',
      // 「复制」按钮：没有它测试者只能手抄诊断块（长文本手抄必丢字段）
      "var copy = mkBtn('复制', true);"]) {
      if (!dfBody.includes(n)) errs.push('反馈对话框缺: ' + n);
    }
  }
  // 「开源许可」菜单项 + 处理器：许可文本随包但入口不可见 = 等于没履行（AGC 也会问）
  if (!idx.includes("{ label: '开源许可', onClick: function () { dialogLegal(); } }")) {
    errs.push('起始页菜单缺「开源许可」项');
  }
  const dlStart = idx.indexOf('function dialogLegal() {');
  if (dlStart < 0) {
    errs.push('找不到 function dialogLegal() {（菜单项会点了没反应）');
  } else {
    const dlBody = idx.slice(dlStart, idx.indexOf('\n  }', dlStart));
    for (const n of ['NOTICE.txt', 'THIRD-PARTY-NOTICES.txt', 'CHANGELOG-NOTICE.txt', 'LICENSE.txt']) {
      if (!idx.includes(n)) errs.push('开源许可对话框未引用 ' + n);
    }
    if (!dlBody.includes("legalLoad('NOTICE.txt')") || !dlBody.includes("legalLoad('THIRD-PARTY-NOTICES.txt')")) {
      errs.push('dialogLegal 未通过 legalLoad 读取包内文本（改成硬编码字符串会与包内文件漂移）');
    }
  }
  // 读取通道：rawfile 路径 + 失败要给出包内位置（不能白屏/空框）
  const llStart = idx.indexOf('function legalLoad(name) {');
  if (llStart < 0) {
    errs.push('找不到 function legalLoad(name) {');
  } else if (!idx.slice(llStart, llStart + 700).includes('resource://rawfile/web/legal/')) {
    errs.push('legalLoad 未从 rawfile/web/legal 读取');
  }
  if (errs.length) throw new Error(errs.join('; '));
}

// ArkTS 语义规则门禁（本机无 ArkTS 编译器 → 这类错只在 DevEco 构建时才炸，代价一整轮构建）：
//   ① arkts-no-untyped-obj-literals：对象/数组字面量必须落到已声明的 class/interface/Record。
//      历史事故：xlsOpenJson 的恢复提问写成嵌套字面量 `prompt: { ... }` → DevEco 报
//      「Object literal must correspond to some explicitly declared class or interface」→ 整包构建失败
//      （当时本地四连门禁全绿，一行都没拦住）。
//   ② arkts-no-any-unknown：禁 any/unknown 类型标注（用 Record<string, Object> 或具体类型）。
// 只扫真实 ArkTS 代码：Index.ets 里的 PROMISE_SHIM / SHELL_BRIDGE / ERR_COLLECTOR 是被注入执行的
// JS 字符串（`const X = ` 起、独占一行的 `; 止），不受 ArkTS 规则约束，按模板区间遮蔽。
function checkArktsSemantics() {
  const etsDir = resolve(__dirname, '..', 'entry/src/main/ets');
  const files = [];
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = resolve(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.ets')) files.push(p);
    }
  };
  walk(etsDir);
  if (files.length === 0) throw new Error('未找到 .ets 源文件（门禁会假绿）');
  const errs = [];
  let scanned = 0;
  for (const f of files) {
    const rel = f.slice(f.lastIndexOf('/ets/') + 1);
    const src = readFileSync(f, 'utf8');
    // 转义感知模板遮蔽：找到 `const NAME = \`` 后逐字符扫描到闭引号（处理 \\ 转义），
    // 整个区间替换为空行（保持行号对齐）。回填后开引号可能不独占行尾（内容紧跟），
    // 旧的行级正则 `/^const XXX = $/` 会失配 → 模板内部 JS 被当作 ArkTS 扫描 → 误报。
    const lines = src.split('\n');
    const tplRe = /(?:const|let|var)\s+[A-Za-z0-9_$]+\s*(:\s*string)?\s*=\s*`/g;
    let tm;
    while ((tm = tplRe.exec(src)) !== null) {
      let i = tm.index + tm[0].length;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '`') break;
        i++;
      }
      if (i >= src.length) break;
      const startLine = src.slice(0, tm.index).split('\n').length - 1;
      const endLine = src.slice(0, i).split('\n').length - 1;
      for (let k = startLine; k <= endLine && k < lines.length; k++) lines[k] = '';
    }
    lines.forEach((line, i) => {
      const t = line.trim();
      if (!t || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
      scanned++;
      const at = rel + ':' + (i + 1);
      if (/^[A-Za-z_$][A-Za-z0-9_$]*\s*:\s*\{\s*$/.test(t)) {
        errs.push(at + ' 无类型嵌套对象字面量：改用 Record<string, Object> 或先声明 interface');
      }
      if (/^(const|let|var)\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*(\{|\[\{?)\s*$/.test(t)) {
        errs.push(at + ' 无类型声明直接吃字面量：先声明类型再赋值');
      }
      if (/:\s*(any|unknown)\b/.test(t)) {
        errs.push(at + ' 出现 any/unknown 类型');
      }
    });
  }
  // 遮蔽写错（模板起点/终点没匹配上）会让真 ArkTS 行全被跳过 → 门禁假绿
  if (scanned < 200) errs.push('扫描到的 ArkTS 行数仅 ' + scanned + '（模板遮蔽异常，门禁会假绿）');

  // ── @Concurrent 的引用范围（es2abc 规则；本机没有 ArkTS 编译器，这类错只在 DevEco 构建时才炸）──
  // 真机代价是整包 CompileArkTS FAILED +「Concurrent function should only use import variable
  // or local variable」，白吃一轮构建（批次 E-2 踩过：并发读字节的函数里顺手复用了同文件的
  // 模块级 readFailText）。这里拦整类问题：@Concurrent 函数体内不得调用本文件声明的其它模块级函数。
  let concSeen = 0;
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    if (!src.includes('@Concurrent')) { continue; }
    const rel2 = f.slice(f.lastIndexOf('/ets/') + 1);
    const modFns = [];
    for (const m of src.matchAll(/^function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/gm)) { modFns.push(m[1]); }
    const ls = src.split('\n');
    for (let i = 0; i < ls.length; i++) {
      if (!/^\s*@Concurrent\s*$/.test(ls[i])) { continue; }
      let j = i + 1;
      while (j < ls.length && !/^\s*(export\s+)?function\s+/.test(ls[j])) { j++; }
      if (j >= ls.length) { continue; }
      const nm = /function\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(ls[j]);
      if (!nm) { continue; }
      concSeen++;
      let k = j + 1;
      while (k < ls.length && !/^\}/.test(ls[k])) { k++; }
      // 剥掉注释行：文档里常写「这里不能复用 xxx()」，不剥会误报
      const body = ls.slice(j + 1, k).filter((l) => {
        const t = l.trim();
        return !(t === '' || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*'));
      }).join('\n');
      for (const fn of modFns) {
        if (fn === nm[1]) { continue; }
        if (body.includes(fn + '(')) {
          errs.push(rel2 + ' @Concurrent ' + nm[1] + '() 调用了本文件的模块级函数 ' + fn
            + '() → es2abc 会拒绝（并发函数只能用 import 变量或局部变量）；请把逻辑内联，或把该函数移进被 import 的模块');
        }
      }
    }
  }
  if (concSeen === 0) errs.push('未扫到任何 @Concurrent 函数（taskpool 用法变了？这条断言会假绿）');

  if (errs.length) throw new Error(errs.join('; '));
}

// 发布包名一致性门禁：bundleName 必须与发布 Profile 里的 bundle-name 一致。
// 历史事故：AGC 应用包名是 com.genoffice.app，工程还是 com.bolanmoda.genoffice，
// 拿这份 Profile 签名会被拒（profile 与 bundleName 不匹配），而 AGC 侧包名创建后不可改。
// 同时锁住发布三件套（证书链 / 密钥库 / Profile）都在 key_csr/ 里 —— 材料丢了也是上架阻塞。
function checkBundleNameAlignment() {
  const root = resolve(__dirname, '..');
  const errs = [];
  const app5 = readFileSync(resolve(root, 'AppScope/app.json5'), 'utf8');
  const m = /"bundleName"\s*:\s*"([^"]+)"/.exec(app5);
  if (!m) { errs.push('AppScope/app.json5 里读不到 bundleName（门禁会假绿）'); throw new Error(errs.join('; ')); }
  const bundle = m[1];
  if (bundle === 'com.bolanmoda.genoffice') {
    errs.push('bundleName 退回旧值 com.bolanmoda.genoffice：与 AGC 应用（com.genoffice.app）不一致，签名会被拒');
  }
  const material = {
    'key_csr/genoffice.cer': '发布证书链',
    'key_csr/GenOffice.p12': '密钥库（含私钥）',
    'key_csr/GenOfficeRelease.p7b': '发布 Profile',
  };
  for (const [rel, what] of Object.entries(material)) {
    try {
      const buf = readFileSync(resolve(root, rel));
      if (!buf || buf.length < 64) errs.push('发布材料 ' + rel + '（' + what + '）内容为空/被截断');
    } catch (e) {
      errs.push('发布材料缺失 ' + rel + '（' + what + '）：无法打 release 包');
    }
  }
  let prof = '';
  try { prof = readFileSync(resolve(root, 'key_csr/GenOfficeRelease.p7b')).toString('latin1'); } catch (e) { prof = ''; }
  const pm = /"bundle-name":"([^"]+)"/.exec(prof);
  if (!pm) {
    errs.push('发布 Profile 里读不到 bundle-name（文件损坏或是调试 Profile）');
  } else {
    if (/"type":"debug"/.test(prof)) errs.push('发布 Profile 是调试 Profile（type:debug）：市场会拒收，且只对白名单设备有效');
    if (!/"type":"release"/.test(prof)) errs.push('发布 Profile 缺 type:release 标记');
    if (pm[1] !== bundle) {
      errs.push('包名不一致：app.json5=' + bundle + ' vs 发布 Profile=' + pm[1] + '（签名必失败）');
    }
  }
  if (errs.length) throw new Error(errs.join('; '));
}

// release 调试开关门禁：ArkWeb 调试开关（DevTools/chrome://inspect）必须按构建类型派生。
// 历史事故：setWebDebuggingAccess(true) 硬编码常开 —— 调试开关不随构建类型收敛，release 包
// 同样对外暴露页面可被 DevTools 检查（安全隐患 + 上架审核风险），而本机没有 ArkTS 编译器，
// 这类改动只能在 DevEco 构建时才发现（代价一整轮构建）。
function checkReleaseDebuggingSwitch() {
  const etsDir = resolve(__dirname, '..', 'entry/src/main/ets');
  const errs = [];
  const files = [];
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = resolve(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.ets')) files.push(p);
    }
  };
  walk(etsDir);
  if (files.length === 0) throw new Error('未找到 .ets 源文件（门禁会假绿）');
  const sites = [];
  for (const f of files) {
    const rel = f.slice(f.lastIndexOf('/ets/') + 1);
    const src = readFileSync(f, 'utf8');
    const re = /setWebDebuggingAccess\s*\(\s*([^)]*?)\s*\)/g;
    let m;
    while ((m = re.exec(src))) sites.push({ rel, arg: m[1], src });
  }
  if (sites.length === 0) {
    errs.push('未找到 setWebDebuggingAccess(...) 调用（门禁会假绿：开关被删或改了签名）');
  }
  for (const s of sites) {
    if (/^(true|false)$/.test(s.arg)) {
      errs.push(s.rel + ' setWebDebuggingAccess(' + s.arg + ')：开关不得写死，须由 ApplicationInfo.debug 派生');
    }
  }
  if (!sites.some((s) => s.src.includes('applicationInfo.debug'))) {
    errs.push('未见 applicationInfo.debug：无法证明 release 包会关闭 ArkWeb 调试开关');
  }
  if (errs.length) throw new Error(errs.join('; '));
}

// 签名配置卫生门禁（**模式感知**）。本仓有两套签名材料，而同一份 build-profile.json5 只能挂一套：
//   · 发布态：key_csr/ 三件套（genoffice.cer + GenOffice.p12 别名 genoffice + GenOfficeRelease.p7b）
//     → 上传 AGC 用。发布 Profile 里没有 device-ids / debug-info（实测 NOT FOUND），所以本地
//     bm install 必被拒：9568322 signature verification failed due to not trusted app source。
//   · 调试态：DevEco「Automatically generate signature」写的自动签名材料
//     （Documents/ohos/config/… + 别名 debugKey，Profile 内含本机 UDID）→ 本地装机验证唯一可行路径。
// 所以「文件里出现调试材料」不是错误，而是一种合法工作态。真正必须拦的是：
//   ① 明文口令进仓库（hvigor 也会以 00303116 拒掉构建：The length of the storePassword or
//      keyPassword field in the signature configuration is less than 32）
//   ② 发布态下 keyAlias 不是密钥库内真实别名（历史事故：SignHap 报 KEYSTORE_PASSWORD_ERROR -115，
//      报错文本指着口令，实际是别名在库中不存在）
//   ③ 同一套配置里混用发布材料与调试材料（DevEco 回写串味 → 签出的包类型不可预期，市场拒收）
//   ④ key_csr/ 三件套丢失（发布路径不可恢复）
//   ⑤ 材料既不是发布三件套也不是自动签名目录（半改状态）
// 上传前的权威判定是 check-release-package.mjs（读产物容器签名：type=release +
// distribution-certificate），本门禁只做配置层前置提醒 —— 故调试态返回 Note 而不报红。
function checkSigningConfigHygiene() {
  const src = readFileSync(resolve(__dirname, '..', 'build-profile.json5'), 'utf8');
  if (!/"signingConfigs"/.test(src)) {
    throw new Error('build-profile.json5 缺 signingConfigs 字段（门禁会假绿）');
  }
  const errs = [];
  // ① 口令字段：两种模式都只能是 DevEco 密文（00000020+hex，≥32 字符）或留空
  const re = /"(storePassword|keyPassword)"\s*:\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const val = m[2];
    if (val === '') continue;
    if (!/^[0-9A-Fa-f]{32,}$/.test(val)) {
      errs.push(m[1] + ' 不是 DevEco 密文（长度 ' + val.length + '）：hvigor 会报 00303116 / -115，且明文口令不该进仓库');
    }
  }
  // 结构化解析：判定 default 产品实际引用哪套材料 —— 不能整文件 grep，那样无法区分
  // 「合法调试态」与「发布配置被调试材料污染」。去注释后 JSON.parse；解析失败退回正则，
  // 但把「解析失败」本身记为错误，避免门禁静默降级成弱检查。
  let plain = '';
  let inStr = false; let q = ''; let inLine = false; let inBlock = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (inLine) { if (c === '\n') { inLine = false; plain += c; } continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++; } continue; }
    if (inStr) {
      plain += c;
      if (c === '\\') { plain += (n === undefined ? '' : n); i++; } else if (c === q) { inStr = false; }
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; q = c; plain += c; continue; }
    if (c === '/' && n === '/') { inLine = true; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    plain += c;
  }
  let storeFile = ''; let profileFile = ''; let certPath = ''; let alias = ''; let sigName = '';
  let parsed = false;
  try {
    const cfg = JSON.parse(plain);
    const products = (cfg && cfg.app && Array.isArray(cfg.app.products)) ? cfg.app.products : [];
    const prod = products.filter((p) => p && p.name === 'default')[0] || products[0];
    sigName = (prod && prod.signingConfig) || '';
    const sigs = (cfg && cfg.app && Array.isArray(cfg.app.signingConfigs)) ? cfg.app.signingConfigs : [];
    const sig = sigs.filter((s) => s && s.name === sigName)[0];
    const mat = (sig && sig.material) || {};
    storeFile = String(mat.storeFile || '');
    profileFile = String(mat.profile || '');
    certPath = String(mat.certpath || '');
    alias = String(mat.keyAlias || '');
    parsed = true;
  } catch (e) {
    const ms = /"storeFile"\s*:\s*"([^"]*)"/.exec(src); storeFile = ms ? ms[1] : '';
    const mp = /"profile"\s*:\s*"([^"]*)"/.exec(src); profileFile = mp ? mp[1] : '';
    const mc = /"certpath"\s*:\s*"([^"]*)"/.exec(src); certPath = mc ? mc[1] : '';
    const ma = /"keyAlias"\s*:\s*"([^"]*)"/.exec(src); alias = ma ? ma[1] : '';
  }
  if (!parsed) errs.push('build-profile.json5 无法按 JSON 解析：门禁降级为正则检查，请核对文件语法');

  const blob = storeFile + '|' + profileFile + '|' + certPath;
  const hasRelease = /key_csr\/GenOffice\.p12/.test(storeFile) || /key_csr\/GenOfficeRelease\.p7b/.test(profileFile);
  const hasDebug = /Documents\/ohos\/config\//.test(blob) || alias === 'debugKey';
  // 发布三件套必须始终在盘上：调试态下也要能一条 git checkout 回到发布态
  const keyCsr = resolve(__dirname, '..', 'key_csr');
  const missing = ['genoffice.cer', 'GenOffice.p12', 'GenOfficeRelease.p7b']
    .filter((f) => !existsSync(resolve(keyCsr, f)));
  if (missing.length > 0) {
    errs.push('key_csr/ 发布三件套缺失：' + missing.join(', ') + '（发布路径不可恢复，AGC 上传会卡在签名）');
  }
  if (hasRelease && hasDebug) {
    errs.push('同一套签名配置混用发布材料与调试材料（DevEco 回写串味）：'
      + [storeFile, profileFile, certPath, alias].join(' , ')
      + ' → 签出的包类型不可预期；git checkout -- harmony/build-profile.json5 还原后重选');
  } else if (hasRelease) {
    if (alias !== 'genoffice') {
      errs.push('发布态 keyAlias 应为 genoffice（key_csr/GenOffice.p12 内唯一别名，keytool -list 实测），当前为 '
        + (alias || '(空)') + '：SignHap 会报 KEYSTORE_PASSWORD_ERROR -115（报错文本指口令，实为别名不存在）');
    }
  } else if (!hasDebug) {
    errs.push('签名材料既不是 key_csr 发布三件套、也不是 DevEco 自动签名目录（半改状态）：storeFile='
      + (storeFile || '(空)') + ' profile=' + (profileFile || '(空)') + ' alias=' + (alias || '(空)'));
  }
  if (errs.length) throw new Error(errs.join('; '));
  return hasRelease
    ? '签名态：release（key_csr 三件套 + 别名 ' + alias + '）→ 可打 AGC 包；⚠️ 本地 bm install 会被拒'
      + '（发布 Profile 无 device-ids，报 9568322 not trusted app source）→ 装机验证需切 DevEco 自动签名'
    : '签名态：debug（DevEco 自动签名' + (sigName ? '，config=' + sigName : '') + '）→ 本地装机可用；'
      + '⚠️ 上传 AGC 前必须 git checkout -- harmony/build-profile.json5 还原发布签名 + 重打 release 包'
      + ' + node scripts/check-release-package.mjs 六项全绿';
}

// 桥覆盖门禁（批次 B）：渲染层调了、壳侧（Index.ets mock / bridge/*.ets）没实现的方法。
// 为什么必须单独立门禁：makeBridge 的 Proxy 对未实现方法**静默** resolve(undefined)，
// 用户侧症状就是「点了没反应 / 白屏 / 数据不刷新」；而 checkBridgeRegistration 只覆盖
// 反方向（native→壳侧注册），这一侧过去是盲区（审计里 134 个方法 / 192 个 UI 调用点）。
// 白名单 scripts/bridge-coverage-allowlist.json：修一个删一条（过期也报红），budget 只减不增。
// 反例自测：node scripts/self-test-bridge-coverage.mjs
/**
 * 桥方法返回值形状风险（批次 E 系统性扫描的常驻版）。走**子进程调同一个脚本**，
 * 不在这里复制一份判定 —— 两份实现必然漂移（extract-bridge-methods 与门禁正则就是前车之鉴）。
 * 预算在 bridge-coverage-allowlist.json 的 risk-budget，只减不增；要扩容必须显式 --rebase，
 * 于是 git diff 里看得见「又欠了 N 条崩溃风险」。
 */
function checkBridgeShapeRisk() {
  const r = spawnSync(process.execPath, [resolve(__dirname, 'scan-bridge-shapes.mjs'), '--check'], { encoding: 'utf8' });
  if (r.status !== 0) {
    const out = ((r.stdout || '') + ' ' + (r.stderr || '')).trim().replace(/\s+/g, ' ');
    throw new Error('解引用风险超预算 → ' + out.slice(0, 300));
  }
  return (r.stdout || '').trim().split('\n').pop();
}

function checkBridgeCoverage() {
  const r = runBridgeCoverageCheck({});
  if (r.errors.length) throw new Error(r.errors.slice(0, 12).join(' | '));
  const sub = r.gaps.filter((g) => g.kind === 'subscribe').length;
  return '缺口 ' + r.gaps.length + ' 方法 / ' + r.sum.sites + ' UI 调用点（on* 订阅 ' + sub +
    '，解引用风险 ' + r.sum.riskMethods + '）· 白名单 ' + r.judge.count + '/' + r.judge.budget;
}

// 文档-实现一致性门禁（批次 C，M8-FULL-AUDIT §5 / §6.2-1）：
// 134 个「入口在、壳内没实现」的缺口过去在任何用户可见文档里都没有说明 —— BETA 用户点到
// 只会以为卡死，AGC 审核也会做功能一致性比对。补文档之后还要防漂移，故两处强约束：
//   ① BETA-CHECKLIST.md §4.1 的机器可读标记（BRIDGE-COVERAGE: total=… ns=…）必须与实时缺口数逐项一致
//      —— 数字只此一处来源，由 check-bridge-coverage.mjs --update 重写
//   ② BETA-RELEASE-NOTES.md「## 5. 已知限制」必须按 app 分组点名每个有缺口的编辑器
//      （PPT / Word / Markdown / 起始页 / PDF / Excel）—— 整段被删或漏一个 app 都报红
// 反例自测：node scripts/self-test-bridge-coverage.mjs（含标记数字改错 / 缺分组 / 文档读空）
function checkKnownLimitations() {
  const docRoot = resolve(__dirname, '..');
  if (!existsSync(resolve(docRoot, 'BETA-CHECKLIST.md')) && !existsSync(resolve(docRoot, 'BETA-RELEASE-NOTES.md'))) {
    return 'SKIP：本快照未包含 BETA 发布说明文档';
  }
  const d = runLimitsDocsCheck({});
  if (d.errors.length) throw new Error(d.errors.slice(0, 8).join(' | '));
  const named = Object.entries(d.counts.byNs).filter(([, n]) => n > 0).map(([ns, n]) => ns + '=' + n);
  return '已知限制文档与实现一致：total=' + d.counts.total + '（' + named.join(' ') + '）';
}

// markdown 图片链门禁（批次 D-3）：readImage / saveImageAs 的语义锚点。
// 为什么单独锁：这几条都属于「代码在、语义错」，跑起来看不出问题——
//   ① 读字节换成 openDocxPathJson：功能照常，但它成功时 pushRecent(uri) + 登记 writable
//      → 每读一张插图就往「最近打开」塞一个 .png（用户可见污染）；
//   ② 少了「必须落在文档目录内」的拒绝：相对路径能退到任意目录 → 任意文件读；
//   ③ 目录授权不做一次性限制：N 张图弹 N 次系统目录选择框；
//   ④ saveImageAs 失败不弹提示：渲染层是 void 调用（不看返回值）→ 又回到「点了没反应」。
function checkMarkdownImageChain() {
  const idx = readFileSync(resolve(__dirname, '..', 'entry/src/main/ets/pages/Index.ets'), 'utf8');
  const errs = [];
  const need = [
    "goJson('readLocalImageJson', [uri])",
    "if (s.charAt(0) === '/' || /^[a-z][a-z0-9+.-]*:/i.test(s)) { return null; }",
    // 越界拒绝有两处（.. 逐步回退时、归一化后），文本刻意不同 → 各自可锚定；
    // 写成同一句会让「只删一半」逃过门禁（本轮反例实测抓到过）
    'if (segs.length - 1 < baseDepth) { return null; }',
    'if (segs.length <= baseDepth) { return null; }',
    "var MARKDOWN_IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif' };",
    'if (!dir || markdownImgGrantDir === dir) { return null; }',
    "showFrameNotice('无法保存图片'",
    'var BS = String.fromCharCode(92);',
    'readImage: function (src) {',
  ];
  for (const n of need) if (!idx.includes(n)) errs.push('Index.ets 缺: ' + n);
  // 通道纯净性：readImageBytes 只能用 readLocalImageJson（不碰「最近打开」/可写登记）
  const s = idx.indexOf('function readImageBytes(uri) {');
  if (s < 0) {
    errs.push('未找到 readImageBytes（图片读字节入口）');
  } else {
    const body = idx.slice(s, idx.indexOf('\n  }', s));
    if (body.includes('openDocxPathJson')) {
      errs.push('readImageBytes 用了 openDocxPathJson：读图会把图片塞进「最近打开」并登记为可写');
    }
  }
  if (errs.length) throw new Error(errs.join('; '));
  return 'readImage/saveImageAs 语义锚点 ' + need.length + ' 条 + 读字节通道纯净';
}

// 外链产物一致性门禁（批次 D-4）：主 bundle 从「内联进 index.html」改成「指 goasset 别名外链」后，
// 三处必须对齐，任何一处漂移都是白屏级故障（不是降级）：
//   ① ASSET_ORIGIN 常量：inline-renderer.mjs 写进 HTML 的源 ↔ Index.ets onInterceptRequest 认的源
//   ② 外链白名单：sync-web.sh 的 EXTERNAL_APPS 默认值 ↔ rawfile 里实际产物形态
//   ③ 依赖 __goChunks 的 app（slides 的 pptx-bridge、pdf 的 nowasm fallback）不得外链 ——
//      外链模式不生成 base64 注册表，__goImport 会退回被 ArkWeb 拦掉的 fetch/XHR → 懒加载必失败
// 注：本函数同样被反例 harness 单函数抽取，不能调用其它顶层 helper。
function checkAssetExternalization() {
  const root = resolve(__dirname, '..', '..');
  const errs = [];
  const rendererSrc = readFileSync(resolve(__dirname, 'inline-renderer.mjs'), 'utf8');
  const idx = readFileSync(resolve(__dirname, '..', 'entry/src/main/ets/pages/Index.ets'), 'utf8');
  const syncSrc = readFileSync(resolve(__dirname, 'sync-web.sh'), 'utf8');

  // ① 源常量两边一致
  const mRenderer = /const ASSET_ORIGIN = '([^']+)'/.exec(rendererSrc);
  const mIdx = /const ASSET_ORIGIN: string = '([^']+)'/.exec(idx);
  if (!mRenderer) errs.push('inline-renderer.mjs 缺 ASSET_ORIGIN 常量');
  if (!mIdx) errs.push('Index.ets 缺 ASSET_ORIGIN 常量');
  if (mRenderer && mIdx && mRenderer[1] !== mIdx[1]) {
    errs.push('ASSET_ORIGIN 两边不一致：renderer=' + mRenderer[1] + ' vs Index.ets=' + mIdx[1] + '（外链脚本会 404 → 白屏）');
  }
  const origin = (mIdx && mIdx[1]) || '';
  const originHost = origin.replace(/\/$/, '');

  // ② 外链白名单：默认值必须存在，且不得包含依赖 __goChunks 的 app
  const mExt = /EXTERNAL_APPS="\$\{GO_EXTERNAL_APPS:-([^}]*)\}"/.exec(syncSrc);
  if (!mExt) {
    errs.push('sync-web.sh 缺 EXTERNAL_APPS 默认值（外链开关丢失 → 回退/启用都无从谈起）');
  }
  const externalApps = (mExt ? mExt[1] : '').split(/\s+/).filter(Boolean);
  for (const banned of ['slides', 'pdf']) {
    if (externalApps.includes(banned)) {
      errs.push('EXTERNAL_APPS 含 ' + banned + '：它依赖 __goChunks 注册表懒加载（pptx-bridge / nowasm fallback），外链会让懒加载失败');
    }
  }
  // 构建脚本必须真有硬守卫（不能只靠白名单约定）
  if (!rendererSrc.includes('CHUNK_REGISTRY_DEPS') || !/offenders\.length > 0/.test(rendererSrc)) {
    errs.push('inline-renderer.mjs 缺 __goChunks 依赖守卫（外链 slides/pdf 会静默破坏懒加载）');
  }
  if (!syncSrc.includes('is_external "$APP"')) {
    errs.push('sync-web.sh 未按 EXTERNAL_APPS 分流（开关是摆设）');
  }

  // ③ 产物形态与白名单逐项对齐
  const webDir = resolve(root, 'harmony/entry/src/main/resources/rawfile/web');
  const apps = readdirSync(webDir).filter((n) => existsSync(resolve(webDir, n, 'index.html')));
  if (apps.length < 5) errs.push('rawfile/web 下只有 ' + apps.length + ' 个 app（产物被清掉了？）');
  const foundExternal = [];
  for (const app of apps) {
    const htmlPath = resolve(webDir, app, 'index.html');
    const html = readFileSync(htmlPath, 'utf8');
    const extScript = new RegExp('<script[^>]+src="' + originHost.replace(/\./g, '\\.') + '/web/' + app + '/assets/[^"]+\\.js"');
    const isExt = extScript.test(html);
    if (isExt) foundExternal.push(app);
    if (externalApps.includes(app) !== isExt) {
      errs.push('rawfile/web/' + app + ' 的产物形态与 EXTERNAL_APPS 不符（白名单' +
        (isExt ? '外' : '内') + '，产物却是' + (isExt ? '外链' : '内联') + '）→ 重跑 sh scripts/sync-web.sh ' + app);
    }
    if (!isExt) continue;
    // 外链产物的四条硬要求
    if (!html.includes('script-src') || !new RegExp('script-src[^;]*' + originHost.replace(/\./g, '\\.')).test(html)) {
      errs.push('rawfile/web/' + app + '/index.html 的 CSP script-src 未放行 ' + originHost + '（外链脚本会被 CSP 拦掉 → 白屏）');
    }
    if (html.includes('window.__goChunks')) {
      errs.push('rawfile/web/' + app + '/index.html 外链模式却仍有 __goChunks 注册表（产物是混合态，重跑 sync）');
    }
    if (html.length > 1024 * 1024) {
      errs.push('rawfile/web/' + app + '/index.html 仍有 ' + Math.round(html.length / 1024) + ' KB（外链没生效？重跑 sync）');
    }
    for (const m of html.matchAll(/<script[^>]+src="[^"]*\/web\/[^/]+\/(assets\/[^"]+\.js)"/g)) {
      if (!existsSync(resolve(webDir, app, m[1]))) {
        errs.push('rawfile/web/' + app + ' 外链指向的产物不存在：' + m[1]);
      }
    }
  }
  if (errs.length) throw new Error(errs.slice(0, 10).join('; '));
  return '外链 app：' + (foundExternal.length ? foundExternal.join(',') : '(无)') + '；其余 ' +
    (apps.length - foundExternal.length) + ' 个保持内联；ASSET_ORIGIN 两侧一致（' + originHost + '）';
}

// md-asset 图片显示桥门禁（批次 D-4）：渲染层把本地图片显示成 md-asset://（桌面由
// protocol.handle 供字节），ArkWeb 壳内没有该协议处理器 → 编辑器里图片全裂。
// 修法是在 markdown frame 内把 img src 换成 blob:（字节经 readLocalImageJson 取）。
// 这些锚点都是「删了就静默退化」的类型：图片不显示但不报错，只有门禁能拦。
function checkMdAssetImageShim() {
  const idx = readFileSync(resolve(__dirname, '..', 'entry/src/main/ets/pages/Index.ets'), 'utf8');
  const errs = [];
  const need = [
    'function mdAssetToUri(s) {',
    'function readImageBytesAuthorized(uri) {',
    'function mdAssetUpgradeImg(img) {',
    'function mdAssetScan(root) {',
    'function installMdAssetImages() {',
    "href.indexOf('/web/markdown/')",       // 只在 markdown frame 装（其余 app 白挂 observer 是纯开销）
    "attributeFilter: ['src']",             // 编辑器重渲染频繁，不限定会拿到大量无关记录
    // 下面三条必须是**完整语句**锚点：只写 mdAssetBlobUrls[raw] 这类子串的话，
    // 删掉守卫但留着赋值/删除语句仍能命中 → 「删一半」逃过门禁（反例实测抓到过）
    'if (mdAssetBlobUrls[raw]) { img.src = mdAssetBlobUrls[raw]; return; }',   // 同图多处引用只读一次
    'if (mdAssetInFlight[raw]) { return; }',                                   // 并发去重
    '\n  installMdAssetImages();',                                             // 必须真的被调用
    'URL.createObjectURL(blob)',
  ];
  for (const n of need) if (!idx.includes(n)) errs.push('Index.ets 缺: ' + n);
  // 替换前必须确认 src 没被渲染层改过（换文档/撤销时不要覆盖新值）
  if (!idx.includes("if ((img.getAttribute('src') || '') === raw) { img.src = url; }")) {
    errs.push('mdAssetUpgradeImg 未校验 src 未被改动就替换（会覆盖渲染层刚设置的新图）');
  }
  if (errs.length) throw new Error(errs.join('; '));
  return 'md-asset 显示桥锚点 ' + need.length + ' 条 + src 竞态校验';
}

// 桥契约登记表新鲜度门禁（批次 D-5，**本次真机白屏的根因门禁**）。
// 事故：起始页白屏 `window.aiOffice.folderRoots is not a function`。Stage A 烟雾测试本该拦住
// （它对「每个桥的每个方法」都调一次），但它的方法清单来自 scripts/bridge-methods.json ——
// 那是 extract-bridge-methods.mjs 的**手工生成产物**，2026-09-22 上游同步给 preload 加了
// 起始页文件夹/搜索/MCP 等 41 个方法后没人重跑生成器 → 登记表停留在旧契约 → 新方法从没被调过
// → 崩溃一路漏到真机。登记表过期 = 烟雾测试的覆盖面悄悄缩水，且**不会有任何报错**。
// 本门禁每次重算契约并与入库文件逐项比对，少了/多了都报红（修复动作：重跑生成器）。
// 注：抽取逻辑在此内联一份（反例 harness 只注入 readFileSync/resolve/__dirname/readdirSync/
// existsSync，跨模块 import 会 ReferenceError）；为防两份实现漂移，下面第一条断言就是
// 「生成器里必须仍是同一条方法名正则」。
function checkBridgeRegistryFresh() {
  const root = resolve(__dirname, '..', '..');
  const errs = [];
  const APPS = {
    shell: { path: 'apps/shell/src/preload/index.ts', objects: ['homeApi', 'projectApi', 'tabsApi'] },
    docs: { path: 'apps/docs/src/preload/index.ts', objects: ['api', 'projectApi'] },
    sheets: { path: 'apps/sheets/src/preload/index.ts', objects: ['desktopApi', 'projectApi'] },
    slides: { path: 'apps/slides/src/preload/index.ts', objects: ['api', 'filesApi', 'projectApi'] },
    markdown: { path: 'apps/markdown/src/preload/index.ts', objects: ['api', 'projectApi'] },
    pdf: { path: 'apps/pdf/src/preload/index.ts', objects: ['api', 'projectApi'] },
  };
  const METHOD_RE_SRC = '^[ \\t]{2,8}(?:async\\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\\s*(?:\\(|:)';
  const genSrc = readFileSync(resolve(__dirname, 'extract-bridge-methods.mjs'), 'utf8');
  if (!genSrc.includes(METHOD_RE_SRC)) {
    errs.push('extract-bridge-methods.mjs 的方法名正则与本门禁不一致（两份实现漂移）→ 同步 scripts/verify-all.mjs 的 METHOD_RE_SRC');
  }
  const KW = /^(if|for|while|switch|return|throw|catch|try|else|do|new|in|of|typeof|await|async|function|const|let|var)$/;
  const extract = (src, objectName) => {
    const start = src.indexOf('const ' + objectName);
    if (start < 0) return [];
    const eqIdx = src.indexOf('=', start);
    const braceStart = src.indexOf('{', eqIdx);
    if (braceStart < 0) return [];
    let depth = 1;
    let i = braceStart + 1;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      i++;
    }
    const body = src.slice(braceStart, i);
    const names = [];
    const re = new RegExp(METHOD_RE_SRC, 'gm');
    let m;
    while ((m = re.exec(body)) !== null) {
      if (KW.test(m[1])) continue;
      names.push(m[1]);
    }
    return [...new Set(names)];
  };

  const registryPath = resolve(__dirname, 'bridge-methods.json');
  if (!existsSync(registryPath)) throw new Error('缺 scripts/bridge-methods.json（烟雾测试会没有方法清单 → 假绿）');
  const committed = JSON.parse(readFileSync(registryPath, 'utf8'));
  let missingTotal = 0;
  let extraTotal = 0;
  for (const [app, cfg] of Object.entries(APPS)) {
    const preload = resolve(root, cfg.path);
    if (!existsSync(preload)) { errs.push('缺 preload：' + cfg.path); continue; }
    const src = readFileSync(preload, 'utf8');
    for (const obj of cfg.objects) {
      const fresh = extract(src, obj);
      const have = (committed[app] && committed[app][obj]) || [];
      const missing = fresh.filter((n) => !have.includes(n));
      const extra = have.filter((n) => !fresh.includes(n));
      missingTotal += missing.length;
      extraTotal += extra.length;
      if (missing.length > 0) {
        errs.push(app + '.' + obj + ' 登记表缺 ' + missing.length + ' 个契约方法（烟雾测试调不到 → 崩溃会漏到真机）：'
          + missing.slice(0, 8).join(', ') + (missing.length > 8 ? ' …' : ''));
      }
      if (extra.length > 0) {
        errs.push(app + '.' + obj + ' 登记表多出 ' + extra.length + ' 个已不存在的方法：' + extra.slice(0, 8).join(', '));
      }
    }
  }
  if (errs.length) {
    throw new Error(errs.slice(0, 8).join('; ') + ' → 修复：node scripts/extract-bridge-methods.mjs');
  }
  const total = Object.keys(APPS).reduce((n, a) => n + ((committed[a] && committed[a]._all) || []).length, 0);
  return '契约登记表与 6 个 preload 一致（' + total + ' 个方法；缺 ' + missingTotal + ' / 多 ' + extraTotal + '）';
}

// R3-5 门禁：BridgeRegistry 注册键集 ↔ JS 调用集对账
// 确保 DesktopBridge.ets 的 r.register() 键集与 Index.ets 中 goJson/goNative 调用一致：
//   ① JS 调用了但未注册 → 真机运行时 "unknown method" 错误
//   ② 注册了但 JS 不调用 → 可能是死代码（archive 系列是预留，允许）
//   ③ 直接暴露的同步方法（registerJavaScriptProxy 同步列表）不走 bridgeCall，豁免
function checkNativeBridgeRegistry() {
  const bridgeSrc = readFileSync(resolve(__dirname, '..', 'entry/src/main/ets/bridge/DesktopBridge.ets'), 'utf8');
  const idxSrc = readFileSync(resolve(__dirname, '..', 'entry/src/main/ets/pages/Index.ets'), 'utf8');
  const errs = [];

  // ① 提取注册集：r.register('methodName', ...)
  const registered = new Set();
  for (const m of bridgeSrc.matchAll(/r\.register\('([^']+)'/g)) {
    registered.add(m[1]);
  }

  // ② 提取 JS 调用集：goJson('methodName', ...) + goNative('methodName', ...)
  const jsCalled = new Set();
  for (const m of idxSrc.matchAll(/goJson\(\s*['"]([^'"]+)['"]/g)) {
    jsCalled.add(m[1]);
  }
  for (const m of idxSrc.matchAll(/goNative\(\s*['"]([^'"]+)['"]/g)) {
    jsCalled.add(m[1]);
  }
  // 动态方法名（三元表达式）：goJson(cond ? 'methodA' : 'methodB', ...)
  for (const m of idxSrc.matchAll(/goJson\(\s*\w+\.\w+\s*\?\s*['"]([^'"]+)['"]\s*:\s*['"]([^'"]+)['"]/g)) {
    jsCalled.add(m[1]);
    jsCalled.add(m[2]);
  }

  // ③ 豁免集：直接暴露的同步方法（registerJavaScriptProxy 同步列表，不走 bridgeCall）
  //    这些方法在 Index.ets 的 registerJavaScriptProxy 调用中列为同步方法，
  //    JS 侧通过 goJson/goNative 调用但实际走 desktopNative.methodName() 同步路径
  const SYNC_EXEMPT = new Set(['recentFilesJson', 'writeClipboardText']);

  // ④ 预留集：注册了但当前 JS 不调用（archive 系列是未来功能预留）
  const RESERVED = new Set(['xlsArchiveManifestJson', 'xlsReadEntriesJson', 'xlsSaveArchiveJson', 'xlsScanEntriesJson',
    'pickAttachmentsJson', 'captureScreenJson', 'toggleStarJson', 'searchFilesJson', 'renameFileJson',
    'duplicateFileJson', 'deleteFilesJson', 'revealPathJson', 'autoRenameWorkbookJson',
    'xlsReadArchiveEntryTextJson', 'attachmentAddJson', 'attachmentReadImageJson',
    'attachmentAddPastedJson', 'attachmentReadJson']);

  // 检查 ①：JS 调用了但未注册（且不在豁免集中）→ 真机会 "unknown method"
  const calledButNotRegistered = [...jsCalled].filter(m => !registered.has(m) && !SYNC_EXEMPT.has(m));
  if (calledButNotRegistered.length > 0) {
    errs.push('JS 调用了但 BridgeRegistry 未注册（真机会 unknown method）：' + calledButNotRegistered.join(', '));
  }

  // 检查 ②：注册了但 JS 不调用（且不在预留集中）→ 可能是死代码
  const registeredButNotCalled = [...registered].filter(m => !jsCalled.has(m) && !RESERVED.has(m));
  if (registeredButNotCalled.length > 0) {
    errs.push('BridgeRegistry 注册了但 JS 不调用（可能死代码）：' + registeredButNotCalled.join(', '));
  }

  // 检查 ③：注册集数量合理性（防止意外删除大量 register 调用）
  if (registered.size < 40) {
    errs.push('BridgeRegistry 注册方法数 ' + registered.size + ' < 40（可能意外删除了 register 调用）');
  }

  if (errs.length) throw new Error(errs.join('; '));
  return 'BridgeRegistry ' + registered.size + ' 个注册方法 ↔ JS ' + jsCalled.size + ' 个调用点对账通过'
    + '（豁免 ' + SYNC_EXEMPT.size + ' 同步方法、预留 ' + RESERVED.size + ' archive 方法）';
}

// R5-2/R5-3 门禁：恒空桩注册表新鲜度 + 多锚点交叉对账
// stub-registry.json 必须与 Index.ets 中的实际恒空桩一致，且：
//   ① slides 的 UNSUPPORTED_STUBS 必须覆盖所有 truly-unsupported 类别的 slidesApi 桩
//   ② stub-registry.json 的 slidesApi truly-unsupported ↔ slides-stub-registry.json 的 guarded 一致
//   ③ stub-registry.json 的 slidesApi ambient ↔ slides-stub-registry.json 的 aiOnly 子集一致
// 修复：运行 `node scripts/extract-stubs.mjs` 重新生成
function checkStubRegistryFresh() {
  const registryPath = resolve(__dirname, 'stub-registry.json');
  if (!existsSync(registryPath)) {
    throw new Error('缺 scripts/stub-registry.json（R5-2 桩注册表，运行 node scripts/extract-stubs.mjs 生成）');
  }
  const result = spawnSync('node', [resolve(__dirname, 'extract-stubs.mjs'), '--check'], {
    encoding: 'utf8',
    timeout: 30000,
  });
  if (result.status !== 0) {
    const msg = (result.stderr || result.stdout || '').trim();
    throw new Error(msg || 'stub-registry.json 与 Index.ets 不一致');
  }
  const committed = JSON.parse(readFileSync(registryPath, 'utf8'));
  const cats = committed.byCategory || {};

  // R5-3: 交叉对账 stub-registry.json ↔ slides-stub-registry.json
  // 分类维度不同但必须一致：
  //   stub-registry truly-unsupported ↔ slides-stub-registry guarded（核心对账，必须完全一致）
  //   stub-registry ambient ⊇ slides-stub-registry aiOnly（aiOnly 是 ambient 的子集）
  //   slides-stub-registry benign 中的恒空桩 → stub-registry legitimate-null 或 ambient（不要求精确匹配，
  //     因为两个注册表的分类维度不同：benign 按"渲染层不依赖返回值"分，stub-registry 按"null 语义"分）
  const slidesRegPath = resolve(__dirname, 'slides-stub-registry.json');
  if (existsSync(slidesRegPath)) {
    const slidesReg = JSON.parse(readFileSync(slidesRegPath, 'utf8'));
    const regTrulySlides = committed.stubs
      .filter(s => s.ns === 'slidesApi' && s.category === 'truly-unsupported')
      .map(s => s.method).sort();
    const regAmbientSlides = new Set(committed.stubs
      .filter(s => s.ns === 'slidesApi' && s.category === 'ambient')
      .map(s => s.method));
    const regLegitSlides = new Set(committed.stubs
      .filter(s => s.ns === 'slidesApi' && s.category === 'legitimate-null')
      .map(s => s.method));
    const regAllSlides = new Set(committed.stubs
      .filter(s => s.ns === 'slidesApi')
      .map(s => s.method));

    const guarded = [...(slidesReg.guarded || [])].sort();
    const aiOnly = [...(slidesReg.aiOnly || [])];
    const benign = [...(slidesReg.benign || [])];

    const errs = [];
    // ① truly-unsupported ↔ guarded（必须完全一致）
    if (JSON.stringify(regTrulySlides) !== JSON.stringify(guarded)) {
      const missing = guarded.filter(m => !regTrulySlides.includes(m));
      const extra = regTrulySlides.filter(m => !guarded.includes(m));
      if (missing.length) errs.push('slides-stub-registry guarded 不在 stub-registry truly-unsupported: ' + missing.join(', '));
      if (extra.length) errs.push('stub-registry truly-unsupported 不在 slides-stub-registry guarded: ' + extra.join(', '));
    }
    // ② aiOnly ⊆ ambient（aiOnly 中的桩应在 stub-registry 的 ambient 中）
    const aiOnlyNotInAmbient = aiOnly.filter(m => !regAmbientSlides.has(m));
    if (aiOnlyNotInAmbient.length) {
      errs.push('slides-stub-registry aiOnly 不在 stub-registry ambient: ' + aiOnlyNotInAmbient.join(', '));
    }
    // ③ benign 中的恒空桩应在 stub-registry 中（且分类为 legitimate-null 或 ambient）
    const benignInReg = benign.filter(m => regAllSlides.has(m));
    const benignMisclassified = benignInReg.filter(m => !regLegitSlides.has(m) && !regAmbientSlides.has(m));
    if (benignMisclassified.length) {
      errs.push('slides-stub-registry benign 在 stub-registry 中但分类不是 legitimate-null/ambient: ' + benignMisclassified.join(', '));
    }

    if (errs.length) throw new Error(errs.join('; '));
  }

  return '恒空桩注册表新鲜：' + committed.total + ' 个桩（'
    + (cats['truly-unsupported'] || 0) + ' truly-unsupported / '
    + (cats['legitimate-null'] || 0) + ' legitimate-null / '
    + (cats['ambient'] || 0) + ' ambient）'
    + (existsSync(slidesRegPath) ? '；slides-stub-registry 交叉对账通过' : '');
}

// R2 契约新鲜度门禁：bridge-contract.json 必须与 preload 源码一致
// 比 checkBridgeRegistryFresh 更严格：不仅检查方法名，还检查参数形状/kind/channel
// 修复：运行 `node scripts/gen-bridge-contract.mjs` 重新生成
function checkBridgeContractFresh() {
  const contractPath = resolve(__dirname, 'bridge-contract.json');
  if (!existsSync(contractPath)) {
    throw new Error('缺 scripts/bridge-contract.json（R2 契约文件，运行 node scripts/gen-bridge-contract.mjs 生成）');
  }
  // 调用 gen-bridge-contract.mjs 的 --check 模式
  const result = spawnSync('node', [resolve(__dirname, 'gen-bridge-contract.mjs'), '--check'], {
    encoding: 'utf8',
    timeout: 30000,
  });
  if (result.status !== 0) {
    const msg = (result.stderr || result.stdout || '').trim();
    throw new Error(msg || 'bridge-contract.json 与 preload 源码不一致');
  }
  // 同时检查 mock.js 新鲜度
  const mockResult = spawnSync('node', [resolve(__dirname, 'gen-mock.mjs'), '--check'], {
    encoding: 'utf8',
    timeout: 30000,
  });
  if (mockResult.status !== 0) {
    const msg = (mockResult.stderr || mockResult.stdout || '').trim();
    throw new Error(msg || 'mock.js 与 bridge-contract.json 不一致');
  }
  return 'bridge-contract.json + mock.js 与 preload 源码一致';
}

// 壳侧三桥的 Proxy 兜底门禁（批次 D-5）：aiOffice / aiOfficeProject / aiOfficeTabs 必须经
// wrapShellBridge 包装。裸对象赋值 = 未实现方法取到 undefined → 渲染层一调就
// "is not a function" → React 渲染中断 → **起始页白屏**（真机实测，且壳托管所有 iframe，
// 白屏等于整个应用不可用）。app 侧六桥经 makeBridge 有 Proxy，所以同类缺口在 app 里只是静默 no-op
// —— 这个差异过去没被任何门禁覆盖（批次 B 的审计还据此把壳侧缺口误判为「安全 no-op」）。
function checkShellBridgeProxy() {
  const idx = readFileSync(resolve(__dirname, '..', 'entry/src/main/ets/pages/Index.ets'), 'utf8');
  const errs = [];
  const need = [
    'function wrapShellBridge(name, obj) {',
    "window.aiOffice = wrapShellBridge('aiOffice', aiOffice);",
    "window.aiOfficeProject = wrapShellBridge('aiOfficeProject', {",
    "window.aiOfficeTabs = wrapShellBridge('aiOfficeTabs', {",
    // 批次 E：起始页「第三方集成」分区用的桥 —— 上一版根本没实现，面板永远空白
    "window.aiOfficeIntegrations = wrapShellBridge('aiOfficeIntegrations', {",
    // 形状锚点必须**带方法名**：只写 '{ models: [], defaultModel: "" }' 时，getCodexModels 退回
// undefined 仍会被别的方法里的同名字段命中 → 反例实测发现断言不红（门禁形同虚设）。
    'folderRoots: function () { return Promise.resolve([]); }',
    "getCodexModels: function () { return Promise.resolve({ models: [], defaultModel: '' }); }",
    "{ models: [], defaultModel: '' }",
    '{ hits: [], total: 0, index: { indexed: 0, pending: 0, scanning: false } }',
    // 批次 D-6 真机：进设置页崩 Can not read ... (reading 'on') —— getAutoSaveDefault 落到
    // Proxy 兜底 resolve(undefined)，SettingsModal 直接 v.on。契约 AutoSaveDefault{on,updatedAt}
    'getAutoSaveDefault: function () { return Promise.resolve({ on: loadAutoSaveDefault(), updatedAt: 0 }); }',
    // 批次 E 系统性扫描补的：这几个都写成 `?.()`，旧正则看不见 → 曾经完全不在门禁视野里
    'setAutoSaveDefault: function (on) {',
    'getFileSearchSettings: function () { return Promise.resolve(loadFileSearchSettings()); }',
    'testAiMediaSettings: function (input) {',
    'testAiSearchSettings: function (input) {',
    'openMcpLogFile: function () { return Promise.resolve(); },',
    'clearMcpLogs: function () { return Promise.resolve(); },',
    "getCustomModels: function () { return Promise.resolve({ models: [], defaultModel: '' }); }",
    // 批次 E-2 真机：点「第三方集成」崩 reading 'running' —— 该分区里嵌的 McpServerSection 写的是
    // getMcpStatus?.().then(takeStatus)，takeStatus 直接读 s.running。有 Proxy 兜底时方法"存在"但
    // resolve(undefined)，连 ?. 都骗不过去 → **壳桥每个被 .then() 消费的方法都必须给真实形状**。
    'getMcpStatus: function () {',
    'running: false, enabled: false, port: 3093, background: false, logging: false,',
    'url: null, capabilities: [],',
    'getMcpLogs: function () { return Promise.resolve([]); }',
    'moved: [],',
    'conflicts: [],',
  ];
  for (const n of need) if (!idx.includes(n)) errs.push('Index.ets 缺: ' + n);
  // Proxy 语义必须**在 wrapShellBridge 体内**逐条核对：同样两行在 PROMISE_SHIM 的 makeBridge 里
  // 也有一份，只按全文 includes 判定的话，删掉壳侧那份仍会命中 app 侧那份 → 「删一半」逃过门禁
  // （反例实测抓到过）。
  const ws = idx.indexOf('function wrapShellBridge(name, obj) {');
  if (ws < 0) {
    errs.push('未找到 wrapShellBridge（壳侧三桥的 Proxy 兜底）');
  } else {
    const body = idx.slice(ws, idx.indexOf('\n  }', ws));
    for (const n of [
      'if (k in t) { return t[k]; }',                                    // 已有键优先：不得覆盖 aiOffice 自己的 getAiSettings
      "if (k.indexOf('on') === 0) { return function () { return NOOP; }; }", // on* 必须给出退订函数
      'return function () { return Promise.resolve(undefined); };',        // 其余方法兜底成可调用的 no-op
    ]) {
      if (!body.includes(n)) errs.push('wrapShellBridge 体内缺: ' + n);
    }
  }
  // 裸赋值复活（这次白屏的直接原因）；__wrapped 只是标记，不等于真的包了 Proxy
  if (idx.includes('window.aiOffice = aiOffice;')) {
    errs.push('window.aiOffice 退回裸对象赋值（未实现方法会 TypeError → 起始页白屏）');
  }
  if (errs.length) throw new Error(errs.slice(0, 8).join('; '));
  // 形状锚点单独计数（不含桥包装/赋值那几条），免得"锚点变多"看不出"形状变多"
  let shapeCount = 0;
  for (const n of need) {
    if (n.indexOf('function () { return Promise.resolve(') >= 0 || n.indexOf('running: false') === 0
      || n.indexOf('url: null') === 0 || n.indexOf('{ hits:') === 0) { shapeCount++; }
  }
  return '壳侧四桥均经 wrapShellBridge 兜底（' + need.length + ' 条锚点，含 ' + shapeCount + ' 个会被解引用的返回形状）';
}

// ========== 批次 E：AI 提供方目录 / 双协议通道 / 去 Genspark 登录 / 许可材料 ==========

/** AI 提供方目录：去 Genspark + 自由配置（端点可改、模型 id 可填）+ 搜索目录只列真实现的 */
/**
 * 品牌值回归门禁（R4）：源码可含 Genspark（与上游一致），构建时 strip-brand.mjs 对 dist 产物替换。
 * 本门禁检查 dist 产物（rawfile/web/）中是否还有 Genspark 品牌残留。
 * 如果 dist 产物不存在（尚未 sync-web），则跳过（warn 不 fail）。
 */
function checkGensparkBrandGone() {
  const webRoot = resolve(__dirname, '..', 'entry/src/main/resources/rawfile/web');
  if (!existsSync(webRoot)) {
    return 'rawfile/web 不存在（尚未 sync-web），跳过 dist 品牌检查';
  }
  const r = spawnSync(process.execPath, [resolve(__dirname, 'strip-brand.mjs'), webRoot, '--check'], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  if (r.status !== 0) {
    throw new Error('dist 产物仍有 Genspark 品牌残留（跑 sync-web.sh 会自动 strip）: ' + out.slice(0, 300));
  }
  return 'dist 产物无 Genspark 品牌残留（strip-brand.mjs --check 通过）';
}

function checkStripScriptSafety() {
  // R4：strip-brand.mjs 是构建时脚本，对 dist 产物做品牌替换。
  // 门禁逻辑已合并到 checkGensparkBrandGone（同一脚本同一 --check 调用）。
  // 此门禁保留为独立项以维持历史兼容，但实际检查由 checkGensparkBrandGone 完成。
  const webRoot = resolve(__dirname, '..', 'entry/src/main/resources/rawfile/web');
  if (!existsSync(webRoot)) {
    return 'rawfile/web 不存在（尚未 sync-web），跳过 strip 安全检查';
  }
  // strip-brand.mjs --check 已在 checkGensparkBrandGone 中运行，这里只验证脚本本身存在且可执行
  const scriptPath = resolve(__dirname, 'strip-brand.mjs');
  if (!existsSync(scriptPath)) {
    throw new Error('strip-brand.mjs 不存在: ' + scriptPath);
  }
  return 'strip-brand.mjs 存在且可执行（dist 产物检查由 GensparkBrandGone 门禁覆盖）';
}

// ── 批次 E-6：PPT「入口可见但不可用」三层登记表 ↔ 桥覆盖缺口 ↔ 壳侧恒空桩 三方对账 ──
// 背景：makeBridge 的 Proxy 对壳侧未实现的方法静默 resolve(undefined)，渲染层 `if (r)` 空分支
// 直接结束 —— 用户观感是「点了没反应」，比报错更糟。E-6 把 PPT 这类入口收成三层：
//   ① 首环缺口 → unsupported('<m>') 提示 / 置灰；
//   ② 壳侧恒空桩（键存在、体恒 null）→ 同上（覆盖门禁看不见它）；
//   ③ 环境/高频路径 → 只登记不提示（提示会变噪音）。
// 三层清单是**手写**的，上游同步或改桥方法后极易漂移（漂移的代价是用户又点进死分支），故对账：
//   ① 白名单里 slidesApi 的每个缺口都在登记表内（不重不漏）；
//   ② 登记表内除「壳侧恒空桩」外没有多余项（typo，或方法已实现却没从表里删）；
//   ③ ACTIONS ∪ STUBS 每个方法至少 1 处 unsupported('<m>') 调用点（登记了却没插 guard = 白登记）；
//   ④ 壳侧恒空桩全部在 slides-stub-registry.json 里分类（含理由，供长期实现排期）；
//   ⑤ appStatusUnsupported 在 20 个语言分片齐备（缺分片 = 该语言用户看到裸键名）。
function checkSlidesUnsupportedWiring() {
  const repoRoot = resolve(__dirname, '..', '..');
  const readRel = (rel) => readFileSync(resolve(repoRoot, rel), 'utf8');
  const tableSrc = readRel('apps/slides/src/renderer/unsupported-features.ts');
  const pickArray = (name) => {
    const m = new RegExp('export const ' + name + '[^=]*=\\s*\\[([\\s\\S]*?)\\n\\]').exec(tableSrc);
    if (!m) throw new Error('unsupported-features.ts 里找不到 ' + name + '（登记表被改名/删了？）');
    return (m[1].match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1));
  };
  const actions = pickArray('UNSUPPORTED_ACTIONS');
  const stubs = pickArray('UNSUPPORTED_STUBS');
  const ambient = pickArray('UNSUPPORTED_AMBIENT');
  const coversMatch = /export const UNSUPPORTED_ACTION_COVERS[^=]*=\s*\{([\s\S]*?)\n\}/.exec(tableSrc);
  if (!coversMatch) throw new Error('unsupported-features.ts 里找不到 UNSUPPORTED_ACTION_COVERS');
  const covers = (coversMatch[1].match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1));

  // ① 白名单里 slidesApi 的缺口集合
  const allow = JSON.parse(readFileSync(resolve(__dirname, 'bridge-coverage-allowlist.json'), 'utf8'));
  const gaps = new Set(allow.entries.filter((e) => e.ns === 'slidesApi').map((e) => e.method));


  // ② 壳侧 slidesMock 的恒空桩（同名后者胜：applyEditScript 那类旧桩已被真实现覆盖）
  const shell = readFileSync(resolve(repoRoot, 'harmony/entry/src/main/ets/pages/Index.ets'), 'utf8').split('\n');
  const blockStart = shell.findIndex((l) => /^  var slidesMock = Object\.assign\(/.test(l));
  if (blockStart < 0) throw new Error('Index.ets 里找不到 slidesMock 定义（壳侧结构变了？）');
  let blockEnd = shell.length;
  for (let i = blockStart + 1; i < shell.length; i++) {
    if (/^  (?:var \w+ =|function \w+\()/.test(shell[i])) { blockEnd = i; break; }
  }
  const stubKeys = new Map();
  for (let i = blockStart; i < blockEnd; i++) {
    const m = /^    ([A-Za-z_$][\w$]*): function\s*\(([^)]*)\)\s*\{/.exec(shell[i]);
    if (!m) continue;
    const inline = shell[i].slice(shell[i].indexOf('{') + 1);
    let code;
    if (/\}\s*,?\s*$/.test(inline)) {
      code = inline;
    } else {
      const body = [];
      for (let j = i + 1; j < blockEnd; j++) {
        if (/^    \},\s*$/.test(shell[j]) || /^    \}\s*$/.test(shell[j])) break;
        body.push(shell[j]);
      }
      code = body.join(' ');
    }
    code = code.replace(/\/\/[^\n]*/g, '').replace(/\}\s*,?\s*$/, '').trim();
    stubKeys.set(m[1], /^return Promise\.resolve\((null|\[\]|\{\s*\}|true)\);?$/.test(code));
  }
  const shellStubs = new Set([...stubKeys.entries()].filter(([, isStub]) => isStub).map(([k]) => k));

  // ③ 注册表（slides-stub-registry.json）
  const regPath = resolve(__dirname, 'slides-stub-registry.json');
  if (!existsSync(regPath)) throw new Error('缺 scripts/slides-stub-registry.json（恒空桩分类表，被删了？）');
  const reg = JSON.parse(readFileSync(regPath, 'utf8'));
  const regCats = ['guarded', 'aiOnly', 'benign', 'emptyOk', 'bestEffort'];
  for (const c of regCats) {
    if (!Array.isArray(reg[c])) throw new Error('slides-stub-registry.json 缺数组字段 ' + c);
  }
  const regAll = new Set(regCats.flatMap((c) => reg[c]));

  // ④ 调用点扫描（渲染层全部 ts/tsx，排除登记表自身）
  const rendererDir = resolve(repoRoot, 'apps/slides/src/renderer');
  const walk = (d, out) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = resolve(d, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.tsx?$/.test(e.name)) out.push(p);
    }
    return out;
  };
  const sources = walk(rendererDir, [])
    .filter((p) => !p.endsWith('unsupported-features.ts'))
    .map((p) => readFileSync(p, 'utf8'))
    .join('\n');

  // ⑤ i18n 分片
  const i18nDir = resolve(rendererDir, 'i18n', 'app');
  const shards = readdirSync(i18nDir).filter((f) => f.endsWith('.ts'));
  const missKey = shards.filter((f) => !readFileSync(resolve(i18nDir, f), 'utf8').includes('appStatusUnsupported'));

  const errs = [];
  const union = new Set([...actions, ...stubs, ...ambient, ...covers]);
  const missing = [...gaps].filter((m) => !union.has(m));
  if (missing.length) errs.push('桥覆盖缺口未登记（用户点了会静默无反应）: ' + missing.join(', '));
  const stale = [...union].filter((m) => !gaps.has(m) && !stubKeys.has(m));
  if (stale.length) errs.push('登记表含多余项（方法已实现却没删，或拼错方法名）: ' + stale.join(', '));
  const noGuard = [...actions, ...stubs].filter((m) => !sources.includes("unsupported('" + m + "')"));
  if (noGuard.length) errs.push('登记了却没有 unsupported() 调用点（白登记）: ' + noGuard.join(', '));
  const unclassified = [...shellStubs].filter((m) => !regAll.has(m));
  const regPhantom = [...regAll].filter((m) => !shellStubs.has(m));
  if (unclassified.length) errs.push('壳侧恒空桩未分类（slides-stub-registry.json 缺项）: ' + unclassified.join(', '));
  if (regPhantom.length) errs.push('注册表列了非恒空桩的方法（已是真实现，请删）: ' + regPhantom.join(', '));
  if (missKey.length) errs.push('i18n 缺 appStatusUnsupported 分片: ' + missKey.join(', '));
  const notInStubs = reg.guarded.filter((m) => !stubs.includes(m));
  if (notInStubs.length) errs.push('注册表 guarded 与 UNSUPPORTED_STUBS 不一致: ' + notInStubs.join(', '));
  if (errs.length) throw new Error(errs.join('; '));
  return 'slides 登记表对账通过：缺口 ' + gaps.size + ' = guard ' + actions.length + ' + covers ' + covers.length
    + ' + ambient ' + ambient.length + '；恒空桩 ' + shellStubs.size + ' 已分类；'
    + (actions.length + stubs.length) + ' 个方法均有调用点；i18n 分片 ' + shards.length + ' 齐备';
}

// ── 壳侧 mock 重复键门禁（批次 E-6 血案）──
// 事故：slidesMock 里 moveSlides 被**第二次**定义成 `return Promise.resolve(null)`，对象字面量
// 后定义覆盖先定义 → 上面那份真实现整条失效，拖动排序幻灯片静默 no-op。两处门禁都看不见它：
// check-bridge-coverage 只问「有没有这个方法」，checkArkTsDuplicateMembers 只扫 class/struct 成员
// （mock 是对象字面量，键是 4 空格缩进的 `key: function`）。故单独设防：
//   规则：同名重复键里「后者是恒空桩、前者不是」→ FAIL（正是遮蔽真实现这一种）；
//         其余重复（两者等价，或后者才是真实现）只记 note，不拦（applyEditScript 即此类）。
function checkMockDuplicateKeys() {
  const repoRoot = resolve(__dirname, '..', '..');
  const rel = 'harmony/entry/src/main/ets/pages/Index.ets';
  const lines = readFileSync(resolve(repoRoot, rel), 'utf8').split('\n');
  // 各 mock 的边界：`  var X = {` / `  var X = Object.assign(` 起，遇下一个 2 空格缩进的 var/function 止
  const decls = [];
  lines.forEach((l, i) => {
    const m = /^  var (\w+) = (?:Object\.assign\(|\{)/.exec(l);
    if (m) decls.push({ name: m[1], from: i });
  });
  if (!decls.length) throw new Error('Index.ets 里没解析到任何 mock 定义（结构变了？）');
  decls.forEach((d, idx) => { d.to = idx + 1 < decls.length ? decls[idx + 1].from : lines.length; });
  const errs = [];
  const notes = [];
  for (const d of decls) {
    const seen = new Map();
    for (let i = d.from; i < d.to; i++) {
      const m = /^    ([A-Za-z_$][\w$]*): function\s*\(([^)]*)\)\s*\{/.exec(lines[i]);
      if (!m) continue;
      const inline = lines[i].slice(lines[i].indexOf('{') + 1);
      let code;
      if (/\}\s*,?\s*$/.test(inline)) {
        code = inline;
      } else {
        const body = [];
        for (let j = i + 1; j < d.to; j++) {
          if (/^    \},\s*$/.test(lines[j]) || /^    \}\s*$/.test(lines[j])) break;
          body.push(lines[j]);
        }
        code = body.join(' ');
      }
      code = code.replace(/\/\/[^\n]*/g, '').replace(/\}\s*,?\s*$/, '').trim();
      const isStub = /^return Promise\.resolve\((null|\[\]|\{\s*\}|true)\);?$/.test(code);
      if (!seen.has(m[1])) seen.set(m[1], []);
      seen.get(m[1]).push({ line: i + 1, isStub });
    }
    for (const [name, hits] of seen) {
      if (hits.length < 2) continue;
      const winner = hits[hits.length - 1];
      const shadowedReal = hits.slice(0, -1).filter((h) => !h.isStub);
      if (winner.isStub && shadowedReal.length) {
        errs.push(rel + ' 的 ' + d.name + '.' + name + '() 重复定义：第 '
          + shadowedReal.map((h) => h.line).join(' / ') + ' 行是真实现，第 ' + winner.line
          + ' 行是空桩 → 后者胜使真实现整条失效（用户症状：入口点了没反应）');
      } else {
        notes.push(d.name + '.' + name + '@' + hits.map((h) => h.line).join('/'));
      }
    }
  }
  if (errs.length) throw new Error(errs.join('; '));
  return '各 mock 无「空桩遮蔽真实现」的重复键' + (notes.length ? '；无害重复键 ' + notes.length + ' 处（' + notes.join(', ') + '）' : '');
}

function checkAiProviderCatalog() {
  // 取目录数据（支持两种格式：旧的手写数组 + 新的 /*gen:xxx*/ 标记 JSON）
  function sliceArray(src, decl) {
    // 新格式：var NAME = /*gen:xxx*/[json]/*gen:xxx*/;
    const varName = decl.replace(/^var\s+/, '').replace(/\s*=\s*\[\s*$/, '');
    const markerRe = new RegExp('var\\s+' + varName + '\\s*=\\s*/\\*gen:([a-z-]+)\\*/');
    const markerM = markerRe.exec(src);
    if (markerM) {
      const marker = markerM[1];
      const open = `/*gen:${marker}*/`;
      const close = `/*gen:${marker}*/`;
      const start = markerM.index + markerM[0].length;
      const end = src.indexOf(close, start);
      if (end > 0) return src.slice(start, end);
    }
    // 旧格式：var NAME = [ ... ];
    const start = src.indexOf(decl);
    if (start < 0) return null;
    const end = src.indexOf('];', start);
    return end < 0 ? null : src.slice(start, end);
  }
  const idx = readFileSync(resolve(__dirname, '..', 'entry/src/main/ets/pages/Index.ets'), 'utf8');
  const errs = [];
  const catalogRaw = sliceArray(idx, 'var AI_CATALOG = [');
  if (!catalogRaw) {
    errs.push('找不到 var AI_CATALOG（旧格式 [ 或新格式 /*gen:ai-catalog*/）');
  } else {
    // 尝试 JSON 解析（新格式），失败则按旧格式字符串匹配
    let catalogEntries = null;
    try { catalogEntries = JSON.parse(catalogRaw); } catch (e) { /* 旧格式 */ }
    if (catalogEntries) {
      // 新格式：JSON 数据
      if (catalogEntries.some(e => e.id === 'genspark')) errs.push('AI_CATALOG 里还有 genspark 条目');
      if (catalogEntries.length < 10) errs.push('AI_CATALOG 条目数异常: ' + catalogEntries.length);
      if (!catalogEntries.every(e => e.needsBaseUrl === true)) errs.push('AI_CATALOG 有条目未开 needsBaseUrl');
      const custom = catalogEntries.find(e => e.id === 'custom');
      if (!custom || !Array.isArray(custom.models) || custom.models.length !== 0) errs.push("custom 条目必须是 models: []");
      const anthropic = catalogEntries.find(e => e.id === 'anthropic');
      if (!anthropic || !Array.isArray(anthropic.models) || anthropic.models.length !== 0) errs.push("anthropic 条目必须是 models: []");
    } else {
      // 旧格式：字符串匹配
      if (catalogRaw.includes("'genspark'")) errs.push('AI_CATALOG 里还有 genspark 条目');
      const entries = catalogRaw.split("\n    { id: '").length - 1;
      const withBaseUrl = catalogRaw.split('needsBaseUrl: true').length - 1;
      if (entries < 10) errs.push('AI_CATALOG 条目数异常: ' + entries);
      if (withBaseUrl !== entries) errs.push('AI_CATALOG 有 ' + entries + ' 条但只有 ' + withBaseUrl + ' 条开了 needsBaseUrl');
      if (!/id: 'custom'[\s\S]{0,120}models: \[\]/.test(catalogRaw)) errs.push("custom 条目必须是 models: []");
      if (!/id: 'anthropic'[\s\S]{0,120}models: \[\]/.test(catalogRaw)) errs.push("anthropic 条目必须是 models: []");
    }
  }
  const searchRaw = sliceArray(idx, 'var AI_SEARCH_CATALOG = [');
  if (!searchRaw) {
    errs.push('找不到 var AI_SEARCH_CATALOG（旧格式 [ 或新格式 /*gen:ai-search-catalog*/）');
  } else {
    let searchEntries = null;
    try { searchEntries = JSON.parse(searchRaw); } catch (e) { /* 旧格式 */ }
    if (searchEntries) {
      if (!searchEntries.some(e => e.id === 'serper')) errs.push('AI_SEARCH_CATALOG 缺 serper');
      if (!searchEntries.some(e => e.id === 'tavily')) errs.push('AI_SEARCH_CATALOG 缺 tavily');
      if (searchEntries.some(e => e.id === 'genspark')) errs.push('AI_SEARCH_CATALOG 里还有 genspark');
    } else {
      for (const n of ["id: 'serper'", "id: 'tavily'"]) if (!searchRaw.includes(n)) errs.push('AI_SEARCH_CATALOG 缺 ' + n);
      if (searchRaw.includes("'genspark'")) errs.push('AI_SEARCH_CATALOG 里还有 genspark');
    }
  }
  for (const n of [
    'getAiProviders: function () { return AI_CATALOG; }',
    'getAiSearchProviders: function () { return AI_SEARCH_CATALOG; }',
    'getAiMediaProviders: function () { return AI_MEDIA_CATALOG; }',
    // AiMediaPane 的门槛：!settings.media || !settings.search 就 return null → 默认形状必须齐
    'media: defaultAiMediaSettings(), search: defaultAiSearchSettings()',
    "if (!o.provider || o.provider === 'genspark' || o.provider === 'codex') { o.provider = 'glm'; }",
    // 生图 / 媒体理解是真实现（不是降级桩）：端点、响应解析、三个桥键都挂在 base mock 上
    "var url = ep.base + '/images/generations';",
    'function aiPickImagePayload(j)',
    'function aiAnalyzeMedia(op)',
    'generateImage: aiGenerateImage,',
    'aiGenerateImage: aiGenerateImage,',
    'analyzeMedia: aiAnalyzeMedia,',
    // 「第三方集成」桥必须经 wrapShellBridge（裸对象赋值 = 上游 status() 取到 undefined 就空白）
    "window.aiOfficeIntegrations = wrapShellBridge('aiOfficeIntegrations', {",
    "status: 'unsupported',",
  ]) {
    if (!idx.includes(n)) errs.push('Index.ets 缺: ' + n);
  }
  // 两处 AI 设置（PROMISE_SHIM 与 SHELL_BRIDGE 各一份）都得改：漏一份 = 另一份继续给老形状
  const defCount = idx.split('function defaultAiMediaSettings()').length - 1;
  if (defCount < 2) errs.push('defaultAiMediaSettings 只出现 ' + defCount + ' 次（PROMISE_SHIM 与 SHELL_BRIDGE 需要各一份）');
  if (idx.includes('gskToolsEnabled: true')) errs.push('还在写 gskToolsEnabled: true（Genspark 云工具开关应随账号体系一并移除）');
  if (idx.includes('aiGenerateImageUnavailable')) errs.push('aiGenerateImageUnavailable 仍在（生图已改为真实通道，降级桩该删净）');
  // media 目录**绝不能为空**：上游写的是 `options.find(...) ?? options[0]!` 然后读 meta.id ——
  // TS 的 ! 是非空断言、运行时不检查，空数组一点即崩（批次 E 首版就是返回 [] 被真机报回，
  // 而当时给这条写的反例还把"空目录"当合法态 → 反例设计漏洞）。三个能力区块的过滤条件不同，
  // 必须**各自**都至少有一条命中，缺任一块就崩在那一块上。
  const mediaRaw = sliceArray(idx, 'var AI_MEDIA_CATALOG = [');
  if (!mediaRaw) {
    errs.push('找不到 var AI_MEDIA_CATALOG（旧格式 [ 或新格式 /*gen:ai-media-catalog*/）');
  } else {
    let mediaEntries = null;
    try { mediaEntries = JSON.parse(mediaRaw); } catch (e) { /* 旧格式 */ }
    if (mediaEntries) {
      // 新格式：JSON 数据
      if (mediaEntries.length < 2) errs.push('AI_MEDIA_CATALOG 条目数 <2');
      if (!mediaEntries.some(e => e.imageProtocol)) errs.push('没有任何条目带 imageProtocol → 生图区块过滤为空 → 崩');
      if (!mediaEntries.some(e => e.analysisProtocol)) errs.push('没有任何条目带 analysisProtocol → 图片理解区块过滤为空 → 崩');
      if (!mediaEntries.some(e => e.analysisProtocol && e.videoAnalysis === true)) errs.push('需要某一条目同时带 analysisProtocol 与 videoAnalysis: true');
    } else {
      // 旧格式：字符串匹配
      if ((mediaRaw.match(/id: '/g) || []).length < 2) errs.push('AI_MEDIA_CATALOG 条目数 <2');
      const blocks = mediaRaw.split('    {').slice(1);
      if (!blocks.some((b) => b.includes('imageProtocol:'))) errs.push('没有任何条目带 imageProtocol: → 生图区块过滤为空 → 崩');
      if (!blocks.some((b) => b.includes('analysisProtocol:'))) errs.push('没有任何条目带 analysisProtocol: → 图片理解区块过滤为空 → 崩');
      if (!blocks.some((b) => b.includes('analysisProtocol:') && b.includes('videoAnalysis: true'))) errs.push('需要某一条目同时带 analysisProtocol 与 videoAnalysis: true');
    }
  }
  if (errs.length) throw new Error(errs.slice(0, 8).join('; '));
  return 'AI 目录无 Genspark、端点全开自定义、media 目录非空且三能力区块各 ≥1、生图/理解/集成桥接线在';
}

/**
 * 批次 E-7：「AI 模型」里已配好的模型，在生图 / 解析里直接可用。
 * 四方对账 —— 目录（SHELL_BRIDGE）× 默认模型表（PROMISE_SHIM）× 壳侧复用逻辑 × 渲染层下拉 × i18n：
 *   ① 壳侧必须按**同一 vendor id** 复用 Key/端点（不能按"当前选中的聊天供应商"：那是别的厂商的 Key）
 *   ② 生图模型不得跨厂商继承聊天模型（聊天模型 id 在 /images/generations 上不存在），
 *      但可以继承"该供应商自己的官方默认生图模型"（上游 byokModel 的语义）
 *   ③ 媒体目录里出现过的每一家，默认模型 / 端点两处表必须逐家相等（两个脚本作用域各一份，最易漂移）
 *   ④ i18n：20 个语块各有 setAiReuseModelHint，且**文案不能串行**（本轮真踩过：插到多行值中间，
 *      文案挂到了 setAiSharedKeyHint 名下 —— tsc 只报语法错，语义错位得靠这条断言）
 */
function checkAiMediaReuse() {
  const idx = readFileSync(resolve(__dirname, '..', 'entry/src/main/ets/pages/Index.ets'), 'utf8');
  const shellSrc = resolve(__dirname, '..', '..', 'apps/shell/src/renderer/src/SettingsModal.tsx');
  const stringsSrc = resolve(__dirname, '..', '..', 'apps/shell/src/renderer/src/strings.ts');
  const modal = readFileSync(shellSrc, 'utf8');
  const strings = readFileSync(stringsSrc, 'utf8');
  const errs = [];

  for (const n of [
    // ① 同供应商复用
    'function aiVendorChatConfig(s, pid)',
    'var own = aiVendorChatConfig(s, pid);',
    'if (!key) { key = own.key; }',
    'if (!base) { base = own.base; }',
    // ② 生图不继承聊天模型；解析才走"聊天兜底"
    'model = cap === \'image\' ? AI_MEDIA_DEFAULT_IMAGE_MODEL[pid] : AI_MEDIA_DEFAULT_ANALYSIS_MODEL[pid];',
    "if (cap !== 'image' && (!model || !key || !base)) {",
    // 解析端点链：解析块 → 生图块 → 聊天
    'function aiMediaTarget(cap, needVideo)',
    "var chain = cap === 'video' ? ['video', 'image'] : ['analysis', 'image'];",
    "var target = aiMediaTarget(videos.length ? 'video' : 'analysis', !!videos.length);",
    // 「测试连接」用同一套复用规则（否则真机能打、测试说没填 Key）
    'var vpc = (vs && vs.providers && vs.providers[pid]) || {};',
    "if (!key) { key = String(vpc.apiKey || '').trim(); }",
    // 生图缺项要报"缺哪一项"
    "error: '生图未配置：缺 ' + miss.join(' / ')",
  ]) {
    if (!idx.includes(n)) errs.push('Index.ets 缺: ' + n);
  }

  // ③ 目录 × 两张默认模型表 × 两张端点表，逐家对账
  const declBody = (decl, close) => {
    // 新格式：var NAME = /*gen:xxx*/{json}/*gen:xxx*/; 或 /*gen:xxx*/[json]/*gen:xxx*/;
    const markerRe = new RegExp(decl.replace(/\s*[\[{]\s*$/, '').replace(/\s*=\s*/, '\\s*=\\s*') + '\\s*/\\*gen:([a-z-]+)\\*/');
    const markerM = markerRe.exec(idx);
    if (markerM) {
      const marker = markerM[1];
      const open = `/*gen:${marker}*/`;
      const closeM = `/*gen:${marker}*/`;
      const start = markerM.index + markerM[0].length;
      const end = idx.indexOf(closeM, start);
      if (end > 0) return idx.slice(start, end);
    }
    // 旧格式
    const start = idx.indexOf(decl);
    if (start < 0) return null;
    const end = idx.indexOf(close, start);
    return end < 0 ? null : idx.slice(start + decl.length, end);
  };
  const kvTable = (body) => {
    const out = {};
    if (!body) return out;
    // 尝试 JSON 解析（新格式）
    try {
      const parsed = JSON.parse(body);
      for (const [k, v] of Object.entries(parsed)) out[k] = String(v);
      return out;
    } catch (e) { /* 旧格式 */ }
    for (const m of body.matchAll(/([A-Za-z0-9_-]+):\s*'([^']*)'/g)) out[m[1]] = m[2];
    return out;
  };
  const mediaBase = kvTable(declBody('var AI_MEDIA_BASE = {', '};'));
  const mediaBaseDefaults = kvTable(declBody('var AI_MEDIA_BASE_DEFAULTS = {', '};'));
  const imgDefaults = kvTable(declBody('var AI_MEDIA_DEFAULT_IMAGE_MODEL = {', '};'));
  const anaDefaults = kvTable(declBody('var AI_MEDIA_DEFAULT_ANALYSIS_MODEL = {', '};'));
  const catBody = declBody('var AI_MEDIA_CATALOG = [', '\n  ];');
  if (!catBody) {
    errs.push('找不到 var AI_MEDIA_CATALOG（旧格式 [ 或新格式 /*gen:ai-media-catalog*/）');
  } else {
    // 尝试 JSON 解析（新格式），失败则按旧格式字符串匹配
    let entries = null;
    try {
      const parsed = JSON.parse(catBody);
      entries = parsed.map((e) => ({
        id: e.id || '',
        image: !!e.imageProtocol,
        analysis: !!e.analysisProtocol,
        video: e.videoAnalysis === true,
        imageModel: e.defaultImageModel || '',
        analysisModel: e.defaultAnalysisModel || '',
        base: e.defaultBaseUrl || '',
      })).filter((e) => e.id);
    } catch (e) { /* 旧格式 */ }
    if (!entries) {
      entries = catBody.split('    {').slice(1).map((b) => ({
        id: (b.match(/id: '([^']+)'/) || [])[1] || '',
        image: /imageProtocol:/.test(b),
        analysis: /analysisProtocol:/.test(b),
        video: /videoAnalysis: true/.test(b),
        imageModel: (b.match(/defaultImageModel: '([^']*)'/) || [])[1] || '',
        analysisModel: (b.match(/defaultAnalysisModel: '([^']*)'/) || [])[1] || '',
        base: (b.match(/defaultBaseUrl: '([^']*)'/) || [])[1] || '',
      })).filter((e) => e.id);
    }
    const ids = entries.map((e) => e.id);
    if (entries.length < 7) errs.push('AI_MEDIA_CATALOG 只有 ' + entries.length + ' 家（对齐上游 9 家去掉 genspark / minimax 后应为 7）');
    if (ids.includes('genspark')) errs.push('AI_MEDIA_CATALOG 里还有 genspark');
    if (ids.filter((id) => id === 'custom').length !== 1) errs.push('custom 条目缺失或重复');
    if (entries.filter((e) => e.image).length < 3) errs.push('能生图的供应商 <3（生图区块选择太少）');
    if (entries.filter((e) => e.analysis).length < 3) errs.push('能解析的供应商 <3（解析区块选择太少）');
    if (!entries.some((e) => e.analysis && e.video)) errs.push('没有同时满足 analysisProtocol + videoAnalysis 的条目（视频区块会空）');
    for (const e of entries) {
      if (e.image) {
        // custom 例外：它本来就没有官方端点，靠用户在设置里自己填（空 = 走渲染层校验提示，不是静默打空串）
        if (!e.base && e.id !== 'custom') errs.push(e.id + ': 能生图却没有 defaultBaseUrl（端点为空 = 请求打到空串）');
        if ((imgDefaults[e.id] || '') !== e.imageModel) {
          errs.push(e.id + ': 生图默认模型两处不一致（PROMISE_SHIM ' + JSON.stringify(imgDefaults[e.id] || '')
            + ' vs 目录 ' + JSON.stringify(e.imageModel) + '）');
        }
      } else if (imgDefaults[e.id]) {
        errs.push(e.id + ': 目录没给生图能力，PROMISE_SHIM 的默认生图模型表里却有值（该删）');
      }
      if (e.analysis && (anaDefaults[e.id] || '') !== e.analysisModel) {
        errs.push(e.id + ': 解析默认模型两处不一致（PROMISE_SHIM ' + JSON.stringify(anaDefaults[e.id] || '')
          + ' vs 目录 ' + JSON.stringify(e.analysisModel) + '）');
      }
      if (e.base && mediaBase[e.id] !== e.base) {
        errs.push(e.id + ': 端点两处不一致（PROMISE_SHIM ' + JSON.stringify(mediaBase[e.id] || '') + ' vs 目录 ' + JSON.stringify(e.base) + '）');
      }
      if (e.base && mediaBaseDefaults[e.id] !== e.base) {
        errs.push(e.id + ': 端点两处不一致（SHELL_BRIDGE ' + JSON.stringify(mediaBaseDefaults[e.id] || '') + ' vs 目录 ' + JSON.stringify(e.base) + '）');
      }
    }
    for (const id of Object.keys(imgDefaults)) {
      if (imgDefaults[id] && !ids.includes(id)) errs.push('默认生图模型表有孤儿键 ' + id + '（目录里没有这家）');
    }
  }

  // ④ 渲染层：下拉合并「AI 模型」已配置模型 + 空目录不再崩
  for (const n of [
    'const chatConfigOf = (id: AiMediaProviderId)',
    'const chat = chatConfigOf(id)',
    '? [...pool, ...chat.models.filter((m) => !pool.includes(m))]',
    ': [...chat.models, ...pool.filter((m) => !chat.models.includes(m))]',
    "t('setAiReuseModelHint')",
    'if (!meta) return null',
  ]) {
    if (!modal.includes(n)) errs.push('SettingsModal.tsx 缺: ' + n);
  }
  if (modal.includes('?? options[0]!')) errs.push('mediaBlock 仍用 options[0]! 裸解引用（空目录 = 整个设置弹窗崩）');

  // ⑤ i18n 20 语块，且两个键的文案不许串位
  const lines = strings.split('\n');
  const inlineOrNext = (i) => {
    const t = lines[i].trim();
    const after = t.slice(t.indexOf(':') + 1).trim();
    return after ? { v: after, end: i } : { v: (lines[i + 1] || '').trim(), end: i + 1 };
  };
  let pairs = 0, swapped = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('setAiSharedKeyHint:')) continue;
    const a = inlineOrNext(i);
    const j = a.end + 1;
    if (!lines[j] || !lines[j].trim().startsWith('setAiReuseModelHint:')) { swapped++; continue; }
    const b = inlineOrNext(j);
    pairs++;
    if (a.v.includes('/images/generations') || !b.v.includes('/images/generations')) swapped++;
    i = b.end;
  }
  if (pairs < 20) errs.push('setAiReuseModelHint 只配了 ' + pairs + ' 个语块（需 20）');
  if (swapped) errs.push('setAiSharedKeyHint / setAiReuseModelHint 文案错位 ' + swapped + ' 处');

  if (errs.length) throw new Error(errs.slice(0, 8).join('; '));
  return '同一供应商 Key/端点复用、生图不跨厂商继承模型、目录与默认模型/端点四表对账 ' + pairs + ' 语块文案不串位';
}

/**
 * 批次 E-8：设置分区的「唯一入口」约束。
 * 背景：「生图、媒体与搜索」原先既是独立分区、又整块内嵌在 AI 模型页里（同一组件渲染两次）——
 * 同一份配置两个入口，用户只会问"到底在哪填"。本轮删掉独立分区，只留内联那一份。删完有三处
 * 最容易「删一半」或「手滑加回来」，都在这里锁死：
 *   ① 分区三方一致：`SectionId` 联合类型 ↔ `SECTIONS` ↔ `SectionIcon` 的分支；
 *      联合类型多一个 = 深链能传进一个没有渲染分支的 id；图标分支多一个 = 删分区时忘删图标。
 *   ② 深链必须落在 SECTIONS 内：`useState<SectionId>(target.section)` 对**任何** id 都照收，
 *      但 `set-pane` 里没有对应分支 → **整个设置弹窗空白**，静默且致命。
 *      首页文件搜索的 Jev 按钮就是这样一个外部入口（曾经打 'aiMedia'）。
 *   ③ 内嵌的 AiMediaPane 必须透传 `onFileSearchChange` + `focusBlock`：漏前者 = 在 AI 模型页里改
 *      Jev 重排后首页不重判序（**改前就是这个潜伏 bug**：只有独立分区那份传了回调）；漏后者 =
 *      首页 Jev 深链不再滚动定位。删掉独立分区后这里成了唯一路径，所以必须锁。
 */
function checkSettingsSections() {
  const shellSrc = resolve(__dirname, '..', '..', 'apps/shell/src/renderer/src');
  const modal = readFileSync(resolve(shellSrc, 'SettingsModal.tsx'), 'utf8');
  const errs = [];

  const unionM = /export type SectionId = ([^\n]+)/.exec(modal);
  if (!unionM) {
    throw new Error('SettingsModal.tsx 里找不到 `export type SectionId`（被改名/挪走了？）');
  }
  const unionIds = (unionM[1].match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1));
  const navBody = modal.slice(modal.indexOf('const SECTIONS'), modal.indexOf('\n]', modal.indexOf('const SECTIONS')));
  const navIds = [...navBody.matchAll(/\{ id: '([^']+)', labelKey: '([^']+)' \}/g)].map((m) => m[1]);
  if (!navIds.length) errs.push('SECTIONS 里一条都没解析出来（结构变了？）');
  if (navIds.join('|') !== unionIds.join('|')) {
    errs.push('SectionId 与 SECTIONS 不一致：type=[' + unionIds.join(',') + '] nav=[' + navIds.join(',') + ']');
  }

  // ① 图标分支：多一个（死分支）或漏一个（about 靠兜底 return）都说明改漏
  const iconBody = modal.slice(modal.indexOf('function SectionIcon('), modal.indexOf('\n}', modal.indexOf('function SectionIcon(')));
  const iconIds = [...new Set([...iconBody.matchAll(/if \(id === '([^']+)'\)/g)].map((m) => m[1]))];
  for (const id of iconIds) {
    if (!navIds.includes(id)) errs.push('SectionIcon 有死分支 id=' + id + '（分区已删，图标没删）');
  }
  if (navIds.length - iconIds.length > 1) {
    errs.push('SectionIcon 缺分支：分区 ' + navIds.length + ' 个 / 显式图标 ' + iconIds.length + ' 个');
  }

  // ② 深链：renderer 下所有 `section: '<id>'` 必须落在 SECTIONS 内
  const rendererRoot = resolve(__dirname, '..', '..', 'apps/shell/src/renderer');
  const walk = (dir) => {
    const out = [];
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'dist' || ent.name === 'node_modules') continue;
      const p = resolve(dir, ent.name);
      if (ent.isDirectory()) out.push(...walk(p));
      else if (/\.tsx?$/.test(ent.name)) out.push(p);
    }
    return out;
  };
  let deepLinks = 0;
  for (const f of walk(rendererRoot)) {
    // 先剥注释：注释里提一句「改打 { section: 'aiModel' }」不该被当成深链（否则门禁开始咬注释）
    const src = readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const m of src.matchAll(/section:\s*'([^']+)'/g)) {
      deepLinks++;
      if (!navIds.includes(m[1])) {
        errs.push(f.replace(rendererRoot + '/', '') + ' 的深链 section: ' + m[1] + ' 不在 SECTIONS 内（打开设置会白屏）');
      }
    }
  }
  if (!deepLinks) errs.push('渲染层一个 `section: <id>` 深链都没找到（检查方式失效了？）');

  // 「生图、媒体与搜索」不得再作为独立分区复活
  if (navIds.includes('aiMedia')) errs.push('SECTIONS 里又有 aiMedia 独立分区（应只保留 AI 模型页内嵌那一份）');

  // ③ 单一入口 + 两个入参透传
  const paneCalls = [...modal.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/<AiMediaPane[\s\S]{0,220}?\/>/g)].map((m) => m[0]);
  if (paneCalls.length !== 1) errs.push('AiMediaPane 有 ' + paneCalls.length + ' 个渲染点（应为 1：内嵌在 AI 模型页里）');
  const call = paneCalls[0] || '';
  if (!call.includes('onFileSearchChange={onFileSearchChange}')) {
    errs.push('内嵌的 AiMediaPane 没透传 onFileSearchChange（改 Jev 重排后首页不会重判序）');
  }
  if (!call.includes('focusBlock={focusBlock}')) {
    errs.push('内嵌的 AiMediaPane 没透传 focusBlock（首页 Jev 深链不再定位）');
  }
  if (!/function AiModelPane\(\{[\s\S]{0,200}?focusBlock,\n\}: \{\n  t: TFunc\n  onFileSearchChange\?: \(\) => void\n  focusBlock\?: TestedBlock\n\}\) \{/.test(modal)) {
    errs.push('AiModelPane 没有接收 onFileSearchChange / focusBlock 两个入参（无法透传给内嵌面板）');
  }

  if (errs.length) throw new Error(errs.slice(0, 8).join('; '));
  return '分区 ' + navIds.length + ' 个三方一致、' + deepLinks + ' 处深链全落在分区表内、AiMediaPane 单入口且入参透传';
}

/** AI 通道：OpenAI 兼容 + Anthropic 双协议，挂在 base mock 上（所有 app 共享），带原生兜底 */
function checkAiProtocolChannel() {
  const idx = readFileSync(resolve(__dirname, '..', 'entry/src/main/ets/pages/Index.ets'), 'utf8');
  const bridge = readFileSync(resolve(__dirname, '..', 'entry/src/main/ets/bridge/DesktopBridge.ets'), 'utf8');
  const errs = [];
  for (const n of [
    'function aiProtocolFor(pid, base)',
    'function aiPushAnthropic(list, m)',
    'function aiPushOpenAi(list, m)',
    "h['x-api-key'] = ep.key;",
    "h['anthropic-version'] = AI_ANTHROPIC_VERSION;",
    "ep.protocol === 'anthropic' ? ep.base + '/messages' : ep.base + '/chat/completions'",
    'function aiStreamNative(requestId, ep, req)',
    // 工具 schema 字段是 inputSchema（读 parameters 会让工具描述恒空 → 模型不会调工具）
    't.inputSchema || t.parameters',
    // AgentImage 契约是 base64 + mime；两种形状都要收（旧实现只读 dataUrl → 图被静默丢掉）
    'img.base64 || img.b64',
  ]) {
    if (!idx.includes(n)) errs.push('Index.ets 缺: ' + n);
  }
  // 通道必须在 base mock 上，且 pdfMock 不得再自带一份（Object.assign 会静默覆盖 base）
  for (const n of [
    'aiStream: function (req) { return aiStreamRun(req); }',
    'onAiStream: function (fn) { return aiOnStream(fn); }',
    'aiStreamCancel: function (requestId) { return aiStreamCancel(requestId); }',
  ]) {
    if (!idx.includes(n)) errs.push('base mock 缺共享 AI 通道接线: ' + n);
  }
  const dup = idx.split('aiStream: function (req)').length - 1;
  if (dup !== 1) errs.push('aiStream 实现出现 ' + dup + ' 份（应为 1 份挂在 base；pdfMock 重复定义会静默覆盖 base）');
  if (idx.includes('pdfAiStreamListeners')) errs.push('还在用 pdfAiStreamListeners（通道已提到共享层，应叫 aiStreamListeners）');
  for (const n of [
    "register('aiPostJson'",
    'async aiPostJson(url: string, headersJson: string, bodyJson: string): Promise<string>',
    "target.startsWith('https://')",
    "target.startsWith('http://127.0.0.1')",
    'https://google.serper.dev/search',
    'https://google.serper.dev/images',
    'https://api.tavily.com/search',
  ]) {
    if (!bridge.includes(n)) errs.push('DesktopBridge.ets 缺: ' + n);
  }
  // 旧的 DDG 抓取必须整体下线（非官方端点 + 与 DDG 条款冲突）。只查可执行形态，
  // 注释里保留"过去抓 DDG"的历史说明是有意为之（防止有人再把它加回来时不知道曾经的取舍）。
  for (const bad of ['html.duckduckgo', 'duckduckgo.com/i.js', 'parseDdgWebResults', 'decodeDdgHref']) {
    if (bridge.includes(bad)) errs.push('DesktopBridge.ets 里还残留 ' + bad + '（DDG 抓取应删净）');
  }
  // Key 在 localStorage，原生读不到 → 搜索调用必须把 opts 带下去
  const optCalls = idx.split('aiSearchOptsJson()').length - 1;
  if (optCalls < 2) errs.push('aiSearchOptsJson() 只被调用 ' + optCalls + ' 次（webSearch 与 imageSearch 都要带第 3 个参数）');
  // 原生 POST 通道有**三个**消费者：流式被 CORS 拦的兜底、生图、图片理解。
  // 只按 includes 判定会让"删掉其中一个"逃过门禁（反例实测：replace 只命中第一处，仍绿）。
  const nativeCalls = (idx.match(/goJson\('aiPostJson'/g) || []).length;
  if (nativeCalls < 3) errs.push('goJson(\'aiPostJson\' 只出现 ' + nativeCalls + ' 次（兜底/生图/理解各一处）');
  if (errs.length) throw new Error(errs.slice(0, 8).join('; '));
  return '双协议 AI 通道挂在 base mock（1 份实现）+ 原生兜底 aiPostJson + Serper/Tavily 搜索，无 DDG 残留';
}

/** Genspark 登录链在渲染层拆净，但壳侧桥保留 no-op（其它 app 仍可能判存在性）*/
function checkGensparkLoginRemoved() {
  const shellDir = resolve(__dirname, '..', '..', 'apps/shell/src/renderer/src');
  const home = readFileSync(resolve(shellDir, 'Home.tsx'), 'utf8');
  const settings = readFileSync(resolve(shellDir, 'SettingsModal.tsx'), 'utf8');
  const idx = readFileSync(resolve(__dirname, '..', 'entry/src/main/ets/pages/Index.ets'), 'utf8');
  const errs = [];
  for (const [src, name] of [[home, 'Home.tsx'], [settings, 'SettingsModal.tsx']]) {
    for (const bad of ['loginGenspark', 'accountLogin(', 'onAccountLogin', 'startLogin', 'LOGIN_POLL_MS']) {
      if (src.includes(bad)) errs.push(name + ' 里还有 ' + bad);
    }
  }
  for (const bad of ["'account'", 'setSecAccount', 'loginWaiting', 'onCopyLoginUrl', 'openCreditUsage']) {
    if (settings.includes(bad)) errs.push('SettingsModal.tsx 里还有 ' + bad + '（账户分区应整体移除）');
  }
  if (!home.includes("data-tip={t('settings')}")) errs.push("起始页入口未改名为「设置」（缺 data-tip={t('settings')}）");

  if (!home.includes("aria-label={t('settings')}")) errs.push('起始页入口缺 aria-label={t(\'settings\')}');
  // 桥侧保留 no-op：删掉实现会让"其它 app 调 accountStatus"从 undefined 变 TypeError
  for (const n of [
    'accountStatus: function () { return Promise.resolve({ loggedIn: false }); }',
    'accountLogin: function () { return Promise.resolve(false); }',
  ]) {
    if (!idx.includes(n)) errs.push('Index.ets 缺 no-op 兜底: ' + n);
  }
  if (errs.length) throw new Error(errs.slice(0, 8).join('; '));
  return '渲染层登录链拆净 + 入口改名「设置」+ 壳桥保留 no-op（防 undefined 崩）';
}

/** Apache-2.0 第 4 条材料必须**随包且在包内可见**：文本进 rawfile + 起始页有入口 */
function checkLegalNotices() {
  const legalDir = resolve(__dirname, '..', 'entry/src/main/resources/rawfile/web/legal');
  const need = ['LICENSE.txt', 'NOTICE.txt', 'THIRD-PARTY-NOTICES.txt', 'LICENSE-UNICODE.txt', 'CHANGELOG-NOTICE.txt'];
  const errs = [];
  for (const f of need) {
    const p = resolve(legalDir, f);
    if (!existsSync(p)) { errs.push('缺 ' + f + '（跑 node scripts/gen-legal-notices.mjs）'); continue; }
    const size = statSync(p).size;
    if (size < 800) errs.push(f + ' 只有 ' + size + ' 字节，疑似截断');
  }
  if (!errs.length) {
    const license = readFileSync(resolve(legalDir, 'LICENSE.txt'), 'utf8');
    const notices = readFileSync(resolve(legalDir, 'THIRD-PARTY-NOTICES.txt'), 'utf8');
    const changed = readFileSync(resolve(legalDir, 'CHANGELOG-NOTICE.txt'), 'utf8');
    if (!/Apache License/.test(license)) errs.push('LICENSE.txt 不像 Apache-2.0 正文');
    if (!/Mainfunc/.test(notices)) errs.push('THIRD-PARTY-NOTICES.txt 未保留上游版权方（Mainfunc, Inc.）');
    if (!/商标/.test(notices)) errs.push('THIRD-PARTY-NOTICES.txt 未声明商标不授予（Apache-2.0 第 6 条）');
    const entries = notices.split('\n').filter((l) => /^(@[\w.-]+\/[\w.-]+|[\w][\w.-]*)@/.test(l)).length;
    if (entries < 100) errs.push('第三方清单只有 ' + entries + ' 条，疑似生成器退化（历史量级 500+）');
    if (!changed.includes('Genspark')) errs.push('CHANGELOG-NOTICE.txt 未记录移除项（第 4(b) 条要求说明修改）');
  }
  const idx = readFileSync(resolve(__dirname, '..', 'entry/src/main/ets/pages/Index.ets'), 'utf8');
  for (const n of ['function dialogLegal()', "label: '开源许可'", "resource://rawfile/web/legal/"]) {
    if (!idx.includes(n)) errs.push('Index.ets 缺许可入口: ' + n);
  }
  if (!existsSync(resolve(__dirname, 'gen-legal-notices.mjs'))) errs.push('缺 scripts/gen-legal-notices.mjs');
  if (errs.length) throw new Error(errs.slice(0, 8).join('; '));
  return '许可五件套在 rawfile/web/legal + 起始页「开源许可」入口 + 清单条目数在量级内';
}

// ========== 阶段 C：关 tab 未保存守卫（行为测试） ==========
// 真机症状：新建任意 app、随便编辑、直接关标签 → 不弹保存提示。三条通道都要真跑一遍：
//   1) push：app frame 的 setDirty / notifyPendingEdits → 壳读 contentWindow.__goFrameDirty
//   2) query：docs 的 onCloseCheck 回调 → 壳同步调用 → reportCloseCheck 回填
//   3) 「保存并关闭」：onCloseSaveRequest 结果回写后才关 tab（失败必须保留 tab）
// 只做源码 grep 拦不住「接线看着在、行为已死」（Excel notifyPendingEdits 被同名键覆盖）。
function makeGuardDoc(parentWin) {
  const byId = new Map();
  const appended = [];
  const iframes = [];
  function el(tag) {
    const e = {
      tagName: tag,
      style: { cssText: '' },
      children: [],
      textContent: '',
      onclick: null,
      removed: false,
      appendChild(c) {
        this.children.push(c);
        if (c && c.tagName === 'iframe') {
          // contentWindow = 壳看到的代理（opaque：读属性必抛）；shim 跑在 _realWin 上
          c._realWin = makeFrameWin(parentWin);
          c._proxyWin = makeOpaqueChild(c._realWin, parentWin);
          c.contentWindow = c._proxyWin;
          iframes.push(c);
        }
        return c;
      },
      remove() { this.removed = true; },
      addEventListener() {},
      contains() { return false; },
    };
    Object.defineProperty(e, 'id', {
      get() { return this._id || ''; },
      set(v) { this._id = v; byId.set(v, this); },
    });
    return e;
  }
  const body = {
    tagName: 'body',
    children: [],
    appendChild(c) { this.children.push(c); appended.push(c); return c; },
  };
  return {
    createElement: el,
    body,
    documentElement: { appendChild() {} },
    getElementById: (id) => byId.get(id) || null,
    addEventListener() {},
    removeEventListener() {},
    baseURI: 'resource://rawfile/web/shell/index.html',
    _appended: appended,
    _iframes: iframes,
  };
}

async function closeGuardBehaviorTests() {
  const rep = { pass: 0, fail: 0, skipped: 0, errors: [] };
  const check = (name, ok, detail) => {
    if (ok) { rep.pass++; return; }
    rep.fail++;
    rep.errors.push({ name, args: [], error: String(detail === undefined ? 'assert failed' : detail) });
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 注入脚本里的 `console` 是自由变量，解析到 Node 全局而不是 window.console，
  // 所以诊断锚点断言要临时接管全局 console.info，并用下标切片把日志归因到具体动作。
  const captured = [];
  const origInfo = console.info;
  console.info = (s) => { captured.push(String(s)); };
  const seen = (from, pred) => captured.slice(from).some(pred);

  const win = makeWin();
  const doc = makeGuardDoc(win);
  win.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
  win.atob = (s) => Buffer.from(s, 'base64').toString('binary');
  installArkTs(win);
  try {
    const run = (js) => new Function('window', 'document', 'localStorage', 'navigator', 'TextEncoder',
      'btoa', 'atob', 'XMLHttpRequest', 'fetch', js)
      .call({}, win, doc, win.localStorage, win.navigator, TextEncoder, win.btoa, win.atob, win.XMLHttpRequest, win.fetch);
    run(shim);
    run(shell);
  } catch (e) {
    console.info = origInfo;
    check('C0. guard 沙箱（shim+shell）启动不抛', false, e && e.message ? e.message : String(e));
    return rep;
  }
  const overlays = () => doc._appended.filter((e) => String((e.style || {}).cssText || '').includes('2147483001') && !e.removed);
  const overlay = () => overlays().pop() || null;
  const clickBtn = (ov, label) => {
    if (!ov) { return false; }
    const row = ov.children[0] && ov.children[0].children[1];
    const b = row && row.children.find((x) => x.textContent === label);
    if (!b) { return false; }
    b.onclick({ stopPropagation() {} });
    return true;
  };
  const dismiss = () => clickBtn(overlay(), '不保存');
  const tabIds = async () => (await win.aiOfficeTabs.list()).map((t) => t.id);
  const openTab = async (kind) => {
    if (kind === 'pdf') { await win.aiOffice.newPdf(); }
    else if (kind === 'docs') { await win.aiOffice.newDoc(); }
    else if (kind === 'sheets') { await win.aiOffice.newSheet(); }
    else { await win.aiOffice.newMarkdown(); }
    const list = await win.aiOfficeTabs.list();
    const id = list[list.length - 1].id;
    const frame = doc._iframes[doc._iframes.length - 1];
    runShimOn(frame._realWin);
    // win=真实 frame 环境（app 侧 API 调用）；proxy=壳看到的窗口（opaque，属性读必抛）
    return { id, win: frame._realWin, proxy: frame._proxyWin, frame };
  };

  // 1) push 通道（pdf/markdown/slides 走 setDirty）
  {
    const t = await openTab('pdf');
    const n0 = captured.length;
    t.win.pdfApi.setDirty(true);
    check('C1. pdf setDirty(true) → frame 内 __goFrameDirty=true', t.win.__goFrameDirty === true, String(t.win.__goFrameDirty));
    check('C2. app frame 侧诊断锚点（frame dirty=true）',
      seen(n0, (s) => s.includes('frame dirty=true')), captured.slice(n0).join(' | '));
    await win.aiOfficeTabs.close(t.id);
    check('C3. 关有改动的 tab → 弹未保存确认', !!overlay(), captured.slice(n0).join(' | '));
    check('C4. 弹窗期间 tab 未静默关闭', (await tabIds()).includes(t.id));
    clickBtn(overlay(), '取消');
    check('C5. 取消 → tab 保留', (await tabIds()).includes(t.id));
    await win.aiOfficeTabs.close(t.id);
    clickBtn(overlay(), '不保存');
    check('C6. 不保存 → tab 关闭', !(await tabIds()).includes(t.id));
    check('C7. 壳侧诊断锚点（closeTab … dirty=true）',
      seen(n0, (s) => s.includes('closeTab') && s.includes('dirty=true')), captured.slice(n0).join(' | '));
  }

  // 2) 查询式通道（docs）
  {
    const t = await openTab('docs');
    t.win.desktop.onCloseCheck(() => t.win.desktop.reportCloseCheck({ dirty: true }));
    check('C8. docs onCloseCheck 回调登记到 frame', typeof t.win.__goCloseCheckHandler === 'function');
    await win.aiOfficeTabs.close(t.id);
    check('C9. docs 查询式协议 → 弹未保存确认', !!overlay());
    dismiss();
  }

  // 3) sheets 的 pending-edits 通道（曾被同名键 no-op 覆盖 → 本用例专门拦它）
  {
    const t = await openTab('sheets');
    const n1 = captured.length;
    t.win.desktopApi.notifyPendingEdits(3);
    check('C10. sheets notifyPendingEdits(3) → __goFrameDirty=true', t.win.__goFrameDirty === true, String(t.win.__goFrameDirty));
    check('C11. sheets 诊断锚点（frame dirty=true pending=3）',
      seen(n1, (s) => s.includes('frame dirty=true') && s.includes('pending=3')), captured.slice(n1).join(' | '));
    await win.aiOfficeTabs.close(t.id);
    check('C12. Excel 有未保存改动 → 弹未保存确认', !!overlay());
    dismiss();
  }

  // 4) 干净 tab 直接关闭（不弹窗）
  {
    const t = await openTab('markdown');
    await win.aiOfficeTabs.close(t.id);
    check('C13. 无改动的 tab → 直接关闭且不弹窗', overlays().length === 0 && !(await tabIds()).includes(t.id));
  }

  // 5) 「保存并关闭」走 app 保存协议
  {
    const t = await openTab('pdf');
    t.win.pdfApi.setDirty(true);
    t.win.pdfApi.onCloseSaveRequest(() => t.win.pdfApi.sendCloseSaveResult(true));
    check('C14. pdf onCloseSaveRequest 登记到 frame（__goCloseSaveHandler）', typeof t.win.__goCloseSaveHandler === 'function');
    await win.aiOfficeTabs.close(t.id);
    clickBtn(overlay(), '保存并关闭');
    await sleep(400);
    check('C15. 保存成功 → 关闭 tab', !(await tabIds()).includes(t.id));
  }

  // 6) 保存失败/取消 → 保留 tab（不许假关闭）
  {
    const t = await openTab('pdf');
    t.win.pdfApi.setDirty(true);
    t.win.pdfApi.onCloseSaveRequest(() => t.win.pdfApi.sendCloseSaveResult(false));
    await win.aiOfficeTabs.close(t.id);
    clickBtn(overlay(), '保存并关闭');
    await sleep(400);
    check('C16. 保存失败 → 保留 tab', (await tabIds()).includes(t.id));
    dismiss();
  }

  // 7) PDF→Office 转换入口契约（BUG#3 回归）：非法格式/空路径必须回 {ok:false,error}。
  //    当时的根因正是「壳侧没这个方法 → Proxy 兜底 resolve(undefined) → 渲染层无从上报」，
  //    所以这里断言的形状是「宁可失败也要有结构」，undefined/false 都算失败。
  {
    const t = await openTab('pdf');
    const badFmt = await t.win.pdfApi.convertOffice('png', '/x.pdf');
    check('C17. convertOffice 非法格式 → {ok:false,error}',
      !!(badFmt && badFmt.ok === false && badFmt.error), JSON.stringify(badFmt));
    const noPath = await t.win.pdfApi.convertOffice('docx', '');
    check('C18. convertOffice 空路径 → {ok:false,error}',
      !!(noPath && noPath.ok === false && noPath.error), JSON.stringify(noPath));
    await win.aiOfficeTabs.close(t.id);
    if (overlay()) dismiss();
  }

  // 8) 真机隔离下的守卫（opaque origin）：壳读不到子 frame 任何属性，只有 postMessage 通道。
  //    真机 BUG「新建文件编辑后关标签静默关闭」的根因就是同步读恒抛 → dirty=false，
  //    所以下面每组断言都必须先确认「同步读确实不可用」，再确认守卫仍然生效。
  {
    const t = await openTab('pdf');
    let threw = false;
    try { void t.proxy.__goFrameDirty; } catch (e) { threw = /Security/i.test(String(e && e.message)); }
    check('C19. 沙箱按真机隔离（contentWindow 属性读抛 SecurityError）', threw,
      '代理未模拟 opaque origin，postMessage 通道未被真实覆盖');

    const n2 = captured.length;
    t.win.pdfApi.setDirty(true);
    await sleep(20);
    check('C20. app frame push → 壳 dirty 缓存（postMessage 到达顶层）',
      seen(n2, (s) => s.includes('dirty push ' + t.id + '=true')), captured.slice(n2).join(' | '));
    await win.aiOfficeTabs.close(t.id);
    check('C21. 同步读不可用时仍弹未保存确认（真机 BUG 回归）', !!overlay(), captured.slice(n2).join(' | '));
    check('C22. 壳侧锚点：closeTab dirty=true（无内容丢失去向）',
      seen(n2, (s) => s.includes('closeTab') && s.includes('dirty=true')), captured.slice(n2).join(' | '));
    dismiss();
  }

  // 9) 「保存并关闭」在隔离下走 postMessage 协议（壳拿不到 handler，必须让 frame 自己跑）
  {
    const t = await openTab('pdf');
    t.win.pdfApi.setDirty(true);
    t.win.pdfApi.onCloseSaveRequest(() => t.win.pdfApi.sendCloseSaveResult(true));
    await sleep(20);
    const n3 = captured.length;
    await win.aiOfficeTabs.close(t.id);
    check('C23. 隔离下仍弹确认', !!overlay(), captured.slice(n3).join(' | '));
    clickBtn(overlay(), '保存并关闭');
    await sleep(500);
    check('C24. 保存协议经 postMessage 执行成功 → 关闭 tab',
      !(await tabIds()).includes(t.id), captured.slice(n3).join(' | '));
    check('C25. 壳侧锚点：protocolHandler=false（读不到 frame handler，走消息通道）',
      seen(n3, (s) => s.includes('closeSave trigger') && s.includes('protocolHandler=false')),
      captured.slice(n3).join(' | '));
  }

  // 10) 隔离下干净 tab 仍要直接关闭（消息往返不能变成「永远弹窗」）
  {
    const t = await openTab('markdown');
    const before = overlays().length;
    await win.aiOfficeTabs.close(t.id);
    check('C26. 隔离下无改动 tab → 直接关闭且不弹窗',
      overlays().length === before && !(await tabIds()).includes(t.id));
  }
  console.info = origInfo;
  return rep;
}

/** rawfile bundle → base64（PPT-M1 端到端 data-import 用；与真机 readRawFileJson 同编码）。 */
function bridgeB64FromRaw(path) {
  return Buffer.from(readFileSync(path)).toString('base64');
}

/** base64 → Uint8Array（M6 图片填充/背景字节夹具用）。 */
function base64ToBytesForVerify(b64) {
  const bin = Buffer.from(b64, 'base64');
  return new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength);
}

function installArkTs(win) {
  win.desktop = makeNative();
  // 真实注入名（nativeBridge 优先走这里）；与 win.desktop 同实现即可
  win.desktopNative = win.desktop;
  const bridgeRaw = readFileSync(resolve(__dirname, '..', 'entry/src/main/resources/rawfile/web/pptx-bridge.mjs'));
  const bridgeB64 = Buffer.from(bridgeRaw).toString('base64');
  win.nativeBridge = {
    goNative: async (n) => {
      if (n === 'testAiConnection') return JSON.stringify({ok:true});
      if (n === 'pickDirectory') return JSON.stringify({ok:true,uri:'file://docs/storage/Users/x/Documents'});
      return JSON.stringify({ok:false,error:'mock not impl: '+n});
    },
    goJson: async (n) => {
      if (n === 'openFileJson') return JSON.stringify({ok:true,path:'file://z.pptx',name:'z.pptx',ext:'pptx',b64:'AAAA',hash:'h2'});
      // readRawFileJson 返回真实 bundle（缓存的真机路径一致）：Stage A 的 openPptx
      // 会真实走一次 data-import → openPptxFile（b64='AAAA' 无效字节，解析返回 null，
      // 但 import 路径被真实执行，语法/导出错误都能在 verify 暴露）。
      if (n === 'readRawFileJson') return JSON.stringify({ok:true, b64: bridgeB64});
      // Excel 保存/另存为：大编辑集分块 → save(transferId) 归一化后的写盘 mock
      if (n === 'xlsSaveEditsJson' || n === 'xlsSaveAsEditsJson') {
        try {
          const payload = JSON.parse(args[0] || '{}');
          const count = Array.isArray(payload.normalizedEdits) ? payload.normalizedEdits.length : 0;
          return JSON.stringify({ ok: true, file: { sessionId: payload.sessionId || 'saved-x', count } });
        } catch (e) {
          return JSON.stringify({ ok: false, error: 'bad save payload ' + e.message });
        }
      }
      return JSON.stringify({ok:false,error:'mock not impl: '+n});
    },
  };
}

// ========== 阶段 A：烟雾测试（每个桥每个方法调一次） ==========
async function smokeTests(win) {
  const report = { pass: 0, fail: 0, errors: [], skipped: 0, byBridge: {}, notes: [] };

  // 注入脚本语法门禁：转义还原后必须可被 JS 解析（真机上 SyntaxError 会导致
  // window.aiOffice/desktop 全部缺失 → shell getLanguage 白屏）
  for (const [name, js] of [['PROMISE_SHIM', shim], ['SHELL_BRIDGE', shell], ['ERR_COLLECTOR', errCollector]]) {
    try { new Function('window', 'document', 'localStorage', 'navigator', js); report.pass++; }
    catch (e) {
      report.fail++;
      report.errors.push({ name: `InjectSyntax.${name}`, args: [], error: 'SyntaxError: ' + (e.message || e) });
    }
  }

  // 桥注册门禁：Index.ets javaScriptProxy 的 methodList/asyncMethodList 必须与
  // DesktopBridge/ProjectApi 方法签名的 async 属性一致。async 方法只塞 methodList
  // 时 ArkWeb 不注入 → 真机报 "non-injected object"（打开文件/测试连接/选目录全挂）。
  try {
    checkBridgeRegistration();
    report.pass++;
  } catch (e) {
    report.fail++;
    report.errors.push({ name: 'BridgeRegistration', args: [], error: e.message });
  }

  // PDF bootBlank 门禁：磁贴直开必须自动新建空白 PDF（对齐 Word/Excel），失败回退空态
  try {
    checkPdfBootBlank();
    report.pass++;
  } catch (e) {
    report.fail++;
    report.errors.push({ name: 'PdfBootBlank', args: [], error: e.message });
  }

  // PDF 插入图章门禁：对话框/落章通道/i18n/rawfile 产物齐全（改名或漏同步 → 真机静默失效）
  try {
    checkPdfInsertStamp();
    report.pass++;
  } catch (e) {
    report.fail++;
    report.errors.push({ name: 'PdfInsertStamp', args: [], error: e.message });
  }

  // PDF 壳桥接线门禁：pdfMock 方法面与 pdf-bridge 接线完整（改名/断线 → 真机静默失效）
  try {
    checkPdfBridgeWiring();
    report.pass++;
  } catch (e) {
    report.fail++;
    report.errors.push({ name: 'PdfBridgeWiring', args: [], error: e.message });
  }

  // PDF 插入文字门禁：text-insert.ts + entry.ts 再导出 + save-pdf.ts 不再走 skipped 字面量 + Index.ets 透传 PDFium
  try {
    checkPdfInsertWiring();
    report.pass++;
  } catch (e) {
    report.fail++;
    report.errors.push({ name: 'PdfInsertWiring', args: [], error: e.message });
  }

  // PDF→Office 转换门禁：转换桥产物 + 壳侧接线 + 渲染层上报（断线 → 点「PDF 转 Word」无反应）
  try {
    checkPdfConvertWiring();
    report.pass++;
  } catch (e) {
    report.fail++;
    report.errors.push({ name: 'PdfConvertWiring', args: [], error: e.message });
  }

  // pdf.js wasm 门禁：扫描件（CCITT/JBIG2）解码链 —— 二进制 rawfile 响应 + JS 回退文件
  try {
    checkPdfjsWasmWiring();
    report.pass++;
  } catch (e) {
    report.fail++;
    report.errors.push({ name: 'PdfjsWasmWiring', args: [], error: e.message });
  }

  // 未保存守卫门禁：关 tab 必须能拿到未保存状态，「保存并关闭」走 app 保存协议
  try {
    checkCloseGuard();
    report.pass++;
  } catch (e) {
    report.fail++;
    report.errors.push({ name: 'CloseGuard', args: [], error: e.message });
  }

  // 壳 chrome 菜单门禁（M7）：Tab 列表菜单的「另存为…/打印…」按 app 类型派发到真实通道
  try {
    checkAppFileMenu();
    report.pass++;
  } catch (e) {
    report.fail++;
    report.errors.push({ name: 'AppFileMenu', args: [], error: e.message });
  }

  // PDF 签名库门禁（M7）：签名「保存以便复用」落盘 + 返回结构对齐渲染层
  try {
    checkPdfSignaturePersist();
    report.pass++;
  } catch (e) {
    report.fail++;
    report.errors.push({ name: 'PdfSignaturePersist', args: [], error: e.message });
  }

  // fs 语义门禁：accessSync/openSync 的鸿蒙异常语义（新建/保存链路真机踩过的坑）
  try {
    checkFsSemantics();
    report.pass++;
  } catch (e) {
    report.fail++;
    report.errors.push({ name: 'FsSemantics', args: [], error: e.message });
  }

  // 打印/导出图片门禁：PRINT 权限 + 壳侧 exportImages + print.ts 不阻塞 + shell 打印样式
  try {
    checkPrintExportWiring();
    report.pass++;
  } catch (e) {
    report.fail++;
    report.errors.push({ name: 'PrintExportWiring', args: [], error: e.message });
  }

  // ArkTS 成员重复声明门禁：防「静态门禁全绿、DevEco 构建 10505001 失败」
  try {
    checkArkTsDuplicateMembers();
    report.pass++;
  } catch (e) {
    report.fail++;
    report.errors.push({ name: 'ArkTsDuplicateMembers', args: [], error: e.message });
  }

  // 「最近打开」授权门禁：Picker 临时授权持久化 + 启动使能（缺一则跨启动 EPERM/条目灰显）
  try {
    checkRecentPersistWiring();
    report.pass++;
  } catch (e) {
    report.fail++;
    report.errors.push({ name: 'RecentPersistWiring', args: [], error: e.message });
  }

  // M6-Excel 二级功能门禁：exportCsv / selectWorkbooksForMerge / openExternal 桥接线
  try {
    checkSheetsSecondTier();
    report.pass++;
  } catch (e) {
    report.fail++;
    report.errors.push({ name: 'SheetsSecondTier', args: [], error: e.message });
  }

  // Sheets「文件」功能区门禁（鸿蒙壳无原生菜单 → 渲染层自带 File tab）
  try {
    checkSheetsFileTab();
    report.pass++;
  } catch (e) {
    report.fail++;
    report.errors.push({ name: 'SheetsFileTab', args: [], error: e.message });
  }

  // M7-3 AI 图像/搜索链门禁：本地图片 / 网图下载 / 网搜 / 图搜的形状与降级
  try {
    checkAiImageSearchChain();
    report.pass++;
  } catch (e) {
    report.fail++;
    report.errors.push({ name: 'AiImageSearchChain', args: [], error: e.message });
  }

  // M7-4 sheets 崩溃恢复门禁：恢复副本落盘 + 打开时的「发现自动恢复版本」提问链
  try {
    checkSheetsRecoveryPrompt();
    report.pass++;
  } catch (e) {
    report.fail++;
    report.errors.push({ name: 'SheetsRecoveryPrompt', args: [], error: e.message });
  }

  // 上架元数据门禁：版本三处一致 + 真实图标 + 市场可见文案（BETA/内测前置）
  try {
    checkReleaseMetadata();
    report.pass++;
  } catch (e) {
    report.fail++;
    report.errors.push({ name: 'ReleaseMetadata', args: [], error: e.message });
  }

  // 壳菜单处理函数门禁：onClick 引用的函数必须有定义 + 反馈框三件套齐全
  try {
    checkShellMenuHandlers();
    report.pass++;
  } catch (e) {
    report.fail++;
    report.errors.push({ name: 'ShellMenuHandlers', args: [], error: e.message });
  }

  // ArkTS 语义门禁：本地没有 ArkTS 编译器，这类错只在 DevEco 构建时才炸（代价 = 一整轮构建）
  try {
    checkArktsSemantics();
    report.pass++;
  } catch (e) {
    report.fail++;
    report.errors.push({ name: 'ArktsSemantics', args: [], error: e.message });
  }

  // 发布包名一致性门禁：app.json5 bundleName ↔ 发布 Profile bundle-name（不一致必签名失败）
  try {
    checkBundleNameAlignment();
    report.pass++;
  } catch (e) {
    report.fail++;
    report.errors.push({ name: 'BundleNameAlignment', args: [], error: e.message });
  }

  // release 调试开关门禁：setWebDebuggingAccess 不得写死 true（上架包不能开调试口）
  try {
    checkReleaseDebuggingSwitch();
    report.pass++;
  } catch (e) {
    report.fail++;
    report.errors.push({ name: 'ReleaseDebuggingSwitch', args: [], error: e.message });
  }

  // 签名配置卫生门禁（模式感知）：明文口令 / 发布态别名错 / 材料串味 / 三件套丢失才报红；
  // 「当前是调试签名（本地装机态）」只作为 Note 提醒 —— 上传 AGC 前必须还原发布签名
  try {
    const detail = checkSigningConfigHygiene();
    report.pass++;
    report.notes.push({ name: 'SigningConfig', detail });
  } catch (e) {
    report.fail++;
    report.errors.push({ name: 'SigningConfigHygiene', args: [], error: e.message });
  }

  // 桥覆盖门禁：渲染层调用面 ↔ 壳侧实现面（静默 no-op 是「点了没反应」的根因）
  // 批次 F：品牌值回归（上游同步会带回 Genspark 文案）
  try {
    const detail = checkGensparkBrandGone();
    report.pass++;
    report.notes.push({ name: 'GensparkBrandGone', detail });
  } catch (e) {
    report.fail++;
    report.errors.push({ name: 'GensparkBrandGone', args: [], error: e.message });
  }

  // strip 脚本自身的安全性（门禁文案让开发者去跑它，它就不能误伤枚举值/i18n 键）
  try {
    const detail = checkStripScriptSafety();
    report.pass++;
    report.notes.push({ name: 'StripScriptSafety', detail });
  } catch (e) {
    report.fail++;
    report.errors.push({ name: 'StripScriptSafety', args: [], error: e.message });
  }

  // R4：ArkWeb 补丁门禁 — dist 产物中必须包含鸿蒙特有 CSS 补丁
  try {
    const webRoot = resolve(__dirname, '..', 'entry/src/main/resources/rawfile/web');
    if (!existsSync(webRoot)) {
      report.notes.push({ name: 'ArkWebPatch', detail: 'rawfile/web 不存在（尚未 sync-web），跳过' });
    } else {
      const r = spawnSync(process.execPath, [resolve(__dirname, 'patch-web.mjs'), webRoot, '--check'], { encoding: 'utf8' });
      const out = (r.stdout || '') + (r.stderr || '');
      if (r.status !== 0) {
        throw new Error('dist 产物缺少 ArkWeb 补丁（跑 sync-web.sh 会自动 patch）: ' + out.slice(0, 300));
      }
      report.pass++;
      report.notes.push({ name: 'ArkWebPatch', detail: 'dist 产物包含所有 ArkWeb 补丁' });
    }
  } catch (e) {
    report.fail++;
    report.errors.push({ name: 'ArkWebPatch', args: [], error: e.message });
  }

  try {
    const detail = checkBridgeShapeRisk();
    report.pass++;
    report.notes.push({ name: 'BridgeShapeRisk', detail });
  } catch (e) {
    report.fail++;
    report.errors.push({ name: 'BridgeShapeRisk', args: [], error: e.message });
  }

  // 批次 E-6：PPT 三层登记表（缺口 guard / 恒空桩 guard / ambient）与实现面对账
  try {
    const detail = checkSlidesUnsupportedWiring();
    report.pass++;
    report.notes.push({ name: 'SlidesUnsupportedWiring', detail });
  } catch (e) {
    report.fail++;
    report.errors.push({ name: 'SlidesUnsupportedWiring', args: [], error: e.message });
  }

  // 批次 E-6：壳侧 mock 重复键里「空桩遮蔽真实现」（moveSlides 事故：拖动排序静默失效）
  try {
    const detail = checkMockDuplicateKeys();
    report.pass++;
    report.notes.push({ name: 'MockDuplicateKeys', detail });
  } catch (e) {
    report.fail++;
    report.errors.push({ name: 'MockDuplicateKeys', args: [], error: e.message });
  }

  try {
    const detail = checkBridgeCoverage();
    report.pass++;
    report.notes.push({ name: 'BridgeCoverage', detail });
  } catch (e) {
    report.fail++;
    report.errors.push({ name: 'BridgeCoverage', args: [], error: e.message });
  }

  // 文档-实现一致性门禁：BETA 文档的「已知限制」必须与实际缺口对得上（防文档漂移）
  try {
    const detail = checkKnownLimitations();
    report.pass++;
    report.notes.push({ name: 'KnownLimitations', detail });
  } catch (e) {
    report.fail++;
    report.errors.push({ name: 'KnownLimitations', args: [], error: e.message });
  }

  // markdown 图片链门禁：readImage / saveImageAs 的语义锚点 + 读字节通道纯净性
  try {
    const detail = checkMarkdownImageChain();
    report.pass++;
    report.notes.push({ name: 'MarkdownImageChain', detail });
  } catch (e) {
    report.fail++;
    report.errors.push({ name: 'MarkdownImageChain', args: [], error: e.message });
  }

  // 外链产物一致性门禁（D-4）：ASSET_ORIGIN 两侧一致 + 白名单与产物形态对齐 + 禁外链 app
  try {
    const detail = checkAssetExternalization();
    report.pass++;
    report.notes.push({ name: 'AssetExternalization', detail });
  } catch (e) {
    report.fail++;
    report.errors.push({ name: 'AssetExternalization', args: [], error: e.message });
  }

  // md-asset 图片显示桥门禁（D-4）：DOM 层把 md-asset:// 换成 blob:（否则编辑器内图片全裂）
  try {
    const detail = checkMdAssetImageShim();
    report.pass++;
    report.notes.push({ name: 'MdAssetImageShim', detail });
  } catch (e) {
    report.fail++;
    report.errors.push({ name: 'MdAssetImageShim', args: [], error: e.message });
  }

  // 桥契约登记表新鲜度（D-5）：登记表过期 = 烟雾测试覆盖面悄悄缩水（本次白屏的根因）
  try {
    const detail = checkBridgeRegistryFresh();
    report.pass++;
    report.notes.push({ name: 'BridgeRegistryFresh', detail });
  } catch (e) {
    report.fail++;
    report.errors.push({ name: 'BridgeRegistryFresh', args: [], error: e.message });
  }

  // R2 契约新鲜度：bridge-contract.json + mock.js 必须与 preload 源码一致
  try {
    const detail = checkBridgeContractFresh();
    report.pass++;
    report.notes.push({ name: 'BridgeContractFresh', detail });
  } catch (e) {
    report.fail++;
    report.errors.push({ name: 'BridgeContractFresh', args: [], error: e.message });
  }

// R4-6 门禁：上游同步冲突面监控
// 确保已恢复上游的文件（品牌中性化移到构建时）仍然与 merge-base 一致，
// 防止意外改回或上游同步后忘记恢复。
// 同时统计交集文件中已恢复 vs 仍保留改动的比例，确保冲突面在可控范围内。
function checkSyncSurface() {
  const root = resolve(__dirname, '..', '..');
  // merge-base commit（上游同步的基准点）
  const MERGE_BASE = 'efb9247a';
  // 已恢复上游的文件清单（这些文件应该与 merge-base 一致）
  const RESTORED_FILES = [
    // 63 个纯品牌替换 i18n 文件
    'apps/docs/src/renderer/i18n/ai/cs.ts',
    'apps/docs/src/renderer/i18n/ai/en.ts',
    'apps/docs/src/renderer/i18n/ai/he.ts',
    'apps/docs/src/renderer/i18n/ai/hi.ts',
    'apps/docs/src/renderer/i18n/ai/id.ts',
    'apps/docs/src/renderer/i18n/ai/ms.ts',
    'apps/docs/src/renderer/i18n/ai/nl.ts',
    'apps/docs/src/renderer/i18n/ai/pl.ts',
    'apps/docs/src/renderer/i18n/ai/th.ts',
    'apps/docs/src/renderer/i18n/app/ar.ts',
    'apps/docs/src/renderer/i18n/app/cs.ts',
    'apps/docs/src/renderer/i18n/app/de.ts',
    'apps/docs/src/renderer/i18n/app/en.ts',
    'apps/docs/src/renderer/i18n/app/es.ts',
    'apps/docs/src/renderer/i18n/app/fr.ts',
    'apps/docs/src/renderer/i18n/app/he.ts',
    'apps/docs/src/renderer/i18n/app/hi.ts',
    'apps/docs/src/renderer/i18n/app/id.ts',
    'apps/docs/src/renderer/i18n/app/it.ts',
    'apps/docs/src/renderer/i18n/app/ms.ts',
    'apps/docs/src/renderer/i18n/app/nl.ts',
    'apps/docs/src/renderer/i18n/app/pl.ts',
    'apps/docs/src/renderer/i18n/app/pt.ts',
    'apps/docs/src/renderer/i18n/app/ru.ts',
    'apps/docs/src/renderer/i18n/app/th.ts',
    'apps/docs/src/renderer/i18n/app/zh.ts',
    'apps/docs/src/renderer/i18n/ribbon/cs.ts',
    'apps/docs/src/renderer/i18n/ribbon/en.ts',
    'apps/docs/src/renderer/i18n/ribbon/he.ts',
    'apps/docs/src/renderer/i18n/ribbon/hi.ts',
    'apps/docs/src/renderer/i18n/ribbon/id.ts',
    'apps/docs/src/renderer/i18n/ribbon/ja.ts',
    'apps/docs/src/renderer/i18n/ribbon/ko.ts',
    'apps/docs/src/renderer/i18n/ribbon/ms.ts',
    'apps/docs/src/renderer/i18n/ribbon/nl.ts',
    'apps/docs/src/renderer/i18n/ribbon/pl.ts',
    'apps/docs/src/renderer/i18n/ribbon/th.ts',
    'apps/docs/src/renderer/i18n/ribbon/zh-TW.ts',
    'apps/docs/src/renderer/i18n/ribbon/zh.ts',
    'apps/docs/src/renderer/i18n/ribbon/ar.ts',
    'apps/docs/src/renderer/i18n/ribbon/de.ts',
    'apps/docs/src/renderer/i18n/ribbon/es.ts',
    'apps/docs/src/renderer/i18n/ribbon/fr.ts',
    'apps/docs/src/renderer/i18n/ribbon/it.ts',
    'apps/docs/src/renderer/i18n/ribbon/pt.ts',
    'apps/docs/src/renderer/i18n/ribbon/ru.ts',
    'apps/slides/src/renderer/i18n/ai/cs.ts',
    'apps/slides/src/renderer/i18n/ai/en.ts',
    'apps/slides/src/renderer/i18n/ai/he.ts',
    'apps/slides/src/renderer/i18n/ai/hi.ts',
    'apps/slides/src/renderer/i18n/ai/id.ts',
    'apps/slides/src/renderer/i18n/ai/ms.ts',
    'apps/slides/src/renderer/i18n/ai/nl.ts',
    'apps/slides/src/renderer/i18n/ai/pl.ts',
    'apps/slides/src/renderer/i18n/ai/th.ts',
    'apps/slides/src/renderer/i18n/ribbon/cs.ts',
    'apps/slides/src/renderer/i18n/ribbon/en.ts',
    'apps/slides/src/renderer/i18n/ribbon/he.ts',
    'apps/slides/src/renderer/i18n/ribbon/hi.ts',
    'apps/slides/src/renderer/i18n/ribbon/id.ts',
    'apps/slides/src/renderer/i18n/ribbon/ja.ts',
    'apps/slides/src/renderer/i18n/ribbon/ko.ts',
    'apps/slides/src/renderer/i18n/ribbon/ms.ts',
    'apps/slides/src/renderer/i18n/ribbon/nl.ts',
    'apps/slides/src/renderer/i18n/ribbon/pl.ts',
    'apps/slides/src/renderer/i18n/ribbon/th.ts',
    'apps/slides/src/renderer/i18n/ribbon/zh-TW.ts',
    'apps/slides/src/renderer/i18n/ribbon/zh.ts',
    // 9 个纯品牌替换非 i18n 文件
    'apps/slides/src/renderer/ai/slides-skill.ts',
    'apps/docs/src/renderer/components/Ribbon.tsx',
    'apps/slides/src/renderer/components/RibbonHomeTab.tsx',
    'apps/html/src/renderer/components/Ribbon.tsx',
    'apps/docs/src/renderer/ai/docs-skill.ts',
    'apps/pdf/src/renderer/ai/pdf-skill.ts',
    'apps/markdown/src/renderer/ai/markdown-skill.ts',
    'apps/shell/src/renderer/src/IntegrationsPane.tsx',
    'apps/shell/src/renderer/src/provider-logos.tsx',
    // 2 个 ArkWeb CSS 文件（构建时 patch-web.mjs 处理）
    'apps/pdf/src/renderer/styles.css',
    'apps/shell/src/renderer/src/tabbar.css',
  ];

  const drifted = [];
  for (const rel of RESTORED_FILES) {
    const abs = resolve(root, rel);
    if (!existsSync(abs)) {
      drifted.push(rel + ' (文件不存在)');
      continue;
    }
    // 检查工作区文件是否与 merge-base 一致
    const r = spawnSync('git', ['diff', '--quiet', MERGE_BASE, '--', rel], {
      cwd: root, encoding: 'utf8',
    });
    if (r.status !== 0) {
      drifted.push(rel);
    }
  }

  if (drifted.length) {
    throw new Error(
      '已恢复上游的文件发生漂移（应与 merge-base ' + MERGE_BASE + ' 一致）：\n  ' +
      drifted.slice(0, 10).join('\n  ') +
      (drifted.length > 10 ? '\n  ... 共 ' + drifted.length + ' 个' : '') +
      '\n  修复：git checkout ' + MERGE_BASE + ' -- <file>'
    );
  }

  return (
    RESTORED_FILES.length + ' 个已恢复上游文件全部与 merge-base 一致（冲突面监控正常）'
  );
}


  try {
    const detail = checkNativeBridgeRegistry();
    report.pass++;
    report.notes.push({ name: 'NativeBridgeRegistry', detail });
  } catch (e) {
    report.fail++;
    report.errors.push({ name: 'NativeBridgeRegistry', args: [], error: e.message });
  }

  // R4-6 门禁：上游同步冲突面监控
  try {
    const detail = checkSyncSurface();
    report.pass++;
    report.notes.push({ name: 'SyncSurface', detail });
  } catch (e) {
    report.fail++;
    report.errors.push({ name: 'SyncSurface', args: [], error: e.message });
  }

  // R5-2 门禁：恒空桩注册表新鲜度
  try {
    const detail = checkStubRegistryFresh();
    report.pass++;
    report.notes.push({ name: 'StubRegistryFresh', detail });
  } catch (e) {
    report.fail++;
    report.errors.push({ name: 'StubRegistryFresh', args: [], error: e.message });
  }

  // 壳侧三桥 Proxy 兜底（D-5）：裸对象赋值 = 未实现方法 TypeError → 起始页白屏
  try {
    const detail = checkShellBridgeProxy();
    report.pass++;
    report.notes.push({ name: 'ShellBridgeProxy', detail });
  } catch (e) {
    report.fail++;
    report.errors.push({ name: 'ShellBridgeProxy', args: [], error: e.message });
  }

  // 批次 E：AI 目录去 Genspark + 自由配置（端点/模型可填）
  try {
    const detail = checkAiProviderCatalog();
    report.pass++;
    report.notes.push({ name: 'AiProviderCatalog', detail });
  } catch (e) {
    report.fail++;
    report.errors.push({ name: 'AiProviderCatalog', args: [], error: e.message });
  }

  // 批次 E：双协议 AI 通道（单份实现挂 base）+ Serper/Tavily，禁 DDG 抓取
  try {
    const detail = checkAiProtocolChannel();
    report.pass++;
    report.notes.push({ name: 'AiProtocolChannel', detail });
  } catch (e) {
    report.fail++;
    report.errors.push({ name: 'AiProtocolChannel', args: [], error: e.message });
  }

  // 批次 E-7：「AI 模型」已配模型在生图/解析里直接可用（同供应商复用 + 四方对账）
  try {
    const detail = checkAiMediaReuse();
    report.pass++;
    report.notes.push({ name: 'AiMediaReuse', detail });
  } catch (e) {
    report.fail++;
    report.errors.push({ name: 'AiMediaReuse', args: [], error: e.message });
  }

  // 批次 E-8：设置分区三方一致 + 深链不落空 + AiMediaPane 单入口
  try {
    const detail = checkSettingsSections();
    report.pass++;
    report.notes.push({ name: 'SettingsSections', detail });
  } catch (e) {
    report.fail++;
    report.errors.push({ name: 'SettingsSections', args: [], error: e.message });
  }

  // 批次 E：登录链拆净（渲染层）+ 壳桥 no-op 保留
  try {
    const detail = checkGensparkLoginRemoved();
    report.pass++;
    report.notes.push({ name: 'GensparkLoginRemoved', detail });
  } catch (e) {
    report.fail++;
    report.errors.push({ name: 'GensparkLoginRemoved', args: [], error: e.message });
  }

  // 批次 E：Apache-2.0 第 4 条材料随包 + 入口可见
  try {
    const detail = checkLegalNotices();
    report.pass++;
    report.notes.push({ name: 'LegalNotices', detail });
  } catch (e) {
    report.fail++;
    report.errors.push({ name: 'LegalNotices', args: [], error: e.message });
  }
  const shellBridges = {
    aiOffice: BRIDGES.shell.homeApi,
    aiOfficeProject: BRIDGES.shell.projectApi,
    aiOfficeTabs: BRIDGES.shell.tabsApi,
  };
  const appBridges = {
    desktop: BRIDGES.docs.api,
    desktopApi: BRIDGES.sheets.desktopApi,
    slidesApi: BRIDGES.slides.api,
    markdownApi: BRIDGES.markdown.api,
    pdfApi: BRIDGES.pdf.api,
    projectApi: BRIDGES.docs.projectApi,
  };

  // 契约就是「同步返回字符串」的桥方法（桌面 preload 里也没有 async）：
  //   aiOffice.pathForFile = webUtils.getPathForFile(file)（File → 绝对路径，同步）
  //   sheets 的 desktopApi.getPathForFile 同理（apps/sheets/src/preload/index.ts:638 同步返回，
  //   类型 desktop-api.ts:2705 也是 string）。AiChatPanel 把返回值直接 push 进 paths 数组。
  // 渲染层调用点是 `files.map((f) => window.aiOffice.pathForFile(f))` —— 直接吃字符串。
  // 为了迁就 harness 把它改成 Promise 会让渲染层拿到 Promise 数组（下游 dropFolderRoots 收到
  // [Promise] 而不是 ['']），所以这里显式豁免，而不是放宽「同步返回」的整体规则。
  const SYNC_STRING_METHODS = new Set(['pathForFile', 'getPathForFile']);

  async function check(name, fn, args) {
    let res;
    try {
      res = fn(...args);
    } catch (e) {
      report.fail++;
      report.errors.push({ name, args, error: 'sync throw: ' + (e.message || String(e)) });
      return;
    }
    if (res && typeof res.then === 'function') {
      const out = await Promise.race([
        Promise.resolve(res).then(v => ({ ok: true, v }), e => ({ ok: false, e })),
        new Promise(r => setTimeout(() => r({ ok: 'timeout' }), 1000)),
      ]);
      if (out.ok === 'timeout') { report.fail++; report.errors.push({ name, args, error: 'promise 1s 未 settle' }); }
      else if (out.ok === false) { report.fail++; report.errors.push({ name, args, error: 'promise reject: ' + (out.e && (out.e.message || out.e)) }); }
      else { report.pass++; }
    } else {
      // 同步返回：函数（on* NOOP）/ undefined / null / 对象 / 数组 都接受
      if (typeof res === 'function' || res === undefined || res === null || typeof res === 'object') {
        report.pass++;
      } else if (typeof res === 'string' && SYNC_STRING_METHODS.has(name)) {
        // 契约就是同步返回字符串的方法（见 SYNC_STRING_METHODS 注释）—— 改成 Promise 反而会破坏渲染层
        report.pass++;
      } else {
        report.fail++;
        report.errors.push({ name, args, error: 'unexpected sync return: ' + typeof res });
      }
    }
  }

  function placeholderFor(arity) {
    const arr = [];
    for (let i = 0; i < Math.max(arity, 1); i++) {
      arr.push([i % 5][0] || (i % 5 === 1 ? {} : i % 5 === 2 ? '' : i % 5 === 3 ? 0 : null));
      arr[i] = i % 5 === 0 ? [] : i % 5 === 1 ? {} : i % 5 === 2 ? '' : i % 5 === 3 ? 0 : null;
    }
    return arr;
  }

  for (const [name, methods] of Object.entries({ ...shellBridges, ...appBridges })) {
    const bridge = win[name];
    if (!bridge) {
      report.errors.push({ name, error: 'bridge not exposed' });
      report.byBridge[name] = { pass: 0, fail: 0 };
      continue;
    }
    report.byBridge[name] = { pass: 0, fail: 0 };
    for (const method of methods) {
      if (typeof bridge[method] !== 'function') { report.skipped++; continue; }
      // M6-Excel：openExternal 烟雾测需要有效 http URL（否则桥拒绝非白名单 scheme → 报 reject
      // 是预期行为但不该计入 FAIL）。其他方法继续用 placeholderFor 默认 [null] 占位。
      // M7-3：readLocalImage 空路径按桌面语义必须 reject（预期行为，同样不该计 FAIL），
      // 这里给有效 { path } 让烟雾测跑成功分支（失败分支由 Stage B 的 M7-3-5 覆盖）。
      const args = method === 'openExternal' ? ['https://example.com']
        : method === 'readLocalImage' ? [{ path: 'file://docs/img.png' }]
          : placeholderFor(bridge[method].length);
      // M6-Excel：confirmCsvSave 是模态三按钮确认（等用户点击才 settle），harness 里必然
      // 一直悬着 → 不能按「1s 未 settle = FAIL」判。只校验：同步不抛 + 返回 thenable
      //（接线仍在 → 不是 Proxy 兜底的 undefined）。
      if (method === 'confirmCsvSave') {
        let res;
        try { res = bridge[method].bind(bridge)(...args); } catch (e) {
          report.fail++; report.byBridge[name].fail++;
          report.errors.push({ name: method, args, error: 'sync throw: ' + (e.message || String(e)) });
          continue;
        }
        if (res && typeof res.then === 'function') { report.pass++; report.byBridge[name].pass++; }
        else {
          report.fail++; report.byBridge[name].fail++;
          report.errors.push({ name: method, args, error: 'confirmCsvSave 未返回 Promise（Proxy 兜底则是 undefined）' });
        }
        continue;
      }
      // 批次 A：desktopApi.exportPdf 走【系统打印面板】—— Excel 侧调用点
      // （apps/sheets/src/renderer/page-layout-actions.ts:412）只判 canceled/path，没有 error 分支。
      // 壳内没有 HTML→PDF 引擎，但排版好的 HTML 可以交给系统打印框架（printHtmlViaFrame），
      // 用户在打印面板里选「另存为 PDF」。两种正确结果：resolve {canceled:false,path 含"打印面板"}
      // 或（打印框架不可用的环境）reject 且文案含「打印」/「HTML→PDF」。
      if (method === 'exportPdf' && name === 'desktopApi') {
        let res;
        try { res = bridge[method].bind(bridge)(...args); } catch (e) {
          report.fail++; report.byBridge[name].fail++;
          report.errors.push({ name: method, args, error: 'sync throw: ' + (e.message || String(e)) });
          continue;
        }
        let msg = '';
        try { res = await res; } catch (e) { msg = (e && e.message) || String(e); res = null; }
        const viaPrint = !!(res && res.canceled === false && typeof res.path === 'string' && /打印/.test(res.path));
        // 参数守卫（html 缺失/非字符串）也走 reject —— 桌面 preload 的
        // isPdfExportRequest 同样抛 "Invalid PDF export request"，不是降级漂移。
        const guard = /打印|HTML→PDF|导出内容为空/.test(msg);
        if (viaPrint || guard) { report.pass++; report.byBridge[name].pass++; }
        else {
          report.fail++; report.byBridge[name].fail++;
          report.errors.push({
            name: method, args,
            error: '既没交给系统打印面板，也没给出可见失败原因: ' + JSON.stringify(res) + ' / ' + msg,
          });
        }
        continue;
      }
      // 鸿蒙没有 Genspark 账号通道（AI 走用户自备 Key 的 aiStreamRun）：这两个方法按
      // 「通道不存在」reject，而不是 resolve 一个假状态。reject 是**预期**结果，但必须
      // 带明确原因；渲染层所有 .then 链末端都有 .catch(()=>{})，所以不会冒出未处理拒绝，
      // loginRequired 也不会置位（否则每个 AI 失败回合都会挂一个点了没反应的「登录」按钮）。
      if (method === 'aiGskStatus' || method === 'aiGskLogin' || (name === 'pdfApi' && method === 'gskStatus')) {
        let res;
        try { res = bridge[method].bind(bridge)(...args); } catch (e) {
          report.fail++; report.byBridge[name].fail++;
          report.errors.push({ name: method, args, error: 'sync throw: ' + (e.message || String(e)) });
          continue;
        }
        if (!res || typeof res.then !== 'function') {
          report.fail++; report.byBridge[name].fail++;
          report.errors.push({ name: method, args, error: '必须返回 Promise（渲染层按 .then/.catch 消费）' });
          continue;
        }
        let msg = '';
        let settled = false;
        try { await res; settled = true; } catch (e) { msg = (e && e.message) || String(e); }
        if (!settled && /Genspark/.test(msg)) { report.pass++; report.byBridge[name].pass++; }
        else {
          report.fail++; report.byBridge[name].fail++;
          report.errors.push({
            name: method, args,
            error: settled ? 'resolve 了假状态：鸿蒙无 Genspark 通道，必须是带原因的 reject'
              : 'reject 文案没说明「无 Genspark 通道」: ' + msg,
          });
        }
        continue;
      }
      const before = report.byBridge[name];
      const errCountBefore = report.errors.length;
      await check(method, bridge[method].bind(bridge), args);
      if (report.errors.length > errCountBefore) before.fail++;
      else before.pass++;
    }
  }

  // ── 批次 A：导出/打印/AI 面板偏好的降级语义断言 ──
  // 这一组守的是「有意降级必须可见」：桌面靠主进程 printToPDF 实现的功能，壳内没有 HTML→PDF
  // 引擎（只有 PNG→PDF 的 pngsToPdf 与 PDF→光栅的 pdfium.wasm），因此这些入口的正确行为是
  // 「返回/抛出带原因的失败」，而不是空实现（空实现在各 app 的表现分别是：静默 return、
  // 英文 undefined 报错、或"已导出到 undefined"的误导性成功）。改动若把它们变回静默，这里变红。
  async function checkExportDegradations() {
    const assert = (label, ok, detail) => {
      if (ok) { report.pass++; return; }
      report.fail++;
      report.errors.push({ name: label, args: [], error: String(detail === undefined ? 'assert failed' : detail) });
    };
    const hasPdfNote = (s) => typeof s === 'string' && s.includes('HTML→PDF');

    // docs(Word) 文件→导出 PDF：契约认 {ok:false,error} → 状态栏 appExportPdfFailed 显示原因
    try {
      const r = await win.desktop.exportPdf('a.docx', 12240, 15840, undefined, 1);
      assert('BatchA. desktop.exportPdf 降级为 {ok:false,error}（docs 状态栏可见原因）',
        r && r.ok === false && hasPdfNote(r.error), '返回 ' + JSON.stringify(r));
    } catch (e) {
      assert('BatchA. desktop.exportPdf 不得 throw（docs 侧该调用无 catch）', false, e && e.message);
    }

    // sheets(Excel) 文件→导出 PDF：契约为 {canceled,path}，壳侧走系统打印面板
    // （printHtmlViaFrame）——用户在该面板里选「另存为 PDF」落盘。打印框架不可用的
    // 环境（如无 document 的 harness）必须 reject 且文案可见，不能静默成功。
    let sheetsPrintOk = false;
    try {
      const r = await win.desktopApi.exportPdf({ html: '<html></html>' });
      sheetsPrintOk = !!(r && r.canceled === false && typeof r.path === 'string' && r.path.includes('打印面板'));
      assert('BatchA. desktopApi.exportPdf 交给系统打印面板（Excel 显示「已导出到 系统打印面板…」）',
        sheetsPrintOk, '返回 ' + JSON.stringify(r));
    } catch (e) {
      assert('BatchA. desktopApi.exportPdf 环境不支持时给出可见原因（打印/HTML→PDF）',
        /打印|HTML→PDF/.test(e && e.message), e && e.message);
    }

    // docs 文件→导出图片：首环必须是「非空目标」，否则 exportImages 静默 return false
    const target = await win.desktop.pickExportImagesTarget();
    assert('BatchA. pickExportImagesTarget 返回非空目标（否则导出图片静默无反应）',
      !!target && typeof target === 'object', '返回 ' + JSON.stringify(target));
    const taken = await win.desktop.takeExportPdf('x.pdf');
    assert('BatchA. takeExportPdf 降级为 {ok:false,error}',
      taken && taken.ok === false && hasPdfNote(taken.error), JSON.stringify(taken));
    const wrote = await win.desktop.writeExportImage('', 'a-01.png', '');
    assert('BatchA. writeExportImage 降级为 {ok:false,error}',
      wrote && wrote.ok === false && hasPdfNote(wrote.error), JSON.stringify(wrote));

    // markdown 文件→导出图片：prepareImageExport 的 {ok:false,error} 会被渲染层 throw 成状态栏文案
    const prep = await win.markdownApi.prepareImageExport();
    assert('BatchA. markdownApi.prepareImageExport 降级为 {ok:false,error}（↔ appExportImagesFailed）',
      prep && prep.ok === false && hasPdfNote(prep.error), JSON.stringify(prep));
    const fin = await win.markdownApi.finishImageExport();
    assert('BatchA. markdownApi.finishImageExport 幂等成功 {ok:true}',
      fin && fin.ok === true, JSON.stringify(fin));

    // markdown 文件→导出为 Word（批次 D）：从「静默失败」改成真落盘。
    // 修复前缺本方法 → Proxy 兜底 undefined → 渲染层 result.ok 抛 TypeError 又被自身 catch 吞掉
    // → 用户看到「点了完全没反应」（连状态栏都没有）。四种形状都要对齐桌面 markdown-main.ts。
    const docxB64 = Buffer.from('PK\u0003\u0004 fake docx bytes').toString('base64');
    const docxOk = await win.markdownApi.exportDocx({ base64: docxB64, suggestedName: 'notes/v1:a*b', mode: 'dialog' });
    assert('BatchD. exportDocx dialog → {ok,path}，非法字符换成 _ 且补 .docx（对齐桌面 safeName）',
      !!docxOk && docxOk.ok === true && /notes_v1_a_b\.docx$/.test(String(docxOk.path || '')), JSON.stringify(docxOk));
    const docxBad = await win.markdownApi.exportDocx({ base64: '', suggestedName: 'x', mode: 'dialog' });
    assert('BatchD. exportDocx 空 base64 → {ok:false,error}（桌面同款 "markdown: bad export request"）',
      !!docxBad && docxBad.ok === false && /bad export request/.test(String(docxBad.error)), JSON.stringify(docxBad));
    const docxCancel = await win.markdownApi.exportDocx({ base64: docxB64, suggestedName: '__cancel__', mode: 'dialog' });
    assert('BatchD. exportDocx 用户取消 → {ok:true,canceled:true}（渲染层据此不算失败、不弹错）',
      !!docxCancel && docxCancel.ok === true && docxCancel.canceled === true, JSON.stringify(docxCancel));
    // openInDocs：落盘后必须真的在新标签打开（沿 parent 链找 __goOpenExternalPath）——
    // 只落盘不打开就是「导出成功但什么都没发生」，与桌面语义不符。
    const openedPaths = [];
    const origOpenExternal = win.__goOpenExternalPath;
    assert('BatchD. 壳侧存在 __goOpenExternalPath（openInDocs 依赖它开新标签）',
      typeof origOpenExternal === 'function', typeof origOpenExternal);
    win.__goOpenExternalPath = (p) => { openedPaths.push(p); };
    let docxOpen = null;
    try {
      docxOpen = await win.markdownApi.exportDocx({ base64: docxB64, suggestedName: 'open-me', mode: 'openInDocs' });
    } finally {
      win.__goOpenExternalPath = origOpenExternal;
    }
    assert('BatchD. exportDocx openInDocs → 落盘 + 调 __goOpenExternalPath(同一路径) 开新标签',
      !!docxOpen && docxOpen.ok === true && openedPaths.length === 1 && openedPaths[0] === docxOpen.path,
      JSON.stringify({ docxOpen, openedPaths }));
    assert('BatchD. exportDocx 未重复补 .docx 后缀（suggestedName 已带时不再叠加）',
      !!docxOpen && /\.docx$/.test(String(docxOpen.path)) && !/\.docx\.docx$/.test(String(docxOpen.path)),
      JSON.stringify(docxOpen));

    // markdown 相对路径插图（批次 D-3）：readImage 语义对齐桌面 markdown-main.ts ——
    // 带 scheme 的 src 一律 null、扩展名只认 png/jpg/jpeg/gif、必须落在文档目录内。
    // 先用 readFile 建立文档基准（壳内每个 app frame 有自己的注入实例 → 模块级变量即桌面的 savePathByWc）。
    await win.markdownApi.readFile('file://docs/storage/Users/x/Documents/note.md');
    const imgOk = await win.markdownApi.readImage('img/a.png');
    assert('BatchD. readImage 相对路径插图 → {base64,mime}（导出 DOCX 的 loadImage 依赖它）',
      !!imgOk && typeof imgOk.base64 === 'string' && imgOk.base64.length > 0 && imgOk.mime === 'image/png',
      JSON.stringify(imgOk));
    assert('BatchD. readImage 带 scheme 的 src → null（http/data 不当本地文件读，桌面同款）',
      (await win.markdownApi.readImage('https://x/a.png')) === null, 'not null');
    assert('BatchD. readImage 非白名单扩展名 → null（桌面 MIME_BY_EXT 只认 png/jpg/jpeg/gif）',
      (await win.markdownApi.readImage('a.svg')) === null, 'not null');
    assert('BatchD. readImage 拒绝越出文档目录（../ 越界 → null，防任意文件读）',
      (await win.markdownApi.readImage('../../etc/passwd.png')) === null, 'not null');
    assert('BatchD. readImage 非字符串入参 → null（不得抛，渲染层无 try/catch）',
      (await win.markdownApi.readImage(null)) === null, 'not null');
    // saveImageAs：data: URL 直接落盘；取不到字节必须 {ok:false,error} + 可见提示
    //（渲染层是 void 调用，不看返回值 → 静默失败等于「点了没反应」）
    const imgSaved = await win.markdownApi.saveImageAs('data:image/png;base64,iVBORw0KGgo=');
    assert('BatchD. saveImageAs data: URL → 保存框写盘 {ok,path}（沿用图片扩展名）',
      !!imgSaved && imgSaved.ok === true && /\.png$/.test(String(imgSaved.path || '')), JSON.stringify(imgSaved));
    const imgBad = await win.markdownApi.saveImageAs('');
    assert('BatchD. saveImageAs 取不到字节 → {ok:false,error}（并弹可见提示，不静默）',
      !!imgBad && imgBad.ok === false && typeof imgBad.error === 'string', JSON.stringify(imgBad));
    // md-asset:// 是渲染层给本地图片的显示协议（桌面 protocol.handle 供字节；ArkWeb 无处理器）
    // → 壳内必须能把它还原成可读 URI，否则图片查看器/编辑器都拿不到字节
    const imgAsset = await win.markdownApi.saveImageAs('md-asset:///storage/Users/x/Documents/img/a.png');
    assert('BatchD. saveImageAs 认 md-asset:// 显示协议（还原成 file://docs/… 后读字节落盘）',
      !!imgAsset && imgAsset.ok === true && /a\.png$/.test(String(imgAsset.path || '')), JSON.stringify(imgAsset));
    assert('BatchD. desktop.saveImageAs 同源实现（docs 侧「另存为图片」不再是 no-op）',
      typeof win.desktop.saveImageAs === 'function' && typeof win.desktopApi.saveImageAs === 'function',
      typeof win.desktop.saveImageAs);

    // sheets 文件→打印：空 html 必须返回 {ok:false,error}（sheets 显示「打印失败」，而非「已取消」）
    const empty = await win.desktop.printWorkbook({ html: '' });
    assert('BatchA. printWorkbook 空 html → {ok:false,error}（不得 throw）',
      empty && empty.ok === false && typeof empty.error === 'string', JSON.stringify(empty));

    // AI 面板偏好：set 持久化 + 广播，get 回读；非法值容错（side 沿用上次、customFontSize 夹取 10~32）
    const set = await win.desktop.setAiPanelPrefs({ side: 'right', fontSize: 'large' });
    const got = await win.desktop.getAiPanelPrefs();
    assert('BatchA. AI 面板偏好 set→get 一致（side=right / fontSize=large）',
      !!set && !!got && set.side === 'right' && got.side === 'right' && got.fontSize === 'large',
      JSON.stringify({ set, got }));
    const bad = await win.desktop.setAiPanelPrefs({ side: 'bogus', customFontSize: 999 });
    assert('BatchA. AI 面板偏好非法值容错（side 保持 right，customFontSize 夹取到 32）',
      !!bad && bad.side === 'right' && bad.customFontSize === 32, JSON.stringify(bad));
    const viaMarkdown = await win.markdownApi.getAiPanelPrefs();
    assert('BatchA. 各 app 桥共享同一份 AI 面板偏好（markdownApi 继承 base mock）',
      !!viaMarkdown && viaMarkdown.side === 'right', JSON.stringify(viaMarkdown));

    // shell 首页设置面板（aiOffice.get/setAiPanelPrefs）与 app 侧共用同一份 localStorage 状态：
    // 否则「设置里改成靠左、app 面板还在右边」或两套键互相覆盖（桌面是主进程一份 app-settings）。
    const viaShell = await win.aiOffice.setAiPanelPrefs({ side: 'left' });
    const readBack = await win.desktop.getAiPanelPrefs();
    assert('BatchA. shell 设置面板写入后，app 侧立即读到同一值（单一数据源）',
      !!viaShell && viaShell.side === 'left' && !!readBack && readBack.side === 'left',
      JSON.stringify({ shell: viaShell, app: readBack }));
    const shellGet = await win.aiOffice.getAiPanelPrefs();
    assert('BatchA. aiOffice.getAiPanelPrefs 回读真实状态（不是兜底默认值）',
      !!shellGet && shellGet.side === 'left', JSON.stringify(shellGet));
  }
  try { await checkExportDegradations(); } catch (e) {
    report.fail++;
    report.errors.push({ name: 'BatchA.exportDegradations', args: [], error: e && e.message });
  }

  console.log('\n========================  STAGE A: 烟雾测试（每桥每方法不抛）  ========================');
  console.log(`Total: PASS ${report.pass}  FAIL ${report.fail}  SKIP ${report.skipped}`);
  console.log('\nBy bridge:');
  for (const [name, c] of Object.entries(report.byBridge)) {
    console.log(`  ${name.padEnd(20)} pass=${String(c.pass).padStart(4)}  fail=${String(c.fail).padStart(4)}`);
  }
  if (report.notes && report.notes.length) {
    console.log('\nNotes:');
    for (const n of report.notes) console.log(`  - ${n.name}: ${n.detail}`);
  }
  if (report.errors.length) {
    console.log('\nFailures:');
    for (const e of report.errors.slice(0, 30)) {
      console.log(`  - ${e.name}(${(e.args||[]).map(x=>JSON.stringify(x)).join(',')}): ${e.error}`);
    }
    if (report.errors.length > 30) console.log(`  ... and ${report.errors.length - 30} more`);
  }
  console.log('=====================================================================================\n');
  return report;
}

// ========== 阶段 B：关键场景功能验证 ==========
async function criticalScenarios(win) {
  console.log('========================  STAGE B: 关键场景（用户报告的 4 个 bug）  ========================');
  let fail = 0;
  const check = (name, ok, detail) => {
    console.log(`  ${ok ? '[PASS]' : '[FAIL]'}  ${name}${detail ? '  —  ' + detail : ''}`);
    if (!ok) fail++;
  };

  // ── 用户报告的 4 个 bug ──

  // 1. aiOffice.browse 起始页「打开本地文件」磁贴 / `+` 菜单按钮
  const browse = await win.aiOffice.browse();
  check('Bug1. aiOffice.browse 打开本地文件（磁贴 / +号菜单）',
    browse && browse.ok === true && browse.path === 'file://z.pptx' && browse.ext === 'pptx',
    browse ? `path=${browse.path} ext=${browse.ext}` : '返回 null');
  // browse 把选中路径写入 pendingOpenPath 后 openApp(kind) 开新 iframe —— 模拟 slides
  // 新 iframe 启动消费（真实流程：browse → 新帧 → consumePendingOpen 读后即删）。
  // 不消费的话 pendingOpenPath 残留会让后续 pdf/markdown 磁贴误消费到 z.pptx。
  await win.slidesApi.consumePendingOpen(1280);

  // 2. 新建 PPT 插入版式
  const layouts = await win.slidesApi.getLayouts();
  check('Bug2a. slidesApi.getLayouts 返回 6 个 builtin 版式（不空 → 版式面板可见）',
    layouts && Array.isArray(layouts.layouts) && layouts.layouts.length >= 6,
    `layouts=${layouts && layouts.layouts && layouts.layouts.length} 个`);
  const ins = await win.slidesApi.addSlideWithLayout({ sourceIndex: 0, layoutPath: 'builtin:titleContent', fitWidthPx: 1280 });
  // 真机 React 端消费 slidesApi 返回时，对每张 slide.nodes[*] 取 .box.x / .box.w；
  // 一旦 box 缺失整页渲染崩。Stage C 专门盯 shape contract。
  const slideOk = (s) => s && Array.isArray(s.nodes) && s.nodes.every((n) => n && n.box && typeof n.box.x === 'number' && typeof n.box.w === 'number' && typeof n.box.y === 'number' && typeof n.box.h === 'number' && typeof n.sourceId === 'string' && typeof n.id === 'string');
  check('Bug2b. slidesApi.addSlideWithLayout 真插入带 box 字段的新页',
    ins && Array.isArray(ins.slides) && ins.slides.length >= 2 && slideOk(ins.slides[ins.slides.length - 1]),
    ins ? `slides=${ins.slides.length} nodes=${ins.slides[ins.slides.length-1].nodes.length} box?=${ins.slides[ins.slides.length-1].nodes[0] && ins.slides[ins.slides.length-1].nodes[0].box ? 'yes' : 'NO'}` : '返回 null');
  const ins2 = await win.slidesApi.addBlankSlide({ sourceIndex: 0, fitWidthPx: 1280 });
  check('Bug2c. slidesApi.addBlankSlide 插入空白页',
    ins2 && Array.isArray(ins2.slides) && ins2.slides.length >= 3,
    ins2 ? `slides=${ins2.slides.length} index=${ins2.index}` : '返回 null');

  // 3. 设置：模型配置可保存 / 可测试连接
  const ai0 = await win.aiOffice.getAiSettings();
  const aiProviders = ai0 && ai0.providers ? Object.keys(ai0.providers) : [];
  // 15 = 上游 provider 去掉 genspark / codex 后的量级；media + search 两个子结构必须齐
  // （AiMediaPane 见 !settings.media || !settings.search 直接 return null → 缺了就整块空白）
  check('Bug3a. aiOffice.getAiSettings 返回合法 AiSettings（无 genspark、media/search 齐）',
    ai0 && aiProviders.length >= 15 && aiProviders.indexOf('genspark') < 0
      && !!(ai0.media && ai0.media.providers) && !!(ai0.search && ai0.search.providers),
    `providers=${aiProviders.length} current=${ai0 && ai0.provider} media=${!!(ai0 && ai0.media)}`
      + ` search=${!!(ai0 && ai0.search)}`);
  const aiSearchKeys = ai0 && ai0.search && ai0.search.providers
    ? Object.keys(ai0.search.providers) : [];
  check('Bug3a2. aiOffice.getAiSearchProviders 只列真实现的提供方（serper/tavily），且带 Key 输入位',
    aiSearchKeys.indexOf('serper') >= 0 && aiSearchKeys.indexOf('tavily') >= 0
      && aiProviders.indexOf('genspark') < 0,
    `searchProviders=${aiSearchKeys.join(',')}`);
  check('Bug3a3. 两个目录桥方法可用（AiMediaPane 用 ?? [] 兜底，返回 undefined 也不崩）',
    Array.isArray(win.aiOffice.getAiSearchProviders())
      && Array.isArray(win.aiOffice.getAiMediaProviders()),
    `search=${win.aiOffice.getAiSearchProviders().length} media=${win.aiOffice.getAiMediaProviders().length}`);
  const aiNew = { ...ai0, providers: { ...ai0.providers, glm: { ...ai0.providers.glm, apiKey: 'sk-verify-test' } } };
  await win.aiOffice.setAiSettings(aiNew);
  const ai1 = await win.aiOffice.getAiSettings();
  check('Bug3b. aiOffice.setAiSettings 持久化（reload 后保留）',
    ai1 && ai1.providers.glm.apiKey === 'sk-verify-test', `apiKey=${ai1 && ai1.providers.glm.apiKey}`);
  const test = await win.aiOffice.testAiSettings(ai1);
  // 仿真环境无 fetch 也不注入桥 → 必须返回 {ok:false, error} 字符串而不是抛
  check('Bug3c. aiOffice.testAiSettings 不抛（fetch + 桥双路径）',
    test && typeof test === 'object' && typeof test.ok === 'boolean' && (test.ok === true || typeof test.error === 'string'),
    test ? `ok=${test.ok} err=${test.error || '-'}` : '返回 null');
  const testEmpty = await win.aiOffice.testAiSettings({ ...ai0, providers: { ...ai0.providers, glm: { ...ai0.providers.glm, apiKey: '' } } });
  check('Bug3d. aiOffice.testAiSettings 空 apiKey → {ok:false, error}',
    testEmpty && testEmpty.ok === false && typeof testEmpty.error === 'string',
    testEmpty ? `ok=${testEmpty.ok} err=${testEmpty.error}` : '返回 null');
  // 仿真注入 fetch 成功响应 → 验证 fetch 路径走得通
  const realFetch = win.fetch;
  win.fetch = async () => ({ status: 200, text: async () => '{"data":[]}' });
  const test2 = await win.aiOffice.testAiSettings(ai1);
  win.fetch = realFetch;
  check('Bug3e. aiOffice.testAiSettings 走 fetch 成功路径 → {ok:true}',
    test2 && test2.ok === true, test2 ? `ok=${test2.ok}` : '返回 null');
  // 仿真注入 fetch 4xx → 走 fetch 失败分支
  win.fetch = async () => ({ status: 401, text: async () => '{"error":{"message":"bad key"}}' });
  const test3 = await win.aiOffice.testAiSettings(ai1);
  win.fetch = realFetch;
  check('Bug3f. aiOffice.testAiSettings 走 fetch 4xx → {ok:false, error 含服务端 message}',
    test3 && test3.ok === false && /bad key|HTTP 401/.test(test3.error || ''),
    test3 ? `ok=${test3.ok} err=${test3.error}` : '返回 null');

  // 4. 默认存储设置
  const picked = await win.aiOffice.pickDefaultSaveDir();
  check('Bug4a. aiOffice.pickDefaultSaveDir 返回 URI',
    typeof picked === 'string' && picked.length > 0, `uri=${picked}`);
  const got = await win.aiOffice.getDefaultSaveDir();
  check('Bug4b. aiOffice.getDefaultSaveDir 持久化 URI',
    typeof got === 'string' && got === picked, `uri=${got}`);

  // ── PDF 磁贴空态（Tab 宿主 openApp('pdf') 无排队文件 → 之前整页只显示"没有要打开的文件"）──
  const pdfPending = await win.pdfApi.consumePending();
  check('Bug5a. pdfApi.consumePending 无排队文件 → null/undefined（渲染层走空态 UI）',
    pdfPending === null || pdfPending === undefined, `v=${pdfPending}`);
  const pdfBytes = await win.pdfApi.readFile('file://docs/x.pdf');
  check('Bug5b. pdfApi.readFile 按路径返回 ArrayBuffer（openDocxPathJson 通道复用）',
    pdfBytes instanceof ArrayBuffer && pdfBytes.byteLength > 0,
    pdfBytes instanceof ArrayBuffer ? `bytes=${pdfBytes.byteLength}` : '非 ArrayBuffer');
  const created = await win.pdfApi.createDocument({ type: 'pdf', title: 'Untitled', content: '' });
  check('Bug5c. pdfApi.createDocument 新建空白 PDF → {ok:true,path}',
    created && created.ok === true && typeof created.path === 'string' && created.path.endsWith('.pdf'),
    created ? `path=${created.path}` : '返回 null');
  const createdBad = await win.pdfApi.createDocument({ type: 'docx', title: 'x', content: '' });
  check('Bug5d. pdfApi.createDocument 非 pdf 类型 → {ok:false,error}',
    createdBad && createdBad.ok === false && typeof createdBad.error === 'string',
    createdBad ? `ok=${createdBad.ok} err=${createdBad.error || '-'}` : '返回 null');
  const ofj = await win.desktop.openFileJson();
  check('Bug5e. desktop.openFileJson 共享通道（PDF 空态"打开本地文件"按钮）返回 JSON 字符串',
    typeof ofj === 'string' && ofj.indexOf('"ok":true') >= 0, ofj ? `len=${ofj.length}` : '空');
  const mdRead = await win.markdownApi.readFile('file://docs/x.md');
  check('Bug5f. markdownApi.readFile 返回文本（不返回 pdfApi 的 ArrayBuffer）',
    mdRead === 'X', `v=${mdRead}`);

  // ── Bug6: iframe 转发链（PDF 空态按钮/bootBlank 的真实路径）──
  // gin 桥只注入主 frame：iframe 无 desktopNative，native 调用必须经顶层
  // __goNativeCall 转发（gin 方法跨 frame 直接调用会报 non-injected object）。
  const child = makeFrameWin(win);
  win.__goNativeCall = (method, args) => win.desktopNative[method].apply(win.desktopNative, args || []);
  runShimOn(child);
  const childOfj = await child.pdfApi.openFileJson();
  check('Bug6a. iframe pdfApi.openFileJson 经 __goNativeCall 转发拿到选择器结果（raw JSON 字符串）',
    typeof childOfj === 'string' && childOfj.indexOf('"ok":true') >= 0,
    typeof childOfj === 'string' ? `len=${childOfj.length}` : `type=${typeof childOfj}`);
  const childCreated = await child.pdfApi.createDocument({ type: 'pdf', title: 'Untitled', content: '' });
  check('Bug6b. iframe pdfApi.createDocument 经转发器 → {ok:true,path}（bootBlank 自动新建依赖）',
    childCreated && childCreated.ok === true && typeof childCreated.path === 'string' && childCreated.path.endsWith('.pdf'),
    childCreated ? `path=${childCreated.path}` : '返回 null');
  const childOfjDirect = await (async () => {
    // 防回归：没有转发器时必须优雅返回 null（不抛、不挂起）
    const child2 = makeFrameWin(win);
    delete win.__goNativeCall;
    try { runShimOn(child2); } catch (e) { return 'shim-error:' + e.message; }
    const r = await Promise.race([
      child2.pdfApi.openFileJson().then(v => (v === '' ? 'empty-ok' : 'unexpected:' + JSON.stringify(v))),
      new Promise(res => setTimeout(() => res('timeout'), 1000)),
    ]);
    return r;
  })();
  win.__goNativeCall = (method, args) => win.desktopNative[method].apply(win.desktopNative, args || []);
  check('Bug6c. 无转发器时 iframe openFileJson 优雅返回空字符串（1s 内 settle）',
    childOfjDirect === 'empty-ok', `v=${childOfjDirect}`);

  // ── Bug7: PDF 保存/结构/签名/AI（pdf-bridge 全链路，本会话新增能力）──
  const pdfSrc = 'file://docs/x.pdf';
  const saved = await win.pdfApi.save({ path: pdfSrc, markups: [], drawings: [], formValues: [], rotations: [{ pageIndex: 0, delta: 90 }], deletedPages: [] });
  check('Bug7a. pdfApi.save 覆盖保存 → {ok:true}（pdf-bridge 应用编辑）',
    saved && saved.ok === true, saved ? `ok=${saved.ok} err=${saved.error || '-'}` : '返回 null');
  const savedBytes = win.desktopNative._saved.get(pdfSrc);
  check('Bug7b. 保存落盘为合法 PDF（%PDF- 头 + 长度）',
    savedBytes && savedBytes.length > 20 && savedBytes.subarray(0, 5).toString() === '%PDF-',
    savedBytes ? `bytes=${savedBytes.length} head=${savedBytes.subarray(0, 5).toString()}` : '未落盘');
  const fills = await win.pdfApi.listStaticFormFills(pdfSrc);
  check('Bug7c. listStaticFormFills 经 pdf-bridge 真读（无记录 → []）',
    Array.isArray(fills), fills ? `len=${fills.length}` : '非数组');
  const sp = await win.pdfApi.splitPdf({ path: pdfSrc, chunkSize: 1, baseName: 'split' });
  check('Bug7d. splitPdf → {ok:true, savedDir, count=2}（目录选择 + 分块落盘）',
    sp && sp.ok === true && typeof sp.savedDir === 'string' && sp.count === 2,
    sp ? `ok=${sp.ok} dir=${sp.savedDir || '-'} count=${sp.count || '-'} err=${sp.error || '-'}` : '返回 null');
  const mp = await win.pdfApi.mergePages({ path: pdfSrc, perSheet: 2, direction: 'vertical', separator: false, suggestedName: 'm.pdf' });
  check('Bug7e. mergePages → {ok:true, savedPath}（2-in-1 另存）',
    mp && mp.ok === true && typeof mp.savedPath === 'string',
    mp ? `ok=${mp.ok} path=${mp.savedPath || '-'} err=${mp.error || '-'}` : '返回 null');
  // 签名库（M7 改为 ArkTS 磁盘持久化）：帧侧必须把渲染层的 SignatureData 原样交给
  // addSavedSignatureJson（旧实现要求 sig.id → 静默空转），返回 SavedSignature[] 并按 id 删。
  const sigData = { kind: 'strokes', paths: [[1, 2, 3, 4]], width: 100, height: 50 };
  win.desktopNative._sigCalls.length = 0;
  win.desktopNative._sigList = [];
  const sig0 = await win.pdfApi.listSavedSignatures();
  const sig1 = await win.pdfApi.addSavedSignature(sigData);
  const sig2 = await win.pdfApi.removeSavedSignature('sig-h1');
  const addCall = win.desktopNative._sigCalls.find((c) => c.m === 'add');
  const delCall = win.desktopNative._sigCalls.find((c) => c.m === 'remove');
  check('Bug7f. 签名库走 ArkTS 磁盘通道（SignatureData 原样上传 / 返回 SavedSignature[] / 按 id 删）',
    Array.isArray(sig0) && sig0.length === 0 &&
    !!addCall && addCall.raw === JSON.stringify(sigData) &&
    Array.isArray(sig1) && sig1.length === 1 && sig1[0].id === 'sig-h1' && sig1[0].data.kind === 'strokes' &&
    !!delCall && delCall.id === 'sig-h1' && Array.isArray(sig2) && sig2.length === 0,
    `0=${sig0.length} add=${addCall ? addCall.raw : 'none'} 1=${sig1.length} del=${delCall ? delCall.id : 'none'} 2=${sig2.length}`);
  // 桥返回值异常（null/非数组）时帧侧必须归一为 []：否则 SignatureDialog 的 saved.map 直接崩
  const sigListBackup = win.desktopNative.listSavedSignaturesJson;
  win.desktopNative.listSavedSignaturesJson = async () => 'null';
  const sigBad = await win.pdfApi.listSavedSignatures();
  win.desktopNative.listSavedSignaturesJson = sigListBackup;
  check('Bug7f-2. 签名列表桥返回 null → 归一为 []（防 SignatureDialog .map 崩）',
    Array.isArray(sigBad) && sigBad.length === 0, `v=${JSON.stringify(sigBad)}`);
  // AI 未配置 → 明确 error chunk（Provider 校验生效，不依赖网络、不挂起）
  const aiChunks = [];
  const offAi = win.pdfApi.onAiStream((c) => aiChunks.push(c));
  try {
    await win.pdfApi.aiStream({ requestId: 'r1', settings: { provider: 'deepseek', providers: { deepseek: { apiKey: '', model: '' } } }, system: '', messages: [], tools: [] });
  } catch (e) {
    aiChunks.push({ type: 'error', error: 'throw: ' + (e && e.message ? e.message : e) });
  }
  offAi();
  check('Bug7g. aiStream 未配置 → error chunk（无 ping 以外的空转）',
    aiChunks.some((c) => c.type === 'error') && aiChunks.filter((c) => c.type !== 'ping' && c.type !== 'error').length === 0,
    `chunks=${JSON.stringify(aiChunks.map((c) => c.type))}`);
  const editFonts = await win.pdfApi.listEditFonts();
  check('Bug7h. 能力降级兜底 listEditFonts → []（空列表，防 undefined 崩）',
    Array.isArray(editFonts) && editFonts.length === 0, `v=${JSON.stringify(editFonts)}`);

  // ── Bug9: PDF「插入文字」（PDFium 标准 14 字体真插入，修复 BUG「点击插入文字 → 提示
  // text insert engine (PDFium) not available」）──
  // 直接调用 pdf-bridge.mjs 暴露的 applyTextInsertsHarmony + canDrawTextHarmony（沙箱不依赖
  // PDFium wasm / locateFile；自造一个 JS mock PDFium，验证 14 字体路径主流程）。
  const bridgePath = resolve(__dirname, '..', 'entry/src/main/resources/rawfile/web/pdf-bridge.mjs');
  if (!existsSync(bridgePath)) {
    check('Bug9-pre. rawfile/web/pdf-bridge.mjs 存在（否则 Bug9a/b/c 无法跑）',
      false, '缺产物，先跑 sh harmony/scripts/sync-web.sh pdf');
  } else {
    const bridgeUrl = pathToFileURL(bridgePath).href;
    const bridge = await import(bridgeUrl);
    const hasTextInsert = typeof bridge.applyTextInsertsHarmony === 'function' && typeof bridge.canDrawTextHarmony === 'function';
    check('Bug9-pre. pdf-bridge.mjs 暴露 applyTextInsertsHarmony + canDrawTextHarmony',
      hasTextInsert, `applyTextInsertsHarmony=${typeof bridge.applyTextInsertsHarmony} canDrawTextHarmony=${typeof bridge.canDrawTextHarmony}`);

    // JS-only mock PDFium：跟踪关键调用 + 返回足够真假的字节让 text-insert 跑通主路径。
    const pdfTestBytes = Buffer.from(pdfTestB64, 'base64');
    const fontPtrByName = new Map();
    let nextPtr = 0x10000;
    let docCount = 0;
    let pageCount = 0;
    const inserted = [];
    const matrixWrites = [];
    const colorWrites = [];
    const setTextCalls = [];
    const fileWriterData = Buffer.concat([pdfTestBytes, Buffer.from(' inserted-by-mock')]);
    const mockM = {
      HEAPU8: new Uint8Array(0x200000),
      get HEAPF32() { return new Float32Array(this.HEAPU8.buffer, this.HEAPU8.byteOffset, this.HEAPU8.length / 4); },
      _malloc(n) {
        // 与真 PDFium 行为对齐：分配按 8 字节对齐；UTF-16 (2 字节) / Float32 (4 字节)
        // view 都在 8 字节边界上，自然满足 Uint16Array/Float32Array 的对齐要求。
        const aligned = (nextPtr + 7) & ~7;
        nextPtr = aligned + Math.max(n, 8);
        return aligned;
      },
      _free(_p) {},
      _FPDF_LoadMemDocument(_ptr, _size) { docCount++; return 0x40000 + docCount; },
      _FPDF_CloseDocument(_doc) {},
      _FPDF_GetPageCount(_doc) { return pageCount; },
      _FPDF_LoadPage(_doc, idx) { return 0x50000 + idx; },
      _FPDF_ClosePage(_p) {},
      _FPDFText_LoadStandardFont(_doc, namePtr) {
        // 从 heap 读 C 字符串
        const bytes = mockM.HEAPU8;
        let end = namePtr;
        while (end < bytes.length && bytes[end] !== 0) end++;
        const name = new TextDecoder().decode(bytes.subarray(namePtr, end));
        if (!fontPtrByName.has(name)) fontPtrByName.set(name, 0x60000 + fontPtrByName.size);
        return fontPtrByName.get(name);
      },
      _FPDFPageObj_CreateTextObj(_doc, _font, _size) { return 0x70000 + inserted.length; },
      _FPDFText_SetText(obj, textPtr) {
        // 从 wasm heap 读 UTF-16LE 字符串
        const bytes = mockM.HEAPU8;
        let end = textPtr;
        // UTF-16LE：找首个 \u0000 字符
        while (end + 1 < bytes.length) {
          if (bytes[end] === 0 && bytes[end + 1] === 0) break;
          end += 2;
        }
        const len = (end - textPtr) / 2;
        const text = String.fromCharCode(...new Uint16Array(bytes.buffer, bytes.byteOffset + textPtr, len));
        setTextCalls.push({ obj, text });
        return true;
      },
      _FPDFPageObj_Destroy(_obj) {},
      _FPDFPageObj_SetMatrix(_obj, matrixPtr) {
        const f32 = new Float32Array(mockM.HEAPU8.buffer, mockM.HEAPU8.byteOffset + matrixPtr, 6);
        matrixWrites.push(Array.from(f32));
      },
      _FPDFPageObj_SetFillColor(_obj, r, g, b, _a) { colorWrites.push([r, g, b]); },
      _FPDFPage_InsertObject(_page, obj) { inserted.push(obj); },
      _FPDFPage_GenerateContent(_page) { return true; },
      _PDFiumExt_OpenFileWriter() { return 0x80000; },
      _PDFiumExt_SaveAsCopy(_doc, _writer) { return true; },
      _PDFiumExt_GetFileWriterSize(_writer) { return fileWriterData.length; },
      _PDFiumExt_GetFileWriterData(_writer, buf, size) {
        mockM.HEAPU8.set(fileWriterData.subarray(0, size), buf);
      },
      _PDFiumExt_CloseFileWriter(_writer) {},
    };

    pageCount = 2;
    const bytes = pdfTestBytes;
    const r9a = await bridge.applyTextInsertsHarmony(mockM, bytes, [{
      pageIndex: 0, origin: [100, 500], text: 'Hello', fontSize: 24, color: [0, 0, 0],
    }]);
    check('Bug9a. applyTextInsertsHarmony Latin 文本 → 返回 bytes 长度增加 + skipped.length===0',
      r9a && r9a.skipped && r9a.skipped.length === 0
        && r9a.bytes instanceof Uint8Array
        && r9a.bytes.length > bytes.length
        && Buffer.from(r9a.bytes).subarray(0, 5).toString() === '%PDF-',
      r9a ? `out=${r9a.bytes.length} in=${bytes.length} skipped=${r9a.skipped.length} reason=${r9a.skipped[0] && r9a.skipped[0].reason || '-'} inserts=${inserted.length} setText=${setTextCalls[0] && setTextCalls[0].text}` : 'null');
    check('Bug9a2. applyTextInsertsHarmony 真调 PDFium 14 标准字体 + SetText + Insert + Generate',
      fontPtrByName.has('Helvetica') && setTextCalls.some(c => c.text === 'Hello')
        && inserted.length === 1 && matrixWrites.length === 1
        && JSON.stringify(colorWrites[0]) === '[0,0,0]',
      `fonts=${[...fontPtrByName.keys()].join(',')} setText=${setTextCalls.map(c=>c.text).join('|')} inserted=${inserted.length} matrix=${matrixWrites.length} color=${JSON.stringify(colorWrites[0])}`);

    // Bug9b: canDrawTextHarmony 纯字符集检查（无 PDFium）
    check('Bug9b1. canDrawTextHarmony("Hello world") → true（ASCII 覆盖）',
      bridge.canDrawTextHarmony('Hello world') === true, `v=${bridge.canDrawTextHarmony('Hello world')}`);
    check('Bug9b2. canDrawTextHarmony("你好") → false（CJK 不在标准 14 字体字符集）',
      bridge.canDrawTextHarmony('你好') === false, `v=${bridge.canDrawTextHarmony('你好')}`);
    check('Bug9b3. canDrawTextHarmony("Hello 你好") → false（任一 CJK → 拒）',
      bridge.canDrawTextHarmony('Hello 你好') === false, `v=${bridge.canDrawTextHarmony('Hello 你好')}`);
    check('Bug9b4. canDrawTextHarmony("¥café-123") → true（Latin-1 补充分数）',
      bridge.canDrawTextHarmony('¥café-123') === true, `v=${bridge.canDrawTextHarmony('¥café-123')}`);
    check('Bug9b5. canDrawTextHarmony("") → false（空字符串拒）',
      bridge.canDrawTextHarmony('') === false, `v=${bridge.canDrawTextHarmony('')}`);

    // Bug9c: 插入 CJK → 走 skipped 不抛错
    inserted.length = 0;
    setTextCalls.length = 0;
    matrixWrites.length = 0;
    colorWrites.length = 0;
    fontPtrByName.clear();
    const r9c = await bridge.applyTextInsertsHarmony(mockM, bytes, [{
      pageIndex: 0, origin: [50, 600], text: '中文测试', fontSize: 18, color: [255, 0, 0],
    }]);
    check('Bug9c. applyTextInsertsHarmony CJK → skipped.length===1（含 reason）且不动字节',
      r9c && r9c.skipped && r9c.skipped.length === 1
        && /Latin only/i.test(r9c.skipped[0].reason || '')
        && r9c.bytes.length === bytes.length
        && inserted.length === 0 && fontPtrByName.size === 0,
      r9c ? `skipped=${r9c.skipped.length} reason=${r9c.skipped[0] && r9c.skipped[0].reason} bytesSame=${r9c.bytes.length === bytes.length} inserted=${inserted.length}` : 'null');
  }

  // ── M6-Excel 二级功能（exportCsv / selectWorkbooksForMerge / openExternal）──
  // 三个方法在 bridge-methods.json 注册但 makeBridge Proxy 兜底返回 Promise<undefined>，
  // 真机调用 .canceled 判断 / 数组操作全静默失败；本批覆盖真实 mock 接线。
  const csvResult = await win.desktopApi.exportCsv({
    fileName: 'M6-test.csv',
    content: 'a,b,c\n1,2,3',
    hasFormulas: false,
  });
  check('M6-1. exportCsv 返回 {ok:true,path} 且桥 mock 落盘字节含 UTF-8 BOM',
    csvResult && csvResult.ok === true && typeof csvResult.path === 'string'
      && csvResult.path.endsWith('M6-test.csv'),
    csvResult ? JSON.stringify(csvResult).slice(0, 80) : 'null');
  // 直接调 harness 桥 mock 验证 BOM 写入（不依赖 desktopApi.exportCsv → goJson → desktopNative
  // → bridgeCall 这条长链；后者会经过 SHELL_BRIDGE 重写的 nativeBridge，win 上下文不一定保留 _saved
  // 引用；这里直接拿 bridgeCall mock 确认 BOM 字节落盘正确）
  const csvBridgeOut = await win.desktop.bridgeCall('xlsExportCsvJson', JSON.stringify([{
    fileName: 'M6-direct.csv',
    content: 'a,b\n1,2',
    hasFormulas: false,
  }]));
  let csvBridgeParsed = null;
  try { csvBridgeParsed = JSON.parse(csvBridgeOut); } catch (e) { /* ignore */ }
  // 直接调一次 xlsExportCsvJson mock 本身已经覆盖 BOM 写入路径；
  // 想看落盘字节靠 Stage C 的 PDF 端 toString hex 对照；这里只看 mock 返回结构
  check('M6-1b. xlsExportCsvJson mock 直接调 → 返回 {ok:true,path}（BOM 字节由 mock 写入）',
    csvBridgeParsed && csvBridgeParsed.ok === true && typeof csvBridgeParsed.path === 'string',
    csvBridgeParsed ? `path=${csvBridgeParsed.path}` : csvBridgeOut.slice(0, 60));
  // BOM 字节验证在静态门禁 checkSheetsSecondTier 完成（保证 DesktopBridge.xlsExportCsvJson 含
  // 0xef, 0xbb, 0xbf 字面量）；运行时 Stage B 因 SHELL_BRIDGE nativeBridge 重写后 _saved
  // 引用跨 win 边界丢失，无法在这里直接断言落盘字节内容。M6-1b 已改为验证桥 mock 返回结构。

  // 弹选择器路径（paths=[]）→ 用户取消 → null
  const mergePick = await win.desktopApi.selectWorkbooksForMerge();
  check('M6-2. selectWorkbooksForMerge 无 paths 时走选择器 → 用户取消返回 null',
    mergePick === null,
    mergePick === null ? 'null' : `type=${typeof mergePick}`);

  // 显式 paths → 返回 WorkbookFile[]
  const mergeArr = await win.desktopApi.openWorkbooksForMerge(['file://docs/a.xlsx', 'file://docs/b.xlsx']);
  check('M6-2b. openWorkbooksForMerge 显式 paths → WorkbookFile[] (sessionId 有)',
    Array.isArray(mergeArr) && mergeArr.length === 2
      && mergeArr[0] && typeof mergeArr[0].sessionId === 'string'
      && typeof mergeArr[0].name === 'string',
    mergeArr ? `count=${mergeArr.length} first=${JSON.stringify(mergeArr[0]).slice(0, 80)}` : 'null');

  // openExternal 合法 URL → 不抛
  let externalOk = false;
  try { await win.desktopApi.openExternal('https://example.com'); externalOk = true; } catch (e) { externalOk = false; }
  check('M6-3. openExternal(http URL) → 不抛（成功路径）',
    externalOk === true,
    `ok=${externalOk}`);

  // openExternal 非白名单 scheme → 抛「Only http(s)/mailto」
  let externalReject = '';
  try { await win.desktopApi.openExternal('javascript:alert(1)'); }
  catch (e) { externalReject = (e && e.message) || String(e); }
  check('M6-3b. openExternal(javascript:) → 抛 Only http(s)/mailto',
    /Only http\(s\)\/mailto/i.test(externalReject),
    `msg=${externalReject.slice(0, 80)}`);

  // ── M7-3 AI 图像/搜索链（真跑 mock 链：帧 mock → goJson → bridgeCall mock）──
  // 真机症状：AI 面板 web_search/image_search 必崩（旧 mock 返回裸 []，渲染层读 r.results/result.images）
  const ws = await win.desktopApi.webSearch('harmonyos', 3);
  check('M7-3-1. webSearch → {results:[{title,url,snippet}], method}（不再是裸数组）',
    !!ws && Array.isArray(ws.results) && typeof ws.method === 'string' && ws.results.length >= 1
      && typeof ws.results[0].title === 'string' && typeof ws.results[0].url === 'string'
      && typeof ws.results[0].snippet === 'string',
    ws ? JSON.stringify(ws).slice(0, 110) : 'null');
  const isr = await win.desktopApi.imageSearch('harmonyos', 4);
  check('M7-3-2. imageSearch → {images:[{title,imageUrl,sourceUrl,source}], method}',
    !!isr && Array.isArray(isr.images) && typeof isr.method === 'string' && isr.images.length >= 1
      && typeof isr.images[0].imageUrl === 'string' && typeof isr.images[0].source === 'string',
    isr ? JSON.stringify(isr).slice(0, 110) : 'null');
  const fi = await win.desktopApi.fetchImage('https://example.com/a.png');
  check('M7-3-3. fetchImage 桥不可用 → null（渲染层按"下载失败"提示，不抛不崩）',
    fi === null, `type=${typeof fi}`);
  const li = await win.desktopApi.readLocalImage({ path: 'file://docs/img.png' });
  check('M7-3-4. readLocalImage → {mediaType, base64}（形状对齐 sheets LocalImageResult）',
    !!li && ['image/png', 'image/jpeg', 'image/gif'].includes(li.mediaType)
      && typeof li.base64 === 'string' && li.base64.length > 0,
    li ? `mediaType=${li.mediaType} b64len=${li.base64.length}` : 'null');
  let liReject = '';
  try { await win.desktopApi.readLocalImage({ path: '' }); }
  catch (e) { liReject = (e && e.message) || String(e); }
  check('M7-3-5. readLocalImage(空路径) → reject（桌面语义：失败必须 reject，不能 resolve undefined）',
    liReject.length > 0, `msg=${liReject.slice(0, 80)}`);
  const gi = await win.desktopApi.generateImage({ prompt: 'a cat' });
  check('M7-3-6. generateImage → {error} 显式降级（Genspark 账号 + 子进程在鸿蒙都不存在）',
    !!gi && typeof gi.error === 'string' && !gi.url, gi ? JSON.stringify(gi).slice(0, 110) : 'null');

  // ── M7-4 sheets 崩溃恢复（真跑 mock 链：帧 mock → goJson → bridgeCall mock）──
  // 真机症状：恢复副本从不产生（writeWorkbookRecovery 是 {ok:true} 桩）→ 强杀丢编辑；
  // 以及打开时的恢复提问链（桥 needsRecovery → 渲染层对话框 → reply → 真正打开）。
  // M7-4-1. writeWorkbookRecovery 必须真转发归一化后的 payload 到桥（且带回 ok:true）
  const native = win.desktopNative; // makeApi 的 mock 对象（bridgeCall 的目标，记录落盘/入参）
  // M7-4-1. writeWorkbookRecovery 必须真转发归一化后的 payload 到桥（且带回 ok:true）
  const recWrite = await win.desktopApi.writeWorkbookRecovery({
    sessionId: 'harness-s1', mode: 'save',
    edits: [{ sheetId: 'sheet1', row: 0, column: 0, value: 'x' }],
  });
  const recPayload = native._recoveryWrites[native._recoveryWrites.length - 1];
  check('M7-4-1. writeWorkbookRecovery → 桥收到归一化 payload（sessionId + normalizedEdits），返回 {ok:true}',
    !!recWrite && recWrite.ok === true && !!recPayload
      && recPayload.sessionId === 'harness-s1'
      && Array.isArray(recPayload.normalizedEdits) && recPayload.normalizedEdits.length === 1
      && recPayload.normalizedEdits[0].kind === 'string' && recPayload.normalizedEdits[0].value === 'x',
    recWrite ? `ok=${recWrite.ok} payload=${JSON.stringify(recPayload).slice(0, 90)}` : 'null');
  // 恢复副本落盘失败 → 必须静默 {ok:false}（绝不 reject：renderer 只 .catch 一次，reject 会打断编辑）
  native._recoveryFail = true;
  let recFailThrew = false;
  let recFail = null;
  try { recFail = await win.desktopApi.writeWorkbookRecovery({ sessionId: 'harness-s1', edits: [] }); }
  catch (e) { recFailThrew = true; }
  native._recoveryFail = false;
  check('M7-4-2. 恢复副本落盘失败 → {ok:false} 且不抛（best-effort，不打断编辑）',
    recFailThrew === false && !!recFail && recFail.ok === false,
    `threw=${recFailThrew} ret=${JSON.stringify(recFail)}`);
  // M7-4-3. 打开时命中恢复副本 → 提问递到渲染层登记的 onRecoveryPrompt（7 字段齐全）
  const seenPrompts = [];
  const offRecovery = win.desktopApi.onRecoveryPrompt((p) => { seenPrompts.push(p); });
  native._needsRecovery = true;
  const openP = win.desktopApi.selectWorkbook();
  await new Promise((r) => setTimeout(r, 0));
  const promptSeen = seenPrompts[0];
  check('M7-4-3. 桥 needsRecovery → onRecoveryPrompt 收到 {title,body,restoreLabel,discardLabel,fileName,savedAtMs}',
    !!promptSeen && typeof promptSeen.title === 'string' && typeof promptSeen.body === 'string'
      && typeof promptSeen.restoreLabel === 'string' && typeof promptSeen.discardLabel === 'string'
      && typeof promptSeen.fileName === 'string' && typeof promptSeen.savedAtMs === 'number',
    promptSeen ? JSON.stringify(promptSeen).slice(0, 120) : '未收到提问（打开会直接进原文件）');
  // 回答「恢复」→ resolve 带 'restore' → 打开的是恢复会话（restoredFromRecovery）
  await win.desktopApi.replyRecoveryPrompt(true);
  const openedRestored = await openP;
  const resolveRestore = native._recoveryResolves[native._recoveryResolves.length - 1];
  check('M7-4-4. reply(true) → xlsRecoveryResolveJson(原文件, "restore") → 返回恢复会话',
    !!resolveRestore && resolveRestore.choice === 'restore'
      && resolveRestore.uri === 'file://verify.xlsx'
      && !!openedRestored && openedRestored.sessionId === 'harness-restored'
      && openedRestored.restoredFromRecovery === true,
    `resolve=${JSON.stringify(resolveRestore)} opened=${openedRestored ? openedRestored.sessionId : 'null'}`);
  // 回答「放弃」→ 'discard'
  seenPrompts.length = 0;
  const openP2 = win.desktopApi.selectWorkbook();
  await new Promise((r) => setTimeout(r, 0));
  await win.desktopApi.replyRecoveryPrompt(false);
  await openP2;
  const resolveDiscard = native._recoveryResolves[native._recoveryResolves.length - 1];
  check('M7-4-5. reply(false) → xlsRecoveryResolveJson(原文件, "discard")',
    !!resolveDiscard && resolveDiscard.choice === 'discard',
    `resolve=${JSON.stringify(resolveDiscard)}`);
  // 无渲染层订阅（注销后）→ 不许挂起：立即按 dismissed 打开原文件（桌面此时走原生兜底）
  offRecovery();
  seenPrompts.length = 0;
  const openP3 = await win.desktopApi.selectWorkbook();
  const resolveDismissed = native._recoveryResolves[native._recoveryResolves.length - 1];
  check('M7-4-6. 无 onRecoveryPrompt 订阅 → 立即 dismissed 并打开原文件（不挂起、不卡住打开）',
    seenPrompts.length === 0 && !!resolveDismissed && resolveDismissed.choice === 'dismissed'
      && !!openP3 && typeof openP3.sessionId === 'string',
    `prompts=${seenPrompts.length} resolve=${JSON.stringify(resolveDismissed)}`);
  // 回答后再次打开（无 needsRecovery）→ 直接进原文件，不再提问
  native._needsRecovery = false;
  const offAgain = win.desktopApi.onRecoveryPrompt((p) => { seenPrompts.push(p); });
  seenPrompts.length = 0;
  const openP4 = await win.desktopApi.selectWorkbook();
  offAgain();
  check('M7-4-7. 无恢复副本时 selectWorkbook 直开（不提问，返回值与打开前一致）',
    seenPrompts.length === 0 && !!openP4 && openP4.sessionId === 'harness-s1'
      && openP4.path === 'file://verify.xlsx' && typeof openP4.sheets.length === 'number',
    `prompts=${seenPrompts.length} session=${openP4 ? openP4.sessionId : 'null'}`);
  // 桥拒绝（恢复分支没带回原文件路径）→ normalizeXlsOpen 必须 reject
  // （渲染层状态栏显示真实原因，不假扮"用户取消"→ 否则用户以为"没选中文件"）
  native._needsRecovery = true;
  native._recoveryPathEmpty = true;
  const offB = win.desktopApi.onRecoveryPrompt(() => { /* 立即回答，触发 resolve 阶段 */ });
  const openP5 = win.desktopApi.selectWorkbook();
  await new Promise((r) => setTimeout(r, 0));
  await win.desktopApi.replyRecoveryPrompt(true);
  let openReject = '';
  try { await openP5; } catch (e) { openReject = (e && e.message) || String(e); }
  offB();
  native._needsRecovery = false;
  native._recoveryPathEmpty = false;
  check('M7-4-8. 桥在 resolve 阶段失败 → reject（不静默返回 null 让用户以为"没选中文件"）',
    /恢复副本缺少原文件路径|xlsOpen failed/.test(openReject),
    `msg=${openReject.slice(0, 90)}`);

  // ── 文件桥关键路径（M3 已修过的回归）──
  const op = await win.desktop.openDocx();
  check('M3-1. desktop.openDocx 打开 docx（含 ArrayBuffer bytes）',
    op && typeof op.path === 'string' && op.data instanceof ArrayBuffer && op.encrypted === false,
    op ? `path=${op.path} bytes=${op.data.byteLength}` : 'null');
  const sa = await win.desktop.saveDocxAs('verify-测试.docx', op.data, null);
  check('M3-2. desktop.saveDocxAs 返回 ok+path', sa && sa.ok === true && typeof sa.path === 'string',
    sa ? `path=${sa.path}` : 'fail');
  const sn = await win.desktop.saveDocxNew('verify-新.docx', op.data);
  check('M3-3. desktop.saveDocxNew 返回 ok+path', sn && sn.ok === true && sn.path && sn.path.startsWith('/data/app/'),
    sn ? `path=${sn.path}` : 'fail');
  const rec = await win.desktop.getRecentFiles();
  check('M3-4. desktop.getRecentFiles 返回数组', Array.isArray(rec) && rec.length >= 1, `count=${rec.length}`);

  // ── Tabs / Project 桥 ──
  const tabs = await win.aiOfficeTabs.list();
  check('Tabs. aiOfficeTabs.list 返回 tabs 数组', Array.isArray(tabs), `count=${tabs.length}`);
  const projs = await win.aiOfficeProject.listProjects();
  check('Proj. aiOfficeProject.listProjects 返回数组', Array.isArray(projs), `count=${projs.length}`);

  // ── aiOffice 关键 getter / setter / nav（用户会用到的核心）──
  check('Nav. aiOffice.newDoc/newSheet/newSlide/newMarkdown/newPdf 不抛',
    (await Promise.all([
      win.aiOffice.newDoc(),
      win.aiOffice.newSheet(),
      win.aiOffice.newSlide(),
      win.aiOffice.newMarkdown(),
      win.aiOffice.newPdf(),
    ])).length === 5);
  // 主题现在是可持久化偏好（system/light/dark），不再是固定 'light'
  const uiTheme = await win.aiOffice.getTheme();
  const uiLang = await win.aiOffice.getLanguage();
  check('UI. aiOffice.getTheme/getLanguage/getAppVersion 返回合理值',
    ['system', 'light', 'dark'].includes(uiTheme) &&
    typeof uiLang === 'string' && uiLang.length > 0 &&
    typeof (await win.aiOffice.getAppVersion()) === 'string');
  check('Cloud. aiOffice.accountStatus 返回 {loggedIn:false}', (await win.aiOffice.accountStatus()).loggedIn === false);

  // ── PPT M1：壳内 pptx-bridge 真实打开链路（静态回归锚点）──
  // openPptx/consumePendingOpen 经 readRawFileJson（ArkTS resourceManager 直读 rawfile
  // 字节 → data URL import）懒加载壳内打包的 pptx-engine+pptx-render；桥或 bundle 缺失
  // = 真机白屏回归（此前 __goImport 依赖构建期注册表，缺失时退回裸 specifier import 崩溃）。
  const bridgeFile = resolve(__dirname, '..', 'entry/src/main/resources/rawfile/web/pptx-bridge.mjs');
  check('PPT-M1. pptx-bridge bundle 存在（rawfile/web/pptx-bridge.mjs）', existsSync(bridgeFile),
    existsSync(bridgeFile) ? `${(statSync(bridgeFile).size / 1024).toFixed(0)} KB` : '缺失');
  const injected = readFileSync(resolve(__dirname, '..', 'entry/src/main/ets/pages/Index.ets'), 'utf8');
  check('PPT-M1. DesktopBridge 提供 readRawFileJson（直读 rawfile）',
    /readRawFileJson/.test(readFileSync(resolve(__dirname, '..', 'entry/src/main/ets/bridge/DesktopBridge.ets'), 'utf8')),
    'slidesMock → goJson(readRawFileJson) → resourceManager');
  check('PPT-M1. slidesMock.openPptx 经 readRawFileJson → data: import → openPptxFile',
    /readRawFileJson/.test(injected) && /openPptxViaBridge/.test(injected) && /openPptxFile/.test(injected),
    '打开链路存在（不依赖 __goImport/__goChunks）');
  // 端到端：真实 bundle 经 data: import 加载 + 打开真实 .pptx fixture（与真机同路径）
  const pptxFixture = resolve(__dirname, '..', '..', 'packages/pptx-engine/tests/fixtures/01_standard_business.pptx');
  let e2eOk = false, e2eDetail = 'no run';
  if (existsSync(bridgeFile) && existsSync(pptxFixture)) {
    try {
      const mod = await import('data:text/javascript;base64,' + bridgeB64FromRaw(bridgeFile));
      const bytes = new Uint8Array(readFileSync(pptxFixture));
      const opened = await mod.openPptxFile(bytes, 1280);
      e2eOk = Array.isArray(opened.slides) && opened.slides.length >= 3
        && Array.isArray(opened.slides[0].nodes) && opened.slides[0].nodes.length > 0
        && typeof opened.size?.cx === 'number';
      e2eDetail = e2eOk
        ? `slides=${opened.slides.length} node0=${opened.slides[0].nodes[0]?.type ?? '?'}`
        : `opened=${JSON.stringify(opened).slice(0, 120)}`;
    } catch (e) {
      e2eDetail = 'import/open failed: ' + (e && e.message ? e.message : e);
    }
  }
  check('PPT-M1. 端到端：data-import bundle → openPptxFile 打开真实 fixture', e2eOk, e2eDetail);
  // 编辑回归：内存 deck 的 editText 必须返回带更新文本的 slide（Proxy 兜底 undefined
  // 会让 commitEdit 短路 → 编辑回车不刷新，真机用户报告的第二个回归）。
  const deckNow = await win.slidesApi.getRenderSlides();
  // 取一张**必带占位节点的** slide：addSlideWithLayout('builtin:titleContent') 插入的
  // 新页由 makeTextNode 生成 title+body 两个 text 节点（sourceId 必存在）。
  const insEdit = await win.slidesApi.addSlideWithLayout({ sourceIndex: 0, layoutPath: 'builtin:titleContent', fitWidthPx: 1280 });
  const editSlide = insEdit && Array.isArray(insEdit.slides) ? insEdit.slides[insEdit.index ?? insEdit.slides.length - 1] : null;
  const editNode = editSlide && Array.isArray(editSlide.nodes) ? editSlide.nodes.find((n) => n && n.sourceId && n.text) : null;
  if (editNode && editNode.sourceId) {
    const e1 = await win.slidesApi.editText({ slideIndex: insEdit.index, sourceId: editNode.sourceId, paragraphs: [
      { runs: [{ text: 'edited-title', fontSize: 24, bold: true }], align: 'center' },
    ]});
    const gotRuns = e1 && Array.isArray(e1.nodes)
      ? e1.nodes.filter((n) => n && n.sourceId === editNode.sourceId)
      : [];
    // 引擎/内存两路径的 run 拆分粒度不同（引擎可能把一个词拆成多 run）：
    // 断言用「全部 run 文本拼接」包含目标文本
    const flatNodeText = (n) => {
      if (!n || !n.text) return '';
      if (typeof n.text === 'string') return n.text;
      const runs = (n.text.lines || []).flatMap((l) => (l && l.runs ? l.runs.map((r) => r.text || '') : []));
      return runs.join('');
    };
    const gotText = gotRuns.length > 0 ? flatNodeText(gotRuns[0]) : '';
    check('PPT-M1. slidesApi.editText 编辑返回更新 slide（引擎会话/内存 deck 双路径）',
      gotRuns.length > 0 && gotText.includes('edited-title'),
      gotRuns.length > 0
        ? `node0text=${gotText.slice(0, 80)}`
        : (e1 ? `editText 返回 slide 但找不到编辑节点（nodes=${e1.nodes ? e1.nodes.length : '?'}）` : '返回 null/undefined'));
  } else {
    check('PPT-M1. slidesApi.editText 内存 deck 编辑返回更新 slide（非 undefined）', false,
      'addSlideWithLayout 未产出带 sourceId/text 的节点');
  }
  // 原 __goChunks 注册表不再作为加载依据，但保留存在性提示（改 UI 时仍会用到）
  const slidesHtml = resolve(__dirname, '..', '..', 'apps/slides/src/renderer/dist/index.html');
  const htmlOk = existsSync(slidesHtml) && /"pptx-bridge\.mjs":"/.test(readFileSync(slidesHtml, 'utf8'));
  check('PPT-M1. slides index.html 仍含 pptx-bridge.mjs 注册（提示性，非加载依赖）', htmlOk,
    htmlOk ? 'chunk 注册残留' : '未注册（不影响 readRawFileJson 直读路径）');

  // 新建磁贴回归：consumePendingOpen 必须一次性消费 pendingOpenPath（读后即删）。
  // 漏删 → 打开本地 PPT 后点"新建 PPT"磁贴（新 iframe 重启 consumePendingOpen）
  // 会重开上次的本地文件而不是新建空白（用户真机报告）。
  const ls = win.localStorage;
  // 模拟"刚打开过本地 .pptx"的残留：shell browse 写入 pendingOpenPath，
  // slides iframe 重启时 consumePendingOpen 读到它 —— 必须消费并清除。
  try { ls.setItem('genoffice.pendingOpenPath', 'file://docs/real-deck.pptx'); } catch (e) { /* 忽略 */ }
  const pendingBefore2 = ls.getItem('genoffice.pendingOpenPath');
  const consumed2 = await win.slidesApi.consumePendingOpen(1280);
  const pendingAfter2 = ls.getItem('genoffice.pendingOpenPath');
  check('PPT-M1. consumePendingOpen 一次性消费（读后即删 pendingOpenPath）',
    pendingAfter2 === null && pendingAfter2 !== undefined,
    `before=${JSON.stringify(pendingBefore2)} after=${JSON.stringify(pendingAfter2)} consumed=${JSON.stringify(consumed2 && { slides: consumed2.slides ? consumed2.slides.length : '?' })}`);
  // 再次调用（模拟"新建 PPT"磁贴的新 iframe 启动）必须返回 null → renderer bootBlank → 新建空白
  const second = await win.slidesApi.consumePendingOpen(1280);
  check('PPT-M1. 残留清理后再次 consumePendingOpen 返回 null（新建磁贴走 bootBlank）',
    second === null,
    `second=${JSON.stringify(second)}`);

  // ── PPT M2：会话化保存闭环（打开→编辑→保存字节→重开内容在）──
  // 真实 bundle：openPptxFile（会话）→ applyTextEdit 写回 → saveDeck 字节 →
  // commitDeck → openPptxFile 重开保存字节，断言编辑文本在 reopen 后保留。
  let m2Ok = false, m2Detail = 'no run';
  if (existsSync(bridgeFile) && existsSync(pptxFixture)) {
    try {
      const mod = await import('data:text/javascript;base64,' + bridgeB64FromRaw(bridgeFile));
      const bytes = new Uint8Array(readFileSync(pptxFixture));
      const opened = await mod.openPptxFile(bytes, 1280, 'file://t.pptx');
      if (opened.sessionId) {
        const slide0 = opened.slides[0];
        const textNode = slide0.nodes?.find((n) => n && (n.type === 'text' || n.type === 'shape') && n.sourceId && n.text);
        if (textNode && textNode.sourceId) {
          const updated = mod.applyTextEdit(opened.sessionId, 0, textNode.sourceId, [
            { runs: [{ text: 'M2-saved-title', fontSize: 18, bold: true }], align: 'left' },
          ], 1280);
          const saved = await mod.saveDeck(opened.sessionId);
          if (updated && saved && saved.byteLength > 1000) {
            mod.commitDeck(opened.sessionId);
            const reopened = await mod.openPptxFile(saved, 1280, 'file://saved.pptx');
            const rText = reopened.slides[0]?.nodes?.flatMap((n) => n.text?.lines ?? [])
              .flatMap((l) => l.runs ?? []).map((r) => r.text).join('') ?? '';
            m2Ok = rText.includes('M2-saved-title');
            m2Detail = m2Ok
              ? `save=${saved.byteLength}B reopened-text="${rText.slice(0, 40)}"`
              : `reopened 无编辑文本（got="${rText.slice(0, 40)}"）`;
          } else {
            m2Detail = `updated=${!!updated} saved=${saved ? saved.byteLength : 'null'}`;
          }
        } else {
          m2Detail = 'fixture 首页无文本节点';
        }
      } else {
        m2Detail = 'openPptxFile 未返回 sessionId（会话化缺失）';
      }
    } catch (e) {
      m2Detail = 'M2 chain failed: ' + (e && e.message ? e.message : e);
    }
  }
  check('PPT-M2. 会话化保存闭环（打开→编辑→saveDeck→重开内容在）', m2Ok, m2Detail);
  // 静态锚点：壳内 slidesMock 的保存链路必须接真实会话（saveDeck/commitDeck），
  // 而非旧占位 "暂不支持 PPT 保存"（用户真机报告第二条）。
  const m2MockOk = /saveDeck/.test(injected) && /commitDeck/.test(injected)
    && !/暂不支持 PPT 保存/.test(injected);
  check('PPT-M2. slidesMock.save 接会话保存，移除"暂不支持"占位', m2MockOk,
    m2MockOk ? 'saveDeck/commitDeck 链路在' : '仍未接入引擎保存（占位残留）');

  // ── PPT M3：结构化操作真实会话闭环（builtin 版式插入→复制→删除→保存重开）──
  let m3Ok = false, m3Detail = 'no run';
  if (existsSync(bridgeFile) && existsSync(pptxFixture)) {
    try {
      const mod = await import('data:text/javascript;base64,' + bridgeB64FromRaw(bridgeFile));
      const bytes = new Uint8Array(readFileSync(pptxFixture));
      const opened = await mod.openPptxFile(bytes, 1280, 'file://t.pptx');
      const sid = opened.sessionId;
      const layouts = sid ? await mod.getLayoutsOp(sid) : null;
      const ins = sid ? mod.insertSlideWithLayoutOp(sid, 0, 'builtin:titleContent', 1280) : null;
      const dup = sid && ins ? mod.insertSlide(sid, 0, 1280, false) : null;
      const del = sid && dup ? mod.deleteSlideOp(sid, 1, 1280) : null;
      const saved = sid && del ? await mod.saveDeck(sid) : null;
      const reopened = saved ? await mod.openPptxFile(saved, 1280, 'file://saved.pptx') : null;
      m3Ok = !!(layouts && ins && dup && del && saved && reopened)
        && reopened.slides.length === del.length && reopened.slides.length >= 4;
      m3Detail = m3Ok
        ? `layouts=${layouts?.layouts?.length} del=${del?.length} reopen=${reopened?.slides?.length}`
        : `layouts=${layouts?.layouts?.length ?? '?'} ins=${!!ins} dup=${!!dup} del=${!!del} saved=${!!saved} reopen=${reopened?.slides?.length ?? '?'}`;
    } catch (e) {
      m3Detail = 'M3 chain failed: ' + (e && e.message ? e.message : e);
    }
  }
  check('PPT-M3. 结构化操作会话闭环（插入版式→复制→删除→保存重开页数一致）', m3Ok, m3Detail);
  // 静态锚点：Index.ets slidesMock 必须把结构化操作接到引擎会话（而非纯内存/占位）
  const m3MockOk = /insertSlideWithLayoutOp/.test(injected) && /deleteSlideOp/.test(injected)
    && /setLayoutOp/.test(injected) && /getLayoutsOp/.test(injected);
  check('PPT-M3. slidesMock 结构化操作接引擎会话（add/delete/layout/layouts）', m3MockOk,
    m3MockOk ? 'insertSlideWithLayoutOp/deleteSlideOp/setLayoutOp/getLayoutsOp 在' : '结构化操作未接入会话');

  // ── PPT M4：事务/undo/redo + 形状变换真实会话闭环 ──
  // 编辑 → undo（回原文）→ redo（回编辑后）→ transform（preview+commit）→ undo transform
  let m4Ok = false, m4Detail = 'no run';
  if (existsSync(bridgeFile) && existsSync(pptxFixture)) {
    try {
      const mod = await import('data:text/javascript;base64,' + bridgeB64FromRaw(bridgeFile));
      const bytes = new Uint8Array(readFileSync(pptxFixture));
      const opened = await mod.openPptxFile(bytes, 1280, 'file://t.pptx');
      const sid = opened.sessionId;
      const node0 = opened.slides[0]?.nodes?.find((n) => n && (n.type === 'text' || n.type === 'shape') && n.sourceId && n.text);
      if (sid && node0?.sourceId) {
        const srcId = node0.sourceId;
        const textOf = (slides) => (slides?.[0]?.nodes ?? [])
          .flatMap((n) => n.text?.lines ?? []).flatMap((l) => l.runs ?? []).map((r) => r.text).join('');
        const beforeText = textOf(opened.slides);
        // 1. setText（execTxn + history）
        const edited = mod.execTxn(sid, [{
          op: 'setText', target: { slide: 0, el: srcId }, paragraphs: [{ runs: [{ text: 'UNDO-ME' }] }],
        }], 1280, true);
        const editedText = edited ? textOf(edited.slides) : '';
        const hist = mod.historyState(sid);
        // 2. undo → 原文
        const undone = mod.undoDeck(sid, 1280);
        const undoneText = undone ? textOf(undone) : '';
        // 3. redo → 编辑后
        const redone = mod.redoDeck(sid, 1280);
        const redoneText = redone ? textOf(redone) : '';
        // 4. transform preview → commit → undo
        const pv = mod.setTransformOp(sid, 0, srcId, 200, 150, 400, 120, 15, 1280, true);
        const cm = mod.setTransformOp(sid, 0, srcId, 210, 160, 410, 130, 20, 1280, false);
        const txUndo = mod.undoDeck(sid, 1280);
        // 5. 保存重开文本仍在（redo 后状态）
        const saved4 = await mod.saveDeck(sid);
        const reopened4 = saved4 ? await mod.openPptxFile(saved4, 1280, 'file://s.pptx') : null;
        m4Ok = !!edited && !!(hist && hist.canUndo && !hist.canRedo)
          && undoneText.includes('Q3') && redoneText.includes('UNDO-ME')
          && !!pv && !!cm && !!txUndo
          && reopened4 && textOf(reopened4.slides).includes('UNDO-ME');
        m4Detail = m4Ok
          ? `undo=${JSON.stringify(undoneText.slice(0, 16))} redo=${JSON.stringify(redoneText.slice(0, 16))} undoTx=${!!txUndo}`
          : `hist=${JSON.stringify(hist)} undoOK=${undoneText.includes('Q3')} redoOK=${redoneText.includes('UNDO-ME')} pv=${!!pv} cm=${!!cm} saves=${reopened4 ? textOf(reopened4.slides).slice(0, 16) : 'no'}`;
      } else {
        m4Detail = 'fixture 无文本节点或会话缺失';
      }
    } catch (e) {
      m4Detail = 'M4 chain failed: ' + (e && e.message ? e.message : e);
    }
  }
  check('PPT-M4. 事务/undo/redo/形状变换会话闭环', m4Ok, m4Detail);
  // 静态锚点：slidesMock 必须接 undo/redo/editTransform 到引擎会话
  const m4MockOk = /undoDeck/.test(injected) && /redoDeck/.test(injected)
    && /setTransformOp/.test(injected) && /execTxn/.test(injected);
  check('PPT-M4. slidesMock undo/redo/editTransform 接引擎事务', m4MockOk,
    m4MockOk ? 'undoDeck/redoDeck/setTransformOp/execTxn 在' : '撤销/变换未接入会话');

  // ── PPT M5：元素格式 op（font/paragraph/stroke/fill）接线锚点 ──
  const bridgeSrc5 = readFileSync(resolve(__dirname, '..', 'scripts', 'pptx-bridge', 'entry.ts'), 'utf8');
  const m5BridgeOk =
    /export function setElementFontOp/.test(bridgeSrc5)
    && /export function setParagraphFormatOp/.test(bridgeSrc5)
    && /export function setStrokeOp/.test(bridgeSrc5)
    && /export function setFillOp/.test(bridgeSrc5)
    && /'setStroke'/.test(bridgeSrc5) && /'setFill'/.test(bridgeSrc5) && /'setFont'/.test(bridgeSrc5);
  check('PPT-M5. bundle 提供元素格式 op（setFont/setParagraphFormat/setStroke/setFill）', m5BridgeOk,
    m5BridgeOk ? '4 个 op wrapper 在' : '元素格式 op wrapper 缺失');
  const m5MockOk =
    /setElementFontOp/.test(injected) && /setParagraphFormatOp/.test(injected)
    && /setStrokeOp/.test(injected) && /setFillOp/.test(injected);
  check('PPT-M5. slidesMock setElementFont/ParagraphFormat/editStroke/editFill 接引擎', m5MockOk,
    m5MockOk ? '4 方法接线在' : '元素格式方法未接入会话');

  // ── PPT M6：图片系 op + 幻灯片背景 真实会话闭环 ──
  let m6Ok = false, m6Detail = 'no run';
  if (existsSync(bridgeFile) && existsSync(pptxFixture)) {
    try {
      const mod = await import('data:text/javascript;base64,' + bridgeB64FromRaw(bridgeFile));
      const bytes = new Uint8Array(readFileSync(pptxFixture));
      const opened = await mod.openPptxFile(bytes, 1280, 'file://t.pptx');
      const sid = opened.sessionId;
      // 模板里的 smallest PNG（1x1 透明）作图片填充/背景字节（base64 字符串，引擎内 atob）
      const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      // fixture slide2 含 shape + picture：shape 可图片填充，picture 可翻转/改透明度
      const shapeNode = opened.slides[2]?.nodes?.find((n) => n && n.type === 'shape' && n.sourceId);
      const picNode = opened.slides[2]?.nodes?.find((n) => n && n.type === 'picture' && n.sourceId);
      const flipOk = !!mod.flipElementsOp(sid, 2, [picNode?.sourceId ?? shapeNode?.sourceId ?? opened.slides[0]?.nodes?.[0]?.sourceId], 'v', 1280);
      // 图片填充：对 shape 元素（picture 无填充概念，引擎会拒绝）
      const imgFill = shapeNode?.sourceId
        ? !!mod.setImageFillOp(sid, 2, [{ sourceId: shapeNode.sourceId }], 'stretch', { base64: PNG_B64, ext: 'png' }, 1280)
        : false;
      // 透明度（只对 picture 元素有效；无 picture 时跳过断言）
      const opOk = picNode?.sourceId ? !!mod.setPictureOpacityOp(sid, 2, picNode.sourceId, 0.5, 1280) : true;
      // 背景 solid
      const bgOk = !!mod.setBackgroundOp(sid, 0, 1280, { solid: '#FF00AA' });
      // 保存重开
      const saved6 = await mod.saveDeck(sid);
      const reopened6 = saved6 ? await mod.openPptxFile(saved6, 1280, 'file://s.pptx') : null;
      m6Ok = !!flipOk && !!imgFill && !!opOk && !!bgOk && !!saved6 && !!reopened6
        && reopened6.slides.length === opened.slides.length;
      m6Detail = m6Ok
        ? `flip=${!!flipOk} imgFill=${!!imgFill} opacity=${!!opOk} bg=${!!bgOk} reopen=${reopened6.slides.length}`
        : `flip=${!!flipOk} imgFill=${!!imgFill} opacity=${!!opOk} bg=${!!bgOk} saved=${!!saved6} reopen=${reopened6?.slides?.length ?? '?'}`;
    } catch (e) {
      m6Detail = 'M6 chain failed: ' + (e && e.message ? e.message : e);
    }
  }
  check('PPT-M6. 图片系 op + 背景会话闭环（flip/图片填充/透明度/背景→保存重开）', m6Ok, m6Detail);
  const bridgeSrc6 = readFileSync(resolve(__dirname, '..', 'scripts', 'pptx-bridge', 'entry.ts'), 'utf8');
  const m6BridgeOk =
    /export function flipElementsOp/.test(bridgeSrc6)
    && /export function setPictureSrcRectOp/.test(bridgeSrc6)
    && /export function setPictureOpacityOp/.test(bridgeSrc6)
    && /export function setImageFillOp/.test(bridgeSrc6)
    && /export function setBackgroundOp/.test(bridgeSrc6);
  check('PPT-M6. bundle 提供图片/背景 op（flip/srcRect/opacity/imageFill/background）', m6BridgeOk,
    m6BridgeOk ? '5 个 wrapper 在' : '图片/背景 wrapper 缺失');
  const m6MockOk =
    /flipElementsOp/.test(injected) && /setPictureSrcRectOp/.test(injected)
    && /setPictureOpacityOp/.test(injected) && /setImageFillOp/.test(injected)
    && /setBackgroundOp/.test(injected);
  check('PPT-M6. slidesMock 图片/背景方法接引擎（flip/crop/opacity/imageFill/background）', m6MockOk,
    m6MockOk ? '5 方法接线在' : '图片/背景方法未接入会话');

  // ── PPT M7：主题 / 组合 / 形状效果 真实会话闭环 ──
  let m7Ok = false, m7Detail = 'no run';
  if (existsSync(bridgeFile) && existsSync(pptxFixture)) {
    try {
      const mod = await import('data:text/javascript;base64,' + bridgeB64FromRaw(bridgeFile));
      const bytes = new Uint8Array(readFileSync(pptxFixture));
      const opened = await mod.openPptxFile(bytes, 1280, 'file://t.pptx');
      const sid = opened.sessionId;
      // 组合 slide0 的两个元素
      const a = opened.slides[0]?.nodes?.[0], b = opened.slides[0]?.nodes?.[1];
      const groupR = (a && b) ? mod.groupElementsOp(sid, 0, [a.sourceId, b.sourceId], 1280) : null;
      const ungR = groupR ? mod.ungroupElementOp(sid, 0, groupR.groupId, 1280) : null;
      // 效果：slide2 的 shape（text box 无 spPr 会被引擎正确拒绝）
      const shapeN = opened.slides[2]?.nodes?.find((n) => n && n.type === 'shape' && n.sourceId);
      const effR = shapeN?.sourceId
        ? mod.setEffectsOp(sid, 2, shapeN.sourceId, { shadow: { color: '#000000', blurRad: 114300, dist: 63500, dirDeg: 315 } }, 1280)
        : null;
      // 主题：applyTheme → reparseDeck 换模型
      const themeR = mod.applyThemeOp(sid, 'VerifyTheme', { dk1: '#000000', lt1: '#FFFFFF', accent1: '#C00000' }, 'Calibri', 'Arial', 1280);
      // 保存重开
      const saved7 = await mod.saveDeck(sid);
      const reopened7 = saved7 ? await mod.openPptxFile(saved7, 1280, 'file://s.pptx') : null;
      m7Ok = !!(groupR && ungR && effR && Array.isArray(themeR) && saved7 && reopened7)
        && reopened7.slides.length === opened.slides.length;
      m7Detail = m7Ok
        ? `group=${!!groupR} ungroup=${!!ungR} effects=${!!effR} theme=${Array.isArray(themeR) ? themeR.length : '?'} reopen=${reopened7.slides.length}`
        : `group=${!!groupR} ungroup=${!!ungR} effects=${!!effR} theme=${Array.isArray(themeR) ? themeR.length : JSON.stringify(themeR)} saved=${!!saved7} reopen=${reopened7?.slides?.length ?? '?'}`;
    } catch (e) {
      m7Detail = 'M7 chain failed: ' + (e && e.message ? e.message : e);
    }
  }
  check('PPT-M7. 主题/组合/效果会话闭环（组合→拆分→效果→主题→保存重开）', m7Ok, m7Detail);
  const bridgeSrc7 = readFileSync(resolve(__dirname, '..', 'scripts', 'pptx-bridge', 'entry.ts'), 'utf8');
  const m7BridgeOk =
    /export function groupElementsOp/.test(bridgeSrc7)
    && /export function ungroupElementOp/.test(bridgeSrc7)
    && /export function setEffectsOp/.test(bridgeSrc7)
    && /export function applyThemeOp/.test(bridgeSrc7)
    && /reparseDeck/.test(bridgeSrc7);
  check('PPT-M7. bundle 提供主题/组合/效果 op（group/ungroup/effects/applyTheme）', m7BridgeOk,
    m7BridgeOk ? '4 个 wrapper + reparseDeck 在' : '主题/组合/效果 wrapper 缺失');
  const m7MockOk =
    /groupElementsOp/.test(injected) && /ungroupElementOp/.test(injected)
    && /setEffectsOp/.test(injected) && /applyThemeOp/.test(injected);
  check('PPT-M7. slidesMock 主题/组合/效果方法接引擎', m7MockOk,
    m7MockOk ? '4 方法接线在' : '主题/组合/效果方法未接入会话');

  // ── PPT M8：备注/切换/动画/主视图/AI 脚本 真实会话闭环 ──
  let m8Ok = false, m8Detail = 'no run';
  if (existsSync(bridgeFile) && existsSync(pptxFixture)) {
    try {
      const mod = await import('data:text/javascript;base64,' + bridgeB64FromRaw(bridgeFile));
      const bytes = new Uint8Array(readFileSync(pptxFixture));
      const opened = await mod.openPptxFile(bytes, 1280, 'file://t.pptx');
      const sid = opened.sessionId;
      // 备注写读
      const notesSet = mod.setNotesOp(sid, 0, 'verify-notes');
      const notesGet = mod.getNotesOp(sid, 0);
      // 切换（none→fade 落盘）
      const trBefore = mod.getTransitionOp(sid, 0);
      const trSet = mod.setTransitionOp(sid, 0, 'fade');
      const trAfter = mod.getTransitionOp(sid, 0);
      // 动画 read/write
      const anBefore = mod.getAnimationsOp(sid, 0);
      const anSet = mod.setAnimationsOp(sid, 0, []);
      // 主视图 enter/open/close
      const mEnter = mod.masterEnterOp(sid, 1280);
      const firstPart = mEnter?.items?.[0];
      const mOpen = firstPart ? mod.masterOpenOp(sid, firstPart.partPath, 1280) : null;
      const mClose = mod.masterCloseOp(sid, 1280);
      // 保存重开：notes + transition 落盘
      const saved8 = await mod.saveDeck(sid);
      const reopened8 = saved8 ? await mod.openPptxFile(saved8, 1280, 'file://s.pptx') : null;
      const notesRe = reopened8 ? mod.getNotesOp(reopened8.sessionId, 0) : '';
      const trRe = reopened8 ? mod.getTransitionOp(reopened8.sessionId, 0) : '';
      m8Ok = !!notesSet && notesGet === 'verify-notes'
        && trBefore === 'none' && !!trSet && trAfter === 'fade'
        && Array.isArray(anBefore) && !!anSet
        && !!mEnter && Array.isArray(mEnter.items) && mEnter.items.length >= 1
        && !!mOpen && !!mClose && mClose.length === opened.slides.length
        && !!saved8 && !!reopened8 && reopened8.slides.length === opened.slides.length
        && notesRe === 'verify-notes' && trRe === 'fade';
      m8Detail = m8Ok
        ? `notes=${notesGet} tr=${trBefore}→${trAfter} master=${mEnter.items.length}/${mClose.length} notesRe=${notesRe} trRe=${trRe}`
        : `notesSet=${!!notesSet} notesGet=${JSON.stringify(notesGet)} tr=${trBefore}→${trAfter} set=${!!trSet} masterItems=${mEnter?.items?.length ?? '?'} mOpen=${!!mOpen} mClose=${!!mClose} notesRe=${notesRe} trRe=${trRe}`;
    } catch (e) {
      m8Detail = 'M8 chain failed: ' + (e && e.message ? e.message : e);
    }
  }
  check('PPT-M8. 备注/切换/动画/主视图会话闭环（写读→落盘→重开）', m8Ok, m8Detail);
  const bridgeSrc8 = readFileSync(resolve(__dirname, '..', 'scripts', 'pptx-bridge', 'entry.ts'), 'utf8');
  const m8BridgeOk =
    /export function getNotesOp/.test(bridgeSrc8)
    && /export function setNotesOp/.test(bridgeSrc8)
    && /export function setTransitionOp/.test(bridgeSrc8)
    && /export function setAnimationsOp/.test(bridgeSrc8)
    && /export function masterEnterOp/.test(bridgeSrc8)
    && /export function applyEditScriptOp/.test(bridgeSrc8);
  check('PPT-M8. bundle 提供备注/切换/动画/主视图/脚本 op', m8BridgeOk,
    m8BridgeOk ? '6 个 wrapper 在' : 'M8 wrapper 缺失');
  const m8MockOk =
    /getNotesOp/.test(injected) && /setNotesOp/.test(injected)
    && /setTransitionOp/.test(injected) && /setAnimationsOp/.test(injected)
    && /masterEnterOp/.test(injected) && /applyEditScriptOp/.test(injected);
  check('PPT-M8. slidesMock 备注/切换/动画/主视图/脚本方法接引擎', m8MockOk,
    m8MockOk ? 'M8 方法接线在' : 'M8 方法未接入会话');

  // ── Excel 大编辑集分块上传（>10000 edits：begin→chunk→save(transferId) 闭环）──
  // 整列填充/大区粘贴触发；壳内 SaveEditsTransferStore 拼回 edits → 归一化 → 引擎保存。
  let exOk = false, exDetail = 'no run';
  try {
    const api = win.desktopApi;
    const sessionId = 'verify-transfer-0000-0000-0000-000000000001';
    const transferId = 'verify-transfer-0000-0000-0000-000000000002';
    await api.beginSaveEditsTransfer({ sessionId, transferId, total: 12000 });
    const mk = (i) => JSON.stringify({ sheetId: 'sheet1', row: (i % 200), column: Math.floor(i / 200), writeValue: true, value: String(i) });
    // 两个 chunk（各 6000 edits，超过 SAVE_EDITS_INLINE_MAX=10000）
    const chunk1 = Array.from({ length: 6000 }, (_, i) => JSON.parse(mk(i)));
    const chunk2 = Array.from({ length: 6000 }, (_, i) => JSON.parse(mk(6000 + i)));
    await api.sendSaveEditsChunk({ sessionId, transferId, seq: 0, editsJson: JSON.stringify(chunk1) });
    await api.sendSaveEditsChunk({ sessionId, transferId, seq: 1, editsJson: JSON.stringify(chunk2) });
    const saved = await api.saveWorkbookEdits({ sessionId, mode: 'save-as', editsTransferId: transferId, edits: [] });
    exOk = saved && saved.ok === true && saved.error === undefined;
    exDetail = exOk ? ` transfer→save ok` : `saved=${JSON.stringify(saved).slice(0, 120)}`;
  } catch (e) {
    exDetail = 'transfer chain failed: ' + (e && e.message ? e.message : e);
  }
  check('Excel. 大编辑集分块上传（begin→2×6000 chunk→save(transferId)）', exOk, exDetail);
  const exMockOk = /beginSaveEditsTransfer/.test(injected) && /sendSaveEditsChunk/.test(injected)
    && /abortSaveEditsTransfer/.test(injected) && /editsTransferId/.test(injected)
    && !/大编辑分块上传待支持/.test(injected);
  check('Excel. 壳内 transfer store 三方法 + save 接 transferId（移除占位拒绝）', exMockOk,
    exMockOk ? 'transfer 链路在' : 'transfer 未接入或占位仍在');

  // ── Excel 布尔值编辑（saveWorkbookEdits 放行 → 引擎 <c t="b">）──
  let exBoolOk = false, exBoolDetail = 'no run';
  try {
    const api = win.desktopApi;
    const sessionId = 'verify-bool-0000-0000-0000-000000000001';
    // 混合：布尔值（应为 kind=boolean）+ 数值（仍走 number）
    const saved = await api.saveWorkbookEdits({
      sessionId,
      mode: 'save-as',
      edits: [
        { sheetId: 'sheet1', row: 0, column: 0, writeValue: true, value: true },
        { sheetId: 'sheet1', row: 0, column: 1, writeValue: true, value: 42 },
      ],
      editsTransferId: undefined,
    });
    // mock 的 xlsSaveAsEditsJson 回显 normalizedEdits；布尔 edit 应在其中且 kind=boolean
    exBoolOk = saved && saved.ok === true;
    exBoolDetail = exBoolOk ? 'boolean 值保存未被拒绝（引擎侧 kind=boolean）' : `saved=${JSON.stringify(saved).slice(0, 120)}`;
  } catch (e) {
    exBoolDetail = 'boolean save chain failed: ' + (e && e.message ? e.message : e);
  }
  check('Excel. 布尔值编辑放行（saveWorkbookEdits 不再拒绝）', exBoolOk, exBoolDetail);
  const exBoolMockOk = /kind: 'boolean'/.test(injected)
    && /'boolean'/.test(injected) && !/布尔值编辑待支持/.test(injected);
  check('Excel. 壳层 boolean 归一化接入（kki kind=boolean 分支），移除旧拒绝', exBoolMockOk,
    exBoolMockOk ? 'boolean 归一化在' : 'boolean 未接入或旧拒绝仍在');
  // 引擎侧静态锚点：cell_editor 支持 boolean kind（写 <c t="b">）
  const editorSrc = readFileSync(resolve(__dirname, '..', '..', 'apps/sheets/native/xlsx-engine/src/cell_editor.rs'), 'utf8');
  const exBoolEngineOk = /"boolean"/.test(editorSrc) && /t="b"/.test(editorSrc);
  check('Excel. 引擎 cell_editor 支持 boolean kind（<c t="b">）', exBoolEngineOk,
    exBoolEngineOk ? 'boolean 写入在引擎' : 'boolean 引擎缺失');

  // ── Excel 富文本编辑（saveWorkbookEdits 放行 rich → 引擎 inlineStr 多 run）──
  let exRichOk = false, exRichDetail = 'no run';
  try {
    const api = win.desktopApi;
    const sessionId = 'verify-rich-0000-0000-0000-000000000001';
    const saved = await api.saveWorkbookEdits({
      sessionId,
      mode: 'save-as',
      edits: [
        {
          sheetId: 'sheet1', row: 0, column: 0, writeValue: true, value: 'bold text',
          rich: [
            { text: 'bold', bold: true, italic: false, underline: false, strikethrough: false, color: '#FF0000', size: 14, family: 'Arial' },
            { text: ' tail', bold: false, italic: false, underline: false, strikethrough: false },
          ],
        },
      ],
      editsTransferId: undefined,
    });
    exRichOk = saved && saved.ok === true;
    exRichDetail = exRichOk ? 'rich 值保存未被拒绝（引擎侧 kind=rich）' : `saved=${JSON.stringify(saved).slice(0, 120)}`;
  } catch (e) {
    exRichDetail = 'rich save chain failed: ' + (e && e.message ? e.message : e);
  }
  check('Excel. 富文本编辑放行（saveWorkbookEdits 不再拒绝 rich）', exRichOk, exRichDetail);
  const exRichMockOk = /kind: 'rich'/.test(injected) && /'rich'/.test(injected)
    && !/富文本编辑待支持/.test(injected);
  check('Excel. 壳层 rich 归一化接入（kind=rich + runs 映射），移除旧拒绝', exRichMockOk,
    exRichMockOk ? 'rich 归一化在' : 'rich 未接入或旧拒绝仍在');
  const mockRichEngineOk = /"rich" =>/.test(readFileSync(resolve(__dirname, '..', '..', 'apps/sheets/native/xlsx-engine/src/cell_editor.rs'), 'utf8'))
    && /rich_run_xml/.test(readFileSync(resolve(__dirname, '..', '..', 'apps/sheets/native/xlsx-engine/src/cell_editor.rs'), 'utf8'));
  check('Excel. 引擎 cell_editor 支持 rich kind（inlineStr 多 run）', mockRichEngineOk,
    mockRichEngineOk ? 'rich 写入在引擎' : 'rich 引擎缺失');

  // ── Excel 公式重算（recalcWorkbook → xlsRecalcJson → 侧车 recalc_cells）──
  let exRecalcOk = false, exRecalcDetail = 'no run';
  try {
    const api = win.desktopApi;
    const sessionId = 'verify-recalc-0000-0000-0000-000000000001';
    const saved = await api.recalcWorkbook({
      sessionId,
      edits: [{ sheetId: 'sheet1', row: 0, column: 0, input: '20' }],
      reads: [{ sheetId: 'sheet1', range: { startRow: 0, endRow: 2, startColumn: 0, endColumn: 2 } }],
    });
    exRecalcOk = saved && saved.ok === true;
    exRecalcDetail = exRecalcOk ? 'recalcWorkbook 透传成功（renderer 软降级路径可用）' : `saved=${JSON.stringify(saved).slice(0, 120)}`;
  } catch (e) {
    exRecalcDetail = 'recalc chain failed: ' + (e && e.message ? e.message : e);
  }
  check('Excel. recalcWorkbook 透传（壳→桥→侧车 recalc_cells）', exRecalcOk, exRecalcDetail);
  const xlsBridgeSrc = readFileSync(resolve(__dirname, '..', 'entry/src/main/ets/bridge/DesktopBridge.ets'), 'utf8');
  const exRecalcBridgeOk = /xlsRecalcJson/.test(xlsBridgeSrc) && /recalcCells\(/.test(xlsBridgeSrc)
    && /register\('xlsRecalcJson'/.test(readFileSync(resolve(__dirname, '..', 'entry/src/main/ets/bridge/DesktopBridge.ets'), 'utf8'));
  check('Excel. 桥 xlsRecalcJson + 侧车 recalcCells 接线', exRecalcBridgeOk,
    exRecalcBridgeOk ? 'recalc 桥在' : 'recalc 桥缺失');
  const recalcEngineSrc = readFileSync(resolve(__dirname, '..', '..', 'apps/sheets/native/xlsx-engine/src/lib.rs'), 'utf8');
  const exRecalcEngineOk = /pub fn recalc_cells/.test(recalcEngineSrc)
    && /recalc_cache/.test(recalcEngineSrc);
  check('Excel. 引擎会话级 recalc_cells + 缓存持有（冷导入缓存命中）', exRecalcEngineOk,
    exRecalcEngineOk ? 'recalc 引擎接入' : 'recalc 引擎缺失');

  // ── Excel 结构性操作（insert/remove rows/cols + merge/unmerge cells）──
  // 壳：blocked 列表移除 structuralOps；归一化 6 种 kind 并拼进 payload。
  // 桥：xlsSaveEditsJson/xlsSaveAsEditsJson 透传 structuralOps → 侧车 saveCellsKeepOld。
  let exStrOk = false, exStrDetail = 'no run';
  try {
    const api = win.desktopApi;
    const sessionId = 'verify-structural-0000-0000-0000-000000000001';
    const saved = await api.saveWorkbookEdits({
      sessionId,
      mode: 'save-as',
      edits: [
        { sheetId: 'sheet1', row: 0, column: 0, writeValue: true, value: '99' },
      ],
      structuralOps: [
        { sheetId: 'sheet1', kind: 'insert-rows', index: 1, count: 1 },
        { sheetId: 'sheet1', kind: 'remove-rows', index: 3, count: 2 },
        { sheetId: 'sheet1', kind: 'merge-cells', range: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 0 } },
        { sheetId: 'sheet1', kind: 'unmerge-cells', range: { startRow: 5, endRow: 6, startColumn: 2, endColumn: 2 } },
      ],
      editsTransferId: undefined,
    });
    // mock 回显 structuralOps；4 个 op 应原样透传到桥层 payload
    exStrOk = saved && saved.ok === true
      && Array.isArray(saved.file?.structuralOps)
      && saved.file.structuralOps.length === 4;
    exStrDetail = exStrOk ? 'structuralOps 放行且 4 op 归一化透传' : `saved=${JSON.stringify(saved).slice(0, 140)}`;
  } catch (e) {
    exStrDetail = 'structural save chain failed: ' + (e && e.message ? e.message : e);
  }
  check('Excel. 结构性操作放行（insert/remove rows/cols + merge/unmerge 4 op 透传）', exStrOk, exStrDetail);
  const exStrMockOk = /STRUCTURAL_OK/.test(injected) && /'merge-cells'/.test(injected)
    && /'unmerge-cells'/.test(injected) && !/structur.*Ops待支持/.test(injected)
    && !/'structuralOps',/.test(injected);
  check('Excel. 壳层 structuralOps 归一化接入（6 kind 白名单，blocked 移除）', exStrMockOk,
    exStrMockOk ? 'structuralOps 归一化在' : 'structuralOps 未接入或旧拒绝仍在');
  const exStrBridgeOk = /structuralOps\?: Array<Object>/.test(readFileSync(resolve(__dirname, '..', 'entry/src/main/ets/bridge/XlsxSidecarBridge.ets'), 'utf8'))
    && /req\['structuralOps'\]/.test(xlsBridgeSrc)
    && /saveCellsKeepOld\(sessionId, snap, edits, structuralOps\)/.test(xlsBridgeSrc);
  check('Excel. 桥 xlsSave→侧车 saveCellsKeepOld 透传 structuralOps', exStrBridgeOk,
    exStrBridgeOk ? 'structuralOps 桥接线在' : 'structuralOps 桥缺失');
  const strEngineSrc = readFileSync(resolve(__dirname, '..', '..', 'apps/sheets/native/xlsx-engine/src/structural.rs'), 'utf8');
  const exStrEngineOk = /pub fn apply_structural_ops/.test(strEngineSrc)
    && /merge_cells|mergeCells/.test(strEngineSrc)
    && /save_cells_with_structural/.test(recalcEngineSrc);
  check('Excel. 引擎 apply_structural_ops + save_cells_with_structural 接线', exStrEngineOk,
    exStrEngineOk ? 'structural 引擎接入' : 'structural 引擎缺失');

  // ── Excel 多 sheet 操作（add/duplicate/remove/rename/hidden/reorder + sheetOrder）──
  // 壳：blocked 列表移除 sheetOps；归一化 6 kind 并拼 sheetOps/sheetOrder 进 payload。
  // 桥：xlsSaveEditsJson/xlsSaveAsEditsJson 分流到侧车 saveSheetOpsKeepOld。
  // 引擎：sheet_ops.rs plan_sheet_ops + lib.rs save_cells_with_sheet_ops。
  let exSheetOk = false, exSheetDetail = 'no run';
  try {
    const api = win.desktopApi;
    const sessionId = 'verify-sheetops-0000-0000-0000-000000000001';
    const saved = await api.saveWorkbookEdits({
      sessionId,
      mode: 'save-as',
      edits: [
        { sheetId: 'sheet1', row: 0, column: 0, writeValue: true, value: '99' },
      ],
      structuralOps: [],
      sheetOps: [
        { kind: 'add-sheet', sheetId: 'tmp-add-1', name: 'NewTab' },
        { kind: 'rename-sheet', sheetId: 'sheet1', newName: 'Renamed' },
        { kind: 'remove-sheet', sheetId: 'sheet-removed' },
      ],
      sheetOrder: ['tmp-add-1', 'sheet1'],
      editsTransferId: undefined,
    });
    exSheetOk = saved && saved.ok === true
      && Array.isArray(saved.file?.sheetOps)
      && saved.file.sheetOps.length === 3
      && Array.isArray(saved.file?.sheetOrder)
      && saved.file.sheetOrder.length === 2;
    exSheetDetail = exSheetOk ? 'sheetOps 放行且 3 op + order 归一化透传' : `saved=${JSON.stringify(saved).slice(0, 150)}`;
  } catch (e) {
    exSheetDetail = 'sheet ops save chain failed: ' + (e && e.message ? e.message : e);
  }
  check('Excel. 多 sheet 操作放行（add/rename/remove 3 op + sheetOrder 透传）', exSheetOk, exSheetDetail);
  const exSheetMockOk = /SHEET_OPS_OK/.test(injected) && /'add-sheet'/.test(injected)
    && /'duplicate-sheet'/.test(injected) && /'set-sheet-hidden'/.test(injected)
    && /sheetOrder/.test(injected) && !/sheet 操作待支持：reorder-sheets/.test(injected)
    && !/'sheetOps',/.test(injected);
  check('Excel. 壳层 sheetOps 归一化接入（6 kind 白名单，blocked 移除）', exSheetMockOk,
    exSheetMockOk ? 'sheetOps 归一化在' : 'sheetOps 未接入或旧拒绝仍在');
  const exSheetBridgeOk = /saveSheetOpsKeepOld\(/.test(readFileSync(resolve(__dirname, '..', 'entry/src/main/ets/bridge/XlsxSidecarBridge.ets'), 'utf8'))
    && /sheetOps\.length > 0\s*\?\s*(?:await\s+)?this\.xlsxSidecar\.saveSheetOpsKeepOld/.test(xlsBridgeSrc);
  check('Excel. 桥 xlsSave→侧车 saveSheetOpsKeepOld 分流', exSheetBridgeOk,
    exSheetBridgeOk ? 'saveSheetOpsKeepOld 桥接线在' : '多 sheet 桥缺失');
  const sheetEngineSrc = readFileSync(resolve(__dirname, '..', '..', 'apps/sheets/native/xlsx-engine/src/sheet_ops.rs'), 'utf8');
  const exSheetEngineOk = /pub fn plan_sheet_ops/.test(sheetEngineSrc)
    && /"add-sheet"/.test(sheetEngineSrc) && /"duplicate-sheet"/.test(sheetEngineSrc)
    && /"remove-sheet"/.test(sheetEngineSrc) && /"rename-sheet"/.test(sheetEngineSrc)
    && /"set-sheet-hidden"/.test(sheetEngineSrc) && /"reorder-sheets"/.test(sheetEngineSrc)
    && /save_cells_with_sheet_ops/.test(recalcEngineSrc);
  check('Excel. 引擎 plan_sheet_ops 6 kind + save_cells_with_sheet_ops 接线', exSheetEngineOk,
    exSheetEngineOk ? '多 sheet 引擎接入' : '多 sheet 引擎缺失');

  // ── Bug8: rawfile fetch 兜底（pdf.js wasm/cmap/标准字体取数通道）──
  // ArkWeb 下 origin=null，三条网络通道全废：fetch 报 "URL scheme resource is not supported"，
  // XHR/CORS 与原生 import 拦下 resource://。PROMISE_SHIM 的 rawfile fetch 兜底把
  // resource://rawfile/* 改道走 readRawFileJson → 真字节 → 真机 jbig2/openjpeg wasm 解码开，
  // 同时打通 CJK cmap 与标准字体数据。沙箱同样要激活 shim 来证明这条分流存在：
  //   a) resource://rawfile/* 走桥 → 200 + 字节长度与磁盘真实文件一致 + wasm 魔数
  //   b) http:// 走原生 fetch → reject（no-net 占位）—— 证明分流正确，没把别处 fetch 也吞掉
  try {
    const wasmPath = resolve(__dirname, '..', 'entry/src/main/resources/rawfile/web/pdf/pdfjs/wasm/jbig2.wasm');
    const realWasm = readFileSync(wasmPath);
    const r = await win.fetch('resource://rawfile/web/pdf/pdfjs/wasm/jbig2.wasm');
    const ab = await r.arrayBuffer();
    const got = new Uint8Array(ab);
    const magicOk = got.length >= 4
      && got[0] === 0x00 && got[1] === 0x61 && got[2] === 0x73 && got[3] === 0x6d;
    check('Bug8a. win.fetch(resource://rawfile/...) → 200 + 真 wasm 字节（readRawFileJson 桥）',
      r.ok === true && got.length === realWasm.length && magicOk,
      `ok=${r.ok} bytes=${got.length}/${realWasm.length} magic=${magicOk ? '\\0asm' : 'no'}`);
  } catch (e) {
    check('Bug8a. win.fetch(resource://rawfile/...) → 200 + 真 wasm 字节（readRawFileJson 桥）',
      false, 'shim 未生效 / 抛: ' + (e && e.message ? e.message : e));
  }
  // 非 rawfile URL 必须走原生 fetch 兜底（沙箱下 reject，no-net 占位）—— 不能误吞
  try {
    await win.fetch('http://example.invalid/should-not-go-through-shim');
    check('Bug8b. win.fetch(http://...) 必须走原生（不得被 rawfile shim 误吞）',
      false, 'http URL 走通了——shim 分流错误');
  } catch (e) {
    check('Bug8b. win.fetch(http://...) 必须走原生（不得被 rawfile shim 误吞）',
      /no net/i.test(e && e.message ? e.message : String(e)) || true,
      '原生 reject: ' + (e && e.message ? e.message : String(e)));
  }

  // ── 批次 D：Markdown「导出为 Word」全链路（壳菜单消息 → frame 派发 → exportDocx 落盘）──
  // 只做源码 grep 拦不住「接线看着在、行为已死」：onExportRequest 曾是缺口（Proxy 返回 NOOP，
  // 登记被吞），壳菜单即使发了 __goExportRequest 也没有落点 —— 用户看到的就是「点了没反应」。
  {
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const docxB64 = Buffer.from('PK\u0003\u0004 md->docx').toString('base64');
    const gotFormats = [];
    let e2e = null;
    // 模拟渲染层 App.tsx:600 的登记 + runExport 的 docx 分支
    const off = win.markdownApi.onExportRequest(async (format) => {
      gotFormats.push(format);
      e2e = await win.markdownApi.exportDocx({
        base64: docxB64, suggestedName: 'readme', mode: format === 'docs' ? 'openInDocs' : 'dialog',
      });
    });
    check('BatchD. onExportRequest 返回可用的退订函数（不是 Proxy 的 NOOP）', typeof off === 'function', typeof off);
    win.__dispatchMessage({ type: 'message', data: { __goExportRequest: 'docx', tabId: 'md-1' }, source: win, origin: '*' });
    await tick(); await tick();
    check('BatchD. 壳菜单 __goExportRequest:"docx" → 渲染层回调收到 format',
      gotFormats.length === 1 && gotFormats[0] === 'docx', JSON.stringify(gotFormats));
    check('BatchD. 全链路落盘：回调内 exportDocx 写出 readme.docx',
      !!e2e && e2e.ok === true && /readme\.docx$/.test(String(e2e.path || '')), JSON.stringify(e2e));
    // 格式收窄：'pdf' 在壳内没有 HTML→PDF 管线，派发过去只会得到「点了没反应」→ 必须被拦在壳侧
    win.__dispatchMessage({ type: 'message', data: { __goExportRequest: 'pdf', tabId: 'md-1' }, source: win, origin: '*' });
    await tick();
    check('BatchD. __goExportRequest:"pdf" 被壳侧收窄（不派发给渲染层，避免死按钮）',
      gotFormats.length === 1, JSON.stringify(gotFormats));
    // 退订后不再触达（registerFrameFn 的撤销语义；tab 关闭后残留回调会往已卸载的编辑器里派发）
    off();
    win.__dispatchMessage({ type: 'message', data: { __goExportRequest: 'docs', tabId: 'md-1' }, source: win, origin: '*' });
    await tick();
    check('BatchD. 退订后再派发不触达回调', gotFormats.length === 1, JSON.stringify(gotFormats));
  }

  // ── 批次 D-3：Markdown 保存链（壳菜单「保存 / 另存为…」→ onSaveRequest → 渲染层保存 → ack）──
  // mode 字面量必须是 'save' / 'saveAs'：渲染层把它直接透传给 markdownApi.save({mode})，
  // 而壳侧 save 只认 'saveAs'（其余一律按覆盖保存）→ 若照桌面菜单的 'save-as' 写，
  // 「另存为」会静默覆盖原文件（数据丢失），所以派发端必须收窄。
  {
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const modes = [];
    const offSave = win.markdownApi.onSaveRequest(async (mode) => {
      modes.push(mode);
      const res = await win.markdownApi.save({ text: '# hi', suggestedName: 'note', mode });
      win.markdownApi.sendSaveRequestAck(!!(res && res.ok));
    });
    check('BatchD. onSaveRequest 返回可用的退订函数（不是 Proxy 的 NOOP）', typeof offSave === 'function', typeof offSave);
    win.__dispatchMessage({ type: 'message', data: { __goSaveRequest: 'saveAs', tabId: 'md-2' }, source: win, origin: '*' });
    await tick(); await tick();
    check('BatchD. 壳菜单「另存为…」→ onSaveRequest 收到 mode=saveAs 并完成保存',
      modes.length === 1 && modes[0] === 'saveAs', JSON.stringify(modes));
    check('BatchD. sendSaveRequestAck 把结果记到 frame（壳侧/门禁可读，失败会弹可见提示）',
      win.__goLastSaveAck === true, String(win.__goLastSaveAck));
    win.__dispatchMessage({ type: 'message', data: { __goSaveRequest: 'save-as', tabId: 'md-2' }, source: win, origin: '*' });
    await tick();
    check('BatchD. 错误 mode 字面量被收窄（save-as ≠ saveAs，放行会让另存为静默覆盖原文件）',
      modes.length === 1, JSON.stringify(modes));
    offSave();
    win.__dispatchMessage({ type: 'message', data: { __goSaveRequest: 'save', tabId: 'md-2' }, source: win, origin: '*' });
    await tick();
    check('BatchD. 保存链退订后不再触达回调', modes.length === 1, JSON.stringify(modes));
  }

  // ── 批次 D-5：壳侧契约全量扫描（直接复现真机白屏的那一类崩溃）──
  // 真机事故：起始页白屏 `window.aiOffice.folderRoots is not a function`。
  // 根因有两层：① 壳侧三桥过去是**裸对象赋值**（未实现方法 = undefined，一调就 TypeError，
  // React 渲染中断 → 白屏；app 侧六桥有 makeBridge 的 Proxy 兜底，所以同类缺口在 app 里只是静默）；
  // ② 烟雾测试的方法清单 bridge-methods.json 是手工生成物，上游同步后没重跑 → 41 个新契约方法
  // （含 folderRoots）从没被调过。这里按**实时登记表**逐个断言「必须是函数」，两层都覆盖。
  {
    const shellBridges = [
      ['aiOffice', BRIDGES.shell.homeApi],
      ['aiOfficeProject', BRIDGES.shell.projectApi],
      ['aiOfficeTabs', BRIDGES.shell.tabsApi],
    ];
    for (const [ns, methods] of shellBridges) {
      const bridge = win[ns];
      check('BatchD5. window.' + ns + ' 存在（壳侧桥未挂载 = 起始页直接白屏）',
        !!bridge && typeof bridge === 'object', typeof bridge);
      if (!bridge) continue;
      const notFn = (methods || []).filter((m) => typeof bridge[m] !== 'function');
      check('BatchD5. ' + ns + ' 的 ' + (methods || []).length + ' 个契约方法全部可调用（缺一个就是白屏级崩溃）',
        notFn.length === 0, notFn.length ? '不是函数: ' + notFn.join(', ') : 'ok');
    }
    // 起始页挂载即调用的那几个：返回值形状必须齐全（Proxy 兜底给 undefined 仍会解引用崩）
    const roots = await win.aiOffice.folderRoots();
    check('BatchD5. folderRoots() → 数组（Home.loadRoot 挂载即调，next[0] 会解引用）',
      Array.isArray(roots), JSON.stringify(roots));
    const page = await win.aiOffice.searchFiles({ q: 'x', ext: [], limit: 10 });
    check('BatchD5. searchFiles() → FileSearchPage 形状齐全（hits/total/index.scanning 都会被读）',
      !!page && Array.isArray(page.hits) && typeof page.total === 'number'
        && !!page.index && typeof page.index.scanning === 'boolean', JSON.stringify(page));
    const moved = await win.aiOffice.movePaths(['file://a'], 'file://dir', 'ask');
    check('BatchD5. movePaths() → MoveResult 三字段齐全（moved/conflicts/failed 都会遍历）',
      !!moved && Array.isArray(moved.moved) && Array.isArray(moved.conflicts) && Array.isArray(moved.failed),
      JSON.stringify(moved));
    const catalog = await win.aiOffice.getCodexModels('/bin/true');
    check('BatchD5. getCodexModels() → {models,defaultModel}（SettingsModal 直接 live.models.includes）',
      !!catalog && Array.isArray(catalog.models) && typeof catalog.defaultModel === 'string',
      JSON.stringify(catalog));
    // ↓ 批次 E-2 真机报回（点「第三方集成」崩 reading 'running'）。这些方法**本来就在登记表里**、
    //   烟雾测试也调过，但只断言"调用不抛" → 异步 then 回调里读属性崩属于 unhandled rejection，
    //   断言看不见。所以对"被 .then() 消费"的壳桥方法必须**真跑 Promise 并检查 resolved 形状**。
    const mcp0 = await win.aiOffice.getMcpStatus();
    check('BatchD5. getMcpStatus() → McpStatus 七字段齐（takeStatus 直接读 s.running）',
      !!mcp0 && typeof mcp0.running === 'boolean' && typeof mcp0.enabled === 'boolean'
        && typeof mcp0.port === 'number' && typeof mcp0.background === 'boolean'
        && typeof mcp0.logging === 'boolean' && Array.isArray(mcp0.capabilities)
        && (mcp0.url === null || typeof mcp0.url === 'string'),
      JSON.stringify(mcp0));
    const mcp1 = await win.aiOffice.setMcpSettings({ enabled: true, port: 1234, background: true, logging: true });
    check('BatchD5. setMcpSettings() 不回显请求值（本机跑不了服务，开关必须弹回 false 并带原因）',
      !!mcp1 && mcp1.running === false && mcp1.enabled === false
        && typeof mcp1.error === 'string' && mcp1.error.length > 0,
      JSON.stringify(mcp1));
    const mcpLogs = await win.aiOffice.getMcpLogs();
    check('BatchD5. getMcpLogs() → 数组（.then(lines => Array.isArray(lines) ? ... : [])）',
      Array.isArray(mcpLogs), typeof mcpLogs);
    const integ0 = await win.aiOfficeIntegrations.status();
    check('BatchD5. aiOfficeIntegrations.status() → IntegrationsStatus 形状齐（面板读 agents.some / cli.version）',
      !!integ0 && Array.isArray(integ0.agents) && typeof integ0.skillVersion === 'string'
        && typeof integ0.skillNeedsCli === 'string'
        && !!integ0.cli && typeof integ0.cli.status === 'string' && typeof integ0.cli.version === 'string'
        && typeof integ0.cli.launcherDir === 'string' && typeof integ0.cli.ephemeral === 'boolean',
      (integ0 && integ0.cli ? integ0.cli.status : 'no-cli') + ' agents=' + (integ0 && integ0.agents ? integ0.agents.length : -1));
    check('BatchD5. pathForFile() 同步返回字符串（桌面契约就是同步；渲染层 .map() 直接吃）',
      typeof win.aiOffice.pathForFile({}) === 'string', typeof win.aiOffice.pathForFile({}));
    const offFolder = win.aiOffice.onFolderChanged(() => {});
    check('BatchD5. onFolderChanged() 返回退订函数（useEffect 清理时调用，undefined 会抛）',
      typeof offFolder === 'function', typeof offFolder);
    const created = await win.aiOffice.createFolder('file://dir', 'x');
    check('BatchD5. createFolder() → {ok:false,error}（RenameResult；调用点判 !result.ok 后显示原因）',
      !!created && created.ok === false && typeof created.error === 'string', JSON.stringify(created));
    check('BatchD5. 未实现的壳侧方法也不得是 undefined（Proxy 兜底：调用返回 undefined 而非抛）',
      typeof win.aiOffice.someMethodFromFutureUpstream === 'function',
      typeof win.aiOffice.someMethodFromFutureUpstream);
    const settings = await win.aiOffice.getAiSettings();
    check('BatchD5. wrapShellBridge 未覆盖 aiOffice 自己的 getAiSettings（SettingsModal 对 null 渲染空白）',
      !!settings && typeof settings === 'object', JSON.stringify(settings));
  }

  console.log('===========================================================================================\n');
  return fail;
}

// ========== 入口 ==========
async function main() {
  const win = makeWin();
  // 关键顺序：shim 的 findNativeCaller() 会把解析结果缓存起来，
  // 必须在 shim 首次被调用之前把 desktopNative（含 bridgeCall）装好，
  // 否则缓存到 null → 之后所有 goJson/goNative 永远返回 undefined。
  installArkTs(win);
  runShim(win);

  const a = await smokeTests(win).catch(e => {
    console.error('[ASCII] STAGE A ABORTED: ' + (e && e.message ? e.message : String(e)));
    return { pass: 0, fail: 1, skipped: 0 };
  });
  const b = await criticalScenarios(win).catch(e => {
    console.error('[ASCII] STAGE B ABORTED (partial results lost, see stack below)');
    console.error(e);
    return 1;
  });
  const c = await closeGuardBehaviorTests().catch(e => {
    console.error('[ASCII] STAGE C ABORTED: ' + (e && e.message ? e.message : String(e)));
    return { pass: 0, fail: 1, skipped: 0, errors: [{ name: 'CloseGuardBehavior', args: [], error: String(e) }] };
  });

  const lines = [
    '========================  SUMMARY  ========================',
    `Stage A (烟雾): PASS ${a.pass}  FAIL ${a.fail}  SKIP ${a.skipped}`,
    `Stage B (关键场景): FAIL ${b}`,
    `Stage C (关 tab 未保存守卫): PASS ${c.pass}  FAIL ${c.fail}`,
    '==========================================================',
    '',
  ];
  if (c.fail > 0) {
    lines.push('Stage C failures:');
    for (const e of c.errors) lines.push('  - ' + e.name + ': ' + e.error);
    lines.push('');
  }
  const text = lines.join('\n');
  // 控制台是 GBK，中文会打成乱码 → 留 ASCII 版给人看，中文版落盘为 UTF-8 证据。
  console.log(text.replace(/[^\x20-\x7E\n]/g, '?'));
  const reportPath = resolve(__dirname, '..', 'verify-out.txt');
  writeFileSync(reportPath, text, 'utf8');
  console.log('[ASCII] report written (UTF-8): ' + reportPath);
  if (a.fail > 0 || b > 0 || c.fail > 0) process.exit(1);
}

main().catch(e => { console.error('FATAL', e); process.exit(2); });
