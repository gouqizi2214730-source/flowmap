'use strict';
/* VPFM 自研模块共用代码：
   - VP.get / VP.post：经本地服务转发访问交易所公开接口（不跨域、走代理），带去重、短缓存和重试；
   - VP.fmt：中文习惯的数字格式（亿 / 万）；
   - VP.ex：各交易所接口的统一封装（币安、Bybit、OKX、Bitget、Hyperliquid、Deribit）；
   - VP.prefs / VP.store / VP.toast / VP.colors 等小工具。 */
(function () {
  const VP = (window.VP = {});
  const PROXY = '/api/wb/proxy/';

  /* ------------------------------------------------------------ 请求 */
  const inflight = new Map();
  const cache = new Map();
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  class FetchError extends Error {
    constructor(msg, status) { super(msg); this.status = status; }
  }
  VP.FetchError = FetchError;

  async function once(url, { method = 'GET', body, timeout = 15000 }) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(PROXY + url, {
        method, signal: ctl.signal, cache: 'no-store',
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await r.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { /* 不是 JSON */ }
      if (!r.ok) {
        const host = new URL(url).hostname;
        const msg = data?.error?.message || data?.msg || data?.retMsg || data?.message || text.slice(0, 120) || '';
        throw new FetchError(`${host} 返回 ${r.status}${msg ? '：' + msg : ''}`, r.status);
      }
      if (data === null) throw new FetchError(`${new URL(url).hostname} 返回的不是 JSON`, 0);
      return data;
    } catch (e) {
      if (e.name === 'AbortError') throw new FetchError(`${new URL(url).hostname} 超时`, 0);
      if (e instanceof FetchError) throw e;
      throw new FetchError(`连不上本地服务：${e.message}`, 0);
    } finally { clearTimeout(timer); }
  }

  VP.request = async function (url, opts = {}) {
    const { ttl = 0, retries = 1, method = 'GET', body } = opts;
    const key = method + ' ' + url + (body ? ' ' + JSON.stringify(body) : '');
    if (ttl > 0) {
      const c = cache.get(key);
      if (c && Date.now() - c.t < ttl) return c.data;
    }
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      let last;
      for (let i = 0; i <= retries; i++) {
        try {
          const data = await once(url, opts);
          if (ttl > 0) cache.set(key, { t: Date.now(), data });
          return data;
        } catch (e) {
          last = e;
          const retry = e.status === 0 || e.status === 429 || e.status >= 500;
          if (!retry || i === retries) break;
          await sleep(e.status === 429 ? 2500 : 700 * (i + 1));
        }
      }
      throw last;
    })();
    inflight.set(key, p);
    try { return await p; } finally { inflight.delete(key); }
  };
  VP.get = (url, opts) => VP.request(url, opts);
  VP.post = (url, body, opts = {}) => VP.request(url, { ...opts, method: 'POST', body });

  /** 并发受限地跑一组任务，返回 [{ok, value|error}] */
  VP.pool = async function (items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    async function worker() {
      while (next < items.length) {
        const i = next++;
        try { out[i] = { ok: true, value: await fn(items[i], i) }; } catch (error) { out[i] = { ok: false, error }; }
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
  };

  /* ------------------------------------------------------------ 格式 */
  const nf = (d) => new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const NF = Array.from({ length: 9 }, (_, d) => nf(d));
  const fixed = (v, d) => NF[Math.max(0, Math.min(8, d))].format(v);

  VP.fmt = {
    /** 金额：1.23亿 / 4,567万 / 9,876 */
    big(v, d = 2) {
      if (v == null || !isFinite(v)) return '—';
      const a = Math.abs(v), s = v < 0 ? '-' : '';
      if (a >= 1e12) return s + fixed(a / 1e12, d) + '万亿';
      if (a >= 1e8) return s + fixed(a / 1e8, d) + '亿';
      if (a >= 1e4) return s + fixed(a / 1e4, a >= 1e6 ? 0 : 1) + '万';
      return s + fixed(a, a >= 100 ? 0 : 2);
    },
    usd(v, d = 2) { return v == null || !isFinite(v) ? '—' : (v < 0 ? '-$' : '$') + VP.fmt.big(Math.abs(v), d); },
    /** 价格：按数量级自动取小数位 */
    price(v) {
      if (v == null || !isFinite(v)) return '—';
      const a = Math.abs(v);
      const d = a >= 10000 ? 1 : a >= 1000 ? 2 : a >= 10 ? 3 : a >= 1 ? 4 : a >= 0.01 ? 5 : a >= 0.0001 ? 7 : 8;
      return fixed(v, d);
    },
    num(v, d = 2) { return v == null || !isFinite(v) ? '—' : fixed(v, d); },
    pct(v, d = 2, sign = true) {
      if (v == null || !isFinite(v)) return '—';
      return (sign && v > 0 ? '+' : '') + fixed(v * 100, d) + '%';
    },
    /** 资金费率：万分之几更直观，统一显示百分比四位小数 */
    rate(v) { return v == null || !isFinite(v) ? '—' : (v > 0 ? '+' : '') + fixed(v * 100, 4) + '%'; },
    time(ts, sec = true) {
      const d = new Date(ts);
      const p = n => String(n).padStart(2, '0');
      return `${p(d.getHours())}:${p(d.getMinutes())}${sec ? ':' + p(d.getSeconds()) : ''}`;
    },
    date(ts) { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()}`; },
    ago(ts) {
      const s = Math.max(0, (Date.now() - ts) / 1000);
      if (s < 60) return `${Math.round(s)} 秒前`;
      if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
      if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
      return `${Math.round(s / 86400)} 天前`;
    },
    /** 倒计时：剩余毫秒 → 3:12:05 */
    countdown(ms) {
      if (!(ms > 0)) return '—';
      const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
      return `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`;
    },
  };

  /* ------------------------------------------------------------ 偏好与存储 */
  const PREFS_KEY = 'vpfm.prefs';
  VP.prefs = function () {
    try { return Object.assign({ updown: 'green-up' }, JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')); } catch { return { updown: 'green-up' }; }
  };
  const prefListeners = [];
  VP.onPrefs = fn => prefListeners.push(fn);
  function applyPrefs() {
    const p = VP.prefs();
    if (p.updown === 'red-up') document.documentElement.dataset.updown = 'red-up';
    else delete document.documentElement.dataset.updown;
    prefListeners.forEach(fn => { try { fn(p); } catch (e) { console.error(e); } });
  }
  window.addEventListener('storage', e => { if (e.key === PREFS_KEY) applyPrefs(); });
  window.addEventListener('vpfm-prefs', applyPrefs);
  applyPrefs();

  VP.store = function (name, defaults) {
    const key = 'vpfm.' + name;
    let v;
    try { v = Object.assign({}, defaults, JSON.parse(localStorage.getItem(key) || '{}')); } catch { v = Object.assign({}, defaults); }
    return {
      get: () => v,
      set(patch) { Object.assign(v, patch); try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* 忽略 */ } return v; },
    };
  };

  /** 当前主题颜色（随涨跌颜色设置变化） */
  VP.colors = function () {
    const cs = getComputedStyle(document.documentElement);
    const g = n => cs.getPropertyValue(n).trim();
    return {
      up: g('--up'), down: g('--down'), upSoft: g('--up-soft'), downSoft: g('--down-soft'),
      amber: g('--amber'), cyan: g('--cyan'), violet: g('--violet'), text: g('--text'), dim: g('--text-dim'),
      faint: g('--text-faint'), line: g('--line'), bg: g('--bg'),
    };
  };
  /** 交易所固定配色（图例里一眼认出） */
  VP.EX_COLORS = { binance: '#f0b90b', bybit: '#f7a600', okx: '#c9d1dc', bitget: '#1ec7c7', hyperliquid: '#5ee6c2', deribit: '#2f7bf2' };
  VP.EX_COLORS.bybit = '#ff8a3d';
  VP.EX_NAMES = { binance: '币安', bybit: 'Bybit', okx: 'OKX', bitget: 'Bitget', hyperliquid: 'Hyperliquid', deribit: 'Deribit' };

  let toastTimer = 0;
  VP.toast = function (msg, bad = false) {
    try { if (window.parent !== window && window.parent.vpfm) { window.parent.vpfm.toast(msg, bad); return; } } catch { /* 单独打开时自己显示 */ }
    let t = document.getElementById('vp-toast');
    if (!t) { t = document.createElement('div'); t.id = 'vp-toast'; t.className = 'vp-toast'; t.setAttribute('role', 'status'); document.body.append(t); }
    t.textContent = msg; t.classList.toggle('bad', bad); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
  };

  /** 模块是否在前台：外壳切走时会发 vpfm-visible 事件（iframe 被隐藏不会触发 document.hidden） */
  VP.active = true;
  const visListeners = new Set();
  window.addEventListener('vpfm-visible', e => {
    const was = VP.active;
    VP.active = !!e.detail;
    if (VP.active !== was) visListeners.forEach(fn => { try { fn(VP.active); } catch (err) { console.error(err); } });
  });
  document.addEventListener('visibilitychange', () => visListeners.forEach(fn => { try { fn(!document.hidden && VP.active); } catch (err) { console.error(err); } }));
  VP.isVisible = () => !document.hidden && VP.active;
  VP.onVisible = fn => visListeners.add(fn);

  /** 定时刷新：模块不在前台时暂停，回到前台时如果已经过期立即补一次 */
  VP.every = function (ms, fn, { immediate = true } = {}) {
    let timer = 0, last = 0, stopped = false;
    const run = async () => {
      if (stopped) return;
      clearTimeout(timer);
      if (!VP.isVisible()) { timer = setTimeout(run, 1000); return; }
      last = Date.now();
      try { await fn(); } catch (e) { console.error(e); }
      if (!stopped) timer = setTimeout(run, ms);
    };
    visListeners.add(vis => { if (vis && !stopped && Date.now() - last > ms) run(); });
    if (immediate) run(); else timer = setTimeout(run, ms);
    return { stop() { stopped = true; clearTimeout(timer); }, now: run };
  };

  /* ------------------------------------------------------------ 交易所 */
  const n = x => (x === null || x === undefined || x === '' ? NaN : Number(x));
  VP.n = n;

  /** 去掉 1000/10000/1M 之类倍数前缀，返回 [币种, 倍数] */
  VP.baseOf = function (raw) {
    let s = String(raw).toUpperCase();
    let mult = 1;
    let m = /^(1000000|100000|10000|1000|100)(?=[A-Z])/.exec(s);
    if (m) { mult = Number(m[1]); s = s.slice(m[1].length); }
    else if ((m = /^1M(?=[A-Z])/.exec(s))) { mult = 1e6; s = s.slice(2); }
    else if ((m = /^([A-Z0-9]+?)(1000)$/.exec(s)) && m[1].length >= 2) { mult = 1000; s = m[1]; }
    return [s, mult];
  };

  const TF = {
    '1m': { sec: 60, bn: '1m', by: '1', ok: '1m', byOi: '5min', okRubik: '5m', bnOi: '5m', hl: '1m' },
    '5m': { sec: 300, bn: '5m', by: '5', ok: '5m', byOi: '5min', okRubik: '5m', bnOi: '5m', hl: '5m' },
    '15m': { sec: 900, bn: '15m', by: '15', ok: '15m', byOi: '15min', okRubik: '5m', bnOi: '15m', hl: '15m' },
    '1h': { sec: 3600, bn: '1h', by: '60', ok: '1H', byOi: '1h', okRubik: '1H', bnOi: '1h', hl: '1h' },
    '4h': { sec: 14400, bn: '4h', by: '240', ok: '4H', byOi: '4h', okRubik: '1H', bnOi: '4h', hl: '4h' },
    '1d': { sec: 86400, bn: '1d', by: 'D', ok: '1Dutc', byOi: '1d', okRubik: '1D', bnOi: '1d', hl: '1d' },
    '1w': { sec: 604800, bn: '1w', by: 'W', ok: '1Wutc', byOi: '1d', okRubik: '1D', bnOi: '1d', hl: '1w' },
    '1M': { sec: 2592000, bn: '1M', by: 'M', ok: '1Mutc', byOi: '1d', okRubik: '1D', bnOi: '1d', hl: '1M' },
  };
  VP.TF_NAME = { '1m': '1分钟', '5m': '5分钟', '15m': '15分钟', '1h': '1小时', '4h': '4小时', '1d': '日线', '1w': '周线', '1M': '月线' };
  VP.TF = TF;

  const BN = 'https://fapi.binance.com', BNS = 'https://api.binance.com', BY = 'https://api.bybit.com',
    OK = 'https://www.okx.com', BG = 'https://api.bitget.com', HL = 'https://api.hyperliquid.xyz/info',
    DB = 'https://www.deribit.com/api/v2/public';

  const bybitOk = j => { if (j.retCode !== 0) throw new FetchError('Bybit：' + j.retMsg, 0); return j.result; };
  const okxOk = j => { if (j.code !== '0') throw new FetchError('OKX：' + (j.msg || j.code), 0); return j.data; };
  const bitgetOk = j => { if (j.code !== '00000') throw new FetchError('Bitget：' + (j.msg || j.code), 0); return j.data; };
  const deribitOk = j => { if (j.error) throw new FetchError('Deribit：' + j.error.message, 0); return j.result; };
  // OKX 统计接口的周期：界面周期换成 5m / 1H / 1D，本来就是这三个的原样用
  const okPeriod = p => (TF[p] && TF[p].okRubik) || p;
  /** Bybit 列表接口按 nextPageCursor 往前翻页，凑够 want 条或没有更多为止（最多 6 页）。
      返回的游标已经是 URL 编码过的，和官方 SDK 一样原样放回查询串 */
  async function bybitPaged(url, pageSize, want) {
    let out = [], cursor = '';
    for (let page = 0; page < 6 && out.length < want; page++) {
      const r = bybitOk(await VP.get(`${url}&limit=${Math.min(pageSize, want - out.length)}${cursor ? '&cursor=' + cursor : ''}`, { ttl: 30000 }));
      out = out.concat(r.list || []);
      cursor = r.nextPageCursor;
      if (!cursor || !(r.list || []).length) break;
    }
    return out;
  }

  /** K 线统一成 {t(秒), o, h, l, c, v(币), qv(计价币), tb(主动买入量，币)} */
  const bnKline = k => ({ t: k[0] / 1000, o: n(k[1]), h: n(k[2]), l: n(k[3]), c: n(k[4]), v: n(k[5]), qv: n(k[7]), tb: n(k[9]) });

  VP.ex = {
    binance: {
      sym: base => base + 'USDT',
      async klines(sym, tf, limit = 500, { spot = false, endTime } = {}) {
        const host = spot ? BNS + '/api/v3/klines' : BN + '/fapi/v1/klines';
        const url = `${host}?symbol=${sym}&interval=${TF[tf].bn}&limit=${limit}${endTime ? '&endTime=' + endTime : ''}`;
        return (await VP.get(url, { ttl: 5000 })).map(bnKline);
      },
      /** 往前翻页拿更多 K 线（最多 maxBars 根） */
      async klinesDeep(sym, tf, maxBars, opts = {}) {
        let out = await this.klines(sym, tf, Math.min(1500, maxBars), opts);
        while (out.length && out.length < maxBars) {
          const end = out[0].t * 1000 - 1;
          const more = await this.klines(sym, tf, Math.min(1500, maxBars - out.length), { ...opts, endTime: end });
          if (!more.length) break;
          out = more.concat(out);
        }
        return out;
      },
      premiumAll: () => VP.get(BN + '/fapi/v1/premiumIndex', { ttl: 8000 }),
      premium: sym => VP.get(BN + '/fapi/v1/premiumIndex?symbol=' + sym, { ttl: 4000 }),
      fundingInfo: () => VP.get(BN + '/fapi/v1/fundingInfo', { ttl: 3600e3 }),
      ticker24: sym => VP.get(BN + '/fapi/v1/ticker/24hr' + (sym ? '?symbol=' + sym : ''), { ttl: sym ? 4000 : 15000 }),
      openInterest: sym => VP.get(BN + '/fapi/v1/openInterest?symbol=' + sym, { ttl: 8000 }),
      // /futures/data 系列：每次最多 500 条，只保留最近 30 天；end（毫秒）用来往前翻页
      oiHist: (sym, tf, limit = 500, end) => VP.get(`${BN}/futures/data/openInterestHist?symbol=${sym}&period=${TF[tf].bnOi}&limit=${limit}${end ? '&endTime=' + end : ''}`, { ttl: 30000 }),
      fundingHist: (sym, limit = 200) => VP.get(`${BN}/fapi/v1/fundingRate?symbol=${sym}&limit=${limit}`, { ttl: 60000 }),
      lsAccounts: (sym, tf, limit = 500, end) => VP.get(`${BN}/futures/data/globalLongShortAccountRatio?symbol=${sym}&period=${TF[tf].bnOi}&limit=${limit}${end ? '&endTime=' + end : ''}`, { ttl: 30000 }),
      lsTopPos: (sym, tf, limit = 500, end) => VP.get(`${BN}/futures/data/topLongShortPositionRatio?symbol=${sym}&period=${TF[tf].bnOi}&limit=${limit}${end ? '&endTime=' + end : ''}`, { ttl: 30000 }),
      taker: (sym, tf, limit = 500, end) => VP.get(`${BN}/futures/data/takerlongshortRatio?symbol=${sym}&period=${TF[tf].bnOi}&limit=${limit}${end ? '&endTime=' + end : ''}`, { ttl: 30000 }),
    },
    bybit: {
      sym: base => base + 'USDT',
      async klines(sym, tf, limit = 500) {
        const r = bybitOk(await VP.get(`${BY}/v5/market/kline?category=linear&symbol=${sym}&interval=${TF[tf].by}&limit=${Math.min(1000, limit)}`, { ttl: 5000 }));
        return r.list.map(k => ({ t: n(k[0]) / 1000, o: n(k[1]), h: n(k[2]), l: n(k[3]), c: n(k[4]), v: n(k[5]), qv: n(k[6]) })).reverse();
      },
      async tickers(sym) {
        return bybitOk(await VP.get(`${BY}/v5/market/tickers?category=linear${sym ? '&symbol=' + sym : ''}`, { ttl: sym ? 4000 : 15000 })).list;
      },
      // 持仓历史：每页最多 200 条，按游标往前翻，直到凑够 want 条
      async oiHist(sym, tf, want = 200) {
        const rows = await bybitPaged(`${BY}/v5/market/open-interest?category=linear&symbol=${sym}&intervalTime=${TF[tf].byOi}`, 200, want);
        return rows.map(x => ({ t: n(x.timestamp) / 1000, oi: n(x.singleOpenInterest ?? x.openInterest) })).sort((a, b) => a.t - b.t);
      },
      async fundingHist(sym, limit = 200) {
        return bybitOk(await VP.get(`${BY}/v5/market/funding/history?category=linear&symbol=${sym}&limit=${limit}`, { ttl: 60000 })).list
          .map(x => ({ t: n(x.fundingRateTimestamp) / 1000, rate: n(x.fundingRate) })).reverse();
      },
      async lsAccounts(sym, tf, want = 500) {
        const period = { '1m': '5min', '5m': '5min', '15m': '15min', '1h': '1h', '4h': '4h', '1d': '1d', '1w': '1d', '1M': '1d' }[tf];
        const rows = await bybitPaged(`${BY}/v5/market/account-ratio?category=linear&symbol=${sym}&period=${period}`, 500, want);
        return rows.map(x => ({ t: n(x.timestamp) / 1000, long: n(x.buyRatio), short: n(x.sellRatio) })).sort((a, b) => a.t - b.t);
      },
    },
    okx: {
      inst: base => base + '-USDT-SWAP',
      async klines(inst, tf, limit = 300) {
        const d = okxOk(await VP.get(`${OK}/api/v5/market/candles?instId=${inst}&bar=${TF[tf].ok}&limit=${Math.min(300, limit)}`, { ttl: 5000 }));
        return d.map(k => ({ t: n(k[0]) / 1000, o: n(k[1]), h: n(k[2]), l: n(k[3]), c: n(k[4]), v: n(k[6]), qv: n(k[7]) })).reverse();
      },
      tickers: async () => okxOk(await VP.get(`${OK}/api/v5/market/tickers?instType=SWAP`, { ttl: 15000 })),
      ticker: async inst => okxOk(await VP.get(`${OK}/api/v5/market/ticker?instId=${inst}`, { ttl: 4000 }))[0],
      oiAll: async () => okxOk(await VP.get(`${OK}/api/v5/public/open-interest?instType=SWAP`, { ttl: 15000 })),
      oi: async inst => okxOk(await VP.get(`${OK}/api/v5/public/open-interest?instType=SWAP&instId=${inst}`, { ttl: 8000 }))[0],
      funding: async inst => okxOk(await VP.get(`${OK}/api/v5/public/funding-rate?instId=${inst}`, { ttl: 30000 }))[0],
      async fundingHist(inst, limit = 100) {
        return okxOk(await VP.get(`${OK}/api/v5/public/funding-rate-history?instId=${inst}&limit=${limit}`, { ttl: 60000 }))
          .map(x => ({ t: n(x.fundingTime) / 1000, rate: n(x.realizedRate || x.fundingRate) })).reverse();
      },
      // 统计接口的 period 只有 5m / 1H / 1D：传界面周期（15m 等）会换成对应的统计周期，也可以直接传这三个值
      async oiVolHist(ccy, tf) {
        return okxOk(await VP.get(`${OK}/api/v5/rubik/stat/contracts/open-interest-volume?ccy=${ccy}&period=${okPeriod(tf)}`, { ttl: 30000 }))
          .map(x => ({ t: n(x[0]) / 1000, oiUsd: n(x[1]), volUsd: n(x[2]) })).reverse();
      },
      async lsHist(ccy, tf) {
        return okxOk(await VP.get(`${OK}/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=${ccy}&period=${okPeriod(tf)}`, { ttl: 30000 }))
          .map(x => ({ t: n(x[0]) / 1000, ratio: n(x[1]) })).reverse();
      },
      async takerHist(ccy, tf) {
        return okxOk(await VP.get(`${OK}/api/v5/rubik/stat/taker-volume?ccy=${ccy}&instType=CONTRACTS&period=${okPeriod(tf)}`, { ttl: 30000 }))
          .map(x => ({ t: n(x[0]) / 1000, sell: n(x[1]), buy: n(x[2]) })).reverse();
      },
      instruments: async () => okxOk(await VP.get(`${OK}/api/v5/public/instruments?instType=SWAP`, { ttl: 3600e3 })),
    },
    bitget: {
      tickers: async () => bitgetOk(await VP.get(`${BG}/api/v2/mix/market/tickers?productType=USDT-FUTURES`, { ttl: 15000 })),
      ticker: async sym => bitgetOk(await VP.get(`${BG}/api/v2/mix/market/ticker?symbol=${sym}&productType=USDT-FUTURES`, { ttl: 4000 }))[0],
      async fundingAll() {
        try { return bitgetOk(await VP.get(`${BG}/api/v2/mix/market/current-fund-rate?productType=USDT-FUTURES`, { ttl: 60000, retries: 0 })); } catch { return []; }
      },
    },
    hyperliquid: {
      async ctxs() {
        const [meta, ctx] = await VP.post(HL, { type: 'metaAndAssetCtxs' }, { ttl: 15000 });
        return meta.universe.map((u, i) => ({ name: u.name, delisted: !!u.isDelisted, ...ctx[i] }));
      },
      async candles(coin, tf, bars = 500) {
        const end = Date.now(), start = end - TF[tf].sec * 1000 * bars;
        const d = await VP.post(HL, { type: 'candleSnapshot', req: { coin, interval: TF[tf].hl, startTime: start, endTime: end } }, { ttl: 5000 });
        return d.map(k => ({ t: k.t / 1000, o: n(k.o), h: n(k.h), l: n(k.l), c: n(k.c), v: n(k.v) }));
      },
    },
    deribit: {
      summary: async (currency, kind) => deribitOk(await VP.get(`${DB}/get_book_summary_by_currency?currency=${currency}&kind=${kind}`, { ttl: 20000 })),
      index: async currency => deribitOk(await VP.get(`${DB}/get_index_price?index_name=${currency.toLowerCase()}_usd`, { ttl: 5000 })),
      trades: async (currency, count = 1000) => deribitOk(await VP.get(`${DB}/get_last_trades_by_currency?currency=${currency}&kind=option&count=${count}`, { ttl: 20000 })).trades,
      // DVOL K 线：一次返回的条数有上限，按 continuation（下一页的 end_timestamp）往前翻，凑满整段时间
      volIndex: async (currency, resolution = 3600, hours = 24 * 7) => {
        let end = Date.now(), data = [];
        const start = end - hours * 3600e3;
        for (let page = 0; page < 5; page++) {
          const r = deribitOk(await VP.get(`${DB}/get_volatility_index_data?currency=${currency}&start_timestamp=${start}&end_timestamp=${end}&resolution=${resolution}`, { ttl: 60000 }));
          data = (r.data || []).concat(data);
          const next = Number(r.continuation);
          if (!next || next <= start || next >= end) break;
          end = next;
        }
        const seen = new Set();
        return { data: data.filter(x => !seen.has(x[0]) && seen.add(x[0])), continuation: null };
      },
    },
  };

  /* ------------------------------------------------------------ 实时数据（WebSocket，带自动重连） */
  VP.socket = function (url, { onOpen, onMessage, ping, pingMs = 20000, name = url } = {}) {
    let ws = null, closed = false, retry = 0, pingTimer = 0, status = 'connecting';
    const listeners = new Set();
    const setStatus = s => { status = s; listeners.forEach(fn => fn(s)); };
    function open() {
      if (closed) return;
      setStatus('connecting');
      try { ws = new WebSocket(url); } catch { schedule(); return; }
      ws.onopen = () => {
        retry = 0; setStatus('open');
        try { onOpen && onOpen(ws); } catch (e) { console.error(e); }
        clearInterval(pingTimer);
        if (ping) pingTimer = setInterval(() => { try { ws.send(typeof ping === 'function' ? ping() : ping); } catch { /* 忽略 */ } }, pingMs);
      };
      ws.onmessage = ev => { try { onMessage(ev.data); } catch (e) { console.error(name, e); } };
      ws.onclose = () => { clearInterval(pingTimer); if (!closed) { setStatus('retry'); schedule(); } };
      ws.onerror = () => { try { ws.close(); } catch { /* 忽略 */ } };
    }
    function schedule() { retry++; setTimeout(open, Math.min(30000, 1000 * 2 ** Math.min(retry, 5))); }
    open();
    return {
      close() { closed = true; clearInterval(pingTimer); try { ws && ws.close(); } catch { /* 忽略 */ } },
      send(x) { if (ws && ws.readyState === 1) ws.send(x); },
      get status() { return status; },
      onStatus(fn) { listeners.add(fn); fn(status); },
    };
  };

  /* ------------------------------------------------------------ 图表 */
  /** lightweight-charts 的统一外观 */
  VP.chartOptions = function (extra = {}) {
    const c = VP.colors();
    return Object.assign({
      // 图表库的署名放在设置页的“组成部分”里，图上不再显示角标
      layout: { background: { type: 'solid', color: 'transparent' }, textColor: c.dim, fontFamily: getComputedStyle(document.body).fontFamily, fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: 'rgba(40,56,78,.35)' }, horzLines: { color: 'rgba(40,56,78,.35)' } },
      rightPriceScale: { borderColor: c.line, minimumWidth: 78 },
      timeScale: { borderColor: c.line, timeVisible: true, secondsVisible: false, rightOffset: 4 },
      crosshair: { mode: 0, vertLine: { color: '#566a86', labelBackgroundColor: '#24324a' }, horzLine: { color: '#566a86', labelBackgroundColor: '#24324a' } },
      localization: {
        locale: 'zh-CN',
        // 图上的时间已经用 VP.localTime 平移成本地时间，这里按 UTC 读出来就是本地时刻
        timeFormatter: t => { const d = new Date(t * 1000); return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; },
      },
      handleScale: { axisPressedMouseMove: { time: true, price: true } },
    }, extra);
  };

  /** 把几张图的时间轴和十字线连在一起 */
  VP.syncCharts = function (entries) {
    let busy = false;
    entries.forEach(({ chart }) => {
      chart.timeScale().subscribeVisibleTimeRangeChange(range => {
        if (busy || !range) return;
        busy = true;
        entries.forEach(o => { if (o.chart !== chart) { try { o.chart.timeScale().setVisibleRange(range); } catch { /* 对方没数据 */ } } });
        busy = false;
      });
      chart.subscribeCrosshairMove(p => {
        entries.forEach(o => {
          if (o.chart === chart) return;
          if (!p || !p.time || !o.series) { o.chart.clearCrosshairPosition(); return; }
          try { o.chart.setCrosshairPosition(NaN, p.time, o.series); } catch { /* 对方没这个时间点 */ }
        });
      });
    });
  };

  /** 本地时区：lightweight-charts 按 UTC 显示时间，喂给图表的时间统一先平移到本地（秒） */
  const TZ = -new Date().getTimezoneOffset() * 60;
  VP.localTime = t => t + TZ;
  VP.TZ = TZ;
})();
