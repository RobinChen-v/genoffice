// 注入 JS 独立源码（R1 外置化）：ERR_COLLECTOR 的唯一维护处。
// 改动直接编辑本文件（真实 JS，无模板字面量转义），然后跑：
//   node harmony/scripts/build-injected.mjs   # esbuild 打包 → 转义回填 Index.ets
// verify-all 的新鲜度门禁会比对 Index.ets 回填内容与本文件构建产物，过期即 FAIL。
(function () {
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
    var msg = (e.message || e.type || 'unknown') + (url ? ' @ ' + url : '') + (e.error && e.error.stack ? '\n' + e.error.stack : '');
    show('error', msg);
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    var msg = (r && (r.stack || r.message)) ? ((r.message || '') + '\n' + (r.stack || '')) : String(r);
    show('rejection', msg);
  });
  console.error = function () {
    var args = Array.prototype.slice.call(arguments).map(function (a) {
      return (a && a.stack) ? String(a.message) + '\n' + a.stack : String(a);
    });
    show('console.error', args.join(' '));
    origErr.apply(console, arguments);
  };
})();

