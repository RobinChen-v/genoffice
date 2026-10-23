import { webview } from '@kit.ArkWeb';
import { common, abilityAccessCtrl, Permissions } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { DesktopBridge, ProjectApi } from '../bridge/DesktopBridge';
import { IncomingOpen } from '../common/IncomingOpen';

// 走自建响应的模块类资源（默认 rawfile 通道对 module/crossorigin 请求
// 缺 CORS 头与 JS MIME，动态 import()/@font-face 全部 "Failed to fetch"）
const RAWFILE_MODULE_RE: RegExp = /\.(js|mjs|wasm|json|css|woff2?|ttf|otf)$/i;

// **文本类**资源白名单：只有这些扩展名按 UTF-8 投递，其余（图片/字体/wasm/cmap/未知扩展名）
// 一律投原始字节 —— 响应体一旦被按文本解码，字节就被替换成 U+FFFD（不可逆损坏）。
// 反例（真机复测 D-6）：这里曾是「二进制白名单」/\.(wasm|ttf|otf|woff2?)$/，于是
// sheets 的 send-enter-off.png（AI 面板右下角图标，全 JS 里唯一的文件型图标，其余 93 个
// 图标都是 data: 内联）被判成文本 → 破图。wasm/字体早先踩过的坑（pdf.js 静默丢 CCITT 瓦片、
// @font-face 退化）是同一个机制。白名单化后新增任何二进制资源都自动安全，漏配只会「少一个
// charset」而不是「字节损坏」。cmaps/*.bcmap 是预编译二进制 CMap，同样不能进白名单。
const RAWFILE_TEXT_RE: RegExp = /\.(js|mjs|css|json|map|html?|svg|txt|xml|csv|md)$/i;

// rawfile 的 https 别名：ArkWeb 下页面 origin 是 null，resource:// 不在 fetch/XHR/动态 import 的
// scheme 白名单里（只有 arkweb/chrome/data/http/https 允许），所以 cmaps/standard_fonts/wasm 只能
// 绕 readRawFileJson 桥 —— base64 过主线程，是 PDF 打开慢与字体超时回落的原因之一。
// 这里把该别名交给 onInterceptRequest 自建响应（原生直读字节 + CORS），http(s) 本就在白名单内，
// INTERNET 权限 module.json5 已声明；拦截命中时不产生真实网络请求（域名不解析）。
// 渲染层经 window.__goAssetBase 拿到别名，探测实测通得过才切过去，拦截失效自动回落老通道。
const ASSET_ORIGIN: string = 'https://goasset.local/';

// 把 JSBridge 的同步返回包装成与 Electron preload 一致的 Promise 形态。
// preload 里所有 ipcRenderer.invoke() 都返回 Promise，renderer 代码按 .then() 消费。
//
// 完整 Mock desktop 对象 —— docs preload 一共暴露 47 个方法。
// 桥打通（M3+）只需在 mock 同名方法里调 ArkTS 注入的真实实现，再删 mock 默认值即可。
// 现在 mock 让应用启动期所有调用都有响应，根除 "X is not a function"。
const PROMISE_SHIM = `(function () {
  // ===== 动态 import 中转（必须最早就位：主 bundle 内联体在 </body> 前同步执行）=====
  // rawfile 通道对 module/crossorigin 请求缺 CORS 头与 JS MIME，import("./assets/x.js")
  // 恒 "Failed to fetch"。经典脚本的同源 fetch/XHR 无 JS MIME 检查，拿到源码后以
  // data: URL 按 module import（CSP 已放开 data: blob:）。全挂时回落原生 import。
  function b64utf8(s) {
    var bytes = new TextEncoder().encode(s), bin = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }
  function dataImport(code) {
    return import('data:text/javascript;charset=utf-8;base64,' + b64utf8(code));
  }
  function fetchText(spec) {
    if (!window.fetch) { return Promise.reject(new Error('no fetch')); }
    return fetch(spec).then(function (r) {
      if (!r.ok) { throw new Error('HTTP ' + r.status); }
      return r.text();
    });
  }
  function xhrText(spec) {
    return new Promise(function (resolve, reject) {
      try {
        var x = new XMLHttpRequest();
        x.open('GET', spec, true);
        x.onload = function () { (x.status === 200 || x.status === 0) ? resolve(x.responseText) : reject(new Error('XHR ' + x.status)); };
        x.onerror = function () { reject(new Error('XHR error')); };
        x.send();
      } catch (e) { reject(e); }
    });
  }
  window.__goImport = function (spec) {
    var cache = window.__goModCache || (window.__goModCache = {});
    if (cache[spec]) { return cache[spec]; }
    var p;
    // ArkWeb 关键限制：fetch/XHR 对 resource:// scheme 一律拒绝（CORS 只放行
    // arkweb/chrome/data/http/https…），网络取源码在中端不可行。构建期 inline-renderer
    // 已把 assets/*.js 源码以 base64 写进 window.__goChunks（key=含 hash 的文件名），
    // 这里按 basename 命中后直接 import(blob:) —— data:/blob: 都在允许列表。
    var key = String(spec || '');
    if (key.indexOf('resource://rawfile/') === 0) { key = key.slice('resource://rawfile/'.length); }
    var slash = key.lastIndexOf('/');
    var base = slash >= 0 ? key.slice(slash + 1) : key;
    var tbl = window.__goChunks || {};
    var b64 = tbl[base] || tbl[key];
    if (b64) {
      try {
        var bin = atob(b64), len = bin.length, bytes = new Uint8Array(len);
        for (var i2 = 0; i2 < len; i2++) { bytes[i2] = bin.charCodeAt(i2); }
        var code = new TextDecoder().decode(bytes);
        var rewrote = false;
        // 兜底改写（纯字符串方法，零正则转义风险）：语言包 chunk 顶层静态
        // import{...}from"./index-<hash>.js" —— 若构建期改写缺失（旧产物/新 hash
        // 语言包），blob: 模块内相对 import 无法解析会抛 "Failed to resolve module
        // specifier"。这里按字符串形态解析绑定并换成 reexports 取值。
        if (code.indexOf('import{') === 0) {
          var semi = code.indexOf(';');
          if (semi > 0) {
            var head = code.slice(0, semi);
            var fromMark = head.indexOf('from');
            if (fromMark > 0) {
              var specPart = head.slice(fromMark + 4).replace(/"/g, '').replace(/'/g, '').trim();
              var depKey = specPart.split('/').pop();
              var bindsPart = head.slice(0, fromMark).replace(/import{/, '').replace(/}/g, '').trim();
              var stmts = [];
              var bindArr = bindsPart.split(',');
              for (var bi = 0; bi < bindArr.length; bi++) {
                var bBind = bindArr[bi].trim();
                if (!bBind) { continue; }
                var asPos = bBind.indexOf(' as ');
                var frm = asPos >= 0 ? bBind.slice(0, asPos).trim() : bBind.trim();
                var to = asPos >= 0 ? bBind.slice(asPos + 4).trim() : bBind.trim();
                stmts.push('const ' + to + '=(window.__goChunkReexports||{})[' + JSON.stringify(depKey) + '][' + JSON.stringify(frm) + '];');
              }
              code = stmts.join(' ') + code.slice(semi + 1);
              rewrote = true;
            }
          }
        }
        // 仅当运行时兜底改写被触发（构建期改写缺失）时提示，正常加载不刷屏。
        if (rewrote) {
          try {
            // 校验改写后能借 reexports 取到绑定：取不到说明主 chunk 未挂载/文件名不匹配
            var __checkKey = (typeof window !== 'undefined' && window.__goChunkReexports) ? depKey : null;
            if (!__checkKey || !window.__goChunkReexports[__checkKey] || typeof window.__goChunkReexports[__checkKey].m === 'undefined') {
              console.error('[GenOffice] goImport chunk runtime-rewrote (m missing): ' + base);
            }
          } catch (e) { /* 校验失败不阻断加载 */ }
        }
        var blobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
        p = Promise.resolve(import(blobUrl));
      } catch (e) {
        console.error('[GenOffice] goImport chunk->blob failed (' + (e && e.message || e) + '): ' + key);
        p = Promise.reject(e);
      }
    } else if (String(spec).indexOf('resource://rawfile/') === 0) {
      // 真机实测（ArkWeb）：本页 origin 是 null，resource:// 的三条网络通道全部不可用 ——
      // fetch 以 "URL scheme resource is not supported" 拒绝，XHR 与原生动态 import 都被
      // CORS 拦（只放行 arkweb/chrome/data/http/https…）。故未注册进 __goChunks 的 rawfile
      // JS 在本页加载不了：注册表命中（blob:）才是可行通道，data: 需桥先读字节。
      // 这里以原生 import 尝试（Electron/dev 与将来 CORS 化自定义 scheme 时可通），失败即止，
      // 不再叠两次注定失败的 fetch/XHR 请求与两行 error 日志。
      p = import(spec).catch(function (e) {
        console.error('[GenOffice] goImport resource:// 未注册且原生 import 失败（ArkWeb 下 fetch/XHR/import 均被拦）: ' + spec + ' :: ' + (e && e.message || e));
        return Promise.reject(e);
      });
    } else {
      // 未命中注册表（网络 URL / 其它 scheme）：保留原 fetch/XHR 兜底。
      p = fetchText(spec)
        .catch(function (e) {
          console.error('[GenOffice] goImport fetch miss (' + (e && e.message || e) + '), try XHR: ' + spec);
          return xhrText(spec);
        })
        .then(dataImport)
        .catch(function (e) {
          console.error('[GenOffice] goImport data-route failed (' + (e && e.message || e) + '), fallback native import: ' + spec);
          return import(spec);
        });
    }
    cache[spec] = p;
    return p;
  };
  // 版本探针（error 级必现）：真机日志出现此行 = 已启用动态 import 中转（v4, chunk table）。
  console.error('[GenOffice] dynamic-import shim active (v4, chunk table)');
  // 运行时变量形态的动态 import：pdf.js worker、sheets 语言包等编译产物把模块路径
  // 放进变量（bundle 里是 import(VAR)，静态字面量改写覆盖不到）。把 VAR 按文档
  // 基准解析成 resource:// 相对路径，再交给 __goImport 走 fetch/data: 中转。
  window.__goImportDynamic = function (u) {
    var abs;
    try { abs = new URL(String(u), document.baseURI || location.href).href; } catch (e) { abs = String(u); }
    // 直接传绝对 resource:// URL：fetch 对绝对 URL 不会按页面 base 二次拼接
    // （此前剥成相对路径会拼出 web/pdf/web/pdf/… 双重前缀）。
    return window.__goImport(abs);
  };

  // ===== 剪贴板兜底：ArkWeb navigator.clipboard.readText 权限被拒（NotAllowedError）
  // → ArkTS pasteboard 桥（readClipboardText/writeClipboardText）。原生可用时优先原生。
  // 注意：app 跑在 shell 的 iframe 里时 ArkTS 桥可能只注入了 top frame，
  // 统一走 goNative（沿 parent 链找真实桥；本 frame 的 Proxy 兜底函数返回 undefined）=====
  try {
    if (navigator.clipboard) {
      var oc = navigator.clipboard;
      var origRead = oc.readText ? oc.readText.bind(oc) : null;
      oc.readText = function () {
        var viaBridge = function () {
          return goNative('readClipboardText', []).then(function (t) {
            return typeof t === 'string' ? t : '';
          }).catch(function () { return ''; });
        };
        return origRead ? origRead().catch(viaBridge) : viaBridge();
      };
      oc.writeText = function (t) {
        try {
          goNative('writeClipboardText', [String(t)]);
          return Promise.resolve();
        } catch (e) { return Promise.reject(e); }
      };
    }
  } catch (e) { /* navigator.clipboard 不存在时 app 自会走桥 */ }

  // ===== M3：native 桥调用助手（xxxJson 通道：base64/JSON 字符串传输）=====
  function b64ToBuf(b64) {
    var bin = atob(b64), n = bin.length, u = new Uint8Array(n);
    for (var i = 0; i < n; i++) { u[i] = bin.charCodeAt(i); }
    return u.buffer;
  }
  function bufToB64(buf) {
    // 兼容 ArrayBuffer 与 Uint8Array（savePptx 返回 Uint8Array，可能带偏移/尾部
    // 多余字节，必须仅取 view 范围内的字节 —— new Uint8Array(arrBuf) 会取整块）。
    var u = (buf instanceof Uint8Array) ? buf : new Uint8Array(buf || 0), s = '';
    for (var i = 0; i < u.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }
  // ArkTS 真实桥注册为 window.desktopNative（gin 宿主对象，仅主 frame 注入）。
  // 关键：gin 桥方法只能在注入它的 frame 里调用 —— 即使对象被注入到所有 frame 的
  // window（ArkWeb 6.x registerJavaScriptProxy 文档行为），跨 frame 调时 gin 内部
  // frame check 仍会拒（"native proxy object not found"）。所以这里返回"caller 闭包"
  // 而不是桥对象：
  //   1) 永远优先沿 parent 链找顶层 __goNativeCall 转发器（SHELL_BRIDGE 在顶层
  //      桥就绪后安装，函数本身是普通 JS，跨 frame 调用合法；内部 nb[method].apply
  //      是在主 frame 内调 host object，gin 接受）；
  //   2) fallback 到本 frame 的 desktopNative（同 frame 内调用，gin 接受）；
  // 3) 都没有时返回 null（不抛，挂起保护靠 goNative/goJson Promise.resolve）
  // 关键原因：iframe 路由下（如 PDF 磁贴）用户调 window.pdfApi.openFileJson → 走本
  // mock → findNativeCaller。如果优先本地 desktopNative，iframe 内虽然 window 上
  // 有 desktopNative 但调它必报 non-injected object（user 截图 'OnInvokeMethodAsync
  // async method name: openFileJson' → 'native proxy object not found'）。改顺序后
  // 走顶层 __goNativeCall → 主 frame 内调 → gin 接受 → 真正可达。
  function findNativeCaller() {
    try {
      var cur = window;
      while (cur) {
        var f = cur.__goNativeCall;
        if (typeof f === 'function') {
          if (!window.__goNativeLogged) {
            window.__goNativeLogged = true;
            console.info('[GenOffice] native bridge: __goNativeCall forwarder');
          }
          return function (method, args) { return f(method, args); };
        }
        if (cur === cur.parent) { break; }
        cur = cur.parent;
      }
    } catch (e) { /* 跨域 frame 访问被拒 */ }
    try {
      var d = window.desktopNative;
      if (d && typeof d.bridgeCall === 'function') {
        if (!window.__goNativeLogged) {
          window.__goNativeLogged = true;
          console.info('[GenOffice] native bridge: local desktopNative');
        }
        return function (method, args) { return d.bridgeCall(method, JSON.stringify(args || [])); };
      }
    } catch (e) { /* ignore */ }
    console.warn('[GenOffice] native caller not found (forwarder + local bridge 均不可用)');
    return null;
  }
  function goJson(method, args) {
    var call = findNativeCaller();
    if (!call) { return Promise.resolve(null); }
    try {
      // ArkTS asyncMethodList 注入的方法返回 Promise<string>，统一 await 后 JSON.parse
      var p = call(method, args);
      console.info('[GenOffice] goJson call ' + method + ' type=' + (typeof p) + ' isPromise=' + (p && typeof p.then === 'function'));
      return Promise.resolve(p).then(function (j) {
        console.info('[GenOffice] goJson ' + method + ' resolved type=' + (typeof j) + ' len=' + (typeof j === 'string' ? j.length : 0));
        if (typeof j !== 'string') { console.warn('[GenOffice] goJson ' + method + ' not string'); return null; }
        if (!j) { console.warn('[GenOffice] goJson ' + method + ' empty string'); return null; }
        try { var parsed = JSON.parse(j); console.info('[GenOffice] goJson ' + method + ' parsed ok=' + parsed.ok); return parsed; } catch (e) { console.warn('[GenOffice] goJson ' + method + ' JSON parse fail: ' + e); return null; }
      });
    } catch (e) { console.warn('[GenOffice] goJson ' + method + ' threw: ' + e); return Promise.resolve(null); }
  }
  // 非 JSON 通道（readClipboardText 等）：原样值透传，不 JSON.parse
  function goNative(method, args) {
    var call = findNativeCaller();
    if (!call) { return Promise.resolve(undefined); }
    try {
      return Promise.resolve(call(method, args));
    } catch (e) { return Promise.reject(e); }
  }
  // pdf.js 资源根别名：壳侧 onInterceptRequest 对 https://goasset.local/ 自建响应
  // （renderer 的 view-config.ts 优先用它，探测失败自动回落 resource://rawfile）。
  try { window.__goAssetBase = 'https://goasset.local/'; } catch (e) { /* 非浏览器环境忽略 */ }
  // ===== rawfile fetch 兜底 =====
  // ArkWeb 下本页 origin 是 null：fetch 对 resource:// 报 "URL scheme resource is not
  // supported"，XHR 与原生 import 被 CORS 拦 —— 三条网络通道全废。pdf.js 的 cmap /
  // 标准字体数据 / wasm 字节都经主线程 fetch/XHR 取（useWorkerFetch 只在 http(s) 下为真），
  // 因此 CJK 预定义 cmap 与 wasm 快解码一起哑火。这里把 resource://rawfile/* 的 fetch
  // 改道走已验证的 readRawFileJson 桥（pdf-bridge / pdf-convert / pdfium.wasm / pptx-bridge
  // 同一条通道），用真字节构造 Response —— 调用方看到的仍是标准 fetch 语义。
  // 只拦绝对 resource://rawfile/ URL：相对路径交回原生 fetch（loadPdfiumBytes 自有回退）。
  try {
    if (typeof window.fetch === 'function' && typeof Response === 'function') {
      var goFetchNative = window.fetch.bind(window);
      var GO_RAWFILE_FETCH = 'resource://rawfile/';
      // 别名根同样兜底：拦截器失效时走桥（慢但字节正确），绝不落到真实网络。
      var GO_ASSET_FETCH = 'https://goasset.local/';
      var goRawfileFetchCache = {};
      function goRawfileMime(p) {
        var dot = p.lastIndexOf('.');
        var ext = dot >= 0 ? p.slice(dot + 1).toLowerCase() : '';
        if (ext === 'wasm') { return 'application/wasm'; }
        if (ext === 'json') { return 'application/json'; }
        if (ext === 'js' || ext === 'mjs') { return 'text/javascript'; }
        if (ext === 'css') { return 'text/css'; }
        if (ext === 'ttf') { return 'font/ttf'; }
        if (ext === 'otf') { return 'font/otf'; }
        if (ext === 'woff') { return 'font/woff'; }
        if (ext === 'woff2') { return 'font/woff2'; }
        return 'application/octet-stream';
      }
      window.fetch = function (input, init) {
        var url = '';
        try {
          url = (typeof input === 'string') ? input : ((input && input.url) ? input.url : '');
        } catch (e) { url = ''; }
        if (url.indexOf(GO_RAWFILE_FETCH) === 0) {
          var rel = url.slice(GO_RAWFILE_FETCH.length);
        } else if (url.indexOf(GO_ASSET_FETCH) === 0) {
          var rel = url.slice(GO_ASSET_FETCH.length);
        } else { return goFetchNative(input, init); }
        var qi = rel.indexOf('?');
        if (qi >= 0) { rel = rel.slice(0, qi); }
        var hi = rel.indexOf('#');
        if (hi >= 0) { rel = rel.slice(0, hi); }
        try { rel = decodeURIComponent(rel); } catch (e) { /* 保留原样 */ }
        var cached = goRawfileFetchCache[rel];
        if (cached) {
          return Promise.resolve(new Response(cached, {
            status: 200,
            statusText: 'OK',
            headers: { 'Content-Type': goRawfileMime(rel), 'Access-Control-Allow-Origin': '*' }
          }));
        }
        return goJson('readRawFileJson', [rel]).then(function (r) {
          if (!r || r.ok !== true || !r.b64) {
            throw new Error('readRawFileJson miss: ' + rel);
          }
          var bytes = new Uint8Array(b64ToBuf(r.b64));
          goRawfileFetchCache[rel] = bytes;
          if (!window.__goRawfileFetchCount || window.__goRawfileFetchCount < 12) {
            window.__goRawfileFetchCount = (window.__goRawfileFetchCount || 0) + 1;
            console.info('[GenOffice] rawfile fetch via bridge (' + window.__goRawfileFetchCount + '): ' + rel + ' bytes=' + bytes.length);
          }
          return new Response(bytes, {
            status: 200,
            statusText: 'OK',
            headers: { 'Content-Type': goRawfileMime(rel), 'Access-Control-Allow-Origin': '*' }
          });
        }).catch(function (e) {
          console.error('[GenOffice] rawfile fetch via bridge failed: ' + rel + ' :: ' + (e && e.message ? e.message : e));
          return Promise.reject(new TypeError('Failed to fetch'));
        });
      };
      // error 级必现探针：真机日志出现此行 = rawfile fetch 兜底已启用（对齐动态 import shim 的验证惯例）
      console.error('[GenOffice] rawfile fetch shim active (resource://rawfile/* -> readRawFileJson)');
    }
  } catch (e) { /* fetch/Response 不可用时保持原状（原生 fetch 仍会失败，行为不退化） */ }
  function openResultFrom(r) {
    if (!r || !r.ok) { return null; }
    return { path: r.path, name: r.name, data: b64ToBuf(r.b64), hash: r.hash, encrypted: false };
  }
  function recentFilesImpl() {
    return goJson('recentFilesJson', []).then(function (r) {
      return (r && typeof r === 'object' && typeof r.length === 'number') ? r : [];
    });
  }

  var NOOP = function () {};
  // 未保存状态推送锚点：只在状态**变化**时打一行。app frame 的 console 会进 hilog，
  // 用它精确区分「渲染层没推」与「壳读不到」这两类「关 tab 不弹保存提示」的失败。
  function dirtyTrace(v, extra) {
    try {
      if (window.__goDirtyTraced === v) { return; }
      window.__goDirtyTraced = v;
      console.info('[GenOffice] frame dirty=' + v + (extra ? ' ' + extra : ''));
    } catch (e) { /* 忽略 */ }
  }
  // ===== 跨 frame 未保存状态通道（postMessage）=====
  // 真机取证：ArkWeb 下 resource://rawfile 文档 origin=null（opaque），父子 frame 互读属性抛
  // SecurityError —— 壳读 frames[id].contentWindow.__goFrameDirty 恒为 false，而 app frame 里
  // findNativeCaller 的 parent 链遍历同样失败（hilog: "native bridge: local desktopNative"），
  // 证明「关标签前提示保存」三条同步通道在真机全部读不到。postMessage 是 opaque origin 之间
  // 唯一可用通道，用 ev.source 做身份匹配（WindowProxy 同一性跨域可比较），无需给 iframe 传
  // tab id。三条消息：
  //   app → 壳：{__goDirty:<bool>}            状态变化即推（壳据此维护 dirty 缓存）
  //   壳 → app：{__goDirtyQuery:true}         app → 壳：{__goDirtyAnswer:true,dirty:<bool>}
  //   壳 → app：{__goCloseSaveRequest:true}   app → 壳：{__goCloseSaveAnswer:true,ok:<bool>}
  function frameDirtyValue() {
    try { if (window.__goFrameDirty) { return true; } } catch (e) { /* 忽略 */ }
    try {
      if (typeof window.__goCloseCheckHandler === 'function') {
        window.__goCloseCheckHandler();
        var st = window.__goCloseCheck;
        return !!(st && st.dirty);
      }
    } catch (e) { /* 忽略 */ }
    return false;
  }
  function pushDirtyToHost(v) {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ __goDirty: !!v, tabId: window.__goTabId || null }, '*');
      }
    } catch (e) { /* 忽略 */ }
  }
  function answerToHost(ev, msg) {
    try {
      var t = (ev && ev.source) ? ev.source : window.parent;
      if (t && typeof t.postMessage === 'function') { t.postMessage(msg, '*'); }
    } catch (e) { /* 忽略 */ }
  }
  // 「保存并关闭」（app 侧）：跑本 frame 渲染层登记的 onCloseSaveRequest 回调，轮询其结果
  // 通道后回写。结果非 null/undefined = 明确成功/失败；60s 上限兜底（系统保存框可能久留）。
  function runCloseSaveRequest(ev) {
    var handler = null;
    try { handler = window.__goCloseSaveHandler; } catch (e) { handler = null; }
    var ans = function (extra) {
      var msg = { __goCloseSaveAnswer: true, tabId: window.__goTabId || null };
      for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) { msg[k] = extra[k]; } }
      answerToHost(ev, msg);
    };
    if (typeof handler !== 'function') {
      ans({ ok: false, noHandler: true });
      return;
    }
    try { window.__goCloseSaveResult = null; } catch (e) { /* 忽略 */ }
    try { handler(); } catch (e) {
      console.error('[GenOffice] closeSave handler threw: ' + e);
      ans({ ok: false, threw: true });
      return;
    }
    var tries = 0;
    (function poll() {
      var r = null;
      try { r = window.__goCloseSaveResult; } catch (e) { r = null; }
      if (r !== null && r !== undefined) {
        ans({ ok: r === true });
        return;
      }
      if (tries++ > 600) {
        ans({ ok: false, timeout: true });
        return;
      }
      setTimeout(poll, 100);
    })();
  }
  // ===== 壳 chrome 菜单 → 本 frame 渲染层命令（另存为 / 打印 / 菜单命令）=====
  // 桌面版这条链由 Electron 原生菜单 + 主进程 IPC 派发；鸿蒙壳没有原生菜单，改为：
  //   壳自绘菜单（Tab 列表菜单顶部的「另存为…/打印…」，见 SHELL_BRIDGE showTabsMenu）
  //   → postMessage({__goSaveAsRequest|__goPrintRequest|__goMenuCommand|__goMenuAction})
  //   → 本 frame 派发给渲染层登记的回调。
  // 通道按各 app 现状分工（函数名已在 apps/*/src/renderer 核实）：
  //   onSaveAsRequest  pdf            （App.tsx onSaveAsRequest → saveAsTo(targetPath)）
  //   onPrintRequest   pdf / markdown
  //   onExportRequest  markdown       （ExportFormat：'docx' 存盘 / 'docs' 存盘后在 Word 打开）
  //   onSaveRequest    markdown       （'save' 覆盖保存 / 'saveAs' 另存为，回执走 sendSaveRequestAck）
  //   onMenuCommand    docs / slides  （'save-as' / 'print' …）
  //   onMenuAction     sheets         （'save-as' / 'export-pdf' …）
  // 未登记 = 该 app 不支持该动作：壳侧按 tab.kind 只显示有通道的项，这里再兜一层静默。
  var frameSaveAsFns = [];
  var framePrintFns = [];
  var frameExportFns = [];
  var frameSaveRequestFns = [];
  var frameMenuCommandFns = [];
  var frameMenuActionFns = [];
  function registerFrameFn(list, fn) {
    if (typeof fn !== 'function') { return function () { /* 非法回调：返回空撤销函数 */ }; }
    list.push(fn);
    return function () {
      var at = list.indexOf(fn);
      if (at >= 0) { list.splice(at, 1); }
    };
  }
  // 逐个派发，单个渲染层回调抛错不影响其余；返回触达数量（壳侧日志/门禁据此判断是否真有落点）
  function fireFrameFns(list, a, b, tag) {
    var fns = list.slice();
    for (var i = 0; i < fns.length; i++) {
      try { fns[i](a, b); } catch (e) { console.error('[GenOffice] ' + tag + ' handler threw: ' + e); }
    }
    return fns.length;
  }
  function triggerSaveAsRequest(targetPath) {
    return fireFrameFns(frameSaveAsFns, targetPath || '', undefined, 'saveAs') > 0;
  }
  function triggerFramePrint() {
    return fireFrameFns(framePrintFns, undefined, undefined, 'print') > 0;
  }
  // 导出派发（markdown）：format 取桌面 ExportFormat 字面量（'pdf' / 'docx' / 'docs' / 'png'）。
  // 只放行壳菜单真实会发的两种，其余静默丢弃 —— 渲染层 runExport 对 'pdf'/'png' 会走
  // HTML→PDF 与逐页栅格化链路（壳内不可用），发过去只会得到「点了没反应」的观感。
  function triggerFrameExport(format) {
    if (format !== 'docx' && format !== 'docs') { return false; }
    return fireFrameFns(frameExportFns, format, undefined, 'export') > 0;
  }
  // 保存派发（markdown）：mode 只放行 'save' / 'saveAs' —— 渲染层把它直接透传给
  // markdownApi.save({mode})，而壳侧 save 只认 'saveAs'（其余按覆盖保存处理），
  // 传错字面量会让「另存为」变成静默覆盖原文件（数据风险，必须收窄）。
  function triggerFrameSaveRequest(mode) {
    if (mode !== 'save' && mode !== 'saveAs') { return false; }
    return fireFrameFns(frameSaveRequestFns, mode, undefined, 'saveRequest') > 0;
  }
  function triggerMenuCommand(cmd, payload) {
    return fireFrameFns(frameMenuCommandFns, cmd, payload, 'menuCommand') > 0;
  }
  function triggerMenuAction(action) {
    return fireFrameFns(frameMenuActionFns, action, undefined, 'menuAction') > 0;
  }
  // ===== AI 面板偏好（side / fontSize / customFontSize / spellcheck）=====
  // 桌面由主进程写 app-settings.json，并广播 'app:ai-panel-prefs-changed'；壳侧镜像到
  // localStorage 并对同一 tab 广播。渲染层 main.tsx 启动时 getAiPanelPrefs() 应用一次、
  // 订阅 onAiPanelPrefsChanged —— 缺这三个方法时（Proxy 兜底）偏好不持久化：头部
  // 的「停靠到左/右」点了没反应、重开又回左侧。normalize 规则对齐
  // packages/ui/src/ai-panel-prefs.ts（非法字段落回默认值，customFontSize 夹在 10~32）。
  var frameAiPrefsFns = [];
  var AI_PANEL_KEY = 'genoffice.aiPanelPrefs';
  var AI_PANEL_SIZES = ['default', 'large', 'xlarge', 'custom'];
  function defaultAiPanelPrefs() {
    return { side: 'left', fontSize: 'default', customFontSize: 14, spellcheck: true };
  }
  function normalizeAiPanelPrefs(raw) {
    var o = (raw && typeof raw === 'object') ? raw : {};
    var d = defaultAiPanelPrefs();
    var size = (typeof o.fontSize === 'string' && AI_PANEL_SIZES.indexOf(o.fontSize) >= 0)
      ? o.fontSize : d.fontSize;
    var n = (typeof o.customFontSize === 'string') ? Number(o.customFontSize) : o.customFontSize;
    var custom = (typeof n === 'number' && isFinite(n))
      ? Math.min(32, Math.max(10, Math.round(n))) : d.customFontSize;
    return {
      side: (o.side === 'right') ? 'right' : 'left',
      fontSize: size,
      customFontSize: custom,
      spellcheck: (typeof o.spellcheck === 'boolean') ? o.spellcheck : d.spellcheck
    };
  }
  function loadAiPanelPrefs() {
    try {
      var s = localStorage.getItem(AI_PANEL_KEY);
      if (s) { return normalizeAiPanelPrefs(JSON.parse(s)); }
    } catch (e) { /* 损坏则回默认 */ }
    return defaultAiPanelPrefs();
  }
  function saveAiPanelPrefs(p) {
    try { localStorage.setItem(AI_PANEL_KEY, JSON.stringify(p || {})); } catch (e) { /* 忽略 */ }
  }
  // patch 语义对齐桌面：非法字段沿用「上一次」的值而不是默认值
  function mergeAiPanelPrefs(patch) {
    var prev = loadAiPanelPrefs();
    var o = (patch && typeof patch === 'object') ? patch : {};
    var next = {
      side: (o.side === 'left' || o.side === 'right') ? o.side : prev.side,
      fontSize: ('fontSize' in o) ? o.fontSize : prev.fontSize,
      customFontSize: ('customFontSize' in o) ? o.customFontSize : prev.customFontSize,
      spellcheck: ('spellcheck' in o) ? o.spellcheck : prev.spellcheck
    };
    return normalizeAiPanelPrefs(next);
  }
  // 桌面 setAiPanelPrefs 会向所有 webContents 广播 'app:ai-panel-prefs-changed'；
  // 壳侧等价物是逐个已注册的渲染层回调（只覆盖当前 tab 的 frame，tab 间各自持久化同步）
  function broadcastAiPanelPrefs(p) {
    fireFrameFns(frameAiPrefsFns, p, undefined, 'aiPanelPrefs');
  }
  // shell 首页设置面板改的是同一份 localStorage（见 __goShared 注释）：同源它的文档会收到
  // storage 事件，借此让已打开的 app iframe 立刻跟随（同一 tab 内 shell 页与 iframe 文档不同，
  // 各自 shim 实例的回调列表不共享）。ArkWeb 若不派发该事件则退化为「重新打开该文档时生效」，
  // 不报错、不影响其它路径。
  try {
    window.addEventListener('storage', function (e) {
      if (!e || e.key !== AI_PANEL_KEY || typeof e.newValue !== 'string') { return; }
      var p = null;
      try { p = normalizeAiPanelPrefs(JSON.parse(e.newValue)); } catch (err) { p = null; }
      if (p) { fireFrameFns(frameAiPrefsFns, p, undefined, 'aiPanelPrefs'); }
    });
  } catch (e) { /* 无 addEventListener 的环境（测试 harness）忽略 */ }
  // ===== 打印：排版好的 HTML → 隐藏 iframe → 系统打印框架 =====
  // 桌面把 HTML 写进临时文件、用隐藏 BrowserWindow + webContents.print() 交给系统打印
  // 对话框；壳侧等价物是「同一份 HTML 塞进隐藏 iframe，调该 window 的 print()」——
  // ArkWeb 把 W3C window.print 交给系统打印框架接管（PDF 打印走的就是这条路径）。
  // iframe 隔离是必要的：payload 自带 <style>/@page，直接注入宿主 app 会污染其布局。
  // 放一份文档到 body 上 1px 隐藏位，不参与交互、不影响 app 自身排版。
  // 当前在用的打印 iframe：ArkWeb 的 window.print 是 fire-and-forget，打印框架可能在本
  // 函数返回后仍在读该文档，因此【不能】调用返回就移除（对照 apps/pdf/renderer/print.ts：
  // 打印根保留到 afterprint 或 60s 兜底）。下一次打印先回收上一个，避免 1px 容器堆积。
  var printFrameSlot = null;
  // 桌面「导出 PDF / 导出图片」共用的失败原因文案：这些功能在桌面靠主进程
  // webContents.printToPDF(HTML→PDF) 实现，壳内没有该引擎（只有 PNG→PDF 的
  // pdf-bridge.pngsToPdf 与 PDF→光栅的 pdfium.wasm）。统一走「显式降级 + 可见原因」，
  // 不用空实现（空实现会让渲染层静默或抛英文 undefined 错误）。
  var HTML2PDF_UNAVAILABLE = '鸿蒙版暂不支持该功能：需要桌面版的 HTML→PDF 渲染管线（已列入后续里程碑）';
  function printHtmlViaFrame(html) {
    var prev = printFrameSlot;
    if (prev) {
      printFrameSlot = null;
      try { if (prev.parentNode) { prev.parentNode.removeChild(prev); } } catch (e) { /* 忽略 */ }
    }
    return new Promise(function (resolve) {
      var frame = null;
      var settled = false;
      function finish(r) {
        if (settled) { return; }
        settled = true;
        resolve(r);
      }
      // 只回收容器，不改 settled：定时回收发生在 resolve 之后
      function dispose() {
        try { if (frame && frame.parentNode) { frame.parentNode.removeChild(frame); } } catch (e) { /* 忽略 */ }
        if (printFrameSlot === frame) { printFrameSlot = null; }
      }
      try {
        frame = document.createElement('iframe');
        frame.setAttribute('aria-hidden', 'true');
        frame.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;'
          + 'opacity:0;border:0;pointer-events:none;';
        frame.srcdoc = html;
        frame.onload = function () {
          try {
            var w = frame.contentWindow;
            if (!w || typeof w.print !== 'function') {
              dispose();
              finish({ ok: false, error: '当前设备不支持打印（window.print 不可用）' });
              return;
            }
            // 系统打印框关闭后回收；afterprint 在 ArkWeb 下不保证派发 → 60s 兜底（同 PDF）
            try { w.addEventListener('afterprint', dispose, { once: true }); } catch (e) { /* 忽略 */ }
            setTimeout(dispose, 60000);
            w.focus();
            w.print();
            // 调用返回即视为「已交给打印框架」——取消由用户在系统对话框里做
            finish({ ok: true });
          } catch (e) {
            dispose();
            finish({ ok: false, error: '打印失败：' + (e && e.message ? e.message : e) });
          }
        };
        document.body.appendChild(frame);
        printFrameSlot = frame;
        // 兜底：srcdoc 未触发 onload（异常包形态）时不至于让渲染层 await 悬挂
        setTimeout(function () {
          if (settled) { return; }
          dispose();
          finish({ ok: false, error: '打印准备超时' });
        }, 8000);
      } catch (e) {
        dispose();
        finish({ ok: false, error: '打印失败：' + (e && e.message ? e.message : e) });
      }
    });
  }
  // ===== sheets 崩溃恢复提问（M7-4）：桥 → 渲染层对话框 → 桥 =====
  // 桌面这条链在 main 进程（sheets-main.ts promptRecoveryRestore）：发 recoveryPrompt 事件，
  // 等渲染层 replyRecoveryPrompt(restore) 回来；'dismissed' = 渲染层在回答前消失。
  // 对话框 UI 由渲染层自带（RecoveryDialog.tsx，文案直接用 payload 里的），所以壳这一层
  // 只做「转发 + 等待」，【不要】再自绘 DOM 弹层——会和渲染层的对话框叠成两层。
  var frameRecoveryPromptFns = [];
  var recoveryPromptWaiter = null; // 未决提问的 resolve（单飞）
  // payload 7 字段校验：与桌面 preload 的 onRecoveryPrompt 一致（缺字段的 payload 递给
  // 渲染层会让 RecoveryDialog 渲染出 undefined）。不合格 = 当作"没答"处理。
  function isRecoveryPromptPayload(p) {
    if (!p || typeof p !== 'object') { return false; }
    if (typeof p.title !== 'string' || typeof p.body !== 'string') { return false; }
    if (typeof p.restoreLabel !== 'string' || typeof p.discardLabel !== 'string') { return false; }
    if (typeof p.fileName !== 'string' || typeof p.savedAtMs !== 'number') { return false; }
    return Number.isFinite(p.savedAtMs);
  }
  function settleRecoveryPrompt(choice) {
    var waiter = recoveryPromptWaiter;
    recoveryPromptWaiter = null;
    if (waiter) { waiter(choice); }
  }
  /**
   * 返回 'restore' | 'discard' | 'dismissed'。
   * 没有渲染层订阅时立即 'dismissed'（桌面此时弹原生 messagebox 兜底；壳没有原生对话框层，
   * 按「打开原文件 + 保留恢复副本」处理 = 下次打开再问，绝不丢副本）。
   */
  function askRecoveryPrompt(prompt) {
    return new Promise(function (resolve) {
      // 单飞：上一次提问还没回答又来新的（用户连点两个文件）→ 旧的按 'dismissed' 收口，
      // 避免两个 waiter 抢同一次 reply。桥侧旧的那次打开随后会照常打开原文件。
      settleRecoveryPrompt('dismissed');
      if (frameRecoveryPromptFns.length === 0 || !isRecoveryPromptPayload(prompt)) {
        resolve('dismissed');
        return;
      }
      recoveryPromptWaiter = resolve;
      fireFrameFns(frameRecoveryPromptFns, prompt, undefined, 'recoveryPrompt');
    });
  }
  try {
    window.addEventListener('message', function (ev) {
      var d = ev && ev.data;
      if (!d || typeof d !== 'object') { return; }
      // 壳在查询/保存请求里带上 tab id：缓存下来，后续 push 也带上 → 壳侧不依赖
      // ev.source 的身份匹配（个别 ArkWeb 版本不回填 source 时仍能定位到 tab）
      if (typeof d.tabId === 'string' && d.tabId.length > 0) { window.__goTabId = d.tabId; }
      if (d.__goDirtyQuery) {
        answerToHost(ev, { __goDirtyAnswer: true, dirty: frameDirtyValue(), tabId: window.__goTabId || null });
        return;
      }
      if (d.__goCloseSaveRequest) { runCloseSaveRequest(ev); return; }
      // 壳菜单文件动作（PDF 另存为/打印、docs/slides 菜单命令、sheets 菜单动作）
      if (d.__goSaveAsRequest) {
        triggerSaveAsRequest(typeof d.targetPath === 'string' ? d.targetPath : '');
        return;
      }
      if (d.__goPrintRequest) { triggerFramePrint(); return; }
      if (typeof d.__goExportRequest === 'string') { triggerFrameExport(d.__goExportRequest); return; }
      if (typeof d.__goSaveRequest === 'string') { triggerFrameSaveRequest(d.__goSaveRequest); return; }
      if (typeof d.__goMenuCommand === 'string') { triggerMenuCommand(d.__goMenuCommand, d.payload); return; }
      if (typeof d.__goMenuAction === 'string') { triggerMenuAction(d.__goMenuAction); }
    });
  } catch (e) { /* 忽略 */ }
  // sheets「新建空白表格」投递的空白工作簿（字段对齐引擎 WorkbookMetadata +
  // SheetMetadata 序列化全集；空表字段显式给空值，避免渲染层 .length 读 undefined）。
  // 以 sessionId 建立真实会话语义：workbookFile 非空 → 另存为可用；编辑进 journal →
  // 保存可点（M5 前保存引擎明确报错但按钮可用、错误可见）。
  var BLANK_WORKBOOK = {
    sessionId: 'blank-new',
    name: '未命名表格',
    nameBase: '未命名表格',
    path: '',
    sha256: '0000000000000000000000000000000000000000000000000000000000000000',
    fileBytes: 0,
    readOnly: false,
    needsSaveAs: true,
    entryCount: 0,
    activeTab: 0,
    date1904: false,
    styles: [],
    dxfStyles: [],
    definedNames: [],
    themeColors: null,
    themeFonts: null,
    normalFontName: null,
    workbookProtection: null,
    visuals: [],
    sheets: [{
      id: 'sheet-1',
      name: 'Sheet1',
      rowCount: 100,
      columnCount: 50,
      sourceXmlBytes: 0,
      columnWidths: [],
      defaultRowHeight: null,
      defaultRowHeightFixed: false,
      defaultColumnWidth: null,
      baseColumnWidth: null,
      freeze: null,
      hidden: false,
      tabColor: null,
      showGridLines: true,
      showFormulas: false,
      showRowColHeaders: true,
      rightToLeft: false,
      zoomScale: null,
      tables: [],
      comments: [],
      pivotRanges: [],
      pivotTables: [],
      sparklines: [],
      printArea: null,
      printTitles: null,
      hasScopedDefinedNames: false,
      cellImages: []
    }]
  };
  // 新建空白表格产生的真实引擎会话（selectWorkbook 消费 pendingBlankSheet 后登记）。
  // 保存/另存为统一走另存为对话框（无 URI）；成功后渲染层换到新会话（有 URI），
  // 之后普通保存走正常写回。
  var BLANK_SESSION_IDS = {};
  // ===== 大编辑集分块上传 store（桌面 SaveEditsTransferStore 同款语义）=====
  // >10000 个单元格编辑（整列填充/大区粘贴）走 begin/Chunk 分块；壳内累加
  // 拼回 edits 数组，save 请求带 editsTransferId 在此 take（对齐桌面 main 进程）。
  var MAX_SAVE_EDITS_TOTAL = 10000000;
  var SAVE_EDITS_CHUNK_JSON_MAX = 50000000; // zod 上限：单 chunk JSON 字符串长度
  var MAX_OPEN_TRANSFERS = 4;
  var TRANSFER_IDLE_EXPIRY_MS = 120000;
  var editTransfers = {}; // transferId -> {sessionId,total,chunks,received,lastActivityMs}
  var transferSweepTimer = null;
  function transferSweep() {
    var now = Date.now();
    for (var id in editTransfers) {
      if (editTransfers.hasOwnProperty(id) && (now - editTransfers[id].lastActivityMs) > TRANSFER_IDLE_EXPIRY_MS) {
        delete editTransfers[id];
      }
    }
    if (Object.keys(editTransfers).length === 0 && transferSweepTimer !== null) {
      clearTimeout(transferSweepTimer);
      transferSweepTimer = null;
    }
  }
  function syncTransferSweep() {
    if (Object.keys(editTransfers).length > 0 && transferSweepTimer === null) {
      transferSweepTimer = setTimeout(transferSweep, TRANSFER_IDLE_EXPIRY_MS / 4);
    }
  }
  function takeEditTransfer(transferId, sessionId) {
    var t = editTransfers[transferId];
    if (!t || t.sessionId !== sessionId) { throw new Error('Unknown save transfer.'); }
    delete editTransfers[transferId];
    syncTransferSweep();
    if (t.received !== t.total) { throw new Error('Save transfer is incomplete.'); }
    var edits = [];
    for (var c = 0; c < t.chunks.length; c++) {
      for (var j = 0; j < t.chunks[c].length; j++) { edits.push(t.chunks[c][j]); }
    }
    return edits;
  }
  function discardEditTransfer(transferId, sessionId) {
    var t = editTransfers[transferId];
    if (t && t.sessionId === sessionId) { delete editTransfers[transferId]; }
    syncTransferSweep();
  }
  // app 内「打开」的后缀过滤（起始页磁贴的通用打开不传 = 不限类型）
  var DOCX_SUFFIXES = ['.docx', '.doc'];
  var PDF_SUFFIXES = ['.pdf'];
  var PPTX_SUFFIXES = ['.pptx', '.ppt'];
  var MARKDOWN_SUFFIXES = ['.md', '.markdown', '.txt'];
  // CSV 会话首次保存的「保持格式？」三按钮确认（mock.confirmCsvSave 用）。
  // 为什么自绘 DOM modal：ArkWeb 内 window.confirm 需要 ArkTS onJsDialog 回调，且 confirm
  // 只有两个按钮，而桌面语义是 csv / xlsx / cancel 三选一。必须留在 PROMISE_SHIM 里：
  // 调用方是 sheets app frame（desktopApi 在子 frame 自己的 mock 上），而 SHELL_BRIDGE
  // 有 top guard 只在主 frame 跑 —— 放那边会 "showCsvKeepFormatChoice is not defined"。
  // 文案对齐桌面 i18n：csvKeepFormatMsg / csvKeepFormatDetail + csvContinueBtn /
  // csvKeepXlsxBtn / btnCancel；壳层自绘 UI 一律中文（与关标签保存提示一致）。
  var csvChoiceEl = null;
  function closeCsvChoice() {
    if (csvChoiceEl) { csvChoiceEl.remove(); csvChoiceEl = null; }
  }
  function showCsvKeepFormatChoice() {
    return new Promise(function (resolve) {
      closeCsvChoice();
      var ov = document.createElement('div');
      ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:2147483001;display:flex;align-items:center;justify-content:center';
      var box = document.createElement('div');
      box.style.cssText = 'background:#fff;border-radius:10px;padding:20px 24px;max-width:420px;box-shadow:0 10px 40px rgba(0,0,0,.25);font:13px/1.5 system-ui,sans-serif;color:#202124';
      var title = document.createElement('div');
      title.textContent = '继续以 CSV 格式保存吗?';
      title.style.cssText = 'margin-bottom:8px;font-weight:600';
      var detail = document.createElement('div');
      detail.textContent = 'CSV 只保留单张工作表的纯文本值——公式、格式和其他工作表不会存入 .csv 文件。';
      detail.style.cssText = 'margin-bottom:16px;color:#5f6368';
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:flex-end;gap:8px';
      // answer 先移除弹层再 resolve：连点两个按钮不会双结算
      var answer = function (v) { closeCsvChoice(); resolve(v); };
      var mk = function (label, primary, v) {
        var b = document.createElement('button');
        b.textContent = label;
        b.style.cssText = 'padding:6px 14px;border-radius:6px;border:1px solid #d0d4da;background:' + (primary ? '#1a73e8' : '#fff') + ';color:' + (primary ? '#fff' : '#202124') + ';cursor:pointer;font:13px/1.2 system-ui,sans-serif';
        b.onclick = function (e) { e.stopPropagation(); answer(v); };
        return b;
      };
      // 桌面 defaultId=0 → 主按钮 =「继续保存为 CSV」；cancelId=2 → 点遮罩＝取消
      row.appendChild(mk('取消', false, 'cancel'));
      row.appendChild(mk('另存为 .xlsx', false, 'xlsx'));
      row.appendChild(mk('继续保存为 CSV', true, 'csv'));
      box.appendChild(title); box.appendChild(detail); box.appendChild(row);
      ov.appendChild(box);
      (document.body || document.documentElement).appendChild(ov);
      csvChoiceEl = ov;
      // 用 onclick（而非 addEventListener）：门禁 harness 的 DOM stub 只提供 onclick
      ov.onclick = function (e) { if (e.target === ov) { answer('cancel'); } };
    });
  }
  // ===== 生图 / 媒体理解（批次 E：自建通道，不沿用 Genspark 云工具的计费身份）=====
  // 桌面这两件事走 Genspark 账号 + gsk CLI 子进程；移植版把它换成用户自备 Key 的直连：
  //   生图 = OpenAI 兼容 POST {base}/images/generations → {data:[{b64_json|url}]}
  //   理解 = 复用聊天双协议通道（OpenAI 兼容 / Anthropic），把素材塞成多模态输入
  // 端点/模型/Key 来自 settings.media.providers[<提供方>]（设置 - AI 媒体与搜索 里填）。
  var AI_MEDIA_BASE = {
    openai: 'https://api.openai.com/v1',
    gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
    doubao: 'https://ark.cn-beijing.volces.com/api/v3',
    glm: 'https://open.bigmodel.cn/api/paas/v4',
    xai: 'https://api.x.ai/v1',
    qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    minimax: 'https://api.minimaxi.com/v1',
    custom: ''
  };
  var AI_IMAGE_SIZES = {
    '1:1': '1024x1024', '16:9': '1792x1024', '9:16': '1024x1792',
    '4:3': '1024x768', '3:4': '768x1024', '3:2': '1024x682', '2:3': '682x1024'
  };
  // 各家默认生图 / 解析模型（上游 byokModel 的语义：config.imageModel || meta.defaultImageModel）。
  // 与 SHELL_BRIDGE 的 AI_MEDIA_CATALOG 是**两个脚本作用域**（同 AI_MEDIA_BASE 那份注释），
  // 各需一份 → verify-all 的 checkAiMediaReuse 会逐家对账，防止两边漂移。
  var AI_MEDIA_DEFAULT_IMAGE_MODEL = {
    openai: 'gpt-image-1', glm: 'cogview-4-250304', qwen: 'qwen-image-plus',
    doubao: 'doubao-seedream-5-0-260128', xai: 'grok-imagine-image-2.0',
    gemini: '', custom: ''
  };
  var AI_MEDIA_DEFAULT_ANALYSIS_MODEL = {
    openai: 'gpt-5.6-terra', glm: 'glm-4.6v', qwen: 'qwen3-vl-plus',
    doubao: 'doubao-seed-2-1-pro-260628', xai: 'grok-4.6',
    gemini: 'gemini-3.7-flash', custom: ''
  };
  // 「AI 模型」页里某个供应商已填好的配置（Key / 端点 / 模型）—— 媒体块的复用来源。
  // 与 aiResolveEndpoint 的区别：那个按「当前选中的聊天供应商」解析，这里必须按**指定的 pid**
  //（用户在 AI 模型里配了通义、聊天用的是别家，生图选通义时依然要拿到通义的 Key/端点）。
  function aiVendorChatConfig(s, pid) {
    var pc = (s && s.providers && s.providers[pid]) || {};
    var base = (pc.baseUrl && pc.baseUrl.trim()) ? pc.baseUrl.trim()
      : (pid === 'anthropic' ? AI_ANTHROPIC_DEFAULT_BASE : (AI_DEFAULT_BASE[pid] || ''));
    var list = sanitizeModelList(pc.models);
    return { base: base, key: pc.apiKey || '', model: list.length ? list[0] : (pc.model || '') };
  }
  function aiMediaEndpoint(cap) {
    var s = loadAiSettings();
    var m = (s && s.media) || defaultAiMediaSettings();
    var pid = cap === 'image' ? m.imageProvider
      : (cap === 'video' ? m.videoAnalysisProvider : m.analysisProvider);
    var c = (m.providers && m.providers[pid]) || {};
    var base = (c.baseUrl && c.baseUrl.trim()) ? c.baseUrl.trim() : (AI_MEDIA_BASE[pid] || '');
    var key = c.apiKey || '';
    var model = (cap === 'image' ? c.imageModel : c.analysisModel) || '';
    // 「AI 模型里已配置好的直接可用」：媒体块没填的字段回退到同一供应商在 AI 模型里的配置，
    // 用户不必在聊天页和这里各填一遍 Key。
    var own = aiVendorChatConfig(s, pid);
    if (!key) { key = own.key; }
    if (!base) { base = own.base; }
    if (!model) {
      // ① 该供应商的官方默认模型（上游 byokModel 同语义）② 同一供应商在 AI 模型里配的模型
      //（自定义端点没有官方默认，只能靠用户配过的那个；生图模型还得是 /images/generations 认的）。
      model = cap === 'image' ? AI_MEDIA_DEFAULT_IMAGE_MODEL[pid] : AI_MEDIA_DEFAULT_ANALYSIS_MODEL[pid];
      if (!model) { model = own.model; }
    }
    if (cap !== 'image' && (!model || !key || !base)) {
      // 该供应商在 AI 模型里也没配 → 沿用旧行为，退回「当前选中的聊天供应商」那一套
      var chat = aiResolveEndpoint(s);
      if (!model) { model = chat.model; }
      if (!base) { base = chat.base; }
      if (!key) { key = chat.key; }
    }
    return { pid: pid, base: aiTrimSlashes(base), key: key, model: model };
  }
  // 媒体解析该用哪套端点：「图片解析」/「视频解析」块 →「生图」块（同一网关常一个 key 通吃）
  // → 聊天 provider。三项（端点/Key/模型）不齐的块一律跳过：半套配置发出去只会拿到 401/404。
  function aiMediaTarget(cap, needVideo) {
    var chain = cap === 'video' ? ['video', 'image'] : ['analysis', 'image'];
    for (var i = 0; i < chain.length; i++) {
      var ep = aiMediaEndpoint(chain[i]);
      if (!ep.base || !ep.key || !ep.model) { continue; }
      var proto = aiProtocolFor(ep.pid, ep.base);
      if (needVideo && proto === 'anthropic') { continue; }
      return { pid: ep.pid, protocol: proto, base: ep.base, key: ep.key, model: ep.model, maxTokens: 0 };
    }
    return aiResolveEndpoint(loadAiSettings());
  }
  // /images/generations 的响应 → 渲染层契约 {url?, error?}
  function aiPickImagePayload(j) {
    var arr = j && j.data;
    if (!arr || !arr.length) { return { error: '生图响应缺少 data[]' }; }
    var it = arr[0] || {};
    if (it.b64_json) { return { url: 'data:image/png;base64,' + it.b64_json }; }
    if (it.url) { return { url: String(it.url) }; }
    if (it.b64) { return { url: 'data:image/png;base64,' + it.b64 }; }
    return { error: '生图响应里没有图片数据' };
  }
  function aiParseImageReply(j) {
    var r = aiPickImagePayload(j);
    return r.url ? r : { error: r.error };
  }
  function aiGenerateImage(op) {
    var prompt = String((op && op.prompt) || '');
    if (!prompt) { return Promise.resolve({ error: 'harmony: empty image prompt' }); }
    var ep = aiMediaEndpoint('image');
    if (!ep.base || !ep.key || !ep.model) {
      // 报「缺哪一项」而不是笼统一句：Key/端点多半已从 AI 模型里复用，缺的通常只是模型 id。
      var miss = [];
      if (!ep.base) { miss.push('端点'); }
      if (!ep.key) { miss.push('API Key'); }
      if (!ep.model) { miss.push('模型 id'); }
      return Promise.resolve({
        error: '生图未配置：缺 ' + miss.join(' / ')
          + '。可在 设置 - AI 模型（同一服务商）里配好，或在 设置 - 生图、媒体与搜索 里补齐生图模型。'
      });
    }
    var size = AI_IMAGE_SIZES[String((op && op.aspectRatio) || '1:1')] || '1024x1024';
    var body = JSON.stringify({ model: ep.model, prompt: prompt, n: 1, size: size });
    var url = ep.base + '/images/generations';
    var headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + ep.key };
    // 原生通道一发就行：生图本来就是"等整张图"，没有流式收益，还避开 CORS
    return goJson('aiPostJson', [url, JSON.stringify(headers), body]).then(function (r) {
      if (!r || r.status < 200 || r.status >= 300) {
        var hint = r && r.text ? String(r.text).slice(0, 200) : '';
        return { error: '生图失败：HTTP ' + (r ? r.status : '0') + (hint ? ' ' + hint : '') };
      }
      var j = null;
      try { j = JSON.parse(r.text); } catch (e) { j = null; }
      if (!j) { return { error: '生图响应不是 JSON' }; }
      return aiParseImageReply(j);
    }, function (e) {
      return { error: '生图失败：' + (e && e.message ? e.message : String(e)) };
    });
  }
  // 素材地址 → {base64, mime}：data URL 直接拆、http(s) 走 fetchImageJson、本地走 readLocalImageJson
  function aiMediaBytes(u) {
    var s = String(u || '');
    if (!s) { return Promise.resolve(null); }
    if (s.substring(0, 5) === 'data:') {
      var comma = s.indexOf(',');
      if (comma < 0) { return Promise.resolve(null); }
      var meta = s.substring(0, comma);
      var mime = 'image/png';
      var colon = meta.indexOf(':');
      var semi = meta.indexOf(';');
      if (colon >= 0 && semi > colon) { mime = meta.substring(colon + 1, semi); }
      return Promise.resolve({ base64: s.substring(comma + 1), mime: mime });
    }
    if (s.substring(0, 4) === 'http') {
      return goJson('fetchImageJson', [s]).then(function (r) {
        return (r && r.base64) ? { base64: r.base64, mime: r.mime || 'image/png' } : null;
      }, function () { return null; });
    }
    return goJson('readLocalImageJson', [s]).then(function (r) {
      return (r && r.base64) ? { base64: r.base64, mime: r.mediaType || 'image/png' } : null;
    }, function () { return null; });
  }
  function aiAnalyzeMedia(op) {
    var urls = (op && op.mediaUrls) || [];
    var ask = String((op && op.requirements) || '请描述这些素材的内容与结构。');
    if (!urls.length) { return Promise.resolve({ error: 'harmony: no media urls' }); }
    return Promise.all(urls.map(aiMediaBytes)).then(function (items) {
      var images = [];
      var videos = [];
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (!it) { continue; }
        if (it.mime && it.mime.substring(0, 5) === 'video') { videos.push(it); } else { images.push(it); }
      }
      if (!images.length && !videos.length) {
        return { error: '素材读取失败（不支持的地址或已被移动）' };
      }
      // 端点得等素材分完类再挑：有视频才走「视频解析」那条链（静态图走「图片解析」块）
      var target = aiMediaTarget(videos.length ? 'video' : 'analysis', !!videos.length);
      if (!target.base || !target.key || !target.model) {
        return { error: 'AI 未配置：在 设置 - AI 模型（或 生图、媒体与搜索）里补齐端点 / API Key / 模型 id 后再用媒体解析' };
      }
      if (videos.length && target.protocol === 'anthropic') {
        return { error: 'Anthropic 协议的 messages 端点不收视频，请改用支持视频的 OpenAI 兼容网关' };
      }
      // 素材直接拼进多模态消息（不复用 aiPush*：那两个是给聊天轮次用的，这里只有一轮）
      var body = { model: target.model, stream: false, messages: [] };
      if (target.protocol === 'anthropic') {
        var ablocks = [];
        if (ask) { ablocks.push({ type: 'text', text: ask }); }
        var all = images.concat(videos);
        for (var k = 0; k < all.length; k++) {
          if (all[k].mime && all[k].mime.substring(0, 5) === 'video') { continue; }
          ablocks.push({ type: 'image', source: { type: 'base64', media_type: all[k].mime, data: all[k].base64 } });
        }
        body.messages = [{ role: 'user', content: ablocks }];
        body.max_tokens = AI_DEFAULT_MAX_TOKENS;
      } else {
        var oblocks = [];
        if (ask) { oblocks.push({ type: 'text', text: ask }); }
        var all2 = images.concat(videos);
        for (var k2 = 0; k2 < all2.length; k2++) {
          var isVideo = all2[k2].mime && all2[k2].mime.substring(0, 5) === 'video';
          var du = 'data:' + all2[k2].mime + ';base64,' + all2[k2].base64;
          oblocks.push(isVideo
            ? { type: 'video_url', video_url: { url: du } }
            : { type: 'image_url', image_url: { url: du } });
        }
        body.messages = [{ role: 'user', content: oblocks }];
      }
      var headers = target.protocol === 'anthropic'
        ? { 'Content-Type': 'application/json', 'x-api-key': target.key, 'anthropic-version': AI_ANTHROPIC_VERSION }
        : { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + target.key };
      var url2 = target.protocol === 'anthropic' ? target.base + '/messages' : target.base + '/chat/completions';
      return goJson('aiPostJson', [url2, JSON.stringify(headers), JSON.stringify(body)]).then(function (r) {
        if (!r || r.status < 200 || r.status >= 300) {
          return { error: '图片理解失败：HTTP ' + (r ? r.status : '0') + (r && r.text ? ' ' + String(r.text).slice(0, 180) : '') };
        }
        var j = null;
        try { j = JSON.parse(r.text); } catch (e) { j = null; }
        if (!j) { return { error: '图片理解响应不是 JSON' }; }
        if (target.protocol === 'anthropic') {
          var blocks = j.content || [];
          var out = '';
          for (var b = 0; b < blocks.length; b++) {
            if (blocks[b] && blocks[b].type === 'text') { out += blocks[b].text || ''; }
          }
          return out ? { text: out } : { error: '模型没有返回文本' };
        }
        var ch = (j.choices && j.choices[0]) || {};
        var mc = ch.message || {};
        return mc.content ? { text: String(mc.content) } : { error: '模型没有返回文本' };
      }, function (e) {
        return { error: '图片理解失败：' + (e && e.message ? e.message : String(e)) };
      });
    });
  }
  // ===== sheets 保存请求归一化（保存 / 另存为 / 崩溃恢复副本三者共用）=====
  // 桌面这三件事走同一条 pipeline（sheets-main.ts 的 resolveTransferredEdits +
  // workbookSaveRequestSchema → writeWorkbookTo），差异只在"写到哪"：原文件 / 用户选框 /
  // userData 恢复目录。所以归一化抽成模块级函数，saveWorkbookEdits 只是薄包装，
  // writeWorkbookRecovery 复用同一份校验（避免两条路各写一遍白名单漂移）。
  // 返回 { error: string } 或 { payload: {...}, isSaveAs: boolean }。
  function buildSheetsSavePayload(request) {
    request = request || {};
    var isSaveAs = request.mode === 'save-as';
    // 新建空白表格：真实引擎会话但无 URI（未命名）。保存/另存为统一走另存为
    // 对话框（系统选位置后写盘），成功后渲染层换到带 URI 的新会话。
    var isBlankSession = !!(request.sessionId && BLANK_SESSION_IDS[request.sessionId]);
    if (isBlankSession) { isSaveAs = true; }
    // 值优先路线：除单元格值/样式外的一切编辑类型明确拒绝，不静默丢数据
    // （journal 保留、错误可见，后续逐类接入）。
    var blocked = ['filterStates','cfStates','dvStates',
      'pageSetupStates','noteStates','hyperlinkEdits','sparklineAdditions','formulaValues',
      'definedNamesState','themeState','workbookProtectionState','protectedRangeStates',
      'tableAdditions','pivotAdditions','chartEdits','visualEdits','visualAdditions',
      'bulkConstantFills'];
    for (var b = 0; b < blocked.length; b++) {
      var v = request[blocked[b]];
      if (v == null) { continue; }
      if (typeof v === 'object') {
        if (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0) {
          return { error: '该编辑类型待支持（值优先）：' + blocked[b] };
        }
      } else if (v) {
        return { error: '该编辑类型待支持（值优先）：' + blocked[b] };
      }
    }
    if (request.editsTransferId) {
      // 大编辑集已分块上传：从 store 取出拼好的编辑数组继续归一化
      try {
        request.edits = takeEditTransfer(request.editsTransferId, request.sessionId);
      } catch (e) {
        return { error: (e && e.message) ? String(e.message) : '保存分块无效' };
      }
    }
    // M5.2b 样式白名单：workbookStyleEditSchema 的键集。越界键 → 明确拒绝，
    // 防止脏键被引擎侧（deny_unknown_fields）二次拒绝或污染 styles.xml。
    var STYLE_KEYS = ['bold','italic','underline','underlineStyle','strikethrough',
      'fontFamily','fontSize','fontColor','fillColor','horizontalAlignment',
      'verticalAlignment','wrapText','textRotation','indent','protectionLocked',
      'protectionHidden','numberFormat','borderTop','borderBottom','borderLeft','borderRight'];
    var cells = [];
    for (var i = 0; i < (request.edits || []).length; i++) {
      var e = request.edits[i];
      if (!e) {
        return { error: '存在无效编辑记录' };
      }
      // 白名单校验：style 对象里只能有 schema 键
      var style = null;
      if (e.style && typeof e.style === 'object') {
        var styleKeys = Object.keys(e.style);
        if (styleKeys.length > 0) {
          for (var sk = 0; sk < styleKeys.length; sk++) {
            if (STYLE_KEYS.indexOf(styleKeys[sk]) < 0) {
              return { error: '样式键不支持：' + styleKeys[sk] };
            }
          }
          style = e.style;
        }
      }
      if (e.rich && e.rich.length > 0) {
        // 富文本：引擎 kind="rich" 写 inlineStr 多 run（rPr 样式逐 run 保留）
        var cellRich = { sheetId: e.sheetId, row: e.row, column: e.column, kind: 'rich' };
        cellRich.rich = e.rich.map(function (r) {
          return {
            text: String(r && r.text != null ? r.text : ''),
            bold: !!(r && r.bold), italic: !!(r && r.italic),
            underline: !!(r && r.underline), strikethrough: !!(r && r.strikethrough),
            ...(r && r.color ? { color: r.color } : {}),
            ...(r && r.size != null ? { size: r.size } : {}),
            ...(r && r.family ? { family: r.family } : {}),
            ...(r && r.vertAlign ? { vertAlign: r.vertAlign } : {}),
          };
        });
        if (style) { cellRich.style = style; }
        cells.push(cellRich);
        continue;
      }
      // 布尔值：引擎新增 "boolean" kind（<c t="b">），TRUE/true/1 → 1
      if (typeof e.value === 'boolean') {
        var cellBool = { sheetId: e.sheetId, row: e.row, column: e.column, kind: 'boolean' };
        cellBool.value = e.value ? 'TRUE' : 'FALSE';
        if (style) { cellBool.style = style; }
        cells.push(cellBool);
        continue;
      }
      var cell = { sheetId: e.sheetId, row: e.row, column: e.column };
      if (e.writeValue === false) {
        // 纯样式编辑：需要 style delta 或 styleReset，否则无内容可保存
        if (!style && e.styleReset !== true) {
          return { error: '无效编辑记录（无值且无样式）' };
        }
        cell.kind = 'style';
      } else if (e.formula) {
        cell.kind = 'formula';
        cell.formula = e.formula;
        if (e.value !== null && e.value !== undefined) { cell.value = String(e.value); }
      } else if (e.value === null) {
        cell.kind = 'clear';
      } else if (typeof e.value === 'number') {
        cell.kind = 'number';
        cell.value = String(e.value);
      } else {
        cell.kind = 'string';
        cell.value = String(e.value);
      }
      if (style) { cell.style = style; }
      if (e.styleReset === true) { cell.styleReset = true; }
      cells.push(cell);
    }
    if (cells.length === 0) {
      // 纯结构性操作（插入/删除行列、合并/取消合并）与多 sheet 操作（增删/
      // 改名/隐藏/排序）也允许：不要求单元格编辑。
      if ((request.structuralOps || []).length === 0 &&
          (request.sheetOps || []).length === 0) {
        return { error: '没有可保存的编辑' };
      }
    }
    // M6.2 结构性操作：仅放行引擎支持的 6 种 kind，其余继续拒绝（不静默丢数据）。
    // op 形状 = renderer structuralOp：{ sheetId, kind, index, count } 或
    // { sheetId, kind, range: {startRow,endRow,startColumn,endColumn} }（引擎同构）。
    var STRUCTURAL_OK = ['insert-rows','remove-rows','insert-cols','remove-cols',
      'merge-cells','unmerge-cells'];
    var structuralOps = [];
    for (var so = 0; so < (request.structuralOps || []).length; so++) {
      var op = request.structuralOps[so];
      if (!op || typeof op !== 'object') {
        return { error: '存在无效结构性操作记录' };
      }
      if (STRUCTURAL_OK.indexOf(op.kind) < 0) {
        return { error: '该结构性操作待支持：' + op.kind };
      }
      if (op.kind === 'merge-cells' || op.kind === 'unmerge-cells') {
        var r = op.range;
        if (!r || typeof r !== 'object') {
          return { error: '合并/取消合并缺少 range' };
        }
        if (!(Number.isInteger(r.startRow) && Number.isInteger(r.endRow) &&
              Number.isInteger(r.startColumn) && Number.isInteger(r.endColumn))) {
          return { error: '结构性操作 range 无效' };
        }
        structuralOps.push({
          sheetId: op.sheetId,
          kind: op.kind,
          index: 0,
          count: 0,
          range: { startRow: r.startRow, endRow: r.endRow, startColumn: r.startColumn, endColumn: r.endColumn }
        });
      } else {
        if (!(Number.isInteger(op.index) && Number.isInteger(op.count)) ||
            op.index < 0 || op.count < 1) {
          return { error: '结构性操作 index/count 无效' };
        }
        structuralOps.push({
          sheetId: op.sheetId,
          kind: op.kind,
          index: op.index,
          count: op.count
        });
      }
    }
    // M11 多 sheet 操作：放行引擎支持的 6 种 kind（增删/改名/隐藏/排序）。
    // op 形状 = renderer sheetOp：{ kind, sheetId, name?, newName?, sourceSheetId?, hidden? }；
    // sheetOrder = renderer 的 tab 全序（已存在 sheet 用引擎 id，新增 sheet 用临时 id）。
    var SHEET_OPS_OK = ['add-sheet','duplicate-sheet','remove-sheet','rename-sheet',
      'set-sheet-hidden','reorder-sheets'];
    var sheetOps = [];
    for (var so2 = 0; so2 < (request.sheetOps || []).length; so2++) {
      var sop = request.sheetOps[so2];
      if (!sop || typeof sop !== 'object') {
        return { error: '存在无效 sheet 操作记录' };
      }
      if (SHEET_OPS_OK.indexOf(sop.kind) < 0) {
        return { error: '该 sheet 操作待支持：' + sop.kind };
      }
      if (sop.kind === 'reorder-sheets') {
        // 顺序由顶层 sheetOrder 整体表达，无需 per-op 字段。
        sheetOps.push({ kind: 'reorder-sheets' });
        continue;
      }
      if (typeof sop.sheetId !== 'string' || sop.sheetId.length === 0) {
        return { error: 'sheet 操作缺少 sheetId' };
      }
      if (sop.kind === 'add-sheet') {
        if (typeof sop.name !== 'string' || sop.name.length === 0) {
          return { error: '新建 sheet 缺少名字' };
        }
        sheetOps.push({ kind: 'add-sheet', sheetId: sop.sheetId, name: sop.name });
      } else if (sop.kind === 'duplicate-sheet') {
        if (typeof sop.name !== 'string' || sop.name.length === 0 ||
            typeof sop.sourceSheetId !== 'string' || sop.sourceSheetId.length === 0) {
          return { error: '复制 sheet 缺少名字或源' };
        }
        sheetOps.push({ kind: 'duplicate-sheet', sheetId: sop.sheetId, name: sop.name,
          sourceSheetId: sop.sourceSheetId });
      } else if (sop.kind === 'remove-sheet') {
        sheetOps.push({ kind: 'remove-sheet', sheetId: sop.sheetId });
      } else if (sop.kind === 'rename-sheet') {
        if (typeof sop.newName !== 'string' || sop.newName.length === 0) {
          return { error: '改名缺少新名字' };
        }
        sheetOps.push({ kind: 'rename-sheet', sheetId: sop.sheetId, newName: sop.newName });
      } else if (sop.kind === 'set-sheet-hidden') {
        if (typeof sop.hidden !== 'boolean') {
          return { error: '隐藏状态无效' };
        }
        sheetOps.push({ kind: 'set-sheet-hidden', sheetId: sop.sheetId, hidden: sop.hidden });
      }
    }
    var sheetOrder = [];
    for (var so3 = 0; so3 < (request.sheetOrder || []).length; so3++) {
      var orderId = request.sheetOrder[so3];
      if (typeof orderId === 'string' && orderId.length > 0) { sheetOrder.push(orderId); }
    }
    var payload = { sessionId: request.sessionId, normalizedEdits: cells };
    if (structuralOps.length > 0) { payload.structuralOps = structuralOps; }
    if (sheetOps.length > 0) { payload.sheetOps = sheetOps; }
    if (sheetOps.length > 0 && sheetOrder.length > 0) { payload.sheetOrder = sheetOrder; }
    return { payload: payload, isSaveAs: isSaveAs };
  }

  // ===== sheets 打开（含崩溃恢复提问）=====
  // 打开结果归一化：桥内部失败 → reject（渲染层状态栏显示真实原因，不假扮"用户取消"）；
  // null = 用户取消选择器；其余（WorkbookFile）原样返回。
  function normalizeXlsOpen(r) {
    if (r && r.ok === false) {
      var reason = (r && r.error) ? String(r.error) : '打开工作簿失败';
      console.error('[GenOffice] xlsOpen failed: ' + reason);
      return Promise.reject(new Error(reason));
    }
    if (!r) { console.warn('[GenOffice] xlsOpen returned null'); }
    return r || null;
  }
  /**
   * 打开工作簿（p 为空 = 弹系统选择器）。M7-4：桥先查"比原文件新的恢复副本"，命中时
   * 返回 {ok:false,needsRecovery:true,path,prompt} → 这里把提问交给渲染层对话框，等回答
   * 后再让桥真正打开（xlsRecoveryResolveJson：restore 用副本 / discard 删副本用原文件 /
   * dismissed 保留副本用原文件）。其余返回值语义与打开前完全一致。
   */
  function openSheetWithRecovery(p) {
    return goJson('xlsOpenJson', [p]).then(function (r) {
      if (r && r.ok === false && r.needsRecovery === true) {
        return askRecoveryPrompt(r.prompt).then(function (choice) {
          var target = (typeof r.path === 'string' && r.path.length > 0) ? r.path : p;
          return goJson('xlsRecoveryResolveJson', [String(target || ''), String(choice)])
            .then(normalizeXlsOpen);
        });
      }
      return normalizeXlsOpen(r);
    });
  }

  var mock = {
    // === 基础状态 ===
    getLanguage: function () { return Promise.resolve('zh'); },
    getTheme: function () { return Promise.resolve('light'); },
    onLanguageChanged: function () { return NOOP; },
    onThemeChanged: function () { return NOOP; },
    onChromePressed: function () { return NOOP; },

    // === 文档打开/保存（M3：xxxJson 通道接 ArkTS 真实实现，未注入时优雅降级） ===
    openDocx: function () {
      // docs 菜单「打开…」与 Electron 一致：只列 docx/doc（起始页磁贴走 browse 不经过这里）
      return goJson('openDocxJson', [JSON.stringify(DOCX_SUFFIXES)]).then(openResultFrom);
    },
    openDocxPath: function (p) {
      return goJson('openDocxPathJson', [p]).then(openResultFrom);
    },
    openDocxDecrypt: function () { return Promise.resolve(null); },
    setDocPassword: function () { return Promise.resolve(); },
    docPasswordIntentRevision: function () { return Promise.resolve(0); },
    discardDocPasswordIntents: function () { return Promise.resolve(); },
    consumePendingOpenDocx: function () { return Promise.resolve(null); },
    consumeNewBlankDoc: function () { return Promise.resolve(null); },
    consumeAiDocContent: function () { return Promise.resolve(null); },
    // 新建空白文档（pdf:create-document / docs createDocument）：ArkTS createDocumentJson
    // 落盘空白 PDF 返回 path；失败/取消返回 null（渲染层保持 empty 态）。
    createDocument: function (op) {
      return goJson('createDocumentJson', [
        op && op.type || '', op && op.title || '', op && op.content || '',
      ]).then(function (r) { return r || null; });
    },
    onOpenDocx: function (handler) {
      // 鸿蒙 Tab 宿主：shell 的 browse() 把选中的文件路径暂存到同源 localStorage，
      // docs iframe 启动时订阅本事件——立即投递 pending 文件（经 openDocxPath 读字节），
      // 与桌面版主进程 open-result 事件语义对齐。消费后即删除，重复订阅不会重复投递。
      if (typeof handler === 'function') {
        try {
          var pendingPath = localStorage.getItem('genoffice.pendingOpenPath');
          if (pendingPath && pendingPath.length > 0) {
            localStorage.removeItem('genoffice.pendingOpenPath');
            setTimeout(function () {
              if (window.desktop && typeof window.desktop.openDocxPath === 'function') {
                window.desktop.openDocxPath(pendingPath).then(function (result) {
                  try { handler(result); } catch (e) { /* 渲染层自行处理 */ }
                });
              }
            }, 100);
          }
        } catch (e) { /* localStorage 不可用时静默 */ }
      }
      return NOOP;
    },
    onRenamedDocx: function () { return NOOP; },
    saveDocx: function (path, data, auto) {
      return goJson('saveDocxJson', [path, bufToB64(data)]).then(function (r) {
        return r || { ok: false, error: 'file bridge unavailable' };
      });
    },
    writeRecoveryCopy: function () { return Promise.resolve(); },
    onTeardown: function () { return NOOP; },
    saveDocxAs: function (defaultName, data, sourcePath) {
      return goJson('saveAsDocxJson', [defaultName, bufToB64(data), sourcePath || '']).then(function (r) {
        return r || { ok: false };
      });
    },
    saveDocxNew: function (defaultName, data) {
      console.info('[GenOffice] saveDocxNew called, defaultName=' + defaultName + ' dataLen=' + (data ? (data.byteLength || data.length || '?') : '0'));
      var b64 = bufToB64(data);
      console.info('[GenOffice] saveDocxNew b64 len=' + (b64 ? b64.length : '0'));
      return goJson('saveNewDocxJson', [defaultName, b64]).then(function (r) {
        console.info('[GenOffice] saveDocxNew goJson result=' + JSON.stringify(r));
        return r || { ok: false, error: 'file bridge unavailable' };
      });
    },
    // 通用保存（M4.1：markdown/slides 共用，走 ArkTS saveAsAnyJson/saveAnyJson）
    // 覆盖保存（path 已授权）或弹系统保存选择器；取消/失败按返回对象处理，绝不给 undefined
    saveAny: function (path, data) {
      return goJson('saveAnyJson', [path, bufToB64(data)]).then(function (r) {
        return r || { ok: false, error: 'file bridge unavailable' };
      });
    },
    saveAsAny: function (name, data) {
      return goJson('saveAsAnyJson', [name, bufToB64(data)]).then(function (r) {
        return r || { ok: false, error: 'file bridge unavailable' };
      });
    },
    // 文本 readFile（markdown 语义）；pdfApi 用 Object.assign 覆盖为 ArrayBuffer 版本
    readFile: function (p) {
      return goJson('openDocxPathJson', [p]).then(function (r) {
        if (!r || !r.ok) {
          return null;
        }
        try { return new TextDecoder().decode(b64ToBuf(r.b64)); } catch (e) { return null; }
      });
    },
    // 起始页 / 子 app 空态 "打开本地文件" 共享通道：返回 ArkTS 选文件的 JSON 字符串，
    // 与 Electron desktop.openFileJson 语义一致（{ok,path,ext,name} 或空）。
    // iframe 里经顶层 __goNativeCall 转发（gin 桥方法不能跨 frame 调用）。
    // 没有可用桥时返回空字符串 = "未选择文件"。
    openFileJson: function (suffixes) {
      var call = findNativeCaller();
      if (!call) { return Promise.resolve(''); }
      // suffixes（后缀数组，如 ['.pdf']）：app 内「打开」只列本 app 类型；缺省/空 = 不限类型
      var args = [];
      try { if (Array.isArray(suffixes) && suffixes.length > 0) { args = [JSON.stringify(suffixes)]; } }
      catch (e) { args = []; }
      try { return Promise.resolve(call('openFileJson', args) || ''); }
      catch (e) { return Promise.resolve(''); }
    },
    // 待打开文件（markdown/pdf 语义）：shell browse() 把选中文件路径写入同源
    // localStorage，app iframe 启动时消费一次即删（docs 走 onOpenDocx 投递，
    // slides 无解析器返回 null）。
    consumePending: function () {
      try {
        var p = localStorage.getItem('genoffice.pendingOpenPath');
        if (p && p.length > 0) {
          localStorage.removeItem('genoffice.pendingOpenPath');
          return Promise.resolve(p);
        }
      } catch (e) { /* 忽略 */ }
      return Promise.resolve(null);
    },
    getRecentFiles: function () { return recentFilesImpl(); },
    // 未保存守卫（一）：push 通道 —— markdown/pdf/slides 的渲染层 setDirty(dirty) 推状态，
    // 记录到本 frame window；关闭 tab 时壳读 frames[id].contentWindow.__goFrameDirty。
    setDirty: function (d) {
      try { window.__goFrameDirty = !!(d); } catch (e) { /* 忽略 */ }
      dirtyTrace(!!d, 'push');
      pushDirtyToHost(!!d);
    },

    // === 资源/图片/打印/导出 ===
    // Electron docs:pick-image → {base64, mime, name}；ArkTS 桥 pickImageJson 返回 JSON 字符串
    // （goJson 沿 parent 链找真实桥；未注入时返回 null = 等价"取消"）
    pickImage: function () { return goJson('pickImageJson', []); },
    fontMetrics: function () { return Promise.resolve({ ascent: 0, descent: 0, unitsPerEm: 1000 }); },
    print: function () { return Promise.resolve(); },
    // docs(Word)/markdown 的「导出 PDF」：桌面由主进程 printToPDF(html, w, h, outPath, scale)
    // 落盘，契约（apps/docs/src/renderer/file-actions.ts:1318/1382）:
    //   {ok:true,path} / {ok:false}（用户取消）/ {ok:false,error}（→ 状态栏 appExportPdfFailed，可见）
    // 壳内无 HTML→PDF 引擎 → 返回带原因的错误对象，用户看到「暂不支持 + 原因」而不是静默。
    // 注意 sheets(Excel) 用的 desktopApi.exportPdf 契约不同（只认 {canceled,path}），
    // 由 sheetsMock 覆写为 reject（见 desktopApi 注册处），throw 才能走到它的可见 catch。
    exportPdf: function () {
      return Promise.resolve({ ok: false, error: HTML2PDF_UNAVAILABLE });
    },
    printPdfBuffer: function () { return Promise.resolve(new ArrayBuffer(0)); },
    saveMergedPdf: function () { return Promise.resolve(null); },
    // sheets 文件→打印：桌面把 activeSheetPrintPayload 的排版 HTML 交给隐藏窗口走
    // Chromium 打印对话框（{ok:true} / {ok:false}（用户取消）/ {ok:false,error}）。
    // 壳侧缺本方法时 Proxy 兜底 resolve(undefined) → 渲染层 result.ok 当场 TypeError
    //（被 catch 成一句英文 NotImplemented 提示，用户报的「Excel 打印无反应」即此）。
    printWorkbook: function (req) {
      var html = (req && typeof req.html === 'string') ? req.html : '';
      if (html.length === 0) {
        return Promise.resolve({ ok: false, error: '打印内容为空（工作表尚未完成排版）' });
      }
      return printHtmlViaFrame(html);
    },
    // docs 文件→导出 HTML：桌面由主进程弹保存框写盘，返回 {ok,path} / {ok:false}（取消）
    // / {ok:false,error}。壳侧复用 saveAsAnyJson（弹系统保存框 + 登记授权 URI 并写字节）；
    // 带 outPath 时（headless/预览重试路径）走 saveAnyJson 覆盖写已授权 URI。
    exportHtml: function (fileName, html, outPath) {
      var name = String(fileName || 'Untitled').replace(/.[^.]*$/, '') + '.html';
      var b64 = bufToB64(new TextEncoder().encode(String(html || '')));
      if (typeof outPath === 'string' && outPath.length > 0) {
        return goJson('saveAnyJson', [outPath, b64]).then(function (r) {
          r = r || { ok: false, error: 'file bridge unavailable' };
          if (r.ok) { return { ok: true, path: r.path || outPath }; }
          return { ok: false, error: String(r.error || 'write failed') };
        });
      }
      return goJson('saveAsAnyJson', [name, b64]).then(function (r) {
        r = r || { ok: false, error: 'file bridge unavailable' };
        if (r.ok && !r.canceled && r.path) { return { ok: true, path: r.path }; }
        if (r.ok) { return { ok: false }; }   // 用户取消 → 渲染层显示「已取消」
        return { ok: false, error: String(r.error || 'write failed') };
      });
    },
    // headless 导出通道（docs/markdown 的 App.tsx 启动即消费）：桌面 --headless-export
    // 由隐藏窗口 + CLI 指定的 outPath 驱动，壳内不存在该模式 → 恒 null，渲染层
    // if (!target) return 直接结束（等价「无 headless 任务」，不报错）。
    consumeHeadlessExport: function () { return Promise.resolve(null); },
    // docs 文件→导出图片：桌面链路 = pickExportImagesTarget（选目录 + 该目录下临时 PDF 路径）
    // → exportPdf 产出 PDF → takeExportPdf 取 PDF 字节 → pdf.js 逐页光栅 → writeExportImage 写 PNG。
    // 首环就依赖 HTML→PDF，壳内无法真实实现。旧状是 Proxy 兜底 undefined → exportImages 在
    // if (!target) return false 处【静默】结束（用户反馈「导出图片点了没反应」）。
    // 这里给一个非空目标，让流程走到【可见】的失败分支（状态栏 appExportPdfFailed + 上面那句原因），
    // 后两步也按各自 {ok:false,error} 契约返回原因（将来若接上 HTML→PDF，只需换掉 exportPdf/takeExportPdf）。
    pickExportImagesTarget: function () { return Promise.resolve({ dir: '', pdfPath: '' }); },
    takeExportPdf: function () {
      return Promise.resolve({ ok: false, error: HTML2PDF_UNAVAILABLE });
    },
    writeExportImage: function () {
      return Promise.resolve({ ok: false, error: HTML2PDF_UNAVAILABLE });
    },

    // === AI（本地可移植子集 + 显式降级；ArkTS 语义见 DesktopBridge.ets 的 M7-3 段） ===
    // AI 通道过去只挂在 pdfMock 上（其余 app 的 aiStream 是这个空实现 → AI 面板点了没反应），
    // 现在提到 base：所有 app 的 mock 都 Object.assign({}, mock) 继承同一份实现。
    getAiSettings: function () { return Promise.resolve(loadAiSettings()); },
    setAiSettings: function (s) { saveAiSettings(s && s.providers ? normalizeAiSettings(s) : s); return Promise.resolve(); },
    aiChat: function () { return Promise.resolve({}); },
    aiStream: function (req) { return aiStreamRun(req); },
    aiStreamCancel: function (requestId) { return aiStreamCancel(requestId); },
    // 壳内无拼写诊断收集器 / 无 headless 导出主进程：给 resolve() 而不是留白，
    // 调用点多为 fire-and-forget，但契约上仍必须是 Promise。
    spellDiag: function () { return Promise.resolve(); },
    // Zotero 联动与 MCP 落盘口都依赖桌面主进程/外部应用；契约要求返回**对象**，
    // 给 undefined 会让调用点读 result.ok 崩（同一批扫描抓出来的两条）。
    zoteroCommand: function () {
      return Promise.resolve({ ok: false, error: '鸿蒙版未接入 Zotero 文献插件联动' });
    },
    saveDocxTo: function () {
      return Promise.resolve({ ok: false, error: '鸿蒙版请用「保存 / 另存为…」写盘（无 MCP 落盘口）' });
    },
    headlessExportDone: function () { return Promise.resolve(); },
    // Genspark 账号通道已整体移除（LLM 代理按 GenOffice 记账，fork 无权用；鸿蒙也没有
    // device-code 登录）。aiGskStatus/aiGskLogin reject 让渲染层走「无 Genspark」分支，
    // 不留假入口（resolve({loggedIn:false}) 会让 UI 显示「登录 Genspark」按钮 → 点击无效）。
    aiGskStatus: function () { return Promise.reject(new Error('鸿蒙版没有 Genspark 账号通道')); },
    aiGskLogin: function () { return Promise.reject(new Error('鸿蒙版没有 Genspark 账号通道')); },
    // AI 面板偏好（docs/sheets/pdf/markdown 共用；base mock 一次实现 + Proxy 继承）：
    // get 供渲染层启动时应用、set 持久化并广播、on* 供订阅。桌面契约见
    // apps/*/src/shared/*ipc.ts 的 setAiPanelPrefs(patch) => Promise<AiPanelPrefs>。
    getAiPanelPrefs: function () { return Promise.resolve(loadAiPanelPrefs()); },
    setAiPanelPrefs: function (patch) {
      var next = mergeAiPanelPrefs(patch);
      saveAiPanelPrefs(next);
      broadcastAiPanelPrefs(next);
      return Promise.resolve(next);
    },
    onAiPanelPrefsChanged: function (fn) { return registerFrameFn(frameAiPrefsFns, fn); },
    // 网搜/图搜：ArkTS 原生侧发 HTTP（绕 WebView 的 CORS 与 origin null），提供方是用户自填
    // Key 的 Serper / Tavily 正式 API（过去的 DuckDuckGo 抓取属非官方接口，商用不稳）。
    // Key 存在同一份 localStorage 设置里，原生读不到 → 每次调用把 {provider, apiKey} 带下去。
    // 渲染层消费 {results|images, method} —— 未配置/异常必须给 method:'error'（错误分支会提示
    // "可重试"，而空数组形状会被 r.results.forEach 当场 TypeError）。
    webSearch: function (query, maxResults) {
      return goJson('webSearchJson', [String(query || ''), Number(maxResults) || 6, aiSearchOptsJson()]).then(function (r) {
        if (r && r.results) { return r; }
        return { results: [], method: 'error', error: 'harmony: web search bridge unavailable' };
      });
    },
    imageSearch: function (query, maxResults) {
      return goJson('imageSearchJson', [String(query || ''), Number(maxResults) || 8, aiSearchOptsJson()]).then(function (r) {
        if (r && r.images) { return r; }
        return { images: [], method: 'error', error: 'harmony: image search bridge unavailable' };
      });
    },
    // 网图下载：{base64, mime} | null（渲染层再按魔术字节自行嗅探一次）
    fetchImage: function (url) { return goJson('fetchImageJson', [String(url || '')]); },
    // 本地图片（sheets 的 add_image 本地路径分支）：桌面失败是 reject，这里把 {error} 转成 reject
    readLocalImage: function (req) {
      var p = (req && req.path) ? String(req.path) : '';
      return goJson('readLocalImageJson', [p]).then(function (r) {
        if (r && r.mediaType && r.base64) { return r; }
        return Promise.reject(new Error((r && r.error) ? String(r.error) : 'harmony: cannot read the image'));
      });
    },
    // 生图 / 媒体理解：批次 E 起为自建通道（用户自备 Key），不再是降级桩
    generateImage: aiGenerateImage,
    aiGenerateImage: aiGenerateImage,
    analyzeMedia: aiAnalyzeMedia,

    // === 附件/文件 ===
    pickAttachments: function () { return Promise.resolve([]); },
    addAttachmentPaths: function () { return Promise.resolve(); },
    addPastedImage: function () { return Promise.resolve(null); },
    copyImageToClipboard: function () { return Promise.resolve(); },
    readAttachment: function () { return Promise.resolve({ text: '', done: true }); },
    readAttachmentImage: function () { return Promise.resolve(null); },
    getPathForFile: function () { return Promise.resolve(''); },

    // === 多 Tab ===
    openNewTab: function () { return Promise.resolve(null); },
    listDocsTabs: function () { return Promise.resolve([]); },
    focusDocsTab: function () { return Promise.resolve(); },

    // === 事件订阅/上报 ===
    onAiStream: function (fn) { return aiOnStream(fn); },
    // 壳 chrome 菜单命令（docs 'save-as' / slides 'save-as'|'print' …）：真实登记到本 frame，
    // 由壳菜单经 postMessage({__goMenuCommand}) 派发（见本文件「壳 chrome 菜单」段）。
    onMenuCommand: function (fn) { return registerFrameFn(frameMenuCommandFns, fn); },
    // 壳 chrome 菜单「另存为…/打印…」通道：PDF 走这两个（saveAsTo(targetPath) / printDoc()），
    // markdown 走 onPrintRequest。base 实现即权威实现——各 app mock 不得再覆盖（见 pdfMock 注释）。
    onSaveAsRequest: function (fn) { return registerFrameFn(frameSaveAsFns, fn); },
    onPrintRequest: function (fn) { return registerFrameFn(framePrintFns, fn); },
    // 壳菜单「导出为 Word…」通道（markdown 专用，但按惯例放 base：各 app mock 不得覆盖）。
    // 渲染层 App.tsx 用 onExportRequest(format) 登记 runExport —— 缺本方法时 Proxy 返回 NOOP，
    // 登记被吞掉 → 壳菜单即使发了 __goExportRequest 也没有落点（导出为 Word 点了没反应）。
    onExportRequest: function (fn) { return registerFrameFn(frameExportFns, fn); },
    // 壳菜单「保存 / 另存为…」通道（markdown）：桌面由原生菜单发 saveRequest(mode)，
    // 渲染层存完回 sendSaveRequestAck(bool)。mode 字面量对齐桌面 shell（'save' / 'saveAs'，
    // 见 apps/shell/src/main/index.ts 的 requestMarkdownSave 调用）与 markdownMock.save 的判定。
    onSaveRequest: function (fn) { return registerFrameFn(frameSaveRequestFns, fn); },
    // 保存回执：壳内没有等待方（桌面用它 resolve 菜单动作的 promise），记到本 frame 上
    // 供壳侧/门禁读取（与关标签守卫的 __goFrameDirty 同一套做法），失败时给可见提示。
    sendSaveRequestAck: function (ok) {
      try { window.__goLastSaveAck = (ok === true); } catch (e) { /* 忽略 */ }
      if (ok !== true) { showFrameNotice('保存未完成', '渲染层回报保存失败（未写出文件）。'); }
      return Promise.resolve();
    },
    // 图片查看器「另存为图片」（docs / markdown 两侧同名）：桌面 saveImageFromUrl 支持
    // data: / file: / http(s):；壳内按形态分流（data: / md-asset: / http(s): / URI / 相对路径），
    // 拿不到字节时弹可见提示 —— 渲染层是 void 调用，不看返回值，静默失败等于「点了没反应」。
    saveImageAs: function (src) { return saveImageFromSrc(src, markdownDocPath); },
    // 未保存守卫（二）：docs 的查询式协议 —— 渲染层把 closeCheck 回调登记到本 frame，
    // 壳关 tab 前同步调它，渲染层立即 reportCloseCheck({dirty,...}) 回填本 frame 状态。
    onCloseCheck: function (handler) {
      if (typeof handler === 'function') {
        try { window.__goCloseCheckHandler = handler; } catch (e) { /* 忽略 */ }
      }
      console.info('[GenOffice] closeCheck registered=' + (typeof handler === 'function'));
      return NOOP;
    },
    reportViewMenuState: NOOP,
    reportCloseCheck: function (state) {
      try { window.__goCloseCheck = state || null; } catch (e) { /* 忽略 */ }
      dirtyTrace(!!(state && state.dirty), 'query');
      pushDirtyToHost(!!(state && state.dirty));
    },
    // 未保存守卫（三）：「保存并关闭」—— docs/sheets/slides/markdown/pdf 的渲染层都实现了
    // onCloseSaveRequest 协议（完整保存流程 + 结果回写），壳优先走它而不是裸调 save()。
    onCloseSaveRequest: function (handler) {
      if (typeof handler === 'function') {
        try { window.__goCloseSaveHandler = handler; } catch (e) { /* 忽略 */ }
      }
      console.info('[GenOffice] closeSave registered=' + (typeof handler === 'function'));
      return NOOP;
    },
    reportCloseSaveResult: function (ok) {
      try { window.__goCloseSaveResult = !!ok; } catch (e) { /* 忽略 */ }
      console.info('[GenOffice] closeSave result=' + !!ok);
    },
    // markdown/pdf 的结果通道名（docs/sheets/slides 用 reportCloseSaveResult）
    sendCloseSaveResult: function (ok) {
      try { window.__goCloseSaveResult = !!ok; } catch (e) { /* 忽略 */ }
      console.info('[GenOffice] closeSave result=' + !!ok);
    },
    // sheets：pending-edit 徽标数就是未保存状态（Electron main 用它做关闭守卫）
    notifyPendingEdits: function (count) {
      var v = Number(count) > 0;
      try { window.__goFrameDirty = v; } catch (e) { /* 忽略 */ }
      dirtyTrace(v, 'pending=' + Number(count));
      pushDirtyToHost(v);
    },

    // === sheets（M4.5：xlsx 进程内 napi sidecar 接线） ===
    // 与 Electron sheets-main.ts 的 IPC 语义对齐：selectWorkbook 弹系统选择器（或消费
    // shell 暂存的 pendingOpenPath），返回完整 WorkbookFile；渲染层随后以 sessionId
    // 流式 readWorkbookRange 拉单元格。全部走 xlsXxxJson → bridgeCall → DesktopBridge
    // → xlsxSidecar（import 'libxlsx_sidecar.so'）。
    sheetsSheetExt: /.(xlsx|xlsm|xls|csv)$/i,
    // 「新建空白表格」：生成真实空 xlsx 快照并开引擎会话（create_blank），与打开文件
    // 同链路——读取由引擎返回空网格，保存/另存为走真实 save_cells。
    selectWorkbook: function () {
      // 优先消费 shell browse() 暂存的路径（同源 localStorage，docs 用 onOpenDocx 消费，
      // sheets 这里等价消费）；没有则弹系统选择器（<path 传 ''>）。
      var p = '';
      try {
        // 新建空白投递优先（独立 key，避免误消费 browse 的文件路径）
        if (localStorage.getItem('genoffice.pendingBlankSheet')) {
          localStorage.removeItem('genoffice.pendingBlankSheet');
          return goJson('xlsOpenBlankJson', []).then(function (r) {
            if (r && r.ok === false) {
              var reason = (r && r.error) ? String(r.error) : '新建空白表格失败';
              console.error('[GenOffice] xlsOpenBlank failed: ' + reason);
              return Promise.reject(new Error(reason));
            }
            if (!r) { return null; }
            if (r.sessionId) { BLANK_SESSION_IDS[r.sessionId] = true; }
            return r;
          });
        }
        var pendingPath = localStorage.getItem('genoffice.pendingOpenPath');
        if (pendingPath && mock.sheetsSheetExt.test(pendingPath)) {
          p = pendingPath;
          localStorage.removeItem('genoffice.pendingOpenPath');
        }
      } catch (e) { /* localStorage 不可用时弹选择器 */ }
      return openSheetWithRecovery(p);
    },
    hasQueuedWorkbook: function () {
      try {
        var pendingPath = localStorage.getItem('genoffice.pendingOpenPath');
        var blank = localStorage.getItem('genoffice.pendingBlankSheet');
        return Promise.resolve(!!(blank || (pendingPath && mock.sheetsSheetExt.test(pendingPath))));
      } catch (e) { return Promise.resolve(false); }
    },
    // M6-Excel：多选 xlsx 合并源（selectWorkbooksForMerge / openWorkbooksForMerge）。
    // 与桌面 IPC 一致：弹系统选择器（multiSelect）或消费显式 paths，桥返回 WorkbookFile[]
    // （shell 不会注册持久授权 —— 合并源是只读副本，保存链路不期望命中合并源会话的 URI）。
    selectWorkbooksForMerge: function () {
      return goJson('xlsOpenMergeJson', [JSON.stringify([])]).then(function (r) {
        if (r && r.ok === false) {
          var reason = (r && r.error) ? String(r.error) : '选择合并源失败';
          console.error('[GenOffice] xlsOpenMerge (picker) failed: ' + reason);
          return Promise.reject(new Error(reason));
        }
        if (r == null) { return null; }
        return r;
      });
    },
    openWorkbooksForMerge: function (paths) {
      var list = Array.isArray(paths) ? paths : [];
      return goJson('xlsOpenMergeJson', [JSON.stringify(list)]).then(function (r) {
        if (r && r.ok === false) {
          var reason = (r && r.error) ? String(r.error) : '打开合并源失败';
          console.error('[GenOffice] xlsOpenMerge (paths) failed: ' + reason);
          return Promise.reject(new Error(reason));
        }
        if (r == null) { return null; }
        return r;
      });
    },
    // M6-Excel：导出活动 sheet 为 CSV（带 BOM）。桥走 xlsExportCsvJson：picker.save 让用户
    // 选位置 → TaskPool 写 BOM+UTF-8 字节 → 返回 {ok,path} 或 {canceled}；hasFormulas 警告
    // 由渲染层 csv-export.ts 在桌面路径上提前弹 ArkUI promptAction 处理（与桌面
    // dialog.showMessageBox 三按钮语义对齐：转 xlsx / 继续 CSV / 取消）。
    exportCsv: function (request) {
      var req = request || {};
      // hasFormulas 警告 + 取消转 xlsx 的「提前弹」逻辑：这里只负责纯 CSV 导出。
      // csv-export.ts 会先在 UI 层弹原生对话框（hasFormulas 时），本函数执行时用户已确认继续 CSV。
      return goJson('xlsExportCsvJson', [JSON.stringify({
        fileName: String(req.fileName || 'export.csv'),
        content: String(req.content || ''),
        hasFormulas: req.hasFormulas === true,
        activeSheetName: req.activeSheetName || undefined,
        targetPath: req.targetPath || undefined,
      })]).then(function (r) {
        if (r && r.ok === false) {
          var reason = (r && r.error) ? String(r.error) : '导出 CSV 失败';
          console.error('[GenOffice] xlsExportCsv failed: ' + reason);
          return Promise.reject(new Error(reason));
        }
        return r || { canceled: true };
      });
    },
    // M6-Excel 收尾：CSV 会话「首次保存是否保持 CSV 格式？」三按钮确认。桌面版是
    // dialog.showMessageBox（csvKeepFormatMsg/csvKeepFormatDetail + csvContinueBtn /
    // csvKeepXlsxBtn / btnCancel，defaultId=0=csv、cancelId=2=cancel）。渲染层
    // save-actions.ts 只认 'csv' | 'xlsx' | 'cancel' 三个字符串。
    // 缺本方法时 makeBridge Proxy 兜底返回 undefined → 渲染层落到「继续 CSV」分支：
    // 不弹窗、也没法转 xlsx 另存（用户以为已确认，实际是静默降级）。
    confirmCsvSave: function () { return showCsvKeepFormatChoice(); },
    // M6-Excel：打开外部链接（renderer cell click 命中 http(s) hyperlink）。
    // 鸿蒙壳走 Want + startAbility 让系统浏览器接管；scheme 白名单限制 http(s)/mailto。
    openExternal: function (url) {
      return goJson('openExternalJson', [String(url || '')]).then(function (r) {
        if (r && r.ok === false) {
          var reason = (r && r.error) ? String(r.error) : 'openExternal 失败';
          console.error('[GenOffice] openExternal failed: ' + reason);
          return Promise.reject(new Error(reason));
        }
        return undefined;
      });
    },
    // 新建空白表格：渲染层 boot 先调本方法再轮询 hasQueuedWorkbook —— 这里
    // 【不能】删 pendingBlankSheet（selectWorkbook 靠它识别"新建空白"投递）。
    consumeNewBlankWorkbook: function () {
      try { localStorage.removeItem('genoffice.newBlankSheet'); } catch (e) { /* 忽略 */ }
      return Promise.resolve(false);
    },
    readWorkbookRange: function (request) {
      var req = request || {};
      return goJson('xlsReadRangeJson', [JSON.stringify(req)]).then(function (r) {
        if (r && r.error) {
          // 新建空白会话没有 sidecar 后端，读失败属预期 → 静默返回空网格
          if (req.sessionId === BLANK_WORKBOOK.sessionId) {
            return { cells: [], rows: [], merges: [], hyperlinks: [] };
          }
          console.error('[GenOffice] xlsReadRange error: ' + String(r.error));
          return { cells: [], rows: [], merges: [], hyperlinks: [] };
        }
        return (r || { cells: [], rows: [], merges: [], hyperlinks: [] });
      });
    },
    readWorkbookFormulas: function (request) {
      var req = request || {};
      return goJson('xlsReadFormulaCellsJson', [JSON.stringify(req)]).then(function (r) {
        if (r && r.error) {
          if (req.sessionId !== BLANK_WORKBOOK.sessionId) {
            console.error('[GenOffice] xlsReadFormulas error: ' + String(r.error));
          }
          return { cells: [], indexingComplete: false };
        }
        return (r && !r.error) ? r : { cells: [], indexingComplete: false };
      });
    },
    readWorkbookMedia: function (request) {
      return goJson('xlsReadMediaJson', [JSON.stringify(request || {})]).then(function (r) {
        if (r && r.error) {
          console.error('[GenOffice] xlsReadMedia error: ' + String(r.error));
        }
        return r && !r.error ? r : { error: 'media unavailable' };
      });
    },
    closeWorkbook: function (sessionId) {
      return goJson('xlsCloseJson', [sessionId]).then(function () { return undefined; });
    },
    // 大编辑集分块上传（renderer >10000 edits 时调用；对齐桌面 SaveEditsTransferStore）
    beginSaveEditsTransfer: function (request) {
      try {
        request = request || {};
        transferSweep();
        if (editTransfers[request.transferId]) { throw new Error('Save transfer already exists.'); }
        if (Object.keys(editTransfers).length >= MAX_OPEN_TRANSFERS) { throw new Error('Too many open save transfers.'); }
        editTransfers[request.transferId] = {
          sessionId: request.sessionId,
          total: request.total,
          chunks: [],
          received: 0,
          lastActivityMs: Date.now(),
        };
        syncTransferSweep();
        return Promise.resolve();
      } catch (e) { return Promise.reject(e); }
    },
    sendSaveEditsChunk: function (request) {
      try {
        request = request || {};
        transferSweep();
        var t = editTransfers[request.transferId];
        if (!t || t.sessionId !== request.sessionId) { return Promise.resolve(); } // 未知 transfer：静默丢（renderer 保存失败会从头重试）
        if (request.seq !== t.chunks.length) {
          discardEditTransfer(request.transferId, request.sessionId);
          return Promise.resolve(); // 乱序：丢弃并静默（renderer 会 abort+重试）
        }
        var parsed;
        try { parsed = JSON.parse(request.editsJson || '[]'); } catch (e) { parsed = []; }
        if (!Array.isArray(parsed) || String(request.editsJson).length > SAVE_EDITS_CHUNK_JSON_MAX) {
          discardEditTransfer(request.transferId, request.sessionId);
          return Promise.resolve();
        }
        if (t.received + parsed.length > t.total || t.received + parsed.length > MAX_SAVE_EDITS_TOTAL) {
          discardEditTransfer(request.transferId, request.sessionId);
          return Promise.resolve();
        }
        t.chunks.push(parsed);
        t.received += parsed.length;
        t.lastActivityMs = Date.now();
        return Promise.resolve();
      } catch (e) { return Promise.resolve(); }
    },
    abortSaveEditsTransfer: function (request) {
      try {
        discardEditTransfer(request.transferId, request.sessionId);
      } catch (e) { /* best-effort */ }
      return Promise.resolve();
    },
    // 保存链路（M5.1 真写盘：值/文本/公式/清空；M5.2b 样式编辑 → sidecar save_cells → 写回原文件）
    saveWorkbookEdits: function (request) {
      // 归一化（值优先白名单 / 结构性与 multi-sheet op 形状校验）在模块级
      // buildSheetsSavePayload：崩溃恢复副本（writeWorkbookRecovery）复用同一份校验，
      // 两条路各自漂移会导致"保存能过、恢复副本静默失败"这类难查问题。
      var built = buildSheetsSavePayload(request);
      if (built.error) {
        return Promise.resolve({ ok: false, error: built.error });
      }
      return goJson(built.isSaveAs ? 'xlsSaveAsEditsJson' : 'xlsSaveEditsJson',
        [JSON.stringify(built.payload)]).then(function (r) {
        if (!r || r.ok === false) {
          return { ok: false, error: (r && r.error) ? String(r.error) : '保存失败' };
        }
        return r; // {ok:true,file} 渲染层重开新会话；{ok:true,canceled:true} 另存为取消
      });
    },
    // 公式重算（recalcWorkbook）：edits/reads 原样透传侧车；失败返回 ok:false
    // （renderer 软降级到文件缓存值，保存时由 Excel 自行重算）
    recalcWorkbook: function (request) {
      if (!request || !request.sessionId) {
        return Promise.resolve({ ok: false, error: 'recalc 需要会话' });
      }
      return goJson('xlsRecalcJson', [JSON.stringify(request)]).then(function (r) {
        if (!r || r.ok === false) {
          return { ok: false, error: (r && r.error) ? String(r.error) : '重算失败' };
        }
        return { ok: true, ...((r && r.result) || { cells: [] }) };
      }).catch(function (e) {
        return { ok: false, error: '重算异常：' + (e && e.message ? e.message : e) };
      });
    },
    // 崩溃恢复副本（桌面 renderer 每 30s 仅在脏时调用；save-actions.ts:353）。桌面写
    // userData/sheets-autosave，壳写 filesDir/genoffice-sheets-recovery（桥侧 xlsRecoveryWriteJson）。
    // 与保存共用 buildSheetsSavePayload（同一份白名单/形状校验），但【不弹任何对话框、
    // 不换会话】：任何失败都回 {ok:false}，渲染层静默跳过本轮（桌面同语义，绝不打断编辑）。
    writeWorkbookRecovery: function (request) {
      var built = buildSheetsSavePayload(request);
      if (built.error) { return Promise.resolve({ ok: false }); }
      return goJson('xlsRecoveryWriteJson', [JSON.stringify(built.payload)]).then(function (r) {
        return { ok: !!(r && r.ok === true) };
      }).catch(function () { return { ok: false }; });
    },
    autoRenameWorkbook: function () { return Promise.resolve({ renamed: false }); },
    onWorkbookRenamed: function () { return NOOP; },
    // sheets 崩溃恢复提问（桌面 sheets-main.ts promptRecoveryRestore ↔ preload onRecoveryPrompt）。
    // onRecoveryPrompt 必须是【订阅登记】语义：返回取消订阅函数（wrapMethod 对 on* 不 Promise 化），
    // App.tsx:607 在 mount effect 里登记、在 cleanup 里调用返回值注销。
    // replyRecoveryPrompt 必须是【真实现】——桌面这里是 IPC send；写成 no-op 会让恢复提问
    // 永远挂起（打开卡住不报错，极难查），门禁 checkSheetsRecoveryPrompt 拦这一点。
    onRecoveryPrompt: function (fn) { return registerFrameFn(frameRecoveryPromptFns, fn); },
    replyRecoveryPrompt: function (restore) {
      settleRecoveryPrompt(restore === true ? 'restore' : 'discard');
      return Promise.resolve();
    },
    // notifyPendingEdits 由上方「事件订阅/上报」段统一实现（写 __goFrameDirty）。
    // 切勿在此再写一次无参 no-op：对象字面量后者胜出，会静默覆盖实现，Excel 的
    // 未保存状态永远为 false → 关 tab 不弹保存提示（真机已踩，门禁 checkCloseGuard 拦）。
    // sheets 的「菜单动作」通道（'open' | 'save' | 'save-as' | 'export-pdf' | 'export-csv'
    // | 'undo' | 'redo'，见 apps/sheets/src/shared/desktop-api.ts MenuAction）：真实登记到
    // 本 frame，由壳菜单经 postMessage({__goMenuAction}) 派发。
    onMenuAction: function (fn) { return registerFrameFn(frameMenuActionFns, fn); },
  };

  function promiseify(fn) {
    return function () {
      try {
        var r = fn.apply(this, Array.prototype.slice.call(arguments));
        return (r && typeof r.then === 'function') ? r : Promise.resolve(r);
      } catch (e) { return Promise.reject(e); }
    };
  }

  // 订阅型方法（on* 开头）必须【原样返回取消订阅函数】——不能 Promise 化！
  // React effect 的 cleanup 会直接调用其返回值，包成 Promise 就报 "X is not a function"。
  function wrapMethod(k, fn) {
    return (k.indexOf('on') === 0) ? fn : promiseify(fn);
  }

  // ===== AI 设置：localStorage 持久化（rawfile 同源，shell 与各 app iframe 共享一份） =====
  var AI_KEY = 'genoffice.aiSettings';
  var DEF_PROVIDERS = {
    // Genspark 通道彻底移除：它的 LLM 走 Genspark 侧记在 GenOffice 账上的代理（app_type /
    // key_name = genoffice 落 billing_tag + X-Agent-Type 分账），fork 无权使用；鸿蒙侧本来
    // 也没有 device-code 登录（无 Node 主进程 / 无 ~/.genoffice/auth.json）→ 留着只是死入口。
    // 这里的 model 只是预填，「AI 模型」分区里可改；custom 给空串 → 渲染层转成自由输入框。
    anthropic: 'claude-sonnet-5', gemini: 'gemini-3.7-flash',
    deepseek: 'deepseek-v4-pro', openai: 'gpt-5.6-terra', kimi: 'kimi-k3',
    glm: 'glm-5.3', qwen: 'qwen3.8-max', doubao: 'doubao-seed-2-1-pro-260628',
    minimax: 'MiniMax-M3', xai: 'grok-4.6', mistral: 'mistral-medium-latest',
    openrouter: 'openrouter/auto', 'opencode-zen': 'claude-sonnet-5', 'opencode-go': 'kimi-k2.7-code',
    custom: ''
  };
  // media / search 必须是「全形状」：AiMediaPane 见 !settings.media || !settings.search 直接
  // return null —— 缺字段等于「AI 媒体与搜索」整块空白，Serper / Tavily 的 Key 没地方填。
  function defaultAiMediaSettings() {
    var mp = {};
    var ids = ['openai', 'gemini', 'doubao', 'glm', 'xai', 'qwen', 'minimax', 'custom'];
    for (var i = 0; i < ids.length; i++) {
      mp[ids[i]] = { apiKey: '', baseUrl: '', imageModel: '', analysisModel: '' };
    }
    return { imageProvider: 'custom', analysisProvider: 'custom', videoAnalysisProvider: 'custom', providers: mp };
  }
  function defaultAiSearchSettings() {
    return {
      provider: 'serper',
      providers: { serper: { apiKey: '' }, tavily: { apiKey: '' }, parallel: { apiKey: '' } }
    };
  }
  function defaultAiSettings() {
    var p = {};
    Object.keys(DEF_PROVIDERS).forEach(function (id) { p[id] = { apiKey: '', model: DEF_PROVIDERS[id], baseUrl: '', models: [] }; });
    return { provider: 'glm', providers: p, media: defaultAiMediaSettings(), search: defaultAiSearchSettings(), autoModel: false };
  }
  // 用户自存模型列表：只留非空字符串、去重、限长 40 条（防止手输把配置撑爆）。
  function sanitizeModelList(v) {
    if (!v || !v.length) { return []; }
    var out = [];
    for (var i = 0; i < v.length && out.length < 40; i++) {
      var m = v[i];
      if (typeof m !== 'string') { continue; }
      m = m.trim();
      if (m && out.indexOf(m) < 0) { out.push(m); }
    }
    return out;
  }
  // 老配置（存过 genspark / 缺 media、search）补齐：不补就会整块面板空白、provider 落空。
  function normalizeAiSettings(o) {
    var d = defaultAiSettings();
    if (!o.provider || o.provider === 'genspark' || o.provider === 'codex') { o.provider = 'glm'; }
    var keys = Object.keys(d.providers);
    for (var i = 0; i < keys.length; i++) {
      var cur = o.providers[keys[i]] || {};
      o.providers[keys[i]] = {
        apiKey: cur.apiKey || '', model: cur.model || d.providers[keys[i]].model, baseUrl: cur.baseUrl || '',
        models: sanitizeModelList(cur.models)
      };
    }
    if (!o.media || !o.media.providers) { o.media = defaultAiMediaSettings(); }
    if (!o.search || !o.search.providers) { o.search = defaultAiSearchSettings(); }
    o.autoModel = !!o.autoModel;
    return o;
  }
  // AI 面板的模型选择：AUTO 开关 + 当前提供商的候选列表（自存列表，含当前 model）。
  // 面板下拉直接吃这三个字段，不必各自读整份配置。
  var AI_MODEL_AUTO = '__auto__';
  function aiChatModelChoices() {
    var s = loadAiSettings();
    var pc = (s.providers && s.providers[s.provider]) || {};
    var list = sanitizeModelList(pc.models);
    var cur = pc.model || '';
    if (cur && list.indexOf(cur) < 0) { list = [cur].concat(list); }
    return { auto: !!s.autoModel, current: s.autoModel ? AI_MODEL_AUTO : cur, models: list };
  }
  // auto 哨兵或空串 = 开 AUTO；其余按模型 id 钉住（顺手关掉 AUTO，避免"选了却没生效"）。
  function aiApplyChatModel(m) {
    var s = loadAiSettings();
    if (m === AI_MODEL_AUTO || m === null || m === undefined || m === '') {
      s.autoModel = true;
      saveAiSettings(s);
      return aiChatModelChoices();
    }
    s.autoModel = false;
    var pc = (s.providers && s.providers[s.provider]) || {};
    pc.model = String(m);
    if (s.providers && s.providers[s.provider]) { s.providers[s.provider] = pc; }
    saveAiSettings(s);
    return aiChatModelChoices();
  }
  function loadAiSettings() {
    try {
      var s = localStorage.getItem(AI_KEY);
      if (s) { var o = JSON.parse(s); if (o && o.providers) { return normalizeAiSettings(o); } }
    } catch (e) { /* 损坏则回默认 */ }
    return defaultAiSettings();
  }
  function saveAiSettings(s) {
    try { localStorage.setItem(AI_KEY, JSON.stringify(s || {})); } catch (e) { /* 忽略 */ }
  }
  // 供 SHELL_BRIDGE 复用（同页 documentStart 先后执行）
  window.__goShared = {
    loadAiSettings: loadAiSettings,
    saveAiSettings: saveAiSettings,
    // AI 面板偏好也给 shell 首页的设置面板用（aiOffice.get/setAiPanelPrefs）：桌面这两条 IPC
    // 落在主进程的同一份 app-settings，壳侧对应「同一 localStorage key + 同一 normalize 规则」，
    // 否则会出现「设置面板改了、app 里的面板不动」或各存一份互相覆盖。
    loadAiPanelPrefs: loadAiPanelPrefs,
    saveAiPanelPrefs: saveAiPanelPrefs,
    mergeAiPanelPrefs: mergeAiPanelPrefs,
    broadcastAiPanelPrefs: broadcastAiPanelPrefs
  };

  // ProjectApi 共 11 个方法（packages/project-store/src/ipc.ts），全 app 通用桥
  var projectMock = {
    resolveChat: function (args) {
      return Promise.resolve({ projectId: 'default', chatId: (args && args.tempChatId) || 'unsaved-0' });
    },
    appendChat: function () { return Promise.resolve(); },
    loadChat: function () { return Promise.resolve([]); },
    rebindChat: function () { return Promise.resolve({ projectId: 'default', chatId: 'unsaved-0' }); },
    listProjects: function () { return Promise.resolve([]); },
    createProject: function () { return Promise.resolve({ id: 'default', name: 'Default', fileCount: 0, lastActiveAt: 0 }); },
    renameProject: function () { return Promise.resolve(); },
    deleteProject: function () { return Promise.resolve(); },
    moveFile: function () { return Promise.resolve(); },
    getTimeline: function () { return Promise.resolve([]); },
  };

  // ===== 桥工厂：显式 mock 为底座 + Proxy 兜底 =====
  // 各 app 桥名不同（以 contextBridge.exposeInMainWorld 第一实参为准）：
  //   docs=desktop / sheets=desktopApi / slides=slidesApi / markdown=markdownApi / pdf=pdfApi
  // slides 有 177 个方法，逐一 mock 不现实 —— Proxy 对未知方法统一兜底：
  //   on* → 返回退订函数；其余 → Promise<undefined>；then/catch 等拒识（保持非 thenable）。
  var DENY = { then: 1, catch: 1, finally: 1 };
  function makeBridge(name, base) {
    base = base || {};
    base.getAiSettings = function () { return Promise.resolve(loadAiSettings()); };
    base.setAiSettings = function (s) { saveAiSettings(s && s.providers ? normalizeAiSettings(s) : s); return Promise.resolve(); };
    // AI 面板的模型下拉：读候选（含 AUTO 哨兵）/ 写选择。app iframe 内也走这两条，
    // 所以必须挂在 base 上 —— Proxy 兜底只会给 Promise<undefined>。
    base.getAiChatModels = function () { return Promise.resolve(aiChatModelChoices()); };
    base.setAiChatModel = function (m) { return Promise.resolve(aiApplyChatModel(m)); };
    // __has(method): 能力探测 — 判断方法是否在桥上有真实实现（不是 Proxy 兜底）
    // 渲染层可在调用前检查：if (window.desktop.__has('saveDocx')) { ... }
    base.__has = function (method) {
      return Object.prototype.hasOwnProperty.call(base, method) && typeof base[method] === 'function';
    };
    // __unsupported(method): 结构化诊断 — 未实现方法的信息（不再静默无反应）
    base.__unsupported = function (method) {
      return { method: method, bridge: name, message: 'Method not yet implemented on HarmonyOS' };
    };
    base.__wrapped = true;
    var proxy = new Proxy(base, {
      get: function (t, k) {
        if (k in t) { return t[k]; }
        if (typeof k !== 'string' || k.charAt(0) === '_' || DENY[k]) { return undefined; }
        // ArkTS 专用通道（xxxJson）：未 merge 时返回走 findNativeCaller 的 caller 闭包，
        // iframe 路由下经顶层 __goNativeCall 转发到主 frame 的 desktopNative 同名方法
        //（gin 桥方法不能跨 frame 调用，必须在主 frame 内触发）。找不到转发器时
        // 返回 null（与 nativeBridge 行为一致，挂起保护靠 Promise.resolve 链）。
        if (/Json$/.test(k)) {
          return function () {
            var caller = findNativeCaller();
            if (!caller) { return Promise.resolve(null); }
            var a = Array.prototype.slice.call(arguments);
            return Promise.resolve(caller(k, a));
          };
        }
        if (k.indexOf('on') === 0) { return function () { return NOOP; }; }
        // 未实现方法：控制台可见方法名 + 桥名，便于定位「点了没反应」的根因
        console.warn('[GenOffice] unsupported: ' + name + '.' + k);
        return function () { return Promise.resolve(undefined); };
      }
    });
    // ArkTS registerJavaScriptProxy 晚注入合并：真实方法写进 base（Proxy 优先返回 base 成员）
    var merge = function (v) {
      if (v && typeof v === 'object' && !v.__wrapped) {
        Object.keys(v).forEach(function (k) {
          if (k.indexOf('__') !== 0 && typeof v[k] === 'function') { base[k] = wrapMethod(k, v[k]); }
        });
      }
    };
    // 若 ArkTS 已先注入（早于 documentStart），先合并其方法再接管属性
    var existing = window[name];
    if (existing && typeof existing === 'object' && !existing.__wrapped) { merge(existing); }
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        get: function () { return proxy; },
        set: merge
      });
    } catch (e) { window[name] = proxy; }
    return proxy;
  }

  // 关键应用启动方法必须返回有效载荷，单纯的"Promise<undefined>"会让 slides 等
  // 启动流程停在 splash（applyOpen 早 return）。补足以下 mock：
  // - newBlank: 启动新空白文档（M3 落真实文件 IO 时桥接到 ArkTS）
  // - consumePendingOpen: 返回 null（无待打开文件，走 bootBlank 分支）
  // - getLayouts: 必须有数据（applyOpen 后立即 setLayoutsResult）
  var BOOT_SLIDE = {
    widthPx: 1280, heightPx: 720, scale: 1,
    background: { kind: 'none' },
    nodes: []
  };
  function bootOpenResult(name) {
    return { path: '', slides: [BOOT_SLIDE], defaultFont: null, name: name || 'Untitled' };
  }
  // ===== slides 版式目录（等价 pptx-engine builtinLayoutInfos：Office 16:9 标准六件套，
  // 几何按 12192000×6858000 EMU 基准等比缩放；path 用 builtin:<key> 虚拟路径）=====
  var GO_SLIDE_CX = 12192000, GO_SLIDE_CY = 6858000;
  var GO_PH_HINT = {
    title: 'Click to add title', ctrTitle: 'Click to add title', body: 'Click to add text',
    subTitle: 'Click to add subtitle', obj: 'Click to add content'
  };
  function goLayouts() {
    var sx = function (v) { return Math.round((v / GO_SLIDE_CX) * GO_SLIDE_CX); };
    var sy = function (v) { return Math.round((v / GO_SLIDE_CY) * GO_SLIDE_CY); };
    function ph(type, idx, x, y, cx, cy) {
      return { type: type, idx: idx, x: sx(x), y: sy(y), cx: sx(cx), cy: sy(cy), hint: GO_PH_HINT[type] || 'Click to add text' };
    }
    var T = { x: 838200, y: 365125, cx: 10515600, cy: 1325563 };
    var B = { x: 838200, y: 1825625, cx: 10515600, cy: 4351338 };
    return [
      { path: 'builtin:titleSlide', name: 'Title Slide', layoutType: 'title', placeholders: [
        ph('ctrTitle', '', 1524000, 1122363, 9144000, 2387600),
        ph('subTitle', '1', 1524000, 3602038, 9144000, 1655762)
      ] },
      { path: 'builtin:titleContent', name: 'Title and Content', layoutType: 'obj', placeholders: [
        ph('title', '', T.x, T.y, T.cx, T.cy),
        ph('body', '1', B.x, B.y, B.cx, B.cy)
      ] },
      { path: 'builtin:sectionHeader', name: 'Section Header', layoutType: 'secHead', placeholders: [
        ph('title', '', 831850, 4589463, 10515600, 1500187),
        ph('body', '1', 831850, 1709738, 10515600, 2852737)
      ] },
      { path: 'builtin:twoContent', name: 'Two Content', layoutType: 'twoObj', placeholders: [
        ph('title', '', T.x, T.y, T.cx, T.cy),
        ph('body', '1', 838200, 1825625, 5157787, 4351338),
        ph('body', '2', 6172200, 1825625, 5181600, 4351338)
      ] },
      { path: 'builtin:titleOnly', name: 'Title Only', layoutType: 'titleOnly', placeholders: [
        ph('title', '', T.x, T.y, T.cx, T.cy)
      ] },
      { path: 'builtin:blank', name: 'Blank', layoutType: 'blank', placeholders: [] }
    ];
  }

  // 共享 startup 增强基座（让所有 6 个桥的同名方法都有正确返回值）
  // === slides 内存 deck（无 pptx-engine 引擎下的最小可用降级）===
  // 设计：让 applyOpen / addSlide / addSlideWithLayout / setSlideLayout 等在内存里
  // 真有结果返回；版式面板可点击，点击后真插入新节点。M5 落 Rust pptx-engine 后可整体替换。
  var slideClip = null; // 页剪贴板（copySlides → pasteSlide，应用内）
  var slideDeck = {
    slides: [{
      widthPx: 1280, heightPx: 720, scale: 1,
      background: { kind: 'none' },
      nodes: [],
      layoutPath: 'builtin:blank',
    }],
    size: { cx: GO_SLIDE_CX, cy: GO_SLIDE_CY },
  };
  // EMU → viewport px (ArkTS 渲染层用 fitWidthPx=1280 时 scale=1；先打 1:1 几何，避免 box 缺失让 React 端崩)
  var EMU_PER_PX = 9525; // 914400 / 96
  function emu(v) { return Math.round(v / EMU_PER_PX); }
  function makeTextBox(ph, slide) {
    // ph.x/y/cx/cy 已是 EMU；先换算成 px（按 slide 自身 widthPx / (cx/EMU_PER_PX) 缩放）。
    var baseW = slide.size ? (slide.size.cx / EMU_PER_PX) : (slide.widthPx || 1280);
    var scale = (slide.widthPx || 1280) / baseW;
    var x = Math.round(ph.x / EMU_PER_PX * scale);
    var y = Math.round(ph.y / EMU_PER_PX * scale);
    var w = Math.round(ph.cx / EMU_PER_PX * scale);
    var h = Math.round(ph.cy / EMU_PER_PX * scale);
    return { x: x, y: y, w: w, h: h, rotationDeg: 0, flipH: false, flipV: false,
             centerX: x + w / 2, centerY: y + h / 2 };
  }
  function makeTextNode(ph, slide) {
    var kind = ph.type === 'ctrTitle' ? 'title' : (ph.type === 'subTitle' ? 'subtitle' : 'body');
    var text = kind === 'title' ? '点击添加标题' : (kind === 'subtitle' ? '点击添加副标题' : '点击添加文本');
    var fontSize = kind === 'title' ? 36 : (kind === 'subtitle' ? 22 : 18);
    var sid = 'ph-' + ph.type + '-' + Math.floor(Math.random() * 1e9).toString(36);
    return {
      id: sid,
      type: 'text',
      sourceId: sid,
      placeholder: ph.type,
      box: makeTextBox(ph, slide),
      fill: { kind: 'none' },
      text: {
        lines: [{
          runs: [{ text: text, fontFamily: '', fontSizePx: fontSize,
                   color: '#202124', bold: kind === 'title', italic: false, underline: false,
                   x: 0, baselineY: fontSize * 0.85, widthPx: 0, ascentPx: fontSize * 0.8 }],
          top: 0, height: fontSize * 1.2, align: kind === 'subtitle' ? 'center' : 'left',
        }],
        insets: { l: 6, t: 4, r: 6, b: 4 },
        anchor: 'top', fontScale: 1, contentHeight: fontSize * 1.2, wrap: true,
      },
    };
  }
  function applyLayoutToSlide(slide, layoutPath) {
    slide.layoutPath = layoutPath || 'builtin:blank';
    var def = goLayouts().find(function (l) { return l.path === slide.layoutPath; }) || goLayouts()[0];
    if (!def) { slide.nodes = []; return; }
    slide.size = slide.size || { cx: GO_SLIDE_CX, cy: GO_SLIDE_CY };
    slide.nodes = def.placeholders.map(function (p) { return makeTextNode(p, slide); });
  }
  // 启动时给 deck 第一张上版式（避免首屏白板）
  applyLayoutToSlide(slideDeck.slides[0], 'builtin:titleSlide');
  function newDeckSlide(layoutPath) {
    var s = {
      widthPx: 1280, heightPx: 720, scale: 1,
      background: { kind: 'none' },
      nodes: [],
      layoutPath: 'builtin:blank',
    };
    applyLayoutToSlide(s, layoutPath);
    return s;
  }
  window.__goBoot = {
    newBlank: function () {
      var d = {
        path: '', slides: [{
          widthPx: 1280, heightPx: 720, scale: 1,
          background: { kind: 'none' }, nodes: [], layoutPath: 'builtin:blank',
        }],
        defaultFont: null, name: 'Untitled', size: slideDeck.size,
      };
      applyLayoutToSlide(d.slides[0], 'builtin:titleSlide');
      slideDeck = { slides: d.slides, size: d.size };
      return Promise.resolve(d);
    },
    consumePendingOpen: function () { return Promise.resolve(null); },
    // GetLayoutsResult：{layouts, size}（此前返回 {layouts:[], activeLayoutId} 结构就是错的 → 版式面板空白）
    getLayouts: function () { return Promise.resolve({ layouts: goLayouts(), size: slideDeck.size }); },
    getRecentFiles: function () { return recentFilesImpl(); },
    getSections: function () { return Promise.resolve([]); },
    getAnimations: function () { return Promise.resolve([]); },
    getHeaderFooter: function () { return Promise.resolve({}); },
    getComments: function () { return Promise.resolve([]); },
    getRunLinks: function () { return Promise.resolve([]); },
    getSlideLinks: function () { return Promise.resolve([]); },
    getNotes: function () { return Promise.resolve(''); },
    getTransition: function () { return Promise.resolve(null); },
    getAiSettings: function () { return Promise.resolve(loadAiSettings()); },
    isDirty: function () { return Promise.resolve(false); },
    getRenderSlides: function () { return Promise.resolve(slideDeck.slides); },
    getSlideSize: function () { return Promise.resolve(slideDeck.size); },
    // === 插入版式 / 增删 slide 的最小内存实现 ===
    addSlide: function (op) {
      try {
        var src = (op && typeof op.sourceIndex === 'number') ? op.sourceIndex : slideDeck.slides.length - 1;
        var ns = newDeckSlide('builtin:blank');
        var at = Math.min(Math.max(src + 1, 0), slideDeck.slides.length);
        slideDeck.slides.splice(at, 0, ns);
        return Promise.resolve({ slides: slideDeck.slides, index: at });
      } catch (e) { return Promise.resolve(null); }
    },
    addBlankSlide: function (op) {
      try {
        var src = (op && typeof op.sourceIndex === 'number') ? op.sourceIndex : slideDeck.slides.length - 1;
        var ns = newDeckSlide('builtin:blank');
        var at = Math.min(Math.max(src + 1, 0), slideDeck.slides.length);
        slideDeck.slides.splice(at, 0, ns);
        return Promise.resolve({ slides: slideDeck.slides, index: at });
      } catch (e) { return Promise.resolve(null); }
    },
    addSlideWithLayout: function (op) {
      try {
        var src = (op && typeof op.sourceIndex === 'number') ? op.sourceIndex : slideDeck.slides.length - 1;
        var ns = newDeckSlide(op && op.layoutPath || 'builtin:titleContent');
        var at = Math.min(Math.max(src + 1, 0), slideDeck.slides.length);
        slideDeck.slides.splice(at, 0, ns);
        return Promise.resolve({ slides: slideDeck.slides, index: at });
      } catch (e) { return Promise.resolve(null); }
    },
    setSlideLayout: function (op) {
      try {
        var i = (op && typeof op.slideIndex === 'number') ? op.slideIndex : 0;
        var s = slideDeck.slides[i];
        if (!s) { return Promise.resolve(null); }
        applyLayoutToSlide(s, op && op.layoutPath || 'builtin:blank');
        return Promise.resolve(s);
      } catch (e) { return Promise.resolve(null); }
    },
    deleteSlide: function (i) {
      try {
        if (slideDeck.slides.length <= 1) { return Promise.resolve(null); }
        var idx = Math.max(0, Math.min(i | 0, slideDeck.slides.length - 1));
        slideDeck.slides.splice(idx, 1);
        return Promise.resolve(slideDeck.slides);
      } catch (e) { return Promise.resolve(null); }
    },
  };
  Object.keys(window.__goBoot).forEach(function (k) {
    mock[k] = window.__goBoot[k];
  });

  // 六个桥共用同一 mock 底座（getLanguage/getTheme 等基础方法所有 app 都要用；
  // ArkTS 只注入 desktop/projectApi 两个名字，合并只影响这两个，共享底座无副作用）
  // pdfApi 专属 overlay：readFile 按路径读字节返回 ArrayBuffer（复用 openDocxPathJson
  // 无选择器按 URI 读文件），与 markdown 的 readFile: Promise<string> 语义不同，
  // 不能进共享底座 —— 否则 markdown 打开文件会被塞 ArrayBuffer。
  // 保存/结构操作/静态表单读取接 pdf-bridge（esbuild 打包 pdf-lib 纯逻辑单文件，
  // 见 harmony/scripts/build-pdf-bridge.mjs；同步链 sync-web.sh pdf 分支）。

  // pdf-bridge 懒加载（同 slidesProject 的 loadPptxBridge；rawfile 直读 → data: URL import）
  var pdfBridgePromise = null;
  var PDF_BRIDGE_RAW = 'web/pdf-bridge.mjs';
  function loadPdfBridge() {
    if (pdfBridgePromise) { return pdfBridgePromise; }
    pdfBridgePromise = goJson('readRawFileJson', [PDF_BRIDGE_RAW]).then(function (r) {
      if (!r || r.ok !== true || !r.b64) {
        pdfBridgePromise = null;
        throw new Error('readRawFileJson failed: ' + (r && r.error ? r.error : 'missing b64'));
      }
      return import('data:text/javascript;base64,' + r.b64);
    }).catch(function (e) {
      console.error('[GenOffice] pdf-bridge load failed: ' + (e && e.message ? e.message : e));
      pdfBridgePromise = null;
      throw e;
    });
    return pdfBridgePromise;
  }
  function readPdfPathBytes(p) {
    return goJson('openDocxPathJson', [p]).then(function (r) {
      if (!r || !r.ok) { throw new Error((r && r.error) ? r.error : 'read failed: ' + p); }
      return new Uint8Array(b64ToBuf(r.b64));
    });
  }
  // 覆盖写（不弹选择器）
  function writePdfBytesAt(p, bytes) {
    return goJson('saveAnyJson', [p, bufToB64(bytes)]).then(function (r) {
      if (!r) { return { ok: false, error: 'save bridge unavailable' }; }
      if (!r.ok) { return { ok: false, error: r.error || 'write failed' }; }
      return { ok: true, path: p };
    });
  }
  // 另存为（弹系统保存选择器；name 只是建议文件名）
  function savePdfAsBytes(name, bytes) {
    var base = String(name || 'Untitled.pdf');
    if (!/.pdf$/i.test(base)) { base += '.pdf'; }
    var parts = base.split('/');
    base = parts[parts.length - 1];
    return goJson('saveAsAnyJson', [base, bufToB64(bytes)]).then(function (r) {
      if (!r) { return { ok: false, error: 'save-as bridge unavailable' }; }
      if (r.canceled || !r.ok) {
        return (r.canceled) ? { ok: true, canceled: true } : { ok: false, error: r.error || 'save-as failed' };
      }
      // savedPath：对齐桌面契约（extract/mergePages/splitPages 等消费方依赖该字段）
      return { ok: true, path: r.path, savedPath: r.path };
    });
  }
  function pickPdfFile() {
    // 复用共享底座的文件选择。
    // 返回 {path, bytes}（成功）| null（用户取消/选择器不可用，等价桌面 canceled）
    // | {error: '...'}（选中后读字节失败，显式上报而非静默取消）。
    return Promise.resolve(mock.openFileJson(PDF_SUFFIXES)).then(function (j) {
      var r = null;
      if (typeof j === 'string' && j) {
        try { r = JSON.parse(j); } catch (e) { r = null; }
      }
      if (!r || !r.ok || !r.path) {
        console.info('[GenOffice] pdf pickFile: 未选择 / 选择器不可用 j=' + (typeof j === 'string' ? j.slice(0, 80) : String(j)));
        return null;
      }
      return readPdfPathBytes(r.path).then(function (bytes) {
        console.info('[GenOffice] pdf pickFile OK: ' + r.path + ' bytes=' + bytes.length);
        return { path: r.path, bytes: bytes };
      }).catch(function (e) {
        console.error('[GenOffice] pdf pickFile 读字节失败: ' + (e && e.message ? e.message : e) + ' path=' + r.path);
        return { error: '读取所选 PDF 失败: ' + ((e && e.message) ? e.message : e) };
      });
    });
  }
  // 供 insertPdf/replacePages/mergePdf 使用：把 pickPdfFile 的失败/取消转成明确结果
  function pdfPickCheck(other) {
    if (!other) { return Promise.resolve({ ok: true, canceled: true }); }
    if (Object.prototype.hasOwnProperty.call(other, 'error')) {
      return Promise.resolve({ ok: false, error: other.error });
    }
    return Promise.resolve(null); // 正常选择
  }
  function handlePdfOpErr(e) {
    console.error('[GenOffice] pdf op failed: ' + (e && e.message ? e.message : e));
    return { ok: false, error: (e && e.message) ? e.message : ('pdf op failed: ' + String(e)) };
  }
  // ===== PDF → Word/Excel/PPT 本地转换（pdf-convert 桥 + PDFium wasm，全在壳内跑）=====
  // 打包：harmony/scripts/build-pdf-convert.mjs（esbuild：pdf2docx 三种转换 + @embedpdf/pdfium
  // 浏览器 init）；wasm 实体随构建拷进 rawfile（web/pdfium.wasm，4.4MB，懒加载一次后复用）。
  // 流程对齐桌面 exportPdfAsDocxLocal/XlsxLocal/PptxLocal：读源文件 → 转换 → 另存为 →
  // 在新标签页打开。差异：桌面先弹保存对话框再转换，壳内 saveAsAnyJson 需要字节才能弹
  // （桥上没有「只选路径」的方法），所以顺序是转换在前、另存为在后。
  var PDF_CONVERT_RAW = 'web/pdf-convert.mjs';
  var PDFIUM_WASM_RAW = 'web/pdfium.wasm';
  var pdfConvertPromise = null;
  var pdfiumPromise = null;
  var pdfConverting = false;
  function loadPdfConvert() {
    if (pdfConvertPromise) { return pdfConvertPromise; }
    pdfConvertPromise = goJson('readRawFileJson', [PDF_CONVERT_RAW]).then(function (r) {
      if (!r || r.ok !== true || !r.b64) {
        pdfConvertPromise = null;
        throw new Error('readRawFileJson failed: ' + (r && r.error ? r.error : 'missing b64'));
      }
      console.info('[GenOffice] pdf-convert loaded b64=' + r.b64.length);
      return import('data:text/javascript;base64,' + r.b64);
    }).catch(function (e) {
      console.error('[GenOffice] pdf-convert load failed: ' + (e && e.message ? e.message : e));
      pdfConvertPromise = null;
      throw e;
    });
    return pdfConvertPromise;
  }
  // wasm 魔数校验（0x00 61 73 6D = "asm"）：fetch 命中错误页/空响应时立刻回退，
  // 而不是把垃圾字节喂给 initPdfium 后报看不懂的错。
  function pdfiumWasmOk(bytes) {
    var magic = 'asm';
    return !!bytes && bytes.length > 1024 && bytes[0] === 0
      && bytes[1] === magic.charCodeAt(0) && bytes[2] === magic.charCodeAt(1) && bytes[3] === magic.charCodeAt(2);
  }
  // 4.4MB wasm 的取字节：优先 fetch（resource://rawfile 同源，不经 base64 过桥，省一次
  // 6MB 字符串编解码），失败/内容异常再回退 readRawFileJson（与 pdf-bridge 同一条验证过的通道）。
  function loadPdfiumBytes() {
    var viaFetch = function () {
      try {
        return fetch('../pdfium.wasm').then(function (r) {
          if (!r || !r.ok) { throw new Error('fetch ../pdfium.wasm status=' + (r ? r.status : 'no-response')); }
          return r.arrayBuffer();
        }).then(function (ab) {
          var b = new Uint8Array(ab);
          if (!pdfiumWasmOk(b)) { throw new Error('pdfium.wasm 内容异常 ' + b.length + 'B'); }
          return b;
        });
      } catch (e) {
        // fetch 本身缺失/同步抛错也要落进回退分支，而不是把异常抛到调用栈外
        return Promise.reject(e);
      }
    };
    var viaBridge = function () {
      return goJson('readRawFileJson', [PDFIUM_WASM_RAW]).then(function (r) {
        if (!r || r.ok !== true || !r.b64) {
          throw new Error('readRawFileJson failed: ' + (r && r.error ? r.error : 'missing b64'));
        }
        return new Uint8Array(b64ToBuf(r.b64));
      });
    };
    return viaFetch().catch(function (e) {
      console.info('[GenOffice] pdfium fetch unavailable (' + (e && e.message ? e.message : e) + '), fallback readRawFileJson');
      return viaBridge();
    });
  }
  function loadPdfium(mod) {
    if (pdfiumPromise) { return pdfiumPromise; }
    var t0 = Date.now();
    pdfiumPromise = loadPdfiumBytes().then(function (bytes) {
      console.info('[GenOffice] pdfium wasm read: ' + bytes.length + 'B in ' + (Date.now() - t0) + 'ms');
      return mod.initPdfium(bytes).then(function (m) {
        console.info('[GenOffice] pdfium ready in ' + (Date.now() - t0) + 'ms');
        return m;
      });
    }).catch(function (e) {
      console.error('[GenOffice] pdfium init failed: ' + (e && e.message ? e.message : e));
      pdfiumPromise = null;
      throw e;
    });
    return pdfiumPromise;
  }
  // 另存为（任意扩展名）：savePdfAsBytes 会把名字强制成 .pdf，转换出口要 .docx/.xlsx/.pptx
  function saveAsBytesExt(name, bytes) {
    var base = String(name || 'Untitled');
    var parts = base.split('/');
    base = parts[parts.length - 1];
    return goJson('saveAsAnyJson', [base, bufToB64(bytes)]).then(function (r) {
      if (!r) { return { ok: false, error: 'save-as bridge unavailable' }; }
      if (r.canceled || !r.ok) {
        return (r.canceled) ? { ok: true, canceled: true } : { ok: false, error: r.error || 'save-as failed' };
      }
      return { ok: true, path: r.path, savedPath: r.path };
    });
  }
  // 源名 a.pdf → a.docx（去掉目录与旧扩展名）；不用正则，避开模板字面量的反斜杠转义
  function convertSuggestedName(src, ext) {
    var p = String(src || '');
    var slash = p.lastIndexOf('/');
    var base = slash >= 0 ? p.substring(slash + 1) : p;
    var dot = base.lastIndexOf('.');
    if (dot > 0) { base = base.substring(0, dot); }
    if (!base) { base = 'Untitled'; }
    return base + '.' + ext;
  }
  // 反斜杠常量：注入脚本是 ArkTS 模板字面量，正则/字符串里直接写反斜杠会被吃掉一层
  // （文件里的 /\\/g 注入后变成未闭合的 //g → 整段 PROMISE_SHIM SyntaxError）。
  // 需要按反斜杠切分时一律用本常量，不写转义。
  var BS = String.fromCharCode(92);
  // Markdown「导出为 Word」的文件名：对齐桌面 markdown-main.ts（非法字符换成 _、截 80 字、补 .docx）。
  // 后缀判断走字符串比较而不是 /.docx$/：模板字面量会吃掉一层反斜杠（同 convertSuggestedName 的注释）。
  // 反斜杠统一用 BS 常量处理，不在正则里写 \\ —— 注入脚本是 ArkTS 模板字面量，写进去会被吃一层：
  // 文件里的 /\\/g 注入后变成 //g（未闭合正则，整段脚本 SyntaxError，本轮实测踩过）。
  function markdownDocxName(suggested) {
    var base = String(suggested || '').split(BS).join('_').replace(/[/:*?"<>|]/g, '_').slice(0, 80).trim();
    if (!base) { base = '未命名'; }
    if (base.toLowerCase().slice(-5) !== '.docx') { base = base + '.docx'; }
    return base;
  }
  // ===== 本地图片：解析 / 读字节 / 另存（markdown readImage 与两侧 saveImageAs 共用）=====
  // 桌面 readImage 语义（markdown-main.ts）：带 scheme 的 src 一律 null；相对路径按「文档所在目录」
  // 解析且必须落在该目录内（resolveSafeRelativeImagePath + isPathInside，防 ../ 越界读任意文件）；
  // 扩展名只认 png/jpg/jpeg/gif（MIME_BY_EXT）；读不到 / 不是文件 → null（渲染层跳过该图，不崩）。
  // 壳内同款语义，两点差别：
  //   1) 授权模型：Picker 只授权被选中的那个 .md，读同目录图片会 EPERM → 首次失败时请用户授权
  //      文档所在目录（pickDirectory 会登记进 DesktopBridge._grantedDirs 并持久化），再重试一次；
  //      每个文档目录最多打扰一次（否则 N 张图弹 N 次框）。
  //   2) 读字节走 readLocalImageJson 而不是 openDocxPathJson：后者成功时会 pushRecent(uri) +
  //      登记 writable，用它读图会把 .png 塞进「最近打开」；前者按魔数嗅探 mime、限 PNG/JPEG/GIF、
  //      不碰最近列表，语义正好。注意它不做 activatePersistedGrants —— 但打开文档时的 readFile
  //      走 readDocxUri 已经激活过持久授权，所以轮到读图时授权是生效的。
  var MARKDOWN_IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif' };
  function markdownImageMime(name) {
    var s = String(name || '');
    var dot = s.lastIndexOf('.');
    if (dot < 0 || dot === s.length - 1) { return ''; }
    return MARKDOWN_IMAGE_MIME[s.substring(dot + 1).toLowerCase()] || '';
  }
  function uriBaseName(uri) {
    var s = String(uri || '');
    var slash = s.lastIndexOf('/');
    var name = (slash >= 0) ? s.substring(slash + 1) : s;
    try { name = decodeURIComponent(name); } catch (e) { /* 非法编码：按原样 */ }
    return name || 'image';
  }
  // 文档 URI + 相对 src → 同目录下的子 URI。绝对路径 / 带 scheme / 退到文档目录之上 → null
  function markdownResolveImageUri(docUri, src) {
    var s = String(src || '');
    if (!s) { return null; }
    try { s = decodeURIComponent(s); } catch (e) { /* 非法百分号编码：按原样处理 */ }
    s = s.split(BS).join('/');
    if (s.charAt(0) === '/' || /^[a-z][a-z0-9+.-]*:/i.test(s)) { return null; }
    var d = String(docUri || '');
    var slash = d.lastIndexOf('/');
    if (slash <= 0) { return null; }
    var segs = d.substring(0, slash).split('/');
    var baseDepth = segs.length;
    var parts = s.split('/');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p === '' || p === '.') { continue; }
      if (p === '..') {
        // 退到文档目录之上＝越界（对齐桌面 isPathInside）：拒绝，不静默夹取到目录根
        if (segs.length - 1 < baseDepth) { return null; }
        segs.pop();
        continue;
      }
      segs.push(p);
    }
    // 归一化后仍不深于文档目录（src 形如 './' 或 'a/..'）→ 指向目录而非文件，拒绝
    if (segs.length <= baseDepth) { return null; }
    // 目录段沿用原 URI 的编码（Picker 返回的非 ASCII 是百分号编码，改了就读不到），
    // 新增段按段编码并还原冒号（与渲染层 resolveImageSrc 的 encodeSegment 一致）
    var out = [];
    for (var k = 0; k < segs.length; k++) {
      out.push(k < baseDepth ? segs[k] : encodeURIComponent(segs[k]).replace(/%3A/gi, ':'));
    }
    return out.join('/');
  }
  function readImageBytes(uri) {
    return goJson('readLocalImageJson', [uri]).then(function (r) {
      if (!r || !r.base64) {
        if (r && r.error) { console.info('[GenOffice] readImageBytes: ' + r.error + ' (' + uri + ')'); }
        return null;
      }
      return { b64: r.base64, mime: r.mediaType || markdownImageMime(uriBaseName(uri)) || 'image/png', name: uriBaseName(uri) };
    }).catch(function (e) {
      console.error('[GenOffice] readImageBytes failed: ' + (e && e.message ? e.message : e));
      return null;
    });
  }
  // md-asset:// → 可读 URI。渲染层把本地图片显示成这个自定义协议（桌面由
  // protocol.handle('md-asset') 供字节，见 apps/markdown/src/main/markdown-main.ts:667）；
  // ArkWeb 壳内没有该协议处理器，所以要自己把它还原成能读的 URI。
  // 壳内文档路径是 file://docs/... 形态 → 拼出来的 md-asset 里会带嵌套 scheme，两种都要认。
  function mdAssetToUri(s) {
    var p = String(s || '');
    if (p.substring(0, 11) !== 'md-asset://') { return ''; }
    p = p.substring(11);
    if (p.charAt(0) === '/') { p = p.substring(1); }
    try { p = decodeURIComponent(p); } catch (e) { /* 非法百分号编码：按原样 */ }
    if (!p) { return ''; }
    return p.indexOf('://') > 0 ? p : ('file://docs' + (p.charAt(0) === '/' ? '' : '/') + p);
  }
  // 目录授权的基准目录：优先文档所在目录（readImage 的相对路径解析基准），
  // 没有文档时退到图片自身的父目录（md-asset 显示链可能是绝对路径）。
  function markdownImgGrantDirOf(uri) {
    var base = markdownDocPath || String(uri || '');
    var slash = String(base).lastIndexOf('/');
    return (slash > 0) ? String(base).substring(0, slash) : '';
  }
  // 带一次性目录授权的读图：Picker 只授权被选中的那个文件，读同目录图片会 EPERM →
  // 首次失败请用户授权所在目录（pickDirectory 会登记进 _grantedDirs 并持久化），再重试一次。
  // markdownImgGrantDir 保证每个目录只问一次（否则 N 张图弹 N 次系统框）。
  function readImageBytesAuthorized(uri) {
    return readImageBytes(uri).then(function (got) {
      if (got) { return got; }
      var dir = markdownImgGrantDirOf(uri);
      if (!dir || markdownImgGrantDir === dir) { return null; }
      markdownImgGrantDir = dir;
      console.info('[GenOffice] 读图需要目录授权（单文件授权读不到同目录图片）：' + dir);
      return goJson('pickDirectory', []).then(function (pr) {
        if (!pr || !pr.ok || !pr.uri) { return null; }
        return readImageBytes(uri);
      }).catch(function (e) {
        console.error('[GenOffice] 目录授权失败: ' + (e && e.message ? e.message : e));
        return null;
      });
    });
  }
  // 图片字节来源分流：data: / md-asset:// / http(s): / 带 scheme 的 URI / 相对路径
  function imageBytesFromSrc(src, docUri) {
    var s = String(src || '');
    if (!s) { return Promise.resolve(null); }
    if (s.substring(0, 5) === 'data:') {
      var comma = s.indexOf(',');
      if (comma < 0) { return Promise.resolve(null); }
      var meta = s.substring(5, comma);
      // 只支持 base64 形式；未编码的 URL-escaped 文本不是图片字节
      if (!/;base64$/i.test(meta)) { return Promise.resolve(null); }
      var dm = /;base64$/i.exec(meta);
      return Promise.resolve({
        b64: s.substring(comma + 1),
        mime: meta.substring(0, dm.index) || 'image/png',
        name: 'image.' + ((/png/i.test(meta) && 'png') || (/gif/i.test(meta) && 'gif') || 'jpg'),
      });
    }
    if (s.substring(0, 11) === 'md-asset://') {
      var assetUri = mdAssetToUri(s);
      return assetUri ? readImageBytesAuthorized(assetUri) : Promise.resolve(null);
    }
    if (/^https?:/i.test(s)) {
      return fetch(s).then(function (r) {
        if (!r || !r.ok) { throw new Error('http ' + (r ? r.status : 'no-response')); }
        return r.arrayBuffer();
      }).then(function (ab) {
        return { b64: bufToB64(new Uint8Array(ab)), mime: 'image/jpeg', name: uriBaseName(s.split('?')[0]) };
      }).catch(function (e) {
        console.error('[GenOffice] saveImageAs fetch failed: ' + (e && e.message ? e.message : e));
        return null;
      });
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) { return readImageBytes(s); }
    var rel = markdownResolveImageUri(docUri, s);
    return rel ? readImageBytes(rel) : Promise.resolve(null);
  }
  // frame 内自绘提示（单按钮）：saveImageAs 是 void 调用，渲染层不看返回值 —— 失败必须可见，
  // 否则又回到「点了没反应」。样式/交互沿用 showCsvKeepFormatChoice（onclick 而非 addEventListener：
  // 门禁 harness 的 DOM stub 只提供 onclick）。
  var frameNoticeEl = null;
  function showFrameNotice(title, detail) {
    try {
      if (frameNoticeEl) { frameNoticeEl.remove(); frameNoticeEl = null; }
      var ov = document.createElement('div');
      ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:2147483001;display:flex;align-items:center;justify-content:center';
      var box = document.createElement('div');
      box.style.cssText = 'background:#fff;border-radius:10px;padding:20px 24px;max-width:420px;box-shadow:0 10px 40px rgba(0,0,0,.25);font:13px/1.5 system-ui,sans-serif;color:#202124';
      var t = document.createElement('div');
      t.textContent = String(title || '提示');
      t.style.cssText = 'margin-bottom:8px;font-weight:600';
      var d = document.createElement('div');
      d.textContent = String(detail || '');
      d.style.cssText = 'margin-bottom:16px;color:#5f6368;word-break:break-all';
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:flex-end';
      var b = document.createElement('button');
      b.textContent = '知道了';
      b.style.cssText = 'padding:6px 14px;border-radius:6px;border:1px solid #d0d4da;background:#1a73e8;color:#fff;cursor:pointer;font:13px/1.2 system-ui,sans-serif';
      var close = function () { if (frameNoticeEl) { frameNoticeEl.remove(); frameNoticeEl = null; } };
      b.onclick = function (e) { e.stopPropagation(); close(); };
      ov.onclick = function (e) { if (e.target === ov) { close(); } };
      row.appendChild(b);
      box.appendChild(t); box.appendChild(d); box.appendChild(row);
      ov.appendChild(box);
      (document.body || document.documentElement).appendChild(ov);
      frameNoticeEl = ov;
    } catch (e) {
      console.error('[GenOffice] showFrameNotice failed: ' + (e && e.message ? e.message : e));
    }
  }
  // 「另存为图片」：拿到字节 → 系统保存框写盘；拿不到字节给可见原因（渲染层 void 调用，不会提示）
  function saveImageFromSrc(src, docUri) {
    return imageBytesFromSrc(src, docUri).then(function (got) {
      if (!got || !got.b64) {
        showFrameNotice('无法保存图片', '取不到图片字节。来源：' + String(src || '(空)').slice(0, 120));
        return { ok: false, error: 'image bytes unavailable' };
      }
      var name = got.name || 'image.png';
      if (name.indexOf('.') < 0) { name = name + '.png'; }
      return goJson('saveAsAnyJson', [name, got.b64]).then(function (r) {
        r = r || { ok: false, error: 'file bridge unavailable' };
        if (r.ok && r.canceled) { return { ok: true, canceled: true }; }
        if (!r.ok || !r.path) {
          showFrameNotice('保存图片失败', String(r.error || 'write failed'));
          return { ok: false, error: String(r.error || 'write failed') };
        }
        return { ok: true, path: r.path };
      });
    }).catch(function (e) {
      showFrameNotice('保存图片失败', (e && e.message) ? e.message : String(e));
      return { ok: false, error: (e && e.message) ? e.message : String(e) };
    });
  }
  // ===== md-asset:// 本地图片显示（markdown frame 专属，D-4）=====
  // 渲染层把本地图片显示成 md-asset://<path>（桌面由 protocol.handle('md-asset') 供字节，
  // 见 apps/markdown/src/main/markdown-main.ts:667）。ArkWeb 壳内没有该协议处理器 →
  // 编辑器里的本地图片全裂（但导出 .docx 正常，因为导出走桥读字节，是另一条路）。
  // 这里不改渲染层（避免重打包 + 与上游冲突），也不动 ArkTS 的 scheme 注册
  // （customizeSchemes 时机敏感，失败会影响整个 Web 初始化）：在 markdown frame 内监听 DOM，
  // 把 md-asset 的 img src 换成 blob: URL，字节经 readLocalImageJson 取（复用 readImage 的
  // 授权与白名单规则）。代价：图片异步出现（先裂一下再补上），可接受。
  var mdAssetBlobUrls = {};   // 原始 src → blob URL（同一张图多处引用只读一次）
  var mdAssetInFlight = {};   // 原始 src → true（并发去重）
  function mdAssetUpgradeImg(img) {
    try {
      if (!img || img.nodeType !== 1 || img.nodeName !== 'IMG') { return; }
      var raw = img.getAttribute('src') || '';
      if (raw.substring(0, 11) !== 'md-asset://') { return; }
      if (mdAssetBlobUrls[raw]) { img.src = mdAssetBlobUrls[raw]; return; }
      if (mdAssetInFlight[raw]) { return; }
      var uri = mdAssetToUri(raw);
      if (!uri) { return; }
      if (typeof Blob === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) { return; }
      mdAssetInFlight[raw] = true;
      readImageBytesAuthorized(uri).then(function (got) {
        delete mdAssetInFlight[raw];
        if (!got || !got.b64) { return; }   // 读不到就保持原样（裂图），不反复重试
        var blob = new Blob([b64ToBuf(got.b64)], { type: got.mime || 'image/png' });
        var url = URL.createObjectURL(blob);
        mdAssetBlobUrls[raw] = url;
        // 期间渲染层若已改过 src（换文档/撤销），不要覆盖它的新值
        if ((img.getAttribute('src') || '') === raw) { img.src = url; }
      }).catch(function (e) {
        delete mdAssetInFlight[raw];
        console.error('[GenOffice] md-asset 图片读取失败: ' + (e && e.message ? e.message : e));
      });
    } catch (e) { /* 单张图失败不影响其余 */ }
  }
  function mdAssetScan(root) {
    try {
      if (!root) { return; }
      mdAssetUpgradeImg(root);
      if (root.querySelectorAll) {
        var list = root.querySelectorAll('img[src^="md-asset://"]');
        for (var i = 0; i < list.length; i++) { mdAssetUpgradeImg(list[i]); }
      }
    } catch (e) { /* 忽略 */ }
  }
  function installMdAssetImages() {
    try {
      // 只在 markdown frame 装：其它 app 不产生 md-asset URL，白挂 MutationObserver 是纯开销
      if (typeof MutationObserver === 'undefined') { return; }
      var href = '';
      try { href = String((typeof location !== 'undefined' && location.href) || ''); } catch (e) { href = ''; }
      if (href.indexOf('/web/markdown/') < 0) { return; }
      var start = function () {
        try {
          var root = document.documentElement || document.body;
          if (!root) { return; }
          mdAssetScan(document);
          var mo = new MutationObserver(function (records) {
            for (var i = 0; i < records.length; i++) {
              var r = records[i];
              if (!r) { continue; }
              if (r.type === 'attributes') { mdAssetUpgradeImg(r.target); continue; }
              var added = r.addedNodes || [];
              for (var k = 0; k < added.length; k++) { mdAssetScan(added[k]); }
            }
          });
          // attributeFilter 限定 src：编辑器重渲染频繁，不限定会拿到大量无关记录
          mo.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
          console.info('[GenOffice] md-asset 图片显示桥已启用（markdown frame）');
        } catch (e) {
          console.error('[GenOffice] md-asset observer 安装失败: ' + (e && e.message ? e.message : e));
        }
      };
      if (document && document.documentElement) { start(); }
      else if (document && document.addEventListener) { document.addEventListener('DOMContentLoaded', start); }
    } catch (e) { /* 装不上就退化：图片不显示，其余功能不受影响 */ }
  }
  installMdAssetImages();
  // 转换结果在新标签页打开：壳内 openLocalPath（起始页「打开方式」同一条链路）。
  // iframe 里没有 openApp，沿 parent 链取顶层 __goOpenExternalPath（同 findNativeCaller 的走法）。
  function openConvertedInShell(p) {
    try {
      var w = window;
      while (w) {
        if (typeof w.__goOpenExternalPath === 'function') { return w.__goOpenExternalPath(p); }
        if (w === w.parent) { break; }
        w = w.parent;
      }
    } catch (e) {
      console.error('[GenOffice] open converted failed: ' + (e && e.message ? e.message : e));
    }
    return '';
  }
  // 结构化加载失败 → 可读原因（对齐桌面 pdfDocxLocalEncrypted/Unsupported/Corrupt 文案）
  function pdfConvertErrorMsg(e) {
    var code = (e && e.code) ? e.code : '';
    if (code === 'password-required') { return '该 PDF 受密码保护，本地转换无法打开'; }
    if (code === 'unsupported') { return '该 PDF 使用了证书等不支持的加密方式，无法本地转换'; }
    if (code === 'corrupt') { return 'PDF 内容损坏，无法本地转换'; }
    return (e && e.message) ? e.message : ('转换失败: ' + String(e));
  }
  // 签名库：ArkTS 磁盘持久化（filesDir/genoffice-pdf-signatures.json，语义见
  // DesktopBridge.addSavedSignatureJson：补 id/createdAt、同图去重、上限 10、原子写）。
  // 旧实现把 localStorage 当存储、且要求入参带 sig.id —— 渲染层传的是 SignatureData（无 id），
  // 于是「保存签名以便复用」在真机恒为空表（M7 修复）；localStorage 旧值一律不再读。
  function listSavedSignatures() {
    return goJson('listSavedSignaturesJson', []).then(function (r) {
      return Array.isArray(r) ? r : [];
    });
  }
  function addSavedSignature(sig) {
    return goJson('addSavedSignatureJson', [JSON.stringify(sig || {})]).then(function (r) {
      return Array.isArray(r) ? r : [];
    });
  }
  function removeSavedSignature(id) {
    return goJson('removeSavedSignatureJson', [String(id || '')]).then(function (r) {
      return Array.isArray(r) ? r : [];
    });
  }
  // PDF 关闭保存协议回调表（另存为/打印已泛化到 frameSaveAsFns / framePrintFns，
  // 见本文件「壳 chrome 菜单 → 本 frame 渲染层命令」段）
  var pdfCloseSaveRequestFns = [];
  // AI 流：渲染层 AgentLoop 驱动循环（agent-core），壳在注入脚本里跑 provider HTTP。
  // 桌面版由 Electron 主进程跑 packages/ai-provider（三协议）；壳内引不了那个包（依赖 node:fs /
  // 子进程）→ 这里实现两条线：OpenAI 兼容 chat/completions + Anthropic messages(/v1/messages，
  // x-api-key + anthropic-version)。这两条覆盖「自填 baseUrl + 自填模型 id」能碰到的绝大多数
  // 网关（含各类 token plan / 订阅转 API 中转站）。通道挂在 base mock 上，所有 app 共享。
  var aiStreamListeners = [];
  var aiAborters = {};
  function pushAiChunk(chunk) {
    var fns = aiStreamListeners;
    for (var i = 0; i < fns.length; i++) {
      try { fns[i](chunk); } catch (e) { /* 监听者异常不影响流 */ }
    }
  }
  var AI_ANTHROPIC_VERSION = '2023-06-01';
  var AI_ANTHROPIC_DEFAULT_BASE = 'https://api.anthropic.com/v1';
  // 兜底输出上限：Anthropic 的 max_tokens 是必填项，缺了就 400。
  var AI_DEFAULT_MAX_TOKENS = 8192;
  // 各家官方 OpenAI 兼容端点；用户填了 baseUrl 就完全以填的为准（token plan 网关走这条）。
  var AI_DEFAULT_BASE = {
    openai: 'https://api.openai.com/v1',
    deepseek: 'https://api.deepseek.com/v1',
    glm: 'https://open.bigmodel.cn/api/paas/v4',
    qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    doubao: 'https://ark.cn-beijing.volces.com/api/v3',
    kimi: 'https://api.moonshot.cn/v1',
    minimax: 'https://api.minimaxi.com/v1',
    xai: 'https://api.x.ai/v1',
    mistral: 'https://api.mistral.ai/v1',
    openrouter: 'https://openrouter.ai/api/v1',
    // Gemini 也有 OpenAI 兼容路径，指到它才能用同一条通道（原生 generateContent 协议未接）
    gemini: 'https://generativelanguage.googleapis.com/v1beta/openai'
  };
  // 协议判定：provider id 为主（选 Claude 即走 messages 协议），其次看 baseUrl 里有没有
  // anthropic 字样（不少 Claude 中转站直接沿用它的域名/路径形态）。
  function aiProtocolFor(pid, base) {
    if (pid === 'anthropic') { return 'anthropic'; }
    if (base && base.indexOf('anthropic') >= 0) { return 'anthropic'; }
    return 'openai';
  }
  function aiTrimSlashes(s) {
    var out = s || '';
    while (out.length > 0 && out.charAt(out.length - 1) === '/') { out = out.substring(0, out.length - 1); }
    return out;
  }
  function aiResolveEndpoint(settings) {
    var s = settings || loadAiSettings();
    var pid = (s && s.provider) || '';
    // 渲染层带回来的 provider 可能是移植版已移除的 id（genspark / codex，桌面把它当「未配置」的
    // 兜底返回值），或压根没有本机配置 → 一律落回本机存储的选择，不要让请求打到空端点。
    if (!pid || pid === 'genspark' || pid === 'codex' || !(s.providers && s.providers[pid])) {
      var stored = loadAiSettings();
      pid = stored.provider;
      if (s && s.providers && s.providers[pid]) { s = { provider: pid, providers: s.providers }; }
      else { s = stored; }
    }
    var pc = (s && s.providers && s.providers[pid]) || {};
    var base = (pc.baseUrl && pc.baseUrl.trim()) ? pc.baseUrl.trim()
      : (pid === 'anthropic' ? AI_ANTHROPIC_DEFAULT_BASE : (AI_DEFAULT_BASE[pid] || ''));
    // AUTO 开关：渲染层有时只回传 providers（不含 autoModel），那时按本机存储的开关走，
    // 免得"设置里开了 AUTO、真机却不生效"。
    var autoOn = (s && typeof s.autoModel === 'boolean') ? s.autoModel : !!loadAiSettings().autoModel;
    return {
      pid: pid,
      protocol: aiProtocolFor(pid, base),
      base: aiTrimSlashes(base),
      key: pc.apiKey || '',
      model: autoOn ? aiAutoChatModel(pc) : (pc.model || ''),
      auto: autoOn,
      maxTokens: s && s.maxOutputTokens ? s.maxOutputTokens : 0
    };
  }
  // AUTO 模型：从「本机已配的模型」里挑，而不是钉死 model 字段。文本对话优先用户自存列表的
  // 第一项（他把想用的排在前面），没有列表就回落到 model 字段。生图/媒体解析不在此列 ——
  // 那条链走 media 配置的 imageModel/analysisModel。
  function aiAutoChatModel(pc) {
    var list = sanitizeModelList(pc && pc.models);
    if (list.length) { return list[0]; }
    return (pc && pc.model) || '';
  }
  // AgentImage 契约是 base64 + mime（不是 dataUrl）；两个字段都收，渲染层版本差异不至于把图丢掉。
  function aiImageInfo(img) {
    if (!img) { return null; }
    var b64 = img.base64 || img.b64 || '';
    var mime = img.mime || '';
    if (!b64 && img.dataUrl) {
      var head = img.dataUrl.indexOf(',');
      if (head < 0) { return null; }
      var meta = img.dataUrl.substring(0, head);
      var colon = meta.indexOf(':');
      var semi = meta.indexOf(';');
      if (colon >= 0 && semi > colon) { mime = meta.substring(colon + 1, semi); }
      b64 = img.dataUrl.substring(head + 1);
    }
    if (!b64) { return null; }
    if (!mime) { mime = 'image/png'; }
    return { mime: mime, base64: b64, dataUrl: 'data:' + mime + ';base64,' + b64 };
  }
  function aiToolOutputText(res) {
    var out = res && res.output;
    if (typeof out === 'string') { return out; }
    try { return JSON.stringify(out === undefined ? '' : out); } catch (e) { return String(out); }
  }
  // AgentMessage → OpenAI 消息（tool 轮会展开成多条 role:tool）
  function aiPushOpenAi(list, m) {
    if (!m) { return; }
    if (m.role === 'tool') {
      var rs = m.results || [];
      for (var r = 0; r < rs.length; r++) {
        list.push({ role: 'tool', tool_call_id: rs[r].id, content: aiToolOutputText(rs[r]) });
      }
      return;
    }
    if (m.role === 'user') {
      var parts = [];
      if (m.text) { parts.push({ type: 'text', text: m.text }); }
      var ims = m.images || [];
      for (var i = 0; i < ims.length; i++) {
        var info = aiImageInfo(ims[i]);
        if (info) { parts.push({ type: 'image_url', image_url: { url: info.dataUrl } }); }
      }
      list.push({ role: 'user', content: parts.length > 0 ? parts : (m.text || '') });
      return;
    }
    var msg = { role: 'assistant', content: m.text || '' };
    var tcs = m.toolCalls || [];
    if (tcs.length > 0) {
      msg.tool_calls = [];
      for (var j = 0; j < tcs.length; j++) {
        msg.tool_calls.push({
          id: tcs[j].id,
          type: 'function',
          function: { name: tcs[j].name, arguments: JSON.stringify(tcs[j].input || {}) }
        });
      }
    }
    list.push(msg);
  }
  // AgentMessage → Anthropic 消息（tool 轮换写成 user 轮的 tool_result 块，这是它的协议要求）
  function aiPushAnthropic(list, m) {
    if (!m) { return; }
    if (m.role === 'tool') {
      var blocks = [];
      var rs = m.results || [];
      for (var r = 0; r < rs.length; r++) {
        blocks.push({
          type: 'tool_result',
          tool_use_id: rs[r].id,
          content: aiToolOutputText(rs[r]),
          is_error: rs[r].isError ? true : false
        });
      }
      if (blocks.length > 0) { list.push({ role: 'user', content: blocks }); }
      return;
    }
    if (m.role === 'user') {
      var parts = [];
      if (m.text) { parts.push({ type: 'text', text: m.text }); }
      var ims = m.images || [];
      for (var i = 0; i < ims.length; i++) {
        var info = aiImageInfo(ims[i]);
        if (info) {
          parts.push({ type: 'image', source: { type: 'base64', media_type: info.mime, data: info.base64 } });
        }
      }
      if (parts.length > 0) { list.push({ role: 'user', content: parts }); }
      return;
    }
    var ablocks = [];
    if (m.text) { ablocks.push({ type: 'text', text: m.text }); }
    var tcs = m.toolCalls || [];
    for (var j = 0; j < tcs.length; j++) {
      ablocks.push({ type: 'tool_use', id: tcs[j].id, name: tcs[j].name, input: tcs[j].input || {} });
    }
    if (ablocks.length > 0) { list.push({ role: 'assistant', content: ablocks }); }
  }
  // AgentToolDef 的 schema 字段是 inputSchema（旧代码读 parameters → 工具描述一直是空的）
  function aiOpenAiTool(t) {
    return {
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.inputSchema || t.parameters || { type: 'object', properties: {} }
      }
    };
  }
  function aiAnthropicTool(t) {
    return {
      name: t.name,
      description: t.description || '',
      input_schema: t.inputSchema || t.parameters || { type: 'object', properties: {} }
    };
  }
  // 流结束时把累积的 tool_call 片段一次性发出（OpenAI 是分片 name/arguments，Anthropic 是
  // input_json_delta）→ 两家共用这套累加器：{ id, name, args }
  function aiFlushToolCalls(requestId, accTool) {
    var keys = Object.keys(accTool);
    for (var i = 0; i < keys.length; i++) {
      var tc = accTool[keys[i]];
      if (!tc || !tc.name) { continue; }
      var input = {};
      var broken = false;
      if (tc.args) {
        try { input = JSON.parse(tc.args); } catch (e) { broken = true; }
      }
      pushAiChunk({
        requestId: requestId, type: 'tool-call',
        toolCall: {
          id: tc.id, name: tc.name, input: input,
          inputError: broken ? 'harmony: incomplete tool args' : undefined
        }
      });
    }
  }
  function aiHeaders(ep, stream) {
    var h = { 'Content-Type': 'application/json' };
    if (ep.protocol === 'anthropic') {
      h['x-api-key'] = ep.key;
      h['anthropic-version'] = AI_ANTHROPIC_VERSION;
    } else {
      h['Authorization'] = 'Bearer ' + ep.key;
    }
    return h;
  }
  function aiUrlFor(ep) {
    return ep.protocol === 'anthropic' ? ep.base + '/messages' : ep.base + '/chat/completions';
  }
  function aiBodyFor(ep, req, stream) {
    var list = [];
    var ms = req.messages || [];
    var push = ep.protocol === 'anthropic' ? aiPushAnthropic : aiPushOpenAi;
    for (var i = 0; i < ms.length; i++) { push(list, ms[i]); }
    var body = { model: ep.model, messages: list, stream: stream };
    if (ep.protocol === 'anthropic') {
      if (req.system) { body.system = req.system; }
      // Anthropic 的 max_tokens 必填
      body.max_tokens = req.maxTokens || ep.maxTokens || AI_DEFAULT_MAX_TOKENS;
    } else if (req.system) {
      list.unshift({ role: 'system', content: req.system });
    }
    var tools = req.tools || [];
    if (tools.length > 0) {
      body.tools = [];
      for (var j = 0; j < tools.length; j++) {
        body.tools.push(ep.protocol === 'anthropic' ? aiAnthropicTool(tools[j]) : aiOpenAiTool(tools[j]));
      }
    }
    return body;
  }
  // 非流式兜底（浏览器 fetch 被 CORS 拦时的第二条路）：经 ArkTS 原生 HTTP 发一次 stream=false
  // 请求，整段回灌成 delta / tool-call / done。代价是没有逐字输出，换来「至少能用」。
  function aiStreamNative(requestId, ep, req) {
    var body = aiBodyFor(ep, req, false);
    return goJson('aiPostJson', [aiUrlFor(ep), JSON.stringify(aiHeaders(ep)), JSON.stringify(body)]).then(function (r) {
      if (!r || r.status < 200 || r.status >= 300) {
        pushAiChunk({
          requestId: requestId, type: 'error',
          error: 'AI 服务返回 HTTP ' + (r ? r.status : '?') + '：' + String((r && r.text) || '').slice(0, 300)
        });
        return;
      }
      var j = null;
      try { j = JSON.parse(r.text); } catch (e) { j = null; }
      if (!j) {
        pushAiChunk({ requestId: requestId, type: 'error', error: 'AI 响应不是 JSON（网关返回了非预期内容）' });
        return;
      }
      if (ep.protocol === 'anthropic') {
        var blocks = j.content || [];
        for (var i = 0; i < blocks.length; i++) {
          var b = blocks[i];
          if (!b) { continue; }
          if (b.type === 'text' && b.text) { pushAiChunk({ requestId: requestId, type: 'delta', text: b.text }); }
          if (b.type === 'tool_use') {
            pushAiChunk({ requestId: requestId, type: 'tool-call', toolCall: { id: b.id, name: b.name, input: b.input || {} } });
          }
        }
        pushAiChunk({ requestId: requestId, type: 'done', stopReason: j.stop_reason || 'stop' });
        return;
      }
      var choice = (j.choices && j.choices[0]) || {};
      var msgc = choice.message || {};
      if (msgc.content) { pushAiChunk({ requestId: requestId, type: 'delta', text: msgc.content }); }
      var tcs = msgc.tool_calls || [];
      for (var k = 0; k < tcs.length; k++) {
        var tc = tcs[k] || {};
        var fn = tc.function || {};
        var input = {};
        var broken = false;
        if (fn.arguments) { try { input = JSON.parse(fn.arguments); } catch (e2) { broken = true; } }
        pushAiChunk({
          requestId: requestId, type: 'tool-call',
          toolCall: {
            id: tc.id, name: fn.name, input: input,
            inputError: broken ? 'harmony: incomplete tool args' : undefined
          }
        });
      }
      pushAiChunk({ requestId: requestId, type: 'done', stopReason: choice.finish_reason || 'stop' });
    });
  }
  function aiStreamRun(req) {
    req = req || {};
    var requestId = req.requestId;
    var ep = aiResolveEndpoint(req.settings);
    if (!ep.base || !ep.key || !ep.model) {
      pushAiChunk({
        requestId: requestId, type: 'error',
        error: 'AI 未配置：请在 设置 - AI 模型 里补齐 API Key / 模型 id（当前 provider=' + ep.pid + '，端点=' + (ep.base || '空') + '）'
      });
      return Promise.resolve();
    }
    var body = aiBodyFor(ep, req, true);
    var ctrl = new AbortController();
    aiAborters[requestId] = ctrl;
    pushAiChunk({ requestId: requestId, type: 'ping' });
    return fetch(aiUrlFor(ep), {
      method: 'POST',
      headers: aiHeaders(ep),
      body: JSON.stringify(body),
      signal: ctrl.signal
    }).then(function (resp) {
      if (!resp || !resp.ok) {
        return resp.text().catch(function () { return ''; }).then(function (t) {
          pushAiChunk({
            requestId: requestId, type: 'error',
            error: 'AI 服务返回 HTTP ' + (resp ? resp.status : '?') + '：' + String(t).slice(0, 300)
          });
        });
      }
      if (!resp.body || !resp.body.getReader) {
        pushAiChunk({ requestId: requestId, type: 'error', error: 'AI 响应没有可读的流式数据体（该网关可能不支持 stream=true）' });
        return;
      }
      return aiReadSse(requestId, ep, resp.body.getReader());
    }).catch(function (e) {
      if (e && (e.name === 'AbortError' || e.code === 20)) { return; }
      // 端点不可达 / CORS 被拦 → 转原生通道（不再直接报错给用户）
      return aiStreamNative(requestId, ep, req);
    }).then(function () {
      delete aiAborters[requestId];
    });
  }
  function aiStreamCancel(requestId) {
    var c = aiAborters[requestId];
    if (c) { try { c.abort(); } catch (e) { /* 忽略 */ } }
  }
  function aiOnStream(fn) {
    aiStreamListeners.push(fn);
    return function () {
      aiStreamListeners = aiStreamListeners.filter(function (f) { return f !== fn; });
    };
  }
  // 搜索参数（provider + key）传给原生：Key 只存在于 localStorage，ArkTS 侧读不到。
  // 形状与上游 AiSearchSettings 对齐（serper / tavily / parallel；genspark 已移除）。
  function aiSearchOptsJson() {
    var s = loadAiSettings();
    var se = (s && s.search) || {};
    var pid = se.provider === 'tavily' || se.provider === 'parallel' ? se.provider : 'serper';
    var pc = (se.providers && se.providers[pid]) || {};
    return JSON.stringify({ provider: pid, apiKey: pc.apiKey || '' });
  }
  // SSE 逐行解析：OpenAI 的 delta / tool_calls 分片与 Anthropic 的 content_block_* 事件
  // 归一到同一套 chunk（delta / reasoning / tool-call / done），两家共用累加器与收尾。
  function aiReadSse(requestId, ep, reader) {
    var dec = new TextDecoder();
    var buf = '';
    var accTool = {};
    var finished = false;
    var stopReason = '';
    var maybeFinish = function (reason) {
      if (finished) { return; }
      finished = true;
      aiFlushToolCalls(requestId, accTool);
      pushAiChunk({ requestId: requestId, type: 'done', stopReason: reason || stopReason || 'stop' });
    };
    var handle = function (data) {
      var j = null;
      try { j = JSON.parse(data); } catch (e) { return; }
      if (!j) { return; }
      if (ep.protocol === 'anthropic') {
        if (j.type === 'content_block_start') {
          var cb = j.content_block || {};
          if (cb.type === 'tool_use') {
            var ai = j.index || 0;
            accTool[ai] = { id: cb.id || '', name: cb.name || '', args: '' };
          }
          return;
        }
        if (j.type === 'content_block_delta') {
          var dl = j.delta || {};
          if (dl.type === 'text_delta' && dl.text) { pushAiChunk({ requestId: requestId, type: 'delta', text: dl.text }); }
          if (dl.type === 'thinking_delta' && dl.thinking) { pushAiChunk({ requestId: requestId, type: 'reasoning', text: dl.thinking }); }
          if (dl.type === 'input_json_delta' && dl.partial_json) {
            var bi = j.index || 0;
            var acc = accTool[bi] || (accTool[bi] = { id: '', name: '', args: '' });
            acc.args += dl.partial_json;
          }
          return;
        }
        if (j.type === 'message_delta') {
          var md = j.delta || {};
          if (md.stop_reason) { stopReason = md.stop_reason; }
          return;
        }
        if (j.type === 'message_stop') { maybeFinish('stop'); return; }
        if (j.type === 'error') {
          var er = j.error || {};
          pushAiChunk({ requestId: requestId, type: 'error', error: 'AI 服务报错 ' + (er.type || 'error') + ': ' + (er.message || '') });
          return;
        }
        return;
      }
      var c = j.choices && j.choices[0];
      if (!c) { return; }
      var d = c.delta;
      if (d) {
        if (d.content) { pushAiChunk({ requestId: requestId, type: 'delta', text: d.content }); }
        if (d.reasoning_content) { pushAiChunk({ requestId: requestId, type: 'reasoning', text: d.reasoning_content }); }
        if (d.tool_calls) {
          for (var ti = 0; ti < d.tool_calls.length; ti++) {
            var tc = d.tool_calls[ti];
            if (!tc) { continue; }
            var idx = tc.index || 0;
            var acc2 = accTool[idx] || (accTool[idx] = { id: '', name: '', args: '' });
            if (tc.id && !acc2.id) { acc2.id = tc.id; }
            if (tc.function) {
              if (tc.function.name) { acc2.name += tc.function.name; }
              if (tc.function.arguments) { acc2.args += tc.function.arguments; }
            }
          }
        }
      }
      if (c.finish_reason) { maybeFinish(c.finish_reason); }
    };
    var pump = function () {
      return reader.read().then(function (r) {
        if (r.done) { maybeFinish(); return; }
        buf += dec.decode(r.value, { stream: true });
        var nl;
        while ((nl = buf.indexOf('\\n')) >= 0) {
          var line = buf.slice(0, nl).replace(/\\r$/, '').trim();
          buf = buf.slice(nl + 1);
          if (!line || line.indexOf('data:') !== 0) { continue; }
          var data = line.slice(5).trim();
          if (data === '[DONE]') { maybeFinish(); return; }
          handle(data);
          if (finished) { return; }
        }
        return pump();
      });
    };
    return pump();
  }

  var pdfMock = Object.assign({}, mock, {
    readFile: function (p) {
      return goJson('openDocxPathJson', [p]).then(function (r) {
        if (!r || !r.ok) {
          throw new Error((r && r.error) ? r.error : 'read failed');
        }
        return b64ToBuf(r.b64);
      });
    },
    // 静态表单填充记录：pdf-bridge 真读 PDF 内嵌 GenOfficeStaticFormFills；读失败/未注桥回退 []。
    listStaticFormFills: function (p) {
      if (!p) { return Promise.resolve([]); }
      return loadPdfBridge().then(function (mod) {
        return readPdfPathBytes(p).then(function (bytes) {
          return mod.readStaticFormFills(bytes);
        }, function () { return []; });
      }).catch(function () { return []; });
    },
    // 无 OCR 引擎（null → 渲染层停止自动 OCR）；无本地字体注册（Dropdown 停"原字体"）
    ocrPage: function () { return Promise.resolve(null); },
    listEditFonts: function () { return Promise.resolve([]); },
    gskStatus: function () { return Promise.reject(new Error('鸿蒙版没有 Genspark 账号通道')); },
    // 保存/另存（核心闭环）：pdf-bridge 应用编辑 —— 表单/标注/绘图/批注回复/图章/旋转/
    // 删页/重排/元数据/静态表单真写盘；文本/图片编辑缺 PDFium 管线 → 计入 skipped，
    // 渲染层有专门的 skipped 提示。targetPath 与 path 不同/缺失 → 系统保存选择器。
    // 文本插入：把壳侧已 init 的 PDFium 透给 pdf-bridge（与 pdf-convert 共用一份 wasm
    // 单例），走 PDFium 标准 14 字体真插入；PDFium 未就绪 → 全部 skipped。
    // 文本编辑/图片编辑仍依赖桌面级字体管线（Harmony 无系统字体 + 无 harfbuzz）→ skipped。
    // targetPath 与 path 不同/缺失 → 系统保存选择器。
    save: function (op) {
      op = op || {};
      var srcPath = op.path;
      // 另存为：targetPath 非空且 ≠ path（已选目标），或空字符串（渲染层 Ctrl+Shift+S
      // 走 saveAsTo('')→save({targetPath:''})，无预选目标）→ 弹系统保存选择器
      var wantsSaveAs = (typeof op.targetPath === 'string') && (op.targetPath === '' || op.targetPath !== srcPath);
      var outPath = wantsSaveAs ? (op.targetPath || '') : srcPath;
      // PDFium 获取闭包：复用 pdf-convert 已 init 的 PDFium 单例（缓存于 pdfiumPromise）。
      // pdf-convert 还没初始化（用户首开 PDF 没碰转换）→ 临时载入 + init；再缓存给下次。
      var getPdfium = function () { return loadPdfConvert().then(loadPdfium); };
      return loadPdfBridge().then(function (mod) {
        return readPdfPathBytes(srcPath).then(function (bytes) {
          return mod.applySaveEdits(bytes, op, getPdfium).then(function (res) {
            console.info('[GenOffice] pdf.save bridge applied: src=' + srcPath + ' in=' + bytes.length + ' out=' + res.bytes.length + ' skipped=' + ((res.skippedTextEdits || []).length + (res.skippedTextInserts || []).length + (res.skippedImageEdits || []).length));
            var write = (outPath === srcPath)
              ? writePdfBytesAt(outPath, res.bytes)
              : savePdfAsBytes(outPath, res.bytes);
            return write.then(function (r) {
              if (!r.ok) { console.error('[GenOffice] pdf.save write failed: ' + (r.error || '?') + ' target=' + outPath); return r; }
              console.info('[GenOffice] pdf.save written: ' + (r.path || outPath) + ' (saveAs=' + wantsSaveAs + ')');
              var out = { ok: true, path: r.path || outPath };
              if (res.skippedTextEdits && res.skippedTextEdits.length) { out.skippedTextEdits = res.skippedTextEdits; }
              if (res.skippedTextInserts && res.skippedTextInserts.length) { out.skippedTextInserts = res.skippedTextInserts; }
              if (res.skippedImageEdits && res.skippedImageEdits.length) { out.skippedImageEdits = res.skippedImageEdits; }
              return out;
            });
          });
        });
      }).catch(handlePdfOpErr);
    },
    // 回写类结构操作：读 → 引擎 → 写回原路径 → {ok:true}
    insertBlankPage: function (op) {
      var args = [op && op.afterPageIndex];
      return loadPdfBridge().then(function (mod) {
        return readPdfPathBytes(op.path).then(function (bytes) {
          return mod.insertBlankPageBytes.apply(null, [bytes].concat(args)).then(function (out) {
            return writePdfBytesAt(op.path, out);
          });
        });
      }).catch(handlePdfOpErr);
    },
    setPageSize: function (op) {
      return loadPdfBridge().then(function (mod) {
        return readPdfPathBytes(op.path).then(function (bytes) {
          return mod.setPageSizeBytes(bytes, op.width, op.height).then(function (out) {
            return writePdfBytesAt(op.path, out);
          });
        });
      }).catch(handlePdfOpErr);
    },
    cropPages: function (op) {
      return loadPdfBridge().then(function (mod) {
        return readPdfPathBytes(op.path).then(function (bytes) {
          return mod.cropPagesBytes(bytes, op.pages, op.rect).then(function (out) {
            return writePdfBytesAt(op.path, out);
          });
        });
      }).catch(handlePdfOpErr);
    },
    // 选择另一 PDF 后回写：insertPdf / replacePages
    insertPdf: function (op) {
      return pickPdfFile().then(function (other) {
        var chk = pdfPickCheck(other);
        if (chk) { return chk; }
        return loadPdfBridge().then(function (mod) {
          return readPdfPathBytes(op.path).then(function (bytes) {
            return mod.insertPdfBytes(bytes, other.bytes, op.afterPageIndex).then(function (r) {
              return writePdfBytesAt(op.path, r.merged).then(function (w) {
                if (!w.ok) { return w; }
                return { ok: true, insertedCount: r.count };
              });
            });
          });
        });
      }).catch(handlePdfOpErr);
    },
    replacePages: function (op) {
      return pickPdfFile().then(function (other) {
        var chk = pdfPickCheck(other);
        if (chk) { return chk; }
        return loadPdfBridge().then(function (mod) {
          return readPdfPathBytes(op.path).then(function (bytes) {
            return mod.replacePagesBytes(bytes, other.bytes, op.pages).then(function (r) {
              return writePdfBytesAt(op.path, r.merged).then(function (w) {
                if (!w.ok) { return w; }
                return { ok: true, removed: r.removed, inserted: r.inserted };
              });
            });
          });
        });
      }).catch(handlePdfOpErr);
    },
    // 输出新文件：弹保存选择器 → {ok:true, savedPath}（渲染层成功后 reload/提示）
    extractPages: function (op) {
      return loadPdfBridge().then(function (mod) {
        return readPdfPathBytes(op.path).then(function (bytes) {
          return mod.extractPagesBytes(bytes, op.pages).then(function (out) {
            return savePdfAsBytes(op.suggestedName, out);
          });
        });
      }).catch(handlePdfOpErr);
    },
    mergePages: function (op) {
      return loadPdfBridge().then(function (mod) {
        return readPdfPathBytes(op.path).then(function (bytes) {
          return mod.mergePagesBytes(bytes, {
            perSheet: op.perSheet,
            direction: op.direction === 'horizontal' ? 'horizontal' : 'vertical',
            separator: op.separator === true,
          }).then(function (out) {
            return savePdfAsBytes(op.suggestedName, out);
          });
        });
      }).catch(handlePdfOpErr);
    },
    splitPages: function (op) {
      return loadPdfBridge().then(function (mod) {
        return readPdfPathBytes(op.path).then(function (bytes) {
          return mod.splitPagesBytes(bytes, op.perPage).then(function (out) {
            return savePdfAsBytes(op.suggestedName, out);
          });
        });
      }).catch(handlePdfOpErr);
    },
    // 拆分到目录（弹目录选择器）：每 chunkSize 页一个文件 → {ok:true, savedDir, count}
    splitPdf: function (op) {
      return goJson('pickDirectory', []).then(function (r) {
        var dir = (r && (r.path || r.dir || r.uri)) ? (r.path || r.dir || r.uri) : null;
        if (!dir) {
          if (r && r.canceled) { return { ok: true, canceled: true }; }
          return { ok: false, error: 'directory pick canceled/unavailable' };
        }
        return loadPdfBridge().then(function (mod) {
          return readPdfPathBytes(op.path).then(function (bytes) {
            return mod.splitPdfBytes(bytes, op.chunkSize).then(function (parts) {
              var base = String(op.baseName || 'split').replace(/[/\\:*?"<>|]/g, '_');
              var chain = Promise.resolve({ ok: true });
              var saved = 0;
              for (var i = 0; i < parts.length; i++) {
                (function (idx, partBytes) {
                  chain = chain.then(function (acc) {
                    if (!acc.ok) { return acc; }
                    return goJson('saveInDirJson', [dir, base + '-' + (idx + 1) + '.pdf', bufToB64(partBytes)]).then(function (w) {
                      if (!w || !w.ok) { return { ok: false, error: (w && w.error) ? w.error : 'write failed: ' + idx }; }
                      saved++;
                      return { ok: true };
                    });
                  });
                })(i, parts[i]);
              }
              return chain.then(function (res) {
                if (!res.ok) { return res; }
                return { ok: true, savedDir: dir, count: saved };
              });
            });
          });
        });
      }).catch(handlePdfOpErr);
    },
    // 导出图片（功能区「开始」→ 导出图片）：渲染层已把各页画成 PNG（base64 无前缀），
    // 壳侧选目录后逐页落盘 → {ok:true, savedDir, count}（渲染层只认 ok/error，缺本方法时
    // Proxy 兜底返回 undefined → result.ok 抛错，点击表现为「无反应」，真机已踩）。
    exportImages: function (op) {
      op = op || {};
      var images = op.images || [];
      if (!images.length) { return Promise.resolve({ ok: false, error: 'no pages to export' }); }
      var base = String(op.baseName || 'page').replace(/[/:*?"<>|]/g, '_');
      var numbers = op.pageNumbers || [];
      return goJson('pickDirectory', []).then(function (r) {
        var dir = (r && (r.path || r.dir || r.uri)) ? (r.path || r.dir || r.uri) : null;
        if (!dir) {
          if (r && r.canceled) { return { ok: true, canceled: true }; }
          return { ok: false, error: 'directory pick canceled/unavailable' };
        }
        var chain = Promise.resolve({ ok: true });
        var saved = 0;
        for (var i = 0; i < images.length; i++) {
          (function (idx) {
            chain = chain.then(function (acc) {
              if (!acc.ok) { return acc; }
              var n = numbers[idx] || (idx + 1);
              // 导出目标是「已授权目录 + 新文件名」，从未进 writable → 必须走 saveInDirJson
              // （旧实现用 saveAnyJson 拼新路径，真机恒报 save target is not an opened document）
              return goJson('saveInDirJson', [dir, base + '-p' + n + '.png', images[idx]]).then(function (w) {
                if (!w || !w.ok) { return { ok: false, error: (w && w.error) ? w.error : ('write failed: ' + idx) }; }
                saved++;
                return { ok: true };
              });
            });
          })(i);
        }
        return chain.then(function (res) {
          if (!res.ok) { return res; }
          console.info('[GenOffice] pdf.exportImages written ' + saved + ' png → ' + dir);
          return { ok: true, savedDir: dir, count: saved };
        });
      }).catch(handlePdfOpErr);
    },
    // PDF 转换（功能区「开始」→ 转换 → Word/Excel/PowerPoint）：pdf2docx 引擎 + PDFium wasm
    // 全在壳内跑（无登录、无额度，与桌面本地转换同源）。渲染层 convertTo 之前只传 format，
    // 壳侧又没有本方法 → Proxy 兜底 resolve(undefined) → await 直接结束、catch 吞错，
    // 点击表现为「无反应」（用户报的 BUG#3）。现在改为 (format, path)：
    //   读字节 → 转换（首次含 pdfium wasm 载入）→ 另存为 .docx/.xlsx/.pptx → 新标签页打开
    // 返回结构化结果（渲染层据此提示成败/降级页），失败一律 {ok:false, error}，不再静默。
    convertOffice: function (format, path) {
      var fmt = String(format || '').toLowerCase();
      if (fmt !== 'docx' && fmt !== 'xlsx' && fmt !== 'pptx') {
        return Promise.resolve({ ok: false, error: 'unsupported format: ' + fmt });
      }
      var src = String(path || '');
      if (!src) {
        return Promise.resolve({ ok: false, error: '没有可转换的源文件路径' });
      }
      if (pdfConverting) {
        return Promise.resolve({ ok: false, busy: true, error: '转换进行中，请稍候' });
      }
      pdfConverting = true;
      var t0 = Date.now();
      console.info('[GenOffice] pdf.convertOffice start fmt=' + fmt + ' src=' + src);
      var finish = function (result) {
        pdfConverting = false;
        console.info('[GenOffice] pdf.convertOffice done fmt=' + fmt + ' ' + (Date.now() - t0) + 'ms ok=' + (!!(result && result.ok)) + ' err=' + ((result && result.error) ? result.error : '-'));
        return result;
      };
      return readPdfPathBytes(src).then(function (bytes) {
        console.info('[GenOffice] pdf.convertOffice source ' + bytes.length + 'B in ' + (Date.now() - t0) + 'ms');
        return loadPdfConvert().then(function (mod) {
          return loadPdfium(mod).then(function (pdfium) {
            var tConv = Date.now();
            var job = (fmt === 'docx')
              ? mod.convertPdfToDocx(bytes, { pdfium: pdfium })
              : ((fmt === 'xlsx')
                ? mod.convertPdfToXlsx(bytes, { pdfium: pdfium })
                : mod.convertPdfToPptx(bytes, { pdfium: pdfium }));
            return job.then(function (res) {
              var out = (fmt === 'docx') ? res.docx : ((fmt === 'xlsx') ? res.xlsx : res.pptx);
              var pages = res.pageResults || [];
              var degraded = [];
              for (var i = 0; i < pages.length; i++) {
                if (pages[i] && pages[i].status && pages[i].status !== 'ok') { degraded.push(pages[i].page); }
              }
              console.info('[GenOffice] pdf.convertOffice converted ' + fmt + ' ' + out.length + 'B pages=' + res.pages + ' in ' + (Date.now() - tConv) + 'ms degraded=' + degraded.length);
              return saveAsBytesExt(convertSuggestedName(src, fmt), out).then(function (w) {
                if (!w.ok) { console.error('[GenOffice] pdf.convertOffice save failed: ' + (w.error || '?')); return w; }
                if (w.canceled) { console.info('[GenOffice] pdf.convertOffice save-as canceled'); return { ok: true, canceled: true }; }
                var opened = openConvertedInShell(w.savedPath);
                console.info('[GenOffice] pdf.convertOffice saved ' + w.savedPath + ' opened=' + (opened || 'none'));
                return {
                  ok: true,
                  format: fmt,
                  savedPath: w.savedPath,
                  pages: res.pages,
                  warnings: res.warnings || [],
                  scannedDocument: !!res.scannedDocument,
                  degradedPages: degraded,
                  openedApp: opened || ''
                };
              });
            });
          });
        });
      }).then(finish, function (e) {
        console.error('[GenOffice] pdf.convertOffice failed fmt=' + fmt + ': ' + (e && e.message ? e.message : e));
        return finish({ ok: false, error: pdfConvertErrorMsg(e) });
      });
    },
    // 合并：先合并当前文档 + 选择的一个 PDF（v1 单选；多选能力待 ArkTS 侧），
    // 另存为新文件 → {ok:true, savedPath, appendedCount}
    mergePdf: function (op) {
      return pickPdfFile().then(function (other) {
        var chk = pdfPickCheck(other);
        if (chk) { return chk; }
        return loadPdfBridge().then(function (mod) {
          return readPdfPathBytes(op.path).then(function (bytes) {
            return mod.mergePdfBytes(bytes, [other.bytes]).then(function (r) {
              return savePdfAsBytes(op.suggestedName, r.merged).then(function (w) {
                if (!w.ok) { return w; }
                return { ok: true, savedPath: w.path, appendedCount: r.appended };
              });
            });
          });
        });
      }).catch(handlePdfOpErr);
    },

    // === 能力降级兜底（消除静默失败/潜在崩溃，语义对齐桌面） ===
    getUsername: function () { return Promise.resolve(''); },
    // 磁贴新建的空白有真实路径 → 视为已命名；不开「AI 后自动保存命名」链路
    isUntitled: function () { return Promise.resolve(false); },
    autoRename: function () { return Promise.resolve({ renamed: false }); },
    // 无字体度量管线：一律判可绘制，避免误弹"需覆盖已有文字"确认
    canDrawText: function () { return Promise.resolve(true); },
    // 无 PDFium 干跑校验：返回空数组（渲染层 [v]=... 解构需要数组）
    validateTextEdits: function () { return Promise.resolve([]); },
    listPageImages: function () { return Promise.resolve([]); },
    // setDirty 不覆盖：pdf 渲染层每次 dirty 变化都推状态（本 frame __goFrameDirty），
    // 覆盖成 noop 会让「关闭 tab」守卫永远认为 PDF 无未保存更改（已踩）。
    sendSaveAsResult: function () {},
    getLanguage: function () { return Promise.resolve('zh'); },
    // 跟随系统主题：applyTheme('system') 移除 data-theme → CSS prefers-color-scheme
    getTheme: function () { return Promise.resolve('system'); },
    // 签名库：ArkTS 磁盘持久化（list/add/remove 三个 goJson 封装见上方「签名库」段；
  // 之前缺失 listSavedSignatures → Proxy 兜底 undefined → SignatureDialog 处崩）
    listSavedSignatures: function () { return listSavedSignatures(); },
    addSavedSignature: function (sig) { return addSavedSignature(sig); },
    removeSavedSignature: function (id) { return removeSavedSignature(id); },
    // AI 通道（onAiStream / aiStream / aiStreamCancel）已提到 base mock：所有 app 共用一份
    // 实现（OpenAI 兼容 + Anthropic messages 双协议）。本对象是 Object.assign({}, mock, {...})，
    // 在这里重复定义会静默覆盖 base —— 旧的 PDF 专用实现就是这么把 bug 只修在 PDF 一侧的。
    // 壳菜单「另存为…/打印…」：PDF 走专用通道 onSaveAsRequest / onPrintRequest，二者已在
    // base mock 里实现（登记到 frameSaveAsFns / framePrintFns），这里不再重复定义——
    // 本对象是 Object.assign({}, mock, {...})，重复定义会静默覆盖 base 实现。
    // 仅 onCloseSaveRequest 需要额外链回 base（关 tab 守卫协议）。
    onCloseSaveRequest: function (fn) {
      pdfCloseSaveRequestFns.push(fn);
      // 同时登记到 frame 状态：关闭 tab 的守卫经 __goCloseSaveHandler 触发本回调
      var offBase = mock.onCloseSaveRequest(fn);
      return function () {
        pdfCloseSaveRequestFns = pdfCloseSaveRequestFns.filter(function (f) { return f !== fn; });
        offBase();
      };
    },
    });
  // markdown 保存：纯文本直写（接通用保存桥）。首次保存/另存为弹系统保存选择器，
  // 之后覆盖保存静默。imageSources 的图片落盘暂不支持（返回 null，渲染层退化保留原图路径）。
  var markdownSavedPath = null;
  // 当前文档 URI：readImage 解析相对路径插图的基准（桌面用 savePathByWc 按 webContents 记，
  // 壳内每个 app frame 有自己的注入脚本实例 → 模块级变量即等价物）。打开/另存为时更新。
  var markdownDocPath = null;
  // 已请求过目录授权的文档目录：单文件授权读不到同目录图片，首次失败请用户授权一次，
  // 之后不再打扰（否则 N 张图弹 N 次框）。
  var markdownImgGrantDir = null;
  // 写图片用的目录授权缓存（与上面的 markdownImgGrantDir 分开：那个是「读」的目录授权，
  // 这个是「写」的目录授权，一次授权后长期有效）
  var markdownImgWriteDir = null;
  // 插图落盘链（桌面 markdown-main.ts 的 pickImage/saveImage：把图片复制进**文档所在目录**，
  // 返回相对路径，渲染层 resolveImageSrc 再映射成 md-asset:// 显示）。
  // 壳内同语义，但落盘口只有「已授权目录」（saveInDirJson）；相对路径又必须在文档目录下才能
  // 解析，所以要求用户把目录授权成文档所在目录（复用 readImage 那套 persistPickerGrant，
  // 授权一次即持久）。授权不符/取消时返回 null = 本次不插入（宁可没插入，也不写坏 src）。
  function markdownDirUriOf(p) {
    var i = String(p || '').lastIndexOf('/');
    return (i > 0) ? String(p).substring(0, i + 1) : '';
  }
  function markdownNormDir(u) {
    u = String(u || '');
    if (u.length === 0) { return ''; }
    return (u.charAt(u.length - 1) === '/') ? u : (u + '/');
  }
  var MARKDOWN_IMG_EXT = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp'
  };
  function markdownWriteImage(baseName, ext, b64) {
    if (!markdownDocPath) { return Promise.resolve(null); }
    var docDir = markdownNormDir(markdownDirUriOf(markdownDocPath));
    if (docDir.length === 0) { return Promise.resolve(null); }
    var name = String(baseName || 'image');
    var dot = name.lastIndexOf('.');
    if (dot > 0) { name = name.substring(0, dot); }
    if (name.length === 0) { name = 'image'; }
    // 名字带短随机后缀：同名重复插入会覆盖上一次的文件，而已插入的段落仍指向旧名字
    var stamp = Date.now().toString(36);
    var fileName = name + '-' + stamp.substring(stamp.length - 4) + '.' + (ext || 'png');
    var ask = markdownImgWriteDir ? Promise.resolve(markdownImgWriteDir) : goJson('pickDirectory', []);
    return ask.then(function (dir) {
      if (!dir || markdownNormDir(dir) !== docDir) { return null; }
      markdownImgWriteDir = dir;
      return goJson('saveInDirJson', [dir, fileName, b64]).then(function (r) {
        r = r || {};
        return (r.ok && r.path) ? fileName : null;
      });
    });
  }
  var markdownMock = Object.assign({}, mock, {
    save: function (op) {
      op = op || {};
      var b64 = bufToB64(new TextEncoder().encode(op.text || ''));
      var name = (op.suggestedName || 'Untitled');
      if (!/.md$/i.test(name)) { name += '.md'; }
      var target = (op.mode === 'saveAs') ? null : markdownSavedPath;
      return (target ? goJson('saveAnyJson', [target, b64]) : goJson('saveAsAnyJson', [name, b64]))
        .then(function (r) {
          r = r || { ok: false, error: 'file bridge unavailable' };
          if (r.ok && !r.canceled && r.path) {
            markdownSavedPath = r.path;
            if (markdownDocPath !== r.path) { markdownDocPath = r.path; markdownImgGrantDir = null; }
          }
          return r;
        });
    },
    // 打开文档（起始页磁贴 / 系统「打开方式」→ consumePending 拿到路径后渲染层调这里）：
    // 记下文档 URI 再走 base 的读文本逻辑 —— readImage 要靠它解析相对路径插图。
    readFile: function (p) {
      if (typeof p === 'string' && p.length > 0 && markdownDocPath !== p) {
        markdownDocPath = p;
        markdownImgGrantDir = null;
      }
      return mock.readFile(p);
    },
    // 相对路径插图取字节（导出 DOCX 的 loadImage 用）：语义对齐桌面 readImage ——
    // 带 scheme 的 src 一律 null，相对路径必须落在文档目录内，只认 png/jpg/jpeg/gif，
    // 任何失败都返回 null（渲染层 if (!data) return null → 跳过该图，不崩）。
    // 授权：单文件授权读不到同目录图片 → 首次失败请用户选一次文档所在目录（pickDirectory
    // 会登记并持久化），再重试一次；同一目录只问一次。
    readImage: function (src) {
      if (typeof src !== 'string' || !src) { return Promise.resolve(null); }
      if (/^[a-z][a-z0-9+.-]*:/i.test(src)) { return Promise.resolve(null); }
      if (!markdownImageMime(src)) { return Promise.resolve(null); }
      if (!markdownDocPath) { return Promise.resolve(null); }
      var uri = markdownResolveImageUri(markdownDocPath, src);
      if (!uri) { return Promise.resolve(null); }
      // 授权重试在 readImageBytesAuthorized 里（与 md-asset 显示链共用同一套「每目录只问一次」）
      return readImageBytesAuthorized(uri).then(function (got) {
        return got ? { base64: got.b64, mime: got.mime } : null;
      });
    },
    // 插入图片（功能区按钮 / 斜杠菜单）：必须返回**文档目录下的相对路径**。
    // 基类 mock.pickImage 返回的是 docs 形状 {base64, mime, name} —— 直接当 src 插入会得到一个
    // 指向 JSON 的破图（此前按钮被置灰，所以没人踩到；D-6 解开置灰后必须同时给对形状）。
    pickImage: function () {
      return goJson('pickImageJson', []).then(function (picked) {
        picked = picked || {};
        var b64 = (typeof picked.base64 === 'string') ? picked.base64 : '';
        if (b64.length === 0) { return null; }   // 用户取消选图
        var ext = MARKDOWN_IMG_EXT[picked.mime] || 'png';
        return markdownWriteImage(picked.name, ext, b64);
      });
    },
    // 粘贴/拖入图片（localImage.ts persistAndInsert）：桌面写进文档目录并返回相对路径。
    // 此前恒返回 null → 渲染层提示「请先保存文档，再粘贴图片」= 粘贴**永远**失败；
    // 现在走同一条落盘链（返回 null 的语义也从"未实现"变成"未授权/已取消"）。
    saveImage: function (req) {
      req = req || {};
      var b64 = (typeof req.base64 === 'string') ? req.base64 : '';
      if (b64.length === 0) { return Promise.resolve(null); }
      var ext = (typeof req.ext === 'string' && req.ext.length > 0) ? req.ext : 'png';
      return markdownWriteImage('pasted', ext, b64);
    },
    // 文件→导出为 Word：桌面 markdown-main.ts 的 exportDocx = 校验 base64 →
    // dialog 模式弹保存框写字节 / openInDocs 模式写 app 缓存后交给 Docs 打开，
    // 返回三种形状 {ok,path} / {ok,canceled:true} / {ok:false,error}。
    // 壳内两种模式都落到 saveAsAnyJson（系统保存框 + 授权登记 + 写字节，返回形状与桌面同构），
    // openInDocs 再沿 parent 链用 __goOpenExternalPath 在新标签打开（PDF→Word 转换同一条已验证链路）。
    // 与桌面的差异：openInDocs 桌面不弹框（直写 app 缓存目录），壳内没有「免选路径」的落盘口
    // （saveAnyJson 只认已授权 URI）→ 仍弹一次保存框，选完即写并打开。
    // 修复前：缺本方法 → Proxy 兜底 undefined → 渲染层 result.ok 抛 TypeError，又被它自己的
    // catch 吞成 console.error → 用户看到「点了完全没反应」（批次 C 加宽风险窗口后查出）。
    exportDocx: function (req) {
      req = req || {};
      var b64 = (typeof req.base64 === 'string') ? req.base64 : '';
      if (b64.length === 0) {
        return Promise.resolve({ ok: false, error: 'markdown: bad export request' });
      }
      var openAfter = (req.mode === 'openInDocs');
      return goJson('saveAsAnyJson', [markdownDocxName(req.suggestedName), b64]).then(function (r) {
        r = r || { ok: false, error: 'file bridge unavailable' };
        if (r.ok && r.canceled) { return { ok: true, canceled: true }; }
        if (!r.ok || !r.path) { return { ok: false, error: String(r.error || 'write failed') }; }
        if (openAfter) { openConvertedInShell(r.path); }
        return { ok: true, path: r.path };
      });
    },
    // 文件→导出图片：桌面 prepareImageExport 在 main 进程 printToPDF(html) → 返回
    // {id, path, pdfBase64}，渲染层再用 pdf.js 逐页栅格化成 PNG。壳内没有 HTML→PDF
    // 引擎（Chromium printToPDF 不可用；pdfium.wasm 只做 PDF→光栅），所以这里给
    // 【显式可见】的失败结果：渲染层 !target.ok → throw(result.error) → 状态栏显示
    // appExportImagesFailed。缺本方法时 Proxy 兜底 undefined → !target.ok TypeError，
    // 用户看到的是「点了没反应」（本轮修复前即此症状）。
    prepareImageExport: function () {
      return Promise.resolve({
        ok: false,
        error: '鸿蒙版暂不支持「导出图片」：该功能依赖桌面版的 HTML→PDF 渲染管线',
      });
    },
    // 栅格化环节的收尾（成功/失败各调一次）：无待清理资源 → {ok:true}
    finishImageExport: function () { return Promise.resolve({ ok: true }); },
    // app 内「打开」（QAT 打开按钮）：md/txt 过滤的系统选择器，直接返回解码文本 + 路径
    //（省去渲染层二次 readFile）；取消 / 选择器不可用返回 null。
    // 桌面版经主进程新建 tab 打开，故 Electron preload 无此方法（渲染层按键存在性判断）。
    openLocalFile: function (suffixes) {
      var list = (Array.isArray(suffixes) && suffixes.length > 0) ? suffixes : MARKDOWN_SUFFIXES;
      return mock.openFileJson(list).then(function (j) {
        var r = null;
        if (typeof j === 'string' && j) {
          try { r = JSON.parse(j); } catch (e) { r = null; }
        }
        if (!r || !r.ok || !r.b64) { return null; }
        try {
          // 记下文档 URI：app 内「打开」不走 readFile，否则 readImage 没有解析基准
          if (r.path && markdownDocPath !== r.path) { markdownDocPath = r.path; markdownImgGrantDir = null; }
          return { path: r.path || '', name: r.name || '', text: new TextDecoder().decode(b64ToBuf(r.b64)) };
        } catch (e) { return null; }
      });
    },
    onReadTextRequest: function () { return NOOP; },
    sendReadTextResult: function () { return Promise.resolve(); },
    onFileRenamed: function () { return NOOP; },
  });
  // slides 打开/编辑/保存走真实链路：字节 → pptx-bridge（壳内打包的 pptx-engine+
  // pptx-render）解析渲染并持有会话（OpenedPptx 在 bundle 内 Map，进程内不经 IPC）。
  // M1 打开+渲染；M2 文本编辑写回模型 + 真实保存（savePptx 字节落盘）+ 新建空白会话；
  // 版式/增删页等结构性操作仍为内存 deck（无会话时兜底）。
  //
  // 加载方式：__goImport('pptx-bridge.mjs') 依赖构建期 __goChunks 注册表，缺失时
  // 退回 fetch/XHR → 裸 specifier import（真机报 "Failed to resolve module specifier，
  // base URL is about:blank"）。改走 ArkTS readRawFileJson 直读 rawfile 字节 →
  // data: URL import：不经网络、不依赖注册表，任何包形态都可用；结果缓存。
  var pptxBridgePromise = null;
  var PPTX_BRIDGE_RAW = 'web/pptx-bridge.mjs';
  function loadPptxBridge() {
    if (pptxBridgePromise) { return pptxBridgePromise; }
    pptxBridgePromise = goJson('readRawFileJson', [PPTX_BRIDGE_RAW]).then(function (r) {
      if (!r || r.ok !== true || !r.b64) {
        pptxBridgePromise = null;
        throw new Error('readRawFileJson failed: ' + (r && r.error ? r.error : 'missing b64'));
      }
      return import('data:text/javascript;base64,' + r.b64);
    }).catch(function (e) {
      console.error('[GenOffice] pptx-bridge load failed: ' + (e && e.message ? e.message : e));
      pptxBridgePromise = null;
      throw e;
    });
    return pptxBridgePromise;
  }
  // 当前会话（M2）：打开/新建产生的 sessionId 与落盘路径；保存/编辑经它走引擎模型。
  var pptSessionId = null;
  var pptSessionPath = null;
  function openPptxViaBridge(bytes, fit, path, name) {
    return loadPptxBridge().then(function (mod) {
      if (!mod || typeof mod.openPptxFile !== 'function') { return null; }
      return mod.openPptxFile(bytes, fit, path || '').then(function (r) {
        if (!r) { return null; }
        r.path = path || '';
        r.name = name || 'Untitled';
        pptSessionId = r.sessionId || null;
        pptSessionPath = path || null;
        return r;
      });
    }).catch(function (e) {
      console.error('[GenOffice] pptx-bridge openPptxFile failed: ' + (e && e.message ? e.message : e));
      return null;
    });
  }
  // M9：slidesMock 引擎 op 统一包装——无会话/桥失败统一 null（渲染层 if (!r) return，
  // 插入入口 disabled={!hasDoc}，无会话时正常不可达）
  function pptxOp(run) {
    if (!pptSessionId) { return Promise.resolve(null); }
    return loadPptxBridge().then(function (mod) {
      try { return run(mod); } catch (e) {
        console.error('[GenOffice] pptx op failed: ' + (e && e.message ? e.message : e));
        return null;
      }
    }).catch(function (e) {
      console.error('[GenOffice] pptx bridge failed: ' + (e && e.message ? e.message : e));
      return null;
    });
  }
  // M9：图片 naturalPx → 视口 px 框（dpi 按 96 近似；等比缩进页面 80% 内；centerPx 优先，缺省页心）
  function pptxNaturalFrame(mod, op) {
    var size = (mod && typeof mod.getSlideSizeOp === 'function' && mod.getSlideSizeOp(pptSessionId)) || { cx: 12192000, cy: 6858000 };
    var fit = (op && op.fitWidthPx) || 1280;
    var nat = (op && op.naturalPx) || { width: 320, height: 240 };
    var wEmu = Math.max(1, Math.round((nat.width || 320) * 9525));
    var hEmu = Math.max(1, Math.round((nat.height || 240) * 9525));
    var k = Math.min(1, (size.cx * 0.8) / wEmu, (size.cy * 0.8) / hEmu);
    wEmu = Math.round(wEmu * k); hEmu = Math.round(hEmu * k);
    var pageH = fit * size.cy / size.cx;
    var pxPerEmu = fit / size.cx;
    var w = wEmu * pxPerEmu, h = hEmu * pxPerEmu;
    var cxPx = (op && op.centerPx && typeof op.centerPx.x === 'number') ? op.centerPx.x : fit / 2;
    var cyPx = (op && op.centerPx && typeof op.centerPx.y === 'number') ? op.centerPx.y : pageH / 2;
    return { x: Math.round(cxPx - w / 2), y: Math.round(cyPx - h / 2), w: Math.round(w), h: Math.round(h) };
  }
  function openPptxViaBridge(bytes, fit, path, name) {
    return loadPptxBridge().then(function (mod) {
      if (!mod || typeof mod.openPptxFile !== 'function') { return null; }
      return mod.openPptxFile(bytes, fit, path || '').then(function (r) {
        if (!r) { return null; }
        r.path = path || '';
        r.name = name || 'Untitled';
        pptSessionId = r.sessionId || null;
        pptSessionPath = path || null;
        return r;
      });
    }).catch(function (e) {
      console.error('[GenOffice] pptx-bridge openPptxFile failed: ' + (e && e.message ? e.message : e));
      return null;
    });
  }
  var slidesMock = Object.assign({}, mock, {
    // ===== 批次 E 系统性扫描补的缺口（这些调用点在渲染层写成「方法名?.()」，
    //       旧覆盖正则看不见 → 一直是"未登记的静默 no-op"）=====
    // 原则：能给真实行为就给（setAutoSavePref 落盘），给不了的必须返回**契约形状 + 原因**，
    // 不能留 undefined（调用点常写 r.ok / .length，Proxy 兜底会把"方法不存在"变成"读属性崩"）。
    setAutoSavePref: function (on) {
      try { localStorage.setItem('genoffice.slides.autoSave', on ? '1' : '0'); } catch (e) { /* 忽略 */ }
      return Promise.resolve();
    },
    fontDownload: function (family) {
      return Promise.resolve({ ok: false, error: '鸿蒙版不支持在线下载字体：' + String(family || '') + '（请用系统已安装字体或本地导入）' });
    },
    fontInstallLocal: function () { return Promise.resolve({ families: [] }); },
    getChartColorSchemes: function () { return Promise.resolve([]); },
    applyTxn: function () { return Promise.resolve(null); },
    setShowFullScreen: function () { return Promise.resolve(); },
    // ===== 批次 E：PPT deck 操作补齐（解引用风险清单里的 20 条）=====
    // 原则：能真做就真做（deleteSlides / duplicateSlides / pickPictureFile 走 slideDeck 与图片选择器）；
    // 做不了的必须返回**契约允许的合法值 + 原因**，绝不能留 undefined —— 上游 Proxy 兜底给的是
    // resolve(undefined)，而这些调用点在渲染层是 result.slides / result.length 直接解引用 → 白屏级 TypeError。
    // 会话优先：打开的 PPT 真身 deck 在 pptx sidecar；无会话（boot 空白 deck）回退内存版
    deleteSlides: function (op) {
      var idxs = (op && (op.indices || op.indexes)) || [];
      if (!idxs.length && op && typeof op.index === 'number') { idxs = [op.index]; }
      if (!idxs.length) { return Promise.resolve(null); }
      var sorted = idxs.slice().sort(function (a, b) { return b - a; });
      var run = function (sid) {
        return loadPptxBridge().then(function (mod) {
          for (var k = 0; k < sorted.length; k++) {
            mod.deleteSlideOp(sid, sorted[k] | 0, 1280);
          }
          return mod.getRenderSlidesOp ? mod.getRenderSlidesOp(sid) : null;
        }).then(function (r) { return r || slideDeck.slides; }, function () { return slideDeck.slides; });
      };
      if (pptSessionId) { return run(pptSessionId); }
      // 无会话回退：boot 内存 deck（与 __goBoot.deleteSlide 同一套）
      var keep = [];
      for (var i = 0; i < slideDeck.slides.length; i++) {
        var drop = false;
        for (var j = 0; j < idxs.length; j++) { if (idxs[j] === i) { drop = true; break; } }
        if (!drop) { keep.push(slideDeck.slides[i]); }
      }
      if (keep.length === slideDeck.slides.length || keep.length === 0) { return Promise.resolve(null); }
      slideDeck.slides = keep;
      return Promise.resolve(slideDeck.slides);
    },
    moveSlides: function (op) {
      var pairs = (op && op.moves) || [];
      if (!pairs.length) { return Promise.resolve(null); }
      var runSession = function (sid) {
        return loadPptxBridge().then(function (mod) {
          for (var k = 0; k < pairs.length; k++) {
            mod.moveSlideOp(sid, pairs[k].from | 0, pairs[k].to | 0, 1280);
          }
          return mod.getRenderSlidesOp ? mod.getRenderSlidesOp(sid) : null;
        }).then(function (r) { return r || slideDeck.slides; }, function () { return slideDeck.slides; });
      };
      if (pptSessionId) { return runSession(pptSessionId); }
      var arr = slideDeck.slides.slice();
      for (var m = 0; m < pairs.length; m++) {
        var from = pairs[m].from | 0, to = pairs[m].to | 0;
        if (from < 0 || from >= arr.length) { continue; }
        var item = arr.splice(from, 1)[0];
        arr.splice(Math.max(0, Math.min(to, arr.length)), 0, item);
      }
      slideDeck.slides = arr;
      return Promise.resolve(slideDeck.slides);
    },
    duplicateSlides: function (op) {
      var src = (op && typeof op.index === 'number') ? op.index : -1;
      var n = (op && op.count) ? op.count : 1;
      if (src < 0 || !slideDeck.slides[src]) { return Promise.resolve(null); }
      var at = Math.min(src + 1, slideDeck.slides.length);
      for (var k = 0; k < n; k++) {
        slideDeck.slides.splice(at + k, 0, JSON.parse(JSON.stringify(slideDeck.slides[src])));
      }
      return Promise.resolve({ slides: slideDeck.slides, index: at });
    },
    // 图片选择：真实能力（复用 sheets/pdf 那条 pickImage 通道），返回 {base64, ext} | null
    pickPictureFile: function () {
      return goJson('pickImageJson', ['']).then(function (r) {
        if (!r || !r.base64) { return null; }
        var mime = String(r.mime || 'image/png');
        var ext = mime.indexOf('jpeg') >= 0 ? 'jpg' : (mime.indexOf('gif') >= 0 ? 'gif' : (mime.indexOf('webp') >= 0 ? 'webp' : 'png'));
        return { base64: r.base64, ext: ext };
      }, function () { return null; });
    },
    getShapeKeys: function () { return Promise.resolve([]); },
    // ===== 批次 F：PPT 二波（隐藏页 / 页剪贴板 / 批注与分区降级）=====
    // hidden 是 RenderSlide 的合法字段（放映/导出时跳过），壳内 deck 直接置位即可真用。
    setSlideHidden: function (op) {
      var si = (op && typeof op.slideIndex === 'number') ? op.slideIndex : -1;
      var s = slideDeck.slides[si];
      if (!s) { return Promise.resolve(null); }
      s.hidden = op ? op.hidden !== false : true;
      return Promise.resolve(s);
    },
    setSlidesHidden: function (op) {
      var idxs = (op && op.slideIndexes) || [];
      var hid = op ? op.hidden !== false : true;
      for (var i = 0; i < idxs.length; i++) {
        var s = slideDeck.slides[idxs[i]];
        if (s) { s.hidden = hid; }
      }
      return Promise.resolve(slideDeck.slides);
    },
    // 页剪贴板：壳内变量承载（桌面版走系统级 slide clipboard，鸿蒙为应用内剪贴板）
    copySlides: function (op) {
      var idxs = (op && op.slideIndexes) || [];
      if (!idxs.length) { return Promise.resolve(false); }
      var picks = [];
      for (var i = 0; i < idxs.length; i++) {
        var s = slideDeck.slides[idxs[i]];
        if (s) { picks.push(JSON.parse(JSON.stringify(s))); }
      }
      if (!picks.length) { return Promise.resolve(false); }
      slideClip = picks;
      return Promise.resolve(true);
    },
    hasSlideClipboard: function () { return Promise.resolve(!!(slideClip && slideClip.length)); },
    pasteSlide: function (op) {
      if (!slideClip || !slideClip.length) { return Promise.resolve(null); }
      var after = (op && typeof op.afterIndex === 'number') ? op.afterIndex : slideDeck.slides.length - 1;
      var at = Math.min(Math.max(after + 1, 0), slideDeck.slides.length);
      var news = [];
      for (var i = 0; i < slideClip.length; i++) {
        news.push(JSON.parse(JSON.stringify(slideClip[i])));
      }
      for (var j = 0; j < news.length; j++) { slideDeck.slides.splice(at + j, 0, news[j]); }
      return Promise.resolve({ slides: slideDeck.slides, index: at, count: news.length });
    },
    repasteSlide: function () { return Promise.resolve(null); },
    // 批注引擎壳内没有（pptx comments 读写不在 napi 面）→ 契约内降级
    addComment: function () { return Promise.resolve(null); },
    deleteComment: function () { return Promise.resolve(null); },
    // 分区：壳内 deck 不维护 sections（getSections 恒 []），写操作一律契约内 null
    setSections: function () { return Promise.resolve(null); },
    addSection: function () { return Promise.resolve(null); },
    renameSection: function () { return Promise.resolve(null); },
    removeSection: function () { return Promise.resolve(null); },
    // ===== 批次 E-4：AI 面板（slides-skill）依赖的 18 条桥 =====
    // 结论先说：五个 app 里只有 PPT 的 AI 工具链有缺口（docs/sheets/markdown/pdf/shell 均为 0）。
    // 这里按「能真做就真做」处理：deleteElement(s) 直接改 deck；元素/表格/图表/SmartArt 的**新建**
    // 与云端整页生成在壳内没有对应管线，返回契约允许的 null（AI 工具会向模型报告失败，
    // 模型改走文本路径）；风格模板与历史批次给形状正确的空态。
    deleteElement: function (op) {
      var si = (op && typeof op.slideIndex === 'number') ? op.slideIndex : slideDeck.slides.length - 1;
      var s = slideDeck.slides[si];
      if (!s || !s.nodes || !s.nodes.length) { return Promise.resolve(null); }
      var id = op && (op.id || op.sourceId);
      var before = s.nodes.length;
      s.nodes = s.nodes.filter(function (n) { return n && n.id !== id && n.sourceId !== id; });
      return Promise.resolve(s.nodes.length === before ? null : s);
    },
    deleteElements: function (op) {
      var si = (op && typeof op.slideIndex === 'number') ? op.slideIndex : slideDeck.slides.length - 1;
      var s = slideDeck.slides[si];
      if (!s || !s.nodes || !s.nodes.length) { return Promise.resolve(null); }
      var ids = (op && (op.ids || op.sourceIds)) || [];
      var want = {};
      for (var i = 0; i < ids.length; i++) { want[ids[i]] = 1; }
      var before = s.nodes.length;
      s.nodes = s.nodes.filter(function (n) { return !(n && (want[n.id] || want[n.sourceId])); });
      return Promise.resolve(s.nodes.length === before ? null : s);
    },
    // ===== M9：插入/元素工厂/表格/图表/剪贴板 —— pptx-bridge 引擎 op 接线 =====
    // 无会话（未打开文档）返回 null；渲染层 if (!r) return
    addElement: function (op) {
      op = op || {};
      return pptxOp(function (mod) {
        return mod.addElementOp(pptSessionId, op.slideIndex | 0, String(op.kind || ''),
          op.xPx | 0, op.yPx | 0, op.wPx | 0, op.hPx | 0, op.fitWidthPx || 1280,
          op.paragraphs, op.fillColor, op.stroke, op.bodyPr);
      });
    },
    addTable: function (op) {
      op = op || {};
      return pptxOp(function (mod) {
        return mod.addTableOp(pptSessionId, op.slideIndex | 0, op.rows | 0, op.cols | 0,
          op.xPx | 0, op.yPx | 0, op.wPx | 0, op.hPx | 0, op.fitWidthPx || 1280, op.rowHeightEmu);
      });
    },
    addChart: function (op) {
      op = op || {};
      return pptxOp(function (mod) {
        return mod.addChartOp(pptSessionId, op.slideIndex | 0, String(op.kind || 'bar'),
          op.categories || [], op.series || [],
          op.xPx | 0, op.yPx | 0, op.wPx | 0, op.hPx | 0, op.fitWidthPx || 1280, op.title);
      });
    },
    addSmartArt: function (op) {
      op = op || {};
      return pptxOp(function (mod) {
        return mod.addSmartArtOp(pptSessionId, op.slideIndex | 0, String(op.layout || 'list'),
          op.items || [], op.xPx | 0, op.yPx | 0, op.wPx | 0, op.hPx | 0, op.fitWidthPx || 1280);
      });
    },
    // 图片字节插入：渲染层给定框（图标/Zoom）或 naturalPx（外部图/拖入）两分支
    addImageBytes: function (op) {
      op = op || {};
      return pptxOp(function (mod) {
        var f;
        if (typeof op.xPx === 'number' && typeof op.yPx === 'number') {
          f = { x: op.xPx | 0, y: op.yPx | 0, w: op.wPx | 0, h: op.hPx | 0 };
        } else {
          f = pptxNaturalFrame(mod, op);
        }
        return mod.addPictureOp(pptSessionId, op.slideIndex | 0, String(op.base64 || ''),
          String(op.ext || 'png'), f.x, f.y, f.w, f.h, op.fitWidthPx || 1280, op.name);
      });
    },
    // 插入图片（插入→图片）：选图 → natural 尺寸 → 页心插入（PowerPoint dpi 语义的近似）
    insertImage: function (slideIndex, fitWidthPx) {
      if (!pptSessionId) { return Promise.resolve(null); }
      return goJson('pickImageJson', ['']).then(function (r) {
        if (!r || !r.base64) { return null; }
        var mime = String(r.mime || 'image/png');
        var ext = mime.indexOf('jpeg') >= 0 ? 'jpg' : (mime.indexOf('gif') >= 0 ? 'gif' : (mime.indexOf('webp') >= 0 ? 'webp' : 'png'));
        return loadPptxBridge().then(function (mod) {
          return new Promise(function (resolve) {
            var img = new Image();
            img.onload = function () { resolve({ width: img.naturalWidth || 320, height: img.naturalHeight || 240 }); };
            img.onerror = function () { resolve({ width: 320, height: 240 }); };
            img.src = 'data:image/' + ext + ';base64,' + r.base64;
          }).then(function (nat) {
            var frame = pptxNaturalFrame(mod, { naturalPx: nat, fitWidthPx: fitWidthPx });
            return mod.addPictureOp(pptSessionId, slideIndex | 0, r.base64, ext,
              frame.x, frame.y, frame.w, frame.h, fitWidthPx || 1280);
          });
        });
      }).catch(function (e) {
        console.error('[GenOffice] pptx insertImage failed: ' + (e && e.message ? e.message : e));
        return null;
      });
    },
    // 更换图片字节（抠图/另选图片）：框/层级/效果保留
    replacePictureBytes: function (op) {
      op = op || {};
      return pptxOp(function (mod) {
        return mod.replacePictureOp(pptSessionId, op.slideIndex | 0, String(op.sourceId || ''),
          String(op.base64 || ''), String(op.ext || 'png'), 1280, op.keepSrcRect === true);
      });
    },
    // 批量几何变换（对齐/分布/多选旋转：渲染层算好几何，整批落模型，一个 undo 步）
    batchEditTransform: function (op) {
      op = op || {};
      return pptxOp(function (mod) {
        return mod.batchEditTransformOp(pptSessionId, op.slideIndex | 0, op.items || [], op.fitWidthPx || 1280);
      });
    },
    // 层级调整（上移/下移一层、置顶/置底）
    reorderElement: function (op) {
      op = op || {};
      return pptxOp(function (mod) {
        return mod.reorderElementOp(pptSessionId, op.slideIndex | 0, String(op.sourceId || ''),
          String(op.dir || ''), 1280);
      });
    },
    // 超链接设置/清除（target null = 清除；Zoom 缩略图链接也走这里）
    setLink: function (op) {
      op = op || {};
      return pptxOp(function (mod) {
        return mod.setLinkOp(pptSessionId, op.slideIndex | 0, String(op.sourceId || ''),
          op.target || null, 1280);
      });
    },
    insertImageUrl: function () { return Promise.resolve(null); },
    replacePictureUrl: function () { return Promise.resolve(null); },
    // 整页生成（云端 / 本地 JSON spec → 单页 pptx → land）：无云端账号、无本地生成管线
    cloudGenStatus: function () { return Promise.resolve({ enabled: false }); },
    cloudGeneratePage: function () {
      return Promise.resolve({ ok: false, error: '鸿蒙版未接云端整页生成' });
    },
    localGeneratePage: function () {
      return Promise.resolve({ ok: false, error: '鸿蒙版未接本地整页生成管线' });
    },
    landGeneratedPages: function () {
      console.warn('[GenOffice] slides.landGeneratedPages: 无生成产物可落位');
      return Promise.resolve(null);
    },
    // 历史批次：开 true 让 AI 的批量编辑不中断；结束无计数（undo 链独立）
    beginHistoryBatch: function () { return Promise.resolve(true); },
    endHistoryBatch: function () { return Promise.resolve(null); },
    // 风格模板：无磁盘模板库
    listStyleTemplates: function () { return Promise.resolve([]); },
    loadStyleTemplate: function () {
      return Promise.resolve({ ok: false, error: '鸿蒙版未接风格模板库' });
    },
    saveStyleTemplate: function () {
      return Promise.resolve({ ok: false, error: '鸿蒙版未接风格模板库' });
    },
    saveStyleSidecar: function () { return Promise.resolve({ ok: false }); },
    findReplace: function () {
      console.warn('[GenOffice] slides.findReplace: harmony has no main-process deck; the renderer edits in place');
      return Promise.resolve(null);
    },
    // 图表编辑（改类型/数据/配色：patch 透传给引擎 setChart）
    editChart: function (op) {
      op = op || {};
      var patch = {};
      var ck = ['kind', 'categories', 'series', 'colorScheme', 'title', 'legendPos', 'dataLabels', 'gridlines', 'catAxisTitle', 'valAxisTitle', 'gapWidthPct', 'switchRowCol', 'pointColors'];
      for (var ci = 0; ci < ck.length; ci++) { if (op[ck[ci]] !== undefined) { patch[ck[ci]] = op[ck[ci]]; } }
      return pptxOp(function (mod) {
        return mod.editChartOp(pptSessionId, op.slideIndex | 0, String(op.sourceId || ''), patch, 1280);
      });
    },
    applyEditScript: function () { return Promise.resolve(null); },
    aiSnapshotRestore: function () { return Promise.resolve(null); },
    insertMedia: function () { return Promise.resolve(null); },
    insertModel3d: function () { return Promise.resolve(null); },
    // 元素剪贴板：复制（cut=true 剪切，引擎壳内剪贴板）
    copyElements: function (op) {
      op = op || {};
      return pptxOp(function (mod) {
        return Promise.resolve(mod.copyElementsOp(pptSessionId, op.slideIndex | 0, op.sourceIds || [], op.cut === true) || 0);
      });
    },
    // 元素剪贴板：PNG 附带（桌面把 PNG 存进元素剪贴板供「粘贴为图片」）。鸿蒙无跨应用
    // 元素剪贴板，壳内 pasteElements 只走元素数据通道 → 收下即确认，不再消费
    // （渲染层 await 后忽略返回值，仅 try/catch 兜住渲染失败，不阻塞元素复制本身）。
    copyElementsImage: function (token, png) {
      if (!png) { return Promise.resolve(false); }
      return Promise.resolve(true);
    },
    // 元素剪贴板：粘贴（同页/跨页级联偏移由引擎处理）
    pasteElements: function (op) {
      op = op || {};
      return pptxOp(function (mod) {
        return mod.pasteElementsOp(pptSessionId, op.slideIndex | 0, op.fitWidthPx || 1280);
      });
    },
    // 就地复制（⌘D / 拖拽复制）
    duplicateElements: function (op) {
      op = op || {};
      return pptxOp(function (mod) {
        return mod.duplicateElementsOp(pptSessionId, op.slideIndex | 0, op.sourceIds || [],
          op.dxPx | 0, op.dyPx | 0, op.fitWidthPx || 1280);
      });
    },
    // 表格：合并/拆分（kind: merge-right/merge-down/split）
    tableMerge: function (op) {
      op = op || {};
      return pptxOp(function (mod) {
        return mod.tableMergeOp(pptSessionId, op.slideIndex | 0, String(op.sourceId || ''),
          String(op.kind || ''), op.row | 0, op.col | 0, 1280);
      });
    },
    // 表格：行列增删（kind: insert-row/delete-row/insert-col/delete-col）
    tableStructure: function (op) {
      op = op || {};
      return pptxOp(function (mod) {
        return mod.tableStructureOp(pptSessionId, op.slideIndex | 0, String(op.sourceId || ''),
          String(op.kind || ''), op.index | 0, 1280, op.before === true);
      });
    },
    // 表格：拖列宽/行高（视口 px → EMU）
    setTableColWidth: function (op) {
      op = op || {};
      return pptxOp(function (mod) {
        return mod.setTableColWidthOp(pptSessionId, op.slideIndex | 0, String(op.sourceId || ''),
          op.col | 0, Math.round((op.wPx || 0) * 9525), 1280);
      });
    },
    setTableRowHeight: function (op) {
      op = op || {};
      return pptxOp(function (mod) {
        return mod.setTableRowHeightOp(pptSessionId, op.slideIndex | 0, String(op.sourceId || ''),
          op.row | 0, Math.round((op.hPx || 0) * 9525), 1280);
      });
    },
    // 表格：单元格文本提交（Tab 跳格同链路）
    editTableCell: function (op) {
      op = op || {};
      return pptxOp(function (mod) {
        return mod.editTableCellOp(pptSessionId, op.slideIndex | 0, String(op.sourceId || ''),
          op.row | 0, op.col | 0, op.paragraphs || [], 1280);
      });
    },
    // 表格样式（styleName 预设 / firstRow/bandRow 等开关透传）
    editTableStyle: function (op) {
      op = op || {};
      var style = {};
      var sk = ['styleName', 'firstRow', 'lastRow', 'firstCol', 'lastCol', 'bandRow', 'bandCol', 'rtl', 'shadingColor', 'borderColor', 'borderWidthPt', 'borderPreset'];
      for (var si = 0; si < sk.length; si++) { if (op[sk[si]] !== undefined) { style[sk[si]] = op[sk[si]]; } }
      return pptxOp(function (mod) {
        return mod.setTableStyleOp(pptSessionId, op.slideIndex | 0, String(op.sourceId || ''), style, 1280);
      });
    },
    // 手绘墨迹：一张透明 PNG picture 元素
    addInk: function (op) {
      op = op || {};
      return pptxOp(function (mod) {
        return mod.addInkOp(pptSessionId, op.slideIndex | 0, String(op.base64 || ''),
          op.xPx | 0, op.yPx | 0, op.wPx | 0, op.hPx | 0, op.fitWidthPx || 1280, op.payload);
      });
    },
    // moveSlides 曾在此被重复定义成空桩，把上面（slideDeck 分支）的真实现整条遮蔽 →
    // 拖拽排序幻灯片静默失效（重复键后定义覆盖先定义）。已删除；门禁 checkMockDuplicateKeys 拦这一类。
    moveSection: function () { return Promise.resolve(null); },
    removeSectionSlides: function () { return Promise.resolve(null); },
    // presenterStart 的契约是**非空** {audience:boolean} → 返回 null 会让调用点崩，必须给对象
    presenterStart: function () {
      console.warn('[GenOffice] slides.presenterStart: 鸿蒙版未接放映/观众视图');
      return Promise.resolve({ audience: false });
    },
    printSlides: function () {
      return Promise.resolve({ ok: false, error: '鸿蒙版请用壳菜单「打印…」走系统打印框架' });
    },
    // 导出图片（功能区「开始」→ 导出图片）：渲染层把每张可见页渲成 2x PNG（base64 无前缀）
    // → 本方法选目录 + 逐页落盘。注意契约与 pdfMock.exportImages 不同（那边吃 {images,pageNumbers}），
    // slides 渲染层给 {dir, baseName, pngsBase64}、读回 {ok, paths}（用 paths.length 报「已导出 N 张」）。
    // 旧状：pickExportDir 未实现 → 渲染层「if (!dir) return」首行即静默返回（用户报「点了没反应」）。
    pickExportDir: function () {
      return goJson('pickDirectory', []).then(function (r) {
        r = r || {};
        if (r.canceled) { return null; }
        return (r.path || r.dir || r.uri) ? (r.path || r.dir || r.uri) : null;
      }).catch(function () { return null; });
    },
    exportImages: function (op) {
      op = op || {};
      var pngs = op.pngsBase64 || [];
      if (!pngs.length) { return Promise.resolve({ ok: false, error: '没有可导出的页面' }); }
      var dir = String(op.dir || '');
      if (!dir) { return Promise.resolve({ ok: false, error: '未选择导出目录' }); }
      var base = String(op.baseName || 'slide').replace(/[/:*?"<>|]/g, '_');
      var chain = Promise.resolve({ ok: true });
      var paths = [];
      for (var i = 0; i < pngs.length; i++) {
        (function (idx) {
          chain = chain.then(function (acc) {
            if (!acc.ok) { return acc; }
            var name = base + '-p' + (idx + 1) + '.png';
            // 目标是「已授权目录 + 新文件名」→ 必须走 saveInDirJson（saveAnyJson 拼新路径在真机恒报
            // save target is not an opened document，pdf 侧已踩过）
            return goJson('saveInDirJson', [dir, name, pngs[idx]]).then(function (w) {
              if (!w || !w.ok) { return { ok: false, error: (w && w.error) ? w.error : ('写盘失败: ' + name) }; }
              paths.push(dir + '/' + name);
              return { ok: true };
            });
          });
        })(i);
      }
      return chain.then(function (res) {
        if (!res.ok) { return res; }
        console.info('[GenOffice] slides.exportImages written ' + paths.length + ' png → ' + dir);
        return { ok: true, paths: paths, savedDir: dir, count: paths.length };
      }).catch(function (e) {
        console.error('[GenOffice] slides.exportImages failed: ' + (e && e.message ? e.message : e));
        return { ok: false, error: '导出图片失败：' + (e && e.message ? e.message : e) };
      });
    },
    // 右键「另存为图片」：渲染层把选中元素渲成一张透明 PNG → savePicture({pngBase64, defaultName})，
    // 弹系统保存框写盘 → {ok, path}。旧状：方法缺失 → r 是 undefined → 渲染层「r.ok」直接 TypeError
    // （桥形状扫描里的解引用风险之一），用户观感是「点了没反应」。
    savePicture: function (op) {
      op = op || {};
      var b64 = String(op.pngBase64 || '');
      if (!b64) { return Promise.resolve({ ok: false, error: '没有可保存的图片数据' }); }
      var name = String(op.defaultName || 'Picture').replace(/[/:*?"<>|]/g, '_');
      if (!/.png$/i.test(name)) { name += '.png'; }
      return goJson('saveAsAnyJson', [name, b64]).then(function (r) {
        r = r || { ok: false, error: 'file bridge unavailable' };
        if (r.ok && r.canceled) { return { ok: true, canceled: true }; }
        if (!r.ok || !r.path) { return { ok: false, error: String(r.error || '写盘失败') }; }
        return { ok: true, path: r.path };
      }).catch(function (e) {
        return { ok: false, error: '另存为图片失败：' + (e && e.message ? e.message : e) };
      });
    },
    // PPT 导出 PDF：渲染层把可见页渲成 2x PNG → 本方法选目标路径（弹系统保存框）。
    // 复用 saveAsAnyJson 先创建空文件拿授权路径，随后 exportPdf 覆盖写真内容。
    pickExportPdfPath: function (name) {
      var suggested = String(name || 'presentation.pdf');
      if (!/.pdf$/i.test(suggested)) { suggested += '.pdf'; }
      return goJson('saveAsAnyJson', [suggested, '']).then(function (r) {
        r = r || { ok: false };
        if (r.ok && !r.canceled && r.path) { return r.path; }
        return null;
      });
    },
    exportPdf: function (op) {
      op = op || {};
      if (!op.filePath || !Array.isArray(op.pngsBase64) || op.pngsBase64.length === 0) {
        return Promise.resolve({ ok: false, error: '导出 PDF：缺少目标路径或页面图像' });
      }
      return loadPdfBridge().then(function (mod) {
        if (!mod || typeof mod.pngsToPdf !== 'function') {
          return { ok: false, error: '导出 PDF：pdf-bridge 未就绪' };
        }
        return mod.pngsToPdf(op.pngsBase64, op.widthPx || 1280, op.heightPx || 720).then(function (bytes) {
          return goJson('saveAnyJson', [op.filePath, bufToB64(bytes)]).then(function (r) {
            r = r || { ok: false, error: 'file bridge unavailable' };
            if (!r.ok) { return { ok: false, error: r.error || '写盘失败' }; }
            return { ok: true, path: r.path || op.filePath };
          });
        });
      }).catch(function (e) {
        console.error('[GenOffice] pptx exportPdf failed: ' + (e && e.message ? e.message : e));
        return { ok: false, error: '导出 PDF 失败：' + (e && e.message ? e.message : e) };
      });
    },
    // M2 保存（覆盖保存）：会话字节 → 写回原路径。path 为空（新建空白）走另存为语义
    // （saveAsAnyJson 弹系统保存框），成功后登记路径，后续覆盖保存静默写回。
    save: function () {
      if (!pptSessionId) {
        return Promise.resolve({ ok: false, error: '没有可保存的演示文稿会话' });
      }
      return loadPptxBridge().then(function (mod) {
        return mod.saveDeck(pptSessionId).then(function (bytes) {
          if (!bytes) { return { ok: false, error: '生成 pptx 字节失败' }; }
          var b64 = bufToB64(bytes);
          var name = pptSessionPath ? pptSessionPath.split('/').pop() : 'presentation.pptx';
          var write = pptSessionPath
            ? goJson('saveAnyJson', [pptSessionPath, b64])
            : goJson('saveAsAnyJson', [name, b64]);
          return write.then(function (r) {
            r = r || { ok: false, error: 'file bridge unavailable' };
            if (r.ok && !r.canceled) {
              mod.commitDeck(pptSessionId);
              if (r.path) { pptSessionPath = r.path; }
              return { ok: true, path: r.path || pptSessionPath || '' };
            }
            return r;
          });
        });
      }).catch(function (e) {
        console.error('[GenOffice] pptx save failed: ' + (e && e.message ? e.message : e));
        return { ok: false, error: '保存失败：' + (e && e.message ? e.message : e) };
      });
    },
    // M2 另存为：弹系统保存框 → 字节落盘 → 换会话路径。
    saveAs: function (name) {
      if (!pptSessionId) {
        return Promise.resolve({ ok: false, error: '没有可保存的演示文稿会话' });
      }
      var suggested = (name && String(name)) || 'presentation.pptx';
      if (!/.pptx?$/i.test(suggested)) { suggested += '.pptx'; }
      return loadPptxBridge().then(function (mod) {
        return mod.saveDeck(pptSessionId).then(function (bytes) {
          if (!bytes) { return { ok: false, error: '生成 pptx 字节失败' }; }
          var b64 = bufToB64(bytes);
          return goJson('saveAsAnyJson', [suggested, b64]).then(function (r) {
            r = r || { ok: false, error: 'file bridge unavailable' };
            if (r.ok && !r.canceled && r.path) {
              mod.commitDeck(pptSessionId);
              pptSessionPath = r.path;
              return { ok: true, path: r.path };
            }
            return r;  // 用户取消 → ok:false 无 error，renderer 静默
          });
        });
      }).catch(function (e) {
        console.error('[GenOffice] pptx saveAs failed: ' + (e && e.message ? e.message : e));
        return { ok: false, error: '另存为失败：' + (e && e.message ? e.message : e) };
      });
    },
    // M2 新建空白：真实会话（createBlankPptx → openPptx），保存与打开文件同链路。
    // 替换 __goBoot.newBlank 的纯内存 deck（保存前无引擎模型可落盘）。
    newBlank: function (fitWidthPx) {
      var fit = fitWidthPx || 1280;
      return loadPptxBridge().then(function (mod) {
        if (!mod || typeof mod.newBlankDeck !== 'function') { return null; }
        return mod.newBlankDeck(fit).then(function (r) {
          if (!r) { return null; }
          // 引擎空白 PPT 第一页无占位节点；补标题版式（对齐内存版 applyLayoutToSlide
          // 'builtin:titleSlide' 的行为，用户期望打开即是"点击添加标题/正文"版式）。
          if (typeof mod.setLayoutOp === 'function' && r.sessionId) {
            try {
              var laid = mod.setLayoutOp(r.sessionId, 0, 'builtin:titleSlide', fit);
              if (laid && typeof laid === 'object' && Array.isArray(r.slides) && r.slides.length > 0) {
                r.slides[0] = laid;
              }
            } catch (e) { /* 版式补挂失败不影响新建（仍是空白页） */ }
          }
          pptSessionId = r.sessionId || null;
          pptSessionPath = null;
          slideDeck = { slides: r.slides, size: { cx: r.size.cx, cy: r.size.cy } };
          return r;
        });
      }).catch(function (e) {
        console.error('[GenOffice] pptx newBlank failed: ' + (e && e.message ? e.message : e));
        return null;
      });
    },
    // M1 打开链路：选 .pptx（openFileJson 返回字节 b64）→ pptx-bridge 解析渲染。
    // 返回 OpenResult {path, slides, size, defaultFont, sessionId}（renderer applyOpen 直接消费）。
    openPptx: function (fitWidthPx) {
      var fit = fitWidthPx || 1280;
      return Promise.resolve()
        .then(function () { return mock.openFileJson(PPTX_SUFFIXES); })
        .then(function (raw) {
          if (!raw || raw === '') { return null; }
          var picked;
          try { picked = JSON.parse(raw); } catch (e) { return null; }
          if (!picked || picked.ok !== true || !picked.b64) { return null; }
          var ext = (picked.ext || '').toLowerCase();
          if (ext !== 'pptx' && ext !== 'pptm') { return null; }
          var bytes;
          try { bytes = new Uint8Array(b64ToBuf(picked.b64)); } catch (e) { return null; }
          return openPptxViaBridge(bytes, fit, picked.path || '', picked.name || 'Untitled');
        });
    },
    // 启动时 shell browse() 投递的 .pptx 路径：字节读 → 真实解析渲染；失败/非 pptx → null（新建空白）。
    // 一次性消费：读到即删（含成功路径）。漏删会让下一次"新建 PPT"磁贴（新 iframe 重启
    // consumePendingOpen）重开上次的本地文件而不是新建空白 —— docs/markdown/pdf/sheets 全
    // 是读后即删语义，slides 之前只删了失败分支（真机回归：打开本地后新建磁贴重开旧文件）。
    consumePendingOpen: function (fitWidthPx) {
      var fit = fitWidthPx || 1280;
      var p = '';
      try {
        p = localStorage.getItem('genoffice.pendingOpenPath') || '';
        localStorage.removeItem('genoffice.pendingOpenPath');  // 无论成功/失败/非 pptx 都清
      } catch (e) { /* 忽略 */ }
      if (!p || !/.pptx?$/i.test(p)) {
        return Promise.resolve(null);
      }
      return goJson('openDocxPathJson', [p]).then(function (r) {
        if (!r || r.ok !== true || !r.b64) {
          return null;
        }
        var bytes;
        try { bytes = new Uint8Array(b64ToBuf(r.b64)); } catch (e) { return null; }
        var parts = p.split('/');
        return openPptxViaBridge(bytes, fit, p, parts.pop() || 'Untitled');
      });
    },
    // 编辑：有引擎会话时走事务（setText op + pushHistory，一次提交 = 一个 undo 步，
    // 与桌面 editText 同语义）；无会话回退内存 deck 节点更新。
    // 返回更新后的那张 RenderSlide（renderer commitEdit 用它 setSlides 替换）。
    editText: function (op) {
      try {
        var fit = 1280;
        if (pptSessionId) {
          return loadPptxBridge().then(function (mod) {
            if (!mod || typeof mod.execTxn !== 'function') { return null; }
            // execTxn 返回整副渲染树；renderer editText 需要本页重建 → 会话页重建
            var r = mod.execTxn(pptSessionId, [{
              op: 'setText',
              target: { slide: op.slideIndex, el: op.sourceId },
              paragraphs: op.paragraphs,
            }], fit, true);
            if (r && r.slides && r.slides[op.slideIndex]) { return r.slides[op.slideIndex]; }
            return fallbackEditText(op, fit);
          });
        }
        return Promise.resolve(fallbackEditText(op, fit));
      } catch (e) {
        console.error('[GenOffice] slides editText failed: ' + (e && e.message ? e.message : e));
        return null;
      }
    },
    // M4 撤销/重做（引擎快照栈互换，返回整副渲染树；无会话回退内存未实现 → null）
    undo: function () {
      if (!pptSessionId) { return Promise.resolve(null); }
      return loadPptxBridge().then(function (mod) {
        return mod.undoDeck(pptSessionId, 1280) || null;
      });
    },
    redo: function () {
      if (!pptSessionId) { return Promise.resolve(null); }
      return loadPptxBridge().then(function (mod) {
        return mod.redoDeck(pptSessionId, 1280) || null;
      });
    },
    // M4 形状变换（px → EMU；preview 拖动一次只压一个 undo 步）
    editTransform: function (op) {
      if (!pptSessionId) { return Promise.resolve(null); }
      var fit = (op && op.fitWidthPx) || 1280;
      return loadPptxBridge().then(function (mod) {
        return mod.setTransformOp(
          pptSessionId,
          (op && op.slideIndex) || 0,
          op && op.sourceId,
          (op && op.xPx) || 0,
          (op && op.yPx) || 0,
          (op && op.wPx) || 0,
          (op && op.hPx) || 0,
          (op && op.rotationDeg) || 0,
          fit,
          !!(op && op.preview),
        ) || null;
      });
    },
    // ===== M3 结构化操作（M2 会话化后：真实写进引擎模型，保存一并落盘）=====
    // 会话优先（返回引擎重建的渲染树），无会话回退 __goBoot 内存 deck 实现。
    addSlide: function (op) {
      if (!pptSessionId) { return mock.addSlide ? mock.addSlide(op) : null; }
      var fit = (op && op.fitWidthPx) || 1280;
      return loadPptxBridge().then(function (mod) {
        return mod.insertSlide(pptSessionId, (op && op.sourceIndex) || 0, fit, !!(op && op.clearText)) || null;
      });
    },
    addBlankSlide: function (op) {
      if (!pptSessionId) { return mock.addBlankSlide ? mock.addBlankSlide(op) : null; }
      var fit = (op && op.fitWidthPx) || 1280;
      return loadPptxBridge().then(function (mod) {
        return mod.insertBlankSlideOp(pptSessionId, (op && op.sourceIndex) || 0, fit) || null;
      });
    },
    addSlideWithLayout: function (op) {
      if (!pptSessionId) { return (mock.addSlideWithLayout ? mock.addSlideWithLayout(op) : null); }
      var fit = (op && op.fitWidthPx) || 1280;
      var layoutPath = (op && op.layoutPath) || 'builtin:titleContent';
      return loadPptxBridge().then(function (mod) {
        return mod.insertSlideWithLayoutOp(pptSessionId, (op && op.sourceIndex) || 0, layoutPath, fit) || null;
      });
    },
    setSlideLayout: function (op) {
      if (!pptSessionId) { return mock.setSlideLayout ? mock.setSlideLayout(op) : null; }
      var fit = (op && op.fitWidthPx) || 1280;
      return loadPptxBridge().then(function (mod) {
        return mod.setLayoutOp(
          pptSessionId,
          (op && typeof op.slideIndex === 'number') ? op.slideIndex : 0,
          op && op.layoutPath,
          fit,
        ) || null;
      });
    },
    deleteSlide: function (slideIndex) {
      if (!pptSessionId) { return mock.deleteSlide ? mock.deleteSlide(slideIndex) : null; }
      return loadPptxBridge().then(function (mod) {
        return mod.deleteSlideOp(pptSessionId, slideIndex | 0, 1280) || null;
      });
    },
    moveSlide: function (op) {
      if (!pptSessionId) { return mock.moveSlide ? mock.moveSlide(op) : null; }
      var fit = (op && op.fitWidthPx) || 1280;
      return loadPptxBridge().then(function (mod) {
        return mod.moveSlideOp(
          pptSessionId,
          (op && op.fromIndex) || 0,
          (op && typeof op.toIndex === 'number') ? op.toIndex : 0,
          fit,
        ) || null;
      });
    },
    getLayouts: function () {
      if (!pptSessionId) { return mock.getLayouts ? mock.getLayouts() : null; }
      return loadPptxBridge().then(function (mod) {
        return mod.getLayoutsOp(pptSessionId) || null;
      });
    },
    getSlideSize: function () {
      if (!pptSessionId) { return mock.getSlideSize ? mock.getSlideSize() : null; }
      return loadPptxBridge().then(function (mod) {
        return mod.getSlideSizeOp(pptSessionId) || null;
      });
    },
    setSlideSize: function (op) {
      if (!pptSessionId) { return mock.setSlideSize ? mock.setSlideSize(op) : null; }
      var fit = (op && op.fitWidthPx) || 1280;
      return loadPptxBridge().then(function (mod) {
        return mod.setSlideSizeOp(pptSessionId, (op && op.cx) || 0, (op && op.cy) || 0, fit) || null;
      });
    },
    // ===== M5 元素格式 op（会话优先；无会话回退内存 deck/占位）=====
    setElementFont: function (op) {
      if (!pptSessionId) { return Promise.resolve(null); }
      var fit = (op && op.fitWidthPx) || 1280;
      var font = {
        fontFamily: op && op.fontFamily,
        fontSizePt: op && op.fontSizePt,
        strike: op && op.strike,
        bold: op && op.bold,
        italic: op && op.italic,
        underline: op && op.underline,
        color: op && op.color,
      };
      return loadPptxBridge().then(function (mod) {
        return mod.setElementFontOp(pptSessionId, op.slideIndex, op.sourceIds || [], font, fit, op.groupId) || null;
      });
    },
    setElementParagraphFormat: function (op) {
      if (!pptSessionId) { return Promise.resolve(null); }
      var fit = (op && op.fitWidthPx) || 1280;
      var format = {
        bullet: op && op.bullet,
        bulletChar: op && op.bulletChar,
        bulletHangEmu: op && op.bulletHangEmu,
        bulletSizePct: op && op.bulletSizePct,
        bulletColor: op && op.bulletColor,
        lineSpacingPct: op && op.lineSpacingPct,
        spaceBeforePt: op && op.spaceBeforePt,
        spaceAfterPt: op && op.spaceAfterPt,
        align: op && op.align,
        rtl: op && op.rtl,
        indentDelta: op && op.indentDelta,
      };
      return loadPptxBridge().then(function (mod) {
        return mod.setParagraphFormatOp(pptSessionId, op.slideIndex, op.sourceIds || [], format, fit, op.groupId) || null;
      });
    },
    editStroke: function (op) {
      if (!pptSessionId) { return Promise.resolve(null); }
      var fit = (op && op.fitWidthPx) || 1280;
      return loadPptxBridge().then(function (mod) {
        return mod.setStrokeOp(pptSessionId, op.slideIndex, op.sourceId, op.stroke || null, fit, op.groupId) || null;
      });
    },
    editFill: function (op) {
      if (!pptSessionId) { return Promise.resolve(null); }
      var fit = (op && op.fitWidthPx) || 1280;
      return loadPptxBridge().then(function (mod) {
        return mod.setFillOp(pptSessionId, op.slideIndex, op.sourceId, op.fill, fit, op.groupId) || null;
      });
    },
    // ===== M6 图片系 op + 幻灯片背景 =====
    flipElements: function (op) {
      if (!pptSessionId) { return Promise.resolve(null); }
      var fit = (op && op.fitWidthPx) || 1280;
      return loadPptxBridge().then(function (mod) {
        return mod.flipElementsOp(pptSessionId, op.slideIndex, op.sourceIds || [], op.axis || 'h', fit, op.groupId) || null;
      });
    },
    editPictureSrcRect: function (op) {
      if (!pptSessionId) { return Promise.resolve(null); }
      var fit = (op && op.fitWidthPx) || 1280;
      return loadPptxBridge().then(function (mod) {
        return mod.setPictureSrcRectOp(
          pptSessionId, op.slideIndex, op.sourceId,
          op.srcRect || null, fit,
          op.boxPx || undefined,
        ) || null;
      });
    },
    editPictureOpacity: function (op) {
      if (!pptSessionId) { return Promise.resolve(null); }
      var fit = (op && op.fitWidthPx) || 1280;
      return loadPptxBridge().then(function (mod) {
        return mod.setPictureOpacityOp(pptSessionId, op.slideIndex, op.sourceId, op.opacity, fit) || null;
      });
    },
    // 图片填充：有内联 source（纹理预设）直接用；否则壳内弹系统选图（pickImageJson）
    // 读字节再交引擎（桌面是主进程弹选择器，壳改为经桥取字节）。
    editImageFill: function (op) {
      if (!pptSessionId) { return Promise.resolve(null); }
      var fit = (op && op.fitWidthPx) || 1280;
      var load = op && op.source
        ? Promise.resolve(op.source)
        : goJson('pickImageJson', []).then(function (r) {
            if (!r || !r.base64) { return null; }
            return { base64: r.base64, ext: mimeToExt(r.mime || '') };
          }).catch(function () { return null; });
      return load.then(function (source) {
        if (!source) { return null; }
        return loadPptxBridge().then(function (mod) {
          return mod.setImageFillOp(pptSessionId, op.slideIndex, op.targets || [], op.mode || 'stretch', source, fit) || null;
        });
      });
    },
    // 幻灯片背景：solid/gradient/reset/hide 直通；image 经壳选图拿字节（桌面主进程选择器）。
    editBackground: function (op) {
      if (!pptSessionId) { return Promise.resolve(null); }
      var fit = (op && op.fitWidthPx) || 1280;
      if (op && op.kind === 'image') {
        var load2 = (op.pick === false && op.sourceSlideIndex != null)
          ? Promise.resolve(null)   // 复用已有背景：壳内暂不支持（媒体 part 检索留待后续）
          : goJson('pickImageJson', []).then(function (r) {
              if (!r || !r.base64) { return null; }
              return { base64: r.base64, ext: mimeToExt(r.mime || '') };
            }).catch(function () { return null; });
        return load2.then(function (b64src) {
          if (!b64src) { return null; }
          return loadPptxBridge().then(function (mod) {
            return mod.setBackgroundOp(pptSessionId, op.slideIndex, fit, {
              image: { source: { base64: b64src.base64, ext: b64src.ext }, tile: op.mode === 'tile' },
            }) || null;
          });
        });
      }
      var kind = (op && op.kind) || 'reset';
      var payload;
      if (kind === 'solid') { payload = { solid: op.color }; }
      else if (kind === 'gradient') {
        payload = { gradient: { from: op.from, to: op.to, angleDeg: op.angleDeg, radial: op.radial } };
      } else if (kind === 'hideGraphics') { payload = { hideGraphics: !!op.hidden }; }
      else { payload = { reset: true }; }
      return loadPptxBridge().then(function (mod) {
        return mod.setBackgroundOp(pptSessionId, op.slideIndex, fit, payload) || null;
      });
    },
    // ===== M7 主题 / 组合 / 形状效果 =====
    groupElements: function (op) {
      if (!pptSessionId) { return Promise.resolve(null); }
      var fit = (op && op.fitWidthPx) || 1280;
      return loadPptxBridge().then(function (mod) {
        return mod.groupElementsOp(pptSessionId, op.slideIndex, op.sourceIds || [], fit) || null;
      });
    },
    ungroupElement: function (op) {
      if (!pptSessionId) { return Promise.resolve(null); }
      var fit = (op && op.fitWidthPx) || 1280;
      return loadPptxBridge().then(function (mod) {
        return mod.ungroupElementOp(pptSessionId, op.slideIndex, op.sourceId, fit) || null;
      });
    },
    setEffects: function (op) {
      if (!pptSessionId) { return Promise.resolve(null); }
      var fit = (op && op.fitWidthPx) || 1280;
      return loadPptxBridge().then(function (mod) {
        return mod.setEffectsOp(pptSessionId, op.slideIndex, op.sourceId, op.effects || {}, fit) || null;
      });
    },
    applyTheme: function (op) {
      if (!pptSessionId) { return Promise.resolve(null); }
      var fit = (op && op.fitWidthPx) || 1280;
      return loadPptxBridge().then(function (mod) {
        return mod.applyThemeOp(
          pptSessionId,
          (op && op.name) || 'Custom',
          (op && op.colors) || {},
          op && op.majorFont,
          op && op.minorFont,
          fit,
        ) || null;
      });
    },
    // ===== M8 备注 / 切换 / 动画 / 主视图 / AI 编辑脚本 =====
    getNotes: function (slideIndex) {
      if (!pptSessionId) { return Promise.resolve(''); }
      return loadPptxBridge().then(function (mod) {
        return mod.getNotesOp(pptSessionId, slideIndex | 0) || '';
      });
    },
    setNotes: function (op) {
      if (!pptSessionId) { return Promise.resolve(false); }
      return loadPptxBridge().then(function (mod) {
        return mod.setNotesOp(pptSessionId, (op && op.slideIndex) || 0, (op && op.text) || '');
      });
    },
    getTransition: function (slideIndex) {
      if (!pptSessionId) { return Promise.resolve('none'); }
      return loadPptxBridge().then(function (mod) {
        return mod.getTransitionOp(pptSessionId, slideIndex | 0) || 'none';
      });
    },
    setTransition: function (op) {
      if (!pptSessionId) { return Promise.resolve(false); }
      return loadPptxBridge().then(function (mod) {
        return mod.setTransitionOp(pptSessionId, (op && op.slideIndex) || 0, (op && op.kind) || 'none');
      });
    },
    getAnimations: function (slideIndex) {
      if (!pptSessionId) { return Promise.resolve([]); }
      return loadPptxBridge().then(function (mod) {
        return mod.getAnimationsOp(pptSessionId, slideIndex | 0) || [];
      });
    },
    setAnimations: function (op) {
      if (!pptSessionId) { return Promise.resolve(false); }
      return loadPptxBridge().then(function (mod) {
        return mod.setAnimationsOp(pptSessionId, (op && op.slideIndex) || 0, (op && op.items) || []);
      });
    },
    masterEnter: function (fitWidthPx) {
      if (!pptSessionId) { return Promise.resolve(null); }
      var fit = fitWidthPx || 1280;
      return loadPptxBridge().then(function (mod) {
        return mod.masterEnterOp(pptSessionId, fit) || null;
      });
    },
    masterOpen: function (partPath) {
      if (!pptSessionId) { return Promise.resolve(null); }
      return loadPptxBridge().then(function (mod) {
        return mod.masterOpenOp(pptSessionId, partPath, 1280) || null;
      });
    },
    masterClose: function () {
      if (!pptSessionId) { return Promise.resolve(null); }
      return loadPptxBridge().then(function (mod) {
        return mod.masterCloseOp(pptSessionId, 1280) || null;
      });
    },
    masterEditText: function (op) {
      if (!pptSessionId) { return Promise.resolve(null); }
      return loadPptxBridge().then(function (mod) {
        return mod.masterEditOp(pptSessionId, 'setText', op.sourceId, { paragraphs: op.paragraphs }, 1280) || null;
      });
    },
    masterEditTransform: function (op) {
      if (!pptSessionId) { return Promise.resolve(null); }
      var fit = (op && op.fitWidthPx) || 1280;
      var emuBase = 12192000; // 桌面 EMU_PER_PX_96 = 9525，16:9 基准宽 = 12192000/9525 = 1280px
      var scale = fit / 1280;
      return loadPptxBridge().then(function (mod) {
        return mod.masterEditOp(pptSessionId, 'setTransform', op.sourceId, {
          box: {
            x: Math.round(((op.xPx || 0) * emuBase) / 1280),
            y: Math.round(((op.yPx || 0) * emuBase) / 1280),
            cx: Math.round(((op.wPx || 0) * emuBase) / 1280),
            cy: Math.round(((op.hPx || 0) * emuBase) / 1280),
          },
          rotDeg: (op && op.rotationDeg) || 0,
        }, fit) || null;
      });
    },
    masterEditFill: function (op) {
      if (!pptSessionId) { return Promise.resolve(null); }
      return loadPptxBridge().then(function (mod) {
        return mod.masterEditOp(pptSessionId, 'setFill', op.sourceId, { fill: op.fill }, 1280) || null;
      });
    },
    masterEditStroke: function (op) {
      if (!pptSessionId) { return Promise.resolve(null); }
      return loadPptxBridge().then(function (mod) {
        return mod.masterEditOp(pptSessionId, 'setStroke', op.sourceId, {
          stroke: op.stroke ? { color: op.stroke.color, widthEmu: Math.round((op.stroke.widthPt || 1) * 12700) } : null,
        }, 1280) || null;
      });
    },
    applyEditScript: function (op) {
      if (!pptSessionId) { return Promise.resolve(null); }
      // 参数守卫：空/残缺 op（smoke 占位、异常调用）不喂给引擎 —— 引擎读 op.boxes
      // 对 undefined 抛 "not iterable"，真机温和降级（返回 null）优于抛错上屏。
      if (!op || typeof op !== 'object' || !(op.boxes || op.edits || op.ops)) {
        return Promise.resolve(null);
      }
      var fit = (op && op.fitWidthPx) || 1280;
      return loadPptxBridge().then(function (mod) {
        return mod.applyEditScriptOp(pptSessionId, op, fit) || null;
      });
    },
    // ====== 差集补齐：28 个方法（消除 Proxy warn + 返回类型对齐） ======
    // --- on* 回调（8 个）：鸿蒙壳无对应触发源，注册回调后永不调用，返回 NOOP 作 unsubscribe ---
    onAudienceNav: function () { return NOOP; },
    onDeckChanged: function () { return NOOP; },
    onFontsChanged: function () { return NOOP; },
    onHistoryChanged: function () { return NOOP; },
    onOpened: function () { return NOOP; },
    onRenamed: function () { return NOOP; },
    onShowInk: function () { return NOOP; },
    onShowSync: function () { return NOOP; },
    // --- 放映/观众视图（6 个）：鸿蒙版未接放映/观众视图，与 presenterStart 同口径 ---
    presenterEnd: function () { return Promise.resolve(); },
    presenterInk: function () { return Promise.resolve(); },
    presenterSwap: function () { return Promise.resolve(); },
    presenterSync: function () { return Promise.resolve(); },
    audienceNav: function () { return Promise.resolve(); },
    audienceReady: function () { return Promise.resolve(null); },
    // --- 剪贴板（3 个）：鸿蒙壳无系统剪贴板桥接 ---
    clipboardProbe: function () { return Promise.resolve(false); },
    clipboardExternal: function () { return Promise.resolve(null); },
    nativeClipboard: function () { return Promise.resolve(); },
    // --- 私有字体（2 个）：鸿蒙壳无嵌入字体管理 ---
    privateFontFaces: function () { return Promise.resolve([]); },
    privateFontData: function () { return Promise.resolve(null); },
    // --- 编辑操作（5 个）：pptx-bridge 无对应 op，降级返回 null（渲染层 if (!result) skip） ---
    editConnectorEndpoints: function () { return Promise.resolve(null); },
    editTransformMulti: function () { return Promise.resolve(null); },
    masterDeleteElement: function () { return Promise.resolve(null); },
    getChartData: function () { return Promise.resolve(null); },
    getLink: function () { return Promise.resolve(null); },
    // --- 其他（4 个） ---
    addMediaBytes: function () { return Promise.resolve(null); },
    applyHeaderFooter: function () { return Promise.resolve(null); },
    getMediaData: function () { return Promise.resolve(null); },
    setAdvanceTimes: function () { return Promise.resolve(false); },
  });
  // mime → 图片扩展名（pickImageJson 给 mime；桌面 EditFillImageOp 要 ext 后缀）
  function mimeToExt(mime) {
    var m = String(mime || '').toLowerCase().split('/').pop();
    if (m === 'jpeg') { return 'jpg'; }
    if (m === 'svg+xml') { return 'svg'; }
    return m || 'png';
  }
  function fallbackEditText(op, fit) {
    try {
      var s = slideDeck.slides[op && op.slideIndex];
      if (!s || !Array.isArray(s.nodes)) { return null; }
      var node = s.nodes.find(function (n) { return n && n.sourceId === op.sourceId; });
      if (!node || !node.text) { return null; }
      // 编辑段落的 runs（DOM 权威样式）写回节点文本结构（与占位节点同构）。
      // 字号：EditRun.fontSize 为 pt（overlay 提交时除以 scale 还原），
      // 板面按 96dpi 换算 px ≈ pt × 4/3（新 deck scale=1，1280 基准）。
      var paragraphs = (op && Array.isArray(op.paragraphs) ? op.paragraphs : []);
      var lines = paragraphs.map(function (p) {
        var runs = (p && Array.isArray(p.runs) ? p.runs : []).map(function (r, i) {
          var pt = parseFloat(String(r && r.fontSize != null ? r.fontSize : ''));
          var fontSizePx = isFinite(pt) && pt > 0 ? Number((pt * 4 / 3).toFixed(2)) : 18;
          return {
            text: r && r.text != null ? String(r.text) : '',
            fontFamily: (r && r.fontFamily) || '',
            fontSizePx: fontSizePx,
            color: (r && r.color) || '#202124',
            bold: !!(r && r.bold), italic: !!(r && r.italic), underline: !!(r && r.underline),
            x: 0, baselineY: fontSizePx * 0.85, widthPx: 0, ascentPx: fontSizePx * 0.8,
            order: i,
          };
        });
        var fs = (runs.length && runs[0].fontSizePx) || 18;
        return {
          runs: runs,
          top: 0, height: fs * 1.2,
          align: (p && p.align) || 'left',
        };
      });
      node.text.lines = lines;
      node.text.contentHeight = lines.reduce(function (acc, l) { return acc + l.height; }, 0);
      return s;
    } catch (e) {
      return null;
    }
  }
  // sheets(Excel) 的 desktopApi.exportPdf 契约与 docs 不同 —— 见
  // apps/sheets/src/renderer/page-layout-actions.ts:412：它只判
  // result.canceled ? 已取消 : 已导出到(result.path)，【没有 error 分支】，
  // 所以「返回错误对象」在该侧会被显示成"已导出到 undefined"（误导性成功）。
  // 该流程唯一能露出自定义原因的出口是 :420 的 catch → 必须 reject(throw)。
  var sheetsMock = Object.assign({}, mock, {
    exportPdf: function () {
      return Promise.reject(new Error(HTML2PDF_UNAVAILABLE));
    },
  });
  // html(HTML 编辑器/预览器)：保存/读图语义与 markdown 同构（纯文本 + 相对路径插图），
  // 但保存扩展名是 .html；差集方法 8 个（preview/present/readText/provisionalTitle 等）。
  var htmlSavedPath = null;
  var htmlDocPath = null;
  var htmlImgGrantDir = null;
  var htmlImgWriteDir = null;
  var HTML_IMG_EXT = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
    'image/webp': 'webp', 'image/bmp': 'bmp'
  };
  function htmlWriteImage(baseName, ext, b64) {
    if (!htmlDocPath) { return Promise.resolve(null); }
    var docDir = markdownNormDir(markdownDirUriOf(htmlDocPath));
    if (docDir.length === 0) { return Promise.resolve(null); }
    var name = String(baseName || 'image');
    var dot = name.lastIndexOf('.');
    if (dot > 0) { name = name.substring(0, dot); }
    if (name.length === 0) { name = 'image'; }
    var stamp = Date.now().toString(36);
    var fileName = name + '-' + stamp.substring(stamp.length - 4) + '.' + (ext || 'png');
    var ask = htmlImgWriteDir ? Promise.resolve(htmlImgWriteDir) : goJson('pickDirectory', []);
    return ask.then(function (dir) {
      if (!dir || markdownNormDir(dir) !== docDir) { return null; }
      htmlImgWriteDir = dir;
      return goJson('saveInDirJson', [dir, fileName, b64]).then(function (r) {
        r = r || {};
        return (r.ok && r.path) ? fileName : null;
      });
    });
  }
  function htmlReadImageBytesAuthorized(uri) {
    return readImageBytes(uri).then(function (got) {
      if (got) { return got; }
      var slash = String(uri || '').lastIndexOf('/');
      var dir = (slash > 0) ? String(uri).substring(0, slash) : '';
      if (!dir || htmlImgGrantDir === dir) { return null; }
      htmlImgGrantDir = dir;
      console.info('[GenOffice] html readImage needs dir grant: ' + dir);
      return goJson('pickDirectory', []).then(function (pr) {
        if (!pr || !pr.ok || !pr.uri) { return null; }
        return readImageBytes(uri);
      }).catch(function (e) {
        console.error('[GenOffice] dir grant failed: ' + (e && e.message ? e.message : e));
        return null;
      });
    });
  }
  var htmlMock = Object.assign({}, mock, {
    save: function (op) {
      op = op || {};
      var b64 = bufToB64(new TextEncoder().encode(op.text || ''));
      var name = (op.suggestedName || op.defaultName || 'Untitled');
      if (!/.html?$/i.test(name)) { name += '.html'; }
      var target = (op.mode === 'saveAs') ? null : htmlSavedPath;
      return (target ? goJson('saveAnyJson', [target, b64]) : goJson('saveAsAnyJson', [name, b64]))
        .then(function (r) {
          r = r || { ok: false, error: 'file bridge unavailable' };
          if (r.ok && !r.canceled && r.path) {
            htmlSavedPath = r.path;
            if (htmlDocPath !== r.path) { htmlDocPath = r.path; htmlImgGrantDir = null; }
          }
          return r;
        });
    },
    readFile: function (p) {
      if (typeof p === 'string' && p.length > 0 && htmlDocPath !== p) {
        htmlDocPath = p; htmlImgGrantDir = null;
      }
      return mock.readFile(p);
    },
    readImage: function (src) {
      if (typeof src !== 'string' || !src) { return Promise.resolve(null); }
      if (/^[a-z][a-z0-9+.-]*:/i.test(src)) { return Promise.resolve(null); }
      if (!markdownImageMime(src)) { return Promise.resolve(null); }
      if (!htmlDocPath) { return Promise.resolve(null); }
      var uri = markdownResolveImageUri(htmlDocPath, src);
      if (!uri) { return Promise.resolve(null); }
      return htmlReadImageBytesAuthorized(uri).then(function (got) {
        return got ? { base64: got.b64, mime: got.mime } : null;
      });
    },
    pickImage: function () {
      return goJson('pickImageJson', []).then(function (picked) {
        picked = picked || {};
        var b64 = (typeof picked.base64 === 'string') ? picked.base64 : '';
        if (b64.length === 0) { return null; }
        var ext = HTML_IMG_EXT[picked.mime] || 'png';
        return htmlWriteImage(picked.name, ext, b64);
      });
    },
    saveImage: function (req) {
      req = req || {};
      var b64 = (typeof req.base64 === 'string') ? req.base64 : '';
      if (b64.length === 0) { return Promise.resolve(null); }
      var ext = (typeof req.ext === 'string' && req.ext.length > 0) ? req.ext : 'png';
      return htmlWriteImage('pasted', ext, b64);
    },
    exportPdf: function (req) {
      return Promise.resolve({ ok: false, error: HTML2PDF_UNAVAILABLE });
    },
    exportDocx: function (req) {
      req = req || {};
      var html = (typeof req.html === 'string') ? req.html : '';
      var b64 = bufToB64(new TextEncoder().encode(html));
      if (b64.length === 0) {
        return Promise.resolve({ ok: false, error: 'html: bad export request' });
      }
      var name = (req.suggestedName || 'Untitled') + '.docx';
      return goJson('saveAsAnyJson', [name, b64]).then(function (r) {
        r = r || { ok: false, error: 'file bridge unavailable' };
        if (r.ok && r.canceled) { return { ok: true, canceled: true }; }
        if (!r.ok || !r.path) { return { ok: false, error: String(r.error || 'write failed') }; }
        return { ok: true, path: r.path };
      });
    },
    exportHtml: function (req) {
      req = req || {};
      var html = (typeof req.html === 'string') ? req.html : '';
      var b64 = bufToB64(new TextEncoder().encode(html));
      var name = (req.suggestedName || 'Untitled');
      if (!/.html?$/i.test(name)) { name += '.html'; }
      if (typeof req.outPath === 'string' && req.outPath.length > 0) {
        return goJson('saveAnyJson', [req.outPath, b64]).then(function (r) {
          r = r || { ok: false, error: 'file bridge unavailable' };
          if (r.ok) { return { ok: true, path: r.path || req.outPath }; }
          return { ok: false, error: String(r.error || 'write failed') };
        });
      }
      return goJson('saveAsAnyJson', [name, b64]).then(function (r) {
        r = r || { ok: false, error: 'file bridge unavailable' };
        if (r.ok && !r.canceled && r.path) { return { ok: true, path: r.path }; }
        if (r.ok) { return { ok: false }; }
        return { ok: false, error: String(r.error || 'write failed') };
      });
    },
    getPreviewInfo: function () { return Promise.resolve({ url: '' }); },
    updatePreview: function () {},
    setPresentFullScreen: function () { return Promise.resolve(); },
    presentInNewTab: function () { return Promise.resolve(false); },
    onFileRenamed: function () { return NOOP; },
    setProvisionalTitle: function () {},
    onReadTextRequest: function () { return NOOP; },
    sendReadTextResult: function () {},
    getAutoSaveDefault: function () { return Promise.resolve({ on: false, updatedAt: 0 }); },
    onAutoSaveDefaultChanged: function () { return NOOP; },
  });
  makeBridge('desktop', mock);
  makeBridge('desktopApi', sheetsMock);   // sheets 的桥名：方法集继承 desktop，仅覆写契约不同的项
  makeBridge('slidesApi', slidesMock); // slides：177 方法，显式 mock + 兜底
  makeBridge('markdownApi', markdownMock);  // markdown
  makeBridge('pdfApi', pdfMock);    // pdf：readFile 走专属 overlay
  makeBridge('htmlApi', htmlMock);   // html：保存/读图语义同 markdown，差集 8 方法
  makeBridge('projectApi', projectMock);
})();

`;

// shell 起始页桥：window.aiOffice / aiOfficeProject / tabsApi
// （apps/shell/src/preload/index.ts 暴露的三组 API，含模型设置 getAiProviders 等）
// newDoc/newSheet/... 在 Tab 宿主模式：shell 页面创建 iframe 承载对应 app（web/<app>/index.html），
// Tab 状态经 aiOfficeTabs.list/onChanged 与 React TabBar 双向联动 —— 等价 Electron WebContentsView 架构。
const SHELL_BRIDGE = `(function () {

  if (window.aiOffice && window.aiOffice.__wrapped) { return; }
  // 只在顶层 shell 安装（documentStart 注入对 iframe 同样生效，防止 app iframe 里再装一套 Tab 宿主）
  try { if (window.top !== window.self) { return; } } catch (e) { return; }
  var EMPTY_PAGE = { entries: [], total: 0, totalAll: 0 };
  var NOOP = function () {};
  var SAVE_DIR_KEY = 'genoffice.saveDir';
  // 版本号：与 AppScope/app.json5 的 versionName、DesktopBridge.APP_VERSION 三处必须一致
  // （verify-all 的 checkAppVersionConsistency 比对）。市场内测/发版时三处一起改。
  var SHELL_APP_VERSION = '2.0.1';

  // ===== 桥 helper（与 PROMISE_SHIM 同源实现；SHELL_BRIDGE 是独立闭包，必须自带一份）=====
  // 真实桥在 window.desktopNative（gin 宿主对象，方法不可枚举，不能靠 merge 进 mock）。
  function nativeBridge() {
    var w = window;
    try {
      while (w) {
        var c1 = w.desktopNative;
        if (c1 && typeof c1.bridgeCall === 'function') {
          if (!w.__goNativeLogged) {
            w.__goNativeLogged = true;
            console.info('[GenOffice] nativeBridge via desktopNative');
          }
          return c1;
        }
        var c2 = w.desktop;
        if (c2 && c2 !== c1 && typeof c2.bridgeCall === 'function') { return c2; }
        if (w === w.parent) { break; }
        w = w.parent;
      }
    } catch (e) { /* 跨域 */ }
    console.warn('[GenOffice] shell nativeBridge not found');
    return null;
  }
  function goNative(method, args) {
    var b = nativeBridge();
    if (!b) { return Promise.resolve(undefined); }
    try { return Promise.resolve(b.bridgeCall(method, JSON.stringify(args || []))); }
    catch (e) { return Promise.reject(e); }
  }
  function goJson(method, args) {
    var b = nativeBridge();
    if (!b) { return Promise.resolve(null); }
    try {
      var r = b.bridgeCall(method, JSON.stringify(args || []));
      return Promise.resolve(r).then(function (j) {
        if (!j) { return null; }
        try { return JSON.parse(j); } catch (e) { return null; }
      });
    } catch (e) { return Promise.resolve(null); }
  }
  // ===== 壳侧三桥的 Proxy 兜底（与 PROMISE_SHIM 的 makeBridge 同语义）=====
  // 事故（真机实测）：window.aiOffice 过去是**裸对象赋值**（只写了 aiOffice.__wrapped = true
  // 这个标记，并没有真的包 Proxy）→ 渲染层调到未实现的方法时拿到 undefined，
  // 直接抛 "window.aiOffice.folderRoots is not a function" → React 渲染中断 → **起始页白屏**。
  // app 侧六桥都经 makeBridge 的 Proxy，所以同类缺口在 app 里只是「静默 no-op」；
  // 壳侧必须是同一套语义，否则缺口=崩溃（壳还托管所有 iframe，白屏等于整个应用不可用）。
  // 与 makeBridge 的两点差别（刻意的）：
  //   1) **不覆写已有键** —— aiOffice 自己的 getAiSettings 永不返回 null（SettingsModal 对 null
  //      渲染空白），被 makeBridge 的通用实现覆盖会退化；
  //   2) 不做 ArkTS 晚注入 merge —— 壳侧三桥没有 registerJavaScriptProxy 对应物。
  // SHELL_BRIDGE 是独立闭包且不能假定 PROMISE_SHIM 先跑，所以自带一份实现。
  function wrapShellBridge(name, obj) {
    var base = obj || {};
    base.__wrapped = true;
    // __has(method): 能力探测 — 判断方法是否在桥上有真实实现（不是 Proxy 兜底）
    // 渲染层可在调用前检查：if (window.aiOffice.__has('folderRoots')) { ... }
    base.__has = function (method) {
      return Object.prototype.hasOwnProperty.call(base, method) && typeof base[method] === 'function';
    };
    // __unsupported(method): 结构化诊断 — 未实现方法的信息（不再静默无反应）
    base.__unsupported = function (method) {
      return { method: method, bridge: name, message: 'Method not yet implemented on HarmonyOS' };
    };
    var proxy = new Proxy(base, {
      get: function (t, k) {
        if (k in t) { return t[k]; }
        if (typeof k !== 'string' || k.charAt(0) === '_') { return undefined; }
        // on* 是订阅：必须返回「能调用且给出退订函数」的函数，裸 undefined 会让
        // 渲染层 useEffect 里的清理函数变成 undefined（卸载时调用即抛）
        if (k.indexOf('on') === 0) { return function () { return NOOP; }; }
        // 未实现方法：返回带诊断信息的 Promise（不再静默 undefined）
        // 控制台可见方法名 + 桥名，便于定位「点了没反应」的根因
        console.warn('[GenOffice] unsupported: ' + name + '.' + k);
        return function () { return Promise.resolve(undefined); };
      }
    });
    try { window[name] = proxy; } catch (e) { /* 忽略 */ }
    return proxy;
  }
  function b64ToBuf(b64) {
    try {
      var bin = atob(b64 || '');
      var len = bin.length;
      var buf = new ArrayBuffer(len);
      var view = new Uint8Array(buf);
      for (var i = 0; i < len; i++) { view[i] = bin.charCodeAt(i); }
      return buf;
    } catch (e) { return new ArrayBuffer(0); }
  }

  // ===== AI 设置：自持存取（与 PROMISE_SHIM 同 key 同结构）=====
  // 不再依赖 __goShared —— 实测 shell 主框架里 documentStart 脚本的执行顺序
  // 不保证 PROMISE_SHIM 先跑（__goShared 未就绪导致 getAiSettings 返回 null、
  // SettingsModal 渲染空白）。iframe 里的 app 不受影响（SHELL_BRIDGE 有 top guard）。
  var AI_KEY = 'genoffice.aiSettings';
  var DEF_PROVIDERS = {
    // Genspark 通道彻底移除：它的 LLM 走 Genspark 侧记在 GenOffice 账上的代理（app_type /
    // key_name = genoffice 落 billing_tag + X-Agent-Type 分账），fork 无权使用；鸿蒙侧本来
    // 也没有 device-code 登录（无 Node 主进程 / 无 ~/.genoffice/auth.json）→ 留着只是死入口。
    // 这里的 model 只是预填，「AI 模型」分区里可改；custom 给空串 → 渲染层转成自由输入框。
    anthropic: 'claude-sonnet-5', gemini: 'gemini-3.7-flash',
    deepseek: 'deepseek-v4-pro', openai: 'gpt-5.6-terra', kimi: 'kimi-k3',
    glm: 'glm-5.3', qwen: 'qwen3.8-max', doubao: 'doubao-seed-2-1-pro-260628',
    minimax: 'MiniMax-M3', xai: 'grok-4.6', mistral: 'mistral-medium-latest',
    openrouter: 'openrouter/auto', 'opencode-zen': 'claude-sonnet-5', 'opencode-go': 'kimi-k2.7-code',
    custom: ''
  };
  // media / search 必须是「全形状」：AiMediaPane 见 !settings.media || !settings.search 直接
  // return null —— 缺字段等于「AI 媒体与搜索」整块空白，Serper / Tavily 的 Key 没地方填。
  function defaultAiMediaSettings() {
    var mp = {};
    var ids = ['openai', 'gemini', 'doubao', 'glm', 'xai', 'qwen', 'minimax', 'custom'];
    for (var i = 0; i < ids.length; i++) {
      mp[ids[i]] = { apiKey: '', baseUrl: '', imageModel: '', analysisModel: '' };
    }
    return { imageProvider: 'custom', analysisProvider: 'custom', videoAnalysisProvider: 'custom', providers: mp };
  }
  function defaultAiSearchSettings() {
    return {
      provider: 'serper',
      providers: { serper: { apiKey: '' }, tavily: { apiKey: '' }, parallel: { apiKey: '' } }
    };
  }
  function defaultAiSettings() {
    var p = {};
    Object.keys(DEF_PROVIDERS).forEach(function (id) { p[id] = { apiKey: '', model: DEF_PROVIDERS[id], baseUrl: '', models: [] }; });
    return { provider: 'glm', providers: p, media: defaultAiMediaSettings(), search: defaultAiSearchSettings(), autoModel: false };
  }
  // 用户自存模型列表：只留非空字符串、去重、限长 40 条（防止手输把配置撑爆）。
  function sanitizeModelList(v) {
    if (!v || !v.length) { return []; }
    var out = [];
    for (var i = 0; i < v.length && out.length < 40; i++) {
      var m = v[i];
      if (typeof m !== 'string') { continue; }
      m = m.trim();
      if (m && out.indexOf(m) < 0) { out.push(m); }
    }
    return out;
  }
  // 老配置（存过 genspark / 缺 media、search）补齐：不补就会整块面板空白、provider 落空。
  function normalizeAiSettings(o) {
    var d = defaultAiSettings();
    if (!o.provider || o.provider === 'genspark' || o.provider === 'codex') { o.provider = 'glm'; }
    var keys = Object.keys(d.providers);
    for (var i = 0; i < keys.length; i++) {
      var cur = o.providers[keys[i]] || {};
      o.providers[keys[i]] = {
        apiKey: cur.apiKey || '', model: cur.model || d.providers[keys[i]].model, baseUrl: cur.baseUrl || '',
        models: sanitizeModelList(cur.models)
      };
    }
    if (!o.media || !o.media.providers) { o.media = defaultAiMediaSettings(); }
    if (!o.search || !o.search.providers) { o.search = defaultAiSearchSettings(); }
    o.autoModel = !!o.autoModel;
    return o;
  }
  // AI 面板的模型选择：AUTO 开关 + 当前提供商的候选列表（自存列表，含当前 model）。
  // 面板下拉直接吃这三个字段，不必各自读整份配置。
  var AI_MODEL_AUTO = '__auto__';
  function aiChatModelChoices() {
    var s = loadAiSettings();
    var pc = (s.providers && s.providers[s.provider]) || {};
    var list = sanitizeModelList(pc.models);
    var cur = pc.model || '';
    if (cur && list.indexOf(cur) < 0) { list = [cur].concat(list); }
    return { auto: !!s.autoModel, current: s.autoModel ? AI_MODEL_AUTO : cur, models: list };
  }
  // auto 哨兵或空串 = 开 AUTO；其余按模型 id 钉住（顺手关掉 AUTO，避免"选了却没生效"）。
  function aiApplyChatModel(m) {
    var s = loadAiSettings();
    if (m === AI_MODEL_AUTO || m === null || m === undefined || m === '') {
      s.autoModel = true;
      saveAiSettings(s);
      return aiChatModelChoices();
    }
    s.autoModel = false;
    var pc = (s.providers && s.providers[s.provider]) || {};
    pc.model = String(m);
    if (s.providers && s.providers[s.provider]) { s.providers[s.provider] = pc; }
    saveAiSettings(s);
    return aiChatModelChoices();
  }
  function loadAiSettings() {
    try {
      var s = localStorage.getItem(AI_KEY);
      if (s) { var o = JSON.parse(s); if (o && o.providers) { return normalizeAiSettings(o); } }
    } catch (e) { /* 损坏则回默认 */ }
    return defaultAiSettings();
  }
  function saveAiSettings(s) {
    try { localStorage.setItem(AI_KEY, JSON.stringify(s || {})); } catch (e) { /* 忽略 */ }
  }
  // AI 面板默认值：仅在 __goShared 不可用（注入顺序被打断/异常包）时兜底；正常路径与 app 侧
  // 读同一份 localStorage（key=genoffice.aiPanelPrefs，规则见 packages/ui/src/ai-panel-prefs.ts）。
  var AI_PANEL_FALLBACK = { side: 'left', fontSize: 'default', customFontSize: 14, spellcheck: true };
  console.info('[GenOffice] shell bridge ready; promise-shim shared=' + (window.__goShared ? 'yes' : 'no'));

  // ===== 顶层 native 调用转发器 =====
  // gin 桥方法只能在注入它的 frame 里调用（iframe 直接调 parent 的桥报 non-injected
  // object），但跨 frame 调普通 JS 函数合法 —— app iframe 经 __goNativeCall 转发。
  // documentStart 时 ArkTS 注入可能尚未完成，轮询直到 desktopNative 就绪再安装。
  (function installForwarder(attempt) {
    var nb = null;
    try { nb = nativeBridge(); } catch (e) { nb = null; }
    if (nb && typeof nb.bridgeCall === 'function') {
      window.__goNativeCall = function (method, args) {
        // 统一走 bridgeCall 调度（所有 async 方法合并为 1 个 gin 桥入口）
        console.info('[GenOffice] __goNativeCall: ' + method + ' argsLen=' + (args ? args.length : 0) + ' nb=' + (!!nb));
        try { return nb.bridgeCall(method, JSON.stringify(args || [])); }
        catch (e) {
          console.error('[GenOffice] __goNativeCall: ' + method + ' threw: ' + (e && (e.message || e)));
          return null;
        }
      };
      console.info('[GenOffice] __goNativeCall forwarder installed');
      return;
    }
    if (attempt < 100) { setTimeout(function () { installForwarder(attempt + 1); }, 100); }
    else { console.warn('[GenOffice] forwarder: desktopNative 未就绪，放弃安装'); }
  })(0);

  // ===== AI provider 目录（AiCatalogEntry = AiProviderMeta + defaultBaseUrl） =====
  // AI 提供方目录（AiCatalogEntry = AiProviderMeta + defaultBaseUrl）——**壳侧数据，不走上游 i18n**，
  // 所以 label / placeholder 可以直接写中文。渲染层的规则：
  //   models 非空 → 下拉选择；models 为空 → 自由输入框（可填任意模型 id）
  //   needsBaseUrl → 显示端点输入框（填了就完全覆盖官方端点，含 http://localhost）
  // Genspark 条目已删（其代理按 GenOffice 记账，fork 无权用；鸿蒙也没有 device-code 登录）。
  var AI_CATALOG = [
    { id: 'glm', label: 'GLM（智谱）', models: [], defaultModel: 'glm-5.3', keyPlaceholder: 'sk-...', needsBaseUrl: true, defaultBaseUrl: '' },
    { id: 'deepseek', label: 'DeepSeek', models: [], defaultModel: 'deepseek-v4-pro', keyPlaceholder: 'sk-...', needsBaseUrl: true, defaultBaseUrl: '' },
    { id: 'qwen', label: 'Qwen（阿里云百炼）', models: [], defaultModel: 'qwen3.8-max', keyPlaceholder: 'sk-...', needsBaseUrl: true, defaultBaseUrl: '' },
    { id: 'doubao', label: '豆包（火山方舟）', models: [], defaultModel: 'doubao-seed-2-1-pro-260628', keyPlaceholder: 'sk-...', needsBaseUrl: true, defaultBaseUrl: '' },
    { id: 'kimi', label: 'Kimi（月之暗面）', models: [], defaultModel: 'kimi-k3', keyPlaceholder: 'sk-...', needsBaseUrl: true, defaultBaseUrl: '' },
    { id: 'minimax', label: 'MiniMax', models: [], defaultModel: 'MiniMax-M3', keyPlaceholder: 'sk-...', needsBaseUrl: true, defaultBaseUrl: '' },
    // 下面几条面向「任意端点 + 任意模型 id」：各类 token plan / 订阅转 API 中转站走这里。
    { id: 'custom', label: '自定义端点（OpenAI 兼容）', models: [], defaultModel: '', keyPlaceholder: 'sk-...', needsBaseUrl: true, defaultBaseUrl: '' },
    { id: 'anthropic', label: 'Claude（Anthropic 协议 /v1/messages）', models: [], defaultModel: 'claude-sonnet-5', keyPlaceholder: 'sk-ant-...', needsBaseUrl: true, defaultBaseUrl: '' },
    { id: 'openrouter', label: 'OpenRouter（聚合网关）', models: [], defaultModel: 'openrouter/auto', keyPlaceholder: 'sk-or-...', needsBaseUrl: true, defaultBaseUrl: '' },
    // 境外厂商：接口能连通就可用，但大陆商店上架请引导用户选上面境内的提供方（合规考虑）。
    { id: 'openai', label: 'OpenAI', models: [], defaultModel: 'gpt-5.6-terra', keyPlaceholder: 'sk-...', needsBaseUrl: true, defaultBaseUrl: '' },
    { id: 'gemini', label: 'Gemini（OpenAI 兼容路径）', models: [], defaultModel: 'gemini-3.7-flash', keyPlaceholder: 'AIza...', needsBaseUrl: true, defaultBaseUrl: '' },
    { id: 'xai', label: 'Grok', models: [], defaultModel: 'grok-4.6', keyPlaceholder: 'xai-...', needsBaseUrl: true, defaultBaseUrl: '' },
    { id: 'mistral', label: 'Mistral', models: [], defaultModel: 'mistral-medium-latest', keyPlaceholder: 'sk-...', needsBaseUrl: true, defaultBaseUrl: '' },
    { id: 'opencode-zen', label: 'OpenCode Zen', models: [], defaultModel: 'claude-sonnet-5', keyPlaceholder: '', needsBaseUrl: true, defaultBaseUrl: '' },
    { id: 'opencode-go', label: 'OpenCode Go', models: [], defaultModel: 'kimi-k2.7-code', keyPlaceholder: '', needsBaseUrl: true, defaultBaseUrl: '' }
  ];
  // 搜索提供方：只列鸿蒙侧真实现的（Serper 网搜+图搜 / Tavily 仅网搜）。
  // parallel 与 genspark 未接 → 不给目录就不会出现在设置里，避免「填了 Key 也没用」。
  var AI_SEARCH_CATALOG = [
    { id: 'serper', label: 'Serper（Google 结果，含图片搜索）', keyPlaceholder: '申请 serper.dev 免费 Key', imageSearch: true },
    { id: 'tavily', label: 'Tavily（面向 LLM 的搜索 API，仅网页结果）', keyPlaceholder: '申请 tavily.com 免费 Key（tvly-...）', imageSearch: false },
    { id: 'parallel', label: 'Parallel（v1 search，仅网页结果）', keyPlaceholder: '申请 parallel.ai API Key', imageSearch: false }
  ];
  // 生图 / 图片分析目录。**不得为空**：上游 AiMediaPane 的写法是
  //   meta = options.find(m => m.id === current) ?? options[0]!   然后读 meta.id
  //   —— TS 的 ! 非空断言运行时不检查，空数组时 options[0] 就是 undefined，一点即崩
  //   （批次 E 首版踩过；当时给这条写的反例还把"空目录"当合法态 → 反例设计漏洞已修）。
  // 而且三个能力区块的过滤条件不同（生图看 imageProtocol / 图片分析看 analysisProtocol /
  // 视频分析要 analysisProtocol && videoAnalysis），**三条过滤结果各自都必须 ≥1**。
  // 供应商清单对齐上游 packages/ai-provider/src/media.ts 的 AI_MEDIA_PROVIDERS（去掉 genspark），
  // 但只留**鸿蒙侧真能跑**的两类端点：
  //   生图 = POST {base}/images/generations（OpenAI 兼容；见 aiGenerateImage）
  //   解析 = POST {base}/chat/completions 多模态（见 aiAnalyzeMedia）
  // 上游的 gemini（原生 generateContent）与 minimax（/image_generation 原生协议）**生图**没接，
  // 所以这两家不给 imageProtocol → 不会出现在「生图」供应商下拉里（填在选项里点了必然失败）。
  // Gemini 的解析走它自家的 OpenAI 兼容路径（AI_MEDIA_BASE.gemini 指到 /v1beta/openai）→ 解析可用。
  var AI_MEDIA_CATALOG = [
    {
      id: 'openai', label: 'OpenAI 兼容生图（/images/generations）',
      description: '任何提供 /images/generations 的端点都能用；填 Key 后可改端点与模型 id。',
      keyPlaceholder: 'sk-...', defaultBaseUrl: 'https://api.openai.com/v1',
      imageProtocol: 'openai-images', imageModels: ['gpt-image-2', 'gpt-image-1.5', 'gpt-image-1', 'gpt-image-1-mini', 'dall-e-3'], defaultImageModel: 'gpt-image-1',
      analysisProtocol: 'openai-chat', analysisModels: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4-mini'], defaultAnalysisModel: 'gpt-5.6-terra',
      videoAnalysis: false
    },
    {
      id: 'glm', label: 'GLM（智谱）',
      description: 'CogView 生图走 /images/generations；GLM-V 解析图片。在「AI 模型」里配过智谱的话，这里不填 Key 也会自动复用。',
      keyPlaceholder: 'xxxxxxxx.xxxxxxxx', defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      imageProtocol: 'openai-images', imageModels: ['cogview-4-250304', 'cogview-3-flash'], defaultImageModel: 'cogview-4-250304',
      analysisProtocol: 'openai-chat', analysisModels: ['glm-4.6v', 'glm-4.6v-flash'], defaultAnalysisModel: 'glm-4.6v',
      videoAnalysis: true
    },
    {
      id: 'qwen', label: 'Qwen（阿里云百炼）',
      description: 'qwen-image 生图与 qwen3-vl 解析都走百炼的 OpenAI 兼容端点；视频解析可用。',
      keyPlaceholder: 'sk-...', defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      imageProtocol: 'openai-images', imageModels: ['qwen-image-plus', 'qwen-image'], defaultImageModel: 'qwen-image-plus',
      analysisProtocol: 'openai-chat', analysisModels: ['qwen3-vl-plus', 'qwen3-vl-flash', 'qwen3.8-max', 'qwen3.7-plus'], defaultAnalysisModel: 'qwen3-vl-plus',
      videoAnalysis: true
    },
    {
      id: 'doubao', label: '豆包（火山方舟）',
      description: 'Seedream 生图、Seed 解析（图片与视频）都在方舟的 /api/v3 上。',
      keyPlaceholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      imageProtocol: 'openai-images', imageModels: ['doubao-seedream-5-0-260128', 'doubao-seedream-4-5-251128', 'doubao-seedream-4-0-250828'], defaultImageModel: 'doubao-seedream-5-0-260128',
      analysisProtocol: 'openai-chat', analysisModels: ['doubao-seed-2-1-pro-260628', 'doubao-seed-2-1-turbo-260628'], defaultAnalysisModel: 'doubao-seed-2-1-pro-260628',
      videoAnalysis: true
    },
    {
      id: 'xai', label: 'Grok（xAI）',
      description: 'Grok Imagine 生图；Grok 只解析图片（视频不支持）。',
      keyPlaceholder: 'xai-...', defaultBaseUrl: 'https://api.x.ai/v1',
      imageProtocol: 'openai-images', imageModels: ['grok-imagine-image-2.0', 'grok-2-image-1212'], defaultImageModel: 'grok-imagine-image-2.0',
      analysisProtocol: 'openai-chat', analysisModels: ['grok-4.6', 'grok-4.5'], defaultAnalysisModel: 'grok-4.6',
      videoAnalysis: false
    },
    {
      id: 'gemini', label: 'Gemini（OpenAI 兼容路径，仅解析）',
      description: '解析走 Gemini 的 OpenAI 兼容路径（/v1beta/openai），图片与视频都行；生图需原生协议，鸿蒙侧未接 → 只用于解析。',
      keyPlaceholder: 'AIza...', defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      analysisProtocol: 'openai-chat', analysisModels: ['gemini-3.7-flash', 'gemini-3.1-pro-preview', 'gemini-3.6-flash'], defaultAnalysisModel: 'gemini-3.7-flash',
      videoAnalysis: true
    },
    {
      id: 'custom', label: '自定义端点（生图 + 图片 / 视频理解）',
      description: '填你自己的网关：生图走 /images/generations，理解走聊天端点的多模态输入（OpenAI 兼容或 Anthropic 协议均可）。视频理解取决于所选模型是否支持。',
      keyPlaceholder: 'sk-...', defaultBaseUrl: '', needsBaseUrl: true,
      imageProtocol: 'openai-images', imageModels: [], defaultImageModel: '',
      analysisProtocol: 'openai-chat', analysisModels: [], defaultAnalysisModel: '',
      videoAnalysis: true
    }
  ];

  // 媒体端点默认表：SHELL_BRIDGE 与 PROMISE_SHIM 是**两个脚本作用域**，各需一份
  // （「测试连接」在用户没填 baseUrl 时要能回落到官方端点）。
  var AI_MEDIA_BASE_DEFAULTS = {
    openai: 'https://api.openai.com/v1',
    gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
    doubao: 'https://ark.cn-beijing.volces.com/api/v3',
    glm: 'https://open.bigmodel.cn/api/paas/v4',
    xai: 'https://api.x.ai/v1',
    qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    minimax: 'https://api.minimaxi.com/v1',
    custom: ''
  };
  // ===== 自动保存 / 文件搜索（Jev 重排）偏好：localStorage，与 AI 设置同一套持久化 =====
  // 这两组方法在渲染层写成「方法名?.()」调用，因此过去**完全不在覆盖门禁的视野里**
  // （旧正则只认「方法名紧跟左括号」）。其中 setAutoSaveDefault 干脆没实现：用户拨开关 → 被 Proxy 吞掉 →
  // 下次进来还是关的，属于「看着能操作、实际静默失效」。
  var AUTO_SAVE_KEY = 'genoffice.autoSaveDefault';
  var FILE_SEARCH_KEY = 'genoffice.fileSearchSettings';
  function loadFileSearchSettings() {
    var out = { rerank: false, jevEndpoint: 'openrouter', jevKeys: { openrouter: '', direct: '' } };
    try {
      var s = localStorage.getItem(FILE_SEARCH_KEY);
      if (!s) { return out; }
      var o = JSON.parse(s);
      if (!o || typeof o !== 'object') { return out; }
      var k = o.jevKeys || {};
      return {
        rerank: o.rerank === true,
        jevEndpoint: o.jevEndpoint === 'direct' ? 'direct' : 'openrouter',
        jevKeys: { openrouter: k.openrouter || '', direct: k.direct || '' }
      };
    } catch (e) { return out; }
  }
  function loadAutoSaveDefault() {
    try { return localStorage.getItem(AUTO_SAVE_KEY) === '1'; } catch (e) { return false; }
  }

  function getSaveDir() {
    try { return localStorage.getItem(SAVE_DIR_KEY) || ''; } catch (e) { return ''; }
  }

  // 自绘输入对话框（ArkWeb 未处理 onJsPrompt，window.prompt() 恒返回 null，必须自绘）
  function dialogInput(title, defVal) {
    return new Promise(function (resolve) {
      try {
        var ov = document.createElement('div');
        ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:2147483600;display:flex;align-items:center;justify-content:center';
        var box = document.createElement('div');
        box.style.cssText = 'background:#fff;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.25);padding:18px;width:420px;max-width:90vw;font:14px/1.4 system-ui,sans-serif';
        var h = document.createElement('div');
        h.textContent = title;
        h.style.cssText = 'font-weight:600;margin-bottom:10px;color:#202124';
        var inp = document.createElement('input');
        inp.value = defVal || '';
        inp.style.cssText = 'width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #c4c9d0;border-radius:6px;font:inherit;margin-bottom:14px';
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;justify-content:flex-end;gap:8px';
        function mkBtn(label, primary) {
          var b = document.createElement('button');
          b.textContent = label;
          b.style.cssText = 'padding:7px 16px;border-radius:6px;border:1px solid ' + (primary ? 'transparent' : '#c4c9d0') + ';background:' + (primary ? '#1a73e8' : '#fff') + ';color:' + (primary ? '#fff' : '#202124') + ';font:inherit;cursor:pointer';
          return b;
        }
        var ok = mkBtn('确定', true);
        var cancel = mkBtn('取消', false);
        function done(v) { ov.remove(); resolve(v); }
        ok.onclick = function () { done(inp.value.trim() || null); };
        cancel.onclick = function () { done(null); };
        inp.onkeydown = function (e) {
          if (e.key === 'Enter') { ok.onclick(); }
          else if (e.key === 'Escape') { cancel.onclick(); }
        };
        row.appendChild(cancel);
        row.appendChild(ok);
        box.appendChild(h);
        box.appendChild(inp);
        box.appendChild(row);
        ov.appendChild(box);
        (document.body || document.documentElement).appendChild(ov);
        setTimeout(function () { try { inp.focus(); inp.select(); } catch (e) { /* 忽略 */ } }, 0);
      } catch (e) { resolve(null); }
    });
  }

  // 目录选择：优先 ArkTS 真实选择器（DesktopBridge.pickDirectory，经 desktopNative），
  // 拿不到则弹自绘输入框。结果持久化到 localStorage。错误一律抛出便于 ERR_COLLECTOR 抓取。
  function pickSaveDir() {
    try {
      console.info('[GenOffice] pickSaveDir called');
      // 必须经 bridgeCall 单入口调度：gin 桥只注册了 bridgeCall，desktopNative 上
      // 没有 pickDirectory 方法（直接调是 undefined → 永远掉进输入框兜底）。
      // DesktopBridge.bridgeCall('pickDirectory') 返回 {"ok":true,"uri":...}。
      return goJson('pickDirectory', []).then(function (r) {
        var uri = r && r.ok ? r.uri : null;
        console.info('[GenOffice] pickDirectory ->', uri);
        if (typeof uri === 'string' && uri) { return uri; }
        return dialogInput('设置默认保存目录', getSaveDir() || '/data/storage/el2/base/files');
      }).then(function (dir) {
        if (dir) { try { localStorage.setItem(SAVE_DIR_KEY, dir); } catch (e) { /* 忽略 */ } }
        return dir || null;
      });
    } catch (e) {
      console.error('[GenOffice] pickSaveDir failed:', e && (e.stack || e.message || e));
      return Promise.resolve(null);
    }
  }

  // ================= Tab 宿主（iframe 承载编辑器） =================
  var APP_TITLES = { docs: 'AI Docs', sheets: 'AI Sheets', slides: 'AI Slides', markdown: 'AI Markdown', pdf: 'AI PDF', html: 'AI HTML' };
  var TAB_BAR_H = 40; // 与 home.css "below the 40px tab bar" 对齐
  var tabs = [{ id: 'home', kind: 'home', title: 'Home', closable: false, active: true }];
  var listeners = [];
  var frames = {}; // tabId -> iframe
  var seq = 0;

  function notify() {
    listeners.forEach(function (h) { try { h(tabs.slice()); } catch (e) { /* overlay 会抓 */ } });
  }
  function ensureHost() {
    var h = document.getElementById('__tab_host');
    if (!h) {
      h = document.createElement('div');
      h.id = '__tab_host';
      h.style.cssText = 'position:fixed;top:' + TAB_BAR_H + 'px;left:0;right:0;bottom:0;z-index:99990;display:none';
      (document.body || document.documentElement).appendChild(h);
    }
    return h;
  }
  function syncFrames() {
    var activeId = null;
    tabs.forEach(function (t) { if (t.active) { activeId = t.id; } });
    Object.keys(frames).forEach(function (id) {
      frames[id].style.display = (id === activeId) ? 'block' : 'none';
    });
    var host = document.getElementById('__tab_host');
    if (host) { host.style.display = (activeId && activeId !== 'home') ? 'block' : 'none'; }
  }
  function openApp(kind) {
    if (!APP_TITLES[kind]) { return; }
    var id = kind + '-' + (++seq);
    tabs.forEach(function (t) { t.active = false; });
    tabs.push({ id: id, kind: kind, title: APP_TITLES[kind], closable: true, active: true });
    var host = ensureHost();
    var f = document.createElement('iframe');
    f.src = '../' + kind + '/index.html';
    f.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;background:#fff';
    host.appendChild(f);
    frames[id] = f;
    syncFrames();
    notify();
  }
  // 「新建空白表格」：置一次性标记后开 sheets tab，selectWorkbook 消费标记返回
  // 空白真实 WorkbookFile（workbookFile 非空 → 保存/另存为可用，M5 前错误可见）。
  function openBlankSheet() {
    try { localStorage.setItem('genoffice.pendingBlankSheet', '1'); } catch (e) { /* 忽略 */ }
    openApp('sheets');
  }
  // 扩展名 → app kind（起始页「打开本地文件」与系统「打开方式」共用一张表）
  var EXT_KIND = {
    docx: 'docs', xlsx: 'sheets', xlsm: 'sheets', xls: 'sheets', csv: 'sheets',
    pptx: 'slides', md: 'markdown', markdown: 'markdown', pdf: 'pdf', txt: 'markdown',
    html: 'html', htm: 'html'
  };
  function kindOfPath(path) {
    var p = String(path || '');
    var dot = p.lastIndexOf('.');
    if (dot < 0) { return null; }
    var ext = p.substring(dot + 1).toLowerCase();
    var q = ext.indexOf('?');
    if (q >= 0) { ext = ext.substring(0, q); }
    return EXT_KIND[ext] || null;
  }
  // 打开本地文件：只暂存 path（大文件 base64 不塞 localStorage，字节交给各 app 各自桥读取），
  // 再按扩展名开对应 app tab —— 起始页「打开本地文件」与系统「打开方式」共用此函数。
  function openLocalPath(path) {
    var kind = kindOfPath(path);
    if (!kind) {
      console.error('[GenOffice] openLocalPath: 不支持的文件类型 ' + path);
      return null;
    }
    try { localStorage.setItem('genoffice.pendingOpenPath', path); } catch (e) { /* 忽略容量 */ }
    openApp(kind);
    return kind;
  }
  // ArkTS 入口：EntryAbility onCreate/onNewWant 收到系统「打开方式」分发（want.uri）
  // → Index.runJavaScript 调本函数。返回 kind（'' = 不支持），便于日志确认。
  window.__goOpenExternalPath = function (uri) {
    var path = String(uri || '');
    try { path = decodeURIComponent(path); } catch (e) { /* 保留原样 */ }
    var kind = openLocalPath(path);
    console.info('[GenOffice] external open: ' + path + ' -> ' + (kind || 'unsupported'));
    return kind || '';
  };
  function activateTab(id) {
    tabs.forEach(function (t) { t.active = (t.id === id); });
    syncFrames();
    notify();
  }
  // ===== 未保存更改守卫：关闭有编辑的 tab 前弹确认（保存并关闭 / 不保存关闭 / 取消）=====
  var TAB_SAVE_BRIDGE = {
    docs: 'desktop', sheets: 'desktopApi', slides: 'slidesApi', markdown: 'markdownApi', pdf: 'pdfApi', html: 'htmlApi'
  };
  function frameWinOf(id) {
    try { return (frames[id] && frames[id].contentWindow) || null; } catch (e) { return null; }
  }
  // ===== 跨 frame 未保存状态（postMessage）：见 PROMISE_SHIM 同名段注释 =====
  // 真机是 opaque origin：读子 frame 属性必抛 SecurityError，所以下面「同步读」只能当同源
  // 快速路径（harness / Electron 复用），权威来源是 ① app frame 主动 push 的 dirtyCache
  // ② 关 tab 时的 postMessage 查询。两条都走 ev.source 身份匹配（WindowProxy 跨域可比）。
  var dirtyCache = {};     // tabId -> bool（app frame push 的最新值）
  var dirtyWaiters = [];   // [{win,done}] 壳 → app 的 __goDirtyQuery 等待表
  var saveWaiters = [];    // [{win,done}] 壳 → app 的 __goCloseSaveRequest 等待表
  function settleWaiters(list, src, val) {
    for (var i = list.length - 1; i >= 0; i--) {
      var ent = list[i];
      // 优先 ev.source 身份匹配；个别 ArkWeb 不回填 source 时按「唯一等待者」兜底
      if (!src || ent.win === src || list.length === 1) { list.splice(i, 1); ent.done(val); }
    }
  }
  function waitFrame(list, win, send, timeoutMs) {
    return new Promise(function (resolve) {
      var settled = false;
      var entry = { win: win, done: function (v) {
        if (settled) { return; }
        settled = true;
        var at = list.indexOf(entry);
        if (at >= 0) { list.splice(at, 1); }
        resolve(v);
      } };
      list.push(entry);
      setTimeout(function () { entry.done(false); }, timeoutMs);
      try { send(); } catch (e) { entry.done(false); }
    });
  }
  function tabIdOfSource(src) {
    var ids = Object.keys(frames);
    for (var i = 0; i < ids.length; i++) {
      if (src && frameWinOf(ids[i]) === src) { return ids[i]; }
    }
    return null;
  }
  try {
    window.addEventListener('message', function (ev) {
      var d = ev && ev.data;
      if (!d || typeof d !== 'object') { return; }
      if (d.__goDirtyAnswer) { settleWaiters(dirtyWaiters, ev.source, !!d.dirty); return; }
      if (d.__goCloseSaveAnswer) { settleWaiters(saveWaiters, ev.source, d); return; }
      if (typeof d.__goDirty === 'boolean') {
        // 归属：优先 ev.source 身份匹配，回退消息里回带的 tabId（app frame 在壳首次
        // 查询后已知自己的 id，之后所有 push 都带上）
        var pid = tabIdOfSource(ev.source) || (typeof d.tabId === 'string' && frames[d.tabId] ? d.tabId : null);
        if (pid && dirtyCache[pid] !== d.__goDirty) {
          dirtyCache[pid] = d.__goDirty;
          console.info('[GenOffice] dirty push ' + pid + '=' + d.__goDirty);
        }
      }
    });
  } catch (e) { /* 忽略 */ }
  // 未保存判定（三条通道，任一为真即视为有改动）：
  // 1) push：markdown/pdf/slides 的 setDirty、sheets 的 notifyPendingEdits → __goFrameDirty
  // 2) 查询：docs 的 onCloseCheck → 同步触发其已登记回调，渲染层立即 reportCloseCheck 回填
  function frameDirtyOf(id) {
    var w = frameWinOf(id);
    if (!w) {
      // 真机排查锚点：contentWindow 缺失 → 跨 frame 访问不通（守卫必然失效）
      console.info('[GenOffice] guard probe: no contentWindow for ' + id);
      return false;
    }
    try {
      if (w.__goFrameDirty) { return true; }
      if (typeof w.__goCloseCheckHandler === 'function') {
        w.__goCloseCheckHandler();
        var st = w.__goCloseCheck;
        return !!(st && st.dirty);
      }
    } catch (e) {
      // 真机必走这里（opaque origin）：同步读全废 → 交由 postMessage 通道判定
      console.info('[GenOffice] guard probe threw for ' + id + ': ' + e);
      return false;
    }
    return false;
  }
  // 权威判定：同步读（同源）→ push 缓存 → postMessage 查询（真机唯一可用）
  function frameDirtyAsync(id) {
    if (frameDirtyOf(id)) { return Promise.resolve(true); }
    if (dirtyCache[id] === true) { return Promise.resolve(true); }
    var w = frameWinOf(id);
    if (!w || typeof w.postMessage !== 'function') { return Promise.resolve(false); }
    return waitFrame(dirtyWaiters, w, function () {
      w.postMessage({ __goDirtyQuery: true, tabId: id }, '*');
    }, 800).then(function (v) { return !!v || dirtyCache[id] === true; });
  }
  // 真机排查锚点：一次输出现场全部通道，避免多轮猜测（每个 app 都能定位到具体断点）：
  //  - win=null        → 壳拿不到 iframe.contentWindow（跨 frame 访问不通）
  //  - pushFlag=true   → 渲染层推过 setDirty/notifyPendingEdits，壳也读到了
  //  - checkHandler=…  → 该 app 是否登记了查询式协议（undefined = 渲染层没调用 onCloseCheck）
  //  - saveHandler=…   → 「保存并关闭」是否有 app 协议（undefined = 只能裸调 save 兜底）
  function dirtyProbe(id) {
    var w = frameWinOf(id);
    if (!w) { return 'win=null'; }
    var s = 'win=ok';
    try { s = s + ' pushFlag=' + String(w.__goFrameDirty) + '(' + (typeof w.__goFrameDirty) + ')'; }
    catch (e) { s = s + ' pushFlag=THREW'; }
    try { s = s + ' checkHandler=' + (typeof w.__goCloseCheckHandler); }
    catch (e) { s = s + ' checkHandler=THREW'; }
    try {
      var st = w.__goCloseCheck;
      s = s + ' checkDirty=' + (st ? String(st.dirty) : 'null');
    } catch (e) { s = s + ' checkDirty=THREW'; }
    try { s = s + ' saveHandler=' + (typeof w.__goCloseSaveHandler); }
    catch (e) { s = s + ' saveHandler=THREW'; }
    s = s + ' cache=' + String(dirtyCache[id]);
    return s;
  }
  // 无协议时的兜底：裸调该 app 桥的 save()（只可能出现在同源环境；真机属性读不可用）
  function saveViaBridge(id, w) {
    var t = tabs.find(function (x) { return x.id === id; });
    if (!t) { return Promise.resolve(true); }
    var bridgeName = TAB_SAVE_BRIDGE[t.kind];
    try {
      var saveFn = w && bridgeName && w[bridgeName] && w[bridgeName].save;
      if (typeof saveFn === 'function') {
        return Promise.resolve(saveFn()).then(function () { return true; }, function () { return false; });
      }
    } catch (e) { /* 无保存通道 → 视为无需保存 */ }
    return Promise.resolve(true);
  }
  // 「保存并关闭」：优先走各 app 已实现的 onCloseSaveRequest 协议（完整保存流程，
  // 结果经 sendCloseSaveResult / reportCloseSaveResult 回写）；返回 true = 已保存。
  // 同源（harness）走同步读直接触发回调；真机（opaque origin）读不到子 frame 属性，
  // 改由 postMessage 让 app frame 在它自己的 frame 内跑同一协议并回写结果。
  // 保存失败/取消 → 返回 false，调用方不关闭 tab（避免用户以为保存了其实没保存）。
  function saveFrameBeforeClose(id) {
    var w = frameWinOf(id);
    var handler = null;
    try { handler = w && w.__goCloseSaveHandler; } catch (e) { handler = null; }
    console.info('[GenOffice] closeSave trigger id=' + id + ' protocolHandler=' + (typeof handler === 'function'));
    if (typeof handler === 'function') {
      return new Promise(function (resolve) {
        var peek = function () {
          try { return w.__goCloseSaveResult === true; } catch (e) { return false; }
        };
        var settled = false;
        var finish = function () { if (!settled) { settled = true; resolve(peek()); } };
        try { w.__goCloseSaveResult = null; } catch (e) { /* 忽略 */ }
        try { handler(); } catch (e) { console.error('[GenOffice] closeSave handler threw: ' + e); finish(); return; }
        var tries = 0;
        (function poll() {
          if (settled) { return; }
          // 保存完成 / 明确失败（结果写回 null 之外的值）即结束；60s 上限兜底挂死
          var r = null;
          try { r = w.__goCloseSaveResult; } catch (e) { r = null; }
          if (r !== null && r !== undefined) { finish(); return; }
          if (tries++ > 600) { console.warn('[GenOffice] closeSave timeout, keep tab open'); finish(); return; }
          setTimeout(poll, 100);
        })();
      });
    }
    if (!w || typeof w.postMessage !== 'function') { return saveViaBridge(id, w); }
    // 真机通道：app frame 内 runCloseSaveRequest → handler() → 结果回写后 __goCloseSaveAnswer
    // 超时给足 120s：系统保存框可能长时间停留（用户在那儿取消时子 frame 会立即回 ok=false）
    return waitFrame(saveWaiters, w, function () {
      w.postMessage({ __goCloseSaveRequest: true, tabId: id }, '*');
    }, 120000).then(function (ans) {
      if (ans && ans.ok === true) { return true; }
      // 该 app 没登记保存协议（或消息未达）→ 同源兜底；兜底也拿不到通道就保留 tab
      if (ans && ans.noHandler) { return saveViaBridge(id, w); }
      if (ans && (ans.timeout || ans.threw)) { console.warn('[GenOffice] closeSave app-side失败: ' + JSON.stringify(ans)); }
      return false;
    });
  }
  var confirmDialogEl = null;
  function closeDirtyConfirm() {
    if (confirmDialogEl) { confirmDialogEl.remove(); confirmDialogEl = null; }
  }
  function showDirtyConfirm(id) {
    // ArkWeb 内 window.confirm 需 ArkTS onJsDialog 处理，用自绘 DOM modal 更稳
    if (confirmDialogEl) { closeDirtyConfirm(); }
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:2147483001;display:flex;align-items:center;justify-content:center';
    var box = document.createElement('div');
    box.style.cssText = 'background:#fff;border-radius:10px;padding:20px 24px;min-width:320px;box-shadow:0 10px 40px rgba(0,0,0,.25);font:13px/1.5 system-ui,sans-serif;color:#202124';
    var msg = document.createElement('div');
    msg.textContent = '此文档有未保存的更改，要保存后关闭吗？';
    msg.style.cssText = 'margin-bottom:16px;font-weight:600';
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;justify-content:flex-end;gap:8px';
    var mk = function (label, primary, onClick) {
      var b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'padding:6px 14px;border-radius:6px;border:1px solid #d0d4da;background:' + (primary ? '#1a73e8' : '#fff') + ';color:' + (primary ? '#fff' : '#202124') + ';cursor:pointer;font:13px/1.2 system-ui,sans-serif';
      b.onclick = function (e) { e.stopPropagation(); onClick(); };
      return b;
    };
    row.appendChild(mk('取消', false, function () { closeDirtyConfirm(); }));
    row.appendChild(mk('不保存', false, function () { closeDirtyConfirm(); doCloseTab(id); }));
    row.appendChild(mk('保存并关闭', true, function () {
      closeDirtyConfirm();
      // 保存失败 / 在系统保存对话框取消 → 保留 tab（假关闭会丢内容）
      saveFrameBeforeClose(id).then(function (ok) {
        if (ok) { doCloseTab(id); }
        else { console.warn('[GenOffice] closeSave did not complete; tab kept open'); }
      }, function () { /* 异常也不关闭 */ });
    }));
    box.appendChild(msg); box.appendChild(row);
    ov.appendChild(box);
    (document.body || document.documentElement).appendChild(ov);
    confirmDialogEl = ov;
    ov.addEventListener('click', function (e) { if (e.target === ov) { closeDirtyConfirm(); } });
  }
  function closeTab(id) {
    // 同步读只作同源快速路径；真机必抛 → 落回 push 缓存 / postMessage 查询（异步）
    return frameDirtyAsync(id).then(function (dirty) {
      console.info('[GenOffice] closeTab id=' + id + ' dirty=' + dirty + ' cap[' + dirtyProbe(id) + ']');
      if (dirty) {
        showDirtyConfirm(id);
        return;
      }
      doCloseTab(id);
    });
  }
  function doCloseTab(id) {
    tabs = tabs.filter(function (t) { return t.id !== id; });
    if (frames[id]) { frames[id].remove(); delete frames[id]; }
    delete dirtyCache[id];
    if (!tabs.some(function (t) { return t.active; }) && tabs.length > 0) { tabs[0].active = true; }
    syncFrames();
    notify();
  }

  // ================= 自绘菜单（Electron 端为原生菜单） =================
  function closeMenu() {
    var m = document.getElementById('__shell_menu');
    if (m) { m.remove(); }
    document.removeEventListener('pointerdown', onMenuOutside, true);
  }
  function onMenuOutside(e) {
    var m = document.getElementById('__shell_menu');
    if (m && !m.contains(e.target)) { closeMenu(); }
  }
  function popupMenu(x, y, items) {
    closeMenu();
    var m = document.createElement('div');
    m.id = '__shell_menu';
    m.style.cssText = 'position:fixed;top:' + y + 'px;left:' + x + 'px;background:#fff;border:1px solid #d0d4da;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.18);padding:4px;z-index:2147483000;min-width:180px';
    items.forEach(function (it) {
      var b = document.createElement('div');
      b.textContent = it.label;
      b.style.cssText = 'padding:7px 12px;font:13px/1.2 system-ui,sans-serif;border-radius:6px;cursor:pointer;color:#202124;white-space:nowrap' + (it.disabled ? ';opacity:.45;cursor:default' : '');
      b.onmouseenter = function () { if (!it.disabled) { b.style.background = '#eef1f5'; } };
      b.onmouseleave = function () { b.style.background = 'transparent'; };
      b.onclick = function (e) { e.stopPropagation(); closeMenu(); if (!it.disabled && it.onClick) { it.onClick(); } };
      m.appendChild(b);
    });
    (document.body || document.documentElement).appendChild(m);
    setTimeout(function () { document.addEventListener('pointerdown', onMenuOutside, true); }, 0);
  }
  // 「关于 / 反馈」对话框（自绘；桌面版走原生 About 面板 + 在线反馈页）。
  // 为什么必须自绘：window.alert/confirm 在 ArkWeb 需要 ArkTS onJsDialog 回调，且壳层弹窗文案
  // 本来就统一为中文。内容 = 版本 + 反馈三要素 + 日志抓取命令 + 可直接复制的诊断块
  // （诊断块含版本/平台/语言/UA/时间，测试者贴进内测反馈页即可定位）。
  function shellDiagnosticText() {
    var lines = [
      'GenOffice 版本: ' + SHELL_APP_VERSION,
      '平台: HarmonyOS (ArkWeb 壳)',
      '语言: ' + (navigator.language || 'unknown'),
      '屏幕: ' + (window.screen ? (window.screen.width + 'x' + window.screen.height) : 'unknown'),
      'UA: ' + (navigator.userAgent || 'unknown'),
      '时间: ' + new Date().toString()
    ];
    return lines.join('\\n');
  }
  function dialogFeedback() {
    closeMenu();
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:2147483600;display:flex;align-items:center;justify-content:center';
    var box = document.createElement('div');
    box.style.cssText = 'background:#fff;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.25);padding:20px 22px;width:520px;max-width:92vw;font:13px/1.6 system-ui,sans-serif;color:#202124';
    var h = document.createElement('div');
    h.textContent = '关于 GenOffice（内测版 ' + SHELL_APP_VERSION + '）';
    h.style.cssText = 'font-weight:600;font-size:15px;margin-bottom:10px';
    var tips = document.createElement('div');
    tips.style.cssText = 'color:#3c4043;margin-bottom:12px';
    tips.textContent = '内测反馈请选「应用市场 → 我的 → 内测应用 → GenOffice → 反馈」，并尽量附上：'
      + '① 重现步骤；② 出问题的原文件；③ 下面的诊断信息。';
    var pre = document.createElement('textarea');
    pre.readOnly = true;
    pre.value = shellDiagnosticText()
      + '\\n\\n日志抓取（电脑连上设备后执行）：\\n  hdc hilog | grep GenOffice';
    pre.style.cssText = 'width:100%;box-sizing:border-box;height:150px;padding:8px 10px;border:1px solid #c4c9d0;border-radius:6px;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;color:#202124;background:#f8f9fa;resize:vertical';
    var note = document.createElement('div');
    note.style.cssText = 'color:#5f6368;font-size:12px;margin-top:8px;min-height:16px';
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:12px';
    function mkBtn(label, primary) {
      var b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'padding:7px 16px;border-radius:6px;border:1px solid ' + (primary ? 'transparent' : '#c4c9d0') + ';background:' + (primary ? '#1a73e8' : '#fff') + ';color:' + (primary ? '#fff' : '#202124') + ';font:inherit;cursor:pointer';
      return b;
    }
    var copy = mkBtn('复制', true);
    var close = mkBtn('关闭', false);
    copy.onclick = function () {
      var t = pre.value;
      try {
        // PROMISE_SHIM 已把 navigator.clipboard.writeText 接到原生 pasteboard 桥；
        // 原生桥不可用时退回直接调 desktopNative.writeClipboardText（sync 方法）。
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(t);
        } else {
          var nb = nativeBridge();
          if (nb && typeof nb.writeClipboardText === 'function') { nb.writeClipboardText(t); }
        }
        note.textContent = '已复制到剪贴板';
      } catch (e) {
        try { pre.select(); } catch (e2) { /* 忽略 */ }
        note.textContent = '复制失败——请手动全选上面的文本复制';
      }
    };
    close.onclick = function () { ov.remove(); };
    ov.onclick = function (e) { if (e.target === ov) { ov.remove(); } };
    row.appendChild(copy);
    row.appendChild(close);
    box.appendChild(h);
    box.appendChild(tips);
    box.appendChild(pre);
    box.appendChild(note);
    box.appendChild(row);
    ov.appendChild(box);
    (document.body || document.documentElement).appendChild(ov);
  }
  // ===== 「开源许可」入口（批次 E）=====
  // Apache-2.0 第 4 条要求随包保留 LICENSE / NOTICE 并说明改了什么；文本由
  // harmony/scripts/gen-legal-notices.mjs 生成到 rawfile/web/legal/。这里给一个**可见入口**
  // —— 只把文本塞进包里、用户永远看不到，实测等于没履行（AGC 审核也会问）。
  // 第三方清单 ~90KB，默认不加载，只在点「查看完整第三方许可」时才读。
  var legalTextCache = {};
  function legalLoad(name) {
    if (legalTextCache[name]) { return Promise.resolve(legalTextCache[name]); }
    return fetch('resource://rawfile/web/legal/' + name).then(function (r) {
      if (!r || !r.ok) { throw new Error('HTTP ' + (r ? r.status : '')); }
      return r.text();
    }).then(function (t) {
      legalTextCache[name] = t;
      return t;
    });
  }
  function dialogLegal() {
    closeMenu();
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:2147483600;display:flex;align-items:center;justify-content:center';
    var box = document.createElement('div');
    box.style.cssText = 'background:#fff;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.25);padding:20px 22px;width:640px;max-width:94vw;font:13px/1.6 system-ui,sans-serif;color:#202124';
    var h = document.createElement('div');
    h.textContent = '开源许可与第三方组件';
    h.style.cssText = 'font-weight:600;font-size:15px;margin-bottom:10px';
    var tips = document.createElement('div');
    tips.style.cssText = 'color:#3c4043;margin-bottom:12px';
    tips.textContent = '本应用是 GenOffice（Apache License 2.0，Copyright 2026 Mainfunc, Inc.）的'
      + '鸿蒙 PC 移植版。GenOffice 与 Genspark 均为 Mainfunc, Inc. 的商标，Apache-2.0 不授予商标权，'
      + '本应用与 Mainfunc, Inc. / Genspark 无关联、不受其背书。下面含上游 NOTICE、本衍生作品的'
      + '修改声明，以及第三方组件清单。';
    var pre = document.createElement('textarea');
    pre.readOnly = true;
    pre.value = '正在读取随包的许可文本…';
    pre.style.cssText = 'width:100%;box-sizing:border-box;height:300px;padding:8px 10px;border:1px solid #c4c9d0;border-radius:6px;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;color:#202124;background:#f8f9fa;resize:vertical;white-space:pre';
    var note = document.createElement('div');
    note.style.cssText = 'color:#5f6368;font-size:12px;margin-top:8px;min-height:16px';
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:12px';
    function mkLegalBtn(label, primary) {
      var b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'padding:7px 14px;border-radius:6px;border:1px solid ' + (primary ? 'transparent' : '#c4c9d0') + ';background:' + (primary ? '#1a73e8' : '#fff') + ';color:' + (primary ? '#fff' : '#202124') + ';font:inherit;cursor:pointer';
      return b;
    }
    function legalBasicText() {
      return Promise.all([legalLoad('NOTICE.txt'), legalLoad('CHANGELOG-NOTICE.txt')]).then(function (arr) {
        return arr[1] + '\\n\\n' + arr[0];
      });
    }
    var viewing = 'basic';
    legalBasicText().then(function (t) {
      pre.value = t;
    }).catch(function (e) {
      pre.value = '读取失败：' + (e && e.message ? e.message : String(e))
        + '\\n\\n许可文本文件位于应用包内 resources/rawfile/web/legal/（LICENSE.txt / NOTICE.txt / '
        + 'THIRD-PARTY-NOTICES.txt / LICENSE-UNICODE.txt / CHANGELOG-NOTICE.txt）。';
      note.textContent = '读取失败 —— 上面已给出包内文件位置';
    });
    var swap = mkLegalBtn('查看完整第三方许可', false);
    swap.onclick = function () {
      if (viewing === 'third') {
        viewing = 'basic';
        swap.textContent = '查看完整第三方许可';
        legalBasicText().then(function (t) { pre.value = t; }, function () {});
        return;
      }
      viewing = 'third';
      swap.textContent = '返回 NOTICE 与修改声明';
      pre.value = '正在加载完整第三方清单…';
      legalLoad('THIRD-PARTY-NOTICES.txt').then(function (t) {
        pre.value = t;
      }, function (e) {
        pre.value = '加载失败：' + (e && e.message ? e.message : String(e));
      });
    };
    var copy = mkLegalBtn('复制', true);
    copy.onclick = function () {
      var t = pre.value;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(t);
        } else {
          var nb = nativeBridge();
          if (nb && typeof nb.writeClipboardText === 'function') { nb.writeClipboardText(t); }
        }
        note.textContent = '已复制到剪贴板';
      } catch (e) {
        try { pre.select(); } catch (e2) { /* 忽略 */ }
        note.textContent = '复制失败——请手动全选上面的文本复制';
      }
    };
    var close = mkLegalBtn('关闭', false);
    close.onclick = function () { ov.remove(); };
    ov.onclick = function (e) { if (e.target === ov) { ov.remove(); } };
    row.appendChild(swap);
    row.appendChild(copy);
    row.appendChild(close);
    box.appendChild(h);
    box.appendChild(tips);
    box.appendChild(pre);
    box.appendChild(note);
    box.appendChild(row);
    ov.appendChild(box);
    (document.body || document.documentElement).appendChild(ov);
  }
  function showNewMenu(x, y) {
    popupMenu(x, y, [
      { label: 'AI Docs（Word）', onClick: function () { openApp('docs'); } },
      { label: 'AI Sheets（表格）', onClick: function () { openBlankSheet(); } },
      { label: 'AI Slides（幻灯片）', onClick: function () { openApp('slides'); } },
      { label: 'AI Markdown', onClick: function () { openApp('markdown'); } },
      { label: 'AI PDF', onClick: function () { openApp('pdf'); } },
      { label: 'AI HTML', onClick: function () { openApp('html'); } },
      { label: '打开本地文件…', onClick: function () { aiOffice.browse(); } },
      { label: '关于 / 反馈', onClick: function () { dialogFeedback(); } },
      { label: '开源许可', onClick: function () { dialogLegal(); } }
    ]);
  }
  // ===== 壳 chrome「另存为…/打印…」：按当前 tab 的 app 类型派发到对应 app frame =====
  // 桌面版由 Electron 原生菜单 + 主进程 IPC 完成；鸿蒙壳没有原生菜单，把这两项放进已有的
  // 自绘菜单（tab 列表按钮，Shell TabBar 的 tab-overflow-btn）。各 app 的渲染层通道不同，
  // 与 PROMISE_SHIM「壳 chrome 菜单 → 本 frame 渲染层命令」段一一对应：
  //   pdf      → onSaveAsRequest（saveAsTo(targetPath)） / onPrintRequest
  //   markdown → onPrintRequest / onExportRequest('docx' 存盘 | 'docs' 存盘后在 Word 打开)
  //   docs     → onMenuCommand('save-as')            slides → onMenuCommand('save-as'|'print')
  //   sheets   → onMenuAction('save-as')
  // 未列出的 app（含 Home）没有该通道 → 不显示对应项，不留「点了没反应」的死按钮。
  // markdown 刻意不放「导出 PDF / 导出图片」：两者都要壳内没有的 HTML→PDF 管线，
  // 渲染层拿到 {ok:false} 只写 console（导出图片有状态栏文案，导出 PDF 没有）→ 会变成死按钮。
  var APP_FILE_ACTIONS = {
    pdf: [
      { label: '另存为…', msg: { __goSaveAsRequest: true, targetPath: '' } },
      { label: '打印…', msg: { __goPrintRequest: true } }
    ],
    markdown: [
      { label: '保存', msg: { __goSaveRequest: 'save' } },
      { label: '另存为…', msg: { __goSaveRequest: 'saveAs' } },
      { label: '打印…', msg: { __goPrintRequest: true } },
      { label: '导出为 Word…', msg: { __goExportRequest: 'docx' } },
      { label: '导出为 Word 并打开', msg: { __goExportRequest: 'docs' } }
    ],
    docs: [
      { label: '另存为…', msg: { __goMenuCommand: 'save-as' } }
    ],
    slides: [
      { label: '另存为…', msg: { __goMenuCommand: 'save-as' } },
      { label: '打印…', msg: { __goMenuCommand: 'print' } }
    ],
    sheets: [
      { label: '另存为…', msg: { __goMenuAction: 'save-as' } }
    ]
  };
  function activeTab() {
    for (var i = 0; i < tabs.length; i++) { if (tabs[i].active) { return tabs[i]; } }
    return null;
  }
  // 派发到目标 tab 的 iframe：带 tabId 便于 frame 侧回填（个别 ArkWeb 版本不回填 ev.source）
  function postToTab(id, msg) {
    var w = frameWinOf(id);
    if (!w) {
      console.error('[GenOffice] app menu: no contentWindow for tab ' + id + '（跨 frame 访问不通）');
      return false;
    }
    try {
      w.postMessage(Object.assign({ tabId: id }, msg), '*');
      console.info('[GenOffice] app menu -> ' + id + ' ' + JSON.stringify(msg));
      return true;
    } catch (e) {
      console.error('[GenOffice] app menu post failed: ' + e);
      return false;
    }
  }
  function showTabsMenu(x, y) {
    var t = activeTab();
    var acts = (t && APP_FILE_ACTIONS[t.kind]) || [];
    var items = acts.map(function (a) {
      return { label: a.label, onClick: function () { postToTab(t.id, a.msg); } };
    });
    if (items.length > 0) { items.push({ label: '── 标签页 ──', disabled: true }); }
    tabs.forEach(function (tt) {
      items.push({ label: (tt.active ? '● ' : '') + tt.title, onClick: function () { activateTab(tt.id); } });
    });
    popupMenu(x, y, items);
  }

  var aiOffice = {
    // 最近文件：ArkTS 真实实现（DesktopBridge.recentPageJson → filesDir/genoffice-recents.json 持久化，
    // 每次打开/另存都 pushRecent）。返回结构对齐桌面版 apps/shell/src/main/recent-files.ts 的
    // RecentPage {entries:[{path,name,ext,mtimeMs,sizeBytes,starred,missing?}],total,totalAll}。
    recents: function (query) {
      return goJson('recentPageJson', [JSON.stringify(query || {})]).then(function (r) {
        if (!r || typeof r !== 'object') { return EMPTY_PAGE; }
        return { entries: r.entries || [], total: r.total || 0, totalAll: r.totalAll || 0 };
      });
    },
    // 收藏未实现（无星标持久化）：返回空页而不是 null，Home 的 sidebar 计数才不炸
    starred: function () { return Promise.resolve(EMPTY_PAGE); },
    statPaths: function (paths) {
      return goJson('statPathsJson', [JSON.stringify(paths || [])]).then(function (r) {
        return (r && typeof r.length === 'number') ? r : [];
      });
    },
    toggleStar: function () { return Promise.resolve(); },
    // 起始页/最近文件点开某文件 → 按扩展名路由到对应 app tab（与系统「打开方式」同一函数）
    openPath: function (path) { openLocalPath(path); return Promise.resolve(); },
    // 起始页"打开本地文件"：系统选择器 → 按扩展名决定开哪个 app tab。
    // 直接调 ArkTS 的 openFileJson（Promise<JSON string>），避免 goJson 包一层
    // 偶发的 thenable 处理路径。桥定位复用 nativeBridge（desktopNative 优先）。
    browse: function () {
      // 统一走 SHELL_BRIDGE 自带的 goNative（闭包内 nativeBridge → 直调 gin 宿主对象）
      // 并加 || '' 兜底：gin 桥 async 方法返回 undefined 时回退为空串，与 PROMISE_SHIM 语义一致。
      return goNative('openFileJson', []).then(function (j) {
        j = j || '';  // null/undefined → ''，让下游 !j 统一处理
        console.info('[GenOffice] browse openFileJson -> type=' + (typeof j) + (typeof j === 'string' ? ' len=' + j.length + ' head=' + j.slice(0, 60) : ' val=' + String(j)));
        if (typeof j !== 'string' || !j) { console.error('[GenOffice] browse: empty result（用户取消或桥失败）'); return null; }
        var r;
        try { r = JSON.parse(j); } catch (e) { console.error('[GenOffice] browse: JSON.parse failed: ' + e.message); return null; }
        if (!r || !r.ok) { console.error('[GenOffice] browse: openFileJson 失败 ' + (r && r.error ? r.error : '(no detail)')); return null; }
        if (!r.ext) { console.error('[GenOffice] browse: 缺少 ext 字段'); return null; }
        // 暂存 path 供 app iframe 启动时消费（docs 经 onOpenDocx、markdown/pdf 经 consumePending、
        // slides 经 consumePendingOpen）；只存 path 不存 b64——大文件 base64 会逼近 localStorage
        // 容量上限，读字节交给各 app 自己的 ArkTS 桥。
        if (!openLocalPath(r.path)) { return null; }
        return r;
      }).catch(function (e) {
        console.error('[GenOffice] browse failed: ' + (e && (e.message || e)));
        return null;
      });
    },
    // 新建文档 → 开新 Tab（iframe 承载，不再整页跳转）
    newDoc: function () { openApp('docs'); return Promise.resolve(); },
    newSheet: function () { openBlankSheet(); return Promise.resolve(); },
    newSlide: function () { openApp('slides'); return Promise.resolve(); },
    newMarkdown: function () { openApp('markdown'); return Promise.resolve(); },
    newPdf: function () { openApp('pdf'); return Promise.resolve(); },
    // 文件操作（M3）
    removeRecent: function (paths) {
      return goJson('removeRecentJson', [JSON.stringify(paths || [])]).then(function () { /* 列表由 Home 重新拉取 */ });
    },
    revealPath: function () { return Promise.resolve(); },
    renameFile: function () { return Promise.resolve({ ok: false, error: 'HarmonyOS bridge not ready' }); },
    duplicateFile: function () { return Promise.resolve(); },
    deleteFiles: function () { return Promise.resolve(); },
    openTrash: function () { return Promise.resolve(); },
    // 语言 / 主题 / 版本
    getLanguage: function () { return Promise.resolve('zh'); },
    setLanguage: function () { return Promise.resolve(); },
    getUpdateChannel: function () { return Promise.resolve('stable'); },
    setUpdateChannel: function () { return Promise.resolve(); },
    // 账号（gsk 登录 M4）
    accountStatus: function () { return Promise.resolve({ loggedIn: false }); },
    accountLogin: function () { return Promise.resolve(false); },
    onAccountLogin: function () { return NOOP; },
    openLoginUrl: function () { return Promise.resolve(); },
    accountLogout: function () { return Promise.resolve(); },
    // 版本号必须与 AppScope/app.json5 的 versionName + DesktopBridge.APP_VERSION 三处一致
    // （verify-all 的 checkAppVersionConsistency 会比对；设置页「版本」一栏读这里）。
    getAppVersion: function () { return Promise.resolve(SHELL_APP_VERSION); },
    // 引导页：已看过，直接进主页
    onboardingSeen: function () { return Promise.resolve(true); },
    setOnboardingSeen: function () { return Promise.resolve(true); },
    getTheme: function () { return Promise.resolve('light'); },
    setTheme: function () { return Promise.resolve(); },
    getAnalyticsEnabled: function () { return Promise.resolve(false); },
    setAnalyticsEnabled: function () { return Promise.resolve(true); },
    getDefaultSaveDir: function () { return Promise.resolve(getSaveDir()); },
    pickDefaultSaveDir: function () { return pickSaveDir(); },
    onThemeChanged: function () { return NOOP; },
    // 外链 / GitHub
    openGenTeam: function () { return Promise.resolve(); },
    openCreditUsage: function () { return Promise.resolve(); },
    openGitHubRepo: function () { return Promise.resolve(); },
    githubStars: function () { return Promise.resolve(null); },
    starPromptShouldShow: function () { return Promise.resolve({ show: false, docOpens: 0 }); },
    starPromptAction: function () { return Promise.resolve(); },
    // 云项目（M4）
    cloudProjectsCached: function () { return Promise.resolve(null); },
    cloudProjectsSync: function () { return Promise.resolve(null); },
    openCloudProject: function () { return Promise.resolve(); },
    // === 模型设置（getAiProviders 同步；getAiSettings 永不返回 null——SettingsModal 对 null 渲染空白） ===
    getAiSettings: function () {
      var s = loadAiSettings();
      console.info('[GenOffice] getAiSettings provider=' + s.provider + ' providers=' + Object.keys(s.providers).length);
      return Promise.resolve(s);
    },
    setAiSettings: function (s) {
      // 渲染层偶尔会回传"只含聊天字段"的对象 → 直接整份覆盖会把 media/search 的 Key 抹掉，
      // 所以要 normalize（缺的子结构补默认，已有 Key 保留）。
      saveAiSettings(s && s.providers ? normalizeAiSettings(s) : s);
      return Promise.resolve();
    },
    getAiProviders: function () { return AI_CATALOG; },
    // AI 面板模型下拉（与 app 侧 makeBridge 同一对实现，保证两边读同一份配置）
    getAiChatModels: function () { return Promise.resolve(aiChatModelChoices()); },
    setAiChatModel: function (m) { return Promise.resolve(aiApplyChatModel(m)); },
    // 「AI 媒体与搜索」分区的两个目录（上游 AiMediaPane 读这两个 + settings.media/search 形状）。
    // 目录为空 = 该区块不出现：生图未接（诚实降级），搜索只列真实现的 Serper / Tavily。
    getAiSearchProviders: function () { return AI_SEARCH_CATALOG; },
    getAiMediaProviders: function () { return AI_MEDIA_CATALOG; },
    // AI 面板偏好（桌面 home:get-ai-panel-prefs / home:set-ai-panel-prefs）：与 app 侧共用一份
    // 状态，因此复用 promise-shim 暴露的 __goShared 助手（同一 localStorage key + 同一 normalize）。
    // 语义对齐桌面 apps/shell/src/main/index.ts:3808 —— set 是 patch 合并，非法字段沿用上次值。
    getAiPanelPrefs: function () {
      var s = window.__goShared;
      if (s && typeof s.loadAiPanelPrefs === 'function') { return Promise.resolve(s.loadAiPanelPrefs()); }
      return Promise.resolve(AI_PANEL_FALLBACK);
    },
    setAiPanelPrefs: function (patch) {
      var s = window.__goShared;
      if (s && typeof s.mergeAiPanelPrefs === 'function') {
        var next = s.mergeAiPanelPrefs(patch);
        s.saveAiPanelPrefs(next);
        s.broadcastAiPanelPrefs(next);
        return Promise.resolve(next);
      }
      return Promise.resolve(AI_PANEL_FALLBACK);
    },
    // 测试连接：先 JS 端 fetch（避开 ArkWeb javaScriptProxy 在 Promise<JSON string> 通道上的 "non-injected object" 偶发问题），
    // fetch 失败（CORS/网络/服务端拒绝）再回退到 ArkTS 桥。两条都失败时给出明确错误。
    testAiSettings: function (s) {
      var BASE_URLS = {
        deepseek: 'https://api.deepseek.com/v1',
        glm: 'https://open.bigmodel.cn/api/paas/v4', qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        openai: 'https://api.openai.com/v1', kimi: 'https://api.moonshot.ai/v1',
        doubao: 'https://ark.cn-beijing.volces.com/api/v3', minimax: 'https://api.minimax.io/v1',
        xai: 'https://api.x.ai/v1', mistral: 'https://api.mistral.ai/v1',
        openrouter: 'https://openrouter.ai/api/v1',
        anthropic: 'https://api.anthropic.com/v1',
        gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
        'opencode-zen': '', 'opencode-go': '', custom: ''
      };
      try {
        var prov = (s && s.provider) || 'glm';
        var provConf = (s && s.providers && s.providers[prov]) || {};
        var apiKey = (provConf.apiKey || '').trim();
        var baseUrl = (provConf.baseUrl || '').trim() || BASE_URLS[prov] || '';
        if (!apiKey) {
          return Promise.resolve({ ok: false, error: '请先为当前提供商填写 API Key' });
        }
        if (!baseUrl) {
          return Promise.resolve({ ok: false, error: '该提供商暂不支持自动测试连接' });
        }
        // 协议判定与注入脚本里的 aiProtocolFor 同规则（SHELL_BRIDGE 是另一段脚本，不能跨作用域调用）：
        // 选 Claude 或端点里带 anthropic 字样 → Anthropic 的 models 端点（x-api-key + anthropic-version）。
        var protocol = (prov === 'anthropic' || baseUrl.indexOf('anthropic') >= 0) ? 'anthropic' : 'openai';
        // 尝试 1：JS fetch（同源 rawfile + ArkWeb 网络通道；跨域需服务端 CORS 放开）
        var doFetch = function () {
          if (typeof window.fetch !== 'function') { return Promise.reject(new Error('fetch unavailable')); }
          // 注意：SHELL_BRIDGE 是 TS 模板字面量，正则里的 / 会被 TS 转义成 /，
          // 注入后变 // 行注释导致整个脚本 SyntaxError。字符类 [/] 无需转义，安全。
          var url = baseUrl.replace(/[/]+$/, '') + '/models';
          var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
          var to = ctrl ? setTimeout(function () { try { ctrl.abort(); } catch (e) { /* ignore */ } }, 12000) : 0;
          var headers = protocol === 'anthropic'
            ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }
            : { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' };
          return window.fetch(url, {
            method: 'GET',
            headers: headers,
            signal: ctrl ? ctrl.signal : undefined,
          }).then(function (resp) {
            if (to) { clearTimeout(to); }
            if (resp && resp.status === 200) { return { ok: true }; }
            var msg = 'HTTP ' + (resp && resp.status);
            return resp && resp.text ? resp.text().then(function (t) {
              try {
                var j = JSON.parse(t);
                if (j && j.error && j.error.message) { msg = j.error.message; }
                else if (j && j.message) { msg = j.message; }
              } catch (e) { /* 非 JSON */ }
              return { ok: false, error: msg, status: resp.status };
            }) : { ok: false, error: msg };
          });
        };
        return doFetch().catch(function (fetchErr) {
          // 尝试 2：ArkTS 桥（http.createHttp 跨域无 CORS 限制）
          return goNative('testAiConnection', [baseUrl, apiKey, protocol]).then(function (r) {
            if (typeof r === 'string' && r) {
              try { var j = JSON.parse(r); if (j && typeof j.ok === 'boolean') { return j; } } catch (e) { /* 非 JSON */ }
            }
            return { ok: false, error: '无法连接服务器（fetch: ' + (fetchErr && (fetchErr.message || fetchErr)) + '）' };
          }).catch(function (e) {
            return { ok: false, error: '网络异常：' + String(e && (e.message || e) || e) };
          });
        });
      } catch (e) {
        return Promise.resolve({ ok: false, error: String(e && (e.message || e) || e) });
      }
    },
    // ===== 起始页「文件夹 / 搜索 / 模型」集群（批次 D-5：此前全部缺失）=====
    // 缺失的后果不是「点了没反应」而是**白屏**：壳桥过去是裸对象（见 wrapShellBridge 注释），
    // 渲染层 Home.tsx 挂载即调 folderRoots() → undefined 不是函数 → React 渲染中断。
    // 形状严格对齐桌面契约（apps/shell/src/shared/home-api.ts）：调用点会解引用的字段必须齐全，
    // 少一个字段就是把崩溃从「不是函数」换成「读 undefined 的属性」。
    // 语义：壳内没有「文件夹树 / 全文索引 / codex CLI」这些桌面主进程能力 → 返回**空集合**
    // （界面显示"没有文件夹 / 没有结果"，真实且不崩），写操作返回带原因的失败。
    folderRoots: function () { return Promise.resolve([]); },
    addFolderRoot: function () { return Promise.resolve(null); },
    dropFolderRoots: function () { return Promise.resolve([]); },
    removeFolderRoot: function () { return Promise.resolve(); },
    deleteFolder: function () { return Promise.resolve(); },
    // 桌面是同步的 webUtils.getPathForFile(file)（File → 绝对路径）；壳内拿不到 File 的真实
    // 路径（无 webUtils，且 resource/file URI 与 POSIX 路径不同源）→ 返回空串。
    // 调用点是拖拽落目录：Array.prototype.map 得到 [''] → dropFolderRoots(['']) → []，不崩。
    pathForFile: function () { return ''; },
    createFolder: function () {
      return Promise.resolve({ ok: false, error: '鸿蒙版暂不支持在起始页新建文件夹' });
    },
    renameFolder: function () {
      return Promise.resolve({ ok: false, error: '鸿蒙版暂不支持重命名文件夹' });
    },
    // MoveResult：moved/conflicts/failed 三个字段调用点都会读（.length / 遍历）
    movePaths: function (paths) {
      var list = Array.isArray(paths) ? paths : [];
      return Promise.resolve({
        moved: [],
        conflicts: [],
        failed: list.map(function (p) {
          return { path: String(p), error: '鸿蒙版暂不支持在起始页移动文件' };
        }),
      });
    },
    newHtml: function () { openApp('html'); return Promise.resolve(); },
    // FileSearchPage：hits/total/index 都会被解引用（index.scanning 决定"正在索引"提示）
    searchFiles: function () {
      return Promise.resolve({ hits: [], total: 0, index: { indexed: 0, pending: 0, scanning: false } });
    },
    // 契约是 FileSearchRerank | null（null = 重排关闭/不可用）→ 渲染层已有 null 分支
    rerankSearch: function () { return Promise.resolve(null); },
    // CodexModelCatalog {models, defaultModel}：SettingsModal 直接 live.models.includes(...)，
    // 且调用点有「if (!window.aiOffice.getCodexModels) return」的存在性判断 —— Proxy 兜底后
    // 该判断恒真，所以**必须**返回完整形状，不能靠 undefined 让它早退。
    getCodexModels: function () { return Promise.resolve({ models: [], defaultModel: '' }); },
    // 同类缺口（批次 D-6 真机复测）：进「设置」页即崩 Cannot read properties of undefined
    // (reading 'on') @ SettingsModal.tsx:1271 —— getAutoSaveDefault?.().then(v => setAutoSaveOn(v.on))。
    // 方法存在性由 wrapShellBridge 兜底（恒为函数），所以**必须**给真实形状；契约见
    // apps/shell/src/shared/home-api.ts:42 AutoSaveDefault {on, updatedAt}。
    // 语义（批次 E 扫描后修正）：过去恒返回关闭 —— 界面确实不崩，但用户拨开关会被
    // setAutoSaveDefault（当时没实现）静默吞掉，下次进来又是关的。现在两端都接上，
    // 值落在 localStorage，与 AI 设置同一套持久化。
    getAutoSaveDefault: function () { return Promise.resolve({ on: loadAutoSaveDefault(), updatedAt: 0 }); },
    // 同一处崩溃的兄弟调用点（SettingsModal.tsx:355 取自定义模型列表后直接 ce.models.length）：
    // 契约同 CodexModelCatalog {models, defaultModel}，空列表 = 界面上「没有可用模型」。
    getCustomModels: function () { return Promise.resolve({ models: [], defaultModel: '' }); },
    // ===== 本机 MCP 服务（「第三方集成」分区里嵌的 McpServerSection）=====
    // 鸿蒙版不在本机跑 MCP：那条链要 Node 运行时 + 可执行 launcher（桌面是 genoffice mcp）。
    // 但**形状必须给全**：组件写的是 getMcpStatus?.().then(takeStatus)，而 takeStatus 直接读
    // s.running —— 有了 Proxy 兜底，方法"存在"但 resolve(undefined)，于是崩成
    // reading 'running'（真机报回）。这正是"Proxy 把方法不存在翻译成读 undefined 属性"的老陷阱，
    // 差别只是这次连 ?. 都骗过去了。
    getMcpStatus: function () {
      return Promise.resolve({
        running: false, enabled: false, port: 3093, background: false, logging: false,
        url: null, capabilities: [],
        error: '鸿蒙版不在本机运行 MCP 服务（需要 Node 运行时与可执行 launcher）。如需把 GenOffice 接入其它 agent，可在「第三方集成」里导出技能说明或复制接入配置。'
      });
    },
    // 不回显用户请求的开关：拨完弹回关闭 + error 说明，比"显示已启用但什么都没跑"诚实
    setMcpSettings: function () {
      return Promise.resolve({
        running: false, enabled: false, port: 3093, background: false, logging: false,
        url: null, capabilities: [],
        error: '鸿蒙版不支持在本机启用 MCP 服务，该设置不会生效。'
      });
    },
    getMcpLogs: function () { return Promise.resolve([]); },
    openMcpLogFile: function () { return Promise.resolve(); },
    clearMcpLogs: function () { return Promise.resolve(); },
    // ===== 自动保存 / 文件搜索（Jev 重排）偏好 =====
    // 这几个方法在渲染层写成「方法名?.()」调用，因此**从来没进过覆盖门禁的视野**
    // （旧正则只认「方法名紧跟左括号」），是这次系统性扫描刚暴露的 20 个隐藏缺口之一。setAutoSaveDefault 过去
    // 干脆没有实现：用户在设置里拨开关 → Proxy 吞掉 → 下次进来又是关的（静默失效）。
    setAutoSaveDefault: function (on) {
      try { localStorage.setItem(AUTO_SAVE_KEY, on ? '1' : '0'); } catch (e) { /* 隐私模式 */ }
      return Promise.resolve();
    },
    getFileSearchSettings: function () { return Promise.resolve(loadFileSearchSettings()); },
    setFileSearchSettings: function (patch) {
      var cur = loadFileSearchSettings();
      var p = patch || {};
      var keys = p.jevKeys || cur.jevKeys;
      var next = {
        rerank: typeof p.rerank === 'boolean' ? p.rerank : cur.rerank,
        jevEndpoint: p.jevEndpoint === 'direct' ? 'direct' : (p.jevEndpoint === 'openrouter' ? 'openrouter' : cur.jevEndpoint),
        jevKeys: { openrouter: (keys && keys.openrouter) || '', direct: (keys && keys.direct) || '' }
      };
      try { localStorage.setItem(FILE_SEARCH_KEY, JSON.stringify(next)); } catch (e) { /* 忽略 */ }
      return Promise.resolve(next);
    },
    // Jev 重排要连 TypeSafe 侧端点：没有本机能力，但要给**渲染层认识的结果形状**
    // （调用点会把 error 直接显示出来，拿到 undefined 就是空白气泡）
    testFileSearchRerank: function (input) {
      var key = (input && input.apiKey) ? String(input.apiKey).trim() : '';
      var endpoint = (input && input.endpoint) === 'direct' ? 'direct' : 'openrouter';
      if (!key) {
        return Promise.resolve({ ok: false, error: '未填写 Jev API Key（' + endpoint + '）' });
      }
      var url = endpoint === 'direct'
        ? 'https://api.typesafe.org/v1/models'
        : 'https://openrouter.ai/api/v1/models';
      return goJson('aiPostJson', [url, JSON.stringify({ 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' }), '{}'])
        .then(function (r) {
          if (r && r.status >= 200 && r.status < 300) { return { ok: true }; }
          if (r && (r.status === 401 || r.status === 403)) { return { ok: false, error: 'Key 被拒（HTTP ' + r.status + '）' }; }
          return { ok: false, error: '无法连接 Jev 端点（HTTP ' + (r ? r.status : 0) + '）' };
        }, function (e) { return { ok: false, error: '网络异常：' + String((e && e.message) || e) }; });
    },
    // 「测试连接」按钮（批次 E 刚把 media/search 目录打开，这两个不实现就会把 undefined
    // 灌进 AiStatusPill 的 status.text —— 与本次真机崩的 getMcpStatus 同一类）
    testAiMediaSettings: function (input) {
      var cfg = (input && input.config) || {};
      var base = String(cfg.baseUrl || '').trim();
      var key = String(cfg.apiKey || '').trim();
      var pid = String((input && input.provider) || '');
      // 与 aiMediaEndpoint 同一套复用规则：媒体块没填的端点 / Key 回退到「AI 模型」里**同一供应商**。
      // 不这么做就会出现自相矛盾 —— 真机能打（壳侧已复用），「测试连接」却说没填 Key。
      if (!base || !key) {
        var vs = loadAiSettings();
        var vpc = (vs && vs.providers && vs.providers[pid]) || {};
        if (!base) { base = String(vpc.baseUrl || '').trim(); }
        if (!key) { key = String(vpc.apiKey || '').trim(); }
      }
      if (!base) { base = AI_MEDIA_BASE_DEFAULTS[pid] || ''; }
      if (!base) { return Promise.resolve({ ok: false, error: '该提供方需要填写端点（baseUrl）' }); }
      if (!key) { return Promise.resolve({ ok: false, error: '未填写 API Key' }); }
      var proto = base.indexOf('anthropic') >= 0 ? 'anthropic' : 'openai';
      return goNative('testAiConnection', [base, key, proto]).then(function (r) {
        if (typeof r === 'string' && r) {
          try { var j = JSON.parse(r); if (j && typeof j.ok === 'boolean') { return j; } } catch (e) { /* 落到下面 */ }
        }
        return r && typeof r.ok === 'boolean' ? r : { ok: false, error: '测试连接没有返回可用结果' };
      }, function (e) { return { ok: false, error: '网络异常：' + String((e && e.message) || e) }; });
    },
    testAiSearchSettings: function (input) {
      var key = String((input && input.apiKey) || '').trim();
      var pid = String((input && input.provider) || '');
      if (!key) { return Promise.resolve({ ok: false, error: '未填写搜索 API Key' }); }
      // 最小查询：Serper num=1 / Tavily max_results=1（都算一次额度，但这是唯一能验证 Key 的办法）
      var url = pid === 'tavily' ? 'https://api.tavily.com/search' : 'https://google.serper.dev/search';
      var headers = pid === 'tavily'
        ? { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key }
        : { 'Content-Type': 'application/json', 'X-API-KEY': key };
      var body = pid === 'tavily'
        ? JSON.stringify({ query: 'genoffice', max_results: 1 })
        : JSON.stringify({ q: 'genoffice', num: 1 });
      return goJson('aiPostJson', [url, JSON.stringify(headers), body]).then(function (r) {
        if (r && r.status >= 200 && r.status < 300) { return { ok: true }; }
        if (r && (r.status === 401 || r.status === 403)) { return { ok: false, error: 'Key 被拒（HTTP ' + r.status + '）' }; }
        return { ok: false, error: (pid || 'search') + ': HTTP ' + (r ? r.status : 0) };
      }, function (e) { return { ok: false, error: '网络异常：' + String((e && e.message) || e) }; });
    },
    onFolderChanged: function () { return NOOP; },
  };
  // 三个壳桥一律经 Proxy 兜底（裸赋值 = 未实现方法直接 TypeError → 起始页白屏）
  window.aiOffice = wrapShellBridge('aiOffice', aiOffice);


  window.aiOfficeProject = wrapShellBridge('aiOfficeProject', {
    listProjects: function () { return Promise.resolve([]); },
    listFiles: function () { return Promise.resolve([]); },
    createProject: function () { return Promise.resolve(null); },
    renameProject: function () { return Promise.resolve(); },
    deleteProject: function () { return Promise.resolve(); },
    moveFile: function () { return Promise.resolve(); },
    getTimeline: function () { return Promise.resolve([]); },
  });

  // ===== 「第三方集成」桥（批次 E 方案一：保留分区，给真实形状）=====
  // 桌面这个分区做的是「把 GenOffice 作为技能 / MCP 暴露给别家 agent」，清单是 claude-code /
  // codex / cursor / gemini / copilot / opencode / windsurf 这些**桌面 CLI/IDE**，靠往
  // ~/.claude/skills 这类目录写文件生效。鸿蒙 PC 上：那些程序基本不存在，且应用沙箱**不允许**
  // 往别的应用目录写 → status() 的诚实答案就是「未检测到可对接的 agent」（不是空白，也不是假成功）。
  // 沙箱内真正能做的两件事保留：把技能说明写成文件（用户放去任意已授权目录）+ 复制接入配置。
  function utf8ToB64(text) {
    var u = new TextEncoder().encode(String(text || ''));
    var bin = '';
    for (var i = 0; i < u.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, Array.prototype.slice.call(u.subarray(i, i + 0x8000)));
    }
    return btoa(bin);
  }
  function integrationSkillDoc() {
    return [
      '# GenOffice（鸿蒙版）技能说明',
      '',
      '版本：' + SHELL_APP_VERSION + ' / 平台：HarmonyOS PC（ArkWeb 壳）',
      '',
      'GenOffice 是 Word / Excel / PPT / PDF / Markdown 五合一离线编辑器，文档读写全部在本机完成。',
      'AI 能力为 BYO Key 直连：用户在 设置 → AI 模型 填写提供方端点、API Key 与模型 id，',
      '支持 OpenAI 兼容 /chat/completions 与 Anthropic /v1/messages 两条协议；任何能暴露成这两种',
      '协议之一的网关或本地 agent（含各类 token plan 中转）都可以直接接进来 —— 这才是本平台上',
      '「接入更强 AI」的实际路径，而不是把 Office 自身导出成别家 agent 的技能。',
      '',
      '## 为什么这里列不出可自动对接的 agent',
      '鸿蒙 PC 没有桌面 CLI/IDE 的技能目录语义，应用沙箱也不允许写入其它应用的目录，',
      '因此无法像桌面版那样把技能文件装进 claude-code / cursor 等工具。此构建不含命令行 launcher',
      '与 MCP stdio 服务（Node 运行时不存在）。',
      '',
      '## 可用的动作',
      '- 「导出技能说明」：把本文件写到你在系统选择器里指定的目录（例如你自己维护的配置目录）。',
      '- 复制配置：把上面这段接入说明放到剪贴板，自行粘贴到目标工具的配置文件。',
      ''
    ].join('\\n');
  }
  /** 技能文件落盘：dir 由 picker 给出，返回 SkillInstallState（{status, path}）*/
  function integrationWriteSkill(dir) {
    if (!dir) { return Promise.resolve({ status: 'missing', path: '' }); }
    return goJson('saveInDirJson', [dir, 'genoffice-skill.md', utf8ToB64(integrationSkillDoc())])
      .then(function (r) {
        if (r && r.ok && r.path) {
          return { status: 'installed', path: String(r.path), installedVersion: SHELL_APP_VERSION };
        }
        return { status: 'missing', path: '' };
      }, function () { return { status: 'missing', path: '' }; });
  }
  window.aiOfficeIntegrations = wrapShellBridge('aiOfficeIntegrations', {
    status: function () {
      return Promise.resolve({
        cli: {
          status: 'unsupported',
          location: '',
          manual: '鸿蒙版不含命令行 launcher（无 Node 运行时），无法作为 MCP stdio 服务被拉起',
          launcherDir: '',
          ephemeral: false,
          version: ''
        },
        skillVersion: SHELL_APP_VERSION,
        skillNeedsCli: '',
        agents: []
      });
    },
    // { agentId } → 沙箱定位不到别家目录 → 先让用户选一个目录；{ dir } → 直接写
    installSkill: function (target) {
      var dir = (target && target.dir) ? String(target.dir) : '';
      if (dir) { return integrationWriteSkill(dir); }
      return goJson('pickDirectory', []).then(function (pr) {
        var picked = (pr && pr.dir) ? String(pr.dir) : '';
        return integrationWriteSkill(picked || '');
      });
    },
    uninstallSkill: function () { return Promise.resolve({ status: 'missing', path: '' }); },
    pickSkillDir: function () {
      return goJson('pickDirectory', []).then(function (pr) {
        return (pr && pr.dir) ? String(pr.dir) : null;
      });
    },
    saveSkillZip: function () {
      return goJson('pickDirectory', []).then(function (pr) {
        var dir = (pr && pr.dir) ? String(pr.dir) : '';
        if (!dir) { return null; }
        return goJson('saveInDirJson', [dir, 'genoffice-skill.md', utf8ToB64(integrationSkillDoc())])
          .then(function (r) { return (r && r.ok && r.path) ? String(r.path) : null; },
            function () { return null; });
      });
    },
    copyText: function (text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          return navigator.clipboard.writeText(String(text || ''));
        }
        var nb = nativeBridge();
        if (nb && typeof nb.writeClipboardText === 'function') { nb.writeClipboardText(String(text || '')); }
      } catch (e) { /* 剪贴板不可用时静默（面板自己会显示"已复制"计时）*/ }
      return Promise.resolve();
    }
  });

  // 真实暴露名是 aiOfficeTabs（exposeInMainWorld('aiOfficeTabs', ...)）
  // Tab 宿主实现：list/activate/close/reorder 操作内存状态 + iframe，onChanged 推送 React TabBar
  window.aiOfficeTabs = wrapShellBridge('aiOfficeTabs', {
    list: function () { return Promise.resolve(tabs.slice()); },
    activate: function (id) { activateTab(id); return Promise.resolve(); },
    close: function (id) { return closeTab(id); },
    showMenu: function (x, y) { showTabsMenu(x, y); return Promise.resolve(); },
    showNewMenu: function (x, y) { showNewMenu(x, y); return Promise.resolve(); },
    reorder: function (id, toIndex) {
      var from = tabs.findIndex(function (t) { return t.id === id; });
      if (from < 1 || toIndex < 1) { return Promise.resolve(); } // home 恒在第 0 位
      var moved = tabs.splice(from, 1)[0];
      tabs.splice(Math.min(Math.max(toIndex, 1), tabs.length), 0, moved);
      notify();
      return Promise.resolve();
    },
    onChanged: function (handler) {
      listeners.push(handler);
      return function () {
        listeners = listeners.filter(function (h) { return h !== handler; });
      };
    },
    notifyChromePressed: NOOP,
    onChromePressed: function () { return NOOP; },
  });

})();

`;

// 错误采集器：把所有 JS 运行时错误渲染成页面顶部的红色覆盖层，白屏排障无需看日志。
const ERR_COLLECTOR = `(function () {
  var shown = 0;
  var origErr = console.error;
  function show(tag, msg) {
    if (shown > 20) { return; }
    shown++;
    // 同时打进 hilog，白屏排障时贴日志也能拿到完整堆栈（仅页面 overlay 会丢）
    try { origErr.call(console, '[GenOffice][' + tag + '] ' + msg); } catch (e) { /* 忽略 */ }
    try {
      var d = document.getElementById('__err_overlay');
      if (!d) {
        d = document.createElement('div');
        d.id = '__err_overlay';
        d.style.cssText = 'position:fixed;left:0;top:0;width:100%;max-height:50%;overflow:auto;background:#c62828;color:#fff;font:12px/1.5 monospace;z-index:2147483647;padding:6px 8px;box-sizing:border-box;white-space:pre-wrap;word-break:break-all';
        (document.body || document.documentElement).appendChild(d);
      }
      var p = document.createElement('pre');
      p.style.cssText = 'margin:4px 0;white-space:pre-wrap;word-break:break-all;font:inherit';
      p.textContent = '[' + tag + '] ' + msg;
      d.appendChild(p);
    } catch (e) { /* 最后手段 */ }
  }
  window.addEventListener('error', function (e) {
    // 资源加载错误（img/script/font 404、坏图 data URL…）的 message 常为空或与
    // 渲染逻辑无关，弹红覆盖层只会刷屏。这类错误只进 hilog，不打扰用户。
    var url = e.filename || (e.target && (e.target.src || e.target.href)) || '';
    var isResource = false;
    if (e.target && e.target.tagName && /^(IMG|LINK|SCRIPT|STYLE|OBJECT|EMBED|IFRAME|SOURCE|VIDEO|AUDIO|TRACK)$/.test(e.target.tagName)) { isResource = true; }
    if (/^(data:|resource:|blob:)/.test(url) && !e.message) { isResource = true; }
    if (isResource) {
      var brief = (e.message || 'resource') + (url ? ' @ ' + (url.length > 160 ? url.slice(0, 160) + '…' : url) : '');
      try { origErr.call(console, '[GenOffice][resource] ' + brief); } catch (er) { /* 忽略 */ }
      return;
    }
    var msg = (e.message || e.type || 'unknown') + (url ? ' @ ' + url : '') + (e.error && e.error.stack ? '\\n' + e.error.stack : '');
    show('error', msg);
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    var msg = (r && (r.stack || r.message)) ? ((r.message || '') + '\\n' + (r.stack || '')) : String(r);
    show('rejection', msg);
  });
  console.error = function () {
    var args = Array.prototype.slice.call(arguments).map(function (a) {
      return (a && a.stack) ? String(a.message) + '\\n' + a.stack : String(a);
    });
    show('console.error', args.join(' '));
    origErr.apply(console, arguments);
  };
})();

`;

@Entry
@Component
struct Index {
  controller: webview.WebviewController = new webview.WebviewController();
  desktop: DesktopBridge = new DesktopBridge();
  projectApi: ProjectApi = new ProjectApi();
  private ctx: common.Context | undefined = undefined;
  private serveLogCount: number = 0;
  /** javaScriptProxy 注册后的 refresh 只执行一次（防 onControllerAttached 重触发死循环） */
  private proxyRefreshed: boolean = false;
  /** 系统「打开方式」URI 投递 handler 只注册一次（页面存活期持续生效，支持热启动 onNewWant） */
  private wantHandlerReady: boolean = false;

  private mimeOf(path: string): string {
    const dot = path.lastIndexOf('.');
    const ext = dot >= 0 ? path.substring(dot + 1).toLowerCase() : '';
    switch (ext) {
      case 'js':
      case 'mjs':
        return 'text/javascript';
      case 'css':
        return 'text/css';
      case 'json':
        return 'application/json';
      case 'wasm':
        return 'application/wasm';
      case 'html':
      case 'htm':
        return 'text/html';
      case 'svg':
        return 'image/svg+xml';
      case 'png':
        return 'image/png';
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg';
      case 'gif':
        return 'image/gif';
      case 'webp':
        return 'image/webp';
      case 'ico':
        return 'image/x-icon';
      case 'woff':
        return 'font/woff';
      case 'woff2':
        return 'font/woff2';
      case 'ttf':
        return 'font/ttf';
      case 'otf':
        return 'font/otf';
      default:
        return 'application/octet-stream';
    }
  }

  /**
   * rawfile 资源自建响应：resourceManager 直读 + CORS 头 + 正确 MIME。
   * 读不到文件时返回 undefined 交回默认通道（保持 html/图片等现状行为）。
   * 两个入口：`resource://rawfile/…`（模块类资源，见 RAWFILE_MODULE_RE）与 https 别名
   * `https://goasset.local/…`（等价于 rawfile 根，供渲染层 fetch 走原生通道，不限扩展名 ——
   * cmaps/*.bcmap 不在模块清单里，但同样是 fetch 取字节的资源）。
   * 注意：WebResourceResponse / Header 是 Web 组件 d.ts 的全局类型（不经 webview 命名空间导入）；
   * getRawFileContent 返回 Promise，同步读用 getRawFileContentSync（API 12+）。
   */
  private serveRawfile(url: string): WebResourceResponse | undefined {
    const RAWFILE_PREFIX = 'resource://rawfile/';
    let aliased = false;
    let path = '';
    if (url.startsWith(ASSET_ORIGIN)) {
      aliased = true;
      path = url.substring(ASSET_ORIGIN.length);
    } else if (url.startsWith(RAWFILE_PREFIX)) {
      path = url.substring(RAWFILE_PREFIX.length);
    } else {
      return undefined;
    }
    const q = path.indexOf('?');
    if (q >= 0) {
      path = path.substring(0, q);
    }
    try {
      path = decodeURIComponent(path);
    } catch (e) {
      // 保留原样
    }
    if (!aliased && !RAWFILE_MODULE_RE.test(path)) {
      return undefined;
    }
    const rm = this.ctx?.resourceManager;
    if (!rm) {
      return undefined;
    }
    try {
      const data: Uint8Array = rm.getRawFileContentSync(path);
      const ab = new ArrayBuffer(data.byteLength);
      new Uint8Array(ab).set(data);
      const mime = this.mimeOf(path);
      // 只有文本类资源声明 UTF-8（既不给响应设编码，也不在 Content-Type 里带 charset），
      // 其余一律原始字节 —— 否则 ArkWeb 按文本解码响应体，字节被替换成 U+FFFD：
      // pdf.js 的 jbig2.wasm 因此实例化失败、扫描件（CCITT G4 瓦片）被静默丢弃成几乎全白页；
      // sheets 的 send-enter-off.png 因此破图（真机复测 D-6，见 RAWFILE_TEXT_RE）。
      const binary = !RAWFILE_TEXT_RE.test(path);
      const resp = new WebResourceResponse();
      // 组件级 WebResourceResponse 无 setErrorCode（那是 webview 命名空间版的 API），默认状态 200
      resp.setReasonMessage('OK');
      resp.setResponseMimeType(mime);
      if (!binary) {
        resp.setResponseEncoding('utf-8');
      }
      resp.setResponseHeader([
        { headerKey: 'Access-Control-Allow-Origin', headerValue: '*' },
        {
          headerKey: 'Content-Type',
          headerValue: binary ? mime : (mime + '; charset=utf-8')
        },
        { headerKey: 'Cache-Control', headerValue: 'no-store' }
      ]);
      resp.setResponseData(ab);
      resp.setResponseIsReady(true);
      if (this.serveLogCount < 30) {
        this.serveLogCount += 1;
        console.info('[GenOffice] rawfile served (' + this.serveLogCount + '): ' + path
          + ' via=' + (aliased ? 'alias' : 'rawfile')
          + ' mime=' + mime + ' binary=' + binary + ' bytes=' + data.byteLength);
      }
      return resp;
    } catch (e) {
      console.error('[GenOffice] rawfile serve miss: ' + path);
      return undefined;
    }
  }

  aboutToAppear(): void {
    this.ctx = this.getUIContext().getHostContext();
    // M3：文件桥需要 ctx（filesDir 存最近文件、save-new 落沙箱目录）
    // getHostContext() 可能返回 undefined，需空值守卫后再传给 setContext（其参数非可选）。
    if (this.ctx) {
      this.desktop.setContext(this.ctx);
    } else {
      console.error('[GenOffice] host context is undefined; file bridge ctx unavailable');
    }
    // 开发期可接 Chrome DevTools 调试（chrome://inspect），release 包必须关闭：
    // 调试开关常开等于把网页内容对外暴露给 DevTools 检查，上架审核也会拦。
    // 判据取 ApplicationInfo.debug（系统按签名 Profile 判定：debug 证书 true / release false），
    // 不用 BuildProfile —— 后者是 hvigor 生成模块，本机无法验证其存在性。
    const hostCtx: common.Context | undefined = this.ctx;
    let arkWebDebugAccess: boolean = false;
    if (hostCtx) {
      arkWebDebugAccess = hostCtx.applicationInfo.debug;
    }
    webview.WebviewController.setWebDebuggingAccess(arkWebDebugAccess);
    // READ_PASTEBOARD 是 user_grant 权限：仅 module.json5 声明不够，
    // pasteboard.getData() 在未授权时抛 201。启动时申请一次（拒绝时剪贴板桥返回 ''，不崩）。
    // 注意：requestPermissionsFromUser 是 AtManager 实例方法，需先 createAtManager()。
    if (this.ctx) {
      const perms: Array<Permissions> = ['ohos.permission.READ_PASTEBOARD'];
      const atManager: abilityAccessCtrl.AtManager = abilityAccessCtrl.createAtManager();
      atManager.requestPermissionsFromUser(this.ctx, perms)
        .then((result) => {
          console.info('[GenOffice] READ_PASTEBOARD auth: ' + result.authResults[0]);
        })
        .catch((e: object) => {
          console.error('[GenOffice] READ_PASTEBOARD request failed: ' + JSON.stringify(e));
        });
    }
  }

  build() {
    Column() {
      // 入口 = shell 起始页（应用选择器 + 模型设置）；点"新建文档"经 SHELL_BRIDGE 相对导航到 web/docs/
      Web({ src: $rawfile('web/shell/index.html'), controller: this.controller })
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .fileAccess(true)
        .mixedMode(MixedMode.All)
        // 设置 → 通用 → 主题的「跟随系统」：不写 data-theme 时靠 tokens.css 的
        // prefers-color-scheme 分支。ArkWeb 默认 WebDarkMode.Off，媒体查询恒为浅色，
        // 这就是审核第 3 条「跟随系统无效果」的宿主侧原因。Auto = 跟随系统（不做强制反色）。
        .darkMode(WebDarkMode.Auto)
        .javaScriptOnDocumentStart([
          { script: ERR_COLLECTOR, scriptRules: ["*"] },
          { script: PROMISE_SHIM, scriptRules: ["*"] },
          { script: SHELL_BRIDGE, scriptRules: ["*"] }
        ])
        // 注入走 registerJavaScriptProxy + refresh（官方文档明确"refresh 后注册生效"；
        // 声明式 javaScriptProxy 在真机上未生效）。关键 1：async（返回 Promise）方法
        // 必须放第 4 参 asyncMethodList —— 只塞 methodList 时 ArkWeb 不注入它们，
        // JS 调用报 "Javascript bridge method can't be invoked on a non-injected object"。
        // 关键 2：注册名 desktopNative/projectApiNative 与 PROMISE_SHIM mock 的
        // window.desktop 分离 —— mock 用 defineProperty 接管了 window.desktop（get 返回
        // Proxy、set 走 merge），gin 宿主对象方法不可枚举（Object.keys 为空），merge
        // 永远搬不动真实方法，同名注入会被 accessor 吞掉。
        .onControllerAttached(() => {
          this.controller.registerJavaScriptProxy(
            this.desktop, 'desktopNative',
            ['getLanguage', 'getTheme', 'platform', 'version',
              'recentFilesJson', 'writeClipboardText', 'bridgeCall'],
            // 此 ArkWeb 版本的 asyncMethodList 有 bug（返回 number 而非 Promise），
            // bridgeCall 只放 methodList 走同步调用，async 函数返回值 Promise 由
            // JS 侧 Promise.resolve(p).then() 正常 await，绕过 gin 桥 async 缺陷。
            []
          );
          this.controller.registerJavaScriptProxy(this.projectApi, 'projectApiNative', ['list']);
          // refresh 重载页面使注册生效；documentStart 脚本幂等（__wrapped guard）。
          // 一次性 guard：若部分版本 onControllerAttached 在每次 load 都触发，
          // 无条件 refresh 会变成无限重载循环（主线程被打满 → THREAD_BLOCK）。
          if (!this.proxyRefreshed) {
            this.proxyRefreshed = true;
            this.controller.refresh();
          }
        })
        .onPageEnd(() => {
          // 注入探测：结果经 onConsole 转发到 hilog（过滤 GenOffice 即见）。
          // 1) desktopNative=object + openDocxJson=function → gin 桥就绪；
          // 2) __goNativeCall=function → 顶层转发器就绪（PDF 等 iframe 路由经它转发到主 frame）；
          // 3) isIframe → 当前是 iframe（documentStart 真注入了 PROMISE_SHIM）；
          // 4) getLastJavascriptProxyCallingFrameUrl → ArkTS 端能区分调用方 frame。
          // 关键：iframe 路由（PDF 磁贴点开）的 bridge 调用路径是"iframe mock → __goNativeCall
          // 转发器（主 frame JS 函数）→ desktopNative.openFileJson() 在主 frame 内调"——因此
          // 顶层 frame 必须先就绪，iframe 启动后才可能成功。
          this.controller.runJavaScript(
            "(function(){var d=window.desktopNative;var fwd=null;" +
            "try{var c=window;while(c){if(typeof c.__goNativeCall==='function'){fwd=true;break;}if(c===c.parent)break;c=c.parent;}}catch(e){}" +
            "var isIframe=false;try{isIframe=(window.top&&window.top!==window.self);}catch(e){}" +
            "console.info('[GenOffice][probe] frame='+(isIframe?'iframe':'top')+" +
            "' desktopNative='+(typeof d)+" +
            "' bridgeCall='+(d&&typeof d.bridgeCall)+" +
            "' fwd='+(fwd?'ok':'no'));" +
            "if(isIframe&&d&&typeof d.bridgeCall==='function'){try{console.info('[GenOffice][probe] iframe-direct-bridgeCall-test');d.bridgeCall('openFileJson','[]').then(function(r){console.info('[GenOffice][probe] iframe-direct-bridgeCall-ok len='+(typeof r==='string'?r.length:typeof r));},function(e){console.info('[GenOffice][probe] iframe-direct-bridgeCall-err '+e);});}catch(e){console.info('[GenOffice][probe] iframe-direct-throw '+e);}}" +
            "})()"
          );
          // 系统「打开方式」（module.json5 viewData skill → EntryAbility want.uri）
          // 的分发注入点：URI 经 IncomingOpen 单例中转，页面就绪后到这儿注入 shell 桥，
          // 由 window.__goOpenExternalPath 按扩展名开对应 app tab（冷启动暂存的 URI 会立即投递）。
          if (!this.wantHandlerReady) {
            this.wantHandlerReady = true;
            IncomingOpen.onReady((uri: string) => {
              const js: string = 'window.__goOpenExternalPath(' + JSON.stringify(uri) + ')';
              try {
                this.controller.runJavaScript(js, (err: BusinessError, data: string) => {
                  if (err) {
                    console.error('[GenOffice] external open inject failed: ' + JSON.stringify(err));
                  } else {
                    console.info('[GenOffice] external open -> kind=' + data);
                  }
                });
              } catch (e) {
                console.error('[GenOffice] external open inject threw: ' + JSON.stringify(e));
              }
            });
          }
        })
        .onInterceptRequest((event): WebResourceResponse | undefined => {
          // rawfile 默认通道无 CORS 头/JS MIME：动态 import() 与 @font-face（crossorigin 模式）
          // 一律 Failed to fetch。这里自建响应：resourceManager 直读 + Access-Control-Allow-Origin。
          // 同时服务 https 别名（`window.__goAssetBase`），让 pdf.js 的 cmap/字体/wasm 走原生通道。
          return this.serveRawfile(event.request.getRequestUrl());
        })
        .onPageBegin(() => {
          // rawfile 内相对资源：index.html 用相对路径引用 assets/，ArkWeb 可直接解析
        })
        .onConsole((event): boolean => {
          // ArkWeb console 输出转发进 HiLog，tag = GenOffice，IDE 日志窗口可直接过滤
          const m = event.message;
          console.info(`[GenOffice] console.${m.getMessageLevel()}: ${m.getMessage()}`);
          return false; // false = 保留 ArkWeb 默认 console 行为
        })
        .onErrorReceive((event) => {
          if (event && !event.request.getRequestUrl().startsWith('http')) {
            console.error(`[GenOffice] web error: ${event.request.getRequestUrl()} ${event.error.getErrorInfo()}`);
          }
        })
        .width('100%')
        .height('100%')
    }
    .width('100%')
    .height('100%')
  }
}
