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
    // 窗口里现在是什么文档（未命名 = 这张纸还没被用过，可以拿来接从访达打开的文件）
    file_name: Option<String>,
}

// macOS 专属的运行时状态：菜单退出流程、访达打开文件的启动期排队
#[cfg(target_os = "macos")]
#[derive(Default)]
struct MacState {
    // 主窗口渲染层是否已经就绪（决定访达打开的文件是排队还是开新窗口）
    main_ready: std::sync::atomic::AtomicBool,
    // ⌘Q 触发的退出流程进行中
    quitting: std::sync::atomic::AtomicBool,
    // 退出流程里还没问过的「有未保存内容」的窗口 label
    quit_dirty: Mutex<Vec<String>>,
    // 没有未保存内容的窗口：等所有 dirty 的都处理完再关。
    // 以前是和 dirty 的混在一个队列里按 label 顺序关，干净窗口会先被静默关掉，
    // 轮到 dirty 的弹框时用户点「取消」，前面那些窗口已经回不来了（§2.4）
    quit_clean: Mutex<Vec<String>>,
    // 最近一次「从系统打开文档」的时刻。开场时 Reopen 和 openURLs 会同时来，
    // Reopen 看到 0 个窗口就先建一张空白纸，紧接着文档又开一个窗口——
    // 用户看到的就是「第一个冒出新建空白窗口」（§2.1）
    last_open_request: Mutex<Option<std::time::Instant>>,
}

#[derive(Default)]
struct AppState {
    windows: Mutex<HashMap<String, WindowDocState>>,
    // 防止同一次拖放/重复事件在短时间内开出一串窗口
    recent_external: Mutex<HashMap<String, std::time::Instant>>,
    selftest_script: Mutex<Option<String>>,
    #[cfg(target_os = "macos")]
    mac: MacState,
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

// Windows 生产版的兜底：从 WebView2 层面关掉浏览器默认右键菜单和浏览器快捷键。
// 渲染层已经拦了 contextmenu 和 F5/Ctrl+R，这里再上一层，防止 WebView2 以后改了事件顺序。
// 只关这几项：Ctrl+C/X/V/Z/Y/A、输入法仍由 Chromium 自己处理。
// Ctrl+滚轮缩放要关掉：v1.1.3 起页面缩放由渲染层自己实现（只缩纸张），
// 留着 WebView2 内建的整页缩放会跟着一起放大，变成双重缩放。
// debug 构建不动，保留默认菜单和开发者工具（R-09）。
#[cfg(windows)]
fn configure_webview_settings(window: &tauri::WebviewWindow) {
    if cfg!(debug_assertions) {
        return;
    }
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Controller, ICoreWebView2PermissionRequestedEventArgs,
        ICoreWebView2Settings3, ICoreWebView2_3, COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ,
        COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    };
    use webview2_com::PermissionRequestedEventHandler;
    use windows::core::Interface;

    let _ = window.with_webview(|webview| {
        let setup = (|| -> Result<(), String> {
            let controller: ICoreWebView2Controller = webview.controller();
            let core: ICoreWebView2_3 = unsafe { controller.CoreWebView2() }
                .and_then(|core| core.cast())
                .map_err(|e| e.to_string())?;
            let settings3: ICoreWebView2Settings3 = unsafe { core.Settings() }
                .and_then(|settings| settings.cast())
                .map_err(|e| e.to_string())?;
            unsafe {
                settings3
                    .SetAreDefaultContextMenusEnabled(false)
                    .map_err(|e| e.to_string())?;
                settings3
                    .SetAreBrowserAcceleratorKeysEnabled(false)
                    .map_err(|e| e.to_string())?;
                // Ctrl+滚轮交给渲染层：内建缩放关掉，否则纸张缩放和整页缩放会叠在一起
                settings3
                    .SetIsZoomControlEnabled(false)
                    .map_err(|e| e.to_string())?;
            }
            // 自定义菜单里的「粘贴」要读剪贴板；WebView2 默认会弹权限框。
            // 只对本地页面（tauri.localhost / tauri://）的「读剪贴板」自动允许，其它照旧。
            let handler = PermissionRequestedEventHandler::create(Box::new(
                move |_sender, args: Option<ICoreWebView2PermissionRequestedEventArgs>| {
                    if let Some(args) = args {
                        let mut kind = COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ;
                        let known = unsafe { args.PermissionKind(&mut kind) }.is_ok();
                        let mut raw = windows::core::PWSTR::null();
                        let page = match unsafe { args.Uri(&mut raw) } {
                            Ok(()) => webview2_com::CoTaskMemPWSTR::from(raw).to_string(),
                            Err(_) => String::new(),
                        };
                        let local_page =
                            page.contains("tauri.localhost") || page.starts_with("tauri://");
                        if known
                            && local_page
                            && kind == COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ
                        {
                            let _ = unsafe { args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW) };
                        }
                    }
                    Ok(())
                },
            ));
            let mut token = 0i64;
            unsafe {
                core.add_PermissionRequested(&handler, &mut token)
                    .map_err(|e| e.to_string())?;
            }
            Ok(())
        })();
        if let Err(error) = setup {
            eprintln!("[wordlite] 配置 WebView2 设置失败：{error}");
        }
    });
}

// macOS：WKWebView 默认允许双指捏合做「整体放大」（allowsMagnification / zoomPageByFactors）。
// 简写没有页面缩放功能，捏合放大后整页会跟着变大、且没有入口还原，
// 触控板在图片/正文上捏一下就中招（§4.4「有没有导致整页缩放：有」）。
// 这里关掉网页缩放，捏合手势就只留下事件，不改变界面比例。
#[cfg(target_os = "macos")]
fn configure_mac_webview(window: &tauri::WebviewWindow) {
    let _ = window.with_webview(|webview| {
        use objc2_web_kit::WKWebView;

        let webview_ptr = webview.inner();
        if webview_ptr.is_null() {
            return;
        }
        // 指针由 tauri 在主线程上给出，只在本闭包里借用
        let wk_webview: &WKWebView = unsafe { &*(webview_ptr as *const WKWebView) };
        unsafe {
            wk_webview.setAllowsMagnification(false);
        }
    });
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
    #[cfg(windows)]
    configure_webview_settings(&window);
    #[cfg(target_os = "macos")]
    {
        configure_mac_webview(&window);
        // 建窗口这一步发生在异步线程里，系统不会自动把新窗口抬到最前
        raise_new_window(app, &window);
    }
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

// 只接管的扩展名：其它文件不抢（访达/命令行都会走这里）
fn supported_document_path(path: &Path) -> Option<String> {
    if !path.is_file() {
        return None;
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase());
    if matches!(extension.as_deref(), Some("docx") | Some("txt")) {
        return Some(path.to_string_lossy().to_string());
    }
    None
}

// 从命令行参数里找要打开的文档（资源管理器“打开方式”/双击关联文件）
// 以 - 开头的参数全部跳过：macOS 启动时会带 -psn_0_12345 这类参数
fn document_path_from_args<I: IntoIterator<Item = String>>(args: I) -> Option<String> {
    // --long-print-file 的值是自测用的样本 txt，不能当成“要打开的文档”
    let mut skip_next = false;
    for arg in args {
        if skip_next {
            skip_next = false;
            continue;
        }
        if arg == "--long-print-file" {
            skip_next = true;
            continue;
        }
        if arg.starts_with('-') {
            continue;
        }
        if let Some(path) = supported_document_path(Path::new(&arg)) {
            return Some(path);
        }
    }
    None
}

// 同一个路径 1.5 秒内只处理一次：拖放、右键“打开方式”、访达双击、argv 可能重复触发
fn take_external_path(state: &AppState, path: &str) -> bool {
    let now = std::time::Instant::now();
    let mut recent = state.recent_external.lock().unwrap();
    if let Some(last) = recent.get(path) {
        if now.duration_since(*last) < std::time::Duration::from_millis(1500) {
            return false;
        }
    }
    recent.insert(path.to_string(), now);
    recent.retain(|_, at| now.duration_since(*at) < std::time::Duration::from_secs(30));
    true
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
    let state = app.state::<AppState>();
    if !take_external_path(&state, &path) {
        return Ok(());
    }
    create_document_window(&app, Some(path)).map(|_| ())
}

// Mac 的 ⌘N：新开一个空窗口，当前窗口的内容和未保存状态都不动。
// 新窗口相对原窗口层叠偏移一点（Mac 惯例），到屏幕边缘再回到工作区左上角。
#[tauri::command]
async fn new_window(app: tauri::AppHandle) -> Result<(), String> {
    let anchor = menu_target_window(&app).map(|window| {
        (
            window.outer_position().ok(),
            window.outer_size().ok(),
            window.scale_factor().unwrap_or(1.0),
            window.current_monitor().ok().flatten(),
        )
    });
    let window = create_document_window(&app, None)?;
    let Some((Some(position), Some(size), scale, monitor)) = anchor else {
        return Ok(());
    };
    let step = (28.0 * scale).round() as i32;
    let mut x = position.x + step;
    let mut y = position.y + step;
    if let Some(monitor) = monitor {
        let area = monitor.work_area();
        let max_x = area.position.x + area.size.width as i32 - size.width as i32;
        let max_y = area.position.y + area.size.height as i32 - size.height as i32;
        if x > max_x {
            x = area.position.x + step;
        }
        if y > max_y {
            y = area.position.y + step;
        }
    }
    let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(x, y)));
    Ok(())
}

