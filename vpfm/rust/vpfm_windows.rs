// VPFM：模块在独立窗口里打开（多窗口 / 多显示器）。
//
// - 界面通过内置服务器在应用数据目录写 vpfm-winreq-*.json 请求文件，这里每 150 毫秒看一眼：
//   open（打开或切到某个模块的窗口）、focus、close、main（切回主窗口）；
// - 模块窗口加载 /wb/window.html#模块，关掉只关它自己，模块回到主窗口；
// - 记住每个窗口（包括主窗口）的位置、大小和是否最大化，写在 vpfm-windows.json；
//   退出时还开着的模块窗口，下次启动按原来的位置重新打开；
// - 模块窗口开关时把打开着的模块列表推给主窗口（window.__vpfmWindows）。
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder, WindowEvent};

/// 可以单独开窗口的模块（和界面里的列表一致）
const MODULES: &[(&str, &str)] = &[
    ("flowmap", "深度热力图"),
    ("aggr", "聚合成交"),
    ("lmap", "流动性地图"),
    ("derivs", "衍生品数据"),
    ("options", "期权 GEX"),
    ("structure", "结构分析"),
    ("tools", "工具箱"),
];
const STATE_FILE: &str = "vpfm-windows.json";
const REQ_PREFIX: &str = "vpfm-winreq-";

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default)]
struct Geo {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    #[serde(default)]
    max: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct ModWin {
    #[serde(default)]
    open: bool,
    #[serde(default)]
    geo: Option<Geo>,
}

#[derive(Serialize, Deserialize, Debug, Default)]
struct Saved {
    #[serde(default)]
    main: Option<Geo>,
    #[serde(default)]
    mods: BTreeMap<String, ModWin>,
}

#[derive(Deserialize)]
struct Req {
    op: String,
    #[serde(default, rename = "mod")]
    module: String,
}

static STATE: Mutex<Option<Saved>> = Mutex::new(None);
/// 现在开着的模块窗口（以窗口事件为准，推给主窗口用）
static OPEN: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());
static DIRTY: AtomicBool = AtomicBool::new(false);
/// 主窗口正在关闭（整个程序要退出）：这之后模块窗口被销毁不算"用户关掉了它"
static CLOSING: AtomicBool = AtomicBool::new(false);
static PORT: AtomicU16 = AtomicU16::new(0);

fn data_dir(app: &AppHandle) -> Option<PathBuf> {
    crate::app_data_directory(app).ok()
}

fn module_name(m: &str) -> Option<&'static str> {
    MODULES.iter().find(|(id, _)| *id == m).map(|(_, n)| *n)
}

fn label_of(m: &str) -> String {
    format!("mod-{m}")
}

fn shutting_down(app: &AppHandle) -> bool {
    CLOSING.load(Ordering::Relaxed)
        || app
            .try_state::<crate::ShutdownState>()
            .is_some_and(|s| s.0.load(Ordering::Relaxed))
}

fn with_state<T>(f: impl FnOnce(&mut Saved) -> T) -> T {
    let mut g = STATE.lock().unwrap_or_else(|e| e.into_inner());
    f(g.get_or_insert_with(Saved::default))
}

fn load(app: &AppHandle) {
    let saved = data_dir(app)
        .and_then(|d| std::fs::read_to_string(d.join(STATE_FILE)).ok())
        .and_then(|s| serde_json::from_str::<Saved>(&s).ok())
        .unwrap_or_default();
    *STATE.lock().unwrap_or_else(|e| e.into_inner()) = Some(saved);
}

fn flush(app: &AppHandle) {
    DIRTY.store(false, Ordering::Relaxed);
    let Some(dir) = data_dir(app) else { return };
    let text = with_state(|s| serde_json::to_string_pretty(s).unwrap_or_default());
    if text.is_empty() {
        return;
    }
    let tmp = dir.join(format!("{STATE_FILE}.tmp"));
    if std::fs::write(&tmp, text).is_ok() {
        let _ = std::fs::rename(&tmp, dir.join(STATE_FILE));
    }
}

/// 窗口左上角往里一点要落在某个显示器上，否则（显示器拔掉了）不用存下来的位置
fn on_screen(app: &AppHandle, g: &Geo) -> bool {
    let Ok(monitors) = app.available_monitors() else { return true };
    if monitors.is_empty() {
        return true;
    }
    let (cx, cy) = (g.x + 80, g.y + 16);
    monitors.iter().any(|m| {
        let (p, s) = (m.position(), m.size());
        cx >= p.x && cx < p.x + s.width as i32 && cy >= p.y && cy < p.y + s.height as i32
    })
}

