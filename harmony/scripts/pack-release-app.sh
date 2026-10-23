#!/bin/sh
# 用 AGC 签发的新发布证书打可上架的 .app（Release）。
# 前置：key_csr/GenOffice.p12、key_csr/genoffice-release.cer、key_csr/GenOfficeRelease.p7b
#       三件套齐全，且密钥库密码写在 key_csr/material/release-key-password.txt（该目录被 .gitignore 忽略）。
# 用法：sh harmony/scripts/pack-release-app.sh
set -e

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SDK=${DEVECO_SDK_HOME:-/data/service/hnp/hmos-clt.org/hmos-clt_1.0.0/sdk}
HVIGOR=${HVIGOR_BIN:-/data/service/hnp/hmos-clt.org/hmos-clt_1.0.0/hvigor/bin/hvigorw.js}
TOOL="$SDK/default/openharmony/toolchains/lib"
KEYDIR="$ROOT/key_csr"
P12="$KEYDIR/GenOffice.p12"
CER="$KEYDIR/genoffice-release.cer"
P7B="$KEYDIR/GenOfficeRelease.p7b"
PWD_FILE="$KEYDIR/material/release-key-password.txt"

for f in "$P12" "$CER" "$P7B" "$PWD_FILE"; do
  if [ ! -f "$f" ]; then
    echo "缺少签名材料: $f" >&2
    exit 1
  fi
done

PWD_VALUE=$(cat "$PWD_FILE")
VERSION=$(sed -n 's/.*"versionName"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/AppScope/app.json5")
if [ -z "$VERSION" ]; then
  echo "无法从 AppScope/app.json5 读取 versionName" >&2
  exit 1
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

echo "==> 1/5 构建（版本 $VERSION）"
cd "$ROOT"
NODE_OPTIONS="--require $ROOT/scripts/hvigor-node26-shim.cjs" node "$HVIGOR" assembleApp --no-daemon

UNSIGNED_HAP="$ROOT/entry/build/default/outputs/default/entry-default-unsigned.hap"
UNSIGNED_APP="$ROOT/build/outputs/default/harmony-default-unsigned.app"
for f in "$UNSIGNED_HAP" "$UNSIGNED_APP"; do
  if [ ! -f "$f" ]; then
    echo "构建产物缺失: $f" >&2
    exit 1
  fi
done

echo "==> 2/5 提取 pack.info / pac.json"
mkdir -p "$WORK/meta"
(cd "$WORK/meta" && jar xf "$UNSIGNED_APP" pac.json pack.info)

echo "==> 3/5 签名 HAP"
mkdir -p "$WORK/app"
"$TOOL/hap-sign-tool" sign-app \
  -mode localSign -keyAlias genoffice -signAlg SHA256withECDSA \
  -appCertFile "$CER" -profileFile "$P7B" \
  -keystoreFile "$P12" -keystorePwd "$PWD_VALUE" -keyPwd "$PWD_VALUE" \
  -inFile "$UNSIGNED_HAP" -outFile "$WORK/app/entry-default.hap" -compatibleVersion 23

echo "==> 4/5 打包 .app"
cp "$WORK/meta/pac.json" "$WORK/meta/pack.info" "$WORK/app/"
(cd "$WORK/app" && zip -0 -X -q "$WORK/unsigned.app" entry-default.hap pac.json pack.info)

echo "==> 5/5 签名 .app"
OUT_DIR="$ROOT/build/outputs/default"
OUT="$OUT_DIR/GenOffice-$VERSION-release.app"
mkdir -p "$OUT_DIR"
"$TOOL/hap-sign-tool" sign-app \
  -mode localSign -keyAlias genoffice -signAlg SHA256withECDSA \
  -appCertFile "$CER" -profileFile "$P7B" \
  -keystoreFile "$P12" -keystorePwd "$PWD_VALUE" -keyPwd "$PWD_VALUE" \
  -inFile "$WORK/unsigned.app" -outFile "$OUT"

echo "==> 校验"
"$TOOL/hap-sign-tool" verify-app -inFile "$OUT" -outCertChain "$WORK/v.cer" -outProfile "$WORK/v.p7b" >/dev/null
"$TOOL/hap-sign-tool" verify-app -inFile "$WORK/app/entry-default.hap" -outCertChain "$WORK/h.cer" -outProfile "$WORK/h.p7b" >/dev/null

echo "完成: $OUT（$(du -h "$OUT" | cut -f1)）"