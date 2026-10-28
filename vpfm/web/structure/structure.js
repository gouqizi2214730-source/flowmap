'use strict';
/* 结构分析：在 K 线上叠加 SMC 结构（摆动点、BOS/CHoCH、订单块、FVG、等高等低）、
   ICT/PO3（高周期 K 线、C1–C4 序列、T-Spot、CISD、STDV 投射、SMT 背离）、
   关键价位（前日/前周高低、日/周开盘、交易时段）和指标（三周期布林带、锚定/滚动 VWAP、EMA、成交量分布）。
   K 线来自币安合约或现货公开接口，全部在本机计算。 */
(function () {
  const { fmt, ex, n } = VP;
  const LW = window.LightweightCharts;
  const $ = s => document.querySelector(s);
  const TFS = ['1m', '5m', '15m', '1h', '4h', '1d'];
  const QUICK = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB'];
  const HTF = { '1m': ['15m', '1h'], '5m': ['1h', '4h'], '15m': ['4h', '1d'], '1h': ['1d', '1w'], '4h': ['1w', '1M'], '1d': ['1w', '1M'] };
  const BBTF = { '1m': ['5m', '15m', '1h'], '5m': ['5m', '15m', '1h'], '15m': ['15m', '1h', '4h'], '1h': ['1h', '4h', '1d'], '4h': ['4h', '1d', '1w'], '1d': ['1d', '1w', '1M'] };
  const BB_COLORS = ['#2962ff', '#ff9800', '#9c27b0']; // 与三周期布林带指标的默认配色一致
  const RV_COLORS = { 30: '#eedf7b', 90: '#bbd4bc', 365: '#add556' }; // 与 VWAP Claire 的默认配色一致
  const VWAP_COLORS = { D: '#53a7b0', W: '#8fa7ff', M: '#d38cff' };
  const EMA_COLORS = { 20: '#e6c86e', 50: '#5fb3a1', 200: '#c46a8a' };
  const SESSION_COLORS = { asia: '#7b6cf6', london: '#45b7ff', nyam: '#f2b33d', nypm: '#ff8a3d' };

  const LAYERS = [
    ['结构', [['swings', '摆动点（HH/HL/LH/LL）'], ['bos', 'BOS / CHoCH'], ['ob', '订单块'], ['fvg', 'FVG 缺口'], ['liq', '等高 / 等低流动性']]],
    ['ICT / PO3', [['htf', '高周期 K 线（右侧）'], ['po3', 'PO3 序列与 T-Spot'], ['cisd', 'CISD'], ['stdv', 'STDV 投射'], ['smt', 'SMT 背离']]],
    ['价位', [['pdl', '前日高低'], ['pwl', '前周高低'], ['opens', '日开 / 周开'], ['sessions', '交易时段（纽约时间）']]],
    ['指标', [['bb', '三周期布林带'], ['vwapD', '日 VWAP ±1/2σ'], ['vwapW', '周 VWAP'], ['vwapM', '月 VWAP'], ['rvwap', '滚动 VWAP 30/90/365 天'], ['ema', 'EMA 20/50/200'], ['vp', '成交量分布（可见区间）']]],
  ];
  const DEF = { swings: true, bos: true, ob: true, fvg: true, liq: true, htf: true, po3: true, cisd: true, stdv: true, smt: false, pdl: true, pwl: false, opens: true, sessions: false, bb: false, vwapD: true, vwapW: false, vwapM: false, rvwap: false, ema: false, vp: true };
  const st = VP.store('structure', { coin: 'BTC', tf: '15m', mkt: 'futures', swing: 10, fvgMin: 0.15, layers: {}, tab: 'layers' });
  const S = st.get();
  S.layers = Object.assign({}, DEF, S.layers);
  let coin = S.coin, tf = TFS.includes(S.tf) ? S.tf : '15m', mkt = S.mkt;
  const on = k => !!st.get().layers[k];

  /* ------------------------------------------------------------ 图表 */
  const chart = LW.createChart($('#chart'), VP.chartOptions({ autoSize: true, timeScale: { rightOffset: 44, barSpacing: 7, borderColor: '#1b2636', timeVisible: true, secondsVisible: false } }));
  const colors = () => VP.colors();
  let c0 = colors();
  const candles = chart.addCandlestickSeries({ upColor: c0.up, downColor: c0.down, borderVisible: false, wickUpColor: c0.up, wickDownColor: c0.down });
  const volume = chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.86, bottom: 0 } });
  const line = (color, w = 1, style = 0) => chart.addLineSeries({ color, lineWidth: w, lineStyle: style, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  const SER = {
    bb: [0, 1, 2].map(k => ({ up: line(BB_COLORS[k]), mid: line(BB_COLORS[k], 2), dn: line(BB_COLORS[k]) })),
    vwapD: { v: line(VWAP_COLORS.D, 2), u1: line(VWAP_COLORS.D + '99', 1, 2), d1: line(VWAP_COLORS.D + '99', 1, 2), u2: line(VWAP_COLORS.D + '66', 1, 1), d2: line(VWAP_COLORS.D + '66', 1, 1) },
    vwapW: { v: line(VWAP_COLORS.W, 2) },
    vwapM: { v: line(VWAP_COLORS.M, 2) },
    rvwap: { 30: line(RV_COLORS[30], 1), 90: line(RV_COLORS[90], 1), 365: line(RV_COLORS[365], 2) },
    ema: { 20: line(EMA_COLORS[20]), 50: line(EMA_COLORS[50]), 200: line(EMA_COLORS[200], 2) },
  };
  const LT = VP.localTime;

  /* ------------------------------------------------------------ 数据 */
  let B = [];            // 图表周期 K 线
  let H = {};            // 其他周期 K 线
  let daily = [];        // 日线（滚动 VWAP、统计）
  let cmpBars = null;    // SMT 对比币
  let R = null;          // 计算结果
  const bnSyms = new Map();

  async function resolveSymbol() {
    if (mkt === 'spot') return coin + 'USDT';
    if (!bnSyms.size) {
      try { for (const x of await ex.binance.premiumAll()) if (/USDT$/.test(x.symbol)) { const [b, m] = VP.baseOf(x.symbol.slice(0, -4)); if (!bnSyms.has(b) || m === 1) bnSyms.set(b, x.symbol); } } catch { /* 用默认写法 */ }
    }
    return bnSyms.get(coin) || coin + 'USDT';
  }
  const kl = (sym, t, limit, deep) => (deep ? ex.binance.klinesDeep(sym, t, limit, { spot: mkt === 'spot' }) : ex.binance.klines(sym, t, limit, { spot: mkt === 'spot' }));

  let loadSeq = 0;
  async function load(first) {
    const seq = ++loadSeq;
    const want = `${coin}|${tf}|${mkt}`;
    try {
      const sym = await resolveSymbol();
      const others = [...new Set([...HTF[tf], ...BBTF[tf]])].filter(t => t !== tf);
      const tasks = [kl(sym, tf, 1500, true), ...others.map(t => kl(sym, t, 300, false)), kl(sym, '1d', 1000, false)];
      if (on('smt')) tasks.push(kl(coin === 'BTC' ? 'ETHUSDT' : 'BTCUSDT', tf, 1500, true));
      const res = await Promise.allSettled(tasks);
      if (seq !== loadSeq || want !== `${coin}|${tf}|${mkt}`) return;
      if (res[0].status !== 'fulfilled') throw res[0].reason;
      B = res[0].value.filter(b => isFinite(b.c));
      H = { [tf]: B };
      others.forEach((t, k) => { if (res[k + 1].status === 'fulfilled') H[t] = res[k + 1].value; });
      const dIdx = others.length + 1;
      daily = res[dIdx].status === 'fulfilled' ? res[dIdx].value : [];
      cmpBars = on('smt') && res[dIdx + 1]?.status === 'fulfilled' ? res[dIdx + 1].value : null;
      const failed = res.filter(r => r.status === 'rejected').length;
      setStatus(`${sym}${mkt === 'spot' ? ' 现货' : ' 永续'}，更新于 ${fmt.time(Date.now())}` + (failed ? `，${failed} 项失败` : ''), failed > 0);
      $('#chartMsg').hidden = true;
      compute();
      draw(first);
    } catch (e) {
      if (seq !== loadSeq) return;
      setStatus('获取 K 线失败：' + e.message, true);
      if (!B.length) { $('#chartMsg').hidden = false; $('#chartMsg').textContent = `获取 ${coin} 的 K 线失败：${e.message}`; }
    }
  }
  function setStatus(t, bad) { const s = $('#status'); s.textContent = t; s.classList.toggle('bad', !!bad); }

  /* ------------------------------------------------------------ 计算 */
  const weekKey = t => Math.floor((t / 86400 + 3) / 7);
  const monthKey = t => { const d = new Date(t * 1000); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
  const dayKey = t => Math.floor(t / 86400);
  const secOf = t => VP.TF[t].sec;
  function idxAtOrAfter(t) { let lo = 0, hi = B.length - 1, r = B.length; while (lo <= hi) { const m = (lo + hi) >> 1; if (B[m].t >= t) { r = m; hi = m - 1; } else lo = m + 1; } return r; }

  /** 高周期的值按"已收完"的高周期 K 线对到图表 K 线上（不重绘） */
  function mapConfirmed(htf, vals, htfTf) {
    const out = new Array(B.length).fill(NaN);
    const cs = secOf(tf);
    let j = -1;
    for (let i = 0; i < B.length; i++) {
      const barEnd = B[i].t + cs;
      while (j + 1 < htf.length) {
        const end = htf[j + 2] ? htf[j + 2].t : htf[j + 1].t + secOf(htfTf);
        if (end <= barEnd) j++; else break;
      }
      if (j >= 0) out[i] = vals[j];
    }
    return out;
  }

  function compute() {
    const s = st.get();
    const sw = SMC.swings(B, s.swing);
    const atr = SMC.atr(B);
    const r = { sw, atr };
    r.bos = SMC.bosChoch(B, sw);
    r.fvg = SMC.fvg(B, { minSize: atr * s.fvgMin });
    r.ob = SMC.orderBlocks(B, sw);
    r.liq = SMC.liquidity(B, sw, 0.01);
    r.cisd = SMC.cisd(B);
    // 摆动点标签：和上一个同类摆动点比
    let lastH = null, lastL = null;
    r.swLabels = sw.map(p => {
      let lab;
      if (p.type === 1) { lab = lastH == null ? 'H' : p.level > lastH ? 'HH' : 'LH'; lastH = p.level; }
      else { lab = lastL == null ? 'L' : p.level < lastL ? 'LL' : 'HL'; lastL = p.level; }
      return { ...p, lab };
    });
    // 高周期 K 线与 PO3（用第一个高周期）
    const [h1, h2] = HTF[tf];
    r.h1 = H[h1] || []; r.h2 = H[h2] || []; r.h1tf = h1; r.h2tf = h2;
    r.po3 = SMC.po3(r.h1);
    const seq = r.po3[0];
    if (seq) {
      const c2Start = idxAtOrAfter(seq.c2.t);
      // 序列方向上、C2 开始之后的第一个 CISD
      seq.cisd = r.cisd.find(c => c.bull === (seq.side === 1) && c.i >= c2Start) || null;
      seq.c1Idx = idxAtOrAfter(seq.c1.t);
      seq.c2Idx = c2Start;
      const c3 = r.h1[seq.i2 + 1];
      seq.c3Idx = c3 ? idxAtOrAfter(c3.t) : B.length;
      if (seq.cisd) seq.stdv = SMC.stdv(seq.cisd.level, seq.extreme);
    }
    // 价位
    if (daily.length >= 2) {
      const d0 = daily[daily.length - 1], d1 = daily[daily.length - 2];
      r.day = { open: d0.o, start: d0.t, ph: d1.h, pl: d1.l };
      const weeks = groupWeeks(daily);
      if (weeks.length >= 2) { const w0 = weeks[weeks.length - 1], w1 = weeks[weeks.length - 2]; r.week = { open: w0.o, start: w0.t, ph: w1.h, pl: w1.l }; }
    }
    r.sessions = ['1m', '5m', '15m', '1h'].includes(tf) ? SMC.sessions(B) : [];
    // 指标
    const closes = B.map(b => b.c);
    r.ema = { 20: SMC.ema(closes, 20), 50: SMC.ema(closes, 50), 200: SMC.ema(closes, 200) };
    r.vwap = { D: SMC.vwap(B, dayKey), W: SMC.vwap(B, weekKey), M: SMC.vwap(B, monthKey) };
    r.bb = BBTF[tf].map(t => {
      const hb = H[t]; if (!hb || hb.length < 21) return null;
      const bb = SMC.bb(hb.map(x => x.c), 20, 2);
      if (t === tf) return { tf: t, up: bb.up, mid: bb.mid, dn: bb.dn };
      return { tf: t, up: mapConfirmed(hb, bb.up, t), mid: mapConfirmed(hb, bb.mid, t), dn: mapConfirmed(hb, bb.dn, t) };
    });
    r.rv = {};
    for (const N of [30, 90, 365]) {
      const rv = SMC.rvwap(daily, N);
      const byDay = new Map(rv.map(x => [dayKey(x.t), x.value]));
      // 当天的滚动 VWAP 用"截至昨天"的值，避免盘中重算
      r.rv[N] = B.map(b => byDay.get(dayKey(b.t) - 1) ?? NaN);
    }
    if (cmpBars && cmpBars.length > 50) r.smt = SMC.smt(B, cmpBars, Math.max(3, Math.round(s.swing / 2)));
    r.events = buildEvents(r);
    R = r;
  }
  function groupWeeks(days) {
    const out = [];
    for (const d of days) {
      const k = weekKey(d.t), last = out[out.length - 1];
      if (last && last.k === k) { last.h = Math.max(last.h, d.h); last.l = Math.min(last.l, d.l); last.c = d.c; }
      else out.push({ k, t: d.t, o: d.o, h: d.h, l: d.l, c: d.c });
    }
    return out;
  }

  function buildEvents(r) {
    const ev = [];
    for (const e of r.bos) ev.push({ i: e.broken, bull: e.dir > 0, text: `${e.kind} ${e.dir > 0 ? '向上' : '向下'}突破 ${fmt.price(e.level)}` });
    for (const c of r.cisd.slice(-12)) ev.push({ i: c.i, bull: c.bull, text: `${c.bull ? '看涨' : '看跌'} CISD ${fmt.price(c.level)}${c.invalid >= 0 ? '（已失效）' : ''}` });
    for (const l of r.liq) if (l.swept >= 0) ev.push({ i: l.swept, bull: l.type < 0, text: `扫${l.type > 0 ? '等高' : '等低'} ${fmt.price(l.level)}` });
    for (const f of r.fvg.slice(-30)) if (f.filled < 0 && f.mitigated < 0) ev.push({ i: f.i + 1, bull: f.dir > 0, text: `${f.dir > 0 ? '看涨' : '看跌'} FVG ${fmt.price(f.bottom)}–${fmt.price(f.top)}` });
    if (r.smt) for (const s of r.smt) ev.push({ i: s.i2, bull: s.type > 0, text: `${s.type > 0 ? '看涨' : '看跌'} SMT（对比 ${coin === 'BTC' ? 'ETH' : 'BTC'}）` });
    const seq = r.po3[0];
    if (seq) ev.push({ i: seq.c2Idx ?? B.length - 1, bull: seq.side > 0, text: `${VP.TF_NAME[r.h1tf]} C2 ${seq.side > 0 ? '扫低' : '扫高'}${seq.closedIn ? '后收回' : '（进行中）'}` });
    return ev.filter(e => e.i >= 0 && e.i < B.length).sort((a, b) => b.i - a.i).slice(0, 40);
  }

  /* ------------------------------------------------------------ 画到图上 */
  function seriesData(vals, filter) {
    const out = [];
    for (let i = 0; i < B.length; i++) {
      const v = vals[i];
      if (filter && !filter(i)) continue;
      out.push(isFinite(v) ? { time: LT(B[i].t), value: v } : { time: LT(B[i].t) });
    }
    return out;
  }
  function setLine(s, vals, visible) { s.applyOptions({ visible }); s.setData(visible ? seriesData(vals) : []); }

  function draw(first) {
    if (!R) return;
    const c = colors();
    const keepRange = !first ? chart.timeScale().getVisibleLogicalRange() : null;
    const atRight = keepRange && keepRange.to >= B.length - 2;
    const last = B[B.length - 1]?.c || 1;
    const prec = last >= 1000 ? 1 : last >= 10 ? 2 : last >= 1 ? 4 : last >= 0.01 ? 5 : 7;
    candles.applyOptions({ upColor: c.up, downColor: c.down, wickUpColor: c.up, wickDownColor: c.down, priceFormat: { type: 'price', precision: prec, minMove: 10 ** -prec } });
    candles.setData(B.map(b => ({ time: LT(b.t), open: b.o, high: b.h, low: b.l, close: b.c })));
    volume.setData(B.map(b => ({ time: LT(b.t), value: b.v, color: (b.c >= b.o ? c.up : c.down) + '40' })));
    const L = st.get().layers;
    R.bb.forEach((bb, k) => {
      const vis = L.bb && !!bb;
      setLine(SER.bb[k].up, bb?.up || [], vis); setLine(SER.bb[k].mid, bb?.mid || [], vis); setLine(SER.bb[k].dn, bb?.dn || [], vis);
    });
    const vd = R.vwap.D;
    setLine(SER.vwapD.v, vd.vw, L.vwapD);
    setLine(SER.vwapD.u1, vd.vw.map((v, i) => v + vd.sd[i]), L.vwapD); setLine(SER.vwapD.d1, vd.vw.map((v, i) => v - vd.sd[i]), L.vwapD);
    setLine(SER.vwapD.u2, vd.vw.map((v, i) => v + 2 * vd.sd[i]), L.vwapD); setLine(SER.vwapD.d2, vd.vw.map((v, i) => v - 2 * vd.sd[i]), L.vwapD);
    setLine(SER.vwapW.v, R.vwap.W.vw, L.vwapW && tf !== '1d');
    setLine(SER.vwapM.v, R.vwap.M.vw, L.vwapM);
    for (const N of [30, 90, 365]) setLine(SER.rvwap[N], R.rv[N], L.rvwap);
    for (const N of [20, 50, 200]) setLine(SER.ema[N], R.ema[N], L.ema);
    const margin = L.htf ? 44 : 18;
    chart.timeScale().applyOptions({ rightOffset: margin });
    if (first) chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, B.length - 200), to: B.length + margin });
    else if (keepRange && !atRight) chart.timeScale().setVisibleLogicalRange(keepRange);
    overlay.update();
    renderSide();
    legend(null);
  }

  /* ---------- 覆盖层：方框、价位线、标签、右侧高周期 K 线、成交量分布 ---------- */
  class Overlay {
    constructor() {
      const self = this;
      this.views = [
        { zOrder: () => 'bottom', renderer: () => ({ draw: t => self.paint(t, 'bg') }) },
        { zOrder: () => 'top', renderer: () => ({ draw: t => self.paint(t, 'fg') }) },
      ];
    }
    attached(p) { this.req = p.requestUpdate; }
    detached() {}
    paneViews() { return this.views; }
    updateAllViews() {}
    update() { if (this.req) this.req(); }
    paint(target, layer) {
      if (!R || !B.length) return;
      target.useMediaCoordinateSpace(({ context: g, mediaSize }) => {
        try { paint(g, mediaSize.width, mediaSize.height, layer); } catch (e) { console.error(e); }
      });
    }
  }
  const overlay = new Overlay();
  candles.attachPrimitive(overlay);

  const LABEL_W = 96; // 最后一根 K 线右边：先留一列放价位标签，再画高周期 K 线
  const font = (px, w = 500) => `${w} ${px}px ` + getComputedStyle(document.body).fontFamily;
  function tag(g, text, x, y, color, { bg = null, align = 'left', base = 'middle' } = {}) {
    g.font = font(10.5);
    const w = g.measureText(text).width;
    const x0 = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    if (bg) { g.fillStyle = bg; g.fillRect(x0 - 3, y - 7.5, w + 6, 15); }
    g.fillStyle = color; g.textBaseline = base; g.textAlign = 'left'; g.fillText(text, x0, y);
  }
  const alpha = (hex, a) => hex + Math.round(a * 255).toString(16).padStart(2, '0');

  function paint(g, W, Hh, layer) {
    const ts = chart.timeScale();
    const vis = ts.getVisibleLogicalRange();
    if (!vis) return;
    const X = i => ts.logicalToCoordinate(i);
    const Y = p => candles.priceToCoordinate(p);
    const bs = Math.max(1, (X(1) ?? 0) - (X(0) ?? 0));
    const nB = B.length;
    const right = X(nB - 1) + bs / 2;
    const L = st.get().layers;
    const c = colors();
    const from = Math.max(0, Math.floor(vis.from) - 2), to = Math.min(nB - 1, Math.ceil(vis.to) + 2);
    const inView = (a, b) => b >= from && a <= to;
    const hl = (y, x0, x1, col, dash, w = 1) => { if (y == null) return; g.save(); g.strokeStyle = col; g.lineWidth = w; if (dash) g.setLineDash(dash); g.beginPath(); g.moveTo(x0, Math.round(y) + 0.5); g.lineTo(x1, Math.round(y) + 0.5); g.stroke(); g.restore(); };
    const box = (x0, x1, p0, p1, fill, stroke, dash) => {
      const y0 = Y(p0), y1 = Y(p1); if (y0 == null || y1 == null) return;
      const top = Math.min(y0, y1), h = Math.max(1, Math.abs(y1 - y0));
      g.fillStyle = fill; g.fillRect(x0, top, x1 - x0, h);
      if (stroke) { g.save(); g.strokeStyle = stroke; if (dash) g.setLineDash(dash); g.strokeRect(Math.round(x0) + 0.5, Math.round(top) + 0.5, x1 - x0, h); g.restore(); }
    };

    if (layer === 'bg') {
      // 交易时段
      if (L.sessions) for (const s of R.sessions) {
        if (!inView(s.start, s.end)) continue;
        const col = SESSION_COLORS[s.id];
        box(X(s.start) - bs / 2, X(s.end) + bs / 2, s.hi, s.lo, alpha(col, 0.07), alpha(col, 0.35));
        tag(g, s.name, X(s.start) - bs / 2 + 3, Y(s.hi) - 8, alpha(col, 0.9));
      }
      // FVG：未回补的延伸到最右，已回补的停在回补那根
      if (L.fvg) {
        // 没回补的（最近 600 根内）+ 最近 150 根里刚回补的
        const list = R.fvg.filter(f => (f.filled < 0 ? f.i > nB - 600 : f.filled > nB - 150) && (f.filled < 0 || f.filled > from));
        for (const f of list.slice(-60)) {
          const end = f.filled >= 0 ? f.filled : nB - 1;
          if (!inView(f.i - 1, end)) continue;
          const col = f.dir > 0 ? c.up : c.down;
          const done = f.filled >= 0;
          box(X(f.i - 1) - bs / 2, f.filled >= 0 ? X(end) : right + bs * 2, f.top, f.bottom, alpha(hex(col), done ? 0.06 : f.mitigated >= 0 ? 0.12 : 0.18), null);
        }
      }
      // 订单块：每个方向显示最近 4 个
      if (L.ob) {
        for (const dir of [1, -1]) {
          for (const o of R.ob.filter(x => x.dir === dir).slice(-4)) {
            const end = o.breaker ? Math.max(o.mitigated, o.i + 1) : nB - 1;
            if (!inView(o.i, end)) continue;
            const col = hex(dir > 0 ? c.up : c.down);
            box(X(o.i) - bs / 2, o.breaker ? X(end) : right + bs * 2, o.top, o.bottom, alpha(col, o.breaker ? 0.05 : 0.11), alpha(col, o.breaker ? 0.3 : 0.7), o.breaker ? [3, 3] : null);
            tag(g, o.breaker ? 'OB（已破）' : 'OB', X(o.i) - bs / 2 + 3, (Y((o.top + o.bottom) / 2) ?? 0), alpha(col, 0.95));
          }
        }
      }
      // PO3 的 T-Spot（C3 目标区）
      const seq = R.po3[0];
      if (L.po3 && seq && seq.tspot3) {
        const x0 = X(Math.min(seq.c3Idx, nB - 1)) - bs / 2;
        box(x0, right + bs * 2, seq.tspot3[0], seq.tspot3[1], alpha('#f2b33d', 0.12), alpha('#f2b33d', 0.55), [4, 3]);
        tag(g, 'T-Spot（C3）', x0 + 3, Y(Math.max(...seq.tspot3)) - 8, '#f2b33d');
      }
      if (L.po3 && seq && seq.tspot4) {
        const c4 = R.h1[seq.i2 + 2];
        const x0 = X(c4 ? Math.min(idxAtOrAfter(c4.t), nB - 1) : nB - 1) - bs / 2;
        box(x0, right + bs * 2, seq.tspot4[0], seq.tspot4[1], alpha('#ff9800', 0.12), alpha('#ff9800', 0.55), [4, 3]);
        tag(g, 'T-Spot（C4）', x0 + 3, Y(Math.max(...seq.tspot4)) - 8, '#ff9800');
      }
      // 成交量分布（可见区间）
      if (L.vp) {
        const a = Math.max(0, Math.ceil(vis.from)), z = Math.min(nB - 1, Math.floor(vis.to));
        if (z - a > 10) {
          const vp = SMC.volumeProfile(B, a, z, 64);
          R.vp = vp;
          if (vp) {
            const xr = Math.min(right, W - 2), maxW = W * 0.16;
            for (let k = 0; k < vp.vol.length; k++) {
              const y0 = Y(vp.lo + k * vp.step), y1 = Y(vp.lo + (k + 1) * vp.step);
              if (y0 == null || y1 == null) continue;
              const h = Math.max(1, Math.abs(y0 - y1) - 1), top = Math.min(y0, y1) + 0.5;
              const w = vp.vol[k] / vp.max * maxW, wb = vp.buy[k] / vp.max * maxW;
              const inVA = vp.lo + (k + 0.5) * vp.step >= vp.val && vp.lo + (k + 0.5) * vp.step <= vp.vah;
              g.fillStyle = inVA ? 'rgba(135,150,171,.20)' : 'rgba(135,150,171,.10)'; g.fillRect(xr - w, top, w, h);
              g.fillStyle = inVA ? alpha(hex(c.up), 0.22) : alpha(hex(c.up), 0.1); g.fillRect(xr - w, top, wb, h);
            }
          }
        }
      }
      return;
    }

    // ------- 前景 -------
    // 价位：前日 / 前周高低、日开 / 周开
    const lv = [];
    if (L.pdl && R.day) lv.push([R.day.ph, '前日高', '#d6deea', [6, 4], R.day.start], [R.day.pl, '前日低', '#d6deea', [6, 4], R.day.start]);
    if (L.pwl && R.week) lv.push([R.week.ph, '前周高', '#a68cfa', [6, 4], R.week.start], [R.week.pl, '前周低', '#a68cfa', [6, 4], R.week.start]);
    if (L.opens && R.day) lv.push([R.day.open, '日开盘', '#8796ab', [2, 3], R.day.start]);
    if (L.opens && R.week) lv.push([R.week.open, '周开盘', '#8796ab', [2, 3], R.week.start]);
    for (const [p, name, col, dash, t0] of lv) {
      const y = Y(p); if (y == null) continue;
      const x0 = Math.max(0, X(Math.max(0, idxAtOrAfter(t0))) ?? 0);
      hl(y, x0, right + bs * 2 + LABEL_W, alpha(hex(col), 0.75), dash);
      tag(g, `${name} ${fmt.price(p)}`, right + bs * 2 + 2, y - 7, hex(col));
    }
    // 摆动点
    if (L.swings) for (const p of R.swLabels) {
      if (p.i < from || p.i > to) continue;
      const y = Y(p.level); if (y == null) continue;
      tag(g, p.lab, X(p.i), p.type > 0 ? y - 9 : y + 9, p.type > 0 ? '#c9d3e0' : '#c9d3e0', { align: 'center' });
    }
    // BOS / CHoCH
    if (L.bos) for (const e of R.bos) {
      if (!inView(e.i, e.broken)) continue;
      const y = Y(e.level); if (y == null) continue;
      const col = e.dir > 0 ? c.up : c.down;
      hl(y, X(e.i), X(e.broken), col, e.kind === 'BOS' ? [4, 3] : null, e.kind === 'CHoCH' ? 1.5 : 1);
      tag(g, e.kind, (X(e.i) + X(e.broken)) / 2, e.dir > 0 ? y - 8 : y + 8, col, { align: 'center' });
    }
    // 等高 / 等低
    if (L.liq) for (const q of R.liq) {
      const end = q.swept >= 0 ? q.swept : nB - 1;
      if (!inView(q.i, end)) continue;
      const y = Y(q.level); if (y == null) continue;
      hl(y, X(q.i), q.swept >= 0 ? X(end) : right + bs * 2, alpha('#f2b33d', q.swept >= 0 ? 0.45 : 0.9), [1, 3], 1.5);
      tag(g, `${q.type > 0 ? '等高' : '等低'}×${q.count}${q.swept >= 0 ? ' 已扫' : ''}`, X(q.i), q.type > 0 ? y - 8 : y + 8, '#f2b33d');
    }
    // CISD
    // 有效的 CISD + 最近 60 根里失效的（变暗）
    if (L.cisd) for (const k of R.cisd.filter(x => x.invalid < 0 || x.i > nB - 60).slice(-12)) {
      if (!inView(k.start, k.i + 3)) continue;
      const y = Y(k.level); if (y == null) continue;
      const col = alpha(hex(k.bull ? c.up : c.down), k.invalid >= 0 ? 0.35 : 1);
      hl(y, X(k.start) - bs / 2, X(k.i + 3), col, null, 1.5);
      tag(g, 'CISD', X(k.i + 3) + 3, y, col);
    }
    // PO3：C1 高低点（被扫的那条）、C2 极值、STDV
    const seq = R.po3[0];
    if (L.po3 && seq) {
      const x0 = X(Math.min(seq.c1Idx, nB - 1)) - bs / 2;
      const swept = seq.side > 0 ? seq.c1.l : seq.c1.h;
      hl(Y(swept), x0, right + bs * 2, '#f2b33d', [6, 3]);
      tag(g, `C1 ${seq.side > 0 ? '低点' : '高点'}（${VP.TF_NAME[R.h1tf]}）`, x0 + 3, Y(swept) + (seq.side > 0 ? 9 : -9), '#f2b33d');
      hl(Y(seq.extreme), X(Math.min(seq.c2Idx, nB - 1)) - bs / 2, right + bs * 2, alpha('#f2b33d', 0.5), [2, 3]);
      tag(g, 'C2 极值', X(Math.min(seq.c2Idx, nB - 1)) + 3, Y(seq.extreme) + (seq.side > 0 ? 9 : -9), alpha('#f2b33d', 0.8));
    }
    if (L.stdv && seq && seq.stdv) {
      const x0 = X(seq.cisd.i) - bs / 2;
      for (let k = 0; k < seq.stdv.length; k++) {
        const s = seq.stdv[k]; const y = Y(s.price); if (y == null) continue;
        hl(y, x0, right + bs * 2, 'rgba(160,170,185,.75)');
        tag(g, `−${s.d}  ${fmt.price(s.price)}`, right + bs * 2 + 2, y - 7, '#a0aab9');
      }
      for (let k = 0; k + 1 < seq.stdv.length; k += 2) {
        const y0 = Y(seq.stdv[k].price), y1 = Y(seq.stdv[k + 1].price);
        if (y0 != null && y1 != null) { g.fillStyle = 'rgba(160,170,185,.08)'; g.fillRect(x0, Math.min(y0, y1), right + bs * 2 - x0, Math.abs(y1 - y0)); }
      }
    }
    // SMT
    if (L.smt && R.smt) for (const s of R.smt.slice(-3)) {
      if (!inView(s.i1, s.i2)) continue;
      const y1 = Y(s.l1), y2 = Y(s.l2); if (y1 == null || y2 == null) continue;
      g.save(); g.strokeStyle = '#a68cfa'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(X(s.i1), y1); g.lineTo(X(s.i2), y2); g.stroke(); g.restore();
      tag(g, `SMT（${coin === 'BTC' ? 'ETH' : 'BTC'}）`, X(s.i2) + 4, y2 + (s.type > 0 ? 9 : -9), '#a68cfa');
    }
    // 成交量分布的 POC / 价值区
    if (L.vp && R.vp) {
      const xa = X(Math.max(0, Math.ceil(vis.from))), xr = Math.min(right, W - 2);
      hl(Y(R.vp.poc), xa, xr, alpha('#f2b33d', 0.8), null, 1);
      hl(Y(R.vp.vah), xa, xr, 'rgba(135,150,171,.5)', [2, 3]);
      hl(Y(R.vp.val), xa, xr, 'rgba(135,150,171,.5)', [2, 3]);
      tag(g, 'POC', xr - 4, Y(R.vp.poc) - 7, '#f2b33d', { align: 'right' });
    }
    // 右侧的高周期 K 线
    if (L.htf) drawHtf(g, W, X, Y, bs, right, c, seq, L);
  }

  function hex(col) {
    if (col.startsWith('#')) return col.length === 4 ? '#' + [...col.slice(1)].map(x => x + x).join('') : col.slice(0, 7);
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(col);
    return m ? '#' + [m[1], m[2], m[3]].map(v => Number(v).toString(16).padStart(2, '0')).join('') : '#888888';
  }

  function drawHtf(g, W, X, Y, bs, right, c, seq, L) {
    const groups = [[R.h1, R.h1tf, 4], [R.h2, R.h2tf, 3]];
    let x = right + bs * 2 + LABEL_W + 8;
    const cw = Math.max(6, Math.min(14, bs * 1.4)), gap = Math.max(3, cw * 0.5);
    for (const [bars, t, count] of groups) {
      const list = bars.slice(-count);
      if (!list.length) continue;
      if (x + (cw + gap) * list.length > W - 4) break;
      g.font = font(10.5, 600); g.fillStyle = '#8796ab'; g.textAlign = 'left'; g.textBaseline = 'middle';
      let topY = Infinity;
      list.forEach(b => { const y = Y(b.h); if (y != null) topY = Math.min(topY, y); });
      tag(g, VP.TF_NAME[t], x, Math.max(10, topY - 16), '#8796ab');
      list.forEach((b, k) => {
        const cx = x + k * (cw + gap) + cw / 2;
        const yo = Y(b.o), yc = Y(b.c), yh = Y(b.h), yl = Y(b.l);
        if ([yo, yc, yh, yl].some(v => v == null)) return;
        const col = b.c >= b.o ? c.up : c.down;
        g.strokeStyle = col; g.lineWidth = 1; g.beginPath(); g.moveTo(Math.round(cx) + 0.5, yh); g.lineTo(Math.round(cx) + 0.5, yl); g.stroke();
        g.fillStyle = col; g.fillRect(cx - cw / 2, Math.min(yo, yc), cw, Math.max(1, Math.abs(yc - yo)));
        // C1–C4 标记（第一个高周期上的 PO3 序列）
        if (t === R.h1tf && L.po3 && seq) {
          const idx = bars.length - list.length + k;
          const lab = idx === seq.i1 ? 'C1' : idx === seq.i2 ? 'C2' : idx === seq.i2 + 1 ? 'C3' : idx === seq.i2 + 2 ? 'C4' : '';
          if (lab) tag(g, lab, cx, yl + 10, '#f2b33d', { align: 'center' });
        }
      });
      x += list.length * (cw + gap) + cw * 1.6;
    }
  }

  /* ------------------------------------------------------------ 图例 */
  function legend(param) {
    if (!B.length) return;
    let i = B.length - 1;
    if (param && param.logical != null) i = Math.max(0, Math.min(B.length - 1, Math.round(param.logical)));
    const b = B[i], L = st.get().layers;
    const ch = b.c / b.o - 1;
    const parts = [`<span>${fmt.date(b.t * 1000)} ${fmt.time(b.t * 1000, false)}</span>`, `<span>开 <b>${fmt.price(b.o)}</b></span>`, `<span>高 <b>${fmt.price(b.h)}</b></span>`, `<span>低 <b>${fmt.price(b.l)}</b></span>`, `<span>收 <b class="${ch >= 0 ? 'up' : 'down'}">${fmt.price(b.c)}</b> ${fmt.pct(ch)}</span>`];
    if (L.vwapD && isFinite(R.vwap.D.vw[i])) parts.push(`<span><i style="background:${VWAP_COLORS.D}"></i>日 VWAP <b>${fmt.price(R.vwap.D.vw[i])}</b></span>`);
    if (L.vwapW && isFinite(R.vwap.W.vw[i])) parts.push(`<span><i style="background:${VWAP_COLORS.W}"></i>周 VWAP <b>${fmt.price(R.vwap.W.vw[i])}</b></span>`);
    if (L.vwapM && isFinite(R.vwap.M.vw[i])) parts.push(`<span><i style="background:${VWAP_COLORS.M}"></i>月 VWAP <b>${fmt.price(R.vwap.M.vw[i])}</b></span>`);
    if (L.bb) R.bb.forEach((bb, k) => { if (bb && isFinite(bb.up[i])) parts.push(`<span><i style="background:${BB_COLORS[k]}"></i>布林 ${VP.TF_NAME[bb.tf]} <b>${fmt.price(bb.dn[i])}–${fmt.price(bb.up[i])}</b></span>`); });
    if (L.rvwap) for (const N of [30, 90, 365]) if (isFinite(R.rv[N][i])) parts.push(`<span><i style="background:${RV_COLORS[N]}"></i>RVWAP ${N} 天 <b>${fmt.price(R.rv[N][i])}</b></span>`);
    if (L.ema) for (const N of [20, 50, 200]) if (isFinite(R.ema[N][i])) parts.push(`<span><i style="background:${EMA_COLORS[N]}"></i>EMA${N} <b>${fmt.price(R.ema[N][i])}</b></span>`);
    $('#legend').innerHTML = parts.join('');
  }
  chart.subscribeCrosshairMove(p => legend(p && p.time ? p : null));
  chart.timeScale().subscribeVisibleLogicalRangeChange(() => overlay.update());

  /* ------------------------------------------------------------ 侧栏 */
  function renderLayers() {
    const L = st.get().layers, s = st.get();
    const sw = { bb: BB_COLORS[1], vwapD: VWAP_COLORS.D, vwapW: VWAP_COLORS.W, vwapM: VWAP_COLORS.M, rvwap: RV_COLORS[365], ema: EMA_COLORS[200], liq: '#f2b33d', po3: '#f2b33d', smt: '#a68cfa', pwl: '#a68cfa' };
    $('#side-layers').innerHTML = LAYERS.map(([name, items]) => `<div class="layer-group"><h4>${name}</h4>`
      + items.map(([k, label]) => `<label class="check"><input type="checkbox" data-k="${k}" ${L[k] ? 'checked' : ''}> ${label}${sw[k] ? `<i class="sw" style="background:${sw[k]}"></i>` : ''}</label>`).join('')
      + (name === '结构' ? `<div class="param">摆动长度 <input class="field" type="number" min="2" max="50" id="swingLen" value="${s.swing}"> FVG 最小 <input class="field" type="number" min="0" max="3" step="0.05" id="fvgMin" value="${s.fvgMin}">×ATR</div>` : '')
      + (name === 'ICT / PO3' ? `<div class="param">高周期：${HTF[tf].map(t => VP.TF_NAME[t]).join(' / ')}；三周期布林：${BBTF[tf].map(t => VP.TF_NAME[t]).join(' / ')}</div>` : '')
      + `</div>`).join('');
  }
  $('#side-layers').addEventListener('change', e => {
    const k = e.target.dataset.k;
    if (k) {
      const layers = { ...st.get().layers, [k]: e.target.checked };
      st.set({ layers });
      if (k === 'smt' && e.target.checked) { load(false); return; }
      draw(false);
      return;
    }
    if (e.target.id === 'swingLen') { st.set({ swing: Math.max(2, Math.min(50, Number(e.target.value) || 10)) }); compute(); draw(false); }
    if (e.target.id === 'fvgMin') { st.set({ fvgMin: Math.max(0, Math.min(3, Number(e.target.value) || 0)) }); compute(); draw(false); }
  });

  function renderSide() {
    renderNow();
    if (st.get().tab === 'stats') renderStats();
  }
  function renderNow() {
    if (!R || !B.length) return;
    const last = B[B.length - 1], px = last.c;
    const dist = p => `${fmt.price(p)}（${p >= px ? '+' : ''}${((p / px - 1) * 100).toFixed(2)}%）`;
    const rows = [];
    const lastBreak = R.bos[R.bos.length - 1];
    rows.push(['结构方向', lastBreak ? `<span class="${lastBreak.dir > 0 ? 'up' : 'down'}">${lastBreak.dir > 0 ? '看涨' : '看跌'}</span>（最近 ${lastBreak.kind}）` : '—']);
    const seq = R.po3[0];
    rows.push([`PO3（${VP.TF_NAME[R.h1tf]}）`, seq ? `<span class="${seq.side > 0 ? 'up' : 'down'}">${seq.side > 0 ? '看涨' : '看跌'}</span> C${seq.phase} 阶段${seq.cisd ? '，已有 CISD' : ''}` : '没有进行中的序列']);
    if (seq && seq.tspot3) rows.push(['T-Spot（C3）', `${fmt.price(Math.min(...seq.tspot3))}–${fmt.price(Math.max(...seq.tspot3))}`]);
    const openF = R.fvg.filter(f => f.filled < 0);
    const fUp = openF.filter(f => f.bottom > px).sort((a, b) => a.bottom - b.bottom)[0];
    const fDn = openF.filter(f => f.top < px).sort((a, b) => b.top - a.top)[0];
    rows.push(['上方最近 FVG', fUp ? dist(fUp.bottom) : '—']);
    rows.push(['下方最近 FVG', fDn ? dist(fDn.top) : '—']);
    const act = R.ob.filter(o => !o.breaker);
    const oUp = act.filter(o => o.bottom > px).sort((a, b) => a.bottom - b.bottom)[0];
    const oDn = act.filter(o => o.top < px).sort((a, b) => b.top - a.top)[0];
    rows.push(['上方订单块', oUp ? dist(oUp.bottom) : '—']);
    rows.push(['下方订单块', oDn ? dist(oDn.top) : '—']);
    if (R.day) { rows.push(['前日高', dist(R.day.ph)]); rows.push(['前日低', dist(R.day.pl)]); }
    const vw = R.vwap.D.vw[B.length - 1];
    if (isFinite(vw)) rows.push(['日 VWAP', `${px >= vw ? '价格在上方' : '价格在下方'} ${dist(vw)}`]);
    const bbs = R.bb.filter(Boolean);
    if (bbs.length) {
      const i = B.length - 1;
      const above = bbs.filter(b => px > b.up[i]).length, below = bbs.filter(b => px < b.dn[i]).length;
      rows.push(['三周期布林', above ? `收在 ${above} 条上轨之上` : below ? `收在 ${below} 条下轨之下` : '在通道内']);
    }
    $('#side-now').innerHTML = rows.map(([k, v]) => `<div class="now-row"><span>${k}</span><b>${v}</b></div>`).join('')
      + `<div class="now-head">最近信号</div><ol class="events">` + R.events.map(e => `<li data-i="${e.i}"><span class="t">${fmt.date(B[e.i].t * 1000)} ${fmt.time(B[e.i].t * 1000, false)}</span><span class="${e.bull ? 'bull' : 'bear'}">${e.text}</span></li>`).join('') + `</ol>`;
  }
  $('#side-now').addEventListener('click', e => {
    const li = e.target.closest('li[data-i]'); if (!li) return;
    const i = Number(li.dataset.i);
    const r = chart.timeScale().getVisibleLogicalRange();
    const span = r ? r.to - r.from : 200;
    chart.timeScale().setVisibleLogicalRange({ from: i - span / 2, to: i + span / 2 });
  });

  /* ---------- 统计：前日高低被突破的概率、日内高低点出现在哪个时段 ---------- */
  let hourly = null, hourlyKey = '';
  async function renderStats() {
    const el = $('#side-stats');
    if (daily.length < 30) { el.innerHTML = '<p class="stat-note">日线数据不够，暂时无法统计。</p>'; return; }
    const D = daily.slice(-91);
    let up = 0, dn = 0, both = 0, inside = 0, k = 0;
    for (let i = 1; i < D.length - 1; i++) {
      const p = D[i - 1], d = D[i];
      const u = d.h > p.h, w = d.l < p.l;
      k++; if (u) up++; if (w) dn++; if (u && w) both++; if (!u && !w) inside++;
    }
    const pct = v => (k ? v / k * 100 : 0);
    const ranges = daily.slice(-15, -1).map(d => d.h - d.l);
    const adr = ranges.reduce((a, b) => a + b, 0) / Math.max(1, ranges.length);
    const today = daily[daily.length - 1];
    const bar = (label, v, txt) => `<div class="stat-bar"><span>${label}</span><span class="track"><span class="fill" style="width:${Math.min(100, v).toFixed(1)}%"></span></span><b>${txt ?? v.toFixed(0) + '%'}</b></div>`;
    let html = `<div class="now-head">最近 ${k} 天（UTC 自然日）</div>`
      + bar('破前日高', pct(up)) + bar('破前日低', pct(dn)) + bar('两边都破', pct(both)) + bar('都没破', pct(inside))
      + `<div class="now-head">波动</div><div class="now-row"><span>平均日内振幅（14 天）</span><b>${fmt.price(adr)}（${(adr / today.o * 100).toFixed(2)}%）</b></div>`
      + `<div class="now-row"><span>今天已走</span><b>${fmt.price(today.h - today.l)}（ADR 的 ${((today.h - today.l) / adr * 100).toFixed(0)}%）</b></div>`;
    // 日内高低点出现的时段：用 1 小时 K 线统计最近 30 天
    const key = `${coin}|${mkt}`;
    if (hourlyKey !== key) {
      hourlyKey = key; hourly = null;
      try { hourly = await kl(await resolveSymbol(), '1h', 720, false); } catch { hourly = []; }
    }
    if (hourly && hourly.length > 48) {
      const days = new Map();
      for (const b of hourly) {
        const d = dayKey(b.t);
        const g = days.get(d) || { hi: -Infinity, lo: Infinity, hiT: 0, loT: 0, n: 0 };
        if (b.h > g.hi) { g.hi = b.h; g.hiT = b.t; } if (b.l < g.lo) { g.lo = b.l; g.loT = b.t; } g.n++;
        days.set(d, g);
      }
      const sessOf = t => { const { hour } = SMC.nyParts(t); const s = SMC.SESSIONS.find(x => (x.from < x.to ? hour >= x.from && hour < x.to : hour >= x.from || hour < x.to)); return s ? s.name : '其他'; };
      const cntH = {}, cntL = {}; let m = 0;
      for (const g of days.values()) { if (g.n < 24) continue; m++; cntH[sessOf(g.hiT)] = (cntH[sessOf(g.hiT)] || 0) + 1; cntL[sessOf(g.loT)] = (cntL[sessOf(g.loT)] || 0) + 1; }
      const names = [...SMC.SESSIONS.map(s => s.name), '其他'];
      html += `<div class="now-head">日内最高点出现在（${m} 天）</div>` + names.map(nm => bar(nm, (cntH[nm] || 0) / Math.max(1, m) * 100)).join('')
        + `<div class="now-head">日内最低点出现在</div>` + names.map(nm => bar(nm, (cntL[nm] || 0) / Math.max(1, m) * 100)).join('')
        + `<p class="stat-note">时段按纽约时间：亚洲 18–02、伦敦 02–08、纽约上午 08–12、纽约下午 12–16，其他是 16–18 点；日按 UTC 0 点（北京时间 8 点）划分。</p>`;
    }
    el.innerHTML = html;
  }

  function showTab(t) {
    st.set({ tab: t });
    document.querySelectorAll('#sideTabs button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === t)));
    ['layers', 'now', 'stats'].forEach(x => { $('#side-' + x).hidden = x !== t; });
    if (t === 'stats') renderStats();
    if (t === 'now') renderNow();
  }
  $('#sideTabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) showTab(b.dataset.v); });

  /* ------------------------------------------------------------ 顶栏 */
  function markTop() {
    document.querySelectorAll('#tf button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === tf)));
    document.querySelectorAll('#quick button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === coin)));
    document.querySelectorAll('#mkt button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === mkt)));
    $('#coin').value = coin;
  }
  function restart() { B = []; R = null; markTop(); renderLayers(); $('#chartMsg').hidden = false; $('#chartMsg').textContent = '加载中…'; load(true); timer.stop(); timer = VP.every(refreshMs(), () => load(false), { immediate: false }); }
  const refreshMs = () => (tf === '1m' || tf === '5m' ? 15000 : tf === '15m' || tf === '1h' ? 30000 : 60000);
  $('#tf').innerHTML = TFS.map(t => `<button type="button" data-v="${t}">${t}</button>`).join('');
  $('#quick').innerHTML = QUICK.map(c => `<button type="button" class="chip" data-v="${c}">${c}</button>`).join('');
  $('#tf').addEventListener('click', e => { const b = e.target.closest('button'); if (b && b.dataset.v !== tf) { tf = b.dataset.v; st.set({ tf }); restart(); } });
  $('#mkt').addEventListener('click', e => { const b = e.target.closest('button'); if (b && b.dataset.v !== mkt) { mkt = b.dataset.v; st.set({ mkt }); hourlyKey = ''; restart(); } });
  $('#quick').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setCoin(b.dataset.v); });
  const inp = $('#coin');
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') { setCoin(inp.value); inp.blur(); } });
  inp.addEventListener('change', () => setCoin(inp.value));
  function setCoin(v) {
    v = VP.baseOf(String(v || '').trim().toUpperCase().replace(/[-_/]?(USDT|USD|PERP|SWAP)$/, ''))[0];
    if (!v || v === coin) { markTop(); return; }
    coin = v; st.set({ coin }); hourlyKey = ''; restart();
  }
  ex.binance.ticker24().then(t => {
    const list = t.filter(x => /USDT$/.test(x.symbol)).sort((a, b) => n(b.quoteVolume) - n(a.quoteVolume)).map(x => VP.baseOf(x.symbol.slice(0, -4))[0]);
    $('#coinList').innerHTML = [...new Set(list)].slice(0, 250).map(b => `<option value="${b}">`).join('');
  }).catch(() => {});
  // 外壳的币种联动（在聚合成交里点了交易对）
  window.addEventListener('vpfm-coin', e => { if (e.detail) setCoin(e.detail); });
  VP.onPrefs(() => draw(false));

  markTop();
  renderLayers();
  showTab(st.get().tab || 'layers');
  let timer = { stop() {} };
  restart();
})();
