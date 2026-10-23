// M4 验证：sheets xlsx 引擎的 OHOS 交叉编译产物核验。
// M4.5 终版架构（2026-09 真机 hilog 收敛）：手写 NAPI FFI 不可行 —— 设备
// libace_napi.z.so 的 napi_* 仅是 OUC __import_module__("napi") 占位桩，MUSL 加载
// 报 "relocating failed: symbol not found: napi_get_cb_info"。改为：
//   * Rust 引擎 libxlsx_sidecar_rust.so：纯 C ABI（xlsx_handle_c/xlsx_free_c），
//     零 napi 依赖；
//   * ArkTS import 'libxlsx_sidecar.so' 的正式模块：entry CMake 工程
//     （src/main/cpp/napi_init.cpp，OUC 编译 NAPI 薄层）产物，内部调用 Rust 引擎。
// 校验：
//   1. 交叉编译产物 cdylib 存在且为 aarch64 OHOS（LE/64）格式
//   2. 导出 xlsx_handle_c / xlsx_free_c，且无 napi_* undefined 引用
//   3. 已部署到 entry/libs/arm64-v8a + CMake 薄层 + 接口声明齐全
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const check = (name, cond) => { if (!cond) throw new Error('FAIL ' + name); console.log('PASS  ' + name); };

const ROOT = new URL('../..', import.meta.url).pathname; // /storage/.../GenOffice
const SDK = process.env.HOME + '/.harmonybrew/Cellar/ohos-sdk/26.0.0.18_1';
const NM = SDK + '/native/llvm/bin/llvm-nm';

const srcSo = ROOT + 'apps/sheets/native/xlsx-engine/target/aarch64-unknown-linux-ohos/release/libxlsx_sidecar_rust.so';
const deployed = ROOT + 'harmony/entry/libs/arm64-v8a/libxlsx_sidecar_rust.so';
const napiShim = ROOT + 'harmony/entry/src/main/cpp/napi_init.cpp';
const cmake = ROOT + 'harmony/entry/src/main/cpp/CMakeLists.txt';
const dts = ROOT + 'harmony/entry/src/main/cpp/types/libxlsx_sidecar/index.d.ts';
const typesPkg = ROOT + 'harmony/entry/src/main/cpp/types/libxlsx_sidecar/oh-package.json5';

// ---- B1: 编译产物存在 & ELF 类型 ----
for (const [name, p] of [['release cdylib', srcSo], ['deployed entry/libs/arm64-v8a', deployed]]) {
  check(`${name} exists`, existsSync(p));
  const buf = readFileSync(p);
  check(`${name} is ELF`, buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46);
  check(`${name} is little-endian`, buf[5] === 1);
  check(`${name} is 64-bit`, buf[4] === 2);
}

// ---- B2: 纯 C ABI 导出 + 零 napi 引用（手写 NAPI 在此 SDK 不可行，见文件头）----
{
  let nmOut;
  try {
    nmOut = execFileSync(NM, ['-D', deployed], { encoding: 'utf8', timeout: 20000 });
  } catch (e) { nmOut = (e.stdout || '') + (e.stderr || ''); }
  check('exports xlsx_handle_c', /T xlsx_handle_c\s*$/m.test(nmOut));
  check('exports xlsx_free_c', /T xlsx_free_c\s*$/m.test(nmOut));
  check('no undefined napi_* references', !/ U napi_/.test(nmOut));
}

// ---- B3: NAPI 薄层（OUC 编译）+ 接口声明 ----
check('cpp/napi_init.cpp exists', existsSync(napiShim) && /xlsx_handle_c/.test(readFileSync(napiShim, 'utf8')));
check('cpp/CMakeLists.txt exists', existsSync(cmake) && /libxlsx_sidecar_rust/.test(readFileSync(cmake, 'utf8')));
check('index.d.ts declares handle()', existsSync(dts) && /handle/.test(readFileSync(dts, 'utf8')));
check('types oh-package declares libxlsx_sidecar.so', existsSync(typesPkg)
  && /"libxlsx_sidecar\.so"/.test(readFileSync(typesPkg, 'utf8')));

console.log('\nALL M4 CROSS-COMPILE + NAPI SHIM VERIFY PASS');