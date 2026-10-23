#!/bin/sh
# M4/M4.5：交叉编译 sheets xlsx 引擎到 HarmonyOS(arm64) Rust 纯 C ABI 库。
#
# M4.5 背景：商业 HarmonyOS NEXT SDK 无 @ohos.process.childprocess；且手写 NAPI
# FFI（引用 napi_* 符号）在真机加载即失败 —— 设备 libace_napi.z.so 的 napi_* 仅是
# OUC __import_module__("napi") 占位桩，MUSL 报 "relocating failed: symbol not found:
# napi_get_cb_info"。因此：
#   * Rust 引擎 libxlsx_sidecar_rust.so 只导出纯 C ABI（xlsx_handle_c/xlsx_free_c），
#     不调用任何 napi 符号；
#   * ArkTS import 'libxlsx_sidecar.so' 的正式模块由 entry 的 CMake 工程
#     （src/main/cpp/napi_init.cpp，OUC 编译）产出，其 NAPI 薄层内部调用本引擎。
#
# 依赖（本机 harmonybrew）：
#   rust        -> ~/.harmonybrew/Cellar/rust/<ver>   （OHOS 定制版，自带 aarch64-unknown-linux-ohos target）
#   ohos-sdk    -> ~/.harmonybrew/Cellar/ohos-sdk/<ver>（含 native/llvm/bin/aarch64-unknown-linux-ohos-clang + native/sysroot）
#
# 用法：sh harmony/scripts/build-xlsx-sidecar-ohos.sh
# 产出：apps/sheets/native/xlsx-engine/target/aarch64-unknown-linux-ohos/release/libxlsx_sidecar_rust.so
# 并复制到 harmony/entry/libs/arm64-v8a/libxlsx_sidecar_rust.so（模块 native 打包源目录）
set -e

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SDK_VAR="${OHOS_SDK:-$HOME/.harmonybrew/Cellar/ohos-sdk/26.0.0.18_1}"
RUST=$(ls -d "$HOME/.harmonybrew/Cellar/rust"/* 2>/dev/null | sort -V | tail -1)
CLL="$SDK_VAR/native/llvm/bin/aarch64-unknown-linux-ohos-clang"
ARR="$SDK_VAR/native/llvm/bin/llvm-ar"
SYS="$SDK_VAR/native/sysroot"
SRC="$ROOT/apps/sheets/native/xlsx-engine"
TARGET="$SRC/target/aarch64-unknown-linux-ohos/release/libxlsx_sidecar_rust.so"
DST="$ROOT/harmony/entry/libs/arm64-v8a/libxlsx_sidecar_rust.so"

echo "==> rust toolchain: $RUST"
export PATH="$RUST/bin:$PATH"
export CARGO_HOME="$HOME/.cargo"
export CC="$CLL" HOST_CC="$CLL" CC_aarch64_unknown_linux_ohos="$CLL" AR="$ARR"
export CFLAGS="--sysroot=$SYS"

echo "==> [1/3] cargo build --release --lib --target aarch64-unknown-linux-ohos"
( cd "$SRC" && cargo build --release --lib --target aarch64-unknown-linux-ohos )

echo "==> [2/3] verify pure-C symbols (xlsx_handle_c / xlsx_free_c, no napi_*)"
NM="$SDK_VAR/native/llvm/bin/llvm-nm"
"$NM" -D "$TARGET" | grep -q "T xlsx_handle_c" && echo "    xlsx_handle_c OK"
"$NM" -D "$TARGET" | grep -q "T xlsx_free_c" && echo "    xlsx_free_c OK"
if "$NM" -D "$TARGET" | grep -q "U napi_"; then
  echo "    ERROR: engine still references napi_* symbols (must be napi-free)" >&2
  exit 1
fi
echo "    no napi_* undefined references"

echo "==> [3/3] deploy to entry/libs/arm64-v8a (native 打包源)"
mkdir -p "$(dirname "$DST")"
cp "$TARGET" "$DST"
echo "    deployed: $DST"
ls -la "$DST"

echo "> DONE. 引擎已更新；正式 NAPI 模块（libxlsx_sidecar.so）由 entry CMake 工程在 DevEco 构建时产出。"