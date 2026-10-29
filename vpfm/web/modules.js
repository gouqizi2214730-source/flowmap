'use strict';
/* 外壳（index.html）和独立窗口（window.html）共用的模块列表 */
window.VPFM_MODULES = [
  { id: 'flowmap', name: '深度热力图', short: '热力', src: 'flowmap/', heavy: true },
  { id: 'aggr', name: '聚合成交', short: '成交', src: 'aggr/', heavy: true },
  { id: 'lmap', name: '流动性地图', short: '流动', src: 'lmap/?lang=zh&source=browser', heavy: true },
  { id: 'derivs', name: '衍生品数据', short: '衍生', src: 'derivs/' },
  { id: 'options', name: '期权 GEX', short: '期权', src: 'options/' },
  { id: 'structure', name: '结构分析', short: '结构', src: 'structure/' },
  { id: 'tools', name: '工具箱', short: '工具', src: 'tools/' },
];
/* 跟着聚合成交切币的模块 */
window.VPFM_LINKED = ['derivs', 'structure'];

/* 从聚合成交的交易对（如 BINANCE_FUTURES:btcusdt、OKEX:BTC-USDT-SWAP）里取出币种 */
window.VPFM_baseFromMarket = function (id) {
  let s = String(id || '').split(':').pop().toUpperCase();
  s = s.replace(/[-_]?(SWAP|PERPETUAL|PERP)$/, '');
  if (/[-_/]/.test(s)) s = s.split(/[-_/]/)[0];
  else s = s.replace(/(USDT|USDC|FDUSD|BUSD|USD|EUR|BTC)$/, m => (s.length > m.length ? '' : m));
  s = s.replace(/^(1000000|100000|10000|1000|1M)(?=[A-Z])/, '');
  if (s === 'XBT') s = 'BTC';
  return /^[A-Z0-9]{2,15}$/.test(s) ? s : null;
};

/* 让模块页面里的外部链接、window.open 打开到系统浏览器，快捷键交给外壳 —— 外壳和独立窗口都用 */
window.VPFM_wire = function (el, { onKey, openExternal }) {
  let w;
  try { w = el.contentWindow; if (!w || !w.document) return; } catch { return; }
  if (w.__vpfmWired) return;
  w.__vpfmWired = true;
  if (onKey) w.addEventListener('keydown', onKey, true);
  const external = href => {
    let u;
    try { u = new URL(href, w.location.href); } catch { return null; }
    if (!/^https?:$/.test(u.protocol) || u.origin === location.origin) return null;
    return u.href;
  };
  w.document.addEventListener('click', e => {
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
    const ext = external(href);
    if (ext) { e.preventDefault(); e.stopPropagation(); openExternal(ext); }
  }, true);
  const nativeOpen = w.open;
  w.open = function (url, target, features) {
    const ext = external(String(url));
    if (ext) { openExternal(ext); return null; }
    return nativeOpen.call(w, url, target, features);
  };
};
