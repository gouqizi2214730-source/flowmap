'use strict';
/* VPFM 外壳：左侧切换模块，模块放在同源 iframe 里、切走后保留运行。
   本页由内置服务器在 http://127.0.0.1:<端口>/wb/ 提供，各模块和外壳同源。 */

const ICONS = {
  flowmap: '<path d="M3 6h7M14 6h7M3 10h4M10 10h11M3 14h12M18 14h3M3 18h6M12 18h9"/>',
  aggr: '<circle cx="7.5" cy="15.5" r="3.5"/><circle cx="15.5" cy="8.5" r="4.5"/><circle cx="18" cy="18" r="2"/>',
  lmap: '<path d="M8 3.5v17M16 3.5v17M8 7.5h8M8 12h8M8 16.5h8"/><path d="M3 7.5h2.5M3 12h4M18.5 12h2.5M18.5 16.5h2.5"/>',
  derivs: '<path d="M4.5 20v-6M9.5 20v-9M14.5 20v-5M19.5 20V9"/><path d="M3 10l6.5-5 5 3.5L21 4"/>',
  options: '<path d="M3 18.5c4 0 5-13 9-13s5 13 9 13"/><path d="M12 3v18" stroke-dasharray="1.5 2.5"/>',
  structure: '<path d="M3 17.5l5-6.5 4 4 5-8.5 4 3.5"/><rect x="13.5" y="13" width="7" height="4.5" rx="1"/>',
  tools: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8.5 7.5h7M8.5 12h1M12 12h0M15.5 12h0M8.5 16.5h1M12 16.5h0M15.5 16.5h0"/>',
};

const MODULES = [
  { id: 'flowmap', name: '深度热力图', short: '热力', src: 'flowmap/', heavy: true },
  { id: 'aggr', name: '聚合成交', short: '成交', src: 'aggr/', heavy: true },
  { id: 'lmap', name: '流动性地图', short: '流动', src: 'lmap/?lang=zh&source=browser', heavy: true },
  { id: 'derivs', name: '衍生品数据', short: '衍生', src: 'derivs/' },
  { id: 'options', name: '期权 GEX', short: '期权', src: 'options/' },
  { id: 'structure', name: '结构分析', short: '结构', src: 'structure/' },
  { id: 'tools', name: '工具箱', short: '工具', src: 'tools/' },
];
const BY_ID = Object.fromEntries(MODULES.map(m => [m.id, m]));

const CREDITS = [
  ['FlowMap', 'nazmiefearmutcu/flowmap', 'Apache-2.0', '深度热力图（WebGL）、DOM、成交明细、CVD、成交量分布、录制回放。VPFM 的桌面外壳和内置服务器也来自它。'],
  ['aggr', 'Tucsky/aggr', 'GPL-3.0', '多交易所逐笔成交与爆仓聚合、成交量气泡图、价格提醒。历史数据服务和社区指标库是作者的在线服务，已关闭。'],
  ['Liquidity Mapper Fast', 'liquiditymapperfast/liquiditymapperfast.github.io', 'MIT', '多交易所聚合盘口热力图、足迹图、Delta/CVD、持仓、清算、关键价位、录制回放。'],
  ['smart-money-concepts', 'joshyattridge/smart-money-concepts', 'MIT', '结构分析里的摆动高低点、BOS/CHoCH、订单块、FVG、流动性算法（改写为 JavaScript）。'],
  ['HTF SUITE、Bandz Po3 Profiler、Fractal Model、Triple HTF BB、VWAP Claire', 'gouqizi2214730-source', 'GPL-3.0 / MPL-2.0 / MIT', '结构分析里的高周期 K 线、PO3、CISD、三周期布林带、锚定与滚动 VWAP 等思路参考了这些 TradingView 指标（按概念重写，没有照搬代码）。'],
  ['Lightweight Charts', 'tradingview/lightweight-charts', 'Apache-2.0', '衍生品、期权和结构分析的图表。'],
  ['Barlow', 'jpt/barlow', 'OFL-1.1', '界面里的数字字体。'],
];

