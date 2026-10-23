// 注入 JS 独立源码（R1 外置化）：SHELL_BRIDGE 的唯一维护处。
// 改动直接编辑本文件（真实 JS，无模板字面量转义），然后跑：
//   node harmony/scripts/build-injected.mjs   # esbuild 打包 → 转义回填 Index.ets
// verify-all 的新鲜度门禁会比对 Index.ets 回填内容与本文件构建产物，过期即 FAIL。
(function () {

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
    return lines.join('\n');
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
      + '\n\n日志抓取（电脑连上设备后执行）：\n  hdc hilog | grep GenOffice';
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
        return arr[1] + '\n\n' + arr[0];
      });
    }
    var viewing = 'basic';
    legalBasicText().then(function (t) {
      pre.value = t;
    }).catch(function (e) {
      pre.value = '读取失败：' + (e && e.message ? e.message : String(e))
        + '\n\n许可文本文件位于应用包内 resources/rawfile/web/legal/（LICENSE.txt / NOTICE.txt / '
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
    ].join('\n');
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

