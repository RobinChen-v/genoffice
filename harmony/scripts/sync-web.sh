#!/bin/sh
# 完整流水线：构建全部 app renderer → 内联（rawfile 兼容）→ 同步到 ArkWeb rawfile
# 用法：sh harmony/scripts/sync-web.sh [app ...]   不带参数 = 全部
# 幂等：每次运行都会重新构建 + 内联 + 同步
set -e

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VITE="$ROOT/node_modules/vite/bin/vite.js"
INLINE="$ROOT/harmony/scripts/inline-renderer.mjs"
WEB="$ROOT/harmony/entry/src/main/resources/rawfile/web"

ALL_APPS="shell docs sheets slides markdown pdf html"
APPS="${*:-$ALL_APPS}"

# 外链模式白名单（D-4）：这些 app 的 JS 不内联进 index.html，改指 https://goasset.local/…，
# 由壳侧 onInterceptRequest 原生供字节（text/javascript + CORS）。
# 默认只 sheets：它的 index.html 内联后是 36 MB 单行 JS（「Excel 打开卡顿」的主因），
# 外链后降到 <1 KB；且 sheets 不依赖 __goChunks 懒加载（引擎是原生 .so 侧车）。
# slides / pdf **不能**外链：pptx-bridge.mjs 与 pdfjs/wasm/*_nowasm_fallback.js 靠构建期
# base64 注册表 + __goImport(blob:) 加载，外链模式不生成注册表 → 懒加载必失败
# （inline-renderer.mjs 对此有硬守卫，会直接报错退出）。
# 回退：GO_EXTERNAL_APPS="" sh scripts/sync-web.sh sheets && 重新 Build Hap(s)
EXTERNAL_APPS="${GO_EXTERNAL_APPS:-sheets}"

is_external() {
  case " $EXTERNAL_APPS " in
    *" $1 "*) return 0 ;;
    *) return 1 ;;
  esac
}

[ -f "$VITE" ] || { echo "缺少 $VITE，先 npm install"; exit 1; }

# 契约自动生成（R2）：preload 源码 → bridge-contract.json → mock.js
# 上游一改 preload，契约/mock 自动重生，不再手工维护
echo ">>> [contract] 生成桥契约 (bridge-contract.json)"
node "$ROOT/harmony/scripts/gen-bridge-contract.mjs" || { echo "契约生成失败"; exit 1; }
echo ">>> [contract] 生成 mock.js"
node "$ROOT/harmony/scripts/gen-mock.mjs" || { echo "mock 生成失败"; exit 1; }

for APP in $APPS; do
  SRC="$ROOT/apps/$APP"
  DIST="$SRC/src/renderer/dist"
  DST="$WEB/$APP"

  [ -f "$SRC/vite.renderer.config.ts" ] || { echo "[skip] $APP: 无 vite.renderer.config.ts"; continue; }

  echo ">>> [$APP 1/3] vite build"
  ( cd "$SRC" && node "$VITE" build --config vite.renderer.config.ts --base ./ )

  # slides：先把 pptx 壳桥（pptx-engine+render 浏览器 bundle）打进 dist/assets，
  # inline-renderer 会把它注册进 __goChunks（slidesMock.openPptx 经 __goImport 懒加载）。
  if [ "$APP" = "slides" ]; then
    echo ">>> [$APP 2.1/3] build pptx-bridge"
    node "$ROOT/harmony/scripts/build-pptx-bridge.mjs" --dist "$DIST" || exit 1
  fi
  # pdf：pdf-bridge（pdf-lib 纯逻辑：保存/结构操作/静态表单读取）由 pdfMock 经
  # readRawFileJson 直读 rawfile/web/pdf-bridge.mjs 懒加载（不需要进 __goChunks，
  # 不进 dist/assets，避免 1.1MB base64 注册表膨胀拖慢 PDF 打开）。
  if [ "$APP" = "pdf" ]; then
    echo ">>> [$APP 2.1/3] build pdf-bridge"
    node "$ROOT/harmony/scripts/build-pdf-bridge.mjs" || exit 1
    # pdf-convert：PDF→Word/Excel/PPT 转换桥（pdf2docx + PDFium wasm），同样只进
    # rawfile/web（Index.ets convertOffice 懒加载），不进 dist/assets。
    echo ">>> [$APP 2.2/3] build pdf-convert"
    node "$ROOT/harmony/scripts/build-pdf-convert.mjs" || exit 1
  fi
  if is_external "$APP"; then
    echo ">>> [$APP 2/3] 外链模式（JS 不内联，module script 指 goasset 别名）"
    node "$INLINE" "$DIST" --external --app "$APP"
  else
    echo ">>> [$APP 2/3] inline 脚本与样式进 index.html"
    node "$INLINE" "$DIST"
  fi

  echo ">>> [$APP 3/3] 同步到 $DST"
  mkdir -p "$DST"
  python3 - "$DST" <<'EOF'
