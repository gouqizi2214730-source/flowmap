# VPFM

本地订单流与衍生品工作台：一个窗口、左侧切换模块、全中文界面、自动更新。行情由你的电脑直接从各交易所的公开接口获取，不经过任何第三方数据网站。

## 模块

| 左侧 | 模块 | 内容 | 来源 |
|---|---|---|---|
| 热力 | 深度热力图 | WebGL 盘口热力图、DOM、成交明细、CVD、成交量分布、录制回放，支持约 100 家交易所和美股 | [FlowMap](https://github.com/nazmiefearmutcu/flowmap)（Apache-2.0） |
| 成交 | 聚合成交 | 多交易所逐笔成交与爆仓聚合、成交量气泡图、计数器与统计、价格提醒 | [aggr](https://github.com/Tucsky/aggr)（GPL-3.0） |
| 流动 | 流动性地图 | 多交易所聚合盘口热力图、足迹图、Delta/CVD、持仓、清算、关键价位、回放 | [Liquidity Mapper Fast](https://github.com/liquiditymapperfast/liquiditymapperfast.github.io)（MIT） |
| 衍生 | 衍生品数据 | 合约/现货 CVD、五所聚合持仓、资金费率历史、多空比、实时爆仓流、跨所资金费率表（折算 8 小时、年化价差） | VPFM 自研 |
| 期权 | 期权 GEX | Deribit BTC/ETH：各行权价 Gamma 敞口、Gamma 翻转价、看涨/看跌墙、最大痛点、波动率微笑、期限结构、DVOL 恐慌度、大额成交 | VPFM 自研，DVOL 恐慌度参考 Resonance Alpha |
| 结构 | 结构分析 | SMC（摆动点、BOS/CHoCH、订单块、FVG、等高等低）、高周期 FVG、PO3 序列与 T-Spot、CISD、STDV、Breaker / 独角兽、SMT、高周期 K 线、三周期布林带、锚定/滚动 VWAP、成交量分布、前高前低被突破概率等统计 | VPFM 自研，算法改写自 smart-money-concepts（MIT），概念参考 HTF SUITE、Bandz Po3 Profiler、Fractal Model、Unicorn Model、HTF FVGs Tap、Triple HTF BB、VWAP Claire |
| 工具 | 工具箱 | 打开复盘本（FupanBook）、仓位计算、强平价估算、资金费成本、时段时钟 | VPFM 自研 |

快捷键：`Ctrl+1`…`Ctrl+7` 切换模块，`Ctrl+,` 打开设置。双击左侧图标重新加载该模块。在聚合成交里点交易对，衍生品数据和结构分析会跟着切到这个币（设置里可关）。

## 安装

到本仓库 **Releases** 下载最新的 `VPFM_版本号_x64-setup.exe`，双击安装（装在当前用户目录，不需要管理员权限）。

## 网络与代理

- 网页里的实时连接（WebSocket）跟随 Windows 系统代理（例如 Clash 的"系统代理"模式）。
- 内置服务器（深度热力图的行情、自研模块的数据转发、检查更新）默认读取 Windows 系统代理，也可以在 **设置 → 网络代理** 里填写 `http://127.0.0.1:7890` 这样的地址，或者关掉代理。

## 自动更新

- GitHub Actions 每天北京时间 9:37 检查三个上游项目，有新提交就重新编译并发布到 Releases（标签 `vpfm-v版本号`）。
- 软件启动 10 秒后自动检查，此后每 6 小时检查一次；**设置 → 检查更新** 或菜单 **帮助 → 检查更新…** 可以手动检查。确认后在后台下载，用 SHA-256 校验，然后自动安装并重新打开。

## 组成

| 路径 | 作用 |
|---|---|
| `vpfm/web/` | 外壳（左侧栏、设置页）和自研模块（衍生品、期权、结构、工具箱） |
| `vpfm/server/vpfm_wb.py` | 装进内置服务器的扩展：提供界面文件、交易所接口转发、系统代理、更新按钮 |
| `vpfm/rust/vpfm_update.rs` | 检查更新、下载安装、"帮助"菜单 |
| `vpfm/apply_vpfm.py` | 把上面这些套到 FlowMap 最新源码上（先套 `zh-patch/` 汉化补丁） |
| `vpfm/aggr/` | aggr 的中文界面脚本、本地字体，以及去掉统计脚本的构建后处理 |
| `.github/workflows/vpfm-release.yml` | 每天同步 → 汉化 → 编译 → 冒烟测试 → 发布 |

上游改动了打补丁的位置时，工作流会报错并停止发布，已安装的版本照常可用；修好锚点后会自动重新发布。上游新增的英文文字在补充到中文表之前会显示英文。

更新安全性：软件只从本仓库的 GitHub Releases 下载，并核对 GitHub 记录的 SHA-256；没有额外的代码签名，所以请保管好你的 GitHub 账号。
