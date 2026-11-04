// 简写 WordLite - Tauri 2 主进程
// 与 Electron 版保持同一套 window.wordlite API，渲染层代码不改。
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use base64::Engine;
use serde::Deserialize;
use tauri::{Emitter, EventTarget, Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogResult};

#[derive(Default)]
struct WindowDocState {
    dirty: bool,
    allow_close: bool,
    pending_open: Option<String>,
}

#[derive(Default)]
struct AppState {
    windows: Mutex<HashMap<String, WindowDocState>>,
    // 防止同一次拖放/重复事件在短时间内开出一串窗口
    recent_external: Mutex<HashMap<String, std::time::Instant>>,
    selftest_script: Mutex<Option<String>>,
}

impl AppState {
    fn update<R>(&self, label: &str, f: impl FnOnce(&mut WindowDocState) -> R) -> R {
        let mut windows = self.windows.lock().unwrap();
        f(windows.entry(label.to_string()).or_default())
    }

    fn remove(&self, label: &str) {
        self.windows.lock().unwrap().remove(label);
    }
}

static WINDOW_COUNTER: AtomicUsize = AtomicUsize::new(1);

// WebView2 初始化失败时明确提示，而不是直接闪退
#[cfg(windows)]
fn report_startup_error(detail: &str) {
    use windows::core::HSTRING;
    use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
    let message = format!(
        "简写无法启动：WebView2 初始化失败\n\n{detail}\n\n如果程序位于带低完整性标签的目录（如被沙箱工具处理过），请移到普通目录再试。"
    );
    unsafe {
        MessageBoxW(
            None,
            &HSTRING::from(message),
            &HSTRING::from("简写"),
            MB_OK | MB_ICONERROR,
        );
    }
}

#[cfg(not(windows))]
fn report_startup_error(detail: &str) {
    eprintln!("简写无法启动：WebView2 初始化失败\n{detail}");
}

fn next_doc_label() -> String {
    format!("doc-{}", WINDOW_COUNTER.fetch_add(1, Ordering::SeqCst))
}

fn build_document_window(
    app: &tauri::AppHandle,
    label: &str,
    path: Option<String>,
) -> Result<tauri::WebviewWindow, String> {
    // 先记下待打开路径，再建窗口，避免页面先加载完、renderer_ready 取不到路径
    if let Some(path) = path {
        app.state::<AppState>()
            .update(label, |state| state.pending_open = Some(path));
    }

    let window = match tauri::WebviewWindowBuilder::new(
        app,
        label,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("未命名文档 - 简写")
    .inner_size(1160.0, 860.0)
    .min_inner_size(860.0, 600.0)
    .center()
    .build()
    {
        Ok(window) => window,
        Err(error) => {
            app.state::<AppState>().remove(label);
            return Err(error.to_string());
        }
    };
    let _ = window.set_focus();
    Ok(window)
}

// 外部打开（拖入、右键“打开方式”、第二实例）总是新建独立窗口，方便并排对比
fn create_document_window(
    app: &tauri::AppHandle,
    path: Option<String>,
) -> Result<tauri::WebviewWindow, String> {
    if app.webview_windows().len() >= 20 {
        return Err("已打开太多窗口，请先关闭一些窗口".into());
    }
    let label = next_doc_label();
    build_document_window(app, &label, path)
}

// 把孤儿自动保存文件挂到新窗口的 label 上，再建窗口；渲染层启动时会询问是否恢复
fn create_recovery_window(app: &tauri::AppHandle, source: &Path) -> Result<(), String> {
    if app.webview_windows().len() >= 20 {
        return Err("已打开太多窗口，请先关闭一些窗口".into());
    }
    let label = next_doc_label();
    let target = autosave_path(app, &label)?;
    std::fs::rename(source, &target).map_err(|error| error.to_string())?;
    build_document_window(app, &label, None).map(|_| ())
}

// 从命令行参数里找要打开的文档（资源管理器“打开方式”/双击关联文件）
fn document_path_from_args<I: IntoIterator<Item = String>>(args: I) -> Option<String> {
    for arg in args {
        if arg.starts_with('-') {
            continue;
        }
        let path = PathBuf::from(&arg);
        if !path.is_file() {
            continue;
        }
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase());
        if matches!(extension.as_deref(), Some("docx") | Some("txt")) {
            return Some(arg);
        }
    }
    None
}

