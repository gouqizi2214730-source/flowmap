// FlowMap 汉化版：检查更新与自动更新。
//
// - 启动约 10 秒后自动检查一次，此后每 6 小时检查一次；
// - 菜单"帮助 → 检查更新…"可随时手动检查；
// - 更新源：汉化版仓库 GitHub Releases 的最新版本（GitHub Actions 每天同步
//   原项目、重新汉化、编译后发布）。下载的安装包会用 Release 里给出的
//   SHA-256 校验，不一致就放弃安装。
// 发现新版本时弹窗询问，确认后下载、校验、停止内置服务器、安装并自动重启。
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use sha2::{Digest, Sha256};
use tauri::menu::{Menu, MenuItem, Submenu};
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

const REPO: &str = "__ZH_REPO__";
static CHECKING: AtomicBool = AtomicBool::new(false);

type Res<T> = Result<T, Box<dyn std::error::Error>>;

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
                    "FlowMap 中文版 {v}\n\n基于开源项目 FlowMap（Apache-2.0，作者 nazmiefearmutcu）汉化。\n每天自动同步原项目更新，软件启动时自动检查新版本。\n\n发布页：https://github.com/{REPO}/releases"
                ))
                .title("关于")
                .kind(MessageDialogKind::Info)
                .show(|_| {});
        }
        _ => {}
    }
}

fn info(app: &AppHandle, title: &str, msg: String, kind: MessageDialogKind) {
    app.dialog().message(msg).title(title).kind(kind).blocking_show();
}

fn run_check(app: &AppHandle, manual: bool) {
    if CHECKING.swap(true, Ordering::SeqCst) {
        return;
    }
    let res = check_once(app, manual);
    CHECKING.store(false, Ordering::SeqCst);
    if let Err(err) = res {
        eprintln!("[flowmap-zh] 检查更新失败：{err}");
        if manual {
            info(
                app,
                "检查更新",
                format!("检查更新失败：{err}\n\n请确认网络能访问 GitHub 后再试。"),
                MessageDialogKind::Warning,
            );
        }
    }
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15))
        .timeout_read(Duration::from_secs(120))
        .user_agent("FlowMap-zh-updater")
        .build()
}

fn parse_ver(s: &str) -> Option<semver::Version> {
    semver::Version::parse(s.trim().trim_start_matches("zh-v").trim_start_matches('v')).ok()
}

fn check_once(app: &AppHandle, manual: bool) -> Res<()> {
    let a = agent();
    let rel: serde_json::Value = a
        .get(&format!("https://api.github.com/repos/{REPO}/releases/latest"))
        .set("Accept", "application/vnd.github+json")
        .call()?
        .into_json()?;
    let tag = rel["tag_name"].as_str().unwrap_or_default();
    let latest = parse_ver(tag).ok_or("无法识别最新版本号")?;
    let current = parse_ver(&app.package_info().version.to_string()).ok_or("无法识别当前版本号")?;
    if latest <= current {
        if manual {
            info(app, "检查更新", format!("当前已是最新版本（{current}）。"), MessageDialogKind::Info);
        }
        return Ok(());
    }
    let assets = rel["assets"].as_array().cloned().unwrap_or_default();
    let exe = assets
        .iter()
        .find(|x| x["name"].as_str().is_some_and(|n| n.ends_with("-setup.exe")))
        .ok_or("最新版本里没有找到安装包")?;
    let name = exe["name"].as_str().unwrap_or("FlowMap-zh-setup.exe").to_string();
    let url = exe["browser_download_url"].as_str().ok_or("安装包没有下载地址")?.to_string();
    // 期望的 SHA-256：优先用 GitHub 记录的 digest，否则读同名 .sha256 文件。
    let mut want = exe["digest"].as_str().unwrap_or_default().trim_start_matches("sha256:").to_lowercase();
    if want.len() != 64 {
        if let Some(h) = assets.iter().find(|x| x["name"].as_str() == Some(format!("{name}.sha256").as_str())) {
            let u = h["browser_download_url"].as_str().unwrap_or_default();
            want = a.get(u).call()?.into_string()?.split_whitespace().next().unwrap_or_default().to_lowercase();
        }
    }
    if want.len() != 64 {
        return Err("最新版本没有提供校验值，为安全起见不安装".into());
    }

    let notes = rel["body"].as_str().unwrap_or_default();
    let notes: String = notes.lines().filter(|l| !l.starts_with("<!--")).take(14).collect::<Vec<_>>().join("\n");
    let yes = app
        .dialog()
        .message(format!(
            "发现 FlowMap 中文版新版本 {latest}（当前 {current}）。\n\n{}\n\n是否现在下载并安装？安装时程序会自动关闭，完成后自动重新打开。",
            notes.trim()
        ))
        .title("FlowMap 中文版 - 发现更新")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom("立即更新".to_string(), "以后再说".to_string()))
        .blocking_show();
    if !yes {
        return Ok(());
    }

    let mut bytes = Vec::new();
    a.get(&url).call()?.into_reader().read_to_end(&mut bytes)?;
    let got = format!("{:x}", Sha256::digest(&bytes));
    if got != want {
        return Err(format!("安装包校验失败（期望 {want}，实际 {got}），已放弃安装").into());
    }
    let path = std::env::temp_dir().join(&name);
    std::fs::write(&path, &bytes)?;

    // 先停掉内置 Python 服务器，避免安装时文件被占用。
    if let Some(state) = app.try_state::<crate::ShutdownState>() {
        state.0.store(true, Ordering::Relaxed);
    }
    if let Some(state) = app.try_state::<crate::SidecarState>() {
        crate::kill_sidecar(&state);
    }
    crate::release_instance_lock(app);
    // /P 显示进度但不需要点击；/UPDATE 覆盖安装；/R 装完自动重新打开。
    std::process::Command::new(&path).args(["/P", "/UPDATE", "/R"]).spawn()?;
    std::process::exit(0);
}