// 访达双击 / 拖到 Dock 图标：启动阶段先排进主窗口的 pending_open；
// 主窗口只是一张没用过的空纸时也直接交给它，已经开着文档才新开一个窗口并排对比
#[cfg(target_os = "macos")]
fn open_document_from_system(app: &tauri::AppHandle, path: String) {
    let state = app.state::<AppState>();
    // 先打时间戳再去重：即便这次被 1.5 秒去重挡掉，也说明「有文档正在来的路上」，
    // 单实例回调里的延迟建窗口要靠它让路
    *state.mac.last_open_request.lock().unwrap() = Some(std::time::Instant::now());
    if !take_external_path(&state, &path) {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        // 同一份文件可能先经命令行参数排进主窗口，访达的 openURLs 随后又到。
        // 已经排过了什么都不做，否则会开出第二个窗口（§2.1「新文档 + 真文档」）
        let already = state.update("main", |doc| doc.pending_open.as_deref() == Some(path.as_str()));
        if already {
            return;
        }
        // 主窗口还在显示占位内容（渲染层没报 ready）→ 不管有没有 pending 都只排队。
        // 这里以前只在「没有 pending」时才排队，但 Reopen 抢先生成的那张空白纸
        // 还没就绪，文件被排进去后紧接着又建了一个 doc-* 窗口，两张纸同时出现
        if !state.mac.main_ready.load(Ordering::SeqCst) {
            state.update("main", |doc| doc.pending_open = Some(path.clone()));
            return;
        }
        // 主窗口就绪了但还是空纸（没有文件名或还叫「未命名文档」、没改动过）：收下这份文件。
        // 否则访达双击时会先留下一个空窗口，再额外开一个装文档的窗口
        let file_name = Path::new(&path)
            .file_name()
            .map(|value| value.to_string_lossy().to_string());
        let adopt = state.update("main", |doc| {
            let blank =
                !doc.dirty && doc.file_name.as_deref().map_or(true, |cur| cur == "未命名文档");
            // 顺手占住这张纸：一次打开多个文件时，后到的那个就不会再抢同一个窗口
            if blank {
                doc.file_name = file_name.clone();
            }
            blank
        });
        if adopt {
            let _ = window.emit_to(EventTarget::webview_window("main"), "open-file-path", path);
            return;
        }
    }
    let _ = create_document_window(app, Some(path));
}

// 输入法正在组合时，Mac 的右键（右键点击 / Control+点）会被 WKWebView 的
// NSTextInputContext 当成「点别处」，把还没上屏的拼音就地丢弃：拼音变成一长串字母
// 落进正文、选字框还在但空格/数字都不再生效（§6.1 / §6.2 的全部怪现象都出在这里）。
// 渲染层的 mousedown / contextmenu 拦截只能拦住网页，够不到这一层，
// 所以在这里挂一个 NSEvent 本地监听，只在「组合中」把右键吞掉，组合原样留着。
//
// 判「正在拼拼音」不靠 AppKit 内部状态：v1.1.1 用 NSTextInputContext 的
// hasMarkedText() 去问，真机上恒为 false，拦截等于没装（§6.1 每按必现）。
// 改成渲染层自己上报（compositionstart / compositionend 直接调 set_ime_composing），
// 原生层只读这一个原子标志。这一条链我们自己能验，不赌 WebKit 内部实现。
#[cfg(target_os = "macos")]
static IME_COMPOSING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

// 非 Mac 平台没有这个原生监听，命令只为了让前端调用不 404（Windows 的组合拦截在渲染层）
#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn set_ime_composing(_composing: bool) {}

#[cfg(target_os = "macos")]
#[tauri::command]
fn set_ime_composing(window: tauri::WebviewWindow, composing: bool) {
    use std::sync::atomic::Ordering;
    // 只有键盘窗口能改这个标志：多窗口时别让后台窗口的组合状态误吞前台窗口的右键
    if window.is_focused().unwrap_or(false) {
        IME_COMPOSING.store(composing, Ordering::SeqCst);
    }
}

#[cfg(target_os = "macos")]
fn install_ime_right_click_guard() {
    use block2::RcBlock;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags, NSEventType};
    use std::sync::atomic::Ordering;

    let mtm = match MainThreadMarker::new() {
        Some(mtm) => mtm,
        // 不在主线程时监听装不了；退化成「不拦」，至少不会挡住正常右键
        None => return,
    };
    let block = RcBlock::new(move |event: std::ptr::NonNull<NSEvent>| -> *mut NSEvent {
        let event = unsafe { event.as_ref() };
        let composed = IME_COMPOSING.load(Ordering::SeqCst);
        // Mac 的「右键」有两副面孔：真右键是 RightMouseDown，
        // 触控板/鼠标的 Control+点 走的是 LeftMouseDown + Control 修饰键。
        // 只挡 RightMouseDown 的话 Control+点 照样把拼音打散（§6.1 的主要用法）
        let right_click = event.r#type() == NSEventType::RightMouseDown
            || (event.r#type() == NSEventType::LeftMouseDown
                && event.modifierFlags().contains(NSEventModifierFlags::Control));
        if composed && right_click {
            // 返回 null = 这次事件到此为止，不再派发
            std::ptr::null_mut()
        } else {
            event as *const NSEvent as *mut NSEvent
        }
    });
    // 监听留着就得留住：函数退出后 block 被 drop，监听就会拿到悬空指针
    unsafe {
        let monitor = NSEvent::addLocalMonitorForEventsMatchingMask_handler(
            NSEventMask::RightMouseDown
                | NSEventMask::RightMouseUp
                | NSEventMask::LeftMouseDown,
            &block,
        );
        if let Some(monitor) = monitor {
            // 拆开是无效的：NSEvent 文档要求移除监听时把句柄也释放，
            // 这里索性让它活到进程结束（一个只认指针的短生命周期监听）
            std::mem::forget(monitor);
        }
    }
    let _ = mtm;
}

// 刚建好的 doc-* 窗口：抬到最前并抢键盘焦点。
// tao 的 set_focus 只对「已经是 key window」的窗口 makeKeyAndOrderFront + 激活应用，
// 新窗口 inset 层级低、又常建在后台线程上，所以会停在已打开窗口的后面（§2.1 后半）
#[cfg(target_os = "macos")]
fn raise_new_window(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    use objc2_app_kit::{NSApplication, NSWindow};
    use objc2::MainThreadMarker;

    // 裸指针不是 Send，跨线程只传地址本身；闭包是在主线程上执行的，
    // 窗口此刻一定还活着（刚由我们创建，还没人能关掉它）
    let ns_window = window.ns_window().ok().map(|ptr| ptr as usize);
    let handle = app.clone();
    let label = window.label().to_string();
    let _ = app.run_on_main_thread(move || {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        unsafe {
            let app = NSApplication::sharedApplication(mtm);
            app.activate();
            if let Some(ptr) = ns_window {
                let ns_window: &NSWindow = &*(ptr as *const NSWindow);
                ns_window.makeKeyAndOrderFront(None);
            }
        }
        // 等第一帧画出来再补一次焦点：不占主线程，也留足系统把窗口激活的时间
        let app_for_later = handle.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(120));
            if let Some(window) = app_for_later.get_webview_window(&label) {
                let _ = window.set_focus();
            }
        });
    });
}

#[tauri::command(rename_all = "camelCase")]
fn set_document_state(
    window: tauri::WebviewWindow,
    state: State<AppState>,
    dirty: bool,
    file_name: String,
) {
    let label = window.label().to_string();
    state.update(&label, |doc| {
        doc.dirty = dirty;
        doc.file_name = Some(file_name.clone());
    });
    let prefix = if dirty { "*" } else { "" };
    let _ = window.set_title(&format!("{prefix}{file_name} - 简写"));
}

