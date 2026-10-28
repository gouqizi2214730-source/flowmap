# FlowMap 中文版 → VPFM

FlowMap 中文版已经并入 **VPFM**（本地订单流与衍生品工作台），说明见 [README-VPFM.md](README-VPFM.md)。

- 原来的汉化补丁仍在 `zh-patch/`，VPFM 构建时先套用它，所以 VPFM 里的深度热力图依旧是全中文。
- 已安装的 FlowMap 中文版下次检查更新时会提示安装 VPFM。VPFM 是独立的程序（单独的安装目录和数据目录），装好后旧的 FlowMap 中文版可以在"设置 → 应用"里卸载。

| 文件 | 作用 |
|---|---|
| `zh-patch/client/src/i18n/zh.ts` | FlowMap 语言表的中文版 |
| `zh-patch/client/src/i18n/zhDom.ts` | 运行时把写死在组件里的英文替换成中文 |
| `zh-patch/apply.py` | 把汉化补丁套到 FlowMap 最新源码上 |