import os, shutil, sys
d = sys.argv[1]
for name in os.listdir(d):
    p = os.path.join(d, name)
    if os.path.isdir(p):
        shutil.rmtree(p)
    else:
        os.remove(p)
EOF
  cp -r "$DIST/." "$DST/"
  echo ">>> [$APP 3.5/3] 字体别名复制（fonts/xxx → assets/<hash 文件>）"
  node - "$DST" <<'EOF'
// sheets 运行时按 `fonts/Carlito-Regular.ttf`（无 hash）加载字体，而 vite 把实体
// 输出为 assets/Carlito-Regular-<hash>.ttf → 404。扫内联后的 index.html 收集
// fonts/<name> 引用，在 assets/ 里按主名前缀匹配并把实体复制成 assets/fonts/<name>。
const fs = require('node:fs');
const path = require('node:path');
const dst = process.argv[2];
const dir = path.join(dst, 'assets');
let html = '';
try { html = fs.readFileSync(path.join(dst, 'index.html'), 'utf8'); } catch (e) { process.exit(0); }
const refs = [...new Set([...html.matchAll(/fonts\/([A-Za-z0-9_.-]+\.(?:ttf|otf|woff2?))/g)].map((m) => m[1]))];
if (refs.length === 0) process.exit(0);
let files = [];
try { files = fs.readdirSync(dir); } catch (e) { process.exit(0); }
const outDir = path.join(dir, 'fonts');
for (const ref of refs) {
  const out = path.join(outDir, ref);
  if (fs.existsSync(out)) continue;
  const stem = ref.replace(/\.\w+$/, '');
  const ext = ref.slice(ref.lastIndexOf('.'));
  const hit = files.find((f) => f.startsWith(stem + '-') && f.endsWith(ext)) || files.find((f) => f === ref);
  if (!hit) { console.warn(`[font-alias] 未找到 ${ref} 的实体文件`); continue; }
  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(path.join(dir, hit), out);
  console.log(`[font-alias] ${ref} <- ${hit}`);
}
EOF
  echo ">>> [$APP] 完成：$(du -s "$DST" | cut -f1) KB"
done

# R4：构建时品牌中性化 — 对 dist 产物做 Genspark → AI 替换
# 源码保持上游原样（含 Genspark），构建产物中由 strip-brand.mjs 统一替换
echo ">>> [brand] 对 rawfile/web 产物执行品牌中性化"
node "$ROOT/harmony/scripts/strip-brand.mjs" "$WEB" || { echo "品牌中性化失败"; exit 1; }

# R4：构建时 ArkWeb 补丁 — 对 dist CSS 产物追加鸿蒙特有样式
# 源码保持上游原样（无 ArkWeb 特定 CSS），构建产物中由 patch-web.mjs 追加
echo ">>> [arkweb] 对 rawfile/web 产物应用 ArkWeb 补丁"
node "$ROOT/harmony/scripts/patch-web.mjs" "$WEB" || { echo "ArkWeb 补丁失败"; exit 1; }

echo ">>> 全部完成，在 DevEco 重 Build Hap(s) 即可"