#[tauri::command]
fn renderer_ready(window: tauri::WebviewWindow, state: State<AppState>) -> Result<(), String> {
    let label = window.label().to_string();
    // 主窗口的渲染层到此可用：之后从访达打开的文件直接开新窗口，不再排队
    #[cfg(target_os = "macos")]
    if label == "main" {
        state.mac.main_ready.store(true, Ordering::SeqCst);
    }
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

// 关闭流程被渲染层取消（三选一里选了“取消”）。Windows 上没有退出流程，什么也不做。
#[tauri::command]
fn close_cancelled(state: State<AppState>) {
    #[cfg(target_os = "macos")]
    {
        state.mac.quitting.store(false, Ordering::SeqCst);
        state.mac.quit_dirty.lock().unwrap().clear();
        state.mac.quit_clean.lock().unwrap().clear();
    }
    #[cfg(not(target_os = "macos"))]
    let _ = &state;
}

#[tauri::command]
fn close_after_save(window: tauri::WebviewWindow, state: State<AppState>) -> Result<(), String> {
    let label = window.label().to_string();
    state.update(&label, |doc| doc.allow_close = true);
    window.close().map_err(|e| e.to_string())
}

// 打印走系统打印面板；macOS 用 WKWebView 自带的打印（eval window.print() 在 WKWebView 里不弹面板）
#[tauri::command]
fn print_document(window: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        window.print().map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        window.eval("window.print()").map_err(|e| e.to_string())
    }
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

// 只读尾部 1KB 找 %%EOF：CoreGraphics 逐页写盘，多页文档中途停顿时不能只看大小不变
#[cfg(target_os = "macos")]
fn pdf_tail_has_eof(path: &str) -> bool {
    use std::io::{Read, Seek, SeekFrom};

    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let Ok(size) = file.metadata().map(|metadata| metadata.len()) else {
        return false;
    };
    let tail = size.min(1024);
    if tail == 0 || file.seek(SeekFrom::Start(size - tail)).is_err() {
        return false;
    }
    let mut buffer = Vec::with_capacity(tail as usize);
    if file.take(tail).read_to_end(&mut buffer).is_err() {
        return false;
    }
    buffer.windows(5).any(|window| window == b"%%EOF")
}

// macOS：NSPrintOperation 以「保存到文件」的方式导出。边距交给渲染层的 @page，这里全设 0，避免双重边距。
// 同步的 runOperation 在 WKWebView 上会输出空白页，所以用模态异步版本，完成信号靠轮询产物。
#[cfg(target_os = "macos")]
fn print_to_pdf_file(
    window: &tauri::WebviewWindow,
    file_path: &str,
    page: &PageMetrics,
) -> Result<(), String> {
    use objc2::rc::autoreleasepool;
    use objc2_app_kit::{NSPrintInfo, NSPrintJobSavingURL, NSPrintSaveJob, NSWindow};
    use objc2_foundation::{NSString, NSSize, NSURL};
    use objc2_web_kit::WKWebView;

    const CM_PER_INCH: f64 = 2.54;
    let to_pt = |cm: f64| cm * 72.0 / CM_PER_INCH;
    let paper = NSSize::new(to_pt(page.page_width), to_pt(page.page_height));

    let target = file_path.to_string();
    // 先打到同目录的临时文件，写完再改名覆盖目标：覆盖已有 PDF 时不会被旧文件的大小误导
    let temp_path = format!("{target}.wltmp.pdf");
    let _ = std::fs::remove_file(&temp_path);
    let temp_for_print = temp_path.clone();
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();

    window
        .with_webview(move |webview| {
            let outcome = autoreleasepool(|_pool| -> Result<(), String> {
                let webview_ptr = webview.inner();
                let window_ptr = webview.ns_window();
                if webview_ptr.is_null() || window_ptr.is_null() {
                    return Err("拿不到 WKWebView / NSWindow 句柄".to_string());
                }
                // 指针由 tauri 在主线程上给出，只在本闭包里借用
                let wk_webview: &WKWebView = unsafe { &*(webview_ptr as *const WKWebView) };
                let ns_window: &NSWindow = unsafe { &*(window_ptr as *const NSWindow) };

                let print_info = NSPrintInfo::new();
                print_info.setPaperSize(paper);
                print_info.setLeftMargin(0.0);
                print_info.setRightMargin(0.0);
                print_info.setTopMargin(0.0);
                print_info.setBottomMargin(0.0);
                print_info.setHorizontallyCentered(false);
                print_info.setVerticallyCentered(false);
                print_info.setJobDisposition(unsafe { NSPrintSaveJob });

                // 输出文件走 NSPrintJobSavingURL；objc2 没生成 setValue:forKey:，直接发消息写字典
                let url = NSURL::fileURLWithPath(&NSString::from_str(&temp_for_print));
                let dictionary = unsafe { print_info.dictionary() };
                unsafe {
                    let _: () = objc2::msg_send![
                        &*dictionary,
                        setObject: &*url,
                        forKey: NSPrintJobSavingURL
                    ];
                }

                let operation = unsafe { wk_webview.printOperationWithPrintInfo(&print_info) };
                operation.setShowsPrintPanel(false);
                operation.setShowsProgressPanel(false);
                // 打印操作的 view 要手动设成 webview 的 bounds，否则输出空白页
                if let Some(print_view) = operation.view() {
                    print_view.setFrame(wk_webview.bounds());
                }
                unsafe {
                    operation.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
                        ns_window,
                        None,
                        None,
                        std::ptr::null_mut(),
                    );
                }
                // 模态打印在事件循环里继续跑，operation 必须活到结束，这里故意不释放
                std::mem::forget(operation);
                Ok(())
            });
            let _ = tx.send(outcome);
        })
        .map_err(|e| format!("访问 webview 失败：{e}"))?;

    let started = rx
        .recv_timeout(std::time::Duration::from_secs(10))
        .map_err(|_| "启动打印超时".to_string())?;
    if let Err(error) = started {
        let _ = std::fs::remove_file(&temp_path);
        return Err(error);
    }

    // 大小连续 300ms 不变且尾部有 %%EOF 才算写完，最多等 20 秒
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    let mut last_size = 0u64;
    let mut stable = 0u32;
    let mut finished = false;
    while std::time::Instant::now() < deadline {
        if let Ok(metadata) = std::fs::metadata(&temp_path) {
            let size = metadata.len();
            if size > 0 && size == last_size {
                stable += 1;
                if stable >= 3 && pdf_tail_has_eof(&temp_path) {
                    finished = true;
                    break;
                }
            } else {
                stable = 0;
                last_size = size;
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    if !finished {
        let _ = std::fs::remove_file(&temp_path);
        return Err("PDF 导出超时".to_string());
    }
    // 写完才替换目标文件，旧 PDF 不会在新文件写一半时被覆盖
    if let Err(error) = std::fs::rename(&temp_path, file_path) {
        let _ = std::fs::remove_file(&temp_path);
        return Err(format!("PDF 导出失败：无法替换目标文件（{error}）"));
    }
    Ok(())
}

// 其他平台没有实现，保持迁移阶段 3 之前的行为
#[cfg(not(any(windows, target_os = "macos")))]
fn print_to_pdf_file(
    window: &tauri::WebviewWindow,
    file_path: &str,
    page: &PageMetrics,
) -> Result<(), String> {
    let _ = (window, file_path, page);
    Err("当前平台不支持 PDF 导出".into())
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

// ---- 菜单命令 ----

// 菜单项统一发 menu-command 给当前窗口，由渲染层分发到已有函数
fn menu_target_window(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    if let Some(window) = app
        .webview_windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false))
    {
        return Some(window);
    }
    if let Some(window) = app.get_webview_window("main") {
        return Some(window);
    }
    let mut windows: Vec<tauri::WebviewWindow> = app.webview_windows().into_values().collect();
    windows.sort_by(|a, b| a.label().cmp(b.label()));
    windows.into_iter().next()
}

fn emit_menu_command(app: &tauri::AppHandle, id: &str) {
    let Some(window) = menu_target_window(app) else {
        return;
    };
    let _ = window.emit_to(
        EventTarget::webview_window(window.label()),
        "menu-command",
        id.to_string(),
    );
}

fn handle_menu_event(app: &tauri::AppHandle, id: &str) {
    #[cfg(target_os = "macos")]
    if id == "quit" {
        begin_quit(app);
        return;
    }
    // 没有任何窗口时，新建和打开都只是开一个空窗口
    if matches!(id, "new" | "open") && app.webview_windows().is_empty() {
        let _ = create_document_window(app, None);
        return;
    }
    // 系统自带项（关于/服务/隐藏/剪切/复制/粘贴/全选/最小化…）由 AppKit 自己处理，
    // 只把约定里的 id 转发给渲染层
    const COMMAND_IDS: [&str; 11] = [
        "new",
        "open",
        "save",
        "saveAs",
        "exportPdf",
        "print",
        "undo",
        "redo",
        "find",
        "replace",
        "help",
    ];
    if !COMMAND_IDS.contains(&id) {
        return;
    }
    emit_menu_command(app, id);
}

// ---- macOS 菜单栏（Windows 不建菜单，行为保持原样） ----
#[cfg(target_os = "macos")]
fn build_app_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};

    // 自定义项：点击后把 id 发给当前窗口。
    // 撤销/重做必须是自定义项，用系统 undo: 会绕过 TipTap 自己的历史记录。
    fn custom(
        app: &tauri::AppHandle,
        id: &str,
        text: &str,
        accelerator: Option<&str>,
    ) -> tauri::Result<tauri::menu::MenuItem<tauri::Wry>> {
        let mut builder = MenuItemBuilder::with_id(id, text);
        if let Some(accelerator) = accelerator {
            builder = builder.accelerator(accelerator);
        }
        builder.build(app)
    }

    let app_menu = SubmenuBuilder::new(app, "简写")
        .about_with_text("关于简写", None)
        .separator()
        .services_with_text("服务")
        .separator()
        .hide_with_text("隐藏简写")
        .hide_others_with_text("隐藏其他")
        .show_all_with_text("全部显示")
        .separator()
        .item(&custom(app, "quit", "退出简写", Some("CmdOrCtrl+Q"))?)
        .build()?;

    let file_menu = SubmenuBuilder::new(app, "文件")
        .item(&custom(app, "new", "新建", Some("CmdOrCtrl+N"))?)
        .item(&custom(app, "open", "打开…", Some("CmdOrCtrl+O"))?)
        .close_window_with_text("关闭窗口")
        .separator()
        .item(&custom(app, "save", "保存", Some("CmdOrCtrl+S"))?)
        .item(&custom(app, "saveAs", "另存为…", Some("CmdOrCtrl+Shift+S"))?)
        .separator()
        .item(&custom(app, "exportPdf", "导出 PDF…", None)?)
        .separator()
        .item(&custom(app, "print", "打印…", Some("CmdOrCtrl+P"))?)
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "编辑")
        .item(&custom(app, "undo", "撤销", Some("CmdOrCtrl+Z"))?)
        .item(&custom(app, "redo", "重做", Some("CmdOrCtrl+Shift+Z"))?)
        .separator()
        .cut_with_text("剪切")
        .copy_with_text("复制")
        .paste_with_text("粘贴")
        .select_all_with_text("全选")
        .separator()
        .item(&custom(app, "find", "查找…", Some("CmdOrCtrl+F"))?)
        .item(&custom(app, "replace", "替换…", Some("CmdOrCtrl+Alt+F"))?)
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "窗口")
        .minimize_with_text("最小化")
        .maximize_with_text("缩放")
        .fullscreen_with_text("全屏")
        .separator()
        .item(&PredefinedMenuItem::bring_all_to_front(app, Some("前置全部窗口"))?)
        .build()?;

    let help_menu = SubmenuBuilder::new(app, "帮助")
        .item(&custom(app, "help", "简写帮助", Some("CmdOrCtrl+Shift+/"))?)
        .build()?;

    // 交给 AppKit 当标准的“窗口”“帮助”菜单（补窗口列表、帮助搜索）
    window_menu.set_as_windows_menu_for_nsapp()?;
    help_menu.set_as_help_menu_for_nsapp()?;

    MenuBuilder::new(app)
        .items(&[
            &app_menu,
            &file_menu,
            &edit_menu,
            &window_menu,
            &help_menu,
        ])
        .build()
}

