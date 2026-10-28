// VPFM：检查更新与自动更新（替代 FlowMap 汉化版的 zh_update.rs）。
//
// - 启动约 10 秒后自动检查一次，此后每 6 小时检查一次；
// - 菜单"帮助 → 检查更新…"或界面里的"检查更新"按钮可随时手动检查（界面通过内置服务器
//   在应用数据目录写一个 vpfm-update.flag 文件，这里每秒看一眼）；
// - 更新源：本仓库 GitHub Releases 里标签以 vpfm-v 开头的最新版本，安装包用 Release 记录的
//   SHA-256 校验，不一致就放弃；
// - 网络：内置服务器把当前使用的代理写在 vpfm-proxy.txt，下载更新也走同一个代理。
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use sha2::{Digest, Sha256};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

const REPO: &str = "__VPFM_REPO__";
const TAG_PREFIX: &str = "vpfm-v";
static CHECKING: AtomicBool = AtomicBool::new(false);

type Res<T> = Result<T, Box<dyn std::error::Error>>;

fn data_dir(app: &AppHandle) -> Option<PathBuf> {
    crate::app_data_directory(app).ok()
}

pub fn spawn(app: AppHandle) {
    let a = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(10));
        loop {
            run_check(&a, false);
            std::thread::sleep(Duration::from_secs(6 * 3600));
        }
    });
    // 界面上的"检查更新"按钮：内置服务器写标记文件，这里轮询
    std::thread::spawn(move || {
        let flag = match data_dir(&app) {
            Some(d) => d.join("vpfm-update.flag"),
            None => return,
        };
        let _ = std::fs::remove_file(&flag);
        loop {
            std::thread::sleep(Duration::from_millis(900));
            if flag.exists() {
                let _ = std::fs::remove_file(&flag);
                let a = app.clone();
                std::thread::spawn(move || run_check(&a, true));
            }
        }
    });
}

pub fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let check = MenuItem::with_id(app, "vpfm_check_update", "检查更新…", true, None::<&str>)?;
    let data = MenuItem::with_id(app, "vpfm_open_data", "打开数据目录", true, None::<&str>)?;
    let reload = MenuItem::with_id(app, "vpfm_reload", "重新加载界面", true, Some("CmdOrCtrl+Shift+R"))?;
    let sep = PredefinedMenuItem::separator(app)?;
    let about = MenuItem::with_id(app, "vpfm_about", "关于 VPFM", true, None::<&str>)?;
    let help = Submenu::with_items(app, "帮助", true, &[&check, &data, &reload, &sep, &about])?;
    Menu::with_items(app, &[&help])
}

pub fn on_menu(app: &AppHandle, id: &str) {
    match id {
        "vpfm_check_update" => {
            let app = app.clone();
            std::thread::spawn(move || run_check(&app, true));
        }
        "vpfm_open_data" => {
            if let Some(d) = data_dir(app) {
                #[cfg(windows)]
                let _ = std::process::Command::new("explorer").arg(&d).spawn();
                #[cfg(target_os = "macos")]
                let _ = std::process::Command::new("open").arg(&d).spawn();
                #[cfg(all(unix, not(target_os = "macos")))]
                let _ = std::process::Command::new("xdg-open").arg(&d).spawn();
            }
        }
        "vpfm_reload" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.eval("location.reload()");
            }
        }
        "vpfm_about" => {
            let v = app.package_info().version.to_string();
            app.dialog()
                .message(format!(
                    "VPFM {v}\n\n本地订单流与衍生品工作台。整合了这些开源项目：\n· FlowMap（Apache-2.0）深度热力图与内置服务器\n· aggr（GPL-3.0）聚合成交与爆仓\n· Liquidity Mapper Fast（MIT）流动性地图与足迹图\n· smart-money-concepts（MIT）结构算法\n\n行情由本机直接从交易所获取。每天自动跟进上游更新，软件启动时自动检查新版本。\n\n发布页：https://github.com/{REPO}/releases"
                ))
                .title("关于 VPFM")
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
        if manual {
            info(app, "检查更新", "正在检查或下载更新，请稍候。".into(), MessageDialogKind::Info);
        }
        return;
    }
    let res = check_once(app, manual);
    CHECKING.store(false, Ordering::SeqCst);
    if let Err(err) = res {
        eprintln!("[vpfm] 检查更新失败：{err}");
        if manual {
            info(
                app,
                "检查更新",
                format!("检查更新失败：{err}\n\n请确认网络能访问 GitHub（需要的话在设置里填写代理）后再试。"),
                MessageDialogKind::Warning,
            );
        }
    }
}

fn agent(app: &AppHandle) -> ureq::Agent {
    let mut b = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15))
        .timeout_read(Duration::from_secs(180))
        .user_agent("VPFM-updater");
    if let Some(d) = data_dir(app) {
        if let Ok(p) = std::fs::read_to_string(d.join("vpfm-proxy.txt")) {
            let p = p.trim();
            if !p.is_empty() {
                if let Ok(proxy) = ureq::Proxy::new(p) {
                    b = b.proxy(proxy);
                }
            }
        }
    }
    b.build()
}

fn parse_ver(s: &str) -> Option<semver::Version> {
    semver::Version::parse(s.trim().trim_start_matches(TAG_PREFIX).trim_start_matches('v')).ok()
}

fn check_once(app: &AppHandle, manual: bool) -> Res<()> {
    let a = agent(app);
    let list: serde_json::Value = a
        .get(&format!("https://api.github.com/repos/{REPO}/releases?per_page=30"))
        .set("Accept", "application/vnd.github+json")
        .call()?
        .into_json()?;
    let mut best: Option<(semver::Version, serde_json::Value)> = None;
    for rel in list.as_array().cloned().unwrap_or_default() {
        if rel["draft"].as_bool().unwrap_or(false) || rel["prerelease"].as_bool().unwrap_or(false) {
            continue;
        }
        let tag = rel["tag_name"].as_str().unwrap_or_default();
        if !tag.starts_with(TAG_PREFIX) {
            continue;
        }
        if let Some(v) = parse_ver(tag) {
            if best.as_ref().map_or(true, |(b, _)| v > *b) {
                best = Some((v, rel));
            }
        }
    }
    let (latest, rel) = best.ok_or("发布页上还没有 VPFM 版本")?;
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
    let name = exe["name"].as_str().unwrap_or("VPFM-setup.exe").to_string();
    let url = exe["browser_download_url"].as_str().ok_or("安装包没有下载地址")?.to_string();
    let size_mb = exe["size"].as_u64().unwrap_or(0) as f64 / 1048576.0;
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
            "发现 VPFM 新版本 {latest}（当前 {current}）。\n\n{}\n\n是否现在下载并安装？安装包约 {size_mb:.0} MB，会在后台下载，下载完成后程序自动关闭、安装并重新打开。",
            notes.trim()
        ))
        .title("VPFM - 发现更新")
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