const SHELL_KEY = 'vpfm.shell.v1';
const PREFS_KEY = 'vpfm.prefs';
const SAVER_MS = 5 * 60 * 1000;

const $ = s => document.querySelector(s);
const readJson = (k, d) => { try { return Object.assign({}, d, JSON.parse(localStorage.getItem(k) || '{}')); } catch { return Object.assign({}, d); } };
const writeJson = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 存储不可用就只在本次有效 */ } };

const shell = readJson(SHELL_KEY, { last: 'flowmap', start: 'last', hidden: [], saver: false });
const prefs = readJson(PREFS_KEY, { updown: 'green-up', link: true });
const frames = new Map();
let current = null;

/* ---------- 提示 ---------- */
let toastTimer = 0;
function toast(msg, bad = false, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg; t.classList.toggle('bad', bad); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
  return j;
}

function openExternal(url) {
  post('/api/wb/open', { url }).catch(e => toast('打不开链接：' + e.message, true));
}

/* ---------- 左侧栏 ---------- */
function visibleModules() { return MODULES.filter(m => !shell.hidden.includes(m.id)); }

function buildRail() {
  const rail = $('#rail');
  rail.textContent = '';
  visibleModules().forEach((m, i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'rail-item'; b.dataset.go = m.id;
    b.setAttribute('role', 'tab');
    b.title = `${m.name}（Ctrl+${i + 1}）`;
    b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[m.id]}</svg><span>${m.short}</span><i class="live"></i>`;
    rail.append(b);
  });
  markRail();
}

function markRail() {
  document.querySelectorAll('[data-go].rail-item').forEach(b => {
    const on = b.dataset.go === current;
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    const live = b.querySelector('.live');
    if (live) live.classList.toggle('on', frames.has(b.dataset.go));
  });
}

/* ---------- 模块切换 ---------- */
function ensureFrame(id) {
  let f = frames.get(id);
  if (f) return f;
  const m = BY_ID[id];
  const el = document.createElement('iframe');
  el.className = 'mod';
  el.title = m.name;
  el.allow = 'clipboard-read; clipboard-write; fullscreen; autoplay';
  el.src = m.src;
  el.addEventListener('load', () => { wire(el); if (el.hidden) tellVisible({ el }, false); });
  $('#stage').append(el);
  f = { el, hiddenAt: 0 };
  frames.set(id, f);
  return f;
}

/** 告诉模块自己是否在前台（隐藏的 iframe 不会触发 document.hidden），模块据此暂停定时刷新 */
function tellVisible(f, visible) {
  try { f.el.contentWindow.dispatchEvent(new CustomEvent('vpfm-visible', { detail: visible })); } catch { /* 还没加载完 */ }
}

function show(id, opts = {}) {
  if (id !== 'settings' && !BY_ID[id]) id = visibleModules()[0]?.id || 'settings';
  if (id === current && !opts.force) return;
  if (current && current !== 'settings') {
    const f = frames.get(current);
    if (f) { f.el.hidden = true; f.hiddenAt = Date.now(); tellVisible(f, false); }
  }
  $('#settings').hidden = id !== 'settings';
  if (id === 'settings') {
    refreshSettings();
  } else {
    const f = ensureFrame(id);
    f.el.hidden = false; f.hiddenAt = 0; tellVisible(f, true);
    try { f.el.contentWindow.focus(); } catch { /* 跨域时忽略 */ }
    shell.last = id; writeJson(SHELL_KEY, shell);
  }
  current = id;
  document.title = id === 'settings' ? 'VPFM · 设置' : `VPFM · ${BY_ID[id].name}`;
  if (location.hash.slice(1) !== id) history.replaceState(null, '', '#' + id);
  markRail();
}

function reloadModule(id) {
  const f = frames.get(id);
  if (!f) return;
  try { f.el.contentWindow.location.reload(); } catch { f.el.src = BY_ID[id].src; }
}

// 省资源：切走一段时间的重型模块释放掉
setInterval(() => {
  if (!shell.saver) return;
  const now = Date.now();
  for (const [id, f] of frames) {
    if (id !== current && f.hiddenAt && now - f.hiddenAt > SAVER_MS) {
      f.el.src = 'about:blank'; f.el.remove(); frames.delete(id);
    }
  }
  markRail();
}, 30000);

/* ---------- 让模块里的快捷键、外部链接也归外壳管 ---------- */
function onKey(e) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
  if (e.key === ',') { e.preventDefault(); show('settings'); return; }
  const n = /^Digit([1-9])$/.exec(e.code);
  if (n) {
    const m = visibleModules()[Number(n[1]) - 1];
    if (m) { e.preventDefault(); e.stopPropagation(); show(m.id); }
  }
}

function externalHref(a, win) {
  const href = a.getAttribute('href');
  if (!href || href.startsWith('#') || href.startsWith('javascript:')) return null;
  let u;
  try { u = new URL(href, win.location.href); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (u.origin === location.origin) return null;
  return u.href;
}

function wire(el) {
  let w;
  try { w = el.contentWindow; if (!w || !w.document) return; } catch { return; }
  if (w.__vpfmWired) return;
  w.__vpfmWired = true;
  w.addEventListener('keydown', onKey, true);
  w.document.addEventListener('click', e => {
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    const ext = externalHref(a, w);
    if (ext) { e.preventDefault(); e.stopPropagation(); openExternal(ext); }
  }, true);
  const nativeOpen = w.open;
  w.open = function (url, target, features) {
    try {
      const u = new URL(String(url), w.location.href);
      if (/^https?:$/.test(u.protocol) && u.origin !== location.origin) { openExternal(u.href); return null; }
    } catch { /* 交给原来的实现 */ }
    return nativeOpen.call(w, url, target, features);
  };
}
window.addEventListener('keydown', onKey, true);

/* ---------- 币种联动：在聚合成交（aggr）里点交易对，衍生品数据和结构分析跟着切换 ---------- */
function baseFromMarket(id) {
  let s = String(id || '').split(':').pop().toUpperCase();
  s = s.replace(/[-_]?(SWAP|PERPETUAL|PERP)$/, '');
  if (/[-_/]/.test(s)) s = s.split(/[-_/]/)[0];
  else s = s.replace(/(USDT|USDC|FDUSD|BUSD|USD|EUR|BTC)$/, m => (s.length > m.length ? '' : m));
  s = s.replace(/^(1000000|100000|10000|1000|1M)(?=[A-Z])/, '');
  if (s === 'XBT') s = 'BTC';
  return /^[A-Z0-9]{2,15}$/.test(s) ? s : null;
}
let lastLinked = '';
window.addEventListener('message', e => {
  if (e.origin !== location.origin || typeof e.data !== 'string' || e.data[0] !== '{') return;
  let msg; try { msg = JSON.parse(e.data); } catch { return; }
  if (!msg || msg.op !== 'market' || !prefs.link) return;
  const coin = baseFromMarket(msg.data);
  if (!coin) return;
  for (const id of ['derivs', 'structure']) {
    const f = frames.get(id);
    if (f) { try { f.el.contentWindow.dispatchEvent(new CustomEvent('vpfm-coin', { detail: coin })); } catch { /* 忽略 */ } }
    else { const key = 'vpfm.' + id; const v = readJson(key, {}); v.coin = coin; writeJson(key, v); } // 还没打开的模块：下次打开就是这个币
  }
  if (coin !== lastLinked) { lastLinked = coin; toast(`衍生品数据和结构分析已切到 ${coin}`); }
});

/* ---------- 本地服务状态 ---------- */
let info = null;
let fails = 0;
async function ping() {
  const ls = $('#linkState');
  try {
    const r = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error(String(r.status));
    if (fails >= 2) toast('本地服务已恢复');
    fails = 0;
    $('#banner').hidden = true;
    if (!info) info = await fetch('/api/wb/info', { cache: 'no-store' }).then(x => x.json()).catch(() => null);
    const proxied = !!info?.proxy;
    ls.className = 'link-state ' + (proxied ? 'proxy' : 'ok');
    $('#linkText').textContent = proxied ? '代理' : '直连';
    ls.title = proxied ? `本地服务正常，走代理 ${info.proxy}` : '本地服务正常，直接连接交易所';
  } catch {
    fails += 1;
    ls.className = 'link-state bad';
    $('#linkText').textContent = '断开';
    ls.title = '本地服务没有响应';
    if (fails >= 2) {
      const b = $('#banner');
      b.textContent = '本地服务没有响应，正在重连。深度热力图暂时收不到数据，其他模块不受影响。';
      b.hidden = false;
    }
  }
}

/* ---------- 设置页 ---------- */
function applyPrefs() {
  if (prefs.updown === 'red-up') document.documentElement.dataset.updown = 'red-up';
  else delete document.documentElement.dataset.updown;
  document.querySelectorAll('#updownSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === prefs.updown)));
}

function fillStatic() {
  const sel = $('#startSel');
  sel.innerHTML = '<option value="last">上次打开的模块</option>' + MODULES.map(m => `<option value="${m.id}">${m.name}</option>`).join('');
  sel.value = shell.start || 'last';
  sel.onchange = () => { shell.start = sel.value; writeJson(SHELL_KEY, shell); };

  $('#linkChk').checked = prefs.link !== false;
  $('#linkChk').onchange = e => { prefs.link = e.target.checked; writeJson(PREFS_KEY, prefs); };
  $('#saverChk').checked = !!shell.saver;
  $('#saverChk').onchange = e => { shell.saver = e.target.checked; writeJson(SHELL_KEY, shell); };

  const list = $('#modList');
  list.innerHTML = MODULES.map(m => `<label class="check"><input type="checkbox" value="${m.id}" ${shell.hidden.includes(m.id) ? '' : 'checked'}> ${m.name}</label>`).join('');
  list.onchange = e => {
    const id = e.target.value;
    shell.hidden = shell.hidden.filter(x => x !== id);
    if (!e.target.checked) {
      if (visibleModules().length <= 1) { e.target.checked = true; toast('至少保留一个模块'); return; }
      shell.hidden.push(id);
      const f = frames.get(id);
      if (f) { f.el.remove(); frames.delete(id); }
    }
    writeJson(SHELL_KEY, shell); buildRail();
  };

  document.querySelectorAll('#updownSeg button').forEach(b => {
    b.onclick = () => { prefs.updown = b.dataset.v; writeJson(PREFS_KEY, prefs); applyPrefs(); notifyPrefs(); };
  });

  const keys = visibleModules().map((m, i) => [`Ctrl+${i + 1}`, m.name]).concat([['Ctrl+,', '设置']]);
  $('#keys').innerHTML = keys.map(([k, v]) => `<dt><kbd>${k}</kbd></dt><dd>${v}</dd>`).join('');

  $('#credits').innerHTML = CREDITS.map(([n, repo, lic, d]) =>
    `<li><div><b>${n}</b><div class="lic">${lic}</div></div><p>${d}<br><a href="https://github.com/${repo}" data-ext>github.com/${repo}</a></p></li>`).join('');

  $('#updateBtn').onclick = async () => {
    try { await post('/api/wb/update-check'); toast('正在检查更新，结果会在弹出的窗口里显示'); }
    catch (e) { toast('无法开始检查：' + e.message, true); }
  };
  $('#openData').onclick = () => post('/api/wb/open-data').catch(e => toast('打不开数据目录：' + e.message, true));
  $('#proxySave').onclick = saveProxy;
  $('#settings').addEventListener('click', e => {
    const a = e.target.closest('a[href]');
    if (a && /^https?:/.test(a.href) && new URL(a.href).origin !== location.origin) { e.preventDefault(); openExternal(a.href); }
  });
}

function notifyPrefs() {
  for (const f of frames.values()) {
    try { f.el.contentWindow.dispatchEvent(new CustomEvent('vpfm-prefs', { detail: { ...prefs } })); } catch { /* 忽略 */ }
  }
}

const SOURCE_NAME = { system: '系统代理', env: '环境变量', custom: '自定义', off: '已关闭', none: '没有设置', unsupported: '不支持的代理类型（只支持 http 代理）' };

async function refreshSettings() {
  applyPrefs();
  try {
    const [s, inf, ver] = await Promise.all([
      fetch('/api/wb/settings', { cache: 'no-store' }).then(r => r.json()),
      fetch('/api/wb/info', { cache: 'no-store' }).then(r => r.json()),
      fetch('version.json', { cache: 'no-store' }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
    ]);
    info = inf;
    document.querySelectorAll('input[name="proxyMode"]').forEach(r => { r.checked = r.value === s.proxyMode; });
    $('#proxyInput').value = s.proxy || '';
    $('#proxyNow').textContent = s.effective ? `现在使用：${s.effective}（${SOURCE_NAME[s.source] || s.source}）` : `现在直接连接（${SOURCE_NAME[s.source] || s.source}）`;
    $('#dataDir').textContent = inf.dataDir || '';
    const v = ver.version || '开发版';
    $('#verLine').textContent = `版本 ${v}${ver.built ? '，构建于 ' + ver.built.replace('T', ' ').replace(/:\d\dZ$/, ' UTC') : ''}`;
    $('#buildLine').textContent = `当前 ${v}`;
    const ups = ver.upstreams || {};
    const names = { flowmap: 'FlowMap', aggr: 'aggr', lmap: 'Liquidity Mapper' };
    $('#upstreams').innerHTML = Object.keys(ups).length
      ? '包含的上游版本：<span class="upstreams-list">' + Object.entries(ups).map(([k, x]) => `<span>${names[k] || k} <span class="num">${String(x.sha || '').slice(0, 7)}</span>${x.date ? '（' + x.date + '）' : ''}</span>`).join('') + '</span>'
      : '';
  } catch (e) {
    $('#verLine').textContent = '读取信息失败：' + e.message;
  }
}

async function saveProxy() {
  const mode = document.querySelector('input[name="proxyMode"]:checked')?.value || 'system';
  const proxy = $('#proxyInput').value.trim();
  if (mode === 'custom' && !proxy) { toast('请填写代理地址，例如 http://127.0.0.1:7890', true); return; }
  try {
    const r = await post('/api/wb/settings', { proxyMode: mode, proxy });
    info = null;
    toast(r.effective ? `已保存，内置服务器改走 ${r.effective}` : '已保存，内置服务器改为直接连接');
    refreshSettings(); ping();
  } catch (e) { toast('保存失败：' + e.message, true); }
}

/* ---------- 启动 ---------- */
document.addEventListener('click', e => {
  const b = e.target.closest('[data-go]');
  if (b) show(b.dataset.go);
});
document.addEventListener('dblclick', e => {
  const b = e.target.closest('.rail-item[data-go]');
  if (b && b.dataset.go !== 'settings') { reloadModule(b.dataset.go); toast(`已重新加载${BY_ID[b.dataset.go].name}`); }
});
window.addEventListener('hashchange', () => show(location.hash.slice(1)));
window.addEventListener('storage', e => { if (e.key === PREFS_KEY) { Object.assign(prefs, readJson(PREFS_KEY, prefs)); applyPrefs(); } });

window.vpfm = { show, openExternal, toast, reloadModule, prefs: () => ({ ...prefs }) };

applyPrefs();
fillStatic();
buildRail();
const fromHash = location.hash.slice(1);
const first = (fromHash && (BY_ID[fromHash] || fromHash === 'settings')) ? fromHash
  : (shell.start && shell.start !== 'last' && BY_ID[shell.start]) ? shell.start : shell.last;
show(first);
ping();
setInterval(ping, 5000);
