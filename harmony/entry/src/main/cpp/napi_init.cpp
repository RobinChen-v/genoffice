#include "napi/native_api.h"

#include <cstring>
#include <string>

// Rust xlsx 引擎（纯 C ABI，不依赖任何 napi 符号 —— napi_* 只能由 OUC 编译的
// C/C++ 代码调用，见 napi.rs 顶部背景说明）。xlsx_handle_c 返回的内存由
// xlsx_free_c 释放。
extern "C" {
    char* xlsx_handle_c(const char* requestJson);
    void xlsx_free_c(char* ptr);
}

// ArkTS `import xlsxSidecar from 'libxlsx_sidecar.so'` 拿到的 handle():
// requestJson: string -> responseJson: string（与 desktop sidecar 行协议一致）。
static napi_value HandleRequest(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value args[1] = { nullptr };
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

    if (argc < 1 || args[0] == nullptr) {
        napi_value result = nullptr;
        napi_get_undefined(env, &result);
        return result;
    }

    size_t length = 0;
    napi_get_value_string_utf8(env, args[0], nullptr, 0, &length);
    std::string request(length + 1, '\0');
    size_t written = 0;
    // &request[0] 写法与编译标准无关（string::data 在 C++14 下返回 const char*）。
    // 该 API 会以 '\0' 结尾写入 bufsize 字节并回写实际长度。
    napi_get_value_string_utf8(env, args[0], &request[0], request.size(), &written);

    char* response = xlsx_handle_c(request.c_str());
    napi_value result = nullptr;
    if (response == nullptr) {
        napi_get_undefined(env, &result);
        return result;
    }
    napi_create_string_utf8(env, response, std::strlen(response), &result);
    xlsx_free_c(response);
    return result;
}

EXTERN_C_START
static napi_value Init(napi_env env, napi_value exports)
{
    napi_property_descriptor descriptors[] = {
        { "handle", nullptr, HandleRequest, nullptr, nullptr, nullptr, napi_default, nullptr },
    };
    napi_define_properties(env, exports,
        sizeof(descriptors) / sizeof(descriptors[0]), descriptors);
    return exports;
}
EXTERN_C_END

// 模块名 = "xlsx_sidecar"：与 ArkTS `import 'libxlsx_sidecar.so'` 归一化后的
// 模块名一致（真机 NMM 日志 key:default/xlsx_sidecar 实证）。
static napi_module demoModule = {
    .nm_version = 1,
    .nm_flags = 0,
    .nm_filename = nullptr,
    .nm_register_func = Init,
    .nm_modname = "xlsx_sidecar",
    .nm_priv = ((void*)0),
    .reserved = { 0 },
};

extern "C" __attribute__((constructor)) void RegisterXlsxSidecarModule(void)
{
    napi_module_register(&demoModule);
}