#[cfg(target_os = "macos")]
fn setup_macos_menu(app: &mut tauri::App) -> tauri::Result<()> {
    let menu = build_app_menu(app.handle())?;
    app.set_menu(menu)?;
    Ok(())
}

// ⌘Q：先标成退出中，再「有未保存内容的窗口先问，干净的窗口排后面」一个个走
// 现有的 CloseRequested 保存流程。干净窗口一个都不先关，等于给「取消」留了退路。
#[cfg(target_os = "macos")]
fn begin_quit(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let labels: Vec<String> = app.webview_windows().keys().cloned().collect();
    if labels.is_empty() {
        app.exit(0);
        return;
    }
    let mut dirty = Vec::new();
    let mut clean = Vec::new();
    for label in labels {
        if state.update(&label, |doc| doc.dirty) {
            dirty.push(label);
        } else {
            clean.push(label);
        }
    }
    dirty.sort();
    clean.sort();
    state.mac.quitting.store(true, Ordering::SeqCst);
    *state.mac.quit_dirty.lock().unwrap() = dirty;
    *state.mac.quit_clean.lock().unwrap() = clean;
    close_next_for_quit(app);
}

// 关掉队列里的下一个窗口；两个队列都空了并且一个窗口都不剩才真正退出
#[cfg(target_os = "macos")]
fn close_next_for_quit(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    loop {
        let next = {
            let mut dirty = state.mac.quit_dirty.lock().unwrap();
            if let Some(label) = dirty.first().cloned() {
                dirty.remove(0);
                Some(label)
            } else {
                drop(dirty);
                let mut clean = state.mac.quit_clean.lock().unwrap();
                if clean.is_empty() {
                    None
                } else {
                    Some(clean.remove(0))
                }
            }
        };
        let Some(label) = next else {
            if app.webview_windows().is_empty() {
                app.exit(0);
            }
            return;
        };
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.close();
            return;
        }
    }
}

