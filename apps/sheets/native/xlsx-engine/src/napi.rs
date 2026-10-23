//! Pure-C ABI entry layer for the HarmonyOS shell.
//!
//! 背景（2026-09 真机 hilog 实证）：商务 HarmonyOS NEXT 的 libace_napi.z.so 里所有
//! napi_* 只是 4 字节 `ret` 占位桩 —— NAPI 运行时走的是 OUC 工具链的
//! `__import_module__("napi")` 机制（见 node_api.h 的 NAPI_EXTERN），**不通过传统
//! ELF 符号提供**。手写 `extern "C"` 引用 napi_* 的 cdylib 在真机 MUSL 加载时即报
//! `relocating failed: symbol not found ... napi_get_cb_info`。
//!
//! 因此本 cdylib **不再调用任何 napi_***，只导出两个纯 C 函数：
//!   - `xlsx_handle_c(request_json: *const c_char) -> *mut c_char`：一行协议调用
//!   - `xlsx_free_c(ptr: *mut c_char)`：释放上者返回的内存
//! 由 harmony entry 的 C 薄层（src/main/cpp/napi_init.cpp，OUC 正确编译）在 NAPI
//! 回调内调用并完成 JS 侧包装 —— 所有 napi_* 调用都发生在 OUC 编译的 C 代码里。
//! 协议与 desktop sidecar 的 JSON 行协议完全一致（main.rs stdin/stdout 同构）。

use std::ffi::{CStr, CString, c_char};
use std::path::Path;
use std::sync::Mutex;

use serde_json::{Value, json};

use crate::{CellRange, SidecarError, WorkbookSessions};

const PROTOCOL_VERSION: u8 = 1;

// ---------------------------------------------------------------------------
// Session state lives for the lifetime of the loaded module (one UIAbility
// process). The bridge calls are synchronous on the ArkTS thread, so a single
// Mutex guards the sessions against re-entrant or pooled calls.
// ---------------------------------------------------------------------------

static SESSIONS: Mutex<Option<WorkbookSessions>> = Mutex::new(None);

fn sessions() -> &'static Mutex<Option<WorkbookSessions>> {
    &SESSIONS
}

// ---------------------------------------------------------------------------
// Request dispatch. Kept deliberately small: everything main.rs handles is
// represented, minus the recalc worker (cold IronCalc import does not belong
// on the UI thread; the renderer's recalc requests fail soft to cached values).
// ---------------------------------------------------------------------------

fn handle_line(line: &str) -> String {
    let request: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(error) => {
            return failure(
                String::new(),
                "invalid_json",
                format!("Invalid sidecar request: {error}"),
            )
        }
    };
    let request_id = request
        .get("requestId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let version = request.get("version").and_then(Value::as_u64).unwrap_or(0);
    if version != PROTOCOL_VERSION as u64 {
        return failure(
            request_id,
            "unsupported_version",
            "Unsupported sidecar protocol version.".into(),
        );
    }
    match dispatch(&request) {
        Ok(value) => success(request_id, value),
        Err(error) => {
            let code = match error {
                SidecarError::InvalidRequest(_) => "invalid_request",
                SidecarError::Io(_) => "io_error",
                SidecarError::Workbook(_) => "workbook_error",
            };
            failure(request_id, code, error.to_string())
        }
    }
}

