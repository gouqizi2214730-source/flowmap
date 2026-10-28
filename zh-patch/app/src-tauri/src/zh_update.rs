// FlowMap 汉化版：检查更新与自动更新。
//
// - 启动约 10 秒后自动检查一次，此后每 6 小时检查一次；
// - 菜单"帮助 → 检查更新…"可随时手动检查；
// - 更新源是汉化版仓库 Release 里的 latest.json（GitHub Actions 每天同步上游、
//   重新汉化并签名打包后发布）。安装包签名不对会被拒绝。
// 发现新版本时弹窗询问，确认后下载、校验签名、停止内置服务器、安装并自动重启。
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::menu::{Menu, MenuItem, Submenu};
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

static CHECKING: AtomicBool = AtomicBool::new(false);

pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(10));
        loop {
            run_check(&app, false);
            std::thread::sleep(Duration::from_secs(6 * 3600));
        }
    });
}

pub fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let check = MenuItem::with_id(app, "zh_check_update", "检查更新…", true, None::<&str>)?;
    let about = MenuItem::with_id(app, "zh_about", "关于 FlowMap 中文版", true, None::<&str>)?;
    let help = Submenu::with_items(app, "帮助", true, &[&check, &about])?;
    Menu::with_items(app, &[&help])
}

pub fn on_menu(app: &AppHandle, id: &str) {
    match id {
        "zh_check_update" => {
            let app = app.clone();
            std::thread::spawn(move || run_check(&app, true));
        }
        "zh_about" => {
            let v = app.package_info().version.to_string();
            app.dialog()
                .message(format!(
                    "FlowMap 中文版 {v}\n\n基于开源项目 FlowMap（Apache-2.0，作者 nazmiefearmutcu）汉化。\n每天自动同步原项目更新，软件启动时自动检查新版本。"
                ))
                .title("关于")
                .kind(MessageDialogKind::Info)
                .show(|_| {});
        }
        _ => {}
    }
}

fn run_check(app: &AppHandle, manual: bool) {
    if CHECKING.swap(true, Ordering::SeqCst) {
        return;
    }
    let res = tauri::async_runtime::block_on(check_once(app, manual));
    CHECKING.store(false, Ordering::SeqCst);
    if let Err(err) = res {
        eprintln!("[flowmap-zh] 检查更新失败：{err}");
        if manual {
            app.dialog()
                .message(format!("检查更新失败：{err}\n\n请确认网络能访问 GitHub 后再试。"))
                .title("检查更新")
                .kind(MessageDialogKind::Warning)
                .blocking_show();
        }
    }
}

async fn check_once(app: &AppHandle, manual: bool) -> Result<(), Box<dyn std::error::Error>> {
    let Some(update) = app.updater()?.check().await? else {
        if manual {
            app.dialog()
                .message(format!(
                    "当前已是最新版本（{}）。",
                    app.package_info().version
                ))
                .title("检查更新")
                .kind(MessageDialogKind::Info)
                .blocking_show();
        }
        return Ok(());
    };
    let notes = update.body.clone().unwrap_or_default();
    let msg = format!(
        "发现 FlowMap 中文版新版本 {}（当前 {}）。\n\n{}\n\n是否现在下载并安装？安装时程序会自动关闭，完成后自动重新打开。",
        update.version,
        update.current_version,
        notes.trim()
    );
    let yes = app
        .dialog()
        .message(msg)
        .title("FlowMap 中文版 - 发现更新")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "立即更新".to_string(),
            "以后再说".to_string(),
        ))
        .blocking_show();
    if !yes {
        return Ok(());
    }
    let bytes = update.download(|_, _| {}, || {}).await?;
    // 先停掉内置 Python 服务器，避免安装时文件被占用。
    if let Some(state) = app.try_state::<crate::ShutdownState>() {
        state.0.store(true, Ordering::Relaxed);
    }
    if let Some(state) = app.try_state::<crate::SidecarState>() {
        crate::kill_sidecar(&state);
    }
    crate::release_instance_lock(app);
    update.install(bytes)?;
    app.restart();
}
