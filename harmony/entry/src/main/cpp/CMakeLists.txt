cmake_minimum_required(VERSION 3.5.0)
project(xlsx_sidecar)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(NATIVERENDER_ROOT_PATH ${CMAKE_CURRENT_SOURCE_DIR})

if(DEFINED PACKAGE_FIND_FILE)
    include(${PACKAGE_FIND_FILE})
endif()

include_directories(${NATIVERENDER_ROOT_PATH}
                    ${NATIVERENDER_ROOT_PATH}/include)

# OUC 编译的 NAPI 薄层：产物 libxlsx_sidecar.so（ArkTS import 'libxlsx_sidecar.so'
# 的解析对象，nm_modname=xlsx_sidecar）。所有 napi_* 调用都发生在这里，由
# DevEco 的 OUC 工具链按 __import_module__("napi") 机制正确编译绑定。
add_library(xlsx_sidecar SHARED napi_init.cpp)
target_include_directories(xlsx_sidecar PUBLIC ${NATIVERENDER_ROOT_PATH})
target_link_libraries(xlsx_sidecar PUBLIC libace_napi.z.so)

# 链接 Rust 纯 C ABI 引擎（无 napi 依赖）：libxlsx_sidecar_rust.so 部署在模块
# native libs 打包源目录（entry/libs/${OHOS_ARCH}），随 HAP 自动打包；
# 运行时作为 libxlsx_sidecar.so 的 DT_NEEDED 由系统加载器解析。
target_link_libraries(xlsx_sidecar PUBLIC
    ${NATIVERENDER_ROOT_PATH}/../../../libs/${OHOS_ARCH}/libxlsx_sidecar_rust.so)

target_link_directories(xlsx_sidecar PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/../libs/${OHOS_ARCH})