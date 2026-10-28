/* aggr 中文界面：不改 aggr 源码，在运行时把界面上的英文文字替换成中文。
   做法与 FlowMap 汉化补丁相同：监听 DOM 变化，按"整段文字完全一致"查表替换文字节点和
   title / placeholder / aria-label 属性；动态拼接的句子用正则。代码编辑器里的内容不动。 */
(function () {
  'use strict';
  var EXACT = {
    // 菜单与面板
    'Chart': '图表', 'Live Chart': '实时图表', 'Trades': '成交', 'Legacy trades feed': '旧版成交列表', 'Liquidations': '爆仓',
    'Stats': '统计', 'Counters': '计数器', 'Prices': '价格', 'Watchlist': '自选', 'Website': '网页', 'Embed website': '嵌入网页',
    'Alerts': '提醒', 'Manage alerts': '管理提醒', 'Audio': '声音', 'Pane': '面板', 'Panels': '面板', 'Menu': '菜单',
    'LITE ⚡️': '精简版 ⚡️', 'Minimal but faster': '更简洁、更快', '% change & volume': '涨跌幅与成交量',
    'Buys/sells by intervals': '按时间段统计买卖', 'Custom rolling metrics': '自定义滚动指标',
    'Settings': '设置', 'Preferences': '偏好', 'Options': '选项', 'Other options': '其他选项', 'Other': '其他',
    'Maximize': '最大化', 'Sources': '数据源', 'Sync': '同步', 'Arrange': '排列', 'Restart': '重启', 'Snapshot': '截图',
    'Save positions': '保存位置', 'Revert back to original positions': '恢复原来的位置',
    'Maintain shift key to change timeframe on all panes': '按住 Shift 可同时修改所有面板的周期',
    // 搜索 / 市场
    'Search...': '搜索…', 'Search': '搜索', 'Search history': '搜索记录', 'Show recents': '显示最近使用', 'Clear': '清空',
    'Exchanges': '交易所', 'Currency': '币种', 'Type': '类型', 'Perpetuals': '永续', 'Spots': '现货', 'Futures': '期货',
    'Extras': '其他', 'Group by pair': '按交易对分组', 'Merge stablecoins': '合并稳定币', 'Connect to all': '全部连接',
    'Connect →': '连接', 'add all': '全部添加', 'Manage connections': '管理连接', 'With historical data': '有历史数据',
    'historical data available for this market': '这个市场有历史数据', 'Updating database...': '正在更新数据库…',
    'No results': '没有结果', 'add markets': '添加市场', 'No active markets,': '没有已连接的市场，',
    // 图表设置
    'Scales': '坐标轴', 'Left': '左侧', 'Right': '右侧', 'Time': '时间', 'Borders': '边框', 'Border color': '边框颜色',
    'Text color': '文字颜色', 'Show legend': '显示图例', 'Show horizontal grid lines': '显示水平网格线',
    'Show vertical grid lines': '显示竖直网格线', 'Horizontal line color': '水平线颜色', 'Vertical line color': '竖直线颜色',
    'Watermark': '水印', 'Watermark color': '水印颜色', 'Fill gaps with empty bars': '用空 K 线填补缺口',
    'Refresh chart every': '图表刷新间隔', 'Low refresh rate can be': '刷新频率太低可能', 'CPU intensive': '比较耗 CPU',
    'Timeframe': '周期', 'Unknown timeframe': '无法识别的周期', 'Go': '确定', 'ex 1m': '例如 1m',
    'Edit': '编辑', 'Flip': '翻转', 'Label': '标签', 'Visible': '显示', 'Manage': '管理', 'Scale with:': '共用坐标轴：',
    'Scale with': '共用坐标轴', 'Default scale': '默认坐标轴',
    // 指标
    'Indicators': '指标', 'Installed': '已安装', 'Community': '社区', 'Add to chart': '添加到图表', 'Install': '安装',
    'New indicator': '新建指标', 'Create blank indicator': '新建空白指标', 'Create': '创建', 'Untitled': '未命名',
    'Script': '脚本', 'Script options': '脚本选项', 'Colors': '颜色', 'Format': '格式', 'Precision': '精度', 'Scale': '坐标轴',
    'Save changes': '保存修改', 'Discard': '放弃', 'Reset': '重置', 'Rollback changes': '撤销修改', 'Save changes ?': '保存修改？',
    'Duplicate': '复制', 'Rename': '重命名', 'Download': '下载', 'Bring ahead': '移到前面', 'Send behind': '移到后面',
    'Resize': '调整大小', 'Remove': '删除', 'Add': '添加', 'search option...': '搜索选项…',
    'Volume uses abbreviation for Million and Thousand': '成交量用 K / M 缩写',
    'Enable by default<br>on new charts': '新图表默认启用', 'Author': '作者', 'Date': '日期', 'Name': '名称',
    'Description': '说明', 'Preview': '预览', 'Save': '保存', 'Save as': '另存为', 'Version': '版本',
    'Created at': '创建于', 'Updated at': '更新于', 'Created': '创建', 'Updated': '更新',
    'No history available': '没有历史版本', 'Publish': '发布', 'Publish request': '申请发布',
    'Scripting documentation': '脚本文档', 'Wiki': '说明文档', 'Word Wrap': '自动换行',
    'Choose what to include': '选择要包含的内容', 'Include script in preset': '预设里包含脚本',
    'Toggle all color options': '全选颜色选项', 'Toggle all other options': '全选其他选项',
    'Configure preset': '设置预设', 'Failed to fetch indicator': '获取指标失败', 'Failed to fetch indicators': '获取指标失败',
    'Referenced indicator': '引用的指标', 'Name (or leave empty)': '名称（可留空）',
    // 预设
    'Apply': '应用', 'Update': '更新', 'Import from preset file': '从预设文件导入', 'Download preset file': '下载预设文件',
    'Preset looks empty': '预设是空的', 'You did not select anything to save in the preset !': '没有选择要保存到预设的内容！',
    'Import': '导入', 'IMPORT': '导入', 'Import settings': '导入设置', 'Markets': '市场',
    // 成交设置
    'Thresholds': '阈值', 'Threshold': '阈值', 'Add a threshold': '添加阈值', 'Custom thresholds': '自定义阈值',
    'Amount*': '金额*', 'Amounts': '金额', 'MAX': '最大', 'Set as maximum amount': '设为最大金额',
    'Will only show trades below that amount': '只显示低于这个金额的成交',
    'Increase threshold →': '提高阈值', '← Decrease threshold': '降低阈值',
    'Enter the absolute amount<br>or % of significant amount': '填写金额<br>或显著金额的百分比',
    'Small orders': '小单', 'Large orders': '大单', 'Number of trades rendered': '显示的成交笔数', 'Lines count': '行数',
    'Show logos': '显示交易所图标', 'Monochrome logos': '单色图标', 'Show pairs': '显示交易对', 'Show prices': '显示价格',
    "Show symbol's names<br>(ex: BTC-USD)": '显示交易对名称<br>（例如 BTC-USD）', 'Transpose': '横向排列',
    'Time format': '时间格式', 'Time format preference': '时间格式偏好', 'Formats': '格式',
    'Show the weighted average price instead of the last price for aggregated trade results': '聚合成交显示加权平均价，而不是最后成交价',
    'Weighted average': '加权平均', 'Histogram': '柱状图', 'Rolling delta histogram': '滚动 Delta 柱状图',
    'Mute pane': '面板静音', 'Pane volume': '面板音量', 'Audio is currently disabled': '声音目前已关闭',
    'Click to enable audio': '点击开启声音', 'Minimum for a trade to trigger a sound': '触发声音的最小成交额',
    'Enable animations to show gifs': '开启动画以显示 GIF', 'Upgrade': '升级',
    '✨ Upgrade to the canvas based feed for better performance ✨': '✨ 升级到画布版成交列表，性能更好 ✨',
    'Buy': '买入', 'Sell': '卖出', 'Buy gif': '买入 GIF', 'Sell gif': '卖出 GIF', 'Giphy keyword': 'GIF 关键词',
    'Custom colors': '自定义颜色',
    // 声音
    'Enable audio': '开启声音', 'Configure threshold audio': '设置阈值声音', 'Synthetize sound': '合成声音',
    'Import audio': '导入音频', 'Original': '原始', 'Custom': '自定义', 'When buy': '买入时', 'When sell': '卖出时',
    'Advanced': '高级', 'Browse': '浏览', 'Delay': '延迟', 'Duration': '时长', 'Dynamic': '动态', 'Frequency': '频率',
    'Gain': '增益', 'Start Gain': '起始增益', 'End Gain': '结束增益', 'Fade In': '淡入', 'Fade Out': '淡出',
    'Output': '输出', 'Source': '来源', 'Restart audio': '重启声音', 'Restart audio service (clear ALL queue)': '重启声音服务（清空全部队列）',
    'learn more': '了解更多', 'Ok': '确定', 'Cancel': '取消', 'Audio disabled 🔇': '声音已关闭 🔇', 'Audio enabled 🔊': '声音已开启 🔊',
    'Audio resumed successfully 🔊': '声音已恢复 🔊',
    // 统计 / 计数器 / 价格
    'Add a stat': '添加统计项', 'Enable bucket': '启用分桶', 'Enable graph': '显示图形', 'Graph': '图形', 'BUCKET': '分桶',
    'Window': '窗口', 'Window (m)': '窗口（分钟）', 'Window (minutes)': '窗口（分钟）',
    'Interval in which data is summed (ex: 1m)': '数据累计的时间段（例如 1m）', 'Sum': '求和', 'Value': '数值',
    'Sum over given interval (ex: 30s or 10m or 1h)': '在给定时间段内求和（例如 30s、10m、1h）', 'Decimal precision': '小数位数',
    'Color condition': '颜色条件', 'Enable onditionnal color': '启用条件颜色', "ex: value > 0 ? 'red' : 'white'": "例如：value > 0 ? 'red' : 'white'",
    'Only count liquidations': '只统计爆仓', 'Sum amount of trades instead of volume': '统计成交笔数而不是成交量',
    'Enter a set of timeframes (ie 1m, 15m)': '填写一组周期（例如 1m, 15m）', 'Comma separated list of steps (ex: 1m, 5m, 10m, 15m)': '用逗号分隔的周期（例如 1m, 5m, 10m, 15m）',
    'Show price': '显示价格', 'Show price change': '显示涨跌幅', 'Show volume': '显示成交量', 'Show volume Δ': '显示成交量差',
    'Show Symbols': '显示交易对', 'Ticker only': '只显示代码', 'BTCUSDT → BTC': 'BTCUSDT → BTC',
    'Sort by': '排序', 'Sort animation': '排序动画', 'Switch order': '切换顺序', 'Volume filter': '成交量过滤',
    'Enter amount': '填写金额', 'Filter': '过滤', 'Period': '周期', 'No period': '不重置', 'Avg. periods': '平均周期数',
    'Average the previous period data into the new': '把上一周期的数据平均到新周期', 'AVERAGED': '平均',
    'Automatically clear the data at predetermined intervals': '按设定的时间间隔自动清空数据', 'Customization': '自定义',
    'TRADES': '成交笔数', 'TRADES Δ': '成交笔数差', 'VOLUME Δ': '成交量差',
    // 提醒
    'Price alerts': '价格提醒', 'Alert color': '提醒颜色', 'Alert sound': '提醒声音', 'Control': '控制',
    'Line style': '线型', 'Line style (ex: dashed)': '线型（例如 dashed）', 'Line width': '线宽', 'Line width (ex: 2)': '线宽（例如 2）',
    'Uses average price of the coin': '使用该币的平均价格', 'Notifications are blocked.': '通知已被阻止。',
    'Awaiting browser persmission.': '等待浏览器授权。', 'Alert @': '提醒 @', 'Custom message (optional)': '自定义消息（可选）',
    'No alerts': '没有提醒', 'no alerts': '没有提醒', 'Active': '已启用', 'Inactive': '未启用', 'Triggered': '已触发',
    'Check status': '查看状态', '1 click': '单击', 'Place alerts faster ⚡️': '更快地设置提醒 ⚡️',
    'Alerts are disabled': '提醒已关闭', 'Enable alerts ?': '开启提醒？', 'Color': '颜色',
    // 设置对话框
    'Data': '数据', 'RAW': '原始', 'No aggregation': '不聚合', 'Will pull Binance tick data': '获取币安逐笔数据',
    "Will pull aggregated Binance data but won't aggregate on top of it": '获取币安聚合数据，不再二次聚合',
    'Processing raw data eats up CPU power': '处理原始数据比较耗 CPU', 'Show Slippage': '显示滑点',
    'Size display preference': '数量显示方式', 'Size in': '数量单位', 'main volume': '主成交量', 'Granularity preference': '精度偏好',
    'aggregation, slippage, currency': '聚合、滑点、币种', 'background, buy/sell color': '背景、买卖颜色',
    'enable/disable exchange globally': '全局开关交易所', 'Background color': '背景颜色', 'App text color': '界面文字颜色',
    'Buy color': '买入颜色', 'Sell color': '卖出颜色', 'Workspaces': '工作区', 'New': '新建', 'Create blank template': '新建空白模板',
    'Upload template file': '上传模板文件', 'Open in a tab': '在新标签页打开', 'Export database': '导出数据库',
    'Reset to default': '恢复默认', 'reset everything': '全部重置', 'Reset app': '重置应用', 'Reset everything ?': '全部重置？',
    'Are you sure ?': '确定吗？', 'Github': 'GitHub', 'Other settings': '其他设置',
    'Auto hide names': '自动隐藏名称', 'Floating headers': '浮动标题栏', 'Simple watermarks': '简单水印',
    'Use local time for charts': '图表使用本地时间', 'Use slider for thresholds': '阈值用滑块调节',
    // 网页面板
    'Url': '网址', 'Load': '加载', 'Reload': '重新加载', 'Interactive': '可交互', 'Invert': '反色', 'Invert site colors': '网页反色',
    'Automatic reload': '自动刷新', 'Automaticaly reload the website after some time': '一段时间后自动刷新网页', 'Never': '从不',
    'Currently set to': '当前设置为', 'Yes, authorize': '是的，允许',
    'Some url might not work because of the cross domain policy in place for that website': '有些网址因为对方网站的跨域限制可能无法加载',
    'Allow interaction (click, scroll etc)<br>Keep it OFF to move the pane around with ease.': '允许交互（点击、滚动等）<br>关闭时更方便拖动面板。',
    'Security Warning': '安全提示',
    // 连接问题
    'Connection issue': '连接问题', "Can't connect to": '无法连接', 'Connecting to': '正在连接', 'Please wait': '请稍候',
    'Retry connection with exchange': '重新连接交易所', 'Troubleshoot': '排查问题', 'Use a VPN': '使用代理 / VPN',
    'I enabled my VPN': '我已开启代理', 'Disable': '禁用', 'Disable all': '全部禁用', 'Dismiss': '忽略', 'Back': '返回',
    'The exchange API is unreachable due to': '交易所接口无法访问，原因是', 'geo restriction': '地区限制', 'or something else.': '或其他原因。',
    'Beginning in late November 2022, Binance began declining API requests originating from US IP addresses.': '从 2022 年 11 月下旬起，币安会拒绝来自美国 IP 的接口请求。',
    "'s pairs so you won't see the issue anymore": ' 的交易对，以后就不会再看到这个问题', 'Last used :': '上次使用：',
    'The current proxy URL might not be working': '当前的转发地址可能不可用', 'Clear proxy URL': '清除转发地址',
    // 其他
    'Loading': '加载中', 'Update notice': '更新提示', 'Not found': '没有找到', 'No chart': '没有图表',
    '💡 Stuck here ?': '💡 卡在这里了？', 'Never see again': '不再显示', 'Next': '下一步', 'Submit': '提交', 'Open': '打开',
    'Or': '或', 'Thank you': '谢谢', 'Show preview': '显示预览', 'Default color': '默认颜色', 'Save color': '保存颜色',
    'Transparent': '透明', 'Rotate': '旋转', 'Color space thumb': '色域滑块',
    // 脚本里拼出来的提示
    'Show more': '显示更多', 'Show less': '收起', 'Accept and Proceed': '同意并继续',
    'There is no current workspace': '当前没有工作区', 'This action will override ALL your aggr data.': '这个操作会覆盖你所有的 aggr 数据。',
    'Please remove one or more existing panes to create space before adding a new pane': '请先删掉一个或几个面板，腾出位置再添加新面板',
    'Determine how loud it should be (0 to 1 to avoid saturation)': '音量大小（0 到 1，避免失真）',
    'Direct link to song (.mp3, .wav, .ogg) or name of already imported file': '音频文件直链（.mp3、.wav、.ogg）或已导入文件的名称',
    'Duration of the IN transition (in seconds, default is 0)': '淡入时长（秒，默认 0）',
    'Duration of the OUT transition (in seconds, default is 1)': '淡出时长（秒，默认 1）',
    'Final gain (after fadeOut)': '最终增益（淡出之后）', 'Initial gain (before fadeIn)': '初始增益（淡入之前）',
    'Hold the note for n seconds (default 0)': '音符保持 n 秒（默认 0）',
    'Offset the start of the song at second n (to play only a part of it)': '从第 n 秒开始播放（只放其中一段）',
    'Type of wave used for the note (can be triangle, square, sawtooth, sin etc)': '音符的波形（triangle、square、sawtooth、sin 等）',
    'Wait n seconds before play the note': '等 n 秒再播放', 'Aggr server seems down 💀': 'aggr 服务器连不上 💀',
    'quote currency': '计价币', 'base currency': '基础币', 'DONATE': '捐助', 'Price': '价格', 'Volume': '成交量',
    'Go fullscreen': '全屏', 'Exit fullscreen': '退出全屏',
  };
  var UNIT = { s: '秒', m: '分钟', h: '小时', d: '天', w: '周', mo: '个月', y: '年' };

  // 动态拼接的句子
  var PATTERNS = [
    [/^Connecting to (.+?)\.?$/, '正在连接 $1'],
    [/^Can't connect to (.+?)\.?$/, '无法连接 $1'],
    [/^(\d+) markets?$/, '$1 个市场'],
    [/^(\d+) results?$/, '$1 个结果'],
    [/^(.+) options$/, '$1 选项'],
    [/^Refresh chart every (.+)$/, '图表每 $1 刷新一次'],
    [/^Removed gifs about "(.+)"$/, '已删除关于“$1”的 GIF'],
    [/^Unrecognized pane type "(.+)"$/, '无法识别的面板类型“$1”'],
    [/^matching "(.+)"$/, '匹配“$1”'],
    [/^Last used : (.+)$/, '上次使用：$1'],
    [/^Waiting for trades >\s*(.+)$/, '等待大于 $1 的成交'],
    [/^Waiting for liquidations >\s*(.+)$/, '等待大于 $1 的爆仓'],
    [/^Failed to format (.+)'s products$/, '整理 $1 的交易对列表失败'],
    [/^Reconnecting (.+)$/, '正在重连 $1'],
    [/^Deleted indicator (.+)$/, '已删除指标 $1'],
    [/^Duplicated pane (.+)$/, '已复制面板 $1'],
    [/^Saved indicator (.+)$/, '已保存指标 $1'],
    [/^Imported workspace (.+)$/, '已导入工作区 $1'],
    [/^Imported sound (.+)$/, '已导入声音 $1'],
    [/^Imported (.+) as preset for (.+)$/, '已把 $1 导入为 $2 的预设'],
    [/^Workspace "(.+)" already exists$/, '工作区“$1”已存在'],
    [/^This preset "(.+)" already exists\.$/, '预设“$1”已存在。'],
    [/^Pane (.+) doesn't exists$/, '面板 $1 不存在'],
    [/^Indicator (.+) doesn't exist in your library, nothing to rollback to\.$/, '库里没有指标 $1，无法回退。'],
    [/^Failed to load sound buffer (.+)$/, '加载声音 $1 失败'],
    [/^Please check that (.+) audio script is syntactically correct\.$/, '请检查 $1 的声音脚本语法是否正确。'],
    [/^Preset doesn't match with pane type \((.+) is not (.+)\)$/, '预设和面板类型不匹配（$1 不是 $2）'],
    [/^(\d+)\s*ms aggregation$/, '$1ms 聚合'],
    [/^created (\d+)\s*(s|m|h|d|w|mo|y) ago$/, function (_, n, u) { return '创建于 ' + n + ' ' + UNIT[u] + '前'; }],
    [/^(\d+)\s*(s|m|h|d|w|mo|y) ago$/, function (_, n, u) { return n + ' ' + UNIT[u] + '前'; }],
    [/^Removed (.+)$/, '已删除 $1'],
  ];

  var SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, CODE: 1, PRE: 1 };
  // on / off：aggr 的开关按钮用 CSS 把这两个属性的值显示成文字
  var ATTRS = ['title', 'placeholder', 'aria-label', 'alt', 'data-tippy-content', 'on', 'off'];
  var LOWER = {};
  for (var k in EXACT) if (Object.prototype.hasOwnProperty.call(EXACT, k)) LOWER[k.toLowerCase()] = EXACT[k];

  function translateText(s) {
    if (!s) return null;
    var t = s.trim().replace(/\u00a0/g, ' '); // aggr 常用 &nbsp; 连接数字和单位
    if (!t || t.length > 300) return null;
    var hit = EXACT[t] || LOWER[t.toLowerCase()];
    if (!hit) {
      for (var i = 0; i < PATTERNS.length; i++) {
        if (PATTERNS[i][0].test(t)) { hit = t.replace(PATTERNS[i][0], PATTERNS[i][1]); break; }
      }
    }
    if (!hit || hit === t) return null;
    var lead = s.match(/^\s*/)[0], tail = s.match(/\s*$/)[0];
    return lead + hit.replace(/<br>/g, ' ') + tail;
  }
  function inEditor(el) { return !!(el && el.closest && el.closest('.monaco-editor, [contenteditable="true"]')); }
  function doNode(node) {
    if (node.nodeType === 3) {
      var p = node.parentElement;
      if (!p || SKIP[p.tagName] || inEditor(p)) return;
      var r = translateText(node.nodeValue);
      if (r !== null) node.nodeValue = r;
    } else if (node.nodeType === 1) {
      if (SKIP[node.tagName] || inEditor(node)) return;
      for (var i = 0; i < ATTRS.length; i++) {
        var v = node.getAttribute(ATTRS[i]);
        if (v) { var r2 = translateText(v); if (r2 !== null) node.setAttribute(ATTRS[i], r2.trim()); }
      }
      // innerHTML 里带 <br> 的整段（例如复选框说明）
      if (node.childNodes.length > 1 && node.childNodes.length <= 5 && /<br>/i.test(node.innerHTML) && !node.querySelector('*:not(br)')) {
        var whole = EXACT[node.innerHTML.trim()];
        if (whole) { node.innerHTML = whole; return; }
      }
      for (var c = node.firstChild; c; c = c.nextSibling) doNode(c);
    }
  }
  function start() {
    doNode(document.body);
    new MutationObserver(function (list) {
      for (var i = 0; i < list.length; i++) {
        var m = list[i];
        if (m.type === 'characterData') doNode(m.target);
        else if (m.type === 'attributes') doNode(m.target);
        else for (var j = 0; j < m.addedNodes.length; j++) doNode(m.addedNodes[j]);
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    document.documentElement.lang = 'zh-CN';
    if (document.title === 'AGGR' || /aggr/i.test(document.title)) document.title = '聚合成交 - VPFM';
  }
  // 原生确认框
  var nativeConfirm = window.confirm, nativeAlert = window.alert;
  window.confirm = function (m) { return nativeConfirm.call(window, translateText(String(m)) || m); };
  window.alert = function (m) { return nativeAlert.call(window, translateText(String(m)) || m); };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
  window.__vpfmZhAggr = { translateText: translateText };
})();