/// Runs one command against the shared sessions. Recalc cells is deliberately
/// unsupported: a cold IronCalc import on the UI thread would freeze the shell,
/// and the renderer fails soft to cached values when it cannot recalc.
fn dispatch(request: &Value) -> Result<Value, SidecarError> {
    let command = request.get("command").and_then(Value::as_str).unwrap_or("");
    match command {
        "open" => {
            let path = string_field(request, "path")?;
            let locale = string_field_or(request, "locale", "zh");
            let short_date = string_field_opt(request, "shortDateFormat");
            let mut guard = sessions().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let sessions = guard.get_or_insert_with(WorkbookSessions::new);
            to_value(sessions.open_with_locale(
                Path::new(&path),
                &locale,
                short_date.as_deref(),
            ))
        }
        "create_blank" => {
            // Shell 新建空白表格：生成真实空 xlsx 并开引擎会话（与打开文件同链路）。
            let path = string_field(request, "path")?;
            let sheet_name = string_field_or(request, "sheetName", "Sheet1");
            let mut guard = sessions().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let sessions = guard.get_or_insert_with(WorkbookSessions::new);
            to_value(sessions.create_blank(Path::new(&path), &sheet_name))
        }
        "read_range" => {
            let session_id = string_field(request, "sessionId")?;
            let sheet_id = string_field(request, "sheetId")?;
            let range_value = request
                .get("range")
                .ok_or_else(|| SidecarError::InvalidRequest("Missing range.".into()))?;
            let range: CellRange = serde_json::from_value(range_value.clone())
                .map_err(|error| SidecarError::InvalidRequest(error.to_string()))?;
            let mut guard = sessions().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let sessions = guard
                .as_mut()
                .ok_or_else(|| SidecarError::InvalidRequest("No open workbook session.".into()))?;
            to_value(sessions.read_range(&session_id, &sheet_id, &range))
        }
        "read_formula_cells" => {
            let session_id = string_field(request, "sessionId")?;
            let sheet_id = string_field(request, "sheetId")?;
            let mut guard = sessions().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let sessions = guard
                .as_mut()
                .ok_or_else(|| SidecarError::InvalidRequest("No open workbook session.".into()))?;
            to_value(sessions.read_formula_cells(&session_id, &sheet_id))
        }
        "read_media" => {
            let session_id = string_field(request, "sessionId")?;
            let visual_id = string_field(request, "visualId")?;
            let guard = sessions().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let sessions = guard
                .as_ref()
                .ok_or_else(|| SidecarError::InvalidRequest("No open workbook session.".into()))?;
            to_value(sessions.read_media(&session_id, &visual_id))
        }
        "close" => {
            let session_id = string_field(request, "sessionId")?;
            let mut guard = sessions().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let sessions = guard
                .as_mut()
                .ok_or_else(|| SidecarError::InvalidRequest("No open workbook session.".into()))?;
            to_value(sessions.close(&session_id).map(|()| json!({ "closed": true })))
        }
        "save_cells" => {
            // M5 v1 save: cell-value edits -> new snapshot + reopened session.
            let session_id = string_field(request, "sessionId")?;
            let target_path = string_field(request, "targetPath")?;
            let edits: Vec<crate::CellEdit> = request
                .get("edits")
                .cloned()
                .ok_or_else(|| SidecarError::InvalidRequest("Missing edits.".into()))
                .and_then(|value| {
                    serde_json::from_value(value)
                        .map_err(|error| SidecarError::InvalidRequest(error.to_string()))
                })?;
            // M6.2 structural ops（可选）：insert/remove rows/cols + merge/unmerge。
            let structural_ops_value = request.get("structuralOps").cloned().unwrap_or_else(|| json!([]));
            let structural_ops: Vec<crate::StructuralOp> = serde_json::from_value(structural_ops_value)
                .map_err(|error| SidecarError::InvalidRequest(error.to_string()))?;
            let mut guard = sessions().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let sessions = guard
                .as_mut()
                .ok_or_else(|| SidecarError::InvalidRequest("No open workbook session.".into()))?;
            to_value(sessions.save_cells_with_structural(
                &session_id,
                Path::new(&target_path),
                &edits,
                &structural_ops,
                false,
            ))
        }
        "save_cells_keep_old" => {
            // Harmony shell save: swap = exactly the M5 path, but the source
            // session stays open until the host's write-back to the user URI
            // succeeds (a canceled Save-As / failed write-back must not
            // orphan the renderer's session id — the retry keeps working).
            let session_id = string_field(request, "sessionId")?;
            let target_path = string_field(request, "targetPath")?;
            let edits: Vec<crate::CellEdit> = request
                .get("edits")
                .cloned()
                .ok_or_else(|| SidecarError::InvalidRequest("Missing edits.".into()))
                .and_then(|value| {
                    serde_json::from_value(value)
                        .map_err(|error| SidecarError::InvalidRequest(error.to_string()))
                })?;
            // M6.2 structural ops（可选）
            let structural_ops_value = request.get("structuralOps").cloned().unwrap_or_else(|| json!([]));
            let structural_ops: Vec<crate::StructuralOp> = serde_json::from_value(structural_ops_value)
                .map_err(|error| SidecarError::InvalidRequest(error.to_string()))?;
            let mut guard = sessions().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let sessions = guard
                .as_mut()
                .ok_or_else(|| SidecarError::InvalidRequest("No open workbook session.".into()))?;
            to_value(sessions.save_cells_with_structural(
                &session_id,
                Path::new(&target_path),
                &edits,
                &structural_ops,
                true,
            ))
        }
        "save_sheet_ops" => {
            // M11 多 sheet 操作：sheetOps[{kind,sheetId,name,sourceSheetId,newName,hidden}]
            // + sheetOrder[] + 可选 edits/structuralOps → save_cells_with_sheet_ops。
            let session_id = string_field(request, "sessionId")?;
            let target_path = string_field(request, "targetPath")?;
            let edits_value = request.get("edits").cloned().unwrap_or_else(|| json!([]));
            let edits: Vec<crate::CellEdit> = serde_json::from_value(edits_value)
                .map_err(|error| SidecarError::InvalidRequest(error.to_string()))?;
            let structural_value = request.get("structuralOps").cloned().unwrap_or_else(|| json!([]));
            let structural: Vec<crate::StructuralOp> = serde_json::from_value(structural_value)
                .map_err(|error| SidecarError::InvalidRequest(error.to_string()))?;
            let sheet_ops_value = request.get("sheetOps").cloned().unwrap_or_else(|| json!([]));
            let sheet_ops: Vec<crate::SheetOp> = serde_json::from_value(sheet_ops_value)
                .map_err(|error| SidecarError::InvalidRequest(error.to_string()))?;
            let order_value = request.get("sheetOrder").cloned().unwrap_or_else(|| json!([]));
            let sheet_order: Vec<String> = serde_json::from_value(order_value)
                .map_err(|error| SidecarError::InvalidRequest(error.to_string()))?;
            let keep_old = bool_field(request, "keepOld")?;
            let mut guard = sessions().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let sessions = guard
                .as_mut()
                .ok_or_else(|| SidecarError::InvalidRequest("No open workbook session.".into()))?;
            to_value(sessions.save_cells_with_sheet_ops(
                &session_id,
                Path::new(&target_path),
                &edits,
                &structural,
                &sheet_ops,
                &sheet_order,
                keep_old,
            ))
        }
        "recalc_cells" => {
            // 公式重算（renderer recalcWorkbook）：edits[{sheetId,row,column,input}]
            // + reads[{sheetId,range}] → 返回重算后的单元格显示值。
            let session_id = string_field(request, "sessionId")?;
            let edits_value = request.get("edits").cloned().unwrap_or_else(|| json!([]));
            let edits: Vec<crate::recalc::RecalcEdit> = serde_json::from_value(edits_value)
                .map_err(|error| SidecarError::InvalidRequest(error.to_string()))?;
            let reads_value = request.get("reads").cloned().unwrap_or_else(|| json!([]));
            let reads: Vec<crate::recalc::RecalcRead> = serde_json::from_value(reads_value)
                .map_err(|error| SidecarError::InvalidRequest(error.to_string()))?;
            let mut guard = sessions().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let sessions = guard
                .as_mut()
                .ok_or_else(|| SidecarError::InvalidRequest("No open workbook session.".into()))?;
            to_value(sessions.recalc_cells(&session_id, &edits, &reads))
        }
        "archive_manifest" => {
            let path = string_field(request, "path")?;
            to_value(crate::archive::archive_manifest(Path::new(&path))
                .map(|entries| json!({ "entries": entries })))
        }
        "read_entries" => {
            let path = string_field(request, "path")?;
            let output_dir = string_field(request, "outputDir")?;
            let entries = string_list_field(request, "entries")?;
            to_value(crate::archive::read_entries_to_dir(
                Path::new(&path),
                &entries,
                Path::new(&output_dir),
            )
            .map(|extracted| json!({ "entries": extracted })))
        }
        "scan_entries" => {
            let path = string_field(request, "path")?;
            let needle = string_field(request, "needle")?;
            let entries = string_list_field(request, "entries")?;
            to_value(crate::archive::scan_entries_for_text(Path::new(&path), &entries, &needle)
                .map(|matches| json!({ "matches": matches })))
        }
        "save_archive" => {
            let source_path = string_field(request, "sourcePath")?;
            let target_path = string_field(request, "targetPath")?;
            let replacements = entry_contents(request, "replacements")?;
            let removals = string_list_field(request, "removals")?;
            let additions = entry_contents(request, "additions")?;
            to_value(crate::archive::save_archive(
                Path::new(&source_path),
                Path::new(&target_path),
                &replacements,
                &removals,
                &additions,
            ))
        }
        "convert_workbook" => {
            let path = string_field(request, "path")?;
            let target_path = string_field(request, "targetPath")?;
            crate::convert::convert_to_xlsx(Path::new(&path), Path::new(&target_path))
                .map(|result| json!({ "sheets": result.sheets, "cells": result.cells }))
        }
        "recalc_cells" => Err(SidecarError::InvalidRequest(
            "recalc_cells is unavailable in the in-process bridge.".into(),
        )),
        other => Err(SidecarError::InvalidRequest(format!(
            "Unknown sidecar command: {other}"
        ))),
    }
}

