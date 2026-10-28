'use strict';
/* 衍生品数据：价格 + 合约/现货 CVD、聚合持仓、资金费率、多空比、实时爆仓、跨所资金费率表。
   数据全部来自各交易所的公开接口（经本地服务转发），不依赖第三方数据网站。 */
(function () {
  const { fmt, ex, n } = VP;
  const LW = window.LightweightCharts;
  const $ = s => document.querySelector(s);
  const TFS = ['5m', '15m', '1h', '4h', '1d'];
  const QUICK = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
  const st = VP.store('derivs', { coin: 'BTC', tf: '15m', liqScope: 'coin', liqMin: 10000, sort: 'oi', dir: -1 });
  let coin = st.get().coin;
  let tf = TFS.includes(st.get().tf) ? st.get().tf : '15m';
  const errors = new Map();

  /* ------------------------------------------------------------ 交易对解析 */
  // 各交易所上该币的合约代码（考虑 1000PEPE、kPEPE 之类的倍数写法）
  const markets = { bn: new Map(), by: new Map(), ok: new Map(), bg: new Map(), hl: new Map(), ready: null };
  async function loadMarkets() {
    const [bnP, byT, okT, bgT, hl] = await Promise.allSettled([
      ex.binance.premiumAll(), ex.bybit.tickers(), ex.okx.tickers(), ex.bitget.tickers(), ex.hyperliquid.ctxs(),
    ]);
    if (bnP.status === 'fulfilled') for (const x of bnP.value) if (/USDT$/.test(x.symbol)) { const [b, m] = VP.baseOf(x.symbol.slice(0, -4)); if (!markets.bn.has(b) || m === 1) markets.bn.set(b, { sym: x.symbol, mult: m }); }
    if (byT.status === 'fulfilled') for (const x of byT.value) if (/USDT$/.test(x.symbol)) { const [b, m] = VP.baseOf(x.symbol.slice(0, -4)); if (!markets.by.has(b) || m === 1) markets.by.set(b, { sym: x.symbol, mult: m }); }
    if (okT.status === 'fulfilled') for (const x of okT.value) if (/-USDT-SWAP$/.test(x.instId)) markets.ok.set(x.instId.split('-')[0], { inst: x.instId, mult: 1 });
    if (bgT.status === 'fulfilled') for (const x of bgT.value) if (/USDT$/.test(x.symbol)) { const [b, m] = VP.baseOf(x.symbol.slice(0, -4)); if (!markets.bg.has(b) || m === 1) markets.bg.set(b, { sym: x.symbol, mult: m }); }
    if (hl.status === 'fulfilled') for (const x of hl.value) if (!x.delisted) { const k = /^k[A-Z]/.test(x.name); markets.hl.set(k ? x.name.slice(1) : x.name, { name: x.name, mult: k ? 1000 : 1 }); }
    // 币种候选：按币安 24h 成交额排序
    try {
      const t = await ex.binance.ticker24();
      const list = t.filter(x => /USDT$/.test(x.symbol)).sort((a, b) => n(b.quoteVolume) - n(a.quoteVolume)).map(x => VP.baseOf(x.symbol.slice(0, -4))[0]);
      $('#coinList').innerHTML = [...new Set(list)].slice(0, 250).map(b => `<option value="${b}">`).join('');
    } catch { /* 候选列表不是必须的 */ }
  }
  const resolve = c => ({ bn: markets.bn.get(c), by: markets.by.get(c), ok: markets.ok.get(c), bg: markets.bg.get(c), hl: markets.hl.get(c) });

  function noteErr(key, e) { if (e) errors.set(key, e.message || String(e)); else errors.delete(key); showStatus(); }
  let lastOk = 0;
  function showStatus() {
    const s = $('#status');
    const errs = [...errors.values()];
    s.classList.toggle('bad', errs.length > 0);
    s.textContent = (lastOk ? `更新于 ${fmt.time(lastOk)}` : '加载中…') + (errs.length ? `，${errs.length} 项数据获取失败` : '');
    s.title = errs.join('\n');
  }

  /* ------------------------------------------------------------ 顶栏 */
  function buildTop() {
    $('#tf').innerHTML = TFS.map(t => `<button type="button" data-v="${t}">${t}</button>`).join('');
    $('#quick').innerHTML = QUICK.map(c => `<button type="button" class="chip" data-v="${c}">${c}</button>`).join('');
    $('#tf').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setTf(b.dataset.v); });
    $('#quick').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setCoin(b.dataset.v); });
    const inp = $('#coin');
    inp.value = coin;
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { setCoin(inp.value); inp.blur(); } });
    inp.addEventListener('change', () => setCoin(inp.value));
    markTop();
  }
  function markTop() {
    document.querySelectorAll('#tf button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === tf)));
    document.querySelectorAll('#quick button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === coin)));
    $('#coin').value = coin;
  }
  function setCoin(c) {
    c = String(c || '').trim().toUpperCase().replace(/[-_/]?(USDT|USD|PERP|SWAP)$/, '');
    c = VP.baseOf(c)[0];
    if (!c || c === coin) { markTop(); return; }
    coin = c; st.set({ coin }); markTop();
    kpiTimer.now(); chartTimer.now(); renderLiqs();
  }
  function setTf(t) {
    if (!TFS.includes(t) || t === tf) return;
    tf = t; st.set({ tf }); markTop(); chartTimer.now();
  }

  /* ------------------------------------------------------------ 指标条 */
  const settle = async obj => {
    const keys = Object.keys(obj);
    const res = await Promise.allSettled(keys.map(k => obj[k]));
    const out = {}, errs = {};
    res.forEach((r, i) => { if (r.status === 'fulfilled') out[keys[i]] = r.value; else errs[keys[i]] = r.reason; });
    return [out, errs];
  };
  const skip = () => Promise.reject(new Error('未上线'));

  let nextFunding = 0;
  async function loadKpis() {
    if (!markets.ready) return;
    const m = resolve(coin);
    const [r] = await settle({
      bnT: m.bn ? ex.binance.ticker24(m.bn.sym) : skip(),
      bnP: m.bn ? ex.binance.premium(m.bn.sym) : skip(),
      bnOi: m.bn ? ex.binance.openInterest(m.bn.sym) : skip(),
      bnOiH: m.bn ? ex.binance.oiHist(m.bn.sym, '1h', 25) : skip(),
      bnLs: m.bn ? ex.binance.lsAccounts(m.bn.sym, '5m', 1) : skip(),
      bnTop: m.bn ? ex.binance.lsTopPos(m.bn.sym, '5m', 1) : skip(),
      byT: m.by ? ex.bybit.tickers(m.by.sym) : skip(),
      okOi: m.ok ? ex.okx.oi(m.ok.inst) : skip(),
      okF: m.ok ? ex.okx.funding(m.ok.inst) : skip(),
      okT: m.ok ? ex.okx.ticker(m.ok.inst) : skip(),
      bgT: m.bg ? ex.bitget.ticker(m.bg.sym) : skip(),
      hl: m.hl ? ex.hyperliquid.ctxs() : skip(),
    });
    const parts = [];
    let price = NaN, chg = NaN;
    if (r.bnT) { price = n(r.bnT.lastPrice); chg = n(r.bnT.priceChangePercent) / 100; }
    const by = r.byT && r.byT[0];
    const okT = r.okT || null;
    const bg = r.bgT || null;
    const hl = r.hl && m.hl ? r.hl.find(x => x.name === m.hl.name) : null;
    if (!isFinite(price) && by) { price = n(by.lastPrice); chg = n(by.price24hPcnt); }

    // 持仓（美元）与资金费率（折算到 8 小时），按持仓加权
    const oi = {}, fr = {};
    if (r.bnOi && r.bnP) oi.binance = n(r.bnOi.openInterest) * n(r.bnP.markPrice);
    if (r.bnP) fr.binance = n(r.bnP.lastFundingRate) * 8 / (fundingHours.get(m.bn.sym) || 8);
    if (by) { oi.bybit = n(by.singleOpenInterestValue ?? by.openInterestValue); fr.bybit = n(by.fundingRate) * 8 / (n(by.fundingIntervalHour) || 8); }
    if (r.okOi) oi.okx = n(r.okOi.oiUsd);
    if (r.okF) { const h = (n(r.okF.nextFundingTime) - n(r.okF.fundingTime)) / 3.6e6; fr.okx = n(r.okF.fundingRate) * 8 / (h > 0 ? h : 8); }
    if (bg) { oi.bitget = n(bg.holdingAmount) * n(bg.markPrice); fr.bitget = n(bg.fundingRate) * 8 / (bitgetHours.get(m.bg.sym) || 8); }
    if (hl) { oi.hyperliquid = n(hl.openInterest) * n(hl.markPx); fr.hyperliquid = n(hl.funding) * 8; }
    const oiTotal = Object.values(oi).filter(isFinite).reduce((a, b) => a + b, 0);
    let wSum = 0, wRate = 0;
    for (const k of Object.keys(fr)) if (isFinite(fr[k]) && isFinite(oi[k]) && oi[k] > 0) { wSum += oi[k]; wRate += fr[k] * oi[k]; }
    const wFunding = wSum > 0 ? wRate / wSum : NaN;
    let oiChg = NaN;
    if (r.bnOiH && r.bnOiH.length > 1) oiChg = n(r.bnOiH[r.bnOiH.length - 1].sumOpenInterestValue) / n(r.bnOiH[0].sumOpenInterestValue) - 1;
    if (r.bnP) nextFunding = n(r.bnP.nextFundingTime);
    const vol = (r.bnT ? n(r.bnT.quoteVolume) : 0) + (by ? n(by.turnover24h) : 0) + (okT ? n(okT.volCcy24h) * n(okT.last) : 0)
      + (bg ? n(bg.usdtVolume) : 0) + (hl ? n(hl.dayNtlVlm) : 0);
    const basis = r.bnP ? n(r.bnP.markPrice) / n(r.bnP.indexPrice) - 1 : NaN;
    const cls = v => (v > 0 ? 'up' : v < 0 ? 'down' : '');

    parts.push(`<div class="kpi big"><span class="k">${m.bn ? m.bn.sym + ' 永续' : coin + ' 永续'}</span><span class="v num">${fmt.price(price)}<small class="${cls(chg)}">${fmt.pct(chg)}</small></span></div>`);
    parts.push(`<div class="kpi"><span class="k">持仓合计（${Object.keys(oi).length} 所）</span><span class="v">${fmt.usd(oiTotal)}${isFinite(oiChg) ? `<small class="${cls(oiChg)}">${fmt.pct(oiChg)}</small><span class="tag">币安 24h</span>` : ''}</span></div>`);
    parts.push(`<div class="kpi"><span class="k">资金费率（持仓加权，8h）</span><span class="v">${fmt.rate(wFunding)}<span class="tag" id="fundCd">${nextFunding ? '下次 ' + fmt.countdown(nextFunding - Date.now()) : ''}</span></span></div>`);
    parts.push(`<div class="kpi"><span class="k">年化</span><span class="v">${isFinite(wFunding) ? fmt.pct(wFunding * 3 * 365, 1) : '—'}</span></div>`);
    if (r.bnLs && r.bnLs[0]) parts.push(`<div class="kpi"><span class="k">币安多空人数比</span><span class="v">${fmt.num(n(r.bnLs[0].longShortRatio), 2)}<small class="dim">多 ${fmt.num(n(r.bnLs[0].longAccount) * 100, 0)}%</small></span></div>`);
    if (r.bnTop && r.bnTop[0]) parts.push(`<div class="kpi"><span class="k">币安大户持仓比</span><span class="v">${fmt.num(n(r.bnTop[0].longShortRatio), 2)}</span></div>`);
    parts.push(`<div class="kpi"><span class="k">基差（标记/指数）</span><span class="v ${cls(basis)}">${fmt.pct(basis, 3)}</span></div>`);
    parts.push(`<div class="kpi"><span class="k">24h 合约成交额</span><span class="v">${fmt.usd(vol)}</span></div>`);
    $('#kpis').innerHTML = parts.join('');
    const anyOk = Object.keys(r).length > 0;
    noteErr('kpi', anyOk ? null : new Error(`${coin}：主要交易所都没有返回数据`));
    if (anyOk) { lastOk = Date.now(); showStatus(); }
  }
  setInterval(() => { const el = document.getElementById('fundCd'); if (el && nextFunding) el.textContent = '下次 ' + fmt.countdown(nextFunding - Date.now()); }, 1000);

  /* ------------------------------------------------------------ 图表 */
  const panes = {};
  function pane(id, opts = {}) {
    const el = document.getElementById(id);
    const body = el.querySelector('.pane-body');
    const chart = LW.createChart(body, VP.chartOptions({ autoSize: true, ...opts }));
    const msg = document.createElement('div');
    msg.className = 'pane-msg'; msg.textContent = '加载中…';
    body.append(msg);
    const p = { el, body, chart, msg, series: {} };
    // 隐形的"时间格"：每张图都放进全部 K 线时间点，几张图的横坐标才能一一对齐
    p.grid = chart.addLineSeries({ priceScaleId: 'vp-grid', visible: false, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
    chart.priceScale('vp-grid').applyOptions({ visible: false });
    p.say = (text, err = false) => {
      msg.hidden = !text; msg.classList.toggle('err', err);
      msg.innerHTML = '';
      if (text) {
        const d = document.createElement('div'); d.textContent = text; msg.append(d);
        if (err) { const b = document.createElement('button'); b.className = 'btn'; b.textContent = '重试'; b.onclick = () => chartTimer.now(); msg.append(b); }
      }
    };
    return p;
  }

  const amountFmt = { type: 'custom', minMove: 0.01, formatter: v => fmt.big(v, 2) };
  const usdFmt = { type: 'custom', minMove: 0.01, formatter: v => fmt.usd(v, 2) };
  const pctFmt = { type: 'custom', minMove: 0.000001, formatter: v => (v * 100).toFixed(4) + '%' };
  const ratioFmt = { type: 'custom', minMove: 0.0001, formatter: v => v.toFixed(2) };

  function buildCharts() {
    const c = VP.colors();
    const hideTime = { timeScale: { visible: false } };
    panes.price = pane('p-price', hideTime);
    panes.price.series.candles = panes.price.chart.addCandlestickSeries({
      upColor: c.up, downColor: c.down, borderVisible: false, wickUpColor: c.up, wickDownColor: c.down, priceLineVisible: true,
    });
    panes.price.series.vol = panes.price.chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: amountFmt, lastValueVisible: false, priceLineVisible: false });
    panes.price.chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    panes.cvd = pane('p-cvd', hideTime);
    panes.cvd.series.perp = panes.cvd.chart.addLineSeries({ color: c.amber, lineWidth: 2, priceFormat: usdFmt, title: '' });
    panes.cvd.series.spot = panes.cvd.chart.addLineSeries({ color: c.cyan, lineWidth: 2, priceFormat: usdFmt });

    panes.oi = pane('p-oi', hideTime);
    const area = (color) => panes.oi.chart.addAreaSeries({ lineColor: color, topColor: color + '55', bottomColor: color + '10', lineWidth: 1, priceFormat: usdFmt, priceLineVisible: false });
    panes.oi.series.total = area('#45d0e6');
    panes.oi.series.bnby = area(VP.EX_COLORS.bybit);
    panes.oi.series.bn = area(VP.EX_COLORS.binance);

    panes.funding = pane('p-funding', hideTime);
    for (const k of ['binance', 'bybit', 'okx']) {
      panes.funding.series[k] = panes.funding.chart.addLineSeries({ color: VP.EX_COLORS[k], lineWidth: 2, lineType: 1, priceFormat: pctFmt, priceLineVisible: false, lastValueVisible: true });
    }
    panes.funding.series.binance.createPriceLine({ price: 0, color: '#3a4a60', lineWidth: 1, lineStyle: 2, axisLabelVisible: false });

    panes.ls = pane('p-ls');
    const lsCols = { bnAcc: VP.EX_COLORS.binance, bnTop: '#ffd98a', byAcc: VP.EX_COLORS.bybit, okAcc: VP.EX_COLORS.okx };
    for (const [k, col] of Object.entries(lsCols)) {
      panes.ls.series[k] = panes.ls.chart.addLineSeries({ color: col, lineWidth: k === 'bnTop' ? 1 : 2, lineStyle: k === 'bnTop' ? 2 : 0, priceFormat: ratioFmt, priceLineVisible: false });
    }
    panes.ls.series.bnAcc.createPriceLine({ price: 1, color: '#3a4a60', lineWidth: 1, lineStyle: 2, axisLabelVisible: false });

    const list = Object.values(panes);
    VP.syncCharts(list.map(p => ({ chart: p.chart, series: Object.values(p.series)[0] })));
    list.forEach(p => p.chart.subscribeCrosshairMove(param => legends(param && param.time)));
    VP.onPrefs(() => {
      const c2 = VP.colors();
      panes.price.series.candles.applyOptions({ upColor: c2.up, downColor: c2.down, wickUpColor: c2.up, wickDownColor: c2.down });
      if (lastData) drawVolume(lastData.fk);
    });
  }

  // 时间轴对齐：取 ≤ t 的最近一个值（向前填充，最多容忍 maxGap 秒；粗粒度补上的点按自己的间隔 span 放宽）
  function lookup(series, maxGap) {
    let i = 0;
    return t => {
      while (i + 1 < series.length && series[i + 1].t <= t) i++;
      const p = series[i];
      return p && p.t <= t && t - p.t <= Math.max(maxGap, 2 * (p.span || 0)) ? p : null;
    };
  }
  const uniq = arr => { const out = []; let last = -Infinity; for (const x of arr) { if (x.time > last) { out.push(x); last = x.time; } } return out; };
  const LT = VP.localTime;

  // 历史要盖住整段 K 线（1000 根）：
  // 币安 /futures/data 每次最多 500 条（只存最近 30 天），按 endTime 往前再翻；
  async function bnDeep(fn, sym, want = 1000) {
    let out = await fn(sym, tf, 500);
    while (out.length && out.length < want) {
      const older = await fn(sym, tf, 500, n(out[0].timestamp) - 1);
      const fresh = older.filter(x => n(x.timestamp) < n(out[0].timestamp));
      if (!fresh.length) break;
      out = fresh.concat(out);
      if (older.length < 500) break;
    }
    return out;
  }
  // OKX 统计接口 5 分钟粒度只有最近 2 天、1 小时 30 天、1 天 180 天：细的优先，更早的部分用粗一级补上
  const OK_PERIODS = { '1m': ['5m'], '5m': ['5m', '1H'], '15m': ['5m', '1H'], '1h': ['1H', '1D'], '4h': ['1H', '1D'], '1d': ['1D'], '1w': ['1D'], '1M': ['1D'] };
  const OK_SPAN = { '5m': 300, '1H': 3600, '1D': 86400 };
  async function okxDeep(fn, ccy) {
    const periods = OK_PERIODS[tf] || ['1D'];
    const got = await Promise.allSettled(periods.map(p => fn(ccy, p)));
    let out = [];
    got.forEach((g, k) => {
      if (g.status !== 'fulfilled' || !g.value.length) return;
      const rows = g.value.map(x => ({ ...x, span: OK_SPAN[periods[k]] }));
      out = out.length ? rows.filter(x => x.t < out[0].t).concat(out) : rows;
    });
    if (!out.length && got[0].status === 'rejected') throw got[0].reason;
    return out;
  }
  const fundingHours = new Map();
  const bitgetHours = new Map();
  const medianGapH = arr => {
    if (arr.length < 3) return 8;
    const gaps = arr.slice(1).map((x, i) => x.t - arr[i].t).sort((a, b) => a - b);
    return Math.max(1, Math.round(gaps[Math.floor(gaps.length / 2)] / 3600));
  };

  let lastData = null;
  function drawVolume(fk) {
    const c = VP.colors();
    panes.price.series.vol.setData(uniq(fk.map(k => ({ time: LT(k.t), value: k.qv, color: (k.c >= k.o ? c.up : c.down) + '66' }))));
  }

  async function loadCharts() {
    if (!markets.ready) return;
    const m = resolve(coin);
    const want = coin + '|' + tf;
    const spotSym = coin + 'USDT';
    if (!m.bn && !m.by) {
      Object.values(panes).forEach(p => p.say(`${coin} 在币安和 Bybit 都没有 USDT 永续合约`, true));
      return;
    }
    const [r, errs] = await settle({
      fk: m.bn ? ex.binance.klinesDeep(m.bn.sym, tf, 1000) : ex.bybit.klines(m.by.sym, tf, 1000),
      sk: ex.binance.klinesDeep(spotSym, tf, 1000, { spot: true }),
      bnOi: m.bn ? bnDeep(ex.binance.oiHist, m.bn.sym) : skip(),
      byOi: m.by ? ex.bybit.oiHist(m.by.sym, tf, 1000) : skip(),
      okOi: m.ok ? okxDeep(ex.okx.oiVolHist, coin) : skip(),
      bnF: m.bn ? ex.binance.fundingHist(m.bn.sym, 300) : skip(),
      byF: m.by ? ex.bybit.fundingHist(m.by.sym, 200) : skip(),
      okF: m.ok ? ex.okx.fundingHist(m.ok.inst, 100) : skip(),
      bnLs: m.bn ? bnDeep(ex.binance.lsAccounts, m.bn.sym) : skip(),
      bnTop: m.bn ? bnDeep(ex.binance.lsTopPos, m.bn.sym) : skip(),
      byLs: m.by ? ex.bybit.lsAccounts(m.by.sym, tf, 1000) : skip(),
      okLs: m.ok ? okxDeep(ex.okx.lsHist, coin) : skip(),
    });
    if (want !== coin + '|' + tf) return; // 期间切换了币种或周期
    // 没上线的交易所、没有现货的币（币安返回 400）不算失败
    const realErr = Object.entries(errs).filter(([k, e]) => e.message !== '未上线' && !(k === 'sk' && e.status === 400));
    noteErr('charts', realErr.length ? new Error(realErr.map(([k, e]) => `${k}: ${e.message}`).join('；')) : null);

    // 价格
    const fk = r.fk || [];
    if (!fk.length) { Object.values(panes).forEach(p => p.say('价格数据获取失败：' + (errs.fk?.message || '无数据'), true)); return; }
    const sec = VP.TF[tf].sec;
    const t0 = fk[0].t;
    const gridData = fk.map(k => ({ time: LT(k.t) }));
    Object.values(panes).forEach(p => p.grid.setData(gridData));
    // 其他数据落到 K 线的时间格上：早于第一根 K 线的丢掉，同一格里取最后一个值
    const onGrid = pts => {
      const out = [];
      for (const p of pts) {
        if (!(p.t >= t0) || !isFinite(p.value)) continue;
        const time = LT(Math.floor(p.t / sec) * sec);
        if (out.length && out[out.length - 1].time === time) out[out.length - 1].value = p.value;
        else if (!out.length || time > out[out.length - 1].time) out.push({ time, value: p.value });
      }
      return out;
    };
    const last = fk[fk.length - 1].c;
    const prec = last >= 1000 ? 1 : last >= 10 ? 2 : last >= 1 ? 4 : last >= 0.01 ? 5 : 7;
    panes.price.series.candles.applyOptions({ priceFormat: { type: 'price', precision: prec, minMove: 10 ** -prec } });
    panes.price.series.candles.setData(uniq(fk.map(k => ({ time: LT(k.t), open: k.o, high: k.h, low: k.l, close: k.c }))));
    drawVolume(fk);
    $('#priceSrc').textContent = m.bn ? `币安 ${m.bn.sym}` : `Bybit ${m.by.sym}`;
    panes.price.say('');

    // CVD：合约用币安合约 K 线里的主动买入量；现货用币安现货
    const cvd = ks => { let acc = 0; return ks.filter(k => isFinite(k.tb)).map(k => { acc += (2 * k.tb - k.v) * k.c; return { t: k.t, value: acc }; }); };
    panes.cvd.series.perp.setData(m.bn ? onGrid(cvd(fk)) : []);
    panes.cvd.series.spot.setData(r.sk ? onGrid(cvd(r.sk)) : []);
    panes.cvd.say(m.bn || r.sk ? '' : '这个币没有币安的主动买卖数据');

    // 持仓：以币安的时间点为准，Bybit/OKX 向前填充对齐，堆叠显示
    const priceAt = lookup(fk.map(k => ({ t: k.t, c: k.c })), sec * 2);
    // Bybit 持仓是合约张数（币），乘对应价格换成美元；两边若是 1000PEPE 这类倍数合约要换算
    const unit = m.bn ? (m.by?.mult || 1) / (m.bn.mult || 1) : 1;
    const bnOi = (r.bnOi || []).map(x => ({ t: n(x.timestamp) / 1000, usd: n(x.sumOpenInterestValue) }));
    const byOi = (r.byOi || []).map(x => { const p = priceAt(x.t); return p ? { t: x.t, usd: x.oi * p.c * unit } : null; }).filter(Boolean);
    const okOi = (r.okOi || []).map(x => ({ t: x.t, usd: x.oiUsd, span: x.span }));
    const base = bnOi.length ? bnOi : byOi.length ? byOi : okOi;
    const gap = Math.max(sec * 2, 3 * 3600 * (tf === '4h' ? 1 : 0), 3600);
    const fBy = lookup(byOi, gap), fOk = lookup(okOi, gap);
    const hasBy = byOi.length > 0, hasOk = okOi.length > 0, hasBn = bnOi.length > 0;
    const rows = [];
    for (const p of base) {
      const bn = hasBn ? (bnOi === base ? p.usd : null) : 0;
      const by = hasBy ? (byOi === base ? p.usd : fBy(p.t)?.usd) : 0;
      const ok = hasOk ? (okOi === base ? p.usd : fOk(p.t)?.usd) : 0;
      if (bn == null || by == null || ok == null) continue;
      rows.push({ t: p.t, bn: bn || 0, by: by || 0, ok: ok || 0 });
    }
    const pick3 = k => onGrid(rows.map(x => ({ t: x.t, value: k(x) })));
    panes.oi.series.bn.setData(pick3(x => x.bn));
    panes.oi.series.bnby.setData(pick3(x => x.bn + x.by));
    panes.oi.series.total.setData(pick3(x => x.bn + x.by + x.ok));
    oiRows = (() => {
      const out = [];
      for (const x of rows) {
        if (!(x.t >= t0)) continue;
        const time = LT(Math.floor(x.t / sec) * sec);
        if (out.length && out[out.length - 1].time === time) Object.assign(out[out.length - 1], { bn: x.bn, by: x.by, ok: x.ok });
        else if (!out.length || time > out[out.length - 1].time) out.push({ time, bn: x.bn, by: x.by, ok: x.ok });
      }
      return out;
    })();
    panes.oi.say(rows.length ? '' : '没有持仓历史');

    // 资金费率：每家按自己的结算间隔折算成 8 小时
    const norm = (arr, key) => {
      const h = medianGapH(arr); if (key) fundingHours.set(key, h);
      return onGrid(arr.map(x => ({ t: x.t, value: x.rate * 8 / h })));
    };
    const bnF = (r.bnF || []).map(x => ({ t: Math.round(n(x.fundingTime) / 1000), rate: n(x.fundingRate) }));
    panes.funding.series.binance.setData(norm(bnF, m.bn?.sym));
    panes.funding.series.bybit.setData(r.byF ? norm(r.byF) : []);
    panes.funding.series.okx.setData(r.okF ? norm(r.okF) : []);
    panes.funding.say(bnF.length || r.byF?.length || r.okF?.length ? '' : '没有资金费率历史');

    // 多空比
    const ratio = arr => onGrid((arr || []).map(x => ({ t: n(x.timestamp) / 1000, value: n(x.longShortRatio) })));
    panes.ls.series.bnAcc.setData(ratio(r.bnLs));
    panes.ls.series.bnTop.setData(ratio(r.bnTop));
    panes.ls.series.byAcc.setData(onGrid((r.byLs || []).map(x => ({ t: x.t, value: x.short > 0 ? x.long / x.short : NaN }))));
    panes.ls.series.okAcc.setData(onGrid((r.okLs || []).map(x => ({ t: x.t, value: x.ratio }))));
    panes.ls.say(r.bnLs || r.byLs || r.okLs ? '' : '没有多空比数据');

    const first = !lastData || lastData.key !== want;
    lastData = { key: want, fk, r, m, bars: fk.map(k => ({ time: LT(k.t), ...k })) };
    if (first) {
      const ts = panes.price.chart.timeScale();
      const bars = Math.min(fk.length, tf === '1d' ? 180 : 240);
      ts.setVisibleLogicalRange({ from: fk.length - bars, to: fk.length + 3 });
    }
    legends(null);
    lastOk = Date.now(); showStatus();
  }

  let oiRows = [];

  // 图例：鼠标所在时刻的数值，没有鼠标时显示最新值
  function legends(time) {
    if (!lastData) return;
    const pick = (arr, key = 'value') => {
      if (!arr || !arr.length) return null;
      if (!time) return key ? arr[arr.length - 1][key] : arr[arr.length - 1];
      let lo = 0, hi = arr.length - 1, best = null;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid].time <= time) { best = arr[mid]; lo = mid + 1; } else hi = mid - 1; }
      return best ? (key ? best[key] : best) : null;
    };
    const { bars } = lastData;
    const b = pick(bars, null);
    const c = VP.colors();
    if (b) {
      const ch = b.c / b.o - 1;
      $('#lg-price').innerHTML = `<span>开 <b>${fmt.price(b.o)}</b></span><span>高 <b>${fmt.price(b.h)}</b></span><span>低 <b>${fmt.price(b.l)}</b></span><span>收 <b class="${ch >= 0 ? 'up' : 'down'}">${fmt.price(b.c)}</b></span><span>${fmt.pct(ch)}</span><span>成交额 <b>${fmt.usd(b.qv)}</b></span>`;
    }
    const sp = panes.cvd.series;
    const perp = seriesCache(sp.perp), spot = seriesCache(sp.spot);
    $('#lg-cvd').innerHTML = `<span><i style="background:${c.amber}"></i>合约 <b>${fmt.usd(pick(perp))}</b></span><span><i style="background:${c.cyan}"></i>现货 <b>${fmt.usd(pick(spot))}</b></span>`;
    const R = oiRows;
    const bn = pick(R, 'bn'), by = pick(R, 'by'), ok = pick(R, 'ok');
    $('#lg-oi').innerHTML = `<span>合计 <b>${fmt.usd((bn || 0) + (by || 0) + (ok || 0))}</b></span>`
      + `<span><i style="background:${VP.EX_COLORS.binance}"></i>币安 <b>${fmt.usd(bn)}</b></span>`
      + `<span><i style="background:${VP.EX_COLORS.bybit}"></i>Bybit <b>${fmt.usd(by)}</b></span>`
      + `<span><i style="background:#45d0e6"></i>OKX <b>${fmt.usd(ok)}</b></span>`;
    const fs = panes.funding.series;
    $('#lg-funding').innerHTML = ['binance', 'bybit', 'okx'].map(k => `<span><i style="background:${VP.EX_COLORS[k]}"></i>${VP.EX_NAMES[k]} <b>${fmt.rate(pick(seriesCache(fs[k])))}</b></span>`).join('');
    const ls = panes.ls.series;
    $('#lg-ls').innerHTML = [['bnAcc', '币安人数', VP.EX_COLORS.binance], ['bnTop', '币安大户持仓', '#ffd98a'], ['byAcc', 'Bybit 人数', VP.EX_COLORS.bybit], ['okAcc', 'OKX 人数', VP.EX_COLORS.okx]]
      .map(([k, name, col]) => `<span><i style="background:${col}"></i>${name} <b>${fmt.num(pick(seriesCache(ls[k])), 2)}</b></span>`).join('');
  }
  // 记住每条线最后一次 setData 的数据，图例按时间查值
  const cacheMap = new WeakMap();
  function seriesCache(s) { return cacheMap.get(s) || []; }
  const origSet = new WeakSet();
  function trackSeries() {
    for (const p of Object.values(panes)) for (const s of Object.values(p.series)) {
      if (origSet.has(s)) continue; origSet.add(s);
      const set = s.setData.bind(s);
      s.setData = data => { cacheMap.set(s, data); return set(data); };
    }
  }

  /* ------------------------------------------------------------ 实时爆仓 */
  const LIQ = { items: [], perMin: new Map(), total: new Map(), max: 600 };
  const okCtVal = new Map();
  function addLiq(it) {
    if (!(it.usd > 0)) return;
    LIQ.items.unshift(it);
    if (LIQ.items.length > LIQ.max) LIQ.items.length = LIQ.max;
    const minute = Math.floor(it.ts / 60000);
    const key = minute + '|' + it.coin;
    const cur = LIQ.perMin.get(key) || { minute, coin: it.coin, long: 0, short: 0 };
    cur[it.side] += it.usd;
    LIQ.perMin.set(key, cur);
    for (const k of [it.coin, '*']) {
      const tot = LIQ.total.get(k) || { long: 0, short: 0 };
      tot[it.side] += it.usd; LIQ.total.set(k, tot);
    }
    scheduleRender();
  }
  let renderPending = false;
  function scheduleRender() { if (!renderPending && VP.isVisible()) { renderPending = true; requestAnimationFrame(() => { renderPending = false; renderLiqs(); }); } }

  function liqFilter() {
    const s = st.get();
    return it => (s.liqScope === 'all' || it.coin === coin) && it.usd >= s.liqMin;
  }
  function renderLiqs() {
    const s = st.get();
    document.querySelectorAll('#liqScope button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === s.liqScope)));
    $('#liqMin').value = String(s.liqMin);
    const f = liqFilter();
    const shown = LIQ.items.filter(f).slice(0, 150);
    $('#liqList').innerHTML = shown.length ? shown.map(it => `<li class="${it.side}${it.usd >= 1e6 ? ' huge' : ''}" title="${VP.EX_NAMES[it.ex]} ${it.sym} 爆仓价 ${fmt.price(it.price)}">`
      + `<span class="t">${fmt.time(it.ts)}</span><span class="ex">${VP.EX_NAMES[it.ex]}</span>`
      + `<span class="what"><b>${it.coin}</b> ${it.side === 'long' ? '多单' : '空单'} @${fmt.price(it.price)}</span><span class="usd">${fmt.usd(it.usd, 1)}</span></li>`).join('')
      : `<li class="liq-empty">${LIQ.items.length ? '没有符合条件的爆仓，调低金额或切到“全部”' : '等待爆仓数据…（币安只推送每个币每秒最大的一笔）'}</li>`;
    // 汇总：本次打开以来 & 最近 60 分钟
    const now = Date.now(), from = Math.floor(now / 60000) - 59;
    let L1 = 0, S1 = 0;
    const bars = new Array(60).fill(0).map(() => ({ long: 0, short: 0 }));
    for (const [k, v] of LIQ.perMin) {
      if (v.minute < from - 60) { LIQ.perMin.delete(k); continue; }
      if (s.liqScope !== 'all' && v.coin !== coin) continue;
      if (v.minute >= from) { L1 += v.long; S1 += v.short; const b = bars[v.minute - from]; if (b) { b.long += v.long; b.short += v.short; } }
    }
    const tot = LIQ.total.get(s.liqScope === 'all' ? '*' : coin) || { long: 0, short: 0 };
    const L = tot.long, S = tot.short;
    const since = LIQ.started ? fmt.time(LIQ.started, false) : '';
    $('#liqSum').innerHTML = `<div><div class="k">多单爆仓（60 分钟）</div><div class="v down">${fmt.usd(L1, 1)}</div><div class="k">${since} 以来 ${fmt.usd(L, 1)}</div></div>`
      + `<div><div class="k">空单爆仓（60 分钟）</div><div class="v up">${fmt.usd(S1, 1)}</div><div class="k">${since} 以来 ${fmt.usd(S, 1)}</div></div>`;
    drawBars(bars);
  }
  function drawBars(bars) {
    const cv = $('#liqBars');
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w) return;
    cv.width = w * dpr; cv.height = h * dpr;
    const g = cv.getContext('2d');
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    const c = VP.colors();
    const max = Math.max(1, ...bars.map(b => Math.max(b.long, b.short)));
    const mid = h / 2, bw = w / bars.length;
    g.fillStyle = c.line; g.fillRect(0, mid, w, 1);
    bars.forEach((b, i) => {
      const x = i * bw + 1, ww = Math.max(1, bw - 2);
      const hs = (b.short / max) * (mid - 2), hl = (b.long / max) * (mid - 2);
      g.fillStyle = c.up; g.fillRect(x, mid - hs, ww, hs);
      g.fillStyle = c.down; g.fillRect(x, mid + 1, ww, hl);
    });
    g.fillStyle = c.faint; g.font = '10px ' + getComputedStyle(document.body).fontFamily;
    g.fillText('空单', 2, 10); g.fillText('多单', 2, h - 3);
  }

  const feeds = {};
  function feedBadge() {
    $('#liqFeeds').innerHTML = Object.entries(feeds).map(([k, f]) => `<span class="${f.status}" title="${f.status === 'open' ? '已连接' : '连接中'}">${VP.EX_NAMES[k]}</span>`).join('');
  }
  function startLiqFeeds() {
    LIQ.started = Date.now();
    // 币安：全部合约的强平推送
    feeds.binance = VP.socket('wss://fstream.binance.com/ws/!forceOrder@arr', {
      name: 'binance-liq',
      onMessage(raw) {
        const j = JSON.parse(raw);
        const list = Array.isArray(j) ? j : [j];
        for (const e of list) {
          const o = e.o || e.data?.o; if (!o) continue;
          const sym = o.s; if (!/USDT$|USDC$/.test(sym)) continue;
          const [c0] = VP.baseOf(sym.replace(/USDT$|USDC$/, ''));
          const qty = n(o.z) || n(o.q), price = n(o.ap) || n(o.p);
          addLiq({ ex: 'binance', coin: c0, sym, side: o.S === 'SELL' ? 'long' : 'short', price, usd: qty * price, ts: n(o.T) || Date.now() });
        }
      },
    });
    // Bybit：按交易对订阅（订阅成交额最大的 60 个）
    feeds.bybit = VP.socket('wss://stream.bybit.com/v5/public/linear', {
      name: 'bybit-liq', ping: '{"op":"ping"}',
      async onOpen(ws) {
        let syms = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
        try {
          const t = await ex.bybit.tickers();
          syms = t.filter(x => /USDT$/.test(x.symbol)).sort((a, b) => n(b.turnover24h) - n(a.turnover24h)).slice(0, 60).map(x => x.symbol);
        } catch { /* 用默认几个 */ }
        const cur = markets.by.get(coin); if (cur && !syms.includes(cur.sym)) syms.push(cur.sym);
        for (let i = 0; i < syms.length; i += 10) ws.send(JSON.stringify({ op: 'subscribe', args: syms.slice(i, i + 10).map(s => 'allLiquidation.' + s) }));
      },
      onMessage(raw) {
        const j = JSON.parse(raw);
        if (!j.topic || !j.topic.startsWith('allLiquidation')) return;
        for (const d of j.data || []) {
          const [c0, mult] = VP.baseOf(d.s.replace(/USDT$/, ''));
          void mult;
          const price = n(d.p), qty = n(d.v);
          addLiq({ ex: 'bybit', coin: c0, sym: d.s, side: d.S === 'Buy' ? 'long' : 'short', price, usd: qty * price, ts: n(d.T) || Date.now() });
        }
      },
    });
    // OKX：全部永续的强平推送（张数 × 面值）
    feeds.okx = VP.socket('wss://ws.okx.com:8443/ws/v5/public', {
      name: 'okx-liq', ping: 'ping',
      async onOpen(ws) {
        if (!okCtVal.size) {
          try { for (const x of await ex.okx.instruments()) okCtVal.set(x.instId, { ctVal: n(x.ctVal), ctType: x.ctType, ccy: x.ctValCcy }); } catch { /* 拿不到面值时按 USDT 合约估算 */ }
        }
        ws.send(JSON.stringify({ op: 'subscribe', args: [{ channel: 'liquidation-orders', instType: 'SWAP' }] }));
      },
      onMessage(raw) {
        if (raw === 'pong') return;
        const j = JSON.parse(raw);
        if (!j.data || j.arg?.channel !== 'liquidation-orders') return;
        for (const d of j.data) {
          const inst = d.instId || ''; const coinName = inst.split('-')[0];
          const meta = okCtVal.get(inst);
          for (const x of d.details || []) {
            const px = n(x.bkPx), sz = n(x.sz);
            let usd;
            if (meta && meta.ctType === 'inverse') usd = sz * meta.ctVal;
            else usd = sz * (meta ? meta.ctVal : 1) * px;
            const longLiq = x.posSide ? x.posSide === 'long' : x.side === 'sell';
            addLiq({ ex: 'okx', coin: coinName, sym: inst, side: longLiq ? 'long' : 'short', price: px, usd, ts: n(x.ts) || Date.now() });
          }
        }
      },
    });
    Object.values(feeds).forEach(f => f.onStatus(feedBadge));
    setInterval(() => { if (VP.isVisible()) renderLiqs(); }, 15000);
    VP.onVisible(v => { if (v) renderLiqs(); });

    $('#liqScope').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { st.set({ liqScope: b.dataset.v }); renderLiqs(); } });
    $('#liqMin').addEventListener('change', e => { st.set({ liqMin: Number(e.target.value) }); renderLiqs(); });
    window.addEventListener('resize', () => renderLiqs());
  }

  /* ------------------------------------------------------------ 跨所资金费率表 */
  let boardRows = [];
  async function loadBoard() {
    const [r, errs] = await settle({
      bnP: ex.binance.premiumAll(), bnT: ex.binance.ticker24(), bnI: ex.binance.fundingInfo(),
      byT: ex.bybit.tickers(), okT: ex.okx.tickers(), okO: ex.okx.oiAll(),
      bgT: ex.bitget.tickers(), bgF: ex.bitget.fundingAll(), hl: ex.hyperliquid.ctxs(),
    });
    const rows = new Map();
    const row = b => { if (!rows.has(b)) rows.set(b, { base: b, price: NaN, chg: NaN, vol: 0, oi: 0, f: {}, raw: {} }); return rows.get(b); };
    const setF = (rw, k, raw, hours) => { rw.f[k] = raw * 8 / hours; rw.raw[k] = { raw, hours }; };
    if (r.bnI) for (const x of r.bnI) fundingHours.set(x.symbol, n(x.fundingIntervalHours) || 8);
    const bnTicker = new Map((r.bnT || []).map(x => [x.symbol, x]));
    for (const x of r.bnP || []) {
      if (!/USDT$/.test(x.symbol)) continue;
      const [b, mult] = VP.baseOf(x.symbol.slice(0, -4)); const rw = row(b);
      setF(rw, 'binance', n(x.lastFundingRate), fundingHours.get(x.symbol) || 8);
      const t = bnTicker.get(x.symbol);
      rw.price = n(x.markPrice) / mult;
      if (t) { rw.chg = n(t.priceChangePercent) / 100; rw.vol += n(t.quoteVolume); }
      rw.bnSym = x.symbol;
    }
    for (const x of r.byT || []) {
      if (!/USDT$/.test(x.symbol) || !x.fundingRate) continue;
      const [b, mult] = VP.baseOf(x.symbol.slice(0, -4)); const rw = row(b);
      setF(rw, 'bybit', n(x.fundingRate), n(x.fundingIntervalHour) || 8);
      rw.vol += n(x.turnover24h); rw.oi += n(x.singleOpenInterestValue ?? x.openInterestValue) || 0;
      if (!isFinite(rw.price)) { rw.price = n(x.lastPrice) / mult; rw.chg = n(x.price24hPcnt); }
    }
    const okOi = new Map((r.okO || []).map(x => [x.instId, n(x.oiUsd)]));
    for (const x of r.okT || []) {
      if (!/-USDT-SWAP$/.test(x.instId)) continue;
      const b = x.instId.split('-')[0]; const rw = row(b);
      rw.vol += n(x.volCcy24h) * n(x.last); rw.oi += okOi.get(x.instId) || 0; rw.okInst = x.instId;
      if (!isFinite(rw.price)) { rw.price = n(x.last); rw.chg = n(x.last) / n(x.open24h) - 1; }
    }
    if (r.bgF) for (const x of r.bgF) if (x.symbol && x.fundingRateInterval) bitgetHours.set(x.symbol, n(x.fundingRateInterval));
    for (const x of r.bgT || []) {
      if (!/USDT$/.test(x.symbol)) continue;
      const [b] = VP.baseOf(x.symbol.slice(0, -4)); const rw = row(b);
      setF(rw, 'bitget', n(x.fundingRate), bitgetHours.get(x.symbol) || 8);
      rw.vol += n(x.usdtVolume); rw.oi += n(x.holdingAmount) * n(x.markPrice) || 0;
    }
    for (const x of r.hl || []) {
      if (x.delisted) continue;
      const k = /^k[A-Z]/.test(x.name); const b = k ? x.name.slice(1) : x.name; const rw = row(b);
      setF(rw, 'hyperliquid', n(x.funding), 1);
      rw.vol += n(x.dayNtlVlm); rw.oi += n(x.openInterest) * n(x.markPx) || 0;
      if (!isFinite(rw.price)) rw.price = n(x.markPx) / (k ? 1000 : 1);
    }
    let list = [...rows.values()].filter(x => Object.keys(x.f).length >= 2 && x.vol > 0);
    list.sort((a, b) => b.vol - a.vol);
    list = list.slice(0, 80);
    // OKX 没有批量资金费率接口：只补成交额前 40 的
    const okList = list.filter(x => x.okInst).slice(0, 30);
    await VP.pool(okList, 3, async x => {
      const d = await ex.okx.funding(x.okInst);
      const h = (n(d.nextFundingTime) - n(d.fundingTime)) / 3.6e6;
      setF(x, 'okx', n(d.fundingRate), h > 0 ? h : 8);
    });
    // 币安持仓也没有批量接口：补前 30 的
    const bnList = list.filter(x => x.bnSym).slice(0, 30);
    await VP.pool(bnList, 4, async x => {
      const d = await ex.binance.openInterest(x.bnSym);
      const mark = n((r.bnP || []).find(p => p.symbol === x.bnSym)?.markPrice);
      x.oi += n(d.openInterest) * mark || 0; x.bnOi = true;
    });
    for (const x of list) {
      const v = Object.values(x.f).filter(isFinite);
      x.spread = v.length >= 2 ? (Math.max(...v) - Math.min(...v)) * 3 * 365 : NaN;
      for (const k of ['binance', 'bybit', 'okx', 'bitget', 'hyperliquid']) x['f_' + k] = x.f[k];
    }
    boardRows = list;
    const bad = Object.entries(errs).map(([k, e]) => `${k}: ${e.message}`);
    $('#boardStatus').textContent = `更新于 ${fmt.time(Date.now())}` + (bad.length ? `，${bad.length} 个接口失败` : '');
    $('#boardStatus').title = bad.join('\n');
    $('#boardStatus').classList.toggle('bad', bad.length > 0);
    renderBoard();
  }

  function heat(v) {
    if (!isFinite(v)) return '';
    if (v === 0) return 'color:var(--text-faint)';
    // 0.01%/8h 是常见的基准费率：以它为参照着色，正值琥珀、负值青色
    const a = Math.min(1, Math.abs(v) / 0.0008);
    const alpha = (0.12 + a * 0.6).toFixed(2);
    if (Math.abs(v - 0.0001) < 0.00002) return 'color:var(--text-dim)';
    return v > 0 ? `background:rgba(242,179,61,${alpha});color:${a > 0.5 ? '#1a1205' : 'var(--text)'}` : `background:rgba(69,183,255,${alpha});color:${a > 0.5 ? '#04121e' : 'var(--text)'}`;
  }
  function renderBoard() {
    const s = st.get();
    const q = $('#boardFilter').value.trim().toUpperCase();
    const key = s.sort, dir = s.dir;
    const rows = boardRows.filter(x => !q || x.base.includes(q)).slice();
    rows.sort((a, b) => {
      const va = a[key], vb = b[key];
      if (key === 'base') return dir * String(va).localeCompare(String(vb));
      const fa = isFinite(va) ? va : -Infinity * dir, fb = isFinite(vb) ? vb : -Infinity * dir;
      return dir * (fa - fb);
    });
    document.querySelectorAll('#board th').forEach(th => { if (th.dataset.sort === key) th.setAttribute('aria-sort', dir > 0 ? 'ascending' : 'descending'); else th.removeAttribute('aria-sort'); });
    const cell = (x, k) => {
      const v = x.f[k];
      if (!isFinite(v)) return '<td class="miss">—</td>';
      const raw = x.raw[k];
      const tip = raw.hours !== 8 ? `每 ${raw.hours} 小时结算，原始费率 ${fmt.rate(raw.raw)}` : `每 8 小时结算`;
      return `<td class="f" title="${tip}"><span style="${heat(v)}">${fmt.rate(v)}</span></td>`;
    };
    $('#board tbody').innerHTML = rows.length ? rows.map(x => `<tr>`
      + `<td class="sym" data-coin="${x.base}">${x.base}</td><td>${fmt.price(x.price)}</td>`
      + `<td class="${x.chg >= 0 ? 'up' : 'down'}">${fmt.pct(x.chg)}</td><td>${fmt.usd(x.vol, 1)}</td>`
      + `<td title="${x.bnOi ? '含币安' : '不含币安'}">${x.oi > 0 ? fmt.usd(x.oi, 1) : '—'}</td>`
      + ['binance', 'bybit', 'okx', 'bitget', 'hyperliquid'].map(k => cell(x, k)).join('')
      + `<td>${isFinite(x.spread) ? fmt.pct(x.spread, 1, false) : '—'}</td></tr>`).join('')
      : `<tr><td colspan="11" class="empty">${boardRows.length ? '没有匹配的币种' : '加载中…'}</td></tr>`;
  }
  function wireBoard() {
    $('#board thead').addEventListener('click', e => {
      const th = e.target.closest('th[data-sort]'); if (!th) return;
      const s = st.get();
      st.set(s.sort === th.dataset.sort ? { dir: -s.dir } : { sort: th.dataset.sort, dir: th.dataset.sort === 'base' ? 1 : -1 });
      renderBoard();
    });
    $('#board tbody').addEventListener('click', e => {
      const td = e.target.closest('td[data-coin]'); if (!td) return;
      setCoin(td.dataset.coin); $('#scroll').scrollTo({ top: 0, behavior: 'smooth' });
    });
    $('#boardFilter').addEventListener('input', renderBoard);
  }

  // 外壳的币种联动（在聚合成交里点了交易对）
  window.addEventListener('vpfm-coin', e => { if (e.detail) setCoin(e.detail); });
  /* ------------------------------------------------------------ 启动 */
  buildTop();
  buildCharts();
  trackSeries();
  wireBoard();
  renderBoard();
  startLiqFeeds();
  renderLiqs();
  let kpiTimer = { now() {} }, chartTimer = { now() {} };
  markets.ready = loadMarkets().catch(e => noteErr('markets', e)).then(() => {
    markets.ready = true;
    kpiTimer = VP.every(15000, loadKpis);
    chartTimer = VP.every(60000, loadCharts);
    VP.every(180000, loadBoard);
  });
})();