fn apply_geo(app: &AppHandle, w: &tauri::WebviewWindow, g: &Geo) -> bool {
    if g.w < 200 || g.h < 150 || !on_screen(app, g) {
        return false;
    }
    // 先挪到目标显示器再设大小：不同缩放比例的显示器之间移动时系统会按 DPI 调整一次大小
    let _ = w.set_position(PhysicalPosition::new(g.x, g.y));
    let _ = w.set_size(PhysicalSize::new(g.w, g.h));
    if g.max {
        let _ = w.maximize();
    }
    true
}

/// 记下窗口当前的位置和大小（最小化时不记；最大化时只记"最大化"，保留还原后的大小）
fn record(window: &tauri::Window) {
    let label = window.label().to_string();
    let is_main = label == "main";
    let module = label.strip_prefix("mod-").map(str::to_string);
    if !is_main && module.is_none() {
        return;
    }
    if window.is_minimized().unwrap_or(false) {
        return;
    }
    let max = window.is_maximized().unwrap_or(false);
    let pos = window.outer_position().ok();
    let size = window.inner_size().ok();
    with_state(|s| {
        let slot = if is_main {
            &mut s.main
        } else {
            &mut s.mods.entry(module.clone().unwrap_or_default()).or_default().geo
        };
        let mut g = slot.unwrap_or_default();
        g.max = max;
        if !max {
            if let (Some(p), Some(sz)) = (pos, size) {
                if p.x > -30000 && p.y > -30000 && sz.width >= 200 && sz.height >= 150 {
                    g.x = p.x;
                    g.y = p.y;
                    g.w = sz.width;
                    g.h = sz.height;
                }
            }
        }
        if g.w >= 200 {
            *slot = Some(g);
        }
    });
    DIRTY.store(true, Ordering::Relaxed);
}

/// 把打开着的模块窗口列表推给主窗口的界面
fn push(app: &AppHandle) {
    let open: Vec<String> = OPEN.lock().unwrap_or_else(|e| e.into_inner()).iter().cloned().collect();
    if let Some(main) = app.get_webview_window("main") {
        let json = serde_json::to_string(&open).unwrap_or_else(|_| "[]".into());
        let _ = main.eval(format!("window.__vpfmWindows && window.__vpfmWindows({json})"));
    }
}

fn focus(w: &tauri::WebviewWindow) {
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
}

fn open_module(app: &AppHandle, m: &str) -> Result<(), String> {
    let name = module_name(m).ok_or_else(|| format!("未知模块 {m}"))?;
    let label = label_of(m);
    if let Some(w) = app.get_webview_window(&label) {
        focus(&w);
        return Ok(());
    }
    let port = PORT.load(Ordering::Relaxed);
    let url = format!("http://127.0.0.1:{port}/wb/window.html#{m}")
        .parse()
        .map_err(|e| format!("{e}"))?;
    let w = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
        .title(format!("VPFM · {name}"))
        .theme(Some(tauri::Theme::Dark))
        .inner_size(1280.0, 800.0)
        .min_inner_size(560.0, 400.0)
        .visible(false)
        .build()
        .map_err(|e| format!("{e}"))?;
    let _ = w.remove_menu();
    let saved = with_state(|s| s.mods.get(m).and_then(|x| x.geo));
    let placed = saved.is_some_and(|g| apply_geo(app, &w, &g));
    if !placed {
        // 没有记录：在主窗口旁边错开一点打开
        let shift = 36 * (OPEN.lock().unwrap_or_else(|e| e.into_inner()).len() as i32 + 1);
        match app.get_webview_window("main").and_then(|mw| mw.outer_position().ok()) {
            Some(p) if p.x > -30000 => {
                let _ = w.set_position(PhysicalPosition::new(p.x + shift, p.y + shift));
            }
            _ => {
                let _ = w.center();
            }
        }
    }
    focus(&w);
    OPEN.lock().unwrap_or_else(|e| e.into_inner()).insert(m.to_string());
    with_state(|s| s.mods.entry(m.to_string()).or_default().open = true);
    DIRTY.store(true, Ordering::Relaxed);
    push(app);
    Ok(())
}

