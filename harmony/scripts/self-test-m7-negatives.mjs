#!/usr/bin/env node
// 负向自检：把 verify-all.mjs 里 M7 的静态门禁函数抠出来单独跑，逐点破坏源码后断言
// "必须变红"——防止门禁断言写错路径/正则后永远绿（历史教训：接线看着在、行为已死）。
//   checkAppFileMenu        壳 chrome 菜单「另存为…/打印…」按 app 类型派发
//   checkPdfSignaturePersist PDF 签名库落盘 + 返回结构对齐渲染层
//   checkSheetsFileTab      sheets 文件 tab（含大按钮图标必须包 .tool-symbol 才拿到 28px 尺寸）
//   checkArktsSemantics     ArkTS 语义规则（无类型对象字面量 / any，本地无 ArkTS 编译器只能静态拦）
//   checkBundleNameAlignment 发布包名一致性（app.json5 ↔ 发布 Profile，不一致必签名失败）
//   checkReleaseDebuggingSwitch ArkWeb 调试开关不得写死（release 包不能开 DevTools 口）
//   checkSigningConfigHygiene 签名配置卫生（明文口令 / 旧调试配置 / 别名不匹配都不得进 build-profile.json5）
// 用法：node scripts/self-test-m7-negatives.mjs
import { readFileSync as realRead, readdirSync as realReaddir, existsSync as realExists, statSync as realStat } from 'node:fs'
import { resolve as realResolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const verifySrc = realRead(realResolve(__dirname, 'verify-all.mjs'), 'utf8')

// 取顶层函数体：从 "\nfunction name(" 到下一个行首 "}"（不能数括号——函数体里有 '{' 字面量）
function extractFn(src, name) {
  const start = src.indexOf('\nfunction ' + name + '(')
  if (start < 0) throw new Error('verify-all.mjs 已无函数 ' + name + '（门禁被删/改名？）')
  const end = src.indexOf('\n}', start)
  if (end < 0) throw new Error('未找到函数 ' + name + ' 的结尾')
  return src.slice(start, end + 2)  // 含行首的收尾 }
}

// new Function 只是"取出"函数，必须再调一次 () 才执行
function buildRunner(fnName) {
  const body = extractFn(verifySrc, fnName)
  const factory = new Function(
    'readFileSync',
    'resolve',
    '__dirname',
    'readdirSync',
    'existsSync',
    'statSync',
    body + '\n; return ' + fnName + ';',
  )
  return (mutate) => {
    const readFileSync = (p, enc) => {
      const txt = realRead(p, enc)
      const label = typeof p === 'string' ? p : ''
      if (!mutate) return txt
      if (label.endsWith('Index.ets')) return mutate(txt, 'Index.ets')
      return mutate(txt, label)
    }
    factory(readFileSync, realResolve, realResolve(__dirname), realReaddir, realExists, realStat)()
  }
}

// build-profile.json5 的 signingConfigs 会被 DevEco 回写成真实配置（不再是空数组 []），
// 负例改写必须按括号配平整段替换；否则 replace('"signingConfigs": []') 变成空操作 → 假绿。
function signingConfigsBounds(t) {
  const key = t.indexOf('"signingConfigs"')
  if (key < 0) return null
  const open = t.indexOf('[', key)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < t.length; i++) {
    if (t[i] === '[') depth++
    else if (t[i] === ']') { depth--; if (depth === 0) return [key, i] }
  }
  return null
}
function setSigningConfigs(t, body) {
  const b = signingConfigsBounds(t)
  if (!b) return t
  return t.slice(0, b[0]) + '"signingConfigs": [' + body + ']' + t.slice(b[1] + 1)
}
function dropSigningConfigs(t) {
  const b = signingConfigsBounds(t)
  if (!b) return t
  let end = b[1] + 1
  while (end < t.length && /[\s,]/.test(t[end])) {
    if (t[end] === ',') { end++; break }
    end++
  }
  return t.slice(0, b[0]) + t.slice(end)
}