#[derive(Deserialize)]
struct FileFilter {
    name: String,
    extensions: Vec<String>,
}

fn autosave_path(app: &tauri::AppHandle, label: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(format!("autosave-{label}.json")))
}

fn add_filters(
    mut builder: tauri_plugin_dialog::FileDialogBuilder<tauri::Wry>,
    filters: Option<Vec<FileFilter>>,
) -> tauri_plugin_dialog::FileDialogBuilder<tauri::Wry> {
    if let Some(filters) = filters {
        for filter in filters {
            let extensions: Vec<String> = filter.extensions;
            let refs: Vec<&str> = extensions.iter().map(String::as_str).collect();
            builder = builder.add_filter(filter.name.as_str(), &refs);
        }
    }
    builder
}

#[tauri::command(rename_all = "camelCase")]
async fn show_open_dialog(
    window: tauri::WebviewWindow,
    filters: Option<Vec<FileFilter>>,
) -> Result<Option<String>, String> {
    // 挂到主窗口下：文件对话框始终显示在应用窗口之上，但不做全局置顶
    let builder = add_filters(window.dialog().file().set_parent(&window), filters);
    Ok(builder.blocking_pick_file().map(|path| path.to_string()))
}

#[tauri::command(rename_all = "camelCase")]
async fn show_save_dialog(
    window: tauri::WebviewWindow,
    default_path: Option<String>,
    filters: Option<Vec<FileFilter>>,
) -> Result<Option<String>, String> {
    let requested = default_path.unwrap_or_else(|| "未命名文档.docx".into());
    let path = PathBuf::from(&requested);
    let mut builder = window.dialog().file().set_title("另存为").set_parent(&window);

    if path.is_absolute() {
        if let Some(directory) = path.parent() {
            builder = builder.set_directory(directory);
        }
        if let Some(name) = path.file_name() {
            builder = builder.set_file_name(name.to_string_lossy().to_string());
        }
    } else {
        if let Ok(directory) = window.path().document_dir() {
            builder = builder.set_directory(directory);
        }
        builder = builder.set_file_name(requested);
    }

    let builder = add_filters(builder, filters);
    Ok(builder.blocking_save_file().map(|path| path.to_string()))
}

// 与 Electron 版一致的文本编码识别：UTF-8(BOM)/UTF-16LE/BE/GBK
fn decode_text(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(&bytes[3..]).into_owned();
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return decode_utf16(&bytes[2..], true);
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return decode_utf16(&bytes[2..], false);
    }
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_string(),
        Err(_) => {
            let (text, _, _) = encoding_rs::GBK.decode(bytes);
            text.into_owned()
        }
    }
}

fn decode_utf16(bytes: &[u8], little_endian: bool) -> String {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| {
            if little_endian {
                u16::from_le_bytes([pair[0], pair[1]])
            } else {
                u16::from_be_bytes([pair[0], pair[1]])
            }
        })
        .collect();
    String::from_utf16_lossy(&units)
}

#[tauri::command(rename_all = "camelCase")]
async fn read_file(file_path: String, binary: bool) -> Result<String, String> {
    let bytes = std::fs::read(&file_path).map_err(|e| e.to_string())?;
    if binary {
        Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
    } else {
        Ok(decode_text(&bytes))
    }
}

// 原子写入：先写同目录临时文件并落盘，再 rename 覆盖，避免崩溃时留下半截文件
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut temp = path.as_os_str().to_os_string();
    temp.push(".wltmp");
    let temp = PathBuf::from(temp);
    let result = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::create(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temp, path)
    })();
    result.map_err(|error| {
        let _ = std::fs::remove_file(&temp);
        error.to_string()
    })
}

