#!/usr/bin/env node
/**
 * 把渲染层里的 Genspark 品牌字样中性化（批次 E）。
 *
 * 为什么需要脚本而不是一次性手改：
 *   1. 面大 —— i18n 是 21 语言 × 5 个 app × 3 个命名空间，含品牌串共 900+ 行；
 *   2. **上游会继续改这些文件** —— 下次同步上游后又要重来一遍，手改必然漏。
 *   所以这里既是迁移脚本也是「可重跑的补丁」，verify-all 的 checkGensparkBrandGone 会锁住结果。
 *
 * 语义变化要如实反映（不是简单删词）：移植版**没有账号体系**，所以
 *   「登录 Genspark」不是"换个名字"，而是「配置 AI（填你自己的 Key）」；
 *   「Genspark 积分已用完」不再成立，真实情况是"你所选服务商的额度/Key 有问题"。
 *   直接机械删掉品牌词会留下「登录」这种指向不存在功能的按钮文案 —— 那比 Genspark 更坏。
 *
 * 用法：node scripts/strip-genspark-brand.mjs [--check]   # --check 只报告不改写
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(dirname(HERE), '..');
const CHECK_ONLY = process.argv.includes('--check');

/**
 * 各语言的「AI」写法，用于替换**纯品牌值**（`'Genspark'` 这种当标题/菜单项的）。
 * 只对 CJK + 拉丁主流语种给本地化词，其余回落 'AI' —— 它是绝大多数语言里通用的缩写，
 * 比硬凑机器翻译安全。
 */
const AI_WORD = {
  en: 'AI', zh: 'AI', 'zh-TW': 'AI', ja: 'AI', ko: 'AI', de: 'KI', fr: 'IA', es: 'IA',
  it: 'IA', pt: 'IA', nl: 'AI', pl: 'AI', cs: 'AI', ru: 'ИИ', tr: 'AI', ar: 'الذكاء الاصطناعي',
  he: 'AI', hi: 'AI', id: 'AI', ms: 'AI',
};
/** 登录/额度这类**语义变了**的短语：只本地化中英日韩（本项目主市场），其余用英文中性文案。 */
const PHRASES = {
  login: {
    en: 'Configure AI', zh: '配置 AI', 'zh-TW': '設定 AI', ja: 'AI を設定', ko: 'AI 설정',
  },
  notLoggedIn: {
    en: 'Not configured (AI features need your own API key)',
    zh: '未配置（AI 功能需要填写你自己的 API Key）',
    'zh-TW': '未設定（AI 功能需要填入你自己的 API Key）',
    ja: '未設定（AI 機能には自分の API Key が必要です）',
    ko: '미설정 (AI 기능에는 자체 API 키가 필요합니다)',
  },
  credits: {
    en: 'Your AI provider rejected the request (quota or key problem) - check the vendor console, then try again',
    zh: '你所选的 AI 服务商拒绝了本次请求（额度或 Key 问题），请到服务商控制台确认后再试',
    'zh-TW': '你所選的 AI 服務商拒絕了本次請求（額度或 Key 問題），請到服務商控制台確認後再試',
    ja: '選択した AI プロバイダーが要求を拒否しました（額度または Key の問題）。コンソールを確認して再試行してください',
    ko: '선택한 AI 제공자가 요청을 거부했습니다(사용량 또는 키 문제). 제공자 콘솔에서 확인한 뒤 다시 시도하세요',
  },
  account: {
    en: 'AI provider', zh: 'AI 服务商', 'zh-TW': 'AI 服務商', ja: 'AI プロバイダー', ko: 'AI 제공자',
  },
  pricing: {
    en: 'your AI provider', zh: '你的 AI 服务商', 'zh-TW': '你的 AI 服務商',
    ja: 'お使いの AI プロバイダー', ko: 'AI 제공자',
  },
};
function pick(table, lang) {
  return table[lang] || table.en;
}
/** 只改「引号内的字符串值」—— 绝不碰键名（改了键名会让所有消费方与上游同步全线冲突）。
 *  因此这里**没有** `/\bGenspark\b/g` 这种全局兜底：宁可让残留被打印出来人工过一遍。 */