// 事件循环回调：关掉最后一个窗口不退出程序（D5），点 Dock 图标再开一个新窗口
#[cfg(target_os = "macos")]
fn handle_run_event(app: &tauri::AppHandle, event: tauri::RunEvent) {
    match event {
        tauri::RunEvent::ExitRequested { code, api, .. } => {
            let quitting = app.state::<AppState>().mac.quitting.load(Ordering::SeqCst);
            if code.is_none() && !quitting {
                api.prevent_exit();
            }
        }
        tauri::RunEvent::Reopen {
            has_visible_windows,
            ..
        } => {
            if !has_visible_windows {
                let recent_open = app
                    .state::<AppState>()
                    .mac
                    .last_open_request
                    .lock()
                    .unwrap()
                    .map(|at| at.elapsed().as_millis() < 1200)
                    .unwrap_or(false);
                // 点 Dock 图标：窗口只是被最小化或隐藏时把它调出来，一个窗口都没有才新建
                let mut windows: Vec<tauri::WebviewWindow> =
                    app.webview_windows().into_values().collect();
                // 「双击文件启动程序」时系统会先发 Reopen 再发 openURLs：这一刻还没窗口，
                // 但马上就要开文档窗口了。这时新建一张空白纸，用户会先看到一个空窗口，
                // 文档窗口随后才出来（§2.1「第一个冒出新建空白窗口」，低概率复现）。
                // 刚有过打开请求就什么都不做，把窗口让给随后的文档
                if windows.is_empty() && !recent_open {
                    let _ = create_document_window(app, None);
                } else if !windows.is_empty() {
                    // 优先主窗口，其次 label 最小的，保证每次点到同一个
                    windows.sort_by(|a, b| {
                        let key = |window: &tauri::WebviewWindow| {
                            (window.label() != "main", window.label().to_string())
                        };
                        key(a).cmp(&key(b))
                    });
                    if let Some(window) = windows.into_iter().next() {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
        }
        // 访达双击 / 拖到 Dock 图标 / “打开方式”
        tauri::RunEvent::Opened { urls } => {
            for url in urls {
                let Ok(path) = url.to_file_path() else {
                    continue;
                };
                if let Some(path) = supported_document_path(&path) {
                    open_document_from_system(app, path);
                }
            }
        }
        _ => {}
    }
}

#[cfg(not(target_os = "macos"))]
fn handle_run_event(_app: &tauri::AppHandle, _event: tauri::RunEvent) {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // 单实例必须第一个注册：第二次启动（右键打开/双击文件）时新建独立窗口
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // 窗口回调里同步建 WebView 在 Windows 上可能死锁，放到异步线程里做
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Some(path) = document_path_from_args(argv) {
                    // Mac 上「打开方式」会同时触发单实例回调和访达的 openURLs，
                    // 两条都直连 create_document_window 就会开出两个窗口。
                    // 统一走 open_document_from_system，它自带同路径去重和空窗口收留
                    #[cfg(target_os = "macos")]
                    open_document_from_system(&handle, path);
                    #[cfg(not(target_os = "macos"))]
                    let _ = create_document_window(&handle, Some(path));
                } else if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                } else if let Some(window) = handle.webview_windows().into_values().next() {
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                } else {
                    // 一个窗口都没有：On Mac 上稍等再建，先看有没有文档要来。
                    // 访达双击文档时路径走 openURLs，单实例回调的 argv 里根本没有它，
                    // 两个回调谁先到是随机的；这里立刻补一张空白纸，
                    // 紧接着 openURLs 再开一个文档窗口，用户就先看到一个空窗口
                    // （§2.1「第一个冒出新建空白窗口」的低概率复现）
                    #[cfg(target_os = "macos")]
                    {
                        let app_for_later = handle.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_millis(600));
                            let state = app_for_later.state::<AppState>();
                            let opening = state
                                .mac
                                .last_open_request
                                .lock()
                                .unwrap()
                                .map(|at| at.elapsed().as_millis() < 600)
                                .unwrap_or(false);
                            // 期间没有文档进来、也还是没有窗口，才补一张空白纸
                            if !opening && app_for_later.webview_windows().is_empty() {
                                let _ = create_document_window(&app_for_later, None);
                            }
                        });
                    }
                    #[cfg(not(target_os = "macos"))]
                    let _ = create_document_window(&handle, None);
                }
            });
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .setup(|app| {
            // 主窗口由配置文件创建，这里补上兜底设置（doc-* 窗口在 build_document_window 里设）
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main") {
                configure_webview_settings(&window);
            }
            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                configure_mac_webview(&window);
            }
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
                let args: Vec<String> = std::env::args().collect();
                // --long-print：用内置的 600 段样本；--long-print-file <path>：用指定 txt（每行一段）
                let long_print_file = args
                    .iter()
                    .position(|arg| arg == "--long-print-file")
                    .and_then(|index| args.get(index + 1))
                    .cloned();
                let long_print =
                    long_print_file.is_some() || args.iter().any(|arg| arg == "--long-print");
                let dialog_test = args.iter().any(|arg| arg == "--dialog-test");
                let probe = std::env::temp_dir().join("wordlite-tauri-selftest.txt");
                let probe_json = serde_json::to_string(&probe.to_string_lossy().to_string())
                    .unwrap_or_else(|_| "\"\"".into());
                let probe_bin = std::env::temp_dir().join("wordlite-tauri-selftest.bin");
                let probe_bin_json = serde_json::to_string(&probe_bin.to_string_lossy().to_string())
                    .unwrap_or_else(|_| "\"\"".into());
                // 长文档 PDF 落盘位置：CI 用 runner.temp 作 TMPDIR，再按这个路径上传。
                // 指定样本文件时按文件名派生，两份样本各留一份 PDF 方便对照。
                let long_pdf = match &long_print_file {
                    Some(path) => {
                        let stem: String = Path::new(path)
                            .file_stem()
                            .and_then(|value| value.to_str())
                            .unwrap_or("file")
                            .chars()
                            .map(|ch| {
                                if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                                    ch
                                } else {
                                    '_'
                                }
                            })
                            .collect();
                        std::env::temp_dir().join(format!("wordlite-selftest-{stem}.pdf"))
                    }
                    None => std::env::temp_dir().join("wordlite-selftest-long.pdf"),
                };
                let long_pdf_json = serde_json::to_string(&long_pdf.to_string_lossy().to_string())
                    .unwrap_or_else(|_| "\"\"".into());
                let long_file_json = match &long_print_file {
                    Some(path) => serde_json::to_string(path).unwrap_or_else(|_| "null".into()),
                    None => "null".into(),
                };
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
                            // V2：自定义打印预览已删除，Ctrl+P 直接走原生打印页
                            const printTitle = document.querySelector('#btnPrint')?.title || '';
                            results.printPreviewRemoved = !document.querySelector('#printPreviewDialog') &&
                                !document.querySelector('#btnPrintPreview') &&
                                (printTitle.includes('Ctrl+P') || printTitle.includes('⌘P'));
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
                                    // --long-print-file 指定 txt 时每行一段；否则用内置的 600 段短段落样本
                                    const longFile = {long_file};
                                    let longHtml;
                                    if (longFile) {{
                                        const raw = await window.wordlite.file.readFile(longFile, false);
                                        const escapeHtml = (value) => value
                                            .replace(/&/g, '&amp;')
                                            .replace(/</g, '&lt;')
                                            .replace(/>/g, '&gt;');
                                        const lines = raw.replace(/\r\n/g, '\n').split('\n');
                                        while (lines.length && lines[lines.length - 1] === '') lines.pop();
                                        longHtml = lines
                                            .map((line) => (line ? '<p>' + escapeHtml(line) + '</p>' : '<p><br></p>'))
                                            .join('');
                                        results.longFile = longFile;
                                    }} else {{
                                        longHtml = '<p>测试分页内容，这是一段用于验证打印预览自动分页的示例文字。</p>'.repeat(600);
                                    }}
                                    document.execCommand('insertHTML', false, longHtml);
                                    await new Promise((resolve) => setTimeout(resolve, 500));
                                    results.longChars = editorEl.innerText.length;
                                    const longPdf = await withTimeout(window.wordlite.file.printToPDF(), 40000);
                                    results.longPdfPages = (atob(longPdf).match(/\/Type\s*\/Page[^s]/g) || []).length;
                                    // 完整 PDF 落盘，交给 CI 上传后人工检查尺寸和边距
                                    await window.wordlite.file.writeFile({long_pdf}, longPdf, true);
                                    results.longPdfFile = {long_pdf};
                                }} catch (longError) {{
                                    results.longError = String(longError);
                                }}
                            }}
                            // 页面缩放：只在状态栏改纸张的显示比例，字号和文档内容都不动
                            try {{
                                const paperEl = document.querySelector('.paper');
                                const domEl = document.querySelector('.ProseMirror');
                                const zoomLabel = document.querySelector('#btnZoomReset');
                                const zoomIn = document.querySelector('#btnZoomIn');
                                const zoomOut = document.querySelector('#btnZoomOut');
                                results.pageZoomControls = !!zoomLabel && !!zoomIn && !!zoomOut;
                                zoomLabel.click();
                                await new Promise((resolve) => setTimeout(resolve, 100));
                                const columnAt100 = domEl.clientWidth;
                                const paperAt100 = paperEl.getBoundingClientRect().width;
                                zoomOut.click();
                                await new Promise((resolve) => setTimeout(resolve, 150));
                                const shrunk = paperEl.style.zoom;
                                const paperAt90 = paperEl.getBoundingClientRect().width;
                                // 排版像素不变：图片宽度和点击定位都按 clientWidth 算，它必须纹丝不动
                                const columnAt90 = domEl.clientWidth;
                                results.pageZoomShrinks = shrunk === '0.9' && paperAt90 < paperAt100 * 0.95;
                                results.pageZoomKeepsLayout = columnAt90 === columnAt100;
                                results.pageZoomLabel = zoomLabel.textContent;
                                results.pageZoomStored = JSON.parse(localStorage.getItem('wordlite.zoom.v1'));
                                zoomLabel.click();
                                await new Promise((resolve) => setTimeout(resolve, 120));
                                results.pageZoomReset = paperEl.style.zoom === '' && zoomLabel.textContent === '100%';
                            }} catch (zoomError) {{
                                results.pageZoomError = String(zoomError);
                            }}
                            try {{
                                await withTimeout(window.__TAURI__.core.invoke('open_external', {{ path: {probe} }}), 5000);
                                // 立刻重复一次，验证 1.5 秒内的同路径去重（不应再开窗口）
                                await withTimeout(window.__TAURI__.core.invoke('open_external', {{ path: {probe} }}), 5000);
                                results.openedNewWindow = true;
                            }} catch (openError) {{
                                results.openError = String(openError);
                            }}
                            // X1：左页边距按下拖到该行中间，选区非空且起点是行首
                            try {{
                                editorEl.focus();
                                document.execCommand('selectAll', false, null);
                                document.execCommand('delete', false, null);
                                document.execCommand('insertHTML', false,
                                    '<p>第一段文字甲乙丙丁戊己庚辛壬癸</p><p>第二段文字甲乙丙丁戊己庚辛壬癸</p>');
                                const wsEl = document.querySelector('#workspace');
                                wsEl.scrollTop = 0;
                                await new Promise((resolve) => setTimeout(resolve, 300));
                                const edBox = editorEl.getBoundingClientRect();
                                const line = editorEl.querySelectorAll('p')[1].getBoundingClientRect();
                                const lineMid = line.top + line.height / 2;
                                const make = (type, x, y, buttons) => new PointerEvent(type, {{
                                    bubbles: true, cancelable: true, clientX: x, clientY: y,
                                    button: 0, buttons: buttons, pointerId: 1,
                                    pointerType: 'mouse', isPrimary: true
                                }});
                                wsEl.dispatchEvent(make('pointerdown', edBox.left - 40, lineMid, 1));
                                window.dispatchEvent(make('pointermove', line.left + 60, lineMid, 1));
                                window.dispatchEvent(make('pointerup', line.left + 60, lineMid, 0));
                                await new Promise((resolve) => setTimeout(resolve, 150));
                                const picked = document.getSelection().toString();
                                const lineText = editorEl.querySelectorAll('p')[1].textContent;
                                results.blankDragText = picked;
                                results.blankDragOk = picked.length > 0 && lineText.startsWith(picked);
                            }} catch (blankError) {{
                                results.blankDragOk = false;
                                results.blankDragError = String(blankError);
                            }}
                            // V1：右键菜单 / 刷新封堵
                            // 用导航计数判断页面有没有重载：重载一次 window 就重建，计数清零
                            const marked = window.__wlV1Mark = (window.__wlV1Mark || 0) + 1;
                            const noReload = () => window.__wlV1Mark === marked;
                            // 刷新键在「焦点不在正文」的位置按：这是用户离开编辑器时的情形
                            const press = (key, modifiers = [], code) => {{
                                const mods = {{ Alt: 1, Control: 2, Meta: 4, Shift: 8 }};
                                const flags = modifiers.reduce((acc, name) => acc | (mods[name] || 0), 0);
                                let down = null;
                                for (const type of ['keydown', 'keyup']) {{
                                    const ev = new KeyboardEvent(type, {{
                                        key, code: code || key, ctrlKey: modifiers.includes('Control'),
                                        altKey: modifiers.includes('Alt'), shiftKey: modifiers.includes('Shift'),
                                        metaKey: modifiers.includes('Meta'), bubbles: true, cancelable: true
                                    }});
                                    document.body.dispatchEvent(ev);
                                    if (type === 'keydown') down = ev;
                                }}
                                return down;
                            }}
                            // 1) 刷新键都被拦下。各平台的「刷新」不一样：
                            //    Windows 是 F5 / Ctrl+R / Ctrl+Shift+R / Alt+←，
                            //    Mac 是 ⌘R / ⌘⇧R；⌥← 在 Mac 上是「按词移动光标」，本来就不该拦
                            const macPlatform = window.wordlite?.platform === 'mac';
                            const refreshCases = macPlatform
                                ? [['F5', 'F5', [], 'F5'], ['MetaR', 'r', ['Meta'], 'KeyR'],
                                   ['MetaShiftR', 'r', ['Meta', 'Shift'], 'KeyR']]
                                : [['F5', 'F5', [], 'F5'], ['CtrlR', 'r', ['Control'], 'KeyR'],
                                   ['CtrlShiftR', 'r', ['Control', 'Shift'], 'KeyR'],
                                   ['AltLeft', 'ArrowLeft', ['Alt'], 'ArrowLeft']];
                            try {{
                                const refreshKeys = [];
                                for (const [name, key, mods, code] of refreshCases) {{
                                    const ev = press(key, mods, code);
                                    refreshKeys.push(name + '=' + ev.defaultPrevented);
                                    results['refreshBlocked_' + name] = ev.defaultPrevented;
                                }}
                                results.refreshKeys = refreshKeys.join(' ');
                                results.refreshBlocked = refreshCases
                                    .every(([name]) => results['refreshBlocked_' + name] === true);
                                await new Promise((resolve) => setTimeout(resolve, 100));
                                results.refreshNoReload = noReload();
                            }} catch (refreshError) {{
                                results.refreshBlocked = false;
                                results.refreshError = String(refreshError);
                            }}
                            // 2) 正文里 Ctrl+R 仍然是右对齐：拦刷新不能把右对齐一起拦掉
                            // Mac 上修饰键是 ⌘ 不是 Ctrl，硬编码 ctrlKey 会让这条在 Mac 上
                            // 永远为 false（CI 日志里 alignRightShortcut=false 就是这个原因）
                            const modKey = window.wordlite?.platform === 'mac' ? 'metaKey' : 'ctrlKey';
                            try {{
                                const ed = editorEl.editor;
                                ed.chain().focus().setContent('<p>右对齐检查</p>').run();
                                ed.chain().selectAll().setTextAlign('left').run();
                                await new Promise((resolve) => setTimeout(resolve, 100));
                                editorEl.dispatchEvent(new KeyboardEvent('keydown', {{
                                    key: 'r', code: 'KeyR', [modKey]: true, bubbles: true, cancelable: true
                                }}));
                                await new Promise((resolve) => setTimeout(resolve, 150));
                                results.alignRightShortcut = ed.getAttributes('paragraph').textAlign === 'right';
                            }} catch (alignError) {{
                                results.alignRightShortcut = false;
                                results.alignRightError = String(alignError);
                            }}
                            // 3) Ctrl+F 打开查找、查找框里右键保留默认菜单、查找框里 Ctrl+R 不刷新
                            try {{
                                editorEl.focus();
                                editorEl.dispatchEvent(new KeyboardEvent('keydown', {{
                                    key: 'f', code: 'KeyF', [modKey]: true, bubbles: true, cancelable: true
                                }}));
                                await new Promise((resolve) => setTimeout(resolve, 150));
                                results.findOpened = !document.querySelector('#findBar').hidden;
                                const findInput = document.querySelector('#findInput');
                                const ctx = new MouseEvent('contextmenu', {{
                                    bubbles: true, cancelable: true, clientX: 10, clientY: 10
                                }});
                                findInput.dispatchEvent(ctx);
                                results.inputContextAllowed = !ctx.defaultPrevented;
                                results.findRefreshNoReload = noReload();
                                document.querySelector('#btnFindClose').click();
                            }} catch (findError) {{
                                results.findOpened = false;
                                results.findError = String(findError);
                            }}
                            // 4) 正文 / 纸边距右键弹自定义菜单；功能区右键不弹；图片右键选中图片
                            try {{
                                const ed2 = editorEl.editor;
                                const menu = document.querySelector('#contextMenu');
                                // 读菜单里可点的项（跳过禁用项和分隔线）
                                const itemsOf = () => [...menu.querySelectorAll('.context-menu-item:not(:disabled)')]
                                    .map((el) => el.textContent.replace(/\\s+/g, ' ').trim());
                                const fire = (el, x, y) => {{
                                    const ev = new MouseEvent('contextmenu', {{
                                        bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2
                                    }});
                                    el.dispatchEvent(ev);
                                    return ev;
                                }};
                                ed2.chain().focus().setContent('<p>第一段右键文字</p><p>第二段右键文字</p>').run();
                                await new Promise((resolve) => setTimeout(resolve, 150));
                                const firstLine = editorEl.querySelectorAll('p')[0].getBoundingClientRect();
                                const textEvent = fire(editorEl.querySelectorAll('p')[0],
                                    firstLine.left + 30, firstLine.top + firstLine.height / 2);
                                results.textContextPrevented = textEvent.defaultPrevented;
                                results.textMenuOpen = !menu.hidden;
                                results.textMenuItems = itemsOf();
                                results.textMenuHasRefresh = itemsOf().some((label) => label.includes('刷新'));
                                // 从别处点到选区外面：光标跟到点击处，菜单里只剩没有选区时的项
                                ed2.chain().focus().setTextSelection({{ from: 1, to: 6 }}).run();
                                const secondLine = editorEl.querySelectorAll('p')[1].getBoundingClientRect();
                                fire(editorEl.querySelectorAll('p')[1],
                                    secondLine.left + 30, secondLine.top + secondLine.height / 2);
                                await new Promise((resolve) => setTimeout(resolve, 100));
                                results.caretMovedToClick = ed2.state.selection.empty &&
                                    ed2.state.selection.from >= ed2.state.doc.child(0).nodeSize;
                                results.noSelectionHasCut = itemsOf().some((label) => label.includes('剪切'));
                                // 选区里右键：选区原样保留
                                ed2.chain().focus().setTextSelection({{ from: 1, to: 6 }}).run();
                                const selectedText = ed2.state.doc.textBetween(1, 6);
                                fire(editorEl.querySelectorAll('p')[0],
                                    firstLine.left + 30, firstLine.top + firstLine.height / 2);
                                await new Promise((resolve) => setTimeout(resolve, 100));
                                results.selectionKept = ed2.state.doc.textBetween(
                                    ed2.state.selection.from, ed2.state.selection.to) === selectedText;
                                results.selectionHasCut = itemsOf().some((label) => label.includes('剪切'));
                                fire(document.body, 2, 2); // 点菜单外：关掉
                                results.outsideClickCloses = menu.hidden;
                                const paper = document.querySelector('.paper').getBoundingClientRect();
                                const blankEvent = fire(document.querySelector('.paper'),
                                    paper.right - 10, paper.top + 40);
                                results.blankContextPrevented = blankEvent.defaultPrevented;
                                results.blankMenuOpen = !menu.hidden;
                                fire(document.body, 2, 2);
                                const ribbonEvent = fire(document.querySelector('#ribbon .tab'), 100, 30);
                                results.ribbonContextPrevented = ribbonEvent.defaultPrevented;
                                results.ribbonMenuOpen = !menu.hidden;
                                // 图片：右键后是 NodeSelection，菜单换成图片项
                                ed2.chain().focus().setContent(
                                    '<p>图片右键</p><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">'
                                ).run();
                                await new Promise((resolve) => setTimeout(resolve, 300));
                                const img = editorEl.querySelector('img');
                                const imgBox = img.getBoundingClientRect();
                                const imageEvent = fire(img, imgBox.left + imgBox.width / 2, imgBox.top + imgBox.height / 2);
                                await new Promise((resolve) => setTimeout(resolve, 100));
                                results.imageContextPrevented = imageEvent.defaultPrevented;
                                results.imageSelected = ed2.state.selection.node?.type.name === 'image';
                                results.imageMenuItems = menu.hidden ? [] : itemsOf();
                                results.imageMenuHasSettings = results.imageMenuItems
                                    .some((label) => label.includes('图片设置'));
                                fire(document.body, 2, 2);
                                results.menuClosedAfterImage = menu.hidden;
                            }} catch (menuError) {{
                                results.textMenuOpen = false;
                                results.menuError = String(menuError);
                            }}
                            // 5) Shift+F10 在光标处打开、方向键 + Tab 不跑出菜单；Esc 先关菜单，查找栏还在
                            try {{
                                const ed3 = editorEl.editor;
                                const menu = document.querySelector('#contextMenu');
                                ed3.chain().focus().setContent('<p>键盘菜单检查</p><p>第二段</p>').run();
                                ed3.chain().focus('end').run();
                                document.dispatchEvent(new KeyboardEvent('keydown', {{
                                    key: 'f', code: 'KeyF', [modKey]: true, bubbles: true, cancelable: true
                                }}));
                                await new Promise((resolve) => setTimeout(resolve, 100));
                                results.findBarOpenBeforeEsc = !document.querySelector('#findBar').hidden;
                                document.dispatchEvent(new KeyboardEvent('keydown', {{
                                    key: 'F10', code: 'F10', shiftKey: true, bubbles: true, cancelable: true
                                }}));
                                await new Promise((resolve) => setTimeout(resolve, 150));
                                results.keyboardMenuOpen = !menu.hidden;
                                results.keyboardMenuItems = menu.hidden
                                    ? 0
                                    : menu.querySelectorAll('.context-menu-item').length;
                                results.keyboardMenuItemRole = menu.hidden
                                    ? 0
                                    : menu.querySelectorAll('[role=menuitem]').length;
                                // 方向键在菜单里走一圈不会跑出去；Tab 也不会把焦点送出菜单
                                const moveKey = (key, shiftKey = false) => menu.firstElementChild.dispatchEvent(
                                    new KeyboardEvent('keydown', {{ key, shiftKey, bubbles: true, cancelable: true }}));
                                for (let i = 0; i < 3; i++) moveKey('ArrowDown');
                                results.keyboardNavInsideMenu = menu.contains(document.activeElement);
                                moveKey('Tab');
                                results.tabStaysInsideMenu = menu.contains(document.activeElement);
                                document.dispatchEvent(new KeyboardEvent('keydown', {{
                                    key: 'Escape', code: 'Escape', bubbles: true, cancelable: true
                                }}));
                                await new Promise((resolve) => setTimeout(resolve, 100));
                                results.escClosedMenu = menu.hidden;
                                results.escKeptFindBar = !document.querySelector('#findBar').hidden;
                                document.querySelector('#btnFindClose').click();
                            }} catch (keyboardError) {{
                                results.keyboardMenuOpen = false;
                                results.keyboardMenuError = String(keyboardError);
                            }}
                            results.contextMenuOk = !!(results.textMenuOpen && results.blankMenuOpen &&
                                results.ribbonContextPrevented && !results.ribbonMenuOpen &&
                                results.imageSelected && results.imageMenuHasSettings &&
                                results.keyboardMenuOpen && results.escClosedMenu &&
                                results.refreshBlocked && results.refreshNoReload);
                            // V5：图片编辑面板的撤销栈语义——取消不动栈，完成只加一步
                            try {{
                                const edImg = editorEl.editor;
                                const hook = window.__wlImageEditor;
                                edImg.chain().focus().setContent(
                                    '<p>图片编辑检查</p><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" width="120" height="80">'
                                ).run();
                                await new Promise((resolve) => setTimeout(resolve, 300));
                                // 位置必须用 posAtDOM 算：doc.forEach 的偏移量对节点位置不可靠（V4 踩过）
                                const imgEl = editorEl.querySelector('img');
                                const imagePos = imgEl ? edImg.view.posAtDOM(imgEl, 0) : null;
                                results.imageEditHook = !!hook;
                                if (hook && imagePos != null) {{
                                    // 取消：改动若干项后 Esc，撤销栈深度必须不变
                                    const before = hook.historyState();
                                    hook.open(imagePos);
                                    await new Promise((r) => setTimeout(r, 250));
                                    results.imagePanelOpen = !hook.panel().hidden;
                                    const setValue = (selector, value) => {{
                                        const el = document.querySelector(selector);
                                        el.value = value;
                                        el.dispatchEvent(new Event('input', {{ bubbles: true }}));
                                    }};
                                    setValue('#panelImageWidth', 200);
                                    setValue('#panelCropTop', 20);
                                    document.querySelector('#panelImageWrap').value = 'right';
                                    document.querySelector('#panelImageWrap').dispatchEvent(new Event('change', {{ bubbles: true }}));
                                    await new Promise((r) => setTimeout(r, 250));
                                    hook.cancel();
                                    await new Promise((r) => setTimeout(r, 200));
                                    const afterCancel = hook.historyState();
                                    const attrsAfterCancel = edImg.getJSON().content.find((n) => n.type === 'image').attrs;
                                    results.imageEditCancelDepth = before.undo;
                                    results.imageEditCancelDepthAfter = afterCancel.undo;
                                    results.imageEditCancelKeptDepth = before.undo === afterCancel.undo;
                                    results.imageEditCancelRestored = attrsAfterCancel.width === 120 &&
                                        attrsAfterCancel.height === 80 && (attrsAfterCancel.wrap || null) === null &&
                                        Number(attrsAfterCancel.crop?.top || 0) === 0;
                                    results.imagePanelClosedAfterCancel = hook.panel().hidden;
                                    // 完成：同样改几项后完成，撤销栈应正好 +1
                                    const beforeDone = hook.historyState();
                                    hook.open(imagePos);
                                    await new Promise((r) => setTimeout(r, 250));
                                    setValue('#panelImageWidth', 200);
                                    document.querySelector('#panelImageWrap').value = 'right';
                                    document.querySelector('#panelImageWrap').dispatchEvent(new Event('change', {{ bubbles: true }}));
                                    await new Promise((r) => setTimeout(r, 250));
                                    hook.finish();
                                    await new Promise((r) => setTimeout(r, 200));
                                    const afterDone = hook.historyState();
                                    results.imageEditDoneDepth = beforeDone.undo + 1;
                                    results.imageEditDoneDepthAfter = afterDone.undo;
                                    results.imageEditDoneOneStep = afterDone.undo === beforeDone.undo + 1;
                                    const doneAttrs = edImg.getJSON().content.find((n) => n.type === 'image').attrs;
                                    results.imageEditDoneApplied = !!doneAttrs && doneAttrs.width === 200 && doneAttrs.wrap === 'right';
                                    edImg.commands.undo();
                                    await new Promise((r) => setTimeout(r, 200));
                                    const undoneAttrs = edImg.getJSON().content.find((n) => n.type === 'image').attrs;
                                    results.imageEditUndoRestored = !!undoneAttrs && undoneAttrs.width === 120 && (undoneAttrs.wrap || null) === null;
                                    results.imageEditOk = results.imageEditCancelKeptDepth &&
                                        results.imageEditCancelRestored && results.imageEditDoneOneStep &&
                                        results.imageEditDoneApplied && results.imageEditUndoRestored;
                                }}
                            }} catch (imageEditError) {{
                                results.imageEditOk = false;
                                results.imageEditError = String(imageEditError);
                            }}
                            // V5b：裁剪交互——数据映射（宽=原宽×未裁掉比例）、应用/取消的还原语义
                            try {{
                                const edCrop = editorEl.editor;
                                const hook = window.__wlImageEditor;
                                edCrop.chain().focus().setContent(
                                    '<p>裁剪检查</p><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" width="240" height="180">'
                                ).run();
                                await new Promise((resolve) => setTimeout(resolve, 300));
                                const cropImg = editorEl.querySelector('img');
                                const cropPos = cropImg ? edCrop.view.posAtDOM(cropImg, 0) : null;
                                results.cropEditHook = !!(hook && cropPos != null && hook.crop);
                                if (hook && cropPos != null && hook.crop) {{
                                    hook.open(cropPos);
                                    await new Promise((r) => setTimeout(r, 250));
                                    hook.crop();
                                    await new Promise((r) => setTimeout(r, 200));
                                    results.cropModeEntered = hook.isCropping();
                                    results.cropOverlayOpen = !document.querySelector('#cropOverlay').hidden;
                                    // 遮罩和图片对齐：四块暗色都在图片矩形里
                                    const cropBox = cropImg.getBoundingClientRect();
                                    const shadeSum = [...document.querySelectorAll('.crop-shade')]
                                        .reduce((sum, part) => {{
                                            const box = part.getBoundingClientRect();
                                            return sum + box.width * box.height;
                                        }}, 0);
                                    results.cropShadesCoverImage = shadeSum <= cropBox.width * cropBox.height + 4;
                                    // 应用 20%/15% 裁剪：宽 = 240 × (1 - 40%)、高 = 180 × (1 - 30%)
                                    hook.setCropDraft({{ top: 15, right: 20, bottom: 15, left: 20 }});
                                    await new Promise((r) => setTimeout(r, 150));
                                    const beforeApply = hook.historyState();
                                    hook.applyCrop();
                                    await new Promise((r) => setTimeout(r, 300));
                                    const cropAttrs = edCrop.getJSON().content.find((n) => n.type === 'image').attrs;
                                    results.cropApplied = !hook.isCropping();
                                    results.cropData = {{ width: cropAttrs.width, height: cropAttrs.height, crop: cropAttrs.crop }};
                                    results.cropSizeFollowsCrop = cropAttrs.width === 144 && cropAttrs.height === 126;
                                    results.cropPercentStored = Number(cropAttrs.crop?.left || 0) === 20 &&
                                        Number(cropAttrs.crop?.top || 0) === 15;
                                    // 先完成，再看撤销一步是否把裁剪一起收回
                                    hook.finish();
                                    await new Promise((r) => setTimeout(r, 250));
                                    const depthFinish = hook.historyState().undo;
                                    edCrop.commands.undo();
                                    await new Promise((r) => setTimeout(r, 250));
                                    const undoneCrop = edCrop.getJSON().content.find((n) => n.type === 'image').attrs;
                                    results.cropUndoRestored = undoneCrop.width === 240 && undoneCrop.height === 180 &&
                                        Number(undoneCrop.crop?.left || 0) === 0;
                                    results.cropOneStep = depthFinish === beforeApply.undo + 1;
                                    // 取消路径：进了裁剪改了框再 Esc，文档一点不动
                                    hook.open(cropPos);
                                    await new Promise((r) => setTimeout(r, 250));
                                    hook.crop();
                                    await new Promise((r) => setTimeout(r, 200));
                                    hook.setCropDraft({{ top: 30, right: 0, bottom: 0, left: 30 }});
                                    await new Promise((r) => setTimeout(r, 150));
                                    const beforeCancel = hook.historyState();
                                    hook.cancelCrop();
                                    await new Promise((r) => setTimeout(r, 200));
                                    const cancelCropAttrs = edCrop.getJSON().content.find((n) => n.type === 'image').attrs;
                                    results.cropCancelKept = !hook.isCropping() &&
                                        hook.historyState().undo === beforeCancel.undo &&
                                        Number(cancelCropAttrs.crop?.left || 0) === 0 && hook.isEditing();
                                    hook.cancel();
                                    await new Promise((r) => setTimeout(r, 200));
                                    results.cropOk = results.cropModeEntered && results.cropOverlayOpen &&
                                        results.cropSizeFollowsCrop && results.cropPercentStored &&
                                        results.cropUndoRestored && results.cropOneStep && results.cropCancelKept;
                                }}
                            }} catch (cropError) {{
                                results.cropOk = false;
                                results.cropError = String(cropError);
                            }}
                            // V6：图片查看器——打开关闭不动文档、不动撤销栈、缩放上下限、姿势还原
                            try {{
                                const edView = editorEl.editor;
                                const viewer = window.__wlImageViewer;
                                edView.chain().focus().setContent(
                                    '<p>查看大图检查</p><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" width="200" height="150">'
                                ).run();
                                await new Promise((resolve) => setTimeout(resolve, 300));
                                const viewImg = editorEl.querySelector('img');
                                const viewPos = viewImg ? edView.view.posAtDOM(viewImg, 0) : null;
                                results.viewerHook = !!(viewer && viewPos != null && viewer.open);
                                if (viewer && viewPos != null && viewer.open) {{
                                    const beforeDoc = edView.state.doc.toJSON();
                                    const beforeDepth = window.__wlImageEditor.historyState();
                                    const beforeSelection = edView.state.selection.from;
                                    const beforeDirtyBytes = JSON.stringify(beforeDoc).length;
                                    viewer.open(viewPos);
                                    await new Promise((r) => setTimeout(r, 250));
                                    results.viewerOpened = viewer.isOpen();
                                    results.viewerShowsOriginal = viewer.image().src === edView.state.doc.nodeAt(viewPos).attrs.src;
                                    const fit = viewer.fitScale();
                                    results.viewerFitCapped = fit > 0 && fit <= 1;
                                    viewer.zoom(9);
                                    results.viewerZoomClampedHigh = Math.abs(viewer.state().zoom - 8) < 1e-6;
                                    viewer.zoom(0.001);
                                    results.viewerZoomClampedLow = Math.abs(viewer.state().zoom - 0.1) < 1e-6;
                                    viewer.pan(30, -20);
                                    const panned = viewer.state();
                                    results.viewerPanApplied = Math.abs(panned.x - 30) < 1e-6 && Math.abs(panned.y + 20) < 1e-6;
                                    viewer.close();
                                    await new Promise((r) => setTimeout(r, 250));
                                    results.viewerClosed = !viewer.isOpen();
                                    const afterDoc = edView.state.doc.toJSON();
                                    const afterDepth = window.__wlImageEditor.historyState();
                                    results.viewerNoDocChange = JSON.stringify(afterDoc) === JSON.stringify(beforeDoc);
                                    results.viewerNoHistoryChange =
                                        afterDepth.undo === beforeDepth.undo && afterDepth.redo === beforeDepth.redo;
                                    results.viewerSelectionKept = edView.state.selection.from === beforeSelection;
                                    results.viewerNoDirty = beforeDirtyBytes === JSON.stringify(afterDoc).length;
                                    results.viewerOk = results.viewerOpened && results.viewerShowsOriginal &&
                                        results.viewerFitCapped && results.viewerZoomClampedHigh &&
                                        results.viewerZoomClampedLow && results.viewerPanApplied &&
                                        results.viewerClosed && results.viewerNoDocChange &&
                                        results.viewerNoHistoryChange && results.viewerSelectionKept;
                                }}
                            }} catch (viewerError) {{
                                results.viewerOk = false;
                                results.viewerError = String(viewerError);
                            }}
                            results.state = 'ok';
                        }} catch (error) {{
                            results.error = String(error);
                        }}
                        window.__TAURI__.core.invoke('selftest_report', {{ results }});
                    }})()"#,
                    probe = probe_json,
                    probe_bin = probe_bin_json,
                    long_pdf = long_pdf_json,
                    long_file = long_file_json,
                    long_print = if long_print { "true" } else { "false" },
                    dialog_test = if dialog_test { "true" } else { "false" }
                );
                let _ = std::fs::write(
                    std::env::temp_dir().join("wordlite-selftest-script.js"),
                    &script,
                );
                *app.state::<AppState>().selftest_script.lock().unwrap() = Some(script);
                // 两份长文档样本各约 34 页，打印耗时更长，看门狗放宽到 75 秒
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(75));
                    println!("[selftest] watchdog timeout");
                    handle.exit(2);
                });
            }
            #[cfg(target_os = "macos")]
            if let Err(error) = setup_macos_menu(app) {
                eprintln!("创建菜单失败：{error}");
            }
            Ok(())
        })
        .on_menu_event(|app, event| handle_menu_event(app, event.id().0.as_str()))
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
            new_window,
            set_document_state,
            renderer_ready,
            close_cancelled,
            close_after_save,
            print_document,
            print_to_pdf,
            export_pdf,
            set_ime_composing,
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
            // 切走窗口时组合已经没了：万一渲染层的 compositionend 没送到
            // （比如切换瞬间的竞态），标志会卡在 true，之后每次右键都被吞掉。
            // 这比原来的 bug 更糟，所以在原生侧兜一道
            #[cfg(target_os = "macos")]
            tauri::WindowEvent::Focused(false) => {
                IME_COMPOSING.store(false, Ordering::SeqCst);
            }
            tauri::WindowEvent::Destroyed => {
                let state = window.state::<AppState>();
                state.remove(window.label());
                // 退出流程里：关掉一个再关下一个，最后一个关完才真正退出
                #[cfg(target_os = "macos")]
                if state.mac.quitting.load(Ordering::SeqCst) {
                    let handle = window.app_handle().clone();
                    tauri::async_runtime::spawn(async move {
                        close_next_for_quit(&handle);
                    });
                }
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .unwrap_or_else(|error| {
            report_startup_error(&error.to_string());
            std::process::exit(1);
        });

    // 输入法组合中的右键必须挡在 WKWebView 之前（见 install_ime_right_click_guard）
    #[cfg(target_os = "macos")]
    install_ime_right_click_guard();

    app.run(|app_handle, event| handle_run_event(app_handle, event));
}