#[tauri::command(rename_all = "camelCase")]
async fn write_file(file_path: String, data: String, binary: bool) -> Result<(), String> {
    let bytes = if binary {
        base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|e| e.to_string())?
    } else {
        data.into_bytes()
    };
    write_atomic(Path::new(&file_path), &bytes)
}

#[tauri::command]
async fn read_autosave(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Option<serde_json::Value>, String> {
    let path = autosave_path(&app, window.label())?;
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map(Some).map_err(|e| e.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
async fn write_autosave(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    payload: serde_json::Value,
) -> Result<(), String> {
    let path = autosave_path(&app, window.label())?;
    if let Some(directory) = path.parent() {
        std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    }
    let bytes = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;
    write_atomic(&path, &bytes)
}

#[tauri::command]
async fn clear_autosave(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    let path = autosave_path(&app, window.label())?;
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn is_doc_label(label: &str) -> bool {
    label
        .strip_prefix("doc-")
        .is_some_and(|number| !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit()))
}

fn orphan_autosave_labels(app: &tauri::AppHandle) -> Result<Vec<String>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let mut labels = Vec::new();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(labels);
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(label) = name
            .strip_prefix("autosave-")
            .and_then(|rest| rest.strip_suffix(".json"))
        else {
            continue;
        };
        if !is_doc_label(label) || app.get_webview_window(label).is_some() {
            continue;
        }
        labels.push(label.to_string());
    }
    labels.sort();
    Ok(labels)
}

#[tauri::command]
fn list_orphan_autosaves(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    orphan_autosave_labels(&app)
}

#[tauri::command(rename_all = "camelCase")]
async fn restore_orphan_autosave(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if !is_doc_label(&label) {
        return Err("无效的备份标签".into());
    }
    if app.get_webview_window(&label).is_some() {
        return Ok(());
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let source = dir.join(format!("autosave-{label}.json"));
    if !source.is_file() {
        return Ok(());
    }
    create_recovery_window(&app, &source)
}

#[tauri::command]
async fn confirm_action(window: tauri::WebviewWindow, message: String) -> Result<bool, String> {
    // 拖放打开时应用窗口可能刚失去焦点：先还原并聚焦，再把对话框挂到窗口下。
    // owner 关系只保证压在主窗口之上，不会全局置顶。
    let _ = window.unminimize();
    let _ = window.set_focus();
    Ok(window
        .dialog()
        .message(message)
        .title("简写")
        .parent(&window)
        .buttons(MessageDialogButtons::OkCancelCustom("是".into(), "否".into()))
        .blocking_show())
}

// 应用内打开/新建时的三选一：保存 / 不保存 / 取消
#[tauri::command]
async fn confirm_save_changes(window: tauri::WebviewWindow) -> Result<String, String> {
    let _ = window.unminimize();
    let _ = window.set_focus();
    let result = window
        .dialog()
        .message("当前文档有未保存的更改。")
        .title("简写")
        .parent(&window)
        .buttons(MessageDialogButtons::YesNoCancelCustom(
            "保存".into(),
            "不保存".into(),
            "取消".into(),
        ))
        .blocking_show_with_result();
    // rfd 的自定义按钮在 Windows 上返回 Custom(按钮文字)，不是 Yes/No/Cancel
    Ok(match result {
        MessageDialogResult::Yes => "save",
        MessageDialogResult::Custom(label) if label == "保存" => "save",
        MessageDialogResult::No => "discard",
        MessageDialogResult::Custom(label) if label == "不保存" => "discard",
        _ => "cancel",
    }
    .to_string())
}

// 拖入/右键“打开方式”的入口：新建独立窗口
#[tauri::command(rename_all = "camelCase")]
async fn open_external(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let now = std::time::Instant::now();
    let state = app.state::<AppState>();
    {
        let mut recent = state.recent_external.lock().unwrap();
        if let Some(last) = recent.get(&path) {
            if now.duration_since(*last) < std::time::Duration::from_millis(1500) {
                return Ok(());
            }
        }
        recent.insert(path.clone(), now);
        recent.retain(|_, at| now.duration_since(*at) < std::time::Duration::from_secs(30));
    }
    create_document_window(&app, Some(path)).map(|_| ())
}

#[tauri::command(rename_all = "camelCase")]
fn set_document_state(
    window: tauri::WebviewWindow,
    state: State<AppState>,
    dirty: bool,
    file_name: String,
) {
    let label = window.label().to_string();
    state.update(&label, |doc| doc.dirty = dirty);
    let prefix = if dirty { "*" } else { "" };
    let _ = window.set_title(&format!("{prefix}{file_name} - 简写"));
}

#[tauri::command]
fn renderer_ready(window: tauri::WebviewWindow, state: State<AppState>) -> Result<(), String> {
    let label = window.label().to_string();
    let pending = state.update(&label, |doc| doc.pending_open.take());
    if let Some(path) = pending {
        window
            .emit_to(
                EventTarget::webview_window(window.label()),
                "open-file-path",
                path,
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn close_after_save(window: tauri::WebviewWindow, state: State<AppState>) -> Result<(), String> {
    let label = window.label().to_string();
    state.update(&label, |doc| doc.allow_close = true);
    window.close().map_err(|e| e.to_string())
}

// 打印先走 WebView 自带的打印对话框；页码/份数交给系统打印面板
#[tauri::command(rename_all = "camelCase")]
fn print_document(window: tauri::WebviewWindow, options: serde_json::Value) -> Result<(), String> {
    let _ = options;
    window.eval("window.print()").map_err(|e| e.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageMetrics {
    page_width: f64,
    page_height: f64,
    margin_top: f64,
    margin_right: f64,
    margin_bottom: f64,
    margin_left: f64,
}

impl Default for PageMetrics {
    fn default() -> Self {
        Self {
            page_width: 21.0,
            page_height: 29.7,
            margin_top: 2.54,
            margin_right: 3.18,
            margin_bottom: 2.54,
            margin_left: 3.18,
        }
    }
}

// Windows：WebView2 原生 PrintToPdf，纸张尺寸/边距用渲染层 @page 里的厘米值
#[cfg(windows)]
fn print_to_pdf_file(
    window: &tauri::WebviewWindow,
    file_path: &str,
    page: &PageMetrics,
) -> Result<(), String> {
    use std::sync::mpsc;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_7, ICoreWebView2Environment6,
    };
    use webview2_com::PrintToPdfCompletedHandler;
    use windows::core::{Interface, HSTRING};

    const CM_PER_INCH: f64 = 2.54;
    let width = page.page_width / CM_PER_INCH;
    let height = page.page_height / CM_PER_INCH;
    let top = page.margin_top / CM_PER_INCH;
    let right = page.margin_right / CM_PER_INCH;
    let bottom = page.margin_bottom / CM_PER_INCH;
    let left = page.margin_left / CM_PER_INCH;

    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    let target = file_path.to_string();

    window
        .with_webview(move |webview| {
            let tx_error = tx.clone();
            let setup = (move || -> Result<(), String> {
                let controller = webview.controller();
                let core = unsafe { controller.CoreWebView2() }.map_err(|e| e.to_string())?;
                let core7: ICoreWebView2_7 = core.cast().map_err(|e| e.to_string())?;
                let environment: ICoreWebView2Environment6 =
                    webview.environment().cast().map_err(|e| e.to_string())?;
                let settings = unsafe { environment.CreatePrintSettings() }
                    .map_err(|e| e.to_string())?;
                unsafe {
                    settings
                        .SetShouldPrintBackgrounds(true)
                        .map_err(|e| e.to_string())?;
                    settings
                        .SetShouldPrintHeaderAndFooter(false)
                        .map_err(|e| e.to_string())?;
                    settings.SetPageWidth(width).ok();
                    settings.SetPageHeight(height).ok();
                    settings.SetMarginTop(top).ok();
                    settings.SetMarginRight(right).ok();
                    settings.SetMarginBottom(bottom).ok();
                    settings.SetMarginLeft(left).ok();
                }
                let path = HSTRING::from(target.as_str());
                let handler = PrintToPdfCompletedHandler::create(Box::new(move |error, success| {
                    let outcome = match error {
                        Ok(()) if success => Ok(()),
                        Ok(()) => Err("PDF 导出失败（WebView2 返回 false）".to_string()),
                        Err(err) => Err(format!("PDF 导出失败：{err}")),
                    };
                    let _ = tx.send(outcome);
                    Ok(())
                }));
                unsafe { core7.PrintToPdf(&path, &settings, &handler) }
                    .map_err(|e| e.to_string())
            })();
            if let Err(error) = setup {
                let _ = tx_error.send(Err(error));
            }
        })
        .map_err(|e| e.to_string())?;

    rx.recv_timeout(std::time::Duration::from_secs(90))
        .map_err(|_| "PDF 导出超时".to_string())?
}

#[cfg(windows)]
#[tauri::command(rename_all = "camelCase")]
async fn print_to_pdf(
    window: tauri::WebviewWindow,
    page: Option<PageMetrics>,
) -> Result<String, String> {
    let page = page.unwrap_or_default();
    let path = std::env::temp_dir().join(format!("wordlite-{}.pdf", std::process::id()));
    let path_text = path.to_string_lossy().to_string();
    print_to_pdf_file(&window, &path_text, &page)?;
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&path);
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[cfg(windows)]
#[tauri::command(rename_all = "camelCase")]
async fn export_pdf(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    default_path: String,
    page: Option<PageMetrics>,
) -> Result<serde_json::Value, String> {
    let page = page.unwrap_or_default();
    let requested = PathBuf::from(&default_path);
    let mut builder = app.dialog().file().set_title("导出 PDF").set_parent(&window);
    if requested.is_absolute() {
        if let Some(directory) = requested.parent() {
            builder = builder.set_directory(directory);
        }
        if let Some(name) = requested.file_name() {
            builder = builder.set_file_name(name.to_string_lossy().to_string());
        }
    } else {
        if let Ok(directory) = app.path().document_dir() {
            builder = builder.set_directory(directory);
        }
        builder = builder.set_file_name(requested.to_string_lossy().to_string());
    }
    builder = builder.add_filter("PDF 文档", &["pdf"]);
    let Some(chosen) = builder.blocking_save_file() else {
        return Ok(serde_json::json!({ "saved": false }));
    };
    let mut file_path = chosen.to_string();
    if !file_path.to_ascii_lowercase().ends_with(".pdf") {
        file_path.push_str(".pdf");
    }
    print_to_pdf_file(&window, &file_path, &page)?;
    Ok(serde_json::json!({ "saved": true, "path": file_path }))
}

#[cfg(not(windows))]
#[tauri::command]
async fn print_to_pdf() -> Result<String, String> {
    Err("macOS 的 PDF 导出将在迁移阶段 3 实现".into())
}

#[cfg(not(windows))]
#[tauri::command(rename_all = "camelCase")]
async fn export_pdf(
    default_path: String,
    page: Option<PageMetrics>,
) -> Result<serde_json::Value, String> {
    let _ = (default_path, page);
    Err("macOS 的 PDF 导出将在迁移阶段 3 实现".into())
}

// 页面加载完成后由渲染层调用，确保 window.__TAURI__ 已注入再执行自测脚本
#[tauri::command]
fn selftest_ready(window: tauri::WebviewWindow, state: State<AppState>) {
    let script = state.selftest_script.lock().unwrap().take();
    if let Some(script) = script {
        let _ = window.eval(script);
    }
}

// 仅用于迁移自测：渲染层把检查结果发回来后打印并退出
#[tauri::command]
fn selftest_report(app: tauri::AppHandle, results: serde_json::Value) {
    let mut results = results;
    if let Some(object) = results.as_object_mut() {
        object.insert(
            "windowCount".into(),
            serde_json::json!(app.webview_windows().len()),
        );
    }
    println!(
        "[selftest] {}",
        serde_json::to_string(&results).unwrap_or_else(|_| "{}".into())
    );
    // 只有以 --selftest 启动时才退出，避免普通运行中被页面调用直接关掉
    if std::env::args().any(|arg| arg == "--selftest") {
        app.exit(0);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 单实例必须第一个注册：第二次启动（右键打开/双击文件）时新建独立窗口
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // 窗口回调里同步建 WebView 在 Windows 上可能死锁，放到异步线程里做
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Some(path) = document_path_from_args(argv) {
                    let _ = create_document_window(&handle, Some(path));
                } else if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                } else if let Some(window) = handle.webview_windows().into_values().next() {
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                } else {
                    let _ = create_document_window(&handle, None);
                }
            });
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .setup(|app| {
            // 接着已有的 doc 自动保存文件编号，避免新窗口的 label 覆盖旧恢复副本
            if let Ok(dir) = app.path().app_data_dir() {
                let mut max = 0;
                if let Ok(entries) = std::fs::read_dir(&dir) {
                    for entry in entries.flatten() {
                        let name = entry.file_name().to_string_lossy().to_string();
                        if let Some(number) = name
                            .strip_prefix("autosave-doc-")
                            .and_then(|rest| rest.strip_suffix(".json"))
                            .and_then(|value| value.parse::<usize>().ok())
                        {
                            max = max.max(number);
                        }
                    }
                }
                WINDOW_COUNTER.store(max + 1, Ordering::SeqCst);
            }
            if let Some(path) = document_path_from_args(std::env::args().skip(1)) {
                app.state::<AppState>()
                    .update("main", |state| state.pending_open = Some(path));
            }
            if std::env::args().any(|arg| arg == "--selftest") {
                let handle = app.handle().clone();
                let long_print = std::env::args().any(|arg| arg == "--long-print");
                let dialog_test = std::env::args().any(|arg| arg == "--dialog-test");
                let probe = std::env::temp_dir().join("wordlite-tauri-selftest.txt");
                let probe_json = serde_json::to_string(&probe.to_string_lossy().to_string())
                    .unwrap_or_else(|_| "\"\"".into());
                let probe_bin = std::env::temp_dir().join("wordlite-tauri-selftest.bin");
                let probe_bin_json = serde_json::to_string(&probe_bin.to_string_lossy().to_string())
                    .unwrap_or_else(|_| "\"\"".into());
                let script = format!(
                    r#"(async () => {{
                        const results = {{}};
                        const editorEl = document.querySelector('.ProseMirror');
                        const withTimeout = (promise, ms) => Promise.race([
                            promise,
                            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
                        ]);
                        try {{
                            results.bridge = !!window.wordlite;
                            results.tauri = !!window.__TAURI__;
                            results.editor = !!editorEl;
                            results.findBar = !!document.querySelector('#findBar');
                            results.startupLoaded = (editorEl?.innerText || '').includes('hello');
                            results.helpTabs = document.querySelectorAll('.help-tab').length;
                            document.querySelector('[data-help-tab="about"]')?.click();
                            results.aboutVisible = !document.querySelector('#help-panel-about')?.hidden;
                            results.aboutVersion = document.querySelector('#helpVersion')?.textContent;
                            if ({dialog_test}) {{
                                try {{
                                    results.dialogChoice = await window.wordlite.file.confirmSaveChanges();
                                }} catch (dialogError) {{
                                    results.dialogError = String(dialogError);
                                }}
                            }}
                            await window.wordlite.file.writeFile({probe}, 'hello', false);
                            results.read = await window.wordlite.file.readFile({probe}, false);
                            await window.wordlite.file.writeFile({probe_bin}, 'aGVsbG8=', true);
                            results.readBinary = await window.wordlite.file.readFile({probe_bin}, true);
                            await window.wordlite.file.writeAutosave({{ token: 'ok' }});
                            results.autosave = (await window.wordlite.file.readAutosave())?.token;
                            await window.wordlite.file.clearAutosave();
                            try {{
                                const pdf = await withTimeout(window.wordlite.file.printToPDF(), 15000);
                                results.pdfLength = pdf.length;
                                results.pdfHeader = atob(pdf).slice(0, 4);
                                results.pageRule = document.querySelector('#printPageStyle')?.textContent;
                            }} catch (pdfError) {{
                                results.pdfError = String(pdfError);
                            }}
                            if ({long_print}) {{
                                try {{
                                    editorEl.focus();
                                    document.execCommand('selectAll', false, null);
                                    document.execCommand('delete', false, null);
                                    document.execCommand('insertHTML', false, '<p>测试分页内容，这是一段用于验证打印预览自动分页的示例文字。</p>'.repeat(600));
                                    await new Promise((resolve) => setTimeout(resolve, 500));
                                    results.longChars = editorEl.innerText.length;
                                    const longPdf = await withTimeout(window.wordlite.file.printToPDF(), 25000);
                                    results.longPdfPages = (atob(longPdf).match(/\/Type\s*\/Page[^s]/g) || []).length;
                                    document.querySelector('#btnPrintPreview')?.click();
                                    await new Promise((resolve) => setTimeout(resolve, 500));
                                    results.previewPages = document.querySelectorAll('.preview-page').length;
                                    results.previewMeta = document.querySelector('#previewMeta')?.textContent;
                                    document.querySelector('#printPreviewDialog')?.close();
                                }} catch (longError) {{
                                    results.longError = String(longError);
                                }}
                            }}
                            try {{
                                await withTimeout(window.__TAURI__.core.invoke('open_external', {{ path: {probe} }}), 5000);
                                // 立刻重复一次，验证 1.5 秒内的同路径去重（不应再开窗口）
                                await withTimeout(window.__TAURI__.core.invoke('open_external', {{ path: {probe} }}), 5000);
                                results.openedNewWindow = true;
                            }} catch (openError) {{
                                results.openError = String(openError);
                            }}
                            results.state = 'ok';
                        }} catch (error) {{
                            results.error = String(error);
                        }}
                        window.__TAURI__.core.invoke('selftest_report', {{ results }});
                    }})()"#,
                    probe = probe_json,
                    probe_bin = probe_bin_json,
                    long_print = if long_print { "true" } else { "false" },
                    dialog_test = if dialog_test { "true" } else { "false" }
                );
                let _ = std::fs::write(
                    std::env::temp_dir().join("wordlite-selftest-script.js"),
                    &script,
                );
                *app.state::<AppState>().selftest_script.lock().unwrap() = Some(script);
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(45));
                    println!("[selftest] watchdog timeout");
                    handle.exit(2);
                });
            }
            Ok(())
        })
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                let _ = webview.eval(
                    "if (window.__TAURI__ && window.__TAURI__.core) { window.__TAURI__.core.invoke('selftest_ready') }",
                );
            }
        })
        .invoke_handler(tauri::generate_handler![
            show_open_dialog,
            show_save_dialog,
            read_file,
            write_file,
            read_autosave,
            write_autosave,
            clear_autosave,
            confirm_action,
            confirm_save_changes,
            list_orphan_autosaves,
            restore_orphan_autosave,
            open_external,
            set_document_state,
            renderer_ready,
            close_after_save,
            print_document,
            print_to_pdf,
            export_pdf,
            selftest_ready,
            selftest_report
        ])
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                let state = window.state::<AppState>();
                let label = window.label().to_string();
                let (allow, dirty) = state.update(&label, |doc| (doc.allow_close, doc.dirty));
                if !allow && dirty {
                    api.prevent_close();
                    let _ = window.emit_to(
                        EventTarget::webview_window(label),
                        "save-before-close",
                        (),
                    );
                }
            }
            tauri::WindowEvent::Destroyed => {
                window.state::<AppState>().remove(window.label());
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .unwrap_or_else(|error| {
            report_startup_error(&error.to_string());
            std::process::exit(1);
        });
}