function transform(src, lang) {
  // 裸词守卫：引号内容若是 camelCase/snake_case 标识符（枚举值、i18n 键、组件名）→ 不动。
  // 反例：'genspark' 是 AiProviderId 的枚举值，t('setAiGenspark') 是 i18n 键 —— 改了就是 TS2367/TS2345。
  const isBareIdent = (q) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(q.slice(1, -1));
  // 按键名精准中和（21 语言的动词形态各异，按值匹配必漏；cs/he/hi/id 的「登录 Genspark」就是这样漏的）。
  // 这些键的语义已随账号体系移除而改变：登录按钮 → 「配置 AI」，未登录状态 → 「未配置…」。
  const loginVal = pick(PHRASES.login, lang);
  const notLoggedInVal = pick(PHRASES.notLoggedIn, lang);
  const keyNeutral = {
    aiGskLoginBtn: loginVal, aiLoginGenspark: loginVal, appLoginGenspark: loginVal, appSettingsLogin: loginVal,
    aiNotLoggedIn: notLoggedInVal, appNotLoggedIn: notLoggedInVal, appSettingsLoggedOut: notLoggedInVal,
  };
  for (const k of Object.keys(keyNeutral)) {
    src = src.replace(new RegExp('(^\\s*)' + k + '\\s*:\\s*(\'|"|`)[^\'\\"`]*(\'|"|`)', 'gm'),
      '$1' + k + ': ' + JSON.stringify(keyNeutral[k]));
  }
  let out = src;
  const en = {
    // 1) 未登录 → 未配置（各语言 PHRASES）
    loginBtn: pick(PHRASES.login, lang),
    notLoggedIn: pick(PHRASES.notLoggedIn, lang),
    credits: pick(PHRASES.credits, lang),
    account: pick(PHRASES.account, lang),
  };
  const aiWord = AI_WORD[lang] || 'AI';
  const pairs = [
    // 「Genspark 积分已用完，请前往 genspark.ai/pricing 充值后重试」整句
    [/'[^\n']*Genspark[^\n']*(?:积分|credits|créditos|crediti|Kredite|kredyty|кредиты|크레딧|クレジット|額度|点数)[^\n']*'/g, "'" + en.credits + "'"],
    // 「登录 Genspark」/「Sign in to Genspark」/「Anmelden bei Genspark」…
    [/'[^\n']*(?:Sign in to|Log in to|Anmelden bei|Se connecter|Iniciar sesión|Accedi|Entrar|Registrarse|登录|登入|登録|로그인|Connexion)[^\n']*Genspark[^\n']*'/g, "'" + en.loginBtn + "'"],
    // 「未登录（AI 功能需要登录 Genspark 账号）」这类整句状态说明
    [/'[^\n']*(?:Not signed in|未登录|未登入|Not logged in|No ha iniciado|Non connesso|Não conectado|미로그인|未ログイン)[^\n']*'/g, "'" + en.notLoggedIn + "'"],
    // 「Genspark account」→「AI 服务商」
    [/'[^']{0,40}Genspark (?:account|账号|帳號|アカウント|계정|compte|Konto|conto|cuenta)[^']{0,4}'/g, "'" + en.account + "'"],
    // 裸品牌值：'Genspark' / "Genspark" → 'AI'（面板标题、Ribbon 分组名）
    [/'Genspark'/g, "'" + aiWord + "'"],
    [/\"Genspark\"/g, '"' + aiWord + '"'],
    // 'Genspark AI' 这种「品牌 + AI」的值 → 只留 AI（zh/ja/ko 用各自的「助手」写法）
    [/'Genspark AI'/g, function (all) { return isBareIdent(all) ? all : "'" + aiWord + (lang === 'zh' ? ' 助手' : lang === 'ja' ? ' アシスタント' : lang === 'ko' ? ' 어시스턴트' : ' Assistant') + "'"; }],
    // 值里残留的 genspark.ai 链接（例如积分提示的变体）→ 指向服务商自己的控制台
    [/'([^\n']*)genspark\.ai\/pricing([^\n']*)'/g, function (_all, pre, post) {
      return "'" + pre + pick(PHRASES.pricing, lang) + post + "'";
    }],
    // 引号内剩下的独立品牌词（键名不受影响，因为正则要求两侧有引号边界）
    [/'([^\n']*)\bGenspark\b([^\n']*)'/g, function (_all, pre, post) {
      if (/^\s*$/.test(pre) && /^\s*$/.test(post)) { return "'" + aiWord + "'"; }
      return "'" + (pre + aiWord + post).replace(/\s{2,}/g, ' ').trim() + "'";
    }],
    // 大小写不敏感的值内品牌 token 兜底（含 GensparkMark 之外的普通词形与 genspark.ai 链接）
    // 只处理**带文案特征**的值（含空格/标点/链接）：裸词是标识符或 i18n 键，改了会 TS2367/TS2345
    [/'([^'\n]*[^'\n ][^'\n]*)'/gi, function (all) {
      if (isBareIdent(all) || !/genspark/i.test(all)) { return all; }
      return all.replace(/genspark[^'"\n]*/gi, function (tok2) {
        if (tok2.toLowerCase().indexOf('genspark.ai') === 0) { return pick(PHRASES.pricing, lang); }
        return aiWord;
      });
    }],
    [/"([^"\n]*)"/gi, function (all) {
      if (!/genspark/i.test(all)) { return all; }
      return all.replace(/Genspark AI/g, aiWord + (lang === 'zh' ? ' 助手' : ' Assistant'))
        .replace(/genspark[^'"\n]*/gi, aiWord);
    }],
    // ── 最后一公里（批次 F）：以上规则覆盖不到的变体（各语言变格、模板串、属性值），
    // 引号内大小写不敏感地把品牌 token 换成中性词。裸词标识符/键不在引号内，不受影响。
    // ⚠ 但"不在引号内"只说对了一半：'genspark'（AiProviderId 枚举值）与 t('aiGensparkAccount')
    //   （i18n 键）**就是**引号内的裸词 —— 少了 isBareIdent 守卫这两条会把枚举值和键名一起改掉，
    //   改完 sheets/App.tsx、AiChatPanel.tsx、shell/SettingsModal.tsx 三处编译即红（TS2367/TS2345）。
    [/\'([^\'\n]*)\'/g, function (all) {
      if (isBareIdent(all) || /genspark-ai/i.test(all)) { return all; }
      return all.replace(/genspark\.ai/gi, 'AI provider').replace(/genspark/gi, 'AI');
    }],
    [/\u0022([^\u0022\n]*)\u0022/g, function (all) {
      if (isBareIdent(all)) { return all; }
      return all.replace(/genspark\.ai/gi, 'AI provider').replace(/genspark/gi, 'AI');
    }],
  ];
  for (const [re, rep] of pairs) { out = out.replace(re, rep); }
  // ── JSX 文本节点（`>文案<`）：既不在引号里、也不是键名，上面 12 条规则**全都看不见它**。
  // Excel AI 面板标题就是这么漏到真机的（{t('aiPanelTitle')} 被上游同步回裸 Genspark）。
  // 只替换捕获组内的品牌 token，前后标签原样回填 —— 组内不含换行，所以行数守卫不可能被触发。
  const JSX_TEXT_RE = /(\/?>\s*)([A-Za-z][A-Za-z0-9 ,.'!?&:;()\-]*?)(\s*<\/?[A-Za-z])/g;
  out = out.replace(JSX_TEXT_RE, function (all, pre, text, post) {
    if (!/genspark/i.test(text)) { return all; }
    const neutral = text.replace(/genspark\.ai/gi, 'AI provider').replace(/genspark/gi, aiWord);
    // 'Genspark AI' 这类「品牌 + 通用词」替换后会叠成 'AI AI'，收一次
    return pre + neutral.replace(/\s{2,}/g, ' ').replace(/(^|\s)(AI)(?:\s+AI)+(?=\s|$)/g, '$1$2').trim() + post;
  });
  return out;
}

function walk(dir, out) {
  if (!existsSync(dir)) { return out; }
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { walk(p, out); continue; }
    if (/\.(ts|tsx)$/.test(e.name)) { out.push(p); }
  }
  return out;
}

