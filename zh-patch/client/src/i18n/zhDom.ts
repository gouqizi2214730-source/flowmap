/**
 * FlowMap 汉化版：界面运行时翻译层。
 *
 * 上游只把"外壳"文字放进了 i18n 表，大量面板文字仍写死在组件里。为了在
 * 每次自动同步上游代码后都不需要改动组件源码，这里用 MutationObserver
 * 在 DOM 层把已知英文替换成中文（文本节点 + title / aria-label /
 * placeholder 属性 + confirm/alert 对话框）。新增但尚未收录的英文会原样
 * 显示，不会出错。语言切到非中文时刷新页面恢复原文。
 */
import { getLocale, subscribeLocale } from './index';

const EXACT: Record<string, string> = {
  // App / 通用
  'Heatmap unavailable': '热力图不可用',
  'WebGL2 is not available in this browser/context': '当前浏览器 / 环境不支持 WebGL2',
  ', so the chart canvas cannot render. The DOM panels — symbol search, DOM ladder, time & sales — keep working.':
    '，所以图表画布无法渲染。DOM 面板（品种搜索、DOM 阶梯、成交明细）仍可使用。',
  'PNG export unavailable — the graphics context is lost. The chart will repaint when it recovers.':
    '无法导出 PNG — 图形上下文已丢失。恢复后图表会重新绘制。',
  'FlowMap hit an unrecoverable error': 'FlowMap 遇到了无法恢复的错误',
  'Reload FlowMap': '重新加载 FlowMap',
  'Live': '实时',
  'Replay': '回放',
  'Demo': '演示',
  'All': '全部',
  'Add': '添加',
  'Delete': '删除',
  'Cancel': '取消',
  'Close': '关闭',
  'Settings': '设置',
  'Recent': '最近',
  'Simulated': '模拟',

  // 指标
  'Indicators': '指标',
  'Close indicators': '关闭指标',
  'Candles': 'K 线',
  'Active (': '已启用（',
  'None — add a study below.': '暂无 — 在下面添加一个指标。',
  'Theme default': '主题默认',
  'Period': '周期',
  'VWAP (session)': 'VWAP（时段）',
  'Bollinger Bands': '布林带',
  'StdDev': '标准差',
  'Basis': '中轨',
  'Upper': '上轨',
  'Lower': '下轨',
  'Fast': '快线',
  'Slow': '慢线',
  'Signal': '信号线',
  'Histogram': '柱状图',

  // 配色
  'Theme': '主题',
  'Flow': 'Flow',
  'Classic': '经典',
  'Ice': '冰蓝',
  'Mono': '单色',
  'Midnight': '午夜',
  'Navy blue': '海军蓝',
  'Paper': '纸张',
  'Warm parchment': '暖色羊皮纸',
  'Studio': '工作室',
  'Neutral white': '中性白',
  'Amber': '琥珀',
  'Copper and amber': '铜色与琥珀色',
  'Deep sea': '深海',
  'Petrol green': '石油绿',
  'Daylight': '日光',
  'Blue daylight': '蓝色日光',
  'High contrast': '高对比度',
  'Black and white': '黑白',

  // 价格提醒
  'price alerts': '价格提醒',
  'Price alerts': '价格提醒',
  'clear fired': '清除已触发',
  'close alerts': '关闭提醒',
  'No alerts for this symbol. Press': '该品种没有提醒。按',
  'at the crosshair, or type a level below.': '在十字光标处添加，或在下面输入价位。',
  're-armed ↑': '已重新启用 ↑',
  're-armed ↓': '已重新启用 ↓',
  'armed ↑': '已启用 ↑',
  'armed ↓': '已启用 ↓',
  'new alert price': '新提醒价格',

  // 图例 / CVD
  'Last price': '最新价',
  'Trades': '成交',
  'Chart legend: last price, VWAP, best bid and ask, trades': '图例：最新价、VWAP、最优买卖价、成交',
  'not measurable for this feed (no trade side)': '该数据源无法计算（没有成交方向）',
  'Cumulative volume delta': '累计成交量差（CVD）',

  // DOM 阶梯
  'RECORDED DENSITY': '录制密度',
  'market closed': '休市',
  'connecting…': '连接中…',
  'no book stream in replay — the tape keeps playing': '回放中没有订单簿数据 — 成交明细继续播放',
  'waiting for book…': '等待订单簿…',
  'Recorded interval density; inside quotes, when available, are reconstructed from row centres.':
    '录制的区间密度；如有内盘报价，则由行中心价重建。',
  'Depth quantities are grouped over this price interval. Inside quotes and tape retain the exchange tick.':
    '深度数量按这个价格区间分组。内盘报价和成交明细保留交易所最小价位。',
  'center locked — click to follow mid': '中心已锁定 — 点击跟随中间价',
  'following mid — click to lock': '正在跟随中间价 — 点击锁定',
  'LOCKED': '已锁定',
  'FOLLOW': '跟随',
  'Center on the current midpoint and follow the market': '以当前中间价居中并跟随行情',
  'CENTER': '居中',
  'Sum of sizes on the displayed grouped rungs only; not the full book': '仅为显示的分组档位数量之和，不是完整订单簿',
  'Visible Σ': '可见 Σ',
  'following density': '跟随密度',
  'following mid': '跟随中间价',

  // 画图
  'Select / move drawings': '选择 / 移动画图',
  'Trend line': '趋势线',
  'Horizontal line': '水平线',
  'Horizontal ray (extends right)': '水平射线（向右延伸）',
  'Rectangle': '矩形',
  'Fib retracement': '斐波那契回撤',
  'Text label': '文字标签',
  'this chart': '此图表',
  'Drawing tools': '画图工具',
  'Stroke width': '线宽',
  'Undo (Ctrl+Z)': '撤销（Ctrl+Z）',
  'Undo drawing change': '撤销画图修改',
  'Redo (Ctrl+Shift+Z)': '重做（Ctrl+Shift+Z）',
  'Redo drawing change': '重做画图修改',
  'Clear all drawings': '清除所有画图',
  'TRENDLINE': '趋势线',
  'H-LINE': '水平线',
  'H-RAY': '水平射线',
  'RECTANGLE': '矩形',
  'FIB': '斐波那契',
  'TEXT': '文字',
  'Chart drawings': '图表画图',
  '— drag or click to place · Esc cancels': '— 拖动或点击放置 · Esc 取消',
  '· click 2 finishes': '· 第 2 次点击完成',

  // 研究（情报）抽屉
  'Unavailable — no connected source supplied data.': '不可用 — 没有已连接的数据源提供数据。',
  'Intelligence Terminal': '研究终端',
  'Institutional Terminal Alpha': '机构研究终端',
  'Close intelligence drawer': '关闭研究面板',
  'SEC & Acoustic': 'SEC 文件与语音分析',
  'DoD & Capitol': '国防合同与国会交易',
  'Dark Pools & GEX': '暗池与 GEX',
  'Jets & Talent': '公务机与招聘',
  'ACTIVE SYMBOL:': '当前品种：',
  'Show all universe': '显示全部品种',
  'DEMO FIXTURES — all values, names and events below are synthetic examples.': '演示数据 — 下面所有数值、名称和事件都是虚构示例。',
  'Received intelligence': '已接收的研究数据',
  'Source not supplied': '未提供来源',
  'Amount: $': '金额：$',
  'Risk Factors Semantic Diff Engine': '风险因素语义对比引擎',
  'EARNINGS CALL ACOUSTICS': '财报电话会议语音分析',
  'Call Transcript & Acoustic Metrics': '电话会议文字记录与语音指标',
  'HEURISTIC SCORE (UNVALIDATED)': '启发式评分（未经验证）',
  'PITCH JITTER (F0)': '音高抖动（F0）',
  'SHIMMER': '振幅抖动',
  'PAUSE RATIO': '停顿比例',
  'tracked phrase matches (text only)': '跟踪短语匹配（仅文本）',
  'Government & Defense Contracts': '政府与国防合同',
  'Amount not supplied': '未提供金额',
  'Award ID:': '合同编号：',
  'Congressional & Senate Trades': '众议员与参议员交易',
  'Committee:': '委员会：',
  'Amount:': '金额：',
  'Gamma Exposure (GEX) Microstructure': 'Gamma 敞口（GEX）微观结构',
  'NET GEX (MODEL)': '净 GEX（模型）',
  'Positive under call/put sign assumption': '按看涨 / 看跌符号假设为正',
  'Negative under call/put sign assumption': '按看涨 / 看跌符号假设为负',
  'CALL WALL (CEILING)': '看涨墙（上限）',
  'Largest call gamma magnitude': '最大看涨 gamma',
  'PUT WALL (FLOOR)': '看跌墙（下限）',
  'Largest put gamma magnitude': '最大看跌 gamma',
  'GAMMA FLIP (TRIGGER)': 'Gamma 翻转（触发点）',
  'Vol Regime Inflection Strike': '波动率状态拐点行权价',
  'Dark Pool (Off-Exchange) TRF Volumes': '暗池（场外）TRF 成交量',
  'OFF-EXCHANGE SHORT RATIO:': '场外做空比例：',
  'Total Volume:': '总成交量：',
  'Off-Exchange Short:': '场外做空：',
  'OTC Non-ATS:': '场外非 ATS：',
  'INSTITUTIONAL SIGNAL:': '机构信号：',
  'Corporate Jet M&A Radar': '公务机并购雷达',
  '🎯 Executive Transit Alert:': '🎯 高管出行提醒：',
  'Talent Velocity & Headcount Velocity': '招聘速度与人员变化',
  'R&D Openings:': '研发职位：',
  'Total Listings:': '职位总数：',
  'Status:': '状态：',
  'HIRING FREEZE': '冻结招聘',
  'EXPANDING': '扩张中',
  'ACCUMULATION': '吸筹',
  'DISTRIBUTION': '派发',
  'NEUTRAL': '中性',
  'NORMAL': '正常',
  'ELEVATED': '偏高',
  'SEVERE': '严重',
  'UNKNOWN': '未知',
  'Purchase': '买入',
  'Sale': '卖出',
  'Senate': '参议院',
  'House': '众议院',
  '(INVERTED)': '（倒挂）',
  'MACRO UNAVAILABLE': '宏观数据不可用',
  'MACRO:': '宏观：',
  'UNAVAILABLE': '不可用',
  'Received macro data: SOFR / HY OAS / 10Y-2Y': '已接收宏观数据：SOFR / 高收益债利差 / 10年-2年利差',
  'Unavailable — no connected source supplied macro data.': '不可用 — 没有已连接的数据源提供宏观数据。',
  'Research (J): DOCS, GOV, FLOW, GEO': '研究（J）：文件、政府、资金流、地理',

  // 实时控制 / 价格轴
  'Return to the live edge': '回到实时边缘',
  'GO LIVE': '回到实时',
  'Resume price tracking (keeps your zoom)': '恢复价格跟踪（保持你的缩放）',
  'Resume price tracking and return to the live edge (keeps your zoom)': '恢复价格跟踪并回到实时边缘（保持你的缩放）',
  'TRACK PRICE': '跟踪价格',
  'FIT': '适配',
  'TRACK': '跟踪',
  'LOCK': '锁定',
  'TRK·WAIT': '跟踪·等待',
  'Price auto-scale': '价格自动缩放',
  'price tracking is armed but paused — the live edge is off-screen. Press R / GO LIVE to return to it (your price zoom is kept).':
    '价格跟踪已启用但暂停 — 实时边缘不在屏幕内。按 R 或"回到实时"返回（保留你的价格缩放）。',
  'price auto-scale ON — click to lock (P). Double-click the axis to re-fit.': '价格自动缩放已开 — 点击锁定（P）。双击坐标轴重新适配。',
  'price auto-scale OFF — click to restore (P)': '价格自动缩放已关 — 点击恢复（P）',

  // 行情条
  'Awaiting quote': '等待报价',
  'Stale quote': '报价已过期',
  'Quiet quote': '报价无变化',
  'Live quote': '实时报价',
  'Last trade': '最新成交',
  'Bid': '买价',
  'Ask': '卖价',
  'Spread': '价差',
  'Time since this app received a real inside quote. Quiet quotes are retained and labelled; generated chart frames do not reset this clock.':
    '距离本程序收到上一笔真实内盘报价的时间。无变化的报价会保留并标注；图表生成的帧不会重置这个计时。',
  'Quote age': '报价时长',
  'Chart time window': '图表时间窗口',
  'Fit loaded history': '显示全部已加载历史',

  // 测量
  'MEASURE — drag on the chart · Esc exits': '测量 — 在图上拖动 · Esc 退出',

  // 叠加层开关
  'Price': '价格',
  'Price — last-price line over the heatmap': '价格 — 热力图上的最新价线',
  'Bubbles': '气泡',
  'Bubbles — trade size bubbles on the tape': '气泡 — 按成交量显示的成交气泡',
  'Volume': '成交量',
  'Volume — traded volume bars along the chart bottom': '成交量 — 图表底部的成交量柱',
  'BBO — best bid/offer': 'BBO — 最优买卖价',
  'VWAP — volume-weighted average price': 'VWAP — 成交量加权平均价',
  'CVD — cumulative volume delta (lower pane)': 'CVD — 累计成交量差（下方面板）',
  'Liquidity': '流动性',
  'Liquidity profile — resting orders by price; not executed trade volume': '流动性分布 — 按价格的挂单量；不是成交量',
  'GEX — Gamma Exposure boundaries (Call/Put Walls, Gamma Flip)': 'GEX — Gamma 敞口边界（看涨 / 看跌墙、Gamma 翻转）',
  'Markers': '标记',
  'Markers — event markers': '标记 — 事件标记',
  'Axes': '坐标轴',
  'Axes — price/time axes': '坐标轴 — 价格 / 时间轴',
  'overlay toggles': '叠加层开关',
  'render performance': '渲染性能',

  // 重连
  'protocol error': '协议错误',
  'subscription refused': '订阅被拒绝',
  '(UTC)': '（UTC）',
  '· [start, end)': '· [开始, 结束)',
  'depth channel': '深度通道',
  'price range': '价格范围',
  'history depth': '历史深度',

  // 品种搜索
  'Crypto': '加密货币',
  'Equity': '美股',
  'crypto': '加密货币',
  'equity': '美股',
  'Sim': '模拟',
  'Filter venues…': '筛选交易所…',
  'Search all markets — symbol or venue…': '搜索全部市场 — 品种或交易所…',
  'reading venue list…': '正在读取交易所列表…',
  'preparing previews': '正在准备预览',
  'previews ready': '预览已就绪',
  'listing…': '正在列出…',
  'listing failed': '列出失败',
  'Search symbols': '搜索品种',
  'Search symbols ( / or ⌘K )': '搜索品种（/ 或 ⌘K）',
  'Symbol search': '品种搜索',
  'symbol search': '品种搜索',
  'close search': '关闭搜索',
  'Venues ·': '交易所 ·',
  'loading venues…': '正在加载交易所…',
  "— a venue's first read can take a few seconds": '— 首次读取交易所可能需要几秒',
  'could not be read': '无法读取',
  'The listing request failed — this says nothing about whether': '列出请求失败 — 这并不代表',
  'has symbols. Nothing was cached, so it is worth another try.': '没有品种。没有缓存任何内容，值得再试一次。',
  'retry listing': '重新列出',
  'All markets': '全部市场',
  'bundled directory': '内置目录',
  'The curated cross-venue shortlist. Pure and instant — no venue round trip.': '精选的跨交易所清单。纯本地、即时 — 不需要访问交易所。',
  'Native connector: true incremental book diffs, streamed.': '原生连接器：真实的增量订单簿推送。',
  'Served through ccxt: the book is re-read whole each tick, so depth is a snapshot.': '通过 ccxt 提供：每次整本重新读取订单簿，所以深度是快照。',
  'pick the venue to search': '选择要搜索的交易所',
  'data unavailable': '数据不可用',
  'loading preview…': '正在加载预览…',
  'stale — market closed or last known': '已过期 — 休市或最后已知值',
  'As of': '截至',
  'type to search all crypto + equity symbols': '输入以搜索全部加密货币和美股品种',

  // 成交明细
  'T&S': '成交明细',
  'Display held; incoming prints are still retained. Resume to see the newest prints.': '显示已暂停；新成交仍会保留。恢复后可看到最新成交。',
  'HELD': '已暂停',
  'RESUME': '恢复',
  'HOLD': '暂停',
  'Side': '方向',
  'Tape side': '成交方向',
  'Buy': '买',
  'Sell': '卖',
  'Unknown': '未知',
  'Minimum price multiplied by native quantity; contract units vary by instrument': '最小价格 × 原始数量；合约单位因品种而异',
  'Min price × quantity': '最小 价格 × 数量',
  'Minimum tape price × quantity': '成交明细最小 价格 × 数量',
  'waiting for tape…': '等待成交…',
  'no prints match filters': '没有符合筛选条件的成交',

  // 时间轴 / 回放状态
  'REPLAY REFUSED': '回放被拒绝',
  'NO FEED': '无数据源',
  'REPLAY CONNECTING…': '回放连接中…',
  'RECONNECTING…': '重新连接中…',
  'CONNECTING…': '连接中…',
  'waiting for the feed': '等待数据源',
  'server at capacity — retrying': '服务器已满载 — 正在重试',
  'waiting for the feed…': '等待数据源…',
  'waiting for the replay to attach': '等待回放接入',
  'replay speed — click to step up, shift-click to step down': '回放速度 — 点击加速，Shift+点击减速',
  'return the chart to the live edge (R)': '让图表回到实时边缘（R）',
  'replay seek': '回放定位',
  'FOLLOWING': '跟随中',
  'SCROLLED BACK': '已回滚',
  ', session-relative': '，相对时段',

  // 自选列表
  'Watchlist': '自选',
  'No active symbol to add': '没有可添加的当前品种',
  '+ Add current': '+ 添加当前品种',
  'No symbols yet — add the active symbol, or jump to a recent one.': '还没有品种 — 添加当前品种，或跳到最近浏览的品种。',
  'Recent symbols': '最近品种',
  'Active stream quote; daily change and sparkline remain HTTP snapshots': '实时推送报价；日涨跌和迷你走势图仍为 HTTP 快照',
  'Shared HTTP quote snapshot, refreshed every 10 seconds': '共享 HTTP 报价快照，每 10 秒刷新',
  'LIVE MID': '实时中间价',
  'LIVE LAST': '实时最新价',
  'SNAPSHOT': '快照',
  'Daily change from the shared quote snapshot': '来自共享报价快照的日涨跌',
  'Executive Jet Transit Alert: Corporate jet telemetry active in M&A/Finance Hub': '高管公务机出行提醒：公务机出现在并购 / 金融中心',
  'no data': '无数据',

  // 导出 / 图例模型
  'scrolled back': '已回滚',
  'history ≈ reconstructed': '历史 ≈ 重建',
  'synthetic depth': '合成深度',
  'synthetic amber colormap': '合成深度琥珀配色',
  'divergent imbalance (ask blue → bid amber)': '发散型失衡（卖单蓝 → 买单琥珀）',
  'bid depth': '买单深度',
  'ask depth': '卖单深度',
  'axis wheel / drag': '坐标轴上滚轮 / 拖动',

  // 能力徽章说明
  'recorded time-weighted density; reconstructed quotes use row centres, not original raw L2 snapshots':
    '录制的时间加权密度；重建的报价使用行中心价，不是原始 L2 快照',
  'polled tape — real venue prints, but re-read on a timer rather than streamed, so bursts arrive coalesced':
    '轮询成交 — 真实的交易所成交，但按定时器重新读取而不是推送，所以密集成交会合并到达',
  'inferred aggressor side — derived from the quote/tick rule, not reported by the venue':
    '推断的主动方方向 — 由报价 / tick 规则推导，不是交易所报告的',
  'no aggressor side — this tier cannot say who lifted whom, so CVD is not computed':
    '没有主动方方向 — 这一档数据无法判断谁吃了谁，所以不计算 CVD',
  'synthetic depth — reconstructed, not a real order book': '合成深度 — 重建的，不是真实订单簿',
  'no depth tier reported — the feed states none, so make no assumption about what the book here is':
    '未报告深度等级 — 数据源没有说明，所以不要对这里的订单簿做任何假设',
  'no depth at all — this tier ships no order book, so the heatmap has nothing but the tape to draw from':
    '完全没有深度 — 这一档不提供订单簿，热力图只能根据成交来绘制',
  'snapshot depth — the whole book is re-read each tick (ccxt polling), not streamed as incremental venue diffs':
    '快照深度 — 每次整本重新读取订单簿（ccxt 轮询），不是交易所增量推送',
  'top of book only — the real best bid/ask, extruded into a band; there is no depth ladder behind it':
    '只有盘口 — 真实的最优买卖价被拉成一条带；后面没有深度阶梯',
};