const SUITES = [
  {
    fn: 'checkAppFileMenu',
    cases: [
      ['对照：真实源码必须通过', null, null],
      ['APP_FILE_ACTIONS 少一个 app 类型', (t, l) => l === 'Index.ets' ? t.replace('    pdf: [', '    pdfx: [') : t, /APP_FILE_ACTIONS 缺 app 类型: pdf/],
      ['pdf 消息键名被改（键名拼错=点了没反应）', (t, l) => l === 'Index.ets' ? t.replace('__goSaveAsRequest: true', '__goSaveAsReq: true') : t, /pdf 菜单动作缺 __goSaveAsRequest/],
      ['showTabsMenu 不再派发到 frame', (t, l) => l === 'Index.ets' ? t.replace('postToTab(t.id, a.msg)', 'noop(t.id, a.msg)') : t, /showTabsMenu 缺: postToTab/],
      ['postToTab 不再取 contentWindow', (t, l) => l === 'Index.ets' ? t.replace('function postToTab(id, msg) {\n    var w = frameWinOf(id);', 'function postToTab(id, msg) {\n    var w = null;') : t, /postToTab 缺: frameWinOf/],
      ['frame listener 丢了打印分支', (t, l) => l === 'Index.ets' ? t.replace('if (d.__goPrintRequest) { triggerFramePrint(); return; }', 'if (false) { return; }') : t, /listener 缺派发分支/],
      ['frame listener 丢了导出分支', (t, l) => l === 'Index.ets' ? t.replace("if (typeof d.__goExportRequest === 'string') { triggerFrameExport(d.__goExportRequest); return; }", 'if (false) { return; }') : t, /listener 缺派发分支/],
      ['base mock 的 onExportRequest 退回无参 no-op（登记被吞）', (t, l) => l === 'Index.ets' ? t.replace('onExportRequest: function (fn) { return registerFrameFn(frameExportFns, fn); },', 'onExportRequest: function () { return NOOP; },') : t, /无参 no-op|缺通道实现/],
      ['markdown 菜单少了「导出为 Word…」', (t, l) => l === 'Index.ets' ? t.replace("{ label: '导出为 Word…', msg: { __goExportRequest: 'docx' } },", '') : t, /markdown 菜单动作缺 __goExportRequest: 'docx'/],
      ['triggerFrameExport 不再收窄格式（会让导出 PDF 变死按钮）', (t, l) => l === 'Index.ets' ? t.replace("if (format !== 'docx' && format !== 'docs') { return false; }", '') : t, /triggerFrameExport 未收窄 ExportFormat/],
      ['base mock 的 onMenuCommand 退回无参 no-op', (t, l) => l === 'Index.ets' ? t.replace('onMenuCommand: function (fn) { return registerFrameFn(frameMenuCommandFns, fn); },', 'onMenuCommand: function () { return NOOP; },') : t, /无参 no-op|缺通道实现/],
      ['pdfMock 覆盖 onPrintRequest（静默替换 base）', (t, l) => l === 'Index.ets' ? t.replace('var pdfMock = Object.assign({}, mock, {', 'var pdfMock = Object.assign({}, mock, {\n    onPrintRequest: function (fn) { return NOOP; },') : t, /pdfMock 覆盖了 onPrintRequest/],
      ['旧名残留（半迁移）', (t, l) => l === 'Index.ets' ? t.replace('function postToTab(id, msg) {', 'function triggerPdfSaveAs() {}\n  function postToTab(id, msg) {') : t, /仍残留旧名: triggerPdfSaveAs/],
      ['PDF 渲染层不再登记 onSaveAsRequest', (t, l) => l.endsWith('apps/pdf/src/renderer/App.tsx') ? t.replace('pdfApi.onSaveAsRequest(', 'pdfApi.onSaveAsRequestX(') : t, /apps\/pdf\/src\/renderer\/App\.tsx 缺: pdfApi\.onSaveAsRequest\(/],
      ['slides 不再处理 print 命令', (t, l) => l.endsWith('apps/slides/src/renderer/App.tsx') ? t.replace("cmd === 'print'", "cmd === 'printX'") : t, /apps\/slides\/src\/renderer\/App\.tsx 缺: cmd === 'print'/],
      ['sheets MenuAction 丢掉 save-as', (t, l) => l.endsWith('apps/sheets/src/shared/desktop-api.ts') ? t.replace("'open' | 'save' | 'save-as'", "'open' | 'save'") : t, /desktop-api\.ts 缺: MenuAction 含 'save-as'/],
      ['frame listener 丢了保存派发分支', (t, l) => l === 'Index.ets' ? t.replace("if (typeof d.__goSaveRequest === 'string') { triggerFrameSaveRequest(d.__goSaveRequest); return; }", 'if (false) { return; }') : t, /listener 缺派发分支/],
      ['base mock 的 onSaveRequest 退回无参 no-op（登记被吞）', (t, l) => l === 'Index.ets' ? t.replace('onSaveRequest: function (fn) { return registerFrameFn(frameSaveRequestFns, fn); },', 'onSaveRequest: function () { return NOOP; },') : t, /无参 no-op|缺通道实现/],
      ['markdown 菜单少了「另存为…」', (t, l) => l === 'Index.ets' ? t.replace("{ label: '另存为…', msg: { __goSaveRequest: 'saveAs' } },", '') : t, /markdown 菜单动作缺 __goSaveRequest: 'saveAs'/],
      ['triggerFrameSaveRequest 不再收窄 mode（另存为会静默覆盖原文件）', (t, l) => l === 'Index.ets' ? t.replace("if (mode !== 'save' && mode !== 'saveAs') { return false; }", '') : t, /triggerFrameSaveRequest 未收窄 mode/],
      ['markdown 渲染层不再登记 onSaveRequest', (t, l) => l.endsWith('apps/markdown/src/renderer/App.tsx') ? t.replace('markdownApi.onSaveRequest(', 'markdownApi.onSaveRequestX(') : t, /apps\/markdown\/src\/renderer\/App\.tsx 缺: markdownApi\.onSaveRequest\(/],
    ],
  },
  {
    fn: 'checkMarkdownImageChain',
    cases: [
      ['对照：真实源码必须通过', null, null],
      // 换错读字节通道：功能看起来照常，但 openDocxPathJson 成功时 pushRecent(uri) + 登记 writable
      // → 每读一张插图就往「最近打开」塞一个 .png（用户可见污染，只有门禁能拦）
      ['readImageBytes 改用 openDocxPathJson（图片会污染「最近打开」）', (t, l) => l === 'Index.ets' ? t.replace("return goJson('readLocalImageJson', [uri]).then(function (r) {", "return goJson('openDocxPathJson', [uri]).then(function (r) {") : t, /readImageBytes 用了 openDocxPathJson|Index\.ets 缺: goJson\('readLocalImageJson'/],
      ['去掉「越出文档目录」拒绝（相对路径可读任意文件）', (t, l) => l === 'Index.ets' ? t.replace('if (segs.length <= baseDepth) { return null; }', '') : t, /Index\.ets 缺: if \(segs\.length <= baseDepth\)/],
      ['去掉「.. 逐步回退」的越界拒绝（只留归一化后那道，等于半迁移）', (t, l) => l === 'Index.ets' ? t.replace('if (segs.length - 1 < baseDepth) { return null; }', '') : t, /Index\.ets 缺: if \(segs\.length - 1 < baseDepth\)/],
      ['去掉「绝对路径 / 带 scheme」拒绝', (t, l) => l === 'Index.ets' ? t.replace("if (s.charAt(0) === '/' || /^[a-z][a-z0-9+.-]*:/i.test(s)) { return null; }", '') : t, /Index\.ets 缺: if \(s\.charAt\(0\) === '\/'/],
      ['目录授权改成每张图都弹框（去掉一次性限制）', (t, l) => l === 'Index.ets' ? t.replace('if (!dir || markdownImgGrantDir === dir) { return null; }', 'if (!dir) { return null; }') : t, /Index\.ets 缺: if \(!dir \|\| markdownImgGrantDir === dir\)/],
      ['saveImageAs 失败不再弹可见提示（回到「点了没反应」）', (t, l) => l === 'Index.ets' ? t.replace("showFrameNotice('无法保存图片'", "console.error('无法保存图片'") : t, /Index\.ets 缺: showFrameNotice\('无法保存图片'/],
      ['扩展名白名单被删（svg/webp 也当图片读，桌面只认 png/jpg/jpeg/gif）', (t, l) => l === 'Index.ets' ? t.replace("var MARKDOWN_IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif' };", 'var MARKDOWN_IMAGE_MIME = {};') : t, /Index\.ets 缺: var MARKDOWN_IMAGE_MIME/],
      ['readImage 实现被删（退回 Proxy 静默 undefined → 导出 docx 无图）', (t, l) => l === 'Index.ets' ? t.replace('readImage: function (src) {', 'readImageX: function (src) {') : t, /Index\.ets 缺: readImage: function \(src\)/],
      ['反斜杠常量被改回正则字面量（模板字面量吃一层 → 整段脚本 SyntaxError）', (t, l) => l === 'Index.ets' ? t.replace('var BS = String.fromCharCode(92);', 'var BS = "\\";') : t, /Index\.ets 缺: var BS = String\.fromCharCode\(92\)/],
    ],
  },
  {
    fn: 'checkPdfSignaturePersist',
    cases: [
      ['对照：真实源码必须通过', null, null],
      ['帧侧签名通道名被改（菜单/对话框拿不到表）', (t, l) => l === 'Index.ets' ? t.replace("goJson('listSavedSignaturesJson', [])", "goJson('listSavedSignaturesJsonX', [])") : t, /Index\.ets 缺: goJson\('listSavedSignaturesJson', \[\]\)/],
      ['帧侧退回 localStorage 实现（旧坑复活）', (t, l) => l === 'Index.ets' ? t.replace('  function listSavedSignatures() {', "  var SIGNATURES_KEY = 'genoffice.pdf.savedSignatures';\n  function listSavedSignatures() {") : t, /仍残留 localStorage 签名库实现: SIGNATURES_KEY/],
      ['桥侧少了 add 派发分支（调用静默降级）', (t, l) => l.endsWith('DesktopBridge.ets') ? t.replace("case 'addSavedSignatureJson':", "case 'addSavedSignatureJsonX':") : t, /DesktopBridge\.ets 缺: case 'addSavedSignatureJson':/],
      ['上限被改（不再截断 10 条）', (t, l) => l.endsWith('DesktopBridge.ets') ? t.replace('MAX_SAVED_SIGNATURES: number = 10', 'MAX_SAVED_SIGNATURES: number = 99') : t, /DesktopBridge\.ets 缺: MAX_SAVED_SIGNATURES: number = 10/],
      ['去掉原子写（崩溃可能写坏整表）', (t, l) => l.endsWith('DesktopBridge.ets') ? t.replace('fs.renameSync(tmp, f)', 'fs.accessSync(tmp)') : t, /DesktopBridge\.ets 缺: fs\.renameSync\(tmp, f\)/],
      ['入参不补 id（渲染层 key 冲突/SavedSignature 结构破坏）', (t, l) => l.endsWith('DesktopBridge.ets') ? t.replace('util.generateRandomUUID(true)', "''") : t, /DesktopBridge\.ets 缺: util\.generateRandomUUID\(true\)/],
      ['渲染层不再把 SignatureData 传进来', (t, l) => l.endsWith('apps/pdf/src/renderer/SignatureDialog.tsx') ? t.replace('addSavedSignature(sig)', 'addSavedSignatureX(sig)') : t, /SignatureDialog\.tsx 缺: addSavedSignature\(sig\)/],
      ['渲染层读取字段与桥返回结构不一致', (t, l) => l.endsWith('apps/pdf/src/renderer/SignatureDialog.tsx') ? t.replace('s.data.kind', 's.kind') : t, /SignatureDialog\.tsx 缺: s\.data\.kind/],
    ],
  },
  {
    fn: 'checkSheetsFileTab',
    cases: [
      ['对照：真实源码必须通过', null, null],
      [
        '另存为图标退回裸 svg（真机：比其他图标偏大）',
        (t, l) =>
          l.endsWith('apps/sheets/src/renderer/ExcelShell.tsx')
            ? t.replace(
                'className="tool-icon-row">\n              <span className="tool-symbol" aria-hidden="true">\n                <SaveAsIcon />\n              </span>',
                'className="tool-icon-row">\n              <SaveAsIcon />',
              )
            : t,
        /SaveAsIcon 未包在 \.tool-symbol 内/,
      ],
      [
        '新增大图标未包 .tool-symbol（守卫须覆盖新增按钮）',
        (t, l) =>
          l.endsWith('apps/sheets/src/renderer/ExcelShell.tsx')
            ? t.replace('<ToolSymbol symbol="Σ" />', '<SigmaIcon />')
            : t,
        /裸图标组件/,
      ],
      [
        '大按钮图标尺寸基准（28px 规则）被删',
        (t, l) =>
          l.endsWith('apps/sheets/src/renderer/styles.css')
            ? t.replace(
                '.ribbon-tool.large .tool-symbol svg {\n  width: 28px;',
                '.ribbon-tool.large .tool-symbol svg {\n  width: 20px;',
              )
            : t,
        /图标尺寸基准被删/,
      ],
    ],
  },
{
    fn: 'checkAiImageSearchChain',
    cases: [
      ['对照：真实源码必须通过', null, null],
      ['帧侧网搜通道名被改（AI 面板网搜必崩）',
        (t, l) => l === 'Index.ets' ? t.replace("goJson('webSearchJson'", "goJson('webSearchJsonX'") : t,
        /Index\.ets 缺: goJson\('webSearchJson'/],
      ['帧侧图搜退回裸数组形状（r.images.map 当场 TypeError）',
        (t, l) => l === 'Index.ets' ? t.replace('var mock = {', "var mock = {\n    imageSearch: function () { return Promise.resolve([]); },") : t,
        /仍是坏形状/],
      ['桥不可用不再返回 method:error（空结果被当成"没有搜到"）',
        (t, l) => l === 'Index.ets' ? t.replace("{ results: [], method: 'error', error: 'harmony: web search bridge unavailable' }", '{ results: [] }') : t,
        /缺错误兜底形状/],
      ['readLocalImage 失败不再 reject（渲染层拿不到错误提示）',
        (t, l) => l === 'Index.ets' ? t.replace('return Promise.reject(new Error((r && r.error)', 'return Promise.resolve(new Error((r && r.error)') : t,
        /未把 \{error\} 转成 Promise\.reject/],
      ['生图挂载键名被改（sheets 的 generate_image 工具拿 Proxy 兜底的 undefined）',
        (t, l) => l === 'Index.ets' ? t.replace('generateImage: aiGenerateImage,', 'generateImageX: aiGenerateImage,') : t,
        /缺生图\/理解实现: generateImage: aiGenerateImage/],
      ['aiGskStatus 谎报已登录（generate_image 工具暴露但无实现）',
        (t, l) => l === 'Index.ets' ? t.replace('aiGskStatus: function () { return Promise.resolve({ loggedIn: false }); }', 'aiGskStatus: function () { return Promise.resolve({ loggedIn: true }); }') : t,
        /aiGskStatus 不再是 \{ loggedIn: false \}/],
      ['SSRF 守卫不再拦私网段（16 进制/内网地址可探测）',
        (t, l) => l.endsWith('DesktopBridge.ets') ? t.replace("|| host.startsWith('192.168.')", '|| false') : t,
        /isPublicHttpTarget 缺拦截规则: '192\.168\.'/],
      ['fetchImage 不再校验目标 URL（SSRF 直通）',
        (t, l) => l.endsWith('DesktopBridge.ets') ? t.replace('if (!isPublicHttpTarget(target)) {', 'if (false) {') : t,
        /fetchImageJson 缺: if \(!isPublicHttpTarget\(target\)\)/],
      ['fetchImage 退回文本响应（拿到字符串 → base64 为空）',
        (t, l) => l.endsWith('DesktopBridge.ets') ? t.replace('expectDataType: http.HttpDataType.ARRAY_BUFFER,', 'expectDataType: http.HttpDataType.STRING,') : t,
        /DesktopBridge\.ets 缺: expectDataType: http\.HttpDataType\.ARRAY_BUFFER/],
      ['mime 回落被删（webp/svg 会被当 jpeg 塞进文档）',
        (t, l) => l.endsWith('DesktopBridge.ets') ? t.replace("mime: sniffed.length > 0 ? sniffed : 'image/jpeg'", "mime: 'image/jpeg'") : t,
        /fetchImageJson 缺: mime: sniffed/],
      ['网搜端点被改错（Serper 打不通 = 网搜永远失败）',
        (t, l) => l.endsWith('DesktopBridge.ets') ? t.replace("'https://google.serper.dev/search'", "'https://google.serper.dev/searchx'") : t,
        /缺: 'https:\/\/google\.serper\.dev\/search'/],
      ['Tavily 端点被改错（选了 Tavily 也搜不到）',
        (t, l) => l.endsWith('DesktopBridge.ets') ? t.replace("'https://api.tavily.com/search'", "'https://api.tavily.com/searchx'") : t,
        /缺: 'https:\/\/api\.tavily\.com\/search'/],
      ['图搜解析函数被改名（版权域名黑名单随它一起失效）',
        (t, l) => l.endsWith('DesktopBridge.ets') ? t.replace('function parseSerperImageResults(', 'function parseSerperImageResultsX(') : t,
        /找不到 parseSerperImageResults|parseSerperImageResults 缺版权黑名单/],
      ['Tavily 也放过去打图搜（它没有图片端点 → 表现为一直失败）',
        (t, l) => l.endsWith('DesktopBridge.ets') ? t.replace("if (opts.provider !== 'serper') {", 'if (false) {') : t,
        /缺: opts\.provider !== 'serper'/],
      ['未配 Key 时退回空结果（用户以为"没有搜索结果"而不是"没配 Key"）',
        (t, l) => l.endsWith('DesktopBridge.ets') ? t.replace('this.searchKeyMissing(', 'this.searchKeyMissingX(') : t,
        /searchKeyMissing 只被调用|缺: searchKeyMissing/],
      ['本地图片不再做魔术字节嗅探（svg 会被当图片读）',
        (t, l) => l.endsWith('DesktopBridge.ets') ? t.replace('function sniffImageMediaType(', 'function sniffImageMediaTypeX(') : t,
        /DesktopBridge\.ets 缺: function sniffImageMediaType\(/],
      ['本地图片 20MB 上限被删（大图读爆主线程）',
        (t, l) => l.endsWith('DesktopBridge.ets') ? t.replace('const MAX_AI_IMAGE_BYTES: number = 20 * 1024 * 1024', 'const MAX_AI_IMAGE_BYTES: number = 512 * 1024 * 1024') : t,
        /DesktopBridge\.ets 缺: const MAX_AI_IMAGE_BYTES: number = 20 \* 1024 \* 1024/],
      ['sheets 契约漂移：imageSearch 返回类型被改',
        (t, l) => l.endsWith('apps/sheets/src/shared/desktop-api.ts') ? t.replace('imageSearch(query: string, maxResults?: number): Promise<ImageSearchResponse>', 'imageSearch(query: string, maxResults?: number): Promise<unknown>') : t,
        /desktop-api\.ts 契约漂移: imageSearch/],
      ['sheets 本地图片消费点漂移（AI add_image 本地分支失联）',
        (t, l) => l.endsWith('apps/sheets/src/renderer/op-executor.ts') ? t.replace('window.desktopApi.readLocalImage({ path: op.path })', 'window.desktopApi.readLocalImageX({ path: op.path })') : t,
        /op-executor\.ts 消费点漂移/],
      ['sheets 图搜不再处理 method:error（后端失败被当成"没有图"）',
        (t, l) => l.endsWith('apps/sheets/src/renderer/ai/image-skill.ts') ? t.replace("if (result.method === 'error')", 'if (false)') : t,
        /image-skill\.ts 消费点漂移/],
      ['pdf fetchImage 契约漂移（width/height 丢失 → 插入尺寸 NaN）',
        (t, l) => l.endsWith('apps/pdf/src/renderer/ai/tools.ts') ? t.replace('fetchImage(url: string): Promise<{ png: string; width: number; height: number } | null>', 'fetchImage(url: string): Promise<{ png: string } | null>') : t,
        /pdf tools\.ts 消费点漂移/],
      ['markdown 桥名漂移（markdownApi.webSearch 落空 → Proxy 兜底）',
        (t, l) => l.endsWith('apps/markdown/src/preload/index.ts') ? t.replace('webSearch: (query, maxResults)', 'webSearchX: (query, maxResults)') : t,
        /markdown preload 桥名漂移/],
    ],
  },
  {
    fn: 'checkSheetsRecoveryPrompt',
    cases: [
      ['对照：真实源码必须通过', null, null],
      ['writeWorkbookRecovery 退回 {ok:true} 桩（恢复副本从不产生 → 强杀丢编辑）',
        (t, l) => l === 'Index.ets' ? t.replace('writeWorkbookRecovery: function (request) {', 'writeWorkbookRecovery: function () { return Promise.resolve({ ok: true }); },\n    writeWorkbookRecoveryX: function (request) {') : t,
        /writeWorkbookRecovery 仍是 \{ok:true\} 桩/],
      ['恢复副本不再走桥（通道名被改）',
        (t, l) => l === 'Index.ets' ? t.replace("goJson('xlsRecoveryWriteJson'", "goJson('xlsRecoveryWriteJsonX'") : t,
        /Index\.ets 缺: goJson\('xlsRecoveryWriteJson'/],
      ['保存与恢复副本不再共用归一化（两条路各自漂移）',
        (t, l) => l === 'Index.ets' ? t.replace('var built = buildSheetsSavePayload(request);', 'var built = buildSheetsSavePayloadX(request);') : t,
        /buildSheetsSavePayload 调用点应为 3 处/],
      ['replyRecoveryPrompt 退回无参（提问永远挂起）',
        (t, l) => l === 'Index.ets' ? t.replace('replyRecoveryPrompt: function (restore) {', 'replyRecoveryPrompt: function () {') : t,
        /Index\.ets 缺: replyRecoveryPrompt: function \(restore\) \{/],
      ['回答不再区分 restore/discard（点"恢复"也当放弃）',
        (t, l) => l === 'Index.ets' ? t.replace("settleRecoveryPrompt(restore === true ? 'restore' : 'discard');", "settleRecoveryPrompt('dismissed');") : t,
        /Index\.ets 缺: settleRecoveryPrompt\(restore === true/],
      ['selectWorkbook 绕过恢复提问',
        (t, l) => l === 'Index.ets' ? t.replace('return openSheetWithRecovery(p);', 'return goJson(\'xlsOpenJson\', [p]).then(function (r) { return r || null; });') : t,
        /未走 openSheetWithRecovery/],
      ['无渲染层订阅时不再立即 dismissed（打开被挂住）',
        (t, l) => l === 'Index.ets' ? t.replace('if (frameRecoveryPromptFns.length === 0 || !isRecoveryPromptPayload(prompt)) {', 'if (false) {') : t,
        /未在"无订阅\/载荷非法"时立即 dismissed/],
      ['payload 7 字段校验被删（RecoveryDialog 渲染 undefined）',
        (t, l) => l === 'Index.ets' ? t.replace('function isRecoveryPromptPayload(p) {', 'function isRecoveryPromptPayloadX(p) {') : t,
        /缺 payload 校验/],
      ['桥侧少了恢复副本落盘分支（派发名漂移）',
        (t, l) => l.endsWith('DesktopBridge.ets') ? t.replace("case 'xlsRecoveryWriteJson':", "case 'xlsRecoveryWriteJsonX':") : t,
        /DesktopBridge\.ets 缺: case 'xlsRecoveryWriteJson':/],
      ['恢复副本目录被改（写不到固定位置，旧副本永远找不到）',
        (t, l) => l.endsWith('DesktopBridge.ets') ? t.replace("this.ctx.filesDir + '/genoffice-sheets-recovery'", "this.ctx.filesDir + '/sheets-recovery-x'") : t,
        /DesktopBridge\.ets 缺: this\.ctx\.filesDir \+ '\/genoffice-sheets-recovery'/],
      ['提问不再早于读字节（大文件白读一遍）',
        (t, l) => l.endsWith('DesktopBridge.ets') ? t.replace('const pending: string = this.pendingSheetsRecovery(uri);', 'const pending: string = \'\';') : t,
        /DesktopBridge\.ets 缺: const pending: string = this\.pendingSheetsRecovery\(uri\);/],
      ['恢复会话不再 stand down（会写坏 sidecar 正在流的源文件）',
        (t, l) => l.endsWith('DesktopBridge.ets') ? t.replace('this.sheetsRestoreTargets.has(sessionId)', 'false') : t,
        /未对恢复会话 stand down/],
      ['恢复到恢复副本时不记原文件戳（磁盘守卫失效）',
        (t, l) => l.endsWith('DesktopBridge.ets') ? t.replace('this.sheetsRestoreStamps.set(sid, restoreStamp);', 'this.sheetsRestoreStampsX(sid, restoreStamp);') : t,
        /缺守卫\/清理: this\.sheetsRestoreStamps\.set\(sid, restoreStamp\);/],
      ['恢复会话原文件守卫被删（会覆盖别处改动）',
        (t, l) => l.endsWith('DesktopBridge.ets') ? t.replace("'工作簿在打开后被磁盘上的改动覆盖——请改用另存为。'", "'保存失败'") : t,
        /缺守卫\/清理/],
      ['保存成功后不清恢复副本（每次打开都问"要恢复吗"）',
        (t, l) => l.endsWith('DesktopBridge.ets') ? t.replace('this.clearSheetsRecovery(uri);\n      this.sheetsRestoreTargets.delete(sessionId);', 'this.sheetsRestoreTargets.delete(sessionId);') : t,
        /未清恢复副本/],
      ['恢复副本落盘不再释放临时快照会话（每 30s 泄漏一个引擎会话）',
        (t, l) => l.endsWith('DesktopBridge.ets') ? t.replace('this.xlsxSidecar.close(newSessionId)', 'this.xlsxSidecar.closeX(newSessionId)') : t,
        /未释放临时快照会话/],
      ['渲染层不再登记 onRecoveryPrompt（提问无处可去）',
        (t, l) => l.endsWith('apps/sheets/src/renderer/App.tsx') ? t.replace('onRecoveryPrompt?.(', 'onRecoveryPromptX?.(') : t,
        /App\.tsx 消费点漂移/],
      ['渲染层不再回答提问（回复通道断）',
        (t, l) => l.endsWith('apps/sheets/src/renderer/App.tsx') ? t.replace('window.desktopApi?.replyRecoveryPrompt?.(restore)', 'noop(restore)') : t,
        /App\.tsx 消费点漂移/],
      ['preload 不再校验 payload 字段（坏载荷直冲渲染层）',
        (t, l) => l.endsWith('apps/sheets/src/preload/index.ts') ? t.replace("typeof payload.savedAtMs === 'number'", "typeof payload.savedAtMs === 'string'") : t,
        /preload 契约漂移/],
      ['桌面语义锚点漂移：dismissed 不再收口（提问悬挂）',
        (t, l) => l.endsWith('apps/sheets/src/main/sheets-main.ts') ? t.replace("settle('dismissed')", "settle('dismissedX')") : t,
        /sheets-main\.ts 恢复链漂移/],
    ],
  },
  {
    fn: 'checkReleaseMetadata',
    cases: [
      ['对照：真实源码必须通过', null, null],
      ['app.json5 版本号被改（app 内显示与市场不一致）',
        (t, l) => l.endsWith('AppScope/app.json5') ? t.replace('"versionName": "0.1.0"', '"versionName": "0.9.9"') : t,
        /版本号不一致: app\.json5=0\.9\.9 vs APP_VERSION=0\.1\.0/],
      ['桥侧 APP_VERSION 被改',
        (t, l) => l.endsWith('DesktopBridge.ets') ? t.replace("export const APP_VERSION: string = '0.1.0'", "export const APP_VERSION: string = '0.0.1'") : t,
        /版本号不一致: app\.json5=0\.1\.0 vs APP_VERSION=0\.0\.1/],
      ['壳侧 SHELL_APP_VERSION 被改（设置页版本错）',
        (t, l) => l === 'Index.ets' ? t.replace("var SHELL_APP_VERSION = '0.1.0'", "var SHELL_APP_VERSION = '1.0.0'") : t,
        /版本号不一致: app\.json5=0\.1\.0 vs SHELL_APP_VERSION=1\.0\.0/],
      ['versionCode 归零（市场直接拒）',
        (t, l) => l.endsWith('AppScope/app.json5') ? t.replace('"versionCode": 1', '"versionCode": 0') : t,
        /缺 versionCode（或 < 1，市场会拒）/],
      ['getAppVersion 不再读 SHELL_APP_VERSION',
        (t, l) => l === 'Index.ets' ? t.replace('getAppVersion: function () { return Promise.resolve(SHELL_APP_VERSION); }', "getAppVersion: function () { return Promise.resolve('9.9.9'); }") : t,
        /getAppVersion 未用 SHELL_APP_VERSION/],
      ['旧版本字面量复活（桥侧 0.1.0-m3）',
        (t, l) => l.endsWith('DesktopBridge.ets') ? t.replace('export const APP_VERSION', "const LEGACY_VERSION: string = '0.1.0-m3';\nexport const APP_VERSION") : t,
        /残留旧版本字面量 '0\.1\.0-m3'/],
      ['图标退回 DevEco 占位图（258B → 桌面/市场空白图）',
        (t, l) => {
          if (!l.endsWith('base/media/app_icon.png')) return t
          const buf = Buffer.alloc(258) // 合法 PNG 头 + 96x96，尺寸/字节数都退回模板占位图
          Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(buf, 0)
          buf.writeUInt32BE(96, 16); buf.writeUInt32BE(96, 20)
          return buf
        },
        /还是 DevEco 占位图/],
      ['图标尺寸过小（96x96）',
        (t, l) => {
          if (!l.endsWith('base/media/app_icon.png')) return t
          const buf = Buffer.alloc(4096)
          Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(buf, 0)
          buf.writeUInt32BE(96, 16); buf.writeUInt32BE(96, 20)
          return buf
        },
        /尺寸过小（96x96/],
      ['start_icon 缺失（启动图空白）',
        (t, l) => l.endsWith('base/media/start_icon.png') ? Buffer.alloc(4) : t,
        /start_icon\.png 不是 PNG/],
      ['应用名被改（市场显示名）',
        (t, l) => l.endsWith('AppScope/resources/base/element/string.json') ? t.replace('"value": "GenOffice"', '"value": "GenOfficeX"') : t,
        /缺 app_name=GenOffice/],
      ['module.json5 丢 startWindowIcon 引用',
        (t, l) => l.endsWith('module.json5') ? t.replace('"startWindowIcon": "$media:start_icon"', '"startWindowIconX": "$media:start_icon"') : t,
        /module\.json5 缺 "startWindowIcon"/],
      ['权限理由字符串被删（审核打回）',
        (t, l) => l.endsWith('entry/src/main/resources/base/element/string.json') ? t.replace('"name": "read_pasteboard_reason"', '"name": "pb_reason"') : t,
        /权限理由字符串缺 read_pasteboard_reason/],
    ],
  },
  {
    fn: 'checkShellMenuHandlers',
    cases: [
      ['对照：真实源码必须通过', null, null],
      ['菜单项引用的函数根本没实现（点击抛 ReferenceError）',
        (t, l) => l === 'Index.ets' ? t.replace('function dialogFeedback() {', 'function dialogFeedbackX() {') : t,
        /调用了未定义函数 dialogFeedback\(\)/],
      ['新增菜单项引用了不存在的函数',
        (t, l) => l === 'Index.ets' ? t.replace("{ label: '关于 / 反馈',", "{ label: '导出全部', onClick: function () { exportAllDocs(); } },\n      { label: '关于 / 反馈',") : t,
        /调用了未定义函数 exportAllDocs\(\)/],
      ['反馈入口标签退回旧名（找不到版本信息）',
        (t, l) => l === 'Index.ets' ? t.replace("{ label: '关于 / 反馈', onClick: function () { dialogFeedback(); } }", "{ label: '反馈 / 报告 Bug', onClick: function () { dialogFeedback(); } }") : t,
        /缺「关于 \/ 反馈」项/],
      ['诊断信息丢版本号（反馈无法定位 build）',
        (t, l) => l === 'Index.ets' ? t.replace("'GenOffice 版本: ' + SHELL_APP_VERSION", "'GenOffice 版本: ?'") : t,
        /反馈对话框缺: 'GenOffice 版本: ' \+ SHELL_APP_VERSION/],
      ['诊断信息丢平台',
        (t, l) => l === 'Index.ets' ? t.replace("'平台: HarmonyOS (ArkWeb 壳)'", "'平台: ?'") : t,
        /反馈对话框缺: '平台: HarmonyOS/],
      ['丢内测反馈路径（测试者不知道去哪报）',
        (t, l) => l === 'Index.ets' ? t.replace('内测应用', '内测X') : t,
        /反馈对话框缺: 内测应用/],
      ['丢日志抓取命令（缺陷无法复现）',
        (t, l) => l === 'Index.ets' ? t.replace('hdc hilog', 'hilog') : t,
        /反馈对话框缺: hdc hilog/],
      ['剪贴板兜底被删（原生剪贴板不可用时复制不了）',
        (t, l) => l === 'Index.ets' ? t.replace('if (nb && typeof nb.writeClipboardText === \'function\') { nb.writeClipboardText(t); }', '') : t,
        /反馈对话框缺: nb\.writeClipboardText\(t\)/],
      ['复制按钮没了',
        (t, l) => l === 'Index.ets' ? t.replace("var copy = mkBtn('复制', true);", '') : t,
        /反馈对话框缺: var copy = mkBtn\('复制'/],
      ['诊断文本函数被删（对话框引用悬空）',
        (t, l) => l === 'Index.ets' ? t.replace('function shellDiagnosticText() {', 'function shellDiagnosticTextX() {') : t,
        /反馈对话框缺: function shellDiagnosticText\(\)/],
      // 「开源许可」的判定挂在**函数体内**（dialogLegal 与 dialogFeedback 各有一份复制兜底，
      // 全文 includes 会让「只删一份」逃过门禁 —— 反例实测抓到过同类问题）
      ['许可对话框改成硬编码文本（与包内文件漂移）',
        (t, l) => l === 'Index.ets' ? t.replace("legalLoad('NOTICE.txt')", "Promise.resolve('占位文本')") : t,
        /dialogLegal 未通过 legalLoad 读取/],
      ['许可对话框不再引 NOTICE/第三方清单',
        (t, l) => l === 'Index.ets' ? t.replace("function legalLoad(name) {", "function legalLoadUnused(name) {") : t,
        /找不到 function legalLoad\(name\)|dialogLegal 未通过 legalLoad/],
    ],
  },
  {
    fn: 'checkArktsSemantics',
    cases: [
      ['对照：真实源码必须通过', null, null],
      ['恢复提问退回嵌套字面量（DevEco 报 arkts-no-untyped-obj-literals，整包构建失败）',
        (t, l) => l.endsWith('DesktopBridge.ets')
          ? t.replace('const prompt: Record<string, Object> = {', 'const probe = {\n        meta: {')
          : t,
        /无类型嵌套对象字面量/],
      ['无类型声明直接吃字面量（const x = { ... }）',
        (t, l) => l.endsWith('DesktopBridge.ets')
          ? t.replace('const prompt: Record<string, Object> = {', 'const prompt = {')
          : t,
        /无类型声明直接吃字面量/],
      ['出现 any 标注（arkts-no-any-unknown）',
        (t, l) => l.endsWith('DesktopBridge.ets')
          ? t.replace('let savedAtMs: number = Date.now();', 'let savedAtMs: any = Date.now();')
          : t,
        /出现 any\/unknown 类型/],
      ['模板起点失效（注入 JS 被当成 ArkTS 扫：遮蔽逻辑不能失效）',
        (t, l) => l === 'Index.ets' ? t.replace('const PROMISE_SHIM = `', 'const PROMISE_SHIM = `x`') : t,
        /无类型声明直接吃字面量/],
      ['源码读空（扫描行数守卫：门禁不能假绿）',
        (t, l) => l.endsWith('.ets') ? '' : t,
        /未找到 \.ets 源文件|扫描到的 ArkTS 行数仅/],
      // 批次 E-2 真机炸在 DevEco：@Concurrent 函数里复用了同文件的模块级函数，
      // es2abc 报「Concurrent function should only use import variable or local variable」
      // → 整包 CompileArkTS 失败，本地四连门禁当时全绿。这条反例锁住整类问题。
      ['并发函数引用本文件的模块级函数（es2abc 拒绝，白吃一轮构建）',
        (t, l) => l.endsWith('DesktopBridge.ets')
          ? t.replace('function readUriOnMainThread(',
              '@Concurrent\nfunction gateProbeConcurrent(u: string): string { return readFailText(u); }\nfunction readUriOnMainThread(')
          : t,
        /@Concurrent gateProbeConcurrent\(\) 调用了本文件的模块级函数 readFailText/],
      ['@Concurrent 结构变了导致扫不到（断言会假绿）',
        (t, l) => l.endsWith('DesktopBridge.ets') ? t.replaceAll('@Concurrent', '@NotConcurrent') : t,
        /未扫到任何 @Concurrent 函数/],
    ],
  },
  {
    fn: 'checkBundleNameAlignment',
    cases: [
      ['对照：真实源码必须通过', null, null],
      ['bundleName 退回旧值（与 AGC 应用不一致 → 签名被拒）',
        (t, l) => l.endsWith('AppScope/app.json5') ? t.replace('"bundleName": "com.genoffice.app"', '"bundleName": "com.bolanmoda.genoffice"') : t,
        /退回旧值 com\.bolanmoda\.genoffice/],
      ['发布 Profile 的 bundle-name 漂移（签名必失败）',
        (t, l) => l.endsWith('GenOfficeRelease.p7b')
          ? Buffer.from(t.toString('latin1').replace('"bundle-name":"com.genoffice.app"', '"bundle-name":"com.other.app"'), 'latin1')
          : t,
        /包名不一致：app\.json5=com\.genoffice\.app vs 发布 Profile=com\.other\.app/],
      ['发布材料被截断/清空（无法打 release 包）',
        (t, l) => l.endsWith('GenOffice.p12') ? Buffer.alloc(0) : t,
        /发布材料 key_csr\/GenOffice\.p12（密钥库（含私钥））内容为空\/被截断/],
      ['发布 Profile 实际是调试 Profile（市场拒收）',
        (t, l) => l.endsWith('GenOfficeRelease.p7b')
          ? Buffer.from(t.toString('latin1').replace('"type":"release"', '"type":"debug"'), 'latin1')
          : t,
        /是调试 Profile（type:debug）/],
    ],
  },
  {
    fn: 'checkReleaseDebuggingSwitch',
    cases: [
      ['对照：真实源码必须通过', null, null],
      ['调试开关写死常开（release 包也开 DevTools 口）',
        (t, l) => l === 'Index.ets'
          ? t.replace('webview.WebviewController.setWebDebuggingAccess(arkWebDebugAccess);', 'webview.WebviewController.setWebDebuggingAccess(true);')
          : t,
        /开关不得写死，须由 ApplicationInfo\.debug 派生/],
      ['开关退回常量 false（开发期连不上 DevTools）',
        (t, l) => l === 'Index.ets'
          ? t.replace('webview.WebviewController.setWebDebuggingAccess(arkWebDebugAccess);', 'webview.WebviewController.setWebDebuggingAccess(false);')
          : t,
        /开关不得写死，须由 ApplicationInfo\.debug 派生/],
      ['判据不再取 ApplicationInfo.debug（无法随构建类型收敛）',
        (t, l) => l === 'Index.ets' ? t.replace('arkWebDebugAccess = hostCtx.applicationInfo.debug;', 'arkWebDebugAccess = true;') : t,
        /未见 applicationInfo\.debug/],
      ['开关调用被整段删掉（防误删守卫假绿）',
        (t, l) => l === 'Index.ets' ? t.replace('webview.WebviewController.setWebDebuggingAccess(arkWebDebugAccess);', '') : t,
        /未找到 setWebDebuggingAccess\(\.\.\.\) 调用/],
      ['源码读空（扫描守卫：门禁不能假绿）',
        (t, l) => l.endsWith('.ets') ? '' : t,
        /未找到 \.ets 源文件|未找到 setWebDebuggingAccess/],
    ],
  },
  {
    fn: 'checkSigningConfigHygiene',
    cases: [
      ['对照：真实源码必须通过', null, null],
      ['口令字段被手填明文（hvigor 00303116，构建在 SignHap 失败）',
        (t, l) => l.endsWith('build-profile.json5')
          ? setSigningConfigs(t, '{ "name": "default", "material": { "storePassword": "password123", "keyPassword": "password123" } }')
          : t,
        /storePassword 不是 DevEco 密文（长度 11）/],
      ['口令字段退回 DevEco 加密串之外的短串（长度 ≥32 但非 hex）',
        (t, l) => l.endsWith('build-profile.json5')
          ? setSigningConfigs(t, '{ "name": "default", "material": { "storePassword": "my-keystore-password-padded-to-32ch", "keyPassword": "" } }')
          : t,
        /storePassword 不是 DevEco 密文/],
      // 切到 DevEco 自动签名 = 本地装机验证的合法工作态（发布 Profile 无 device-ids，
      // bm install 必报 9568322 not trusted app source）→ 门禁不得报红，只在 Notes 里提醒还原
      ['切到 DevEco 自动签名（完整调试材料）＝合法本地装机态，不得报红',
        (t, l) => l.endsWith('build-profile.json5')
          ? setSigningConfigs(t, '{ "name": "default", "type": "HarmonyOS", "material": { "storePassword": "00000020AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "keyPassword": "00000020AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "certpath": "/home/user/ohos/config/default_GenOffice.cer", "keyAlias": "debugKey", "profile": "/home/user/ohos/config/default_GenOffice.p7b", "storeFile": "/home/user/ohos/config/default_GenOffice.p12" } }')
          : t,
        null],
      ['只留 debugKey 别名（其余材料字段空）也按调试态放行',
        (t, l) => l.endsWith('build-profile.json5')
          ? setSigningConfigs(t, '{ "name": "default", "material": { "keyAlias": "debugKey" } }')
          : t,
        null],
      ['发布态 keyAlias 与密钥库内真实别名不一致（SignHap 报 -115，报错文本却指口令）',
        (t, l) => l.endsWith('build-profile.json5')
          ? setSigningConfigs(t, '{ "name": "default", "material": { "storeFile": "/x/key_csr/GenOffice.p12", "keyAlias": "genoffice_old" } }')
          : t,
        /keyAlias 应为 genoffice/],
      ['发布材料与调试材料混进同一套配置（DevEco 回写串味 → 包类型不可预期）',
        (t, l) => l.endsWith('build-profile.json5')
          ? setSigningConfigs(t, '{ "name": "default", "material": { "storeFile": "/x/key_csr/GenOffice.p12", "profile": "/home/user/ohos/config/default_GenOffice.p7b", "keyAlias": "genoffice" } }')
          : t,
        /混用发布材料与调试材料/],
      ['签名材料半改状态（既不是发布三件套也不是自动签名目录）',
        (t, l) => l.endsWith('build-profile.json5')
          ? setSigningConfigs(t, '{ "name": "default", "material": { "storeFile": "/somewhere/else.p12", "profile": "/somewhere/else.p7b", "keyAlias": "whatever" } }')
          : t,
        /半改状态/],
      ['signingConfigs 字段被整段删掉（门禁不能假绿）',
        (t, l) => l.endsWith('build-profile.json5') ? dropSigningConfigs(t) : t,
        /缺 signingConfigs 字段/],
      ['文件读不到（必须报错而不是静默通过）',
        (t, l) => l.endsWith('build-profile.json5') ? (() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) })() : t,
        /ENOENT|读不到 build-profile\.json5/],
    ],
  },
  {
    fn: 'checkAssetExternalization',
    cases: [
      ['对照：真实源码必须通过', null, null],
      // 源常量漂移 = 外链脚本 404 = 整个 app 白屏（不是降级，是全挂）
      ['ASSET_ORIGIN 两侧漂移（外链脚本 404 → 白屏）', (t, l) => l.endsWith('inline-renderer.mjs') ? t.replace("const ASSET_ORIGIN = 'https://goasset.local/'", "const ASSET_ORIGIN = 'https://goasset2.local/'") : t, /ASSET_ORIGIN 两边不一致/],
      ['Index.ets 侧的 ASSET_ORIGIN 被改', (t, l) => l === 'Index.ets' ? t.replace("const ASSET_ORIGIN: string = 'https://goasset.local/';", "const ASSET_ORIGIN: string = 'https://goasset3.local/';") : t, /ASSET_ORIGIN 两边不一致/],
      ['外链白名单塞进 slides（依赖 __goChunks，懒加载必失败）', (t, l) => l.endsWith('sync-web.sh') ? t.replace('EXTERNAL_APPS="${GO_EXTERNAL_APPS:-sheets}"', 'EXTERNAL_APPS="${GO_EXTERNAL_APPS:-sheets slides}"') : t, /EXTERNAL_APPS 含 slides/],
      ['外链白名单塞进 pdf（nowasm fallback 靠注册表）', (t, l) => l.endsWith('sync-web.sh') ? t.replace('EXTERNAL_APPS="${GO_EXTERNAL_APPS:-sheets}"', 'EXTERNAL_APPS="${GO_EXTERNAL_APPS:-pdf}"') : t, /EXTERNAL_APPS 含 pdf/],
      ['构建脚本的 __goChunks 硬守卫被删', (t, l) => l.endsWith('inline-renderer.mjs') ? t.replaceAll('CHUNK_REGISTRY_DEPS', 'CHUNK_DEPS_GONE') : t, /缺 __goChunks 依赖守卫/],
      ['sync-web.sh 不再按白名单分流（开关成摆设）', (t, l) => l.endsWith('sync-web.sh') ? t.replace('if is_external "$APP"; then', 'if false; then') : t, /未按 EXTERNAL_APPS 分流/],
      ['sheets 产物退回内联（白名单说外链、产物是内联 = 没重跑 sync）', (t, l) => l.endsWith('rawfile/web/sheets/index.html') ? t.replace('<script type="module" crossorigin src="https://goasset.local/web/sheets/assets/', '<script type="module" crossorigin src="./assets/') : t, /产物形态与 EXTERNAL_APPS 不符/],
      ['外链产物 CSP 未放行 goasset（脚本被 CSP 拦 → 白屏）', (t, l) => l.endsWith('rawfile/web/sheets/index.html') ? t.replace("script-src 'self' https://goasset.local", "script-src 'self'") : t, /CSP script-src 未放行/],
      ['外链产物里残留 __goChunks（混合态）', (t, l) => l.endsWith('rawfile/web/sheets/index.html') ? t.replace('<title>GenOffice Sheets</title>', '<title>GenOffice Sheets</title><script>window.__goChunks={};</script>') : t, /仍有 __goChunks 注册表/],
    ],
  },
  {
    fn: 'checkMdAssetImageShim',
    cases: [
      ['对照：真实源码必须通过', null, null],
      ['md-asset 桥只定义不调用（等于没接）', (t, l) => l === 'Index.ets' ? t.replace('\n  installMdAssetImages();', '\n  // installMdAssetImages();') : t, /缺:\s*\n?\s*installMdAssetImages\(\);/],
      ['observer 装到所有 frame（去掉 markdown 限定 → 纯开销）', (t, l) => l === 'Index.ets' ? t.replace("if (href.indexOf('/web/markdown/') < 0) { return; }", '') : t, /缺: href\.indexOf\('\/web\/markdown\/'\)/],
      ['observer 不再限定 src 属性（编辑器重渲染时全量回调）', (t, l) => l === 'Index.ets' ? t.replace("attributeFilter: ['src']", "attributeFilter: ['src', 'class', 'style']") : t, /缺: attributeFilter: \['src'\]/],
      ['替换 src 前不校验是否被改过（会覆盖渲染层刚设的新图）', (t, l) => l === 'Index.ets' ? t.replace("if ((img.getAttribute('src') || '') === raw) { img.src = url; }", 'img.src = url;') : t, /未校验 src 未被改动/],
      ['并发去重被删（一次渲染触发 N 次桥调用 + N 次目录授权框）', (t, l) => l === 'Index.ets' ? t.replace('if (mdAssetInFlight[raw]) { return; }', '') : t, /缺: if \(mdAssetInFlight\[raw\]\) \{ return; \}/],
      ['blob 缓存被删（同一张图反复读字节）', (t, l) => l === 'Index.ets' ? t.replace('if (mdAssetBlobUrls[raw]) { img.src = mdAssetBlobUrls[raw]; return; }', '') : t, /缺: if \(mdAssetBlobUrls\[raw\]\)/],
      ['md-asset → URI 解析函数被删', (t, l) => l === 'Index.ets' ? t.replace('function mdAssetToUri(s) {', 'function mdAssetToUriX(s) {') : t, /缺: function mdAssetToUri\(s\) \{/],
    ],
  },
  {
    fn: 'checkBridgeRegistryFresh',
    cases: [
      ['对照：真实源码必须通过', null, null],
      // 本次真机白屏的根因形态：上游给 preload 加了方法，登记表没重生成 → 烟雾测试调不到
      ['登记表少了 folderRoots（上游新增后没重跑生成器 = 本次白屏根因）',
        (t, l) => l.endsWith('bridge-methods.json') ? t.replace('"folderRoots",', '') : t,
        /shell\.homeApi 登记表缺 \d+ 个契约方法/],
      ['登记表多了已不存在的方法（preload 改名后没重跑）',
        (t, l) => l.endsWith('bridge-methods.json') ? t.replace('"recents",', '"recents", "ghostMethod",') : t,
        /登记表多出 1 个已不存在的方法/],
      ['生成器的方法名正则被改（两份实现漂移 → 门禁与生成器各说各话）',
        (t, l) => l.endsWith('extract-bridge-methods.mjs') ? t.replace('{2,8}', '{2,12}') : t,
        /方法名正则与本门禁不一致/],
      ['登记表文件读不到（烟雾测试会没清单 → 假绿）',
        (t, l) => l.endsWith('bridge-methods.json') ? (() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) })() : t,
        /ENOENT|缺 scripts\/bridge-methods\.json/],
    ],
  },
  {
    fn: 'checkShellBridgeProxy',
    cases: [
      ['对照：真实源码必须通过', null, null],
      // 真机白屏的直接原因：__wrapped 只是个标记，并没有真的包 Proxy
      ['window.aiOffice 退回裸对象赋值（未实现方法 → TypeError → 起始页白屏）',
        (t, l) => l === 'Index.ets' ? t.replace("window.aiOffice = wrapShellBridge('aiOffice', aiOffice);", 'window.aiOffice = aiOffice;') : t,
        /退回裸对象赋值|缺: window\.aiOffice = wrapShellBridge/],
      ['wrapShellBridge 定义被删', (t, l) => l === 'Index.ets' ? t.replace('function wrapShellBridge(name, obj) {', 'function wrapShellBridgeX(name, obj) {') : t, /缺: function wrapShellBridge\(name, obj\) \{/],
      ['aiOfficeTabs 不再包装（TabBar 调未实现方法即崩）', (t, l) => l === 'Index.ets' ? t.replace("window.aiOfficeTabs = wrapShellBridge('aiOfficeTabs', {", 'window.aiOfficeTabs = ({') : t, /缺: window\.aiOfficeTabs = wrapShellBridge/],
      ['folderRoots 的空数组形状被删（Home 挂载即 next[0] 解引用）', (t, l) => l === 'Index.ets' ? t.replace('folderRoots: function () { return Promise.resolve([]); },', '') : t, /缺: folderRoots: function/],
      // 这两行在 makeBridge（app 侧）与 wrapShellBridge（壳侧）各有一份 → 必须 replaceAll，
      // 只删第一份等于没删（门禁已改为在 wrapShellBridge 体内判定）
      ['Proxy 不再「已有键优先」（会覆盖 aiOffice 自己的 getAiSettings → 设置面板渲染空白）', (t, l) => l === 'Index.ets' ? t.replaceAll('if (k in t) { return t[k]; }', '') : t, /wrapShellBridge 体内缺: if \(k in t\)/],
      ['getCodexModels 形状退回 undefined（存在性判断被 Proxy 骗过 → live.models 崩）', (t, l) => l === 'Index.ets' ? t.replace("getCodexModels: function () { return Promise.resolve({ models: [], defaultModel: '' }); }", 'getCodexModels: function () { return Promise.resolve(undefined); }') : t, /缺: getCodexModels: function/],
      ['on* 订阅兜底被删（useEffect 清理函数变 undefined → 卸载时抛）', (t, l) => l === 'Index.ets' ? t.replaceAll("if (k.indexOf('on') === 0) { return function () { return NOOP; }; }", '') : t, /wrapShellBridge 体内缺: if \(k\.indexOf\('on'\) === 0\)/],
      // 批次 D-6 真机：设置页 v.on / ce.models.length —— 形状缺失，Proxy 兜底救不了
      ['getAutoSaveDefault 形状被删（进设置页 v.on 崩）', (t, l) => l === 'Index.ets' ? t.replace('getAutoSaveDefault: function () { return Promise.resolve({ on: loadAutoSaveDefault(), updatedAt: 0 }); },', '') : t, /缺: getAutoSaveDefault: function/],
      ['setAutoSaveDefault 没实现（拨开关静默失效，下次进来又是关的）', (t, l) => l === 'Index.ets' ? t.replace('setAutoSaveDefault: function (on) {', 'setAutoSaveDefaultX: function (on) {') : t, /缺: setAutoSaveDefault: function/],
      ['testAiMediaSettings 缺失（刚启用的媒体面板点「测试连接」拿 undefined）', (t, l) => l === 'Index.ets' ? t.replace('testAiMediaSettings: function (input) {', 'testAiMediaSettingsX: function (input) {') : t, /缺: testAiMediaSettings: function/],
      ['getCustomModels 形状被删（自定义模型列表 ce.models.length 崩）', (t, l) => l === 'Index.ets' ? t.replace("getCustomModels: function () { return Promise.resolve({ models: [], defaultModel: '' }); },", '') : t, /缺: getCustomModels: function/],
      // 批次 E-2 真机报回：点「第三方集成」崩 reading 'running'
      ['getMcpStatus 退回 resolve(undefined)（集成分区崩 reading running）',
        (t, l) => l === 'Index.ets' ? t.replace('getMcpStatus: function () {', 'getMcpStatusX: function () {') : t,
        /缺: getMcpStatus: function \(\) \{/],
      ['McpStatus 少一个必填字段（takeStatus 读它即 undefined）',
        (t, l) => l === 'Index.ets' ? t.replaceAll('url: null, capabilities: [],', 'url: null,') : t,
        /缺: url: null, capabilities: \[\],/],
      ['getMcpLogs 没给数组形状（日志面板拿到 undefined）',
        (t, l) => l === 'Index.ets' ? t.replace('getMcpLogs: function () { return Promise.resolve([]); },', '') : t,
        /缺: getMcpLogs: function/],
    ],
  },
  // ===== 批次 E：AI 目录 / 双协议通道 / 去 Genspark 登录 / 许可材料 =====
  {
    fn: 'checkAiProviderCatalog',
    cases: [
      ['对照：真实源码必须通过', null, null],
      ['genspark 条目被加回目录（fork 无权用它的记账代理）',
        (t, l) => l === 'Index.ets' ? t.replace("var AI_CATALOG = [\n", "var AI_CATALOG = [\n    { id: 'genspark', label: 'Genspark', models: [], defaultModel: '', keyPlaceholder: '', needsBaseUrl: true, defaultBaseUrl: '' },\n") : t,
        /AI_CATALOG 里还有 genspark/],
      ['关掉 needsBaseUrl（端点不可填 = 接不了 token plan 网关）',
        (t, l) => l === 'Index.ets' ? t.replace("label: 'GLM（智谱）', models: [], defaultModel: 'glm-5.3', keyPlaceholder: 'sk-...', needsBaseUrl: true,", "label: 'GLM（智谱）', models: [], defaultModel: 'glm-5.3', keyPlaceholder: 'sk-...',") : t,
        /needsBaseUrl/],
      ['custom 变成下拉（不能再自由填模型 id）',
        (t, l) => l === 'Index.ets' ? t.replace("id: 'custom', label: '自定义端点（OpenAI 兼容）', models: []", "id: 'custom', label: '自定义端点（OpenAI 兼容）', models: ['gpt-5.6-terra']") : t,
        /custom 条目必须是 models: \[\]/],
      ['anthropic 变成下拉（Claude 套餐给的模型 id 填不进去）',
        (t, l) => l === 'Index.ets' ? t.replace("id: 'anthropic', label: 'Claude（Anthropic 协议 /v1/messages）', models: []", "id: 'anthropic', label: 'Claude（Anthropic 协议 /v1/messages）', models: ['claude-sonnet-5']") : t,
        /anthropic 条目必须是 models: \[\]/],
      ['搜索目录被删（设置里没有填 Key 的地方 → 搜索永远不可用）',
        (t, l) => l === 'Index.ets' ? t.replace('getAiSearchProviders: function () { return AI_SEARCH_CATALOG; },', '') : t,
        /缺: getAiSearchProviders/],
      ['media/search 默认形状被删（AiMediaPane 直接 return null = 整块空白）',
        (t, l) => l === 'Index.ets' ? t.replace('media: defaultAiMediaSettings(), search: defaultAiSearchSettings()', 'media: undefined, search: undefined').replace('function defaultAiMediaSettings() {', 'function unusedAiMedia() {') : t,
        /defaultAiMediaSettings 只出现|缺: media: defaultAiMediaSettings/],
      ['老配置里的 genspark 不再落回 glm（AI 永远"未配置"）',
        (t, l) => l === 'Index.ets' ? t.replaceAll("if (!o.provider || o.provider === 'genspark' || o.provider === 'codex') { o.provider = 'glm'; }", '') : t,
        /缺: if \(!o\.provider/],
      // ↓ 这五条对应真机报回的崩溃：上一版把"media 目录留空"当成诚实降级，
      //   而上游是 options[0]! 非空断言 —— 空数组一点即崩，且当时没有反例拦住它。
      ['media 目录退回空数组（点「AI 媒体与搜索」即崩 reading id）',
        (t, l) => l === 'Index.ets' ? t.replace(/var AI_MEDIA_CATALOG = \[[\s\S]*?\n  \];/, 'var AI_MEDIA_CATALOG = [];') : t,
        /AI_MEDIA_CATALOG 条目数 <2/],
      ['所有条目去掉 imageProtocol（生图区块过滤为空 → 崩）',
        (t, l) => l === 'Index.ets' ? t.replaceAll('imageProtocol: ', 'imageProtocolX: ') : t,
        /没有任何条目带 imageProtocol/],
      ['所有条目去掉 analysisProtocol（图片理解区块过滤为空 → 崩）',
        (t, l) => l === 'Index.ets' ? t.replaceAll('analysisProtocol: ', 'analysisProtocolX: ') : t,
        /没有任何条目带 analysisProtocol/],
      ['videoAnalysis 全给 false（视频区块的过滤是两者与 → 空 → 崩）',
        (t, l) => l === 'Index.ets' ? t.replaceAll('videoAnalysis: true', 'videoAnalysis: false') : t,
        /需要某一条目.*同时带 analysisProtocol 与 videoAnalysis|需要某一条目\*\*同时\*\*带/],
      ['生图端点被改错（填了 Key 也永远 404）',
        (t, l) => l === 'Index.ets' ? t.replace("var url = ep.base + '/images/generations';", "var url = ep.base + '/images/gen';") : t,
        /缺: var url = ep\.base \+ '\/images\/generations'/],
      ['生图退回降级桩（设置里填了 Key 依然"不可用"）',
        (t, l) => l === 'Index.ets' ? t.replace('generateImage: aiGenerateImage,', 'generateImage: function () { return Promise.resolve({ error: \'n/a\' }); },') : t,
        /缺: generateImage: aiGenerateImage/],
      ['图片理解没挂到 base mock（docs/slides 的 analyze_media 点了没反应）',
        (t, l) => l === 'Index.ets' ? t.replace('analyzeMedia: aiAnalyzeMedia,', '') : t,
        /缺: analyzeMedia: aiAnalyzeMedia/],
      ['集成桥退回裸对象赋值（status() 取不到 → 分区又变空白）',
        (t, l) => l === 'Index.ets' ? t.replace("window.aiOfficeIntegrations = wrapShellBridge('aiOfficeIntegrations', {", 'window.aiOfficeIntegrations = ({') : t,
        /缺: window\.aiOfficeIntegrations = wrapShellBridge/],
    ],
  },
  {
    fn: 'checkAiProtocolChannel',
    cases: [
      ['对照：真实源码必须通过', null, null],
      ['Anthropic 消息映射被删（选 Claude 会发出 OpenAI 形状 → 400）',
        (t, l) => l === 'Index.ets' ? t.replace('function aiPushAnthropic(list, m) {', 'function aiPushAnthropicX(list, m) {') : t,
        /缺: function aiPushAnthropic\(list, m\)/],
      ['x-api-key 头被删（Anthropic 必 401）',
        (t, l) => l === 'Index.ets' ? t.replace("h['x-api-key'] = ep.key;", '') : t,
        /缺: h\['x-api-key'\]/],
      ['anthropic-version 头被删（Anthropic 必 400）',
        (t, l) => l === 'Index.ets' ? t.replace("h['anthropic-version'] = AI_ANTHROPIC_VERSION;", '') : t,
        /缺: h\['anthropic-version'\]/],
      ['端点分流失效（Anthropic 也被打到 /chat/completions）',
        (t, l) => l === 'Index.ets' ? t.replace("ep.protocol === 'anthropic' ? ep.base + '/messages' : ep.base + '/chat/completions'", "ep.base + '/chat/completions'") : t,
        /缺: ep\.protocol === 'anthropic' \? ep\.base/],
      ['工具 schema 读回 parameters（上游字段是 inputSchema → 工具描述恒空）',
        (t, l) => l === 'Index.ets' ? t.replaceAll('t.inputSchema || t.parameters', 't.parameters') : t,
        /缺: t\.inputSchema \|\| t\.parameters/],
      ['图片又只读 dataUrl（AgentImage 契约是 base64+mime → 图被静默丢掉）',
        (t, l) => l === 'Index.ets' ? t.replace('img.base64 || img.b64', 'img.b64X || img.b64') : t,
        /缺: img\.base64 \|\| img\.b64/],
      ['通道退回 PDF 专用（其余 5 个 app 的 AI 面板又点了没反应）',
        (t, l) => l === 'Index.ets' ? t.replace('aiStream: function (req) { return aiStreamRun(req); },', 'aiStream: function () { return Promise.resolve(); },') : t,
        /缺: aiStream: function \(req\)|base mock 缺共享 AI 通道接线/],
      ['pdfMock 重新自带一份 aiStream（静默覆盖 base，双协议只在 PDF 生效）',
        (t, l) => l === 'Index.ets' ? t.replace('var pdfMock = Object.assign({}, mock, {', 'var pdfMock = Object.assign({}, mock, {\n    aiStream: function (req) { return Promise.resolve(); },') : t,
        /aiStream 实现出现 2 份/],
      ['原生兜底通道被删（CORS 一拦就彻底不可用）',
        // 必须 replaceAll：有三个消费者（兜底/生图/理解），只删第一处过去能逃过全文判定
        (t, l) => l === 'Index.ets' ? t.replaceAll("goJson('aiPostJson'", "goJson('aiPostX'") : t,
        /aiPostJson' 只出现/],
      ['原生 POST 不再限本机回环（变成任意 URL 出网原语）',
        (t, l) => l.endsWith('DesktopBridge.ets') ? t.replace("      || target.startsWith('http://127.0.0.1') || target.startsWith('http://localhost');", ';') : t,
        /DesktopBridge\.ets 缺: target\.startsWith\('http:\/\/127\.0\.0\.1'\)/],
      ['Serper 图搜端点被删（图搜打空 URL）',
        (t, l) => l.endsWith('DesktopBridge.ets') ? t.replace("'https://google.serper.dev/images'", "'x'") : t,
        /DesktopBridge\.ets 缺: https:\/\/google\.serper\.dev\/images/],
      ['DDG 抓取被加回（非官方端点，商用不稳）',
        (t, l) => l.endsWith('DesktopBridge.ets') ? t.replace('async webSearchJson(', 'async legacyDdgProbe(): string { return "https://html.duckduckgo.com/html/?q=x"; }\n  async webSearchJson(') : t,
        /还残留 html\.duckduckgo/],
    ],
  },
  {
    fn: 'checkGensparkBrandGone',
    cases: [
      ['对照：真实源码必须通过', null, null],
      ['上游同步带回 Genspark 文案（面板标题又变品牌名）',
        (t, l) => l.endsWith('ai/zh.ts') ? t.replace("aiPanelTitle: 'AI',", "aiPanelTitle: 'Genspark 面板',") : t,
        /仍有 Genspark 品牌值/],
      ['积分提示带回 genspark.ai 链接',
        (t, l) => l.endsWith('ai/en.ts') ? t.replace("aiPanelTitle: 'AI',", "aiPanelTitle: 'Genspark AI 助手',") : t,
        /仍有 Genspark 品牌值/],
      // JSX 文本节点是「值级替换」的盲区：Excel AI 面板标题（{t('aiPanelTitle')} → 裸 Genspark）
      // 就是这么漏到真机的。这条反例一旦失败，说明门禁又只看得见引号内字符串了。
      ['JSX 文本节点漏出品牌名（不引号、无法被值级替换命中）',
        (t, l) => (l.endsWith('sheets/src/renderer/ai/AiChatPanel.tsx'))
          ? t.replace("{t('aiPanelTitle')}", 'Genspark') : t,
        /\[JSX文本\]|仍有 Genspark 品牌值/],
      ['JSX 文本内联写法漏出品牌名（文案紧跟子元素，闭合是 <Child 而不是 </）',
        (t, l) => (l.endsWith('markdown/src/renderer/ai/AiPanel.tsx'))
          ? t.replace('<span className="ai-panel-title">', '<span className="ai-panel-title">Genspark AI ')
          : t,
        /\[JSX文本\]|仍有 Genspark 品牌值/],
    ],
  },
  {
    fn: 'checkGensparkLoginRemoved',
    cases: [
      ['对照：真实源码必须通过', null, null],
      ['登录按钮回到起始页（点了必抛/必没反应）',
        (t, l) => l.endsWith('Home.tsx') ? t.replace("data-tip={t('settings')}", "data-tip={t('loginGenspark')}") : t,
        /还有 loginGenspark|未改名为「设置」/],
      ['登录链复活（锚点换成仍存在的 handleClick：云视图已随批次 E 清理删除）',
        (t, l) => l.endsWith('Home.tsx') ? t.replace('  const handleClick = () => openSettings(null)', '  const startLogin = () => void window.aiOffice.accountLogin?.()\n  const handleClick = () => openSettings(null)') : t,
        /还有 startLogin|还有 accountLogin\(/],
      ['账户分区回到设置导航（打开就是"未登录 + 登录"死路）',
        (t, l) => l.endsWith('SettingsModal.tsx') ? t.replace("export type SectionId = 'aiModel'", "export type SectionId = 'account' | 'aiModel'") : t,
        /SettingsModal\.tsx 里还有 'account'/],
      ['UNPORTED_EXTS 被删（html 磁贴回归，apps/html 未移植 → 打开白屏）',
        (t, l) => l.endsWith('Home.tsx') ? t.replace("const UNPORTED_EXTS: readonly string[] = ['html']", 'const UNPORTED_EXTS: readonly string[] = []') : t,
        /丢了 UNPORTED_EXTS/],
      ['壳侧 accountStatus 兜底被删（其它 app 调用即 TypeError）',
        (t, l) => l === 'Index.ets' ? t.replace('accountStatus: function () { return Promise.resolve({ loggedIn: false }); },', '') : t,
        /缺 no-op 兜底: accountStatus/],
    ],
  },
  {
    fn: 'checkLegalNotices',
    cases: [
      ['对照：真实源码与包内材料必须通过', null, null],
      // 门禁读的是包内文件；用 mutate 模拟"文本被截断/漏了商标声明"
      // LICENSE 正文里 "Apache License" 出现很多次 → 必须 replaceAll，只换第一处门禁仍会绿
      ['LICENSE 正文被换掉（随包的不是 Apache 条款）',
        (t, l) => l.endsWith('LICENSE.txt') ? t.replaceAll('Apache License', 'Some License') : t,
        /LICENSE\.txt 不像 Apache-2\.0/],
      ['第三方清单丢了上游版权方（Apache 4d 义务）',
        (t, l) => l.endsWith('THIRD-PARTY-NOTICES.txt') ? t.replaceAll('Mainfunc', 'Someone') : t,
        /未保留上游版权方/],
      ['第三方清单丢了商标不授予声明（第 6 条）',
        (t, l) => l.endsWith('THIRD-PARTY-NOTICES.txt') ? t.replaceAll('商标', '标记') : t,
        /未声明商标不授予/],
      ['修改声明丢了移除项（第 4(b) 条要求说明改了什么）',
        (t, l) => l.endsWith('CHANGELOG-NOTICE.txt') ? t.replaceAll('Genspark', '某个') : t,
        /未记录移除项/],
      ['开源许可菜单项被删（文本随包但用户看不到 = 等于没履行）',
        (t, l) => l === 'Index.ets' ? t.replace("{ label: '开源许可', onClick: function () { dialogLegal(); } }", '') : t,
        /缺许可入口|菜单缺「开源许可」/],
    ],
  },
]

let pass = 0
let fail = 0
for (const suite of SUITES) {
  console.log('=== ' + suite.fn)
  let run
  try {
    run = buildRunner(suite.fn)
  } catch (e) {
    fail += suite.cases.length
    console.log('[FAIL] 无法加载门禁函数：' + (e.message || e))
    continue
  }
  for (const [name, mutate, expect] of suite.cases) {
    let threw = null
    try {
      run(mutate)
    } catch (e) {
      threw = e.message || String(e)
    }
    if (!mutate) {
      if (threw) { fail++; console.log('[FAIL] ' + name + ' → 不该抛却抛了: ' + threw) }
      else { pass++; console.log('[PASS] ' + name) }
      continue
    }
    // expect === null 且 mutate 非空 = 「允许型」用例：这样改门禁**不该**报红
    // （例如把签名切到 DevEco 自动签名材料 —— 那是本地装机验证的合法工作态，报红会逼人绕过门禁）
    if (expect === null) {
      if (threw) { fail++; console.log('[FAIL] ' + name + ' → 不该报红却报红了: ' + threw) }
      else { pass++; console.log('[PASS] ' + name + '（允许态，未报红）') }
      continue
    }
    if (!threw) { fail++; console.log('[FAIL] ' + name + ' → 断言没红（门禁失效）'); continue }
    if (expect && !expect.test(threw)) { fail++; console.log('[FAIL] ' + name + ' → 红了但不是预期原因: ' + threw); continue }
    pass++
    console.log('[PASS] ' + name + ' → ' + threw.slice(0, 90))
  }
}
console.log('\nself-test-m7-negatives: ' + pass + ' PASS / ' + fail + ' FAIL')
process.exit(fail === 0 ? 0 : 1)