const targets = [];
for (const app of ['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html', 'shell']) {
  walk(resolve(ROOT, 'apps', app, 'src/renderer'), targets);
  walk(resolve(ROOT, 'apps', app, 'src/shared'), targets);
}
walk(resolve(ROOT, 'packages', 'ui', 'src'), targets);

let changed = 0;
const remaining = [];
const changedFiles = [];
for (const f of targets) {
  const rel = f.slice(ROOT.length + 1);
  // 语言检测：路径分隔符同时支持 / 和 \（Windows readdirSync/join 返回反斜杠，
  // 只认正斜杠时 langM 恒 null → 全部回落 'en' → CJK 本地化值被误改成英文统一文案）。
  const langM = /[\\/]i18n[\\/](?:ai[\\/]|app[\\/]|ribbon[\\/])?([A-Za-z-]+)\.ts$/.exec(f);
  const lang = langM ? langM[1] : 'en';
  const src = readFileSync(f, 'utf8');
  if (!/Genspark|genspark/.test(src)) { continue; }
  const next = transform(src, lang);
  if (next !== src) {
  if (next.split('\n').length !== src.split('\n').length) {
    // 行数变了 = 正则跨行吞了代码（本脚本踩过的最严重事故：'assistant'\n text: string 被合并）
    console.error('[brand] 拒绝写入（行数变化 ' + src.split('\n').length + ' -> ' + next.split('\n').length + '）：' + rel);
    process.exitCode = 2;
    continue;
  }
    changed++;
    changedFiles.push(rel);
    if (!CHECK_ONLY) { writeFileSync(f, next); }
  }
  if (/Genspark|genspark/.test(next)) { remaining.push(rel); }
}
console.log((CHECK_ONLY ? '[check] 待改写文件 ' : '[brand] 已改写 ') + changed + ' 个文件');
if (changedFiles.length) {
  console.log('[brand] 改动清单（--check 时也打印，便于逐个人工过）:');
  for (const r of changedFiles) { console.log('  * ' + r); }
  if (CHECK_ONLY) {
    // --check 是"先看再改"的入口：把每处改动的前后行贴出来，免得靠猜
    for (const r of changedFiles) {
      const before = readFileSync(resolve(ROOT, r), 'utf8');
      const after = transform(before, (/\/i18n\/(?:ai\/|app\/|ribbon\/)?([A-Za-z-]+)\.ts$/.exec(r) || [])[1] || 'en');
      const a = before.split('\n'); const b = after.split('\n');
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
          console.log('    ' + r + ':' + (i + 1));
          console.log('      - ' + a[i].trim().slice(0, 110));
          console.log('      + ' + (b[i] || '').trim().slice(0, 110));
        }
      }
    }
  }
}
if (remaining.length) {
  console.log('[brand] 仍含品牌串（人工过一遍：多半是键名或注释，不该改）:');
  for (const r of remaining.slice(0, 20)) { console.log('  - ' + r); }
}
if (CHECK_ONLY && changed > 0) { process.exit(1); }