/** 带变量的句子：英文正则 → 中文模板（$1、$2 为捕获组）。 */
const PATTERNS: Array<[RegExp, string]> = [
  [/^Alert (.+?) · crossed above (.+?) \(now (.+)\)$/, '提醒 $1 · 已向上突破 $2（现价 $3）'],
  [/^Alert (.+?) · crossed below (.+?) \(now (.+)\)$/, '提醒 $1 · 已向下跌破 $2（现价 $3）'],
  [/^muted (\d+)s$/, '静音 $1 秒'],
  [/^\(mid (.+)\)$/, '（中间价 $1）'],
  [/^Stroke width \((.+?)px\) — click to change$/, '线宽（$1px）— 点击更改'],
  [/^Clear all (\d+) drawings? on (.+)\?$/, '清除 $2 上的全部 $1 个画图？'],
  [/^Limit of (\d+) active indicators reached$/, '已达到最多 $1 个启用指标的上限'],
  [/^Filter: (.+) only$/, '筛选：仅 $1'],
  [/^Show up to (.+) of available history ending at the current chart position$/, '显示截至当前图表位置的最多 $1 可用历史'],
  [/^price alerts \((\d+)\)$/, '价格提醒（$1）'],
  [/^Search (.+) — in its own symbol spelling$/, '搜索 $1 — 使用该交易所自己的品种写法'],
  [/^no venue matches “(.+)”$/, '没有交易所匹配"$1"'],
  [/^no (.+) symbol matches “(.+)”$/, '$1 没有品种匹配"$2"'],
  [/^no symbols match “(.+)”$/, '没有品种匹配"$1"'],
  [/^tape rows at or above (.+) price × quantity$/, '价格 × 数量 ≥ $1 的成交明细行'],
  [/^REPLAY (.+)× ENDED$/, '回放 $1× 已结束'],
  [/^REPLAY (.+)× PLAYING$/, '回放 $1× 播放中'],
  [/^REPLAY (.+)× PAUSED$/, '回放 $1× 已暂停'],
  [/^replay refused — (.+); retrying$/, '回放被拒绝 — $1；正在重试'],
  [/^replay speed (.+)×, click to change$/, '回放速度 $1×，点击更改'],
  [/^Watchlist full \((\d+)\)$/, '自选已满（$1）'],
  [/^Add (.+) to the watchlist$/, '把 $1 加入自选'],
  [/^Remove (.+) from watchlist$/, '从自选中移除 $1'],
  [/^Talent Velocity: (.+)% R&D Openings \((.+) listings\)$/, '招聘速度：$1% 研发职位（$2 个职位）'],
  [/^Active \((\d+)\)$/, '已启用（$1）'],
  [/^(.+), (.+) channel$/, '$1，$2 通道'],
  [/^(.+), (.+) depth$/, '$1，$2 深度'],
];

