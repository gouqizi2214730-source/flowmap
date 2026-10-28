# FlowMap 中文版

这是开源项目 [FlowMap](https://github.com/nazmiefearmutcu/flowmap)（Apache-2.0）的汉化自用版：

- **全中文界面**：设置、菜单、面板、提示、成交明细、DOM、画图工具、指标等，默认中文（设置里可切回 English）。
- **自动跟进原项目**：GitHub Actions 每天北京时间 9 点检查原项目，有新提交就拉取最新源码、重新汉化、编译签名后发布到本仓库的 Releases。
- **软件内自动更新**：启动 10 秒后自动检查，之后每 6 小时检查一次；菜单"帮助 → 检查更新…"可手动检查。有新版本会弹窗询问，点"立即更新"后自动下载、校验签名、安装并重启。

## 安装

到本仓库 **Releases** 下载最新的 `FlowMap-zh_版本号_x64-setup.exe`，双击安装（装在当前用户目录，不需要管理员权限）。

## 原理

| 文件 | 作用 |
|---|---|
| `zh-patch/client/src/i18n/zh.ts` | 原项目语言表的中文版 |
| `zh-patch/client/src/i18n/zhDom.ts` | 运行时把写死在组件里的英文替换成中文（不改原组件源码，原项目更新后照样生效） |
| `zh-patch/app/src-tauri/src/zh_update.rs` | 检查更新、下载安装、"帮助"菜单 |
| `zh-patch/apply.py` | 把上面这些套到原项目最新源码上 |
| `.github/workflows/zh-release.yml` | 每天同步 → 汉化 → 编译 → 签名 → 发布 |

如果原项目改动了被打补丁的位置，工作流会报错并停止发布，已安装的版本照常可用；修好 `apply.py` 的锚点后会自动重新发布。原项目新增的英文文字在补充到 `zhDom.ts` 之前会显示英文。

更新包签名私钥保存在仓库 Secrets 的 `TAURI_SIGNING_PRIVATE_KEY` 里，公钥是 `zh-patch/updater.pub`。