fn handle(app: &AppHandle, req: Req) {
    let m = req.module.as_str();
    match req.op.as_str() {
        "open" => {
            if let Err(e) = open_module(app, m) {
                eprintln!("[vpfm] 打开 {m} 窗口失败：{e}");
            }
        }
        "focus" => {
            if let Some(w) = app.get_webview_window(&label_of(m)) {
                focus(&w);
            }
        }
        "close" => {
            if let Some(w) = app.get_webview_window(&label_of(m)) {
                let _ = w.close();
            }
        }
        "main" => {
            if let Some(w) = app.get_webview_window("main") {
                focus(&w);
            }
        }
        "sync" => push(app),
        _ => {}
    }
}

fn take_requests(dir: &Path) -> Vec<Req> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut files: Vec<PathBuf> = rd
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with(REQ_PREFIX) && n.ends_with(".json"))
        })
        .collect();
    files.sort();
    let mut out = Vec::new();
    for p in files {
        let text = std::fs::read_to_string(&p).unwrap_or_default();
        let _ = std::fs::remove_file(&p);
        if let Ok(r) = serde_json::from_str::<Req>(&text) {
            out.push(r);
        }
    }
    out
}

/// 在 setup 里主窗口建好之后调用
pub fn spawn(app: AppHandle, port: u16) {
    PORT.store(port, Ordering::Relaxed);
    load(&app);
    if let Some(main) = app.get_webview_window("main") {
        if let Some(g) = with_state(|s| s.main) {
            apply_geo(&app, &main, &g);
        }
    }
    let Some(dir) = data_dir(&app) else { return };
    // 上次没处理完的请求不要了（可能是很久以前的点击）
    let _ = take_requests(&dir);
    std::thread::spawn(move || {
        // 等内置服务器能访问了再恢复上次开着的模块窗口
        let restore: Vec<String> = with_state(|s| s.mods.iter().filter(|(_, v)| v.open).map(|(k, _)| k.clone()).collect());
        if !restore.is_empty() {
            let healthy = crate::wait_for_health(port, Duration::from_secs(90));
            if healthy {
                std::thread::sleep(Duration::from_millis(800));
            }
            for m in &restore {
                let ok = healthy && module_name(m).is_some() && match open_module(&app, m) {
                    Ok(()) => true,
                    Err(e) => {
                        eprintln!("[vpfm] 恢复 {m} 窗口失败：{e}");
                        false
                    }
                };
                if !ok {
                    // 没能恢复：记成已关闭，界面上这个模块回到主窗口
                    with_state(|s| {
                        if module_name(m).is_some() {
                            s.mods.entry(m.clone()).or_default().open = false;
                        } else {
                            s.mods.remove(m);
                        }
                    });
                    DIRTY.store(true, Ordering::Relaxed);
                }
            }
            push(&app);
            if let Some(main) = app.get_webview_window("main") {
                focus(&main);
            }
        }
        let mut ticks: u32 = 0;
        loop {
            std::thread::sleep(Duration::from_millis(150));
            for r in take_requests(&dir) {
                handle(&app, r);
            }
            ticks = ticks.wrapping_add(1);
            // 拖动窗口时位置变化很频繁：最多每 0.6 秒写一次
            if ticks % 4 == 0 && DIRTY.load(Ordering::Relaxed) && !shutting_down(&app) {
                flush(&app);
            }
        }
    });
}

/// 所有窗口的事件都先经过这里（main.rs 的 on_window_event 里调用）
pub fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    let app = window.app_handle().clone();
    match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => record(window),
        WindowEvent::CloseRequested { .. } if window.label() == "main" => {
            // 主窗口关掉 = 退出：先把现在开着哪些模块窗口、各自的位置存下来，下次启动恢复
            CLOSING.store(true, Ordering::Relaxed);
            record(window);
            flush(&app);
        }
        WindowEvent::Destroyed => {
            if let Some(m) = window.label().strip_prefix("mod-") {
                if !shutting_down(&app) {
                    OPEN.lock().unwrap_or_else(|e| e.into_inner()).remove(m);
                    with_state(|s| s.mods.entry(m.to_string()).or_default().open = false);
                    flush(&app);
                    push(&app);
                }
            }
        }
        _ => {}
    }
}