// ---------------------------------------------------------------------------
// Value plumbing
// ---------------------------------------------------------------------------

fn success(request_id: String, result: Value) -> String {
    serde_json::to_string(&json!({
        "version": PROTOCOL_VERSION,
        "requestId": request_id,
        "ok": true,
        "result": result,
    }))
    .unwrap_or_else(|_| String::new())
}

fn failure(request_id: String, code: &str, message: String) -> String {
    serde_json::to_string(&json!({
        "version": PROTOCOL_VERSION,
        "requestId": request_id,
        "ok": false,
        "error": { "code": code, "message": message },
    }))
    .unwrap_or_else(|_| String::new())
}

fn to_value<T: serde::Serialize>(result: Result<T, SidecarError>) -> Result<Value, SidecarError> {
    result
        .map(|value| serde_json::to_value(value))
        .map_err(SidecarError::from)?
        .map_err(SidecarError::from)
}

fn string_field(request: &Value, key: &str) -> Result<String, SidecarError> {
    request
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| SidecarError::InvalidRequest(format!("Missing {key}.")))
}

fn string_field_or(request: &Value, key: &str, default: &str) -> String {
    request
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or(default)
        .to_owned()
}

fn string_field_opt(request: &Value, key: &str) -> Option<String> {
    request.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn string_list_field(request: &Value, key: &str) -> Result<Vec<String>, SidecarError> {
    request
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .ok_or_else(|| SidecarError::InvalidRequest(format!("Missing {key}.")))
}

fn bool_field(request: &Value, key: &str) -> Result<bool, SidecarError> {
    request
        .get(key)
        .and_then(Value::as_bool)
        .ok_or_else(|| SidecarError::InvalidRequest(format!("Missing {key}.")))
}

fn entry_contents(
    request: &Value,
    key: &str,
) -> Result<Vec<crate::archive::EntryContent>, SidecarError> {
    request
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    serde_json::from_value::<crate::archive::EntryContent>(item.clone()).ok()
                })
                .collect::<Vec<_>>()
        })
        .ok_or_else(|| SidecarError::InvalidRequest(format!("Missing {key}.")))
}

