#!/usr/bin/env python3
"""把 FlowMap（已套过 zh-patch 汉化补丁）改造成 VPFM 桌面外壳。

用法：python vpfm/apply_vpfm.py <上游 FlowMap 源码目录> <版本号> <owner/repo>

改动：
- 内置服务器加上 vpfm_wb 扩展（工作台页面、交易所接口转发、系统代理、更新按钮）；
- 桌面外壳：产品名 VPFM、独立的应用标识、启动页改成等待本地服务后跳到工作台；
- 自动更新换成 vpfm_update.rs（只认 vpfm-v 开头的版本、走代理、界面按钮触发）；
- 本地端口优先用固定端口，网页里保存的设置和布局才能跨重启保留；
- 安装包带上 wb 目录（各模块的静态文件）。
锚点找不到时立即报错退出，工作流失败而不会发布坏包。
"""
import json
import pathlib
import re
import shutil
import sys

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')
HERE = pathlib.Path(__file__).resolve().parent
root = pathlib.Path(sys.argv[1]).resolve()
version, repo = sys.argv[2], sys.argv[3]


def edit(rel, fn):
    p = root / rel
    s = p.read_text(encoding='utf-8')
    new = fn(s)
    if new == s:
        sys.exit(f'[vpfm] 没有改动：{rel}（上游结构可能变了）')
    p.write_text(new, encoding='utf-8')
    print('[vpfm] 已修改', rel)


def sub1(pattern, repl, s, flags=0, what=''):
    new, n = re.subn(pattern, repl, s, count=1, flags=flags)
    if n != 1:
        sys.exit(f'[vpfm] 找不到锚点：{what or pattern}')
    return new


# ---------- 1. 内置服务器 ----------
shutil.copy2(HERE / 'server/vpfm_wb.py', root / 'server/src/flowmap_server/api/vpfm_wb.py')
edit('server/src/flowmap_server/api/app.py', lambda s: sub1(
    r'(\n(\s*)app\.include_router\(ws\.router\)\n)',
    r'\1\2from flowmap_server.api import vpfm_wb  # VPFM 工作台：页面、接口转发、代理\n\2vpfm_wb.install(app)\n',
    s, what='app.include_router(ws.router)'))

# ---------- 2. 启动页 ----------
loader = root / 'vpfm-loader'
loader.mkdir(exist_ok=True)
shutil.copy2(HERE / 'loader/index.html', loader / 'index.html')

# ---------- 3. 自动更新模块 ----------
(root / 'app/src-tauri/src/vpfm_update.rs').write_text(
    (HERE / 'rust/vpfm_update.rs').read_text(encoding='utf-8').replace('__VPFM_REPO__', repo), encoding='utf-8')
zh = root / 'app/src-tauri/src/zh_update.rs'
if zh.exists():
    zh.unlink()


def mainrs(s):
    s = sub1(r'\nmod zh_update;\n', '\nmod vpfm_update;\n', s, what='mod zh_update')
    s, n = re.subn(r'\bzh_update::', 'vpfm_update::', s)
    if n != 3:
        sys.exit(f'[vpfm] zh_update:: 调用应有 3 处，实际 {n} 处')
    # 固定端口优先：WebView 的存储按"协议+主机+端口"区分，端口每次都变的话设置会丢
    s = sub1(r'fn free_loopback_port\(\) -> std::io::Result<u16> \{\n',
             'fn free_loopback_port() -> std::io::Result<u16> {\n'
             '    // VPFM：先试几个固定端口，界面里保存的布局和设置才能在重启后保留\n'
             '    for p in [47821u16, 38917, 29563] {\n'
             '        if let Ok(l) = TcpListener::bind(("127.0.0.1", p)) {\n'
             '            drop(l);\n'
             '            return Ok(p);\n'
             '        }\n'
             '    }\n', s, what='free_loopback_port')
    # 窗口标题；深色主题让各模块的"跟随系统配色"都走深色（FlowMap 在浅色 Windows 上会默认用浅色主题）
    s = sub1(r'\.title\("FlowMap"\)', '.title("VPFM")\n                .theme(Some(tauri::Theme::Dark))', s, what='窗口标题')
    s = re.sub(r'show_error_box\(\s*"FlowMap",', 'show_error_box(\n                        "VPFM",', s)
    s = s.replace('FlowMap 已经在运行。', 'VPFM 已经在运行。').replace('请先关闭另一个 FlowMap 窗口', '请先关闭另一个 VPFM 窗口') \
         .replace('卡住的 FlowMap 进程', '卡住的 VPFM 进程').replace('"FlowMap 启动失败"', '"VPFM 启动失败"') \
         .replace('could not launch the bundled FlowMap server', 'could not launch the bundled VPFM server')
    return s


edit('app/src-tauri/src/main.rs', mainrs)


def cargo(s):
    return sub1(r'(?m)^description = "[^"]*"', 'description = "VPFM — 本地订单流与衍生品工作台"', s, what='Cargo description')


edit('app/src-tauri/Cargo.toml', cargo)


def conf(s):
    c = json.loads(s)
    c['productName'] = 'VPFM'
    c['mainBinaryName'] = 'VPFM'
    c['identifier'] = 'com.gouqizi.vpfm'
    c['version'] = version
    c['build']['frontendDist'] = '../../vpfm-loader'
    c['bundle']['category'] = 'Finance'
    c['bundle']['shortDescription'] = 'VPFM 订单流工作台'
    c['bundle']['publisher'] = 'gouqizi'
    return json.dumps(c, ensure_ascii=False, indent=2) + '\n'


edit('app/src-tauri/tauri.conf.json', conf)


def wconf(s):
    c = json.loads(s)
    res = c['bundle'].setdefault('resources', {})
    if isinstance(res, list):
        sys.exit('[vpfm] tauri.windows.conf.json 的 resources 变成了列表格式')
    res['resources/wb/'] = 'wb/'
    return json.dumps(c, ensure_ascii=False, indent=2) + '\n'


edit('app/src-tauri/tauri.windows.conf.json', wconf)

# 资源目录先放一个占位，工作流后面会把各模块的构建结果放进来
(root / 'app/src-tauri/resources/wb').mkdir(parents=True, exist_ok=True)
print('[vpfm] 完成，版本', version)
