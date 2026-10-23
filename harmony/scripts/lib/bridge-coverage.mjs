// 桥覆盖门禁的纯逻辑层（批次 B）。
//
// 背景：`makeBridge` 的 Proxy 对未实现方法静默 `Promise.resolve(undefined)` ——
// 用户报的「点了没反应」几乎全从这个缝里来；而 verify-all 的 checkBridgeRegistration
// 只校验「native 方法 → 壳侧是否注册」这一个方向，反向（渲染层调了、壳侧没有）没有任何门禁，
// 历史审计里 199 个缺口全部落在盲区。
//
// 本模块把「调用面」与「实现面」对齐，**所有函数只吃字符串**（不碰文件系统），
// 由 CLI（scripts/check-bridge-coverage.mjs）负责读盘，反例自测则喂合成源码。
//
// 实现面 = Index.ets 注入脚本里的 mock 对象字面量（按行区间 + 缩进取 key）
//        + harmony/entry/src/main/ets/bridge/*.ets 的 case 分支与 public 方法名。

/** Index.ets 里 mock 对象的起始标记（顺序无关，按行号排序后切区间）。 */
export const MOCK_MARKERS = [
  ['mock', /var mock = /],
  ['projectMock', /var projectMock = /],
  ['pdfMock', /var pdfMock = /],
  ['markdownMock', /var markdownMock = /],
  ['slidesMock', /var slidesMock = /],
  ['sheetsMock', /var sheetsMock = /],
  // __goBoot 的键在下一段被 Object.keys(...).forEach 并进 base mock → 所有 app 都继承；
  // 少了这个 marker，parseMockKeys 会把这段区间整个错判给前一个对象（PPT deck 操作因此被当成未实现）。
  ['goBoot', /window\.__goBoot = \{/],
  ['aiOffice', /var aiOffice = /],
  ['aiOfficeProject', /window\.aiOfficeProject = /],
  ['aiOfficeTabs', /window\.aiOfficeTabs = /],
];

/**
 * 命名空间 → 实现集合来源（可多个，取并集）。
 * mock 继承链：pdf/markdown/slides/sheets/project 都是 `Object.assign({}, mock, {…})`；
 * desktopApi 用 sheetsMock（继承 mock + exportPdf 覆写），故并上两者。
 */
export const NS_IMPL = {
  // goBoot = 壳内 deck 引导层，键会被并进 mock（见 window.__goBoot 后的 Object.keys 循环）
  desktop: ['mock', 'goBoot'],
  desktopApi: ['mock', 'sheetsMock', 'goBoot'],
  pdfApi: ['mock', 'pdfMock', 'goBoot'],
  slidesApi: ['mock', 'slidesMock', 'goBoot'],
  markdownApi: ['mock', 'markdownMock', 'goBoot'],
  projectApi: ['mock', 'projectMock', 'goBoot'],
  aiOffice: ['aiOffice'],
  aiOfficeProject: ['aiOfficeProject'],
  aiOfficeTabs: ['aiOfficeTabs'],
};

/**
 * 崩溃风险启发式（与用户可见症状对应）：未实现方法返回 undefined，调用点紧接着解引用
 * 就会抛 TypeError（比静默 no-op 更糟 —— 用户看到报错）。取调用行 + 后 RISK_WINDOW-1 行判定。
 * 注意这是**启发式且仅供参考**（不参与红/绿判定，只打印在 Notes 里）：
 * `!target` / `if (!data)` 这类空值保护也算命中，需人工复核
 * （批次 A 的结论：58 命中里真崩溃 3 个，其余是安全 no-op）。
 *
 * 窗口取 9 行的依据（批次 C 实测，全 site 口径）：
 *   +4 行 → 46 命中（漏判 markdownApi.exportDocx：`if (!result.ok)` 在第 6 行）
 *   +6 行 → 54；**+8 行 → 61**；+12 行 → 81（假阳性淹没，不可用）
 * +8 行能抓到「await 结果跨多行对象字面量再解引用」这类真崩溃，是召回/噪声的折中点。
 */
export const RISK_WINDOW = 9;
export const RISK_RE = /(\.ok\b|\.error\b|\.map\(|\.forEach\(|\.length\b|\.results\b|\.images\b|\.base64\b|\.path\b|![a-zA-Z_$][\w$]*\s*[.)]|\[0\])/;

/**
 * 从 Index.ets 源码解析各 mock 对象的 key。
 * @param {string} indexSrc
 * @returns {Record<string, Set<string>>} 标记名 → key 集合
 */
export function parseMockKeys(indexSrc) {
  const lines = indexSrc.split('\n');
  const found = [];
  for (const [name, re] of MOCK_MARKERS) {
    const i = lines.findIndex((l) => re.test(l));
    // goBoot 这类"合并进 mock 的引导层"在**合成夹具**里不存在（self-test-bridge-coverage 用的是
    // 手搓源码片段）。缺失只表示"这份源码没有这一层"，给空集即可；真正致命的缺 marker（mock /
    // pdfMock 等）仍然必须抛错，所以按名字白名单放行。
    if (i < 0) {
      if (name === 'goBoot') { continue; }
      throw new Error('未找到 mock 标记：' + name);
    }
    found.push({ name, start: i });
  }
  found.sort((a, b) => a.start - b.start);
  // 区间终点：下一个标记前一行；最后一个标记到模板串结束（行首 `;）
  const templateEnd = lines.findIndex((l, i) => i > found[found.length - 1].start && /^`;$/.test(l));
  if (templateEnd < 0) throw new Error('未找到注入模板串结束标记（行首 `;）—— Index.ets 结构变了？');
  found.forEach((f, k) => { f.end = k + 1 < found.length ? found[k + 1].start - 1 : templateEnd; });

  const out = {};
  for (const f of found) {
    const keys = new Set();
    for (let i = f.start; i <= f.end; i++) {
      const m = /^\s{4,6}([A-Za-z_$][\w$]*)\s*:/.exec(lines[i]);
      if (m) keys.add(m[1]);
    }
    out[f.name] = keys;
  }
  return out;
}

/**
 * 从桥类源码解析 native 方法名（case 分支 + 类 public 方法）。
 * @param {string[]} bridgeTexts
 * @returns {Set<string>}
 */
export function parseNativeMethods(bridgeTexts) {
  const native = new Set();
  for (const s of bridgeTexts) {
    for (const m of s.matchAll(/case\s+'([A-Za-z0-9_$]+)'\s*:/g)) native.add(m[1]);
    const re = /export\s+class\s+(\w+)\s*\{/g;
    let cm;
    while ((cm = re.exec(s)) !== null) {
      const bodyStart = cm.index + cm[0].length;
      let depth = 1, i = bodyStart;
      while (i < s.length && depth > 0) { if (s[i] === '{') depth++; else if (s[i] === '}') depth--; i++; }
      for (const m of s.slice(bodyStart, i).matchAll(/^\s{2}(?!private|static|readonly)([a-zA-Z][\w$]*)\s*\(/gm)) native.add(m[1]);
    }
  }
  return native;
}

/** 渲染层 src/main 属于 Electron 主进程专用（壳内不加载）→ 不计 UI 可达。 */
export function reachOf(site) {
  return /src\/main\//.test(site) ? 'electron-only' : 'ui';
}

/**
 * 抽取 `window.<ns>.<method>(` 调用点。
 *
 * ⚠️ 正则必须同时吃 **可选链** `ns?.m()` 与 `ns.m?.()`：真机崩过的 `getMcpStatus` 就是写成
 * `window.aiOffice.getMcpStatus?.()` —— 旧写法只匹配「方法名紧跟 (」，于是全部门禁看不见
 * 这类调用点（实测 48 个 ns.method 组合被漏掉，含 27 个 aiOffice 方法）。渲染层的
 * `?.()` 不只是"防方法不存在"，它把**返回值的解引用**留给了 then 回调，恰恰是最容易炸的地方。
 * @param {{path: string, text: string}[]} appFiles
 * @returns {Map<string, Map<string, {site: string, reach: string, context: string}[]>>}
 */
export function extractWindowCalls(appFiles) {
  const calls = new Map();
  for (const f of appFiles) {
    const lines = f.text.split('\n');
    lines.forEach((line, i) => {
      // 分隔符是「点」，点前可有一个 `?`（ns?.m()）；方法名后可跟 `?.`（ns.m?.()）
      for (const m of line.matchAll(/window\.([A-Za-z]+)\s*(?:\?\s*)?\.\s*([A-Za-z_$][\w$]*)\s*(?:\?\s*\.)?\s*\(/g)) {
        const [, ns, method] = m;
        if (!(ns in NS_IMPL) || method === 'call' || method === 'apply' || method === 'bind') continue;
        if (!calls.has(ns)) calls.set(ns, new Map());
        const per = calls.get(ns);
        if (!per.has(method)) per.set(method, []);
        const site = f.path + ':' + (i + 1);
        per.get(method).push({
          site,
          reach: reachOf(site),
          // 调用行 + 后 RISK_WINDOW-1 行：崩溃风险判定的上下文窗口（见 RISK_WINDOW 注释的实测依据）
          context: lines.slice(i, i + RISK_WINDOW).join(' '),
        });
      }
    });
  }
  return calls;
}

/** native 侧可覆盖某方法名（含 …Json 后缀/去后缀的别名写法）。 */
export function nativeCovers(native, method) {
  return native.has(method) || native.has(method + 'Json') || native.has(method.replace(/Json$/, ''));
}

/**
 * 计算缺口（渲染层调了、壳侧两处都没有）。
 * @returns {{ns:string, method:string, kind:'call'|'subscribe', ui:number, total:number,
 *            sites:{site:string,reach:string,context:string}[], risk:string}[]}
 */
export function computeGaps({ mockKeys, native, calls }) {
  const impls = {};
  for (const [ns, keys] of Object.entries(NS_IMPL)) {
    const set = new Set();
    for (const k of keys) for (const v of mockKeys[k] || []) set.add(v);
    impls[ns] = set;
  }
  const gaps = [];
  for (const [ns, per] of calls) {
    for (const [method, sites] of per) {
      if (impls[ns].has(method) || nativeCovers(native, method)) continue;
      const uiSites = sites.filter((s) => s.reach === 'ui');
      if (uiSites.length === 0) continue; // Electron-only（src/main）不计：壳内根本不会走到
      gaps.push({
        ns,
        method,
        kind: /^on[A-Z]/.test(method) ? 'subscribe' : 'call',
        ui: uiSites.length,
        total: sites.length,
        sites: uiSites,
        risk: uiSites.map((s) => (RISK_RE.test(s.context) ? RISK_RE.exec(s.context)[0] : '')).find(Boolean) || '',
      });
    }
  }
  return gaps;
}

export function gapKey(g) {
  return g.ns + '.' + g.method;
}

/**
 * 白名单比对。语义：**只减不增**
 *  - 新缺口（不在白名单）→ 报红
 *  - 白名单条目已不再是缺口（实现了 / 调用点消失）→ 报红（必须删除，防止白名单腐化）
 *  - 白名单条目数 > budget → 报红（防止「顺手把它加进白名单」绕过门禁）
 * @param {ReturnType<typeof computeGaps>} gaps
 * @param {{budget?: number, entries?: {ns:string, method:string}[]}} allowlist
 */
export function judgeAllowlist(gaps, allowlist) {
  const allowed = new Set((allowlist.entries || []).map((e) => e.ns + '.' + e.method));
  const current = new Set(gaps.map(gapKey));
  const newGaps = gaps.filter((g) => !allowed.has(gapKey(g)));
  const stale = (allowlist.entries || []).filter((e) => !current.has(e.ns + '.' + e.method));
  const budget = allowlist.budget;
  const overBudget = typeof budget === 'number' && allowed.size > budget;
  return { newGaps, stale, overBudget, budget, count: allowed.size };
}

/** 汇总统计（与 M8 审计文档口径一致：方法数与调用点两个数字）。 */
export function summarize(gaps) {
  const uiSites = gaps.reduce((n, g) => n + g.ui, 0);
  const risk = gaps.filter((g) => g.risk);
  return { methods: gaps.length, sites: uiSites, riskMethods: risk.length, risk };
}

/** 生成白名单条目（排序稳定 → git diff 可读）。 */
export function toAllowlistEntries(gaps) {
  return gaps
    .map((g) => ({ ns: g.ns, method: g.method, kind: g.kind, ui: g.ui }))
    .sort((a, b) => (a.ns === b.ns ? a.method.localeCompare(b.method) : a.ns.localeCompare(b.ns)));
}

// ───────────────────────── 契约对账（R2-5） ─────────────────────────
// 背景：R2 引入了 bridge-contract.json 作为桥契约的单一事实来源。
// 三方对账 = 契约 ↔ 实现面（mock + native） ↔ 调用面（渲染层 window.ns.method()）。
//
// 新增两类检查：
//   1. 调用面有、契约中没有 → 契约过期（preload 变了但没重新生成契约）或渲染层 bug
//   2. 实现面有、契约中没有 → 实现超出契约范围（手工添加了契约中不存在的方法）
//
// 这两类都是「契约与实际不一致」的信号，必须报红。

/**
 * 从契约 JSON 中提取每个命名空间的方法集。
 * @param {Record<string, Record<string, Record<string, {kind: string}>>>} contract
 *   格式：{ app: { ns: { method: { kind, ... } } } }
 * @returns {Map<string, Set<string>>} 命名空间 → 方法名集合
 */
export function parseContractMethods(contract) {
  const out = new Map();
  for (const [app, bridges] of Object.entries(contract)) {
    if (bridges._error) continue;
    for (const [ns, methods] of Object.entries(bridges)) {
      if (typeof methods !== 'object' || methods._error) continue;
      if (!out.has(ns)) out.set(ns, new Set());
      for (const m of Object.keys(methods)) {
        out.get(ns).add(m);
      }
    }
  }
  return out;
}

/**
 * 计算调用面有、契约中没有的方法（契约过期/渲染层 bug）。
 * 排除在实现面（mock + native）中已有方法——那些是鸿蒙侧特有的方法，不是 bug。
 * @param {{contract: Map<string, Set<string>>, calls: Map<string, Map<string, any[]>>, impls?: Record<string, Set<string>>, native?: Set<string>}} args
 * @returns {{ns: string, method: string, sites: any[]}[]}
 */
export function computeContractGaps({ contract, calls, impls, native }) {
  const gaps = [];
  for (const [ns, per] of calls) {
    const contractMethods = contract.get(ns);
    if (!contractMethods) {
      // 渲染层调了一个契约中完全不存在的命名空间
      for (const [method, sites] of per) {
        const uiSites = sites.filter((s) => s.reach === 'ui');
        if (uiSites.length > 0) {
          // 排除在实现面中已有的方法
          const nsImpls = impls?.[ns];
          if (nsImpls && nsImpls.has(method)) continue;
          if (native && nativeCovers(native, method)) continue;
          gaps.push({ ns, method, sites: uiSites, reason: 'namespace_not_in_contract' });
        }
      }
      continue;
    }
    for (const [method, sites] of per) {
      if (contractMethods.has(method)) continue;
      // 排除在实现面中已有的方法（鸿蒙侧特有的方法，不在 preload 契约中是合理的）
      const nsImpls = impls?.[ns];
      if (nsImpls && nsImpls.has(method)) continue;
      if (native && nativeCovers(native, method)) continue;
      const uiSites = sites.filter((s) => s.reach === 'ui');
      if (uiSites.length === 0) continue;
      gaps.push({ ns, method, sites: uiSites, reason: 'method_not_in_contract' });
    }
  }
  return gaps;
}

/**
 * 计算实现面有、契约中没有的方法（实现超出契约范围）。
 * 只检查 mock 实现面（native 桥有别名机制，不适合严格对账）。
 * @param {{contract: Map<string, Set<string>>, mockKeys: Record<string, Set<string>>}} args
 * @returns {{ns: string, method: string, source: string}[]}
 */
export function computeUncontractedImpls({ contract, mockKeys }) {
  const out = [];
  for (const [ns, sources] of Object.entries(NS_IMPL)) {
    const contractMethods = contract.get(ns);
    if (!contractMethods) continue; // 契约中没有这个命名空间，跳过（由 computeContractGaps 处理）

    const implSet = new Set();
    for (const k of sources) for (const v of mockKeys[k] || []) implSet.add(v);

    for (const method of implSet) {
      // 排除 __has / __unsupported（能力探测 API，不是契约方法）
      if (method === '__has' || method === '__unsupported') continue;
      if (!contractMethods.has(method)) {
        out.push({ ns, method, source: 'mock' });
      }
    }
  }
  return out;
}
// 背景：M8-FULL-AUDIT §5 —— 134 个缺口「在任何用户可见文档中都没有说明」，
// BETA 用户点到不可用入口只会以为卡死。补文档之后还要防漂移：
// 缺口数变了、文档里的数字没跟着变 → 门禁报红（数字只有一处机器可读来源）。

/** 命名空间 → 文档里的 app 分组名（BETA-RELEASE-NOTES §5 用这套词）。 */
export const NS_DOC_GROUP = {
  slidesApi: 'PPT',
  desktop: 'Word',
  desktopApi: 'Excel',
  markdownApi: 'Markdown',
  pdfApi: 'PDF',
  aiOffice: '起始页',
  aiOfficeTabs: '起始页',
};

/** 每命名空间缺口数（含 0，让「已清零」也可见）。 */
export function nsCounts(gaps) {
  const byNs = {};
  for (const ns of Object.keys(NS_DOC_GROUP)) byNs[ns] = 0;
  for (const g of gaps) byNs[g.ns] = (byNs[g.ns] || 0) + 1;
  return { total: gaps.length, byNs };
}

/** 机器可读标记（写在 BETA-CHECKLIST.md 里，由 --update 重写）。 */
export function formatCoverageMarker(counts) {
  const parts = Object.entries(counts.byNs)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ns, n]) => ns + '=' + n);
  return '<!-- BRIDGE-COVERAGE: total=' + counts.total + ' ' + parts.join(' ') + ' -->';
}

const MARKER_RE = /<!--\s*BRIDGE-COVERAGE:\s*([^>]*?)-->/;

export function parseCoverageMarker(text) {
  const m = MARKER_RE.exec(text || '');
  if (!m) return null;
  const out = { total: null, byNs: {} };
  for (const kv of m[1].trim().split(/\s+/)) {
    const [k, v] = kv.split('=');
    const n = Number(v);
    if (!k || !Number.isFinite(n)) continue;
    if (k === 'total') out.total = n; else out.byNs[k] = n;
  }
  return out;
}

/**
 * 判定两份 BETA 文档是否与实际缺口一致。
 * @param {{checklist: string, notes: string, counts: {total:number, byNs:Record<string,number>}}} args
 * @returns {string[]} 错误列表（空 = 通过）
 */
export function judgeLimitsDocs({ checklist, notes, counts }) {
  const errs = [];
  if (!checklist || checklist.length < 200) errs.push('BETA-CHECKLIST.md 读空或过短（' + (checklist || '').length + ' 字节）');
  if (!notes || notes.length < 200) errs.push('BETA-RELEASE-NOTES.md 读空或过短（' + (notes || '').length + ' 字节）');
  if (errs.length) return errs;

  // ① 机器可读标记必须存在且与实时缺口数逐项一致
  const marker = parseCoverageMarker(checklist);
  if (!marker) {
    errs.push('BETA-CHECKLIST.md 缺 BRIDGE-COVERAGE 标记（跑 node scripts/check-bridge-coverage.mjs --update 生成）');
  } else {
    if (marker.total !== counts.total) {
      errs.push('已知限制数字过期：CHECKLIST total=' + marker.total + '，实际=' + counts.total + '（修完缺口请 --update 并同步改文案）');
    }
    for (const ns of Object.keys(NS_DOC_GROUP)) {
      const a = marker.byNs[ns];
      const b = counts.byNs[ns] || 0;
      if (a === undefined) errs.push('BRIDGE-COVERAGE 标记缺命名空间 ' + ns);
      else if (a !== b) errs.push('已知限制数字过期：CHECKLIST ' + ns + '=' + a + '，实际=' + b);
    }
  }

  // ② 给测试者看的精简版必须按 app 分组列出限制（只查分组名，不查数字 —— 数字只有一处来源）
  const sec = /##\s*5\.\s*已知限制[\s\S]*?(?=\n##\s|\n*$)/.exec(notes);
  if (!sec) {
    errs.push('BETA-RELEASE-NOTES.md 缺「## 5. 已知限制」小节');
  } else {
    const need = new Set();
    for (const [ns, n] of Object.entries(counts.byNs)) if (n > 0) need.add(NS_DOC_GROUP[ns]);
    for (const g of [...need].sort()) {
      if (!sec[0].includes(g)) errs.push('已知限制小节缺 ' + g + ' 分组（该 app 有未实现入口，测试者必须被告知）');
    }
  }
  return errs;
}