'use strict';
/* 期权 GEX：Deribit BTC/ETH 期权的 Gamma 敞口、翻转价、看涨/看跌墙、最大痛点、
   波动率微笑与期限结构、大额成交。数据来自 Deribit 公开接口，Greeks 用 Black-76（零利率）在本机计算。 */
(function () {
  const { fmt, ex, n } = VP;
  const $ = s => document.querySelector(s);
  const D_ = VP.draw;
  const st = VP.store('options', { cur: 'BTC', exp: 'all', one: '', range: 0.2, mode: 'net', smile: '', bigMin: 500000 });
  const MON = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
  const YEAR_MS = 365 * 24 * 3600e3;
  const COL = { pos: '#45b7ff', neg: '#ff6a3d', call: '#45b7ff', put: '#ff6a3d', flip: '#a68cfa' };

  /* ------------------------------------------------------------ 数学 */
  const SQ2PI = Math.sqrt(2 * Math.PI);
  const pdf = x => Math.exp(-x * x / 2) / SQ2PI;
  function cdf(x) { // Abramowitz–Stegun 26.2.17
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const p = pdf(x) * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return x >= 0 ? 1 - p : p;
  }
  /** Black-76：返回 gamma（对远期价格）和 delta */
  function greeks(F, K, T, iv, call) {
    if (!(T > 0) || !(iv > 0) || !(F > 0)) return { gamma: 0, delta: call ? (F > K ? 1 : 0) : (F < K ? -1 : 0) };
    const s = iv * Math.sqrt(T);
    const d1 = (Math.log(F / K) + s * s / 2) / s;
    return { gamma: pdf(d1) / (F * s), delta: call ? cdf(d1) : cdf(d1) - 1 };
  }

  function parseInst(name) {
    const m = /^([A-Z]+)(?:_[A-Z]+)?-(\d{1,2})([A-Z]{3})(\d{2})-([\dd.]+)-([CP])$/.exec(name);
    if (!m) return null;
    const exp = Date.UTC(2000 + Number(m[4]), MON[m[3]], Number(m[2]), 8, 0, 0);
    return { exp, strike: Number(m[5].replace('d', '.')), call: m[6] === 'C', code: `${m[2]}${m[3]}${m[4]}` };
  }
  const fk = v => (v >= 100 ? fmt.num(v, 0) : fmt.price(v)); // 行权价、整数价位
  const expLabel = ts => { const d = new Date(ts); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
  const daysLeft = ts => (ts - Date.now()) / 86400e3;
  const leftText = ts => { const d = daysLeft(ts); return d < 1 ? `${Math.max(0, Math.round(d * 24))} 小时` : `${d < 10 ? d.toFixed(1) : Math.round(d)} 天`; };

  /* ------------------------------------------------------------ 数据 */
  let D = null;
  let loading = false;

  async function load() {
    if (loading) return;
    loading = true;
    const cur = st.get().cur;
    try {
      const [sum, idx, trades, dvol] = await Promise.allSettled([
        ex.deribit.summary(cur, 'option'), ex.deribit.index(cur), ex.deribit.trades(cur, 1000), ex.deribit.volIndex(cur, 3600, 24 * 30),
      ]);
      if (cur !== st.get().cur) return;
      if (sum.status !== 'fulfilled') throw sum.reason;
      const spot = idx.status === 'fulfilled' ? n(idx.value.index_price) : n(sum.value.find(o => o.estimated_delivery_price)?.estimated_delivery_price);
      const now = Date.now();
      const opts = [];
      for (const o of sum.value) {
        const p = parseInst(o.instrument_name);
        if (!p || p.exp <= now) continue;
        const T = (p.exp - now) / YEAR_MS;
        const F = n(o.underlying_price) || spot;
        const iv = n(o.mark_iv) / 100;
        const g = greeks(F, p.strike, T, iv, p.call);
        const oi = n(o.open_interest) || 0;
        opts.push({
          name: o.instrument_name, ...p, T, F, iv, oi, vol: n(o.volume) || 0,
          mark: n(o.mark_price), gamma: g.gamma, delta: g.delta,
          gex: (p.call ? 1 : -1) * g.gamma * oi * spot * spot * 0.01,
        });
      }
      const exps = [...new Set(opts.map(o => o.exp))].sort((a, b) => a - b);
      let dv = null;
      if (dvol.status === 'fulfilled' && dvol.value.data?.length) {
        const rows = dvol.value.data.map(r => ({ t: n(r[0]), v: n(r[4]) })).filter(r => isFinite(r.v)).sort((a, b) => a.t - b.t);
        const last = rows[rows.length - 1], dayAgo = rows.find(r => r.t >= last.t - 24 * 3600e3) || rows[0];
        const vals = rows.map(r => r.v);
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) || 1;
        const pct = vals.filter(v => v <= last.v).length / vals.length;
        dv = { now: last.v, chg: last.v - dayAgo.v, rows, mean, sd, z: (last.v - mean) / sd, pct };
      }
      D = { cur, spot, opts, exps, trades: trades.status === 'fulfilled' ? trades.value : [], dvol: dv, at: now };
      const errs = [idx, trades, dvol].filter(x => x.status === 'rejected').map(x => x.reason.message);
      setStatus(`更新于 ${fmt.time(now)}` + (errs.length ? `，${errs.length} 项失败` : ''), errs.length > 0, errs.join('\n'));
      fillExpChoices();
      compute();
    } catch (e) {
      setStatus('获取 Deribit 期权数据失败：' + e.message, true);
      if (!D) $('#kpis').innerHTML = `<div class="empty">获取 Deribit 期权数据失败：${e.message}<br><button class="btn" onclick="location.reload()">重试</button></div>`;
    } finally { loading = false; }
  }
  function setStatus(t, bad = false, title = '') { const s = $('#status'); s.textContent = t; s.classList.toggle('bad', bad); s.title = title; }

  /* ------------------------------------------------------------ 计算 */
  let C = null;
  function selectedOpts() {
    const s = st.get();
    if (s.exp === 'one') return D.opts.filter(o => o.code === s.one);
    if (s.exp === '7' || s.exp === '30') { const lim = Number(s.exp); return D.opts.filter(o => daysLeft(o.exp) <= lim); }
    return D.opts;
  }

  function maxPain(list) {
    const strikes = [...new Set(list.map(o => o.strike))].sort((a, b) => a - b);
    let best = null, bestPay = Infinity;
    for (const k of strikes) {
      let pay = 0;
      for (const o of list) pay += o.oi * (o.call ? Math.max(0, k - o.strike) : Math.max(0, o.strike - k));
      if (pay < bestPay) { bestPay = pay; best = k; }
    }
    return best;
  }

  function perExpiry() {
    return D.exps.map(exp => {
      const list = D.opts.filter(o => o.exp === exp);
      const F = list[0]?.F || D.spot;
      const T = list[0]?.T || 0;
      let cOi = 0, pOi = 0;
      for (const o of list) { if (o.call) cOi += o.oi; else pOi += o.oi; }
      // ATM：离远期价最近的行权价，看涨看跌 IV 取平均
      const strikes = [...new Set(list.map(o => o.strike))];
      const atmK = strikes.reduce((a, b) => (Math.abs(b - F) < Math.abs(a - F) ? b : a), strikes[0]);
      const atm = list.filter(o => o.strike === atmK && o.iv > 0);
      const atmIv = atm.length ? atm.reduce((a, o) => a + o.iv, 0) / atm.length : NaN;
      const near = (call, target) => list.filter(o => o.call === call && o.iv > 0).reduce((best, o) => (!best || Math.abs(o.delta - target) < Math.abs(best.delta - target) ? o : best), null);
      const c25 = near(true, 0.25), p25 = near(false, -0.25);
      const ok25 = c25 && p25 && Math.abs(c25.delta - 0.25) < 0.08 && Math.abs(p25.delta + 0.25) < 0.08;
      return {
        exp, code: list[0]?.code, F, T, cOi, pOi, pcr: cOi > 0 ? pOi / cOi : NaN, maxPain: maxPain(list), atmIv,
        rr: ok25 ? c25.iv - p25.iv : NaN, bf: ok25 ? (c25.iv + p25.iv) / 2 - atmIv : NaN,
        move: F * atmIv * Math.sqrt(T),
      };
    });
  }

  function compute() {
    if (!D) return;
    const list = selectedOpts();
    const S0 = D.spot;
    const by = new Map();
    let cOi = 0, pOi = 0, cVol = 0, pVol = 0, net = 0;
    for (const o of list) {
      const r = by.get(o.strike) || { k: o.strike, cg: 0, pg: 0, co: 0, po: 0 };
      if (o.call) { r.cg += o.gex; r.co += o.oi; cOi += o.oi; cVol += o.vol; } else { r.pg += o.gex; r.po += o.oi; pOi += o.oi; pVol += o.vol; }
      net += o.gex;
      by.set(o.strike, r);
    }
    const strikes = [...by.values()].sort((a, b) => a.k - b.k);
    // GEX 随价格变化：远期价随现价同比例移动，IV 不变
    const lo = S0 * 0.7, hi = S0 * 1.3, N = 121;
    const prof = [];
    for (let i = 0; i < N; i++) {
      const S = lo + (hi - lo) * i / (N - 1);
      let g = 0;
      for (const o of list) {
        if (!o.oi) continue;
        const gm = greeks(o.F * S / S0, o.strike, o.T, o.iv, o.call).gamma;
        g += (o.call ? 1 : -1) * gm * o.oi * S * S * 0.01;
      }
      prof.push({ S, g });
    }
    // 翻转价：离现价最近的零点
    let flip = NaN;
    for (let i = 1; i < prof.length; i++) {
      const a = prof[i - 1], b = prof[i];
      if ((a.g <= 0 && b.g > 0) || (a.g >= 0 && b.g < 0)) {
        const x = a.S + (b.S - a.S) * (0 - a.g) / (b.g - a.g);
        if (!isFinite(flip) || Math.abs(x - S0) < Math.abs(flip - S0)) flip = x;
      }
    }
    const callWall = strikes.reduce((a, b) => (b.cg > (a?.cg ?? -Infinity) ? b : a), null);
    const putWall = strikes.reduce((a, b) => (b.pg < (a?.pg ?? Infinity) ? b : a), null);
    const exps = perExpiry();
    const sel = st.get();
    const firstExp = sel.exp === 'one' ? exps.find(e => e.code === sel.one) : exps.find(e => daysLeft(e.exp) > 0.2) || exps[0];
    C = { list, strikes, prof, flip, callWall, putWall, cOi, pOi, cVol, pVol, net, exps, firstExp };
    renderKpis(); renderTable(); renderTrades(); fillSmileChoices();
    charts.gex.redraw(); charts.profile.redraw(); charts.smile.redraw(); charts.term.redraw(); charts.dvol.redraw();
  }

  /* ------------------------------------------------------------ 指标条与表格 */
  function renderKpis() {
    const S = D.spot, cur = D.cur, c = C;
    const k = (label, value, small = '') => `<div class="kpi"><span class="k">${label}</span><span class="v">${value}${small ? `<small class="dim">${small}</small>` : ''}</span></div>`;
    const dist = x => (isFinite(x) ? `${x >= S ? '+' : ''}${((x / S - 1) * 100).toFixed(1)}%` : '');
    const parts = [
      `<div class="kpi big"><span class="k">${cur} 指数</span><span class="v">${fmt.price(S)}${D.dvol ? `<small class="dim">DVOL ${D.dvol.now.toFixed(1)}（${D.dvol.chg >= 0 ? '+' : ''}${D.dvol.chg.toFixed(1)}）</small>` : ''}</span></div>`,
      k('持仓（看涨 / 看跌）', `${fmt.big(c.cOi, 1)} / ${fmt.big(c.pOi, 1)}`, `${cur}，约 ${fmt.usd((c.cOi + c.pOi) * S, 1)}`),
      k('PCR（持仓 / 24h 成交）', `${fmt.num(c.pOi / c.cOi, 2)} / ${fmt.num(c.cVol > 0 ? c.pVol / c.cVol : NaN, 2)}`),
      `<div class="kpi"><span class="k">净 GEX（每 1%）</span><span class="v" style="color:${c.net >= 0 ? COL.pos : COL.neg}">${fmt.usd(c.net, 2)}<small class="dim">${c.net >= 0 ? '正 Gamma，偏稳' : '负 Gamma，易放大'}</small></span></div>`,
      k('Gamma 翻转价', isFinite(c.flip) ? fk(Math.round(c.flip)) : '—', dist(c.flip)),
      k('看涨墙', c.callWall ? fk(c.callWall.k) : '—', c.callWall ? dist(c.callWall.k) : ''),
      k('看跌墙', c.putWall ? fk(c.putWall.k) : '—', c.putWall ? dist(c.putWall.k) : ''),
    ];
    const e = c.firstExp;
    if (e) {
      parts.push(k(`最大痛点（${expLabel(e.exp)}）`, fk(e.maxPain), dist(e.maxPain)));
      parts.push(k(`ATM IV（${expLabel(e.exp)}）`, isFinite(e.atmIv) ? (e.atmIv * 100).toFixed(1) + '%' : '—', isFinite(e.move) ? `到期 ±${fk(Math.round(e.move))}` : ''));
    }
    $('#kpis').innerHTML = parts.join('');
    $('#gexTitle').textContent = `各行权价 Gamma 敞口（${scopeText()}）`;
  }
  function scopeText() {
    const s = st.get();
    if (s.exp === 'one') return C.firstExp ? expLabel(C.firstExp.exp) + ' 到期' : '单个到期日';
    if (s.exp === '7') return '7 天内到期';
    if (s.exp === '30') return '30 天内到期';
    return '全部到期日';
  }

  function renderTable() {
    const sel = st.get();
    $('#expTable tbody').innerHTML = C.exps.map(e => `<tr data-code="${e.code}" class="${sel.exp === 'one' && sel.one === e.code ? 'sel' : ''}">`
      + `<td>${expLabel(e.exp)}</td><td>${leftText(e.exp)}</td><td>${fmt.big(e.cOi, 1)}</td><td>${fmt.big(e.pOi, 1)}</td>`
      + `<td>${fmt.num(e.pcr, 2)}</td><td class="mp">${fk(e.maxPain)}</td>`
      + `<td>${isFinite(e.atmIv) ? (e.atmIv * 100).toFixed(1) + '%' : '—'}</td>`
      + `<td class="${e.rr > 0 ? 'up' : e.rr < 0 ? 'down' : ''}">${isFinite(e.rr) ? (e.rr >= 0 ? '+' : '') + (e.rr * 100).toFixed(1) : '—'}</td>`
      + `<td>${isFinite(e.bf) ? (e.bf * 100).toFixed(1) : '—'}</td>`
      + `<td>${isFinite(e.move) ? '±' + fk(Math.round(e.move)) + `（${(e.move / e.F * 100).toFixed(1)}%）` : '—'}</td></tr>`).join('');
  }

  function renderTrades() {
    const min = st.get().bigMin;
    $('#bigMin').value = String(min);
    const rows = (D.trades || []).map(t => {
      const p = parseInst(t.instrument_name);
      const idx = n(t.index_price) || D.spot;
      return p ? { ...t, p, notional: n(t.amount) * idx, premium: n(t.amount) * n(t.price) * idx } : null;
    }).filter(t => t && t.notional >= min).sort((a, b) => b.timestamp - a.timestamp).slice(0, 150);
    $('#trades').innerHTML = rows.length ? rows.map(t => `<li class="${t.direction}">`
      + `<span class="t">${fmt.time(t.timestamp)}<br>${fmt.date(t.timestamp)}</span>`
      + `<span class="inst">${t.direction === 'buy' ? '买入' : '卖出'} ${expLabel(t.p.exp)} <span class="k">${fk(t.p.strike)}</span> ${t.p.call ? '看涨' : '看跌'}${t.block_trade_id ? '<span class="tag">大宗</span>' : ''}${t.combo_id ? '<span class="tag">组合</span>' : ''}</span>`
      + `<span class="usd">${fmt.usd(t.premium, 1)}</span>`
      + `<span class="meta">${fmt.num(n(t.amount), 1)} ${D.cur}，名义 ${fmt.usd(t.notional, 1)}，IV ${fmt.num(n(t.iv), 1)}%，价格 ${n(t.price)} ${D.cur}</span></li>`).join('')
      : `<li class="empty">最近 1000 笔成交里没有达到这个金额的</li>`;
  }

  /* ------------------------------------------------------------ 图表 */
  const charts = {};
  const RIGHT = 64, BOTTOM = 22, TOP = 14;
  const fmtK = v => (Math.abs(v) >= 1000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + 'k' : String(v));

  function domainX() { const r = st.get().range, S = D.spot; return [S * (1 - r), S * (1 + r)]; }

  charts.gex = VP.plot($('#gexChart'), (g, w, h, state) => {
    if (!C) return;
    const c = VP.colors();
    const [x0, x1] = domainX();
    const mode = st.get().mode;
    const rows = C.strikes.filter(r => r.k >= x0 && r.k <= x1);
    const vals = rows.flatMap(r => mode === 'net' ? [r.cg + r.pg] : mode === 'split' ? [r.cg, r.pg] : [r.co, -r.po]);
    let ymax = Math.max(0, ...vals), ymin = Math.min(0, ...vals);
    if (ymax === ymin) { ymax = 1; ymin = -1; }
    const pad = (ymax - ymin) * 0.08;
    const X = VP.scale(x0, x1, 4, w - RIGHT), Y = VP.scale(ymin - pad, ymax + pad, h - BOTTOM, TOP);
    const yt = VP.niceTicks(ymin - pad, ymax + pad, 5);
    D_.yAxis(g, yt, Y, w - RIGHT, w, mode === 'oi' ? v => fmt.big(Math.abs(v), 0) : v => fmt.usd(v, 1), c.faint, 'rgba(40,56,78,.35)');
    D_.xAxis(g, VP.niceTicks(x0, x1, 8), X, h - BOTTOM, v => fmtK(v), c.faint, 'rgba(40,56,78,.25)', TOP);
    D_.hline(g, 4, w - RIGHT, Y(0), '#3a4a60');
    let gap = Infinity;
    for (let i = 1; i < rows.length; i++) gap = Math.min(gap, X(rows[i].k) - X(rows[i - 1].k));
    const bw = Math.max(2, Math.min(26, (isFinite(gap) ? gap : 20) * 0.72));
    const bar = (k, v, col) => { const y = Y(Math.max(0, v)), y2 = Y(Math.min(0, v)); g.fillStyle = col; g.fillRect(X(k) - bw / 2, y, bw, Math.max(1, y2 - y)); };
    const hoverK = state.mouse ? nearestStrike(rows, X.invert(state.mouse.x)) : null;
    for (const r of rows) {
      const dim = hoverK != null && hoverK !== r.k ? 'cc' : 'ff';
      if (mode === 'net') { const v = r.cg + r.pg; bar(r.k, v, (v >= 0 ? COL.pos : COL.neg) + dim); }
      else if (mode === 'split') { bar(r.k, r.cg, COL.call + dim); bar(r.k, r.pg, COL.put + dim); }
      else { bar(r.k, r.co, COL.call + dim); bar(r.k, -r.po, '#a68cfa' + dim); }
    }
    // 现价、翻转价、看涨墙、看跌墙：竖线 + 顶部错开排列的标签
    markers(g, X, x0, x1, w, h, [
      [D.spot, '现价 ' + fmt.price(D.spot), c.amber, null, '#1a1205'],
      [C.flip, '翻转 ' + fk(Math.round(C.flip)), COL.flip, [5, 4], '#fff'],
      [C.callWall?.k, '看涨墙 ' + fk(C.callWall?.k), COL.call, [2, 3], '#04121e'],
      [C.putWall?.k, '看跌墙 ' + fk(C.putWall?.k), COL.put, [2, 3], '#1a0a04'],
    ]);
    if (!rows.length) D_.label(g, '这个范围里没有期权持仓', w / 2, h / 2, { color: c.faint, align: 'center' });
  }, {
    onHover(mx) {
      if (!C) return '';
      const [x0, x1] = domainX();
      const rows = C.strikes.filter(r => r.k >= x0 && r.k <= x1);
      if (!rows.length) return '';
      const X = VP.scale(x0, x1, 4, $('#gexChart').clientWidth - RIGHT);
      const k = nearestStrike(rows, X.invert(mx));
      const r = rows.find(x => x.k === k);
      if (!r) return '';
      return `<div><b>${fk(r.k)}</b> <span class="dim">（${((r.k / D.spot - 1) * 100).toFixed(1)}%）</span></div>`
        + `<div class="row"><span>净 GEX</span><b>${fmt.usd(r.cg + r.pg, 2)}</b></div>`
        + `<div class="row"><span>看涨 GEX</span><b>${fmt.usd(r.cg, 2)}</b></div><div class="row"><span>看跌 GEX</span><b>${fmt.usd(r.pg, 2)}</b></div>`
        + `<div class="row"><span>看涨持仓</span><b>${fmt.num(r.co, 1)} ${D.cur}</b></div><div class="row"><span>看跌持仓</span><b>${fmt.num(r.po, 1)} ${D.cur}</b></div>`;
    },
  });
  function markers(g, X, x0, x1, w, h, list) {
    let row = 0;
    for (const [v, text, col, dash, ink] of list) {
      if (!isFinite(v) || v <= x0 || v >= x1) continue;
      const x = X(v);
      D_.vline(g, x, TOP, h - BOTTOM, col, dash, dash ? 1.2 : 1.5);
      const tw = g.measureText(text).width;
      const right = x + 5 + tw + 8 > w - RIGHT;
      D_.label(g, text, right ? x - 5 : x + 5, TOP + 6 + row * 19, { color: ink, bg: col + (dash ? 'dd' : ''), align: right ? 'right' : 'left' });
      row++;
    }
  }
  function nearestStrike(rows, x) { let best = null; for (const r of rows) if (best === null || Math.abs(r.k - x) < Math.abs(best - x)) best = r.k; return best; }

  charts.profile = VP.plot($('#profileChart'), (g, w, h, state) => {
    if (!C) return;
    const c = VP.colors();
    const [x0, x1] = domainX();
    const pts = C.prof.filter(p => p.S >= x0 && p.S <= x1);
    if (!pts.length) return;
    let ymax = Math.max(0, ...pts.map(p => p.g)), ymin = Math.min(0, ...pts.map(p => p.g));
    const pad = (ymax - ymin) * 0.1 || 1;
    const X = VP.scale(x0, x1, 4, w - RIGHT), Y = VP.scale(ymin - pad, ymax + pad, h - BOTTOM, TOP);
    D_.yAxis(g, VP.niceTicks(ymin - pad, ymax + pad, 5), Y, w - RIGHT, w, v => fmt.usd(v, 1), c.faint, 'rgba(40,56,78,.35)');
    D_.xAxis(g, VP.niceTicks(x0, x1, 6), X, h - BOTTOM, v => fmtK(v), c.faint, null);
    const y0 = Y(0);
    // 正负两段分别填色
    for (const [sign, col] of [[1, COL.pos], [-1, COL.neg]]) {
      g.beginPath(); g.moveTo(X(pts[0].S), y0);
      for (const p of pts) g.lineTo(X(p.S), Y(sign > 0 ? Math.max(0, p.g) : Math.min(0, p.g)));
      g.lineTo(X(pts[pts.length - 1].S), y0); g.closePath();
      g.fillStyle = col + '33'; g.fill();
    }
    g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(X(p.S), Y(p.g)) : g.moveTo(X(p.S), Y(p.g))));
    g.strokeStyle = c.text; g.lineWidth = 1.5; g.stroke();
    D_.hline(g, 4, w - RIGHT, y0, '#3a4a60');
    D_.vline(g, X(D.spot), TOP, h - BOTTOM, c.amber, null, 1.5);
    if (isFinite(C.flip) && C.flip > x0 && C.flip < x1) {
      D_.vline(g, X(C.flip), TOP, h - BOTTOM, COL.flip, [5, 4], 1.5);
      D_.label(g, '翻转 ' + fk(Math.round(C.flip)), X(C.flip) + 5, TOP + 6, { color: '#fff', bg: 'rgba(166,140,250,.8)' });
    }
    D_.label(g, '正 Gamma', 10, TOP + 6, { color: COL.pos });
    D_.label(g, '负 Gamma', 10, h - BOTTOM - 10, { color: COL.neg });
    if (state.mouse) D_.vline(g, state.mouse.x, TOP, h - BOTTOM, '#566a86', [3, 3]);
  }, {
    onHover(mx) {
      if (!C) return '';
      const [x0, x1] = domainX();
      const X = VP.scale(x0, x1, 4, $('#profileChart').clientWidth - RIGHT);
      const S = X.invert(mx);
      const p = C.prof.reduce((a, b) => (Math.abs(b.S - S) < Math.abs(a.S - S) ? b : a));
      return `<div class="row"><span>价格</span><b>${fk(Math.round(p.S))}</b></div><div class="row"><span>总 GEX</span><b>${fmt.usd(p.g, 2)}</b></div>`;
    },
  });

  function smileExp() {
    const code = st.get().smile;
    return C.exps.find(e => e.code === code) || C.firstExp;
  }
  charts.smile = VP.plot($('#smileChart'), (g, w, h) => {
    if (!C) return;
    const c = VP.colors();
    const e = smileExp(); if (!e) return;
    const list = D.opts.filter(o => o.exp === e.exp && o.iv > 0);
    const span = Math.max(0.12, Math.min(0.6, 2.8 * (e.atmIv || 0.5) * Math.sqrt(Math.max(e.T, 1 / 365))));
    const x0 = e.F * (1 - span), x1 = e.F * (1 + span);
    const pts = list.filter(o => o.strike >= x0 && o.strike <= x1);
    if (!pts.length) return;
    const ivs = pts.map(o => o.iv * 100);
    const ymin = Math.min(...ivs) - 2, ymax = Math.max(...ivs) + 2;
    const X = VP.scale(x0, x1, 4, w - RIGHT), Y = VP.scale(ymin, ymax, h - BOTTOM, TOP);
    D_.yAxis(g, VP.niceTicks(ymin, ymax, 5), Y, w - RIGHT, w, v => v.toFixed(0) + '%', c.faint, 'rgba(40,56,78,.35)');
    D_.xAxis(g, VP.niceTicks(x0, x1, 6), X, h - BOTTOM, v => fmtK(v), c.faint, null);
    // 虚值期权连成的微笑曲线：远期价以下用看跌，以上用看涨
    const otm = pts.filter(o => (o.call ? o.strike >= e.F : o.strike < e.F)).sort((a, b) => a.strike - b.strike);
    g.beginPath(); otm.forEach((o, i) => (i ? g.lineTo(X(o.strike), Y(o.iv * 100)) : g.moveTo(X(o.strike), Y(o.iv * 100))));
    g.strokeStyle = c.text; g.lineWidth = 1.5; g.stroke();
    for (const o of pts) { g.fillStyle = (o.call ? COL.call : COL.put) + 'bb'; g.beginPath(); g.arc(X(o.strike), Y(o.iv * 100), 2.5, 0, Math.PI * 2); g.fill(); }
    D_.vline(g, X(e.F), TOP, h - BOTTOM, c.amber, [4, 3]);
    D_.label(g, '远期 ' + fk(Math.round(e.F)), X(e.F) + 5, TOP + 6, { color: c.amber });
    $('#lg-smile').innerHTML = `<span><i style="background:${COL.call}"></i>看涨</span><span><i style="background:${COL.put}"></i>看跌</span><span>ATM <b>${(e.atmIv * 100).toFixed(1)}%</b></span>`
      + (isFinite(e.rr) ? `<span>25Δ RR <b>${(e.rr * 100).toFixed(1)}</b></span>` : '');
  });

  charts.term = VP.plot($('#termChart'), (g, w, h, state) => {
    if (!C) return;
    const c = VP.colors();
    const rows = C.exps.filter(e => isFinite(e.atmIv));
    if (!rows.length) return;
    const ivs = rows.map(e => e.atmIv * 100);
    const rrs = rows.map(e => (isFinite(e.rr) ? e.rr * 100 : 0));
    const ymin = Math.min(...ivs) - 3, ymax = Math.max(...ivs) + 3;
    const rmax = Math.max(1, ...rrs.map(Math.abs));
    const X = i => 30 + (w - RIGHT - 50) * (rows.length === 1 ? 0.5 : i / (rows.length - 1));
    const Y = VP.scale(ymin, ymax, h - BOTTOM - 4, TOP + 4);
    const R = VP.scale(-rmax * 1.2, rmax * 1.2, h - BOTTOM - 4, TOP + 4);
    D_.yAxis(g, VP.niceTicks(ymin, ymax, 5), Y, w - RIGHT, w, v => v.toFixed(0) + '%', c.faint, 'rgba(40,56,78,.35)');
    D_.hline(g, 4, w - RIGHT, R(0), '#2b3b51', [2, 3]);
    const bw = Math.max(3, Math.min(16, (w - RIGHT - 50) / rows.length * 0.45));
    rows.forEach((e, i) => {
      const v = isFinite(e.rr) ? e.rr * 100 : 0;
      const y = R(Math.max(0, v)), y2 = R(Math.min(0, v));
      g.fillStyle = (v >= 0 ? COL.pos : COL.neg) + '77'; g.fillRect(X(i) - bw / 2, y, bw, Math.max(1, y2 - y));
    });
    g.beginPath(); rows.forEach((e, i) => (i ? g.lineTo(X(i), Y(e.atmIv * 100)) : g.moveTo(X(i), Y(e.atmIv * 100))));
    g.strokeStyle = c.amber; g.lineWidth = 2; g.stroke();
    rows.forEach((e, i) => { g.fillStyle = c.amber; g.beginPath(); g.arc(X(i), Y(e.atmIv * 100), 3, 0, Math.PI * 2); g.fill(); });
    g.save(); g.fillStyle = c.faint; g.textAlign = 'center';
    const every = Math.ceil(rows.length / Math.max(1, Math.floor((w - RIGHT) / 46)));
    rows.forEach((e, i) => { if (i % every === 0) g.fillText(expLabel(e.exp), X(i), h - BOTTOM + 11); });
    g.restore();
    if (state.mouse) {
      const i = Math.max(0, Math.min(rows.length - 1, Math.round((state.mouse.x - 30) / ((w - RIGHT - 50) / Math.max(1, rows.length - 1)))));
      D_.vline(g, X(i), TOP, h - BOTTOM, '#566a86', [3, 3]);
    }
    $('#lg-term').innerHTML = `<span><i style="background:${c.amber}"></i>ATM IV</span><span><i style="background:${COL.pos}"></i>25Δ RR</span>`;
  }, {
    onHover(mx) {
      if (!C) return '';
      const rows = C.exps.filter(e => isFinite(e.atmIv));
      const w = $('#termChart').clientWidth;
      const i = Math.max(0, Math.min(rows.length - 1, Math.round((mx - 30) / ((w - RIGHT - 50) / Math.max(1, rows.length - 1)))));
      const e = rows[i]; if (!e) return '';
      return `<div><b>${expLabel(e.exp)}</b> <span class="dim">剩 ${leftText(e.exp)}</span></div>`
        + `<div class="row"><span>ATM IV</span><b>${(e.atmIv * 100).toFixed(1)}%</b></div>`
        + `<div class="row"><span>25Δ RR</span><b>${isFinite(e.rr) ? (e.rr * 100).toFixed(1) : '—'}</b></div>`
        + `<div class="row"><span>25Δ 蝶式</span><b>${isFinite(e.bf) ? (e.bf * 100).toFixed(1) : '—'}</b></div>`
        + `<div class="row"><span>最大痛点</span><b>${fk(e.maxPain)}</b></div>`;
    },
  });

  charts.dvol = VP.plot($('#dvolChart'), (g, w, h, state) => {
    const dv = D && D.dvol;
    if (!dv || !dv.rows || dv.rows.length < 10) { D_.label(g, '暂时拿不到 DVOL 数据', w / 2, h / 2, { color: VP.colors().faint, align: 'center' }); return; }
    const c = VP.colors();
    const rows = dv.rows;
    const t0 = rows[0].t, t1 = rows[rows.length - 1].t;
    const lo = Math.min(dv.mean - 2.3 * dv.sd, ...rows.map(r => r.v)) - 1, hi = Math.max(dv.mean + 2.3 * dv.sd, ...rows.map(r => r.v)) + 1;
    const X = VP.scale(t0, t1, 4, w - RIGHT), Y = VP.scale(lo, hi, h - BOTTOM, TOP);
    // ±1σ / ±2σ 区间
    g.fillStyle = 'rgba(166,140,250,.07)'; g.fillRect(4, Y(dv.mean + 2 * dv.sd), w - RIGHT - 4, Y(dv.mean - 2 * dv.sd) - Y(dv.mean + 2 * dv.sd));
    g.fillStyle = 'rgba(166,140,250,.09)'; g.fillRect(4, Y(dv.mean + dv.sd), w - RIGHT - 4, Y(dv.mean - dv.sd) - Y(dv.mean + dv.sd));
    D_.yAxis(g, VP.niceTicks(lo, hi, 4), Y, w - RIGHT, w, v => v.toFixed(0), c.faint, 'rgba(40,56,78,.35)');
    const days = []; for (let t = Math.ceil(t0 / 86400e3) * 86400e3; t <= t1; t += 86400e3 * 5) days.push(t);
    D_.xAxis(g, days, X, h - BOTTOM, t => fmt.date(t), c.faint, null);
    D_.hline(g, 4, w - RIGHT, Y(dv.mean), 'rgba(166,140,250,.8)', [4, 3]);
    D_.label(g, '均值', 8, Y(dv.mean) - 8, { color: '#a68cfa' });
    D_.label(g, '+2σ', 8, Y(dv.mean + 2 * dv.sd) + 9, { color: c.faint });
    g.beginPath(); rows.forEach((r, i) => (i ? g.lineTo(X(r.t), Y(r.v)) : g.moveTo(X(r.t), Y(r.v))));
    g.strokeStyle = c.text; g.lineWidth = 1.4; g.stroke();
    // 超过 +2σ 的时段标成橙色
    g.fillStyle = '#ff6a3d';
    for (const r of rows) if (r.v > dv.mean + 2 * dv.sd) { g.beginPath(); g.arc(X(r.t), Y(r.v), 2, 0, Math.PI * 2); g.fill(); }
    if (state.mouse) D_.vline(g, state.mouse.x, TOP, h - BOTTOM, '#566a86', [3, 3]);
    const mood = dv.z >= 2 ? '恐慌：期权保护很贵' : dv.z >= 1 ? '偏紧张' : dv.z <= -1 ? '平静：期权便宜' : '正常';
    $('#lg-dvol').innerHTML = `<span>当前 <b>${dv.now.toFixed(1)}</b></span><span>24h <b>${dv.chg >= 0 ? '+' : ''}${dv.chg.toFixed(1)}</b></span>`
      + `<span>近 30 天 <b>${(dv.pct * 100).toFixed(0)}%</b> 分位</span><span>偏离均值 <b>${dv.z >= 0 ? '+' : ''}${dv.z.toFixed(1)}σ</b></span><span style="color:${dv.z >= 2 ? '#ff6a3d' : dv.z <= -1 ? '#45b7ff' : 'var(--text-dim)'}">${mood}</span>`;
  }, {
    onHover(mx) {
      const dv = D && D.dvol; if (!dv || !dv.rows) return '';
      const rows = dv.rows, w = $('#dvolChart').clientWidth;
      const X = VP.scale(rows[0].t, rows[rows.length - 1].t, 4, w - RIGHT);
      const t = X.invert(mx);
      const r = rows.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
      return `<div><b>${fmt.date(r.t)} ${fmt.time(r.t, false)}</b></div><div class="row"><span>DVOL</span><b>${r.v.toFixed(2)}</b></div><div class="row"><span>偏离均值</span><b>${((r.v - dv.mean) / dv.sd).toFixed(1)}σ</b></div>`;
    },
  });

  /* ------------------------------------------------------------ 控件 */
  function fillExpChoices() {
    const sel = $('#expOne');
    const cur = st.get().one;
    sel.innerHTML = D.exps.map(e => { const code = D.opts.find(o => o.exp === e).code; return `<option value="${code}">${expLabel(e)}（${leftText(e)}）</option>`; }).join('');
    if (cur && [...sel.options].some(o => o.value === cur)) sel.value = cur;
    else { st.set({ one: sel.value }); }
  }
  function fillSmileChoices() {
    const sel = $('#smileExp');
    const want = smileExp()?.code;
    sel.innerHTML = C.exps.map(e => `<option value="${e.code}">${expLabel(e.exp)}（${leftText(e.exp)}）</option>`).join('');
    if (want) sel.value = want;
  }
  function markControls() {
    const s = st.get();
    document.querySelectorAll('#cur button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === s.cur)));
    document.querySelectorAll('#expMode button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === s.exp)));
    document.querySelectorAll('#gexMode button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === s.mode)));
    document.querySelectorAll('#range button').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.v) === s.range)));
    $('#expOne').hidden = s.exp !== 'one';
  }
  const onSeg = (id, fn) => $(id).addEventListener('click', e => { const b = e.target.closest('button'); if (b) { fn(b.dataset.v); markControls(); } });
  onSeg('#cur', v => { if (v !== st.get().cur) { st.set({ cur: v, one: '', smile: '' }); D = null; C = null; setStatus('加载中…'); load(); } });
  onSeg('#expMode', v => { st.set({ exp: v }); if (D) compute(); });
  onSeg('#gexMode', v => { st.set({ mode: v }); charts.gex.redraw(); });
  onSeg('#range', v => { st.set({ range: Number(v) }); Object.values(charts).forEach(c => c.redraw()); });
  $('#expOne').addEventListener('change', e => { st.set({ one: e.target.value }); compute(); });
  $('#smileExp').addEventListener('change', e => { st.set({ smile: e.target.value }); charts.smile.redraw(); });
  $('#bigMin').addEventListener('change', e => { st.set({ bigMin: Number(e.target.value) }); renderTrades(); });
  $('#expTable tbody').addEventListener('click', e => {
    const tr = e.target.closest('tr[data-code]'); if (!tr) return;
    st.set({ exp: 'one', one: tr.dataset.code, smile: tr.dataset.code });
    $('#expOne').value = tr.dataset.code; markControls(); compute();
  });
  VP.onPrefs(() => { if (C) { renderTable(); renderTrades(); } });

  markControls();
  VP.every(60000, load);
})();