// ---------------------------------------------------------------------------
// Pure-C ABI entry
// ---------------------------------------------------------------------------
// Called from the C NAPI shim (harmony/entry/src/main/cpp/napi_init.cpp), which
// OUC-compiles the napi_* calls that ArkTS `import 'libxlsx_sidecar.so'` needs.
// Rust stays napi-free so the cdylib links with no unresolved napi_* symbols.

/// One protocol call: `requestJson` in, response JSON out (must be freed via
/// `xlsx_free_c`). Null/invalid request returns null.
#[unsafe(no_mangle)]
pub extern "C" fn xlsx_handle_c(request_ptr: *const c_char) -> *mut c_char {
    if request_ptr.is_null() {
        return std::ptr::null_mut();
    }
    let request = match unsafe { CStr::from_ptr(request_ptr) }.to_str() {
        Ok(text) => text.to_owned(),
        Err(_) => return std::ptr::null_mut(),
    };
    let response = handle_line(&request);
    match CString::new(response) {
        Ok(owned) => owned.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}

/// Releases the string returned by `xlsx_handle_c`. Safe to call with null.
#[unsafe(no_mangle)]
pub extern "C" fn xlsx_free_c(ptr: *mut c_char) {
    if !ptr.is_null() {
        unsafe {
            drop(CString::from_raw(ptr));
        }
    }
}