const ATTRS = ['title', 'aria-label', 'placeholder', 'alt'] as const;
const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE']);
const DONE = new Set<string>(Object.values(EXACT));

export function translateText(s: string): string | null {
  const trimmed = s.trim();
  if (!trimmed || DONE.has(trimmed) || !/[A-Za-z]/.test(trimmed)) return null;
  const hit = EXACT[trimmed] ?? EXACT[trimmed.replace(/\s+/g, ' ')];
  let out: string | null = hit ?? null;
  if (out === null) {
    for (const [re, rep] of PATTERNS) {
      if (re.test(trimmed)) {
        out = trimmed.replace(re, (...m: string[]) =>
          rep.replace(/\$(\d)/g, (_x, n: string) => {
            const v = m[Number(n)];
            return EXACT[v] ?? v;
          }),
        );
        break;
      }
    }
  }
  if (out === null) return null;
  const lead = s.match(/^\s*/)?.[0] ?? '';
  const tail = s.match(/\s*$/)?.[0] ?? '';
  return lead + out + tail;
}

function translateElementAttrs(el: Element): void {
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (v) {
      const t = translateText(v);
      if (t !== null && t !== v) el.setAttribute(a, t);
    }
  }
}

function walk(root: Node): void {
  if (root.nodeType === Node.TEXT_NODE) {
    const p = root.parentElement;
    if (p && (SKIP.has(p.tagName) || p.isContentEditable)) return;
    const v = root.nodeValue ?? '';
    const t = translateText(v);
    if (t !== null && t !== v) root.nodeValue = t;
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
  const el = root as Element;
  if (el.tagName && SKIP.has(el.tagName)) return;
  if (root.nodeType === Node.ELEMENT_NODE) translateElementAttrs(el);
  for (let c = root.firstChild; c; c = c.nextSibling) walk(c);
}

let observer: MutationObserver | null = null;

function start(): void {
  if (observer || typeof MutationObserver === 'undefined' || !document.body) return;
  walk(document.body);
  document.title = translateText(document.title) ?? document.title;
  observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'childList') r.addedNodes.forEach(walk);
      else if (r.type === 'characterData') walk(r.target);
      else if (r.type === 'attributes' && r.target instanceof Element) translateElementAttrs(r.target);
    }
  });
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [...ATTRS],
  });
}

let patchedDialogs = false;
function patchDialogs(): void {
  if (patchedDialogs) return;
  patchedDialogs = true;
  const oc = window.confirm.bind(window);
  const oa = window.alert.bind(window);
  window.confirm = (m?: string) => oc(m === undefined ? m : (translateText(String(m)) ?? m));
  window.alert = (m?: unknown) => oa(m === undefined ? m : (translateText(String(m)) ?? m));
}

/** 在 main.tsx 里调用一次。 */
export function installZhDom(): void {
  const apply = () => {
    if (getLocale() === 'zh') {
      patchDialogs();
      if (document.body) start();
      else document.addEventListener('DOMContentLoaded', start, { once: true });
    } else if (observer) {
      observer.disconnect();
      observer = null;
      location.reload();
    }
  };
  apply();
  subscribeLocale(apply);
}
