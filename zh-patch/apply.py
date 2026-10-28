#!/usr/bin/env python3
"""把汉化和自动更新补丁套到一份上游 FlowMap 源码上。

用法：python zh-patch/apply.py <上游源码目录> <版本号> <汉化版仓库 owner/repo>

设计成"每次从上游最新代码重新套一遍"：只复制新增文件、用锚点做少量插入，
锚点找不到时立即报错退出（工作流失败，不会发布坏包，旧版本继续可用）。
"""
import json
import pathlib
import re
import shutil
import sys

HERE = pathlib.Path(__file__).resolve().parent
root = pathlib.Path(sys.argv[1]).resolve()
version, zh_repo = sys.argv[2], sys.argv[3]


def edit(rel, fn):
    p = root / rel
    s = p.read_text(encoding='utf-8')
    new = fn(s)
    if new == s:
        sys.exit(f'[zh-patch] 没有改动：{rel}（上游结构可能变了）')
    p.write_text(new, encoding='utf-8')
    print('[zh-patch] 已修改', rel)


def sub1(pattern, repl, s, flags=0, what=''):
    new, n = re.subn(pattern, repl, s, count=1, flags=flags)
    if n != 1:
        sys.exit(f'[zh-patch] 找不到锚点：{what or pattern}')
    return new


# ---------- 1. 复制新增文件 ----------
for src in (HERE / 'client').rglob('*'):
    if src.is_file():
        dst = root / 'client' / src.relative_to(HERE / 'client')
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
(root / 'app/src-tauri/src/zh_update.rs').write_text(
    (HERE / 'app/src-tauri/src/zh_update.rs').read_text(encoding='utf-8').replace('__ZH_REPO__', zh_repo), encoding='utf-8')

# ---------- 2. i18n：加入中文并设为默认 ----------
def i18n(s):
    s = sub1(r"(import \{ tr \} from './tr';)", r"\1\nimport { zh } from './zh';", s, what='import tr')
    s = sub1(r"export type Locale = ([^;]+);", lambda m: f"export type Locale = 'zh' | {m.group(1)};", s, what='Locale 类型')
    s = sub1(r"export const LOCALES: readonly Locale\[\] = \[", "export const LOCALES: readonly Locale[] = ['zh', ", s, what='LOCALES')
    s = sub1(r"export const DEFAULT_LOCALE: Locale = '[a-z]+';", "export const DEFAULT_LOCALE: Locale = 'zh';", s, what='DEFAULT_LOCALE')
    s = sub1(r"(export function localeLabel\(l: Locale\): string \{\n)", r"\1  if (l === 'zh') return '简体中文';\n", s, what='localeLabel')
    s = sub1(r"(export function isLocale\([^)]*\)[^{]*\{\n\s*return )", r"\1value === 'zh' || ", s, what='isLocale')
    s = sub1(r"const TABLES: Record<Locale, Record<string, string>> = \{ ([^}]*)\};",
             lambda m: f"const TABLES: Record<Locale, Record<string, string>> = {{ {m.group(1).strip()}, zh }};", s, what='TABLES')
    return s


edit('client/src/i18n/index.ts', i18n)

edit('client/src/main.tsx', lambda s: sub1(
    r"(\ninitLocale\(\);\n)", r"\1installZhDom();\n",
    sub1(r"(import \{ initLocale \} from './i18n';)", r"\1\nimport { installZhDom } from './i18n/zhDom';", s, what='import initLocale'),
    what='initLocale();'))


def html(s):
    s = sub1(r'<html lang="en">', '<html lang="zh-CN">', s, what='html lang')
    return sub1(r'<title>FlowMap</title>', '<title>FlowMap 中文版</title>', s, what='title')


edit('client/index.html', html)

# ---------- 3. Tauri：版本号、更新插件、中文提示 ----------
def cargo(s):
    s = sub1(r'(?m)^version = "[^"]+"', f'version = "{version}"', s, what='Cargo version')
    return sub1(r'(?m)^(tauri = \{[^\n]*\}\n)',
                r'\1tauri-plugin-dialog = "2"\nureq = { version = "2", features = ["json"] }\nsemver = "1"\nsha2 = "0.10"\n', s, what='tauri 依赖')


edit('app/src-tauri/Cargo.toml', cargo)


def conf(s):
    c = json.loads(s)
    c['version'] = version
    return json.dumps(c, ensure_ascii=False, indent=2) + '\n'


edit('app/src-tauri/tauri.conf.json', conf)


def wconf(s):
    c = json.loads(s)
    c['bundle']['targets'] = ['nsis']  # 自动更新用 NSIS 安装包
    nsis = c['bundle'].setdefault('windows', {}).setdefault('nsis', {})
    nsis['languages'] = ['SimpChinese', 'English']
    nsis['displayLanguageSelector'] = False
    return json.dumps(c, ensure_ascii=False, indent=2) + '\n'


edit('app/src-tauri/tauri.windows.conf.json', wconf)


def caps(s):
    c = json.loads(s)
    for p in ('dialog:default',):
        if p not in c['permissions']:
            c['permissions'].append(p)
    return json.dumps(c, ensure_ascii=False, indent=2) + '\n'


edit('app/src-tauri/capabilities/default.json', caps)


def mainrs(s):
    s = sub1(r'(\nuse tauri::\{Manager, WebviewUrl, WebviewWindowBuilder\};\n)', r'\1\nmod zh_update;\n', s, what='use tauri')
    s = sub1(r'(fn main\(\) \{\n\s*tauri::Builder::default\(\)\n)',
             r'\1        .plugin(tauri_plugin_dialog::init())\n        .menu(|h| zh_update::build_menu(h))\n        .on_menu_event(|app, ev| zh_update::on_menu(app, ev.id().as_ref()))\n',
             s, what='Builder::default')
    s = sub1(r'(\n(\s*)spawn_sidecar_monitor\(handle, port\);)',
             r'\n\2zh_update::spawn(handle.clone());\1', s, what='spawn_sidecar_monitor')
    # 原生错误弹窗的中文化（找不到也不影响功能）
    for en, zh in [
        ('"FlowMap is already running.\\n\\nClose the other FlowMap window first. If none is visible, a stuck FlowMap process may still be running — quit it from the task manager."',
         '"FlowMap 已经在运行。\\n\\n请先关闭另一个 FlowMap 窗口。如果看不到窗口，可能有卡住的 FlowMap 进程，请在任务管理器里结束它。"'),
        ('"FlowMap failed to start"', '"FlowMap 启动失败"'),
    ]:
        s = s.replace(en, zh)
    return s


edit('app/src-tauri/src/main.rs', mainrs)
print('[zh-patch] 完成，版本', version)
