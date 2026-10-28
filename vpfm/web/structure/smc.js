'use strict';
/* 结构分析的计算部分（纯函数，不碰页面）。
   - swings / bosChoch / fvg / orderBlocks / liquidity：改写自 smart-money-concepts（MIT，joshyattridge）；
   - cisd / po3 / stdv：按 Bandz Po3 Profiler、HTF SUITE 里的概念重写（C1 → C2 扫高/扫低收回 → C3 → C4，CISD = 收盘穿回反向连续 K 线起点的开盘价）；
   - bb / ema / vwap / rvwap / volumeProfile / sessions / prevLevels / smt：常用工具。
   K 线格式：{t(秒), o, h, l, c, v}，按时间升序。 */
(function (root) {
  const SMC = {};

  /* ---------------- 摆动高低点 ---------------- */
  SMC.swings = function (bars, L = 10) {
    const n = bars.length;
    const raw = [];
    for (let i = L; i < n - L; i++) {
      const h = bars[i].h, l = bars[i].l;
      let isH = true, isL = true;
      for (let k = i - L; k <= i + L && (isH || isL); k++) {
        if (k === i) continue;
        if (bars[k].h > h) isH = false;
        if (bars[k].l < l) isL = false;
      }
      if (isH) raw.push({ i, type: 1, level: h });
      else if (isL) raw.push({ i, type: -1, level: l });
    }
    // 连续同向的只留最极端的一个（高点留更高，低点留更低；相等留前一个）
    const out = [];
    for (const p of raw) {
      const top = out[out.length - 1];
      if (top && top.type === p.type) {
        if ((p.type === 1 && p.level > top.level) || (p.type === -1 && p.level < top.level)) out[out.length - 1] = p;
      } else out.push(p);
    }
    return out;
  };

  /* ---------------- BOS / CHoCH ---------------- */
  SMC.bosChoch = function (bars, sw, closeBreak = true) {
    const ev = [];
    for (let k = 3; k < sw.length; k++) {
      const [a, b, c, d] = [sw[k - 3], sw[k - 2], sw[k - 1], sw[k]];
      const T = [a.type, b.type, c.type, d.type].join(',');
      const L4 = a.level, L3 = b.level, L2 = c.level, L1 = d.level; // 对应 Python 里的 [-4] [-3] [-2] [-1]
      let kind = null, dir = 0;
      if (T === '-1,1,-1,1') {
        if (L4 < L2 && L2 < L3 && L3 < L1) { kind = 'BOS'; dir = 1; }
        else if (L1 > L3 && L3 > L4 && L4 > L2) { kind = 'CHoCH'; dir = 1; }
      } else if (T === '1,-1,1,-1') {
        if (L4 > L2 && L2 > L3 && L3 > L1) { kind = 'BOS'; dir = -1; }
        else if (L1 < L3 && L3 < L4 && L4 < L2) { kind = 'CHoCH'; dir = -1; }
      }
      if (kind) ev.push({ i: b.i, kind, dir, level: L3, broken: -1 });
    }
    for (const e of ev) {
      for (let j = e.i + 2; j < bars.length; j++) {
        const v = e.dir === 1 ? (closeBreak ? bars[j].c : bars[j].h) : (closeBreak ? bars[j].c : bars[j].l);
        if ((e.dir === 1 && v > e.level) || (e.dir === -1 && v < e.level)) { e.broken = j; break; }
      }
    }
    // 早先开始、却更晚才被突破的结构点作废（与原实现一致）；没被突破的去掉
    const keep = ev.filter(e => e.broken >= 0);
    return keep.filter(e => !keep.some(o => o !== e && e.i < o.i && e.broken >= o.broken));
  };

  /* ---------------- 公允价值缺口 FVG ---------------- */
  SMC.fvg = function (bars, { minSize = 0 } = {}) {
    const out = [];
    for (let i = 1; i < bars.length - 1; i++) {
      const p = bars[i - 1], c = bars[i], nx = bars[i + 1];
      let dir = 0, top, bottom;
      if (p.h < nx.l && c.c > c.o) { dir = 1; top = nx.l; bottom = p.h; }
      else if (p.l > nx.h && c.c < c.o) { dir = -1; top = p.l; bottom = nx.h; }
      if (!dir || top - bottom < minSize) continue;
      let mit = -1, filled = -1;
      for (let j = i + 2; j < bars.length; j++) {
        if (mit < 0 && (dir === 1 ? bars[j].l <= top : bars[j].h >= bottom)) mit = j;
        if (dir === 1 ? bars[j].l <= bottom : bars[j].h >= top) { filled = j; break; }
      }
      out.push({ i, dir, top, bottom, mitigated: mit, filled });
    }
    return out;
  };

  /* ---------------- 订单块 OB ---------------- */
  SMC.orderBlocks = function (bars, sw, closeMitigation = false) {
    const n = bars.length;
    const highsIdx = sw.filter(s => s.type === 1).map(s => s.i);
    const lowsIdx = sw.filter(s => s.type === -1).map(s => s.i);
    const lastBefore = (arr, i) => { let lo = 0, hi = arr.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m] < i) { r = arr[m]; lo = m + 1; } else hi = m - 1; } return r; };
    const blocks = [];
    for (const dir of [1, -1]) {
      const crossed = new Set();
      const active = [];
      for (let i = 0; i < n; i++) {
        const b = bars[i];
        for (const ob of active.slice()) {
          if (ob.breaker) {
            if (dir === 1 ? b.h > ob.top : b.l < ob.bottom) { ob.removed = i; active.splice(active.indexOf(ob), 1); }
          } else if (dir === 1
            ? (closeMitigation ? Math.min(b.o, b.c) : b.l) < ob.bottom
            : (closeMitigation ? Math.max(b.o, b.c) : b.h) > ob.top) {
            ob.breaker = true; ob.mitigated = dir === 1 ? i - 1 : i;
          }
        }
        const piv = lastBefore(dir === 1 ? highsIdx : lowsIdx, i);
        if (piv < 0 || crossed.has(piv)) continue;
        const brk = dir === 1 ? b.c > bars[piv].h : b.c < bars[piv].l;
        if (!brk) continue;
        crossed.add(piv);
        let idx = i - 1;
        if (i - piv > 1) {
          let best = piv + 1;
          for (let k = piv + 1; k < i; k++) {
            if (dir === 1 ? bars[k].l <= bars[best].l : bars[k].h >= bars[best].h) best = k;
          }
          idx = best;
        }
        if (idx < 0) continue;
        const v0 = bars[i].v || 0, v1 = bars[i - 1]?.v || 0, v2 = bars[i - 2]?.v || 0;
        const hiV = dir === 1 ? v0 + v1 : v2, loV = dir === 1 ? v2 : v0 + v1;
        const ob = {
          i: idx, dir, top: bars[idx].h, bottom: bars[idx].l, created: i, volume: v0 + v1 + v2,
          strength: Math.max(hiV, loV) ? Math.min(hiV, loV) / Math.max(hiV, loV) : 1, breaker: false, mitigated: -1, removed: -1,
        };
        blocks.push(ob); active.push(ob);
      }
    }
    return blocks.filter(b => b.removed < 0).sort((a, b) => a.i - b.i);
  };

  /* ---------------- 流动性（等高 / 等低） ---------------- */
  SMC.liquidity = function (bars, sw, rangePct = 0.01) {
    if (!bars.length) return [];
    let hi = -Infinity, lo = Infinity;
    for (const b of bars) { if (b.h > hi) hi = b.h; if (b.l < lo) lo = b.l; }
    const pip = (hi - lo) * rangePct;
    const out = [];
    for (const type of [1, -1]) {
      const pts = sw.filter(s => s.type === type).map(s => ({ ...s, used: false }));
      for (let a = 0; a < pts.length; a++) {
        const p = pts[a];
        if (p.used) continue;
        const rLo = p.level - pip, rHi = p.level + pip;
        let swept = -1;
        for (let j = p.i + 1; j < bars.length; j++) {
          if (type === 1 ? bars[j].h >= rHi : bars[j].l <= rLo) { swept = j; break; }
        }
        const group = [p];
        for (let b = a + 1; b < pts.length; b++) {
          const q = pts[b];
          if (swept >= 0 && q.i >= swept) break;
          if (!q.used && q.level >= rLo && q.level <= rHi) { group.push(q); q.used = true; }
        }
        if (group.length > 1) {
          out.push({ type, i: p.i, end: group[group.length - 1].i, level: group.reduce((s, x) => s + x.level, 0) / group.length, count: group.length, swept });
        }
      }
    }
    return out.sort((a, b) => a.i - b.i);
  };

  /* ---------------- CISD ---------------- */
  // 看涨 CISD：至少 minRun 根连续阴线之后，一根阳线收盘高于这段阴线第一根的开盘价（灵敏模式用最后一根）。看跌对称。
  SMC.cisd = function (bars, { minRun = 2, sensitive = false, maxAge = 60 } = {}) {
    const out = [];
    let bear = null, bull = null; // {first, last, start, len}
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const red = b.c < b.o, green = b.c > b.o;
      if (red) {
        if (bear && i > 0 && bars[i - 1].c < bars[i - 1].o) { bear.len++; bear.last = b.o; }
        else bear = { first: b.o, last: b.o, start: i, len: 1 };
      }
      if (green) {
        if (bull && i > 0 && bars[i - 1].c > bars[i - 1].o) { bull.len++; bull.last = b.o; }
        else bull = { first: b.o, last: b.o, start: i, len: 1 };
      }
      if (green && bear && bear.len >= minRun && i - bear.start <= maxAge) {
        const lvl = sensitive ? bear.last : bear.first;
        if (b.c > lvl) { out.push({ bull: true, start: bear.start, i, level: lvl }); bear = null; }
      }
      if (red && bull && bull.len >= minRun && i - bull.start <= maxAge) {
        const lvl = sensitive ? bull.last : bull.first;
        if (b.c < lvl) { out.push({ bull: false, start: bull.start, i, level: lvl }); bull = null; }
      }
    }
    // 被收盘反向穿回的 CISD 记为失效
    for (const c of out) {
      c.invalid = -1;
      for (let j = c.i + 1; j < bars.length; j++) {
        if (c.bull ? bars[j].c < c.level : bars[j].c > c.level) { c.invalid = j; break; }
      }
    }
    return out;
  };

  /* ---------------- PO3 序列（高周期 K 线） ---------------- */
  // side = 1 看涨（C2 扫了 C1 低点并收回 C1 区间内），-1 看跌（扫 C1 高点）。返回最新还"活着"的序列。
  SMC.po3 = function (htf) {
    const n = htf.length;
    const res = [];
    for (const side of [1, -1]) {
      for (let back = 0; back <= 2; back++) {
        const i2 = n - 1 - back;
        if (i2 < 1) break;
        const c1 = htf[i2 - 1], c2 = htf[i2];
        const live = i2 === n - 1;
        const openInside = c2.o <= c1.h && c2.o >= c1.l;
        const hiSw = c2.h > c1.h, loSw = c2.l < c1.l;
        const closedIn = c2.c < c1.h && c2.c > c1.l;
        const swept = side === -1 ? hiSw : loSw;
        if (!(openInside && swept && (live || closedIn))) continue;
        let alive = true;
        for (let j = i2 + 1; j < n; j++) {
          if (side === -1 && htf[j].h > c2.h) alive = false;
          if (side === 1 && htf[j].l < c2.l) alive = false;
        }
        if (!alive) continue;
        const c3 = htf[i2 + 1];
        const zone = (c, rangeOf, pct) => (c ? [c.c, c.c - side * (rangeOf.h - rangeOf.l) * pct] : null);
        res.push({
          side, i1: i2 - 1, i2, phase: back + 2, closedIn, twoSided: side === -1 ? loSw : hiSw,
          c1, c2, extreme: side === -1 ? c2.h : c2.l,
          tspot3: closedIn ? zone(c2, c2, 0.5) : null,     // C3 目标区：C2 收盘回到 C2 区间 50%
          tspot4: c3 && back >= 2 ? zone(c3, c3, 0.25) : null, // C4 目标区：C3 收完后，收盘回到 C3 区间 25%
        });
        break;
      }
    }
    return res.sort((a, b) => b.i2 - a.i2);
  };

  /** STDV 投射：level = CISD + d × (CISD − C2 极值)，d 取 2、2.5、4、4.5（顺着交易方向） */
  SMC.stdv = function (cisdLevel, c2Extreme, ds = [2, 2.5, 4, 4.5]) {
    return ds.map(d => ({ d, price: cisdLevel + d * (cisdLevel - c2Extreme) }));
  };

  /* ---------------- 常用指标 ---------------- */
  SMC.ema = function (vals, len) {
    const out = new Array(vals.length).fill(NaN);
    const k = 2 / (len + 1);
    let e = NaN;
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i];
      if (!isFinite(v)) continue;
      e = isFinite(e) ? e + k * (v - e) : v;
      if (i >= len - 1) out[i] = e;
    }
    return out;
  };

  SMC.bb = function (closes, len = 20, mult = 2) {
    const n = closes.length;
    const mid = new Array(n).fill(NaN), up = new Array(n).fill(NaN), dn = new Array(n).fill(NaN);
    let s = 0, s2 = 0;
    for (let i = 0; i < n; i++) {
      s += closes[i]; s2 += closes[i] * closes[i];
      if (i >= len) { s -= closes[i - len]; s2 -= closes[i - len] * closes[i - len]; }
      if (i >= len - 1) {
        const m = s / len, sd = Math.sqrt(Math.max(0, s2 / len - m * m));
        mid[i] = m; up[i] = m + mult * sd; dn[i] = m - mult * sd;
      }
    }
    return { mid, up, dn };
  };

  /** 锚定 VWAP：periodKey(t) 变化时重新开始累计；返回 vwap 与 1 倍标准差 */
  SMC.vwap = function (bars, periodKey) {
    const n = bars.length;
    const vw = new Array(n).fill(NaN), sd = new Array(n).fill(NaN);
    let key = null, pv = 0, v = 0, p2v = 0;
    for (let i = 0; i < n; i++) {
      const b = bars[i];
      const k = periodKey(b.t);
      if (k !== key) { key = k; pv = 0; v = 0; p2v = 0; }
      const tp = (b.h + b.l + b.c) / 3, vol = b.v || 0;
      pv += tp * vol; v += vol; p2v += tp * tp * vol;
      if (v > 0) { const m = pv / v; vw[i] = m; sd[i] = Math.sqrt(Math.max(0, p2v / v - m * m)); }
    }
    return { vw, sd };
  };

  /** 滚动 VWAP：用日线算最近 N 天的成交量加权均价，返回 {t(当天 0 点), value} */
  SMC.rvwap = function (daily, N) {
    const out = [];
    let pv = 0, v = 0;
    for (let i = 0; i < daily.length; i++) {
      const b = daily[i], tp = (b.h + b.l + b.c) / 3;
      pv += tp * b.v; v += b.v;
      if (i >= N) { const o = daily[i - N]; pv -= (o.h + o.l + o.c) / 3 * o.v; v -= o.v; }
      if (i >= N - 1 && v > 0) out.push({ t: b.t, value: pv / v });
    }
    return out;
  };

  SMC.atr = function (bars, len = 14) {
    let s = 0, k = 0;
    for (let i = Math.max(1, bars.length - len * 4); i < bars.length; i++) {
      const b = bars[i], p = bars[i - 1];
      s += Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c)); k++;
    }
    return k ? s / k : 0;
  };

  /** 成交量分布：把每根 K 线的成交量均匀摊到它的高低区间里 */
  SMC.volumeProfile = function (bars, i0, i1, bins = 60) {
    let lo = Infinity, hi = -Infinity;
    for (let i = i0; i <= i1; i++) { if (bars[i].l < lo) lo = bars[i].l; if (bars[i].h > hi) hi = bars[i].h; }
    if (!(hi > lo)) return null;
    const step = (hi - lo) / bins;
    const vol = new Array(bins).fill(0), buy = new Array(bins).fill(0);
    for (let i = i0; i <= i1; i++) {
      const b = bars[i];
      const a = Math.max(0, Math.floor((b.l - lo) / step)), z = Math.min(bins - 1, Math.floor((b.h - lo) / step));
      const share = (b.v || 0) / (z - a + 1);
      const up = b.c >= b.o;
      for (let k = a; k <= z; k++) { vol[k] += share; if (up) buy[k] += share; }
    }
    let poc = 0;
    for (let k = 1; k < bins; k++) if (vol[k] > vol[poc]) poc = k;
    const total = vol.reduce((s, x) => s + x, 0);
    let a = poc, z = poc, acc = vol[poc];
    while (acc < total * 0.7 && (a > 0 || z < bins - 1)) {
      const below = a > 0 ? vol[a - 1] : -1, above = z < bins - 1 ? vol[z + 1] : -1;
      if (above >= below) { z++; acc += vol[z]; } else { a--; acc += vol[a]; }
    }
    const mid = k => lo + (k + 0.5) * step;
    return { lo, hi, step, vol, buy, poc: mid(poc), vah: lo + (z + 1) * step, val: lo + a * step, max: vol[poc] };
  };

  /* ---------------- 时段、前高前低 ---------------- */
  const nyParts = (() => {
    let f = null;
    try { f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { f = null; }
    return t => {
      if (!f) { const d = new Date((t - 4 * 3600) * 1000); return { day: d.toISOString().slice(0, 10), hour: d.getUTCHours() + d.getUTCMinutes() / 60 }; }
      const p = {}; for (const x of f.formatToParts(new Date(t * 1000))) p[x.type] = x.value;
      return { day: `${p.year}-${p.month}-${p.day}`, hour: (Number(p.hour) % 24) + Number(p.minute) / 60 };
    };
  })();
  SMC.nyParts = nyParts;

  /** 交易时段（纽约时间）：亚洲 18–02、伦敦 02–08、纽约上午 08–12、纽约下午 12–16 */
  SMC.SESSIONS = [
    { id: 'asia', name: '亚洲', from: 18, to: 2 },
    { id: 'london', name: '伦敦', from: 2, to: 8 },
    { id: 'nyam', name: '纽约上午', from: 8, to: 12 },
    { id: 'nypm', name: '纽约下午', from: 12, to: 16 },
  ];
  SMC.sessions = function (bars) {
    const out = [];
    let cur = null;
    for (let i = 0; i < bars.length; i++) {
      const { hour } = nyParts(bars[i].t);
      const s = SMC.SESSIONS.find(x => (x.from < x.to ? hour >= x.from && hour < x.to : hour >= x.from || hour < x.to));
      if (cur && (!s || s.id !== cur.id || i - cur.end > 1)) { out.push(cur); cur = null; }
      if (s) {
        if (!cur) cur = { id: s.id, name: s.name, start: i, end: i, hi: bars[i].h, lo: bars[i].l };
        else { cur.end = i; cur.hi = Math.max(cur.hi, bars[i].h); cur.lo = Math.min(cur.lo, bars[i].l); }
      }
    }
    if (cur) out.push(cur);
    return out;
  };

  /** 上一个周期（日/周，按 UTC）的高低点与本周期开盘价 */
  SMC.prevLevels = function (bars, period) {
    const key = t => (period === 'W' ? Math.floor((t / 86400 + 3) / 7) : Math.floor(t / 86400)); // 周一为一周开始
    const groups = new Map();
    for (const b of bars) {
      const k = key(b.t);
      const g = groups.get(k);
      if (!g) groups.set(k, { k, o: b.o, h: b.h, l: b.l, t: b.t });
      else { if (b.h > g.h) g.h = b.h; if (b.l < g.l) g.l = b.l; }
    }
    const list = [...groups.values()].sort((a, b) => a.k - b.k);
    if (list.length < 2) return null;
    const cur = list[list.length - 1], prev = list[list.length - 2];
    return { prevHigh: prev.h, prevLow: prev.l, open: cur.o, start: cur.t, prevStart: prev.t };
  };

  /* ---------------- SMT 背离 ---------------- */
  // 本币和对比币各自的最近两个摆动高点（或低点）：一个创新高、另一个没有，就是 SMT。
  SMC.smt = function (barsA, barsB, L = 5) {
    const mapB = new Map(barsB.map((b, i) => [b.t, i]));
    const swA = SMC.swings(barsA, L);
    const out = [];
    const extremeB = (i, type) => {
      const t0 = barsA[Math.max(0, i - L)].t, t1 = barsA[Math.min(barsA.length - 1, i + L)].t;
      let best = null;
      for (let t = t0; t <= t1; t += barsA[1].t - barsA[0].t) {
        const j = mapB.get(t); if (j == null) continue;
        const v = type === 1 ? barsB[j].h : barsB[j].l;
        if (best === null || (type === 1 ? v > best : v < best)) best = v;
      }
      return best;
    };
    for (const type of [1, -1]) {
      const pts = swA.filter(s => s.type === type).slice(-4);
      for (let k = 1; k < pts.length; k++) {
        const p1 = pts[k - 1], p2 = pts[k];
        const b1 = extremeB(p1.i, type), b2 = extremeB(p2.i, type);
        if (b1 == null || b2 == null) continue;
        const aUp = p2.level > p1.level, bUp = b2 > b1;
        if (type === 1 && aUp !== bUp) out.push({ type: -1, i1: p1.i, i2: p2.i, l1: p1.level, l2: p2.level, leader: aUp ? 'A' : 'B' });
        if (type === -1 && aUp !== bUp) out.push({ type: 1, i1: p1.i, i2: p2.i, l1: p1.level, l2: p2.level, leader: !aUp ? 'A' : 'B' });
      }
    }
    return out.sort((a, b) => a.i2 - b.i2);
  };

  /* ---------------- 高周期 K 线聚合 ---------------- */
  SMC.aggregate = function (bars, sec) {
    const out = [];
    for (const b of bars) {
      const t = Math.floor(b.t / sec) * sec;
      const last = out[out.length - 1];
      if (last && last.t === t) { last.h = Math.max(last.h, b.h); last.l = Math.min(last.l, b.l); last.c = b.c; last.v += b.v || 0; }
      else out.push({ t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 });
    }
    return out;
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = SMC;
  else root.SMC = SMC;
})(typeof window !== 'undefined' ? window : globalThis);
